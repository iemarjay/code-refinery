import type { Env } from "../index";
import type { AuthContext } from "./middleware";
import {
  getReviewsPaginated,
  getReviewById,
  getReviewTraces,
  verifyUserOwnsRepo,
  verifyUserOwnsReview,
} from "../db/queries";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleGetReviews(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const url = new URL(request.url);
  const repoIdStr = url.searchParams.get("repo_id");
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const limit = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)),
  );

  let repoId: number | undefined;
  if (repoIdStr) {
    repoId = parseInt(repoIdStr, 10);
    if (isNaN(repoId)) {
      return jsonResponse({ error: "Invalid repo_id" }, 400);
    }
    // Verify user owns this repo
    const owns = await verifyUserOwnsRepo(env.DB, auth.userId, repoId);
    if (!owns) {
      return jsonResponse({ error: "Not found" }, 404);
    }
  }

  const result = await getReviewsPaginated(env.DB, {
    repoId,
    userId: auth.userId,
    page,
    limit,
  });

  return jsonResponse({
    reviews: result.rows.map((r) => ({
      id: r.id,
      repoId: r.repo_id,
      prNumber: r.pr_number,
      prTitle: r.pr_title,
      prAuthor: r.pr_author,
      headSha: r.head_sha,
      headRef: r.head_ref,
      baseRef: r.base_ref,
      status: r.status,
      errorMessage: r.error_message,
      verdict: r.verdict,
      summary: r.summary,
      findings: r.findings_json ? JSON.parse(r.findings_json) : null,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      durationMs: r.duration_ms,
      createdAt: r.created_at,
    })),
    total: result.total,
    page,
    limit,
  });
}

export async function handleGetReview(
  _request: Request,
  env: Env,
  auth: AuthContext,
  reviewId: number,
): Promise<Response> {
  const owns = await verifyUserOwnsReview(env.DB, auth.userId, reviewId);
  if (!owns) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  const review = await getReviewById(env.DB, reviewId);
  if (!review) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  return jsonResponse({
    id: review.id,
    repoId: review.repo_id,
    prNumber: review.pr_number,
    prTitle: review.pr_title,
    prBody: review.pr_body,
    prAuthor: review.pr_author,
    headSha: review.head_sha,
    headRef: review.head_ref,
    baseSha: review.base_sha,
    baseRef: review.base_ref,
    status: review.status,
    errorMessage: review.error_message,
    verdict: review.verdict,
    summary: review.summary,
    findings: review.findings_json ? JSON.parse(review.findings_json) : null,
    model: review.model,
    inputTokens: review.input_tokens,
    outputTokens: review.output_tokens,
    durationMs: review.duration_ms,
    setupDurationMs: review.setup_duration_ms,
    sandboxWarm: review.sandbox_warm != null ? Boolean(review.sandbox_warm) : null,
    filesChanged: review.files_changed,
    linesAdded: review.lines_added,
    linesRemoved: review.lines_removed,
    activeSkills: review.active_skills_json
      ? JSON.parse(review.active_skills_json)
      : null,
    createdAt: review.created_at,
  });
}

export async function handleGetReviewTrace(
  _request: Request,
  env: Env,
  auth: AuthContext,
  reviewId: number,
): Promise<Response> {
  const owns = await verifyUserOwnsReview(env.DB, auth.userId, reviewId);
  if (!owns) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  const traces = await getReviewTraces(env.DB, reviewId);

  return jsonResponse(
    traces.map((t) => ({
      id: t.id,
      turnNumber: t.turn_number,
      role: t.role,
      contentJson: t.content_json,
      toolName: t.tool_name,
      tokensUsed: t.tokens_used,
    })),
  );
}
