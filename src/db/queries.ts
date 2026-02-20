import type { AgentTurn } from "../agent/loop";

// --- Row types ---

export interface DbUser {
  id: number;
  github_id: number;
  github_login: string;
  avatar_url: string | null;
  created_at: string;
}

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
  diff_text: string | null;
  system_prompt_hash: string | null;
  created_at: string;
}

export interface DbReviewTrace {
  id: number;
  review_id: number;
  turn_number: number;
  role: string;
  content_json: string;
  tool_name: string | null;
  tool_input: string | null;
  tool_result: string | null;
  tokens_used: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  iteration: number | null;
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
  diffText?: string;
  systemPromptHash?: string;
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
        active_skills_json, diff_text, system_prompt_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      params.diffText ?? null,
      params.systemPromptHash ?? null,
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
          review_id, turn_number, role, content_json, tool_name,
          tool_input, tool_result,
          tokens_used, input_tokens, output_tokens, iteration
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        reviewId,
        turn.turnNumber,
        turn.role,
        JSON.stringify({ content: turn.content }),
        turn.toolName ?? null,
        turn.toolInput ?? null,
        turn.toolResult ?? null,
        turn.inputTokens != null && turn.outputTokens != null
          ? turn.inputTokens + turn.outputTokens
          : null,
        turn.inputTokens ?? null,
        turn.outputTokens ?? null,
        turn.iteration,
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

// --- User queries ---

export async function upsertUser(
  db: D1Database,
  githubId: number,
  githubLogin: string,
  avatarUrl: string | null,
): Promise<number> {
  const existing = await db
    .prepare("SELECT id, github_login, avatar_url FROM users WHERE github_id = ?")
    .bind(githubId)
    .first<{ id: number; github_login: string; avatar_url: string | null }>();

  if (existing) {
    // Update login/avatar if changed
    if (existing.github_login !== githubLogin || existing.avatar_url !== avatarUrl) {
      await db
        .prepare("UPDATE users SET github_login = ?, avatar_url = ? WHERE id = ?")
        .bind(githubLogin, avatarUrl, existing.id)
        .run();
    }
    return existing.id;
  }

  try {
    const result = await db
      .prepare(
        "INSERT INTO users (github_id, github_login, avatar_url) VALUES (?, ?, ?)",
      )
      .bind(githubId, githubLogin, avatarUrl)
      .run();
    return result.meta.last_row_id as number;
  } catch {
    // UNIQUE constraint race
    const row = await db
      .prepare("SELECT id FROM users WHERE github_id = ?")
      .bind(githubId)
      .first<{ id: number }>();
    if (row) return row.id;
    throw new Error(`Failed to upsert user ${githubId}`);
  }
}

// --- Session queries ---

export async function createSession(
  db: D1Database,
  userId: number,
  tokenHash: string,
  expiresAt: string,
): Promise<number> {
  const result = await db
    .prepare(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    )
    .bind(userId, tokenHash, expiresAt)
    .run();
  return result.meta.last_row_id as number;
}

export interface SessionWithUser {
  sessionId: number;
  userId: number;
  githubId: number;
  githubLogin: string;
  avatarUrl: string | null;
}

export async function getSessionWithUser(
  db: D1Database,
  tokenHash: string,
): Promise<SessionWithUser | null> {
  const row = await db
    .prepare(
      `SELECT s.id as session_id, u.id as user_id, u.github_id, u.github_login, u.avatar_url
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
    )
    .bind(tokenHash)
    .first<{
      session_id: number;
      user_id: number;
      github_id: number;
      github_login: string;
      avatar_url: string | null;
    }>();

  if (!row) return null;

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    githubId: row.github_id,
    githubLogin: row.github_login,
    avatarUrl: row.avatar_url,
  };
}

export async function deleteSession(
  db: D1Database,
  tokenHash: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .run();
}

export async function deleteExpiredSessions(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM sessions WHERE expires_at < datetime('now')")
    .run();
}

// --- User-installation linking (M:N) ---

export async function linkInstallationsToUser(
  db: D1Database,
  userId: number,
  githubInstallationIds: number[],
): Promise<void> {
  if (githubInstallationIds.length === 0) return;

  const statements = githubInstallationIds.map((ghInstId) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO user_installations (user_id, installation_id)
         SELECT ?, id FROM installations WHERE github_installation_id = ?`,
      )
      .bind(userId, ghInstId),
  );

  await db.batch(statements);
}

// --- Installation IDs for user ---

