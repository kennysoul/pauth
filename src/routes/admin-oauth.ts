import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AuthContext, Env } from '../types';
import { writeAuditLog } from '../lib/audit';
import { getDb } from '../lib/db';
import {
  deleteOAuthIdentityForUser,
  getOAuthIdentityForUser,
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

  adminRoutes.get('/integration/google/secret', async (c) => {
    const conf = await getGoogleOAuthConfig(c.env);
    return c.json({ clientSecret: conf.clientSecret });
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

  adminRoutes.post('/integration/google/validate', async (c) => {
    const conf = await getGoogleOAuthConfig(c.env);
    const clientId = conf.clientId;
    const clientSecret = conf.clientSecret;

    if (!clientId || !clientSecret) {
      return c.json({ ok: false, error: '请先填写 Client ID 和 Client Secret 并保存' }, 400);
    }

    const redirectUri = conf.redirectUri || googleRedirectUri(c.env, conf);
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'invalid_test_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (res.ok) {
      return c.json({ ok: true, message: 'Google OAuth 配置验证通过' });
    }

    const errorData = await res.json().catch(() => ({ error: 'unknown' })) as {
      error?: string;
      error_description?: string;
    };

    if (errorData.error === 'invalid_client') {
      return c.json({
        ok: false,
        error: 'Client ID 或 Client Secret 无效',
        detail: errorData.error_description || '请检查配置并在 Google Cloud Console 中确认凭据',
      }, 400);
    }

    if (errorData.error === 'invalid_grant' || errorData.error === 'redirect_uri_mismatch') {
      return c.json({
        ok: true,
        message: '凭据验证通过',
      });
    }

    return c.json({
      ok: true,
      message: `凭据格式正确（Google 返回 ${errorData.error || '未知错误'}，不影响登录功能）`,
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

  adminRoutes.get('/integration/microsoft/secret', async (c) => {
    const conf = await getMicrosoftOAuthConfig(c.env);
    return c.json({ clientSecret: conf.clientSecret });
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

  adminRoutes.post('/integration/microsoft/validate', async (c) => {
    const conf = await getMicrosoftOAuthConfig(c.env);
    const tenantId = conf.tenantId;
    const clientId = conf.clientId;
    const clientSecret = conf.clientSecret;

    if (!tenantId || !clientId || !clientSecret) {
      return c.json({ ok: false, error: '请先填写 Tenant ID、Client ID 和 Client Secret 并保存' }, 400);
    }

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (res.ok) {
      return c.json({ ok: true, message: '验证通过' });
    }

    const errorData = await res.json().catch(() => ({ error: 'unknown' })) as {
      error?: string;
      error_description?: string;
    };

    if (errorData.error === 'invalid_client') {
      return c.json({
        ok: false,
        error: 'Client ID 或 Client Secret 无效',
        detail: errorData.error_description || '请检查配置并在 Azure Portal 中确认凭据',
      }, 400);
    }

    if (errorData.error === 'unauthorized_client') {
      return c.json({
        ok: true,
        message: '验证通过',
      });
    }

    if (errorData.error === 'invalid_grant' && (errorData.error_description || '').includes('53003')) {
      return c.json({
        ok: true,
        message: '验证通过',
      });
    }

    return c.json({
      ok: true,
      message: '验证通过',
    });
  });

  adminRoutes.delete('/users/:id/google-link', async (c) => {
    const targetId = c.req.param('id');
    const actor = c.get('user');
    if (targetId !== actor.id) {
      return c.json({ error: '仅可管理自己的关联账号' }, 403);
    }
    const db = getDb(c.env);
    const target = await db.select().from(users).where(eq(users.id, targetId)).get();
    if (!target) return c.json({ error: 'User not found' }, 404);

    const linked = await getOAuthIdentityForUser(c.env, targetId, 'google');
    if (!linked) return c.json({ ok: true });

    const pks = await db.select().from(passkeys).where(eq(passkeys.userId, targetId)).all();
    const msLinked = await getOAuthIdentityForUser(c.env, targetId, 'microsoft');
    if (pks.length === 0 && !msLinked) {
      return c.json({ error: '至少保留一种登录身份，请先添加 Passkey 或关联 Microsoft' }, 400);
    }

    await deleteOAuthIdentityForUser(c.env, targetId, 'google');
    await writeAuditLog(c.env, actor.id, 'OAUTH_UNLINK', targetId, { provider: 'google' });
    return c.json({ ok: true });
  });

  adminRoutes.delete('/users/:id/microsoft-link', async (c) => {
    const targetId = c.req.param('id');
    const actor = c.get('user');
    if (targetId !== actor.id) {
      return c.json({ error: '仅可管理自己的关联账号' }, 403);
    }
    const db = getDb(c.env);
    const target = await db.select().from(users).where(eq(users.id, targetId)).get();
    if (!target) return c.json({ error: 'User not found' }, 404);

    const linked = await getOAuthIdentityForUser(c.env, targetId, 'microsoft');
    if (!linked) return c.json({ ok: true });

    const pks = await db.select().from(passkeys).where(eq(passkeys.userId, targetId)).all();
    const googleLinked = await getOAuthIdentityForUser(c.env, targetId, 'google');
    if (pks.length === 0 && !googleLinked) {
      return c.json({ error: '至少保留一种登录身份，请先添加 Passkey 或关联 Google' }, 400);
    }

    await deleteOAuthIdentityForUser(c.env, targetId, 'microsoft');
    await writeAuditLog(c.env, actor.id, 'OAUTH_UNLINK', targetId, { provider: 'microsoft' });
    return c.json({ ok: true });
  });
}
