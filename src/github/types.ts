export interface GitHubUser {
  login: string;
  id: number;
}

export interface GitHubRepository {
  id: number;
  full_name: string;
  name: string;
  owner: GitHubUser;
  clone_url: string;
  default_branch: string;
  private: boolean;
}

export interface GitHubPullRequestRef {
  ref: string;
  sha: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  user: GitHubUser;
  head: GitHubPullRequestRef;
  base: GitHubPullRequestRef;
  draft: boolean;
}

export interface GitHubInstallation {
  id: number;
}

export interface PullRequestEvent {
  action: string;
  number: number;
  pull_request: GitHubPullRequest;
  repository: GitHubRepository;
  installation: GitHubInstallation;
  sender: GitHubUser;
}

export interface ReviewJob {
  prNumber: number;
  prTitle: string;
  prBody: string | null;
  repoFullName: string;
  cloneUrl: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  installationId: number;
  enqueuedAt: string;
}
