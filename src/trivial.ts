import type { PRFile } from "./types";

const TRIVIAL_EXTENSIONS = new Set([
  // Documentation
  ".md", ".rst", ".txt", ".adoc", ".doc", ".docx",
  // Assets
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot",
]);

const TRIVIAL_EXACT_NAMES = new Set([
  // Lockfiles
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "gemfile.lock", "poetry.lock", "cargo.lock",
  "composer.lock", "go.sum",
  // Misc config
  ".editorconfig", ".gitignore", ".gitattributes",
  ".browserslistrc", "tsconfig.json",
]);

const TRIVIAL_CONFIG_EXTENSIONS = new Set([
  ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
]);

const TRIVIAL_PATH_PREFIXES = [
  ".github/",
  ".circleci/",
];

const TRIVIAL_BASENAME_PREFIXES = [
  "license", "licence", "notice", "patents",
  ".prettierrc", ".eslintrc", ".gitlab-ci",
];

const MAX_TRIVIAL_LINES = 500;

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

function baseOf(filename: string): string {
  const slash = filename.lastIndexOf("/");
  return (slash === -1 ? filename : filename.slice(slash + 1)).toLowerCase();
}

export function isTrivialFile(filename: string): boolean {
  const ext = extOf(filename);
  const base = baseOf(filename);
  const lower = filename.toLowerCase();

  if (TRIVIAL_EXTENSIONS.has(ext)) return true;
  if (TRIVIAL_EXACT_NAMES.has(base)) return true;
  if (TRIVIAL_CONFIG_EXTENSIONS.has(ext)) return true;
  if (TRIVIAL_PATH_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (TRIVIAL_BASENAME_PREFIXES.some((p) => base.startsWith(p))) return true;

  return false;
}

export function isTrivialPR(files: PRFile[]): boolean {
  if (files.length === 0) return true;

  let totalLines = 0;
  for (const f of files) {
    if (!isTrivialFile(f.filename)) {
      console.log(`  non-trivial file: ${f.filename}`);
      return false;
    }
    totalLines += f.additions + f.deletions;
  }

  if (totalLines > MAX_TRIVIAL_LINES) {
    console.log(`  trivial file types but too many changed lines (${totalLines} > ${MAX_TRIVIAL_LINES})`);
    return false;
  }

  console.log(`  all ${files.length} files trivial, ${totalLines} lines changed`);
  return true;
}
