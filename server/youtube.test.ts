import crypto from 'node:crypto';
import type request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { FeedItem } from '../shared/types.ts';
import { all, get } from './db.ts';
import { FakeGoogle, fakeVideo } from './test/fakeGoogle.ts';
import { createTestApp, entry } from './test/helpers.ts';

const RICK = 'dQw4w9WgXcQ';
const DESPACITO = 'kJQP7kiw5Fk';

type Agent = ReturnType<typeof request.agent>;

/** Runs the whole "Connect YouTube Music" redirect dance for a listener. */
async function connect(agent: Agent, returnTo = '/pick') {
  const start = await agent.get(`/api/auth/google?returnTo=${encodeURIComponent(returnTo)}`).expect(302);
  const authUrl = new URL(start.headers.location as string);
  const state = authUrl.searchParams.get('state')!;
  const callback = await agent.get(`/api/auth/google/callback?code=good-code&state=${state}`).expect(302);
  return { authUrl, location: callback.headers.location as string };
}

function connectedApp(opts: { apiKey?: string } = {}) {
  const google = new FakeGoogle();
  const test = createTestApp({ fetch: google.fetch, oauth: true, apiKey: opts.apiKey });
  return { google, ...test };
}

describe('connecting YouTube Music', () => {
  it('runs the OAuth flow with PKCE and links the Google account', async () => {
    const { google, listener } = connectedApp();
    const { agent } = await listener();

    const { authUrl, location } = await connect(agent, '/pick');
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authUrl.searchParams.get('client_id')).toBe('test-client-id');
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/google/callback');
    expect(authUrl.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/youtube');
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location).toBe('/pick?youtube=connected');

    // The verifier sent with the code must match the challenge sent to the consent screen.
    const [tokenCall] = google.callsTo('/token', 'POST');
    const verifier = new URLSearchParams(tokenCall!.body!).get('code_verifier')!;
    expect(crypto.createHash('sha256').update(verifier).digest('base64url')).toBe(authUrl.searchParams.get('code_challenge'));

    const me = await agent.get('/api/me').expect(200);
    expect(me.body.features.youtubeLogin).toBe(true);
    expect(me.body.me.youtube).toEqual({
      email: 'listener@example.com',
      name: 'Test Listener',
      pictureUrl: 'https://example.com/me.png',
      playlistUrl: null,
    });
    expect(me.body.me.avatarUrl).toBe('https://example.com/me.png');
  });

  it('refuses unknown, reused or mismatched sign-in attempts', async () => {
    const { listener } = connectedApp();
    const { agent } = await listener();
    const bogus = await agent.get('/api/auth/google/callback?code=good-code&state=made-up').expect(302);
    expect(bogus.headers.location).toBe('/?youtube_error=expired');

    const start = await agent.get('/api/auth/google?returnTo=/me').expect(302);
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const other = await listener();
    const stolen = await other.agent.get(`/api/auth/google/callback?code=good-code&state=${state}`).expect(302);
    expect(stolen.headers.location).toBe('/me?youtube_error=session_mismatch');
    // The state was used up by the failed attempt.
    const reused = await agent.get(`/api/auth/google/callback?code=good-code&state=${state}`).expect(302);
    expect(reused.headers.location).toBe('/?youtube_error=expired');
  });

  it('reports a cancelled consent screen', async () => {
    const { listener } = connectedApp();
    const { agent } = await listener();
    const start = await agent.get('/api/auth/google?returnTo=/pick').expect(302);
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const res = await agent.get(`/api/auth/google/callback?error=access_denied&state=${state}`).expect(302);
    expect(res.headers.location).toBe('/pick?youtube_error=cancelled');
  });

  it('insists on the YouTube permission', async () => {
    const { google, listener } = connectedApp();
    google.grantedScope = 'openid https://www.googleapis.com/auth/userinfo.email';
    const { agent } = await listener();
    const { location } = await connect(agent);
    expect(location).toBe('/pick?youtube_error=scope_missing');
    expect((await agent.get('/api/me')).body.me.youtube).toBeNull();
  });

  it('signs back into the same profile from another device, keeping what the guest did', async () => {
    const { listener } = connectedApp();
    const phone = await listener();
    await connect(phone.agent);
    await phone.agent.put('/api/favorites').send({ songIds: [RICK] }).expect(200);

    const laptop = await listener();
    expect(laptop.me.id).not.toBe(phone.me.id);
    await laptop.agent.put(`/api/songs/${DESPACITO}/reaction`).send({ value: 1 }).expect(200);
    await laptop.agent.post(`/api/songs/${DESPACITO}/comments`).send({ body: 'from my laptop' }).expect(201);
    await connect(laptop.agent);

    const me = (await laptop.agent.get('/api/me').expect(200)).body.me;
    expect(me.id).toBe(phone.me.id);
    expect(me.counts).toEqual({ favorites: 1, likes: 1, saves: 0, comments: 1, followers: 0, following: 0 });
  });

  it('disconnects and revokes the token', async () => {
    const { google, listener } = connectedApp();
    const { agent } = await listener();
    await connect(agent);
    const res = await agent.post('/api/auth/google/disconnect').expect(200);
    expect(res.body.me.youtube).toBeNull();
    expect(google.callsTo('/revoke', 'POST')).toHaveLength(1);
  });
});

