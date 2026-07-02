import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AuthContext, Env } from '../types';
import { writeAuditLog } from '../lib/audit';
import { getDb } from '../lib/db';
import { isValidEmailFormat, normalizeOAuthEmail } from '../lib/oauth-email';
import {
  deleteOAuthIdentityForUser,
  getOAuthIdentityForUser,
  setUserAllowedEmail,
} from '../lib/oauth-identities';
import {
  getGoogleOAuthConfig,
  getMicrosoftOAuthConfig,
  googleRedirectUri,
  microsoftRedirectUri,
  normalizeMicrosoftTenantId,
} from '../lib/oauth-config';
import {
  setSetting,
  GOOGLE_KEYS,
  GOOGLE_DEFAULT_SCOPES,
  MICROSOFT_KEYS,
  MICROSOFT_DEFAULT_SCOPES,
} from '../lib/oauth-settings';
import { passkeys, users } from '../lib/schema';

export function registerAdminOAuthRoutes(adminRoutes: Hono<{ Bindings: Env; Variables: AuthContext }>) {
  adminRoutes.get('/integration/webauth', async (c) => {
    return c.json({
      rpId: c.env.RP_ID,
      rpName: c.env.RP_NAME,
      origin: c.env.ORIGIN,
      cookieDomain: c.env.COOKIE_DOMAIN,
      authHost: c.env.AUTH_HOST,
      source: 'wrangler',
    });
  });

  adminRoutes.get('/integration/google', async (c) => {
    const conf = await getGoogleOAuthConfig(c.env);
    return c.json({
      clientId: conf.clientId,
      redirectUri: conf.redirectUri || googleRedirectUri(c.env, conf),
      scopes: conf.scopes || GOOGLE_DEFAULT_SCOPES,
      clientSecretSet: Boolean(conf.clientSecret),
      enabled: conf.enabled,
    });
  });

  adminRoutes.post('/integration/google', async (c) => {
    const body = await c.req.json<{
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
      scopes?: string;
    }>();
    await setSetting(c.env, GOOGLE_KEYS.clientId, String(body.clientId || '').trim());
    await setSetting(c.env, GOOGLE_KEYS.redirectUri, String(body.redirectUri || '').trim());
    await setSetting(
      c.env,
      GOOGLE_KEYS.scopes,
      String(body.scopes || '').trim() || GOOGLE_DEFAULT_SCOPES,
    );
    const secret = String(body.clientSecret || '').trim();
    if (secret) {
      await setSetting(c.env, GOOGLE_KEYS.clientSecret, secret);
    }
    await writeAuditLog(c.env, c.get('user').id, 'OAUTH_CONFIG_GOOGLE', null, {});
    const conf = await getGoogleOAuthConfig(c.env);
    return c.json({
      ok: true,
      clientId: conf.clientId,
      redirectUri: conf.redirectUri || googleRedirectUri(c.env, conf),
      scopes: conf.scopes,
      clientSecretSet: Boolean(conf.clientSecret),
      enabled: conf.enabled,
    });
  });

  adminRoutes.get('/integration/microsoft', async (c) => {
    const conf = await getMicrosoftOAuthConfig(c.env);
    return c.json({
      tenantId: conf.tenantId,
      clientId: conf.clientId,
      redirectUri: conf.redirectUri || microsoftRedirectUri(c.env, conf),
      scopes: conf.scopes || MICROSOFT_DEFAULT_SCOPES,
      clientSecretSet: Boolean(conf.clientSecret),
      enabled: conf.enabled,
    });
  });

  adminRoutes.post('/integration/microsoft', async (c) => {
    const body = await c.req.json<{
      tenantId?: string;
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
      scopes?: string;
    }>();
    await setSetting(
      c.env,
      MICROSOFT_KEYS.tenantId,
      normalizeMicrosoftTenantId(body.tenantId),
    );
    await setSetting(c.env, MICROSOFT_KEYS.clientId, String(body.clientId || '').trim());
    await setSetting(c.env, MICROSOFT_KEYS.redirectUri, String(body.redirectUri || '').trim());
    await setSetting(
      c.env,
      MICROSOFT_KEYS.scopes,
      String(body.scopes || '').trim() || MICROSOFT_DEFAULT_SCOPES,
    );
    const secret = String(body.clientSecret || '').trim();
    if (secret) {
      await setSetting(c.env, MICROSOFT_KEYS.clientSecret, secret);
    }
    await writeAuditLog(c.env, c.get('user').id, 'OAUTH_CONFIG_MICROSOFT', null, {});
    const conf = await getMicrosoftOAuthConfig(c.env);
    return c.json({
      ok: true,
      tenantId: conf.tenantId,
      clientId: conf.clientId,
      redirectUri: conf.redirectUri || microsoftRedirectUri(c.env, conf),
      scopes: conf.scopes,
      clientSecretSet: Boolean(conf.clientSecret),
      enabled: conf.enabled,
    });
  });

  adminRoutes.post('/users/:id/google-allow-email', async (c) => {
    const targetId = c.req.param('id');
    const body = await c.req.json<{ email?: string }>();
    const email = normalizeOAuthEmail(body.email || '');
    if (email && !isValidEmailFormat(email)) {
      return c.json({ error: '邮箱格式无效' }, 400);
    }
    const db = getDb(c.env);
    const target = await db.select().from(users).where(eq(users.id, targetId)).get();
    if (!target) return c.json({ error: 'User not found' }, 404);
    try {
      await setUserAllowedEmail(c.env, targetId, 'google', email);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'Failed' }, 400);
    }
    return c.json({ ok: true, allowedGoogleEmail: email });
  });

  adminRoutes.post('/users/:id/microsoft-allow-email', async (c) => {
    const targetId = c.req.param('id');
    const body = await c.req.json<{ email?: string }>();
    const email = normalizeOAuthEmail(body.email || '');
    if (email && !isValidEmailFormat(email)) {
      return c.json({ error: '邮箱格式无效' }, 400);
    }
    const db = getDb(c.env);
    const target = await db.select().from(users).where(eq(users.id, targetId)).get();
    if (!target) return c.json({ error: 'User not found' }, 404);
    try {
      await setUserAllowedEmail(c.env, targetId, 'microsoft', email);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'Failed' }, 400);
    }
    return c.json({ ok: true, allowedMicrosoftEmail: email });
  });

  adminRoutes.delete('/users/:id/google-link', async (c) => {
    const targetId = c.req.param('id');
    const db = getDb(c.env);
    const target = await db.select().from(users).where(eq(users.id, targetId)).get();
    if (!target) return c.json({ error: 'User not found' }, 404);

    const linked = await getOAuthIdentityForUser(c.env, targetId, 'google');
    if (!linked) return c.json({ ok: true });

    const pks = await db.select().from(passkeys).where(eq(passkeys.userId, targetId)).all();
    if (pks.length === 0) {
      return c.json({ error: '该账号仅绑定了 Google 登录，请先添加 Passkey 再解绑' }, 400);
    }

    await deleteOAuthIdentityForUser(c.env, targetId, 'google');
    await writeAuditLog(c.env, c.get('user').id, 'OAUTH_UNLINK', targetId, { provider: 'google' });
    return c.json({ ok: true });
  });

  adminRoutes.delete('/users/:id/microsoft-link', async (c) => {
    const targetId = c.req.param('id');
    const db = getDb(c.env);
    const target = await db.select().from(users).where(eq(users.id, targetId)).get();
    if (!target) return c.json({ error: 'User not found' }, 404);

    const linked = await getOAuthIdentityForUser(c.env, targetId, 'microsoft');
    if (!linked) return c.json({ ok: true });

    const pks = await db.select().from(passkeys).where(eq(passkeys.userId, targetId)).all();
    if (pks.length === 0) {
      return c.json({ error: '该账号仅绑定了 Microsoft 登录，请先添加 Passkey 再解绑' }, 400);
    }

    await deleteOAuthIdentityForUser(c.env, targetId, 'microsoft');
    await writeAuditLog(c.env, c.get('user').id, 'OAUTH_UNLINK', targetId, { provider: 'microsoft' });
    return c.json({ ok: true });
  });
}
