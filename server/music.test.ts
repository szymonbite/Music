import { describe, expect, it } from 'vitest';
import {
  artistKeys,
  cleanTitle,
  decadeTag,
  normalizeArtistName,
  parseIsoDuration,
  parseVideoTitle,
  popularityFromViews,
  primaryArtist,
  splitArtists,
  topicsToGenres,
} from './music.ts';

describe('parseVideoTitle', () => {
  it('splits "Artist - Title" and strips the usual noise', () => {
    expect(parseVideoTitle('Rick Astley - Never Gonna Give You Up (Official Music Video)', 'Rick Astley')).toEqual({
      artist: 'Rick Astley',
      title: 'Never Gonna Give You Up',
    });
    expect(parseVideoTitle('Queen – Bohemian Rhapsody [Official Video Remastered]', 'Queen Official')).toEqual({
      artist: 'Queen',
      title: 'Bohemian Rhapsody',
    });
  });

  it('uses the artist from auto-generated "Topic" channels', () => {
    expect(parseVideoTitle('Blinding Lights', 'The Weeknd - Topic')).toEqual({ artist: 'The Weeknd', title: 'Blinding Lights' });
  });

  it('moves featured artists from the title to the artist', () => {
    expect(parseVideoTitle('Mark Ronson - Uptown Funk (Official Video) ft. Bruno Mars', 'MarkRonsonVEVO')).toEqual({
      artist: 'Mark Ronson feat. Bruno Mars',
      title: 'Uptown Funk',
    });
  });

  it('falls back to a cleaned-up channel name', () => {
    expect(parseVideoTitle('Shake It Off', 'TaylorSwiftVEVO')).toEqual({ artist: 'Taylor Swift', title: 'Shake It Off' });
  });

  it('keeps meaningful brackets like remixes', () => {
    expect(cleanTitle('Prayer In C (Robin Schulz Remix) (Official Video)')).toBe('Prayer In C (Robin Schulz Remix)');
    expect(cleanTitle('Song | Official Audio')).toBe('Song');
  });
});

describe('artists', () => {
  it('splits collaborations', () => {
    expect(splitArtists('Mark Ronson feat. Bruno Mars')).toEqual(['Mark Ronson', 'Bruno Mars']);
    expect(splitArtists('Nicky Jam x J Balvin')).toEqual(['Nicky Jam', 'J Balvin']);
    expect(splitArtists('Jessie J, Ariana Grande & Nicki Minaj')).toEqual(['Jessie J', 'Ariana Grande', 'Nicki Minaj']);
  });

  it('knows the headline artist', () => {
    expect(primaryArtist('Mark Ronson feat. Bruno Mars')).toBe('Mark Ronson');
    expect(primaryArtist('Earth, Wind & Fire')).toBe('Earth, Wind & Fire');
  });

  it('normalises names so the same artist matches across sources', () => {
    expect(normalizeArtistName('Beyoncé')).toBe(normalizeArtistName('beyonce'));
    expect(normalizeArtistName('The Weeknd')).toBe('weeknd');
    expect(normalizeArtistName('AC/DC')).toBe('acdc');
    expect(artistKeys('The Kid LAROI & Justin Bieber')).toEqual(['kidlaroi', 'justinbieber']);
  });
});

describe('metadata helpers', () => {
  it('parses ISO 8601 durations', () => {
    expect(parseIsoDuration('PT3M33S')).toBe(213);
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('PT45S')).toBe(45);
    expect(parseIsoDuration('P0D')).toBe(0);
    expect(parseIsoDuration('nonsense')).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
  });

  it('maps YouTube topic categories to genres', () => {
    expect(
      topicsToGenres([
        'https://en.wikipedia.org/wiki/Pop_music',
        'https://en.wikipedia.org/wiki/Hip_hop_music',
        'https://en.wikipedia.org/wiki/Music',
        'https://en.wikipedia.org/wiki/Entertainment',
        'https://en.wikipedia.org/wiki/Gospel_music',
      ]),
    ).toEqual(['pop', 'hip-hop', 'gospel']);
  });

  it('derives decades and popularity', () => {
    expect(decadeTag(1987)).toBe('1980s');
    expect(decadeTag(null)).toBeNull();
    expect(popularityFromViews(1_000_000_000)).toBeCloseTo(0.9, 1);
    expect(popularityFromViews(1_000_000)).toBeCloseTo(0.6, 1);
    expect(popularityFromViews(0)).toBe(0.3);
  });
});
