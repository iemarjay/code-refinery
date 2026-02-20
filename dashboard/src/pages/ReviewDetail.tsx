import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { TraceViewer } from "../components/TraceViewer";
import type { ReviewFinding } from "../lib/types";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-100 text-red-800",
  warning: "bg-yellow-100 text-yellow-800",
  info: "bg-blue-100 text-blue-800",
  praise: "bg-green-100 text-green-800",
};

const VERDICT_BADGES: Record<string, { label: string; className: string }> = {
  approve: { label: "Approved", className: "bg-green-100 text-green-800" },
  request_changes: {
    label: "Changes Requested",
    className: "bg-red-100 text-red-800",
  },
  comment: { label: "Comment", className: "bg-blue-100 text-blue-800" },
};

function FindingCard({ finding }: { finding: ReviewFinding }) {
  const colorClass = SEVERITY_COLORS[finding.severity] || SEVERITY_COLORS.info;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${colorClass}`}
        >
          {finding.severity}
        </span>
        <span className="text-xs text-gray-500">{finding.skill}</span>
      </div>
      <h4 className="font-medium text-gray-900">{finding.title}</h4>
      <p className="mt-1 text-sm text-gray-600">
        {finding.path}
        {finding.line ? `:${finding.line}` : ""}
      </p>
      <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">
        {finding.body}
      </p>
    </div>
  );
}

export function ReviewDetail() {
  const { id } = useParams<{ id: string }>();
  const reviewId = parseInt(id || "", 10);

  const { data: review, isLoading: reviewLoading } = useQuery({
    queryKey: ["review", reviewId],
    queryFn: () => api.getReview(reviewId),
    enabled: !isNaN(reviewId),
  });

  const { data: traces, isLoading: tracesLoading } = useQuery({
    queryKey: ["review-trace", reviewId],
    queryFn: () => api.getReviewTrace(reviewId),
    enabled: !isNaN(reviewId),
  });

  if (reviewLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-blue-600" />
      </div>
    );
  }

  if (!review) {
    return <p className="text-gray-500">Review not found.</p>;
  }

  const verdictBadge = review.verdict
    ? VERDICT_BADGES[review.verdict]
    : null;

  const findings = review.findings || [];
  const groupedFindings = findings.reduce(
    (acc, f) => {
      const key = f.severity;
      if (!acc[key]) acc[key] = [];
      acc[key].push(f);
      return acc;
    },
    {} as Record<string, ReviewFinding[]>,
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-gray-900">
            {review.prTitle}
          </h2>
          {verdictBadge && (
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${verdictBadge.className}`}
            >
              {verdictBadge.label}
            </span>
          )}
          {review.status === "failed" && (
            <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800">
              Failed
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-gray-500">
          PR #{review.prNumber} by {review.prAuthor} &middot;{" "}
          {review.headRef} &rarr; {review.baseRef} &middot;{" "}
          {new Date(review.createdAt).toLocaleDateString()}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <p className="text-xs text-gray-500">Duration</p>
          <p className="text-lg font-semibold">
            {(review.durationMs / 1000).toFixed(1)}s
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <p className="text-xs text-gray-500">Input Tokens</p>
          <p className="text-lg font-semibold">
            {review.inputTokens.toLocaleString()}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <p className="text-xs text-gray-500">Output Tokens</p>
          <p className="text-lg font-semibold">
            {review.outputTokens.toLocaleString()}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <p className="text-xs text-gray-500">Findings</p>
          <p className="text-lg font-semibold">{findings.length}</p>
        </div>
      </div>

      {/* Summary */}
      {review.summary && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="mb-2 font-medium text-gray-900">Summary</h3>
          <p className="whitespace-pre-wrap text-sm text-gray-700">
            {review.summary}
          </p>
        </div>
      )}

      {/* Error message (failed reviews) */}
      {review.errorMessage && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <h3 className="mb-2 font-medium text-red-900">Error</h3>
          <p className="whitespace-pre-wrap text-sm text-red-700">
            {review.errorMessage}
          </p>
        </div>
      )}

      {/* Findings by severity */}
      {findings.length > 0 && (
        <div>
          <h3 className="mb-3 font-medium text-gray-900">Findings</h3>
          <div className="space-y-3">
            {(["critical", "warning", "info", "praise"] as const).map(
              (severity) =>
                groupedFindings[severity]?.map((finding, i) => (
                  <FindingCard key={`${severity}-${i}`} finding={finding} />
                )),
            )}
          </div>
        </div>
      )}

      {/* Agent Trace */}
      <div>
        <h3 className="mb-3 font-medium text-gray-900">Agent Trace</h3>
        {tracesLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-gray-300 border-t-blue-600" />
          </div>
        ) : traces && traces.length > 0 ? (
          <TraceViewer traces={traces} />
        ) : (
          <p className="text-sm text-gray-500">No trace data available.</p>
        )}
      </div>
    </div>
  );
}
