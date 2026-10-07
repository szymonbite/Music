import type { FeedItem } from '../shared/types.ts';
import { all, type DB } from './db.ts';
import { buildProfile, pickFeed, SIGNAL_WEIGHTS, type Candidate, type TasteSignal } from './recommender.ts';
import { getSongRow, myStates, parseList, rowToSong, songStats, type SongRow } from './songs.ts';

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
  }));
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
  const profile = buildProfile(signals);
  const collab = collaborativeCounts(db, userId);
  const candidates = loadCandidates(db, userId, now)
    .filter((c) => !exclude.has(c.id) && c.id !== opts.startWith)
    .map((c) => ({ ...c, collab: collab.get(c.id) ?? 0 }));

  const picks = pickFeed({ profile, candidates, signals, limit, now, random });
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
