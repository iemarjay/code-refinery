import { execFileSync } from "child_process";
import type { PRData, PRFile, MergeResult, ReviewFinding } from "./types";

const REVIEW_MARKER = "<!-- code-refinery-review -->";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ghApi<T = unknown>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  data?: Record<string, unknown>,
  headers?: Record<string, string>,
): T {
  const args = ["api", endpoint, "--method", method];

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      args.push("--header", `${key}: ${value}`);
    }
  }

  if (data) {
    args.push("--input", "-");
  }

  const result = execFileSync("gh", args, {
    encoding: "utf-8",
    input: data ? JSON.stringify(data) : undefined,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });

  if (!result || !result.trim()) {
    return null as T;
  }

  return JSON.parse(result) as T;
}

function ghApiRaw(
  endpoint: string,
  headers?: Record<string, string>,
): string {
  const args = ["api", endpoint, "--method", "GET"];

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      args.push("--header", `${key}: ${value}`);
    }
  }

  return execFileSync("gh", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function getPaginatedFiles(
  repo: string,
  prNumber: number,
): Record<string, unknown>[] {
  const allFiles: Record<string, unknown>[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const files = ghApi<Record<string, unknown>[]>(
      `/repos/${repo}/pulls/${prNumber}/files?per_page=${perPage}&page=${page}`,
    );

    if (!files || files.length === 0) break;
    allFiles.push(...files);
    if (files.length < perPage) break;

    page++;
    if (page > 30) break; // GitHub caps at 3000 files
  }

  return allFiles;
}

function formatFindingComment(finding: ReviewFinding): string {
  const icon = finding.severity === "critical" ? "🔴" : "🟡";
  const passLabel =
    finding.pass_type === "security" ? "Security" : "Code Quality";

  let body = `${icon} **${passLabel}: ${finding.category}** (${finding.severity})\n\n`;
  body += `${finding.description}\n`;

  if (finding.recommendation) {
    body += `\n**Recommendation:** ${finding.recommendation}\n`;
  }

  if (finding.exploit_scenario) {
    body += `\n**Exploit scenario:** ${finding.exploit_scenario}\n`;
  }

  body += `\n<sub>confidence: ${finding.confidence} | Code Refinery</sub>`;

  return body;
}

function findExistingComment(
  repo: string,
  prNumber: number,
): number | null {
  try {
    const comments = ghApi<Array<{ id: number; body?: string }>>(
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    );

    if (!comments || !Array.isArray(comments)) return null;

    for (const comment of comments) {
      if (comment.body && comment.body.includes(REVIEW_MARKER)) {
        return comment.id;
      }
    }
  } catch (err) {
    console.warn(
      "Failed to check for existing comments.",
      (err as Error).message,
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

export function getPRData(repo: string, prNumber: number): PRData {
  const pr = ghApi<Record<string, any>>(
    `/repos/${repo}/pulls/${prNumber}`,
  );

  const files = getPaginatedFiles(repo, prNumber);

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    user: pr.user.login,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    files: files.map((f: Record<string, any>): PRFile => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch,
      previous_filename: f.previous_filename,
    })),
  };
}

export function getPRDiff(repo: string, prNumber: number): string {
  return ghApiRaw(`/repos/${repo}/pulls/${prNumber}`, {
    Accept: "application/vnd.github.diff",
  });
}

export function postSummaryComment(
  repo: string,
  prNumber: number,
  body: string,
): void {
  const markedBody = `${REVIEW_MARKER}\n${body}`;

  const existingId = findExistingComment(repo, prNumber);

  if (existingId !== null) {
    try {
      ghApi(`/repos/${repo}/issues/comments/${existingId}`, "PATCH", {
        body: markedBody,
      });
      console.log(`Updated existing summary comment (id: ${existingId}).`);
      return;
    } catch (err) {
      console.warn(
        `Failed to update comment ${existingId}, creating new one.`,
        (err as Error).message,
      );
    }
  }

  ghApi(`/repos/${repo}/issues/${prNumber}/comments`, "POST", {
    body: markedBody,
  });
  console.log("Posted new summary comment.");
}

export function postInlineReview(
  repo: string,
  prNumber: number,
  headSha: string,
  findings: ReviewFinding[],
  prFiles: PRFile[],
): void {
  const inlineFindings = findings.filter(
    (f) => f.severity === "critical" || f.severity === "warning",
  );

  if (inlineFindings.length === 0) {
    console.log("No critical/warning findings to post inline.");
    return;
  }

  const fileMap = new Map<string, PRFile>();
  for (const file of prFiles) {
    fileMap.set(file.filename, file);
  }

  const reviewComments: Array<{
    path: string;
    line: number;
    side: "RIGHT";
    body: string;
  }> = [];

  for (const finding of inlineFindings) {
    if (!fileMap.has(finding.file)) {
      console.log(
        `File ${finding.file} not in PR diff, skipping inline comment.`,
      );
      continue;
    }

    reviewComments.push({
      path: finding.file,
      line: finding.line,
      side: "RIGHT",
      body: formatFindingComment(finding),
    });
  }

  if (reviewComments.length === 0) {
    console.log("No findings map to files in the PR diff.");
    return;
  }

  // Try batch review first
  try {
    ghApi(`/repos/${repo}/pulls/${prNumber}/reviews`, "POST", {
      commit_id: headSha,
      event: "COMMENT",
      comments: reviewComments,
    });
    console.log(
      `Posted batch review with ${reviewComments.length} inline comments.`,
    );
    return;
  } catch (err) {
    console.warn(
      "Batch review failed (line numbers may be outside diff context). Falling back to individual comments.",
      (err as Error).message,
    );
  }

  // Fallback: post individual comments
  let posted = 0;
  for (const comment of reviewComments) {
    try {
      ghApi(`/repos/${repo}/pulls/${prNumber}/comments`, "POST", {
        commit_id: headSha,
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
      });
      posted++;
    } catch {
      console.warn(
        `Could not post comment on ${comment.path}:${comment.line} — line may not be in diff context.`,
      );
    }
  }
  console.log(
    `Posted ${posted}/${reviewComments.length} individual inline comments.`,
  );
}

export function mergePR(
  repo: string,
  prNumber: number,
  method: string,
): MergeResult {
  try {
    const response = ghApi<{ sha: string; message: string; merged: boolean }>(
      `/repos/${repo}/pulls/${prNumber}/merge`,
      "PUT",
      { merge_method: method },
    );

    return {
      merged: true,
      message: response.message ?? "PR merged successfully.",
      sha: response.sha,
    };
  } catch (err) {
    const message = (err as Error).message;

    if (message.includes("405")) {
      return {
        merged: false,
        message:
          "Merge blocked: PR is not mergeable (required checks may be pending or failing).",
      };
    }
    if (message.includes("409")) {
      return {
        merged: false,
        message:
          "Merge conflict: head branch is out of date with the base branch.",
      };
    }
    if (message.includes("403")) {
      return {
        merged: false,
        message:
          "Forbidden: the provided token does not have permission to merge this PR.",
      };
    }

    return { merged: false, message: `Merge failed: ${message}` };
  }
}
