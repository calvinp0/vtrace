// M14 corrective pivot-revision pass — planning + prompt + record assembly.
//
// SCOPE: this module is PURE (no fs, no spawn, no model, no Docker). It decides
// whether a second corrective patch pass should run, builds the revision prompt, and
// assembles the persisted record. It NEVER touches retrieval: no candidate
// generation, no re-ranking, no re-scoring, no pivot selection, no parser/index
// change. It builds on the M13 compliance checker (`pivotInspectionCompliance.ts`):
// the verdict comes from there, this module turns a non-compliant verdict into a
// gated decision + a revision prompt.
//
// FEASIBILITY (M14): the Stage 5 hard-gate already spawns the EXTERNAL SWE-bench
// harness more than once (`spawnHardGatePhase`) using the installed adapter's
// `VTRACE_AGENT_*` env seam — no external harness internals are modified. The
// revision pass reuses that exact seam: after the first `modelPatch` is produced, run
// the M13 checker; if candidates are missing/unclear, spawn ONE more harness `run`
// whose instructions file carries this revision prompt, then read back the revised
// patch + assistant prose. This module is the deterministic, testable core of that
// flow; the live spawn + fs persistence is the runner's thin orchestrator around it.
//
// OFF BY DEFAULT. The pass runs only under BOTH `--pivot-revision-pass` and
// `--pivot-inspection-enforcement`, with injected Capsule v2 context, an existing
// model patch, and a non-compliant M13 verdict. Never for baseline, no_context skip,
// v1/legacy capsule, single-pivot/no-coedit (no required candidates), fully compliant
// patches, runs with no model patch, or Docker/eval-only mode.
//
// NOTHING HERE IS PROJECT-SPECIFIC. No instance ids, repo names, or hardcoded files.

import {
  buildCorrectivePrompt,
  type PivotInspectionCompliance,
} from "./pivotInspectionCompliance";

/** A compact source excerpt for a missing/unclear candidate, included in the prompt. */
export interface RevisionSourceExcerpt {
  /** Repo-relative file path of the candidate. */
  path: string;
  /** A SHORT excerpt (already bounded by the caller — never a whole file). */
  excerpt: string;
}

export interface RevisionPassDecisionInput {
  /** --pivot-revision-pass. */
  revisionPassEnabled: boolean;
  /** --pivot-inspection-enforcement (the M13 checker only activates under this). */
  enforcementEnabled: boolean;
  /** True when Capsule v2 context was actually injected (not baseline/skip/v1). */
  capsuleV2Injected: boolean;
  /** True when the first pass produced a non-empty model patch. */
  hasModelPatch: boolean;
  /** The M13 compliance verdict for the first patch. */
  complianceBefore: PivotInspectionCompliance;
}

export interface RevisionPassDecision {
  /** Whether the corrective revision pass should run. */
  run: boolean;
  /** A single compact reason — the gate that decided it (for telemetry/report). */
  reason: string;
}

/**
 * Decide whether the corrective revision pass should run. ALL of the gates must hold:
 * both flags enabled, Capsule v2 injected, a model patch exists, the M13 verdict is
 * active (enabled) AND has at least one missing/unclear candidate. The first failing
 * gate is reported as the reason, so the report can explain every no-run.
 */
export function decideRevisionPass(input: RevisionPassDecisionInput): RevisionPassDecision {
  if (!input.revisionPassEnabled) return { run: false, reason: "revision-pass flag off" };
  if (!input.enforcementEnabled) return { run: false, reason: "pivot-inspection enforcement off" };
  if (!input.capsuleV2Injected) return { run: false, reason: "no Capsule v2 context injected" };
  if (!input.hasModelPatch) return { run: false, reason: "no model patch from first pass" };
  if (!input.complianceBefore.enabled) return { run: false, reason: "compliance checker inactive" };
  if (input.complianceBefore.required.length === 0) {
    return { run: false, reason: "no required pivot/co-edit candidates" };
  }
  const outstanding = input.complianceBefore.missing.length + input.complianceBefore.unclear.length;
  if (outstanding === 0) return { run: false, reason: "patch already compliant" };
  return { run: true, reason: `${outstanding} missing/unclear candidate(s)` };
}

const REVISION_INTRO = "You previously produced this patch:";
const REVISION_RULES = [
  "Rules:",
  "  - Do not edit a file merely because it is listed.",
  "  - Prefer the minimal final diff.",
  "  - Preserve already-correct changes.",
  "  - If you rule a candidate out, cite concrete source evidence.",
  "  - Return a unified diff only.",
];

export interface BuildRevisionPromptInput {
  complianceBefore: PivotInspectionCompliance;
  /** The first-pass unified diff. */
  currentPatch: string;
  /** Optional compact excerpts for missing/unclear candidates (never whole files). */
  sourceExcerpts?: readonly RevisionSourceExcerpt[];
}

