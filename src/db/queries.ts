import type { AgentTurn } from "../agent/loop";

// --- Row types ---

export interface DbInstallation {
  id: number;
  github_installation_id: number;
  user_id: number | null;
  status: string;
  created_at: string;
}

export interface DbRepo {
  id: number;
  installation_id: number;
  full_name: string;
  enabled: number;
  settings_json: string | null;
  created_at: string;
}

export interface DbReview {
  id: number;
  repo_id: number;
  pr_number: number;
  pr_title: string;
  pr_body: string | null;
  pr_author: string;
  head_sha: string;
  head_ref: string;
  base_sha: string;
  base_ref: string;
  status: string;
  error_message: string | null;
  verdict: string | null;
  summary: string | null;
  findings_json: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  setup_duration_ms: number | null;
  sandbox_warm: number | null;
  files_changed: number | null;
  lines_added: number | null;
  lines_removed: number | null;
  active_skills_json: string | null;
  created_at: string;
}

export interface DbReviewTrace {
  id: number;
  review_id: number;
  turn_number: number;
  role: string;
  content_json: string;
  tool_name: string | null;
  tokens_used: number | null;
}

// --- Write queries ---

export async function upsertInstallation(
  db: D1Database,
  githubInstallationId: number,
): Promise<number> {
  const existing = await db
    .prepare("SELECT id FROM installations WHERE github_installation_id = ?")
    .bind(githubInstallationId)
    .first<{ id: number }>();

  if (existing) return existing.id;

  try {
    const result = await db
      .prepare(
        "INSERT INTO installations (github_installation_id, status) VALUES (?, 'active')",
      )
      .bind(githubInstallationId)
      .run();
    return result.meta.last_row_id as number;
  } catch {
    // UNIQUE constraint race — another request inserted between our SELECT and INSERT
    const row = await db
      .prepare("SELECT id FROM installations WHERE github_installation_id = ?")
      .bind(githubInstallationId)
      .first<{ id: number }>();
    if (row) return row.id;
    throw new Error(`Failed to upsert installation ${githubInstallationId}`);
  }
}

export async function upsertRepo(
  db: D1Database,
  fullName: string,
  installationId: number,
): Promise<number> {
  const existing = await db
    .prepare("SELECT id FROM repos WHERE full_name = ?")
    .bind(fullName)
    .first<{ id: number }>();

  if (existing) return existing.id;

  try {
    const result = await db
      .prepare(
        "INSERT INTO repos (installation_id, full_name, enabled) VALUES (?, ?, 1)",
      )
      .bind(installationId, fullName)
      .run();
    return result.meta.last_row_id as number;
  } catch {
    // UNIQUE constraint race — another request inserted between our SELECT and INSERT
    const row = await db
      .prepare("SELECT id FROM repos WHERE full_name = ?")
      .bind(fullName)
      .first<{ id: number }>();
    if (row) return row.id;
    throw new Error(`Failed to upsert repo ${fullName}`);
  }
}

export interface InsertReviewParams {
  repoId: number;
  prNumber: number;
  prTitle: string;
  prBody: string | null;
  prAuthor: string;
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  status: "completed" | "failed";
  errorMessage?: string;
  verdict?: string;
  summary?: string;
  findingsJson?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  setupDurationMs?: number;
  sandboxWarm?: boolean;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  activeSkillsJson?: string;
}

export async function insertReview(
  db: D1Database,
  params: InsertReviewParams,
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO reviews (
        repo_id, pr_number, pr_title, pr_body, pr_author,
        head_sha, head_ref, base_sha, base_ref,
        status, error_message, verdict, summary, findings_json,
        model, input_tokens, output_tokens, duration_ms,
        setup_duration_ms, sandbox_warm,
        files_changed, lines_added, lines_removed,
        active_skills_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.repoId,
      params.prNumber,
      params.prTitle,
      params.prBody,
      params.prAuthor,
      params.headSha,
      params.headRef,
      params.baseSha,
      params.baseRef,
      params.status,
      params.errorMessage ?? null,
      params.verdict ?? null,
      params.summary ?? null,
      params.findingsJson ?? null,
      params.model,
      params.inputTokens,
      params.outputTokens,
      params.durationMs,
      params.setupDurationMs ?? null,
      params.sandboxWarm != null ? (params.sandboxWarm ? 1 : 0) : null,
      params.filesChanged ?? null,
      params.linesAdded ?? null,
      params.linesRemoved ?? null,
      params.activeSkillsJson ?? null,
    )
    .run();

  return result.meta.last_row_id as number;
}

