import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Repo, RepoSettings } from "../lib/types";

interface Props {
  repo: Repo;
  onClose: () => void;
}

export function RepoSettingsPanel({ repo, onClose }: Props) {
  const queryClient = useQueryClient();
  const settings = repo.settings || {};

  const [strictness, setStrictness] = useState<string>(
    settings.strictness || "balanced",
  );
  const [ignorePatterns, setIgnorePatterns] = useState(
    (settings.ignorePatterns || []).join("\n"),
  );
  const [customChecklist, setCustomChecklist] = useState(
    (settings.customChecklist || []).join("\n"),
  );

  const mutation = useMutation({
    mutationFn: (newSettings: RepoSettings) =>
      api.patchRepoSettings(repo.id, newSettings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repos"] });
      onClose();
    },
  });

  const handleSave = () => {
    const newSettings: RepoSettings = {
      strictness: strictness as RepoSettings["strictness"],
      ignorePatterns: ignorePatterns
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      customChecklist: customChecklist
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    mutation.mutate(newSettings);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">
            Settings: {repo.fullName}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            &times;
          </button>
        </div>

        <div className="space-y-4">
          {/* Strictness */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Review Strictness
            </label>
            <div className="flex gap-2">
              {(["lenient", "balanced", "strict"] as const).map((level) => (
                <button
                  key={level}
                  onClick={() => setStrictness(level)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize ${
                    strictness === level
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>

          {/* Ignore Patterns */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Ignore Patterns
            </label>
            <textarea
              value={ignorePatterns}
              onChange={(e) => setIgnorePatterns(e.target.value)}
              rows={4}
              placeholder="One glob pattern per line, e.g.&#10;*.lock&#10;dist/**&#10;*.min.js"
              className="w-full rounded-md border border-gray-300 p-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-0.5 text-xs text-gray-400">
              Files matching these patterns will be excluded from review.
            </p>
          </div>

          {/* Custom Checklist */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Custom Checklist
            </label>
            <textarea
              value={customChecklist}
              onChange={(e) => setCustomChecklist(e.target.value)}
              rows={4}
              placeholder="One item per line, e.g.&#10;Check for proper error handling&#10;Verify API response types"
              className="w-full rounded-md border border-gray-300 p-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-0.5 text-xs text-gray-400">
              Additional review points the agent should check for.
            </p>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-md bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm ring-1 ring-gray-300 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={mutation.isPending}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {mutation.isPending ? "Saving..." : "Save"}
          </button>
        </div>

        {mutation.isError && (
          <p className="mt-2 text-sm text-red-600">
            {mutation.error instanceof Error
              ? mutation.error.message
              : "Failed to save settings"}
          </p>
        )}
      </div>
    </div>
  );
}
