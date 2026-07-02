import { eq } from 'drizzle-orm';
import type { Env } from '../types';
import { getDb, nowIso } from './db';
import { settings } from './schema';

export async function getSetting(env: Env, key: string): Promise<string> {
  const db = getDb(env);
  const row = await db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value ?? '';
}

export async function setSetting(env: Env, key: string, value: string) {
  const db = getDb(env);
  const ts = nowIso();
  const existing = await db.select().from(settings).where(eq(settings.key, key)).get();
  if (existing) {
    await db.update(settings).set({ value, updatedAt: ts }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value, updatedAt: ts });
  }
}

export const GOOGLE_KEYS = {
  clientId: 'oauth_google_client_id',
  clientSecret: 'oauth_google_client_secret',
  redirectUri: 'oauth_google_redirect_uri',
  scopes: 'oauth_google_scopes',
} as const;

export const MICROSOFT_KEYS = {
  tenantId: 'oauth_microsoft_tenant_id',
  clientId: 'oauth_microsoft_client_id',
  clientSecret: 'oauth_microsoft_client_secret',
  redirectUri: 'oauth_microsoft_redirect_uri',
  scopes: 'oauth_microsoft_scopes',
} as const;

export const GOOGLE_DEFAULT_SCOPES = 'openid email profile';
export const MICROSOFT_DEFAULT_SCOPES = 'openid profile email User.Read';
export const MICROSOFT_DEFAULT_TENANT = 'common';
