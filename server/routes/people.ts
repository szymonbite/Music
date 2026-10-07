import { Router } from 'express';
import type { FollowResponse, PeopleResponse, PublicUser, UserProfile } from '../../shared/types.ts';
import type { AppContext } from '../context.ts';
import { all, get, run } from '../db.ts';
import { RateLimiter, badRequest, notFound } from '../http.ts';
import { requireUser } from '../session.ts';
import { escapeLike, rowToSong, type SongRow } from '../songs.ts';
import { parseSettings } from '../users.ts';
import { body, queryString } from '../validate.ts';

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVITY_LIMIT = 12;

interface PublicUserRow {
  id: string;
  display_name: string;
  google_picture: string | null;
  google_sub: string | null;
  settings: string;
  followers: number;
  following: number;
  is_following: number;
}

/** Every query using this must bind :me (the viewer). */
const USER_SELECT = `SELECT u.id, u.display_name, u.google_picture, u.google_sub, u.settings,
    (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS followers,
    (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id) AS following,
    EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = :me AND f.followee_id = u.id) AS is_following
  FROM users u`;

function toPublicUser(row: PublicUserRow, viewerId: string): PublicUser {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarUrl: row.google_sub ? row.google_picture : null,
    followers: row.followers,
    following: row.following,
    isFollowing: row.is_following === 1,
    isMe: row.id === viewerId,
  };
}

function userIdParam(value: string | undefined): string {
  if (!value || !USER_ID.test(value)) throw badRequest('Invalid user id');
  return value;
}

export function peopleRoutes(ctx: AppContext): Router {
  const router = Router();
  const followLimiter = new RateLimiter(30, 60_000, ctx.now);

  /** Listeners to follow: name search, or (without a query) people you follow first, then the most followed. */
  router.get('/users', (req, res) => {
    const user = requireUser(req);
    const q = queryString(req.query.q, 40).toLowerCase();
    const rows = all<PublicUserRow>(
      ctx.db,
      `${USER_SELECT}
       WHERE u.id != :me AND u.onboarded_at IS NOT NULL ${q ? "AND lower(u.display_name) LIKE :q ESCAPE '\\'" : ''}
       ORDER BY is_following DESC, followers DESC, u.created_at DESC
       LIMIT 50`,
      q ? { me: user.id, q: `%${escapeLike(q)}%` } : { me: user.id },
    );
    res.json({ people: rows.map((r) => toPublicUser(r, user.id)) } satisfies PeopleResponse);
  });

  router.get('/users/:userId', (req, res) => {
    const viewer = requireUser(req);
    const id = userIdParam(req.params.userId);
    const row = get<PublicUserRow>(ctx.db, `${USER_SELECT} WHERE u.id = :id`, { me: viewer.id, id });
    if (!row) throw notFound('That listener doesn’t exist');

    const isMe = row.id === viewer.id;
    const shares = isMe || parseSettings(row.settings).shareActivity;
    const activity = shares
      ? {
          saved: all<SongRow>(
            ctx.db,
            `SELECT s.* FROM saves x JOIN songs s ON s.id = x.song_id
             WHERE x.user_id = ? AND s.unavailable = 0 ORDER BY x.created_at DESC LIMIT ${ACTIVITY_LIMIT}`,
            [id],
          ).map(rowToSong),
          liked: all<SongRow>(
            ctx.db,
            `SELECT s.* FROM reactions x JOIN songs s ON s.id = x.song_id
             WHERE x.user_id = ? AND x.value = 1 AND s.unavailable = 0 ORDER BY x.created_at DESC LIMIT ${ACTIVITY_LIMIT}`,
            [id],
          ).map(rowToSong),
        }
      : null;
    res.json({ user: toPublicUser(row, viewer.id), activity } satisfies UserProfile);
  });

  router.put('/users/:userId/follow', (req, res) => {
    const user = requireUser(req);
    const id = userIdParam(req.params.userId);
    const following = body(req).following;
    if (typeof following !== 'boolean') throw badRequest('following must be true or false');
    if (id === user.id) throw badRequest('You can’t follow yourself');
    if (!get(ctx.db, 'SELECT 1 FROM users WHERE id = ?', [id])) throw notFound('That listener doesn’t exist');
    followLimiter.consume(user.id);
    if (following) {
      run(ctx.db, 'INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)', [user.id, id, ctx.now()]);
    } else {
      run(ctx.db, 'DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', [user.id, id]);
    }
    const followers = get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?', [id])!.n;
    res.json({ following, followers } satisfies FollowResponse);
  });

  return router;
}
