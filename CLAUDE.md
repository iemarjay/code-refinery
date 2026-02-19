# Code Refinery

PR review agent built on Cloudflare Workers, Sandbox SDK, Queues, AI Gateway, and the Anthropic SDK. Uses a GitHub App for webhooks. React dashboard on Cloudflare Pages.

## Rules

- **NEVER read `.dev.vars`** — it contains secrets (API keys, private keys, tokens). Do not cat, read, or display its contents under any circumstances.

## Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │  Cloudflare Pages (dashboard/)              │
                    │  React SPA — GitHub OAuth login             │
                    │  Routes: /repos, /reviews, /settings, /logs │
                    └──────────────┬──────────────────────────────┘
                                   │ fetch()
                                   ▼
┌──────────────┐    ┌─────────────────────────────────────────────┐
│ GitHub App   │───▶│  Worker (src/)                              │
│ Webhook      │    │  ├─ POST /webhook  → verify + enqueue       │
└──────────────┘    │  ├─ GET  /api/*    → dashboard API          │
                    │  ├─ GET  /auth/*   → GitHub OAuth flow      │
                    │  └─ queue()        → agent loop consumer    │
                    └────┬──────────┬─────────────┬───────────────┘
                         │          │             │
                    Queue (jobs)   D1 (data)    AI Gateway
                         │          │          (Anthropic)
                         ▼          │             │
                    Sandbox (SDK)   │             │
                    sandbox.exec()  │             │
                    sandbox.read◄───┼─────────────┘
                    File()          │
                              ┌─────┘
                              ▼
                         D1 Database
                    (users, repos, reviews,
                     traces, settings)
```

### Two Deployables

1. **Worker** (`src/`) — webhook handler, queue consumer, dashboard API, OAuth. Single `wrangler deploy`. Sandbox container image built automatically.
2. **Dashboard** (`dashboard/`) — React SPA on Cloudflare Pages. `npm run build && wrangler pages deploy`.

### Data Flow

```
GitHub Webhook (PR opened/synchronized)
  → fetch() handler: verify HMAC-SHA256 signature
  → tryEnqueueJob() — SHA dedup, repo rate limit (50/hr), PR debounce (supersede older jobs)
  → env.REVIEW_QUEUE.send(job)
  → Cloudflare Queue (pr-review-jobs, batch_size=1, max_retries=3)
  → queue() handler: validateReviewJob() → isJobSuperseded() check → executeReview(job, env):
      1. upsertInstallation() + upsertRepo() — resolve DB IDs early (for failure recording)
      2. getInstallationToken() — JWT + exchange
      3. getSandboxForRepo(env.SANDBOX, "owner/repo") — keyed by owner--repo for warm clones
      4. setupRepo(sandbox, cloneUrl, headRef, headSha, token) — clone (--depth=50) or fetch+checkout+reset
      5. getPRDiff() — GitHub API with Accept: application/vnd.github.diff
      6. composeSkills(changedFiles, job) — select skills, build system prompt, collect tools
      7. runAgentLoop() — while(has_tool_calls) Anthropic API ↔ sandbox.exec() / sandbox.readFile()
      8. persistReview() — D1: reviews row + review_traces batch (or failed review on error)
      9. postReview() — GitHub PR review API
     10. markJobDone() + message.ack()
```

### Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Worker count | 1 (fetch + queue + API) | Single deploy, shared types & D1 binding |
| Dashboard | React SPA on Pages | Separate deploy cycle. Pages = free hosting + global CDN |
| Auth | GitHub OAuth | Users are GitHub users. SSO, no password management |
| Database | Cloudflare D1 | Native binding, zero-latency from Worker, SQL |
| Sandbox | Cloudflare Sandbox SDK (`@cloudflare/sandbox`) | Built on Containers but no custom server needed — provides exec(), readFile(), writeFile() out of the box |
| Agent loop | Manual while-loop | Full control over sandbox tool routing, timeouts, trace logging |
| Sandbox keying | Per repo (`owner--repo`) | Warm clones — 2nd+ review skips clone (~15s faster). 10m default sleep |
| Clone strategy | `--depth=50` shallow clone | Fast first clone; enough history for most diffs. Agent falls back to GitHub API diff if baseSha not in history |
| Repo directory | `/workspace/repo` (not root) | Keeps workspace clean, avoids conflicts with container WORKDIR |
| Command execution | Allowlisted only (prefix-based) | Security — no arbitrary code from untrusted PRs. `runCommand` returns raw result (no throw on non-zero) so agent sees test failures |
| Skills system | Composable skill modules | Each skill = metadata (file patterns, priority, required tools) + instructions. Composer selects skills by matching changed files, builds unified system prompt |
| Model | claude-sonnet-4-5-20250929 | Balance of speed and quality for reviews |
| Review output | `<review>` JSON tags | Reliable parsing with reasoning preamble |
| Payments | Stubbed for later | Usage tracking in D1 from day 1 so billing data is ready |
| Sandbox image | `cloudflare/sandbox:0.1.4` + ripgrep | Official sandbox base image with built-in server; ripgrep for `searchContent()` |
| gh CLI | Not used | All GitHub API via fetch() in Worker. Smaller container image |
| Cloudflare agents-sdk | Not used | Designed for client-facing chat agents. We're webhook-driven, backend-only |
| DB write isolation | try-catch, non-blocking | DB failures must not prevent review from posting to GitHub |
| Upsert pattern | SELECT-then-INSERT with retry on UNIQUE conflict | D1 lacks reliable `INSERT ... ON CONFLICT ... RETURNING`. Retry-on-conflict handles races |
| Error scrubbing | `scrubErrorMessage()` before DB storage | Prevents tokens/keys from leaking into D1 `error_message` column |
| Token accounting | Split `input_tokens` + `output_tokens` | Different pricing per direction; needed for accurate billing |
| Job dedup | `job_dedup` table with SHA+PR UNIQUE constraint | Prevents duplicate reviews on rapid pushes; enables PR debounce and rate limiting |
| Schema duplication | `schema.ts` (source of truth) + `migrations/*.sql` (deploy artifact) | Manual sync required — no build step. Convention: always update both |

### Warm Sandbox Strategy

Sandboxes keyed by **repo** (not PR), using `owner--repo` as DO ID. Durable Object keeps sandbox alive after last use (default 10 minutes, configurable via `sleepAfter`). First review pays shallow clone cost (`--depth=50`, ~10-20s). Subsequent reviews: update remote URL (fresh token) → `git fetch` → `git checkout -B` → `git reset --hard` → `git clean -fd` (~2-3s). DO is near-free when idle (CPU time only, not wall-clock).

---

## Directory Structure

```
src/                                 ── Worker (webhook + API + queue consumer)
  index.ts                           — Entry point, route dispatch, Env type, re-exports Sandbox, queue consumer with dedup
  router.ts                          — Webhook signature verification + event routing + tryEnqueueJob() gate
  github/
    auth.ts                          — JWT generation (RS256 via Web Crypto), installation token exchange
    api.ts                           — PR diff, post review, post comment
    types.ts                         — Webhook payload + ReviewJob types
  agent/
    review.ts                        — executeReview() orchestrator (auth → sandbox → diff → skills → loop → persist → post), failure recording, error scrubbing
    loop.ts                          — Agentic while-loop (core brain), ReviewResult/ReviewFinding/AgentTrace types
    tools.ts                         — Tool definitions for Anthropic API + routeToolCall() dispatcher
    skills/
      types.ts                       — SandboxToolName, SkillMetadata, Skill, SkillComposition interfaces
      composer.ts                    — composeSkills(), buildSystemPrompt(), extractChangedFiles()
      builtin/
        index.ts                     — BUILTIN_SKILLS map (all 5 skills)
        security-review.ts           — Injection, auth bypass, secrets, SSRF (priority 10)
        bug-detection.ts             — Null errors, off-by-one, race conditions (priority 20)
        architecture-review.ts       — Patterns, coupling, API design (priority 30)
        code-quality.ts              — Readability, complexity, dead code (priority 40)
        data-flow-analysis.ts        — Data flow tracing, taint analysis (priority 50)
  sandbox/
    helpers.ts                       — getSandboxForRepo(), setupRepo(), readFile(), runCommand(), listFiles(), gitDiff(), searchContent(), findFiles(), SandboxError
  api/                               ── Dashboard REST API
    auth.ts                          — GitHub OAuth flow (login, callback, session)
    repos.ts                         — GET /api/repos, PATCH /api/repos/:id/settings
    reviews.ts                       — GET /api/reviews, GET /api/reviews/:id/trace
    usage.ts                         — GET /api/usage (metrics, token counts)
    middleware.ts                    — Session auth middleware
  db/
    schema.ts                        — D1 table DDL (SCHEMA_V1): users, installations, repos, reviews, review_traces, sessions, job_dedup
    queries.ts                       — Typed query helpers: upserts, insertReview, insertReviewTraces (batch), job dedup/rate-limit, dashboard reads
migrations/
  0001_initial_schema.sql            — D1 migration: all tables (users, installations, repos, reviews, review_traces, sessions, job_dedup)
  0002_job_dedup.sql                 — D1 migration: job_dedup table + indexes (idempotent — safe if already in 0001)
Dockerfile                           — Sandbox image: cloudflare/sandbox + ripgrep (no server)
dashboard/                           ── React SPA (Cloudflare Pages)
  src/
    App.tsx                          — Router + layout
    pages/
      Login.tsx                      — GitHub OAuth login
      Repos.tsx                      — Connected repos, enable/disable, settings
      Reviews.tsx                    — Review history list
      ReviewDetail.tsx               — Single review + full agent trace
      Usage.tsx                      — Usage metrics, cost breakdown
      Settings.tsx                   — Org settings, notification prefs
    components/
      ReviewCard.tsx                 — Review summary card
      TraceViewer.tsx                — Agent loop trace viewer (turns, tool calls)
      RepoSettings.tsx               — Per-repo config editor
    lib/
      api.ts                         — Typed fetch wrapper for /api/*
      auth.ts                        — Auth context, token storage
  package.json
  tsconfig.json
  vite.config.ts
wrangler.toml
tsconfig.json
package.json
.dev.vars                            — Local secrets (gitignored)
```

---

## Implementation Phases

### Phase 1: Project Scaffold ✅
Create all config files and stubs so `npm install && npx wrangler dev` works.

- `package.json` — deps: `@anthropic-ai/sdk`, `@cloudflare/sandbox`; devDeps: `wrangler`, `@cloudflare/workers-types`, `typescript`
- `tsconfig.json` — target ES2022, module ES2022, bundler resolution, Workers types
- `wrangler.toml` — queue producer/consumer, `[[containers]]` with Sandbox class, D1 binding, DO binding with `new_sqlite_classes`
- `.gitignore`, `.dev.vars`
- `src/index.ts` — stub fetch + queue handlers, Env interface, re-exports Sandbox
- `Dockerfile` (root) — node:20-slim + git/jq/curl (no server, just the environment)
- `scripts/stringify-pem.sh` — converts PKCS8 PEM to single-line string for .dev.vars

**Verified:** `npm install` ✅, `npx wrangler dev` ✅, `curl localhost:8787` → 200 ✅.

### Phase 2: Router Worker (Webhook Handler) ✅
- `src/github/types.ts` — PullRequestEvent, ReviewJob interfaces (lean, only fields consumed downstream)
- `src/router.ts` — `handleWebhook(request, env)`:
  - HMAC-SHA256 via Web Crypto (`crypto.subtle.importKey` HMAC + `crypto.subtle.sign` + `crypto.subtle.timingSafeEqual`)
  - Body read as `ArrayBuffer` once (reused for HMAC verification + JSON parse)
  - Filter: `X-GitHub-Event === "pull_request"` && `action in ["opened", "synchronize"]`
  - Skips draft PRs, validates `installation.id` present
  - Extract ReviewJob → `env.REVIEW_QUEUE.send(job)` → return 200 JSON
- `src/index.ts` — wired `handleWebhook` into fetch handler

**Verified:** `npx tsc --noEmit` ✅. Missing signature → 401, invalid signature → 401, non-PR events → 200 ignored, valid PR opened → 200 + enqueue.

### Phase 3: GitHub Auth Module ✅
- `src/github/auth.ts`:
  - `pemToArrayBuffer(pem)` — strip headers, validate PKCS#8 (reject PKCS#1 with conversion hint), base64 → ArrayBuffer
  - `generateAppJwt(appId, pem)` — RS256 via `crypto.subtle.importKey("pkcs8")` + `crypto.subtle.sign("RSASSA-PKCS1-v1_5")`; iss=appId, iat=now-60, exp=now+600
  - `getInstallationToken(appId, pem, installationId)` — POST `/app/installations/{id}/access_tokens`
- `src/github/api.ts`:
  - `getPRDiff(token, owner, repo, prNumber)` — Accept: application/vnd.github.diff
  - `postReview(token, owner, repo, prNumber, body, comments, event, commitId)` — POST /pulls/{n}/reviews (includes commit_id for multi-commit PRs)
  - `postComment(token, owner, repo, issueNumber, body)` — POST /issues/{n}/comments
- `src/github/types.ts` — Added ReviewComment interface (path, line, start_line, side, body)
- Migrated from `@cloudflare/containers` to `@cloudflare/sandbox` SDK — removed `/container/` directory, simplified Dockerfile, updated wrangler.toml

**Verified:** `npx tsc --noEmit` ✅.

### Phase 4: Sandbox Setup ✅
- `Dockerfile` (root) — base image `cloudflare/sandbox:0.1.4` + ripgrep; `EXPOSE 3000`; `/workspace` directory
- `src/sandbox/helpers.ts`:
  - `SandboxError` — custom error class with command, exitCode, stderr for diagnostics
  - `getSandboxForRepo(ns, repoFullName)` — wraps `getSandbox()`, keys by `owner--repo` for warm clones
  - `setupRepo(sandbox, cloneUrl, headRef, headSha, token)` — warm path: update remote URL + fetch specific branch (falls back to SHA for fork PRs) + checkout + reset + clean; cold path: `git clone --depth=50`; token injected via URL constructor; **strips token from remote URL after setup** for security
  - `readFile(sandbox, path)` — `sandbox.readFile(path)` with path normalization and traversal validation (must be under `/workspace/repo/`)
  - `runCommand(sandbox, cmd)` — shell metacharacter rejection + prefix-based allowlist check, does NOT throw on non-zero exit (agent loop needs failure output)
  - `listFiles(sandbox, pattern?)` — `git ls-files` with shell metacharacter validation on pattern
  - `gitDiff(sandbox, baseSha)` — `git diff baseSha...HEAD` with SHA format validation
  - `searchContent(sandbox, pattern, options?)` — wraps ripgrep (`rg`) with input validation; returns empty string for no matches (rg exit 1 = no matches)
  - `findFiles(sandbox, pattern, options?)` — wraps `find` with pattern validation and max depth limit (default 10, max 15)
  - Internal helpers: `shellQuote()` for safe quoting, `scrubTokens()` to redact credentials from logs, `SAFE_GIT_REF_RE`/`SAFE_SHA_RE` for input validation
  - Command allowlist (multi-language): JS/TS (npm test, npm run lint, npx tsc), Python (pytest, ruff, mypy), Go (go test, go vet), Rust (cargo test, cargo clippy), Ruby (bundle exec rake/rubocop), Java (gradlew, mvnw, mvn), generic (make test/lint), git commands. rg/find NOT in allowlist — only accessible via `searchContent()`/`findFiles()`
- `src/index.ts` — `validateReviewJob()` runtime validation of queue messages; queue handler calls `executeReview(job, env)`; `Env.SANDBOX` typed as `DurableObjectNamespace<Sandbox>`; added `CLOUDFLARE_ACCOUNT_ID` and `AI_GATEWAY_ID` to Env

**Verified:** `npx tsc --noEmit` ✅.

### Phase 5: Agent Loop (Core) ✅
- `src/agent/tools.ts` — Tool definitions (read_file, list_files, run_command, git_diff, search_content, find_files) + `routeToolCall()` dispatcher with output capping (30k chars for commands/search, 50k for diffs)
- `src/agent/loop.ts` — `runAgentLoop(job, diff, sandbox, composition, apiKey, gatewayBaseUrl?)`:
  - Anthropic client with optional AI Gateway baseURL
  - Model: `claude-sonnet-4-5-20250929`, max_tokens: 16384, temperature: 0
  - While loop (max 20 iterations): messages.create → end_turn: extract `<review>` JSON → tool_use: route to sandbox → max_tokens: ask for summary
  - `ReviewResult` (verdict, summary, findings), `ReviewFinding` (skill, severity, path, line, title, body), `AgentTrace` (turns, tokens, duration)
  - `buildUserMessage()` — formats PR diff (capped at 100k chars)
  - `parseReviewJson()` — extracts JSON from `<review>` tags, handles markdown code fences, validates verdict/findings
  - Fallback: on max iterations, walks backward through messages to find any `<review>` block
- `src/agent/review.ts` — `executeReview(job, env)` orchestrates the full flow: auth → sandbox setup → getPRDiff → extractChangedFiles → composeSkills → runAgentLoop → postReview
  - `mapVerdictToEvent()` — approve/request_changes/comment → GitHub review event
  - `mapFindingsToComments()` — findings → ReviewComment[] with severity labels and skill attribution
  - `formatReviewBody()` — markdown review body with skills list, finding counts by severity, stats
- `src/agent/skills/types.ts` — `SandboxToolName` union, `SkillMetadata`, `Skill`, `SkillComposition` interfaces
- `src/agent/skills/composer.ts` — `composeSkills(changedFiles, job)`:
  - Selects skills based on file pattern matching (glob) against changed files
  - Builds composed system prompt: preamble + skill instruction sections + `<review>` JSON output format
  - Collects union of required tools from active skills
  - `extractChangedFiles(diff)` — parses `+++ b/` lines from unified diff
- `src/agent/skills/builtin/` — 5 built-in skills (all enabled by default):
  - `security-review` (priority 10) — injection, auth bypass, secrets, path traversal, SSRF
  - `bug-detection` (priority 20) — null errors, off-by-one, race conditions, resource leaks
  - `architecture-review` (priority 30) — patterns, coupling, API design
  - `code-quality` (priority 40) — readability, complexity, naming, dead code
  - `data-flow-analysis` (priority 50) — data flow tracing, taint analysis
- `src/index.ts` — queue handler: `validateReviewJob()` → `executeReview(job, env)` with ack/retry; malformed messages discarded (acked, not retried)

**Verified:** `npx tsc --noEmit` ✅.

### Phase 6: Data Layer (D1) ✅
- `src/db/schema.ts` — SCHEMA_V1 with 7 tables:
  - users (github_id, github_login, avatar_url) — Phase 7 OAuth
  - installations (github_installation_id, status) — auto-upserted on first webhook
  - repos (installation_id, full_name, enabled, settings_json) — auto-upserted on first webhook
  - reviews (repo_id, pr_number, pr_title, pr_body, pr_author, head_sha, head_ref, base_sha, base_ref, status, error_message, verdict, summary, findings_json, model, input_tokens, output_tokens, duration_ms, setup_duration_ms, sandbox_warm, files_changed, lines_added, lines_removed, active_skills_json) — completed and failed reviews
  - review_traces (review_id, turn_number, role, content_json, tool_name, tokens_used)
  - sessions (user_id, token_hash, expires_at) — Phase 7 OAuth
  - job_dedup (repo_full_name, pr_number, head_sha, status) — SHA dedup, rate limiting, PR debounce
- `src/db/queries.ts`:
  - Write: `upsertInstallation()`, `upsertRepo()` (SELECT-then-INSERT with UNIQUE conflict retry), `insertReview()` (24-column INSERT), `insertReviewTraces()` (`db.batch()`)
  - Dedup: `tryEnqueueJob()` (3-layer gate: repo enabled → SHA dedup → rate limit + PR debounce), `isJobSuperseded()`, `markJobProcessing()`, `markJobDone()`
  - Read (Phase 7): `getReviewsByRepo()`, `getReviewById()`, `getReviewTraces()`, `getRepoByFullName()`, `getRepoSettings()`
- `migrations/0001_initial_schema.sql` — copy of SCHEMA_V1 for `wrangler d1 migrations apply`
- `src/agent/review.ts` — restructured `executeReview()`: upserts repo/installation early, wraps main flow in try-catch, records failures to D1 with `scrubErrorMessage()`, collects diff stats + sandbox perf + active skills
- `src/router.ts` — gates webhooks through `tryEnqueueJob()` before enqueuing
- `src/index.ts` — queue consumer checks `isJobSuperseded()`, calls `markJobProcessing()`/`markJobDone()`
- `src/github/types.ts` — added `prAuthor` to ReviewJob
- `src/agent/loop.ts` — exported `MODEL` constant

**Verified:** `npx tsc --noEmit` ✅.

### Phase 7: Dashboard API + GitHub OAuth
- `src/api/auth.ts` — GitHub OAuth: /auth/login → /auth/callback → /auth/logout
- `src/api/middleware.ts` — session cookie validation
- `src/api/repos.ts` — GET /api/repos, PATCH /api/repos/:id/settings, POST enable/disable
- `src/api/reviews.ts` — GET /api/reviews (paginated), GET /api/reviews/:id, GET /api/reviews/:id/trace
- `src/api/usage.ts` — GET /api/usage?period=30d (aggregated stats)
- `src/index.ts` — route dispatch: /api/* → handlers, /auth/* → OAuth

**Verify:** OAuth login works, repos listed, reviews with trace drill-down.

### Phase 8: React Dashboard (Cloudflare Pages)
- Vite + React + react-router-dom + @tanstack/react-query
- Pages: Login, Repos, Reviews, ReviewDetail, Usage, Settings
- Components: TraceViewer (accordion timeline), RepoSettings (config editor), ReviewCard
- Deploy: `npx wrangler pages deploy dashboard/dist --project-name code-refinery-dashboard`

**Verify:** Full flow: login → repos → reviews → trace detail. Edit settings → new review reflects them.

### Phase 9: Review Configuration (Unified)
- ReviewConfig: strictness, ignore_patterns, custom_checklist
- Two sources: D1 (dashboard settings, takes priority) + .code-refinery.yml (repo file, additive)
- buildSystemPromptWithConfig() appends config to base system prompt

**Verify:** Set strictness in dashboard, open PR, confirm review matches.

---

## Secrets & Resources

```bash
# GitHub App (webhook + PR API)
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_PRIVATE_KEY
npx wrangler secret put GITHUB_WEBHOOK_SECRET

# GitHub OAuth App (dashboard login — separate from GitHub App)
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET

# Anthropic
npx wrangler secret put ANTHROPIC_API_KEY

# Session signing
npx wrangler secret put SESSION_SECRET

# AI Gateway (optional — if not set, Anthropic API called directly)
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put AI_GATEWAY_ID
```

Cloudflare resources: Queue `pr-review-jobs` + DLQ, D1 `code-refinery-db`, AI Gateway `code-refinery`, Pages `code-refinery-dashboard`.

---

## Tech Stack

- **Runtime:** Cloudflare Workers (TypeScript)
- **Queue:** Cloudflare Queues
- **Database:** Cloudflare D1 (SQLite)
- **Sandbox:** Cloudflare Sandbox SDK (`@cloudflare/sandbox`) — built on Containers, provides exec/readFile/writeFile
- **AI:** Anthropic Claude Sonnet 4.5 via AI Gateway
- **Frontend:** React + Vite on Cloudflare Pages
- **Auth:** GitHub OAuth
- **Tooling:** Wrangler, npm, TypeScript

## Conventions

- All GitHub API calls happen in the Worker via fetch(), never in the sandbox
- Sandbox only runs local operations: file reads, git commands, allowlisted shell commands via `sandbox.exec()`
- Private keys stored as Cloudflare secrets, passed to sandbox only as short-lived installation tokens
- Agent loop capped at 20 iterations with structured `<review>` JSON output
- D1 tracks every agent turn for observability (review_traces table)

### Sandbox Conventions
- Sandbox SDK exports `ExecuteResponse` (not `ExecResult`) as the return type for `sandbox.exec()`
- `getSandbox()` from SDK takes a string ID — we wrap it with `getSandboxForRepo()` using `owner--repo` format
- Repo cloned to `/workspace/repo` constant (`REPO_DIR`), not workspace root
- Token injected into clone URL via `URL` constructor: `x-access-token:{token}@github.com`
- Path validation: `normalizePath()` resolves `..`/`.`, then checks prefix is `/workspace/repo/`
- Command allowlist is prefix-based: `git log --oneline -10` matches `git log` (exact OR prefix + space)
- `runCommand()` does NOT throw on non-zero exit — agent loop needs to see test failure output
- `runCommand()` rejects shell metacharacters (`; | & \` $ ( )` etc.) before allowlist check — prevents prompt injection chaining
- `setupRepo()` DOES throw on failure — clone/fetch errors are hard failures
- `setupRepo()` strips token from remote URL after clone/fetch — prevents user-controlled code (npm test etc.) from reading it via `git remote get-url origin`
- `setupRepo()` handles fork PRs: tries branch fetch first, falls back to SHA fetch if branch not on remote
- `shellQuote()` wraps values in single quotes with interior `'` escaped — used for URLs, patterns
- `scrubTokens()` redacts credentials from URLs in error messages/logs
- `searchContent()` wraps ripgrep (`rg`) with input validation, returns empty string for no matches (rg exit 1 = no matches, not an error)
- `findFiles()` wraps `find` with pattern validation and max depth limit (default 10, max 15)
- rg and find are NOT in `COMMAND_ALLOWLIST` — only accessible via `searchContent()`/`findFiles()` which validate inputs. Raw rg/find via `runCommand` would expose dangerous flags like `--pre`

### D1 / Database Conventions
- All queries use parameterized prepared statements (`.bind()`) — never string interpolation in SQL
- `schema.ts` is source of truth for DDL; `migrations/0001_initial_schema.sql` is the deploy artifact — always update both when changing schema
- Upsert pattern: SELECT-then-INSERT with catch-retry on UNIQUE constraint — handles concurrent request races
- `insertReviewTraces()` uses `db.batch()` for single round-trip (up to ~40 statements per review)
- DB write failures in `executeReview()` are caught and logged — never block the GitHub review from posting
- `scrubErrorMessage()` redacts GitHub tokens (`ghs_`/`ghp_`/`gho_`/`github_pat_`), Anthropic keys (`sk-ant-`), Bearer tokens, and URL-embedded credentials before storing in `error_message` column
- `reviews.status` is either `completed` or `failed` — failed reviews have `error_message` populated, nullable `verdict`/`summary`/`findings_json`
- `reviews.input_tokens` and `output_tokens` stored separately (different pricing per direction)
- `job_dedup` table gates webhook processing: SHA dedup (UNIQUE constraint), per-repo rate limit (50/hr), PR debounce (supersede older pending jobs for same PR)
- `job_dedup.status` lifecycle: `queued` → `processing` → `done`/`failed`/`superseded`
- Queue consumer checks `isJobSuperseded()` before starting expensive agent loop work

### Wrangler / Cloudflare Conventions
- `[[containers]]` uses double-bracket (array) TOML syntax, not `[containers]`
- Container config requires `image` field pointing to Dockerfile path (e.g. `"./Dockerfile"`)
- `disk_size_gb` is not a valid container field in wrangler — omit it
- Local dev without Docker: use `--enable-containers=false` flag with `wrangler dev`
- Sandbox class must be re-exported from the Worker entry point (`src/index.ts`) for DO binding: `export { Sandbox } from "@cloudflare/sandbox"`
- Sandbox DO migration uses `new_sqlite_classes` (not `new_classes`) — required by Sandbox SDK
- `.dev.vars` secrets auto-loaded by wrangler dev as environment variables
- PEM keys in `.dev.vars`: use `scripts/stringify-pem.sh` to convert multi-line PEM to single-line
