import { Router } from 'express';
import type { FeedResponse } from '../../shared/types.ts';
import { isVideoId } from '../../shared/youtube.ts';
import type { AppContext } from '../context.ts';
import { all, type DB } from '../db.ts';
import {
  attachSimilarArtists,
  buildFeed,
  buildFriendsFeed,
  countFreshCandidates,
  loadSignals,
  topArtists,
} from '../feed.ts';
import { artistKeys } from '../music.ts';
import { buildProfile, type TasteProfile } from '../recommender.ts';
import { requireUser } from '../session.ts';
import { escapeLike, getSongRow } from '../songs.ts';
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

/** Whether we already have at least one song by this artist. */
function haveSongsBy(db: DB, artist: { key: string; name: string }): boolean {
  const rows = all<{ artist: string }>(db, "SELECT artist FROM songs WHERE lower(artist) LIKE ? ESCAPE '\\' LIMIT 25", [
    `%${escapeLike(artist.name.toLowerCase())}%`,
  ]);
  return rows.some((r) => artistKeys(r.artist).includes(artist.key));
}

/** Similar artists the listener would probably like but we have no songs for yet: worth a YouTube search. */
function similarArtistsToFind(db: DB, profile: TasteProfile): { key: string; name: string }[] {
  const names = new Map(
    all<{ similar_key: string; similar_name: string }>(db, 'SELECT similar_key, similar_name FROM similar_artists').map((r) => [
      r.similar_key,
      r.similar_name,
    ]),
  );
  return [...profile.similar]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 8)
    .map(([key]) => ({ key, name: names.get(key) ?? '' }))
    .filter((a) => a.name && !haveSongsBy(db, a))
    .slice(0, 2);
}

export function feedRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/feed', async (req, res) => {
    const user = requireUser(req);
    const input = body(req);
    const limit = intInRange(input.limit, 1, 20, 8);
    const exclude = new Set(Array.isArray(input.exclude) ? input.exclude.filter(isVideoId).slice(0, 2000) : []);

    if (input.mode === 'friends') {
      res.json({ items: buildFriendsFeed(ctx.db, user.id, { limit, exclude }) } satisfies FeedResponse);
      return;
    }

    const startWith = isVideoId(input.startWith) ? input.startWith : undefined;
    if (startWith && !getSongRow(ctx.db, startWith)) {
      // A shared link to a song we haven't seen before.
      await ctx.youtube.resolveVideo(user, startWith).catch(() => null);
    }

    // Similar artists (cached for a month, refreshed at most every 6 hours per listener). The first time,
    // wait briefly so a brand new listener's first feed can already reach beyond their favourites.
    const signals = loadSignals(ctx.db, user.id);
    const top = topArtists(buildProfile(signals), signals, 6);
    const similarRefresh = ctx.similar.refreshForUser(user.id, top).catch(() => 0);
    if (top.length && !ctx.similar.hasAny(top.map((a) => a.key))) await within(similarRefresh, 2500);

    if (ctx.youtube.canCall(user)) {
      const discovery = similarRefresh
        .then(() => {
          const profile = attachSimilarArtists(ctx.db, buildProfile(signals), signals);
          return ctx.youtube.discover(user, signals, { similarArtists: similarArtistsToFind(ctx.db, profile) });
        })
        .catch((err: unknown) => {
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
