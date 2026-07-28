import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import type { AuthContext, Env, User } from '../types';
import { writeAuditLog } from '../lib/audit';
import { appendQuery } from '../lib/crypto';
import { getDb } from '../lib/db';
import { normalizeOAuthEmail } from '../lib/oauth-email';
import {
  bindOAuthIdentity,
  deleteOAuthIdentityForUser,
  getOAuthIdentityBySubject,
  getOAuthIdentityForUser,
  type OAuthProfile,
  type OAuthProvider,
} from '../lib/oauth-identities';
import {
  decodeJwtPayload,
  getGoogleOAuthConfig,
  getMicrosoftOAuthConfig,
  googleRedirectUri,
  microsoftRedirectUri,
} from '../lib/oauth-config';
import { issueOAuthState, safeNextPath, takeOAuthState } from '../lib/oauth-state';
import { users } from '../lib/schema';
import { appendCookies, createSession, resolveNormalSession } from '../lib/session';
import {
  validateCompleteLink,
  markCompleteLinkUsed,
  activateUser,
} from '../lib/complete';

export const oauthRoutes = new Hono<{ Bindings: Env; Variables: AuthContext }>();

function appOrigin(c: Context): string {
  return c.env.ORIGIN || new URL(c.req.url).origin;
}

function redirectWithError(c: Context, target: string, message: string) {
  return c.redirect(
    appendQuery(target, { oauth_error: message.slice(0, 180) }, appOrigin(c)),
    302,
  );
}

function redirectWithSuccess(c: Context, target: string, params: Record<string, string>) {
  return c.redirect(appendQuery(target, params, appOrigin(c)), 302);
}

async function finishLogin(c: Context, userId: string, nextPath: string) {
  const db = getDb(c.env);
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) {
    return redirectWithError(c, '/login', '用户不存在');
  }
  if (user.status === 'pending') {
    return redirectWithError(c, '/login', '身份不符合');
  }
  if (user.status === 'disabled') {
    return redirectWithError(c, '/login', '身份不符合');
  }
  const { setCookie } = await createSession(c.env, userId, 'normal');
  appendCookies(c, setCookie);
  await writeAuditLog(c.env, userId, 'OAUTH_LOGIN', userId, {});
  if (user.role !== 'admin' && nextPath.startsWith('/admin')) {
    nextPath = '/me';
  }
  return c.redirect(nextPath, 302);
}

async function handleBindMode(
  c: Context,
  provider: OAuthProvider,
  profile: OAuthProfile,
  oauthState: { bindUserId?: string; bindOperatorUserId?: string; next: string },
) {
  const nextPath = safeNextPath(oauthState.next, '/me');
  const bindUserId = String(oauthState.bindUserId || '').trim();
  if (!bindUserId) {
    return redirectWithError(c, nextPath, '绑定状态无效，请重试');
  }

  const resolved = await resolveNormalSession(c);
  if (!resolved) {
    return redirectWithError(c, nextPath, '登录已失效，请重新发起关联');
  }
  const operator = resolved.user;
  if (bindUserId !== operator.id) {
    return redirectWithError(c, nextPath, '身份不符合');
  }

  const db = getDb(c.env);
  const targetUser = await db.select().from(users).where(eq(users.id, bindUserId)).get();
  if (!targetUser) {
    return redirectWithError(c, nextPath, '身份不符合');
  }

  try {
    await bindOAuthIdentity(c.env, bindUserId, provider, profile);
  } catch (e) {
    await writeAuditLog(c.env, operator.id, 'OAUTH_BIND_FAIL', bindUserId, {
      provider,
      reason: e instanceof Error ? e.message : String(e),
    });
    return redirectWithError(c, nextPath, '身份不符合');
  }

  await writeAuditLog(c.env, operator.id, 'OAUTH_BIND', bindUserId, { provider, email: profile.email });
  return redirectWithSuccess(c, nextPath, {
    oauth: `${provider}_bound`,
    oauth_user: targetUser.name,
    oauth_user_id: bindUserId,
  });
}

async function handleLoginMode(
  c: Context,
  provider: OAuthProvider,
  profile: OAuthProfile,
  nextPath: string,
) {
  const linked = await getOAuthIdentityBySubject(c.env, provider, profile.sub);
  if (linked) {
    await bindOAuthIdentity(c.env, linked.userId, provider, profile);
    return finishLogin(c, linked.userId, nextPath);
  }

  return redirectWithError(c, '/login', '身份不符合');
}

