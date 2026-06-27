import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
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
  resolveRegisterSession,
} from '../lib/session';
import { createRegistrationOptions, verifyRegistration } from '../lib/webauthn';

export const registerRoutes = new Hono<{ Bindings: Env }>();

registerRoutes.use('*', async (c, next) => {
  const db = getDb(c.env);
  const config = await db.select().from(systemConfig).where(eq(systemConfig.id, 1)).get();
  if (config?.state !== 'ACTIVE') {
    return c.json({ error: 'System not ready' }, 503);
  }
  if (!config.registrationEnabled) {
    return c.json({ error: 'Registration is closed' }, 403);
  }
  return next();
});

registerRoutes.post('/begin', async (c) => {
  const body = await c.req.json<{ name?: string; email?: string }>();
  const name = body.name?.trim();
  const email = body.email?.trim().toLowerCase();
  if (!name || !email) {
    return c.json({ error: 'Name and email are required' }, 400);
  }

  const db = getDb(c.env);
  const existing = await db.select().from(users).where(eq(users.email, email)).get();
  if (existing) {
    return c.json({ error: 'Email already registered' }, 409);
  }

  const userId = newId();
  const ts = nowIso();
  await db.insert(users).values({
    id: userId,
    email,
    name,
    role: 'user',
    status: 'pending',
    createdAt: ts,
    updatedAt: ts,
  });

  const { setCookie } = await createSession(c.env, userId, 'register');
  appendCookies(c, setCookie);
  await writeAuditLog(c.env, userId, 'USER_REGISTER', userId, { email, name });

  return c.json({ ok: true, userId });
});

registerRoutes.post('/passkey/options', async (c) => {
  const resolved = await resolveRegisterSession(c);
  if (!resolved) {
    return c.json({ error: 'Registration session required' }, 401);
  }

  const { options, challengeId } = await createRegistrationOptions(c.env, resolved.user);
  return c.json({ options, challengeId });
});

registerRoutes.post('/passkey/verify', async (c) => {
  const resolved = await resolveRegisterSession(c);
  if (!resolved) {
    return c.json({ error: 'Registration session required' }, 401);
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

    const db = getDb(c.env);
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

    await deleteSession(c.env, resolved.session.id);
    appendCookies(c, clearCookie(c.env, 'reg_sid', '/api/register'));

    await writeAuditLog(c.env, resolved.user.id, 'PASSKEY_REGISTER', resolved.user.id, {
      passkeyId,
    });

    return c.json({
      ok: true,
      status: 'pending',
      message: '注册成功，等待管理员审批后即可登录',
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Verification failed';
    return c.json({ error: message }, 400);
  }
});
