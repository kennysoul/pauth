import { Hono } from 'hono';
import { eq, and, sql, desc, isNull } from 'drizzle-orm';
import type { AuthContext, Env } from '../types';
import { writeAuditLog } from '../lib/audit';
import { getDb, nowIso, newId } from '../lib/db';
import { auditLogs, authCodes, accessTokens, clients, invites, oauthIdentities, passkeys, passkeyDelegateTokens, sessions, settings, systemConfig, userClientAccess, userL1Access, users } from '../lib/schema';
import { requireAdmin } from '../middleware/auth';
import { appendCookies, clearCookie, deleteUserSessions } from '../lib/session';
import { getUserPermissions, setUserL1Access } from '../lib/permissions';
import {
  createPasskeyDelegateToken,
  passkeyDelegateLink,
  PASSKEY_DELEGATE_TTL_SECONDS,
} from '../lib/passkey-delegate';
import { newClientSecret, sha256Hex } from '../lib/crypto';
import { registerAdminOAuthRoutes } from './admin-oauth';
import { registerAdminBackupRoutes } from './admin-backup';
import { buildOAuthUserFieldsSync } from './oauth';
import { getGoogleOAuthConfig, getMicrosoftOAuthConfig } from '../lib/oauth-config';
import { getRootUserId, isRootUserId, ROOT_USER_NAME } from '../lib/root-user';

export const adminRoutes = new Hono<{ Bindings: Env; Variables: AuthContext }>();

adminRoutes.use('*', requireAdmin);

adminRoutes.get('/config', async (c) => {
  const db = getDb(c.env);
  const config = await db.select().from(systemConfig).where(eq(systemConfig.id, 1)).get();
  return c.json({
    state: config?.state,
    registrationEnabled: Boolean(config?.registrationEnabled),
  });
});

adminRoutes.patch('/config', async (c) => {
  const body = await c.req.json<{ registrationEnabled?: boolean }>();
  if (typeof body.registrationEnabled !== 'boolean') {
    return c.json({ error: 'registrationEnabled required' }, 400);
  }

  const db = getDb(c.env);
  const ts = nowIso();
  await db
    .update(systemConfig)
    .set({ registrationEnabled: body.registrationEnabled ? 1 : 0, updatedAt: ts })
    .where(eq(systemConfig.id, 1));

  await writeAuditLog(c.env, c.get('user').id, 'CONFIG_UPDATE', null, {
    registrationEnabled: body.registrationEnabled,
  });

  return c.json({ ok: true });
});

