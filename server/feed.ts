import type { FeedItem } from '../shared/types.ts';
import { all, get, run, type DB } from './db.ts';
import { normalizeArtistName, splitArtists } from './music.ts';
import {
  buildProfile,
  pickFeed,
  SIGNAL_WEIGHTS,
  withSimilarArtists,
  type Candidate,
  type SimilarArtistRow,
  type TasteProfile,
  type TasteSignal,
} from './recommender.ts';
import { getSongRow, getSongRows, myStates, parseList, rowToSong, songStats, type SongRow } from './songs.ts';

const TRENDING_WINDOW = 3 * 24 * 60 * 60 * 1000;

interface SignalRow {
  song_id: string;
  title: string;
  artist: string;
  genres: string;
  tags: string;
  kind: 'favorite' | 'like' | 'dislike' | 'save' | 'library' | 'listened' | 'skip';
}

/** Everything we know about a listener's taste, merged per song. */
export function loadSignals(db: DB, userId: string): TasteSignal[] {
  const rows = all<SignalRow>(
    db,
    `SELECT s.id AS song_id, s.title, s.artist, s.genres, s.tags, x.kind FROM (
       SELECT song_id, 'favorite' AS kind FROM favorites WHERE user_id = :me
       UNION ALL SELECT song_id, CASE value WHEN 1 THEN 'like' ELSE 'dislike' END FROM reactions WHERE user_id = :me
       UNION ALL SELECT song_id, 'save' FROM saves WHERE user_id = :me
       UNION ALL SELECT song_id, 'library' FROM library WHERE user_id = :me
       UNION ALL SELECT v.song_id, CASE WHEN v.watched_sec >= 45 THEN 'listened' ELSE 'skip' END FROM views v
         WHERE v.user_id = :me AND (v.watched_sec >= 45 OR v.watched_sec < 5)
           AND NOT EXISTS (SELECT 1 FROM reactions r WHERE r.user_id = :me AND r.song_id = v.song_id)
     ) x JOIN songs s ON s.id = x.song_id`,
    { me: userId },
  );

  const bySong = new Map<string, TasteSignal>();
  for (const row of rows) {
    const weight = SIGNAL_WEIGHTS[row.kind];
    const isSeed = row.kind === 'favorite' || row.kind === 'like' || row.kind === 'save' || row.kind === 'library';
    const existing = bySong.get(row.song_id);
    if (existing) {
      existing.weight += weight;
      existing.seed ||= isSeed;
    } else {
      bySong.set(row.song_id, {
        songId: row.song_id,
        title: row.title,
        artist: row.artist,
        genres: parseList(row.genres),
        tags: parseList(row.tags),
        weight,
        seed: isSeed,
      });
    }
  }
  return [...bySong.values()];
}

interface CandidateRow extends SongRow {
  community_likes: number;
  last_seen_at: number | null;
}

/** Songs the listener could be shown: available and not already liked, disliked, saved or known. */
export function loadCandidates(db: DB, userId: string, now: number, max = 4000): Candidate[] {
  const rows = all<CandidateRow>(
    db,
    `SELECT s.*, v.last_seen_at,
       (SELECT COUNT(*) FROM reactions r WHERE r.song_id = s.id AND r.value = 1) AS community_likes
     FROM songs s
     LEFT JOIN views v ON v.user_id = :me AND v.song_id = s.id
     WHERE s.unavailable = 0
       AND NOT EXISTS (SELECT 1 FROM favorites f WHERE f.user_id = :me AND f.song_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM reactions r WHERE r.user_id = :me AND r.song_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM saves sv WHERE sv.user_id = :me AND sv.song_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM library l WHERE l.user_id = :me AND l.song_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM playback_failures pf WHERE pf.user_id = :me AND pf.song_id = s.id)
     ORDER BY v.last_seen_at IS NOT NULL, random()
     LIMIT :max`,
    { me: userId, max },
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    artist: r.artist,
    genres: parseList(r.genres),
    tags: parseList(r.tags),
    popularity: r.popularity,
    communityLikes: r.community_likes,
    trending: r.trending_at !== null && now - r.trending_at < TRENDING_WINDOW,
    lastSeenAt: r.last_seen_at,
    collab: 0,
    friends: 0,
  }));
}

