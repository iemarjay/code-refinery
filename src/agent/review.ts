import type { Sandbox } from "@cloudflare/sandbox";
import type { ReviewJob, ReviewComment } from "../github/types";
import type { Env } from "../index";
import { getInstallationToken } from "../github/auth";
import { getPRDiff, postReview } from "../github/api";
import { getSandboxForRepo, setupRepo } from "../sandbox/helpers";
import { composeSkills, extractChangedFiles } from "./skills/composer";
import { runAgentLoop } from "./loop";
import type { ReviewResult, ReviewFinding } from "./loop";

export async function executeReview(
  job: ReviewJob,
  env: Env,
): Promise<void> {
  // 1. Auth
  const token = await getInstallationToken(
    env.GITHUB_APP_ID,
    env.GITHUB_PRIVATE_KEY,
    job.installationId,
  );

  // 2. Sandbox setup
  const sandbox = getSandboxForRepo(env.SANDBOX, job.repoFullName);
  const setupResult = await setupRepo(sandbox, job.cloneUrl, job.headRef, job.headSha, token);
  console.log(
    `Repo setup: repo=${job.repoFullName} cloned=${setupResult.cloned} ` +
      `duration=${setupResult.duration}ms`,
  );

  // 3. Get PR diff
  const [owner, repo] = job.repoFullName.split("/");
  const diff = await getPRDiff(token, owner, repo, job.prNumber);
  const changedFiles = extractChangedFiles(diff);

  // 4. Compose skills
  const composition = composeSkills(changedFiles, job);
  console.log(
    `Skills composed: active=[${composition.activeSkillNames.join(", ")}] ` +
      `tools=${composition.tools.length} ` +
      `skipped=${composition.skippedSkills.length}`,
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
  );

  console.log(
    `Agent loop complete: verdict=${review.verdict} ` +
      `findings=${review.findings.length} ` +
      `iterations=${trace.iterationCount} ` +
      `tokens=${trace.totalInputTokens}+${trace.totalOutputTokens} ` +
      `duration=${trace.durationMs}ms`,
  );

  // 6. Post review to GitHub
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
    `Review posted: PR #${job.prNumber} ${event} with ${comments.length} inline comments ` +
      `total_duration=${Date.now()}ms`,
  );
}

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
