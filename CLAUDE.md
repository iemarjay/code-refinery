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
  → fetch() handler: verify HMAC-SHA256 signature, enqueue ReviewJob
  → Cloudflare Queue (pr-review-jobs, batch_size=1, max_retries=3)
  → queue() handler:
      1. getInstallationToken() — JWT + exchange
      2. getPRDiff() — GitHub API with Accept: application/vnd.github.diff
      3. getSandbox(env.SANDBOX, "owner/repo") — keyed by repo for warm clones
      4. sandbox.exec("git clone ...") or sandbox.exec("git fetch && git checkout") — clone or update
      5. runAgentLoop() — while(has_tool_calls) Anthropic API ↔ sandbox.exec() / sandbox.readFile()
      6. postReview() — GitHub PR review API
      7. message.ack()
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
| Sandbox keying | Per repo (`owner/repo`) | Warm clones — 2nd+ review skips clone (~15s faster). 10m default sleep |
| Command execution | Allowlisted only | Security — no arbitrary code from untrusted PRs |
| Model | claude-sonnet-4-5 | Balance of speed and quality for reviews |
| Review output | `<review>` JSON tags | Reliable parsing with reasoning preamble |
| Payments | Stubbed for later | Usage tracking in D1 from day 1 so billing data is ready |
| gh CLI | Not used | All GitHub API via fetch() in Worker. Smaller container image |
| Cloudflare agents-sdk | Not used | Designed for client-facing chat agents. We're webhook-driven, backend-only |

### Warm Sandbox Strategy

Sandboxes keyed by **repo** (not PR). Durable Object keeps sandbox alive after last use (default 10 minutes, configurable via `sleepAfter`). First review pays clone cost (~10-20s). Subsequent reviews do `git fetch && git checkout` (~2-3s). DO is near-free when idle (CPU time only, not wall-clock).

---

## Directory Structure

```
src/                                 ── Worker (webhook + API + queue consumer)
  index.ts                           — Entry point, route dispatch, Env type, re-exports Sandbox
  router.ts                          — Webhook signature verification + event routing
  github/
    auth.ts                          — JWT generation (RS256 via Web Crypto), installation token exchange
    api.ts                           — PR diff, post review, post comment
    types.ts                         — Webhook payload + ReviewJob types
  agent/
    loop.ts                          — Agentic while-loop (core brain)
    tools.ts                         — Tool definitions for Anthropic API + sandbox routing
    prompts.ts                       — System prompt, review checklist, ReviewConfig
  sandbox/
    helpers.ts                       — getSandbox() wrapper, setupRepo(), command allowlist
  api/                               ── Dashboard REST API
    auth.ts                          — GitHub OAuth flow (login, callback, session)
    repos.ts                         — GET /api/repos, PATCH /api/repos/:id/settings
    reviews.ts                       — GET /api/reviews, GET /api/reviews/:id/trace
    usage.ts                         — GET /api/usage (metrics, token counts)
    middleware.ts                    — Session auth middleware
  db/
    schema.ts                        — D1 table definitions (migrations)
    queries.ts                       — Typed query helpers
Dockerfile                           — Sandbox image: node:20-slim + git + jq + curl (no server)
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

### Phase 3: GitHub Auth Module
- `src/github/auth.ts`:
  - `pemToArrayBuffer(pem)` — strip headers, base64 → ArrayBuffer
  - `generateAppJwt(appId, pem)` — RS256 via `crypto.subtle.importKey("pkcs8")` + `crypto.subtle.sign("RSASSA-PKCS1-v1_5")`; iss=appId, iat=now-60, exp=now+600
  - `getInstallationToken(appId, pem, installationId)` — POST `/app/installations/{id}/access_tokens`
- `src/github/api.ts`:
  - `getPRDiff(token, owner, repo, prNumber)` — Accept: application/vnd.github.diff
  - `postReview(token, owner, repo, prNumber, body, comments, event)` — POST /pulls/{n}/reviews
  - `postComment(token, owner, repo, issueNumber, body)` — POST /issues/{n}/comments

**Verify:** Test endpoint generates JWT, gets token, fetches diff, posts review.

### Phase 4: Sandbox Setup
- `Dockerfile` (root) — node:20-slim + git + jq + curl. No Express server — Sandbox SDK handles all communication.
- `src/sandbox/helpers.ts`:
  - `setupRepo(sandbox, cloneUrl, headRef, token)` — `sandbox.exec("git clone ...")` or `sandbox.exec("git fetch && git checkout ...")`
  - `readFile(sandbox, path)` — `sandbox.readFile(path)` with path validation
  - `runCommand(sandbox, cmd)` — allowlisted commands only via `sandbox.exec(cmd)`
  - `listFiles(sandbox, pattern?)` — `sandbox.exec("git ls-files")` with optional filter
  - `gitDiff(sandbox, baseSha)` — `sandbox.exec("git diff baseSha...HEAD")`
  - Command allowlist: npm test, npm run lint, npx tsc --noEmit, git log, git show

**Verify:** Deploy, sandbox.exec("git --version") returns output. Clone a public repo, read files.

### Phase 5: Agent Loop (Core)
- `src/agent/tools.ts` — Tool definitions (read_file, list_files, run_command, git_diff) + sandbox routing (tool_name → helper function)
- `src/agent/prompts.ts` — System prompt (review role, checklist, output format with `<review>` JSON), buildUserMessage()
- `src/agent/loop.ts` — `runAgentLoop(job, diff, sandbox, apiKey, gatewayUrl)`:
  - Anthropic client with AI Gateway baseURL
  - While loop (max 20 iterations): messages.create → if end_turn: parse review → if tool_use: call sandbox helper, collect results, continue
- `src/index.ts` — full queue handler wiring everything together

**Verify:** Deploy, open PR on test repo, review appears on PR within 30-60s.

### Phase 6: Data Layer (D1)
- `src/db/schema.ts` — migration SQL:
  - users (id, github_id, github_login, avatar_url, created_at)
  - installations (id, github_installation_id, user_id, status)
  - repos (id, installation_id, full_name, enabled, settings_json, created_at)
  - reviews (id, repo_id, pr_number, pr_title, head_sha, verdict, summary, comments_json, tokens_used, duration_ms, created_at)
  - review_traces (id, review_id, turn_number, role, content_json, tool_name, tokens_used)
  - sessions (id, user_id, token_hash, expires_at)
- `src/db/queries.ts` — typed helpers
- Integrate with agent loop: log each turn to review_traces, write reviews row on completion

**Verify:** `npx wrangler d1 execute code-refinery-db --command "SELECT * FROM reviews"`

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

### Wrangler / Cloudflare Conventions
- `[[containers]]` uses double-bracket (array) TOML syntax, not `[containers]`
- Container config requires `image` field pointing to Dockerfile path (e.g. `"./Dockerfile"`)
- `disk_size_gb` is not a valid container field in wrangler — omit it
- Local dev without Docker: use `--enable-containers=false` flag with `wrangler dev`
- Sandbox class must be re-exported from the Worker entry point (`src/index.ts`) for DO binding: `export { Sandbox } from "@cloudflare/sandbox"`
- Sandbox DO migration uses `new_sqlite_classes` (not `new_classes`) — required by Sandbox SDK
- `.dev.vars` secrets auto-loaded by wrangler dev as environment variables
- PEM keys in `.dev.vars`: use `scripts/stringify-pem.sh` to convert multi-line PEM to single-line
