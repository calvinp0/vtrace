import { createHash } from "node:crypto";

import { editedFilesFromPatch } from "../capsule/finalEditDiagnostics";
import type { RuleOutSufficiencyCheck } from "./ruleoutSufficiency";

export const RULEOUT_CORRECTIVE_ARTIFACT_FILES = {
  response: "_ruleout_sufficiency_corrective_response.txt",
  revisedPatch: "_ruleout_sufficiency_revised.patch",
  result: "_ruleout_sufficiency_corrective_result.json",
} as const;

const FORBIDDEN_CORRECTIVE_CUES: readonly RegExp[] = [
  /\bFAIL_TO_PASS\b/i,
  /\bPASS_TO_PASS\b/i,
  /\bgold patch\b/i,
  /\bhidden tests?\b/i,
  /\bresolved status\b/i,
  /\bresolved\s*=\s*true\b/i,
  /\bbenchmark expected(?: output)?\b/i,
  /\bexpected benchmark (?:output|results?)\b/i,
  /\btest_unparse\s*\[\(\)-\(\)\]/i,
];

export interface RuleOutCorrectiveDecisionInput {
  enabled: boolean;
  checker: RuleOutSufficiencyCheck | null;
  checkerArtifactText: string;
  correctivePrompt: string;
  firstPassPatch: string;
}

export interface RuleOutCorrectiveDecision {
  run: boolean;
  reason: string;
  correctivePromptSafe: boolean;
  forbiddenLeakageDetected: boolean;
}

export interface RuleOutCorrectiveResult {
  enabled: boolean;
  checkerTriggered: boolean;
  correctivePromptWritten: boolean;
  correctivePromptSafe: boolean;
  correctiveModelCallExecuted: boolean;
  revisedPatchProduced: boolean;
  revisedPatchPath?: string;
  revisedPatchChangedFiles?: string[];
  revisedPatchEditsRuledOutImplementation?: boolean;
  canonicalReplaced: false;
  adoptionEligible: false;
  oracleFree: true;
  forbiddenLeakageDetected: boolean;
  decisionReason: string;
  correctiveResponsePath?: string;
  firstPassPatchSha?: string;
  revisedPatchSha?: string;
  canonicalResultsFileShaBefore?: string;
  canonicalResultsFileShaAfter?: string;
  canonicalPatchUnchanged: boolean;
}

export function hasRuleOutCorrectiveForbiddenLeakage(text: string): boolean {
  return FORBIDDEN_CORRECTIVE_CUES.some((cue) => cue.test(text));
}

export function decideRuleOutCorrectivePass(
  input: RuleOutCorrectiveDecisionInput,
): RuleOutCorrectiveDecision {
  if (!input.enabled) {
    return {
      run: false,
      reason: "corrective-pass flag off",
      correctivePromptSafe: false,
      forbiddenLeakageDetected: false,
    };
  }
  if (input.checker === null) {
    return {
      run: false,
      reason: "checker artifact unavailable",
      correctivePromptSafe: false,
      forbiddenLeakageDetected: false,
    };
  }
  if (!input.checker.enabled) {
    return {
      run: false,
      reason: "rule-out sufficiency checker inactive",
      correctivePromptSafe: false,
      forbiddenLeakageDetected: false,
    };
  }
  if (!input.checker.triggered) {
    return {
      run: false,
      reason: "rule-out sufficiency checker did not trigger",
      correctivePromptSafe: false,
      forbiddenLeakageDetected: false,
    };
  }
  if (
    input.checker.correctivePromptWritten !== true
    || input.correctivePrompt.trim().length === 0
  ) {
    return {
      run: false,
      reason: "safe corrective prompt artifact missing",
      correctivePromptSafe: false,
      forbiddenLeakageDetected: false,
    };
  }
  const forbiddenLeakageDetected =
    hasRuleOutCorrectiveForbiddenLeakage(input.checkerArtifactText)
    || hasRuleOutCorrectiveForbiddenLeakage(input.correctivePrompt);
  if (forbiddenLeakageDetected) {
    return {
      run: false,
      reason: "forbidden leakage detected in checker or prompt artifact",
      correctivePromptSafe: false,
      forbiddenLeakageDetected: true,
    };
  }
  if (!input.firstPassPatch.includes("diff --git")) {
    return {
      run: false,
      reason: "first-pass model patch missing or invalid",
      correctivePromptSafe: true,
      forbiddenLeakageDetected: false,
    };
  }
  return {
    run: true,
    reason: "checker triggered with safe prompt and first-pass patch",
    correctivePromptSafe: true,
    forbiddenLeakageDetected: false,
  };
}

