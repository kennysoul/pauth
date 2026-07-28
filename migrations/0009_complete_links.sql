CREATE TABLE complete_links (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  used_at TEXT,
  voided_at TEXT,
  expires_at TEXT NOT NULL,
  open_count INTEGER NOT NULL DEFAULT 0,
  max_opens INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_complete_links_token ON complete_links(token);