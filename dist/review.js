"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/review.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var import_child_process3 = require("child_process");

// src/github.ts
var import_child_process = require("child_process");

// src/diff.ts
var MAX_SNAP_DISTANCE = 10;
function commentableLines(patch) {
  const lines = /* @__PURE__ */ new Set();
  if (!patch) return lines;
  let right = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      right = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      lines.add(right);
      right++;
    }
  }
  return lines;
}
function snapToDiff(line, commentable) {
  if (commentable.has(line)) return line;
  for (let d = 1; d <= MAX_SNAP_DISTANCE; d++) {
    if (commentable.has(line - d)) return line - d;
    if (commentable.has(line + d)) return line + d;
  }
  return null;
}

// src/dedupe.ts
var NEARBY_LINES = 5;
var MIN_TEXT_OVERLAP = 0.35;
var SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };
var STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "and",
  "this",
  "that",
  "with",
  "from",
  "when",
  "which",
  "into",
  "only",
  "line",
  "code",
  "value",
  "values",
  "call",
  "calls",
  "called",
  "because",
  "before",
  "after",
  "while",
  "would",
  "could",
  "should",
  "there",
  "their",
  "every",
  "other",
  "than",
  "then",
  "does",
  "also",
  "same",
  "were",
  "been",
  "being",
  "have",
  "here"
]);
function tokens(text) {
  const out = /* @__PURE__ */ new Set();
  for (const t of text.toLowerCase().match(/[a-z_][a-z0-9_.]{3,}/g) ?? []) {
    if (!STOPWORDS.has(t)) out.add(t);
  }
  return out;
}
function overlap(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}
function normalizeCategory(category) {
  return category.toLowerCase().replace(/[^a-z]/g, "");
}
function isSameIssue(a, b) {
  if (a.file !== b.file) return false;
  if (a.line === b.line) return true;
  if (Math.abs(a.line - b.line) > NEARBY_LINES) return false;
  return normalizeCategory(a.category) === normalizeCategory(b.category) || overlap(a.description, b.description) >= MIN_TEXT_OVERLAP;
}
function better(a, b) {
  const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (rank !== 0) return rank > 0 ? a : b;
  return a.confidence >= b.confidence ? a : b;
}
function dedupeFindings(findings) {
  const kept = [];
  for (const finding of findings) {
    const idx = kept.findIndex((k) => isSameIssue(k, finding));
    if (idx === -1) {
      kept.push(finding);
      continue;
    }
    const winner = better(kept[idx], finding);
    const loser = winner === finding ? kept[idx] : finding;
    console.log(
      `  [dedupe] ${loser.file}:${loser.line} (${loser.pass_type}/${loser.category}) duplicates ${winner.file}:${winner.line} (${winner.pass_type}/${winner.category})`
    );
    kept[idx] = winner;
  }
  return kept;
}

