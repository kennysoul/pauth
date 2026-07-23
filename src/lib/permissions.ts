import { eq, and } from 'drizzle-orm';
import type { Env } from '../types';
import { getDb, nowIso } from './db';
import { userClientAccess, userL1Access, users } from './schema';

export type UserPermissions = {
  l1Enabled: boolean;
};

export async function getUserPermissions(env: Env, userId: string): Promise<UserPermissions> {
  const db = getDb(env);
  const l1 = await db.select().from(userL1Access).where(eq(userL1Access.userId, userId)).get();
  return {
    l1Enabled: Boolean(l1?.enabled),
  };
}

export async function setUserL1Access(env: Env, userId: string, enabled: boolean) {
  const db = getDb(env);
  const ts = nowIso();
  const existing = await db.select().from(userL1Access).where(eq(userL1Access.userId, userId)).get();
  if (existing) {
    await db
      .update(userL1Access)
      .set({ enabled: enabled ? 1 : 0, updatedAt: ts })
      .where(eq(userL1Access.userId, userId));
  } else {
    await db.insert(userL1Access).values({
      userId,
      enabled: enabled ? 1 : 0,
      updatedAt: ts,
    });
  }
}

export async function userHasL1Access(env: Env, userId: string): Promise<boolean> {
  const db = getDb(env);
  const row = await db.select().from(userL1Access).where(eq(userL1Access.userId, userId)).get();
  return Boolean(row?.enabled);
}

export type ClientRow = typeof import('./schema').clients.$inferSelect;

export async function userCanAccessClient(
  env: Env,
  userId: string,
  client: Pick<ClientRow, 'clientId' | 'accessMode' | 'enabled'>,
): Promise<{ ok: true } | { ok: false; reason: 'client_disabled' | 'user_inactive' | 'l1_required' | 'client_access_denied' }> {
  if (!client.enabled) {
    return { ok: false, reason: 'client_disabled' };
  }

  const db = getDb(env);
  const user = await db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user || user.status !== 'active') {
    return { ok: false, reason: 'user_inactive' };
  }

  if (client.accessMode === 'L1_AND_L2' && !(await userHasL1Access(env, userId))) {
    return { ok: false, reason: 'l1_required' };
  }

  const accessRows = await db
    .select({ userId: userClientAccess.userId })
    .from(userClientAccess)
    .where(
      and(
        eq(userClientAccess.clientId, client.clientId),
        eq(userClientAccess.enabled, 1),
      ),
    )
    .all();

  if (accessRows.length > 0 && !accessRows.some((r) => r.userId === userId)) {
    return { ok: false, reason: 'client_access_denied' };
  }

  return { ok: true };
}
