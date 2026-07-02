import { eq, ne, inArray } from 'drizzle-orm';
import type { Env } from '../types';
import { getDb, nowIso } from './db';
import { getRootUserId } from './root-user';
import {
  clients,
  invites,
  oauthIdentities,
  passkeys,
  settings,
  systemConfig,
  userClientAccess,
  userL1Access,
  users,
} from './schema';

export const BACKUP_KIND = 'pauth-backup-v1';

export type BackupPayload = {
  kind: typeof BACKUP_KIND;
  exportedAt: string;
  registrationEnabled: boolean;
  users: (typeof users.$inferSelect)[];
  passkeys: (typeof passkeys.$inferSelect)[];
  clients: (typeof clients.$inferSelect)[];
  userL1Access: (typeof userL1Access.$inferSelect)[];
  userClientAccess: (typeof userClientAccess.$inferSelect)[];
  oauthIdentities: (typeof oauthIdentities.$inferSelect)[];
  settings: (typeof settings.$inferSelect)[];
  invites: (typeof invites.$inferSelect)[];
};

export type BackupPreview = {
  users: number;
  passkeys: number;
  clients: number;
  oauthIdentities: number;
  settings: number;
  invites: number;
  l1Grants: number;
  exportedAt: string;
  registrationEnabled: boolean;
};

function previewFromPayload(payload: BackupPayload): BackupPreview {
  return {
    users: payload.users.length,
    passkeys: payload.passkeys.length,
    clients: payload.clients.length,
    oauthIdentities: payload.oauthIdentities.length,
    settings: payload.settings.length,
    invites: payload.invites.length,
    l1Grants: payload.userL1Access.length,
    exportedAt: payload.exportedAt,
    registrationEnabled: payload.registrationEnabled,
  };
}

export async function buildBackupPayload(env: Env): Promise<BackupPayload> {
  const db = getDb(env);
  const rootId = await getRootUserId(env);
  if (!rootId) {
    throw new Error('未找到 root 管理员');
  }

  const config = await db.select().from(systemConfig).where(eq(systemConfig.id, 1)).get();

  const allUsers = await db.select().from(users).all();
  const nonRootUsers = allUsers.filter((u) => u.id !== rootId);
  const nonRootIds = nonRootUsers.map((u) => u.id);

  const allPasskeys = await db.select().from(passkeys).all();
  const nonRootPasskeys = allPasskeys.filter((p) => p.userId !== rootId);

  const allOAuth = await db.select().from(oauthIdentities).all();
  const nonRootOAuth = allOAuth.filter((o) => o.userId !== rootId);

  const allL1 = await db.select().from(userL1Access).all();
  const nonRootL1 = allL1.filter((r) => r.userId !== rootId);

  const allUca = await db.select().from(userClientAccess).all();
  const nonRootUca = nonRootIds.length
    ? allUca.filter((r) => nonRootIds.includes(r.userId))
    : [];

  const allInvites = await db.select().from(invites).all();
  const nonRootInvites = allInvites.filter((i) => i.userId !== rootId);

  return {
    kind: BACKUP_KIND,
    exportedAt: nowIso(),
    registrationEnabled: Boolean(config?.registrationEnabled),
    users: nonRootUsers,
    passkeys: nonRootPasskeys,
    clients: await db.select().from(clients).all(),
    userL1Access: nonRootL1,
    userClientAccess: nonRootUca,
    oauthIdentities: nonRootOAuth,
    settings: await db.select().from(settings).all(),
    invites: nonRootInvites,
  };
}

export function parseBackupPayload(json: string): BackupPayload {
  let payload: BackupPayload;
  try {
    payload = JSON.parse(json) as BackupPayload;
  } catch {
    throw new Error('备份内容不是有效 JSON');
  }
  if (payload.kind !== BACKUP_KIND) {
    throw new Error(`不支持的备份类型: ${payload.kind ?? '(缺失)'}`);
  }
  if (!Array.isArray(payload.users)) {
    throw new Error('备份数据不完整');
  }
  return payload;
}

export function previewBackupPayload(payload: BackupPayload): BackupPreview {
  return previewFromPayload(payload);
}

export async function importBackupPayload(env: Env, payload: BackupPayload): Promise<BackupPreview> {
  const db = getDb(env);
  const rootId = await getRootUserId(env);
  if (!rootId) {
    throw new Error('未找到 root 管理员');
  }

  for (const u of payload.users) {
    if (u.id === rootId || u.name === 'root') {
      throw new Error('备份包含 root 用户数据，拒绝导入');
    }
  }
  for (const p of payload.passkeys) {
    if (p.userId === rootId) throw new Error('备份包含 root Passkey，拒绝导入');
  }
  for (const o of payload.oauthIdentities) {
    if (o.userId === rootId) throw new Error('备份包含 root OAuth 数据，拒绝导入');
  }

  const nonRootUserIds = (
    await db.select({ id: users.id }).from(users).where(ne(users.id, rootId)).all()
  ).map((r) => r.id);

  if (nonRootUserIds.length > 0) {
    await db.delete(passkeys).where(inArray(passkeys.userId, nonRootUserIds));
    await db.delete(oauthIdentities).where(inArray(oauthIdentities.userId, nonRootUserIds));
    await db.delete(userL1Access).where(inArray(userL1Access.userId, nonRootUserIds));
    await db.delete(userClientAccess).where(inArray(userClientAccess.userId, nonRootUserIds));
    await db.delete(invites).where(inArray(invites.userId, nonRootUserIds));
    await db.delete(users).where(inArray(users.id, nonRootUserIds));
  }

  await db.delete(clients);
  await db.delete(settings);
  await db.delete(userClientAccess);

  for (const row of payload.clients) {
    await db.insert(clients).values(row);
  }
  for (const row of payload.settings) {
    await db.insert(settings).values(row);
  }
  for (const row of payload.users) {
    await db.insert(users).values(row);
  }
  for (const row of payload.passkeys) {
    await db.insert(passkeys).values(row);
  }
  for (const row of payload.oauthIdentities) {
    await db.insert(oauthIdentities).values(row);
  }
  for (const row of payload.userL1Access) {
    await db.insert(userL1Access).values(row);
  }
  for (const row of payload.userClientAccess) {
    await db.insert(userClientAccess).values(row);
  }
  for (const row of payload.invites) {
    await db.insert(invites).values(row);
  }

  const ts = nowIso();
  await db
    .update(systemConfig)
    .set({
      registrationEnabled: payload.registrationEnabled ? 1 : 0,
      updatedAt: ts,
    })
    .where(eq(systemConfig.id, 1));

  return previewFromPayload(payload);
}