/** Followed listeners who share their activity, as SQL. Binds :me. */
const SHARED_FRIEND_ACTIVITY = `
  SELECT x.user_id, x.song_id, x.created_at, x.kind FROM (
    SELECT user_id, song_id, created_at, 'saved' AS kind FROM saves
    UNION ALL SELECT user_id, song_id, created_at, 'liked' FROM reactions WHERE value = 1
  ) x
  JOIN follows f ON f.followee_id = x.user_id AND f.follower_id = :me
  JOIN users u ON u.id = x.user_id
  WHERE COALESCE(json_extract(u.settings, '$.shareActivity'), 1) = 1`;

/** For each song: how many people this listener follows liked or saved it. */
export function friendCounts(db: DB, userId: string): Map<string, number> {
  const rows = all<{ song_id: string; n: number }>(
    db,
    `SELECT a.song_id, COUNT(DISTINCT a.user_id) AS n FROM (${SHARED_FRIEND_ACTIVITY}) a GROUP BY a.song_id`,
    { me: userId },
  );
  return new Map(rows.map((r) => [r.song_id, r.n]));
}

/** Liked artists' display names by key, so reasons can say "Similar to Arctic Monkeys". */
function artistNames(signals: TasteSignal[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const s of signals) {
    if (s.weight <= 0) continue;
    for (const name of splitArtists(s.artist)) names.set(normalizeArtistName(name), name);
  }
  return names;
}

/** The listener's most-liked artists, best first. */
export function topArtists(profile: TasteProfile, signals: TasteSignal[], count: number): { key: string; name: string }[] {
  const names = artistNames(signals);
  return [...profile.artists]
    .filter(([key, value]) => value > 0.15 && names.has(key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key]) => ({ key, name: names.get(key)! }));
}

/** Adds cached similar-artist data (see server/similar.ts) to a taste profile. */
export function attachSimilarArtists(db: DB, profile: TasteProfile, signals: TasteSignal[]): TasteProfile {
  const top = topArtists(profile, signals, 10);
  if (!top.length) return profile;
  const rows = all<SimilarArtistRow>(
    db,
    `SELECT artist_key AS artistKey, similar_key AS similarKey, score FROM similar_artists
     WHERE artist_key IN (${top.map(() => '?').join(', ')})`,
    top.map((a) => a.key),
  );
  return withSimilarArtists(profile, rows, artistNames(signals));
}

/** For each song: how many other listeners who share a liked song with this listener also liked it. */
export function collaborativeCounts(db: DB, userId: string): Map<string, number> {
  const rows = all<{ song_id: string; n: number }>(
    db,
    `WITH positives AS (
       SELECT user_id, song_id FROM favorites
       UNION SELECT user_id, song_id FROM reactions WHERE value = 1
       UNION SELECT user_id, song_id FROM saves
     ),
     peers AS (
       SELECT DISTINCT p.user_id FROM positives p
       JOIN positives mine ON mine.song_id = p.song_id AND mine.user_id = :me
       WHERE p.user_id != :me
     )
     SELECT p.song_id, COUNT(DISTINCT p.user_id) AS n FROM positives p
     JOIN peers ON peers.user_id = p.user_id
     GROUP BY p.song_id`,
    { me: userId },
  );
  return new Map(rows.map((r) => [r.song_id, r.n]));
}

