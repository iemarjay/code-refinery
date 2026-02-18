import type { Skill } from "../types";

export const dataFlowAnalysis: Skill = {
  metadata: {
    name: "data-flow-analysis",
    label: "Data Flow Analysis",
    description:
      "Traces data paths end-to-end looking for validation gaps, " +
      "unnecessary transformations, N+1 queries, and state management issues.",
    requiredTools: ["read_file", "list_files", "git_diff", "search_content"],
    filePatterns: [],
    enabledByDefault: true,
    priority: 50,
  },

  instructions: `## Data Flow Analysis

Trace how data moves through the code changed in this PR.

### Critical
- **Missing validation at boundaries**: user input, API responses, or file contents used without validation
- **State corruption**: mutations that leave data in an inconsistent state on error
- **Data loss**: silent truncation, dropped fields during transformation, overwritten values

### Warning
- **N+1 queries**: database calls inside loops that should be batched
- **Unnecessary transformations**: data converted between formats without reason (serialize then immediately deserialize)
- **Hidden mutations**: functions that modify their input arguments or global state as a side effect
- **Race conditions on state**: concurrent reads/writes to shared state without coordination

### Approach
1. Pick a data path that this PR changes (e.g., request → handler → service → database → response)
2. Use search_content to trace how data flows — search for function names, type names, and field names to find all producers and consumers
3. Use read_file to trace the data through each layer — what transformations happen? Where is it validated?
4. Use list_files to find related data models, schemas, or type definitions
5. Use git_diff to see if the PR changes the shape of data flowing between modules

For each finding, describe the specific data path and where it breaks down.`,
};
