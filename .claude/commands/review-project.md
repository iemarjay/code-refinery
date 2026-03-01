---
allowed-tools: Bash(find:*), Read, Glob, Grep, LS, Task
description: Full project scan (security + code quality) — walks ALL source files, not limited to a git diff. Use for auditing an unfamiliar codebase, pre-release review, or targeted module audit. Optionally pass a path to scope the scan.
argument-hint: [optional-path-to-scan]
---

You are orchestrating a full project security and code quality scan.

Scan root: **$ARGUMENTS** (defaults to `.` if not provided)

SOURCE FILES TO REVIEW:

```
!`find ${ARGUMENTS:-.} -type f \( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.rb" -o -name "*.php" -o -name "*.cs" -o -name "*.swift" -o -name "*.kt" \) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/vendor/*" -not -path "*/__pycache__/*" -not -name "*.min.js" -not -name "*.d.ts" | sort`
```

Total files: count the lines above.

---

## STEP 1 — Parallel Sub-Agent Scan

Dispatch `security-reviewer` and `code-quality-reviewer` as parallel sub-tasks.

Pass each agent:
- The complete list of source files enumerated above
- This instruction: "You are doing a FULL PROJECT SCAN — not a diff review. Use Read, Grep, and Glob to examine the actual file contents. Walk the file list systematically. Focus on systemic patterns and real bugs — skip one-off per-line nits and trivial style observations."

**File prioritization order** — agents must process files in this order, highest risk first:
1. Auth, session, permission, token, and credential handling code
2. Network handlers, HTTP endpoints, request parsing, and input processing
3. Data serialization, deserialization, and external input parsing
4. Core business logic and state management
5. Utilities and helpers (lowest risk — skip trivial issues here)

Tell both agents which mode they are in: **full-scan mode** (reviewing entire files, not a diff).

Also tell each agent to explicitly skip:
- node_modules/, dist/, build/, vendor/, .git/, __pycache__/
- Lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml, poetry.lock, cargo.lock, go.sum)
- Generated files: *.min.js, *.d.ts, *.pb.go, *.generated.*, *_gen.go
- Markdown and documentation files (*.md, *.rst, *.txt)

---

## STEP 2 — Compile Results

Collect all findings from both agents. Apply hard exclusion filter:

HARD EXCLUSIONS — discard any finding matching:
1. Denial of Service (DoS) or resource exhaustion
2. Rate limiting recommendations or missing rate limits
3. Resource leaks (unclosed files, connections, sockets)
4. Open redirect vulnerabilities
5. Regex injection or ReDoS
6. Memory safety issues (buffer overflow, use-after-free) in non-C/C++ files
7. SSRF in HTML or client-side files
8. Secrets on disk if secured by external tooling
9. Missing input validation with no concrete exploit path
10. Issues in lockfiles, dist/, build/, vendor/, .d.ts, .min.js, or .md files

Deduplicate: if both agents flagged the same file+line+root cause, keep the more detailed one.
Discard findings with confidence < 0.8.

Count surviving findings by severity:
- critical: findings that would block a production deploy
- warning: real issues worth fixing
- info: suggestions that won't block

Compute the verdict:
- Any critical finding → `request_changes`
- Any warning finding, no critical → `comment`
- Zero critical and warning → `approve`

---

## STEP 3 — Output Report

Print the report in this exact structure:

---

## [VERDICT_ICON] [VERDICT] — N critical, N warning, N info

**Scan scope:** `$ARGUMENTS` (or `.` — entire project)
**Files reviewed:** N source files

| | Critical | Warning | Info |
|---|:---:|:---:|:---:|
| Security | N | N | N |
| Code Quality | N | N | N |

---

[For each severity group that has findings, use a collapsible section:]

<details>
<summary>🔴 Critical (N)</summary>

[findings here, grouped by file]

</details>

<details>
<summary>🟡 Warning (N)</summary>

[findings here, grouped by file]

</details>

<details open>
<summary>🔵 Info (N)</summary>

[findings here, grouped by file]

</details>

---

Each finding block:

### [severity] `file/path.ts:LINE` — `category_name`

**Pass:** Security | Code Quality
**Confidence:** 0.XX

[Description of the issue and why it matters]

**Exploit Scenario:** [Required for critical security findings only]

**Recommendation:** [Specific fix — not generic advice]

---

Verdict icons:
- `request_changes` → ❌
- `comment` → ⚠️
- `approve` → ✅

If there are zero findings:

```
## ✅ approve — no findings

**Scan scope:** [path]
**Files reviewed:** N source files

No security vulnerabilities or code quality issues were found.
```
