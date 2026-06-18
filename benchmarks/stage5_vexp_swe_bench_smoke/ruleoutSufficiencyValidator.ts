import { isOperationLikeName, type SemanticSymbolGroup } from "../../src/capsuleV2/semanticEditHypothesis";

export const RULEOUT_TRIGGER_KIND = "cross_implementation_output_ruleout_insufficient" as const;

export interface LeakageCheck {
  usedGold: boolean;
  usedFailToPass: boolean;
  usedPassToPass: boolean;
  usedBenchmarkLabel: boolean;
}

export interface RuleOutSufficiencyInput {
  label: string;
  instance: string;
  semanticGroups: readonly SemanticSymbolGroup[];
  patch: string;
  surfacedTargets: readonly string[];
  inspectedPaths: readonly string[];
  assistantText: string;
  pivotDecisions?: readonly {
    path: string;
    decision: string;
    evidence: string;
  }[];
  leakageCheck?: LeakageCheck;
}

export interface RuleOutSufficiencyResult {
  label: string;
  instance: string;
  shouldFire: boolean;
  fired: boolean;
  decision: "fire" | "no_fire" | "insufficient_artifact";
  triggerKind?: typeof RULEOUT_TRIGGER_KIND;
  pairedOperation?: string;
  editedImplementation?: string;
  ruledOutImplementation?: string;
  evidence: string[];
  missingEvidence: string[];
  leakageCheck: LeakageCheck;
  correctivePromptPreview?: string;
}

const FALSE_LEAKAGE: LeakageCheck = {
  usedGold: false,
  usedFailToPass: false,
  usedPassToPass: false,
  usedBenchmarkLabel: false,
};

const CRASH_CUES: readonly RegExp[] = [
  /\bdoes not crash\b/i,
  /\bno crash\b/i,
  /\b(?:safe|safely)\b/i,
  /\bdoes(?:n't| not) raise\b/i,
  /\bno exception\b/i,
  /\bno error\b/i,
  /\bempty join\b/i,
  /\bjoin\(\s*\[\s*\]\s*\)\s+is safe\b/i,
  /\breturns? (?:an? )?empty string\b.{0,40}\b(?:okay|ok|fine|correct|safe)\b/i,
  /\bno pop\b/i,
  /\bnot vulnerable\b/i,
  /\bhandles? empty (?:iterables?|sequences?|tuples?|lists?) (?:gracefully|correctly|safely|naturally)\b/i,
];

const OUTPUT_EVIDENCE_CUES: readonly RegExp[] = [
  /\bmatches? (?:the )?existing documented output\b/i,
  /\bother implementation returns? (?:the )?same output\b/i,
  /\bround[\s-]?trip remains? equivalent\b/i,
  /\b(?:existing )?test in (?:the )?repository demonstrates? (?:the )?behavior\b/i,
  /\bcaller expects? (?:an? )?empty string\b/i,
  /\bdownstream code handles? (?:an? )?empty string as equivalent\b/i,
  /\b(?:docstring|documentation|source|call site|caller).{0,100}\b(?:requires?|expects?|documents?|treats?)\b.{0,80}\b(?:same|equivalent|desired|correct) (?:output|behavior|result|value)\b/i,
  /\bexplicit source evidence\b.{0,80}\bempty output is desired\b/i,
];

const RULEOUT_CUE = /\b(?:ruled?\s*out|no (?:fix|change|edit|modification) needed|does not need (?:a )?(?:fix|change|edit)|leave unchanged|already handles?)\b/i;

const FORBIDDEN_PROMPT = [
  /\bFAIL_TO_PASS\b/i,
  /\bPASS_TO_PASS\b/i,
  /\bgold patch\b/i,
  /\bhidden expected output\b/i,
  /\bhidden tests?\b/i,
  /\bbenchmark says\b/i,
  /\btest_unparse\b/i,
];

function editedPaths(patch: string): Set<string> {
  const out = new Set<string>();
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    out.add(match[2]!);
  }
  return out;
}

function targetPath(target: string): string {
  return target.split("::", 1)[0]!;
}

function targetForPath(group: SemanticSymbolGroup, path: string): string | undefined {
  return group.targets.find((target) => targetPath(target) === path);
}

function decisionEvidence(input: RuleOutSufficiencyInput, path: string): string[] {
  return (input.pivotDecisions ?? [])
    .filter((decision) => decision.path === path && decision.decision.toUpperCase() === "RULED_OUT")
    .map((decision) => decision.evidence);
}

function textWindowsForPath(text: string, path: string): string[] {
  const lines = text.split("\n");
  const basename = path.split("/").at(-1) ?? path;
  const windows: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i]!.includes(path) && !lines[i]!.includes(basename)) continue;
    windows.push(lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 5)).join("\n"));
  }
  return windows;
}

function ruleOutEvidence(input: RuleOutSufficiencyInput, path: string): string | undefined {
  const markerEvidence = decisionEvidence(input, path).find((evidence) => RULEOUT_CUE.test(evidence) || hasCrashCue(evidence));
  if (markerEvidence !== undefined) return markerEvidence;
  return textWindowsForPath(input.assistantText, path).find((window) => RULEOUT_CUE.test(window));
}

