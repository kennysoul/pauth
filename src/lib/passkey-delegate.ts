import { eq, lt } from 'drizzle-orm';
import type { Env } from '../types';
import { getDb, nowIso } from './db';
import { passkeyDelegateTokens, users } from './schema';

const TTL_SECONDS = 600;

export async function cleanupExpiredDelegateTokens(env: Env) {
  const db = getDb(env);
  const now = nowIso();
  await db.delete(passkeyDelegateTokens).where(lt(passkeyDelegateTokens.expiresAt, now));
}

export async function createPasskeyDelegateToken(env: Env, userId: string): Promise<string> {
  await cleanupExpiredDelegateTokens(env);
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const ts = nowIso();
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();
  const db = getDb(env);
  await db.insert(passkeyDelegateTokens).values({
    token,
    userId,
    expiresAt,
    createdAt: ts,
  });
  return token;
}

export async function resolvePasskeyDelegateToken(env: Env, token: string) {
  const db = getDb(env);
  const now = nowIso();
  const row = await db
    .select()
    .from(passkeyDelegateTokens)
    .where(eq(passkeyDelegateTokens.token, token))
    .get();
  if (!row || row.expiresAt <= now) return null;

  const user = await db.select().from(users).where(eq(users.id, row.userId)).get();
  if (!user || user.status === 'disabled') return null;

  return { token: row, user };
}

export async function deletePasskeyDelegateToken(env: Env, token: string) {
  const db = getDb(env);
  await db.delete(passkeyDelegateTokens).where(eq(passkeyDelegateTokens.token, token));
}

export function passkeyDelegateLink(env: Env, token: string): string {
  return `${env.ORIGIN}/link-device?t=${encodeURIComponent(token)}`;
}

export const PASSKEY_DELEGATE_TTL_SECONDS = TTL_SECONDS;
