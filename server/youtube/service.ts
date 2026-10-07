import type { ReactionValue, SyncStatus, YouTubePlaylist } from '../../shared/types.ts';
import { formatGenre, isVideoId } from '../../shared/youtube.ts';
import { all, get, run, transaction, type DB } from '../db.ts';
import { HttpError } from '../http.ts';
import {
  decadeTag,
  parseIsoDuration,
  parseVideoTitle,
  popularityFromViews,
  topicsToGenres,
} from '../music.ts';
import type { TasteSignal } from '../recommender.ts';
import { getSongRow, getSongRows, upsertSong, type SongInput, type SongRow } from '../songs.ts';
import { isYouTubeConnected, parseSettings, type UserRow } from '../users.ts';
import {
  YOUTUBE_SCOPE,
  YouTubeApiError,
  type Credentials,
  type GoogleUserInfo,
  type TokenResponse,
  type YouTubeClient,
  type YtPlaylistItem,
  type YtThumbnail,
  type YtVideo,
} from './client.ts';

const HOUR = 60 * 60 * 1000;
const NOT_A_SONG =
  /\b(full album|playlist|compilation|non-?stop|megamix|\d+\s*hours?|hour loop|live ?stream|reaction|#shorts|tutorial|karaoke)\b/i;

/**
 * Whether a video looks like a single song. "strict" is used for discovery,
 * where we want proper music videos; the relaxed check is for things the
 * listener chose themselves (their likes, playlists, searches, pasted links).
 */
export function isSongLike(video: YtVideo, strict: boolean): boolean {
  const s = video.snippet;
  if (!s || !isVideoId(video.id)) return false;
  if (s.liveBroadcastContent && s.liveBroadcastContent !== 'none') return false;
  if (video.status?.embeddable === false || video.status?.privacyStatus === 'private') return false;
  const duration = parseIsoDuration(video.contentDetails?.duration);
  if (duration !== null && (duration < (strict ? 60 : 30) || duration > (strict ? 12 : 20) * 60)) return false;
  if (strict && s.categoryId && s.categoryId !== '10') return false;
  return !NOT_A_SONG.test(s.title);
}

function bestThumbnail(thumbs: Record<string, YtThumbnail | undefined> | undefined): string | null {
  return thumbs?.high?.url ?? thumbs?.medium?.url ?? thumbs?.standard?.url ?? thumbs?.default?.url ?? null;
}

export function videoToSongInput(video: YtVideo, trendingAt?: number): SongInput | null {
  const s = video.snippet;
  if (!s || !isVideoId(video.id)) return null;
  const { title, artist } = parseVideoTitle(s.title, s.channelTitle ?? '');
  const published = s.publishedAt ? new Date(s.publishedAt).getUTCFullYear() : NaN;
  const year = Number.isFinite(published) ? published : null;
  const decade = decadeTag(year);
  const views = Number(video.statistics?.viewCount);
  return {
    id: video.id,
    title,
    artist,
    source: 'youtube',
    channelId: s.channelId ?? null,
    channelTitle: s.channelTitle ?? null,
    durationSec: parseIsoDuration(video.contentDetails?.duration),
    year,
    genres: topicsToGenres(video.topicDetails?.topicCategories),
    tags: decade ? [decade] : [],
    thumbnailUrl: bestThumbnail(s.thumbnails),
    popularity: Number.isFinite(views) ? popularityFromViews(views) : undefined,
    trendingAt,
  };
}

function itemVideoId(item: YtPlaylistItem): string | undefined {
  return item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
}

function describe(err: unknown): string {
  if (err instanceof YouTubeApiError) return `${err.status} ${err.reason ?? ''} ${err.message}`.trim();
  return err instanceof Error ? err.message : String(err);
}

/** Maps YouTube failures onto friendly HTTP errors for the client. */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof YouTubeApiError) {
    if (err.isQuota) return new HttpError(503, 'youtube_quota', 'YouTube’s daily API quota is used up. Try again tomorrow.');
    if (err.status === 404) return new HttpError(404, 'youtube_not_found', 'YouTube couldn’t find that. It may be private or deleted.');
    if (err.status === 403) return new HttpError(403, 'youtube_forbidden', 'YouTube refused the request. It may be private.');
    if (err.status === 401) return new HttpError(409, 'youtube_reconnect', 'Please connect YouTube Music again.');
  }
  return new HttpError(502, 'youtube_unreachable', 'Couldn’t reach YouTube right now. Try again in a moment.');
}

