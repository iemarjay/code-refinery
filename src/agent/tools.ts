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
import { queryOSV, type VulnEcosystem } from "./vuln";
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
      "test failures are useful information. " +
      "Use the 'cwd' parameter to run in a subdirectory (e.g. 'apps/api'). " +
      "Do NOT use 'cd' — it is not allowed.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The command to run (must match allowlist)",
        },
        cwd: {
          type: "string",
          description:
            "Subdirectory to run in, relative to repo root (e.g. 'apps/api'). " +
            "Omit to run from the repo root.",
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
      "Search file contents using git grep. Use this to find function definitions, " +
      "usages, imports, patterns, and string literals across tracked files. " +
      "Supports regex. Returns matching lines with file paths and line numbers. " +
      "Automatically respects .gitignore.",
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

  check_vulnerabilities: {
    name: "check_vulnerabilities",
    description:
      "Check packages for known security vulnerabilities using the OSV.dev database. " +
      "Read the project's dependency file (package.json, go.mod, requirements.txt, Cargo.toml, Gemfile) " +
      "to extract package names and versions, then pass them here. Max 50 packages per call.",
    input_schema: {
      type: "object" as const,
      properties: {
        ecosystem: {
          type: "string",
          enum: ["npm", "PyPI", "Go", "crates.io", "RubyGems", "Maven"],
          description: "The package ecosystem to query",
        },
        packages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Package name" },
              version: { type: "string", description: "Package version (e.g. '4.17.21')" },
            },
            required: ["name", "version"],
          },
          description: "List of packages to check (max 50)",
        },
      },
      required: ["ecosystem", "packages"],
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
        const { command, cwd } = toolInput as { command: string; cwd?: string };
        const result = await runCommand(sandbox, command, cwd);
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

      case "check_vulnerabilities": {
        const { ecosystem, packages } = toolInput as {
          ecosystem: VulnEcosystem;
          packages: Array<{ name: string; version: string }>;
        };
        const results = await queryOSV({ ecosystem, packages });
        if (results.length === 0) {
          return {
            result: `No known vulnerabilities found for ${packages.length} ${ecosystem} packages.`,
            isError: false,
          };
        }
        const formatted = results
          .map((r) => {
            const vulns = r.vulnerabilities
              .map((v) => `  - ${v.id} [${v.severity}]: ${v.summary} (fixed in ${v.fixed})`)
              .join("\n");
            return `${r.package}@${r.version}:\n${vulns}`;
          })
          .join("\n\n");
        return { result: formatted.slice(0, 30_000), isError: false };
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
