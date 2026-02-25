# Code Refinery

Automated PR review for GitHub -- two dedicated passes (security + code quality) using Claude Code CLI in full agentic mode. Designed for Pro/Max subscribers and small teams who want thorough reviews without enterprise pricing.

## Features

- **Two-pass review** -- dedicated security and code quality passes with focused prompts
- **Full agentic mode** -- Claude explores your repo freely using Read, Grep, and Glob tools for deep context
- **Constrained JSON output** -- `--json-schema` guarantees valid, structured findings (no regex parsing)
- **Multi-provider** -- Anthropic API, Claude Pro/Max, AWS Bedrock, Google Vertex AI, Azure Foundry, or any proxy
- **Auto-merge** -- optionally merge PRs that pass both review passes with zero findings
- **Trivial PR detection** -- skips docs-only, config-only, and lockfile-only PRs automatically
- **False positive filtering** -- hard regex rules eliminate common noise (lockfiles, vendored code, low-confidence findings)
- **Inline comments** -- critical and warning findings posted directly on the relevant diff lines
- **Zero runtime dependencies** -- uses `gh` CLI (pre-installed on runners) for all GitHub API calls

## Quick Start

```yaml
# .github/workflows/code-refinery.yml
name: Code Refinery
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: your-org/code-refinery@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Provider Setup

Code Refinery works with any Claude provider via environment variables. All provider configuration is handled by the `claude` CLI -- zero provider-specific code in this action.

### Anthropic API Key

The simplest setup. Create an API key at [console.anthropic.com](https://console.anthropic.com).

```yaml
- uses: your-org/code-refinery@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Claude Pro/Max (OAuth)

For subscribers on Claude Pro or Max plans. Flat monthly rate with no per-token costs -- unlimited agent turns.

1. Run `claude setup-token` locally to generate an OAuth token.
2. Store it as a repository secret.

```yaml
- uses: your-org/code-refinery@v1
  with:
    claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

### AWS Bedrock

```yaml
- uses: your-org/code-refinery@v1
  with:
    use_bedrock: true
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
    AWS_REGION: us-east-1
```

### Google Vertex AI

```yaml
- uses: your-org/code-refinery@v1
  with:
    use_vertex: true
  env:
    CLOUD_ML_REGION: us-east5
    ANTHROPIC_VERTEX_PROJECT_ID: ${{ secrets.GCP_PROJECT_ID }}
    GOOGLE_APPLICATION_CREDENTIALS: ${{ secrets.GCP_CREDENTIALS_PATH }}
```

### Azure Foundry

```yaml
- uses: your-org/code-refinery@v1
  with:
    use_foundry: true
  env:
    AZURE_ACCESS_TOKEN: ${{ secrets.AZURE_ACCESS_TOKEN }}
```

### Custom Proxy (Cloudflare AI Gateway, LiteLLM, OpenRouter)

Point `anthropic_base_url` at any API-compatible proxy.

```yaml
# Cloudflare AI Gateway
- uses: your-org/code-refinery@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    anthropic_base_url: https://gateway.ai.cloudflare.com/v1/ACCOUNT_ID/GATEWAY_ID/anthropic

# LiteLLM / OpenRouter
- uses: your-org/code-refinery@v1
  with:
    anthropic_api_key: ${{ secrets.PROXY_API_KEY }}
    anthropic_base_url: https://your-proxy.example.com
