import type { Skill } from "../types";

export const securityReview: Skill = {
  metadata: {
    name: "security-review",
    label: "Security Review",
    description:
      "Analyzes code changes for security vulnerabilities including injection, " +
      "auth bypass, secrets exposure, path traversal, and SSRF.",
    requiredTools: ["read_file", "list_files", "run_command", "git_diff", "search_content"],
    filePatterns: [],
    enabledByDefault: true,
    priority: 10,
  },

  instructions: `## Security Review

Check this PR for security vulnerabilities.

### Critical (must block merge)
- **Injection flaws**: SQL, NoSQL, command injection, XSS, template injection
- **Auth/authz bypass**: missing auth checks on new endpoints, privilege escalation, IDOR
- **Secrets exposure**: hardcoded credentials, API keys, private keys, tokens in code or logs
- **Path traversal**: unsanitized file paths, symlink following, directory escape
- **SSRF**: unvalidated URLs in server-side requests

### Warning (should fix before merge)
- **Insecure defaults**: permissive CORS, disabled CSRF, weak crypto algorithms
- **Missing input validation**: unbounded inputs, missing type/range checks at system boundaries
- **Dependency risks**: known-vulnerable packages, unpinned versions
- **Information leakage**: stack traces in responses, verbose error messages exposing internals

### Approach
1. Read the diff to identify security-relevant changes (new endpoints, auth logic, user input handling, file I/O, external requests)
2. Use search_content to find related security patterns across the codebase (e.g. search for 'eval\\(', 'exec\\(', 'innerHTML', password/secret/token patterns, SQL query construction)
3. Use read_file to examine the full context around security-sensitive code
4. Use list_files to check for related security configurations (auth modules, middleware, .env.example)
5. If security-related tests exist, use run_command to run them

For each finding, specify the exact file path and line number. Quote the problematic code.`,
};
