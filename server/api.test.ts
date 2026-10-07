import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { FeedItem } from '../shared/types.ts';
import { get } from './db.ts';
import { createTestApp } from './test/helpers.ts';

const NIRVANA = 'hTWKbfoikeg';
const KILLERS = 'gGdGFtwCNBE';
const ARCTIC = 'bpOSxM0rNPM';
const RICK = 'dQw4w9WgXcQ';
const DESPACITO = 'kJQP7kiw5Fk';
const ROCK_GENRES = new Set(['rock', 'indie', 'alternative', 'punk', 'metal']);

describe('sessions', () => {
  it('creates a guest listener on the first visit and remembers them', async () => {
    const { app } = createTestApp();
    const agent = request.agent(app);
    const first = await agent.get('/api/me').expect(200);
    expect(String(first.headers['set-cookie'])).toMatch(/ew_session=.+HttpOnly/);
    expect(first.body.me).toMatchObject({ onboarded: false, youtube: null, counts: { favorites: 0, likes: 0, saves: 0, comments: 0 } });
    expect(first.body.me.displayName).toMatch(/^Listener \d{4}$/);
    expect(first.body.features).toEqual({ youtubeLogin: false, youtubeSearch: false });

    const second = await agent.get('/api/me').expect(200);
    expect(second.body.me.id).toBe(first.body.me.id);
  });

  it('picks the trending region from the browser language', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener({ 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8' });
    const res = await agent.get('/api/me').expect(200);
    expect(res.body.me.settings.region).toBe('PL');
  });

  it('requires a session for everything else', async () => {
    const { app } = createTestApp();
    const res = await request(app).post('/api/feed').send({}).expect(401);
    expect(res.body).toEqual({ error: 'no_session', message: expect.any(String) });
  });

  it('signs out', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    await agent.post('/api/auth/logout').expect(204);
    await agent.post('/api/feed').send({}).expect(401);
  });
});

describe('profile', () => {
  it('updates the display name, settings and onboarding state', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    const res = await agent
      .patch('/api/me')
      .send({ displayName: '  Szymon  ', onboarded: true, settings: { skipIntro: false, region: 'gb', bogus: 1, syncSaves: 'yes' } })
      .expect(200);
    expect(res.body.me.displayName).toBe('Szymon');
    expect(res.body.me.onboarded).toBe(true);
    expect(res.body.me.settings).toEqual({ skipIntro: false, autoAdvance: true, syncReactions: true, syncSaves: true, region: 'GB' });
  });

  it('rejects empty or overly long names', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    await agent.patch('/api/me').send({ displayName: '   ' }).expect(400);
    await agent.patch('/api/me').send({ displayName: 'x'.repeat(31) }).expect(400);
    const res = await agent.patch('/api/me').send({ displayName: 'Ok‮name' }).expect(200);
    expect(res.body.me.displayName).toBe('Okname');
  });
});

describe('favourites and the feed', () => {
  it('recommends songs like your favourites and skips the ones you picked', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    const fav = await agent.put('/api/favorites').send({ songIds: [NIRVANA, KILLERS, ARCTIC, 'zzzzzzzzzzz'] }).expect(200);
    expect(fav.body.songs.map((s: { id: string }) => s.id)).toEqual([NIRVANA, KILLERS, ARCTIC]);

    const res = await agent.post('/api/feed').send({ limit: 10 }).expect(200);
    const items: FeedItem[] = res.body.items;
    expect(items).toHaveLength(10);
    expect(items.map((i) => i.id)).not.toEqual(expect.arrayContaining([NIRVANA]));
    for (const item of items) {
      expect(item.reason).toBeTruthy();
      expect(item.stats).toEqual({ likes: 0, comments: 0, saves: 0 });
      expect(item.me).toEqual({ reaction: 0, saved: false, favorite: false });
    }
    const rockish = items.filter((i) => i.genres.some((g) => ROCK_GENRES.has(g)));
    expect(rockish.length).toBeGreaterThanOrEqual(6);
  });

  it('does not resend songs the client already has', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    const first = (await agent.post('/api/feed').send({ limit: 8 }).expect(200)).body.items as FeedItem[];
    const exclude = first.map((i) => i.id);
    const second = (await agent.post('/api/feed').send({ limit: 8, exclude }).expect(200)).body.items as FeedItem[];
    expect(second.filter((i) => exclude.includes(i.id))).toEqual([]);
  });

  it('starts with a shared song', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    const res = await agent.post('/api/feed').send({ limit: 3, startWith: RICK }).expect(200);
    expect(res.body.items[0]).toMatchObject({ id: RICK, title: 'Never Gonna Give You Up', reason: 'Shared with you' });
    expect(res.body.items).toHaveLength(3);
  });

  it('clamps silly input', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    const res = await agent.post('/api/feed').send({ limit: 500, exclude: ['<script>', 42], startWith: 'nope' }).expect(200);
    expect(res.body.items).toHaveLength(20);
  });

  it('rejects malformed favourites', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    await agent.put('/api/favorites').send({ songIds: 'abc' }).expect(400);
    await agent.put('/api/favorites').send({ songIds: ['../etc/passwd'] }).expect(400);
  });
});

