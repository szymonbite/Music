import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Comment, MeResponse, Song } from '../../shared/types.ts';
import { api } from '../api.ts';
import { SessionProvider } from '../session.tsx';
import { CommentsSheet } from './CommentsSheet.tsx';

vi.mock('../api.ts', () => ({
  api: { me: vi.fn(), comments: vi.fn(), postComment: vi.fn(), deleteComment: vi.fn() },
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
};

const session: MeResponse = {
  me: {
    id: 'me',
    displayName: 'Szymon',
    avatarUrl: null,
    onboarded: true,
    settings: { skipIntro: true, autoAdvance: true, syncReactions: true, syncSaves: true, region: 'PL' },
    youtube: null,
    counts: { favorites: 3, likes: 0, saves: 0, comments: 0 },
  },
  features: { youtubeLogin: false, youtubeSearch: false },
};

function comment(id: number, body: string, mine: boolean): Comment {
  return {
    id,
    songId: song.id,
    body,
    createdAt: Date.now() - 60_000,
    author: mine ? { id: 'me', displayName: 'Szymon', avatarUrl: null } : { id: 'ania', displayName: 'Ania', avatarUrl: null },
    mine,
  };
}

function renderSheet() {
  const onClose = vi.fn();
  const onCountChange = vi.fn();
  render(
    <SessionProvider>
      <CommentsSheet song={song} onClose={onClose} onCountChange={onCountChange} />
    </SessionProvider>,
  );
  return { onClose, onCountChange, user: userEvent.setup() };
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

    expect(mocked.postComment).toHaveBeenCalledWith(song.id, 'Never gonna skip this 🔥');
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
});
