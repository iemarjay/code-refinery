import type { ActionConfig } from "./types";

function getInput(name: string, fallback = ""): string {
  return process.env[`INPUT_${name.toUpperCase()}`] ?? fallback;
}

function readConfig(): ActionConfig {
  return {
    repo: process.env.GITHUB_REPOSITORY ?? "",
    prNumber: Number(process.env.PR_NUMBER ?? process.env.GITHUB_REF_NAME?.match(/^(\d+)\//)?.[1] ?? "0"),
    model: getInput("model", "sonnet"),
    strictness: getInput("strictness", "normal"),
    customInstructions: getInput("custom_instructions"),
    excludePatterns: getInput("exclude_patterns")
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean),
    failOnCritical: getInput("fail_on_critical") === "true",
    autoMerge: getInput("auto_merge") === "true",
    autoMergeMethod: getInput("auto_merge_method", "squash"),
    maxTurns: getInput("max_turns") ? Number(getInput("max_turns")) : undefined,
    maxBudgetUsd: getInput("max_budget_usd") ? Number(getInput("max_budget_usd")) : undefined,
    timeoutMinutes: Number(getInput("timeout_minutes", "20")),
  };
}

function main(): void {
  const config = readConfig();

  console.log("Code Refinery — PR Review");
  console.log(`  repo:       ${config.repo}`);
  console.log(`  pr:         #${config.prNumber}`);
  console.log(`  model:      ${config.model}`);
  console.log(`  strictness: ${config.strictness}`);

  if (config.excludePatterns.length > 0) {
    console.log(`  exclude:    ${config.excludePatterns.join(", ")}`);
  }

  // Phase 1 stub — review not yet implemented
  console.log("\nPhase 1 stub — review not yet implemented.");
}

main();
