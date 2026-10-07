import { Router } from 'express';
import type { Features, MeResponse } from '../../shared/types.ts';
import type { AppContext } from '../context.ts';
import { run } from '../db.ts';
import { badRequest } from '../http.ts';
import { ensureUser, requireUser } from '../session.ts';
import { cleanDisplayName, getUser, parseSettings, sanitizeSettings, toMe, type UserRow } from '../users.ts';
import { body } from '../validate.ts';

export function meResponse(ctx: AppContext, user: UserRow): MeResponse {
  const features: Features = { youtubeLogin: ctx.youtube.loginEnabled, youtubeSearch: ctx.youtube.searchEnabled };
  return { me: toMe(ctx.db, user), features };
}

export function meRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/me', (req, res) => {
    res.json(meResponse(ctx, ensureUser(req, res, ctx)));
  });

  router.patch('/me', (req, res) => {
    const user = requireUser(req);
    const patch = body(req);

    if ('displayName' in patch) {
      const name = cleanDisplayName(patch.displayName);
      if (!name) throw badRequest('Your name needs to be between 1 and 30 characters', 'bad_display_name');
      run(ctx.db, 'UPDATE users SET display_name = ? WHERE id = ?', [name, user.id]);
    }
    if ('onboarded' in patch) {
      if (typeof patch.onboarded !== 'boolean') throw badRequest('onboarded must be true or false');
      run(
        ctx.db,
        'UPDATE users SET onboarded_at = CASE WHEN ? THEN COALESCE(onboarded_at, ?) ELSE NULL END WHERE id = ?',
        [patch.onboarded ? 1 : 0, ctx.now(), user.id],
      );
    }
    if ('settings' in patch) {
      const settings = { ...parseSettings(user.settings), ...sanitizeSettings(patch.settings) };
      run(ctx.db, 'UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(settings), user.id]);
    }

    res.json(meResponse(ctx, getUser(ctx.db, user.id)!));
  });

  return router;
}
