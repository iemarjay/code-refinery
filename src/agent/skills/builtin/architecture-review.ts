import type { Skill } from "../types";

export const architectureReview: Skill = {
  metadata: {
    name: "architecture-review",
    label: "Architecture Review",
    description:
      "Evaluates structural changes for coupling, separation of concerns, " +
      "API design, and consistency with existing project patterns.",
    requiredTools: ["read_file", "list_files", "git_diff", "search_content"],
    filePatterns: [],
    enabledByDefault: true,
    priority: 30,
  },

  instructions: `## Architecture Review

Evaluate the structural quality of this PR.

### Critical
- **Circular dependencies**: new imports that create dependency cycles
- **Broken abstraction boundaries**: reaching into internal modules, bypassing public APIs
- **Backwards incompatibility**: breaking changes to public interfaces without migration path

### Warning
- **Tight coupling**: god functions/classes, modules that know too much about each other
- **Wrong layer**: business logic in controllers, I/O in domain models, presentation in data layer
- **Inconsistent patterns**: diverging from established conventions without justification
- **Over-engineering**: unnecessary abstractions, premature generalization, config for one use case

### Approach
1. Read the diff to understand what structural changes are being made
2. Use search_content to trace imports and dependency chains — look for circular dependencies or coupling (e.g. search for 'import.*from.*moduleName')
3. Use list_files to understand the project layout and existing module structure
4. Use read_file to examine related modules and interfaces — does the new code fit the existing patterns?
5. Use git_diff to see the full scope of structural changes across the codebase

Focus on whether this PR makes the codebase easier or harder to maintain long-term. Only flag issues that matter — don't nitpick file organization unless it creates real problems.`,
};
