import type { ErrorRequestHandler } from 'express';
import type { ApiErrorBody } from '../shared/types.ts';

/** An error that maps directly onto an HTTP response. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string, code = 'bad_request') => new HttpError(400, code, message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message } satisfies ApiErrorBody);
    return;
  }
  // express.json() parse errors
  if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'bad_json', message: 'Request body is not valid JSON' } satisfies ApiErrorBody);
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'internal', message: 'Something went wrong' } satisfies ApiErrorBody);
};

/** Fixed-window rate limiter keyed by user (or anything else). */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Throws a 429 when the key has used up its allowance. */
  consume(key: string): void {
    const now = this.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: now, count: 1 });
      if (this.hits.size > 10_000) this.prune(now);
      return;
    }
    if (entry.count >= this.limit) {
      throw new HttpError(429, 'rate_limited', 'Slow down a little and try again in a moment');
    }
    entry.count++;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.hits) {
      if (now - entry.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }
}
