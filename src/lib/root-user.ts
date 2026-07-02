import { asc, eq } from 'drizzle-orm';
import type { Env } from '../types';
import { getDb } from './db';
import { users } from './schema';

export const ROOT_USER_NAME = 'root';

/** Bootstrap admin: earliest-created admin account. */
export async function getRootUser(env: Env) {
  const db = getDb(env);
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.role, 'admin'))
    .orderBy(asc(users.createdAt))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

export async function getRootUserId(env: Env): Promise<string | null> {
  const root = await getRootUser(env);
  return root?.id ?? null;
}

export function isRootUserId(userId: string, rootUserId: string | null): boolean {
  return rootUserId !== null && userId === rootUserId;
}
