import { execFileSync } from "child_process";
import type { PRData, PRFile, MergeResult, ReviewFinding, PriorThread } from "./types";
import { commentableLines, snapToDiff } from "./diff";
import { isSameIssue } from "./dedupe";

const REVIEW_MARKER = "<!-- code-refinery-review -->";
const FINDING_MARKER = "<!-- code-refinery-finding -->";
// Inline comments posted before FINDING_MARKER existed end with this footer
const LEGACY_FINDING_FOOTER = "| Code Refinery</sub>";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ghApi<T = unknown>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  data?: Record<string, unknown>,
  headers?: Record<string, string>,
  token?: string,
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
    env: token ? { ...process.env, GH_TOKEN: token } : process.env,
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

  body += `\n<sub>confidence: ${finding.confidence} | Code Refinery</sub>\n${FINDING_MARKER}`;

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

function isFindingComment(body: string | undefined): boolean {
  return !!body && (body.includes(FINDING_MARKER) || body.includes(LEGACY_FINDING_FOOTER));
}

/**
 * Inline comments from earlier Code Refinery runs on this PR, with the
 * replies under each. Used to avoid re-posting findings and to let Claude
 * see how the author responded. Best-effort: returns [] on failure.
 */
export function getPriorThreads(repo: string, prNumber: number): PriorThread[] {
  type ReviewComment = {
    id: number;
    path: string;
    line: number | null;
    original_line: number | null;
    body?: string;
    user?: { login: string };
    in_reply_to_id?: number;
  };

  const comments: ReviewComment[] = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const batch = ghApi<ReviewComment[]>(
        `/repos/${repo}/pulls/${prNumber}/comments?per_page=100&page=${page}`,
      );
      if (!batch || batch.length === 0) break;
      comments.push(...batch);
      if (batch.length < 100) break;
    }
  } catch (err) {
    console.warn("Failed to fetch prior review comments.", (err as Error).message);
    return [];
  }

  const threads = new Map<number, PriorThread>();
  for (const c of comments) {
    if (c.in_reply_to_id || !isFindingComment(c.body)) continue;
    const header = c.body!.match(/\*\*(?:Security|Code Quality): ([^*]+)\*\*/);
    threads.set(c.id, {
      file: c.path,
      line: c.line ?? c.original_line ?? 0,
      category: header?.[1]?.trim() ?? "",
      description: c.body!,
      outdated: c.line === null,
      replies: [],
    });
  }

  for (const c of comments) {
    const thread = c.in_reply_to_id ? threads.get(c.in_reply_to_id) : undefined;
    if (thread && c.body) {
      thread.replies.push({ user: c.user?.login ?? "unknown", body: c.body });
    }
  }

  return [...threads.values()];
}

export function postInlineReview(
  repo: string,
  prNumber: number,
  headSha: string,
  findings: ReviewFinding[],
  prFiles: PRFile[],
  priorThreads: PriorThread[] = [],
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
  // Findings whose line is not in the diff — GitHub rejects inline comments
  // there, so they go in the review body instead of being dropped.
  const offDiff: ReviewFinding[] = [];

  for (const finding of inlineFindings) {
    if (!fileMap.has(finding.file)) {
      console.log(
        `File ${finding.file} not in PR diff, skipping inline comment.`,
      );
      continue;
    }

    if (priorThreads.some((t) => isSameIssue(t, finding))) {
      console.log(
        `Already commented on ${finding.file}:${finding.line} in an earlier run, not re-posting.`,
      );
      continue;
    }

    const line = snapToDiff(finding.line, commentableLines(fileMap.get(finding.file)!.patch));
    if (line === null) {
      offDiff.push(finding);
      continue;
    }

    let body = formatFindingComment(finding);
    if (line !== finding.line) {
      body = `_Refers to line ${finding.line}, which is outside the diff._\n\n${body}`;
    }

    reviewComments.push({ path: finding.file, line, side: "RIGHT", body });
  }

  if (reviewComments.length === 0 && offDiff.length === 0) {
    console.log("No new inline findings to post.");
    return;
  }

  const reviewBody = offDiff
    .map((f) => `**\`${f.file}:${f.line}\`** (outside the diff)\n\n${formatFindingComment(f)}`)
    .join("\n\n---\n\n");

  // Try batch review first
  try {
    ghApi(`/repos/${repo}/pulls/${prNumber}/reviews`, "POST", {
      commit_id: headSha,
      event: "COMMENT",
      ...(reviewBody ? { body: reviewBody } : {}),
      comments: reviewComments,
    });
    console.log(
      `Posted batch review with ${reviewComments.length} inline comments` +
        (offDiff.length ? ` and ${offDiff.length} outside-diff finding(s) in the review body.` : "."),
    );
    return;
  } catch (err) {
    console.warn(
      "Batch review failed. Falling back to individual comments.",
      (err as Error).message,
    );
  }

  // Fallback: post individual comments; anything GitHub still rejects is
  // added to a single review body so it isn't lost.
  let posted = 0;
  const unposted: string[] = reviewBody ? [reviewBody] : [];
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
        `Could not post comment on ${comment.path}:${comment.line}, moving it to the review body.`,
      );
      unposted.push(`**\`${comment.path}:${comment.line}\`**\n\n${comment.body}`);
    }
  }
  console.log(
    `Posted ${posted}/${reviewComments.length} individual inline comments.`,
  );

  if (unposted.length > 0) {
    try {
      ghApi(`/repos/${repo}/pulls/${prNumber}/reviews`, "POST", {
        commit_id: headSha,
        event: "COMMENT",
        body: unposted.join("\n\n---\n\n"),
      });
      console.log("Posted remaining findings in a review body.");
    } catch (err) {
      console.warn("Failed to post review body.", (err as Error).message);
    }
  }
}

/**
 * Merges the PR. If the active token (normally the code-refinery App token)
 * gets 403 and `fallbackToken` is given, retries once with it — the
 * workflow's GITHUB_TOKEN usually has `contents: write` when the App doesn't.
 */
export function mergePR(
  repo: string,
  prNumber: number,
  method: string,
  fallbackToken?: string,
): MergeResult {
  const result = tryMerge(repo, prNumber, method);
  if (
    !result.merged &&
    result.forbidden &&
    fallbackToken &&
    fallbackToken !== (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN)
  ) {
    console.log("  App token cannot merge, retrying with the workflow token...");
    return tryMerge(repo, prNumber, method, fallbackToken);
  }
  return result;
}

function tryMerge(
  repo: string,
  prNumber: number,
  method: string,
  token?: string,
): MergeResult & { forbidden?: boolean } {
  try {
    const response = ghApi<{ sha: string; message: string; merged: boolean }>(
      `/repos/${repo}/pulls/${prNumber}/merge`,
      "PUT",
      { merge_method: method },
      undefined,
      token,
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
        forbidden: true,
        message:
          "Forbidden: the provided token does not have permission to merge this PR.",
      };
    }

    return { merged: false, message: `Merge failed: ${message}` };
  }
}
