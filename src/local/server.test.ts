import { describe, expect, it, vi } from 'vitest';
import { FakeGoogle, fakeVideo } from '../../server/test/fakeGoogle.ts';
import type { FeedResponse, LibraryResponse, MeResponse, Song } from '../../shared/types.ts';
import type { GoogleAuthPlugin } from './native.ts';
import nodeCrypto from './node-crypto.ts';
import { AutoSaver, memoryStorage } from './persist.ts';
import { createLocalServer, type LocalServer, type LocalServerOptions } from './server.ts';
import { openSqlJsDb } from './sqljs.ts';

const YOUTUBE = 'https://www.googleapis.com/auth/youtube';

async function boot(opts: Partial<LocalServerOptions> & { saved?: Uint8Array | null } = {}) {
  let now = Date.UTC(2026, 9, 7, 12, 0, 0);
  const db = await openSqlJsDb(opts.saved ?? null);
  const server = createLocalServer({
    db,
    fetch: opts.fetch ?? (async (url) => Promise.reject(new Error(`Unexpected request: ${url}`))),
    googleAuth: opts.googleAuth ?? null,
    similarArtists: 'off',
    now: () => now,
    random: () => 0.42,
    ...opts,
  });
  return { db, server, advance: (ms: number) => (now += ms) };
}

