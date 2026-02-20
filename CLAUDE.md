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
| Auth | GitHub OAuth (separate OAuth App) | Users are GitHub users. SSO, no password management. OAuth App is separate from the GitHub App used for webhooks |
| User–repo mapping | M:N `user_installations` join table | Multiple org members can access the same installation's repos. Replaces singular `installations.user_id` |
| CORS | `DASHBOARD_ORIGIN` env var, never wildcard | Pages and Worker are different origins. `SameSite=None; Secure; HttpOnly` cookies |
| CSRF protection | Origin header check on mutations + cookie-based OAuth `state` | Origin check on POST/PATCH/PUT/DELETE. OAuth `state` cookie verified on callback |
| Session tokens | 256-bit entropy, SHA-256 hash stored | Raw token never stored in DB. 30-day expiry. GitHub access token used once in callback, never stored |
| Database | Cloudflare D1 | Native binding, zero-latency from Worker, SQL |
| Sandbox | Cloudflare Sandbox SDK (`@cloudflare/sandbox`) | Built on Containers but no custom server needed — provides exec(), readFile(), writeFile() out of the box |
| Agent loop | Manual while-loop | Full control over sandbox tool routing, timeouts, trace logging |
| Iteration budget | Dynamic: 10 (≤5 files), 15 (≤15), 20 (>15) | Scales exploration budget with PR size |
| Sandbox keying | Per repo (`owner--repo`) | Warm clones — 2nd+ review skips clone (~15s faster). 10m default sleep |
| Clone strategy | `--depth=50` shallow clone | Fast first clone; enough history for most diffs. Agent falls back to GitHub API diff if baseSha not in history |
| Repo directory | `/workspace/repo` (not root) | Keeps workspace clean, avoids conflicts with container WORKDIR |
| Command execution | Static-analysis only allowlist (prefix-based) | Security — NO test runners (npm test, pytest, etc.) as they execute attacker-controlled code from untrusted PRs. Only audit commands, linters, and git |
| Vuln scanning | OSV.dev API via `check_vulnerabilities` tool | Worker-side HTTP call to OSV batch API. Supports npm, PyPI, Go, crates.io, RubyGems, Maven. Max 50 packages per call |
| Content search | `git grep` (not ripgrep) | Always available (no extra install), only searches tracked files, respects .gitignore via index |
| Repo sync | `POST /api/repos/sync` via installation tokens | Fetches repos from GitHub API for each user installation, upserts into D1. Used by dashboard "Refresh repos" button |
| Skills system | Composable skill modules | Each skill = metadata (file patterns, priority, required tools) + instructions. Composer selects skills by matching changed files, builds unified system prompt |
| Model | claude-sonnet-4-5-20250929 | Balance of speed and quality for reviews |
| Review output | `<review>` JSON tags | Reliable parsing with reasoning preamble |
| Payments | Stubbed for later | Usage tracking in D1 from day 1 so billing data is ready |
| Sandbox image | `cloudflare/sandbox:0.1.4` | Official sandbox base image with built-in server |
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
  index.ts                           — Entry point, route dispatch (matchRoute), Env type, re-exports Sandbox, queue consumer with dedup, validateReviewJob()
  router.ts                          — Webhook signature verification + event routing + tryEnqueueJob() gate
  github/
    auth.ts                          — JWT generation (RS256 via Web Crypto), installation token exchange
    api.ts                           — PR diff, post review, post comment
    types.ts                         — Webhook payload + ReviewJob types
  agent/
    review.ts                        — executeReview() orchestrator (auth → sandbox → diff → skills → loop → persist → post), failure recording, error scrubbing
    loop.ts                          — Agentic while-loop (core brain), dynamic iteration budget, ReviewResult/ReviewFinding/AgentTrace types
    tools.ts                         — Tool definitions (7 tools incl. check_vulnerabilities) + routeToolCall() dispatcher
    vuln.ts                          — OSV.dev vulnerability lookup: queryOSV() batch API, VulnEcosystem/VulnQuery/VulnResult types
    skills/
      types.ts                       — SandboxToolName (7 tools), SkillMetadata, Skill, SkillComposition interfaces
      composer.ts                    — composeSkills(), buildSystemPrompt(), extractChangedFiles()
      builtin/
        index.ts                     — BUILTIN_SKILLS map (all 5 skills)
        security-review.ts           — Injection, auth bypass, secrets, SSRF, dependency vuln scanning (priority 10)
        bug-detection.ts             — Null errors, off-by-one, race conditions (priority 20)
        architecture-review.ts       — Patterns, coupling, API design (priority 30)
        code-quality.ts              — Readability, complexity, dead code (priority 40)
        data-flow-analysis.ts        — Data flow tracing, taint analysis (priority 50)
  sandbox/
    helpers.ts                       — getSandboxForRepo(), setupRepo(), readFile(), runCommand(cmd, cwd?), listFiles(), gitDiff(), searchContent(), findFiles(), SandboxError
  api/                               ── Dashboard REST API
    cors.ts                          — handlePreflight(), withCors() — CORS with DASHBOARD_ORIGIN, never wildcard
    middleware.ts                     — AuthContext, authenticate(), requireAuth(), checkCsrf(), cookie helpers, hashToken()
    auth.ts                          — GitHub OAuth: handleAuthLogin(), handleAuthCallback(), handleAuthLogout(), handleAuthMe()
    repos.ts                         — handleGetRepos(), handleSyncRepos(), handlePatchRepoSettings(), handleToggleRepo() + settings validation
    reviews.ts                       — handleGetReviews(), handleGetReview(), handleGetReviewTrace() — all ownership-scoped
    usage.ts                         — handleGetUsage() — aggregated stats, period capped at 365 days
  db/
    schema.ts                        — D1 table DDL (SCHEMA_V1): users, installations, repos, reviews, review_traces, sessions, job_dedup, user_installations
    queries.ts                       — Typed query helpers: upserts, insertReview, insertReviewTraces (batch), job dedup/rate-limit, dashboard reads (13 new query functions for API)
