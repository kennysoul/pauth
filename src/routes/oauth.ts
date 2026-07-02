import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import type { AuthContext, Env, User } from '../types';
import { writeAuditLog } from '../lib/audit';
import { appendQuery } from '../lib/crypto';
import { getDb, newId, nowIso } from '../lib/db';
import { normalizeOAuthEmail } from '../lib/oauth-email';
import {
  bindOAuthIdentity,
  clearUserAllowedEmail,
  getOAuthIdentityBySubject,
  getOAuthIdentityForUser,
  getUserByAllowedEmail,
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
import { systemConfig, users } from '../lib/schema';
import { appendCookies, createSession, resolveNormalSession } from '../lib/session';

export const oauthRoutes = new Hono<{ Bindings: Env; Variables: AuthContext }>();

function redirectWithError(c: Context, target: string, message: string) {
  return c.redirect(appendQuery(target, { oauth_error: message.slice(0, 180) }), 302);
}

function redirectWithSuccess(c: Context, target: string, params: Record<string, string>) {
  return c.redirect(appendQuery(target, params), 302);
}

async function finishLogin(c: Context, userId: string, nextPath: string) {
  const db = getDb(c.env);
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) {
    return redirectWithError(c, '/login', '用户不存在');
  }
  if (user.status === 'pending') {
    return redirectWithError(c, '/login', '账号待审批，请等待管理员确认');
  }
  if (user.status === 'disabled') {
    return redirectWithError(c, '/login', '账号已被禁用');
  }
  const { setCookie } = await createSession(c.env, userId, 'normal');
  appendCookies(c, setCookie);
  await writeAuditLog(c.env, userId, 'OAUTH_LOGIN', userId, {});
  return c.redirect(nextPath, 302);
}

