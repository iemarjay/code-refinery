import type { Skill } from "../types";
import { securityReview } from "./security-review";
import { bugDetection } from "./bug-detection";
import { architectureReview } from "./architecture-review";
import { codeQuality } from "./code-quality";
import { dataFlowAnalysis } from "./data-flow-analysis";

export const BUILTIN_SKILLS: ReadonlyMap<string, Skill> = new Map([
  [securityReview.metadata.name, securityReview],
  [bugDetection.metadata.name, bugDetection],
  [architectureReview.metadata.name, architectureReview],
  [codeQuality.metadata.name, codeQuality],
  [dataFlowAnalysis.metadata.name, dataFlowAnalysis],
]);
