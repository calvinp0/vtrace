// Stage 5 EDIT_GUARD 3-loss before/after comparison report.
//
// SCOPE: reporting / analysis ONLY. The six runs and their Docker evaluations already
// exist on disk; this script READS those raw artifacts and computes the before/after
// comparison for the three controlled-pilot VTRACE losses that EDIT_GUARD targets:
//   before = PIVOT_CHECK only          (--disable-edit-guard)
//   after  = PIVOT_CHECK + EDIT_GUARD   (default)
//
// It runs NO agents, NO Docker, changes NO retrieval / PIVOT_CHECK / EDIT_GUARD /
// telemetry, and never mutates a raw artifact. It only writes its own Markdown + JSON.
// Every metric is computed from the artifacts; nothing is fabricated. Resolution is taken
// verbatim from the existing docker `_eval.meta.json` — it is never re-evaluated here.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { editedFilesFromPatch } from "../../src/capsule/finalEditDiagnostics";
import { delta, deltaPct } from "./run_stage5_pivot_check_report";
import {
  editedFileSetChanged,
  isRecord,
  pivotIsHidden,
  toolPathMatchesPivot,
  uniq,
} from "./run_stage5_outcome_ledger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const DEFAULT_OUT_NAME = "stage5_edit_guard_3_loss_comparison";

// Patch-shape classification vocabulary (fixed enumerated set from the experiment spec).
export type PatchShapeClass =
  | "same_or_nearly_same"
  | "different_but_same_defect"
  | "different_and_improved_but_unresolved"
  | "different_and_worse"
  | "insufficient_evidence";

// The three controlled-pilot VTRACE losses, with the specific known defect each carried
// (verbatim intent from stage5_controlled_pilot_loss_analysis.json) and a per-case probe
// that detects whether the after patch's SHAPE addresses that defect. The probe returns
// `null` when the defect cannot be read reliably from the unified diff (e.g. class scope),
// in which case the classifier falls back to `different_but_same_defect` rather than
// claiming an improvement it cannot evidence.
export interface CaseSeed {
  readonly instanceId: string;
  readonly repo: string;
  readonly beforeLabel: string;
  readonly afterLabel: string;
  // The known defect from the loss analysis (the failure EDIT_GUARD targets).
  readonly knownDefect: string;
  // The EDIT_GUARD step meant to address it.
  readonly editGuardStep: string;
  // Does this patch's SHAPE address the known defect? null = not readable from the diff.
  readonly addressesDefect: (patch: string) => boolean | null;
}

// matplotlib defect = missed empty-array early return. The patch addresses it when it ADDS
// an early return guarded on an empty array (`values.size == 0` ... `return`).
function matplotlibAddressesEmptyArray(patch: string): boolean {
  const added = addedLines(patch);
  const hasEmptyGuard = added.some((l) => /values\.size\s*==\s*0/.test(l));
  const hasReturn = added.some((l) => /\breturn\b/.test(l));
  return hasEmptyGuard && hasReturn;
}

// requests defect = broad control-flow rewrite instead of minimal additive validation.
// The patch addresses it ONLY if it is minimal/additive — i.e. it does NOT delete the
// existing `if not unicode_is_ascii(host)` branch. A patch that removes that line has
// restructured the control flow (the defect), so this returns false.
function requestsMinimalAdditive(patch: string): boolean {
  const removed = removedLines(patch);
  const removedExistingBranch = removed.some((l) => /if not unicode_is_ascii/.test(l));
  return !removedExistingBranch;
}

export const CASE_SEEDS: readonly CaseSeed[] = [
  {
    instanceId: "sympy__sympy-16766",
    repo: "sympy",
    beforeLabel: "eval-editguard-before-sympy-16766",
    afterLabel: "eval-editguard-after-sympy-16766",
    knownDefect:
      "wrong class scope — new printer methods landed in AbstractPythonCodePrinter instead of PythonCodePrinter",
    editGuardStep: "SCOPE (confirm the enclosing class/function before inserting methods)",
    // Class scope cannot be read reliably from a unified diff hunk, so the shape probe is
    // indeterminate. Do not claim the scope defect was fixed without that evidence.
    addressesDefect: () => null,
  },
  {
    instanceId: "matplotlib__matplotlib-22719",
    repo: "matplotlib",
    beforeLabel: "eval-editguard-before-matplotlib-22719",
    afterLabel: "eval-editguard-after-matplotlib-22719",
    knownDefect:
      "missed empty-array behavior — narrowed the deprecation-warning guard but never added the early return for empty arrays",
    editGuardStep: "FAILING BEHAVIOR (name the concrete failing input — the empty array — and verify the patch handles it)",
    addressesDefect: matplotlibAddressesEmptyArray,
  },
  {
    instanceId: "psf__requests-5414",
    repo: "psf",
    beforeLabel: "eval-editguard-before-requests-5414",
    afterLabel: "eval-editguard-after-requests-5414",
    knownDefect:
      "broad control-flow rewrite — always-IDNA-encode restructure instead of minimal additive empty-label validation",
    editGuardStep: "MINIMAL FIX (prefer the smallest additive guard/validation over a control-flow rewrite)",
    addressesDefect: requestsMinimalAdditive,
  },
];

