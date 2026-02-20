export function Settings() {
  return (
    <div>
      <h2 className="mb-6 text-xl font-semibold text-gray-900">Settings</h2>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <p className="text-gray-500">
          Organization-level settings and notification preferences will be
          available here in a future update.
        </p>
        <p className="mt-2 text-sm text-gray-400">
          Per-repo settings (strictness, ignore patterns, custom checklist) can
          be configured from the Repos page.
        </p>
      </div>
    </div>
  );
}
