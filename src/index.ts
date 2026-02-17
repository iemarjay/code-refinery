import { handleWebhook } from "./router";

export { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  // Cloudflare bindings
  REVIEW_QUEUE: Queue;
  DB: D1Database;
  SANDBOX: DurableObjectNamespace;

  // Secrets
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
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

  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const msg of batch.messages) {
      // Phase 5: agent loop
      console.log(`Received job: ${JSON.stringify(msg.body)}`);
      msg.ack();
    }
  },
};
