import { describe, expect, it, vi } from 'vitest';
import type { FeedItem } from '../shared/types.ts';
import { all } from './db.ts';
import { DeezerProvider, LastFmProvider, type SimilarArtistsProvider } from './similar.ts';
import { FakeGoogle, fakeVideo } from './test/fakeGoogle.ts';
import { createTestApp, entry } from './test/helpers.ts';
import type { FetchLike } from './youtube/client.ts';

function fakeProvider(table: Record<string, { name: string; score: number }[]>): SimilarArtistsProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: 'Fake',
    calls,
    async similar(artist: string) {
      calls.push(artist);
      return table[artist] ?? [];
    },
  };
}

const catalog = [
  entry('amSong00001', 'Arctic Monkeys', 'Do I Wanna Know?', ['rock', 'indie']),
  entry('strokesSng1', 'The Strokes', 'Last Nite', ['rock', 'indie']),
  entry('jazzSong001', 'Miles Davis', 'So What', ['jazz']),
];

describe('similar artists', () => {
  it('recommends artists similar to the ones you like, and says so', async () => {
    const provider = fakeProvider({ 'Arctic Monkeys': [{ name: 'The Strokes', score: 0.9 }, { name: 'Arctic Monkeys', score: 1 }] });
    const { listener, db } = createTestApp({ catalog, similar: provider });
    const { agent } = await listener();
    await agent.put('/api/favorites').send({ songIds: ['amSong00001'] }).expect(200);

    const items = (await agent.post('/api/feed').send({ limit: 2 }).expect(200)).body.items as FeedItem[];
    expect(items[0]).toMatchObject({ id: 'strokesSng1', reason: 'Similar to Arctic Monkeys' });
    expect(provider.calls).toEqual(['Arctic Monkeys']);
    // The artist itself is never stored as "similar to itself".
    expect(all(db, 'SELECT similar_key FROM similar_artists')).toEqual([{ similar_key: 'strokes' }]);

    // Cached: the next feed request doesn't ask again.
    await agent.post('/api/feed').send({ limit: 2 }).expect(200);
    expect(provider.calls).toHaveLength(1);
  });

  it('carries on without similar artists when the lookup fails', async () => {
    const provider: SimilarArtistsProvider = { name: 'Broken', similar: () => Promise.reject(new Error('down')) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { listener } = createTestApp({ catalog, similar: provider });
    const { agent } = await listener();
    await agent.put('/api/favorites').send({ songIds: ['amSong00001'] }).expect(200);
    const items = (await agent.post('/api/feed').send({ limit: 2 }).expect(200)).body.items as FeedItem[];
    expect(items).toHaveLength(2);
    warn.mockRestore();
  });

  it('finds songs on YouTube by similar artists it has never heard of, within a daily budget', async () => {
    const google = new FakeGoogle();
    google.addVideos(
      fakeVideo('amSong00001', 'Arctic Monkeys - Do I Wanna Know?', 'Arctic Monkeys'),
      fakeVideo('strokesSng1', 'The Strokes - Last Nite', 'The Strokes'),
      fakeVideo('jazzSong001', 'Miles Davis - So What', 'Miles Davis'),
      fakeVideo('lastShadow1', 'The Last Shadow Puppets - Aviation (Official Video)', 'The Last Shadow Puppets'),
      fakeVideo('someoneElse', 'Totally Different Band - Song', 'Somebody'),
    );
    google.searchResults = ['lastShadow1', 'someoneElse'];
    const provider = fakeProvider({ 'Arctic Monkeys': [{ name: 'The Last Shadow Puppets', score: 0.95 }] });
    const { listener, db } = createTestApp({ catalog, similar: provider, fetch: google.fetch, apiKey: 'key', dailySearchBudget: 5 });
    const { agent } = await listener();
    await agent.put('/api/favorites').send({ songIds: ['amSong00001'] }).expect(200);

    const items = (await agent.post('/api/feed').send({ limit: 5 }).expect(200)).body.items as FeedItem[];
    const [search] = google.callsTo('/search');
    expect(search!.url.searchParams.get('q')).toBe('The Last Shadow Puppets');
    expect(items.find((i) => i.id === 'lastShadow1')).toMatchObject({ reason: 'Similar to Arctic Monkeys', title: 'Aviation' });
    // Other artists that the search turned up are not added.
    expect(all(db, "SELECT id FROM songs WHERE id = 'someoneElse'")).toEqual([]);
    expect(all(db, 'SELECT count FROM daily_counters')).toEqual([{ count: 1 }]);
  });

  it('stops searching once the day’s budget is spent', async () => {
    const google = new FakeGoogle();
    google.addVideos(fakeVideo('amSong00001', 'Arctic Monkeys - Do I Wanna Know?', 'Arctic Monkeys'));
    const provider = fakeProvider({ 'Arctic Monkeys': [{ name: 'The Last Shadow Puppets', score: 0.95 }] });
    const { listener } = createTestApp({ catalog, similar: provider, fetch: google.fetch, apiKey: 'key', dailySearchBudget: 0 });
    const { agent } = await listener();
    await agent.put('/api/favorites').send({ songIds: ['amSong00001'] }).expect(200);
    await agent.post('/api/feed').send({ limit: 5 }).expect(200);
    expect(google.callsTo('/search')).toEqual([]);
  });
});

describe('similar-artist providers', () => {
  function jsonFetch(routes: Record<string, unknown>): FetchLike & { urls: string[] } {
    const urls: string[] = [];
    const fn = (async (input: string) => {
      urls.push(input);
      const match = Object.entries(routes).find(([prefix]) => input.startsWith(prefix));
      return match ? new Response(JSON.stringify(match[1]), { status: 200 }) : new Response('nope', { status: 404 });
    }) as FetchLike & { urls: string[] };
    fn.urls = urls;
    return fn;
  }

  it('reads Last.fm similar artists', async () => {
    const fetch = jsonFetch({
      'https://ws.audioscrobbler.com/2.0/': {
        similarartists: { artist: [{ name: 'The Strokes', match: '0.87' }, { name: 'Kasabian', match: '1.4' }] },
      },
    });
    const result = await new LastFmProvider('lfm-key', fetch).similar('Arctic Monkeys');
    expect(result).toEqual([
      { name: 'The Strokes', score: 0.87 },
      { name: 'Kasabian', score: 1 },
    ]);
    const url = new URL(fetch.urls[0]!);
    expect(url.searchParams.get('method')).toBe('artist.getsimilar');
    expect(url.searchParams.get('artist')).toBe('Arctic Monkeys');
    expect(url.searchParams.get('api_key')).toBe('lfm-key');
  });

  it('treats an unknown artist on Last.fm as "no similar artists"', async () => {
    const fetch = jsonFetch({ 'https://ws.audioscrobbler.com/2.0/': { error: 6, message: 'The artist you supplied could not be found' } });
    expect(await new LastFmProvider('k', fetch).similar('Nobody')).toEqual([]);
  });

  it('reads Deezer related artists, matching the right artist first', async () => {
    const fetch = jsonFetch({
      'https://api.deezer.com/search/artist': { data: [{ id: 1, name: 'Arctic Monkeys Tribute' }, { id: 2, name: 'Arctic Monkeys' }] },
      'https://api.deezer.com/artist/2/related': { data: [{ name: 'The Strokes' }, { name: 'The Kooks' }, { name: 'Kasabian' }] },
    });
    const result = await new DeezerProvider(fetch).similar('arctic monkeys');
    expect(result.map((r) => r.name)).toEqual(['The Strokes', 'The Kooks', 'Kasabian']);
    expect(result[0]!.score).toBeGreaterThan(result[2]!.score);
  });
});
