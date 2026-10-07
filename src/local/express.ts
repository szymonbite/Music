// A small stand-in for Express' Router, so the server's route modules
// (server/routes/*.ts) run unchanged inside the Android app, where there is no
// Node.js. The app build points `import { Router } from 'express'` here (see
// vite.config.ts). It covers what the routes use: method and path matching
// with :params, middleware, error handlers, async handlers that throw, and a
// small response API.

import type { UserRow } from '../../server/users.ts';

export interface LocalRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  cookies: Record<string, string>;
  hostname: string;
  protocol: string;
  user?: UserRow;
  get(name: string): string | undefined;
}

type Next = (err?: unknown) => void;
export type LocalHandler = (req: LocalRequest, res: LocalResponse, next: Next) => unknown;
export type LocalErrorHandler = (err: unknown, req: LocalRequest, res: LocalResponse, next: Next) => unknown;
type Handler = LocalHandler;
type ErrorHandler = LocalErrorHandler;

export class LocalResponse {
  statusCode = 200;
  headersSent = false;
  readonly headers = new Headers();
  body: string | null = null;
  private readonly onFinish: () => void;

  constructor(onFinish: () => void) {
    this.onFinish = onFinish;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  set(name: string, value: string): this {
    this.headers.set(name, value);
    return this;
  }

  json(data: unknown): this {
    this.headers.set('Content-Type', 'application/json');
    return this.send(JSON.stringify(data));
  }

  end(): this {
    return this.send(null);
  }

  send(body: string | null): this {
    if (this.headersSent) return this;
    this.headersSent = true;
    this.body = body;
    this.onFinish();
    return this;
  }

  redirect(url: string): this {
    this.status(302).set('Location', url);
    return this.end();
  }

  // Cookies don't apply inside the app: there is only ever one listener.
  cookie(): this {
    return this;
  }

  clearCookie(): this {
    return this;
  }
}

interface Layer {
  method: string | null;
  match: ((path: string) => Record<string, string> | null) | null;
  handler: Handler | ErrorHandler | LocalRouter;
}

function compilePath(pattern: string): (path: string) => Record<string, string> | null {
  const keys: string[] = [];
  const source = pattern
    .split('/')
    .map((part) => {
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const regex = new RegExp(`^${source}/?$`);
  return (path) => {
    const m = regex.exec(path);
    if (!m) return null;
    const params: Record<string, string> = {};
    keys.forEach((key, i) => {
      params[key] = decodeURIComponent(m[i + 1]!);
    });
    return params;
  };
}

export class LocalRouter {
  private readonly layers: Layer[] = [];

  use(...handlers: (Handler | ErrorHandler | LocalRouter)[]): this {
    for (const handler of handlers) this.layers.push({ method: null, match: null, handler });
    return this;
  }

  private route(method: string, path: string, handlers: Handler[]): this {
    const match = compilePath(path);
    for (const handler of handlers) this.layers.push({ method, match, handler });
    return this;
  }

  get(path: string, ...handlers: Handler[]): this {
    return this.route('GET', path, handlers);
  }

  post(path: string, ...handlers: Handler[]): this {
    return this.route('POST', path, handlers);
  }

  put(path: string, ...handlers: Handler[]): this {
    return this.route('PUT', path, handlers);
  }

  patch(path: string, ...handlers: Handler[]): this {
    return this.route('PATCH', path, handlers);
  }

  delete(path: string, ...handlers: Handler[]): this {
    return this.route('DELETE', path, handlers);
  }

  /** Runs the request through the layers in order, like Express does. */
  handle(req: LocalRequest, res: LocalResponse, done: Next): void {
    let index = 0;
    const next: Next = (err) => {
      if (res.headersSent) return;
      const layer = this.layers[index++];
      if (!layer) {
        done(err);
        return;
      }
      if (layer.method && layer.method !== req.method) return next(err);
      if (layer.match) {
        const params = layer.match(req.path);
        if (!params) return next(err);
        req.params = params;
      }
      const { handler } = layer;
      if (handler instanceof LocalRouter) {
        // Like Express, a pending error skips straight past nested routers to the next error handler.
        if (err !== undefined) return next(err);
        handler.handle(req, res, next);
        return;
      }
      const isErrorHandler = handler.length === 4;
      if (err !== undefined && !isErrorHandler) return next(err);
      if (err === undefined && isErrorHandler) return next();
      try {
        const result =
          err !== undefined ? (handler as ErrorHandler)(err, req, res, next) : (handler as Handler)(req, res, next);
        if (result instanceof Promise) result.catch((e: unknown) => next(e ?? new Error('Rejected')));
      } catch (e) {
        next(e);
      }
    };
    next();
  }
}

export function Router(): LocalRouter {
  return new LocalRouter();
}

/** Parses a query string the way Express' "simple" parser does: repeated keys become arrays. */
export function parseQuery(search: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of search) {
    const existing = out[key];
    out[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return out;
}