describe('likes, dislikes and saves', () => {
  it('counts likes and keeps liked songs out of the feed', async () => {
    const { listener } = createTestApp();
    const a = await listener();
    const b = await listener();

    const liked = await a.agent.put(`/api/songs/${RICK}/reaction`).send({ value: 1 }).expect(200);
    expect(liked.body).toEqual({ reaction: 1, stats: { likes: 1, comments: 0, saves: 0 }, youtube: 'off' });
    await b.agent.put(`/api/songs/${RICK}/reaction`).send({ value: 1 }).expect(200);

    const song = await a.agent.get(`/api/songs/${RICK}`).expect(200);
    expect(song.body.stats.likes).toBe(2);
    expect(song.body.me.reaction).toBe(1);

    const feed = await a.agent.post('/api/feed').send({ limit: 20 }).expect(200);
    expect(feed.body.items.map((i: FeedItem) => i.id)).not.toContain(RICK);

    const unliked = await a.agent.put(`/api/songs/${RICK}/reaction`).send({ value: 0 }).expect(200);
    expect(unliked.body.stats.likes).toBe(1);
  });

  it('moves disliked songs to the disliked list', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    await agent.put(`/api/songs/${DESPACITO}/reaction`).send({ value: -1 }).expect(200);
    const disliked = await agent.get('/api/library/disliked').expect(200);
    expect(disliked.body.items.map((i: FeedItem) => i.id)).toEqual([DESPACITO]);
    const liked = await agent.get('/api/library/liked').expect(200);
    expect(liked.body.items).toEqual([]);
  });

  it('validates reactions', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    await agent.put(`/api/songs/${RICK}/reaction`).send({ value: 2 }).expect(400);
    await agent.put('/api/songs/zzzzzzzzzzz/reaction').send({ value: 1 }).expect(404);
    await agent.put('/api/songs/not-an-id/reaction').send({ value: 1 }).expect(400);
  });

  it('saves songs to the library', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    const saved = await agent.put(`/api/songs/${RICK}/save`).send({ saved: true }).expect(200);
    expect(saved.body).toEqual({ saved: true, stats: { likes: 0, comments: 0, saves: 1 }, youtube: 'off' });
    await agent.put(`/api/songs/${RICK}/save`).send({ saved: true }).expect(200);
    const library = await agent.get('/api/library/saved').expect(200);
    expect(library.body.items).toHaveLength(1);
    expect(library.body.items[0]).toMatchObject({ id: RICK, title: 'Never Gonna Give You Up', addedAt: expect.any(Number) });

    await agent.put(`/api/songs/${RICK}/save`).send({ saved: false }).expect(200);
    expect((await agent.get('/api/library/saved').expect(200)).body.items).toEqual([]);
    await agent.get('/api/library/everything').expect(400);
  });
});

describe('comments', () => {
  it('lets listeners talk about a song', async () => {
    const { listener } = createTestApp();
    const a = await listener();
    const b = await listener();
    await a.agent.patch('/api/me').send({ displayName: 'Ania' });

    const posted = await a.agent.post(`/api/songs/${RICK}/comments`).send({ body: '  never gonna   stop listening  ' }).expect(201);
    expect(posted.body).toMatchObject({ body: 'never gonna stop listening', mine: true, author: { displayName: 'Ania' } });
    await b.agent.post(`/api/songs/${RICK}/comments`).send({ body: 'classic 🔥' }).expect(201);

    const seenByB = await b.agent.get(`/api/songs/${RICK}/comments`).expect(200);
    expect(seenByB.body.total).toBe(2);
    expect(seenByB.body.comments.map((c: { body: string; mine: boolean }) => [c.body, c.mine])).toEqual([
      ['classic 🔥', true],
      ['never gonna stop listening', false],
    ]);

    // Only the author can delete a comment.
    await b.agent.delete(`/api/comments/${posted.body.id}`).expect(403);
    await a.agent.delete(`/api/comments/${posted.body.id}`).expect(204);
    await a.agent.delete(`/api/comments/${posted.body.id}`).expect(404);

    const song = await a.agent.get(`/api/songs/${RICK}`).expect(200);
    expect(song.body.stats.comments).toBe(1);
  });

  it('pages through long threads', async () => {
    const { listener, db } = createTestApp();
    const { agent, me } = await listener();
    for (let i = 0; i < 35; i++) {
      db.prepare('INSERT INTO comments (song_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(RICK, me.id, `comment ${i}`, i);
    }
    const first = await agent.get(`/api/songs/${RICK}/comments`).expect(200);
    expect(first.body.comments).toHaveLength(30);
    expect(first.body.comments[0].body).toBe('comment 34');
    const second = await agent.get(`/api/songs/${RICK}/comments?cursor=${first.body.nextCursor}`).expect(200);
    expect(second.body.comments.map((c: { body: string }) => c.body)).toEqual(['comment 4', 'comment 3', 'comment 2', 'comment 1', 'comment 0']);
    expect(second.body.nextCursor).toBeNull();
  });

  it('rejects empty, huge or spammy comments', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    await agent.post(`/api/songs/${RICK}/comments`).send({ body: '   ' }).expect(400);
    await agent.post(`/api/songs/${RICK}/comments`).send({ body: 'x'.repeat(301) }).expect(400);
    for (let i = 0; i < 8; i++) await agent.post(`/api/songs/${RICK}/comments`).send({ body: `hi ${i}` }).expect(201);
    const limited = await agent.post(`/api/songs/${RICK}/comments`).send({ body: 'one more' }).expect(429);
    expect(limited.body.error).toBe('rate_limited');
  });
});

