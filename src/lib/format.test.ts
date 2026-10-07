import { describe, expect, it } from 'vitest';
import { formatCount, formatTime, initials, timeAgo } from './format.ts';

describe('format helpers', () => {
  it('abbreviates counts', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1000)).toBe('1K');
    expect(formatCount(1234)).toBe('1.2K');
    expect(formatCount(56_789)).toBe('57K');
    expect(formatCount(2_500_000)).toBe('2.5M');
  });

  it('formats playback time', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(83.9)).toBe('1:23');
    expect(formatTime(3723)).toBe('1:02:03');
    expect(formatTime(Number.NaN)).toBe('0:00');
  });

  it('describes how long ago something happened', () => {
    const now = Date.UTC(2026, 9, 7, 12);
    expect(timeAgo(now - 10_000, now)).toBe('now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m');
    expect(timeAgo(now - 3 * 3600_000, now)).toBe('3h');
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d');
    expect(timeAgo(now - 14 * 86_400_000, now)).toBe('2w');
  });

  it('makes initials for avatars', () => {
    expect(initials('Szymon Nowak')).toBe('SN');
    expect(initials('szymon')).toBe('SZ');
    expect(initials('')).toBe('?');
  });
});
