// JSON Schema for Claude's --json-schema constrained decoding.
// This guarantees Claude outputs a valid ReviewOutput structure.

export const reviewSchema = {
  type: "object" as const,
  required: ["findings", "analysis_summary"],
  properties: {
    findings: {
      type: "array" as const,
      items: {
        type: "object" as const,
        required: ["file", "line", "severity", "category", "description", "confidence"],
        properties: {
          file: { type: "string" as const, description: "File path relative to repo root" },
          line: { type: "integer" as const, description: "Line number in the file" },
          severity: {
            type: "string" as const,
            enum: ["critical", "warning", "info"],
            description: "Finding severity level",
          },
          category: { type: "string" as const, description: "Finding category (e.g. sql_injection, null_error)" },
          description: { type: "string" as const, description: "Clear explanation of the issue" },
          confidence: {
            type: "number" as const,
            minimum: 0,
            maximum: 1,
            description: "Confidence score from 0.0 to 1.0",
          },
          recommendation: { type: "string" as const, description: "How to fix the issue" },
          exploit_scenario: { type: "string" as const, description: "How this could be exploited (security findings)" },
        },
        additionalProperties: false,
      },
    },
    analysis_summary: {
      type: "object" as const,
      required: ["files_reviewed", "critical_count", "warning_count", "info_count", "review_completed"],
      properties: {
        files_reviewed: { type: "integer" as const },
        critical_count: { type: "integer" as const },
        warning_count: { type: "integer" as const },
        info_count: { type: "integer" as const },
        review_completed: { type: "boolean" as const },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

// Serialized for passing to --json-schema CLI arg
export const reviewSchemaJson = JSON.stringify(reviewSchema);
