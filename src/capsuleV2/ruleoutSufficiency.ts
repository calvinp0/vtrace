import {
  isOperationLikeName,
  type SemanticSymbolGroup,
} from "./semanticEditHypothesis";
import type { PivotInspectionCompliance } from "./pivotInspectionCompliance";

export const RULEOUT_SUFFICIENCY_TRIGGER =
  "cross_implementation_output_ruleout_insufficient" as const;

export const RULEOUT_SUFFICIENCY_ARTIFACT = "_ruleout_sufficiency_check.json";
export const RULEOUT_SUFFICIENCY_PROMPT_ARTIFACT =
  "_ruleout_sufficiency_corrective_prompt.md";

export interface RuleOutDecision {
  path: string;
  decision: string;
  evidence: string;
}

export interface RuleOutSufficiencyInput {
  enabled: boolean;
  semanticGroups: readonly SemanticSymbolGroup[];
  patch: string;
  surfacedTargets: readonly string[];
  inspectedPaths: readonly string[];
  assistantText: string;
  pivotDecisions?: readonly RuleOutDecision[];
}

export interface RuleOutSufficiencyCheck {
  enabled: boolean;
  triggered: boolean;
  triggerKind?: typeof RULEOUT_SUFFICIENCY_TRIGGER;
  oracleFree: true;
  originalDecision?: "ruledOut";
  effectiveDecision?: "unclear";
  pairedOperation?: string;
  editedImplementation?: string;
  ruledOutImplementation?: string;
  evidence: string[];
  missingEvidence: string[];
  correctivePromptPreview?: string;
  correctivePromptWritten?: boolean;
  canonicalReplaced: false;
  adoptionEligible: false;
}

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
  /\bexplicit source evidence\b.{0,80}\bempty output is (?:intended|desired)\b/i,
];

const RULEOUT_CUE =
  /\b(?:ruled?\s*out|no (?:fix|change|edit|modification) needed|does not need (?:a )?(?:fix|change|edit)|leave unchanged|already handles?)\b/i;

const FORBIDDEN_PROMPT_CUES: readonly RegExp[] = [
  /\bFAIL_TO_PASS\b/i,
  /\bPASS_TO_PASS\b/i,
  /\bgold patch\b/i,
  /\bhidden tests?\b/i,
  /\bexpected benchmark output\b/i,
  /\bresolved status\b/i,
  /\btest_unparse\b/i,
];

function disabledCheck(): RuleOutSufficiencyCheck {
  return {
    enabled: false,
    triggered: false,
    oracleFree: true,
    evidence: [],
    missingEvidence: [],
    canonicalReplaced: false,
    adoptionEligible: false,
  };
}

function targetPath(target: string): string {
  return target.split("::", 1)[0]!;
}

function editedPaths(patch: string): Set<string> {
  const out = new Set<string>();
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    out.add(match[2]!);
  }
  return out;
}

function fileMatches(candidate: string, observed: string): boolean {
  return candidate === observed
    || observed.endsWith(`/${candidate}`)
    || candidate.endsWith(`/${observed}`);
}

function decisionEvidence(input: RuleOutSufficiencyInput, path: string): string[] {
  return (input.pivotDecisions ?? [])
    .filter(
      (decision) =>
        decision.decision.toUpperCase() === "RULED_OUT"
        && fileMatches(path, decision.path),
    )
    .map((decision) => decision.evidence);
}

function textWindowsForPath(text: string, path: string): string[] {
  const lines = text.split(/\r?\n/);
  const basename = path.split("/").at(-1) ?? path;
  const windows: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i]!.includes(path) && !lines[i]!.includes(basename)) continue;
    windows.push(
      lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 5)).join("\n"),
    );
  }
  return windows;
}

function ruleOutEvidence(
  input: RuleOutSufficiencyInput,
  path: string,
): string | undefined {
  const marker = decisionEvidence(input, path).find(
    (evidence) => RULEOUT_CUE.test(evidence) || hasCrashShapedReasoning(evidence),
  );
  if (marker !== undefined) return marker;
  return textWindowsForPath(input.assistantText, path).find((window) =>
    RULEOUT_CUE.test(window)
  );
}

export function hasCrashShapedReasoning(text: string): boolean {
  return CRASH_CUES.some((cue) => cue.test(text));
}

export function hasOutputPreservingEvidence(text: string): boolean {
  return OUTPUT_EVIDENCE_CUES.some((cue) => cue.test(text));
}

export function assertRuleOutCorrectivePromptSafe(prompt: string): void {
  for (const cue of FORBIDDEN_PROMPT_CUES) {
    if (cue.test(prompt)) {
      throw new Error(`rule-out corrective prompt contains forbidden language: ${cue.source}`);
    }
  }
}

/** Remove evaluator-shaped prose before lexical classification or artifact persistence. */
export function sanitizeRuleOutAssistantText(text: string): string {
  return text.split(/\r?\n/).filter((line) =>
    ![
      /\bFAIL_TO_PASS\b/i,
      /\bPASS_TO_PASS\b/i,
      /\bgold patch\b/i,
      /\bhidden tests?\b/i,
      /\bresolved status\b/i,
      /(?:^|\s)(?:tests?\/[\w./-]+|test_[A-Za-z0-9_]+)(?:::[A-Za-z0-9_[\]().-]+)?/,
    ].some((cue) => cue.test(line))
  ).join("\n");
}