export interface YouTubeServiceDeps {
  db: DB;
  client: YouTubeClient;
  now: () => number;
  /** Spend search quota on genre-based discovery. */
  discoverySearch: boolean;
}

export class YouTubeService {
  private readonly db: DB;
  readonly client: YouTubeClient;
  private readonly now: () => number;
  private readonly discoverySearch: boolean;

  constructor(deps: YouTubeServiceDeps) {
    this.db = deps.db;
    this.client = deps.client;
    this.now = deps.now;
    this.discoverySearch = deps.discoverySearch;
  }

  get loginEnabled(): boolean {
    return this.client.oauthEnabled;
  }

  get searchEnabled(): boolean {
    return this.client.apiKeyEnabled;
  }

  // --- Accounts ------------------------------------------------------------

  async completeLogin(opts: { code: string; codeVerifier: string; redirectUri: string }): Promise<{
    tokens: TokenResponse;
    profile: GoogleUserInfo;
  }> {
    const tokens = await this.client.exchangeCode(opts);
    if (tokens.scope && !tokens.scope.split(/\s+/).includes(YOUTUBE_SCOPE)) {
      throw new HttpError(403, 'youtube_scope_missing', 'Earworm needs permission to manage your YouTube account to sync with YouTube Music.');
    }
    const profile = await this.client.userInfo(tokens.access_token);
    if (!profile.sub) throw new HttpError(502, 'google_profile', 'Google didn’t return an account id');
    return { tokens, profile };
  }

  /** Stores the Google identity and tokens on a user. */
  linkAccount(user: UserRow, tokens: TokenResponse, profile: GoogleUserInfo): void {
    run(
      this.db,
      `UPDATE users SET google_sub = :sub, google_email = :email, google_name = :name, google_picture = :picture,
         yt_access_token = :access, yt_refresh_token = COALESCE(:refresh, yt_refresh_token), yt_token_expires_at = :expires,
         yt_discovered_at = NULL
       WHERE id = :id`,
      {
        id: user.id,
        sub: profile.sub,
        email: profile.email ?? null,
        name: profile.name ?? null,
        picture: profile.picture ?? null,
        access: tokens.access_token,
        refresh: tokens.refresh_token ?? null,
        expires: this.now() + tokens.expires_in * 1000,
      },
    );
  }

  private clearTokens(user: UserRow): void {
    run(
      this.db,
      `UPDATE users SET google_sub = NULL, google_email = NULL, google_name = NULL, google_picture = NULL,
         yt_access_token = NULL, yt_refresh_token = NULL, yt_token_expires_at = NULL
       WHERE id = ?`,
      [user.id],
    );
    user.google_sub = null;
    user.yt_access_token = null;
    user.yt_refresh_token = null;
    user.yt_token_expires_at = null;
  }

  async disconnect(user: UserRow): Promise<void> {
    const token = user.yt_refresh_token ?? user.yt_access_token;
    if (token) {
      try {
        await this.client.revoke(token);
      } catch (err) {
        console.warn('Revoking Google token failed:', describe(err));
      }
    }
    this.clearTokens(user);
  }

