import { Router } from 'express';
import type { ResolveResponse, YouTubeLibrary } from '../../shared/types.ts';
import type { AppContext } from '../context.ts';
import { HttpError, badRequest } from '../http.ts';
import { requireUser } from '../session.ts';
import { rowToSong } from '../songs.ts';
import { isYouTubeConnected } from '../users.ts';
import { toHttpError } from '../youtube/service.ts';

export function youtubeRoutes(ctx: AppContext): Router {
  const router = Router();

  /** Liked songs and playlists from the connected YouTube Music account. */
  router.get('/youtube/library', async (req, res) => {
    const user = requireUser(req);
    if (!isYouTubeConnected(user)) throw new HttpError(409, 'youtube_not_connected', 'Connect YouTube Music first.');
    try {
      const library = await ctx.youtube.library(user);
      res.json({ liked: library.liked.map(rowToSong), playlists: library.playlists } satisfies YouTubeLibrary);
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.get('/youtube/playlists/:id', async (req, res) => {
    const user = requireUser(req);
    const id = req.params.id;
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) throw badRequest('Invalid playlist id');
    try {
      const { title, songs } = await ctx.youtube.playlistSongs(user, id, { addToLibrary: isYouTubeConnected(user) });
      res.json({ songs: songs.map(rowToSong), ...(title ? { playlistTitle: title } : {}) } satisfies ResolveResponse);
    } catch (err) {
      throw toHttpError(err);
    }
  });

  return router;
}