adminRoutes.get('/users', async (c) => {
  const status = c.req.query('status');
  const db = getDb(c.env);

  const userQuery =
    status && status !== 'all'
      ? db.select().from(users).where(eq(users.status, status)).all()
      : db.select().from(users).all();

  const [
    userRows,
    pkCounts,
    openInvites,
    googleConfig,
    microsoftConfig,
    rootUserId,
    l1Rows,
    oauthRows,
  ] = await Promise.all([
    userQuery,
    db
      .select({
        userId: passkeys.userId,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(passkeys)
      .groupBy(passkeys.userId)
      .all(),
    db.select({ userId: invites.userId }).from(invites).where(isNull(invites.usedAt)).all(),
    getGoogleOAuthConfig(c.env),
    getMicrosoftOAuthConfig(c.env),
    getRootUserId(c.env),
    db.select().from(userL1Access).all(),
    db.select().from(oauthIdentities).all(),
  ]);

  const countMap = new Map(pkCounts.map((r) => [r.userId, r.count]));
  const inviteMap = new Set(openInvites.map((i) => i.userId));
  const l1Map = new Map(l1Rows.map((r) => [r.userId, Boolean(r.enabled)]));
  const oauthMap = new Map<string, Map<string, (typeof oauthRows)[number]>>();
  for (const row of oauthRows) {
    let byProvider = oauthMap.get(row.userId);
    if (!byProvider) {
      byProvider = new Map();
      oauthMap.set(row.userId, byProvider);
    }
    byProvider.set(row.provider, row);
  }

  const googleEnabled = googleConfig.enabled;
  const microsoftEnabled = microsoftConfig.enabled;

  const result = userRows.map((u) => {
    const byProvider = oauthMap.get(u.id);
    const oauthFields = buildOAuthUserFieldsSync(
      u,
      countMap.get(u.id) ?? 0,
      googleEnabled,
      microsoftEnabled,
      byProvider?.get('google') ?? null,
      byProvider?.get('microsoft') ?? null,
    );
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt,
      passkeyCount: countMap.get(u.id) ?? 0,
      hasPendingInvite: inviteMap.has(u.id) && u.status === 'pending',
      l1Enabled: l1Map.get(u.id) ?? false,
      isRoot: isRootUserId(u.id, rootUserId),
      ...oauthFields,
    };
  });

  return c.json(result);
});

adminRoutes.patch('/users/:id', async (c) => {
  const targetId = c.req.param('id');
  const body = await c.req.json<{ status?: 'active' | 'disabled'; name?: string }>();

  if (body.status === undefined && body.name === undefined) {
    return c.json({ error: 'Nothing to update' }, 400);
  }

  const actor = c.get('user');
  const db = getDb(c.env);
  const target = await db.select().from(users).where(eq(users.id, targetId)).get();
  if (!target) {
    return c.json({ error: 'User not found' }, 404);
  }

  const rootUserId = await getRootUserId(c.env);
  if (isRootUserId(targetId, rootUserId)) {
    if (body.name !== undefined && body.name.trim() !== ROOT_USER_NAME) {
      return c.json({ error: 'root 管理员名称不可修改' }, 400);
    }
    if (body.status === 'disabled') {
      return c.json({ error: '不可禁用 root 管理员' }, 400);
    }
  }

  const updates: { status?: 'active' | 'disabled'; name?: string; updatedAt: string } = {
    updatedAt: nowIso(),
  };

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) {
      return c.json({ error: 'Name cannot be empty' }, 400);
    }
    if (name === ROOT_USER_NAME && !isRootUserId(targetId, rootUserId)) {
      return c.json({ error: '名称 root 保留给首个管理员' }, 400);
    }
    updates.name = name;
  }

  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'disabled') {
      return c.json({ error: 'Invalid status' }, 400);
    }

    if (body.status === 'disabled') {
      if (targetId === actor.id) {
        return c.json({ error: 'Cannot disable yourself' }, 400);
      }
      if (target.role === 'admin') {
        const admins = await db
          .select({ count: sql<number>`count(*)` })
          .from(users)
          .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
          .get();
        if (target.status === 'active' && admins && admins.count <= 1) {
          return c.json({ error: 'Cannot disable the last active admin' }, 400);
        }
      }
    }

    if (body.status === 'active' && target.status !== 'pending' && target.status !== 'disabled') {
      return c.json({ error: 'Invalid state transition' }, 400);
    }

    updates.status = body.status;
  }

  await db.update(users).set(updates).where(eq(users.id, targetId));

  if (body.status === 'disabled') {
    await deleteUserSessions(c.env, targetId);
  }

  if (body.status !== undefined) {
    const action = body.status === 'active' ? 'USER_APPROVE' : 'USER_DISABLE';
    await writeAuditLog(c.env, actor.id, action, targetId, { email: target.email });
  }
  if (body.name !== undefined) {
    await writeAuditLog(c.env, actor.id, 'USER_RENAME', targetId, {
      from: target.name,
      to: updates.name,
    });
  }

  return c.json({ ok: true });
});

adminRoutes.delete('/users/:id', async (c) => {
  const targetId = c.req.param('id');
  const actor = c.get('user');
  const db = getDb(c.env);
  const target = await db.select().from(users).where(eq(users.id, targetId)).get();
  if (!target) {
    return c.json({ error: 'User not found' }, 404);
  }
  if (targetId === actor.id) {
    return c.json({ error: 'Cannot delete yourself' }, 400);
  }
  const rootUserId = await getRootUserId(c.env);
  if (isRootUserId(targetId, rootUserId)) {
    return c.json({ error: '不可删除 root 管理员' }, 400);
  }
  if (target.role === 'admin' && target.status === 'active') {
    const admins = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
      .get();
    if (admins && admins.count <= 1) {
      return c.json({ error: 'Cannot delete the last active admin' }, 400);
    }
  }

  await deleteUserSessions(c.env, targetId);
  await db.delete(users).where(eq(users.id, targetId));
  await writeAuditLog(c.env, actor.id, 'USER_DELETE', targetId, {
    name: target.name,
    status: target.status,
  });
  return c.json({ ok: true });
});

