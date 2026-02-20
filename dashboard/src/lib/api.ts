import type {
  User,
  RepoSettings,
  ReposResponse,
  SyncReposResponse,
  PaginatedReviews,
  Review,
  ReviewTrace,
  UsageStats,
} from "./types";

const API_BASE = import.meta.env.VITE_API_URL || "";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...options,
    headers: {
      ...options?.headers,
    },
  });

  if (response.status === 401) {
    throw new ApiError(401, "Unauthorized");
  }

  if (!response.ok) {
    const body = await response.text();
    let message = `HTTP ${response.status}`;
    try {
      const json = JSON.parse(body);
      if (json.error) message = json.error;
    } catch {
      if (body) message = body;
    }
    throw new ApiError(response.status, message);
  }

  return response.json() as Promise<T>;
}

export const api = {
  getMe: () => apiFetch<User>("/auth/me"),

  getRepos: () => apiFetch<ReposResponse>("/api/repos"),

  syncRepos: () =>
    apiFetch<SyncReposResponse>("/api/repos/sync", { method: "POST" }),

  patchRepoSettings: (id: number, settings: RepoSettings) =>
    apiFetch<{ ok: boolean; settings: RepoSettings }>(
      `/api/repos/${id}/settings`,
      {
        method: "PATCH",
        body: JSON.stringify(settings),
        headers: { "Content-Type": "application/json" },
      },
    ),

  toggleRepo: (id: number, enabled: boolean) =>
    apiFetch<{ ok: boolean; enabled: boolean }>(`/api/repos/${id}/enabled`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
      headers: { "Content-Type": "application/json" },
    }),

  getReviews: (params: { repoId?: number; page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params.repoId) searchParams.set("repo_id", String(params.repoId));
    if (params.page) searchParams.set("page", String(params.page));
    if (params.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return apiFetch<PaginatedReviews>(`/api/reviews${qs ? `?${qs}` : ""}`);
  },

  getReview: (id: number) => apiFetch<Review>(`/api/reviews/${id}`),

  getReviewTrace: (id: number) =>
    apiFetch<ReviewTrace[]>(`/api/reviews/${id}/trace`),

  getUsage: (period = 30) =>
    apiFetch<UsageStats>(`/api/usage?period=${period}`),

  logout: () =>
    apiFetch<{ ok: boolean }>("/auth/logout", { method: "POST" }),
};