/** Count of fresh (unseen) candidates, used to decide whether to fetch more songs from YouTube. */
export function countFreshCandidates(db: DB, userId: string): number {
  return all<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM songs s WHERE s.unavailable = 0
       AND NOT EXISTS (SELECT 1 FROM views v WHERE v.user_id = :me AND v.song_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM favorites f WHERE f.user_id = :me AND f.song_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM reactions r WHERE r.user_id = :me AND r.song_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM library l WHERE l.user_id = :me AND l.song_id = s.id)`,
    { me: userId },
  )[0]!.n;
}

/** Attaches public stats and the listener's own state to songs. */
export function toFeedItems(db: DB, userId: string, rows: { row: SongRow; reason: string }[]): FeedItem[] {
  const ids = rows.map((r) => r.row.id);
  const stats = songStats(db, ids);
  const states = myStates(db, userId, ids);
  return rows.map(({ row, reason }) => ({
    ...rowToSong(row),
    stats: stats.get(row.id)!,
    me: states.get(row.id)!,
    reason,
  }));
}

export interface BuildFeedOptions {
  limit: number;
  exclude: Set<string>;
  startWith?: string;
  now: number;
  random: () => number;
}

export function buildFeed(db: DB, userId: string, opts: BuildFeedOptions): FeedItem[] {
  const { limit, exclude, now, random } = opts;
  const signals = loadSignals(db, userId);
  const profile = attachSimilarArtists(db, buildProfile(signals), signals);
  const collab = collaborativeCounts(db, userId);
  const friends = friendCounts(db, userId);
  const candidates = loadCandidates(db, userId, now)
    .filter((c) => !exclude.has(c.id) && c.id !== opts.startWith)
    .map((c) => ({ ...c, collab: collab.get(c.id) ?? 0, friends: friends.get(c.id) ?? 0 }));

  // Fresh picks are rationed across batches, so remember how long ago the last one was.
  const sinceFresh =
    get<{ songs_since_fresh: number }>(db, 'SELECT songs_since_fresh FROM users WHERE id = ?', [userId])?.songs_since_fresh ?? 0;
  const picks = pickFeed({ profile, candidates, signals, limit, now, random, sinceFresh });
  const since = picks.reduce((n, pick) => (pick.fresh ? 0 : n + 1), sinceFresh);
  run(db, 'UPDATE users SET songs_since_fresh = ? WHERE id = ?', [since, userId]);
  const rows: { row: SongRow; reason: string }[] = [];

  if (opts.startWith && !exclude.has(opts.startWith)) {
    const shared = getSongRow(db, opts.startWith);
    if (shared && !shared.unavailable) rows.push({ row: shared, reason: 'Shared with you' });
  }
  for (const pick of picks) {
    const row = getSongRow(db, pick.candidate.id);
    if (row) rows.push({ row, reason: pick.reason });
  }
  return toFeedItems(db, userId, rows.slice(0, Math.max(limit, 1)));
}

/** "Saved by Ania", "Liked by Ania and Tom", "Saved by Ania and 3 others". */
export function friendsReason(names: string[], saved: boolean): string {
  const verb = saved ? 'Saved' : 'Liked';
  if (names.length <= 1) return `${verb} by ${names[0] ?? 'a friend'}`;
  if (names.length === 2) return `${verb} by ${names[0]} and ${names[1]}`;
  return `${verb} by ${names[0]} and ${names.length - 1} others`;
}

/** The Friends feed: songs the people you follow liked or saved, most recent first. */
export function buildFriendsFeed(db: DB, userId: string, opts: { limit: number; exclude: Set<string> }): FeedItem[] {
  const rows = all<{ user_id: string; song_id: string; kind: 'saved' | 'liked'; display_name: string }>(
    db,
    `SELECT a.user_id, a.song_id, a.kind, u.display_name FROM (${SHARED_FRIEND_ACTIVITY}) a
     JOIN users u ON u.id = a.user_id
     JOIN songs s ON s.id = a.song_id
     WHERE s.unavailable = 0
       AND NOT EXISTS (SELECT 1 FROM reactions r WHERE r.user_id = :me AND r.song_id = a.song_id AND r.value = -1)
       AND NOT EXISTS (SELECT 1 FROM playback_failures pf WHERE pf.user_id = :me AND pf.song_id = a.song_id)
     ORDER BY a.created_at DESC
     LIMIT 2000`,
    { me: userId },
  );

  // Group by song, keeping the order of the most recent activity.
  const bySong = new Map<string, { names: string[]; saved: boolean }>();
  for (const row of rows) {
    if (opts.exclude.has(row.song_id)) continue;
    let entry = bySong.get(row.song_id);
    if (!entry) {
      if (bySong.size >= opts.limit) continue;
      entry = { names: [], saved: false };
      bySong.set(row.song_id, entry);
    }
    if (!entry.names.includes(row.display_name)) entry.names.push(row.display_name);
    if (row.kind === 'saved') entry.saved = true;
  }

  const songs = getSongRows(db, [...bySong.keys()]);
  const items: { row: SongRow; reason: string }[] = [];
  for (const [songId, entry] of bySong) {
    const row = songs.get(songId);
    if (row) items.push({ row, reason: friendsReason(entry.names, entry.saved) });
  }
  return toFeedItems(db, userId, items);
}
