import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import type { AppConfig } from './config.ts';
import type { DB } from './db.ts';
import { HttpError } from './http.ts';
import { createSession, createUser, regionFromAcceptLanguage, userForSession, type UserRow } from './users.ts';

export const SESSION_COOKIE = 'ew_session';
const ONE_YEAR = 365 * 24 * 60 * 60 * 1000;

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRow;
  }
}

function cookieOptions(config: AppConfig): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/', maxAge: ONE_YEAR };
}

export function setSessionCookie(res: Response, token: string, config: AppConfig): void {
  res.cookie(SESSION_COOKIE, token, cookieOptions(config));
}

export function clearSessionCookie(res: Response, config: AppConfig): void {
  const { maxAge: _maxAge, ...options } = cookieOptions(config);
  res.clearCookie(SESSION_COOKIE, options);
}

export function sessionToken(req: Request): string | undefined {
  const value: unknown = req.cookies?.[SESSION_COOKIE];
  return typeof value === 'string' && value.length > 0 && value.length < 200 ? value : undefined;
}

/** Attaches req.user when the request carries a valid session cookie. */
export function sessionMiddleware(db: DB, now: () => number): RequestHandler {
  return (req, _res, next) => {
    const token = sessionToken(req);
    if (token) req.user = userForSession(db, token, now());
    next();
  };
}

export function requireUser(req: Request): UserRow {
  if (!req.user) throw new HttpError(401, 'no_session', 'Your session has ended. Reload the app to continue.');
  return req.user;
}

/** Returns the current user, creating a guest account (and session) on first visit. */
export function ensureUser(req: Request, res: Response, deps: { db: DB; config: AppConfig; now: () => number }): UserRow {
  if (req.user) return req.user;
  const now = deps.now();
  const user = createUser(deps.db, { region: regionFromAcceptLanguage(req.get('accept-language')) }, now);
  setSessionCookie(res, createSession(deps.db, user.id, now), deps.config);
  req.user = user;
  return user;
}

/**
 * Rejects state-changing requests that come from another site. SameSite
 * cookies already cover modern browsers; this is a second line of defence.
 */
export const sameOriginOnly: RequestHandler = (req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let originHost: string;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    return next(new HttpError(403, 'bad_origin', 'Cross-site request blocked'));
  }
  // req.hostname honours X-Forwarded-Host only when "trust proxy" is configured.
  if (originHost !== req.hostname) return next(new HttpError(403, 'bad_origin', 'Cross-site request blocked'));
  next();
};
