import { handleWebhook } from "./router";
import { executeReview } from "./agent/review";
import type { ReviewJob } from "./github/types";
import { isJobSuperseded, markJobProcessing, markJobDone } from "./db/queries";
import { handlePreflight, withCors } from "./api/cors";
import { requireAuth, checkCsrf, type AuthContext } from "./api/middleware";
import {
  handleAuthLogin,
  handleAuthCallback,
  handleAuthLogout,
  handleAuthMe,
} from "./api/auth";
import { handleGetRepos, handleSyncRepos, handlePatchRepoSettings, handleToggleRepo } from "./api/repos";
import { handleGetReviews, handleGetReview, handleGetReviewTrace } from "./api/reviews";
import { handleGetUsage } from "./api/usage";

import type { Sandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  // Cloudflare bindings
  REVIEW_QUEUE: Queue;
  DB: D1Database;
  SANDBOX: DurableObjectNamespace<Sandbox>;

  // Secrets
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;

  // Config
  DASHBOARD_ORIGIN: string;
  GITHUB_APP_SLUG: string;
}

// --- Route matching ---

function matchRoute(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }

  return params;
}

// --- Auth routing ---

async function routeAuth(
  pathname: string,
  request: Request,
  env: Env,
): Promise<Response> {
  if (pathname === "/auth/login" && request.method === "GET") {
    return handleAuthLogin(request, env);
  }
  if (pathname === "/auth/callback" && request.method === "GET") {
    return handleAuthCallback(request, env);
  }
  if (pathname === "/auth/logout" && request.method === "POST") {
    return handleAuthLogout(request, env);
  }
  if (pathname === "/auth/me" && request.method === "GET") {
    return handleAuthMe(request, env);
  }
  return new Response("Not found", { status: 404 });
}

// --- API routing (requires auth) ---