export function hasCrashCue(text: string): boolean {
  return CRASH_CUES.some((cue) => cue.test(text));
}

export function hasConcreteOutputEvidence(text: string): boolean {
  return OUTPUT_EVIDENCE_CUES.some((cue) => cue.test(text));
}

export function buildCorrectivePromptPreview(
  operation: string,
  editedImplementation: string,
  ruledOutImplementation: string,
): string {
  const prompt = [
    `Your first-pass patch edited one implementation of \`${operation}\` (${editedImplementation}) but left the paired implementation unedited (${ruledOutImplementation}).`,
    "Your rule-out explains why the paired implementation may not crash, but it does not explain why its output is correct for the same edge case.",
    "Either revise the patch or provide concrete repository evidence that the paired implementation preserves the intended behavior.",
  ].join("\n");
  assertCorrectivePromptSafe(prompt);
  return prompt;
}

export function assertCorrectivePromptSafe(prompt: string): void {
  for (const forbidden of FORBIDDEN_PROMPT) {
    if (forbidden.test(prompt)) throw new Error(`corrective prompt contains forbidden oracle language: ${forbidden.source}`);
  }
}

function leakDetected(leakage: LeakageCheck): boolean {
  return Object.values(leakage).some(Boolean);
}

export function evaluateRuleOutSufficiency(
  input: RuleOutSufficiencyInput,
  shouldFire = false,
): RuleOutSufficiencyResult {
  const leakageCheck = input.leakageCheck ?? FALSE_LEAKAGE;
  const evidence: string[] = [];
  const missingEvidence: string[] = [];

  if (leakDetected(leakageCheck)) {
    return {
      label: input.label,
      instance: input.instance,
      shouldFire,
      fired: false,
      decision: "no_fire",
      evidence,
      missingEvidence: ["oracle or benchmark-label input detected"],
      leakageCheck,
    };
  }

  if (input.patch.trim().length === 0) {
    return {
      label: input.label,
      instance: input.instance,
      shouldFire,
      fired: false,
      decision: "insufficient_artifact",
      evidence,
      missingEvidence: ["first-pass patch"],
      leakageCheck,
    };
  }

  const edited = editedPaths(input.patch);
  if (input.semanticGroups.length === 0) missingEvidence.push("paired same-operation hypothesis group");

  for (const group of input.semanticGroups) {
    if (!isOperationLikeName(group.name) || group.targets.length < 2) continue;
    const editedTargets = group.targets.filter((target) => edited.has(targetPath(target)));
    const uneditedTargets = group.targets.filter((target) => !edited.has(targetPath(target)));
    if (editedTargets.length === 0) continue;
    if (uneditedTargets.length === 0) {
      missingEvidence.push(`unedited paired implementation for ${group.name}`);
      continue;
    }

    for (const uneditedTarget of uneditedTargets) {
      const uneditedPath = targetPath(uneditedTarget);
      const surfaced = input.surfacedTargets.includes(uneditedTarget)
        || input.inspectedPaths.includes(uneditedPath)
        || decisionEvidence(input, uneditedPath).length > 0;
      if (!surfaced) {
        missingEvidence.push(`surfaced/read/mentioned paired implementation ${uneditedTarget}`);
        continue;
      }

      const ruleOut = ruleOutEvidence(input, uneditedPath);
      if (ruleOut === undefined) {
        missingEvidence.push(`rule-out text/decision for ${uneditedTarget}`);
        continue;
      }
      if (!hasCrashCue(ruleOut)) {
        missingEvidence.push(`crash/no-exception/safe-empty reasoning for ${uneditedTarget}`);
        continue;
      }
      if (hasConcreteOutputEvidence(ruleOut)) {
        missingEvidence.push(`rule-out for ${uneditedTarget} contains concrete output-preserving evidence`);
        continue;
      }

      const editedImplementation = targetForPath(group, targetPath(editedTargets[0]!))!;
      evidence.push(`paired operation: ${group.name}`);
      evidence.push(`edited implementation: ${editedImplementation}`);
      evidence.push(`paired implementation surfaced/read/mentioned: ${uneditedTarget}`);
      evidence.push(`rule-out is crash-shaped: ${ruleOut.replace(/\s+/g, " ").trim().slice(0, 240)}`);
      evidence.push("no concrete output-preserving repository evidence found");
      return {
        label: input.label,
        instance: input.instance,
        shouldFire,
        fired: true,
        decision: "fire",
        triggerKind: RULEOUT_TRIGGER_KIND,
        pairedOperation: group.name,
        editedImplementation,
        ruledOutImplementation: uneditedTarget,
        evidence,
        missingEvidence: [],
        leakageCheck,
        correctivePromptPreview: buildCorrectivePromptPreview(group.name, editedImplementation, uneditedTarget),
      };
    }
  }

  return {
    label: input.label,
    instance: input.instance,
    shouldFire,
    fired: false,
    decision: "no_fire",
    evidence,
    missingEvidence: [...new Set(missingEvidence.length > 0 ? missingEvidence : ["trigger conditions not jointly satisfied"])],
    leakageCheck,
  };
}
