import type { Env } from "../index";
import type { AuthContext } from "./middleware";
import {
  getReposForUser,
  getInstallationIdsForUser,
  upsertInstallation,
  upsertRepo,
  verifyUserOwnsRepo,
  updateRepoSettings,
  updateRepoEnabled,
} from "../db/queries";
import { getInstallationToken } from "../github/auth";

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "code-refinery";

const VALID_STRICTNESS = new Set(["lenient", "balanced", "strict"]);
const MAX_IGNORE_PATTERNS = 20;
const MAX_PATTERN_LENGTH = 200;
const MAX_CHECKLIST_ITEMS = 10;
const MAX_CHECKLIST_LENGTH = 500;

interface RepoSettings {
  strictness?: string;
  ignorePatterns?: string[];
  customChecklist?: string[];
}

function validateSettings(body: unknown): RepoSettings | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Settings must be an object";
  }

  const settings = body as Record<string, unknown>;
  const result: RepoSettings = {};

  if (settings.strictness !== undefined) {
    if (
      typeof settings.strictness !== "string" ||
      !VALID_STRICTNESS.has(settings.strictness)
    ) {
      return "strictness must be one of: lenient, balanced, strict";
    }
    result.strictness = settings.strictness;
  }

  if (settings.ignorePatterns !== undefined) {
    if (!Array.isArray(settings.ignorePatterns)) {
      return "ignorePatterns must be an array of strings";
    }
    if (settings.ignorePatterns.length > MAX_IGNORE_PATTERNS) {
      return `ignorePatterns: max ${MAX_IGNORE_PATTERNS} patterns`;
    }
    for (const p of settings.ignorePatterns) {
      if (typeof p !== "string" || p.length > MAX_PATTERN_LENGTH) {
        return `Each ignore pattern must be a string under ${MAX_PATTERN_LENGTH} chars`;
      }
    }
    result.ignorePatterns = settings.ignorePatterns;
  }

  if (settings.customChecklist !== undefined) {
    if (!Array.isArray(settings.customChecklist)) {
      return "customChecklist must be an array of strings";
    }
    if (settings.customChecklist.length > MAX_CHECKLIST_ITEMS) {
      return `customChecklist: max ${MAX_CHECKLIST_ITEMS} items`;
    }
    for (const item of settings.customChecklist) {
      if (typeof item !== "string" || item.length > MAX_CHECKLIST_LENGTH) {
        return `Each checklist item must be a string under ${MAX_CHECKLIST_LENGTH} chars`;
      }
    }
    result.customChecklist = settings.customChecklist;
  }

  return result;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getInstallUrl(env: Env): string {
  return `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`;
}

function mapRepos(repos: Awaited<ReturnType<typeof getReposForUser>>) {
  return repos.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    enabled: Boolean(r.enabled),
    settings: r.settings_json ? JSON.parse(r.settings_json) : null,
    installationGithubId: r.installation_github_id,
    createdAt: r.created_at,
  }));
}

export async function handleGetRepos(
  _request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const repos = await getReposForUser(env.DB, auth.userId);

  return jsonResponse({
    repos: mapRepos(repos),
    installUrl: getInstallUrl(env),
  });
}

/**
 * Sync repos from GitHub for all of the user's installations.
 * Calls GET /installation/repositories for each installation,
 * upserts repos into D1, and returns the updated list.
 */
export async function handleSyncRepos(
  _request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const installationIds = await getInstallationIdsForUser(env.DB, auth.userId);

  if (installationIds.length === 0) {
    const repos = await getReposForUser(env.DB, auth.userId);
    return jsonResponse({
      repos: mapRepos(repos),
      installUrl: getInstallUrl(env),
      synced: 0,
    });
  }

  let synced = 0;

  for (const ghInstId of installationIds) {
    try {
      const token = await getInstallationToken(
        env.GITHUB_APP_ID,
        env.GITHUB_PRIVATE_KEY,
        ghInstId,
      );

      const dbInstId = await upsertInstallation(env.DB, ghInstId);

      // Paginate through all repos for this installation
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await fetch(
          `${GITHUB_API_BASE}/installation/repositories?per_page=100&page=${page}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": USER_AGENT,
            },
          },
        );

        if (!response.ok) {
          console.error(
            `Failed to fetch repos for installation ${ghInstId}: HTTP ${response.status}`,
          );
          break;
        }

        const data: {
          repositories: Array<{ full_name: string }>;
          total_count: number;
        } = await response.json();

        for (const repo of data.repositories) {
          await upsertRepo(env.DB, repo.full_name, dbInstId);
          synced++;
        }

        hasMore = page * 100 < data.total_count;
        page++;
      }
    } catch (err) {
      console.error(`Failed to sync installation ${ghInstId}:`, err);
      // Continue with other installations
    }
  }

  const repos = await getReposForUser(env.DB, auth.userId);

  return jsonResponse({
    repos: mapRepos(repos),
    installUrl: getInstallUrl(env),
    synced,
  });
}

export async function handlePatchRepoSettings(
  request: Request,
  env: Env,
  auth: AuthContext,
  repoId: number,
): Promise<Response> {
  const owns = await verifyUserOwnsRepo(env.DB, auth.userId, repoId);
  if (!owns) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const result = validateSettings(body);
  if (typeof result === "string") {
    return jsonResponse({ error: result }, 400);
  }

  await updateRepoSettings(env.DB, repoId, JSON.stringify(result));

  return jsonResponse({ ok: true, settings: result });
}

export async function handleToggleRepo(
  request: Request,
  env: Env,
  auth: AuthContext,
  repoId: number,
): Promise<Response> {
  const owns = await verifyUserOwnsRepo(env.DB, auth.userId, repoId);
  if (!owns) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>).enabled !== "boolean") {
    return jsonResponse({ error: "Body must have { enabled: boolean }" }, 400);
  }

  const enabled = (body as { enabled: boolean }).enabled;
  await updateRepoEnabled(env.DB, repoId, enabled);

  return jsonResponse({ ok: true, enabled });
}
