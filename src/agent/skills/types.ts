import type Anthropic from "@anthropic-ai/sdk";

export type SandboxToolName =
  | "read_file"
  | "list_files"
  | "run_command"
  | "git_diff"
  | "search_content"
  | "find_files"
  | "check_vulnerabilities";

export interface SkillMetadata {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly requiredTools: readonly SandboxToolName[];
  /** Glob patterns this skill cares about. Empty = all files. */
  readonly filePatterns: readonly string[];
  readonly enabledByDefault: boolean;
  /** Lower numbers appear first in the composed prompt. */
  readonly priority: number;
}

export interface Skill {
  readonly metadata: SkillMetadata;
  readonly instructions: string;
}

export interface SkillComposition {
  readonly systemPrompt: string;
  readonly tools: Anthropic.Messages.Tool[];
  readonly activeSkillNames: readonly string[];
  readonly skippedSkills: ReadonlyArray<{
    name: string;
    reason: string;
  }>;
}
