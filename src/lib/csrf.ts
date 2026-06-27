import type { Context, Next } from 'hono';
import type { Env } from '../types';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function csrfOriginCheck(c: Context<{ Bindings: Env }>, next: Next) {
  if (!MUTATING.has(c.req.method)) {
    return next();
  }

  const origin = c.req.header('Origin');
  const referer = c.req.header('Referer');
  const expected = c.env.ORIGIN;

  if (origin) {
    if (!origin.startsWith(expected)) {
      return c.json({ error: 'Invalid origin' }, 403);
    }
    return next();
  }

  if (referer && !referer.startsWith(expected)) {
    return c.json({ error: 'Invalid referer' }, 403);
  }

  return next();
}
