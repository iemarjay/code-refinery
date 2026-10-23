import { spawn } from "child_process";
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
  // Prefix for log lines — both passes run concurrently, so logs interleave
  label?: string;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  timedOut: boolean;
  spawnError?: Error;
}

function runClaude(args: string[], input: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    // detached: own process group, so a timeout also kills the tool
    // subprocesses Claude started (they would otherwise hold the pipes open)
    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch { /* already exited */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5_000).unref();
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ stdout, stderr, status: null, timedOut });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err) => finish({ stdout, stderr, status: null, timedOut, spawnError: err }));
    child.on("close", (status) => finish({ stdout, stderr, status, timedOut }));

    child.stdin.on("error", () => { /* surfaced via close/error */ });
    child.stdin.end(input);
  });
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

function parseClaudeOutput(stdout: string, log: (msg: string) => void): ReviewOutput {
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

  log("Claude output missing structured_output and result fields.");
  return EMPTY_RESULT;
}

export async function invokeClaude(options: InvokeClaudeOptions): Promise<InvokeResult> {
  const {
    prompt,
    systemPrompt,
    repoDir,
    model,
    maxTurns,
    maxBudgetUsd,
    timeoutMinutes,
    disallowedTools = "Bash(ps:*)",
    label,
  } = options;

  const prefix = label ? `  [${label}] ` : "";
  const warn = (msg: string) => console.warn(prefix + msg);
  const error = (msg: string) => console.error(prefix + msg);

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
    const run = await runClaude(args, prompt, repoDir, timeoutMs);

    // Check for PROMPT_TOO_LONG before anything else — Claude may report it
    // with either a zero or non-zero exit
    if (isPromptTooLong(run.stdout)) {
      warn("Claude reported prompt is too long.");
      return { output: EMPTY_RESULT, promptTooLong: true };
    }

    if (run.timedOut) {
      error(`Claude CLI timed out after ${timeoutMinutes} minutes.`);
      return { output: EMPTY_RESULT, promptTooLong: false };
    }

    if (run.status === 0 && !run.spawnError) {
      try {
        return { output: parseClaudeOutput(run.stdout, warn), promptTooLong: false };
      } catch (err) {
        error(`Failed to parse Claude output: ${(err as Error).message}`);
        return { output: EMPTY_RESULT, promptTooLong: false };
      }
    }

    const detail = run.spawnError?.message || run.stderr.slice(0, 500) || run.stdout.slice(0, 500);

    if (attempt === MAX_RETRIES - 1) {
      error(`Claude CLI failed after ${MAX_RETRIES} attempts (exit ${run.status ?? "unknown"}): ${detail}`);
      return { output: EMPTY_RESULT, promptTooLong: false };
    }

    // Retry with backoff
    const delayMs = RETRY_DELAY_MS * (attempt + 1);
    warn(`Claude CLI attempt ${attempt + 1} failed (exit ${run.status ?? "unknown"}), retrying in ${delayMs / 1000}s...`);
    await sleep(delayMs);
  }

  return { output: EMPTY_RESULT, promptTooLong: false };
}
