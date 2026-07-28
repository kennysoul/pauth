import { Hono } from 'hono';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Env } from '../types';
import { writeAuditLog } from '../lib/audit';
import { getDb, newId, nowIso } from '../lib/db';
import { passkeys } from '../lib/schema';
import {
  validateCompleteLink,
  incrementOpenCount,
  markCompleteLinkUsed,
  activateUser,
} from '../lib/complete';
import { createRegistrationOptions, verifyRegistration } from '../lib/webauthn';

export const completeRoutes = new Hono<{ Bindings: Env }>();

completeRoutes.get('/:token', async (c) => {
  const result = await validateCompleteLink(c.env, c.req.param('token'));
  if ('error' in result) {
    return c.json({ error: '已失效' }, 410);
  }
  await incrementOpenCount(c.env, c.req.param('token'));
  return c.json({
    name: result.user.name,
    role: result.user.role,
    status: result.user.status,
    expiresAt: result.link.expiresAt,
    openCount: result.link.openCount + 1,
    maxOpens: result.link.maxOpens,
  });
});

completeRoutes.post('/:token/passkey/options', async (c) => {
  const result = await validateCompleteLink(c.env, c.req.param('token'));
  if ('error' in result) {
    return c.json({ error: '已失效' }, 410);
  }
  const { options, challengeId } = await createRegistrationOptions(c.env, result.user);
  return c.json({ options, challengeId });
});

completeRoutes.post('/:token/passkey/verify', async (c) => {
  const result = await validateCompleteLink(c.env, c.req.param('token'));
  if ('error' in result) {
    return c.json({ error: '已失效' }, 410);
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
      result.user,
      body.challengeId,
      body.registrationResponse,
    );

    const db = getDb(c.env);
    const passkeyId = newId();
    const ts = nowIso();
    await db.insert(passkeys).values({
      id: passkeyId,
      userId: result.user.id,
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

    const wasPending = result.user.status === 'pending';
    if (wasPending) {
      await activateUser(c.env, result.user.id);
    }
    await markCompleteLinkUsed(c.env, result.link.token);

    await writeAuditLog(c.env, result.user.id, 'COMPLETE_LINK_USED', result.user.id, {
      passkeyId,
      wasPending,
    });
    await writeAuditLog(c.env, result.user.id, 'PASSKEY_REGISTER', result.user.id, {
      passkeyId,
    });

    return c.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Verification failed';
    return c.json({ error: message }, 400);
  }
});