migrations/
  0001_initial_schema.sql            — D1 migration: all tables (users, installations, repos, reviews, review_traces, sessions, job_dedup)
  0002_job_dedup.sql                 — D1 migration: job_dedup table + indexes (idempotent — safe if already in 0001)
  0003_user_installations.sql        — D1 migration: M:N user_installations join table
  0004_review_observability.sql      — D1 migration: extended review_traces columns (iteration, tool_input, tool_result), review diff_text + system_prompt_hash
Dockerfile                           — Sandbox image: cloudflare/sandbox (no server)
dashboard/                           ── React SPA (Cloudflare Pages)
  src/
    main.tsx                         — ReactDOM root, QueryClientProvider, App
    App.tsx                          — BrowserRouter, Routes, protected route wiring
    pages/
      Login.tsx                      — GitHub OAuth login ("Sign in with GitHub" button)
      Repos.tsx                      — Repo list with sync button, enable/disable toggles, settings, install URL
      Reviews.tsx                    — Paginated review list with repo filter
      ReviewDetail.tsx               — Review detail with findings by severity + TraceViewer
      Usage.tsx                      — Period selector, summary cards, bar charts
      Settings.tsx                   — Placeholder for future org settings
    components/
      Layout.tsx                     — Sidebar nav + user avatar + logout
      ProtectedRoute.tsx             — Redirect to /login if unauthenticated
      ReviewCard.tsx                 — Review summary card with verdict badge
      TraceViewer.tsx                — Expandable accordion of agent turns, tool calls, token counts
      RepoSettings.tsx               — Modal: strictness radio, ignore patterns textarea, custom checklist
    lib/
      types.ts                       — User, Repo, RepoSettings, Review, ReviewTrace, ReposResponse, SyncReposResponse, UsageStats, PaginatedReviews
      api.ts                         — Typed apiFetch<T> with credentials: "include", methods for all endpoints incl. syncRepos()
      auth.tsx                       — AuthProvider context, useAuth() hook, LOGIN_URL
  package.json                       — react 19, react-router-dom 7, @tanstack/react-query 5, tailwindcss 3, vite 6
  tsconfig.json
  vite.config.ts                     — Proxy /api and /auth to localhost:8787 in dev
  tailwind.config.js
  postcss.config.js
  index.html
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
- `Dockerfile` (root) — base image `cloudflare/sandbox:0.1.4`; `EXPOSE 3000`; `/workspace` directory
- `src/sandbox/helpers.ts`:
  - `SandboxError` — custom error class with command, exitCode, stderr for diagnostics
  - `getSandboxForRepo(ns, repoFullName)` — wraps `getSandbox()`, keys by `owner--repo` for warm clones
  - `setupRepo(sandbox, cloneUrl, headRef, headSha, token)` — warm path: update remote URL + fetch specific branch (falls back to SHA for fork PRs) + checkout + reset + clean; cold path: `git clone --depth=50`; token injected via URL constructor; **strips token from remote URL after setup** for security
  - `readFile(sandbox, path)` — `sandbox.readFile(path)` with path normalization and traversal validation (must be under `/workspace/repo/`)
  - `runCommand(sandbox, cmd, cwd?)` — shell metacharacter rejection + prefix-based allowlist check, optional `cwd` param for subdirectory execution, does NOT throw on non-zero exit (agent loop needs failure output)
  - `listFiles(sandbox, pattern?)` — `git ls-files` with shell metacharacter validation on pattern
  - `gitDiff(sandbox, baseSha)` — `git diff baseSha...HEAD` with SHA format validation
  - `searchContent(sandbox, pattern, options?)` — wraps `git grep` with input validation; returns empty string for no matches (exit 1 = no matches)
  - `findFiles(sandbox, pattern, options?)` — wraps `find` with pattern validation and max depth limit (default 10, max 15)
  - Internal helpers: `shellQuote()` for safe quoting, `scrubTokens()` to redact credentials from logs, `SAFE_GIT_REF_RE`/`SAFE_SHA_RE` for input validation
  - Command allowlist (**static-analysis only** — NO test runners): vulnerability audits (npm audit, pip-audit, cargo audit, bundle audit, go list -m -json all), linters (ruff, mypy, go vet, cargo clippy, rubocop), git commands (log, show, ls-files, diff, branch, status). rg/find NOT in allowlist — only accessible via `searchContent()`/`findFiles()`
