import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";

const PERIODS = [
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
];

// Rough Anthropic pricing (Sonnet 4.5) per 1M tokens
const INPUT_COST_PER_M = 3.0;
const OUTPUT_COST_PER_M = 15.0;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function Usage() {
  const [period, setPeriod] = useState(30);

  const { data: stats, isLoading } = useQuery({
    queryKey: ["usage", period],
    queryFn: () => api.getUsage(period),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-blue-600" />
      </div>
    );
  }

  const estimatedCost = stats
    ? (stats.totalInputTokens / 1_000_000) * INPUT_COST_PER_M +
      (stats.totalOutputTokens / 1_000_000) * OUTPUT_COST_PER_M
    : 0;

  const maxDayCount = stats
    ? Math.max(1, ...stats.reviewsByDay.map((d) => d.count))
    : 1;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-gray-900">Usage</h2>
        <div className="flex gap-1 rounded-lg bg-white p-1 shadow-sm ring-1 ring-gray-200">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                period === p.value
                  ? "bg-blue-600 text-white"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {stats && (
        <div className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-sm text-gray-500">Total Reviews</p>
              <p className="text-2xl font-semibold">{stats.totalReviews}</p>
              <p className="text-xs text-gray-400">
                {stats.completedReviews} completed, {stats.failedReviews}{" "}
                failed
              </p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-sm text-gray-500">Tokens Used</p>
              <p className="text-2xl font-semibold">
                {(
                  (stats.totalInputTokens + stats.totalOutputTokens) /
                  1000
                ).toFixed(1)}
                k
              </p>
              <p className="text-xs text-gray-400">
                {(stats.totalInputTokens / 1000).toFixed(1)}k in /{" "}
                {(stats.totalOutputTokens / 1000).toFixed(1)}k out
              </p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-sm text-gray-500">Avg Duration</p>
              <p className="text-2xl font-semibold">
                {formatDuration(stats.avgDurationMs)}
              </p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-sm text-gray-500">Est. Cost</p>
              <p className="text-2xl font-semibold">
                ${estimatedCost.toFixed(2)}
              </p>
              <p className="text-xs text-gray-400">Sonnet 4.5 pricing</p>
            </div>
          </div>

          {/* Reviews per day */}
          {stats.reviewsByDay.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <h3 className="mb-4 font-medium text-gray-900">
                Reviews per Day
              </h3>
              <div className="flex items-end gap-1" style={{ height: 120 }}>
                {stats.reviewsByDay.map((d) => (
                  <div
                    key={d.date}
                    className="flex-1 rounded-t bg-blue-500"
                    style={{
                      height: `${(d.count / maxDayCount) * 100}%`,
                      minHeight: d.count > 0 ? 4 : 0,
                    }}
                    title={`${d.date}: ${d.count} reviews`}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Reviews by repo */}
          {stats.reviewsByRepo.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <h3 className="mb-4 font-medium text-gray-900">
                Reviews by Repository
              </h3>
              <div className="space-y-2">
                {stats.reviewsByRepo.map((r) => (
                  <div key={r.repoName} className="flex items-center gap-3">
                    <span className="w-48 truncate text-sm text-gray-700">
                      {r.repoName}
                    </span>
                    <div className="flex-1">
                      <div
                        className="h-5 rounded bg-blue-500"
                        style={{
                          width: `${(r.count / (stats.reviewsByRepo[0]?.count || 1)) * 100}%`,
                          minWidth: 4,
                        }}
                      />
                    </div>
                    <span className="text-sm font-medium text-gray-900">
                      {r.count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
