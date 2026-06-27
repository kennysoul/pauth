import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const systemConfig = sqliteTable('system_config', {
  id: integer('id').primaryKey(),
  state: text('state').notNull(),
  registrationEnabled: integer('registration_enabled').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const passkeys = sqliteTable('passkeys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull(),
  deviceType: text('device_type'),
  backedUp: integer('backed_up').notNull(),
  transports: text('transports'),
  aaguid: text('aaguid'),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  kind: text('kind').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
});

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  targetId: text('target_id'),
  detail: text('detail'),
  createdAt: text('created_at').notNull(),
});
