CREATE TABLE system_config (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  state                TEXT NOT NULL DEFAULT 'NEEDS_SETUP'
                         CHECK (state IN ('NEEDS_SETUP', 'ACTIVE')),
  registration_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO system_config (id) VALUES (1);

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'user'
               CHECK (role IN ('admin', 'user')),
  status     TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_role   ON users(role);

CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key    TEXT NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  device_type   TEXT,
  backed_up     INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  aaguid        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT
);
CREATE INDEX idx_passkeys_user_id ON passkeys(user_id);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'normal'
               CHECK (kind IN ('normal', 'setup', 'register')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE audit_logs (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  target_id  TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