// src/github.ts
var REVIEW_MARKER = "<!-- code-refinery-review -->";
var FINDING_MARKER = "<!-- code-refinery-finding -->";
var LEGACY_FINDING_FOOTER = "| Code Refinery</sub>";
function ghApi(endpoint, method = "GET", data, headers, token) {
  const args = ["api", endpoint, "--method", method];
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      args.push("--header", `${key}: ${value}`);
    }
  }
  if (data) {
    args.push("--input", "-");
  }
  const result = (0, import_child_process.execFileSync)("gh", args, {
    encoding: "utf-8",
    input: data ? JSON.stringify(data) : void 0,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 3e4,
    env: token ? { ...process.env, GH_TOKEN: token } : process.env
  });
  if (!result || !result.trim()) {
    return null;
  }
  return JSON.parse(result);
}
function ghApiRaw(endpoint, headers) {
  const args = ["api", endpoint, "--method", "GET"];
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      args.push("--header", `${key}: ${value}`);
    }
  }
  return (0, import_child_process.execFileSync)("gh", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 6e4
  });
}
function getPaginatedFiles(repo, prNumber) {
  const allFiles = [];
  let page = 1;
  const perPage = 100;
  while (true) {
    const files = ghApi(
      `/repos/${repo}/pulls/${prNumber}/files?per_page=${perPage}&page=${page}`
    );
    if (!files || files.length === 0) break;
    allFiles.push(...files);
    if (files.length < perPage) break;
    page++;
    if (page > 30) break;
  }
  return allFiles;
}
function formatFindingComment(finding) {
  const icon = finding.severity === "critical" ? "\u{1F534}" : "\u{1F7E1}";
  const passLabel = finding.pass_type === "security" ? "Security" : "Code Quality";
  let body = `${icon} **${passLabel}: ${finding.category}** (${finding.severity})

`;
  body += `${finding.description}
`;
  if (finding.recommendation) {
    body += `
**Recommendation:** ${finding.recommendation}
`;
  }
  if (finding.exploit_scenario) {
    body += `
**Exploit scenario:** ${finding.exploit_scenario}
`;
  }
  body += `
<sub>confidence: ${finding.confidence} | Code Refinery</sub>
${FINDING_MARKER}`;
  return body;
}
function findExistingComment(repo, prNumber) {
  try {
    const comments = ghApi(
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100`
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
      err.message
    );
  }
  return null;
}
function getPRData(repo, prNumber) {
  const pr = ghApi(
    `/repos/${repo}/pulls/${prNumber}`
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
    files: files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch,
      previous_filename: f.previous_filename
    }))
  };
}
function getPRDiff(repo, prNumber) {
  return ghApiRaw(`/repos/${repo}/pulls/${prNumber}`, {
    Accept: "application/vnd.github.diff"
  });
}
function postSummaryComment(repo, prNumber, body) {
  const markedBody = `${REVIEW_MARKER}
${body}`;
  const existingId = findExistingComment(repo, prNumber);
  if (existingId !== null) {
    try {
      ghApi(`/repos/${repo}/issues/comments/${existingId}`, "PATCH", {
        body: markedBody
      });
      console.log(`Updated existing summary comment (id: ${existingId}).`);
      return;
    } catch (err) {
      console.warn(
        `Failed to update comment ${existingId}, creating new one.`,
        err.message
      );
    }
  }
  ghApi(`/repos/${repo}/issues/${prNumber}/comments`, "POST", {
    body: markedBody
  });
  console.log("Posted new summary comment.");
}
function isFindingComment(body) {
  return !!body && (body.includes(FINDING_MARKER) || body.includes(LEGACY_FINDING_FOOTER));
}
function getPriorThreads(repo, prNumber) {
  const comments = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const batch = ghApi(
        `/repos/${repo}/pulls/${prNumber}/comments?per_page=100&page=${page}`
      );
      if (!batch || batch.length === 0) break;
      comments.push(...batch);
      if (batch.length < 100) break;
    }
  } catch (err) {
    console.warn("Failed to fetch prior review comments.", err.message);
    return [];
  }
  const threads = /* @__PURE__ */ new Map();
  for (const c of comments) {
    if (c.in_reply_to_id || !isFindingComment(c.body)) continue;
    const header = c.body.match(/\*\*(?:Security|Code Quality): ([^*]+)\*\*/);
    threads.set(c.id, {
      file: c.path,
      line: c.line ?? c.original_line ?? 0,
      category: header?.[1]?.trim() ?? "",
      description: c.body,
      outdated: c.line === null,
      replies: []
    });
  }
  for (const c of comments) {
    const thread = c.in_reply_to_id ? threads.get(c.in_reply_to_id) : void 0;
    if (thread && c.body) {
      thread.replies.push({ user: c.user?.login ?? "unknown", body: c.body });
    }
  }
  return [...threads.values()];
}
function postInlineReview(repo, prNumber, headSha, findings, prFiles, priorThreads = []) {
  const inlineFindings = findings.filter(
    (f) => f.severity === "critical" || f.severity === "warning"
  );
  if (inlineFindings.length === 0) {
    console.log("No critical/warning findings to post inline.");
    return;
  }
  const fileMap = /* @__PURE__ */ new Map();
  for (const file of prFiles) {
    fileMap.set(file.filename, file);
  }
  const reviewComments = [];
  const offDiff = [];
  for (const finding of inlineFindings) {
    if (!fileMap.has(finding.file)) {
      console.log(
        `File ${finding.file} not in PR diff, skipping inline comment.`
      );
      continue;
    }
    if (priorThreads.some((t) => isSameIssue(t, finding))) {
      console.log(
        `Already commented on ${finding.file}:${finding.line} in an earlier run, not re-posting.`
      );
      continue;
    }
    const line = snapToDiff(finding.line, commentableLines(fileMap.get(finding.file).patch));
    if (line === null) {
      offDiff.push(finding);
      continue;
    }
    let body = formatFindingComment(finding);
    if (line !== finding.line) {
      body = `_Refers to line ${finding.line}, which is outside the diff._

${body}`;
    }
    reviewComments.push({ path: finding.file, line, side: "RIGHT", body });
  }
  if (reviewComments.length === 0 && offDiff.length === 0) {
    console.log("No new inline findings to post.");
    return;
  }
  const reviewBody = offDiff.map((f) => `**\`${f.file}:${f.line}\`** (outside the diff)

${formatFindingComment(f)}`).join("\n\n---\n\n");
  try {
    ghApi(`/repos/${repo}/pulls/${prNumber}/reviews`, "POST", {
      commit_id: headSha,
      event: "COMMENT",
      ...reviewBody ? { body: reviewBody } : {},
      comments: reviewComments
    });
    console.log(
      `Posted batch review with ${reviewComments.length} inline comments` + (offDiff.length ? ` and ${offDiff.length} outside-diff finding(s) in the review body.` : ".")
    );
    return;
  } catch (err) {
    console.warn(
      "Batch review failed. Falling back to individual comments.",
      err.message
    );
  }
  let posted = 0;
  const unposted = reviewBody ? [reviewBody] : [];
  for (const comment of reviewComments) {
    try {
      ghApi(`/repos/${repo}/pulls/${prNumber}/comments`, "POST", {
        commit_id: headSha,
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body
      });
      posted++;
    } catch {
      console.warn(
        `Could not post comment on ${comment.path}:${comment.line}, moving it to the review body.`
      );
      unposted.push(`**\`${comment.path}:${comment.line}\`**

${comment.body}`);
    }
  }
  console.log(
    `Posted ${posted}/${reviewComments.length} individual inline comments.`
  );
  if (unposted.length > 0) {
    try {
      ghApi(`/repos/${repo}/pulls/${prNumber}/reviews`, "POST", {
        commit_id: headSha,
        event: "COMMENT",
        body: unposted.join("\n\n---\n\n")
      });
      console.log("Posted remaining findings in a review body.");
    } catch (err) {
      console.warn("Failed to post review body.", err.message);
    }
  }
}
function mergePR(repo, prNumber, method, fallbackToken) {
  const result = tryMerge(repo, prNumber, method);
  if (!result.merged && result.forbidden && fallbackToken && fallbackToken !== (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN)) {
    console.log("  App token cannot merge, retrying with the workflow token...");
    return tryMerge(repo, prNumber, method, fallbackToken);
  }
  return result;
}
function tryMerge(repo, prNumber, method, token) {
  try {
    const response = ghApi(
      `/repos/${repo}/pulls/${prNumber}/merge`,
      "PUT",
      { merge_method: method },
      void 0,
      token
    );
    return {
      merged: true,
      message: response.message ?? "PR merged successfully.",
      sha: response.sha
    };
  } catch (err) {
    const message = err.message;
    if (message.includes("405")) {
      return {
        merged: false,
        message: "Merge blocked: PR is not mergeable (required checks may be pending or failing)."
      };
    }
    if (message.includes("409")) {
      return {
        merged: false,
        message: "Merge conflict: head branch is out of date with the base branch."
      };
    }
    if (message.includes("403")) {
      return {
        merged: false,
        forbidden: true,
        message: "Forbidden: the provided token does not have permission to merge this PR."
      };
    }
    return { merged: false, message: `Merge failed: ${message}` };
  }
}

// src/claude.ts
var import_child_process2 = require("child_process");

// src/schema.ts
var reviewSchema = {
  type: "object",
  required: ["findings", "analysis_summary"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "line", "severity", "category", "description", "confidence"],
        properties: {
          file: { type: "string", description: "File path relative to repo root" },
          line: { type: "integer", description: "Line number in the file" },
          severity: {
            type: "string",
            enum: ["critical", "warning", "info"],
            description: "Finding severity level"
          },
          category: { type: "string", description: "Finding category (e.g. sql_injection, null_error)" },
          description: { type: "string", description: "Clear explanation of the issue" },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Confidence score from 0.0 to 1.0"
          },
          recommendation: { type: "string", description: "How to fix the issue" },
          exploit_scenario: { type: "string", description: "How this could be exploited (security findings)" }
        },
        additionalProperties: false
      }
    },
    analysis_summary: {
      type: "object",
      required: ["files_reviewed", "critical_count", "warning_count", "info_count", "review_completed"],
      properties: {
        files_reviewed: { type: "integer" },
        critical_count: { type: "integer" },
        warning_count: { type: "integer" },
        info_count: { type: "integer" },
        review_completed: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
};
var reviewSchemaJson = JSON.stringify(reviewSchema);

// src/claude.ts
var MAX_RETRIES = 3;
var RETRY_DELAY_MS = 5e3;
var EMPTY_RESULT = {
  findings: [],
  analysis_summary: {
    files_reviewed: 0,
    critical_count: 0,
    warning_count: 0,
    info_count: 0,
    review_completed: false
  }
};
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function runClaude(args, input, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = (0, import_child_process2.spawn)("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const killGroup = (signal) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5e3).unref();
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ stdout, stderr, status: null, timedOut });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => finish({ stdout, stderr, status: null, timedOut, spawnError: err }));
    child.on("close", (status) => finish({ stdout, stderr, status, timedOut }));
    child.stdin.on("error", () => {
    });
    child.stdin.end(input);
  });
}
function isPromptTooLong(stdout) {
  try {
    const envelope = JSON.parse(stdout);
    return envelope?.type === "result" && envelope?.is_error === true && typeof envelope?.result === "string" && envelope.result.includes("Prompt is too long");
  } catch {
    return false;
  }
}
function parseClaudeOutput(stdout, log) {
  const envelope = JSON.parse(stdout);
  if (envelope.structured_output) {
    return envelope.structured_output;
  }
  if (envelope.result) {
    const parsed = JSON.parse(envelope.result);
    if (parsed && Array.isArray(parsed.findings)) {
      return parsed;
    }
  }
  log("Claude output missing structured_output and result fields.");
  return EMPTY_RESULT;
}
async function invokeClaude(options) {
  const {
    prompt,
    systemPrompt,
    repoDir,
    model,
    maxTurns,
    maxBudgetUsd,
    timeoutMinutes,
    disallowedTools = "Bash(ps:*)",
    label
  } = options;
  const prefix = label ? `  [${label}] ` : "";
  const warn = (msg) => console.warn(prefix + msg);
  const error = (msg) => console.error(prefix + msg);
  const args = [
    "--output-format",
    "json",
    "--model",
    model,
    "--json-schema",
    reviewSchemaJson,
    "--append-system-prompt",
    systemPrompt,
    "--disallowed-tools",
    disallowedTools
  ];
  if (maxTurns !== void 0) {
    args.push("--max-turns", String(maxTurns));
  }
  if (maxBudgetUsd !== void 0) {
    args.push("--max-budget-usd", String(maxBudgetUsd));
  }
  const timeoutMs = timeoutMinutes * 60 * 1e3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const run = await runClaude(args, prompt, repoDir, timeoutMs);
    if (isPromptTooLong(run.stdout)) {
      warn("Claude reported prompt is too long.");
      return { output: EMPTY_RESULT, promptTooLong: true };
    }
    if (run.timedOut) {
      error(`Claude CLI timed out after ${timeoutMinutes} minutes.`);
      return { output: EMPTY_RESULT, promptTooLong: false };
    }
    if (run.status === 0 && !run.spawnError) {
      try {
        return { output: parseClaudeOutput(run.stdout, warn), promptTooLong: false };
      } catch (err) {
        error(`Failed to parse Claude output: ${err.message}`);
        return { output: EMPTY_RESULT, promptTooLong: false };
      }
    }
    const detail = run.spawnError?.message || run.stderr.slice(0, 500) || run.stdout.slice(0, 500);
    if (attempt === MAX_RETRIES - 1) {
      error(`Claude CLI failed after ${MAX_RETRIES} attempts (exit ${run.status ?? "unknown"}): ${detail}`);
      return { output: EMPTY_RESULT, promptTooLong: false };
    }
    const delayMs = RETRY_DELAY_MS * (attempt + 1);
    warn(`Claude CLI attempt ${attempt + 1} failed (exit ${run.status ?? "unknown"}), retrying in ${delayMs / 1e3}s...`);
    await sleep(delayMs);
  }
  return { output: EMPTY_RESULT, promptTooLong: false };
}

