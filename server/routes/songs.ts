import { Router } from 'express';
import type { GenreCount, ResolveResponse, SearchResponse, Song } from '../../shared/types.ts';
import { parseYouTubeRef } from '../../shared/youtube.ts';
import type { AppContext } from '../context.ts';
import { all, get, run } from '../db.ts';
import { toFeedItems } from '../feed.ts';
import { HttpError, RateLimiter, badRequest } from '../http.ts';
import { requireUser } from '../session.ts';
import { genreCounts, rowToSong, searchSongs, type SongRow } from '../songs.ts';
import { toHttpError } from '../youtube/service.ts';
import { body, intInRange, queryString, songFromParams } from '../validate.ts';

/** Playback errors that mean "this video can't be played here", as opposed to a network hiccup. */
const PERMANENT_PLAYER_ERRORS = new Set([100, 101, 150]);

export function songRoutes(ctx: AppContext): Router {
  const router = Router();
  const searchLimiter = new RateLimiter(20, 60_000, ctx.now);
  const resolveLimiter = new RateLimiter(20, 60_000, ctx.now);

  router.get('/genres', (req, res) => {
    requireUser(req);
    res.json({ genres: genreCounts(ctx.db) satisfies GenreCount[] });
  });

  /** Well-known songs to choose favourites from during onboarding. */
  router.get('/songs/starter', (req, res) => {
    requireUser(req);
    const genre = queryString(req.query.genre, 40);
    const limit = intInRange(req.query.limit, 1, 120, 60);
    const rows = all<SongRow>(
      ctx.db,
      `SELECT * FROM songs WHERE unavailable = 0 AND (source = 'catalog' OR trending_at IS NOT NULL)
       ${genre ? 'AND EXISTS (SELECT 1 FROM json_each(songs.genres) WHERE value = :genre)' : ''}`,
      genre ? { genre } : {},
    );
    const ranked = rows
      .map((row) => ({ row, rank: row.popularity + ctx.random() * 0.6 }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit)
      .map((r) => rowToSong(r.row));
    res.json({ songs: ranked });
  });

  router.get('/songs/search', async (req, res) => {
    const user = requireUser(req);
    const q = queryString(req.query.q, 100);
    const remoteAvailable = ctx.youtube.canCall(user);
    if (!q) {
      res.json({ local: [], remote: [], remoteAvailable } satisfies SearchResponse);
      return;
    }
    const local = searchSongs(ctx.db, q, 24).map(rowToSong);
    let remote: Song[] = [];
    let remoteError: string | undefined;
    if (req.query.remote === '1' && remoteAvailable) {
      searchLimiter.consume(user.id);
      try {
        const localIds = new Set(local.map((s) => s.id));
        remote = ((await ctx.youtube.search(user, q)) ?? []).filter((r) => !localIds.has(r.id)).map(rowToSong);
      } catch (err) {
        remoteError = toHttpError(err).message;
      }
    }
    res.json({ local, remote, remoteAvailable, ...(remoteError ? { remoteError } : {}) } satisfies SearchResponse);
  });

  /** Turns a pasted YouTube / YouTube Music link (song or playlist) into songs. */
  router.post('/songs/resolve', async (req, res) => {
    const user = requireUser(req);
    resolveLimiter.consume(user.id);
    const url = body(req).url;
    const ref = typeof url === 'string' ? parseYouTubeRef(url) : null;
    if (!ref) throw badRequest('That doesn’t look like a YouTube or YouTube Music link', 'bad_link');
    try {
      if (ref.type === 'video') {
        const row = await ctx.youtube.resolveVideo(user, ref.id);
        if (!row) throw new HttpError(404, 'video_not_found', 'Couldn’t find that video on YouTube');
        res.json({ songs: [rowToSong(row)] } satisfies ResolveResponse);
      } else {
        const { title, songs } = await ctx.youtube.playlistSongs(user, ref.id, { addToLibrary: false });
        res.json({ songs: songs.map(rowToSong), ...(title ? { playlistTitle: title } : {}) } satisfies ResolveResponse);
      }
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.get('/songs/:id', (req, res) => {
    const user = requireUser(req);
    const row = songFromParams(ctx.db, req);
    res.json(toFeedItems(ctx.db, user.id, [{ row, reason: '' }])[0]);
  });

  /** Called when a song scrolls away, with how long it actually played. Feeds the skip / listen signals. */
  router.post('/songs/:id/seen', (req, res) => {
    const user = requireUser(req);
    const row = songFromParams(ctx.db, req);
    const watched = intInRange(body(req).watchedSec, 0, 3600, 0);
    run(
      ctx.db,
      `INSERT INTO views (user_id, song_id, seen_count, watched_sec, last_seen_at) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(user_id, song_id) DO UPDATE SET seen_count = seen_count + 1,
         watched_sec = MAX(watched_sec, excluded.watched_sec), last_seen_at = excluded.last_seen_at`,
      [user.id, row.id, watched, ctx.now()],
    );
    res.status(204).end();
  });

  /** The player couldn't play this video. Hide it for this listener, and for everyone once confirmed. */
  router.post('/songs/:id/unavailable', (req, res) => {
    const user = requireUser(req);
    const row = songFromParams(ctx.db, req);
    const code = intInRange(body(req).code, 0, 1000, 0);
    run(
      ctx.db,
      'INSERT OR REPLACE INTO playback_failures (user_id, song_id, code, created_at) VALUES (?, ?, ?, ?)',
      [user.id, row.id, code, ctx.now()],
    );
    if (PERMANENT_PLAYER_ERRORS.has(code)) {
      const reports = get<{ n: number }>(
        ctx.db,
        'SELECT COUNT(DISTINCT user_id) AS n FROM playback_failures WHERE song_id = ? AND code IN (100, 101, 150)',
        [row.id],
      )!.n;
      if (reports >= 2) run(ctx.db, 'UPDATE songs SET unavailable = 1 WHERE id = ?', [row.id]);
    }
    res.status(204).end();
  });

  return router;
}
