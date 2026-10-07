import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Comment, Song } from '../../shared/types.ts';
import { api } from '../api.ts';
import { errorMessage, formatCount, timeAgo } from '../lib/format.ts';
import { useSession } from '../session.tsx';
import { useToast } from '../toast.tsx';
import { Avatar } from './Avatar.tsx';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';

const QUICK_REACTIONS = ['🔥', '😍', '🎧', '💯', '😭', '👏'];
const MAX_LENGTH = 300;

interface CommentsSheetProps {
  song: Song;
  onClose: () => void;
  /** Called with the change in comment count so the feed can keep its counter in sync. */
  onCountChange: (delta: number) => void;
  /** Open a listener's profile. */
  onOpenUser?: (userId: string) => void;
}

type PageState = { comments: Comment[]; nextCursor: number | null; total: number };

interface CommentRowProps {
  comment: Comment;
  onLike: (comment: Comment) => void;
  onReply: (comment: Comment) => void;
  onDelete: (comment: Comment) => void;
  onOpenUser?: (userId: string) => void;
}

function CommentRow({ comment: c, onLike, onReply, onDelete, onOpenUser }: CommentRowProps) {
  const author = <Avatar id={c.author.id} name={c.author.displayName} url={c.author.avatarUrl} size={c.parentId ? 28 : 34} />;
  return (
    <div className={`comment${c.parentId ? ' comment--reply' : ''}`}>
      {onOpenUser ? (
        <button type="button" className="comment__avatar" aria-label={`Open ${c.author.displayName}’s profile`} onClick={() => onOpenUser(c.author.id)}>
          {author}
        </button>
      ) : (
        author
      )}
      <div className="comment__main">
        <p className="comment__meta">
          {onOpenUser ? (
            <button type="button" className="comment__author" onClick={() => onOpenUser(c.author.id)}>
              {c.author.displayName}
            </button>
          ) : (
            <span className="comment__author">{c.author.displayName}</span>
          )}
          {c.mine && <span className="comment__you">you</span>}
        </p>
        <p className="comment__body">{c.body}</p>
        <p className="comment__actions">
          <time dateTime={new Date(c.createdAt).toISOString()}>{timeAgo(c.createdAt)}</time>
          <button type="button" className="comment__action" onClick={() => onReply(c)}>
            Reply
          </button>
          {c.mine && (
            <button type="button" className="comment__action" aria-label="Delete comment" onClick={() => onDelete(c)}>
              <Icon name="trash" size={14} />
            </button>
          )}
        </p>
      </div>
      <button
        type="button"
        className="comment__like"
        aria-pressed={c.liked}
        aria-label={`Like comment (${c.likes})`}
        onClick={() => onLike(c)}
      >
        <Icon name="heart" size={18} filled={c.liked} />
        {c.likes > 0 && <span aria-hidden="true">{formatCount(c.likes)}</span>}
      </button>
    </div>
  );
}

