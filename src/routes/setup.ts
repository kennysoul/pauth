import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Env } from '../types';
import { writeAuditLog } from '../lib/audit';
import { getDb, newId, nowIso } from '../lib/db';
import { passkeys, systemConfig, users } from '../lib/schema';
import {
  appendCookies,
  clearCookie,
  createSession,
  deleteSession,
  deleteUserSessions,
  resolveSetupSession,
} from '../lib/session';
import { createRegistrationOptions, verifyRegistration } from '../lib/webauthn';

export const setupRoutes = new Hono<{ Bindings: Env }>();

setupRoutes.post('/begin', async (c) => {
  const db = getDb(c.env);
  const config = await db.select().from(systemConfig).where(eq(systemConfig.id, 1)).get();
  if (config?.state !== 'NEEDS_SETUP') {
    return c.json({ error: '系统已初始化' }, 409);
  }

  const body = await c.req.json<{ name?: string }>();
  const name = body.name?.trim();
  if (!name) {
    return c.json({ error: '名字不能为空' }, 400);
  }

  const admins = await db.select().from(users).where(eq(users.role, 'admin')).all();

  for (const admin of admins) {
    const pkCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(passkeys)
      .where(eq(passkeys.userId, admin.id))
      .get();
    if (pkCount && pkCount.count > 0) {
      return c.json({ error: '系统已初始化' }, 409);
    }
  }

  let userId: string;
  let resumed = false;

  if (admins.length > 0) {
    // 上次未完成 Passkey 注册（如中断或 API 测试）— 继续初始化
    userId = admins[0]!.id;
    resumed = true;
    const ts = nowIso();
    await db.update(users).set({ name, updatedAt: ts }).where(eq(users.id, userId));
    for (let i = 1; i < admins.length; i++) {
      await db.delete(users).where(eq(users.id, admins[i]!.id));
    }
  } else {
    userId = newId();
    const ts = nowIso();
    await db.insert(users).values({
      id: userId,
      email: 'admin@system.internal',
      name,
      role: 'admin',
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    });
    await writeAuditLog(c.env, null, 'SETUP_BEGIN', userId, { name });
  }

  await deleteUserSessions(c.env, userId);

  const { setCookie } = await createSession(c.env, userId, 'setup');
  appendCookies(c, setCookie);

  if (resumed) {
    await writeAuditLog(c.env, userId, 'SETUP_BEGIN', userId, { name, resumed: true });
  }

  return c.json({ ok: true, userId, resumed });
});

setupRoutes.post('/passkey/options', async (c) => {
  const db = getDb(c.env);
  const config = await db.select().from(systemConfig).where(eq(systemConfig.id, 1)).get();
  if (config?.state !== 'NEEDS_SETUP') {
    return c.json({ error: 'Setup not allowed' }, 403);
  }

  const resolved = await resolveSetupSession(c);
  if (!resolved) {
    return c.json({ error: 'Setup session required' }, 401);
  }

  const { options, challengeId } = await createRegistrationOptions(c.env, resolved.user);
  return c.json({ options, challengeId });
});

setupRoutes.post('/passkey/verify', async (c) => {
  const db = getDb(c.env);
  const config = await db.select().from(systemConfig).where(eq(systemConfig.id, 1)).get();
  if (config?.state !== 'NEEDS_SETUP') {
    return c.json({ error: 'Setup not allowed' }, 403);
  }

  const resolved = await resolveSetupSession(c);
  if (!resolved) {
    return c.json({ error: 'Setup session required' }, 401);
  }

  const body = await c.req.json<{
    challengeId?: string;
    registrationResponse?: RegistrationResponseJSON;
  }>();
  if (!body.challengeId || !body.registrationResponse) {
    return c.json({ error: 'Invalid payload' }, 400);
  }

  try {
    const cred = await verifyRegistration(
      c.env,
      resolved.user,
      body.challengeId,
      body.registrationResponse,
    );

    const passkeyId = newId();
    const ts = nowIso();
    await db.insert(passkeys).values({
      id: passkeyId,
      userId: resolved.user.id,
      credentialId: cred.credentialId,
      publicKey: cred.publicKey,
      counter: cred.counter,
      deviceType: cred.deviceType,
      backedUp: cred.backedUp ? 1 : 0,
      transports: JSON.stringify(cred.transports),
      aaguid: cred.aaguid,
      createdAt: ts,
      lastUsedAt: null,
    });

    await db
      .update(systemConfig)
      .set({ state: 'ACTIVE', updatedAt: ts })
      .where(eq(systemConfig.id, 1));

    await deleteSession(c.env, resolved.session.id);

    const { setCookie } = await createSession(c.env, resolved.user.id, 'normal');
    appendCookies(
      c,
      setCookie,
      clearCookie(c.env, 'setup_sid', '/api/setup'),
    );

    await writeAuditLog(c.env, resolved.user.id, 'SETUP_COMPLETE', resolved.user.id, null);
    await writeAuditLog(c.env, resolved.user.id, 'PASSKEY_REGISTER', resolved.user.id, {
      passkeyId,
    });

    return c.json({ ok: true, redirect: '/admin' });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Verification failed';
    return c.json({ error: message }, 400);
  }
});
