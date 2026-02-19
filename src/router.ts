import type { Env } from "./index";
import type { PullRequestEvent, ReviewJob } from "./github/types";
import { tryEnqueueJob } from "./db/queries";

const RELEVANT_ACTIONS = new Set(["opened", "synchronize"]);

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

async function verifySignature(
  secret: string,
  signatureHeader: string,
  body: ArrayBuffer,
): Promise<boolean> {
  const parts = signatureHeader.split("=");
  if (parts[0] !== "sha256" || !parts[1]) {
    return false;
  }
  const signatureHex = parts.slice(1).join("=");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const mac = await crypto.subtle.sign("HMAC", key, body);

  const expected = hexToUint8Array(signatureHex);
  const actual = new Uint8Array(mac);

  if (expected.byteLength !== actual.byteLength) {
    return false;
  }

  return crypto.subtle.timingSafeEqual(expected, actual);
}

export async function handleWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const signatureHeader = request.headers.get("X-Hub-Signature-256");
  if (!signatureHeader) {
    return new Response("Missing signature", { status: 401 });
  }

  const body = await request.arrayBuffer();

  const isValid = await verifySignature(
    env.GITHUB_WEBHOOK_SECRET,
    signatureHeader,
    body,
  );
  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
  }

  const event = request.headers.get("X-GitHub-Event");
  if (event !== "pull_request") {
    return new Response("Ignored: not a pull_request event", { status: 200 });
  }

  let payload: PullRequestEvent;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as PullRequestEvent;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!RELEVANT_ACTIONS.has(payload.action)) {
    return new Response(`Ignored: action "${payload.action}"`, { status: 200 });
  }

  if (payload.pull_request.draft) {
    return new Response("Ignored: draft PR", { status: 200 });
  }

  if (!payload.installation?.id) {
    return new Response("Missing installation ID", { status: 400 });
  }

  const repoFullName = payload.repository.full_name;
  const prNumber = payload.pull_request.number;
  const headSha = payload.pull_request.head.sha;

  // Rate limit, SHA dedup, and PR debounce — all in one D1 call
  const dedup = await tryEnqueueJob(env.DB, repoFullName, prNumber, headSha);
  if (!dedup.allowed) {
    const status = dedup.reason === "rate_limited" ? 429 : 200;
    return new Response(
      JSON.stringify({ message: `Skipped: ${dedup.reason}`, prNumber }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  }

  const job: ReviewJob = {
    prNumber,
    prTitle: payload.pull_request.title,
    prBody: payload.pull_request.body,
    repoFullName,
    cloneUrl: payload.repository.clone_url,
    headRef: payload.pull_request.head.ref,
    headSha,
    baseRef: payload.pull_request.base.ref,
    baseSha: payload.pull_request.base.sha,
    prAuthor: payload.pull_request.user.login,
    installationId: payload.installation.id,
    enqueuedAt: new Date().toISOString(),
  };

  await env.REVIEW_QUEUE.send(job);

  return new Response(
    JSON.stringify({ message: "Review queued", prNumber: job.prNumber }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
