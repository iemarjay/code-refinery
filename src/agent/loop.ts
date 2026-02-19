import Anthropic from "@anthropic-ai/sdk";
import type { Sandbox } from "@cloudflare/sandbox";
import type { ReviewJob } from "../github/types";
import type { SkillComposition } from "./skills/types";
import { routeToolCall } from "./tools";

const MAX_ITERATIONS = 20;
const MAX_TOKENS = 16_384;
export const MODEL = "claude-sonnet-4-5-20250929";

export interface ReviewResult {
  verdict: "approve" | "request_changes" | "comment";
  summary: string;
  findings: ReviewFinding[];
}

export interface ReviewFinding {
  skill: string;
  severity: "critical" | "warning" | "suggestion" | "note";
  path: string;
  line: number;
  end_line?: number;
  title: string;
  body: string;
}

export interface AgentTrace {
  turns: AgentTurn[];
  totalInputTokens: number;
  totalOutputTokens: number;
  iterationCount: number;
  durationMs: number;
}

export interface AgentTurn {
  turnNumber: number;
  role: "assistant" | "user";
  content: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export async function runAgentLoop(
  job: ReviewJob,
  diff: string,
  sandbox: DurableObjectStub<Sandbox>,
  composition: SkillComposition,
  apiKey: string,
  gatewayBaseUrl?: string,
): Promise<{ review: ReviewResult; trace: AgentTrace }> {
  const startTime = Date.now();

  const client = new Anthropic({
    apiKey,
    ...(gatewayBaseUrl ? { baseURL: gatewayBaseUrl } : {}),
  });

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: buildUserMessage(job, diff) },
  ];

  const trace: AgentTrace = {
    turns: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    iterationCount: 0,
    durationMs: 0,
  };

  let iteration = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: composition.systemPrompt,
      messages,
      tools: composition.tools.length > 0 ? composition.tools : undefined,
      temperature: 0,
    });

    trace.totalInputTokens += response.usage.input_tokens;
    trace.totalOutputTokens += response.usage.output_tokens;

    trace.turns.push({
      turnNumber: trace.turns.length + 1,
      role: "assistant",
      content: serializeContentBlocks(response.content),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const review = extractReview(response.content);
      trace.iterationCount = iteration;
      trace.durationMs = Date.now() - startTime;
      return { review, trace };
    }

    if (response.stop_reason === "max_tokens") {
      messages.push({
        role: "user",
        content:
          "Your response was truncated. Please produce your final review now " +
          "inside <review> tags. Summarize any remaining analysis briefly.",
      });
      continue;
    }

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.Messages.ToolUseBlock =>
          block.type === "tool_use",
      );

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        const { result, isError } = await routeToolCall(
          sandbox,
          toolUse.name,
          toolUse.input,
        );

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
          is_error: isError,
        });

        trace.turns.push({
          turnNumber: trace.turns.length + 1,
          role: "user",
          content: result.slice(0, 2000),
          toolName: toolUse.name,
          toolInput: JSON.stringify(toolUse.input).slice(0, 1000),
          toolResult: result.slice(0, 2000),
        });
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Unexpected stop reason
    break;
  }

  // Hit max iterations — try to extract from conversation history
  trace.iterationCount = iteration;
  trace.durationMs = Date.now() - startTime;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : (msg.content as Anthropic.Messages.ContentBlock[])
              .filter(
                (b): b is Anthropic.Messages.TextBlock => b.type === "text",
              )
              .map((b) => b.text)
              .join("");
      try {
        return { review: parseReviewJson(text), trace };
      } catch {
        continue;
      }
    }
  }

  return {
    review: {
      verdict: "comment",
      summary:
        `Agent loop completed without producing a structured review. ` +
        `Ran ${iteration} iterations with skills: ${composition.activeSkillNames.join(", ")}.`,
      findings: [],
    },
    trace,
  };
}

function buildUserMessage(job: ReviewJob, diff: string): string {
  const cappedDiff =
    diff.length > 100_000
      ? diff.slice(0, 100_000) +
        "\n\n[DIFF TRUNCATED — use git_diff tool to see full diff]"
      : diff;

  return `Please review the following PR diff. Use the available tools to examine files and run checks as needed.

## PR Diff

\`\`\`diff
${cappedDiff}
\`\`\`

Analyze this PR according to all active review dimensions in your instructions. Use tools to gather context, then produce your review.`;
}

function extractReview(
  content: Anthropic.Messages.ContentBlock[],
): ReviewResult {
  const text = content
    .filter(
      (block): block is Anthropic.Messages.TextBlock => block.type === "text",
    )
    .map((block) => block.text)
    .join("");

  return parseReviewJson(text);
}

function parseReviewJson(text: string): ReviewResult {
  const reviewMatch = text.match(/<review>\s*([\s\S]*?)\s*<\/review>/);
  if (!reviewMatch) {
    throw new Error("No <review> block found in response");
  }

  let jsonStr = reviewMatch[1].trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  const parsed = JSON.parse(jsonStr);

  if (
    !parsed.verdict ||
    !["approve", "request_changes", "comment"].includes(parsed.verdict)
  ) {
    throw new Error(`Invalid verdict: ${parsed.verdict}`);
  }

  return {
    verdict: parsed.verdict,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    findings: Array.isArray(parsed.findings)
      ? parsed.findings.map(validateFinding).filter(Boolean) as ReviewFinding[]
      : [],
  };
}

function validateFinding(raw: unknown): ReviewFinding | null {
  if (typeof raw !== "object" || raw === null) return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.path !== "string" || typeof f.line !== "number") return null;
  return {
    skill: typeof f.skill === "string" ? f.skill : "unknown",
    severity:
      typeof f.severity === "string" &&
      ["critical", "warning", "suggestion", "note"].includes(f.severity)
        ? (f.severity as ReviewFinding["severity"])
        : "suggestion",
    path: f.path,
    line: f.line,
    end_line: typeof f.end_line === "number" ? f.end_line : undefined,
    title: typeof f.title === "string" ? f.title : "Finding",
    body: typeof f.body === "string" ? f.body : "",
  };
}

function serializeContentBlocks(
  content: Anthropic.Messages.ContentBlock[],
): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use")
        return `[tool_use: ${block.name}(${JSON.stringify(block.input)})]`;
      return `[${block.type}]`;
    })
    .join("\n");
}
