# Code Refinery

GitHub Action for automated PR review — two dedicated passes (security + code quality) using Claude Code CLI in full agentic mode. Designed for Pro/Max subscribers and small teams who want thorough reviews without enterprise pricing.

## Rules

- **NEVER modify files in `vendor/`** — those are cloned reference repos (Anthropic's actions), read-only for studying prompts and patterns.
- **Always check `dist/review.js` into git** after building — standard for GitHub Actions distribution.
- When editing prompts in `prompts.ts`, explain the reasoning — prompt quality determines review quality.
- **After completing each phase**, update this CLAUDE.md: mark the phase ✅, document what was built (files, functions, key decisions), and record the verification results. This is the living spec — keep it accurate.

## Architecture

```
GitHub PR opened/synchronized
  │
  ▼
action.yml (composite GitHub Action)
  │
  ├─ Setup: install Node 20 + claude CLI
  │
  ├─ node dist/review.js
  │   │
  │   ├─ Fetch PR data + diff (gh CLI)
  │   ├─ Trivial PR check → skip if docs/config only
  │   │
  │   ├─ Pass 1: Security Review
  │   │   └─ claude --output-format json --json-schema '{...}'
  │   │      --append-system-prompt "{security_prompt}"
  │   │      (full agentic mode, Sonnet default, prompt via stdin)
  │   │
  │   ├─ Pass 2: Code Quality Review
  │   │   └─ claude --output-format json --json-schema '{...}'
  │   │      --append-system-prompt "{quality_prompt}"
  │   │      (full agentic mode, Sonnet default, prompt via stdin)
  │   │
  │   ├─ Merge findings + false positive filter (hard regex rules)
  │   │
  │   ├─ Post inline review comments (critical + warning)
  │   └─ Post summary comment (full overview)
  │
  └─ Set outputs: findings_count, critical_count, verdict
```

### How Claude Is Invoked

Like Anthropic's security review, we use `claude` (NOT `claude -p`) in full agentic mode:

```
claude \
  --output-format json \
  --model sonnet \
  --json-schema '{schema}' \
  --append-system-prompt "{prompt}" \
  --disallowed-tools "Bash(ps:*)" \
  < user_context_with_diff
```

- **Full agentic mode** — Claude decides how many turns to explore. Uses Read, Grep, Glob tools to understand repo context.
- **`--json-schema`** — constrained decoding guarantees valid JSON output. No regex parsing hacks.
- **Prompt via stdin** — avoids argument length limits (same pattern as Anthropic).
- **`--disallowed-tools "Bash(ps:*)"`** — only restriction, same as Anthropic. Claude can use all built-in read tools.
- For API key users: optional `--max-turns` or `--max-budget-usd` for cost control.
- For Pro/Max subscription users: unlimited turns (flat monthly rate, no per-token cost).

### Auto-Merge

When `auto_merge` is enabled and the review verdict is `approve` (no critical or warning findings), the action automatically merges the PR. This is opt-in and designed for teams that trust the review for low-risk PRs (e.g., junior dev PRs that pass both security and quality checks).

- `auto_merge: true` — enable auto-merge on approval
- `auto_merge_method` — `squash` (default), `merge`, or `rebase`
- Only merges if verdict is `approve` (zero critical/warning findings after filtering)
- Respects branch protection rules — if the repo requires other checks or approvals, the merge will fail gracefully and the action logs why
- Posts a comment noting the auto-merge before executing it

### Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Two separate passes | Security then quality | Dedicated focus per concern. No split attention |
| Full agentic mode | Not `-p` print mode | Same depth as Anthropic. Claude explores freely |
| `claude` CLI | Not SDK or raw API | Inherits user's auth. Multi-turn agent loop built in |
| `--json-schema` | Constrained decoding | Guarantees valid JSON. Anthropic regex-parses free text |
| Sonnet default | Configurable to Opus | Pro-friendly. Opus for critical repos |
| Hard FP filters only | No second Claude call | Saves tokens. Regex rules handle 90% of false positives |
| `gh` CLI for GitHub API | Not octokit | Pre-installed on runners, zero npm runtime deps |
| Env var passthrough | Provider-agnostic | Users set ANTHROPIC_BASE_URL, USE_BEDROCK, etc. |

### Provider Support

All via `claude` CLI env vars — zero provider-specific code from us:

| Provider | Env Vars |
|----------|----------|
| Anthropic (API key) | `ANTHROPIC_API_KEY` |
| Claude Pro/Max (subscription) | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) |
| Cloudflare AI Gateway | `ANTHROPIC_BASE_URL=https://gateway.ai.cloudflare.com/v1/{ACCT}/{GW}/anthropic` |
| AWS Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` + AWS creds |
| Google Vertex AI | `CLAUDE_CODE_USE_VERTEX=1` + GCP creds |
| Azure Foundry | `CLAUDE_CODE_USE_FOUNDRY=1` + Azure creds |
| Any proxy (LiteLLM, OpenRouter) | `ANTHROPIC_BASE_URL=https://your-proxy.com` |