// src/prompts.ts
function getStrictnessConfig(strictness) {
  switch (strictness) {
    case "strict":
      return { label: "strict", confidenceFloor: 0.7, reportInfoFindings: true, categoryScope: "wide" };
    case "lenient":
      return { label: "lenient", confidenceFloor: 0.9, reportInfoFindings: false, categoryScope: "narrow" };
    default:
      return { label: "normal", confidenceFloor: 0.8, reportInfoFindings: false, categoryScope: "standard" };
  }
}
var SEVERITY_GUIDELINES = `
SEVERITY LEVELS (use these exact values):
- "critical": Directly exploitable vulnerability, crash-causing bug, or data-loss risk. Would block a production deploy.
- "warning": Real issue requiring specific conditions to trigger. Significant impact but not immediately exploitable. Worth fixing before merge.
- "info": Defense-in-depth improvement, minor concern, or suggestion for better practices. Will not block merge.`;
function buildConfidenceGuidelines(floor) {
  return `
CONFIDENCE SCORING (0.0 to 1.0):
- 0.9\u20131.0: Certain \u2014 verified exploit path or confirmed bug.
- 0.8\u20130.9: High \u2014 clear vulnerability/bug pattern with known exploitation or failure modes.
- 0.7\u20130.8: Likely \u2014 suspicious pattern requiring specific conditions. Needs attention.
- Below ${floor}: DO NOT REPORT. Too speculative.

Your minimum reporting threshold is ${floor}. Only report findings with confidence >= ${floor}.`;
}
var SECURITY_EXCLUSIONS = `
IMPORTANT \u2014 DO NOT REPORT any of the following:
1. Denial of Service (DoS) or resource exhaustion vulnerabilities
2. Rate limiting recommendations or missing rate limits
3. Resource leaks (unclosed files, connections, sockets) \u2014 handled by the code quality pass
4. Open redirect vulnerabilities
5. Regex injection or ReDoS
6. Memory safety issues (buffer overflow, use-after-free) UNLESS the file is C or C++ (.c, .cc, .cpp, .h)
7. SSRF in HTML or client-side files
8. Secrets or credentials stored on disk (handled by separate tooling)
9. Missing input validation on non-security-critical fields where no proven exploit path exists
10. Style, formatting, or code quality concerns (handled by a separate review pass)
11. Issues in lockfiles, generated files (dist/, build/, vendor/), .d.ts files, or minified files
12. Issues in Markdown documentation files`;
function formatCustomInstructions(customInstructions) {
  if (!customInstructions?.trim()) return "";
  return `

ADDITIONAL INSTRUCTIONS FROM REPOSITORY OWNER:
${customInstructions.trim()}`;
}
var MAX_DIFF_CHARS = 15e4;
function truncateDiff(diff, maxChars = MAX_DIFF_CHARS) {
  if (diff.length <= maxChars) {
    return { text: diff, truncated: false };
  }
  const cutoff = diff.lastIndexOf("\ndiff --git ", maxChars);
  const safePoint = cutoff > 0 ? cutoff : maxChars;
  return {
    text: diff.slice(0, safePoint) + "\n\n[... diff truncated due to size. Use file exploration tools (Read, Grep, Glob) to examine remaining files.]",
    truncated: true
  };
}
var SECURITY_CATEGORIES_NARROW = `
**Input Validation & Injection:**
- SQL injection via unsanitized user input
- Command injection in system calls or subprocesses
- Path traversal in file operations

**Authentication & Authorization:**
- Authentication bypass logic
- Privilege escalation paths
- Authorization logic bypasses

**Crypto & Secrets:**
- Hardcoded API keys, passwords, or tokens in source code
- Weak cryptographic algorithms or implementations`;
var SECURITY_CATEGORIES_STANDARD = `
**Input Validation & Injection:**
- SQL injection via unsanitized user input
- Command injection in system calls or subprocesses
- XXE injection in XML parsing
- Template injection in templating engines
- NoSQL injection in database queries
- Path traversal in file operations

**Authentication & Authorization:**
- Authentication bypass logic
- Privilege escalation paths
- Session management flaws
- JWT token vulnerabilities (missing validation, weak signing)
- Authorization logic bypasses

**Crypto & Secrets:**
- Hardcoded API keys, passwords, or tokens in source code
- Weak cryptographic algorithms or implementations
- Improper key storage or management
- Cryptographic randomness issues (using Math.random for security)

**Code Execution & Deserialization:**
- Remote code execution via deserialization (pickle, YAML, eval)
- Eval injection in dynamic code execution
- Prototype pollution in JavaScript
- XSS vulnerabilities (reflected, stored, DOM-based)

**Data Exposure:**
- Sensitive data in logs or error messages
- PII handling violations
- API endpoint data leakage
- Debug information exposure in production`;
var SECURITY_CATEGORIES_WIDE = SECURITY_CATEGORIES_STANDARD + `

**Supply Chain & Configuration:**
- Dependency confusion or typosquatting risks
- Insecure default configurations
- Certificate validation bypasses
- Unsafe HTTP in security-critical contexts
- Missing security headers in web responses

**Concurrency (security-relevant):**
- TOCTOU (Time-of-check-to-time-of-use) vulnerabilities
- Race conditions in authentication or authorization flows`;
function getSecurityCategories(scope) {
  switch (scope) {
    case "narrow":
      return SECURITY_CATEGORIES_NARROW;
    case "wide":
      return SECURITY_CATEGORIES_WIDE;
    default:
      return SECURITY_CATEGORIES_STANDARD;
  }
}
function buildSecurityPrompt(strictness, customInstructions) {
  const config = getStrictnessConfig(strictness);
  const categories = getSecurityCategories(config.categoryScope);
  const infoLine = config.reportInfoFindings ? "Report critical, warning, AND info-level findings." : "Focus on critical and warning findings. Use info sparingly \u2014 only for notable defense-in-depth suggestions.";
  return `You are a senior security engineer conducting a focused security review of a GitHub pull request.

OBJECTIVE:
Identify HIGH-CONFIDENCE security vulnerabilities introduced by this PR. This is NOT a general code review \u2014 focus ONLY on security implications of newly added or changed code. Do not comment on pre-existing issues in unchanged code.

CRITICAL PRINCIPLES:
1. MINIMIZE FALSE POSITIVES: Only flag issues where you are >${Math.round(config.confidenceFloor * 100)}% confident of actual exploitability or security impact.
2. AVOID NOISE: Skip theoretical issues, style concerns, or low-impact findings.
3. FOCUS ON IMPACT: Prioritize vulnerabilities that could lead to unauthorized access, data breaches, remote code execution, or system compromise.
4. ${infoLine}

SECURITY CATEGORIES TO EXAMINE:
${categories}
${SECURITY_EXCLUSIONS}

ANALYSIS METHODOLOGY:

Phase 1 \u2014 Repository Context Research (use file exploration tools):
- Identify existing security frameworks and libraries (ORM, sanitization, auth middleware).
- Look for established secure coding patterns already in the codebase.
- Understand the project's security model: what is trusted vs untrusted input?
- Check for security configuration (.eslintrc security rules, CSP headers, etc.).

Phase 2 \u2014 Comparative Analysis:
- Compare new code against existing security patterns in the repo.
- Identify deviations from established secure practices.
- Flag code that introduces new attack surfaces not present before.

Phase 3 \u2014 Vulnerability Assessment:
- Trace data flow from user inputs to sensitive operations (sinks).
- Look for injection points where unsanitized data reaches dangerous APIs.
- Check privilege boundaries being crossed unsafely.
- Verify new endpoints or handlers have proper authentication/authorization.
${SEVERITY_GUIDELINES}
${buildConfidenceGuidelines(config.confidenceFloor)}

OUTPUT REQUIREMENTS:
- The "category" field should use snake_case identifiers (e.g., "sql_injection", "auth_bypass", "hardcoded_secret").
- The "file" field must be the path relative to the repository root.
- The "line" field must point to the specific line where the issue exists.
- The "exploit_scenario" field is REQUIRED for critical findings \u2014 describe a concrete attack scenario.
- The "recommendation" field should give a specific fix, not generic advice like "validate input".

FINAL REMINDER:
Each finding should be something a security engineer would confidently raise in a PR review. When in doubt, do not report. It is far better to miss a theoretical vulnerability than to waste developer time with a false positive.

Your final response must contain only the JSON output matching the required schema. Do not include any other text.${formatCustomInstructions(customInstructions)}`;
}
var QUALITY_CATEGORIES_NARROW = `
**Null/Undefined Errors:**
- Dereferencing potentially null or undefined values without checks
- Missing null guards on function return values
- Optional chaining needed but absent

**Logic Errors:**
- Off-by-one errors in loops or array access
- Incorrect boolean logic (wrong operator, inverted condition)
- Unreachable code or dead branches
- Switch/case fallthrough bugs`;
var QUALITY_CATEGORIES_STANDARD = `
**Null/Undefined Errors:**
- Dereferencing potentially null or undefined values without checks
- Missing null guards on function return values
- Optional chaining needed but absent
- Uninitialized variables used before assignment

**Logic Errors:**
- Off-by-one errors in loops or array access
- Incorrect boolean logic (wrong operator, inverted condition)
- Unreachable code or dead branches
- Switch/case fallthrough bugs
- Incorrect comparison (== vs === in JS/TS, wrong type coercion)

**Error Handling:**
- Empty catch blocks that silently swallow errors
- Missing error handling on operations that can fail (file I/O, network, parsing)
- Thrown errors that lose context (re-throwing without original cause)
- Unhandled promise rejections or missing await

**Race Conditions & Concurrency:**
- Shared mutable state accessed without synchronization
- Async operations with incorrect ordering assumptions
- Missing await on async functions (fire-and-forget bugs)
- Callback-based code with race condition windows

**Resource Management:**
- Event listeners registered but never removed (memory leak)
- Subscriptions or intervals not cleaned up
- Large data structures held in closures unnecessarily

**API Contract Violations:**
- Function signatures that don't match their documented behavior
- Return types inconsistent with what callers expect
- Breaking changes in public interfaces`;
var QUALITY_CATEGORIES_WIDE = QUALITY_CATEGORIES_STANDARD + `

**Complexity & Maintainability:**
- Functions exceeding ~50 lines that should be decomposed
- Deeply nested conditionals (>3 levels) that harm readability
- Duplicated logic that should be extracted into a shared function
- Magic numbers or strings that should be named constants

**Naming & Clarity:**
- Variables or functions with misleading names (name implies different behavior)
- Boolean variables or functions with unclear positive/negative sense
- Overly generic names (data, info, result, item) in complex contexts

**Test Gaps:**
- New public functions or methods with no corresponding test
- Changed behavior in existing functions without test updates
- Edge cases in new code that are not covered by tests`;
function getQualityCategories(scope) {
  switch (scope) {
    case "narrow":
      return QUALITY_CATEGORIES_NARROW;
    case "wide":
      return QUALITY_CATEGORIES_WIDE;
    default:
      return QUALITY_CATEGORIES_STANDARD;
  }
}
function buildCodeQualityPrompt(strictness, customInstructions) {
  const config = getStrictnessConfig(strictness);
  const categories = getQualityCategories(config.categoryScope);
  const infoLine = config.reportInfoFindings ? "Report critical, warning, AND info-level findings." : "Focus on critical and warning findings. Use info sparingly \u2014 only for notable improvements.";
  return `You are a senior software engineer conducting a code quality review of a GitHub pull request.

OBJECTIVE:
Identify real bugs, logic errors, and significant code quality issues introduced by this PR. Focus ONLY on code newly added or modified in this PR. Do not comment on pre-existing issues in unchanged code.

CRITICAL PRINCIPLES:
1. FIND REAL BUGS: Prioritize issues that will cause runtime failures, incorrect behavior, or data corruption.
2. MINIMIZE FALSE POSITIVES: Only report issues where you are >${Math.round(config.confidenceFloor * 100)}% confident the code is actually wrong or will cause problems.
3. BE CONSTRUCTIVE: Every finding must include a specific, actionable recommendation.
4. ${infoLine}

DO NOT REPORT:
- Security vulnerabilities (injection, auth bypass, crypto) \u2014 handled by a separate security review pass.
- Style or formatting issues (indentation, whitespace, line length, brace placement).
- Subjective preferences (arrow functions vs function declarations, tabs vs spaces).
- Missing comments or documentation (unless code is genuinely misleading without them).
- Performance micro-optimizations with no measurable impact.
- Issues in lockfiles, generated files (dist/, build/, vendor/), type declarations (.d.ts), or minified files.
- Issues in Markdown documentation files.
- Issues in test files UNLESS the test itself is broken or tests the wrong thing.

CODE QUALITY CATEGORIES TO EXAMINE:
${categories}

ANALYSIS METHODOLOGY:

Phase 1 \u2014 Codebase Context (use file exploration tools):
- Understand the project's language, framework, and conventions.
- Look at existing patterns for error handling, null checking, async usage.
- Check for type definitions, interfaces, or schemas that define expected data shapes.
- Review existing tests to understand the testing patterns used.

Phase 2 \u2014 Change Impact Analysis:
- Understand what the PR is trying to accomplish (read the PR title and description).
- Identify which changed files are most likely to contain bugs (complex logic, data transformations, state management).
- Trace how new code interacts with existing code \u2014 check callers and callees.

Phase 3 \u2014 Defect Detection:
- For each changed file, examine the diff for the categories listed above.
- Verify that error handling covers all failure paths.
- Check that async/await patterns are correct throughout the call chain.
- Look for edge cases in new logic (empty arrays, null values, concurrent access).
${SEVERITY_GUIDELINES}
${buildConfidenceGuidelines(config.confidenceFloor)}

OUTPUT REQUIREMENTS:
- The "category" field should use snake_case identifiers (e.g., "null_error", "race_condition", "missing_error_handling", "logic_error").
- The "file" field must be the path relative to the repository root.
- The "line" field must point to the specific line where the issue exists.
- The "recommendation" field must give a specific fix \u2014 not generic advice like "add error handling". Show what the fix looks like or describe it precisely.
- The "exploit_scenario" field is NOT used for code quality findings \u2014 leave it empty.

FINAL REMINDER:
Focus on bugs that will actually bite someone. A good code review catches the error that would have caused an incident at 2am. When in doubt about whether something is a real issue, do not report it.

Your final response must contain only the JSON output matching the required schema. Do not include any other text.${formatCustomInstructions(customInstructions)}`;
}
var MAX_PRIOR_THREADS = 30;
var MAX_FINDING_CHARS = 600;
var MAX_REPLY_CHARS = 800;
function clip(text, max) {
  const clean = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<sub>[\s\S]*?<\/sub>/g, "").trim();
  return clean.length > max ? clean.slice(0, max) + "\u2026" : clean;
}
function buildPriorThreadsSection(threads) {
  if (threads.length === 0) return "";
  const shown = threads.slice(-MAX_PRIOR_THREADS);
  const blocks = shown.map((t, i) => {
    const where = `${t.file}:${t.line}${t.outdated ? " (outdated \u2014 code has changed since)" : ""}`;
    const replies = t.replies.length ? t.replies.map((r) => `  Reply from ${r.user}:
  ${clip(r.body, MAX_REPLY_CHARS).replace(/\n/g, "\n  ")}`).join("\n") : "  (no replies)";
    return `[${i + 1}] ${where}
  Finding: ${clip(t.description, MAX_FINDING_CHARS).replace(/\n/g, "\n  ")}
${replies}`;
  });
  return `
PREVIOUS REVIEW THREADS:
Earlier Code Refinery runs on this PR left the inline findings below, and the author may have replied. Use them as follows:
- If a finding has been fixed in the current code, do not report it.
- If a reply explains why a finding does not apply (for example: the code predates this PR, the behavior is intended, or the author verified it is not exploitable), do not report it again unless you can point to concrete evidence in the current code that the reply is wrong. If you do, say what the reply missed.
- If a finding is still present and nobody has answered it, report it again with the same file, line and category. It will not be posted twice, but it still counts toward the verdict.
- Do not let these threads narrow your review. Check the rest of the PR as thoroughly as you otherwise would.

${blocks.join("\n\n")}
${threads.length > shown.length ? `
(${threads.length - shown.length} older thread(s) omitted.)
` : ""}`;
}
function buildUserContext(prData, diff, changedFiles, includeDiff = true, priorThreads = []) {
  const filesList = changedFiles.map((f) => `- ${f}`).join("\n");
  let diffSection;
  if (includeDiff) {
    const { text: diffText, truncated } = truncateDiff(diff);
    const truncationNote = truncated ? "\nNOTE: The diff was truncated due to size. Use file exploration tools (Read, Grep, Glob) to examine files not shown in the diff.\n" : "";
    diffSection = `${truncationNote}
DIFF:
\`\`\`
${diffText}
\`\`\`

Review the PR diff above. Analyze the changes and produce your findings as structured JSON.`;
  } else {
    diffSection = `
NOTE: PR diff was omitted due to size constraints. Please use the file exploration tools (Read, Grep, Glob) to examine the specific files that were changed in this PR.

Analyze the changes and produce your findings as structured JSON.`;
  }
  return `PULL REQUEST #${prData.number}: "${prData.title}"

Author: ${prData.user}
Branch: ${prData.headRef} -> ${prData.baseRef}
Changed files: ${prData.changedFiles}
Lines added: ${prData.additions}
Lines deleted: ${prData.deletions}

PR Description:
${prData.body || "(no description provided)"}

Files changed:
${filesList}
${buildPriorThreadsSection(priorThreads)}${diffSection}`;
}