adminRoutes.put('/users/:id/permissions', async (c) => {
  const targetId = c.req.param('id');
  const body = await c.req.json<{ l1Enabled?: boolean }>();
  const db = getDb(c.env);
  const target = await db.select().from(users).where(eq(users.id, targetId)).get();
  if (!target) {
    return c.json({ error: 'User not found' }, 404);
  }

  if (typeof body.l1Enabled !== 'boolean') {
    return c.json({ error: 'l1Enabled required' }, 400);
  }

  await setUserL1Access(c.env, targetId, body.l1Enabled);

  await writeAuditLog(c.env, c.get('user').id, 'USER_PERMISSIONS_UPDATE', targetId, body);
  const permissions = await getUserPermissions(c.env, targetId);
  return c.json({ ok: true, permissions });
});

adminRoutes.post('/users', async (c) => {
  const body = await c.req.json<{ name?: string; role?: 'admin' | 'user'; l1Enabled?: boolean }>();
  const name = body.name?.trim();
  if (!name) {
    return c.json({ error: 'name is required' }, 400);
  }
  if (name === ROOT_USER_NAME) {
    return c.json({ error: '名称 root 保留给首个管理员' }, 400);
  }

  const role = body.role === 'admin' ? 'admin' : 'user';
  const db = getDb(c.env);
  const userId = newId();
  const email = `${userId}@user.internal`;
  const ts = nowIso();

  await db.insert(users).values({
    id: userId,
    email,
    name,
    role,
    status: 'active',
    allowedGoogleEmail: '',
    allowedMicrosoftEmail: '',
    createdAt: ts,
    updatedAt: ts,
  });

  await setUserL1Access(c.env, userId, Boolean(body.l1Enabled));
  await writeAuditLog(c.env, c.get('user').id, 'USER_CREATE', userId, { name, role });

  return c.json({ ok: true, userId, name, role }, 201);
});

adminRoutes.get('/users/:id/passkeys', async (c) => {
  const userId = c.req.param('id');
  const db = getDb(c.env);
  const target = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!target) {
    return c.json({ error: 'User not found' }, 404);
  }

  const rows = await db
    .select({
      id: passkeys.id,
      deviceType: passkeys.deviceType,
      backedUp: passkeys.backedUp,
      createdAt: passkeys.createdAt,
      lastUsedAt: passkeys.lastUsedAt,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .all();

  return c.json({
    credentials: rows.map((r) => ({
      id: r.id,
      name: r.deviceType || 'Passkey',
      deviceType: r.deviceType,
      backedUp: Boolean(r.backedUp),
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    })),
  });
});

adminRoutes.post('/users/:id/passkeys/delegate', async (c) => {
  const userId = c.req.param('id');
  const db = getDb(c.env);
  const target = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!target) {
    return c.json({ error: 'User not found' }, 404);
  }

  const token = await createPasskeyDelegateToken(c.env, userId);
  const link = passkeyDelegateLink(c.env, token);
  await writeAuditLog(c.env, c.get('user').id, 'PASSKEY_DELEGATE_CREATE', userId, {});

  return c.json({
    token,
    link,
    expiresIn: PASSKEY_DELEGATE_TTL_SECONDS,
  });
});

adminRoutes.get('/clients', async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(clients).all();
  return c.json(
    rows.map((cl) => ({
      id: cl.id,
      clientId: cl.clientId,
      name: cl.name,
      accessMode: cl.accessMode,
      redirectUris: JSON.parse(cl.redirectUris) as string[],
      clientSecret: cl.clientSecret || null,
      enabled: Boolean(cl.enabled),
      createdAt: cl.createdAt,
      updatedAt: cl.updatedAt,
    })),
  );
});

adminRoutes.post('/clients', async (c) => {
  const body = await c.req.json<{
    clientId?: string;
    name?: string;
    accessMode?: 'L2_ONLY' | 'L1_AND_L2';
    enabled?: boolean;
  }>();

  const clientId = body.clientId?.trim();
  const name = body.name?.trim();
  if (!clientId || !name) {
    return c.json({ error: 'clientId and name are required' }, 400);
  }
  if (body.accessMode !== 'L2_ONLY' && body.accessMode !== 'L1_AND_L2') {
    return c.json({ error: 'Invalid accessMode' }, 400);
  }

  const db = getDb(c.env);
  const existing = await db.select().from(clients).where(eq(clients.clientId, clientId)).get();
  if (existing) {
    return c.json({ error: 'clientId already exists' }, 409);
  }

  const ts = nowIso();
  const id = newId();
  const clientSecret = newClientSecret();
  const clientSecretHash = await sha256Hex(clientSecret);
  await db.insert(clients).values({
    id,
    clientId,
    name,
    accessMode: body.accessMode!,
    redirectUris: '[]',
    clientSecretHash,
    clientSecret,
    enabled: body.enabled === false ? 0 : 1,
    createdAt: ts,
    updatedAt: ts,
  });

  await writeAuditLog(c.env, c.get('user').id, 'CLIENT_CREATE', id, { clientId, name });
  return c.json({ ok: true, id, clientId, clientSecret }, 201);
});

