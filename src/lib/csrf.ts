import type { Context, Next } from 'hono';
import type { Env } from '../types';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function originHostAllowed(value: string, env: Env): boolean {
  try {
    const url = new URL(value);
    const allowedHost = env.AUTH_HOST || new URL(env.ORIGIN).hostname;
    return url.hostname === allowedHost;
  } catch {
    return false;
  }
}

function requestHostAllowed(c: Context<{ Bindings: Env }>): boolean {
  const host = c.req.header('Host');
  if (!host) return false;
  const allowedHost = c.env.AUTH_HOST || new URL(c.env.ORIGIN).hostname;
  return host.split(':')[0] === allowedHost;
}

export async function csrfOriginCheck(c: Context<{ Bindings: Env }>, next: Next) {
  if (!MUTATING.has(c.req.method)) {
    return next();
  }

  const origin = c.req.header('Origin');
  const referer = c.req.header('Referer');

  if (origin && originHostAllowed(origin, c.env)) {
    return next();
  }

  if (referer && originHostAllowed(referer, c.env)) {
    return next();
  }

  if (requestHostAllowed(c)) {
    return next();
  }

  if (origin || referer) {
    return c.json({ error: 'Invalid origin' }, 403);
  }

  return next();
}