/**
 * Build the corrective revision prompt for the second pass. Uses the M13
 * `buildCorrectivePrompt` as the decision core (it lists ONLY the missing/unclear
 * candidates and carries the anti-over-edit / minimal-diff guardrails), and wraps it
 * with the current patch, optional bounded source excerpts, and the "return a unified
 * diff only" framing. Returns a stable prompt even if the verdict is somehow
 * compliant (callers gate with `decideRevisionPass` first, so that is defensive).
 */
export function buildRevisionPrompt(input: BuildRevisionPromptInput): string {
  const core = buildCorrectivePrompt(input.complianceBefore);
  const lines: string[] = [];
  lines.push(REVISION_INTRO);
  lines.push("");
  lines.push("```diff");
  lines.push(input.currentPatch.trimEnd());
  lines.push("```");
  lines.push("");
  if (core !== null) {
    lines.push(core);
  } else {
    // Defensive: no outstanding candidates. Keep the wording aligned anyway.
    lines.push("VTRACE found no outstanding pivot decisions; keep the patch as-is.");
  }
  if (input.sourceExcerpts && input.sourceExcerpts.length > 0) {
    lines.push("");
    lines.push("Source excerpts for the outstanding candidates:");
    for (const ex of input.sourceExcerpts) {
      lines.push("");
      lines.push(`- ${ex.path}`);
      lines.push("```");
      lines.push(ex.excerpt.trimEnd());
      lines.push("```");
    }
  }
  lines.push("");
  lines.push("Task:");
  lines.push("  Revise the patch only if source evidence shows a listed pivot/co-edit candidate must change.");
  lines.push("  Otherwise explicitly rule it out with concrete source evidence.");
  lines.push("");
  lines.push(...REVISION_RULES);
  return lines.join("\n");
}

/** The separate artifact files the revision pass persists (all "_"-prefixed: never
 *  picked up as a canonical results JSONL, and not staged in git). */
export const REVISION_ARTIFACT_FILES = {
  originalPatch: "_pivot_revision_original.patch",
  prompt: "_pivot_revision_prompt.md",
  response: "_pivot_revision_response.txt",
  revisedPatch: "_pivot_revision_revised.patch",
  record: "_pivot_revision.json",
} as const;

/** The persisted revision-pass record (also the shape written to `_pivot_revision.json`). */
export interface PivotRevisionRecord {
  /** Whether the revision pass actually ran (i.e. a second model call happened). */
  ran: boolean;
  /** The gate decision + reason (from `decideRevisionPass`). */
  decisionReason: string;
  /** First-pass patch (always recorded when present). */
  originalPatch: string;
  /** The revision prompt (null when the pass did not run). */
  revisionPrompt: string | null;
  /** Second-pass assistant prose (null when the pass did not run / no stream). */
  revisionResponse: string | null;
  /** Second-pass patch (null when the pass did not run / produced none). */
  revisedPatch: string | null;
  /** M13 verdict for the original patch. */
  complianceBefore: PivotInspectionCompliance;
  /** M13 verdict for the revised patch (null when the pass did not run). */
  complianceAfter: PivotInspectionCompliance | null;
  /** Whether the revised patch became the final patch for evaluation. */
  replacedFinalPatch: boolean;
}

/** Count of outstanding (missing + unclear) candidates in a verdict. */
export function outstandingCount(c: PivotInspectionCompliance): number {
  return c.missing.length + c.unclear.length;
}

/**
 * Decide whether the revised patch should REPLACE the original as the final patch.
 * Conservative: replace only when the revised patch is non-empty AND it strictly
 * reduces the number of outstanding (missing/unclear) candidates. A revision that
 * does not improve compliance — or produces no diff — keeps the original patch, so
 * the pass can never make the submitted diff worse on the compliance axis.
 */
export function decideReplacement(
  before: PivotInspectionCompliance,
  after: PivotInspectionCompliance | null,
  revisedPatch: string | null,
): boolean {
  if (after === null) return false;
  if (revisedPatch === null || !revisedPatch.includes("diff --git")) return false;
  return outstandingCount(after) < outstandingCount(before);
}

/** Assemble a "did not run" record (gate failed). Keeps the original patch as final. */
export function noRunRecord(
  decisionReason: string,
  originalPatch: string,
  complianceBefore: PivotInspectionCompliance,
): PivotRevisionRecord {
  return {
    ran: false,
    decisionReason,
    originalPatch,
    revisionPrompt: null,
    revisionResponse: null,
    revisedPatch: null,
    complianceBefore,
    complianceAfter: null,
    replacedFinalPatch: false,
  };
}