adminRoutes.patch('/clients/:clientId', async (c) => {
  const clientId = c.req.param('clientId');
  const body = await c.req.json<{
    name?: string;
    accessMode?: 'L2_ONLY' | 'L1_AND_L2';
    enabled?: boolean;
  }>();

  const db = getDb(c.env);
  const row = await db.select().from(clients).where(eq(clients.clientId, clientId)).get();
  if (!row) {
    return c.json({ error: 'Client not found' }, 404);
  }

  const ts = nowIso();
  await db
    .update(clients)
    .set({
      name: body.name?.trim() ?? row.name,
      accessMode:
        body.accessMode === 'L2_ONLY' || body.accessMode === 'L1_AND_L2'
          ? body.accessMode
          : row.accessMode,
      enabled: typeof body.enabled === 'boolean' ? (body.enabled ? 1 : 0) : row.enabled,
      updatedAt: ts,
    })
    .where(eq(clients.clientId, clientId));

  await writeAuditLog(c.env, c.get('user').id, 'CLIENT_UPDATE', row.id, body);
  return c.json({ ok: true });
});

adminRoutes.post('/clients/:clientId/regenerate-secret', async (c) => {
  const clientId = c.req.param('clientId');
  const db = getDb(c.env);
  const row = await db.select().from(clients).where(eq(clients.clientId, clientId)).get();
  if (!row) {
    return c.json({ error: 'Client not found' }, 404);
  }

  const clientSecret = newClientSecret();
  const clientSecretHash = await sha256Hex(clientSecret);
  const ts = nowIso();
  await db
    .update(clients)
    .set({ clientSecretHash, clientSecret, updatedAt: ts })
    .where(eq(clients.clientId, clientId));

  await writeAuditLog(c.env, c.get('user').id, 'CLIENT_SECRET_REGEN', row.id, { clientId });
  return c.json({ ok: true, clientId, clientSecret });
});

adminRoutes.delete('/clients/:clientId', async (c) => {
  const clientId = c.req.param('clientId');
  const db = getDb(c.env);
  const row = await db.select().from(clients).where(eq(clients.clientId, clientId)).get();
  if (!row) {
    return c.json({ error: 'Client not found' }, 404);
  }

  await db.delete(userClientAccess).where(eq(userClientAccess.clientId, clientId));
  await db.delete(clients).where(eq(clients.clientId, clientId));
  await writeAuditLog(c.env, c.get('user').id, 'CLIENT_DELETE', row.id, { clientId });
  return c.json({ ok: true });
});

adminRoutes.get('/clients/:clientId/users', async (c) => {
  const clientId = c.req.param('clientId');
  const db = getDb(c.env);
  const client = await db.select().from(clients).where(eq(clients.clientId, clientId)).get();
  if (!client) {
    return c.json({ error: 'Client not found' }, 404);
  }

  const allUsers = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.status, 'active'))
    .all();

  const accessRows = await db
    .select()
    .from(userClientAccess)
    .where(
      and(
        eq(userClientAccess.clientId, clientId),
        eq(userClientAccess.enabled, 0),
      ),
    )
    .all();
  const excludedIds = new Set(accessRows.map((r) => r.userId));

  const usersList = allUsers.map((u) => ({
    userId: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    excluded: excludedIds.has(u.id),
  }));

  return c.json({ clientId: client.clientId, clientName: client.name, users: usersList });
});

