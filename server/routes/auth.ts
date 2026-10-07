import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import type { AppContext } from '../context.ts';
import { get, run } from '../db.ts';
import { HttpError } from '../http.ts';
import { clearSessionCookie, ensureUser, requireUser, sessionToken } from '../session.ts';
import { deleteSession, getUser, mergeUsers, type UserRow } from '../users.ts';
import { meResponse } from './me.ts';

const STATE_TTL = 15 * 60 * 1000;
const RETURN_PATHS = new Set(['/', '/welcome', '/pick', '/me', '/library']);

function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && RETURN_PATHS.has(value) ? value : '/';
}

function withParam(path: string, key: string, value: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}

function redirectUri(ctx: AppContext, req: Request): string {
  const base = ctx.config.appUrl ?? `${req.protocol}://${req.get('host')}`;
  return `${base}/api/auth/google/callback`;
}

interface OAuthState {
  user_id: string;
  code_verifier: string;
  return_to: string;
  created_at: number;
}

export function authRoutes(ctx: AppContext): Router {
  const router = Router();

  // Step 1: send the listener to Google's consent screen.
  router.get('/auth/google', (req, res) => {
    if (!ctx.youtube.loginEnabled) {
      throw new HttpError(404, 'youtube_login_disabled', 'Connecting YouTube Music isn’t set up on this server yet.');
    }
    const user = ensureUser(req, res, ctx);
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const now = ctx.now();
    run(ctx.db, 'DELETE FROM oauth_states WHERE created_at < ?', [now - STATE_TTL]);
    run(ctx.db, 'INSERT INTO oauth_states (state, user_id, code_verifier, return_to, created_at) VALUES (?, ?, ?, ?, ?)', [
      state,
      user.id,
      verifier,
      safeReturnTo(req.query.returnTo),
      now,
    ]);
    res.redirect(ctx.youtube.client.authUrl({ redirectUri: redirectUri(ctx, req), state, codeChallenge: challenge }));
  });

  // Step 2: Google sends the listener back with a one-time code.
  router.get('/auth/google/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const fail = (reason: string, returnTo = '/') => res.redirect(withParam(returnTo, 'youtube_error', reason));

    if (typeof state !== 'string') return fail('invalid_state');
    const saved = get<OAuthState>(ctx.db, 'SELECT * FROM oauth_states WHERE state = ?', [state]);
    run(ctx.db, 'DELETE FROM oauth_states WHERE state = ?', [state]);
    if (!saved || ctx.now() - saved.created_at > STATE_TTL) return fail('expired');
    if (!req.user || req.user.id !== saved.user_id) return fail('session_mismatch', saved.return_to);
    if (typeof error === 'string') return fail(error === 'access_denied' ? 'cancelled' : 'google_error', saved.return_to);
    if (typeof code !== 'string' || !code) return fail('missing_code', saved.return_to);

    try {
      const { tokens, profile } = await ctx.youtube.completeLogin({
        code,
        codeVerifier: saved.code_verifier,
        redirectUri: redirectUri(ctx, req),
      });
      let target: UserRow = req.user;
      const owner = get<UserRow>(ctx.db, 'SELECT * FROM users WHERE google_sub = ?', [profile.sub]);
      if (owner && owner.id !== target.id) {
        // This Google account already has an Earworm profile (e.g. from another device): fold this guest into it.
        mergeUsers(ctx.db, target.id, owner.id);
        target = getUser(ctx.db, owner.id)!;
      }
      ctx.youtube.linkAccount(target, tokens, profile);
      res.redirect(withParam(saved.return_to, 'youtube', 'connected'));
    } catch (err) {
      console.warn('Connecting YouTube Music failed:', err instanceof Error ? err.message : err);
      const reason = err instanceof HttpError && err.code === 'youtube_scope_missing' ? 'scope_missing' : 'google_error';
      fail(reason, saved.return_to);
    }
  });

  router.post('/auth/google/disconnect', async (req, res) => {
    const user = requireUser(req);
    await ctx.youtube.disconnect(user);
    res.json(meResponse(ctx, getUser(ctx.db, user.id)!));
  });

  router.post('/auth/logout', (req, res) => {
    const token = sessionToken(req);
    if (token) deleteSession(ctx.db, token);
    clearSessionCookie(res, ctx.config);
    res.status(204).end();
  });

  return router;
}
