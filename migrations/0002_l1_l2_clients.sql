CREATE TABLE clients (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  access_mode  TEXT NOT NULL DEFAULT 'L2_ONLY'
                 CHECK (access_mode IN ('L2_ONLY', 'L1_AND_L2')),
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE user_l1_access (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE user_client_access (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id  TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  app_role   TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, client_id)
);

CREATE TABLE invites (
  id         TEXT PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_invites_token ON invites(token);
CREATE INDEX idx_user_client_access_client ON user_client_access(client_id);

-- Existing active users keep L1 access for backward compatibility.
INSERT INTO user_l1_access (user_id, enabled, updated_at)
SELECT id, 1, datetime('now') FROM users WHERE status = 'active';
