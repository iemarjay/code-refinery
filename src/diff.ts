// ---------------------------------------------------------------------------
// Diff line mapping — which head-side lines GitHub accepts inline comments on
// ---------------------------------------------------------------------------

// How far a finding's line may be moved to reach a commentable line.
// Beyond this, the comment would land on unrelated code, so it goes in the
// review body instead.
const MAX_SNAP_DISTANCE = 10;

/**
 * Returns the RIGHT-side line numbers present in a unified diff patch
 * (added lines + context lines). GitHub rejects review comments (HTTP 422)
 * on any other line.
 */
export function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;

  let right = 0;
  let inHunk = false;

  for (const raw of patch.split("\n")) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      right = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (raw.startsWith("+") || raw.startsWith(" ")) {
      lines.add(right);
      right++;
    }
    // "-" lines exist only on the LEFT side; "\ No newline" is metadata
  }

  return lines;
}

/**
 * Maps a finding's line to the nearest commentable line within
 * MAX_SNAP_DISTANCE. Returns null when nothing is close enough.
 */
export function snapToDiff(line: number, commentable: Set<number>): number | null {
  if (commentable.has(line)) return line;

  for (let d = 1; d <= MAX_SNAP_DISTANCE; d++) {
    if (commentable.has(line - d)) return line - d;
    if (commentable.has(line + d)) return line + d;
  }

  return null;
}
