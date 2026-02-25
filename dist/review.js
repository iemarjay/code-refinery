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

// src/github.ts
var import_child_process = require("child_process");
var REVIEW_MARKER = "<!-- code-refinery-review -->";
function ghApi(endpoint, method = "GET", data, headers) {
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
    timeout: 3e4
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
<sub>confidence: ${finding.confidence} | Code Refinery</sub>`;
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
function postInlineReview(repo, prNumber, headSha, findings, prFiles) {
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
  for (const finding of inlineFindings) {
    if (!fileMap.has(finding.file)) {
      console.log(
        `File ${finding.file} not in PR diff, skipping inline comment.`
      );
      continue;
    }
    reviewComments.push({
      path: finding.file,
      line: finding.line,
      side: "RIGHT",
      body: formatFindingComment(finding)
    });
  }
  if (reviewComments.length === 0) {
    console.log("No findings map to files in the PR diff.");
    return;
  }
  try {
    ghApi(`/repos/${repo}/pulls/${prNumber}/reviews`, "POST", {
      commit_id: headSha,
      event: "COMMENT",
      comments: reviewComments
    });
    console.log(
      `Posted batch review with ${reviewComments.length} inline comments.`
    );
    return;
  } catch (err) {
    console.warn(
      "Batch review failed (line numbers may be outside diff context). Falling back to individual comments.",
      err.message
    );
  }
  let posted = 0;
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
        `Could not post comment on ${comment.path}:${comment.line} \u2014 line may not be in diff context.`
      );
    }
  }
  console.log(
    `Posted ${posted}/${reviewComments.length} individual inline comments.`
  );
}
function mergePR(repo, prNumber, method) {
  try {
    const response = ghApi(
      `/repos/${repo}/pulls/${prNumber}/merge`,
      "PUT",
      { merge_method: method }
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
function parseClaudeOutput(stdout) {
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
  console.warn("Claude output missing structured_output and result fields.");
  return EMPTY_RESULT;
}
function invokeClaude(options) {
  const {
    prompt,
    systemPrompt,
    repoDir,
    model,
    maxTurns,
    maxBudgetUsd,
    timeoutMinutes,
    disallowedTools = "Bash(ps:*)"
  } = options;
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
  try {
    const stdout = (0, import_child_process2.execFileSync)("claude", args, {
      input: prompt,
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs
    });
    return parseClaudeOutput(stdout);
  } catch (err) {
    const error = err;
    if (error.code === "ETIMEDOUT" || error.message?.includes("TIMEOUT")) {
      console.error(`Claude CLI timed out after ${timeoutMinutes} minutes.`);
    } else {
      console.error(
        `Claude CLI failed (exit ${error.status ?? "unknown"}): ${error.stderr?.slice(0, 500) || error.message}`
      );
    }
    return EMPTY_RESULT;
  }
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
function buildUserContext(prData, diff, changedFiles) {
  const { text: diffText, truncated } = truncateDiff(diff);
  const truncationNote = truncated ? "\nNOTE: The diff was truncated due to size. Use file exploration tools (Read, Grep, Glob) to examine files not shown in the diff.\n" : "";
  const filesList = changedFiles.map((f) => `- ${f}`).join("\n");
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
${truncationNote}
DIFF:
\`\`\`
${diffText}
\`\`\`

Review the PR diff above. Analyze the changes and produce your findings as structured JSON.`;
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
    if (allowedFiles.has(fileB)) {
      kept.push(section);
    }
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
  const { verdict, findings, securityCompleted, qualityCompleted, filteredCount, mergeResult, trivial } = opts;
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
  const changedFiles = files.map((f) => f.filename);
  const userContext = buildUserContext(prData, diff, changedFiles);
  const repoDir = process.env.GITHUB_WORKSPACE || process.cwd();
  console.log("\n--- Pass 1: Security Review ---");
  const securityPrompt = buildSecurityPrompt(config.strictness, config.customInstructions);
  const securityResult = invokeClaude({
    prompt: userContext,
    systemPrompt: securityPrompt,
    repoDir,
    model: config.model,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    timeoutMinutes: config.timeoutMinutes
  });
  const securityCompleted = securityResult.analysis_summary.review_completed;
  console.log(`  completed: ${securityCompleted}, findings: ${securityResult.findings.length}`);
  for (const f of securityResult.findings) {
    f.pass_type = "security";
  }
  console.log("\n--- Pass 2: Code Quality Review ---");
  const qualityPrompt = buildCodeQualityPrompt(config.strictness, config.customInstructions);
  const qualityResult = invokeClaude({
    prompt: userContext,
    systemPrompt: qualityPrompt,
    repoDir,
    model: config.model,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    timeoutMinutes: config.timeoutMinutes
  });
  const qualityCompleted = qualityResult.analysis_summary.review_completed;
  console.log(`  completed: ${qualityCompleted}, findings: ${qualityResult.findings.length}`);
  for (const f of qualityResult.findings) {
    f.pass_type = "code-quality";
  }
  const allFindings = [...securityResult.findings, ...qualityResult.findings];
  console.log(`
Total raw findings: ${allFindings.length}`);
  console.log("Applying false-positive filters...");
  const filtered = filterFindings(allFindings);
  const filteredCount = allFindings.length - filtered.length;
  const criticalCount = filtered.filter((f) => f.severity === "critical").length;
  const warningCount = filtered.filter((f) => f.severity === "warning").length;
  const infoCount = filtered.filter((f) => f.severity === "info").length;
  console.log(`  after filtering: ${filtered.length} (${criticalCount} critical, ${warningCount} warning, ${infoCount} info)`);
  const verdict = computeVerdict(filtered);
  console.log(`
Verdict: ${verdict}`);
  try {
    postInlineReview(config.repo, config.prNumber, prData.headSha, filtered, files);
  } catch (err) {
    console.warn(`Failed to post inline review: ${err.message}`);
  }
  let mergeResult;
  if (config.autoMerge && verdict === "approve") {
    console.log(`
Auto-merging PR (method: ${config.autoMergeMethod})...`);
    mergeResult = mergePR(config.repo, config.prNumber, config.autoMergeMethod);
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
