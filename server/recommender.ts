// The "For you" ranking. Pure functions only, so it is easy to test and tune.
//
// A listener's taste is built from weighted signals (favourites, likes, saves,
// dislikes, quick skips...). Every candidate song is scored against that taste
// by artist, genre and mood overlap, artists similar to the ones they like,
// what friends and like-minded listeners enjoyed, general popularity, and a
// penalty for songs seen recently. A little randomness and regular "explore"
// slots keep the feed from becoming an echo chamber.

import { artistKeys, normalizeArtistName, primaryArtist, splitArtists } from './music.ts';

export interface TasteSignal {
  songId: string;
  title: string;
  artist: string;
  genres: string[];
  tags: string[];
  /** Positive for things the listener liked, negative for dislikes and skips. */
  weight: number;
  /** Explicitly liked (favourite, like, save, library), so it can be named in a "Because you liked" reason. */
  seed: boolean;
}

export interface Candidate {
  id: string;
  title: string;
  artist: string;
  genres: string[];
  tags: string[];
  /** Prior popularity, 0..1. */
  popularity: number;
  /** Likes from listeners in this app. */
  communityLikes: number;
  /** On a current YouTube trending chart. */
  trending: boolean;
  lastSeenAt: number | null;
  /** How many listeners with overlapping taste liked this song. */
  collab: number;
  /** How many people this listener follows liked or saved this song. */
  friends: number;
}

export interface TasteProfile {
  artists: Map<string, number>;
  genres: Map<string, number>;
  tags: Map<string, number>;
  /** Artists similar to liked ones (key -> affinity 0..1 and the liked artist it came from). */
  similar: Map<string, { score: number; via: string }>;
  /** Sum of positive signal weights; 0 means we know nothing yet. */
  strength: number;
}

export interface SimilarArtistRow {
  artistKey: string;
  similarKey: string;
  score: number;
}

export interface ScoreParts {
  artist: number;
  similar: number;
  genre: number;
  tag: number;
  collab: number;
  friends: number;
  popularity: number;
  seen: number;
}

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
  parts: ScoreParts;
  /** Display name of the artist that matched the listener's taste, if any. */
  matchedArtist: string | null;
  /** The liked artist that a similar-artist match came from. */
  similarVia: string | null;
}

export interface FeedPick {
  candidate: Candidate;
  score: number;
  reason: string;
  explore: boolean;
}

export const SIGNAL_WEIGHTS = {
  favorite: 3,
  like: 2,
  save: 1.5,
  library: 1,
  listened: 0.5,
  skip: -0.5,
  dislike: -3,
} as const;

const WEIGHTS = { artist: 1.5, similar: 1.1, genre: 1, tag: 0.5, collab: 0.8, friends: 0.9, popularity: 0.6 };
const DAY = 24 * 60 * 60 * 1000;