  /** A valid access token for a connected user, refreshed when it is about to expire. */
  private async accessToken(user: UserRow): Promise<string> {
    if (!isYouTubeConnected(user)) {
      throw new HttpError(409, 'youtube_not_connected', 'Connect YouTube Music first.');
    }
    const now = this.now();
    if (user.yt_access_token && (user.yt_token_expires_at ?? 0) - 60_000 > now) return user.yt_access_token;
    if (!user.yt_refresh_token) {
      this.clearTokens(user);
      throw new HttpError(409, 'youtube_reconnect', 'Your YouTube Music connection expired. Please connect again.');
    }
    try {
      const tokens = await this.client.refreshAccessToken(user.yt_refresh_token);
      const expires = now + tokens.expires_in * 1000;
      run(
        this.db,
        'UPDATE users SET yt_access_token = ?, yt_token_expires_at = ?, yt_refresh_token = COALESCE(?, yt_refresh_token) WHERE id = ?',
        [tokens.access_token, expires, tokens.refresh_token ?? null, user.id],
      );
      user.yt_access_token = tokens.access_token;
      user.yt_token_expires_at = expires;
      if (tokens.refresh_token) user.yt_refresh_token = tokens.refresh_token;
      return tokens.access_token;
    } catch (err) {
      if (err instanceof YouTubeApiError && (err.reason === 'invalid_grant' || err.status === 400 || err.status === 401)) {
        this.clearTokens(user);
        throw new HttpError(409, 'youtube_reconnect', 'Your YouTube Music connection expired. Please connect again.');
      }
      throw err;
    }
  }

  /** Runs a call with the user's token, refreshing and retrying once if Google says it's no longer valid. */
  private async asUser<T>(user: UserRow, fn: (creds: Credentials) => Promise<T>): Promise<T> {
    const token = await this.accessToken(user);
    try {
      return await fn({ kind: 'token', accessToken: token });
    } catch (err) {
      if (err instanceof YouTubeApiError && err.status === 401) {
        user.yt_token_expires_at = 0;
        return fn({ kind: 'token', accessToken: await this.accessToken(user) });
      }
      throw err;
    }
  }

  /** Calls YouTube as the user when connected, otherwise with the API key. Null when neither is possible. */
  private async anyCall<T>(user: UserRow | null, fn: (creds: Credentials) => Promise<T>): Promise<T | null> {
    if (user && isYouTubeConnected(user)) {
      try {
        return await this.asUser(user, fn);
      } catch (err) {
        if (!this.searchEnabled || !(err instanceof HttpError)) throw err;
      }
    }
    if (this.searchEnabled) return fn({ kind: 'key' });
    return null;
  }

  canCall(user: UserRow | null): boolean {
    return this.searchEnabled || Boolean(user && isYouTubeConnected(user));
  }

  // --- Songs ---------------------------------------------------------------

  /** Upserts the song-like videos and returns their rows, in input order. */
  saveVideos(videos: YtVideo[], opts: { strict: boolean; trending?: boolean }): SongRow[] {
    const now = this.now();
    const ids: string[] = [];
    transaction(this.db, () => {
      for (const video of videos) {
        if (!isSongLike(video, opts.strict)) continue;
        const input = videoToSongInput(video, opts.trending ? now : undefined);
        if (!input) continue;
        upsertSong(this.db, input, now);
        ids.push(video.id);
      }
    });
    const rows = getSongRows(this.db, ids);
    return [...new Set(ids)].map((id) => rows.get(id)).filter((r): r is SongRow => Boolean(r && !r.unavailable));
  }

  private addToLibrary(userId: string, songIds: string[]): void {
    const now = this.now();
    transaction(this.db, () => {
      for (const songId of songIds) {
        run(this.db, 'INSERT OR IGNORE INTO library (user_id, song_id, created_at) VALUES (?, ?, ?)', [userId, songId, now]);
      }
    });
  }

