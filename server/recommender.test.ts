import { describe, expect, it } from 'vitest';
import { buildProfile, pickFeed, scoreCandidate, type Candidate, type FeedPick, type TasteSignal } from './recommender.ts';

const NOW = Date.UTC(2026, 9, 7);

/** Deterministic pseudo-random numbers so rankings are reproducible. */
function seeded(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function signal(overrides: Partial<TasteSignal> & Pick<TasteSignal, 'songId' | 'artist'>): TasteSignal {
  return { title: overrides.songId, genres: [], tags: [], weight: 3, seed: true, ...overrides };
}

function candidate(overrides: Partial<Candidate> & Pick<Candidate, 'id' | 'artist'>): Candidate {
  return {
    title: overrides.id,
    genres: [],
    tags: [],
    popularity: 0.5,
    communityLikes: 0,
    trending: false,
    lastSeenAt: null,
    collab: 0,
    friends: 0,
    ...overrides,
  };
}

const rockFan: TasteSignal[] = [
  signal({ songId: 'a1', title: 'Mr. Brightside', artist: 'The Killers', genres: ['rock', 'indie'], tags: ['anthem'] }),
  signal({ songId: 'a2', title: 'Do I Wanna Know?', artist: 'Arctic Monkeys', genres: ['rock', 'indie'], tags: ['night'] }),
  signal({ songId: 'a3', title: 'Bad Romance', artist: 'Lady Gaga', genres: ['pop', 'dance'], weight: -3, seed: false }),
];

describe('buildProfile', () => {
  it('learns positive and negative affinities, scaled to [-1, 1]', () => {
    const profile = buildProfile(rockFan);
    expect(profile.genres.get('rock')).toBe(1);
    expect(profile.genres.get('pop')).toBeLessThan(0);
    expect(profile.artists.get('killers')).toBeGreaterThan(0);
    expect(profile.artists.get('ladygaga')).toBeLessThan(0);
    expect(profile.strength).toBe(6);
  });

  it('knows nothing about a brand new listener', () => {
    expect(buildProfile([]).strength).toBe(0);
  });
});

describe('scoreCandidate', () => {
  const profile = buildProfile(rockFan);

  it('prefers liked artists, then liked genres, over the rest', () => {
    const sameArtist = scoreCandidate(profile, candidate({ id: 'c1', artist: 'Arctic Monkeys', genres: ['rock', 'indie'] }), NOW);
    const sameGenre = scoreCandidate(profile, candidate({ id: 'c2', artist: 'The Strokes', genres: ['rock', 'indie'] }), NOW);
    const unrelated = scoreCandidate(profile, candidate({ id: 'c3', artist: 'Miles Davis', genres: ['jazz'] }), NOW);
    const disliked = scoreCandidate(profile, candidate({ id: 'c4', artist: 'Lady Gaga', genres: ['pop', 'dance'] }), NOW);
    expect(sameArtist.score).toBeGreaterThan(sameGenre.score);
    expect(sameGenre.score).toBeGreaterThan(unrelated.score);
    expect(unrelated.score).toBeGreaterThan(disliked.score);
    expect(sameArtist.matchedArtist).toBe('Arctic Monkeys');
  });

  it('matches featured artists too', () => {
    const scored = scoreCandidate(profile, candidate({ id: 'c5', artist: 'Someone feat. Arctic Monkeys' }), NOW);
    expect(scored.matchedArtist).toBe('Arctic Monkeys');
  });

  it('pushes recently seen songs down', () => {
    const fresh = scoreCandidate(profile, candidate({ id: 'c6', artist: 'The Strokes', genres: ['rock'] }), NOW);
    const seenToday = scoreCandidate(profile, candidate({ id: 'c6', artist: 'The Strokes', genres: ['rock'], lastSeenAt: NOW - 3600_000 }), NOW);
    expect(seenToday.score).toBeLessThan(fresh.score - 1);
  });
});

describe('pickFeed', () => {
  const pool: Candidate[] = [
    candidate({ id: 'm1', artist: 'Arctic Monkeys', genres: ['rock', 'indie'] }),
    candidate({ id: 'm2', artist: 'Arctic Monkeys', genres: ['rock', 'indie'] }),
    candidate({ id: 'm3', artist: 'Arctic Monkeys', genres: ['rock', 'indie'] }),
    candidate({ id: 'k1', artist: 'The Killers', genres: ['rock', 'indie'] }),
    candidate({ id: 's1', artist: 'The Strokes', genres: ['rock', 'indie'] }),
    candidate({ id: 'r1', artist: 'Radiohead', genres: ['rock', 'alternative'] }),
    candidate({ id: 'g1', artist: 'Lady Gaga', genres: ['pop', 'dance'] }),
    candidate({ id: 'g2', artist: 'Lady Gaga', genres: ['pop', 'dance'] }),
    ...Array.from({ length: 30 }, (_, i) => candidate({ id: `j${i}`, artist: `Jazz Trio ${i}`, genres: ['jazz'] })),
  ];

  it('fills the batch with taste matches first and keeps artists varied', () => {
    const picks = pickFeed({ profile: buildProfile(rockFan), candidates: pool, signals: rockFan, limit: 5, now: NOW, random: seeded() });
    expect(picks).toHaveLength(5);
    const artists = picks.map((p) => p.candidate.artist);
    for (let i = 1; i < artists.length; i++) expect(artists[i]).not.toBe(artists[i - 1]);
    expect(artists.filter((a) => a === 'Arctic Monkeys').length).toBeLessThanOrEqual(2);
    expect(artists).not.toContain('Lady Gaga');
    expect(picks[0]!.reason).toMatch(/^Because you (like|liked) /);
  });

  /** Scrolls through `batches` feed batches of 8, the way the app loads them. */
  function scroll(candidates: Candidate[], batches: number): FeedPick[] {
    const shown: FeedPick[] = [];
    let sinceFresh = 0;
    for (let b = 0; b < batches; b++) {
      const seen = new Set(shown.map((p) => p.candidate.id));
      const picks = pickFeed({
        profile: buildProfile(rockFan),
        candidates: candidates.filter((c) => !seen.has(c.id)),
        signals: rockFan,
        limit: 8,
        now: NOW,
        random: seeded(b + 1),
        sinceFresh,
      });
      for (const p of picks) sinceFresh = p.fresh ? 0 : sinceFresh + 1;
      shown.push(...picks);
    }
    return shown;
  }

  it('mixes in one fresh pick every 30 songs, counting across batches', () => {
    const rock = Array.from({ length: 80 }, (_, i) => candidate({ id: `r${i}`, artist: `Rock Band ${i}`, genres: ['rock', 'indie'] }));
    const jazz = Array.from({ length: 30 }, (_, i) => candidate({ id: `j${i}`, artist: `Jazz Trio ${i}`, genres: ['jazz'] }));
    const shown = scroll([...rock, ...jazz], 8);
    expect(shown).toHaveLength(64);
    expect(shown.flatMap((p, i) => (p.fresh ? [i] : []))).toEqual([29, 59]);
    expect(shown.filter((p) => p.reason === 'Fresh pick for you')).toHaveLength(2);
  });

  it('falls back to fresh picks rather than running dry', () => {
    const picks = pickFeed({
      profile: buildProfile(rockFan),
      candidates: [pool[3]!, pool[4]!, ...pool.slice(-4)],
      signals: rockFan,
      limit: 6,
      now: NOW,
      random: seeded(),
    });
    expect(picks).toHaveLength(6);
    expect(picks.filter((p) => p.fresh)).toHaveLength(4);
    expect(picks.slice(0, 2).every((p) => !p.fresh)).toBe(true);
  });

  it('explains genre matches with a liked song', () => {
    const picks = pickFeed({
      profile: buildProfile(rockFan),
      candidates: [candidate({ id: 's1', artist: 'The Strokes', genres: ['rock', 'indie'] })],
      signals: rockFan,
      limit: 1,
      now: NOW,
      random: seeded(),
    });
    expect(picks[0]!.reason).toMatch(/^Because you liked “(Mr\. Brightside|Do I Wanna Know\?)”$/);
  });

  it('serves popular songs to a brand new listener', () => {
    const picks = pickFeed({
      profile: buildProfile([]),
      candidates: [
        candidate({ id: 'p1', artist: 'Big Star', popularity: 0.95, communityLikes: 40 }),
        candidate({ id: 'p2', artist: 'Small Act', popularity: 0.1 }),
      ],
      signals: [],
      limit: 2,
      now: NOW,
      random: seeded(),
    });
    expect(picks[0]!.candidate.id).toBe('p1');
    expect(picks[0]!.reason).toBe('Popular on Earworm');
    expect(picks[1]!.reason).toBe('Fresh pick for you');
  });

  it('returns what it can when the pool is small', () => {
    const picks = pickFeed({
      profile: buildProfile(rockFan),
      candidates: pool.slice(0, 3),
      signals: rockFan,
      limit: 8,
      now: NOW,
      random: seeded(),
    });
    expect(picks.map((p) => p.candidate.id).sort()).toEqual(['m1', 'm2', 'm3']);
  });
});
