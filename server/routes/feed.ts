import { Router } from 'express';
import type { FeedResponse } from '../../shared/types.ts';
import { isVideoId } from '../../shared/youtube.ts';
import type { AppContext } from '../context.ts';
import { buildFeed, countFreshCandidates, loadSignals } from '../feed.ts';
import { requireUser } from '../session.ts';
import { getSongRow } from '../songs.ts';
import { body, intInRange } from '../validate.ts';

/** When fewer unseen songs than this are left, wait (briefly) for YouTube discovery before ranking. */
const LOW_WATER_MARK = 30;

/** Resolves with the promise's value, or undefined if it takes longer than ms. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function feedRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/feed', async (req, res) => {
    const user = requireUser(req);
    const input = body(req);
    const limit = intInRange(input.limit, 1, 20, 8);
    const exclude = new Set(Array.isArray(input.exclude) ? input.exclude.filter(isVideoId).slice(0, 2000) : []);
    const startWith = isVideoId(input.startWith) ? input.startWith : undefined;

    if (startWith && !getSongRow(ctx.db, startWith)) {
      // A shared link to a song we haven't seen before.
      await ctx.youtube.resolveVideo(user, startWith).catch(() => null);
    }

    if (ctx.youtube.canCall(user)) {
      const discovery = ctx.youtube.discover(user, loadSignals(ctx.db, user.id)).catch((err: unknown) => {
        console.warn('Discovery failed:', err instanceof Error ? err.message : err);
        return 0;
      });
      if (countFreshCandidates(ctx.db, user.id) < LOW_WATER_MARK) await within(discovery, 5000);
    }

    const items = buildFeed(ctx.db, user.id, {
      limit,
      exclude,
      startWith,
      now: ctx.now(),
      random: ctx.random,
    });
    res.json({ items } satisfies FeedResponse);
  });

  return router;
}
