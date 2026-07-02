ALTER TABLE clients ADD COLUMN client_secret_hash TEXT NOT NULL DEFAULT '';

CREATE TABLE auth_codes (
  code         TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id    TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'openid profile',
  nonce        TEXT,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_auth_codes_expires ON auth_codes(expires_at);

CREATE TABLE access_tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id    TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  scope        TEXT NOT NULL DEFAULT 'openid profile',
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_access_tokens_user ON access_tokens(user_id);
CREATE INDEX idx_access_tokens_expires ON access_tokens(expires_at);
