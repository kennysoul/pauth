import { Hono } from 'hono';
import { eq, and, ne, sql } from 'drizzle-orm';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { AuthContext, Env } from '../types';
import { writeAuditLog } from '../lib/audit';
import { getDb, newId, nowIso } from '../lib/db';
import { oauthIdentities, passkeys, users } from '../lib/schema';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { createRegistrationOptions, verifyRegistration } from '../lib/webauthn';
import { isValidEmailFormat } from '../lib/oauth-email';
import {
  deleteOAuthIdentityForUser,
  getOAuthIdentityForUser,
} from '../lib/oauth-identities';

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
  const googleLinked = await getOAuthIdentityForUser(c.env, user.id, 'google');
  const msLinked = await getOAuthIdentityForUser(c.env, user.id, 'microsoft');
  if (all.length <= 1 && !googleLinked && !msLinked) {
    return c.json({ error: 'Must keep at least one identity' }, 400);
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

meRoutes.put('/me/email', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ email?: string }>();
  const emailInput = body.email?.trim().toLowerCase();

  if (!emailInput) {
    return c.json({ error: 'email is required' }, 400);
  }

  if (!isValidEmailFormat(emailInput)) {
    return c.json({ error: 'Invalid email format' }, 400);
  }

  const db = getDb(c.env);
  const existing = await db.select().from(users)
    .where(and(eq(users.email, emailInput), ne(users.id, user.id)))
    .get();
  if (existing) {
    return c.json({ error: 'Email already in use' }, 409);
  }

  const ts = nowIso();
  await db.update(users)
    .set({ email: emailInput, updatedAt: ts })
    .where(eq(users.id, user.id));

  await writeAuditLog(c.env, user.id, 'USER_EMAIL_CHANGE', user.id, {
    from: user.email,
    to: emailInput,
  });

  return c.json({ ok: true });
});

meRoutes.put('/me/name', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ name?: string }>();
  const nameInput = body.name?.trim();

  if (!nameInput) {
    return c.json({ error: 'name is required' }, 400);
  }

  const db = getDb(c.env);
  const ts = nowIso();
  await db.update(users).set({ name: nameInput, updatedAt: ts }).where(eq(users.id, user.id));
  await writeAuditLog(c.env, user.id, 'USER_NAME_CHANGE', user.id, {
    from: user.name,
    to: nameInput,
  });
  return c.json({ ok: true });
});

meRoutes.get('/me/oauth', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env);
  const googleLinked = await getOAuthIdentityForUser(c.env, user.id, 'google');
  const msLinked = await getOAuthIdentityForUser(c.env, user.id, 'microsoft');
  const pkCount = await db.select().from(passkeys).where(eq(passkeys.userId, user.id)).all();
  return c.json({
    googleLinked: Boolean(googleLinked),
    googleEmail: googleLinked?.email || '',
    googleCanUnlink: Boolean(googleLinked) && (pkCount.length > 0 || Boolean(msLinked)),
    microsoftLinked: Boolean(msLinked),
    microsoftEmail: msLinked?.email || '',
    microsoftCanUnlink: Boolean(msLinked) && (pkCount.length > 0 || Boolean(googleLinked)),
    passkeyCount: pkCount.length,
  });
});

meRoutes.delete('/me/oauth/google-link', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env);
  const pkCount = await db.select().from(passkeys).where(eq(passkeys.userId, user.id)).all();
  const msLinked = await getOAuthIdentityForUser(c.env, user.id, 'microsoft');
  if (pkCount.length === 0 && !msLinked) {
    return c.json({ error: '唯一验证身份，不可解绑' }, 400);
  }
  await deleteOAuthIdentityForUser(c.env, user.id, 'google');
  await writeAuditLog(c.env, user.id, 'OAUTH_UNLINK', user.id, { provider: 'google' });
  return c.json({ ok: true });
});

meRoutes.delete('/me/oauth/microsoft-link', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env);
  const pkCount = await db.select().from(passkeys).where(eq(passkeys.userId, user.id)).all();
  const googleLinked = await getOAuthIdentityForUser(c.env, user.id, 'google');
  if (pkCount.length === 0 && !googleLinked) {
    return c.json({ error: '唯一验证身份，不可解绑' }, 400);
  }
  await deleteOAuthIdentityForUser(c.env, user.id, 'microsoft');
  await writeAuditLog(c.env, user.id, 'OAUTH_UNLINK', user.id, { provider: 'microsoft' });
  return c.json({ ok: true });
});
