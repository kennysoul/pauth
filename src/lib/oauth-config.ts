import type { Env } from '../types';
import {
  getSetting,
  GOOGLE_KEYS,
  GOOGLE_DEFAULT_SCOPES,
  MICROSOFT_KEYS,
  MICROSOFT_DEFAULT_SCOPES,
  MICROSOFT_DEFAULT_TENANT,
} from './oauth-settings';

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
  enabled: boolean;
};

export type MicrosoftOAuthConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
  enabled: boolean;
};

export function normalizeMicrosoftTenantId(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) return MICROSOFT_DEFAULT_TENANT;
  const folded = raw.toLowerCase();
  if (folded === 'common' || folded === 'organizations' || folded === 'consumers') {
    return folded;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    return MICROSOFT_DEFAULT_TENANT;
  }
  return raw;
}

export async function getGoogleOAuthConfig(env: Env): Promise<GoogleOAuthConfig> {
  const [clientIdSetting, clientSecretSetting, redirectUriSetting, scopesSetting] = await Promise.all([
    getSetting(env, GOOGLE_KEYS.clientId),
    getSetting(env, GOOGLE_KEYS.clientSecret),
    getSetting(env, GOOGLE_KEYS.redirectUri),
    getSetting(env, GOOGLE_KEYS.scopes),
  ]);
  let clientId = clientIdSetting.trim();
  let clientSecret = clientSecretSetting.trim();
  let redirectUri = redirectUriSetting.trim();
  let scopes = scopesSetting.trim() || GOOGLE_DEFAULT_SCOPES;

  if (!clientId) clientId = String((env as Record<string, string>).GOOGLE_OAUTH_CLIENT_ID || '').trim();
  if (!clientSecret) {
    clientSecret = String((env as Record<string, string>).GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
  }
  if (!redirectUri) {
    redirectUri = String((env as Record<string, string>).GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  }

  return {
    clientId,
    clientSecret,
    scopes,
    redirectUri,
    enabled: Boolean(clientId && clientSecret),
  };
}

export async function getMicrosoftOAuthConfig(env: Env): Promise<MicrosoftOAuthConfig> {
  const [tenantSetting, clientIdSetting, clientSecretSetting, redirectUriSetting, scopesSetting] =
    await Promise.all([
      getSetting(env, MICROSOFT_KEYS.tenantId),
      getSetting(env, MICROSOFT_KEYS.clientId),
      getSetting(env, MICROSOFT_KEYS.clientSecret),
      getSetting(env, MICROSOFT_KEYS.redirectUri),
      getSetting(env, MICROSOFT_KEYS.scopes),
    ]);
  const tenantId = normalizeMicrosoftTenantId(tenantSetting);
  const clientId = clientIdSetting.trim();
  const clientSecret = clientSecretSetting.trim();
  const redirectUri = redirectUriSetting.trim();
  const scopes = scopesSetting.trim() || MICROSOFT_DEFAULT_SCOPES;

  return {
    tenantId,
    clientId,
    clientSecret,
    scopes,
    redirectUri,
    enabled: Boolean(tenantId && clientId && clientSecret),
  };
}

export function googleRedirectUri(env: Env, conf: GoogleOAuthConfig): string {
  if (conf.redirectUri) return conf.redirectUri;
  return `${env.ORIGIN}/api/oauth/google/callback`;
}

export function microsoftRedirectUri(env: Env, conf: MicrosoftOAuthConfig): string {
  if (conf.redirectUri) return conf.redirectUri;
  return `${env.ORIGIN}/api/oauth/microsoft/callback`;
}

export function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> {
  const raw = String(token || '').trim();
  if (!raw) return {};
  const parts = raw.split('.');
  if (parts.length < 2) return {};
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}