describe('mirroring to YouTube Music', () => {
  it('rates songs on YouTube when you like or dislike them', async () => {
    const { google, listener } = connectedApp();
    const { agent } = await listener();
    await connect(agent);

    expect((await agent.put(`/api/songs/${RICK}/reaction`).send({ value: 1 }).expect(200)).body.youtube).toBe('ok');
    await agent.put(`/api/songs/${RICK}/reaction`).send({ value: -1 }).expect(200);
    await agent.put(`/api/songs/${RICK}/reaction`).send({ value: 0 }).expect(200);
    const ratings = google.callsTo('/videos/rate', 'POST').map((c) => [c.url.searchParams.get('id'), c.url.searchParams.get('rating')]);
    expect(ratings).toEqual([
      [RICK, 'like'],
      [RICK, 'dislike'],
      [RICK, 'none'],
    ]);
    expect(google.callsTo('/videos/rate')[0]!.authorization).toBe('Bearer access-1');

    await agent.patch('/api/me').send({ settings: { syncReactions: false } }).expect(200);
    expect((await agent.put(`/api/songs/${RICK}/reaction`).send({ value: 1 }).expect(200)).body.youtube).toBe('off');
    expect(google.callsTo('/videos/rate')).toHaveLength(3);
  });

  it('keeps an "Earworm saves" playlist in sync with saved songs', async () => {
    const { google, listener } = connectedApp();
    const { agent } = await listener();
    await connect(agent);

    expect((await agent.put(`/api/songs/${RICK}/save`).send({ saved: true }).expect(200)).body.youtube).toBe('ok');
    await agent.put(`/api/songs/${DESPACITO}/save`).send({ saved: true }).expect(200);
    expect(google.createdPlaylists).toEqual(['PLearworm1']);
    expect(google.playlistItems.get('PLearworm1')).toEqual([RICK, DESPACITO]);
    const [createCall] = google.callsTo('/playlists', 'POST');
    expect(JSON.parse(createCall!.body!)).toMatchObject({ snippet: { title: 'Earworm saves' }, status: { privacyStatus: 'private' } });

    await agent.put(`/api/songs/${RICK}/save`).send({ saved: false }).expect(200);
    const [deleteCall] = google.callsTo('/playlistItems', 'DELETE');
    expect(deleteCall!.url.searchParams.get('id')).toBe('item-1');

    const me = (await agent.get('/api/me').expect(200)).body.me;
    expect(me.youtube.playlistUrl).toBe('https://music.youtube.com/playlist?list=PLearworm1');
  });

  it('recreates the playlist if it was deleted on YouTube', async () => {
    const { google, listener } = connectedApp();
    const { agent } = await listener();
    await connect(agent);
    await agent.put(`/api/songs/${RICK}/save`).send({ saved: true }).expect(200);
    google.playlistItems.delete('PLearworm1');
    expect((await agent.put(`/api/songs/${DESPACITO}/save`).send({ saved: true }).expect(200)).body.youtube).toBe('ok');
    expect(google.createdPlaylists).toEqual(['PLearworm1', 'PLearworm2']);
  });

  it('refreshes expired access tokens, and disconnects when Google revokes access', async () => {
    const { google, listener, advance } = connectedApp();
    const { agent } = await listener();
    await connect(agent);

    advance(2 * 60 * 60 * 1000);
    await agent.put(`/api/songs/${RICK}/reaction`).send({ value: 1 }).expect(200);
    expect(google.callsTo('/token', 'POST').map((c) => new URLSearchParams(c.body!).get('grant_type'))).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    expect(google.callsTo('/videos/rate')[0]!.authorization).toBe('Bearer access-2');

    advance(2 * 60 * 60 * 1000);
    google.failRefresh = true;
    const res = await agent.put(`/api/songs/${DESPACITO}/reaction`).send({ value: 1 }).expect(200);
    expect(res.body).toMatchObject({ reaction: 1, youtube: 'error' });
    const after = (await agent.get('/api/me').expect(200)).body.me;
    expect(after.youtube).toBeNull();
    expect(after.youtubeExpired).toBe(true);

    // Reconnecting clears the flag and keeps the same profile.
    google.failRefresh = false;
    await connect(agent);
    const reconnected = (await agent.get('/api/me').expect(200)).body.me;
    expect(reconnected).toMatchObject({ youtubeExpired: false, youtube: { email: 'listener@example.com' } });
  });
});