export function CommentsSheet({ song, onClose, onCountChange, onOpenUser }: CommentsSheetProps) {
  const { me } = useSession();
  const toast = useToast();
  const [page, setPage] = useState<PageState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [replies, setReplies] = useState<Record<number, Comment[] | undefined>>({});
  const [replyingTo, setReplyingTo] = useState<Comment | null>(null);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .comments(song.id)
      .then((result) => {
        if (!cancelled) setPage(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [song.id]);

  /** Applies a change to a comment wherever it is (top level or in a thread). */
  const updateComment = (id: number, change: (c: Comment) => Comment) => {
    setPage((p) => (p ? { ...p, comments: p.comments.map((c) => (c.id === id ? change(c) : c)) } : p));
    setReplies((all) => {
      const next: Record<number, Comment[] | undefined> = {};
      for (const [parent, list] of Object.entries(all)) next[Number(parent)] = list?.map((c) => (c.id === id ? change(c) : c));
      return next;
    });
  };

  const loadMore = async () => {
    if (!page?.nextCursor) return;
    setLoadingMore(true);
    try {
      const more = await api.comments(song.id, page.nextCursor);
      setPage((p) => (p ? { comments: [...p.comments, ...more.comments], nextCursor: more.nextCursor, total: more.total } : p));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const showReplies = async (parent: Comment) => {
    try {
      const { replies: list } = await api.replies(parent.id);
      setReplies((all) => ({ ...all, [parent.id]: list }));
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const startReply = (comment: Comment) => {
    setReplyingTo(comment);
    inputRef.current?.focus();
  };

  const like = async (comment: Comment) => {
    const liked = !comment.liked;
    updateComment(comment.id, (c) => ({ ...c, liked, likes: Math.max(0, c.likes + (liked ? 1 : -1)) }));
    try {
      const res = await api.likeComment(comment.id, liked);
      updateComment(comment.id, (c) => ({ ...c, liked: res.liked, likes: res.likes }));
    } catch (err) {
      updateComment(comment.id, (c) => ({ ...c, liked: !liked, likes: Math.max(0, c.likes + (liked ? -1 : 1)) }));
      toast(errorMessage(err), 'error');
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      const parentId = replyingTo ? (replyingTo.parentId ?? replyingTo.id) : undefined;
      const comment = await api.postComment(song.id, body, parentId);
      if (comment.parentId) {
        const parent = comment.parentId;
        // Show the whole thread with the new reply at the end.
        const loaded = replies[parent];
        const thread: Comment[] = loaded ?? (await api.replies(parent)).replies.filter((x) => x.id !== comment.id);
        setReplies((all) => ({ ...all, [parent]: [...thread, comment] }));
        updateComment(parent, (c) => ({ ...c, replyCount: c.replyCount + 1 }));
        setPage((p) => (p ? { ...p, total: p.total + 1 } : p));
      } else {
        setPage((p) => (p ? { ...p, comments: [comment, ...p.comments], total: p.total + 1 } : p));
      }
      setText('');
      setReplyingTo(null);
      onCountChange(1);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setPosting(false);
    }
  };

  const remove = async (comment: Comment) => {
    try {
      await api.deleteComment(comment.id);
      if (comment.parentId) {
        const parent = comment.parentId;
        setReplies((all) => ({ ...all, [parent]: all[parent]?.filter((c) => c.id !== comment.id) }));
        updateComment(parent, (c) => ({ ...c, replyCount: Math.max(0, c.replyCount - 1) }));
        setPage((p) => (p ? { ...p, total: p.total - 1 } : p));
        onCountChange(-1);
      } else {
        const removed = 1 + comment.replyCount;
        setPage((p) => (p ? { ...p, comments: p.comments.filter((c) => c.id !== comment.id), total: p.total - removed } : p));
        onCountChange(-removed);
      }
      if (replyingTo?.id === comment.id) setReplyingTo(null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const title = page ? `${page.total} ${page.total === 1 ? 'comment' : 'comments'}` : 'Comments';
  const rowProps = { onLike: (c: Comment) => void like(c), onReply: startReply, onDelete: (c: Comment) => void remove(c), onOpenUser };

  return (
    <Sheet title={title} onClose={onClose} className="comments-sheet">
      <div className="comments">
        {!page && !loadError && <span className="spinner comments__spinner" aria-label="Loading comments" />}
        {loadError && <p className="comments__empty">{loadError}</p>}
        {page && page.comments.length === 0 && (
          <p className="comments__empty">
            No comments yet. What does <strong>{song.title}</strong> make you feel?
          </p>
        )}
        {page && page.comments.length > 0 && (
          <ul className="comments__list">
            {page.comments.map((c) => {
              const thread = replies[c.id];
              return (
                <li key={c.id}>
                  <CommentRow comment={c} {...rowProps} />
                  {thread && thread.length > 0 && (
                    <ul className="comments__replies">
                      {thread.map((r) => (
                        <li key={r.id}>
                          <CommentRow comment={r} {...rowProps} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {!thread && c.replyCount > 0 && (
                    <button type="button" className="comments__view-replies" onClick={() => void showReplies(c)}>
                      View {c.replyCount} {c.replyCount === 1 ? 'reply' : 'replies'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {page?.nextCursor && (
          <button type="button" className="btn btn--ghost comments__more" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Show older comments'}
          </button>
        )}
      </div>

      {replyingTo && (
        <div className="replying-to">
          Replying to <strong>{replyingTo.author.displayName}</strong>
          <button type="button" className="icon-btn" aria-label="Cancel reply" onClick={() => setReplyingTo(null)}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      <div className="quick-reactions" role="group" aria-label="Quick reactions">
        {QUICK_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="quick-reactions__btn"
            onClick={() => {
              setText((t) => (t + emoji).slice(0, MAX_LENGTH));
              inputRef.current?.focus();
            }}
          >
            {emoji}
          </button>
        ))}
      </div>
      <form className="comment-form" onSubmit={(e) => void submit(e)}>
        <Avatar id={me.id} name={me.displayName} url={me.avatarUrl} size={34} />
        <input
          ref={inputRef}
          className="comment-form__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX_LENGTH}
          placeholder={replyingTo ? `Reply to ${replyingTo.author.displayName}…` : `Comment as ${me.displayName}…`}
          aria-label="Add a comment"
          enterKeyHint="send"
        />
        <button type="submit" className="icon-btn comment-form__send" aria-label="Post comment" disabled={!text.trim() || posting}>
          <Icon name="send" size={22} />
        </button>
      </form>
    </Sheet>
  );
}
