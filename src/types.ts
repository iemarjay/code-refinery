export type Severity = "critical" | "warning" | "info";
export type PassType = "security" | "code-quality";
export type Verdict = "approve" | "comment" | "request_changes";

export interface ReviewFinding {
  file: string;
  line: number;
  severity: Severity;
  category: string;
  description: string;
  confidence: number;
  recommendation?: string;
  exploit_scenario?: string;
  pass_type?: PassType;
}

export interface AnalysisSummary {
  files_reviewed: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
  review_completed: boolean;
}

export interface ReviewOutput {
  findings: ReviewFinding[];
  analysis_summary: AnalysisSummary;
}

// Claude CLI JSON envelope — structured_output from --json-schema,
// or result string that needs parsing as fallback.
export interface ClaudeJsonResult {
  result?: string;
  structured_output?: ReviewOutput;
}

export interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

export interface PRData {
  number: number;
  title: string;
  body: string;
  user: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: PRFile[];
}

export interface MergeResult {
  merged: boolean;
  message: string;
  sha?: string;
}

export interface ActionConfig {
  repo: string;
  prNumber: number;
  model: string;
  strictness: string;
  customInstructions: string;
  excludePatterns: string[];
  failOnCritical: boolean;
  autoMerge: boolean;
  autoMergeMethod: string;
  maxTurns: number | undefined;
  maxBudgetUsd: number | undefined;
  timeoutMinutes: number;
}
