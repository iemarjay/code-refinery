import type { Review } from "../lib/types";

const VERDICT_STYLES: Record<string, { label: string; className: string }> = {
  approve: { label: "Approved", className: "bg-green-100 text-green-800" },
  request_changes: {
    label: "Changes Requested",
    className: "bg-red-100 text-red-800",
  },
  comment: { label: "Comment", className: "bg-blue-100 text-blue-800" },
};

export function ReviewCard({ review }: { review: Review }) {
  const verdictStyle = review.verdict
    ? VERDICT_STYLES[review.verdict]
    : null;

  const findingCount = review.findings?.length ?? 0;
  const totalTokens = review.inputTokens + review.outputTokens;

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 transition-colors hover:border-gray-300">
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-medium text-gray-900">
              {review.prTitle}
            </h3>
            {verdictStyle && (
              <span
                className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${verdictStyle.className}`}
              >
                {verdictStyle.label}
              </span>
            )}
            {review.status === "failed" && (
              <span className="whitespace-nowrap rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                Failed
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-gray-500">
            PR #{review.prNumber} by {review.prAuthor} &middot;{" "}
            {review.headRef}
          </p>
        </div>
        <div className="ml-4 text-right text-xs text-gray-400">
          <p>{new Date(review.createdAt).toLocaleDateString()}</p>
          <p>
            {(review.durationMs / 1000).toFixed(1)}s &middot;{" "}
            {(totalTokens / 1000).toFixed(1)}k tokens
          </p>
          {findingCount > 0 && (
            <p>
              {findingCount} finding{findingCount !== 1 ? "s" : ""}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