adminRoutes.put('/clients/:clientId/users', async (c) => {
  const clientId = c.req.param('clientId');
  const body = await c.req.json<{ entries: { userId: string; excluded: boolean }[] }>();
  const db = getDb(c.env);
  const client = await db.select().from(clients).where(eq(clients.clientId, clientId)).get();
  if (!client) {
    return c.json({ error: 'Client not found' }, 404);
  }

  const ts = nowIso();
  for (const entry of body.entries ?? []) {
    if (entry.excluded) {
      await db
        .insert(userClientAccess)
        .values({
          userId: entry.userId,
          clientId,
          enabled: 0,
          appRole: null,
          updatedAt: ts,
        })
        .onConflictDoUpdate({
          target: [userClientAccess.userId, userClientAccess.clientId],
          set: { enabled: 0, updatedAt: ts },
        });
    } else {
      await db
        .delete(userClientAccess)
        .where(
          and(
            eq(userClientAccess.userId, entry.userId),
            eq(userClientAccess.clientId, clientId),
          ),
        );
    }
  }

  await writeAuditLog(c.env, c.get('user').id, 'CLIENT_USERS_UPDATE', client.id, {
    clientId,
    entries: body.entries,
  });
  return c.json({ ok: true });
});

adminRoutes.post('/invites', async (c) => {
  const body = await c.req.json<{
    name?: string;
    role?: 'admin' | 'user';
    l1Enabled?: boolean;
  }>();

  const name = body.name?.trim();
  const role = body.role === 'admin' ? 'admin' : 'user';
  if (!name) {
    return c.json({ error: 'name is required' }, 400);
  }

  const db = getDb(c.env);
  const userId = newId();
  const email = `${userId}@invite.internal`;
  const ts = nowIso();
  await db.insert(users).values({
    id: userId,
    email,
    name,
    role,
    status: 'pending',
    createdAt: ts,
    updatedAt: ts,
  });

  await setUserL1Access(c.env, userId, Boolean(body.l1Enabled));

  const token = crypto.randomUUID().replace(/-/g, '');
  const inviteId = newId();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.insert(invites).values({
    id: inviteId,
    token,
    userId,
    expiresAt,
    usedAt: null,
    createdBy: c.get('user').id,
    createdAt: ts,
  });

  await writeAuditLog(c.env, c.get('user').id, 'INVITE_CREATE', userId, {
    name,
    l1Enabled: Boolean(body.l1Enabled),
  });

  const url = `${c.env.ORIGIN}/invite/${token}`;
  return c.json({ ok: true, url, token, expiresAt, userId });
});

adminRoutes.delete('/users/:id/passkeys/:pkId', async (c) => {
  const { id: userId, pkId } = c.req.param();
  const actor = c.get('user');
  const db = getDb(c.env);

  const pk = await db
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.id, pkId), eq(passkeys.userId, userId)))
    .get();
  if (!pk) {
    return c.json({ error: 'Passkey not found' }, 404);
  }

  await db.delete(passkeys).where(eq(passkeys.id, pkId));
  await writeAuditLog(c.env, actor.id, 'PASSKEY_DELETE', userId, { passkeyId: pkId });
  return c.json({ ok: true });
});

adminRoutes.get('/audit-logs', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .all();
  return c.json(rows);
});

adminRoutes.post('/system/reset', async (c) => {
  const body = await c.req.json<{ confirmation?: string }>();
  if (body.confirmation !== 'RESET_ALL_I_UNDERSTAND') {
    return c.json({ error: 'Confirmation required' }, 400);
  }

  const actor = c.get('user');
  const db = getDb(c.env);

  await writeAuditLog(c.env, actor.id, 'SYSTEM_RESET', null, {
    resetBy: actor.email,
    resetAt: nowIso(),
  });

  await db.delete(sessions);
  await db.delete(passkeys);
  await db.delete(invites);
  await db.delete(authCodes);
  await db.delete(accessTokens);
  await db.delete(userClientAccess);
  await db.delete(userL1Access);
  await db.delete(clients);
  await db.delete(users);
  await db.delete(auditLogs);
  await db.delete(oauthIdentities);
  await db.delete(settings);
  await db.delete(passkeyDelegateTokens);

  await db
    .update(systemConfig)
    .set({
      state: 'NEEDS_SETUP',
      registrationEnabled: 0,
      updatedAt: nowIso(),
    })
    .where(eq(systemConfig.id, 1));

  appendCookies(
    c,
    clearCookie(c.env, 'sid', '/'),
    clearCookie(c.env, 'setup_sid', '/api/setup'),
    clearCookie(c.env, 'reg_sid', '/api'),
  );

  return c.json({ ok: true, message: 'System reset' });
});

registerAdminOAuthRoutes(adminRoutes);
registerAdminBackupRoutes(adminRoutes);
