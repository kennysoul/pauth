import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Env } from '../types';
import { writeAuditLog } from '../lib/audit';
import { getDb, nowIso } from '../lib/db';
import { passkeys, users } from '../lib/schema';
import { sanitizeReturnTo } from '../lib/return-to';
import { appendCookies, createSession, deleteSession, resolveNormalSession, clearCookie } from '../lib/session';
import { createAuthenticationOptions, verifyAuthentication } from '../lib/webauthn';

export const loginRoutes = new Hono<{ Bindings: Env }>();

loginRoutes.post('/options', async (c) => {
  const { options, challengeId } = await createAuthenticationOptions(c.env);
  return c.json({ options, challengeId });
});

loginRoutes.post('/verify', async (c) => {
  const body = await c.req.json<{
    challengeId?: string;
    authenticationResponse?: AuthenticationResponseJSON;
    returnTo?: string | null;
  }>();

  if (!body.challengeId || !body.authenticationResponse) {
    return c.json({ error: 'Invalid payload' }, 400);
  }

  try {
    const result = await verifyAuthentication(
      c.env,
      body.challengeId,
      body.authenticationResponse,
    );

    const db = getDb(c.env);
    const user = await db.select().from(users).where(eq(users.id, result.userId)).get();
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }
    if (user.status === 'pending') {
      return c.json({ error: '账号待审批，请等待管理员确认' }, 403);
    }
    if (user.status === 'disabled') {
      return c.json({ error: '账号已被禁用' }, 403);
    }

    const ts = nowIso();
    await db
      .update(passkeys)
      .set({ counter: result.newCounter, lastUsedAt: ts })
      .where(eq(passkeys.id, result.passkeyId));

    const { setCookie } = await createSession(c.env, user.id, 'normal');
    appendCookies(c, setCookie);
    await writeAuditLog(c.env, user.id, 'LOGIN', user.id, null);

    const returnTo = sanitizeReturnTo(body.returnTo, c.env);
    if (returnTo) {
      return c.redirect(returnTo, 302);
    }
    return c.json({ ok: true, redirect: user.role === 'admin' ? '/admin' : '/login' });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Authentication failed';
    return c.json({ error: message }, 400);
  }
});

loginRoutes.post('/logout', async (c) => {
  const resolved = await resolveNormalSession(c);
  if (resolved) {
    await deleteSession(c.env, resolved.session.id);
    await writeAuditLog(c.env, resolved.user.id, 'LOGOUT', resolved.user.id, null);
  }
  appendCookies(c, clearCookie(c.env, 'sid', '/'));
  return c.json({ ok: true });
});
