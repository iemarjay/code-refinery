import type { Skill } from "../types";

export const securityReview: Skill = {
  metadata: {
    name: "security-review",
    label: "Security Review",
    description:
      "Analyzes code changes for security vulnerabilities including injection, " +
      "auth bypass, secrets exposure, path traversal, and SSRF.",
    requiredTools: ["read_file", "list_files", "run_command", "git_diff", "search_content", "find_files", "check_vulnerabilities"],
    filePatterns: [],
    enabledByDefault: true,
    priority: 10,
  },

  instructions: `## Security Review

Check this PR for security vulnerabilities using static analysis and dependency scanning.

### Critical (must block merge)
- **Injection flaws**: SQL, NoSQL, command injection, XSS, template injection. Trace user input from entry point to where it reaches a dangerous sink (database query, shell exec, innerHTML, eval).
- **Auth/authz bypass**: missing auth checks on new endpoints, privilege escalation, IDOR. Verify every new route/handler has appropriate middleware.
- **Secrets exposure**: hardcoded credentials, API keys, private keys, tokens in code or logs. Search for common patterns: password, secret, token, api_key, private_key, AWS_ACCESS_KEY.
- **Path traversal**: unsanitized file paths, symlink following, directory escape. Check that user-supplied paths are validated/normalized before use.
- **SSRF**: unvalidated URLs in server-side requests. Verify URL allowlisting or domain validation on any fetch/http call with user-controlled URLs.

### Warning (should fix before merge)
- **Insecure defaults**: permissive CORS, disabled CSRF, weak crypto algorithms (MD5, SHA1 for security purposes)
- **Missing input validation**: unbounded inputs, missing type/range checks at system boundaries (API handlers, form processors, CLI argument parsing)
- **Dependency vulnerabilities**: known-vulnerable packages, unpinned versions
- **Information leakage**: stack traces in responses, verbose error messages exposing internals, debug flags left enabled

### Approach
1. Read the diff to identify security-relevant changes (new endpoints, auth logic, user input handling, file I/O, external requests).
2. For each security-sensitive change, use read_file to examine the full function/module context — not just the diff hunks.
3. Use search_content to perform static taint analysis: trace data from user-controlled sources (request params, headers, body, query strings, form data, file uploads) to dangerous sinks (SQL queries, shell commands, file system operations, HTTP requests, template rendering, eval/exec).
4. Use search_content to find security anti-patterns across the codebase (e.g. 'eval\\(', 'exec\\(', 'innerHTML', 'dangerouslySetInnerHTML', raw SQL strings, password/secret/token literals).
5. Use find_files to locate security-relevant config files (.env.example, auth middleware, CORS config, CSP headers, Dockerfile, CI workflows).
6. If the PR modifies dependency files (package.json, go.mod, requirements.txt, Cargo.toml, Gemfile), read them to extract package names and versions, then use check_vulnerabilities to scan for known CVEs.
7. If available, use run_command with \`npm audit\` (or equivalent audit tool for the ecosystem) to check for dependency vulnerabilities.

You do NOT have the ability to run tests or execute project code. Focus entirely on static analysis and dependency scanning. Delegate test execution to CI/CD.

For each finding, specify the exact file path and line number. Quote the problematic code and explain the attack vector.`,
};
