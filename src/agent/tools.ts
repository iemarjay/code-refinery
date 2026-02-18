import type Anthropic from "@anthropic-ai/sdk";
import type { Sandbox } from "@cloudflare/sandbox";
import {
  readFile,
  runCommand,
  listFiles,
  gitDiff,
  searchContent,
  findFiles,
  SandboxError,
  REPO_DIR,
} from "../sandbox/helpers";
import type { SandboxToolName } from "./skills/types";

export const TOOL_DEFINITIONS: Record<SandboxToolName, Anthropic.Messages.Tool> = {
  read_file: {
    name: "read_file",
    description:
      "Read the contents of a file in the repository. " +
      "Path must be relative to the repository root (e.g., 'src/index.ts').",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path relative to repository root",
        },
      },
      required: ["path"],
    },
  },

  list_files: {
    name: "list_files",
    description:
      "List tracked files in the repository matching an optional glob pattern. " +
      "Omit pattern to list all tracked files.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Optional glob pattern, e.g. 'src/**/*.ts'",
        },
      },
    },
  },

  run_command: {
    name: "run_command",
    description:
      "Run an allowlisted command in the repository. " +
      "Allowed: test runners (npm test, pytest, go test, cargo test, etc.), " +
      "linters, type checkers, and git commands. " +
      "Returns stdout, stderr, and exit code. Non-zero exit is not an error — " +
      "test failures are useful information.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The command to run (must match allowlist)",
        },
      },
      required: ["command"],
    },
  },

  git_diff: {
    name: "git_diff",
    description:
      "Get the git diff between the base commit and HEAD. " +
      "Useful when the PR diff from GitHub is truncated.",
    input_schema: {
      type: "object" as const,
      properties: {
        base_sha: {
          type: "string",
          description: "The base commit SHA to diff against",
        },
      },
      required: ["base_sha"],
    },
  },

  search_content: {
    name: "search_content",
    description:
      "Search file contents using ripgrep. Use this to find function definitions, " +
      "usages, imports, patterns, and string literals across the codebase. " +
      "Supports regex. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for (e.g. 'function handleAuth', 'import.*from', 'TODO|FIXME')",
        },
        glob: {
          type: "string",
          description: "Optional glob to filter files (e.g. '*.ts', '*.py', 'src/**/*.js')",
        },
        case_sensitive: {
          type: "boolean",
          description: "Whether the search is case-sensitive. Default: false",
        },
      },
      required: ["pattern"],
    },
  },

  find_files: {
    name: "find_files",
    description:
      "Find files by name pattern. Use this when you need to locate files " +
      "that may not be tracked by git (e.g. generated files, configs). " +
      "Supports shell glob patterns in the name.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "File name pattern (e.g. '*.config.ts', 'Dockerfile*', '.eslintrc*')",
        },
        type: {
          type: "string",
          enum: ["f", "d"],
          description: "Filter by type: 'f' for files, 'd' for directories. Default: files only",
        },
        max_depth: {
          type: "number",
          description: "Max directory depth to search. Default: 10",
        },
      },
      required: ["pattern"],
    },
  },
};

export async function routeToolCall(
  sandbox: DurableObjectStub<Sandbox>,
  toolName: string,
  toolInput: unknown,
): Promise<{ result: string; isError: boolean }> {
  try {
    switch (toolName) {
      case "read_file": {
        const { path } = toolInput as { path: string };
        const fullPath = path.startsWith("/") ? path : `${REPO_DIR}/${path}`;
        const content = await readFile(sandbox, fullPath);
        return { result: content, isError: false };
      }

      case "list_files": {
        const { pattern } = toolInput as { pattern?: string };
        const files = await listFiles(sandbox, pattern);
        if (files.length === 0) {
          return {
            result: pattern
              ? `No files matching pattern: ${pattern}`
              : "No tracked files found",
            isError: false,
          };
        }
        const capped = files.slice(0, 500);
        const suffix =
          files.length > 500 ? `\n... and ${files.length - 500} more files` : "";
        return { result: capped.join("\n") + suffix, isError: false };
      }

      case "run_command": {
        const { command } = toolInput as { command: string };
        const result = await runCommand(sandbox, command);
        const output = [
          `Exit code: ${result.exitCode}`,
          result.stdout ? `stdout:\n${result.stdout}` : "",
          result.stderr ? `stderr:\n${result.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return { result: output.slice(0, 30_000), isError: false };
      }

      case "git_diff": {
        const { base_sha } = toolInput as { base_sha: string };
        const diff = await gitDiff(sandbox, base_sha);
        return { result: diff.slice(0, 50_000), isError: false };
      }

      case "search_content": {
        const { pattern, glob, case_sensitive } = toolInput as {
          pattern: string;
          glob?: string;
          case_sensitive?: boolean;
        };
        const matches = await searchContent(sandbox, pattern, {
          glob,
          caseSensitive: case_sensitive,
        });
        if (!matches) {
          return { result: `No matches found for: ${pattern}`, isError: false };
        }
        return { result: matches.slice(0, 30_000), isError: false };
      }

      case "find_files": {
        const { pattern, type, max_depth } = toolInput as {
          pattern: string;
          type?: "f" | "d";
          max_depth?: number;
        };
        const files = await findFiles(sandbox, pattern, {
          type: type ?? "f",
          maxDepth: max_depth,
        });
        if (files.length === 0) {
          return { result: `No files found matching: ${pattern}`, isError: false };
        }
        const capped = files.slice(0, 500);
        const suffix = files.length > 500
          ? `\n... and ${files.length - 500} more`
          : "";
        return { result: capped.join("\n") + suffix, isError: false };
      }

      default:
        return { result: `Unknown tool: ${toolName}`, isError: true };
    }
  } catch (err) {
    const message =
      err instanceof SandboxError
        ? `${err.message}${err.stderr ? `\nstderr: ${err.stderr}` : ""}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { result: message, isError: true };
  }
}
