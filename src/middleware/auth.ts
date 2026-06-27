import { createMiddleware } from 'hono/factory';
import type { Env, AuthContext } from '../types';
import { resolveNormalSession } from '../lib/session';

export const requireAuth = createMiddleware<{ Bindings: Env; Variables: AuthContext }>(
  async (c, next) => {
    const resolved = await resolveNormalSession(c);
    if (!resolved) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (resolved.user.status !== 'active') {
      return c.json({ error: 'Account not active' }, 403);
    }
    c.set('user', resolved.user);
    c.set('session', resolved.session);
    return next();
  },
);

export const requireAdmin = createMiddleware<{ Bindings: Env; Variables: AuthContext }>(
  async (c, next) => {
    if (c.get('user').role !== 'admin') {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  },
);
