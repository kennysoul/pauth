import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env } from '../types';
import { getDb } from '../lib/db';
import { systemConfig } from '../lib/schema';
import { resolveAnySessionForVerify } from '../lib/session';

export const systemRoutes = new Hono<{ Bindings: Env }>();

systemRoutes.get('/state', async (c) => {
  const db = getDb(c.env);
  const config = await db.select().from(systemConfig).where(eq(systemConfig.id, 1)).get();
  return c.json({
    state: config?.state ?? 'NEEDS_SETUP',
    registrationEnabled: Boolean(config?.registrationEnabled),
  });
});

systemRoutes.get('/verify', async (c) => {
  const resolved = await resolveAnySessionForVerify(c);
  if (!resolved || resolved.user.status !== 'active') {
    return c.body(null, 401);
  }

  return c.body(null, 200, {
    'X-Auth-User-Id': resolved.user.id,
    'X-Auth-User-Email': resolved.user.email,
    'X-Auth-User-Name': resolved.user.name,
    'X-Auth-User-Role': resolved.user.role,
  });
});
