CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE users ADD COLUMN allowed_google_email TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN allowed_microsoft_email TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS oauth_identities (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  provider_subject  TEXT NOT NULL,
  email             TEXT NOT NULL DEFAULT '',
  email_verified    INTEGER NOT NULL DEFAULT 0,
  display_name      TEXT NOT NULL DEFAULT '',
  avatar_url        TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_subject),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_users_allowed_google_email ON users(allowed_google_email);
CREATE INDEX IF NOT EXISTS idx_users_allowed_microsoft_email ON users(allowed_microsoft_email);
