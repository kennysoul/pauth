import { eq } from 'drizzle-orm';
import type { Env, User } from '../types';
import { getDb, newId, nowIso } from './db';
import { completeLinks, users } from './schema';

const TTL_SECONDS = 900;
const MAX_OPENS = 3;

export type CompleteLinkError =
  | { error: 'invalid' }
  | { error: 'used' }
  | { error: 'voided' }
  | { error: 'expired' }
  | { error: 'exhausted' };

export type CompleteLinkValid = {
  link: typeof completeLinks.$inferSelect;
  user: User;
};

export async function createCompleteLink(env: Env, userId: string): Promise<{ token: string; expiresAt: string }> {
  const db = getDb(env);
  await db.delete(completeLinks).where(eq(completeLinks.userId, userId));
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const ts = nowIso();
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();
  await db.insert(completeLinks).values({
    id: newId(),
    token,
    userId,
    expiresAt,
    openCount: 0,
    maxOpens: MAX_OPENS,
    createdAt: ts,
  });
  return { token, expiresAt };
}

export async function validateCompleteLink(env: Env, token: string): Promise<CompleteLinkValid | CompleteLinkError> {
  const db = getDb(env);
  const row = await db
    .select()
    .from(completeLinks)
    .where(eq(completeLinks.token, token))
    .get();
  if (!row) return { error: 'invalid' };
  if (row.usedAt) return { error: 'used' };
  if (row.voidedAt) return { error: 'voided' };
  const now = nowIso();
  if (row.expiresAt <= now) return { error: 'expired' };
  if (row.openCount >= row.maxOpens) return { error: 'exhausted' };

  const user = await db.select().from(users).where(eq(users.id, row.userId)).get();
  if (!user) return { error: 'invalid' };
  if (user.status === 'disabled') return { error: 'voided' };

  return { link: row, user: user as User };
}

export async function incrementOpenCount(env: Env, token: string): Promise<boolean> {
  const db = getDb(env);
  const row = await db.select().from(completeLinks).where(eq(completeLinks.token, token)).get();
  if (!row) return false;
  const next = row.openCount + 1;
  if (next > row.maxOpens) {
    await db
      .update(completeLinks)
      .set({ openCount: next, voidedAt: nowIso() })
      .where(eq(completeLinks.token, token));
    return false;
  }
  await db
    .update(completeLinks)
    .set({ openCount: next })
    .where(eq(completeLinks.token, token));
  return true;
}

export async function markCompleteLinkUsed(env: Env, token: string): Promise<void> {
  const db = getDb(env);
  await db
    .update(completeLinks)
    .set({ usedAt: nowIso() })
    .where(eq(completeLinks.token, token));
}

export async function deleteCompleteLinksForUser(env: Env, userId: string): Promise<void> {
  const db = getDb(env);
  await db.delete(completeLinks).where(eq(completeLinks.userId, userId));
}

export function completeLinkUrl(env: Env, token: string): string {
  return `${env.ORIGIN}/complete/${encodeURIComponent(token)}`;
}

export function completeLinkPasskeyUrl(env: Env, token: string): string {
  return `${env.ORIGIN}/complete/${encodeURIComponent(token)}/passkey`;
}

export async function activateUser(env: Env, userId: string): Promise<void> {
  const db = getDb(env);
  await db
    .update(users)
    .set({ status: 'active', updatedAt: nowIso() })
    .where(eq(users.id, userId));
}

export const COMPLETE_TTL_SECONDS = TTL_SECONDS;