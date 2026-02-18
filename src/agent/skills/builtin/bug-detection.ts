import type { Skill } from "../types";

export const bugDetection: Skill = {
  metadata: {
    name: "bug-detection",
    label: "Bug Detection",
    description:
      "Identifies potential bugs including null/undefined errors, off-by-one errors, " +
      "race conditions, resource leaks, and logic errors.",
    requiredTools: ["read_file", "list_files", "run_command", "search_content"],
    filePatterns: [],
    enabledByDefault: true,
    priority: 20,
  },

  instructions: `## Bug Detection

Check this PR for potential bugs.

### Critical
- **Null/undefined dereference**: accessing properties on potentially null values without checks
- **Type mismatches**: incorrect type assumptions, unsafe casts, wrong function signatures
- **Resource leaks**: unclosed file handles, database connections, event listeners, timers
- **Race conditions**: shared mutable state without synchronization, async ordering issues

### Warning
- **Off-by-one errors**: array bounds, loop conditions, pagination, fence-post problems
- **Logic errors**: inverted conditions, missing break/return, unreachable code, wrong operator
- **Error handling gaps**: unhandled promise rejections, empty catch blocks, swallowed errors
- **Edge cases**: empty collections, zero/negative values, very large inputs, Unicode

### Approach
1. Read the diff to identify changed logic paths
2. Use search_content to find all callers/usages of changed functions — do they handle the new behavior correctly?
3. Use read_file to see the full function/class context — not just the diff hunks
4. Use list_files to find related tests — does the test suite cover the new code paths?
5. Use run_command to run the project's type checker or test suite if available
6. Look for patterns that commonly cause bugs in the language/framework being used

For each finding, explain the exact scenario that triggers the bug and suggest a fix.`,
};