async function handleBindMode(
  c: Context,
  provider: OAuthProvider,
  profile: OAuthProfile,
  oauthState: { bindUserId?: string; bindOperatorUserId?: string; next: string },
) {
  const nextPath = safeNextPath(oauthState.next, '/admin/users');
  const bindUserId = String(oauthState.bindUserId || '').trim();
  if (!bindUserId) {
    return redirectWithError(c, nextPath, '绑定状态无效，请重试');
  }

  const resolved = await resolveNormalSession(c);
  if (!resolved) {
    return redirectWithError(c, nextPath, '登录已失效，请重新发起关联');
  }
  const operator = resolved.user;
  const operatorId = oauthState.bindOperatorUserId || operator.id;
  if (operator.id !== operatorId) {
    return redirectWithError(c, nextPath, '登录用户已变化，请重新发起关联');
  }
  if (bindUserId !== operator.id && operator.role !== 'admin') {
    return redirectWithError(c, nextPath, '仅管理员可为其他用户关联第三方账号');
  }

  const db = getDb(c.env);
  const targetUser = await db.select().from(users).where(eq(users.id, bindUserId)).get();
  if (!targetUser) {
    return redirectWithError(c, nextPath, '目标用户不存在');
  }

  const existing = await getOAuthIdentityForUser(c.env, bindUserId, provider);
  const isFirstBind = !existing;
  const allowedColumn =
    provider === 'google' ? targetUser.allowedGoogleEmail : targetUser.allowedMicrosoftEmail;
  const preauthorizedEmail = normalizeOAuthEmail(allowedColumn);

  if (isFirstBind && preauthorizedEmail) {
    if (provider === 'google' && !profile.emailVerified) {
      return redirectWithError(c, nextPath, '该用户限定了邮箱，但当前 Google 邮箱未验证');
    }
    if (provider === 'microsoft' && !profile.email) {
      return redirectWithError(c, nextPath, '该用户限定了邮箱，但当前 Microsoft 账号未返回邮箱');
    }
    if (profile.email !== preauthorizedEmail) {
      return redirectWithError(c, nextPath, '当前邮箱未获授权，请使用管理员指定邮箱');
    }
  }

  try {
    await bindOAuthIdentity(c.env, bindUserId, provider, profile);
    if (isFirstBind && preauthorizedEmail) {
      await clearUserAllowedEmail(c.env, bindUserId, provider);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : '绑定失败';
    return redirectWithError(c, nextPath, message);
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

  if (profile.email) {
    const preauthorized = await getUserByAllowedEmail(c.env, provider, profile.email);
    if (preauthorized) {
      if (provider === 'google' && !profile.emailVerified) {
        return redirectWithError(c, '/login', '该账号要求已验证的 Google 邮箱');
      }
      if (provider === 'microsoft' && !profile.email) {
        return redirectWithError(c, '/login', 'Microsoft 账号未返回邮箱');
      }
      if (preauthorized.status !== 'active') {
        return redirectWithError(c, '/login', '该账号尚未激活，请联系管理员');
      }
      const hadLinked = await getOAuthIdentityForUser(c.env, preauthorized.id, provider);
      const preEmail = normalizeOAuthEmail(
        provider === 'google'
          ? preauthorized.allowedGoogleEmail
          : preauthorized.allowedMicrosoftEmail,
      );
      try {
        await bindOAuthIdentity(c.env, preauthorized.id, provider, profile);
        if (!hadLinked && preEmail) {
          await clearUserAllowedEmail(c.env, preauthorized.id, provider);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : '绑定失败';
        return redirectWithError(c, '/login', message);
      }
      return finishLogin(c, preauthorized.id, nextPath);
    }
  }

  const db = getDb(c.env);
  const config = await db.select().from(systemConfig).where(eq(systemConfig.id, 1)).get();
  if (!config?.registrationEnabled) {
    return redirectWithError(c, '/login', '注册已关闭，请联系管理员先关联第三方账号');
  }

  if (!profile.email) {
    return redirectWithError(c, '/login', '第三方账号未返回邮箱，无法注册');
  }

  const ts = nowIso();
  const userId = newId();
  const displayName = profile.displayName || profile.email.split('@')[0] || 'User';
  try {
    await db.insert(users).values({
      id: userId,
      email: profile.email,
      name: displayName,
      role: 'user',
      status: 'pending',
      allowedGoogleEmail: '',
      allowedMicrosoftEmail: '',
      createdAt: ts,
      updatedAt: ts,
    });
    await bindOAuthIdentity(c.env, userId, provider, profile);
  } catch {
    await db.delete(users).where(eq(users.id, userId));
    return redirectWithError(c, '/login', '自动创建账号失败，请稍后重试');
  }

  return redirectWithError(c, '/login', '账号已创建，请等待管理员审批');
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
      appendQuery('/login', { oauth_error: `请先登录后再关联 ${providerLabel} 账号` }),
      302,
    );
  }
  const operator = resolved.user;
  let targetBindUserId = operator.id;
  if (bindUserId) {
    targetBindUserId = bindUserId;
    if (targetBindUserId !== operator.id && operator.role !== 'admin') {
      return redirectWithError(c, next, `仅管理员可为其他用户关联 ${providerLabel}`);
    }
    const db = getDb(c.env);
    const target = await db.select().from(users).where(eq(users.id, targetBindUserId)).get();
    if (!target) {
      return redirectWithError(c, next, '目标用户不存在');
    }
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

  const mode = c.req.query('mode') === 'bind' ? 'bind' : 'login';
  const defaultNext = mode === 'bind' ? '/admin/users' : '/admin';
  const next = safeNextPath(c.req.query('next'), defaultNext);
  const bindUserId = c.req.query('bind_user_id')?.trim() || undefined;

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

  const mode = c.req.query('mode') === 'bind' ? 'bind' : 'login';
  const defaultNext = mode === 'bind' ? '/admin/users' : '/admin';
  const next = safeNextPath(c.req.query('next'), defaultNext);
  const bindUserId = c.req.query('bind_user_id')?.trim() || undefined;

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
  return handleLoginMode(c, 'microsoft', profile, nextPath);
});

export async function buildOAuthUserFields(
  env: Env,
  user: User & { allowedGoogleEmail?: string; allowedMicrosoftEmail?: string },
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
  user: User & { allowedGoogleEmail?: string; allowedMicrosoftEmail?: string },
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
    googleAllowedEmail: normalizeOAuthEmail(user.allowedGoogleEmail || ''),
    microsoftEnabled,
    microsoftLinked: Boolean(msLinked),
    microsoftEmail: msLinked?.email || '',
    microsoftCanUnlink: Boolean(msLinked && hasPasskey),
    microsoftAllowedEmail: normalizeOAuthEmail(user.allowedMicrosoftEmail || ''),
    hasPasskey,
  };
}
