// "Similar artists" lookups, so discovery can reach beyond the artists a
// listener already knows. Uses Last.fm when LASTFM_API_KEY is set, otherwise
// Deezer's public API (no key needed). Results are cached in SQLite.

import { isDue, markFetched, run, transaction, type DB } from './db.ts';
import { normalizeArtistName } from './music.ts';
import type { FetchLike } from './youtube/client.ts';

export interface SimilarArtist {
  name: string;
  /** 0..1, higher is more similar. */
  score: number;
}

export interface SimilarArtistsProvider {
  readonly name: string;
  similar(artist: string): Promise<SimilarArtist[]>;
}

const DAY = 24 * 60 * 60 * 1000;
const CACHE_DAYS = 30;

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}

export class LastFmProvider implements SimilarArtistsProvider {
  readonly name = 'Last.fm';
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(apiKey: string, fetchImpl: FetchLike = (input, init) => fetch(input, init), timeoutMs = 8000) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async similar(artist: string): Promise<SimilarArtist[]> {
    const params = new URLSearchParams({
      method: 'artist.getsimilar',
      artist,
      api_key: this.apiKey,
      format: 'json',
      limit: '20',
      autocorrect: '1',
    });
    const data = (await getJson(this.fetchImpl, `https://ws.audioscrobbler.com/2.0/?${params}`, this.timeoutMs)) as {
      error?: number;
      message?: string;
      similarartists?: { artist?: { name?: unknown; match?: unknown }[] };
    };
    if (data.error === 6) return []; // artist not found
    if (data.error) throw new Error(`Last.fm: ${data.message ?? data.error}`);
    return (data.similarartists?.artist ?? [])
      .filter((a): a is { name: string; match: unknown } => typeof a.name === 'string')
      .map((a) => ({ name: a.name, score: Math.max(0, Math.min(1, Number(a.match) || 0)) }));
  }
}

export class DeezerProvider implements SimilarArtistsProvider {
  readonly name = 'Deezer';
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(fetchImpl: FetchLike = (input, init) => fetch(input, init), timeoutMs = 8000) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async similar(artist: string): Promise<SimilarArtist[]> {
    type Artists = { data?: { id?: unknown; name?: unknown }[]; error?: { message?: string } };
    const found = (await getJson(
      this.fetchImpl,
      `https://api.deezer.com/search/artist?q=${encodeURIComponent(artist)}&limit=5`,
      this.timeoutMs,
    )) as Artists;
    if (found.error) throw new Error(`Deezer: ${found.error.message ?? 'error'}`);
    const key = normalizeArtistName(artist);
    const candidates = (found.data ?? []).filter((a) => typeof a.id === 'number' && typeof a.name === 'string');
    const match = candidates.find((a) => normalizeArtistName(a.name as string) === key) ?? candidates[0];
    if (!match) return [];

    const related = (await getJson(this.fetchImpl, `https://api.deezer.com/artist/${match.id as number}/related?limit=20`, this.timeoutMs)) as Artists;
    if (related.error) throw new Error(`Deezer: ${related.error.message ?? 'error'}`);
    const names = (related.data ?? []).map((a) => a.name).filter((n): n is string => typeof n === 'string');
    // Deezer lists related artists best-first without scores.
    return names.map((name, i) => ({ name, score: 1 - i / (names.length + 1) }));
  }
}

export class SimilarArtists {
  private readonly db: DB;
  private readonly provider: SimilarArtistsProvider | null;
  private readonly now: () => number;

  constructor(deps: { db: DB; provider: SimilarArtistsProvider | null; now: () => number }) {
    this.db = deps.db;
    this.provider = deps.provider;
    this.now = deps.now;
  }

  get providerName(): string | null {
    return this.provider?.name ?? null;
  }

  /**
   * Looks up (and caches for 30 days) similar artists for up to `maxLookups`
   * of the given artists that aren't cached yet. Returns the number looked up.
   */
  async refresh(artists: { key: string; name: string }[], maxLookups = 4): Promise<number> {
    if (!this.provider) return 0;
    let lookups = 0;
    for (const artist of artists) {
      if (lookups >= maxLookups) break;
      const cacheKey = `similar:${artist.key}`;
      if (!isDue(this.db, cacheKey, CACHE_DAYS * DAY, this.now())) continue;
      lookups++;
      try {
        const similar = await this.provider.similar(artist.name);
        this.store(artist.key, similar);
        markFetched(this.db, cacheKey, this.now());
      } catch (err) {
        console.warn(`Similar artists for "${artist.name}" failed:`, err instanceof Error ? err.message : err);
        // Try again in about a day rather than on every request.
        markFetched(this.db, cacheKey, this.now() - (CACHE_DAYS - 1) * DAY);
      }
    }
    return lookups;
  }

  /** Same as refresh(), but at most every 6 hours per listener. */
  async refreshForUser(userId: string, artists: { key: string; name: string }[]): Promise<number> {
    if (!this.provider || !artists.length) return 0;
    const throttleKey = `similar-user:${userId}`;
    if (!isDue(this.db, throttleKey, DAY / 4, this.now())) return 0;
    markFetched(this.db, throttleKey, this.now());
    return this.refresh(artists);
  }

  /** Whether any of these artists has cached similar artists yet. */
  hasAny(artistKeys: string[]): boolean {
    if (!artistKeys.length) return false;
    const placeholders = artistKeys.map(() => '?').join(', ');
    return this.db.prepare(`SELECT 1 FROM similar_artists WHERE artist_key IN (${placeholders}) LIMIT 1`).get(...artistKeys) !== undefined;
  }

  private store(artistKey: string, similar: SimilarArtist[]): void {
    const best = new Map<string, SimilarArtist>();
    for (const s of similar) {
      const key = normalizeArtistName(s.name);
      if (!key || key === artistKey) continue;
      const current = best.get(key);
      if (!current || s.score > current.score) best.set(key, s);
    }
    transaction(this.db, () => {
      run(this.db, 'DELETE FROM similar_artists WHERE artist_key = ?', [artistKey]);
      for (const [key, s] of best) {
        run(this.db, 'INSERT INTO similar_artists (artist_key, similar_key, similar_name, score) VALUES (?, ?, ?, ?)', [
          artistKey,
          key,
          s.name,
          s.score,
        ]);
      }
    });
  }
}