async function handleRegisterMode(
  c: Context,
  provider: OAuthProvider,
  profile: OAuthProfile,
  completeToken: string,
) {
  const result = await validateCompleteLink(c.env, completeToken);
  if ('error' in result) {
    return redirectWithError(c, '/login', '激活链接已失效');
  }
  const userId = result.user.id;

  try {
    await bindOAuthIdentity(c.env, userId, provider, profile);
  } catch (e) {
    await writeAuditLog(c.env, userId, 'COMPLETE_LINK_BIND_FAIL', userId, {
      provider,
      reason: e instanceof Error ? e.message : String(e),
    });
    return redirectWithError(c, '/login', '身份不符合');
  }

  const wasPending = result.user.status === 'pending';
  if (wasPending) {
    await activateUser(c.env, userId);
  }
  await markCompleteLinkUsed(c.env, completeToken);
  await writeAuditLog(c.env, userId, 'COMPLETE_LINK_USED', userId, {
    provider,
    wasPending,
  });
  return finishLogin(c, userId, '/me');
}

async function authorizeBindStart(
  c: Context,
  bindUserId: string | undefined,
  next: string,
  providerLabel: string,
): Promise<Response | { operator: User; targetBindUserId: string }> {
  const resolved = await resolveNormalSession(c);
  if (!resolved) {
    return c.redirect(
      appendQuery(
        '/login',
        { oauth_error: `请先登录后再关联 ${providerLabel} 账号` },
        appOrigin(c),
      ),
      302,
    );
  }
  const operator = resolved.user;
  let targetBindUserId = operator.id;
  if (bindUserId) {
    if (bindUserId !== operator.id) {
      return redirectWithError(c, next, '身份不符合');
    }
    targetBindUserId = bindUserId;
  }
  return { operator, targetBindUserId };
}

oauthRoutes.get('/google/public-status', async (c) => {
  const conf = await getGoogleOAuthConfig(c.env);
  return c.json({ enabled: conf.enabled });
});

oauthRoutes.get('/microsoft/public-status', async (c) => {
  const conf = await getMicrosoftOAuthConfig(c.env);
  return c.json({ enabled: conf.enabled });
});

