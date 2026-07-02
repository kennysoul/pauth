import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

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
  allowedGoogleEmail: text('allowed_google_email').notNull().default(''),
  allowedMicrosoftEmail: text('allowed_microsoft_email').notNull().default(''),
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

export const clients = sqliteTable('clients', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull().unique(),
  name: text('name').notNull(),
  accessMode: text('access_mode').notNull(),
  redirectUris: text('redirect_uris').notNull(),
  clientSecretHash: text('client_secret_hash').notNull(),
  clientSecret: text('client_secret').notNull(),
  enabled: integer('enabled').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const userL1Access = sqliteTable('user_l1_access', {
  userId: text('user_id').primaryKey(),
  enabled: integer('enabled').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const userClientAccess = sqliteTable(
  'user_client_access',
  {
    userId: text('user_id').notNull(),
    clientId: text('client_id').notNull(),
    enabled: integer('enabled').notNull(),
    appRole: text('app_role'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.clientId] })],
);

export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  userId: text('user_id').notNull(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  createdBy: text('created_by'),
  createdAt: text('created_at').notNull(),
});

export const authCodes = sqliteTable('auth_codes', {
  code: text('code').primaryKey(),
  userId: text('user_id').notNull(),
  clientId: text('client_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  scope: text('scope').notNull(),
  nonce: text('nonce'),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  createdAt: text('created_at').notNull(),
});

export const accessTokens = sqliteTable('access_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull(),
  clientId: text('client_id').notNull(),
  scope: text('scope').notNull(),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const oauthIdentities = sqliteTable('oauth_identities', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(),
  providerSubject: text('provider_subject').notNull(),
  email: text('email').notNull(),
  emailVerified: integer('email_verified').notNull(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const passkeyDelegateTokens = sqliteTable('passkey_delegate_tokens', {
  token: text('token').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
});