- `src/index.ts` — `validateReviewJob()` runtime validation of queue messages; queue handler calls `executeReview(job, env)`; `Env.SANDBOX` typed as `DurableObjectNamespace<Sandbox>`; added `CLOUDFLARE_ACCOUNT_ID` and `AI_GATEWAY_ID` to Env

**Verified:** `npx tsc --noEmit` ✅.

### Phase 5: Agent Loop (Core) ✅
- `src/agent/tools.ts` — Tool definitions (read_file, list_files, run_command, git_diff, search_content, find_files, check_vulnerabilities) + `routeToolCall()` dispatcher with output capping (30k chars for commands/search/vulns, 50k for diffs)
- `src/agent/vuln.ts` — `queryOSV()` Worker-side vulnerability lookup via OSV.dev batch API. Supports npm, PyPI, Go, crates.io, RubyGems, Maven. Max 50 packages per call. Extracts severity from CVSS_V3 scores, fixed versions from affected ranges
- `src/agent/loop.ts` — `runAgentLoop(job, diff, sandbox, composition, apiKey, gatewayBaseUrl?, changedFileCount?)`:
  - Anthropic client with optional AI Gateway baseURL
  - Model: `claude-sonnet-4-5-20250929`, max_tokens: 16384, temperature: 0
  - Dynamic iteration budget: `getMaxIterations(changedFileCount)` → 10 (≤5 files), 15 (≤15 files), 20 (>15 files)
  - While loop: messages.create → end_turn: extract `<review>` JSON → tool_use: route to sandbox → max_tokens: ask for summary
  - `ReviewResult` (verdict, summary, findings), `ReviewFinding` (skill, severity, path, line, title, body), `AgentTrace` (turns, tokens, duration)
  - `buildUserMessage()` — formats PR diff (capped at 100k chars), includes iteration budget in prompt
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
- `src/db/schema.ts` — SCHEMA_V1 with 8 tables:
  - users (github_id, github_login, avatar_url) — Phase 7 OAuth
  - installations (github_installation_id, status) — auto-upserted on first webhook
  - repos (installation_id, full_name, enabled, settings_json) — auto-upserted on first webhook
  - reviews (repo_id, pr_number, pr_title, pr_body, pr_author, head_sha, head_ref, base_sha, base_ref, status, error_message, verdict, summary, findings_json, model, input_tokens, output_tokens, duration_ms, setup_duration_ms, sandbox_warm, files_changed, lines_added, lines_removed, active_skills_json) — completed and failed reviews
  - review_traces (review_id, turn_number, role, content_json, tool_name, tokens_used, iteration, tool_input, tool_result)
  - sessions (user_id, token_hash, expires_at) — Phase 7 OAuth
  - job_dedup (repo_full_name, pr_number, head_sha, status) — SHA dedup, rate limiting, PR debounce
  - user_installations (user_id, installation_id) — M:N join table for multi-user org access
