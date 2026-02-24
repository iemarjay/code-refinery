import { execFileSync } from "child_process";
import { reviewSchemaJson } from "./schema";
import type { ReviewOutput, ClaudeJsonResult } from "./types";

export interface InvokeClaudeOptions {
  prompt: string;
  systemPrompt: string;
  repoDir: string;
  model: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMinutes: number;
  disallowedTools?: string;
}

const EMPTY_RESULT: ReviewOutput = {
  findings: [],
  analysis_summary: {
    files_reviewed: 0,
    critical_count: 0,
    warning_count: 0,
    info_count: 0,
    review_completed: false,
  },
};

function parseClaudeOutput(stdout: string): ReviewOutput {
  const envelope: ClaudeJsonResult = JSON.parse(stdout);

  // Prefer structured_output (from --json-schema constrained decoding)
  if (envelope.structured_output) {
    return envelope.structured_output;
  }

  // Fallback: parse the result string
  if (envelope.result) {
    const parsed = JSON.parse(envelope.result);
    if (parsed && Array.isArray(parsed.findings)) {
      return parsed as ReviewOutput;
    }
  }

  console.warn("Claude output missing structured_output and result fields.");
  return EMPTY_RESULT;
}

export function invokeClaude(options: InvokeClaudeOptions): ReviewOutput {
  const {
    prompt,
    systemPrompt,
    repoDir,
    model,
    maxTurns,
    maxBudgetUsd,
    timeoutMinutes,
    disallowedTools = "Bash(ps:*)",
  } = options;

  const args = [
    "--output-format", "json",
    "--model", model,
    "--json-schema", reviewSchemaJson,
    "--append-system-prompt", systemPrompt,
    "--disallowed-tools", disallowedTools,
  ];

  if (maxTurns !== undefined) {
    args.push("--max-turns", String(maxTurns));
  }
  if (maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(maxBudgetUsd));
  }

  const timeoutMs = timeoutMinutes * 60 * 1_000;

  try {
    const stdout = execFileSync("claude", args, {
      input: prompt,
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    return parseClaudeOutput(stdout);
  } catch (err) {
    const error = err as Error & { code?: string; stderr?: string; status?: number };

    if (error.code === "ETIMEDOUT" || error.message?.includes("TIMEOUT")) {
      console.error(`Claude CLI timed out after ${timeoutMinutes} minutes.`);
    } else {
      console.error(
        `Claude CLI failed (exit ${error.status ?? "unknown"}): ${error.stderr?.slice(0, 500) || error.message}`,
      );
    }

    return EMPTY_RESULT;
  }
}
