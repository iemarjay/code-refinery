import { getSandbox, type Sandbox, type ExecuteResponse } from "@cloudflare/sandbox";

export const REPO_DIR = "/workspace/repo";

const CLONE_TIMEOUT = 120_000;
const FETCH_TIMEOUT = 60_000;
const COMMAND_TIMEOUT = 30_000;
const TEST_TIMEOUT = 120_000;

// Characters that can break out of shell context when interpolated into commands.
// Covers command chaining, subshells, redirects, backticks, variable expansion, and globbing.
const SHELL_METACHAR_RE = /[;|&`$(){}><\n\r\\!"#~]/;

/** Git ref names allow surprisingly many characters. We restrict to a safe subset. */
const SAFE_GIT_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]*$/;

/** Git SHAs: 7-40 hex characters. */
const SAFE_SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Shell-safe single-quote a string: wrap in '' with interior ' escaped. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Scrub tokens/credentials from URLs in a string (for safe logging). */
function scrubTokens(s: string): string {
  return s.replace(
    /https?:\/\/[^@]*@/g,
    (match) => match.replace(/\/\/.*@/, "//<REDACTED>@"),
  );
}

export const COMMAND_ALLOWLIST: readonly string[] = [
  // JS/TS
  "npm test",
  "npm run lint",
  "npx tsc --noEmit",
  // Python
  "python -m pytest",
  "python -m ruff",
  "python -m mypy",
  // Go
  "go test",
  "go vet",
  // Rust
  "cargo test",
  "cargo clippy",
  // Ruby
  "bundle exec rake test",
  "bundle exec rubocop",
  // Java/Kotlin
  "./gradlew test",
  "./mvnw test",
  "mvn test",
  // Generic
  "make test",
  "make lint",
  // Git (all languages)
  "git log",
  "git show",
  "git ls-files",
  "git diff",
  "git branch",
  "git status",
  // rg and find are NOT in this list — they're only accessible via
  // searchContent() and findFiles() which validate inputs and build
  // safe commands. Allowing raw rg/find via run_command would expose
  // dangerous flags like --pre (arbitrary code execution).
];

export class SandboxError extends Error {
  constructor(
    message: string,
    public readonly command?: string,
    public readonly exitCode?: number,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

// --- Internal helpers ---

function normalizePath(inputPath: string): string {
  if (inputPath.includes("\0")) {
    throw new SandboxError("Path contains null byte", inputPath);
  }

  const parts = inputPath.split("/");
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return "/" + resolved.join("/");
}

function injectTokenIntoUrl(cloneUrl: string, token: string): string {
  const url = new URL(cloneUrl);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

async function execOrThrow(
  sandbox: DurableObjectStub<Sandbox>,
  command: string,
  options?: { cwd?: string; timeout?: number },
): Promise<ExecuteResponse> {
  const result = await sandbox.exec(command, {
    cwd: options?.cwd ?? REPO_DIR,
    timeout: options?.timeout ?? COMMAND_TIMEOUT,
  });

  if (!result.success) {
    throw new SandboxError(
      `Command failed (exit ${result.exitCode}): ${scrubTokens(command)}\n${scrubTokens(result.stderr)}`,
      scrubTokens(command),
      result.exitCode,
      scrubTokens(result.stderr),
    );
  }

  return result;
}

// --- Public API ---

export function getSandboxForRepo(
  ns: DurableObjectNamespace<Sandbox>,
  repoFullName: string,
): DurableObjectStub<Sandbox> {
  const sandboxId = repoFullName.replaceAll("/", "--");
  return getSandbox(ns, sandboxId);
}

export async function setupRepo(
  sandbox: DurableObjectStub<Sandbox>,
  cloneUrl: string,
  headRef: string,
  headSha: string,
  token: string,
): Promise<{ cloned: boolean; duration: number }> {
  // Validate inputs before any shell interpolation
  if (!SAFE_GIT_REF_RE.test(headRef)) {
    throw new SandboxError(`Invalid branch name: ${headRef}`);
  }
  if (!SAFE_SHA_RE.test(headSha)) {
    throw new SandboxError(`Invalid SHA: ${headSha}`);
  }

  const start = Date.now();
  const authenticatedUrl = injectTokenIntoUrl(cloneUrl, token);
  const quotedUrl = shellQuote(authenticatedUrl);

  // Check if repo is already cloned (warm sandbox)
  const check = await sandbox.exec("git rev-parse --is-inside-work-tree", {
    cwd: REPO_DIR,
    timeout: 5_000,
  });

  if (check.success && check.stdout.trim() === "true") {
    // Warm path: update remote URL with fresh token, fetch the specific branch, checkout
    await execOrThrow(sandbox, `git remote set-url origin ${quotedUrl}`, {
      timeout: 5_000,
    });

    // Fetch the specific branch — plain `git fetch origin` may not fetch PR branches
    const branchFetch = await sandbox.exec(
      `git fetch origin +refs/heads/${headRef}:refs/remotes/origin/${headRef}`,
      { cwd: REPO_DIR, timeout: FETCH_TIMEOUT },
    );

    if (branchFetch.success) {
      await execOrThrow(sandbox, `git checkout -B ${headRef} origin/${headRef}`, {
        timeout: FETCH_TIMEOUT,
      });
    } else {
      // Branch not on remote (e.g. fork PR, deleted branch) — fetch by SHA
      await execOrThrow(sandbox, `git fetch origin ${headSha}`, {
        timeout: FETCH_TIMEOUT,
      });
      await execOrThrow(sandbox, `git checkout -B ${headRef} ${headSha}`, {
        timeout: FETCH_TIMEOUT,
      });
    }

    await execOrThrow(sandbox, `git reset --hard HEAD`, { timeout: 10_000 });
    await execOrThrow(sandbox, "git clean -fd", { timeout: 10_000 });
  } else {
    // Cold path: fresh clone
    await execOrThrow(
      sandbox,
      `git clone --depth=50 ${quotedUrl} ${REPO_DIR}`,
      { cwd: "/workspace", timeout: CLONE_TIMEOUT },
    );
    // Checkout the PR branch (may already be the default branch)
    const checkout = await sandbox.exec(`git checkout ${headRef}`, {
      cwd: REPO_DIR,
      timeout: FETCH_TIMEOUT,
    });
    // If checkout fails, fetch by SHA (works for forks, deleted branches, etc.)
    if (!checkout.success) {
      await execOrThrow(sandbox, `git fetch origin ${headSha}`, {
        timeout: FETCH_TIMEOUT,
      });
      await execOrThrow(sandbox, `git checkout -B ${headRef} ${headSha}`, {
        timeout: FETCH_TIMEOUT,
      });
    }
  }

  // Strip the token from the remote URL so user-controlled code (npm test, etc.)
  // cannot read it via `git remote get-url origin`.
  const publicUrl = cloneUrl.replace(/^http:/, "https:");
  await execOrThrow(sandbox, `git remote set-url origin ${shellQuote(publicUrl)}`, {
    timeout: 5_000,
  });

  const cloned = !(check.success && check.stdout.trim() === "true");
  return { cloned, duration: Date.now() - start };
}

export async function readFile(
  sandbox: DurableObjectStub<Sandbox>,
  path: string,
): Promise<string> {
  const normalized = normalizePath(path);

  if (!normalized.startsWith(REPO_DIR + "/")) {
    throw new SandboxError(`Path traversal blocked: ${path}`);
  }

  try {
    const response = await sandbox.readFile(normalized);

    if (!response.success) {
      throw new SandboxError(`Failed to read file: ${path}`);
    }

    return response.content;
  } catch (err) {
    if (err instanceof SandboxError) throw err;
    throw new SandboxError(
      `Failed to read file: ${path} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

export async function runCommand(
  sandbox: DurableObjectStub<Sandbox>,
  command: string,
): Promise<ExecuteResponse> {
  const trimmed = command.trim();

  // Reject shell metacharacters anywhere in the command to prevent chaining
  // (e.g. `git log ; curl evil.com`). Individual helpers like searchContent
  // build safe commands internally; this blocks the agent from being tricked
  // via prompt injection into crafting dangerous commands.
  if (SHELL_METACHAR_RE.test(trimmed)) {
    throw new SandboxError(`Command contains forbidden characters: ${trimmed}`);
  }

  const isAllowed = COMMAND_ALLOWLIST.some(
    (prefix) => trimmed === prefix || trimmed.startsWith(prefix + " "),
  );

  if (!isAllowed) {
    throw new SandboxError(`Command not allowed: ${trimmed}`);
  }

  const timeout = trimmed.startsWith("npm test") ? TEST_TIMEOUT : COMMAND_TIMEOUT;

  return sandbox.exec(trimmed, { cwd: REPO_DIR, timeout });
}

export async function listFiles(
  sandbox: DurableObjectStub<Sandbox>,
  pattern?: string,
): Promise<string[]> {
  if (pattern && /[;|&`$()\\]/.test(pattern)) {
    throw new SandboxError(`Invalid pattern: ${pattern}`);
  }

  const command = pattern
    ? `git ls-files -- ${shellQuote(pattern)}`
    : "git ls-files";

  const result = await execOrThrow(sandbox, command, { timeout: 10_000 });

  return result.stdout.split("\n").filter((line: string) => line.length > 0);
}

export async function gitDiff(
  sandbox: DurableObjectStub<Sandbox>,
  baseSha: string,
): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/i.test(baseSha)) {
    throw new SandboxError(`Invalid SHA: ${baseSha}`);
  }

  const result = await execOrThrow(sandbox, `git diff ${baseSha}...HEAD`, {
    timeout: COMMAND_TIMEOUT,
  });

  return result.stdout;
}

export async function searchContent(
  sandbox: DurableObjectStub<Sandbox>,
  pattern: string,
  options?: { glob?: string; caseSensitive?: boolean; maxResults?: number },
): Promise<string> {
  // Validate: no shell metacharacters in pattern or glob
  if (/[;|&`$()\\]/.test(pattern)) {
    throw new SandboxError(`Invalid search pattern: ${pattern}`);
  }
  if (options?.glob && /[;|&`$()\\]/.test(options.glob)) {
    throw new SandboxError(`Invalid glob filter: ${options.glob}`);
  }

  const maxResults = Math.min(options?.maxResults ?? 100, 200);
  const parts = ["rg", "--no-heading", "--line-number", `-m ${maxResults}`];

  if (!options?.caseSensitive) {
    parts.push("-i");
  }
  if (options?.glob) {
    parts.push(`--glob ${shellQuote(options.glob)}`);
  }

  parts.push(shellQuote(pattern));

  const command = parts.join(" ");
  // Call sandbox.exec directly — this helper validates its own inputs.
  // rg returns exit 1 for "no matches" — that's not an error.
  const result = await sandbox.exec(command, {
    cwd: REPO_DIR,
    timeout: COMMAND_TIMEOUT,
  });

  if (result.exitCode === 1 && !result.stderr) {
    return ""; // no matches
  }
  if (result.exitCode > 1) {
    throw new SandboxError(
      `Search failed: ${result.stderr}`,
      command,
      result.exitCode,
      result.stderr,
    );
  }

  return result.stdout;
}

export async function findFiles(
  sandbox: DurableObjectStub<Sandbox>,
  pattern: string,
  options?: { type?: "f" | "d"; maxDepth?: number },
): Promise<string[]> {
  if (/[;|&`$()\\]/.test(pattern)) {
    throw new SandboxError(`Invalid find pattern: ${pattern}`);
  }

  const maxDepth = Math.min(options?.maxDepth ?? 10, 15);
  const parts = ["find", ".", `-maxdepth ${maxDepth}`];

  if (options?.type) {
    parts.push(`-type ${options.type}`);
  }

  parts.push(`-name ${shellQuote(pattern)}`);

  // Call sandbox.exec directly — this helper validates its own inputs.
  const command = parts.join(" ");
  const result = await sandbox.exec(command, {
    cwd: REPO_DIR,
    timeout: COMMAND_TIMEOUT,
  });

  if (result.exitCode !== 0) {
    throw new SandboxError(
      `Find failed: ${result.stderr}`,
      command,
      result.exitCode,
      result.stderr,
    );
  }

  return result.stdout.split("\n").filter((line: string) => line.length > 0);
}