  /** The connected user's liked music and playlists. Liked songs are remembered so the feed skips them. */
  async library(user: UserRow): Promise<{ liked: SongRow[]; playlists: YouTubePlaylist[] }> {
    return this.asUser(user, async (creds) => {
      const liked: YtVideo[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 4; page++) {
        const res = await this.client.likedVideos(creds, pageToken);
        liked.push(...res.items);
        if (!res.nextPageToken) break;
        pageToken = res.nextPageToken;
      }
      const songs = this.saveVideos(
        liked.filter((v) => v.snippet?.categoryId === '10'),
        { strict: false },
      );
      this.addToLibrary(user.id, songs.map((s) => s.id));

      const playlists: YouTubePlaylist[] = [];
      pageToken = undefined;
      for (let page = 0; page < 2; page++) {
        const res = await this.client.myPlaylists(creds, pageToken);
        for (const p of res.items) {
          if (p.id === user.yt_playlist_id) continue;
          playlists.push({
            id: p.id,
            title: p.snippet?.title ?? 'Untitled playlist',
            itemCount: p.contentDetails?.itemCount ?? 0,
            thumbnailUrl: bestThumbnail(p.snippet?.thumbnails),
          });
        }
        if (!res.nextPageToken) break;
        pageToken = res.nextPageToken;
      }
      return { liked: songs, playlists };
    });
  }

  /** Songs in a playlist (up to 100). The connected user's own playlists count as their library. */
  async playlistSongs(
    user: UserRow | null,
    playlistId: string,
    opts: { addToLibrary: boolean },
  ): Promise<{ title: string | null; songs: SongRow[] }> {
    const result = await this.anyCall(user, async (creds) => {
      const ids: string[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 2; page++) {
        const res = await this.client.playlistItems(playlistId, creds, pageToken);
        for (const item of res.items) {
          const id = itemVideoId(item);
          if (isVideoId(id)) ids.push(id);
        }
        if (!res.nextPageToken) break;
        pageToken = res.nextPageToken;
      }
      const info = await this.client.playlistInfo(playlistId, creds).catch(() => null);
      const videos = ids.length ? await this.client.videos([...new Set(ids)].slice(0, 100), creds) : [];
      return { title: info?.snippet?.title ?? null, videos };
    });
    if (!result) {
      throw new HttpError(400, 'youtube_unavailable', 'Importing playlists needs a YouTube API key or a connected YouTube Music account.');
    }
    const songs = this.saveVideos(result.videos, { strict: false });
    if (opts.addToLibrary && user) this.addToLibrary(user.id, songs.map((s) => s.id));
    return { title: result.title, songs };
  }

  /** YouTube music search. Null when no credentials are available. */
  async search(user: UserRow | null, query: string): Promise<SongRow[] | null> {
    const videos = await this.anyCall(user, async (creds) => {
      const ids = await this.client.search(query, creds, 15);
      return ids.length ? this.client.videos(ids, creds) : [];
    });
    return videos ? this.saveVideos(videos, { strict: false }) : null;
  }

  /** Looks up a single video by id, via the API when possible and oEmbed otherwise. */
  async resolveVideo(user: UserRow | null, videoId: string): Promise<SongRow | null> {
    const existing = getSongRow(this.db, videoId);
    if (existing && existing.source !== 'link') return existing;

    const videos = this.canCall(user) ? await this.anyCall(user, (creds) => this.client.videos([videoId], creds)) : null;
    if (videos) {
      const video = videos[0];
      if (!video) return null;
      if (video.status?.embeddable === false) {
        throw new HttpError(422, 'not_embeddable', 'The owner of that video doesn’t allow it to be played in other apps.');
      }
      const [row] = this.saveVideos([video], { strict: false });
      if (!row) throw new HttpError(422, 'not_a_song', 'That doesn’t look like a song (it may be a live stream or a long mix).');
      return row;
    }

    if (existing) return existing;
    const info = await this.client.oembed(videoId);
    if (!info) return null;
    const { title, artist } = parseVideoTitle(info.title, info.author_name);
    upsertSong(this.db, { id: videoId, title, artist, source: 'link' }, this.now());
    return getSongRow(this.db, videoId) ?? null;
  }

  // --- Mirroring actions to YouTube Music ---------------------------------