export async function insertReviewTraces(
  db: D1Database,
  reviewId: number,
  turns: AgentTurn[],
): Promise<void> {
  if (turns.length === 0) return;

  const statements = turns.map((turn) =>
    db
      .prepare(
        `INSERT INTO review_traces (
          review_id, turn_number, role, content_json, tool_name, tokens_used
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        reviewId,
        turn.turnNumber,
        turn.role,
        JSON.stringify({
          content: turn.content,
          toolInput: turn.toolInput,
          toolResult: turn.toolResult,
        }),
        turn.toolName ?? null,
        turn.inputTokens != null && turn.outputTokens != null
          ? turn.inputTokens + turn.outputTokens
          : null,
      ),
  );

  await db.batch(statements);
}

// --- Job dedup & rate limiting ---

const MAX_REVIEWS_PER_REPO_PER_HOUR = 50;

export interface DedupResult {
  allowed: boolean;
  reason?: "duplicate_sha" | "rate_limited" | "repo_disabled";
}

/**
 * Three-layer gate that runs before enqueuing a review job:
 *   1. Repo enabled check — skip disabled repos
 *   2. SHA dedup — exact (repo, PR, sha) already seen → skip
 *   3. Repo rate limit — too many jobs in the last hour → 429
 *
 * If allowed, also supersedes any pending jobs for the same PR (debounce).
 * All queries run in a single batch for one D1 round-trip.
 */
export async function tryEnqueueJob(
  db: D1Database,
  repoFullName: string,
  prNumber: number,
  headSha: string,
): Promise<DedupResult> {
  // 1. Check repo is enabled
  const repo = await db
    .prepare("SELECT enabled FROM repos WHERE full_name = ?")
    .bind(repoFullName)
    .first<{ enabled: number }>();

  // If repo not in DB yet, allow (it'll be upserted during executeReview)
  if (repo && !repo.enabled) {
    return { allowed: false, reason: "repo_disabled" };
  }

  // 2. SHA dedup — try to insert; UNIQUE constraint will reject duplicates
  try {
    await db
      .prepare(
        "INSERT INTO job_dedup (repo_full_name, pr_number, head_sha, status) VALUES (?, ?, ?, 'queued')",
      )
      .bind(repoFullName, prNumber, headSha)
      .run();
  } catch {
    // UNIQUE violation → already enqueued this exact sha
    return { allowed: false, reason: "duplicate_sha" };
  }

  // 3. Repo rate limit — count jobs in the last hour (including the one we just inserted)
  const count = await db
    .prepare(
      "SELECT COUNT(*) as cnt FROM job_dedup WHERE repo_full_name = ? AND created_at > datetime('now', '-1 hour')",
    )
    .bind(repoFullName)
    .first<{ cnt: number }>();

  if (count && count.cnt > MAX_REVIEWS_PER_REPO_PER_HOUR) {
    // Over limit — mark the row we just inserted as failed so it doesn't count next time
    await db
      .prepare(
        "UPDATE job_dedup SET status = 'failed' WHERE repo_full_name = ? AND pr_number = ? AND head_sha = ?",
      )
      .bind(repoFullName, prNumber, headSha)
      .run();
    return { allowed: false, reason: "rate_limited" };
  }

  // 4. Debounce — supersede any older pending jobs for this same PR
  await db
    .prepare(
      "UPDATE job_dedup SET status = 'superseded' WHERE repo_full_name = ? AND pr_number = ? AND status = 'queued' AND head_sha != ?",
    )
    .bind(repoFullName, prNumber, headSha)
    .run();

  return { allowed: true };
}

/**
 * Check if a job has been superseded by a newer push to the same PR.
 * Called by the queue consumer before starting the expensive agent loop.
 */
export async function isJobSuperseded(
  db: D1Database,
  repoFullName: string,
  prNumber: number,
  headSha: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT status FROM job_dedup WHERE repo_full_name = ? AND pr_number = ? AND head_sha = ?",
    )
    .bind(repoFullName, prNumber, headSha)
    .first<{ status: string }>();

  // No row = enqueued before dedup table existed; allow it
  if (!row) return false;

  return row.status === "superseded";
}

/**
 * Mark a job as processing (called when consumer starts working on it).
 */
export async function markJobProcessing(
  db: D1Database,
  repoFullName: string,
  prNumber: number,
  headSha: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE job_dedup SET status = 'processing' WHERE repo_full_name = ? AND pr_number = ? AND head_sha = ?",
    )
    .bind(repoFullName, prNumber, headSha)
    .run();
}

/**
 * Mark a job as done or failed (called after consumer finishes).
 */
export async function markJobDone(
  db: D1Database,
  repoFullName: string,
  prNumber: number,
  headSha: string,
  status: "done" | "failed",
): Promise<void> {
  await db
    .prepare(
      "UPDATE job_dedup SET status = ? WHERE repo_full_name = ? AND pr_number = ? AND head_sha = ?",
    )
    .bind(status, repoFullName, prNumber, headSha)
    .run();
}

// --- Read queries (for Phase 7 dashboard) ---

export async function getReviewsByRepo(
  db: D1Database,
  repoId: number,
  limit = 50,
): Promise<DbReview[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM reviews WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .bind(repoId, limit)
    .all<DbReview>();

  return results;
}

export async function getReviewById(
  db: D1Database,
  reviewId: number,
): Promise<DbReview | null> {
  return db
    .prepare("SELECT * FROM reviews WHERE id = ?")
    .bind(reviewId)
    .first<DbReview>();
}

export async function getReviewTraces(
  db: D1Database,
  reviewId: number,
): Promise<DbReviewTrace[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM review_traces WHERE review_id = ? ORDER BY turn_number ASC",
    )
    .bind(reviewId)
    .all<DbReviewTrace>();

  return results;
}

export async function getRepoByFullName(
  db: D1Database,
  fullName: string,
): Promise<DbRepo | null> {
  return db
    .prepare("SELECT * FROM repos WHERE full_name = ?")
    .bind(fullName)
    .first<DbRepo>();
}

export async function getRepoSettings(
  db: D1Database,
  repoId: number,
): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare("SELECT settings_json FROM repos WHERE id = ?")
    .bind(repoId)
    .first<{ settings_json: string | null }>();

  if (!row?.settings_json) return null;

  try {
    return JSON.parse(row.settings_json);
  } catch {
    return null;
  }
}
