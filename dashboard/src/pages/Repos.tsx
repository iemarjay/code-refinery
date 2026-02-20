import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { RepoSettingsPanel } from "../components/RepoSettings";
import type { Repo } from "../lib/types";

export function Repos() {
  const queryClient = useQueryClient();
  const [editingRepo, setEditingRepo] = useState<Repo | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["repos"],
    queryFn: api.getRepos,
  });

  const repos = data?.repos;
  const installUrl = data?.installUrl;

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api.toggleRepo(id, enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["repos"] }),
  });

  const syncMutation = useMutation({
    mutationFn: api.syncRepos,
    onSuccess: (result) => {
      queryClient.setQueryData(["repos"], {
        repos: result.repos,
        installUrl: result.installUrl,
      });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-blue-600" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-gray-900">Repositories</h2>
        <div className="flex items-center gap-2">
          {installUrl && (
            <a
              href={installUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-gray-800"
            >
              Install on GitHub
            </a>
          )}
          <button
            type="button"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="rounded-md bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm ring-1 ring-gray-300 hover:bg-gray-50 disabled:opacity-50"
          >
            {syncMutation.isPending ? "Syncing\u2026" : "Sync repos"}
          </button>
        </div>
      </div>

      {!repos || repos.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
          <h3 className="text-lg font-medium text-gray-900">
            No repositories yet
          </h3>
          <p className="mt-2 text-gray-500">
            Install the Code Refinery GitHub App on your repositories, then sync
            to see them here.
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            {installUrl && (
              <a
                href={installUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-gray-800"
              >
                Install on GitHub
              </a>
            )}
            <button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="rounded-md bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm ring-1 ring-gray-300 hover:bg-gray-50 disabled:opacity-50"
            >
              {syncMutation.isPending ? "Syncing\u2026" : "Sync repos"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {repos.map((repo) => (
            <div
              key={repo.id}
              className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium text-gray-900">{repo.fullName}</p>
                <p className="text-sm text-gray-500">
                  {repo.enabled ? "Reviews enabled" : "Reviews disabled"}
                </p>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setEditingRepo(repo)}
                  className="text-sm text-blue-600 hover:text-blue-700"
                >
                  Settings
                </button>
                <button
                  type="button"
                  title={repo.enabled ? "Disable reviews" : "Enable reviews"}
                  onClick={() =>
                    toggleMutation.mutate({
                      id: repo.id,
                      enabled: !repo.enabled,
                    })
                  }
                  disabled={toggleMutation.isPending}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    repo.enabled ? "bg-blue-600" : "bg-gray-300"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      repo.enabled ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editingRepo && (
        <RepoSettingsPanel
          repo={editingRepo}
          onClose={() => setEditingRepo(null)}
        />
      )}
    </div>
  );
}