function add(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

/** Scales values into [-1, 1] by the largest magnitude. */
function normalize(map: Map<string, number>): Map<string, number> {
  let max = 0;
  for (const v of map.values()) max = Math.max(max, Math.abs(v));
  if (max === 0) return map;
  return new Map([...map].map(([k, v]) => [k, v / max]));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function buildProfile(signals: TasteSignal[]): TasteProfile {
  const artists = new Map<string, number>();
  const genres = new Map<string, number>();
  const tags = new Map<string, number>();
  let strength = 0;
  for (const s of signals) {
    if (s.weight > 0) strength += s.weight;
    for (const key of artistKeys(s.artist)) add(artists, key, s.weight);
    const genreWeight = s.weight / Math.sqrt(Math.max(1, s.genres.length));
    for (const g of s.genres) add(genres, g, genreWeight);
    const tagWeight = s.weight / Math.sqrt(Math.max(1, s.tags.length));
    for (const t of s.tags) add(tags, t, tagWeight);
  }
  return { artists: normalize(artists), genres: normalize(genres), tags: normalize(tags), similar: new Map(), strength };
}

/**
 * Spreads affinity from liked artists to artists similar to them (from
 * Last.fm / Deezer), so the feed can reach beyond artists you already know.
 * `names` maps artist keys to display names for "Similar to …" reasons.
 */
export function withSimilarArtists(profile: TasteProfile, rows: SimilarArtistRow[], names: Map<string, string>): TasteProfile {
  const similar = new Map<string, { score: number; via: string }>();
  for (const row of rows) {
    const affinity = profile.artists.get(row.artistKey) ?? 0;
    if (affinity <= 0 || (profile.artists.get(row.similarKey) ?? 0) < 0) continue;
    const score = Math.min(1, affinity * row.score);
    const current = similar.get(row.similarKey);
    if (!current || score > current.score) similar.set(row.similarKey, { score, via: names.get(row.artistKey) ?? row.artistKey });
  }
  return { ...profile, similar };
}

function overlap(values: string[], affinity: Map<string, number>): number {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += affinity.get(v) ?? 0;
  return clamp(sum / Math.sqrt(values.length), -1.5, 1.5);
}

export function scoreCandidate(profile: TasteProfile, c: Candidate, now: number): ScoredCandidate {
  let artist = 0;
  let best = 0;
  let matchedArtist: string | null = null;
  for (const [index, name] of splitArtists(c.artist).entries()) {
    const value = profile.artists.get(normalizeArtistName(name)) ?? 0;
    artist += value;
    if (value > best) {
      best = value;
      // For the first name, use the full headline ("Earth, Wind & Fire" rather than "Earth").
      matchedArtist = index === 0 ? primaryArtist(c.artist) : name;
    }
  }
  artist = clamp(artist, -1, 1);

  // Artists similar to ones you like (only counts for artists you don't already like).
  let similar = 0;
  let similarVia: string | null = null;
  if (artist <= 0.1) {
    for (const key of artistKeys(c.artist)) {
      const match = profile.similar.get(key);
      if (match && match.score > similar) {
        similar = match.score;
        similarVia = match.via;
      }
    }
  }

  const genre = overlap(c.genres, profile.genres);
  const tag = overlap(c.tags, profile.tags);
  const collab = Math.min(1, Math.log1p(c.collab) / Math.log1p(8));
  const friends = Math.min(1, Math.log1p(c.friends) / Math.log1p(3));
  const popularity =
    0.6 * c.popularity + 0.4 * Math.min(1, Math.log1p(c.communityLikes) / Math.log1p(25)) + (c.trending ? 0.25 : 0);

  let seen = 0;
  if (c.lastSeenAt !== null) {
    const age = now - c.lastSeenAt;
    seen = age < DAY ? -2 : age < 7 * DAY ? -0.8 : -0.3;
  }

  const score =
    WEIGHTS.artist * artist +
    WEIGHTS.similar * similar +
    WEIGHTS.genre * genre +
    WEIGHTS.tag * tag +
    WEIGHTS.collab * collab +
    WEIGHTS.friends * friends +
    WEIGHTS.popularity * popularity +
    seen;

  return {
    candidate: c,
    score,
    parts: { artist, similar, genre, tag, collab, friends, popularity, seen },
    matchedArtist,
    similarVia,
  };
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * A liked song that shares the most genres and moods with a candidate. Near
 * ties are broken per candidate, so reasons don't all name the same song.
 */
function closestSeed(c: Candidate, seeds: TasteSignal[]): TasteSignal | null {
  const scored: { seed: TasteSignal; score: number }[] = [];
  for (const seed of seeds) {
    if (!seed.seed || seed.weight <= 0) continue;
    const sharedGenres = seed.genres.filter((g) => c.genres.includes(g)).length;
    if (sharedGenres === 0) continue;
    const sharedTags = seed.tags.filter((t) => c.tags.includes(t)).length;
    scored.push({ seed, score: sharedGenres * 2 + sharedTags + seed.weight * 0.1 });
  }
  if (!scored.length) return null;
  const best = Math.max(...scored.map((s) => s.score));
  const close = scored.filter((s) => s.score >= best - 1);
  return close[hash(c.id) % close.length]!.seed;
}

export function explain(s: ScoredCandidate, seeds: TasteSignal[], explore: boolean): string {
  if (explore) return 'Something different to try';
  if (s.parts.artist > 0.3 && s.matchedArtist) return `Because you like ${s.matchedArtist}`;
  if (s.parts.friends > 0) return 'Loved by people you follow';
  if (s.parts.similar > 0.25 && s.similarVia) return `Similar to ${s.similarVia}`;
  if (s.parts.collab >= 0.3) return 'Loved by listeners with similar taste';
  if (s.parts.genre + s.parts.tag > 0.25) {
    const seed = closestSeed(s.candidate, seeds);
    if (seed) return `Because you liked “${seed.title}”`;
  }
  if (s.candidate.trending) return 'Trending on YouTube';
  if (s.candidate.communityLikes >= 2) return 'Popular on Earworm';
  return 'Fresh pick for you';
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

export interface PickOptions {
  profile: TasteProfile;
  candidates: Candidate[];
  signals: TasteSignal[];
  limit: number;
  now: number;
  random: () => number;
  /** Every Nth slot is an exploration pick (default 5). */
  exploreEvery?: number;
}

export function pickFeed(opts: PickOptions): FeedPick[] {
  const { profile, candidates, signals, limit, now, random } = opts;
  const exploreEvery = opts.exploreEvery ?? 5;

  const ranked = candidates
    .map((c) => {
      const scored = scoreCandidate(profile, c, now);
      return { scored, total: scored.score + random() * 0.6 };
    })
    .sort((a, b) => b.total - a.total)
    .map((r) => r.scored);

  // Exploration comes from outside the obvious top picks, but never from
  // artists or genres the listener has pushed away, nor from songs just seen.
  const headSize = limit * 3;
  const explorePool = shuffle(
    ranked.slice(headSize).filter((s) => s.parts.artist >= 0 && s.parts.genre > -0.3 && s.parts.seen > -1),
    random,
  );

  const picks: FeedPick[] = [];
  const used = new Set<string>();
  const perArtist = new Map<string, number>();
  let previousArtist = '';

  const accept = (s: ScoredCandidate, explore: boolean) => {
    const key = artistKeys(s.candidate.artist)[0] ?? '';
    used.add(s.candidate.id);
    perArtist.set(key, (perArtist.get(key) ?? 0) + 1);
    previousArtist = key;
    picks.push({ candidate: s.candidate, score: s.score, reason: explain(s, signals, explore), explore });
  };

  // Prefer variety: no artist twice in a row and at most two per batch.
  const takeFrom = (pool: ScoredCandidate[], explore: boolean, strict: boolean): boolean => {
    for (const s of pool) {
      if (used.has(s.candidate.id)) continue;
      const key = artistKeys(s.candidate.artist)[0] ?? '';
      if (strict && (key === previousArtist || (perArtist.get(key) ?? 0) >= 2)) continue;
      accept(s, explore);
      return true;
    }
    return false;
  };

  while (picks.length < limit) {
    const exploreSlot = profile.strength > 0 && picks.length % exploreEvery === exploreEvery - 1;
    if (exploreSlot && takeFrom(explorePool, true, true)) continue;
    if (takeFrom(ranked, false, true)) continue;
    if (!takeFrom(ranked, false, false)) break;
  }
  return picks;
}