  async syncReaction(user: UserRow, songId: string, value: ReactionValue): Promise<SyncStatus> {
    if (!isYouTubeConnected(user) || !parseSettings(user.settings).syncReactions) return 'off';
    const rating = value === 1 ? 'like' : value === -1 ? 'dislike' : 'none';
    try {
      await this.asUser(user, (creds) => this.client.rate(songId, rating, creds));
      return 'ok';
    } catch (err) {
      console.warn('Syncing rating to YouTube failed:', describe(err));
      return 'error';
    }
  }

  /** Adds or removes a saved song from the user's "Earworm saves" playlist. */
  async syncSave(
    user: UserRow,
    songId: string,
    saved: boolean,
    existingItemId: string | null,
  ): Promise<{ status: SyncStatus; itemId: string | null }> {
    if (!isYouTubeConnected(user) || !parseSettings(user.settings).syncSaves) {
      return { status: 'off', itemId: saved ? null : existingItemId };
    }
    try {
      return await this.asUser(user, async (creds) => {
        if (!saved) {
          if (existingItemId) {
            await this.client.deletePlaylistItem(existingItemId, creds).catch((err: unknown) => {
              if (!(err instanceof YouTubeApiError && err.status === 404)) throw err;
            });
          }
          return { status: 'ok' as const, itemId: null };
        }
        const playlistId = user.yt_playlist_id ?? (await this.createSavesPlaylist(user, creds));
        try {
          return { status: 'ok' as const, itemId: await this.client.addToPlaylist(playlistId, songId, creds) };
        } catch (err) {
          // The playlist was deleted on YouTube: make a new one and try again.
          if (!(err instanceof YouTubeApiError && err.status === 404)) throw err;
          const fresh = await this.createSavesPlaylist(user, creds);
          return { status: 'ok' as const, itemId: await this.client.addToPlaylist(fresh, songId, creds) };
        }
      });
    } catch (err) {
      console.warn('Syncing save to YouTube failed:', describe(err));
      return { status: 'error', itemId: saved ? null : existingItemId };
    }
  }

  private async createSavesPlaylist(user: UserRow, creds: Credentials): Promise<string> {
    const id = await this.client.createPlaylist('Earworm saves', 'Songs I saved while scrolling Earworm.', creds);
    run(this.db, 'UPDATE users SET yt_playlist_id = ? WHERE id = ?', [id, user.id]);
    user.yt_playlist_id = id;
    return id;
  }

  // --- Discovery ---------------------------------------------------------------

  private isDue(key: string, maxAgeMs: number): boolean {
    const row = get<{ fetched_at: number }>(this.db, 'SELECT fetched_at FROM fetch_log WHERE key = ?', [key]);
    return !row || this.now() - row.fetched_at >= maxAgeMs;
  }

  private markFetched(key: string): void {
    run(
      this.db,
      'INSERT INTO fetch_log (key, fetched_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at',
      [key, this.now()],
    );
  }

  private hydrating: Promise<void> | null = null;

  /** Refreshes catalogue songs with real YouTube data and hides ones that can't be played. */
  hydrateCatalog(user: UserRow | null = null): Promise<void> {
    // Startup and the first feed request can both ask for this; only run it once at a time.
    this.hydrating ??= this.runHydration(user).finally(() => {
      this.hydrating = null;
    });
    return this.hydrating;
  }

  private async runHydration(user: UserRow | null): Promise<void> {
    if (!this.isDue('catalog:hydrate', 7 * 24 * HOUR)) return;
    const ids = all<{ id: string }>(this.db, "SELECT id FROM songs WHERE source = 'catalog'").map((r) => r.id);
    const videos = await this.anyCall(user, (creds) => this.client.videos(ids, creds));
    if (!videos) return;
    const now = this.now();
    const found = new Set(videos.map((v) => v.id));
    transaction(this.db, () => {
      for (const video of videos) {
        const input = videoToSongInput(video);
        if (!input) continue;
        const playable = video.status?.embeddable !== false && video.status?.privacyStatus !== 'private';
        upsertSong(this.db, { ...input, unavailable: !playable }, now);
      }
      for (const id of ids) {
        if (!found.has(id)) run(this.db, 'UPDATE songs SET unavailable = 1 WHERE id = ?', [id]);
      }
    });
    this.markFetched('catalog:hydrate');
  }