// src/trivial.ts
var TRIVIAL_EXTENSIONS = /* @__PURE__ */ new Set([
  // Documentation
  ".md",
  ".rst",
  ".txt",
  ".adoc",
  ".doc",
  ".docx",
  // Assets
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot"
]);
var TRIVIAL_EXACT_NAMES = /* @__PURE__ */ new Set([
  // Lockfiles
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "gemfile.lock",
  "poetry.lock",
  "cargo.lock",
  "composer.lock",
  "go.sum",
  // Misc config
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
  ".browserslistrc",
  "tsconfig.json"
]);
var TRIVIAL_CONFIG_EXTENSIONS = /* @__PURE__ */ new Set([
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf"
]);
var TRIVIAL_PATH_PREFIXES = [
  ".github/",
  ".circleci/"
];
var TRIVIAL_BASENAME_PREFIXES = [
  "license",
  "licence",
  "notice",
  "patents",
  ".prettierrc",
  ".eslintrc",
  ".gitlab-ci"
];
var MAX_TRIVIAL_LINES = 500;
function extOf(filename) {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}
function baseOf(filename) {
  const slash = filename.lastIndexOf("/");
  return (slash === -1 ? filename : filename.slice(slash + 1)).toLowerCase();
}
function isTrivialFile(filename) {
  const ext = extOf(filename);
  const base = baseOf(filename);
  const lower = filename.toLowerCase();
  if (TRIVIAL_EXTENSIONS.has(ext)) return true;
  if (TRIVIAL_EXACT_NAMES.has(base)) return true;
  if (TRIVIAL_CONFIG_EXTENSIONS.has(ext)) return true;
  if (TRIVIAL_PATH_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (TRIVIAL_BASENAME_PREFIXES.some((p) => base.startsWith(p))) return true;
  return false;
}
function isTrivialPR(files) {
  if (files.length === 0) return true;
  let totalLines = 0;
  for (const f of files) {
    if (!isTrivialFile(f.filename)) {
      console.log(`  non-trivial file: ${f.filename}`);
      return false;
    }
    totalLines += f.additions + f.deletions;
  }
  if (totalLines > MAX_TRIVIAL_LINES) {
    console.log(`  trivial file types but too many changed lines (${totalLines} > ${MAX_TRIVIAL_LINES})`);
    return false;
  }
  console.log(`  all ${files.length} files trivial, ${totalLines} lines changed`);
  return true;
}

// src/filter.ts
var DOS = [
  /\b(denial of service|dos attack|resource exhaustion)\b/i,
  /\b(exhaust|overwhelm|overload).*?(resource|memory|cpu)\b/i,
  /\b(infinite|unbounded).*?(loop|recursion)\b/i
];
var RATE_LIMITING = [
  /\b(missing|lack of|no)\s+rate\s+limit/i,
  /\brate\s+limiting\s+(missing|required|not implemented)/i,
  /\b(implement|add)\s+rate\s+limit/i,
  /\bunlimited\s+(requests|calls|api)/i
];
var RESOURCE_LEAK = [
  /\b(resource|memory|file)\s+leak\s+potential/i,
  /\bunclosed\s+(resource|file|connection)/i,
  /\b(close|cleanup|release)\s+(resource|file|connection)/i,
  /\bpotential\s+memory\s+leak/i,
  /\b(database|thread|socket|connection)\s+leak/i
];
var OPEN_REDIRECT = [
  /\b(open redirect|unvalidated redirect)\b/i,
  /\bredirect.(attack|exploit|vulnerability)/i,
  /\bmalicious.redirect/i
];
var REGEX_INJECTION = [
  /\b(regex|regular expression)\s+injection\b/i,
  /\b(regex|regular expression)\s+denial of service\b/i,
  /\b(regex|regular expression)\s+flooding\b/i
];
var MEMORY_SAFETY = [
  /\b(buffer overflow|stack overflow|heap overflow)\b/i,
  /\b(oob)\s+(read|write|access)\b/i,
  /\bout.?of.?bounds?\b/i,
  /\b(memory safety|memory corruption)\b/i,
  /\b(use.?after.?free|double.?free|null.?pointer.?dereference)\b/i,
  /\b(segmentation fault|segfault|memory violation)\b/i,
  /\b(bounds check|boundary check|array bounds)\b/i,
  /\b(integer overflow|integer underflow|integer conversion)\b/i,
  /\barbitrary.?(memory read|pointer dereference|memory address|memory pointer)\b/i
];
var SSRF = [
  /\b(ssrf|server\s*.?side\s*.?request\s*.?forgery)\b/i
];
var C_CPP_EXTENSIONS = /* @__PURE__ */ new Set([".c", ".cc", ".cpp", ".h"]);
var LOCKFILE_NAMES = /* @__PURE__ */ new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "gemfile.lock",
  "poetry.lock",
  "cargo.lock",
  "composer.lock",
  "go.sum"
]);
var GENERATED_PATTERNS = [
  /^dist\//,
  /^build\//,
  /^vendor\//,
  /\.min\.js$/,
  /\.d\.ts$/
];
function extOf2(path2) {
  const dot = path2.lastIndexOf(".");
  return dot === -1 ? "" : path2.slice(dot).toLowerCase();
}
function baseOf2(path2) {
  const slash = path2.lastIndexOf("/");
  return (slash === -1 ? path2 : path2.slice(slash + 1)).toLowerCase();
}
function anyMatch(patterns, text) {
  return patterns.some((p) => p.test(text));
}
var rules = [
  {
    name: "Markdown file",
    exclude: (f) => f.file.toLowerCase().endsWith(".md")
  },
  {
    name: "Lockfile or generated file",
    exclude: (f) => {
      const base = baseOf2(f.file);
      const lower = f.file.toLowerCase();
      return LOCKFILE_NAMES.has(base) || GENERATED_PATTERNS.some((p) => p.test(lower));
    }
  },
  {
    name: "Low confidence (<0.7)",
    exclude: (f) => f.confidence < 0.7
  },
  {
    name: "DoS / resource exhaustion",
    exclude: (f) => anyMatch(DOS, `${f.category} ${f.description}`)
  },
  {
    name: "Rate limiting recommendation",
    exclude: (f) => anyMatch(RATE_LIMITING, `${f.category} ${f.description}`)
  },
  {
    name: "Resource leak",
    exclude: (f) => anyMatch(RESOURCE_LEAK, `${f.category} ${f.description}`)
  },
  {
    name: "Open redirect",
    exclude: (f) => anyMatch(OPEN_REDIRECT, `${f.category} ${f.description}`)
  },
  {
    name: "Regex injection",
    exclude: (f) => anyMatch(REGEX_INJECTION, `${f.category} ${f.description}`)
  },
  {
    name: "Memory safety in non-C/C++",
    exclude: (f) => !C_CPP_EXTENSIONS.has(extOf2(f.file)) && anyMatch(MEMORY_SAFETY, `${f.category} ${f.description}`)
  },
  {
    name: "SSRF in HTML",
    exclude: (f) => extOf2(f.file) === ".html" && anyMatch(SSRF, `${f.category} ${f.description}`)
  }
];
function filterFindings(findings) {
  const kept = [];
  let excluded = 0;
  for (const finding of findings) {
    const matched = rules.find((r) => r.exclude(finding));
    if (matched) {
      excluded++;
      console.log(`  [filter] excluded: "${matched.name}" \u2014 ${finding.file}:${finding.line} (${finding.category})`);
    } else {
      kept.push(finding);
    }
  }
  if (excluded > 0) {
    console.log(`  [filter] ${excluded} finding(s) excluded, ${kept.length} kept`);
  }
  return kept;
}

