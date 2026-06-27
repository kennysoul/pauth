import { Hono } from 'hono';
import { eq, and, sql } from 'drizzle-orm';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { AuthContext, Env } from '../types';
import { writeAuditLog } from '../lib/audit';
import { getDb, newId, nowIso } from '../lib/db';
import { passkeys } from '../lib/schema';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { createRegistrationOptions, verifyRegistration } from '../lib/webauthn';

export const meRoutes = new Hono<{ Bindings: Env; Variables: AuthContext }>();

meRoutes.use('*', requireAuth);

meRoutes.get('/me', (c) => {
  const user = c.get('user');
  return c.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
  });
});

meRoutes.get('/me/passkeys', async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({
      id: passkeys.id,
      credentialId: passkeys.credentialId,
      deviceType: passkeys.deviceType,
      backedUp: passkeys.backedUp,
      createdAt: passkeys.createdAt,
      lastUsedAt: passkeys.lastUsedAt,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, c.get('user').id))
    .all();
  return c.json(rows);
});

meRoutes.post('/me/passkeys/options', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env);
  const existing = await db
    .select({ credentialId: passkeys.credentialId })
    .from(passkeys)
    .where(eq(passkeys.userId, user.id))
    .all();
  const { options, challengeId } = await createRegistrationOptions(
    c.env,
    user,
    existing.map((r) => r.credentialId),
  );
  return c.json({ options, challengeId });
});

meRoutes.post('/me/passkeys/verify', async (c) => {
  const user = c.get('user');
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
      user,
      body.challengeId,
      body.registrationResponse,
    );
    const db = getDb(c.env);
    const passkeyId = newId();
    const ts = nowIso();
    await db.insert(passkeys).values({
      id: passkeyId,
      userId: user.id,
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
    await writeAuditLog(c.env, user.id, 'PASSKEY_REGISTER', user.id, { passkeyId });
    return c.json({ ok: true, id: passkeyId });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Verification failed';
    return c.json({ error: message }, 400);
  }
});

meRoutes.delete('/me/passkeys/:id', async (c) => {
  const user = c.get('user');
  const pkId = c.req.param('id');
  const db = getDb(c.env);

  const all = await db.select().from(passkeys).where(eq(passkeys.userId, user.id)).all();
  if (all.length <= 1) {
    return c.json({ error: 'Must keep at least one passkey' }, 400);
  }

  const pk = await db
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.id, pkId), eq(passkeys.userId, user.id)))
    .get();
  if (!pk) {
    return c.json({ error: 'Passkey not found' }, 404);
  }

  await db.delete(passkeys).where(eq(passkeys.id, pkId));
  await writeAuditLog(c.env, user.id, 'PASSKEY_DELETE', user.id, { passkeyId: pkId });
  return c.json({ ok: true });
});
