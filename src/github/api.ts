import type { ReviewComment } from "./types";

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "code-refinery";
const API_VERSION = "2022-11-28";

function githubHeaders(
  token: string,
  accept?: string,
): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: accept ?? "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": API_VERSION,
  };
}

export async function getPRDiff(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`;
  const response = await fetch(url, {
    headers: githubHeaders(token, "application/vnd.github.diff"),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to fetch PR diff (HTTP ${response.status}): ${body}`,
    );
  }

  return response.text();
}

export async function postReview(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  comments: ReviewComment[],
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  commitId: string,
): Promise<void> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
  const response = await fetch(url, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({
      body,
      event,
      comments,
      commit_id: commitId,
    }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Failed to post review (HTTP ${response.status}): ${responseBody}`,
    );
  }
}

export async function postComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  const response = await fetch(url, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Failed to post comment (HTTP ${response.status}): ${responseBody}`,
    );
  }
}
