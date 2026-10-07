import cookieParser from 'cookie-parser';
import express, { Router } from 'express';
import type { AppContext } from './context.ts';
import { errorHandler, notFound } from './http.ts';
import { authRoutes } from './routes/auth.ts';
import { feedRoutes } from './routes/feed.ts';
import { libraryRoutes } from './routes/library.ts';
import { meRoutes } from './routes/me.ts';
import { peopleRoutes } from './routes/people.ts';
import { socialRoutes } from './routes/social.ts';
import { songRoutes } from './routes/songs.ts';
import { youtubeRoutes } from './routes/youtube.ts';
import { sameOriginOnly, sessionMiddleware } from './session.ts';

export function apiRouter(ctx: AppContext): Router {
  const api = Router();
  api.use(express.json({ limit: '200kb' }));
  api.use(cookieParser());
  api.use(sameOriginOnly);
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(sessionMiddleware(ctx.db, ctx.now));

  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use(meRoutes(ctx), authRoutes(ctx), feedRoutes(ctx), songRoutes(ctx), socialRoutes(ctx), libraryRoutes(ctx), youtubeRoutes(ctx), peopleRoutes(ctx));

  api.use((_req, _res, next) => next(notFound('No such API endpoint')));
  api.use(errorHandler);
  return api;
}

/** The Express app with the JSON API mounted at /api. The web client is added by server/index.ts. */
export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', ctx.config.trustProxy);
  app.use('/api', apiRouter(ctx));
  return app;
}
