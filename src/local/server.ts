// Earworm's backend, running inside the Android app. It's the same code as
// the web server (server/): the same routes, recommender, YouTube sync and
// database queries. What differs is the plumbing: requests arrive from api.ts
// instead of over HTTP, the database is sql.js, there's exactly one listener,
// and Google sign-in goes through Android (native.ts).

import { loadCatalog, seedCatalog } from '../../server/catalog.ts';
import type { AppConfig } from '../../server/config.ts';
import type { AppContext } from '../../server/context.ts';
import { get, run, type DB } from '../../server/db.ts';
import { HttpError, errorHandler, notFound } from '../../server/http.ts';
import { feedRoutes } from '../../server/routes/feed.ts';
import { libraryRoutes } from '../../server/routes/library.ts';
import { meResponse, meRoutes } from '../../server/routes/me.ts';
import { socialRoutes } from '../../server/routes/social.ts';
import { songRoutes } from '../../server/routes/songs.ts';
import { youtubeRoutes } from '../../server/routes/youtube.ts';
import { DeezerProvider, LastFmProvider, SimilarArtists } from '../../server/similar.ts';
import { createUser, getUser, type UserRow } from '../../server/users.ts';
import { YOUTUBE_SCOPE, YouTubeClient, type FetchLike, type TokenResponse } from '../../server/youtube/client.ts';
import { YouTubeService, toHttpError } from '../../server/youtube/service.ts';
import { LocalResponse, Router, parseQuery, type LocalErrorHandler, type LocalHandler, type LocalRequest, type LocalRouter } from './express.ts';
import type { AppIdentity, GoogleAuthPlugin, GoogleAuthResult } from './native.ts';

