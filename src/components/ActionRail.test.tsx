import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FeedItem } from '../../shared/types.ts';
import { ActionRail } from './ActionRail.tsx';

const song: FeedItem = {
  id: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  artist: 'Rick Astley',
  year: 1987,
  durationSec: 213,
  genres: ['pop'],
  tags: [],
  thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  source: 'catalog',
  hookSec: null,
  stats: { likes: 1234, comments: 5, saves: 0 },
  me: { reaction: 0, saved: false, favorite: false },
  reason: 'Popular on Earworm',
};

function setup(item: FeedItem = song) {
  const handlers = { onReact: vi.fn(), onComments: vi.fn(), onSave: vi.fn(), onShare: vi.fn() };
  const view = render(<ActionRail item={item} {...handlers} />);
  return { ...handlers, ...view, user: userEvent.setup() };
}

describe('ActionRail', () => {
  it('shows counts and toggles a like', async () => {
    const { onReact, user, rerender } = setup();
    const like = screen.getByRole('button', { name: 'Like (1.2K)' });
    expect(like).toHaveAttribute('aria-pressed', 'false');
    await user.click(like);
    expect(onReact).toHaveBeenLastCalledWith(song, 1);

    const liked = { ...song, me: { ...song.me, reaction: 1 as const } };
    rerender(<ActionRail item={liked} onReact={onReact} onComments={vi.fn()} onSave={vi.fn()} onShare={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^Like/ })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /^Like/ }));
    expect(onReact).toHaveBeenLastCalledWith(liked, 0);
  });

  it('dislikes, opens comments, saves and shares', async () => {
    const { onReact, onComments, onSave, onShare, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Dislike' }));
    expect(onReact).toHaveBeenLastCalledWith(song, -1);
    await user.click(screen.getByRole('button', { name: 'Comments (5)' }));
    expect(onComments).toHaveBeenCalledWith(song);
    await user.click(screen.getByRole('button', { name: 'Save (0)' }));
    expect(onSave).toHaveBeenCalledWith(song);
    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(onShare).toHaveBeenCalledWith(song);
  });

  it('marks saved and disliked songs', () => {
    setup({ ...song, me: { reaction: -1, saved: true, favorite: false } });
    expect(screen.getByRole('button', { name: 'Dislike' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Save/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
