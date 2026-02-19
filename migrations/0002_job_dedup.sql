-- Migration: job_dedup
-- Created: 2026-02-19
-- Purpose: Rate limiting, SHA dedup, and PR debounce for webhook handler

CREATE TABLE IF NOT EXISTS job_dedup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued, superseded, processing, done, failed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo_full_name, pr_number, head_sha)
);

-- Rate limiting: count recent jobs per repo
CREATE INDEX IF NOT EXISTS idx_dedup_repo_created ON job_dedup(repo_full_name, created_at);

-- Debounce: find pending jobs for same PR to supersede
CREATE INDEX IF NOT EXISTS idx_dedup_pr_status ON job_dedup(repo_full_name, pr_number, status);

-- Consumer lookup: check status before processing
CREATE INDEX IF NOT EXISTS idx_dedup_lookup ON job_dedup(repo_full_name, head_sha, status);
