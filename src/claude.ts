import { execFileSync } from "child_process";
import { reviewSchemaJson } from "./schema";
import type { ReviewOutput, ClaudeJsonResult, InvokeResult } from "./types";

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

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5_000;

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

function sleep(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait — no async in execFileSync context */ }
}

function isPromptTooLong(stdout: string): boolean {
  try {
    const envelope = JSON.parse(stdout);
    return (
      envelope?.type === "result" &&
      envelope?.is_error === true &&
      typeof envelope?.result === "string" &&
      envelope.result.includes("Prompt is too long")
    );
  } catch {
    return false;
  }
}

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

export function invokeClaude(options: InvokeClaudeOptions): InvokeResult {
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

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const stdout = execFileSync("claude", args, {
        input: prompt,
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: timeoutMs,
      });

      // Check for PROMPT_TOO_LONG before parsing — surface to caller
      if (isPromptTooLong(stdout)) {
        console.warn("Claude reported prompt is too long.");
        return { output: EMPTY_RESULT, promptTooLong: true };
      }

      return { output: parseClaudeOutput(stdout), promptTooLong: false };
    } catch (err) {
      const error = err as Error & { code?: string; stderr?: string; stdout?: string; status?: number };

      // Check stdout on error too — Claude may return non-zero with PROMPT_TOO_LONG
      if (error.stdout && isPromptTooLong(error.stdout)) {
        console.warn("Claude reported prompt is too long.");
        return { output: EMPTY_RESULT, promptTooLong: true };
      }

      const isTimeout = error.code === "ETIMEDOUT" || error.message?.includes("TIMEOUT");
      const isLastAttempt = attempt === MAX_RETRIES - 1;

      if (isTimeout) {
        console.error(`Claude CLI timed out after ${timeoutMinutes} minutes.`);
        return { output: EMPTY_RESULT, promptTooLong: false };
      }

      if (isLastAttempt) {
        console.error(
          `Claude CLI failed after ${MAX_RETRIES} attempts (exit ${error.status ?? "unknown"}): ${error.stderr?.slice(0, 500) || error.message}`,
        );
        return { output: EMPTY_RESULT, promptTooLong: false };
      }

      // Retry with backoff
      const delayMs = RETRY_DELAY_MS * (attempt + 1);
      console.warn(
        `Claude CLI attempt ${attempt + 1} failed (exit ${error.status ?? "unknown"}), retrying in ${delayMs / 1000}s...`,
      );
      sleep(delayMs);
    }
  }

  return { output: EMPTY_RESULT, promptTooLong: false };
}
