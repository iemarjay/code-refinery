import type { ReviewFinding, Severity } from "./types";

// ---------------------------------------------------------------------------
// Duplicate detection — the security and quality passes run independently,
// so the same bug is often reported twice (different category, nearby line).
// ---------------------------------------------------------------------------

const NEARBY_LINES = 5;
const MIN_TEXT_OVERLAP = 0.35;

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };

// Words too common in findings to say anything about which bug is meant
const STOPWORDS = new Set([
  "the", "and", "this", "that", "with", "from", "when", "which", "into", "only",
  "line", "code", "value", "values", "call", "calls", "called", "because", "before",
  "after", "while", "would", "could", "should", "there", "their", "every", "other",
  "than", "then", "does", "also", "same", "were", "been", "being", "have", "here",
]);

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().match(/[a-z_][a-z0-9_.]{3,}/g) ?? []) {
    if (!STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

function overlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

function normalizeCategory(category: string): string {
  return category.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * True when two findings describe the same issue: same file, and either the
 * same line, or nearby lines with the same category or similar wording.
 */
export function isSameIssue(
  a: Pick<ReviewFinding, "file" | "line" | "category" | "description">,
  b: Pick<ReviewFinding, "file" | "line" | "category" | "description">,
): boolean {
  if (a.file !== b.file) return false;
  if (a.line === b.line) return true;
  if (Math.abs(a.line - b.line) > NEARBY_LINES) return false;

  return (
    normalizeCategory(a.category) === normalizeCategory(b.category) ||
    overlap(a.description, b.description) >= MIN_TEXT_OVERLAP
  );
}

function better(a: ReviewFinding, b: ReviewFinding): ReviewFinding {
  const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (rank !== 0) return rank > 0 ? a : b;
  return a.confidence >= b.confidence ? a : b;
}

/**
 * Collapses duplicate findings, keeping the highest severity (then highest
 * confidence) version of each issue.
 */
export function dedupeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const kept: ReviewFinding[] = [];

  for (const finding of findings) {
    const idx = kept.findIndex((k) => isSameIssue(k, finding));
    if (idx === -1) {
      kept.push(finding);
      continue;
    }

    const winner = better(kept[idx], finding);
    const loser = winner === finding ? kept[idx] : finding;
    console.log(
      `  [dedupe] ${loser.file}:${loser.line} (${loser.pass_type}/${loser.category}) duplicates ${winner.file}:${winner.line} (${winner.pass_type}/${winner.category})`,
    );
    kept[idx] = winner;
  }

  return kept;
}
