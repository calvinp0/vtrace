// M14 corrective pivot-revision pass — planning + prompt + record assembly.
// M15 — evidence enrichment: the revision prompt now carries FAIL_TO_PASS / test
// expectation context and bounded source excerpts for the outstanding candidates, and
// the record carries the first-pass assistant-text pointer + parsed first-pass
// PIVOT_DECISION markers, so the second pass is informed enough to make a real patch
// decision (M14.1 found it was under-informed: it ruled out a gold-required pivot).
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
  type PivotDecisionMarker,
  type PivotInspectionCompliance,
} from "./pivotInspectionCompliance";

/** Strict bounds so the revision prompt stays compact (never whole files / huge lists). */
export const MAX_EXCERPT_CANDIDATES = 3;
export const MAX_EXCERPT_LINES = 12;
export const MAX_EXCERPT_BULLETS = 2;
const MAX_FAIL_TO_PASS = 6;
const MAX_PROBLEM_STATEMENT_CHARS = 600;

/** A compact source excerpt for a missing/unclear candidate, included in the prompt. */
export interface RevisionSourceExcerpt {
  /** Repo-relative file path of the candidate. */
  path: string;
  /** Candidate symbol, when known (for a clearer header). */
  symbol?: string;
  /** A SHORT excerpt (bounded to MAX_EXCERPT_LINES — never a whole file). */
  excerpt: string;
  /** Up to MAX_EXCERPT_BULLETS evidence bullets (why surfaced / co-edit relation). */
  evidence?: readonly string[];
}

/**
 * Where the revision prompt's test-expectation context came from, in priority order:
 *   instance_metadata  — FAIL_TO_PASS names from the dataset / instance record
 *   eval_artifact      — failing-test summary from an evaluation artifact
 *   problem_statement  — issue text excerpt (no test names available)
 *   unavailable        — none of the above
 */