export function buildRuleOutCorrectiveSecondPassPrompt(input: {
  correctivePrompt: string;
  firstPassPatch: string;
}): string {
  const prompt = [
    "Produce a revised patch candidate for the repository task.",
    "",
    "Use only repository-visible source and behavior evidence. Do not rely on evaluator-only test names, benchmark labels, or grading outcomes.",
    "",
    "The candidate is additive experimental output. Preserve correct first-pass changes, make the smallest justified revision, and return a complete final patch.",
    "",
    "## Corrective finding",
    "",
    input.correctivePrompt.trim(),
    "",
    "## First-pass patch",
    "",
    "```diff",
    input.firstPassPatch.trim(),
    "```",
  ].join("\n");
  if (hasRuleOutCorrectiveForbiddenLeakage(prompt)) {
    throw new Error("rule-out corrective second-pass prompt contains forbidden leakage");
  }
  return prompt;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function targetPath(target: string | undefined): string | null {
  if (target === undefined) return null;
  return target.split("::", 1)[0] ?? null;
}

export function buildRuleOutCorrectiveResult(input: {
  enabled: boolean;
  checker: RuleOutSufficiencyCheck | null;
  decision: RuleOutCorrectiveDecision;
  modelCallExecuted: boolean;
  revisedPatch: string | null;
  revisedPatchPath?: string;
  correctiveResponsePath?: string;
  firstPassPatch: string;
  canonicalResultsFileShaBefore?: string;
  canonicalResultsFileShaAfter?: string;
  responseLeakageDetected?: boolean;
}): RuleOutCorrectiveResult {
  const revisedPatchProduced =
    input.revisedPatch !== null && input.revisedPatch.includes("diff --git");
  const revisedPatchChangedFiles = revisedPatchProduced
    ? editedFilesFromPatch(input.revisedPatch!)
    : undefined;
  const ruledOutPath = targetPath(input.checker?.ruledOutImplementation);
  const responseLeakageDetected = input.responseLeakageDetected === true;
  return {
    enabled: input.enabled,
    checkerTriggered: input.checker?.triggered === true,
    correctivePromptWritten: input.checker?.correctivePromptWritten === true,
    correctivePromptSafe: input.decision.correctivePromptSafe,
    correctiveModelCallExecuted: input.modelCallExecuted,
    revisedPatchProduced: revisedPatchProduced && !responseLeakageDetected,
    revisedPatchPath:
      revisedPatchProduced && !responseLeakageDetected
        ? input.revisedPatchPath
        : undefined,
    revisedPatchChangedFiles:
      revisedPatchProduced && !responseLeakageDetected
        ? revisedPatchChangedFiles
        : undefined,
    revisedPatchEditsRuledOutImplementation:
      revisedPatchProduced && !responseLeakageDetected && ruledOutPath !== null
        ? revisedPatchChangedFiles!.includes(ruledOutPath)
        : undefined,
    canonicalReplaced: false,
    adoptionEligible: false,
    oracleFree: true,
    forbiddenLeakageDetected:
      input.decision.forbiddenLeakageDetected || responseLeakageDetected,
    decisionReason: responseLeakageDetected
      ? "corrective response contained forbidden leakage; candidate withheld"
      : input.decision.reason,
    correctiveResponsePath: input.correctiveResponsePath,
    firstPassPatchSha:
      input.firstPassPatch.length > 0 ? sha256Text(input.firstPassPatch) : undefined,
    revisedPatchSha:
      revisedPatchProduced && !responseLeakageDetected
        ? sha256Text(input.revisedPatch!)
        : undefined,
    canonicalResultsFileShaBefore: input.canonicalResultsFileShaBefore,
    canonicalResultsFileShaAfter: input.canonicalResultsFileShaAfter,
    canonicalPatchUnchanged:
      input.canonicalResultsFileShaBefore !== undefined
      && input.canonicalResultsFileShaAfter !== undefined
      && input.canonicalResultsFileShaBefore === input.canonicalResultsFileShaAfter,
  };
}
