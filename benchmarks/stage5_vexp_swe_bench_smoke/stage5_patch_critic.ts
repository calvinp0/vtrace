// Stage 5 patch critic schema + deterministic/mock critic (milestone 3 of the patch
// critic / repair loop design).
//
// SCOPE: analysis only, REPORT-ONLY. This module defines the bounded critic input/output
// contracts and a DETERMINISTIC critic that consumes the milestone-2 probe summaries and
// emits a structured `PatchCriticReport`. It calls NO model, runs NO agents, attempts NO
// repair, and mutates NO artifact. It is a pure-function module: given the same input it
// always produces the same report.
//
// The deterministic critic is a stand-in for the eventual live critic. It exists so we can
// answer, over the existing 12 passive-treatment runs and without spending a model call:
// "if a critic consumed the probe outputs, which runs would it request repair for, why, and
// which cases remain genuinely under-determined?" `null` is never treated as a pass; an
// honest measurement gap stays a gap. Repair is requested conservatively — only for clear
// fail signals — never on unknown scope alone.

import {
  INSTANCE_CONFIGS,
  type Confidence,
  type PatchProbeResult,
  type PatchProbeSummary,
  type ProbeStatus,
  type RiskLevel,
} from "./stage5_patch_probes";

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

// Treatment flags as recorded in the run meta. `null` means "not recorded for this run".
export interface CriticTreatmentMetadata {
  readonly pivotCheckInjected: boolean | null;
  readonly editGuardInjected: boolean | null;
  readonly patchVerifyInjected: boolean | null;
}

// Cheap engagement signals derived from the run meta / ordered tool log. `null` means the
// signal was not available from the artifacts (an honest gap, not a zero).
export interface CriticContextSignals {
  readonly hiddenPivotsInspected: number | null;
  readonly hiddenPivotsEdited: number | null;
  readonly orderedToolLogPresent: boolean | null;
}

// The bounded object the critic reasons over. Intentionally does NOT include full repository
// context, gold patches, or hidden tests — only the agent's own patch, deterministic probe
// output, and bounded run metadata.
export interface PatchCriticInput {
  readonly instanceId: string;
  readonly runLabel: string;
  readonly repo: string;
  readonly issueText?: string | null;
  readonly firstPatch: string;
  readonly editedFiles: string[];
  readonly patchChars: number;
  readonly probeSummary: PatchProbeSummary;
  readonly treatmentMetadata: CriticTreatmentMetadata;
  readonly contextSignals: CriticContextSignals;
}

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

export type CriticDimension = boolean | null;

export interface PatchCriticReport {
  readonly instanceId: string;
  readonly runLabel: string;

  readonly scope_ok: CriticDimension;
  readonly scope_evidence: string;

  readonly failing_behavior_handled: CriticDimension;
  readonly failing_behavior_evidence: string;

  readonly minimality_ok: CriticDimension;
  readonly minimality_evidence: string;

  readonly test_evidence_ok: CriticDimension;
  readonly test_evidence: string;

  readonly risk: RiskLevel;

  readonly repair_required: boolean;
  readonly repair_reason: string;
  readonly repair_instructions: string;

  readonly confidence: Confidence;

