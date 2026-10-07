import type { MySongState, ReactionValue, Song, SongSource, SongStats } from '../shared/types.ts';
import { thumbnailUrl } from '../shared/youtube.ts';
import { all, get, placeholders, run, type DB } from './db.ts';

export interface SongRow {
  id: string;
  title: string;
  artist: string;
  channel_id: string | null;
  channel_title: string | null;
  duration_sec: number | null;
  year: number | null;
  genres: string;
  tags: string;
  thumbnail_url: string | null;
  source: SongSource;
  popularity: number;
  trending_at: number | null;
  unavailable: number;
  created_at: number;
  updated_at: number;
}

export interface SongInput {
  id: string;
  title: string;
  artist: string;
  source: SongSource;
  channelId?: string | null;
  channelTitle?: string | null;
  durationSec?: number | null;
  year?: number | null;
  genres?: string[];
  tags?: string[];
  thumbnailUrl?: string | null;
  popularity?: number;
  trendingAt?: number | null;
  unavailable?: boolean;
}

/** Curated catalogue metadata wins over YouTube data, which wins over bare links. */
const SOURCE_RANK: Record<SongSource, number> = { catalog: 3, youtube: 2, link: 1 };

export function parseList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function rowToSong(row: SongRow): Song {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    year: row.year,
    durationSec: row.duration_sec,
    genres: parseList(row.genres),
    tags: parseList(row.tags),
    thumbnailUrl: row.thumbnail_url ?? thumbnailUrl(row.id),
    source: row.source,
  };
}

export function getSongRow(db: DB, id: string): SongRow | undefined {
  return get<SongRow>(db, 'SELECT * FROM songs WHERE id = ?', [id]);
}

export function getSongRows(db: DB, ids: string[]): Map<string, SongRow> {
  const result = new Map<string, SongRow>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const row of all<SongRow>(db, `SELECT * FROM songs WHERE id IN (${placeholders(chunk.length)})`, chunk)) {
      result.set(row.id, row);
    }
  }
  return result;
}

/** Inserts a song or merges new metadata into an existing one. */
export function upsertSong(db: DB, input: SongInput, now: number): void {
  const existing = getSongRow(db, input.id);
  if (!existing) {
    run(
      db,
      `INSERT INTO songs (id, title, artist, channel_id, channel_title, duration_sec, year, genres, tags,
         thumbnail_url, source, popularity, trending_at, unavailable, created_at, updated_at)
       VALUES (:id, :title, :artist, :channelId, :channelTitle, :durationSec, :year, :genres, :tags,
         :thumbnailUrl, :source, :popularity, :trendingAt, :unavailable, :now, :now)`,
      {
        id: input.id,
        title: input.title,
        artist: input.artist,
        channelId: input.channelId ?? null,
        channelTitle: input.channelTitle ?? null,
        durationSec: input.durationSec ?? null,
        year: input.year ?? null,
        genres: JSON.stringify(input.genres ?? []),
        tags: JSON.stringify(input.tags ?? []),
        thumbnailUrl: input.thumbnailUrl ?? null,
        source: input.source,
        popularity: input.popularity ?? 0.5,
        trendingAt: input.trendingAt ?? null,
        unavailable: input.unavailable ? 1 : 0,
        now,
      },
    );
    return;
  }

  const keepCurated = SOURCE_RANK[existing.source] > SOURCE_RANK[input.source];
  const existingGenres = parseList(existing.genres);
  const existingTags = parseList(existing.tags);
  const pickList = (incoming: string[] | undefined, current: string[]) =>
    JSON.stringify(keepCurated && current.length ? current : incoming?.length ? incoming : current);

  run(
    db,
    `UPDATE songs SET title = :title, artist = :artist, channel_id = :channelId, channel_title = :channelTitle,
       duration_sec = :durationSec, year = :year, genres = :genres, tags = :tags, thumbnail_url = :thumbnailUrl,
       source = :source, popularity = :popularity, trending_at = :trendingAt, unavailable = :unavailable,
       updated_at = :now
     WHERE id = :id`,
    {
      id: input.id,
      title: keepCurated ? existing.title : input.title || existing.title,
      artist: keepCurated ? existing.artist : input.artist || existing.artist,
      channelId: input.channelId ?? existing.channel_id,
      channelTitle: input.channelTitle ?? existing.channel_title,
      durationSec: input.durationSec ?? existing.duration_sec,
      year: keepCurated ? (existing.year ?? input.year ?? null) : (input.year ?? existing.year),
      genres: pickList(input.genres, existingGenres),
      tags: pickList(input.tags, existingTags),
      thumbnailUrl: input.thumbnailUrl ?? existing.thumbnail_url,
      source: keepCurated ? existing.source : input.source,
      popularity: input.popularity ?? existing.popularity,
      trendingAt: input.trendingAt ?? existing.trending_at,
      unavailable: input.unavailable === undefined ? existing.unavailable : input.unavailable ? 1 : 0,
      now,
    },
  );
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Case-insensitive search over titles and artists of songs we already know. */
export function searchSongs(db: DB, query: string, limit = 24): SongRow[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length) return [];
  const where = terms.map((_, i) => `(lower(title) LIKE :t${i} ESCAPE '\\' OR lower(artist) LIKE :t${i} ESCAPE '\\')`);
  const full = terms.join(' ');
  const params: Record<string, string | number> = { limit, exact: full, prefix: `${escapeLike(full)}%` };
  terms.forEach((term, i) => (params[`t${i}`] = `%${escapeLike(term)}%`));
  // Best matches first: exact artist, artist prefix, exact title, title prefix, then everything else.
  return all<SongRow>(
    db,
    `SELECT * FROM songs WHERE unavailable = 0 AND ${where.join(' AND ')}
     ORDER BY lower(artist) = :exact DESC, lower(artist) LIKE :prefix ESCAPE '\\' DESC,
       lower(title) = :exact DESC, lower(title) LIKE :prefix ESCAPE '\\' DESC,
       CASE source WHEN 'catalog' THEN 0 ELSE 1 END, popularity DESC, title
     LIMIT :limit`,
    params,
  );
}

