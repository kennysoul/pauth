import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Env } from '../types';
import { writeAuditLog } from '../lib/audit';
import { getDb, newId, nowIso } from '../lib/db';
import {
  deletePasskeyDelegateToken,
  resolvePasskeyDelegateToken,
} from '../lib/passkey-delegate';
import { passkeys } from '../lib/schema';
import { createRegistrationOptions, verifyRegistration } from '../lib/webauthn';

export const passkeyDelegateRoutes = new Hono<{ Bindings: Env }>();

passkeyDelegateRoutes.get('/:token', async (c) => {
  const resolved = await resolvePasskeyDelegateToken(c.env, c.req.param('token'));
  if (!resolved) {
    return c.json({ error: '链接已过期或无效' }, 404);
  }
  return c.json({ name: resolved.user.name, valid: true });
});

passkeyDelegateRoutes.post('/:token/options', async (c) => {
  const resolved = await resolvePasskeyDelegateToken(c.env, c.req.param('token'));
  if (!resolved) {
    return c.json({ error: '链接已过期或无效' }, 401);
  }

  const db = getDb(c.env);
  const existing = await db
    .select({ credentialId: passkeys.credentialId })
    .from(passkeys)
    .where(eq(passkeys.userId, resolved.user.id))
    .all();

  const { options, challengeId } = await createRegistrationOptions(
    c.env,
    resolved.user,
    existing.map((r) => r.credentialId),
  );
  return c.json({ options, challengeId });
});

passkeyDelegateRoutes.post('/:token/verify', async (c) => {
  const token = c.req.param('token');
  const resolved = await resolvePasskeyDelegateToken(c.env, token);
  if (!resolved) {
    return c.json({ error: '链接已过期或无效' }, 401);
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

    await deletePasskeyDelegateToken(c.env, token);
    await writeAuditLog(c.env, resolved.user.id, 'PASSKEY_DELEGATE_REGISTER', resolved.user.id, {
      passkeyId,
    });

    return c.json({ ok: true, message: 'Passkey 添加成功' });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Verification failed';
    return c.json({ error: message }, 400);
  }
});
