import type { ReviewFinding } from "./types";

// --- Regex pattern groups (ported from Anthropic's findings_filter.py) ---

const DOS: RegExp[] = [
  /\b(denial of service|dos attack|resource exhaustion)\b/i,
  /\b(exhaust|overwhelm|overload).*?(resource|memory|cpu)\b/i,
  /\b(infinite|unbounded).*?(loop|recursion)\b/i,
];

const RATE_LIMITING: RegExp[] = [
  /\b(missing|lack of|no)\s+rate\s+limit/i,
  /\brate\s+limiting\s+(missing|required|not implemented)/i,
  /\b(implement|add)\s+rate\s+limit/i,
  /\bunlimited\s+(requests|calls|api)/i,
];

const RESOURCE_LEAK: RegExp[] = [
  /\b(resource|memory|file)\s+leak\s+potential/i,
  /\bunclosed\s+(resource|file|connection)/i,
  /\b(close|cleanup|release)\s+(resource|file|connection)/i,
  /\bpotential\s+memory\s+leak/i,
  /\b(database|thread|socket|connection)\s+leak/i,
];

const OPEN_REDIRECT: RegExp[] = [
  /\b(open redirect|unvalidated redirect)\b/i,
  /\bredirect.(attack|exploit|vulnerability)/i,
  /\bmalicious.redirect/i,
];

const REGEX_INJECTION: RegExp[] = [
  /\b(regex|regular expression)\s+injection\b/i,
  /\b(regex|regular expression)\s+denial of service\b/i,
  /\b(regex|regular expression)\s+flooding\b/i,
];

const MEMORY_SAFETY: RegExp[] = [
  /\b(buffer overflow|stack overflow|heap overflow)\b/i,
  /\b(oob)\s+(read|write|access)\b/i,
  /\bout.?of.?bounds?\b/i,
  /\b(memory safety|memory corruption)\b/i,
  /\b(use.?after.?free|double.?free|null.?pointer.?dereference)\b/i,
  /\b(segmentation fault|segfault|memory violation)\b/i,
  /\b(bounds check|boundary check|array bounds)\b/i,
  /\b(integer overflow|integer underflow|integer conversion)\b/i,
  /\barbitrary.?(memory read|pointer dereference|memory address|memory pointer)\b/i,
];

const SSRF: RegExp[] = [
  /\b(ssrf|server\s*.?side\s*.?request\s*.?forgery)\b/i,
];

// --- Helpers ---

const C_CPP_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".h"]);

const LOCKFILE_NAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "gemfile.lock", "poetry.lock", "cargo.lock",
  "composer.lock", "go.sum",
]);

const GENERATED_PATTERNS = [
  /^dist\//,
  /^build\//,
  /^vendor\//,
  /\.min\.js$/,
  /\.d\.ts$/,
];

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

function baseOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return (slash === -1 ? path : path.slice(slash + 1)).toLowerCase();
}

function anyMatch(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

// --- Filter rules ---

interface FilterRule {
  name: string;
  exclude: (f: ReviewFinding) => boolean;
}

const rules: FilterRule[] = [
  {
    name: "Markdown file",
    exclude: (f) => f.file.toLowerCase().endsWith(".md"),
  },
  {
    name: "Lockfile or generated file",
    exclude: (f) => {
      const base = baseOf(f.file);
      const lower = f.file.toLowerCase();
      return LOCKFILE_NAMES.has(base) || GENERATED_PATTERNS.some((p) => p.test(lower));
    },
  },
  {
    name: "Low confidence (<0.7)",
    exclude: (f) => f.confidence < 0.7,
  },
  {
    name: "DoS / resource exhaustion",
    exclude: (f) => anyMatch(DOS, `${f.category} ${f.description}`),
  },
  {
    name: "Rate limiting recommendation",
    exclude: (f) => anyMatch(RATE_LIMITING, `${f.category} ${f.description}`),
  },
  {
    name: "Resource leak",
    exclude: (f) => anyMatch(RESOURCE_LEAK, `${f.category} ${f.description}`),
  },
  {
    name: "Open redirect",
    exclude: (f) => anyMatch(OPEN_REDIRECT, `${f.category} ${f.description}`),
  },
  {
    name: "Regex injection",
    exclude: (f) => anyMatch(REGEX_INJECTION, `${f.category} ${f.description}`),
  },
  {
    name: "Memory safety in non-C/C++",
    exclude: (f) =>
      !C_CPP_EXTENSIONS.has(extOf(f.file)) &&
      anyMatch(MEMORY_SAFETY, `${f.category} ${f.description}`),
  },
  {
    name: "SSRF in HTML",
    exclude: (f) =>
      extOf(f.file) === ".html" &&
      anyMatch(SSRF, `${f.category} ${f.description}`),
  },
];

// --- Public API ---

export function filterFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const kept: ReviewFinding[] = [];
  let excluded = 0;

  for (const finding of findings) {
    const matched = rules.find((r) => r.exclude(finding));
    if (matched) {
      excluded++;
      console.log(`  [filter] excluded: "${matched.name}" — ${finding.file}:${finding.line} (${finding.category})`);
    } else {
      kept.push(finding);
    }
  }

  if (excluded > 0) {
    console.log(`  [filter] ${excluded} finding(s) excluded, ${kept.length} kept`);
  }

  return kept;
}