oauthRoutes.get('/google/start', async (c) => {
  const conf = await getGoogleOAuthConfig(c.env);
  if (!conf.enabled) {
    return c.json({ error: 'Google OAuth 未配置' }, 503);
  }

  const rawMode = c.req.query('mode');
  const mode: 'login' | 'bind' | 'register' =
    rawMode === 'bind' ? 'bind' : rawMode === 'register' ? 'register' : 'login';
  const defaultNext = mode === 'bind' ? '/admin/users' : '/admin';
  const next = safeNextPath(c.req.query('next'), defaultNext);
  const bindUserId = c.req.query('bind_user_id')?.trim() || undefined;
  const completeToken = c.req.query('complete_token')?.trim() || undefined;

  const statePayload: Parameters<typeof issueOAuthState>[1] = {
    provider: 'google',
    mode,
    next,
  };

  if (mode === 'bind') {
    const check = await authorizeBindStart(c, bindUserId, next, 'Google');
    if (check instanceof Response) return check;
    statePayload.bindUserId = check.targetBindUserId;
    statePayload.bindOperatorUserId = check.operator.id;
  }

  if (mode === 'register') {
    if (!completeToken) {
      return c.json({ error: '缺少 complete_token' }, 400);
    }
    const check = await validateCompleteLink(c.env, completeToken);
    if ('error' in check) {
      return c.json({ error: '激活链接已失效' }, 410);
    }
    statePayload.registerCompleteToken = completeToken;
  }

  const state = await issueOAuthState(c.env, statePayload);
  const redirectUri = googleRedirectUri(c.env, conf);
  const params = new URLSearchParams({
    client_id: conf.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: conf.scopes,
    state,
    prompt: 'select_account',
    include_granted_scopes: 'true',
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
});

oauthRoutes.get('/microsoft/start', async (c) => {
  const conf = await getMicrosoftOAuthConfig(c.env);
  if (!conf.enabled) {
    return c.json({ error: 'Microsoft OAuth 未配置' }, 503);
  }

  const rawMode = c.req.query('mode');
  const mode: 'login' | 'bind' | 'register' =
    rawMode === 'bind' ? 'bind' : rawMode === 'register' ? 'register' : 'login';
  const defaultNext = mode === 'bind' ? '/admin/users' : '/admin';
  const next = safeNextPath(c.req.query('next'), defaultNext);
  const bindUserId = c.req.query('bind_user_id')?.trim() || undefined;
  const completeToken = c.req.query('complete_token')?.trim() || undefined;

  const statePayload: Parameters<typeof issueOAuthState>[1] = {
    provider: 'microsoft',
    mode,
    next,
  };

  if (mode === 'bind') {
    const check = await authorizeBindStart(c, bindUserId, next, 'Microsoft');
    if (check instanceof Response) return check;
    statePayload.bindUserId = check.targetBindUserId;
    statePayload.bindOperatorUserId = check.operator.id;
  }

  if (mode === 'register') {
    if (!completeToken) {
      return c.json({ error: '缺少 complete_token' }, 400);
    }
    const check = await validateCompleteLink(c.env, completeToken);
    if ('error' in check) {
      return c.json({ error: '激活链接已失效' }, 410);
    }
    statePayload.registerCompleteToken = completeToken;
  }

  const state = await issueOAuthState(c.env, statePayload);
  const redirectUri = microsoftRedirectUri(c.env, conf);
  const tenant = conf.tenantId;
  const params = new URLSearchParams({
    client_id: conf.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: conf.scopes,
    state,
    prompt: 'select_account',
  });
  return c.redirect(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`,
    302,
  );
});

oauthRoutes.get('/google/callback', async (c) => {
  const oauthError = c.req.query('error');
  if (oauthError) {
    const desc = c.req.query('error_description') || oauthError;
    return redirectWithError(c, '/login', String(desc));
  }

  const oauthState = await takeOAuthState(c.env, c.req.query('state'));
  if (!oauthState || oauthState.provider !== 'google') {
    return redirectWithError(c, '/login', '登录状态已过期，请重试');
  }

  const conf = await getGoogleOAuthConfig(c.env);
  if (!conf.enabled) {
    return redirectWithError(c, '/login', 'Google OAuth 未配置');
  }

  const mode = oauthState.mode;
  const nextPath = safeNextPath(oauthState.next, mode === 'bind' ? '/admin/users' : '/admin');
  const code = c.req.query('code')?.trim();
  if (!code) {
    return redirectWithError(c, mode === 'bind' ? nextPath : '/login', '未收到 Google 授权码');
  }

  const redirectUri = googleRedirectUri(c.env, conf);
  let profile: OAuthProfile;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: conf.clientId,
        client_secret: conf.clientSecret,
        redirect_uri: redirectUri,
      }),
    });
    const tokenJson = (await tokenRes.json()) as Record<string, string>;
    if (!tokenRes.ok) {
      throw new Error(tokenJson.error_description || tokenJson.error || 'Google 令牌交换失败');
    }
    const accessToken = String(tokenJson.access_token || '').trim();
    if (!accessToken) throw new Error('Google 未返回 access_token');

    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const infoJson = (await infoRes.json()) as Record<string, unknown>;
    if (!infoRes.ok) {
      throw new Error(String(infoJson.error_description || infoJson.error || '获取 Google 用户信息失败'));
    }

    profile = {
      sub: String(infoJson.sub || '').trim(),
      email: normalizeOAuthEmail(String(infoJson.email || '')),
      emailVerified: Boolean(infoJson.email_verified),
      displayName: String(infoJson.name || '').trim(),
      avatarUrl: String(infoJson.picture || '').trim(),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Google 授权失败';
    return redirectWithError(c, mode === 'bind' ? nextPath : '/login', message);
  }

  if (!profile.sub) {
    return redirectWithError(c, mode === 'bind' ? nextPath : '/login', 'Google 用户标识无效');
  }

  if (mode === 'bind') {
    return handleBindMode(c, 'google', profile, oauthState);
  }
  if (mode === 'register') {
    if (!oauthState.registerCompleteToken) {
      return redirectWithError(c, '/login', '登录状态已过期，请重试');
    }
    return handleRegisterMode(c, 'google', profile, oauthState.registerCompleteToken);
  }
  return handleLoginMode(c, 'google', profile, nextPath);
});

oauthRoutes.get('/microsoft/callback', async (c) => {
  const oauthError = c.req.query('error');
  if (oauthError) {
    const desc = c.req.query('error_description') || oauthError;
    return redirectWithError(c, '/login', String(desc));
  }

  const oauthState = await takeOAuthState(c.env, c.req.query('state'));
  if (!oauthState || oauthState.provider !== 'microsoft') {
    return redirectWithError(c, '/login', '登录状态已过期，请重试');
  }

  const conf = await getMicrosoftOAuthConfig(c.env);
  if (!conf.enabled) {
    return redirectWithError(c, '/login', 'Microsoft OAuth 未配置');
  }

  const mode = oauthState.mode;
  const nextPath = safeNextPath(oauthState.next, mode === 'bind' ? '/admin/users' : '/admin');
  const code = c.req.query('code')?.trim();
  if (!code) {
    return redirectWithError(c, mode === 'bind' ? nextPath : '/login', '未收到 Microsoft 授权码');
  }

  const redirectUri = microsoftRedirectUri(c.env, conf);
  let profile: OAuthProfile = {
    sub: '',
    email: '',
    emailVerified: false,
    displayName: '',
    avatarUrl: '',
  };

  try {
    const tokenUrl = `https://login.microsoftonline.com/${conf.tenantId}/oauth2/v2.0/token`;
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: conf.clientId,
        client_secret: conf.clientSecret,
        redirect_uri: redirectUri,
      }),
    });
    const tokenJson = (await tokenRes.json()) as Record<string, string>;
    if (!tokenRes.ok) {
      throw new Error(tokenJson.error_description || tokenJson.error || 'Microsoft 令牌交换失败');
    }

    const accessToken = String(tokenJson.access_token || '').trim();
    const idClaims = decodeJwtPayload(tokenJson.id_token);
    profile = {
      sub: String(idClaims.oid || idClaims.sub || '').trim(),
      email: normalizeOAuthEmail(
        String(idClaims.email || idClaims.preferred_username || idClaims.upn || ''),
      ),
      emailVerified: Boolean(idClaims.email_verified),
      displayName: String(idClaims.name || '').trim(),
      avatarUrl: '',
    };

    if (accessToken) {
      const infoRes = await fetch('https://graph.microsoft.com/oidc/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (infoRes.ok) {
        const infoJson = (await infoRes.json()) as Record<string, unknown>;
        profile.sub = String(infoJson.sub || profile.sub).trim();
        profile.email = normalizeOAuthEmail(
          String(infoJson.email || infoJson.preferred_username || profile.email),
        );
        profile.displayName = String(infoJson.name || profile.displayName).trim();
        profile.emailVerified = Boolean(infoJson.email_verified || profile.emailVerified);
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Microsoft 授权失败';
    return redirectWithError(c, mode === 'bind' ? nextPath : '/login', message);
  }

  if (!profile.sub) {
    return redirectWithError(c, mode === 'bind' ? nextPath : '/login', 'Microsoft 用户标识无效');
  }

  if (mode === 'bind') {
    return handleBindMode(c, 'microsoft', profile, oauthState);
  }
  if (mode === 'register') {
    if (!oauthState.registerCompleteToken) {
      return redirectWithError(c, '/login', '登录状态已过期，请重试');
    }
    return handleRegisterMode(c, 'microsoft', profile, oauthState.registerCompleteToken);
  }
  return handleLoginMode(c, 'microsoft', profile, nextPath);
});

