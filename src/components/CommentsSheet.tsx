import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Comment, Song } from '../../shared/types.ts';
import { api } from '../api.ts';
import { errorMessage, timeAgo } from '../lib/format.ts';
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
  /** Called with +1 / -1 so the feed can keep its comment count in sync. */
  onCountChange: (delta: number) => void;
}

type PageState = { comments: Comment[]; nextCursor: number | null; total: number };

export function CommentsSheet({ song, onClose, onCountChange }: CommentsSheetProps) {
  const { me } = useSession();
  const toast = useToast();
  const [page, setPage] = useState<PageState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      const comment = await api.postComment(song.id, body);
      setPage((p) => (p ? { ...p, comments: [comment, ...p.comments], total: p.total + 1 } : p));
      setText('');
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
      setPage((p) => (p ? { ...p, comments: p.comments.filter((c) => c.id !== comment.id), total: p.total - 1 } : p));
      onCountChange(-1);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const title = page ? `${page.total} ${page.total === 1 ? 'comment' : 'comments'}` : 'Comments';

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
            {page.comments.map((c) => (
              <li key={c.id} className="comment">
                <Avatar id={c.author.id} name={c.author.displayName} url={c.author.avatarUrl} size={34} />
                <div className="comment__main">
                  <p className="comment__meta">
                    <span className="comment__author">{c.author.displayName}</span>
                    {c.mine && <span className="comment__you">you</span>}
                    <time dateTime={new Date(c.createdAt).toISOString()}>{timeAgo(c.createdAt)}</time>
                  </p>
                  <p className="comment__body">{c.body}</p>
                </div>
                {c.mine && (
                  <button type="button" className="icon-btn comment__delete" aria-label="Delete comment" onClick={() => void remove(c)}>
                    <Icon name="trash" size={18} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {page?.nextCursor && (
          <button type="button" className="btn btn--ghost comments__more" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Show older comments'}
          </button>
        )}
      </div>

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
          placeholder={`Comment as ${me.displayName}…`}
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
