/** Worker-side vulnerability lookup via OSV.dev API. */

const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const MAX_PACKAGES = 50;

export type VulnEcosystem =
  | "npm"
  | "PyPI"
  | "Go"
  | "crates.io"
  | "RubyGems"
  | "Maven";

export interface VulnQuery {
  ecosystem: VulnEcosystem;
  packages: Array<{ name: string; version: string }>;
}

export interface VulnFinding {
  id: string;
  summary: string;
  severity: string;
  fixed: string;
}

export interface VulnResult {
  package: string;
  version: string;
  vulnerabilities: VulnFinding[];
}

interface OSVBatchResponse {
  results: Array<{
    vulns?: Array<{
      id: string;
      summary?: string;
      severity?: Array<{ type: string; score: string }>;
      affected?: Array<{
        ranges?: Array<{
          events?: Array<{ fixed?: string }>;
        }>;
      }>;
    }>;
  }>;
}

export async function queryOSV(query: VulnQuery): Promise<VulnResult[]> {
  const packages = query.packages.slice(0, MAX_PACKAGES);
  if (packages.length === 0) return [];

  const body = {
    queries: packages.map((pkg) => ({
      version: pkg.version,
      package: { name: pkg.name, ecosystem: query.ecosystem },
    })),
  };

  const response = await fetch(OSV_BATCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`OSV API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as OSVBatchResponse;

  const results: VulnResult[] = [];

  for (let i = 0; i < packages.length; i++) {
    const vulns = data.results[i]?.vulns;
    if (!vulns || vulns.length === 0) continue;

    results.push({
      package: packages[i].name,
      version: packages[i].version,
      vulnerabilities: vulns.map((v) => ({
        id: v.id,
        summary: v.summary ?? "No summary available",
        severity: extractSeverity(v.severity),
        fixed: extractFixedVersion(v.affected),
      })),
    });
  }

  return results;
}

function extractSeverity(
  severity?: Array<{ type: string; score: string }>,
): string {
  if (!severity || severity.length === 0) return "UNKNOWN";

  const cvss = severity.find((s) => s.type === "CVSS_V3");
  if (cvss) {
    const score = parseFloat(cvss.score);
    if (score >= 9.0) return "CRITICAL";
    if (score >= 7.0) return "HIGH";
    if (score >= 4.0) return "MODERATE";
    return "LOW";
  }

  return severity[0].score || "UNKNOWN";
}

function extractFixedVersion(
  affected?: Array<{
    ranges?: Array<{
      events?: Array<{ fixed?: string }>;
    }>;
  }>,
): string {
  if (!affected) return "unknown";

  for (const a of affected) {
    for (const range of a.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) return event.fixed;
      }
    }
  }

  return "unknown";
}
