import type { ReviewJob, ReviewComment } from "../github/types";
import type { Env } from "../index";
import { getInstallationToken } from "../github/auth";
import { getPRDiff, postReview } from "../github/api";
import { getSandboxForRepo, setupRepo } from "../sandbox/helpers";
import { composeSkills, extractChangedFiles } from "./skills/composer";
import { runAgentLoop, MODEL } from "./loop";
import type { ReviewResult, ReviewFinding, AgentTrace } from "./loop";
import {
  upsertInstallation,
  upsertRepo,
  insertReview,
  insertReviewTraces,
} from "../db/queries";

export async function executeReview(
  job: ReviewJob,
  env: Env,
): Promise<void> {
  const startTime = Date.now();
  let repoId: number | undefined;
  let setupDurationMs: number | undefined;
  let sandboxWarm: boolean | undefined;

  // Resolve repo in DB early so failures can be recorded
  try {
    const dbInstallationId = await upsertInstallation(env.DB, job.installationId);
    repoId = await upsertRepo(env.DB, job.repoFullName, dbInstallationId);
  } catch (dbErr) {
    console.error(
      `DB upsert failed for ${job.repoFullName} PR #${job.prNumber}:`,
      dbErr,
    );
  }

  const tag = `[review ${job.repoFullName}#${job.prNumber}]`;

  try {
    // 1. Auth
    console.log(`${tag} Getting installation token for installation=${job.installationId}`);
    const token = await getInstallationToken(
      env.GITHUB_APP_ID,
      env.GITHUB_PRIVATE_KEY,
      job.installationId,
    );
    console.log(`${tag} Token acquired`);

    // 2. Sandbox setup
    const sandbox = getSandboxForRepo(env.SANDBOX, job.repoFullName);
    console.log(`${tag} Setting up sandbox: ref=${job.headRef} sha=${job.headSha.slice(0, 7)}`);
    const setupResult = await setupRepo(sandbox, job.cloneUrl, job.headRef, job.headSha, token);
    setupDurationMs = setupResult.duration;
    sandboxWarm = !setupResult.cloned;
    console.log(
      `${tag} Sandbox ready: cloned=${setupResult.cloned} duration=${setupResult.duration}ms`,
    );

    // 3. Get PR diff
    const [owner, repo] = job.repoFullName.split("/");
    console.log(`${tag} Fetching PR diff`);
    const diff = await getPRDiff(token, owner, repo, job.prNumber);
    console.log(`${tag} Diff fetched: ${diff.length} chars`);
    const changedFiles = extractChangedFiles(diff);
    const diffStats = parseDiffStats(diff);

    // 4. Compose skills
    const composition = composeSkills(changedFiles, job);
    console.log(
      `${tag} Skills: active=[${composition.activeSkillNames.join(", ")}] ` +
        `tools=${composition.tools.length} skipped=${composition.skippedSkills.length}`,
    );

    // 5. Run agent loop
    const gatewayBaseUrl =
      env.CLOUDFLARE_ACCOUNT_ID && env.AI_GATEWAY_ID
        ? `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic`
        : undefined;

    const { review, trace } = await runAgentLoop(
      job,
      diff,
      sandbox,
      composition,
      env.ANTHROPIC_API_KEY,
      gatewayBaseUrl,
      changedFiles.length,
    );

    console.log(
      `${tag} Agent loop complete: verdict=${review.verdict} ` +
        `findings=${review.findings.length} iterations=${trace.iterationCount} ` +
        `tokens=${trace.totalInputTokens}+${trace.totalOutputTokens} ` +
        `duration=${trace.durationMs}ms`,
    );

    // 6. Persist to D1
    const promptHash = await hashString(composition.systemPrompt);
    await persistReview(env.DB, repoId, job, {
      status: "completed",
      review,
      trace,
      setupDurationMs,
      sandboxWarm,
      diffStats,
      activeSkillNames: [...composition.activeSkillNames],
      diff,
      systemPromptHash: promptHash,
    });

    // 7. Post review to GitHub
    const event = mapVerdictToEvent(review.verdict);
    const comments = mapFindingsToComments(review.findings);
    const body = formatReviewBody(review, composition, trace);

    await postReview(
      token,
      owner,
      repo,
      job.prNumber,
      body,
      comments,
      event,
      job.headSha,
    );

    console.log(
      `${tag} Posted to GitHub: event=${event} comments=${comments.length} ` +
        `total_duration=${Date.now() - startTime}ms`,
    );
  } catch (err) {
    // Record failure in DB — scrub secrets before storing
    const rawMessage = err instanceof Error ? err.message : String(err);
    await persistReview(env.DB, repoId, job, {
      status: "failed",
      errorMessage: scrubErrorMessage(rawMessage),
      durationMs: Date.now() - startTime,
      setupDurationMs,
      sandboxWarm,
    });

    // Re-throw so the queue handler can retry
    throw err;
  }
}

// --- Error scrubbing ---

/** Redact credentials from error messages before storing in DB. */
function scrubErrorMessage(message: string): string {
  return (
    message
      // URLs with embedded credentials: https://x-access-token:ghs_xxx@github.com
      .replace(/https?:\/\/[^@\s]*@/g, (match) =>
        match.replace(/\/\/.*@/, "//<REDACTED>@"),
      )
      // GitHub tokens: ghs_xxx, ghp_xxx, gho_xxx, github_pat_xxx
      .replace(/\b(ghs|ghp|gho|github_pat)_[A-Za-z0-9_]+/g, "$1_<REDACTED>")
      // Anthropic API keys: sk-ant-xxx
      .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "sk-ant-<REDACTED>")
      // Generic bearer tokens in headers
      .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer <REDACTED>")
  );
}