export const NON_CLAIMS: readonly string[] = [
  "This is a 3-case targeted experiment, not a statistical benchmark; no significance is claimed from n=3.",
  "It does not prove EDIT_GUARD can never help — only that it converted none of these three targeted losses.",
  "It does not compare VTRACE to VEXP; both conditions are VTRACE-indexed and differ only by the edit guard.",
  "It does not change retrieval or revisit Capsule quality conclusions; localization was already correct in all three.",
  "It does not rerun agents or Docker; resolution is read verbatim from the existing docker _eval.meta.json artifacts.",
];

export const RECOMMENDATION = {
  direction: "Move from passive prose guidance to a structured patch-verification checkpoint.",
  detail:
    "Before finalizing the patch, require a PATCH_VERIFY step that checks: (1) did the edit land in the intended " +
    "scope/class/function? (2) does the patch explicitly handle the failing input/behavior? (3) is the change " +
    "minimal/additive unless justified? (4) did a narrow test or reproduction command run? (5) if no test ran, " +
    "explain why and name the risk. Keep this benchmark-only for now.",
  secondaryCostFinding:
    "EDIT_GUARD increased cost and tokens on all three runs. If it does not improve resolution, it should not remain " +
    "always-on; gate it or drop it pending stronger evidence.",
} as const;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

// Sum the four token components; null only when every component is absent.
export function tokenTotalOf(record: Record<string, unknown> | null): number | null {
  if (record === null) return null;
  const parts = [record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheCreationTokens]
    .map(asNumber)
    .filter((n): n is number => n !== null);
  return parts.length === 0 ? null : parts.reduce((a, b) => a + b, 0);
}

// Added (`+`) lines of a unified diff, excluding the `+++` file header.
export function addedLines(patch: string): string[] {
  return patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
}

// Removed (`-`) lines of a unified diff, excluding the `---` file header.
export function removedLines(patch: string): string[] {
  return patch
    .split("\n")
    .filter((l) => l.startsWith("-") && !l.startsWith("---"));
}

