-- M:N join table for users <-> installations
-- Replaces the singular installations.user_id column
CREATE TABLE IF NOT EXISTS user_installations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, installation_id)
);