// --- Helpers ---

async function hashString(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

// --- DB persistence ---

interface PersistCompletedParams {
  status: "completed";
  review: ReviewResult;
  trace: AgentTrace;
  setupDurationMs?: number;
  sandboxWarm?: boolean;
  diffStats?: DiffStats;
  activeSkillNames?: string[];
  diff?: string;
  systemPromptHash?: string;
}

interface PersistFailedParams {
  status: "failed";
  errorMessage: string;
  durationMs: number;
  setupDurationMs?: number;
  sandboxWarm?: boolean;
}

async function persistReview(
  db: D1Database,
  repoId: number | undefined,
  job: ReviewJob,
  params: PersistCompletedParams | PersistFailedParams,
): Promise<void> {
  if (repoId == null) return; // DB upsert failed earlier, nothing to write to

  try {
    if (params.status === "completed") {
      const reviewId = await insertReview(db, {
        repoId,
        prNumber: job.prNumber,
        prTitle: job.prTitle,
        prBody: job.prBody,
        prAuthor: job.prAuthor,
        headSha: job.headSha,
        headRef: job.headRef,
        baseSha: job.baseSha,
        baseRef: job.baseRef,
        status: "completed",
        verdict: params.review.verdict,
        summary: params.review.summary,
        findingsJson: JSON.stringify(params.review.findings),
        model: MODEL,
        inputTokens: params.trace.totalInputTokens,
        outputTokens: params.trace.totalOutputTokens,
        durationMs: params.trace.durationMs,
        setupDurationMs: params.setupDurationMs,
        sandboxWarm: params.sandboxWarm,
        filesChanged: params.diffStats?.filesChanged,
        linesAdded: params.diffStats?.linesAdded,
        linesRemoved: params.diffStats?.linesRemoved,
        activeSkillsJson: params.activeSkillNames
          ? JSON.stringify(params.activeSkillNames)
          : undefined,
        diffText: params.diff,
        systemPromptHash: params.systemPromptHash,
      });
      await insertReviewTraces(db, reviewId, params.trace.turns);
      console.log(`DB write: review_id=${reviewId} traces=${params.trace.turns.length}`);
    } else {
      await insertReview(db, {
        repoId,
        prNumber: job.prNumber,
        prTitle: job.prTitle,
        prBody: job.prBody,
        prAuthor: job.prAuthor,
        headSha: job.headSha,
        headRef: job.headRef,
        baseSha: job.baseSha,
        baseRef: job.baseRef,
        status: "failed",
        errorMessage: params.errorMessage,
        model: MODEL,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: params.durationMs,
        setupDurationMs: params.setupDurationMs,
        sandboxWarm: params.sandboxWarm,
      });
      console.log(`DB write: recorded failed review for PR #${job.prNumber}`);
    }
  } catch (dbErr) {
    console.error(
      `DB write failed for ${job.repoFullName} PR #${job.prNumber}:`,
      dbErr,
    );
  }
}

// --- Diff stats ---

interface DiffStats {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

function parseDiffStats(diff: string): DiffStats {
  let filesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      filesChanged++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      linesAdded++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      linesRemoved++;
    }
  }

  return { filesChanged, linesAdded, linesRemoved };
}

// --- GitHub helpers ---

function mapVerdictToEvent(
  verdict: ReviewResult["verdict"],
): "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
  switch (verdict) {
    case "approve":
      return "APPROVE";
    case "request_changes":
      return "REQUEST_CHANGES";
    case "comment":
      return "COMMENT";
  }
}

function mapFindingsToComments(findings: ReviewFinding[]): ReviewComment[] {
  return findings
    .filter((f) => f.path && f.line)
    .map((f) => ({
      path: f.path,
      line: f.line,
      start_line: f.end_line && f.end_line !== f.line ? f.line : undefined,
      side: "RIGHT" as const,
      body: `**${severityLabel(f.severity)} ${f.title}** _(${f.skill})_\n\n${f.body}`,
    }));
}

function severityLabel(severity: ReviewFinding["severity"]): string {
  switch (severity) {
    case "critical":
      return "[CRITICAL]";
    case "warning":
      return "[WARNING]";
    case "suggestion":
      return "[SUGGESTION]";
    case "note":
      return "[NOTE]";
  }
}

function formatReviewBody(
  review: ReviewResult,
  composition: ReturnType<typeof composeSkills>,
  trace: { iterationCount: number; totalInputTokens: number; totalOutputTokens: number; durationMs: number },
): string {
  const skillsList = composition.activeSkillNames
    .map((name) => `- ${name}`)
    .join("\n");

  const stats = [
    `${trace.iterationCount} iterations`,
    `${trace.totalInputTokens + trace.totalOutputTokens} tokens`,
    `${(trace.durationMs / 1000).toFixed(1)}s`,
  ].join(" | ");

  return `## Code Refinery Review

${review.summary}

### Review Dimensions
${skillsList}

### Findings: ${review.findings.length}
- Critical: ${review.findings.filter((f) => f.severity === "critical").length}
- Warning: ${review.findings.filter((f) => f.severity === "warning").length}
- Suggestion: ${review.findings.filter((f) => f.severity === "suggestion").length}
- Note: ${review.findings.filter((f) => f.severity === "note").length}

---
_${stats}_`;
}