export async function buildOAuthUserFields(
  env: Env,
  user: User,
  passkeyCount: number,
  googleEnabled: boolean,
  microsoftEnabled: boolean,
) {
  const googleLinked = await getOAuthIdentityForUser(env, user.id, 'google');
  const msLinked = await getOAuthIdentityForUser(env, user.id, 'microsoft');
  return buildOAuthUserFieldsSync(
    user,
    passkeyCount,
    googleEnabled,
    microsoftEnabled,
    googleLinked,
    msLinked,
  );
}

export function buildOAuthUserFieldsSync(
  user: User,
  passkeyCount: number,
  googleEnabled: boolean,
  microsoftEnabled: boolean,
  googleLinked: Awaited<ReturnType<typeof getOAuthIdentityForUser>>,
  msLinked: Awaited<ReturnType<typeof getOAuthIdentityForUser>>,
) {
  const hasPasskey = passkeyCount > 0;
  return {
    googleEnabled,
    googleLinked: Boolean(googleLinked),
    googleEmail: googleLinked?.email || '',
    googleCanUnlink: Boolean(googleLinked && hasPasskey),
    microsoftEnabled,
    microsoftLinked: Boolean(msLinked),
    microsoftEmail: msLinked?.email || '',
    microsoftCanUnlink: Boolean(msLinked && hasPasskey),
    hasPasskey,
  };
}