  readonly evidence_probe_ids: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findProbe(summary: PatchProbeSummary, probeId: string): PatchProbeResult | undefined {
  return summary.probes.find((p) => p.probeId === probeId);
}

function evidenceText(probe: PatchProbeResult | undefined, fallback: string): string {
  if (!probe || probe.evidence.length === 0) return fallback;
  return probe.evidence.join(" ");
}

// A repair signal is a concrete negative finding tied to a probe. `strong` signals are
// high-confidence fails (wrong scope, broad rewrite, syntax error) that force repair on their
// own; non-strong signals are medium warnings (missing failing behavior, non-minimal patch)
// that also request repair but at medium confidence.
interface RepairSignal {
  readonly probeId: string;
  readonly strong: boolean;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Repair instruction templates
// ---------------------------------------------------------------------------

// Per-instance concrete repair instructions, keyed by the triggering probe. These are
// deliberately specific to the three known losses (the milestone is tuned to them); a generic
// fallback covers any other instance so the critic never emits an empty instruction when it
// requests repair. Derived from the failed probes — never from gold patches or hidden tests.
const REPAIR_TEMPLATES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "psf__requests-5414": {
    minimality_rewrite_risk:
      "Restore the original non-ASCII IDNA branch guarded by `unicode_is_ascii`; do not IDNA-validate all ASCII hosts on the default/else path. Add only a narrow ASCII empty-label guard — e.g. extend the existing wildcard check to also reject leading-dot / empty-label hosts — instead of restructuring the existing control flow.",
  },
  "matplotlib__matplotlib-22719": {
    failing_behavior_pattern:
      "Add an explicit empty-array handling path in lib/matplotlib/category.py before the code path that assumes non-empty values.",
  },
  "sympy__sympy-16766": {
    inserted_method_scope:
      "Move the inserted _print_* methods into PythonCodePrinter; the diff shows them landing outside the intended class. Reconstruct full file scope to confirm placement before re-evaluating.",
  },
};

function genericInstruction(probeId: string, input: PatchCriticInput, parseError: string): string {
  const files = input.editedFiles.join(", ") || "the edited file";
  switch (probeId) {
    case "inserted_method_scope":
      return `Move the inserted method(s) into the intended class; the diff shows them landing outside it (${files}). Reconstruct full file scope to confirm placement.`;
    case "minimality_rewrite_risk":
      return `Prefer a minimal additive change in ${files} instead of deleting/restructuring the existing control flow.`;
    case "failing_behavior_pattern":
      return `Add an explicit handling path for the failing input named in the issue in ${files}, before the code path that assumes the non-failing case.`;
    case "python_parse":
      return `Fix the syntax error in the inserted Python block before re-evaluation: ${parseError}.`;
    default:
      return `Make a minimal, targeted correction in ${files} addressing the flagged probe.`;
  }
}

function instructionFor(probeId: string, input: PatchCriticInput, parseError: string): string {
  const perInstance = REPAIR_TEMPLATES[input.instanceId]?.[probeId];
  if (perInstance) return perInstance;
  return genericInstruction(probeId, input, parseError);
}

// ---------------------------------------------------------------------------
// Deterministic critic
// ---------------------------------------------------------------------------

// Map probe statuses onto the structured critic report. The mapping is intentionally
// conservative and explicit (see the module header and the design doc): probe `pass` → the
// dimension passes; `fail`/`warn` → the dimension fails and (except for test evidence)
// becomes a repair signal; `unknown`/absent → the dimension is `null` (NOT a pass) and never
// forces repair on its own.
export function buildDeterministicPatchCriticReport(input: PatchCriticInput): PatchCriticReport {
  const { probeSummary } = input;

  const editedFilesProbe = findProbe(probeSummary, "edited_files");
  const scopeProbe = findProbe(probeSummary, "inserted_method_scope");
  const behaviorProbe = findProbe(probeSummary, "failing_behavior_pattern");
  const minimalityProbe = findProbe(probeSummary, "minimality_rewrite_risk");
  const testProbe = findProbe(probeSummary, "test_evidence");
  const parseProbe = findProbe(probeSummary, "python_parse");

  const signals: RepairSignal[] = [];
  let indeterminate = false;

  // --- scope ---------------------------------------------------------------
  let scope_ok: CriticDimension;
  let scope_evidence: string;
  if (!scopeProbe) {
    scope_ok = null;
    scope_evidence =
      "No class-scope probe applies to this instance (no inserted-method pattern configured); scope cannot be assessed from the diff.";
  } else if (scopeProbe.status === "pass") {
    scope_ok = true;
    scope_evidence = evidenceText(scopeProbe, "Inserted method(s) appear within the expected class.");
  } else if (scopeProbe.status === "fail") {
    scope_ok = false;
    scope_evidence = evidenceText(scopeProbe, "Inserted method(s) landed outside the expected class.");
    signals.push({
      probeId: "inserted_method_scope",
      strong: true,
      reason: "inserted method(s) landed outside the expected class (high-confidence scope fail)",
    });
  } else {
    // unknown — an honest measurement gap, NOT a pass and NOT a repair trigger.
    scope_ok = null;
    scope_evidence = evidenceText(
      scopeProbe,
      "Inserted method scope not visible in the diff window; landing scope undetermined.",
    );
    indeterminate = true;
  }

  // --- failing behavior ----------------------------------------------------
  let failing_behavior_handled: CriticDimension;
  let failing_behavior_evidence: string;
  if (!behaviorProbe) {
    failing_behavior_handled = null;
    failing_behavior_evidence =
      "No failing-behavior pattern configured for this instance; failing-behavior coverage cannot be assessed from the diff.";
  } else if (behaviorProbe.status === "pass") {
    failing_behavior_handled = true;
    failing_behavior_evidence = evidenceText(
      behaviorProbe,
      "Added code appears to handle the expected failing behavior.",
    );
  } else if (behaviorProbe.status === "fail" || behaviorProbe.status === "warn") {
    failing_behavior_handled = false;
    failing_behavior_evidence = evidenceText(
      behaviorProbe,
      "Expected failing behavior not (fully) handled by the added code.",
    );
    signals.push({
      probeId: "failing_behavior_pattern",
      strong: false,
      reason:
        behaviorProbe.status === "fail"
          ? "expected failing behavior not handled (no matching added code)"
          : "expected failing behavior only partially handled (weak pattern match)",
    });
  } else {
    failing_behavior_handled = null;
    failing_behavior_evidence = evidenceText(behaviorProbe, "Failing-behavior coverage undetermined.");
    indeterminate = true;
  }

  // --- minimality ----------------------------------------------------------
  let minimality_ok: CriticDimension;
  let minimality_evidence: string;
  if (!minimalityProbe) {
    minimality_ok = null;
    minimality_evidence = "Minimality probe absent.";
  } else if (minimalityProbe.status === "pass") {
    minimality_ok = true;
    minimality_evidence = evidenceText(minimalityProbe, "Patch appears small/additive.");
  } else if (minimalityProbe.status === "fail") {
    minimality_ok = false;
    minimality_evidence = evidenceText(minimalityProbe, "Broad-rewrite indicators present.");
    signals.push({
      probeId: "minimality_rewrite_risk",
      strong: true,
      reason: "broad control-flow rewrite where a minimal additive change would suffice (high-confidence)",
    });
  } else {
    // warn — non-minimal, medium repair signal. The warn can be either the deletion-based
    // non-minimal heuristic or the semantic additive-validation-overreach signal; report the
    // matching reason so it is not mislabeled as a deletion when the patch deletes nothing.
    minimality_ok = false;
    minimality_evidence = evidenceText(minimalityProbe, "Non-minimal indicators present.");
    const isOverreach = minimality_evidence.toLowerCase().includes("overreach");
    signals.push({
      probeId: "minimality_rewrite_risk",
      strong: false,
      reason: isOverreach
        ? "validation widened across an existing guard (additive overreach where a minimal guard would suffice)"
        : "non-minimal patch (deleted control-flow / net-negative hunk)",
    });
  }

  // --- test evidence (never forces repair on its own) ----------------------
  let test_evidence_ok: CriticDimension;
  let test_evidence: string;
  if (!testProbe) {
    test_evidence_ok = null;
    test_evidence = "No test-evidence probe result available.";
  } else if (testProbe.status === "pass") {
    test_evidence_ok = true;
    test_evidence = evidenceText(testProbe, "A named test command/run is present.");
  } else if (testProbe.status === "warn" || testProbe.status === "fail") {
    test_evidence_ok = false;
    test_evidence = evidenceText(testProbe, "No named test suite was run.");
    // Deliberately NOT pushed as a repair signal: weak test evidence alone must not force repair.
  } else {
    test_evidence_ok = null;
    test_evidence = evidenceText(testProbe, "No artifacts available to assess test evidence.");
    indeterminate = true;
  }

  // --- python parse (strong signal on a syntax error) ----------------------
  const parseFail = parseProbe?.status === "fail";
  let parseError = "syntax error";
  if (parseFail) {
    parseError = parseProbe?.evidence.join(" ") ?? "syntax error";
    signals.push({
      probeId: "python_parse",
      strong: true,
      reason: "syntax error in inserted Python block (high-confidence parse fail)",
    });
  }

  // --- repair decision -----------------------------------------------------
  const strongSignals = signals.filter((s) => s.strong);
  const repair_required = signals.length > 0;

  // risk: a high-confidence fail → high; any negative/warn dimension → medium; otherwise low.
  // edited_files fail → cannot assess → unknown.
  let risk: RiskLevel;
  if (editedFilesProbe?.status === "fail") {
    risk = "unknown";
  } else if (strongSignals.length > 0) {
    risk = "high";
  } else if (repair_required || minimality_ok === false || failing_behavior_handled === false) {
    risk = "medium";
  } else {
    risk = "low";
  }

  // confidence: high if a strong fail drove the decision; medium if only medium signals did;
  // for no-repair reports, low when a relevant probe was genuinely indeterminate, else medium.
  let confidence: Confidence;
  if (strongSignals.length > 0) {
    confidence = "high";
  } else if (repair_required) {
    confidence = "medium";
  } else {
    confidence = indeterminate ? "low" : "medium";
  }

  // repair reason + instructions, derived from the triggering signals.
  let repair_reason: string;
  let repair_instructions: string;
  if (repair_required) {
    repair_reason = signals.map((s) => s.reason).join("; ") + ".";
    // De-duplicate instructions per probe (minimality could appear once; keep order stable).
    const seen = new Set<string>();
    const instructionParts: string[] = [];
    for (const s of signals) {
      if (seen.has(s.probeId)) continue;
      seen.add(s.probeId);
      instructionParts.push(instructionFor(s.probeId, input, parseError));
    }
    repair_instructions = instructionParts.join(" ");
  } else {
    repair_reason =
      "No high- or medium-confidence defect signal; deterministic probes are pass/unknown only, so no repair is requested.";
    repair_instructions = "";
  }

  const evidence_probe_ids = probeSummary.probes.map((p) => p.probeId);

  return {
    instanceId: input.instanceId,
    runLabel: input.runLabel,
    scope_ok,
    scope_evidence,
    failing_behavior_handled,
    failing_behavior_evidence,
    minimality_ok,
    minimality_evidence,
    test_evidence_ok,
    test_evidence,
    risk,
    repair_required,
    repair_reason,
    repair_instructions,
    confidence,
    evidence_probe_ids,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Validate a critic report against the contract rules. Returns a list of violation messages;
// an empty list means the report is well-formed. Used by tests and by the dry-run runner to
// guarantee the deterministic critic never emits an invalid report.
export function validatePatchCriticReport(report: PatchCriticReport): string[] {
  const violations: string[] = [];

  // Evidence strings must be non-empty.
  const requireNonEmpty = (field: string, value: string): void => {
    if (value.trim().length === 0) violations.push(`${field} must be non-empty.`);
  };
  requireNonEmpty("scope_evidence", report.scope_evidence);
  requireNonEmpty("failing_behavior_evidence", report.failing_behavior_evidence);
  requireNonEmpty("minimality_evidence", report.minimality_evidence);
  requireNonEmpty("test_evidence", report.test_evidence);

  // repair_reason/repair_instructions required when repair_required.
  if (report.repair_required) {
    requireNonEmpty("repair_reason", report.repair_reason);
    requireNonEmpty("repair_instructions", report.repair_instructions);
  }

  // High-confidence fail signals MUST force repair.
  const hasHighFail =
    report.scope_ok === false || (report.minimality_ok === false && report.confidence === "high");
  if (hasHighFail && !report.repair_required) {
    violations.push("A high-confidence fail signal is present but repair_required is false.");
  }

  // A high-risk report must request repair (no silent high-risk pass).
  if (report.risk === "high" && !report.repair_required) {
    violations.push("risk is high but repair_required is false.");
  }

  // evidence_probe_ids must be non-empty.
  if (report.evidence_probe_ids.length === 0) {
    violations.push("evidence_probe_ids must reference at least one probe.");
  }

  return violations;
}

// Convenience: does any deterministic probe in the summary report a fail/warn? Used by the
// runner to characterize how much signal the critic actually had to work with.
export function summaryHasNegativeProbe(summary: PatchProbeSummary): boolean {
  return summary.probes.some((p: PatchProbeResult) => p.status === "fail" || p.status === "warn");
}

// Re-export the known-instance defect registry so the runner can describe target defects
// without re-deriving them.
export { INSTANCE_CONFIGS };
export type { ProbeStatus };