- `src/db/queries.ts`:
  - Write: `upsertInstallation()`, `upsertRepo()` (SELECT-then-INSERT with UNIQUE conflict retry), `insertReview()` (24-column INSERT), `insertReviewTraces()` (`db.batch()`)
  - Dedup: `tryEnqueueJob()` (3-layer gate: repo enabled → SHA dedup → rate limit + PR debounce), `isJobSuperseded()`, `markJobProcessing()`, `markJobDone()`
  - Dashboard reads: `upsertUser()`, `createSession()`, `getSessionWithUser()`, `deleteSession()`, `deleteExpiredSessions()`, `linkInstallationsToUser()`, `getReposForUser()`, `getInstallationIdsForUser()`, `getReviewsPaginated()`, `updateRepoSettings()`, `updateRepoEnabled()`, `verifyUserOwnsRepo()`, `verifyUserOwnsReview()`, `getUsageStats()`, `getReviewById()`, `getReviewTraces()`
- `migrations/0001_initial_schema.sql` — copy of SCHEMA_V1 for `wrangler d1 migrations apply`
- `src/agent/review.ts` — restructured `executeReview()`: upserts repo/installation early, wraps main flow in try-catch, records failures to D1 with `scrubErrorMessage()`, collects diff stats + sandbox perf + active skills
- `src/router.ts` — gates webhooks through `tryEnqueueJob()` before enqueuing
- `src/index.ts` — queue consumer checks `isJobSuperseded()`, calls `markJobProcessing()`/`markJobDone()`
- `src/github/types.ts` — added `prAuthor` to ReviewJob
- `src/agent/loop.ts` — exported `MODEL` constant

**Verified:** `npx tsc --noEmit` ✅.

### Phase 7: Dashboard API + GitHub OAuth ✅
- `migrations/0003_user_installations.sql` — M:N join table for user–installation mapping (replaces singular `installations.user_id`)
- `migrations/0004_review_observability.sql` — extended review_traces (iteration, tool_input, tool_result), review diff_text + system_prompt_hash
- `src/db/schema.ts` — added `user_installations` table to SCHEMA_V1
- `src/db/queries.ts` — 13 new query functions for dashboard API, all using M:N joins through `user_installations`
- `src/api/cors.ts` — `handlePreflight()` (204 for OPTIONS), `withCors()` (clone response + CORS headers). Origin validated against `env.DASHBOARD_ORIGIN` (never wildcard)
- `src/api/middleware.ts`:
  - `AuthContext` interface: `{ userId, githubId, githubLogin, avatarUrl }`
  - `authenticate()` → parse `session` cookie → SHA-256 hash → D1 lookup (sessions JOIN users, check expires_at)
  - `requireAuth()` → returns AuthContext or 401 Response
  - `checkCsrf()` → Origin header check on POST/PATCH/PUT/DELETE mutations, reject 403 if mismatch
  - Cookie helpers: `setSessionCookie()`, `clearSessionCookie()`, `clearOAuthStateCookie()`, `hashToken()`