export function buildRuleOutCorrectivePrompt(
  operation: string,
  editedImplementation: string,
  ruledOutImplementation: string,
): string {
  const prompt = [
    `Your first-pass patch edited one implementation of \`${operation}\` (${editedImplementation}) but left a surfaced paired implementation unedited (${ruledOutImplementation}).`,
    "",
    "Your rule-out explains why the paired implementation may not crash, but it does not explain why its output or behavior is correct for the same edge case.",
    "",
    "Either revise the patch or provide concrete repository evidence that the paired implementation preserves the intended behavior.",
  ].join("\n");
  assertRuleOutCorrectivePromptSafe(prompt);
  return prompt;
}

export function evaluateRuleOutSufficiency(
  input: RuleOutSufficiencyInput,
): RuleOutSufficiencyCheck {
  if (!input.enabled) return disabledCheck();

  const base: RuleOutSufficiencyCheck = {
    enabled: true,
    triggered: false,
    oracleFree: true,
    evidence: [],
    missingEvidence: [],
    canonicalReplaced: false,
    adoptionEligible: false,
  };
  if (input.patch.trim().length === 0) {
    return { ...base, missingEvidence: ["first-pass patch"] };
  }

  const edited = editedPaths(input.patch);
  const missing: string[] = [];
  if (input.semanticGroups.length === 0) {
    missing.push("paired same-operation semantic hypothesis");
  }

  for (const group of input.semanticGroups) {
    if (!isOperationLikeName(group.name) || group.targets.length < 2) continue;
    const editedTargets = group.targets.filter((target) =>
      edited.has(targetPath(target))
    );
    const uneditedTargets = group.targets.filter(
      (target) => !edited.has(targetPath(target)),
    );
    if (editedTargets.length === 0) continue;
    if (uneditedTargets.length === 0) {
      missing.push(`unedited paired implementation for ${group.name}`);
      continue;
    }

    for (const uneditedTarget of uneditedTargets) {
      const uneditedPath = targetPath(uneditedTarget);
      const surfaced =
        input.surfacedTargets.includes(uneditedTarget)
        || input.inspectedPaths.some((path) => fileMatches(uneditedPath, path))
        || decisionEvidence(input, uneditedPath).length > 0;
      if (!surfaced) {
        missing.push(`surfaced/read/mentioned paired implementation ${uneditedTarget}`);
        continue;
      }
      const ruleOut = ruleOutEvidence(input, uneditedPath);
      if (ruleOut === undefined) {
        missing.push(`rule-out text/decision for ${uneditedTarget}`);
        continue;
      }
      if (!hasCrashShapedReasoning(ruleOut)) {
        missing.push(`crash/no-exception/safe-empty reasoning for ${uneditedTarget}`);
        continue;
      }
      if (hasOutputPreservingEvidence(ruleOut)) {
        missing.push(
          `rule-out for ${uneditedTarget} contains concrete output-preserving evidence`,
        );
        continue;
      }

      const editedImplementation = editedTargets[0]!;
      const prompt = buildRuleOutCorrectivePrompt(
        group.name,
        editedImplementation,
        uneditedTarget,
      );
      return {
        ...base,
        triggered: true,
        triggerKind: RULEOUT_SUFFICIENCY_TRIGGER,
        originalDecision: "ruledOut",
        effectiveDecision: "unclear",
        pairedOperation: group.name,
        editedImplementation,
        ruledOutImplementation: uneditedTarget,
        evidence: [
          `paired operation: ${group.name}`,
          `edited implementation: ${editedImplementation}`,
          `paired implementation surfaced/read/mentioned: ${uneditedTarget}`,
          `rule-out is crash-shaped: ${ruleOut.replace(/\s+/g, " ").trim().slice(0, 240)}`,
        ],
        missingEvidence: ["concrete output/behavior-preserving repository evidence"],
        correctivePromptPreview: prompt,
      };
    }
  }

  return {
    ...base,
    missingEvidence: [
      ...new Set(missing.length > 0 ? missing : ["trigger conditions not jointly satisfied"]),
    ],
  };
}

/** Reclassify only the checker-identified grounded rule-out; preserve all other M13 fields. */
export function applyRuleOutSufficiencyToCompliance(
  compliance: PivotInspectionCompliance,
  check: RuleOutSufficiencyCheck,
): PivotInspectionCompliance {
  if (
    !check.triggered
    || check.ruledOutImplementation === undefined
    || !compliance.enabled
  ) {
    return compliance;
  }
  const path = targetPath(check.ruledOutImplementation);
  const ruledOut = compliance.ruledOut.filter(
    (id) => targetPath(id) !== path,
  );
  const reclassified = compliance.ruledOut.filter(
    (id) => targetPath(id) === path,
  );
  if (reclassified.length === 0) return compliance;
  return {
    ...compliance,
    ruledOut,
    unclear: [...new Set([...compliance.unclear, ...reclassified])],
    correctivePromptSent: true,
  };
}