describe('YouTube library, search and discovery', () => {
  it('imports liked music and playlists, and keeps those songs out of the feed', async () => {
    const google = new FakeGoogle();
    const { listener, db } = createTestApp({
      fetch: google.fetch,
      oauth: true,
      catalog: [entry('catalogSng1', 'Somebody', 'Catalogue Song', ['pop'])],
    });
    google.addVideos(
      fakeVideo('catalogSng1', 'Somebody - Catalogue Song', 'Somebody'),
      fakeVideo('likedSong01', 'Glass Animals - Heat Waves (Official Video)', 'Glass Animals'),
      fakeVideo('likedVlog01', 'My morning routine', 'Some Vlogger', { categoryId: '22' }),
      fakeVideo('mixSong0001', 'Tame Impala - Borderline', 'Tame Impala'),
    );
    google.liked = ['likedSong01', 'likedVlog01'];
    google.playlists = [{ id: 'PLmix', snippet: { title: 'Summer mix' }, contentDetails: { itemCount: 1 } }];
    google.playlistItems.set('PLmix', ['mixSong0001']);

    const { agent, me } = await listener();
    await connect(agent);
    const library = await agent.get('/api/youtube/library').expect(200);
    expect(library.body.liked).toEqual([
      expect.objectContaining({ id: 'likedSong01', title: 'Heat Waves', artist: 'Glass Animals', durationSec: 210, genres: ['pop'] }),
    ]);
    expect(library.body.playlists).toEqual([{ id: 'PLmix', title: 'Summer mix', itemCount: 1, thumbnailUrl: null }]);

    const playlist = await agent.get('/api/youtube/playlists/PLmix').expect(200);
    expect(playlist.body).toMatchObject({ playlistTitle: 'Summer mix', songs: [{ id: 'mixSong0001', artist: 'Tame Impala', title: 'Borderline' }] });

    const known = all<{ song_id: string }>(db, 'SELECT song_id FROM library WHERE user_id = ? ORDER BY song_id', [me.id]).map((r) => r.song_id);
    expect(known).toEqual(['likedSong01', 'mixSong0001']);
    const feed = await agent.post('/api/feed').send({ limit: 20 }).expect(200);
    const ids = feed.body.items.map((i: FeedItem) => i.id);
    expect(ids).toContain('catalogSng1');
    expect(ids).not.toContain('likedSong01');
    expect(ids).not.toContain('mixSong0001');
  });

  it('needs a connection before importing a library', async () => {
    const { listener } = connectedApp();
    const { agent } = await listener();
    expect((await agent.get('/api/youtube/library').expect(409)).body.error).toBe('youtube_not_connected');
  });

  it('searches YouTube with the API key', async () => {
    const { google, listener } = connectedApp({ apiKey: 'test-api-key' });
    google.addVideos(fakeVideo('searchHit01', 'Måneskin - Beggin (Official Video)', 'ManeskinVEVO'));
    google.searchResults = ['searchHit01'];
    const { agent } = await listener();

    const res = await agent.get('/api/songs/search?q=beggin&remote=1').expect(200);
    expect(res.body.remoteAvailable).toBe(true);
    expect(res.body.remote).toEqual([expect.objectContaining({ id: 'searchHit01', artist: 'Måneskin', title: 'Beggin', source: 'youtube' })]);
    const [searchCall] = google.callsTo('/search');
    expect(searchCall!.url.searchParams.get('key')).toBe('test-api-key');
    expect(searchCall!.url.searchParams.get('videoCategoryId')).toBe('10');
  });

  it('adds songs from pasted links, even without an API key', async () => {
    const google = new FakeGoogle();
    google.addVideos(fakeVideo('pastedLink1', 'Daft Punk - Harder, Better, Faster, Stronger (Official Video)', 'Daft Punk'));
    const { listener } = createTestApp({ fetch: google.fetch });
    const { agent } = await listener();

    const res = await agent.post('/api/songs/resolve').send({ url: 'https://music.youtube.com/watch?v=pastedLink1&si=x' }).expect(200);
    expect(res.body.songs).toEqual([
      expect.objectContaining({ id: 'pastedLink1', artist: 'Daft Punk', title: 'Harder, Better, Faster, Stronger', source: 'link' }),
    ]);
    const missing = await agent.post('/api/songs/resolve').send({ url: 'https://youtu.be/missingVid1' }).expect(404);
    expect(missing.body.error).toBe('video_not_found');
    const playlist = await agent.post('/api/songs/resolve').send({ url: 'https://music.youtube.com/playlist?list=PLabc' }).expect(400);
    expect(playlist.body.error).toBe('youtube_unavailable');
  });

  it('pulls trending music and favourite-artist uploads into the feed when running low', async () => {
    const google = new FakeGoogle();
    google.addVideos(
      fakeVideo('catalogSng1', 'Somebody - Old Song', 'Somebody'),
      fakeVideo('catalogSng2', 'Other - Older Song', 'Other'),
      fakeVideo('trending001', 'New Artist - Big Summer Hit (Official Video)', 'NewArtistVEVO', { views: 50_000_000 }),
      fakeVideo('trendLive01', 'Live concert stream', 'Somebody', { duration: 'PT2H' }),
      fakeVideo('upload00001', 'Fav Band - Deep Cut', 'Fav Band', { channelId: 'UCfavband1' }),
      fakeVideo('favSong0001', 'Fav Band - Their Hit', 'Fav Band', { channelId: 'UCfavband1' }),
    );
    google.chart = ['trending001', 'trendLive01'];
    google.playlistItems.set('UUfavband1', ['upload00001', 'favSong0001']);

    const catalog = [entry('catalogSng1', 'Somebody', 'Old Song', ['pop']), entry('catalogSng2', 'Other', 'Older Song', ['rock'])];
    const { listener, db } = createTestApp({ fetch: google.fetch, apiKey: 'test-api-key', catalog });
    const { agent } = await listener();

    // A favourite with known YouTube channel data seeds "more from this artist".
    await agent.post('/api/songs/resolve').send({ url: 'https://youtu.be/favSong0001' }).expect(200);
    await agent.put('/api/favorites').send({ songIds: ['favSong0001'] }).expect(200);

    const feed = await agent.post('/api/feed').send({ limit: 10 }).expect(200);
    const ids = feed.body.items.map((i: FeedItem) => i.id);
    expect(ids).toEqual(expect.arrayContaining(['trending001', 'upload00001', 'catalogSng1', 'catalogSng2']));
    expect(ids).not.toContain('trendLive01');
    expect(ids).not.toContain('favSong0001');

    const trending = get<{ trending_at: number | null }>(db, 'SELECT trending_at FROM songs WHERE id = ?', ['trending001']);
    expect(trending?.trending_at).toEqual(expect.any(Number));
    const reasons = Object.fromEntries(feed.body.items.map((i: FeedItem) => [i.id, i.reason]));
    expect(reasons.upload00001).toBe('Because you like Fav Band');

    // Throttled: a second feed request doesn't hit YouTube again.
    const callCount = google.calls.length;
    await agent.post('/api/feed').send({ limit: 10 }).expect(200);
    expect(google.calls.length).toBe(callCount);
  });

  it('checks catalogue songs against YouTube and hides missing or blocked ones', async () => {
    const google = new FakeGoogle();
    google.addVideos(
      fakeVideo('catalogOk01', 'Real Title (Official Video)', 'Artist', { duration: 'PT4M1S' }),
      fakeVideo('catalogBlk1', 'Blocked', 'Artist', { embeddable: false }),
    );
    const catalog = [
      entry('catalogOk01', 'Curated Artist', 'Curated Title', ['rock']),
      entry('catalogBlk1', 'Curated Artist', 'Blocked Song', ['rock']),
      entry('catalogGone', 'Curated Artist', 'Deleted Song', ['rock']),
    ];
    const { ctx, db } = createTestApp({ fetch: google.fetch, apiKey: 'test-api-key', catalog });
    await ctx.youtube.hydrateCatalog();

    const rows = all<{ id: string; title: string; duration_sec: number | null; unavailable: number }>(
      db,
      'SELECT id, title, duration_sec, unavailable FROM songs ORDER BY id',
    );
    expect(rows).toEqual([
      { id: 'catalogBlk1', title: 'Blocked Song', duration_sec: 210, unavailable: 1 },
      { id: 'catalogGone', title: 'Deleted Song', duration_sec: null, unavailable: 1 },
      // Curated metadata wins; YouTube fills in the duration.
      { id: 'catalogOk01', title: 'Curated Title', duration_sec: 241, unavailable: 0 },
    ]);
  });
});
