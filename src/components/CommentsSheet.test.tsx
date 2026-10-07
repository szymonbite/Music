import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Comment, MeResponse, Song } from '../../shared/types.ts';
import { api } from '../api.ts';
import { SessionProvider } from '../session.tsx';
import { CommentsSheet } from './CommentsSheet.tsx';

vi.mock('../api.ts', () => ({
  api: { me: vi.fn(), comments: vi.fn(), postComment: vi.fn(), deleteComment: vi.fn(), replies: vi.fn(), likeComment: vi.fn() },
}));

const mocked = vi.mocked(api);

const song: Song = {
  id: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  artist: 'Rick Astley',
  year: 1987,
  durationSec: 213,
  genres: ['pop'],
  tags: [],
  thumbnailUrl: '',
  source: 'catalog',
  hookSec: null,
};

const session: MeResponse = {
  me: {
    id: 'me',
    displayName: 'Szymon',
    avatarUrl: null,
    onboarded: true,
    settings: {
      skipIntro: true,
      autoAdvance: true,
      syncReactions: true,
      syncSaves: true,
      region: 'PL',
      previewMode: true,
      shareActivity: true,
    },
    youtube: null,
    youtubeExpired: false,
    counts: { favorites: 3, likes: 0, saves: 0, comments: 0, followers: 0, following: 0 },
  },
  features: { youtubeLogin: false, youtubeSearch: false, social: true },
};

function comment(id: number, body: string, mine: boolean, extra: Partial<Comment> = {}): Comment {
  return {
    id,
    songId: song.id,
    parentId: null,
    likes: 0,
    liked: false,
    replyCount: 0,
    ...extra,
    body,
    createdAt: Date.now() - 60_000,
    author: mine ? { id: 'me', displayName: 'Szymon', avatarUrl: null } : { id: 'ania', displayName: 'Ania', avatarUrl: null },
    mine,
  };
}

function renderSheet() {
  const onClose = vi.fn();
  const onCountChange = vi.fn();
  const onOpenUser = vi.fn();
  render(
    <SessionProvider>
      <CommentsSheet song={song} onClose={onClose} onCountChange={onCountChange} onOpenUser={onOpenUser} />
    </SessionProvider>,
  );
  return { onClose, onCountChange, onOpenUser, user: userEvent.setup() };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.me.mockResolvedValue(session);
  mocked.comments.mockResolvedValue({ comments: [comment(1, 'Absolute classic', false)], nextCursor: null, total: 1 });
});

describe('CommentsSheet', () => {
  it('lists comments and posts a new one', async () => {
    const { onCountChange, user } = renderSheet();
    expect(await screen.findByText('Absolute classic')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '1 comment' })).toBeInTheDocument();

    mocked.postComment.mockResolvedValue(comment(2, 'Never gonna skip this 🔥', true));
    await user.type(screen.getByRole('textbox', { name: 'Add a comment' }), 'Never gonna skip this ');
    await user.click(screen.getByRole('button', { name: '🔥' }));
    expect(screen.getByRole('textbox', { name: 'Add a comment' })).toHaveValue('Never gonna skip this 🔥');
    await user.click(screen.getByRole('button', { name: 'Post comment' }));

    expect(mocked.postComment).toHaveBeenCalledWith(song.id, 'Never gonna skip this 🔥', undefined);
    expect(await screen.findByText('Never gonna skip this 🔥')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '2 comments' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Add a comment' })).toHaveValue('');
    expect(onCountChange).toHaveBeenCalledWith(1);
  });

  it('lets you delete your own comments only', async () => {
    mocked.comments.mockResolvedValue({
      comments: [comment(2, 'mine', true), comment(1, 'theirs', false)],
      nextCursor: null,
      total: 2,
    });
    mocked.deleteComment.mockResolvedValue(undefined);
    const { onCountChange, user } = renderSheet();
    await screen.findByText('mine');
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete comment' });
    expect(deleteButtons).toHaveLength(1);
    await user.click(deleteButtons[0]!);
    expect(mocked.deleteComment).toHaveBeenCalledWith(2);
    await waitFor(() => expect(screen.queryByText('mine')).not.toBeInTheDocument());
    expect(onCountChange).toHaveBeenCalledWith(-1);
  });

  it('invites the first comment and closes with Escape', async () => {
    mocked.comments.mockResolvedValue({ comments: [], nextCursor: null, total: 0 });
    const { onClose, user } = renderSheet();
    expect(await screen.findByText(/No comments yet/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('likes comments and opens the author’s profile', async () => {
    mocked.likeComment.mockResolvedValue({ liked: true, likes: 3 });
    mocked.comments.mockResolvedValue({ comments: [comment(1, 'Absolute classic', false, { likes: 2 })], nextCursor: null, total: 1 });
    const { onOpenUser, user } = renderSheet();
    const like = await screen.findByRole('button', { name: 'Like comment (2)' });
    await user.click(like);
    expect(mocked.likeComment).toHaveBeenCalledWith(1, true);
    expect(await screen.findByRole('button', { name: 'Like comment (3)' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Ania' }));
    expect(onOpenUser).toHaveBeenCalledWith('ania');
  });

  it('shows replies and posts a reply into the thread', async () => {
    mocked.comments.mockResolvedValue({ comments: [comment(1, 'Absolute classic', false, { replyCount: 1 })], nextCursor: null, total: 2 });
    mocked.replies.mockResolvedValue({ replies: [comment(5, 'agreed', false, { parentId: 1 })] });
    mocked.postComment.mockResolvedValue(comment(6, 'same', true, { parentId: 1 }));
    const { onCountChange, user } = renderSheet();

    await user.click(await screen.findByRole('button', { name: 'View 1 reply' }));
    expect(await screen.findByText('agreed')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Reply' })[0]!);
    expect(screen.getByText(/Replying to/)).toHaveTextContent('Replying to Ania');
    await user.type(screen.getByRole('textbox', { name: 'Add a comment' }), 'same');
    await user.click(screen.getByRole('button', { name: 'Post comment' }));

    expect(mocked.postComment).toHaveBeenCalledWith(song.id, 'same', 1);
    expect(await screen.findByText('same')).toBeInTheDocument();
    expect(screen.queryByText(/Replying to/)).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '3 comments' })).toBeInTheDocument();
    expect(onCountChange).toHaveBeenCalledWith(1);
  });
});
