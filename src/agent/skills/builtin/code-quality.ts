import type { Skill } from "../types";

export const codeQuality: Skill = {
  metadata: {
    name: "code-quality",
    label: "Code Quality",
    description:
      "Reviews code style, naming, complexity, dead code, and test coverage.",
    requiredTools: ["read_file", "list_files", "run_command", "search_content", "find_files"],
    filePatterns: [],
    enabledByDefault: true,
    priority: 40,
  },

  instructions: `## Code Quality

Check the quality and maintainability of the code in this PR.

### Warning
- **Confusing naming**: variables, functions, or types whose names don't reflect their purpose
- **High complexity**: deeply nested logic, long functions, too many parameters
- **Dead code**: unreachable branches, unused imports, commented-out blocks left behind
- **Missing tests**: new logic paths without corresponding test coverage

### Suggestion
- **Readability**: code that works but is hard to follow — suggest clearer alternatives
- **Duplication**: copy-pasted logic that should be extracted (only if 3+ occurrences)
- **Consistency**: style that deviates from the rest of the codebase

### Approach
1. Read the diff for code clarity and readability issues.
2. Use search_content to find duplicated code patterns — are there 3+ copies of similar logic?
3. Use read_file to compare style with existing code in the same module.
4. If available, use run_command to run a static linter (e.g. \`python -m ruff\`, \`go vet\`). If the command fails (tool not installed), skip and continue with manual review.
5. Use list_files to check if tests were added or updated alongside the changes.
6. Use find_files to locate linter/formatter config files (.eslintrc*, .prettierrc*, pyproject.toml, etc.) to understand the project's style conventions.

You do NOT have the ability to run tests. Focus on substantive quality issues that automated linters would not catch — structural complexity, naming clarity, missing abstractions, and test coverage gaps. Delegate linting and testing to CI/CD.

Be practical — only flag issues that meaningfully affect maintainability. Don't suggest style changes that a linter would catch.`,
};
