import { Router } from 'express';
import type { Comment, CommentsPage, ReactionResponse, ReactionValue, SaveResponse, SyncStatus } from '../../shared/types.ts';
import type { AppContext } from '../context.ts';
import { all, get, run } from '../db.ts';
import { HttpError, RateLimiter, badRequest, notFound } from '../http.ts';
import { requireUser } from '../session.ts';
import { songStats } from '../songs.ts';
import { UNSAFE_CHARS } from '../users.ts';
import { body, intInRange, songFromParams } from '../validate.ts';

const COMMENT_MAX = 300;
const COMMENTS_PER_PAGE = 30;

export function cleanComment(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(UNSAFE_CHARS, (c) => (c === '\n' ? '\n' : ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length >= 1 && text.length <= COMMENT_MAX ? text : null;
}

interface CommentRow {
  id: number;
  song_id: string;
  body: string;
  created_at: number;
  user_id: string;
  display_name: string;
  google_picture: string | null;
  google_sub: string | null;
}

function toComment(row: CommentRow, viewerId: string): Comment {
  return {
    id: row.id,
    songId: row.song_id,
    body: row.body,
    createdAt: row.created_at,
    author: {
      id: row.user_id,
      displayName: row.display_name,
      avatarUrl: row.google_sub ? row.google_picture : null,
    },
    mine: row.user_id === viewerId,
  };
}

const COMMENT_SELECT = `SELECT c.id, c.song_id, c.body, c.created_at, c.user_id, u.display_name, u.google_picture, u.google_sub
  FROM comments c JOIN users u ON u.id = c.user_id`;

export function socialRoutes(ctx: AppContext): Router {
  const router = Router();
  const commentLimiter = new RateLimiter(8, 60_000, ctx.now);

  router.put('/songs/:id/reaction', async (req, res) => {
    const user = requireUser(req);
    const song = songFromParams(ctx.db, req);
    const value = body(req).value;
    if (value !== 1 && value !== -1 && value !== 0) throw badRequest('value must be 1 (like), -1 (dislike) or 0 (none)');

    const previous = get<{ value: ReactionValue }>(ctx.db, 'SELECT value FROM reactions WHERE user_id = ? AND song_id = ?', [
      user.id,
      song.id,
    ]);
    if (value === 0) {
      run(ctx.db, 'DELETE FROM reactions WHERE user_id = ? AND song_id = ?', [user.id, song.id]);
    } else {
      run(
        ctx.db,
        `INSERT INTO reactions (user_id, song_id, value, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, song_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
        [user.id, song.id, value, ctx.now()],
      );
    }
    const changed = (previous?.value ?? 0) !== value;
    const youtube: SyncStatus = changed ? await ctx.youtube.syncReaction(user, song.id, value) : 'off';
    res.json({ reaction: value, stats: songStats(ctx.db, [song.id]).get(song.id)!, youtube } satisfies ReactionResponse);
  });

  router.put('/songs/:id/save', async (req, res) => {
    const user = requireUser(req);
    const song = songFromParams(ctx.db, req);
    const saved = body(req).saved;
    if (typeof saved !== 'boolean') throw badRequest('saved must be true or false');

    const existing = get<{ yt_item_id: string | null }>(ctx.db, 'SELECT yt_item_id FROM saves WHERE user_id = ? AND song_id = ?', [
      user.id,
      song.id,
    ]);
    let youtube: SyncStatus = 'off';
    if (saved && !existing) {
      run(ctx.db, 'INSERT INTO saves (user_id, song_id, created_at) VALUES (?, ?, ?)', [user.id, song.id, ctx.now()]);
      const sync = await ctx.youtube.syncSave(user, song.id, true, null);
      if (sync.itemId) {
        run(ctx.db, 'UPDATE saves SET yt_item_id = ? WHERE user_id = ? AND song_id = ?', [sync.itemId, user.id, song.id]);
      }
      youtube = sync.status;
    } else if (!saved && existing) {
      run(ctx.db, 'DELETE FROM saves WHERE user_id = ? AND song_id = ?', [user.id, song.id]);
      youtube = (await ctx.youtube.syncSave(user, song.id, false, existing.yt_item_id)).status;
    }
    res.json({ saved, stats: songStats(ctx.db, [song.id]).get(song.id)!, youtube } satisfies SaveResponse);
  });

  router.get('/songs/:id/comments', (req, res) => {
    const user = requireUser(req);
    const song = songFromParams(ctx.db, req);
    const cursor = intInRange(req.query.cursor, 0, Number.MAX_SAFE_INTEGER, 0);
    const rows = all<CommentRow>(
      ctx.db,
      `${COMMENT_SELECT} WHERE c.song_id = :song ${cursor ? 'AND c.id < :cursor' : ''} ORDER BY c.id DESC LIMIT :limit`,
      cursor ? { song: song.id, cursor, limit: COMMENTS_PER_PAGE + 1 } : { song: song.id, limit: COMMENTS_PER_PAGE + 1 },
    );
    const page = rows.slice(0, COMMENTS_PER_PAGE);
    const total = get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM comments WHERE song_id = ?', [song.id])!.n;
    res.json({
      comments: page.map((r) => toComment(r, user.id)),
      nextCursor: rows.length > COMMENTS_PER_PAGE ? page[page.length - 1]!.id : null,
      total,
    } satisfies CommentsPage);
  });

  router.post('/songs/:id/comments', (req, res) => {
    const user = requireUser(req);
    const song = songFromParams(ctx.db, req);
    const text = cleanComment(body(req).body);
    if (!text) throw badRequest(`Comments need to be between 1 and ${COMMENT_MAX} characters`, 'bad_comment');
    commentLimiter.consume(user.id);
    const { lastInsertRowid } = run(ctx.db, 'INSERT INTO comments (song_id, user_id, body, created_at) VALUES (?, ?, ?, ?)', [
      song.id,
      user.id,
      text,
      ctx.now(),
    ]);
    const row = get<CommentRow>(ctx.db, `${COMMENT_SELECT} WHERE c.id = ?`, [lastInsertRowid])!;
    res.status(201).json(toComment(row, user.id));
  });

  router.delete('/comments/:commentId', (req, res) => {
    const user = requireUser(req);
    const id = Number(req.params.commentId);
    if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('Invalid comment id');
    const comment = get<{ user_id: string }>(ctx.db, 'SELECT user_id FROM comments WHERE id = ?', [id]);
    if (!comment) throw notFound('Comment not found');
    if (comment.user_id !== user.id) throw new HttpError(403, 'forbidden', 'You can only delete your own comments');
    run(ctx.db, 'DELETE FROM comments WHERE id = ?', [id]);
    res.status(204).end();
  });

  return router;
}
