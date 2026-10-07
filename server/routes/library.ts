import { Router } from 'express';
import type { LibraryItem, LibraryKind, LibraryResponse, Song } from '../../shared/types.ts';
import { isVideoId } from '../../shared/youtube.ts';
import type { AppContext } from '../context.ts';
import { all, run, transaction } from '../db.ts';
import { badRequest } from '../http.ts';
import { requireUser } from '../session.ts';
import { getSongRows, rowToSong, type SongRow } from '../songs.ts';
import { body, songFromParams } from '../validate.ts';

const LIBRARY_QUERIES: Record<LibraryKind, string> = {
  saved: 'SELECT s.*, x.created_at AS added_at FROM saves x JOIN songs s ON s.id = x.song_id WHERE x.user_id = ?',
  liked: 'SELECT s.*, x.created_at AS added_at FROM reactions x JOIN songs s ON s.id = x.song_id WHERE x.user_id = ? AND x.value = 1',
  disliked: 'SELECT s.*, x.created_at AS added_at FROM reactions x JOIN songs s ON s.id = x.song_id WHERE x.user_id = ? AND x.value = -1',
  favorites: 'SELECT s.*, x.created_at AS added_at FROM favorites x JOIN songs s ON s.id = x.song_id WHERE x.user_id = ?',
};

function isLibraryKind(value: unknown): value is LibraryKind {
  return typeof value === 'string' && value in LIBRARY_QUERIES;
}

function favoriteSongs(ctx: AppContext, userId: string): Song[] {
  return all<SongRow>(
    ctx.db,
    'SELECT s.* FROM favorites f JOIN songs s ON s.id = f.song_id WHERE f.user_id = ? ORDER BY f.created_at',
    [userId],
  ).map(rowToSong);
}

export function libraryRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/favorites', (req, res) => {
    const user = requireUser(req);
    res.json({ songs: favoriteSongs(ctx, user.id) });
  });

  /** Replaces the listener's favourites (the songs picked during onboarding). */
  router.put('/favorites', (req, res) => {
    const user = requireUser(req);
    const ids = body(req).songIds;
    if (!Array.isArray(ids) || ids.length > 300 || !ids.every(isVideoId)) {
      throw badRequest('songIds must be a list of up to 300 song ids');
    }
    const known = getSongRows(ctx.db, [...new Set(ids)]);
    const now = ctx.now();
    transaction(ctx.db, () => {
      run(ctx.db, 'DELETE FROM favorites WHERE user_id = ?', [user.id]);
      [...new Set(ids)].forEach((id, index) => {
        if (known.has(id)) {
          run(ctx.db, 'INSERT INTO favorites (user_id, song_id, created_at) VALUES (?, ?, ?)', [user.id, id, now + index]);
        }
      });
    });
    res.json({ songs: favoriteSongs(ctx, user.id) });
  });

  router.put('/favorites/:id', (req, res) => {
    const user = requireUser(req);
    const song = songFromParams(ctx.db, req);
    const favorite = body(req).favorite;
    if (typeof favorite !== 'boolean') throw badRequest('favorite must be true or false');
    if (favorite) {
      run(ctx.db, 'INSERT OR IGNORE INTO favorites (user_id, song_id, created_at) VALUES (?, ?, ?)', [user.id, song.id, ctx.now()]);
    } else {
      run(ctx.db, 'DELETE FROM favorites WHERE user_id = ? AND song_id = ?', [user.id, song.id]);
    }
    res.json({ favorite });
  });

  router.get('/library/:kind', (req, res) => {
    const user = requireUser(req);
    const kind = req.params.kind;
    if (!isLibraryKind(kind)) throw badRequest('Unknown library section');
    const rows = all<SongRow & { added_at: number }>(ctx.db, `${LIBRARY_QUERIES[kind]} ORDER BY x.created_at DESC LIMIT 500`, [user.id]);
    const items: LibraryItem[] = rows.map((row) => ({ ...rowToSong(row), addedAt: row.added_at }));
    res.json({ kind, items } satisfies LibraryResponse);
  });

  return router;
}