async function call<T>(server: LocalServer, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await server.fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function onboard(server: LocalServer): Promise<Song[]> {
  const { body } = await call<{ songs: Song[] }>(server, 'GET', '/songs/starter');
  const picks = body.songs.slice(0, 5);
  await call(server, 'PUT', '/favorites', { songIds: picks.map((s) => s.id) });
  await call(server, 'PATCH', '/me', { onboarded: true });
  return picks;
}

function fakeGoogleAuth(result: () => Promise<{ accessToken: string; grantedScopes: string[] }>) {
  return { authorize: vi.fn<GoogleAuthPlugin['authorize']>(result) };
}

describe('the app’s built-in backend', () => {
  it('serves one listener with the social features switched off', async () => {
    const { server } = await boot();
    const first = await call<MeResponse>(server, 'GET', '/me');
    expect(first.status).toBe(200);
    expect(first.body.features).toEqual({ youtubeLogin: false, youtubeSearch: false, social: false });
    expect(first.body.me.onboarded).toBe(false);
    const again = await call<MeResponse>(server, 'GET', '/me');
    expect(again.body.me.id).toBe(first.body.me.id);
  });

  it('runs the whole listening loop: favourites, feed, reactions, comments and library', async () => {
    const { server } = await boot();
    await onboard(server);

    const feed = await call<FeedResponse>(server, 'POST', '/feed', { limit: 8, exclude: [] });
    expect(feed.status).toBe(200);
    expect(feed.body.items.length).toBeGreaterThan(0);
    expect(feed.body.items[0]!.reason).toBeTruthy();
    const song = feed.body.items[0]!;

    expect((await call(server, 'PUT', `/songs/${song.id}/reaction`, { value: 1 })).status).toBe(200);
    expect((await call(server, 'PUT', `/songs/${song.id}/save`, { saved: true })).status).toBe(200);
    const comment = await call<{ id: number; body: string }>(server, 'POST', `/songs/${song.id}/comments`, { body: 'Chorus!' });
    expect(comment.status).toBe(201);
    const reply = await call<{ parentId: number }>(server, 'POST', `/songs/${song.id}/comments`, { body: 'Bridge too', parentId: comment.body.id });
    expect(reply.body.parentId).toBe(comment.body.id);
    expect((await call(server, 'POST', `/songs/${song.id}/seen`, { watchedSec: 40 })).status).toBe(204);

    const saved = await call<LibraryResponse>(server, 'GET', '/library/saved');
    expect(saved.body.items.map((s) => s.id)).toEqual([song.id]);
    const me = await call<MeResponse>(server, 'GET', '/me');
    expect(me.body.me.counts).toMatchObject({ likes: 1, saves: 1, comments: 2, favorites: 5 });
  });

  it('answers like the web server for errors and unknown endpoints', async () => {
    const { server } = await boot();
    const bad = await call<{ error: string }>(server, 'PUT', '/songs/nope/reaction', { value: 1 });
    expect(bad).toMatchObject({ status: 400, body: { error: 'bad_request' } });
    expect((await call<{ error: string }>(server, 'GET', '/nowhere')).body.error).toBe('not_found');
    const res = await server.fetch('/api/me', { method: 'PATCH', body: '{oops' });
    expect(res.status).toBe(400);
    // The people pages belong to the web server only.
    expect((await call(server, 'GET', '/users')).status).toBe(404);
  });

  it('keeps everything after the app restarts', async () => {
    const storage = memoryStorage();
    const first = await boot();
    const saver = new AutoSaver(first.db, storage, { delayMs: 10_000 });
    await onboard(first.server);
    const feed = await call<FeedResponse>(first.server, 'POST', '/feed', { limit: 5, exclude: [] });
    const song = feed.body.items[0]!;
    await call(first.server, 'PUT', `/songs/${song.id}/reaction`, { value: 1 });
    await saver.flush();
    expect(storage.saves).toBe(1);

    // Exporting frees sql.js' statements; the server must keep working afterwards.
    await call(first.server, 'PUT', `/songs/${song.id}/save`, { saved: true });
    await saver.flush();
    expect(storage.saves).toBe(2);
    await saver.flush();
    expect(storage.saves).toBe(2);

    const second = await boot({ saved: await storage.load() });
    const me = await call<MeResponse>(second.server, 'GET', '/me');
    expect(me.body.me.onboarded).toBe(true);
    expect(me.body.me.counts).toMatchObject({ likes: 1, saves: 1, favorites: 5 });
  });

  it('“Erase my data” starts over with a fresh listener', async () => {
    const { server } = await boot();
    const before = await call<MeResponse>(server, 'GET', '/me');
    await onboard(server);
    expect((await call(server, 'POST', '/auth/logout')).status).toBe(204);
    const after = await call<MeResponse>(server, 'GET', '/me');
    expect(after.body.me.id).not.toBe(before.body.me.id);
    expect(after.body.me.onboarded).toBe(false);
    expect(after.body.me.counts.favorites).toBe(0);
  });
});

describe('connecting YouTube Music in the app', () => {
  it('links the Google account from Android’s sign-in, then syncs and imports with that token', async () => {
    const google = new FakeGoogle();
    const liked = fakeVideo('aaaaaaaaaaa', 'Artist - Liked Song', 'Artist');
    google.addVideos(liked);
    google.liked = [liked.id];
    const auth = fakeGoogleAuth(async () => ({ accessToken: google.accessToken, grantedScopes: ['openid', 'email', YOUTUBE] }));
    const { server } = await boot({ fetch: google.fetch, googleAuth: auth });

    expect((await call<MeResponse>(server, 'GET', '/me')).body.features.youtubeLogin).toBe(true);
    const connected = await call<MeResponse>(server, 'POST', '/auth/native');
    expect(connected.status).toBe(200);
    expect(connected.body.me.youtube).toMatchObject({ email: 'listener@example.com', name: 'Test Listener' });
    expect(auth.authorize).toHaveBeenCalledWith({ interactive: true });

    const library = await call<{ liked: Song[] }>(server, 'GET', '/youtube/library');
    expect(library.body.liked.map((s) => s.id)).toEqual([liked.id]);
    expect(google.callsTo('/videos').every((c) => c.authorization === `Bearer ${google.accessToken}`)).toBe(true);
  });

  it('quietly asks Android for a fresh token when the old one runs out', async () => {
    const google = new FakeGoogle();
    const auth = fakeGoogleAuth(async () => ({ accessToken: google.accessToken, grantedScopes: [YOUTUBE] }));
    const { server, advance } = await boot({ fetch: google.fetch, googleAuth: auth });
    await call(server, 'POST', '/auth/native');

    advance(11 * 60 * 1000);
    google.accessToken = 'access-2';
    expect((await call(server, 'GET', '/youtube/library')).status).toBe(200);
    expect(auth.authorize).toHaveBeenLastCalledWith({ interactive: false });
  });

  it('asks the listener to reconnect when Google wants consent again', async () => {
    const google = new FakeGoogle();
    let consentNeeded = false;
    const auth = fakeGoogleAuth(async () => {
      if (consentNeeded) throw Object.assign(new Error('Needs consent'), { code: 'consent_required' });
      return { accessToken: google.accessToken, grantedScopes: [YOUTUBE] };
    });
    const { server, advance } = await boot({ fetch: google.fetch, googleAuth: auth });
    await call(server, 'POST', '/auth/native');

    advance(11 * 60 * 1000);
    consentNeeded = true;
    expect((await call<{ error: string }>(server, 'GET', '/youtube/library')).body.error).toBe('youtube_reconnect');
    const me = await call<MeResponse>(server, 'GET', '/me');
    expect(me.body.me).toMatchObject({ youtube: null, youtubeExpired: true });
  });

  it('explains cancellations, a missing permission and an unregistered app', async () => {
    const google = new FakeGoogle();
    const fail = (code: string, status: number) => async () =>
      Promise.reject(Object.assign(new Error(`${status}: `), { code, data: { status } }));
    const cases: [() => Promise<{ accessToken: string; grantedScopes: string[] }>, number, string][] = [
      [fail('cancelled', 16), 400, 'cancelled'],
      [async () => ({ accessToken: google.accessToken, grantedScopes: ['openid'] }), 403, 'youtube_scope_missing'],
      [fail('google_error', 10), 502, 'google_setup'],
      [async () => Promise.reject(new Error('10: DEVELOPER_ERROR')), 502, 'google_setup'],
      [fail('google_error', 7), 502, 'google_error'],
    ];
    for (const [result, status, error] of cases) {
      const { server } = await boot({ fetch: google.fetch, googleAuth: fakeGoogleAuth(result) });
      expect(await call<{ error: string }>(server, 'POST', '/auth/native')).toMatchObject({ status, body: { error } });
    }
  });

  it('tells you exactly what to register in Google Cloud when Google turns the app down', async () => {
    const auth = {
      authorize: async () => Promise.reject(Object.assign(new Error('16: '), { code: 'cancelled', data: { status: 16 } })),
      appIdentity: async () => ({ packageName: 'io.github.example.earworm', sha1: 'AA:BB:CC' }),
    };
    const { server } = await boot({ googleAuth: auth });
    const { body } = await call<{ message: string }>(server, 'POST', '/auth/native');
    expect(body.message).toContain('Google status 16');
    expect(body.message).toContain('test user');
    expect(body.message).toContain('package name io.github.example.earworm and SHA-1 AA:BB:CC');
  });
});

describe('picking a YouTube profile by signing in through the browser', () => {
  const CLIENT = { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-test' };

  /** Plays the browser: Google redirects back with a code (or whatever `answer` says). */
  function fakeBrowser(answer: (url: URL) => { code?: string; state?: string; error?: string }) {
    const opened: URL[] = [];
    return {
      opened,
      plugin: {
        start: async () => ({ redirectUri: 'http://127.0.0.1:43210/' }),
        open: async ({ url }: { url: string }) => {
          opened.push(new URL(url));
          return answer(new URL(url));
        },
      },
    };
  }

  async function sha256url(text: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return Buffer.from(digest).toString('base64url');
  }

  it('keeps the Desktop app client, but never hands the secret back', async () => {
    const { db, server } = await boot();
    expect((await call<{ clientId: string | null }>(server, 'GET', '/app/google-client')).body.clientId).toBeNull();
    expect((await call<{ error: string }>(server, 'PUT', '/app/google-client', { clientId: 'nope', clientSecret: 'x' })).body.error).toBe(
      'bad_client_id',
    );
    expect((await call<{ error: string }>(server, 'PUT', '/app/google-client', { ...CLIENT, clientSecret: '' })).body.error).toBe(
      'bad_client_secret',
    );
    const saved = await call<Record<string, unknown>>(server, 'PUT', '/app/google-client', CLIENT);
    expect(saved.body).toEqual({ clientId: CLIENT.clientId });

    // Still there after a restart.
    const again = createLocalServer({ db, fetch: async () => new Response(), googleAuth: null, similarArtists: 'off' });
    expect((await call<{ clientId: string }>(again, 'GET', '/app/google-client')).body.clientId).toBe(CLIENT.clientId);

    expect((await call(server, 'DELETE', '/app/google-client')).status).toBe(204);
    expect((await call<{ clientId: string | null }>(server, 'GET', '/app/google-client')).body.clientId).toBeNull();
  });

  it('asks Google for the profile picker, checks the answer, and keeps a refresh token', async () => {
    const google = new FakeGoogle();
    google.profile = { ...google.profile, sub: 'brand-account-1', name: 'My Music Channel' };
    const playServices = fakeGoogleAuth(async () => ({ accessToken: 'play-services-token', grantedScopes: [YOUTUBE] }));
    const browser = fakeBrowser((url) => ({ code: google.validCode, state: url.searchParams.get('state')! }));
    const { server, advance } = await boot({ fetch: google.fetch, googleAuth: playServices, browserSignIn: browser.plugin });
    await call(server, 'PUT', '/app/google-client', CLIENT);

    const connected = await call<MeResponse>(server, 'POST', '/auth/native');
    expect(connected.status).toBe(200);
    expect(connected.body.me.youtube?.name).toBe('My Music Channel');
    expect(playServices.authorize).not.toHaveBeenCalled();

    const url = browser.opened[0]!;
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('prompt')).toBe('select_account consent');
    expect(url.searchParams.get('client_id')).toBe(CLIENT.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:43210/');
    const exchange = new URLSearchParams(google.callsTo('/token', 'POST')[0]!.body!);
    expect(exchange.get('client_secret')).toBe(CLIENT.clientSecret);
    expect(exchange.get('redirect_uri')).toBe('http://127.0.0.1:43210/');
    expect(await sha256url(exchange.get('code_verifier')!)).toBe(url.searchParams.get('code_challenge'));

    // An hour later the refresh token keeps it going; Play services isn't involved.
    advance(2 * 60 * 60 * 1000);
    expect((await call(server, 'GET', '/youtube/library')).status).toBe(200);
    expect(google.callsTo('/token', 'POST').map((c) => new URLSearchParams(c.body!).get('grant_type'))).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    expect(playServices.authorize).not.toHaveBeenCalled();
  });

  it('switching to another profile starts a fresh "Earworm saves" playlist', async () => {
    const google = new FakeGoogle();
    const browser = fakeBrowser((url) => ({ code: google.validCode, state: url.searchParams.get('state')! }));
    const { db, server } = await boot({ fetch: google.fetch, googleAuth: null, browserSignIn: browser.plugin });
    await call(server, 'PUT', '/app/google-client', CLIENT);
    await call(server, 'POST', '/auth/native');
    const me = await call<MeResponse>(server, 'GET', '/me');
    db.prepare('UPDATE users SET yt_playlist_id = ? WHERE id = ?').run('PLmain', me.body.me.id);

    google.profile = { ...google.profile, sub: 'brand-account-2', name: 'Other Channel' };
    await call(server, 'POST', '/auth/native');
    const row = db.prepare('SELECT google_sub, yt_playlist_id FROM users WHERE id = ?').get(me.body.me.id);
    expect(row).toEqual({ google_sub: 'brand-account-2', yt_playlist_id: null });
  });

  it('turns cancels and mismatches into clear answers', async () => {
    const google = new FakeGoogle();
    const cases: [(url: URL) => { code?: string; state?: string; error?: string }, string][] = [
      [() => ({ error: 'access_denied' }), 'cancelled'],
      [() => ({ code: google.validCode, state: 'someone-elses-state' }), 'invalid_state'],
      [(url) => ({ code: 'wrong-code', state: url.searchParams.get('state')! }), 'google_error'],
    ];
    for (const [answer, error] of cases) {
      const { server } = await boot({ fetch: google.fetch, googleAuth: null, browserSignIn: fakeBrowser(answer).plugin });
      await call(server, 'PUT', '/app/google-client', CLIENT);
      expect((await call<{ error: string }>(server, 'POST', '/auth/native')).body.error).toBe(error);
    }

    const closed = {
      start: async () => ({ redirectUri: 'http://127.0.0.1:43210/' }),
      open: async () => Promise.reject(Object.assign(new Error('The sign-in page was closed'), { code: 'cancelled' })),
    };
    const { server } = await boot({ fetch: google.fetch, googleAuth: null, browserSignIn: closed });
    await call(server, 'PUT', '/app/google-client', CLIENT);
    expect((await call<{ error: string }>(server, 'POST', '/auth/native')).body.error).toBe('cancelled');
  });
});

describe('the node:crypto stand-in', () => {
  it('makes ids and random values with Web Crypto', () => {
    expect(nodeCrypto.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
    for (let i = 0; i < 50; i++) {
      const n = nodeCrypto.randomInt(1000, 10000);
      expect(n).toBeGreaterThanOrEqual(1000);
      expect(n).toBeLessThan(10000);
    }
    expect(nodeCrypto.randomBytes(24).toString('base64url')).toMatch(/^[\w-]{32}$/);
    expect(nodeCrypto.randomBytes(4).toString('hex')).toMatch(/^[0-9a-f]{8}$/);
  });
});