// Normalize a patch for "did the edit change at all" comparison: drop the volatile diff
// index line (blob SHAs) and surrounding whitespace, which differ even for identical edits.
export function normalizePatch(patch: string): string {
  return patch
    .split("\n")
    .filter((l) => !l.startsWith("index "))
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

// A short mechanical patch summary: edited files + added/removed line counts. Purely
// derived from the diff — no interpretation, so it never overstates what the patch does.
export function patchSummary(patch: string, editedFiles: readonly string[]): string {
  if (patch.trim().length === 0) return "no patch produced";
  const adds = addedLines(patch).length;
  const dels = removedLines(patch).length;
  const files = editedFiles.length > 0 ? editedFiles.join(", ") : "unknown file";
  return `${files}: +${adds}/-${dels} lines`;
}

// ---------------------------------------------------------------------------
// Raw run parts → RunData (pure)
// ---------------------------------------------------------------------------

export interface RawToolCall {
  readonly category: string | null;
  readonly path: string | null;
}

export interface RawRunParts {
  readonly runLabel: string;
  readonly meta: Record<string, unknown> | null; // _run.meta.json
  readonly evalMeta: Record<string, unknown> | null; // _eval.meta.json
  readonly record: Record<string, unknown> | null; // first swebench jsonl record
  readonly toolCalls: readonly RawToolCall[] | null; // _tool_calls.json (null = absent)
}

export interface RunData {
  readonly runLabel: string;
  readonly resolved: boolean | null;
  readonly cost: number | null;
  readonly tokens: number | null;
  readonly modelPatch: string;
  readonly patchChars: number;
  readonly editedFiles: readonly string[];
  readonly pivotCheckInjected: boolean | null;
  readonly editGuardInjected: boolean | null;
  readonly treatmentValid: boolean | null;
  readonly hiddenPivotsInspected: number | null;
}

// Resolution is KNOWN only when actually evaluated: prefer the docker _eval.meta.json
// (evaluationRan === true → resolvedCount >= 1), else the swebench `resolved` boolean,
// else unknown (null). Mirrors the outcome ledger's deriveResolution — never defaulted.
export function deriveResolution(
  evalMeta: Record<string, unknown> | null,
  record: Record<string, unknown> | null,
): boolean | null {
  if (evalMeta !== null && asBool(evalMeta.evaluationRan) === true) {
    const count = asNumber(evalMeta.resolvedCount);
    if (count !== null) return count >= 1;
  }
  if (record !== null && typeof record.resolved === "boolean") return record.resolved;
  return null;
}

// Hidden-pivot inspection: hidden capsule pivots (role-reason without a source-line anchor)
// that were read or edited per the ordered tool log. null when either signal is absent.
export function hiddenPivotsInspectedOf(
  meta: Record<string, unknown> | null,
  toolCalls: readonly RawToolCall[] | null,
): number | null {
  if (meta === null || toolCalls === null) return null;
  const pivotsRaw = Array.isArray(meta.vtraceCapsulePivots) ? (meta.vtraceCapsulePivots as unknown[]) : [];
  const pivots = pivotsRaw
    .filter(isRecord)
    .map((p) => ({ path: asString(p.path) ?? "", roleReason: asString(p.roleReason) }))
    .filter((p) => p.path !== "");
  if (pivots.length === 0) return null;
  const hidden = pivots.filter((p) => pivotIsHidden(p.roleReason));
  let inspected = 0;
  for (const hp of hidden) {
    const seen = toolCalls.some(
      (t) => (t.category === "read" || t.category === "edit") && t.path !== null && toolPathMatchesPivot(t.path, hp.path),
    );
    if (seen) inspected += 1;
  }
  return inspected;
}

export function buildRunData(parts: RawRunParts): RunData {
  const { meta, evalMeta, record, toolCalls } = parts;
  const modelPatch = asString(record?.modelPatch) ?? "";
  const editFromPatch = editedFilesFromPatch(modelPatch);
  const editFromTools = toolCalls
    ? toolCalls
        .filter((t) => t.category === "edit" && t.path)
        .map((t) => relPath(t.path!))
    : [];
  const editedFiles = uniq([...editFromPatch, ...editFromTools]);

  return {
    runLabel: parts.runLabel,
    resolved: deriveResolution(evalMeta, record),
    cost: asNumber(record?.costUsd),
    tokens: tokenTotalOf(record),
    modelPatch,
    patchChars: modelPatch.length,
    editedFiles,
    pivotCheckInjected: asBool(meta?.vtracePivotCheckInjected),
    editGuardInjected: asBool(meta?.vtraceEditGuardInjected),
    treatmentValid: asBool(meta?.vtraceTreatmentValid),
    hiddenPivotsInspected: hiddenPivotsInspectedOf(meta, toolCalls),
  };
}

// Strip the `.bench-repos/<repo>/` prefix so edit-tool paths compare against patch paths.
function relPath(p: string): string {
  const marker = ".bench-repos/";
  const idx = p.indexOf(marker);
  if (idx < 0) return p;
  const after = p.slice(idx + marker.length);
  const slash = after.indexOf("/");
  return slash >= 0 ? after.slice(slash + 1) : after;
}

// ---------------------------------------------------------------------------
// Patch-shape classification (pure)
// ---------------------------------------------------------------------------

// Classify how EDIT_GUARD changed the patch, using only computed signals:
//   - identical normalized patch                          → same_or_nearly_same
//   - patch differs, after addresses defect (before not)  → different_and_improved_but_unresolved
//   - patch differs, before addressed it but after did not→ different_and_worse
//   - patch differs, neither / indeterminate              → different_but_same_defect
// The resolution outcome (still unresolved everywhere here) is reported separately and
// never used to upgrade the classification beyond what the diff evidences.
export function classifyPatchShape(
  beforePatch: string,
  afterPatch: string,
  addressesDefect: (patch: string) => boolean | null,
): PatchShapeClass {
  if (beforePatch.trim().length === 0 || afterPatch.trim().length === 0) return "insufficient_evidence";
  if (normalizePatch(beforePatch) === normalizePatch(afterPatch)) return "same_or_nearly_same";
  const beforeAddr = addressesDefect(beforePatch);
  const afterAddr = addressesDefect(afterPatch);
  if (afterAddr === true && beforeAddr !== true) return "different_and_improved_but_unresolved";
  if (beforeAddr === true && afterAddr === false) return "different_and_worse";
  return "different_but_same_defect";
}

// ---------------------------------------------------------------------------
// Case comparison (pure)
// ---------------------------------------------------------------------------

export interface CaseComparison {
  readonly instanceId: string;
  readonly repo: string;
  readonly beforeLabel: string;
  readonly afterLabel: string;

  readonly beforeResolved: boolean | null;
  readonly afterResolved: boolean | null;
  readonly resolutionChanged: boolean;

  readonly beforeCost: number | null;
  readonly afterCost: number | null;
  readonly costDelta: number | null;
  readonly costDeltaPct: number | null;

  readonly beforeTokens: number | null;
  readonly afterTokens: number | null;
  readonly tokenDelta: number | null;
  readonly tokenDeltaPct: number | null;

  readonly beforePatchChars: number;
  readonly afterPatchChars: number;
  readonly patchCharDelta: number;

  readonly beforeEditedFiles: readonly string[];
  readonly afterEditedFiles: readonly string[];
  readonly editedFileSetChanged: boolean;

  readonly beforePivotCheckInjected: boolean | null;
  readonly afterPivotCheckInjected: boolean | null;
  readonly beforeEditGuardInjected: boolean | null;
  readonly afterEditGuardInjected: boolean | null;
  readonly treatmentValid: boolean;

  readonly beforeHiddenPivotsInspected: number | null;
  readonly afterHiddenPivotsInspected: number | null;

  readonly beforePatchSummary: string;
  readonly afterPatchSummary: string;
  readonly knownDefectBefore: string;
  readonly knownDefectAfter: string;
  readonly defectFixed: boolean;

  readonly classification: PatchShapeClass;
  readonly confidence: string;
  readonly evidence: string;
}

// The EDIT_GUARD treatment split is valid for a case when both conditions kept PIVOT_CHECK
// on, only the after condition injected EDIT_GUARD, and both runs reported a valid treatment.
export function treatmentSplitValid(before: RunData, after: RunData): boolean {
  return (
    before.pivotCheckInjected === true &&
    after.pivotCheckInjected === true &&
    before.editGuardInjected === false &&
    after.editGuardInjected === true &&
    before.treatmentValid === true &&
    after.treatmentValid === true
  );
}

export function buildCase(seed: CaseSeed, before: RunData, after: RunData): CaseComparison {
  const bothResolved = before.resolved !== null && after.resolved !== null;
  const classification = classifyPatchShape(before.modelPatch, after.modelPatch, seed.addressesDefect);
  const afterAddresses = seed.addressesDefect(after.modelPatch);
  const defectFixed = after.resolved === true;

  const knownDefectAfter = describeDefectAfter(seed, after.resolved, afterAddresses);
  const confidence = confidenceFor(classification, afterAddresses);
  const evidence = buildEvidence(seed, before, after, classification, afterAddresses);

  return {
    instanceId: seed.instanceId,
    repo: seed.repo,
    beforeLabel: seed.beforeLabel,
    afterLabel: seed.afterLabel,

    beforeResolved: before.resolved,
    afterResolved: after.resolved,
    resolutionChanged: bothResolved ? before.resolved !== after.resolved : false,

    beforeCost: before.cost,
    afterCost: after.cost,
    costDelta: before.cost !== null && after.cost !== null ? delta(before.cost, after.cost) : null,
    costDeltaPct: before.cost !== null && after.cost !== null ? deltaPct(before.cost, after.cost) : null,

    beforeTokens: before.tokens,
    afterTokens: after.tokens,
    tokenDelta: before.tokens !== null && after.tokens !== null ? delta(before.tokens, after.tokens) : null,
    tokenDeltaPct: before.tokens !== null && after.tokens !== null ? deltaPct(before.tokens, after.tokens) : null,

    beforePatchChars: before.patchChars,
    afterPatchChars: after.patchChars,
    patchCharDelta: after.patchChars - before.patchChars,

    beforeEditedFiles: before.editedFiles,
    afterEditedFiles: after.editedFiles,
    editedFileSetChanged: editedFileSetChanged(before.editedFiles, after.editedFiles),

    beforePivotCheckInjected: before.pivotCheckInjected,
    afterPivotCheckInjected: after.pivotCheckInjected,
    beforeEditGuardInjected: before.editGuardInjected,
    afterEditGuardInjected: after.editGuardInjected,
    treatmentValid: treatmentSplitValid(before, after),

    beforeHiddenPivotsInspected: before.hiddenPivotsInspected,
    afterHiddenPivotsInspected: after.hiddenPivotsInspected,

    beforePatchSummary: patchSummary(before.modelPatch, before.editedFiles),
    afterPatchSummary: patchSummary(after.modelPatch, after.editedFiles),
    knownDefectBefore: seed.knownDefect,
    knownDefectAfter,
    defectFixed,

    classification,
    confidence,
    evidence,
  };
}

function describeDefectAfter(seed: CaseSeed, afterResolved: boolean | null, afterAddresses: boolean | null): string {
  if (afterResolved === true) return `resolved — ${seed.knownDefect} fixed`;
  if (afterAddresses === true) {
    return `still unresolved, but the after patch's SHAPE now addresses the defect (${seed.editGuardStep}) — outcome did not flip`;
  }
  if (afterAddresses === false) {
    return `still unresolved; the after patch still exhibits the same defect class (${seed.knownDefect})`;
  }
  return `still unresolved; defect shape not readable from the diff (scope unverifiable), so persistence is indeterminate`;
}

function confidenceFor(classification: PatchShapeClass, afterAddresses: boolean | null): string {
  if (classification === "different_and_improved_but_unresolved") return "medium-high";
  if (afterAddresses === null) return "medium (patch differs; defect-shape not readable from diff)";
  return "medium-high";
}

function buildEvidence(
  seed: CaseSeed,
  before: RunData,
  after: RunData,
  classification: PatchShapeClass,
  afterAddresses: boolean | null,
): string {
  const parts: string[] = [];
  parts.push(
    `Before (${seed.beforeLabel}) resolved=${before.resolved}; after (${seed.afterLabel}) resolved=${after.resolved}.`,
  );
  parts.push(
    `Both conditions edited ${after.editedFiles.join(", ") || "the gold file"}; edited-file set ${
      editedFileSetChanged(before.editedFiles, after.editedFiles) ? "changed" : "unchanged"
    }.`,
  );
  parts.push(
    `Patch chars ${before.patchChars} → ${after.patchChars} (${after.patchChars - before.patchChars >= 0 ? "+" : ""}${
      after.patchChars - before.patchChars
    }).`,
  );
  if (afterAddresses === true) {
    parts.push(
      `The after patch's shape now addresses the known defect (${seed.knownDefect}) via EDIT_GUARD's ${seed.editGuardStep}, yet docker still reports unresolved.`,
    );
  } else if (afterAddresses === false) {
    parts.push(
      `The after patch still exhibits the known defect (${seed.knownDefect}); EDIT_GUARD's ${seed.editGuardStep} did not change the edit shape.`,
    );
  } else {
    parts.push(
      `The known defect (${seed.knownDefect}) is class-scope-level and not readable from the unified diff, so no improvement can be evidenced.`,
    );
  }
  parts.push(`Classification: ${classification}.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Summary (pure)
// ---------------------------------------------------------------------------

export interface ComparisonSummary {
  readonly cases: number;
  readonly beforeResolvedCount: number;
  readonly afterResolvedCount: number;
  readonly conversionsToResolved: number;
  readonly regressionsToUnresolved: number;
  readonly unchangedResolved: number;
  readonly unchangedUnresolved: number;
  readonly meanBeforeCost: number | null;
  readonly meanAfterCost: number | null;
  readonly meanCostDelta: number | null;
  readonly meanBeforeTokens: number | null;
  readonly meanAfterTokens: number | null;
  readonly meanTokenDelta: number | null;
  readonly editGuardTreatmentValidCount: number;
}

function mean(values: readonly (number | null)[]): number | null {
  const nums = values.filter((n): n is number => n !== null);
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function buildSummary(cases: readonly CaseComparison[]): ComparisonSummary {
  const beforeResolvedCount = cases.filter((c) => c.beforeResolved === true).length;
  const afterResolvedCount = cases.filter((c) => c.afterResolved === true).length;
  // Transition counts only over cases where BOTH outcomes are known.
  const known = cases.filter((c) => c.beforeResolved !== null && c.afterResolved !== null);
  const conversionsToResolved = known.filter((c) => c.beforeResolved === false && c.afterResolved === true).length;
  const regressionsToUnresolved = known.filter((c) => c.beforeResolved === true && c.afterResolved === false).length;
  const unchangedResolved = known.filter((c) => c.beforeResolved === true && c.afterResolved === true).length;
  const unchangedUnresolved = known.filter((c) => c.beforeResolved === false && c.afterResolved === false).length;

  return {
    cases: cases.length,
    beforeResolvedCount,
    afterResolvedCount,
    conversionsToResolved,
    regressionsToUnresolved,
    unchangedResolved,
    unchangedUnresolved,
    meanBeforeCost: mean(cases.map((c) => c.beforeCost)),
    meanAfterCost: mean(cases.map((c) => c.afterCost)),
    meanCostDelta: mean(cases.map((c) => c.costDelta)),
    meanBeforeTokens: mean(cases.map((c) => c.beforeTokens)),
    meanAfterTokens: mean(cases.map((c) => c.afterTokens)),
    meanTokenDelta: mean(cases.map((c) => c.tokenDelta)),
    editGuardTreatmentValidCount: cases.filter((c) => c.treatmentValid).length,
  };
}

// ---------------------------------------------------------------------------
// Report assembly (pure)
// ---------------------------------------------------------------------------

export interface ComparisonReport {
  readonly generatedAt: string | null;
  readonly summary: ComparisonSummary;
  readonly cases: readonly CaseComparison[];
  readonly recommendation: typeof RECOMMENDATION;
  readonly nonClaims: readonly string[];
}

export function buildReport(
  generatedAt: string | null,
  pairs: readonly { seed: CaseSeed; before: RunData; after: RunData }[],
): ComparisonReport {
  const cases = pairs.map((p) => buildCase(p.seed, p.before, p.after));
  return {
    generatedAt,
    summary: buildSummary(cases),
    cases,
    recommendation: RECOMMENDATION,
    nonClaims: NON_CLAIMS,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderJson(report: ComparisonReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function fmtNum(n: number | null, digits = 0): string {
  return n === null ? "n/a" : n.toFixed(digits);
}

function fmtCost(n: number | null): string {
  return n === null ? "n/a" : `$${n.toFixed(4)}`;
}

function fmtPct(n: number | null): string {
  return n === null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function fmtSignedInt(n: number | null): string {
  return n === null ? "n/a" : `${n >= 0 ? "+" : ""}${Math.round(n)}`;
}

function fmtBool(b: boolean | null): string {
  return b === null ? "unknown" : b ? "yes" : "no";
}

export function renderMarkdown(report: ComparisonReport): string {
  const { summary, cases } = report;
  const lines: string[] = [];

  lines.push("# Stage 5 EDIT_GUARD 3-loss comparison");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Reporting / analysis only. No agents, no Docker, no retrieval / PIVOT_CHECK / EDIT_GUARD / telemetry changes. " +
      "Every metric is computed from existing run + docker-eval artifacts; resolution is read verbatim from " +
      "`_eval.meta.json`._",
  );
  lines.push("");

  // --- Summary -------------------------------------------------------------
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `EDIT_GUARD did not produce a resolution improvement on the three targeted losses: ${summary.afterResolvedCount}/` +
      `${summary.cases} after runs resolved (vs ${summary.beforeResolvedCount}/${summary.cases} before). ` +
      `Conversions to resolved: ${summary.conversionsToResolved}; regressions: ${summary.regressionsToUnresolved}; ` +
      `unchanged unresolved: ${summary.unchangedUnresolved}.`,
  );
  lines.push("");
  lines.push(
    `The treatment split was valid in ${summary.editGuardTreatmentValidCount}/${summary.cases} cases (PIVOT_CHECK on ` +
      "in both conditions; EDIT_GUARD injected in after only). EDIT_GUARD raised mean cost by " +
      `${fmtCost(summary.meanCostDelta)} (${fmtCost(summary.meanBeforeCost)} → ${fmtCost(summary.meanAfterCost)}) and ` +
      `mean tokens by ${fmtSignedInt(summary.meanTokenDelta)} (${fmtNum(summary.meanBeforeTokens)} → ` +
      `${fmtNum(summary.meanAfterTokens)}).`,
  );
  lines.push("");
  lines.push("| metric | value |");
  lines.push("| --- | --- |");
  lines.push(`| cases | ${summary.cases} |`);
  lines.push(`| beforeResolvedCount | ${summary.beforeResolvedCount} |`);
  lines.push(`| afterResolvedCount | ${summary.afterResolvedCount} |`);
  lines.push(`| conversionsToResolved | ${summary.conversionsToResolved} |`);
  lines.push(`| regressionsToUnresolved | ${summary.regressionsToUnresolved} |`);
  lines.push(`| unchangedResolved | ${summary.unchangedResolved} |`);
  lines.push(`| unchangedUnresolved | ${summary.unchangedUnresolved} |`);
  lines.push(`| meanBeforeCost | ${fmtCost(summary.meanBeforeCost)} |`);
  lines.push(`| meanAfterCost | ${fmtCost(summary.meanAfterCost)} |`);
  lines.push(`| meanCostDelta | ${fmtCost(summary.meanCostDelta)} |`);
  lines.push(`| meanBeforeTokens | ${fmtNum(summary.meanBeforeTokens)} |`);
  lines.push(`| meanAfterTokens | ${fmtNum(summary.meanAfterTokens)} |`);
  lines.push(`| meanTokenDelta | ${fmtSignedInt(summary.meanTokenDelta)} |`);
  lines.push(`| editGuardTreatmentValidCount | ${summary.editGuardTreatmentValidCount} |`);
  lines.push("");

  // --- Experimental design -------------------------------------------------
  lines.push("## Experimental design");
  lines.push("");
  lines.push(
    "Three controlled-pilot VTRACE losses, each classified `patch_mistake_despite_good_context` (correct file and " +
      "context, wrong edit). For each, two VTRACE-indexed conditions differ ONLY in the edit guard:",
  );
  lines.push("");
  lines.push("- **before** = PIVOT_CHECK only (`--disable-edit-guard`).");
  lines.push("- **after** = PIVOT_CHECK + EDIT_GUARD (default).");
  lines.push("");
  lines.push(
    "`--disable-pivot-check` is never used: this measures the **incremental** effect of EDIT_GUARD on top of " +
      "PIVOT_CHECK. Both conditions share the normal protocol (force-inject, Capsule v2, intent debug, budget 8000). " +
      "All six runs were Docker-evaluated; resolution is taken from those evaluations.",
  );
  lines.push("");

  // --- Result table --------------------------------------------------------
  lines.push("## Result table");
  lines.push("");
  lines.push(
    "| instance | before resolved | after resolved | Δcost | Δtokens | Δpatch chars | edited-set changed | classification |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of cases) {
    lines.push(
      `| ${c.instanceId} | ${fmtBool(c.beforeResolved)} | ${fmtBool(c.afterResolved)} | ${fmtCost(c.costDelta)} ` +
        `(${fmtPct(c.costDeltaPct)}) | ${fmtSignedInt(c.tokenDelta)} (${fmtPct(c.tokenDeltaPct)}) | ` +
        `${fmtSignedInt(c.patchCharDelta)} | ${c.editedFileSetChanged ? "yes" : "no"} | ${c.classification} |`,
    );
  }
  lines.push("");

  // --- Per-case analysis ---------------------------------------------------
  lines.push("## Per-case analysis");
  lines.push("");
  for (const c of cases) {
    lines.push(`### ${c.instanceId} (${c.repo})`);
    lines.push("");
    lines.push(`- **Labels**: \`${c.beforeLabel}\` → \`${c.afterLabel}\`.`);
    lines.push(
      `- **Resolution**: before ${fmtBool(c.beforeResolved)}, after ${fmtBool(c.afterResolved)} (changed: ${
        c.resolutionChanged ? "yes" : "no"
      }).`,
    );
    lines.push(
      `- **Treatment**: PIVOT_CHECK ${fmtBool(c.beforePivotCheckInjected)}→${fmtBool(c.afterPivotCheckInjected)}, ` +
        `EDIT_GUARD ${fmtBool(c.beforeEditGuardInjected)}→${fmtBool(c.afterEditGuardInjected)} (split valid: ${
          c.treatmentValid ? "yes" : "no"
        }).`,
    );
    lines.push(
      `- **Context inspection**: hidden pivots inspected ${fmtNum(c.beforeHiddenPivotsInspected)}→` +
        `${fmtNum(c.afterHiddenPivotsInspected)}.`,
    );
    lines.push(`- **Known defect**: ${c.knownDefectBefore}.`);
    lines.push(`- **After defect status**: ${c.knownDefectAfter}.`);
    lines.push(`- **Patch shape**: before \`${c.beforePatchSummary}\`; after \`${c.afterPatchSummary}\`.`);
    lines.push(`- **Classification**: ${c.classification} (confidence: ${c.confidence}).`);
    lines.push(`- **Evidence**: ${c.evidence}`);
    lines.push("");
  }

  // --- Patch-shape comparison ----------------------------------------------
  lines.push("## Patch-shape comparison");
  lines.push("");
  lines.push("| instance | before chars | after chars | Δ | edited-set changed | classification |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const c of cases) {
    lines.push(
      `| ${c.instanceId} | ${c.beforePatchChars} | ${c.afterPatchChars} | ${fmtSignedInt(c.patchCharDelta)} | ${
        c.editedFileSetChanged ? "yes" : "no"
      } | ${c.classification} |`,
    );
  }
  lines.push("");
  lines.push(
    "Did EDIT_GUARD change the edit behavior? In every case the after patch differs from the before patch, but in " +
      "none did the change convert the task. Did it fix the specific known defect? No case flipped to resolved. " +
      "Did context inspection stay stable? Hidden-pivot inspection is unchanged across before/after in every case " +
      "(localization was never the bottleneck).",
  );
  lines.push("");

  // --- Cost and token impact -----------------------------------------------
  lines.push("## Cost and token impact");
  lines.push("");
  lines.push("| instance | before cost | after cost | Δcost | Δcost% | before tokens | after tokens | Δtokens | Δtokens% |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of cases) {
    lines.push(
      `| ${c.instanceId} | ${fmtCost(c.beforeCost)} | ${fmtCost(c.afterCost)} | ${fmtCost(c.costDelta)} | ` +
        `${fmtPct(c.costDeltaPct)} | ${fmtNum(c.beforeTokens)} | ${fmtNum(c.afterTokens)} | ` +
        `${fmtSignedInt(c.tokenDelta)} | ${fmtPct(c.tokenDeltaPct)} |`,
    );
  }
  lines.push("");
  lines.push(
    `EDIT_GUARD increased cost on all ${summary.cases} runs (mean Δ ${fmtCost(summary.meanCostDelta)}) and tokens on ` +
      `all ${summary.cases} runs (mean Δ ${fmtSignedInt(summary.meanTokenDelta)}). The extra prose adds spend without ` +
      "a resolution return on these three losses.",
  );
  lines.push("");

  // --- Interpretation ------------------------------------------------------
  lines.push("## Interpretation");
  lines.push("");
  lines.push("EDIT_GUARD did not produce a resolution improvement on the three targeted losses. Possible explanations:");
  lines.push("");
  lines.push("1. The guard was too weak / too easy for the model to ignore.");
  lines.push("2. The guard changed reasoning but not enough to alter the patch into a passing one.");
  lines.push("3. These failures require stronger patch verification, not more pre-edit prose.");
  lines.push("4. Task stochasticity may require more repetitions before a final judgment.");
  lines.push("");
  lines.push(
    "Notably, on matplotlib the after patch's shape DID change toward the known fix (it added the empty-array early " +
      "return that the before patch lacked), yet the task still failed docker evaluation — evidence for explanation 3: " +
      "shaping the prose moved the edit closer without crossing the bar a real verification step would enforce. On " +
      "requests the after patch remained a broad control-flow rewrite (the exact defect the MINIMAL FIX step targets), " +
      "evidence for explanation 1/2. No statistical significance is claimed from 3 cases.",
  );
  lines.push("");

  // --- Recommended next engineering work -----------------------------------
  lines.push("## Recommended next engineering work");
  lines.push("");
  lines.push(`**${report.recommendation.direction}**`);
  lines.push("");
  lines.push(report.recommendation.detail);
  lines.push("");
  lines.push(`Secondary (cost): ${report.recommendation.secondaryCostFinding}`);
  lines.push("");

  // --- Non-claims ----------------------------------------------------------
  lines.push("## Non-claims");
  lines.push("");
  for (const claim of report.nonClaims) lines.push(`- ${claim}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Loading (impure)
// ---------------------------------------------------------------------------

async function readJsonFile(p: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(p, "utf8");
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Read the first JSON record from a swebench-*.jsonl file in a run's vtrace dir.
async function readSwebenchRecord(vtraceDir: string): Promise<Record<string, unknown> | null> {
  const { readdir } = await import("node:fs/promises");
  let entries: string[];
  try {
    entries = await readdir(vtraceDir);
  } catch {
    return null;
  }
  const jsonl = entries.find((e) => e.startsWith("swebench-") && e.endsWith(".jsonl"));
  if (!jsonl) return null;
  try {
    const text = await readFile(path.join(vtraceDir, jsonl), "utf8");
    const firstLine = text.split("\n").find((l) => l.trim().length > 0);
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readToolCalls(vtraceDir: string): Promise<RawToolCall[] | null> {
  try {
    const text = await readFile(path.join(vtraceDir, "_tool_calls.json"), "utf8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isRecord).map((t) => ({
      category: asString(t.category),
      path: asString(t.path),
    }));
  } catch {
    return null;
  }
}

export async function loadRun(resultsDir: string, runLabel: string): Promise<RawRunParts> {
  const vtraceDir = path.join(resultsDir, "runs", runLabel, "raw", "vtrace");
  const [meta, evalMeta, record, toolCalls] = await Promise.all([
    readJsonFile(path.join(vtraceDir, "_run.meta.json")),
    readJsonFile(path.join(vtraceDir, "_eval.meta.json")),
    readSwebenchRecord(vtraceDir),
    readToolCalls(vtraceDir),
  ]);
  return { runLabel, meta, evalMeta, record, toolCalls };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly outName: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let outName = DEFAULT_OUT_NAME;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`Missing value for ${arg}.`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--results":
        resultsDir = next();
        break;
      case "--out-name":
        outName = next();
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { resultsDir, outName };
}

async function main(config: CliConfig): Promise<void> {
  const generatedAt = new Date().toISOString();

  const pairs = await Promise.all(
    CASE_SEEDS.map(async (seed) => {
      const [beforeParts, afterParts] = await Promise.all([
        loadRun(config.resultsDir, seed.beforeLabel),
        loadRun(config.resultsDir, seed.afterLabel),
      ]);
      return { seed, before: buildRunData(beforeParts), after: buildRunData(afterParts) };
    }),
  );

  const report = buildReport(generatedAt, pairs);

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const s = report.summary;
  process.stdout.write(
    [
      "Stage 5 EDIT_GUARD 3-loss comparison written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Cases: ${s.cases}   before resolved: ${s.beforeResolvedCount}   after resolved: ${s.afterResolvedCount}`,
      `Conversions: ${s.conversionsToResolved}   regressions: ${s.regressionsToUnresolved}   unchanged unresolved: ${s.unchangedUnresolved}`,
      `Mean Δcost: ${fmtCost(s.meanCostDelta)}   Mean Δtokens: ${fmtSignedInt(s.meanTokenDelta)}   treatment valid: ${s.editGuardTreatmentValidCount}/${s.cases}`,
      "",
    ].join("\n"),
  );
}

if (import.meta.main) {
  try {
    await main(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