- `src/api/auth.ts`:
  - `handleAuthLogin()` → generate random `state` (16 bytes hex), set `__oauth_state` cookie (5 min, HttpOnly), redirect to GitHub OAuth authorize URL
  - `handleAuthCallback()` → verify `state` cookie, exchange code for token, fetch user + installations, upsert user + link installations via `user_installations`, create session (256-bit token, SHA-256 hash stored, 30-day expiry), redirect to `DASHBOARD_ORIGIN`. GitHub access token used once and discarded
  - `handleAuthLogout()` → delete session from D1, clear cookie
  - `handleAuthMe()` → return user JSON or 401
- `src/api/repos.ts`:
  - `handleGetRepos()` → returns `{ repos, installUrl }` (repos joined through user_installations)
  - `handleSyncRepos()` → fetches repos from GitHub API via installation tokens for each user installation, upserts into D1
  - `handlePatchRepoSettings()` → validates settings schema (max 20 patterns, max 200 chars, strictness must be lenient|balanced|strict, max 10 checklist items)
  - `handleToggleRepo()` → enable/disable repo (verify ownership)
- `src/api/reviews.ts` — `handleGetReviews()` (paginated, ownership-scoped), `handleGetReview()`, `handleGetReviewTrace()`
- `src/api/usage.ts` — `handleGetUsage()` (aggregated stats, period capped at 365 days)
- `src/index.ts` — full route dispatch:
  - `matchRoute(pattern, pathname)` helper for `:id` parameter extraction
  - OPTIONS preflight → webhook (no CORS) → `/auth/*` (CORS, no session auth) → `/api/*` (CORS + CSRF + session auth)
  - Env extended with `DASHBOARD_ORIGIN`, `GITHUB_APP_SLUG`

**Verified:** `npx tsc --noEmit` ✅. D1 migrations applied locally ✅.

### Phase 8: React Dashboard (Cloudflare Pages) ✅
- Scaffolded `dashboard/` with Vite 6, React 19, react-router-dom 7, @tanstack/react-query 5, Tailwind CSS 3
- `dashboard/src/lib/types.ts` — User, Repo, RepoSettings, Review, ReviewFinding, ReviewTrace, PaginatedReviews, ReposResponse, SyncReposResponse, UsageStats
- `dashboard/src/lib/api.ts` — typed `apiFetch<T>` with `credentials: "include"`, auto 401→redirect, methods for all endpoints including `syncRepos()`
- `dashboard/src/lib/auth.tsx` — AuthProvider context, `useAuth()` hook, `LOGIN_URL`
- `dashboard/src/main.tsx` — ReactDOM root, QueryClientProvider, App
- `dashboard/src/App.tsx` — BrowserRouter with protected routes
- `dashboard/src/components/Layout.tsx` — sidebar nav with user avatar + logout
- `dashboard/src/components/ProtectedRoute.tsx` — redirect to /login if unauthenticated
- Pages: Login (GitHub OAuth button), Repos (sync + enable/disable + settings + install URL), Reviews (paginated with repo filter), ReviewDetail (findings by severity + TraceViewer), Usage (period selector, summary cards, bar charts), Settings (placeholder)
- Components: ReviewCard (verdict badge), TraceViewer (expandable accordion), RepoSettings (modal with strictness/patterns/checklist)
- `dashboard/vite.config.ts` — proxy `/api` and `/auth` to `localhost:8787` in dev
- Deploy: `cd dashboard && npm run build && npx wrangler pages deploy dist --project-name code-refinery-dashboard`

