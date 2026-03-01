---
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*), Read, Glob, Grep, LS, Task
description: Review pending branch changes (security + code quality) against origin/HEAD. Use when you want to check your work before pushing.
---

You are orchestrating a two-pass code review of the current branch's pending changes.

GIT STATUS:

```
!`git status`
```

FILES MODIFIED:

```
!`git diff --name-only --merge-base origin/HEAD`
```

COMMITS ON THIS BRANCH:

```
!`git log --no-decorate origin/HEAD...`
```

DIFF CONTENT:

```
!`git diff --merge-base origin/HEAD`
```

---

Review the complete diff above. It shows everything this branch introduces compared to `origin/HEAD`.

If the diff is empty (clean branch), output only:

```
## ✅ approve — no changes to review
```

Then stop.

---

## STEP 1 — Parallel Sub-Agent Review

Dispatch `security-reviewer` and `code-quality-reviewer` as parallel sub-tasks.

Pass each agent:
- The full diff content from above
- The list of modified files
- This instruction: "You are reviewing a git diff. Analyze ONLY the changed code shown in the diff — do not comment on unchanged code. Use file exploration tools to understand context (existing patterns, callers, dependencies) before forming findings. Report only noteworthy findings with confidence >= 0.7."

Tell both agents which mode they are in: **diff mode** (reviewing a branch diff, not a full project scan).

---

## STEP 2 — False Positive Filter (Parallel)

For each finding returned by the agents in Step 1, spawn a parallel sub-task to validate it.

Each filter sub-task receives:
- The specific finding (file, line, severity, category, description, confidence)
- The relevant diff hunk or code context
- The full exclusion list below

The filter sub-task must:
1. Re-read the code at the cited location using file exploration tools if needed
2. Verify the finding is real and not a false positive
3. Assign a revised confidence score (0.0–1.0)
4. State whether to KEEP or DISCARD the finding and why

HARD EXCLUSIONS — a finding must be discarded if it matches any of these:
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

SIGNAL QUALITY CRITERIA:
1. Is there a concrete, exploitable path with specific code locations?
2. Does this represent a real risk vs. theoretical best practice?
3. Would this finding be actionable for a developer right now?

---

## STEP 3 — Compile Results

Discard any finding where the filter sub-task assigned confidence < 0.8 or recommended DISCARD.
Deduplicate: if security-reviewer and code-quality-reviewer both flagged the same file+line+root cause, keep the more detailed one.

Count surviving findings by severity:
- critical: findings that would block a production deploy
- warning: real issues worth fixing before merge
- info: suggestions that won't block merge

Compute the verdict:
- Any critical finding → `request_changes`
- Any warning finding, no critical → `comment`
- Zero critical and warning → `approve`

---

## STEP 4 — Output Report

Print the report in this exact structure:

---

## [VERDICT_ICON] [VERDICT] — N critical, N warning, N info

| | Critical | Warning | Info |
|---|:---:|:---:|:---:|
| Security | N | N | N |
| Code Quality | N | N | N |

---

[For each severity group that has findings, use a collapsible section:]

<details>
<summary>🔴 Critical (N)</summary>

[findings here]

</details>

<details>
<summary>🟡 Warning (N)</summary>

[findings here]

</details>

<details open>
<summary>🔵 Info (N)</summary>

[findings here]

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

If there are zero findings across all severities, output only:

```
## ✅ approve — no findings

No security vulnerabilities or code quality issues were found in the changes on this branch.
```
