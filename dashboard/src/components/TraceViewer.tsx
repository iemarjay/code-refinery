import { useState } from "react";
import type { ReviewTrace } from "../lib/types";

interface ParsedContent {
  content?: string;
  toolInput?: string;
  toolResult?: string;
}

function parseContent(json: string): ParsedContent {
  try {
    return JSON.parse(json);
  } catch {
    return { content: json };
  }
}

function TruncatedText({
  text,
  maxLines = 10,
}: {
  text: string;
  maxLines?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const shouldTruncate = lines.length > maxLines;

  if (!shouldTruncate || expanded) {
    return (
      <div>
        <pre className="whitespace-pre-wrap text-xs text-gray-700">{text}</pre>
        {shouldTruncate && (
          <button
            onClick={() => setExpanded(false)}
            className="mt-1 text-xs text-blue-600 hover:text-blue-700"
          >
            Show less
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <pre className="whitespace-pre-wrap text-xs text-gray-700">
        {lines.slice(0, maxLines).join("\n")}
      </pre>
      <button
        onClick={() => setExpanded(true)}
        className="mt-1 text-xs text-blue-600 hover:text-blue-700"
      >
        Show {lines.length - maxLines} more lines
      </button>
    </div>
  );
}

function TraceEntry({ trace }: { trace: ReviewTrace }) {
  const [expanded, setExpanded] = useState(false);
  const parsed = parseContent(trace.contentJson);

  const isAssistant = trace.role === "assistant";
  const isToolResult = trace.toolName !== null;

  return (
    <div
      className={`border-l-2 pl-4 ${
        isAssistant ? "border-blue-300" : "border-gray-300"
      }`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span
          className={`rounded px-1.5 py-0.5 text-xs font-medium ${
            isAssistant
              ? "bg-blue-50 text-blue-700"
              : "bg-gray-100 text-gray-600"
          }`}
        >
          {trace.role}
        </span>
        {isToolResult && (
          <span className="rounded bg-purple-50 px-1.5 py-0.5 text-xs font-medium text-purple-700">
            {trace.toolName}
          </span>
        )}
        <span className="text-xs text-gray-400">Turn {trace.turnNumber}</span>
        {trace.tokensUsed != null && (
          <span className="text-xs text-gray-400">
            {trace.tokensUsed} tokens
          </span>
        )}
        <span className="ml-auto text-xs text-gray-400">
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          {parsed.content && (
            <div className="rounded bg-gray-50 p-2">
              <TruncatedText text={parsed.content} maxLines={20} />
            </div>
          )}
          {parsed.toolInput && (
            <div>
              <p className="mb-1 text-xs font-medium text-gray-500">Input:</p>
              <div className="rounded bg-yellow-50 p-2">
                <TruncatedText text={parsed.toolInput} />
              </div>
            </div>
          )}
          {parsed.toolResult && (
            <div>
              <p className="mb-1 text-xs font-medium text-gray-500">Output:</p>
              <div className="rounded bg-green-50 p-2">
                <TruncatedText text={parsed.toolResult} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TraceViewer({ traces }: { traces: ReviewTrace[] }) {
  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
      {traces.map((trace) => (
        <TraceEntry key={trace.id} trace={trace} />
      ))}
    </div>
  );
}
