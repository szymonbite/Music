import { describe, expect, it } from 'vitest';
import { formatGenre, isVideoId, parseYouTubeRef } from './youtube.ts';

describe('parseYouTubeRef', () => {
  it.each([
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc123', 'dQw4w9WgXcQ'],
    ['youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ?start=10', 'dQw4w9WgXcQ'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('finds the video in %s', (input, id) => {
    expect(parseYouTubeRef(input)).toEqual({ type: 'video', id });
  });

  it('understands playlist links', () => {
    expect(parseYouTubeRef('https://music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG')).toEqual({
      type: 'playlist',
      id: 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
    });
  });

  it.each(['', 'hello world', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://evilyoutube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=short'])(
    'rejects %s',
    (input) => {
      expect(parseYouTubeRef(input)).toBeNull();
    },
  );
});

describe('isVideoId', () => {
  it('accepts 11-character ids only', () => {
    expect(isVideoId('dQw4w9WgXcQ')).toBe(true);
    expect(isVideoId('dQw4w9WgXc')).toBe(false);
    expect(isVideoId('dQw4w9WgXcQ!')).toBe(false);
    expect(isVideoId(42)).toBe(false);
  });
});

describe('formatGenre', () => {
  it('formats genre slugs for display', () => {
    expect(formatGenre('hip-hop')).toBe('Hip-Hop');
    expect(formatGenre('r&b')).toBe('R&B');
    expect(formatGenre('k-pop')).toBe('K-Pop');
    expect(formatGenre('new-wave')).toBe('New Wave');
    expect(formatGenre('pop')).toBe('Pop');
  });
});
