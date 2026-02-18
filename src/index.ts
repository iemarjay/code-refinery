import { handleWebhook } from "./router";
import { executeReview } from "./agent/review";
import type { ReviewJob } from "./github/types";

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
}

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
    installationId: obj.installationId,
    enqueuedAt: typeof obj.enqueuedAt === "string" ? obj.enqueuedAt : new Date().toISOString(),
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      // Phase 7: dashboard API
      return new Response("Not implemented", { status: 501 });
    }

    if (url.pathname.startsWith("/auth/")) {
      // Phase 7: GitHub OAuth
      return new Response("Not implemented", { status: 501 });
    }

    return new Response("OK", { status: 200 });
  },

  async queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const msg of batch.messages) {
      let job: ReviewJob;
      try {
        job = validateReviewJob(msg.body);
      } catch (err) {
        console.error("Invalid queue message, discarding:", err);
        msg.ack(); // discard malformed messages — retrying won't fix them
        continue;
      }
      try {
        await executeReview(job, env);
        msg.ack();
      } catch (err) {
        console.error(`Job failed for ${job.repoFullName} PR #${job.prNumber}:`, err);
        msg.retry();
      }
    }
  },
};