export async function getInstallationIdsForUser(
  db: D1Database,
  userId: number,
): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT i.github_installation_id
       FROM installations i
       JOIN user_installations ui ON ui.installation_id = i.id
       WHERE ui.user_id = ? AND i.status = 'active'`,
    )
    .bind(userId)
    .all<{ github_installation_id: number }>();

  return results.map((r) => r.github_installation_id);
}

// --- Repos for user (via user_installations join table) ---

export interface DbRepoWithInstallation extends DbRepo {
  installation_github_id: number;
}

export async function getReposForUser(
  db: D1Database,
  userId: number,
): Promise<DbRepoWithInstallation[]> {
  const { results } = await db
    .prepare(
      `SELECT r.*, i.github_installation_id as installation_github_id
       FROM repos r
       JOIN installations i ON r.installation_id = i.id
       JOIN user_installations ui ON ui.installation_id = i.id
       WHERE ui.user_id = ?
       ORDER BY r.full_name`,
    )
    .bind(userId)
    .all<DbRepoWithInstallation>();

  return results;
}

// --- Paginated reviews ---

export interface PaginatedResult<T> {
  rows: T[];
  total: number;
}

export async function getReviewsPaginated(
  db: D1Database,
  params: { repoId?: number; userId: number; page: number; limit: number },
): Promise<PaginatedResult<DbReview>> {
  const offset = (params.page - 1) * params.limit;

  if (params.repoId) {
    // Filter by specific repo (ownership already verified by caller)
    const [countResult, dataResult] = await db.batch([
      db
        .prepare("SELECT COUNT(*) as cnt FROM reviews WHERE repo_id = ?")
        .bind(params.repoId),
      db
        .prepare(
          "SELECT * FROM reviews WHERE repo_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        )
        .bind(params.repoId, params.limit, offset),
    ]);

    const total = (countResult.results[0] as { cnt: number }).cnt;
    const rows = dataResult.results as unknown as DbReview[];
    return { rows, total };
  }

  // All reviews for user's repos
  const [countResult, dataResult] = await db.batch([
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM reviews rv
         JOIN repos r ON rv.repo_id = r.id
         JOIN user_installations ui ON ui.installation_id = r.installation_id
         WHERE ui.user_id = ?`,
      )
      .bind(params.userId),
    db
      .prepare(
        `SELECT rv.* FROM reviews rv
         JOIN repos r ON rv.repo_id = r.id
         JOIN user_installations ui ON ui.installation_id = r.installation_id
         WHERE ui.user_id = ?
         ORDER BY rv.created_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(params.userId, params.limit, offset),
  ]);

  const total = (countResult.results[0] as { cnt: number }).cnt;
  const rows = dataResult.results as unknown as DbReview[];
  return { rows, total };
}

// --- Repo settings updates ---

export async function updateRepoSettings(
  db: D1Database,
  repoId: number,
  settingsJson: string,
): Promise<void> {
  await db
    .prepare("UPDATE repos SET settings_json = ? WHERE id = ?")
    .bind(settingsJson, repoId)
    .run();
}

export async function updateRepoEnabled(
  db: D1Database,
  repoId: number,
  enabled: boolean,
): Promise<void> {
  await db
    .prepare("UPDATE repos SET enabled = ? WHERE id = ?")
    .bind(enabled ? 1 : 0, repoId)
    .run();
}

// --- Ownership verification ---

export async function verifyUserOwnsRepo(
  db: D1Database,
  userId: number,
  repoId: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM repos r
       JOIN user_installations ui ON ui.installation_id = r.installation_id
       WHERE r.id = ? AND ui.user_id = ?`,
    )
    .bind(repoId, userId)
    .first();

  return row !== null;
}

export async function verifyUserOwnsReview(
  db: D1Database,
  userId: number,
  reviewId: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM reviews rv
       JOIN repos r ON rv.repo_id = r.id
       JOIN user_installations ui ON ui.installation_id = r.installation_id
       WHERE rv.id = ? AND ui.user_id = ?`,
    )
    .bind(reviewId, userId)
    .first();

  return row !== null;
}

// --- Usage stats ---

export interface UsageStats {
  totalReviews: number;
  completedReviews: number;
  failedReviews: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  avgDurationMs: number;
  reviewsByDay: Array<{ date: string; count: number }>;
  reviewsByRepo: Array<{ repoName: string; count: number }>;
}

export async function getUsageStats(
  db: D1Database,
  userId: number,
  periodDays: number,
): Promise<UsageStats> {
  const sinceDate = `datetime('now', '-${Math.min(periodDays, 365)} days')`;

  const [summaryResult, byDayResult, byRepoResult] = await db.batch([
    db
      .prepare(
        `SELECT
           COUNT(*) as total_reviews,
           SUM(CASE WHEN rv.status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN rv.status = 'failed' THEN 1 ELSE 0 END) as failed,
           COALESCE(SUM(rv.input_tokens), 0) as input_tokens,
           COALESCE(SUM(rv.output_tokens), 0) as output_tokens,
           COALESCE(SUM(rv.duration_ms), 0) as total_duration,
           COALESCE(AVG(rv.duration_ms), 0) as avg_duration
         FROM reviews rv
         JOIN repos r ON rv.repo_id = r.id
         JOIN user_installations ui ON ui.installation_id = r.installation_id
         WHERE ui.user_id = ? AND rv.created_at > ${sinceDate}`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT date(rv.created_at) as date, COUNT(*) as count
         FROM reviews rv
         JOIN repos r ON rv.repo_id = r.id
         JOIN user_installations ui ON ui.installation_id = r.installation_id
         WHERE ui.user_id = ? AND rv.created_at > ${sinceDate}
         GROUP BY date(rv.created_at)
         ORDER BY date ASC`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT r.full_name as repo_name, COUNT(*) as count
         FROM reviews rv
         JOIN repos r ON rv.repo_id = r.id
         JOIN user_installations ui ON ui.installation_id = r.installation_id
         WHERE ui.user_id = ? AND rv.created_at > ${sinceDate}
         GROUP BY r.full_name
         ORDER BY count DESC`,
      )
      .bind(userId),
  ]);

  const summary = summaryResult.results[0] as {
    total_reviews: number;
    completed: number;
    failed: number;
    input_tokens: number;
    output_tokens: number;
    total_duration: number;
    avg_duration: number;
  };

  return {
    totalReviews: summary.total_reviews,
    completedReviews: summary.completed,
    failedReviews: summary.failed,
    totalInputTokens: summary.input_tokens,
    totalOutputTokens: summary.output_tokens,
    totalDurationMs: summary.total_duration,
    avgDurationMs: Math.round(summary.avg_duration),
    reviewsByDay: byDayResult.results as unknown as Array<{
      date: string;
      count: number;
    }>,
    reviewsByRepo: byRepoResult.results as unknown as Array<{
      repoName: string;
      count: number;
    }>,
  };
}
