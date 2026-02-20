import type Anthropic from "@anthropic-ai/sdk";
import type { Skill, SkillComposition, SandboxToolName } from "./types";
import type { ReviewJob } from "../../github/types";
import { BUILTIN_SKILLS } from "./builtin/index";
import { TOOL_DEFINITIONS } from "../tools";

export function composeSkills(
  changedFiles: string[],
  job: ReviewJob,
): SkillComposition {
  const allSkills = [...BUILTIN_SKILLS.values()];

  const skippedSkills: Array<{ name: string; reason: string }> = [];
  const activeSkills: Skill[] = [];

  for (const skill of allSkills) {
    const { name, enabledByDefault, filePatterns } = skill.metadata;

    if (!enabledByDefault) {
      skippedSkills.push({ name, reason: "not enabled" });
      continue;
    }

    if (filePatterns.length > 0 && changedFiles.length > 0) {
      const matches = changedFiles.some((file) =>
        filePatterns.some((pattern) => matchGlob(file, pattern)),
      );
      if (!matches) {
        skippedSkills.push({ name, reason: "no matching files in diff" });
        continue;
      }
    }

    activeSkills.push(skill);
  }

  activeSkills.sort((a, b) => a.metadata.priority - b.metadata.priority);

  const systemPrompt = buildSystemPrompt(activeSkills, job);

  const neededTools = new Set<SandboxToolName>();
  for (const skill of activeSkills) {
    for (const tool of skill.metadata.requiredTools) {
      neededTools.add(tool);
    }
  }

  const tools = [...neededTools]
    .map((name) => TOOL_DEFINITIONS[name])
    .filter((t): t is Anthropic.Messages.Tool => t !== undefined);

  return {
    systemPrompt,
    tools,
    activeSkillNames: activeSkills.map((s) => s.metadata.name),
    skippedSkills,
  };
}

function buildSystemPrompt(skills: Skill[], job: ReviewJob): string {
  const preamble = `You are Code Refinery, an expert code review agent. You are reviewing PR #${job.prNumber}: "${job.prTitle}" in ${job.repoFullName}.

Your task is to analyze the PR diff and provide a thorough review using static analysis. You have access to the full repository in a sandbox and can read files, search content, list files, view diffs, and check for known vulnerabilities. You cannot run tests — delegate that to CI/CD.

## Review Strategy
1. Start by reading the changed files shown in the diff. This is your primary input.
2. If a changed file imports or calls code you need to understand, read that specific dependency. Do NOT read files speculatively.
3. Use \`search_content\` only when you need to find callers/usages of a changed function or to verify a pattern across the codebase. Do not use it for general exploration.
4. Once you have enough context to assess all active review dimensions, produce your review immediately. Do NOT keep reading more files.
5. Prefer fewer, high-quality findings over exhaustive exploration. A focused review with 2-3 real findings is better than reading 20 files and running out of iterations.

## General Guidelines
- Focus on substantive issues, not style nitpicks unless a code-quality skill is active.
- Every finding must reference a specific file path and line number from the diff.
- Quote the relevant code in your findings.
- Distinguish between critical issues (must fix), warnings (should fix), and suggestions (nice to have).

## Tool Behavior
- \`search_content\` and \`list_files\` automatically respect the project's .gitignore — no need to manually exclude directories.
- Only review authored source code. Do not read or analyze generated files, lock files (package-lock.json, yarn.lock, pnpm-lock.yaml, Cargo.lock, go.sum, Gemfile.lock, composer.lock), vendored dependencies, or build artifacts — even if they appear in the diff.
- Batch tool calls when possible — request multiple files in a single turn instead of one at a time.

## PR Context
- **Title:** ${job.prTitle}
- **Branch:** ${job.headRef} -> ${job.baseRef}
- **Head SHA:** ${job.headSha}
- **Base SHA:** ${job.baseSha}
${job.prBody ? `- **Description:** ${job.prBody.slice(0, 2000)}` : ""}

## Active Review Dimensions

`;

  const skillSections = skills.map((skill) => skill.instructions);

  const outputFormat = `

## Output Format

After your analysis, produce your review inside <review> tags as JSON:

\`\`\`
<review>
{
  "verdict": "approve" | "request_changes" | "comment",
  "summary": "Brief overall assessment (2-3 sentences)",
  "findings": [
    {
      "skill": "skill-name",
      "severity": "critical" | "warning" | "suggestion" | "note",
      "path": "src/file.ts",
      "line": 42,
      "end_line": 45,
      "title": "Short finding title",
      "body": "Detailed explanation with quoted code"
    }
  ]
}
</review>
\`\`\`

Rules:
- "verdict" is "request_changes" if ANY finding has severity "critical"
- "verdict" is "comment" if findings exist but none are critical
- "verdict" is "approve" if no findings or only "note" severity
- Every finding MUST have path and line
- The "skill" field identifies which review dimension produced the finding
- Think step by step before producing the review. Show your reasoning.
`;

  return preamble + skillSections.join("\n\n---\n\n") + outputFormat;
}

function matchGlob(filePath: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`(^|/)${regexStr}$`).test(filePath);
}

export function extractChangedFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      files.push(line.slice(6));
    }
  }
  return [...new Set(files)];
}
