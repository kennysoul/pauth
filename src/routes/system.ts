import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env } from '../types';
import { getDb } from '../lib/db';
import { systemConfig } from '../lib/schema';
import { resolveAnySessionForVerify } from '../lib/session';
import { userHasL1Access } from '../lib/permissions';

export const systemRoutes = new Hono<{ Bindings: Env }>();

systemRoutes.get('/state', async (c) => {
  const db = getDb(c.env);
  const config = await db.select().from(systemConfig).where(eq(systemConfig.id, 1)).get();
  return c.json({
    state: config?.state ?? 'NEEDS_SETUP',
    registrationEnabled: Boolean(config?.registrationEnabled),
    origin: c.env.ORIGIN,
  });
});

systemRoutes.get('/verify', async (c) => {
  const resolved = await resolveAnySessionForVerify(c);
  const l1Ok = resolved ? await userHasL1Access(c.env, resolved.user.id) : false;
  if (!resolved || resolved.user.status !== 'active' || !l1Ok) {
    // 从 Caddy forward_auth 传入的原始请求信息
    const proto    = c.req.header('X-Forwarded-Proto') ?? 'https';
    const host     = c.req.header('X-Forwarded-Host')  ?? c.req.header('Host') ?? '';
    const uri      = c.req.header('X-Forwarded-Uri')   ?? '/';
    const returnTo = host ? `${proto}://${host}${uri}` : '';

    const loginUrl = `https://${c.env.AUTH_HOST}/login${
      returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ''
    }`;

    return c.redirect(loginUrl, 302);
  }

  return c.body(null, 200, {
    'X-Auth-User-Id':    resolved.user.id,
    'X-Auth-User-Email': resolved.user.email,
    'X-Auth-User-Name':  resolved.user.name,
    'X-Auth-User-Role':  resolved.user.role,
    'Cache-Control':     'private, no-store, must-revalidate',
  });
});
