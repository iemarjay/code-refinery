export interface User {
  userId: number;
  githubId: number;
  githubLogin: string;
  avatarUrl: string | null;
}

export interface Repo {
  id: number;
  fullName: string;
  enabled: boolean;
  settings: RepoSettings | null;
  installationGithubId: number;
  createdAt: string;
}

export interface RepoSettings {
  strictness?: "lenient" | "balanced" | "strict";
  ignorePatterns?: string[];
  customChecklist?: string[];
}

export interface Review {
  id: number;
  repoId: number;
  prNumber: number;
  prTitle: string;
  prAuthor: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  status: "completed" | "failed";
  errorMessage: string | null;
  verdict: "approve" | "request_changes" | "comment" | null;
  summary: string | null;
  findings: ReviewFinding[] | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  createdAt: string;
  // Detail-only fields
  prBody?: string | null;
  baseSha?: string;
  setupDurationMs?: number | null;
  sandboxWarm?: boolean | null;
  filesChanged?: number | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  activeSkills?: string[] | null;
}

export interface ReviewFinding {
  skill: string;
  severity: "critical" | "warning" | "info" | "praise";
  path: string;
  line?: number;
  endLine?: number;
  title: string;
  body: string;
}

export interface ReviewTrace {
  id: number;
  turnNumber: number;
  role: string;
  contentJson: string;
  toolName: string | null;
  tokensUsed: number | null;
}

export interface PaginatedReviews {
  reviews: Review[];
  total: number;
  page: number;
  limit: number;
}

export interface ReposResponse {
  repos: Repo[];
  installUrl: string;
}

export interface SyncReposResponse {
  repos: Repo[];
  installUrl: string;
  synced: number;
}

export interface UsageStats {
  totalReviews: number;
  completedReviews: number;
  failedReviews: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  avgDurationMs: number;
  reviewsByDay: Array<{ date: string; count: number }>;
  reviewsByRepo: Array<{ repoName: string; count: number }>;
}
