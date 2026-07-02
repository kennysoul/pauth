import { Hono } from 'hono';
import { eq, and, gt, isNull } from 'drizzle-orm';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Env } from '../types';
import { writeAuditLog } from '../lib/audit';
import { getDb, newId, nowIso } from '../lib/db';
import { invites, passkeys, users } from '../lib/schema';
import {
  appendCookies,
  clearCookie,
  createSession,
  deleteSession,
  resolveRegisterSession,
} from '../lib/session';
import { createRegistrationOptions, verifyRegistration } from '../lib/webauthn';

export const inviteRoutes = new Hono<{ Bindings: Env }>();

async function resolveInvite(env: Env, token: string) {
  const db = getDb(env);
  const now = nowIso();
  const row = await db
    .select()
    .from(invites)
    .where(and(eq(invites.token, token), gt(invites.expiresAt, now), isNull(invites.usedAt)))
    .get();
  if (!row) return null;

  const user = await db.select().from(users).where(eq(users.id, row.userId)).get();
  if (!user || user.status === 'disabled') return null;

  return { invite: row, user };
}

inviteRoutes.get('/:token', async (c) => {
  const resolved = await resolveInvite(c.env, c.req.param('token'));
  if (!resolved) {
    return c.json({ error: 'Invite invalid or expired' }, 404);
  }
  return c.json({
    name: resolved.user.name,
    role: resolved.user.role,
  });
});

inviteRoutes.post('/:token/begin', async (c) => {
  const resolved = await resolveInvite(c.env, c.req.param('token'));
  if (!resolved) {
    return c.json({ error: 'Invite invalid or expired' }, 404);
  }

  const { setCookie } = await createSession(c.env, resolved.user.id, 'register');
  appendCookies(c, setCookie);
  return c.json({ ok: true });
});

inviteRoutes.post('/:token/passkey/options', async (c) => {
  const resolved = await resolveRegisterSession(c);
  if (!resolved) {
    return c.json({ error: 'Registration session required' }, 401);
  }

  const token = c.req.param('token');
  const invite = await resolveInvite(c.env, token);
  if (!invite || invite.user.id !== resolved.user.id) {
    return c.json({ error: 'Invite mismatch' }, 403);
  }

  const { options, challengeId } = await createRegistrationOptions(c.env, resolved.user);
  return c.json({ options, challengeId });
});

inviteRoutes.post('/:token/passkey/verify', async (c) => {
  const resolved = await resolveRegisterSession(c);
  if (!resolved) {
    return c.json({ error: 'Registration session required' }, 401);
  }

  const token = c.req.param('token');
  const inviteRow = await resolveInvite(c.env, token);
  if (!inviteRow || inviteRow.user.id !== resolved.user.id) {
    return c.json({ error: 'Invite mismatch' }, 403);
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

    await db
      .update(users)
      .set({ status: 'active', updatedAt: ts })
      .where(eq(users.id, resolved.user.id));

    await db
      .update(invites)
      .set({ usedAt: ts })
      .where(eq(invites.id, inviteRow.invite.id));

    await deleteSession(c.env, resolved.session.id);
    appendCookies(c, clearCookie(c.env, 'reg_sid', '/api'));

    await writeAuditLog(c.env, resolved.user.id, 'INVITE_COMPLETE', resolved.user.id, {
      passkeyId,
      inviteId: inviteRow.invite.id,
    });
    await writeAuditLog(c.env, resolved.user.id, 'PASSKEY_REGISTER', resolved.user.id, {
      passkeyId,
    });

    return c.json({
      ok: true,
      message: '注册成功，你现在可以使用 Passkey 登录。',
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Verification failed';
    return c.json({ error: message }, 400);
  }
});
