export const SCHEMA_V1 = `
-- users: GitHub OAuth users (Phase 7)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- installations: GitHub App installations
CREATE TABLE IF NOT EXISTS installations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_installation_id INTEGER NOT NULL UNIQUE,
  user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_installations_github_id ON installations(github_installation_id);

-- repos: repositories enabled for review
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id INTEGER NOT NULL,
  full_name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  settings_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (installation_id) REFERENCES installations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_repos_full_name ON repos(full_name);
CREATE INDEX IF NOT EXISTS idx_repos_installation ON repos(installation_id);

-- reviews: PR review results (completed and failed)
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_title TEXT NOT NULL,
  pr_body TEXT,
  pr_author TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL,
  head_ref TEXT NOT NULL DEFAULT '',
  base_sha TEXT NOT NULL DEFAULT '',
  base_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'completed',
  error_message TEXT,
  verdict TEXT,
  summary TEXT,
  findings_json TEXT,
  model TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  setup_duration_ms INTEGER,
  sandbox_warm INTEGER,
  files_changed INTEGER,
  lines_added INTEGER,
  lines_removed INTEGER,
  active_skills_json TEXT,
  diff_text TEXT,
  system_prompt_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reviews_repo_pr ON reviews(repo_id, pr_number);
CREATE INDEX IF NOT EXISTS idx_reviews_created ON reviews(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);

-- review_traces: agent loop turns for observability
CREATE TABLE IF NOT EXISTS review_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL,
  turn_number INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  tool_name TEXT,
  tool_input TEXT,
  tool_result TEXT,
  tokens_used INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  iteration INTEGER,
  FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_traces_review ON review_traces(review_id, turn_number);

-- sessions: GitHub OAuth sessions (Phase 7)
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- job_dedup: rate limiting, SHA dedup, and PR debounce
CREATE TABLE IF NOT EXISTS job_dedup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo_full_name, pr_number, head_sha)
);
CREATE INDEX IF NOT EXISTS idx_dedup_repo_created ON job_dedup(repo_full_name, created_at);
CREATE INDEX IF NOT EXISTS idx_dedup_pr_status ON job_dedup(repo_full_name, pr_number, status);
CREATE INDEX IF NOT EXISTS idx_dedup_lookup ON job_dedup(repo_full_name, head_sha, status);

-- user_installations: M:N join table for users <-> installations
CREATE TABLE IF NOT EXISTS user_installations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, installation_id)
);
`;