export interface LocalServerOptions {
  db: DB;
  /** For Google, YouTube and similar-artist lookups. */
  fetch: FetchLike;
  /** Android's Google sign-in, or null when it isn't available. */
  googleAuth: GoogleAuthPlugin | null;
  youtubeApiKey?: string | null;
  lastfmApiKey?: string | null;
  similarArtists?: 'lastfm' | 'deezer' | 'off';
  /** Two-letter region for trending charts. */
  region?: string;
  /** Saves the database right away (before the app reloads after "Erase my data"). */
  persist?: () => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface LocalServer {
  ctx: AppContext;
  /** Handles an API call the way the web server would, e.g. fetch('/api/me'). */
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

// Google Play services doesn't say how long a token lasts, and hands back a
// cached one while it's valid. Asking again every few minutes is cheap.
const NATIVE_TOKEN_SECONDS = 10 * 60;

function errorCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Google's status code, which the Android plugin passes along with a failure. */
function googleStatus(err: unknown): number | undefined {
  const data = err && typeof err === 'object' && 'data' in err ? (err.data as { status?: unknown } | undefined) : undefined;
  return typeof data?.status === 'number' ? data.status : undefined;
}

function tokensFrom(result: GoogleAuthResult): TokenResponse {
  return { access_token: result.accessToken, expires_in: NATIVE_TOKEN_SECONDS, scope: result.grantedScopes.join(' ') };
}

/**
 * Explains why Android's Google sign-in failed. Almost always it's the one-time
 * Google Cloud setup, so spell out exactly what Google needs to see.
 */
function googleError(err: unknown, app: AppIdentity | null): HttpError {
  const status = googleStatus(err);
  const message = errorText(err);
  const client = app
    ? `an Android OAuth client with package name ${app.packageName} and SHA-1 ${app.sha1}`
    : 'an Android OAuth client with Earworm’s package name and SHA-1 (see docs/ANDROID.md)';
  if (status === 10 || /^10\b|DEVELOPER_ERROR/.test(message)) {
    return new HttpError(
      502,
      'google_setup',
      `Google doesn’t recognise this app yet (error 10). In Google Cloud, create ${client}, in the same project as your OAuth consent screen. It can take a few minutes to start working.`,
    );
  }
  if (errorCode(err) === 'cancelled') {
    return new HttpError(
      400,
      'cancelled',
      `Connecting YouTube Music was cancelled${status !== undefined ? ` (Google status ${status})` : ''}. If you didn’t cancel it, Google turned the app down. Check that your Google account is listed as a test user on the OAuth consent screen (Audience), and that Google Cloud has ${client}.`,
    );
  }
  return new HttpError(502, 'google_error', `Google sign-in didn’t work (${status !== undefined ? `status ${status}: ` : ''}${message}).`);
}

export function createLocalServer(opts: LocalServerOptions): LocalServer {
  const { db, googleAuth } = opts;
  const now = opts.now ?? (() => Date.now());
  const region = opts.region ?? 'US';
  const lastfmApiKey = opts.lastfmApiKey ?? null;
  const similarSetting = opts.similarArtists ?? (lastfmApiKey ? 'lastfm' : 'deezer');

  const config: AppConfig = {
    port: 0,
    isProduction: true,
    appUrl: null,
    databasePath: 'indexeddb',
    cookieSecure: false,
    trustProxy: false,
    youtube: {
      apiKey: opts.youtubeApiKey ?? null,
      clientId: null,
      clientSecret: null,
      discoverySearch: false,
      dailySearchBudget: 30,
    },
    similarArtists: { provider: similarSetting, lastfmApiKey },
    social: false,
  };

  const youtube = new YouTubeService({
    db,
    now,
    discoverySearch: false,
    dailySearchBudget: config.youtube.dailySearchBudget,
    client: new YouTubeClient({ apiKey: config.youtube.apiKey, clientId: null, clientSecret: null, fetch: opts.fetch }),
    renewToken: googleAuth
      ? async () => {
          try {
            return tokensFrom(await googleAuth.authorize({ interactive: false }));
          } catch (err) {
            if (errorCode(err) === 'consent_required') return null;
            throw err;
          }
        }
      : undefined,
  });

  const similar = new SimilarArtists({
    db,
    now,
    provider:
      similarSetting === 'lastfm' && lastfmApiKey
        ? new LastFmProvider(lastfmApiKey, opts.fetch)
        : similarSetting === 'deezer'
          ? new DeezerProvider(opts.fetch)
          : null,
  });

  const ctx: AppContext = { db, config, youtube, similar, now, random: opts.random ?? Math.random };

  seedCatalog(db, loadCatalog(), now());

  /** The app's one listener, created on first launch (and again after "Erase my data"). */
  const listener = (): UserRow =>
    get<UserRow>(db, 'SELECT * FROM users ORDER BY created_at, id LIMIT 1') ?? createUser(db, { region }, now());

  const local = Router();
  local.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // "Connect YouTube Music": Android shows Google's account picker, then we link the account.
  local.post('/auth/native', async (req, res) => {
    const user = req.user!;
    if (!googleAuth) throw new HttpError(404, 'youtube_login_disabled', 'Connecting YouTube Music only works in the Android app.');
    let tokens: TokenResponse;
    try {
      tokens = tokensFrom(await googleAuth.authorize({ interactive: true }));
    } catch (err) {
      const app = (await googleAuth.appIdentity?.().catch(() => null)) ?? null;
      throw googleError(err, app);
    }
    if (!tokens.scope?.split(' ').includes(YOUTUBE_SCOPE)) {
      throw new HttpError(403, 'youtube_scope_missing', 'Earworm needs permission to manage your YouTube account to sync with YouTube Music.');
    }
    try {
      youtube.linkAccount(user, tokens, await youtube.verifiedProfile(tokens));
    } catch (err) {
      throw toHttpError(err);
    }
    res.json(meResponse(ctx, getUser(db, user.id)!));
  });

  local.post('/auth/google/disconnect', async (req, res) => {
    const user = req.user!;
    await youtube.disconnect(user);
    res.json(meResponse(ctx, getUser(db, user.id)!));
  });

  // "Erase my data": the app has no accounts to sign out of, so start over with a fresh listener.
  local.post('/auth/logout', async (req, res) => {
    const user = req.user!;
    if (user.yt_access_token || user.yt_refresh_token) await youtube.disconnect(user);
    // Everything personal hangs off the user row and goes with it (ON DELETE CASCADE).
    run(db, 'DELETE FROM users WHERE id = ?', [user.id]);
    await opts.persist?.();
    res.status(204).end();
  });

  const api = Router();
  const attachListener: LocalHandler = (req, _res, next) => {
    req.user = listener();
    next();
  };
  const noSuchEndpoint: LocalHandler = (_req, _res, next) => next(notFound('No such API endpoint'));
  api.use(attachListener);
  api.use(local);
  // In the app build `express` resolves to ./express.ts, so these are LocalRouters.
  const shared = [meRoutes(ctx), feedRoutes(ctx), songRoutes(ctx), socialRoutes(ctx), libraryRoutes(ctx), youtubeRoutes(ctx)];
  api.use(...(shared as unknown as LocalRouter[]));
  api.use(noSuchEndpoint);
  api.use(errorHandler as unknown as LocalErrorHandler);

  if (youtube.searchEnabled) {
    youtube.hydrateCatalog().catch((err: unknown) => console.warn('Could not refresh catalogue songs from YouTube:', errorText(err)));
  }

  return {
    ctx,
    fetch(input, init = {}) {
      const url = new URL(input, 'https://earworm.invalid');
      const headers = new Headers(init.headers);
      let body: unknown;
      if (typeof init.body === 'string' && init.body) {
        try {
          body = JSON.parse(init.body);
        } catch {
          return Promise.resolve(
            Response.json({ error: 'bad_json', message: 'Request body is not valid JSON' }, { status: 400 }),
          );
        }
      }
      const req: LocalRequest = {
        method: (init.method ?? 'GET').toUpperCase(),
        path: url.pathname.replace(/^\/api(?=\/)/, ''),
        params: {},
        query: parseQuery(url.searchParams),
        body,
        cookies: {},
        hostname: 'localhost',
        protocol: 'https',
        get: (name) => headers.get(name) ?? undefined,
      };
      return new Promise((resolve) => {
        const res = new LocalResponse(() => resolve(new Response(res.body, { status: res.statusCode, headers: res.headers })));
        api.handle(req, res, (err) => {
          console.error('Unhandled API error:', err);
          res.status(500).json({ error: 'internal', message: 'Something went wrong' });
        });
      });
    },
  };
}