async function routeApi(
  pathname: string,
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  // Repos
  if (pathname === "/api/repos" && request.method === "GET") {
    return handleGetRepos(request, env, auth);
  }
  if (pathname === "/api/repos/sync" && request.method === "POST") {
    return handleSyncRepos(request, env, auth);
  }

  const repoSettingsMatch = matchRoute("/api/repos/:id/settings", pathname);
  if (repoSettingsMatch && request.method === "PATCH") {
    const repoId = parseInt(repoSettingsMatch.id, 10);
    if (isNaN(repoId)) return jsonResponse({ error: "Invalid repo ID" }, 400);
    return handlePatchRepoSettings(request, env, auth, repoId);
  }

  const repoEnabledMatch = matchRoute("/api/repos/:id/enabled", pathname);
  if (repoEnabledMatch && request.method === "PATCH") {
    const repoId = parseInt(repoEnabledMatch.id, 10);
    if (isNaN(repoId)) return jsonResponse({ error: "Invalid repo ID" }, 400);
    return handleToggleRepo(request, env, auth, repoId);
  }

  // Reviews
  if (pathname === "/api/reviews" && request.method === "GET") {
    return handleGetReviews(request, env, auth);
  }

  const reviewTraceMatch = matchRoute("/api/reviews/:id/trace", pathname);
  if (reviewTraceMatch && request.method === "GET") {
    const reviewId = parseInt(reviewTraceMatch.id, 10);
    if (isNaN(reviewId)) return jsonResponse({ error: "Invalid review ID" }, 400);
    return handleGetReviewTrace(request, env, auth, reviewId);
  }

  const reviewMatch = matchRoute("/api/reviews/:id", pathname);
  if (reviewMatch && request.method === "GET") {
    const reviewId = parseInt(reviewMatch.id, 10);
    if (isNaN(reviewId)) return jsonResponse({ error: "Invalid review ID" }, 400);
    return handleGetReview(request, env, auth, reviewId);
  }

  // Usage
  if (pathname === "/api/usage" && request.method === "GET") {
    return handleGetUsage(request, env, auth);
  }

  return new Response("Not found", { status: 404 });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Job validation ---

function validateReviewJob(raw: unknown): ReviewJob {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Invalid job: not an object");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.prNumber !== "number" || !Number.isInteger(obj.prNumber)) {
    throw new Error("Invalid job: prNumber must be an integer");
  }
  if (typeof obj.repoFullName !== "string" || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(obj.repoFullName)) {
    throw new Error("Invalid job: repoFullName must be 'owner/repo'");
  }
  if (typeof obj.cloneUrl !== "string" || !obj.cloneUrl.startsWith("https://")) {
    throw new Error("Invalid job: cloneUrl must be HTTPS");
  }
  if (typeof obj.headRef !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._\/-]*$/.test(obj.headRef)) {
    throw new Error("Invalid job: headRef contains invalid characters");
  }
  if (typeof obj.headSha !== "string" || !/^[0-9a-f]{7,40}$/i.test(obj.headSha)) {
    throw new Error("Invalid job: headSha must be a hex SHA");
  }
  if (typeof obj.baseRef !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._\/-]*$/.test(obj.baseRef)) {
    throw new Error("Invalid job: baseRef contains invalid characters");
  }
  if (typeof obj.baseSha !== "string" || !/^[0-9a-f]{7,40}$/i.test(obj.baseSha)) {
    throw new Error("Invalid job: baseSha must be a hex SHA");
  }
  if (typeof obj.installationId !== "number" || !Number.isInteger(obj.installationId)) {
    throw new Error("Invalid job: installationId must be an integer");
  }

  return {
    prNumber: obj.prNumber,
    prTitle: typeof obj.prTitle === "string" ? obj.prTitle : "",
    prBody: typeof obj.prBody === "string" ? obj.prBody : null,
    repoFullName: obj.repoFullName,
    cloneUrl: obj.cloneUrl,
    headRef: obj.headRef,
    headSha: obj.headSha,
    baseRef: obj.baseRef,
    baseSha: obj.baseSha,
    prAuthor: typeof obj.prAuthor === "string" ? obj.prAuthor : "",
    installationId: obj.installationId,
    enqueuedAt: typeof obj.enqueuedAt === "string" ? obj.enqueuedAt : new Date().toISOString(),
  };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    const preflight = handlePreflight(request, env);
    if (preflight) return preflight;

    // Webhook (no CORS, no auth)
    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }

    // Auth routes (CORS, no session auth)
    if (url.pathname.startsWith("/auth/")) {
      const response = await routeAuth(url.pathname, request, env);
      return withCors(response, env);
    }

    // API routes (CORS + CSRF + session auth)
    if (url.pathname.startsWith("/api/")) {
      // CSRF check on mutations
      const csrfError = checkCsrf(request, env);
      if (csrfError) return withCors(csrfError, env);

      // Require authentication
      const authResult = await requireAuth(request, env);
      if (authResult instanceof Response) {
        return withCors(authResult, env);
      }

      const response = await routeApi(url.pathname, request, env, authResult);
      return withCors(response, env);
    }

    return new Response("OK", { status: 200 });
  },

  async queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(`[queue] Received batch: ${batch.messages.length} message(s)`);

    for (const msg of batch.messages) {
      const msgId = msg.id.slice(0, 8);
      let job: ReviewJob;
      try {
        job = validateReviewJob(msg.body);
      } catch (err) {
        console.error(`[queue ${msgId}] Invalid message, discarding:`, err);
        msg.ack(); // discard malformed messages — retrying won't fix them
        continue;
      }

      const tag = `${job.repoFullName}#${job.prNumber} ${job.headSha.slice(0, 7)}`;
      console.log(`[queue ${msgId}] Processing: ${tag} (attempt ${msg.attempts})`);

      // Debounce: skip if a newer push superseded this job
      if (await isJobSuperseded(env.DB, job.repoFullName, job.prNumber, job.headSha)) {
        console.log(`[queue ${msgId}] Skipping superseded: ${tag}`);
        msg.ack();
        continue;
      }

      await markJobProcessing(env.DB, job.repoFullName, job.prNumber, job.headSha);
      console.log(`[queue ${msgId}] Marked processing: ${tag}`);

      try {
        const startMs = Date.now();
        await executeReview(job, env);
        const durationMs = Date.now() - startMs;
        await markJobDone(env.DB, job.repoFullName, job.prNumber, job.headSha, "done");
        console.log(`[queue ${msgId}] Completed: ${tag} (${durationMs}ms)`);
        msg.ack();
      } catch (err) {
        await markJobDone(env.DB, job.repoFullName, job.prNumber, job.headSha, "failed");
        console.error(`[queue ${msgId}] Failed: ${tag}`, err);
        msg.retry();
      }
    }
  },
};
