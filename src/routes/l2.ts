import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq, and, gt, isNull } from 'drizzle-orm';
import type { Env } from '../types';
import { writeAuditLog } from '../lib/audit';
import { getDb, nowIso } from '../lib/db';
import { authCodes, accessTokens, clients, users } from '../lib/schema';
import { isAllowedL2RedirectUri } from '../lib/return-to';
import { resolveNormalSession } from '../lib/session';
import { userCanAccessClient } from '../lib/permissions';
import {
  appendQuery,
  newAccessToken,
  newAuthCode,
  sha256Hex,
} from '../lib/crypto';
import { createIdToken } from '../lib/jwt';
import { getOidcSigningKey } from '../lib/oidc-keys';

export const l2Routes = new Hono<{ Bindings: Env }>();

const CODE_TTL_SECONDS = 600;
const TOKEN_TTL_SECONDS = 600;
const DEFAULT_SCOPE = 'openid profile';

function oauthError(c: Context<{ Bindings: Env }>, status: 400 | 401 | 403, error: string, message: string) {
  return c.json({ error, message }, status);
}

function userInfoFromRow(user: { id: string; email: string; name: string }) {
  return {
    sub: user.id,
    email: user.email,
    name: user.name,
  };
}

l2Routes.get('/authorize', async (c) => {
  const clientId = c.req.query('client_id')?.trim();
  const redirectUri = c.req.query('redirect_uri')?.trim();
  const responseType = c.req.query('response_type')?.trim();
  const state = c.req.query('state')?.trim();
  const scope = c.req.query('scope')?.trim() || DEFAULT_SCOPE;
  const nonce = c.req.query('nonce')?.trim() || null;

  if (!clientId) {
    return oauthError(c, 400, 'invalid_request', 'client_id is required');
  }
  if (!redirectUri) {
    return oauthError(c, 400, 'invalid_request', 'redirect_uri is required');
  }
  if (responseType !== 'code') {
    return oauthError(c, 400, 'invalid_request', 'response_type must be code');
  }
  if (!state) {
    return oauthError(c, 400, 'invalid_request', 'state is required');
  }
  if (!isAllowedL2RedirectUri(redirectUri, c.env)) {
    return oauthError(c, 400, 'invalid_redirect_uri', 'redirect_uri must be a valid HTTPS URL');
  }

  const db = getDb(c.env);
  const client = await db.select().from(clients).where(eq(clients.clientId, clientId)).get();
  if (!client || !client.enabled) {
    return oauthError(c, 400, 'invalid_client', 'Unknown or disabled client_id');
  }

  const resolved = await resolveNormalSession(c);
  const reqUrl = new URL(c.req.url);
  const authorizeUrl = `${c.env.ORIGIN}${reqUrl.pathname}${reqUrl.search}`;

  if (!resolved || resolved.user.status !== 'active') {
    const loginUrl = `${c.env.ORIGIN}/login?return_to=${encodeURIComponent(authorizeUrl)}`;
    return c.redirect(loginUrl, 302);
  }

  const access = await userCanAccessClient(c.env, resolved.user.id, client);
  if (!access.ok) {
    const description =
      access.reason === 'l1_required'
        ? 'l1_required'
        : access.reason === 'user_inactive'
          ? 'user_inactive'
          : 'access_denied';
    await writeAuditLog(c.env, resolved.user.id, 'L2_AUTHORIZE_DENY', resolved.user.id, {
      clientId,
      reason: description,
    });
    return c.redirect(
      appendQuery(redirectUri, {
        error: 'access_denied',
        error_description: description,
        state,
      }),
      302,
    );
  }

  const code = newAuthCode();
  const ts = nowIso();
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString();
  await db.insert(authCodes).values({
    code,
    userId: resolved.user.id,
    clientId,
    redirectUri,
    scope,
    nonce,
    expiresAt,
    usedAt: null,
    createdAt: ts,
  });

  await writeAuditLog(c.env, resolved.user.id, 'L2_AUTHORIZE', resolved.user.id, {
    clientId,
    code,
  });

  return c.redirect(
    appendQuery(redirectUri, {
      code,
      state,
    }),
    302,
  );
});

function parseBasicAuth(c: Context<{ Bindings: Env }>): { clientId: string; clientSecret: string } | null {
  const auth = c.req.header('Authorization') ?? '';
  const basicMatch = auth.match(/^Basic\s+(.+)$/i);
  if (!basicMatch) return null;
  try {
    const decoded = atob(basicMatch[1].trim());
    const colon = decoded.indexOf(':');
    if (colon < 1) return null;
    return { clientId: decoded.slice(0, colon).trim(), clientSecret: decoded.slice(colon + 1).trim() };
  } catch {
    return null;
  }
}