export function genreCounts(db: DB): { genre: string; count: number }[] {
  return all<{ genre: string; count: number }>(
    db,
    `SELECT j.value AS genre, COUNT(*) AS count FROM songs, json_each(songs.genres) AS j
     WHERE songs.unavailable = 0 GROUP BY j.value HAVING count >= 2 ORDER BY count DESC, genre`,
  );
}

export function songStats(db: DB, ids: string[]): Map<string, SongStats> {
  const stats = new Map<string, SongStats>(ids.map((id) => [id, { likes: 0, comments: 0, saves: 0 }]));
  if (!ids.length) return stats;
  const ph = placeholders(ids.length);
  for (const r of all<{ song_id: string; n: number }>(
    db,
    `SELECT song_id, COUNT(*) AS n FROM reactions WHERE value = 1 AND song_id IN (${ph}) GROUP BY song_id`,
    ids,
  )) {
    stats.get(r.song_id)!.likes = r.n;
  }
  for (const r of all<{ song_id: string; n: number }>(
    db,
    `SELECT song_id, COUNT(*) AS n FROM comments WHERE song_id IN (${ph}) GROUP BY song_id`,
    ids,
  )) {
    stats.get(r.song_id)!.comments = r.n;
  }
  for (const r of all<{ song_id: string; n: number }>(
    db,
    `SELECT song_id, COUNT(*) AS n FROM saves WHERE song_id IN (${ph}) GROUP BY song_id`,
    ids,
  )) {
    stats.get(r.song_id)!.saves = r.n;
  }
  return stats;
}

export function myStates(db: DB, userId: string, ids: string[]): Map<string, MySongState> {
  const states = new Map<string, MySongState>(ids.map((id) => [id, { reaction: 0, saved: false, favorite: false }]));
  if (!ids.length) return states;
  const ph = placeholders(ids.length);
  for (const r of all<{ song_id: string; value: ReactionValue }>(
    db,
    `SELECT song_id, value FROM reactions WHERE user_id = ? AND song_id IN (${ph})`,
    [userId, ...ids],
  )) {
    states.get(r.song_id)!.reaction = r.value;
  }
  for (const r of all<{ song_id: string }>(db, `SELECT song_id FROM saves WHERE user_id = ? AND song_id IN (${ph})`, [userId, ...ids])) {
    states.get(r.song_id)!.saved = true;
  }
  for (const r of all<{ song_id: string }>(db, `SELECT song_id FROM favorites WHERE user_id = ? AND song_id IN (${ph})`, [userId, ...ids])) {
    states.get(r.song_id)!.favorite = true;
  }
  return states;
}