**Verified:** `npx tsc --noEmit` ✅. `npm run build` ✅ (297KB JS, 16KB CSS).

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

**Environment variables (wrangler.toml `[vars]`):**
- `DASHBOARD_ORIGIN` — dashboard URL, e.g. `https://code-refinery-dashboard.pages.dev` (never wildcard, used for CORS + CSRF + OAuth redirect)
- `GITHUB_APP_SLUG` — GitHub App slug, e.g. `code-refinery` (used to build install URL: `github.com/apps/{slug}/installations/new`)

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
- Agent loop has dynamic iteration budget (10/15/20 based on changed file count) with structured `<review>` JSON output
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
- `runCommand()` accepts optional `cwd` parameter for subdirectory execution (resolved relative to REPO_DIR)
- `searchContent()` wraps `git grep` (not ripgrep) with input validation, returns empty string for no matches (exit 1 = no matches, not an error). Always available, only searches tracked files, respects .gitignore via index
- `findFiles()` wraps `find` with pattern validation and max depth limit (default 10, max 15)
- Command allowlist is **static-analysis only** — NO test runners (npm test, pytest, cargo test, go test, etc.) as they execute attacker-controlled code from untrusted PRs. Delegate test execution to CI/CD
- Allowlist includes: vulnerability audits (npm audit, pip-audit, cargo audit, bundle audit, go list -m), linters (ruff, mypy, go vet, cargo clippy, rubocop), git read-only commands
- rg and find are NOT in `COMMAND_ALLOWLIST` — only accessible via `searchContent()`/`findFiles()` which validate inputs

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

### API / Auth Conventions
- GitHub OAuth uses a **separate OAuth App** (GITHUB_CLIENT_ID/SECRET), not the GitHub App used for webhooks
- OAuth `state` parameter: random 16 bytes hex, stored in `__oauth_state` cookie (5 min, HttpOnly, Secure, SameSite=Lax), verified on callback
- Session token: 256-bit entropy (`crypto.getRandomValues`), SHA-256 hash stored in D1 (raw token never stored). 30-day expiry
- Cookie: `session`, HttpOnly, Secure, SameSite=None, Path=/ (SameSite=None required for cross-origin Pages → Worker)
- GitHub access token: used once in OAuth callback to fetch user info + installations, then discarded (never stored)
- CSRF on mutations: `checkCsrf()` verifies `Origin` header matches `env.DASHBOARD_ORIGIN` on POST/PATCH/PUT/DELETE. Applied before any handler runs
- CORS: `DASHBOARD_ORIGIN` env var (never wildcard). `Access-Control-Allow-Credentials: true`
- User–repo ownership: M:N `user_installations` join table. All API reads and writes verify ownership through this join
- `settings_json` validation: max 20 ignore patterns (200 chars each), max 10 checklist items (500 chars each), strictness must be lenient|balanced|strict
- Repo sync: `POST /api/repos/sync` fetches repos from GitHub API for each user installation, paginates through all repos, upserts into D1

### Wrangler / Cloudflare Conventions
- `[[containers]]` uses double-bracket (array) TOML syntax, not `[containers]`
- Container config requires `image` field pointing to Dockerfile path (e.g. `"./Dockerfile"`)
- `disk_size_gb` is not a valid container field in wrangler — omit it
- Local dev without Docker: use `--enable-containers=false` flag with `wrangler dev`
- Sandbox class must be re-exported from the Worker entry point (`src/index.ts`) for DO binding: `export { Sandbox } from "@cloudflare/sandbox"`
- Sandbox DO migration uses `new_sqlite_classes` (not `new_classes`) — required by Sandbox SDK
- `.dev.vars` secrets auto-loaded by wrangler dev as environment variables
- PEM keys in `.dev.vars`: use `scripts/stringify-pem.sh` to convert multi-line PEM to single-line