## Directory Structure

```
action.yml                    — GitHub Action definition (composite)
package.json                  — Build deps only (esbuild, typescript)
tsconfig.json
src/
  review.ts                   — Main orchestrator (entry point)
  types.ts                    — ReviewFinding, ReviewOutput, ClaudeJsonResult, PRData, PRFile, MergeResult, ActionConfig
  schema.ts                   — JSON schema for --json-schema constrained output
  prompts.ts                  — Security prompt, code quality prompt, user context builder
  trivial.ts                  — Trivial PR detection (docs/config/lock files)
  claude.ts                   — Claude CLI invocation via execFileSync
  filter.ts                   — Hard false-positive filtering (regex rules)
  github.ts                   — PR data fetch, inline review posting, summary comment
dist/
  review.js                   — Bundled output (checked into git)
vendor/                       — Reference repos (gitignored, read-only)
  claude-code-action/         — Anthropic's general PR action
  claude-code-security-review/ — Anthropic's security review action
```

## Implementation Phases

### Phase 1: Scaffold ✅
Created root-level config files so `npm install && npm run build` works.

- `.gitignore` — node_modules, .claude, vendor, dist (except dist/review.js)
- `package.json` — devDeps: esbuild@0.24, typescript@5.7, @types/node@20. Scripts: `build` (esbuild bundle), `typecheck` (tsc --noEmit)
- `tsconfig.json` — target ES2022, module ES2022, moduleResolution bundler, strict
- `action.yml` — composite action with 17 inputs and 3 outputs. Three steps: setup-node@v4, install `@anthropic-ai/claude-code` globally, run `node dist/review.js`. Provider env vars (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY) are mapped from inputs to env. All config flows to review.js as `INPUT_*` env vars.
- `src/types.ts` — `ReviewFinding`, `ReviewOutput`, `ClaudeJsonResult`, `ActionConfig` interfaces. **Severity uses `critical | warning | info`** (not Anthropic's HIGH/MEDIUM/LOW) because it aligns with GitHub review terminology and the verdict logic keys off these directly. `PassType` is `"security" | "code-quality"`. `ClaudeJsonResult` handles both `structured_output` (from --json-schema) and `result` string fallback.
- `src/schema.ts` — JSON Schema object matching `ReviewOutput` structure, exported as both object (`reviewSchema`) and serialized string (`reviewSchemaJson`). Enforces `severity` enum, `confidence` 0-1 range, `additionalProperties: false` at all levels.
- `src/review.ts` — stub entry point. Reads config from `INPUT_*` env vars via `getInput()` helper, parses `excludePatterns` (newline-split), `maxTurns`/`maxBudgetUsd` (number or undefined), booleans from string comparison. Logs config and exits. PR number extracted from `PR_NUMBER` env or `GITHUB_REF_NAME` pattern.

**Verified:** `npm install` (29 packages), `npm run build` → `dist/review.js` (1.4kb), `npx tsc --noEmit` passes, `node dist/review.js` runs and prints config stub.

### Phase 2: GitHub Integration ✅
All GitHub API interaction via `gh` CLI in `src/github.ts`. Zero npm runtime deps.

- `src/types.ts` — Added `PRFile` (filename, status, additions, deletions, changes, patch?, previous_filename?), `PRData` (number, title, body, user, headRef, headSha, baseRef, additions, deletions, changedFiles, files), `MergeResult` (merged, message, sha?).
- `src/github.ts` — All GitHub interaction through two internal helpers:
  - `ghApi<T>(endpoint, method, data?, headers?)` — wraps `execFileSync("gh", ["api", ...])`, returns parsed JSON. Uses `--input -` for request bodies (stdin), `--header` for custom Accept. 30s timeout.
  - `ghApiRaw(endpoint, headers?)` — returns raw string (for diff endpoint). 60s timeout.
  - `getPRData(repo, prNumber)` — `GET /pulls/{n}` for metadata + paginated `GET /pulls/{n}/files?per_page=100` (up to 30 pages / 3000 files). Maps to flat `PRData` interface.
  - `getPRDiff(repo, prNumber)` — `GET /pulls/{n}` with `Accept: application/vnd.github.diff`. Returns unified diff string.
  - `postSummaryComment(repo, prNumber, body)` — Duplicate detection via `findExistingComment()` scanning issue comments for `<!-- code-refinery-review -->` marker. Updates existing (`PATCH /issues/comments/{id}`) or creates new (`POST /issues/{n}/comments`).
  - `postInlineReview(repo, prNumber, headSha, findings, prFiles)` — Filters to critical+warning only. Batch-first via `POST /pulls/{n}/reviews` with `{ commit_id, event: "COMMENT", comments }`. On 422 (line outside diff hunk), falls back to individual `POST /pulls/{n}/comments` per finding, skipping failures.
  - `mergePR(repo, prNumber, method)` — `PUT /pulls/{n}/merge` with `{ merge_method }`. Returns `MergeResult` (never throws). Parses 405/409/403 into human-friendly messages.
  - Error philosophy: read functions (`getPRData`, `getPRDiff`) let errors propagate (fatal). Write functions catch and log internally (best-effort). `mergePR` returns result object.

**Verified:** `npx tsc --noEmit` passes, `npm run build` → `dist/review.js` (1.4kb).

### Phase 3: Trivial PR Detection + Filtering ✅
Skip unnecessary reviews and filter false positives.

- `src/trivial.ts` — Two exports:
  - `isTrivialFile(filename)` — checks a single filename against trivial patterns (docs, config, lockfiles, CI, assets, license). Exported for testability.
  - `isTrivialPR(files: PRFile[])` — returns `true` when ALL files are trivial AND total changed lines ≤ 500. Logs non-trivial files or line count reason on `false`.
  - Pattern categories: documentation (`.md`, `.rst`, `.txt`, `.adoc`), config (`.yml`, `.yaml`, `.toml`, `.ini`), lockfiles (exact names like `package-lock.json`, `yarn.lock`), CI paths (`.github/`, `.circleci/`), assets (images, fonts), license files, misc config (`.editorconfig`, `.gitignore`, `.prettierrc*`, `.eslintrc*`).
- `src/filter.ts` — `filterFindings(findings: ReviewFinding[]): ReviewFinding[]` — returns only findings that survive all rules. 10 filter rules ported from Anthropic's `HardExclusionRules` (`vendor/claude-code-security-review/claudecode/findings_filter.py`):
  1. Markdown files → exclude
  2. Lockfile/generated files (`dist/`, `build/`, `vendor/`, `*.min.js`, `*.d.ts`) → exclude
  3. Low confidence (`< 0.7`) → exclude
  4. DoS/resource exhaustion → exclude
  5. Rate limiting recommendations → exclude
  6. Resource leaks → exclude
  7. Open redirects → exclude
  8. Regex injection → exclude
  9. Memory safety in non-C/C++ → exclude
  10. SSRF in HTML files → exclude
  - Each rule is a named `FilterRule` object. Logs each exclusion with rule name, file, line, and category.

**Verified:** `npx tsc --noEmit` passes, `npm run build` → `dist/review.js` (1.4kb).

### Phase 4: Claude CLI Invocation ✅
Invoke `claude` in full agentic mode with constrained JSON output.

- `src/claude.ts` — Two exports:
  - `InvokeClaudeOptions` interface — `prompt`, `systemPrompt`, `repoDir`, `model`, optional `maxTurns`/`maxBudgetUsd`, `timeoutMinutes`, `disallowedTools` (default `"Bash(ps:*)"`).
  - `invokeClaude(options): ReviewOutput` — builds CLI args array (`--output-format json --model {model} --json-schema {reviewSchemaJson} --append-system-prompt {systemPrompt} --disallowed-tools {disallowedTools}`), conditionally appends `--max-turns` and `--max-budget-usd` when defined. Executes via `execFileSync("claude", args, { input: prompt, cwd: repoDir, timeout: minutes→ms })`.
  - JSON parsing: two-tier strategy via internal `parseClaudeOutput()` — prefers `structured_output` (constrained decoding), falls back to parsing `result` string, validates `findings` array exists.
  - Error handling: never throws. Returns empty `ReviewOutput` with `review_completed: false` on timeout, CLI failure, or parse failure. Logs human-readable error messages (timeout duration, exit code, stderr snippet).
  - Provider env vars (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, etc.) flow through `process.env` automatically — zero provider-specific code.

**Verified:** `npx tsc --noEmit` passes, `npm run build` → `dist/review.js` (1.4kb).

### Phase 5: Prompts (Security + Code Quality) ✅
Two dedicated prompts — the most important phase.

- `src/prompts.ts` — three exports + internal helpers:
  - `buildSecurityPrompt(strictness, customInstructions)` — adapted from Anthropic's security prompt (`vendor/claude-code-security-review/claudecode/prompts.py`). Role: senior security engineer. Three-phase methodology: (1) Repository Context Research, (2) Comparative Analysis, (3) Vulnerability Assessment. Embeds 12-item EXCLUSIONS list mirroring `filter.ts` rules (dual-defense). Categories vary by strictness. Requires `exploit_scenario` for critical findings.
  - `buildCodeQualityPrompt(strictness, customInstructions)` — our own design (no Anthropic equivalent). Role: senior software engineer. Same three-phase structure adapted for quality. Explicit exclusions: security vulns (other pass), style, subjective preferences, test file issues (unless test is broken). Categories: null errors, logic errors, error handling, race conditions, resource management, API contracts; strict adds complexity, naming, test gaps.
  - `buildUserContext(prData, diff, changedFiles)` — shared stdin for both passes. PR metadata + full file list + unified diff. `truncateDiff()` caps at 150k chars (~37k tokens), cuts at `diff --git` boundary, appends note directing Claude to use file tools for remaining files.
  - Internal: `StrictnessConfig` maps `lenient|normal|strict` to `{confidenceFloor, reportInfoFindings, categoryScope}`. Lenient: 0.9/no/narrow. Normal: 0.8/no/standard. Strict: 0.7/yes/wide. Shared `SEVERITY_GUIDELINES` defines critical/warning/info in our terminology. `buildConfidenceGuidelines(floor)` generates scoring ranges with strictness-driven floor.

**Verified:** `npx tsc --noEmit` passes, `npm run build` → `dist/review.js` (1.4kb).

### Phase 6: Full Orchestration ⬜
Wire everything together.

- `src/review.ts` — complete flow:
  1. Read config from `INPUT_*` env vars
  2. Set provider env vars
  3. Fetch PR data + diff → apply exclude patterns
  4. Trivial check → skip if trivial
  5. Pass 1: security prompt → `invokeClaude()` → tag findings as `"security"`
  6. Pass 2: quality prompt → `invokeClaude()` → tag findings as `"code-quality"`
  7. Merge + filter false positives
  8. Compute verdict (request_changes if criticals, comment if findings, approve if clean)
  9. Post inline review (critical + warning)
  10. Post summary comment
  11. If `auto_merge` enabled AND verdict is `approve` → merge PR (squash/merge/rebase)
  12. Set GitHub Action outputs
  13. Exit 1 if `fail_on_critical` and criticals found

**Verify:** Full end-to-end against a real PR. Confirm both passes run, inline comments land correctly, summary is readable.

### Phase 7: Build + README ⬜
Package for distribution.

- Build `dist/review.js` via esbuild, check into git
- Write `README.md` with setup examples for all provider types

**Verify:** Fresh clone → add workflow → open PR → review runs end-to-end.

## Conventions

- `claude` CLI invoked via `execFileSync` — never the SDK, never `-p` print mode
- All GitHub API calls via `gh` CLI — never octokit, never raw fetch
- Provider config is env-var-only — zero provider-specific code
- `--json-schema` enforces output structure — never regex-parse Claude output
- Hard false-positive filters only — never a second Claude API call
- `dist/review.js` is the single bundled entry point — checked into git
- Only `@anthropic-ai/claude-code` CLI is installed at runtime

## Tech Stack

- **Runtime:** Node.js 20 on GitHub Actions runner
- **AI:** Claude Code CLI (full agentic mode) — any provider via env vars
- **GitHub API:** `gh` CLI (pre-installed on runners)
- **Build:** esbuild (bundle to single file), TypeScript
- **Distribution:** Composite GitHub Action with `dist/` checked in

## Reference Material (vendor/)

These are Anthropic's open-source repos, cloned for studying their approach:

| File | What to study |
|------|---------------|
| `vendor/claude-code-security-review/claudecode/prompts.py` | Security prompt structure and categories |
| `vendor/claude-code-security-review/claudecode/findings_filter.py` | Hard exclusion regex patterns |
| `vendor/claude-code-security-review/claudecode/github_action_audit.py` | How they invoke `claude` CLI |
| `vendor/claude-code-security-review/scripts/comment-pr-findings.js` | How they post inline PR comments |
| `vendor/claude-code-action/src/create-prompt/index.ts` | Their ~870-line tag mode prompt |
| `vendor/claude-code-action/base-action/src/run-claude-sdk.ts` | How they use the Agent SDK |