// src/auth.ts
var https = __toESM(require("https"));
var http = __toESM(require("http"));
var TOKEN_EXCHANGE_URL = "https://code-refinery.emarjay921.workers.dev/token-exchange";
async function getOidcToken(audience) {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error(
      "OIDC token request env vars not found. Add `id-token: write` to your workflow permissions."
    );
  }
  const url = `${requestUrl}&audience=${encodeURIComponent(audience)}`;
  const data = await httpRequest("GET", url, {
    Authorization: `Bearer ${requestToken}`
  });
  const parsed = JSON.parse(data);
  if (!parsed.value) {
    throw new Error("OIDC token response missing `value` field.");
  }
  return parsed.value;
}
async function exchangeForAppToken(oidcToken) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const data = await httpRequest("POST", TOKEN_EXCHANGE_URL, {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json"
      });
      const parsed = JSON.parse(data);
      const token = parsed.token || parsed.app_token;
      if (!token) {
        throw new Error("Token exchange response missing `token` field.");
      }
      return token;
    } catch (err) {
      if (attempt < maxAttempts) {
        const delay = attempt * 5e3;
        console.warn(
          `  Token exchange attempt ${attempt} failed, retrying in ${delay / 1e3}s...`
        );
        await sleep2(delay);
      } else {
        throw err;
      }
    }
  }
  throw new Error("Token exchange failed after all retries.");
}
async function setupGitHubToken() {
  const oidcToken = await getOidcToken("code-refinery");
  const appToken = await exchangeForAppToken(oidcToken);
  return appToken;
}
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function httpRequest(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      { method, headers, timeout: 3e4 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${data.slice(0, 500)}`
              )
            );
          } else {
            resolve(data);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP request timed out: ${method} ${urlStr}`));
    });
    if (body) req.write(body);
    req.end();
  });
}