describe('songs', () => {
  it('searches the songs Earworm knows, best matches first', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    const res = await agent.get('/api/songs/search?q=queen').expect(200);
    expect(res.body.remoteAvailable).toBe(false);
    expect(res.body.local[0].artist).toBe('Queen');
    expect(res.body.local.map((s: { title: string }) => s.title)).toContain('Dancing Queen');
  });

  it('offers genres and starter songs for onboarding', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    const genres = await agent.get('/api/genres').expect(200);
    expect(genres.body.genres[0]).toEqual({ genre: 'pop', count: expect.any(Number) });
    const starter = await agent.get('/api/songs/starter?genre=jazz&limit=5').expect(200);
    expect(starter.body.songs.length).toBeGreaterThan(0);
    expect(starter.body.songs.every((s: { genres: string[] }) => s.genres.includes('jazz'))).toBe(true);
  });

  it('records how long a song played', async () => {
    const { listener, db } = createTestApp();
    const { agent, me } = await listener();
    await agent.post(`/api/songs/${RICK}/seen`).send({ watchedSec: 3.4 }).expect(204);
    await agent.post(`/api/songs/${RICK}/seen`).send({ watchedSec: 61 }).expect(204);
    const row = get<{ seen_count: number; watched_sec: number }>(db, 'SELECT * FROM views WHERE user_id = ? AND song_id = ?', [me.id, RICK]);
    expect(row).toMatchObject({ seen_count: 2, watched_sec: 61 });
  });

  it('hides songs that two listeners could not play', async () => {
    const { listener } = createTestApp();
    const a = await listener();
    const b = await listener();
    await a.agent.post(`/api/songs/${RICK}/unavailable`).send({ code: 150 }).expect(204);
    // Hidden for the listener who hit the error right away...
    expect((await a.agent.post('/api/feed').send({ limit: 20, startWith: undefined })).body.items.map((i: FeedItem) => i.id)).not.toContain(RICK);
    expect((await b.agent.get('/api/songs/search?q=never%20gonna').expect(200)).body.local).toHaveLength(1);
    // ...and for everyone once a second listener confirms it.
    await b.agent.post(`/api/songs/${RICK}/unavailable`).send({ code: 101 }).expect(204);
    expect((await b.agent.get('/api/songs/search?q=never%20gonna').expect(200)).body.local).toHaveLength(0);
  });

  it('explains when a pasted link is not YouTube', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    const res = await agent.post('/api/songs/resolve').send({ url: 'https://open.spotify.com/track/123' }).expect(400);
    expect(res.body.error).toBe('bad_link');
  });
});

describe('API hygiene', () => {
  it('blocks cross-site writes', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    await agent.put(`/api/songs/${RICK}/reaction`).set('Origin', 'https://evil.example').send({ value: 1 }).expect(403);
    await agent.put(`/api/songs/${RICK}/reaction`).set('Origin', 'http://127.0.0.1').send({ value: 1 }).expect(200);
  });

  it('answers unknown endpoints and bad JSON with JSON errors', async () => {
    const { listener } = createTestApp();
    const { agent } = await listener();
    expect((await agent.get('/api/nope').expect(404)).body.error).toBe('not_found');
    const bad = await agent.post('/api/feed').set('Content-Type', 'application/json').send('{oops').expect(400);
    expect(bad.body.error).toBe('bad_json');
  });

  it('never caches API responses', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/api/health').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