export interface RevisionTestExpectation {
  failToPass: readonly string[];
  /** Compact problem-statement excerpt, used when no test names are available. */
  problemStatementExcerpt?: string;
  source: "instance_metadata" | "eval_artifact" | "problem_statement" | "unavailable";
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

const REVISION_INTRO = "You previously produced this patch.";
const REVISION_VERIFY_LINE = "VTRACE could not verify the required pivot decision(s).";
const REVISION_RULES = [
  "Rules:",
  "  - Do not edit a file merely because it is listed.",
  "  - Prefer the minimal final diff.",
  "  - Preserve already-correct changes.",
  "  - Only add a co-edit file when source/test evidence requires it.",
  "  - If you rule a candidate out, cite concrete source evidence in a PIVOT_DECISION block.",
];

/**
 * Bound a list of source excerpts to the strict prompt limits: at most
 * MAX_EXCERPT_CANDIDATES candidates, each excerpt clipped to MAX_EXCERPT_LINES lines
 * and each evidence list clipped to MAX_EXCERPT_BULLETS bullets. Pure; never throws.
 */
export function boundExcerpts(
  excerpts: readonly RevisionSourceExcerpt[],
): RevisionSourceExcerpt[] {
  return excerpts.slice(0, MAX_EXCERPT_CANDIDATES).map((ex) => {
    const lines = ex.excerpt.replace(/\s+$/g, "").split(/\r?\n/).slice(0, MAX_EXCERPT_LINES);
    const evidence = (ex.evidence ?? [])
      .map((e) => e.trim())
      .filter((e) => e.length > 0)
      .slice(0, MAX_EXCERPT_BULLETS);
    return { path: ex.path, symbol: ex.symbol, excerpt: lines.join("\n"), evidence };
  });
}

/**
 * Build a `RevisionTestExpectation` from the available instance metadata, preferring
 * FAIL_TO_PASS test names, then a compact problem-statement excerpt, else unavailable.
 * Pure; safe with empty / undefined inputs.
 */
export function buildTestExpectation(
  failToPass: readonly string[] = [],
  problemStatement: string | null | undefined = null,
): RevisionTestExpectation {
  const tests = failToPass.map((t) => t.trim()).filter((t) => t.length > 0);
  if (tests.length > 0) {
    return { failToPass: tests.slice(0, MAX_FAIL_TO_PASS), source: "instance_metadata" };
  }
  const problem = (problemStatement ?? "").replace(/\s+/g, " ").trim();
  if (problem.length > 0) {
    const excerpt =
      problem.length > MAX_PROBLEM_STATEMENT_CHARS
        ? `${problem.slice(0, MAX_PROBLEM_STATEMENT_CHARS - 1)}…`
        : problem;
    return { failToPass: [], problemStatementExcerpt: excerpt, source: "problem_statement" };
  }
  return { failToPass: [], source: "unavailable" };
}

function renderTestExpectation(expectation: RevisionTestExpectation | undefined): string[] {
  if (!expectation || expectation.source === "unavailable") return [];
  const lines: string[] = ["", "## Test expectation", ""];
  if (expectation.failToPass.length > 0) {
    lines.push("FAIL_TO_PASS:");
    for (const t of expectation.failToPass) lines.push(`- ${t}`);
    lines.push("");
    lines.push(
      "Use these tests to decide whether the missing/unclear pivot affects the required behavior.",
    );
  } else if (expectation.problemStatementExcerpt) {
    lines.push("No FAIL_TO_PASS test names were available. Problem statement (excerpt):");
    lines.push(expectation.problemStatementExcerpt);
    lines.push("");
    lines.push(
      "Use the described failing behavior to decide whether the missing/unclear pivot is involved.",
    );
  }
  return lines;
}

export interface BuildRevisionPromptInput {
  complianceBefore: PivotInspectionCompliance;
  /** The first-pass unified diff. */
  currentPatch: string;
  /** Optional compact excerpts for missing/unclear candidates (never whole files). */
  sourceExcerpts?: readonly RevisionSourceExcerpt[];
  /** Optional FAIL_TO_PASS / test expectation context. */
  testExpectation?: RevisionTestExpectation;
}

/**
 * Build the corrective revision prompt for the second pass. Uses the M13
 * `buildCorrectivePrompt` as the decision core (it lists ONLY the missing/unclear
 * candidates and carries the anti-over-edit / minimal-diff guardrails), then wraps it
 * with the current patch, the FAIL_TO_PASS / test-expectation context, optional bounded
 * source excerpts, and the "revise only if evidence requires it" framing. The wording
 * asks the model to either return a non-empty diff OR explain the rule-out with a
 * PIVOT_DECISION marker — so a no-op pass is observable, not silent. Returns a stable
 * prompt even if the verdict is somehow compliant (callers gate with
 * `decideRevisionPass` first, so that is defensive).
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
  lines.push(REVISION_VERIFY_LINE);
  lines.push("");
  if (core !== null) {
    lines.push(core);
  } else {
    // Defensive: no outstanding candidates. Keep the wording aligned anyway.
    lines.push("VTRACE found no outstanding pivot decisions; keep the patch as-is.");
  }
  lines.push(...renderTestExpectation(input.testExpectation));
  const excerpts = boundExcerpts(input.sourceExcerpts ?? []);
  if (excerpts.length > 0) {
    lines.push("");
    lines.push("Source excerpts for the outstanding candidates:");
    for (const ex of excerpts) {
      lines.push("");
      lines.push(`- ${ex.symbol && ex.symbol.length > 0 ? `${ex.path}::${ex.symbol}` : ex.path}`);
      for (const bullet of ex.evidence ?? []) lines.push(`  ${bullet}`);
      lines.push("```");
      lines.push(ex.excerpt.trimEnd());
      lines.push("```");
    }
  }
  lines.push("");
  lines.push("Task:");
  lines.push(
    "  Use the FAIL_TO_PASS/test expectation and source excerpts above to decide whether the patch "
    + "must be revised.",
  );
  lines.push("  Return a non-empty unified diff only if source/test evidence requires a change.");
  lines.push(
    "  Otherwise return no diff and include PIVOT_DECISION markers explaining the rule-out.",
  );
  lines.push("");
  lines.push(...REVISION_RULES);
  return lines.join("\n");
}

/** The separate artifact files the revision pass persists (all "_"-prefixed: never
 *  picked up as a canonical results JSONL, and not staged in git). */
export const REVISION_ARTIFACT_FILES = {
  firstPassAssistant: "_pivot_first_pass_assistant.txt",
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
  /**
   * M18: compliance improved ⇒ the revised patch is a CANDIDATE. This is the old
   * `decideReplacement` signal — necessary for adoption but NOT sufficient (M17.1).
   */
  revisionCandidate: boolean;
  /**
   * M18: verified safe to adopt as the final patch. Requires a verification outcome
   * (shadow eval); compliance improvement alone never sets this true. Defaults false
   * at first-pass time (no shadow eval has run yet) and is upgraded by the shadow-eval
   * stage. See `decideRevisionAdoption` in `revisedPatchShadowEval.ts`.
   */
  replacementRecommended: boolean;
  /** M18: the single signal behind `replacementRecommended` (e.g. "not_verified"). */
  replacementReason: string;
  /**
   * M18 (corrected semantics): TRUE only when the canonical artifacts were ACTUALLY
   * replaced (an `installFinalPatch` happened). The live wiring omits `installFinalPatch`,
   * so this stays false there — fixing the misleading legacy behavior where it tracked
   * compliance improvement instead of real replacement. Mirrors `canonicalReplaced`.
   */
  replacedFinalPatch: boolean;
  /** M18: alias for `replacedFinalPatch` — whether canonical artifacts were replaced. */
  canonicalReplaced: boolean;
  /** Path to the persisted first-pass assistant text, or null when unavailable (M15). */
  firstPassAssistantTextPath?: string | null;
  /** First-pass PIVOT_DECISION markers parsed from the first-pass assistant text (M15). */
  firstPassPivotDecisions?: PivotDecisionMarker[];
  /** The test-expectation context fed into the revision prompt (M15). */
  testExpectation?: RevisionTestExpectation;
}

/** Count of outstanding (missing + unclear) candidates in a verdict. */
export function outstandingCount(c: PivotInspectionCompliance): number {
  return c.missing.length + c.unclear.length;
}

/**
 * Decide whether the revised patch is a REPLACEMENT CANDIDATE on the compliance axis.
 * Conservative: candidate only when the revised patch is non-empty AND it strictly
 * reduces the number of outstanding (missing/unclear) candidates. A revision that
 * does not improve compliance — or produces no diff — keeps the original patch.
 *
 * M18: a true result here marks `revisionCandidate`, NOT `replacementRecommended`.
 * Compliance improvement is necessary but NOT sufficient for adoption (M17.1 proved a
 * compliance-improving revision can still fail to resolve). Adoption is gated on a
 * shadow-eval verification — see `decideRevisionAdoption` in `revisedPatchShadowEval.ts`.
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

/** Optional extra fields (M15) attachable to a record without changing call sites. */
export interface RevisionRecordExtras {
  firstPassAssistantTextPath?: string | null;
  firstPassPivotDecisions?: PivotDecisionMarker[];
  testExpectation?: RevisionTestExpectation;
}

/** Assemble a "did not run" record (gate failed). Keeps the original patch as final. */
export function noRunRecord(
  decisionReason: string,
  originalPatch: string,
  complianceBefore: PivotInspectionCompliance,
  extras: RevisionRecordExtras = {},
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
    revisionCandidate: false,
    replacementRecommended: false,
    replacementReason: "not_verified",
    replacedFinalPatch: false,
    canonicalReplaced: false,
    ...extras,
  };
}