// src/review.ts
function getInput(name, fallback = "") {
  return process.env[`INPUT_${name.toUpperCase()}`] ?? fallback;
}
function readConfig() {
  return {
    repo: process.env.GITHUB_REPOSITORY ?? "",
    prNumber: Number(process.env.PR_NUMBER ?? process.env.GITHUB_REF_NAME?.match(/^(\d+)\//)?.[1] ?? "0"),
    model: getInput("model", "sonnet"),
    strictness: getInput("strictness", "normal"),
    customInstructions: getInput("custom_instructions"),
    excludePatterns: getInput("exclude_patterns").split("\n").map((p) => p.trim()).filter(Boolean),
    failOnCritical: getInput("fail_on_critical") === "true",
    autoMerge: getInput("auto_merge") === "true",
    autoMergeMethod: getInput("auto_merge_method", "squash"),
    maxTurns: getInput("max_turns") ? Number(getInput("max_turns")) : void 0,
    maxBudgetUsd: getInput("max_budget_usd") ? Number(getInput("max_budget_usd")) : void 0,
    timeoutMinutes: Number(getInput("timeout_minutes", "20"))
  };
}
function globToRegex(pattern) {
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0DOUBLESTAR\0").replace(/\*/g, "[^/]*").replace(/\0DOUBLESTAR\0/g, ".*").replace(/\?/g, "[^/]");
  return new RegExp(`^${re}$`);
}
function matchGlob(pattern, filepath) {
  const re = globToRegex(pattern);
  if (re.test(filepath)) return true;
  if (!pattern.includes("/")) {
    const basename = path.posix.basename(filepath);
    if (re.test(basename)) return true;
  }
  return false;
}
function filterExcludedFiles(files, patterns) {
  if (patterns.length === 0) return files;
  const kept = [];
  for (const file of files) {
    const excluded = patterns.some((p) => matchGlob(p, file.filename));
    if (excluded) {
      console.log(`  [exclude] ${file.filename}`);
    } else {
      kept.push(file);
    }
  }
  if (kept.length < files.length) {
    console.log(`  [exclude] ${files.length - kept.length} file(s) excluded, ${kept.length} remaining`);
  }
  return kept;
}
var GENERATED_MARKERS = [
  "@generated",
  "Code generated by OpenAPI Generator",
  "Code generated by protoc-gen-go",
  "AUTO-GENERATED",
  "DO NOT EDIT"
];
function filterDiffByFiles(diff, allowedFiles) {
  const sections = diff.split(/(?=^diff --git )/m);
  const kept = [];
  for (const section of sections) {
    const match = section.match(/^diff --git a\/(.+?) b\/(.+)/);
    if (!match) {
      if (section.trim()) kept.push(section);
      continue;
    }
    const fileB = match[2];
    if (!allowedFiles.has(fileB)) continue;
    if (GENERATED_MARKERS.some((m) => section.includes(m))) {
      console.log(`  [exclude] generated file in diff: ${fileB}`);
      continue;
    }
    kept.push(section);
  }
  return kept.join("");
}
function computeVerdict(findings) {
  if (findings.some((f) => f.severity === "critical")) return "request_changes";
  if (findings.some((f) => f.severity === "warning")) return "comment";
  return "approve";
}
function formatFindingsSection(label, icon, findings) {
  if (findings.length === 0) return "";
  const lines = [];
  lines.push(`<details>`);
  lines.push(`<summary>${icon} ${label} (${findings.length})</summary>`);
  lines.push("");
  for (const f of findings) {
    const passLabel = f.pass_type === "security" ? "Security" : "Code Quality";
    lines.push(`#### \`${f.file}:${f.line}\` \u2014 ${f.category}`);
    lines.push("");
    lines.push(`| | |`);
    lines.push(`|---|---|`);
    lines.push(`| **Severity** | ${f.severity} |`);
    lines.push(`| **Pass** | ${passLabel} |`);
    lines.push(`| **Confidence** | ${f.confidence} |`);
    lines.push("");
    lines.push(f.description);
    lines.push("");
    if (f.recommendation) {
      lines.push(`**Recommendation:** ${f.recommendation}`);
      lines.push("");
    }
    if (f.exploit_scenario) {
      lines.push(`**Exploit scenario:** ${f.exploit_scenario}`);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }
  lines.push(`</details>`);
  lines.push("");
  return lines.join("\n");
}
function buildSummaryComment(opts) {
  const { verdict, findings, securityCompleted, qualityCompleted, filteredCount, duplicateCount, mergeResult, trivial } = opts;
  const lines = [];
  if (trivial) {
    lines.push("## Code Refinery Review \u2014 Skipped (Trivial PR)");
    lines.push("");
    lines.push("This PR contains only documentation, configuration, or lockfile changes. No security or code quality review was performed.");
    lines.push("");
    lines.push(`<sub>Reviewed by Code Refinery</sub>`);
    return lines.join("\n");
  }
  const verdictIcon = verdict === "approve" ? "Approved" : verdict === "comment" ? "Comments" : "Changes Requested";
  const verdictEmoji = verdict === "approve" ? "\u2705" : verdict === "comment" ? "\u26A0\uFE0F" : "\u274C";
  lines.push(`## ${verdictEmoji} Code Refinery Review \u2014 ${verdictIcon}`);
  lines.push("");
  const secFindings = findings.filter((f) => f.pass_type === "security");
  const qualFindings = findings.filter((f) => f.pass_type === "code-quality");
  const count = (arr, sev) => arr.filter((f) => f.severity === sev).length;
  lines.push("| | Critical | Warning | Info |");
  lines.push("|---|:---:|:---:|:---:|");
  lines.push(`| Security | ${count(secFindings, "critical")} | ${count(secFindings, "warning")} | ${count(secFindings, "info")} |`);
  lines.push(`| Code Quality | ${count(qualFindings, "critical")} | ${count(qualFindings, "warning")} | ${count(qualFindings, "info")} |`);
  lines.push("");
  const criticals = findings.filter((f) => f.severity === "critical");
  const warnings = findings.filter((f) => f.severity === "warning");
  const infos = findings.filter((f) => f.severity === "info");
  lines.push(formatFindingsSection("Critical", "\u{1F534}", criticals));
  lines.push(formatFindingsSection("Warning", "\u{1F7E1}", warnings));
  lines.push(formatFindingsSection("Info", "\u{1F7E2}", infos));
  if (!securityCompleted || !qualityCompleted) {
    const incomplete = [];
    if (!securityCompleted) incomplete.push("Security");
    if (!qualityCompleted) incomplete.push("Code Quality");
    lines.push(`> **Note:** The following review pass(es) did not complete successfully: ${incomplete.join(", ")}. Results may be incomplete.`);
    lines.push("");
  }
  if (filteredCount > 0) {
    lines.push(`<sub>${filteredCount} finding(s) were filtered as likely false positives.</sub>`);
    lines.push("");
  }
  if (duplicateCount) {
    lines.push(`<sub>${duplicateCount} duplicate finding(s) reported by both passes were merged.</sub>`);
    lines.push("");
  }
  if (mergeResult) {
    if (mergeResult.merged) {
      lines.push(`**Auto-merged** (sha: \`${mergeResult.sha}\`): ${mergeResult.message}`);
    } else {
      lines.push(`**Auto-merge attempted but failed:** ${mergeResult.message}`);
    }
    lines.push("");
  }
  lines.push(`<sub>Reviewed by Code Refinery</sub>`);
  return lines.join("\n");
}
function setOutputs(values) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.log("GITHUB_OUTPUT not set \u2014 printing outputs to console:");
    for (const [k, v] of Object.entries(values)) {
      console.log(`  ${k}=${v}`);
    }
    return;
  }
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n");
  fs.appendFileSync(outputFile, lines + "\n", "utf-8");
}
async function main() {
  const config = readConfig();
  if (!config.repo) {
    console.error("GITHUB_REPOSITORY is not set. Cannot determine repository.");
    process.exit(1);
  }
  if (!config.prNumber || config.prNumber === 0) {
    console.error("PR number could not be determined from PR_NUMBER or GITHUB_REF_NAME.");
    process.exit(1);
  }
  console.log("Code Refinery \u2014 PR Review");
  console.log(`  repo:       ${config.repo}`);
  console.log(`  pr:         #${config.prNumber}`);
  console.log(`  model:      ${config.model}`);
  console.log(`  strictness: ${config.strictness}`);
  if (config.excludePatterns.length > 0) {
    console.log(`  exclude:    ${config.excludePatterns.join(", ")}`);
  }
  if (config.autoMerge) {
    console.log(`  auto-merge: ${config.autoMergeMethod}`);
  }
  try {
    (0, import_child_process3.execFileSync)("claude", ["--version"], { encoding: "utf-8", timeout: 1e4, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    console.error("Claude Code CLI is not installed or not in PATH. Install with: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }
  const workflowToken = process.env.GITHUB_TOKEN;
  console.log("\nSetting up GitHub App token via OIDC exchange...");
  try {
    const appToken = await setupGitHubToken();
    process.env.GH_TOKEN = appToken;
    console.log("  App token obtained. Comments will appear as code-refinery bot.");
  } catch (err) {
    console.warn(`  OIDC token exchange failed: ${err.message}`);
    console.warn("  Falling back to default GITHUB_TOKEN.");
  }
  let prData;
  let diff;
  try {
    console.log("\nFetching PR data...");
    prData = getPRData(config.repo, config.prNumber);
    console.log(`  title: "${prData.title}" by ${prData.user}`);
    console.log(`  ${prData.changedFiles} files, +${prData.additions} -${prData.deletions}`);
    diff = getPRDiff(config.repo, config.prNumber);
    console.log(`  diff size: ${diff.length} chars`);
  } catch (err) {
    console.error(`Failed to fetch PR data: ${err.message}`);
    process.exit(1);
  }
  let files = prData.files;
  if (config.excludePatterns.length > 0) {
    console.log("\nApplying exclude patterns...");
    files = filterExcludedFiles(files, config.excludePatterns);
    prData = { ...prData, files };
    const allowedSet = new Set(files.map((f) => f.filename));
    diff = filterDiffByFiles(diff, allowedSet);
  }
  if (files.length === 0) {
    console.log("\nAll files excluded by patterns. Nothing to review.");
    const summary2 = buildSummaryComment({
      verdict: "approve",
      findings: [],
      securityCompleted: true,
      qualityCompleted: true,
      filteredCount: 0,
      trivial: true
    });
    try {
      postSummaryComment(config.repo, config.prNumber, summary2);
    } catch (err) {
      console.warn(`Failed to post summary: ${err.message}`);
    }
    setOutputs({ findings_count: "0", critical_count: "0", verdict: "approve" });
    return;
  }
  console.log("\nChecking if PR is trivial...");
  if (isTrivialPR(files)) {
    console.log("PR is trivial \u2014 skipping review.");
    const summary2 = buildSummaryComment({
      verdict: "approve",
      findings: [],
      securityCompleted: true,
      qualityCompleted: true,
      filteredCount: 0,
      trivial: true
    });
    try {
      postSummaryComment(config.repo, config.prNumber, summary2);
    } catch (err) {
      console.warn(`Failed to post summary: ${err.message}`);
    }
    setOutputs({ findings_count: "0", critical_count: "0", verdict: "approve" });
    return;
  }
  const priorThreads = getPriorThreads(config.repo, config.prNumber);
  if (priorThreads.length > 0) {
    console.log(`
Found ${priorThreads.length} review thread(s) from earlier runs.`);
  }
  const changedFiles = files.map((f) => f.filename);
  const userContext = buildUserContext(prData, diff, changedFiles, true, priorThreads);
  const repoDir = process.env.GITHUB_WORKSPACE || process.cwd();
  async function runPass(passLabel, passType, systemPrompt) {
    const baseOpts = {
      systemPrompt,
      repoDir,
      model: config.model,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
      timeoutMinutes: config.timeoutMinutes,
      label: passLabel
    };
    const started = Date.now();
    let result = await invokeClaude({ ...baseOpts, prompt: userContext });
    if (result.promptTooLong) {
      console.warn(`  [${passLabel}] prompt too long, retrying without diff...`);
      const smallerContext = buildUserContext(prData, diff, changedFiles, false, priorThreads);
      result = await invokeClaude({ ...baseOpts, prompt: smallerContext });
    }
    for (const f of result.output.findings) {
      f.pass_type = passType;
    }
    const seconds = Math.round((Date.now() - started) / 1e3);
    console.log(
      `  [${passLabel}] completed: ${result.output.analysis_summary.review_completed}, findings: ${result.output.findings.length} (${seconds}s)`
    );
    return result;
  }
  console.log("\n--- Running Security and Code Quality passes in parallel ---");
  const [securityInvoke, qualityInvoke] = await Promise.all([
    runPass("Security", "security", buildSecurityPrompt(config.strictness, config.customInstructions)),
    runPass("Code Quality", "code-quality", buildCodeQualityPrompt(config.strictness, config.customInstructions))
  ]);
  const securityResult = securityInvoke.output;
  const qualityResult = qualityInvoke.output;
  const securityCompleted = securityResult.analysis_summary.review_completed;
  const qualityCompleted = qualityResult.analysis_summary.review_completed;
  const allFindings = [...securityResult.findings, ...qualityResult.findings];
  console.log(`
Total raw findings: ${allFindings.length}`);
  console.log("Applying false-positive filters...");
  const afterFilters = filterFindings(allFindings);
  const filteredCount = allFindings.length - afterFilters.length;
  console.log("Merging duplicate findings...");
  const filtered = dedupeFindings(afterFilters);
  const duplicateCount = afterFilters.length - filtered.length;
  const criticalCount = filtered.filter((f) => f.severity === "critical").length;
  const warningCount = filtered.filter((f) => f.severity === "warning").length;
  const infoCount = filtered.filter((f) => f.severity === "info").length;
  console.log(`  after filtering: ${filtered.length} (${criticalCount} critical, ${warningCount} warning, ${infoCount} info)`);
  const verdict = computeVerdict(filtered);
  console.log(`
Verdict: ${verdict}`);
  try {
    postInlineReview(config.repo, config.prNumber, prData.headSha, filtered, files, priorThreads);
  } catch (err) {
    console.warn(`Failed to post inline review: ${err.message}`);
  }
  let mergeResult;
  if (config.autoMerge && verdict !== "request_changes") {
    console.log(`
Auto-merging PR (method: ${config.autoMergeMethod})...`);
    mergeResult = mergePR(config.repo, config.prNumber, config.autoMergeMethod, workflowToken);
    if (mergeResult.merged) {
      console.log(`  Merged successfully (sha: ${mergeResult.sha}).`);
    } else {
      console.log(`  Merge failed: ${mergeResult.message}`);
    }
  }
  const summary = buildSummaryComment({
    verdict,
    findings: filtered,
    securityCompleted,
    qualityCompleted,
    filteredCount,
    duplicateCount,
    mergeResult
  });
  try {
    postSummaryComment(config.repo, config.prNumber, summary);
  } catch (err) {
    console.warn(`Failed to post summary comment: ${err.message}`);
  }
  setOutputs({
    findings_count: String(filtered.length),
    critical_count: String(criticalCount),
    verdict
  });
  if (config.failOnCritical && criticalCount > 0) {
    console.error(`
Failing: ${criticalCount} critical finding(s) detected and fail_on_critical is enabled.`);
    process.exit(1);
  }
  console.log("\nReview complete.");
}
main();