  /** Channels of the artists the listener likes most (known once songs have YouTube data). */
  private topChannels(signals: TasteSignal[], count: number): string[] {
    const positive = signals.filter((s) => s.weight > 0);
    const rows = getSongRows(this.db, positive.map((s) => s.songId));
    const weights = new Map<string, number>();
    for (const s of positive) {
      const channel = rows.get(s.songId)?.channel_id;
      if (channel?.startsWith('UC')) weights.set(channel, (weights.get(channel) ?? 0) + s.weight);
    }
    return [...weights].sort((a, b) => b[1] - a[1]).slice(0, count).map(([channel]) => channel);
  }

  /**
   * Pulls fresh candidate songs from YouTube for a listener: the regional
   * music chart, recent uploads from their favourite artists' channels, and
   * (optionally) a search in their top genre. Throttled per listener and per
   * source so quota lasts. Returns the number of songs added or refreshed.
   */
  async discover(user: UserRow, signals: TasteSignal[], opts: { force?: boolean } = {}): Promise<number> {
    if (!this.canCall(user)) return 0;
    const now = this.now();
    if (!opts.force && user.yt_discovered_at && now - user.yt_discovered_at < 6 * HOUR) return 0;
    run(this.db, 'UPDATE users SET yt_discovered_at = ? WHERE id = ?', [now, user.id]);
    user.yt_discovered_at = now;

    const region = parseSettings(user.settings).region;
    const call = <T>(fn: (creds: Credentials) => Promise<T>) => this.anyCall(user, fn);
    let added = 0;
    const steps: (() => Promise<void>)[] = [];

    steps.push(() => this.hydrateCatalog(user));

    const chartKey = `chart:${region}`;
    if (this.isDue(chartKey, 6 * HOUR)) {
      steps.push(async () => {
        const videos = (await call((creds) => this.client.musicChart(region, creds))) ?? [];
        added += this.saveVideos(videos, { strict: true, trending: true }).length;
        this.markFetched(chartKey);
      });
    }

    for (const channel of this.topChannels(signals, 3)) {
      const key = `uploads:${channel}`;
      if (!this.isDue(key, 24 * HOUR)) continue;
      steps.push(async () => {
        const page = await call((creds) => this.client.playlistItems(`UU${channel.slice(2)}`, creds, undefined, 25));
        const ids = (page?.items ?? []).map(itemVideoId).filter(isVideoId);
        const videos = ids.length ? ((await call((creds) => this.client.videos(ids, creds))) ?? []) : [];
        added += this.saveVideos(videos, { strict: true }).length;
        this.markFetched(key);
      });
    }

    if (this.discoverySearch) {
      const genre = topGenre(signals);
      if (genre) {
        const query = `${formatGenre(genre)} songs`;
        const key = `search:${query.toLowerCase()}`;
        if (this.isDue(key, 24 * HOUR)) {
          steps.push(async () => {
            const ids = (await call((creds) => this.client.search(query, creds, 25))) ?? [];
            const videos = ids.length ? ((await call((creds) => this.client.videos(ids, creds))) ?? []) : [];
            added += this.saveVideos(videos, { strict: true }).length;
            this.markFetched(key);
          });
        }
      }
    }

    for (const step of steps) {
      try {
        await step();
      } catch (err) {
        console.warn('YouTube discovery step failed:', describe(err));
        if (err instanceof YouTubeApiError && err.isQuota) break;
      }
    }
    return added;
  }
}

function topGenre(signals: TasteSignal[]): string | null {
  const weights = new Map<string, number>();
  for (const s of signals) {
    if (s.weight <= 0) continue;
    for (const g of s.genres) weights.set(g, (weights.get(g) ?? 0) + s.weight);
  }
  let best: string | null = null;
  let bestWeight = 0;
  for (const [g, w] of weights) {
    if (w > bestWeight) {
      best = g;
      bestWeight = w;
    }
  }
  return best;
}