l2Routes.post('/token', async (c) => {
  const body = await c.req.parseBody();
  const grantType = String(body.grant_type ?? '').trim();
  const code = String(body.code ?? '').trim();
  let clientId = String(body.client_id ?? '').trim();
  let clientSecret = String(body.client_secret ?? '').trim();
  const redirectUri = String(body.redirect_uri ?? '').trim();

  const basicAuth = !clientId ? parseBasicAuth(c) : null;
  if (basicAuth) {
    clientId = basicAuth.clientId;
    clientSecret = basicAuth.clientSecret;
  }

  if (grantType !== 'authorization_code') {
    return oauthError(c, 400, 'unsupported_grant_type', 'Only authorization_code is supported');
  }
  if (!code || !clientId || !clientSecret || !redirectUri) {
    return oauthError(c, 400, 'invalid_request', 'Missing required parameters');
  }

  const db = getDb(c.env);
  const client = await db.select().from(clients).where(eq(clients.clientId, clientId)).get();
  if (!client || !client.enabled) {
    return oauthError(c, 401, 'invalid_client', 'Client authentication failed');
  }

  const secretHash = await sha256Hex(clientSecret);
  if (!client.clientSecretHash || client.clientSecretHash !== secretHash) {
    return oauthError(c, 401, 'invalid_client', 'Client authentication failed');
  }

  const now = nowIso();
  const codeRow = await db
    .select()
    .from(authCodes)
    .where(
      and(
        eq(authCodes.code, code),
        eq(authCodes.clientId, clientId),
        gt(authCodes.expiresAt, now),
        isNull(authCodes.usedAt),
      ),
    )
    .get();

  if (!codeRow) {
    const anyCode = await db.select().from(authCodes).where(eq(authCodes.code, code)).get();
    if (!anyCode) {
      return oauthError(c, 400, 'invalid_grant', 'Authorization code is invalid');
    }
    if (anyCode.usedAt) {
      return oauthError(c, 400, 'invalid_grant', 'Authorization code has already been used');
    }
    return oauthError(c, 400, 'invalid_grant', 'Authorization code has expired');
  }

  if (codeRow.redirectUri !== redirectUri) {
    return oauthError(c, 400, 'invalid_grant', 'redirect_uri mismatch');
  }

  const user = await db.select().from(users).where(eq(users.id, codeRow.userId)).get();
  if (!user || user.status !== 'active') {
    return oauthError(c, 403, 'access_denied', 'User no longer has required client or L1 access');
  }

  const access = await userCanAccessClient(c.env, user.id, client);
  if (!access.ok) {
    return oauthError(c, 403, 'access_denied', 'User no longer has required client or L1 access');
  }

  const ts = nowIso();
  await db.update(authCodes).set({ usedAt: ts }).where(eq(authCodes.code, code));

  const accessToken = newAccessToken();
  const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();
  const tokenHash = await sha256Hex(accessToken);

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_TTL_SECONDS;
  const signingKey = await getOidcSigningKey(c.env);
  const idToken = await createIdToken(c.env, signingKey.kid, {
    iss: c.env.ORIGIN,
    sub: user.id,
    aud: clientId,
    exp,
    iat,
    ...(codeRow.nonce ? { nonce: codeRow.nonce } : {}),
    ...(codeRow.scope.includes('email') ? { email: user.email } : {}),
    ...(codeRow.scope.includes('profile') ? { name: user.name } : {}),
  });

  await db.insert(accessTokens).values({
    tokenHash,
    userId: user.id,
    clientId,
    scope: codeRow.scope,
    expiresAt: tokenExpiresAt,
    revokedAt: null,
    createdAt: ts,
  });

  await writeAuditLog(c.env, user.id, 'L2_TOKEN', user.id, {
    clientId,
    scope: codeRow.scope,
  });

  return c.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_SECONDS,
    scope: codeRow.scope,
    id_token: idToken,
    user: userInfoFromRow(user),
  });
});

l2Routes.get('/userinfo', async (c) => {
  const authHeader = c.req.header('Authorization') ?? '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const rawToken = match?.[1]?.trim();
  if (!rawToken) {
    return oauthError(c, 401, 'invalid_token', 'Bearer token is required');
  }

  const tokenHash = await sha256Hex(rawToken);
  const now = nowIso();
  const db = getDb(c.env);
  const tokenRow = await db
    .select()
    .from(accessTokens)
    .where(
      and(
        eq(accessTokens.tokenHash, tokenHash),
        gt(accessTokens.expiresAt, now),
        isNull(accessTokens.revokedAt),
      ),
    )
    .get();

  if (!tokenRow) {
    return oauthError(c, 401, 'invalid_token', 'Token is expired or revoked');
  }

  const user = await db.select().from(users).where(eq(users.id, tokenRow.userId)).get();
  if (!user || user.status !== 'active') {
    return oauthError(c, 401, 'invalid_token', 'Token is expired or revoked');
  }

  const client = await db.select().from(clients).where(eq(clients.clientId, tokenRow.clientId)).get();
  if (!client || !client.enabled) {
    return oauthError(c, 401, 'invalid_token', 'Token is expired or revoked');
  }

  const access = await userCanAccessClient(c.env, user.id, client);
  if (!access.ok) {
    return oauthError(c, 401, 'invalid_token', 'Token is expired or revoked');
  }

  return c.json(userInfoFromRow(user));
});