```

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `github_token` | `${{ github.token }}` | GitHub token for PR API calls |
| `anthropic_api_key` | | Anthropic API key (direct API users) |
| `claude_code_oauth_token` | | OAuth token for Claude Pro/Max subscribers |
| `model` | `sonnet` | Claude model: `sonnet` or `opus` |
| `strictness` | `normal` | Review strictness: `lenient`, `normal`, or `strict` |
| `custom_instructions` | | Extra instructions appended to both review prompts |
| `exclude_patterns` | | Glob patterns for files to skip (newline-separated) |
| `fail_on_critical` | `false` | Exit with code 1 if critical findings are found |
| `auto_merge` | `false` | Auto-merge PR if review verdict is `approve` |
| `auto_merge_method` | `squash` | Merge method: `squash`, `merge`, or `rebase` |
| `max_turns` | | Max agent turns per Claude invocation (cost control) |
| `max_budget_usd` | | Max budget in USD per Claude invocation (cost control) |
| `timeout_minutes` | `20` | Timeout in minutes per Claude invocation |
| `anthropic_base_url` | | Custom API base URL (proxies, gateways) |
| `use_bedrock` | `false` | Use AWS Bedrock as provider |
| `use_vertex` | `false` | Use Google Vertex AI as provider |
| `use_foundry` | `false` | Use Azure Foundry as provider |

## Outputs

| Output | Description |
|--------|-------------|
| `findings_count` | Total number of findings after filtering |
| `critical_count` | Number of critical findings |
| `verdict` | `approve`, `comment`, or `request_changes` |

Use outputs to gate downstream jobs:

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    outputs:
      verdict: ${{ steps.refinery.outputs.verdict }}
    steps:
      - uses: actions/checkout@v4
      - id: refinery
        uses: your-org/code-refinery@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}

  deploy:
    needs: review
    if: needs.review.outputs.verdict != 'request_changes'
    runs-on: ubuntu-latest
    steps:
      - run: echo "Deploying..."
```

## Strictness Levels

| Level | Confidence Floor | Info Findings | Category Scope |
|-------|:---:|:---:|:---:|
| `lenient` | 0.9 | No | Narrow -- only severe issues |
| `normal` | 0.8 | No | Standard |
| `strict` | 0.7 | Yes | Wide -- includes complexity, naming, test gaps |

- **Lenient** is best for high-velocity teams that only want to catch clear bugs and vulnerabilities.
- **Normal** balances thoroughness with noise reduction. Good default for most teams.
- **Strict** catches everything including code smells, naming issues, and missing test coverage. Best for critical codebases or educational use.

## Exclude Patterns

Skip files from review using newline-separated glob patterns:

```yaml
- uses: your-org/code-refinery@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    exclude_patterns: |
      **/*.generated.ts
      docs/**
      migrations/**
      **/*.snap
```

Excluded files are removed from the diff before Claude sees them. This reduces noise and saves tokens. Trivial files (docs, configs, lockfiles) are already skipped automatically.

## Auto-Merge

When enabled, Code Refinery will automatically merge PRs that receive an `approve` verdict (zero critical or warning findings after filtering).

```yaml
- uses: your-org/code-refinery@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    auto_merge: true
    auto_merge_method: squash  # or merge, rebase
```

Requirements and behavior:

- Only triggers when verdict is `approve` -- any critical or warning finding blocks the merge.
- Respects branch protection rules. If the repository requires additional status checks or reviewer approvals, the merge will fail gracefully and the action logs the reason.
- Posts a comment noting the auto-merge before executing it.
- Best used alongside `fail_on_critical: true` for a complete gate.

## How It Works

```
PR opened / synchronized
  |
  v
Fetch PR metadata + unified diff (gh CLI)
  |
  v
Trivial PR check --> skip if docs/config/lockfiles only
  |
  v
Pass 1: Security Review
  Claude in full agentic mode with security-focused system prompt.
  Explores the repo using Read, Grep, Glob tools.
  Returns structured JSON findings via --json-schema.
  |
  v
Pass 2: Code Quality Review
  Same agentic mode with code-quality system prompt.
  Separate invocation for dedicated focus.
  |
  v
Merge findings + false positive filter (hard regex rules)
  |
  v
Post inline review comments (critical + warning on diff lines)
Post summary comment (full overview with verdict)
  |
  v
Optional: auto-merge if verdict is approve
Set outputs: findings_count, critical_count, verdict
```

Each Claude invocation runs in full agentic mode (not print mode). Claude decides how many turns to take, reading files and searching the codebase to understand context before reporting findings. The `--json-schema` flag uses constrained decoding to guarantee valid JSON output -- no regex parsing.

False positive filtering applies hard rules ported from Anthropic's security review action: lockfiles, vendored code, low-confidence findings, DoS/resource exhaustion, rate limiting recommendations, and other common noise sources are automatically excluded.

## License

MIT
