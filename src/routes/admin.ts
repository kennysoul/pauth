import { Hono } from 'hono';
import { eq, and, sql, desc } from 'drizzle-orm';
import type { AuthContext, Env } from '../types';
import { writeAuditLog } from '../lib/audit';
import { getDb, nowIso } from '../lib/db';
import { auditLogs, passkeys, sessions, systemConfig, users } from '../lib/schema';
import { requireAdmin } from '../middleware/auth';
import { appendCookies, clearCookie, deleteUserSessions } from '../lib/session';

export const adminRoutes = new Hono<{ Bindings: Env; Variables: AuthContext }>();

adminRoutes.use('*', requireAdmin);

adminRoutes.get('/config', async (c) => {
  const db = getDb(c.env);
  const config = await db.select().from(systemConfig).where(eq(systemConfig.id, 1)).get();
  return c.json({
    state: config?.state,
    registrationEnabled: Boolean(config?.registrationEnabled),
  });
});

adminRoutes.patch('/config', async (c) => {
  const body = await c.req.json<{ registrationEnabled?: boolean }>();
  if (typeof body.registrationEnabled !== 'boolean') {
    return c.json({ error: 'registrationEnabled required' }, 400);
  }

  const db = getDb(c.env);
  const ts = nowIso();
  await db
    .update(systemConfig)
    .set({ registrationEnabled: body.registrationEnabled ? 1 : 0, updatedAt: ts })
    .where(eq(systemConfig.id, 1));

  await writeAuditLog(c.env, c.get('user').id, 'CONFIG_UPDATE', null, {
    registrationEnabled: body.registrationEnabled,
  });

  return c.json({ ok: true });
});

adminRoutes.get('/users', async (c) => {
  const status = c.req.query('status');
  const db = getDb(c.env);

  const userRows =
    status && status !== 'all'
      ? await db.select().from(users).where(eq(users.status, status)).all()
      : await db.select().from(users).all();

  const pkCounts = await db
    .select({
      userId: passkeys.userId,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(passkeys)
    .groupBy(passkeys.userId)
    .all();

  const countMap = new Map(pkCounts.map((r) => [r.userId, r.count]));

  return c.json(
    userRows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt,
      passkeyCount: countMap.get(u.id) ?? 0,
    })),
  );
});

adminRoutes.patch('/users/:id', async (c) => {
  const targetId = c.req.param('id');
  const body = await c.req.json<{ status?: 'active' | 'disabled' }>();
  if (body.status !== 'active' && body.status !== 'disabled') {
    return c.json({ error: 'Invalid status' }, 400);
  }

  const actor = c.get('user');
  const db = getDb(c.env);
  const target = await db.select().from(users).where(eq(users.id, targetId)).get();
  if (!target) {
    return c.json({ error: 'User not found' }, 404);
  }

  if (body.status === 'disabled') {
    if (targetId === actor.id) {
      return c.json({ error: 'Cannot disable yourself' }, 400);
    }
    if (target.role === 'admin') {
      const admins = await db
        .select({ count: sql<number>`count(*)` })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
        .get();
      if (target.status === 'active' && admins && admins.count <= 1) {
        return c.json({ error: 'Cannot disable the last active admin' }, 400);
      }
    }
  }

  if (body.status === 'active' && target.status !== 'pending' && target.status !== 'disabled') {
    return c.json({ error: 'Invalid state transition' }, 400);
  }

  const ts = nowIso();
  await db
    .update(users)
    .set({ status: body.status, updatedAt: ts })
    .where(eq(users.id, targetId));

  if (body.status === 'disabled') {
    await deleteUserSessions(c.env, targetId);
  }

  const action = body.status === 'active' ? 'USER_APPROVE' : 'USER_DISABLE';
  await writeAuditLog(c.env, actor.id, action, targetId, { email: target.email });

  return c.json({ ok: true });
});

adminRoutes.delete('/users/:id', async (c) => {
  const targetId = c.req.param('id');
  const actor = c.get('user');
  const db = getDb(c.env);
  const target = await db.select().from(users).where(eq(users.id, targetId)).get();
  if (!target) {
    return c.json({ error: 'User not found' }, 404);
  }
  if (target.status !== 'pending') {
    return c.json({ error: 'Can only delete pending users' }, 400);
  }

  await db.delete(users).where(eq(users.id, targetId));
  await writeAuditLog(c.env, actor.id, 'USER_REJECT', targetId, { email: target.email });
  return c.json({ ok: true });
});

adminRoutes.delete('/users/:id/passkeys/:pkId', async (c) => {
  const { id: userId, pkId } = c.req.param();
  const actor = c.get('user');
  const db = getDb(c.env);

  const pk = await db
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.id, pkId), eq(passkeys.userId, userId)))
    .get();
  if (!pk) {
    return c.json({ error: 'Passkey not found' }, 404);
  }

  await db.delete(passkeys).where(eq(passkeys.id, pkId));
  await writeAuditLog(c.env, actor.id, 'PASSKEY_DELETE', userId, { passkeyId: pkId });
  return c.json({ ok: true });
});

adminRoutes.get('/audit-logs', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .all();
  return c.json(rows);
});

adminRoutes.post('/system/reset', async (c) => {
  const body = await c.req.json<{ confirmation?: string }>();
  if (body.confirmation !== 'RESET_ALL_I_UNDERSTAND') {
    return c.json({ error: 'Confirmation required' }, 400);
  }

  const actor = c.get('user');
  const db = getDb(c.env);

  await writeAuditLog(c.env, actor.id, 'SYSTEM_RESET', null, {
    resetBy: actor.email,
    resetAt: nowIso(),
  });

  await db.delete(sessions);
  await db.delete(passkeys);
  await db.delete(users);
  await db.delete(auditLogs);

  await db
    .update(systemConfig)
    .set({
      state: 'NEEDS_SETUP',
      registrationEnabled: 0,
      updatedAt: nowIso(),
    })
    .where(eq(systemConfig.id, 1));

  appendCookies(
    c,
    clearCookie(c.env, 'sid', '/'),
    clearCookie(c.env, 'setup_sid', '/api/setup'),
    clearCookie(c.env, 'reg_sid', '/api/register'),
  );

  return c.json({ ok: true, message: 'System reset' });
});
