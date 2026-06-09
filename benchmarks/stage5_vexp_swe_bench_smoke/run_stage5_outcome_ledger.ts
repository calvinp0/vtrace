// Stage 5 benchmark outcome ledger.
//
// SCOPE: reporting / indexing ONLY. This scans EXISTING Stage 5 run artifacts under
// `results/runs/` (plus a few curated/generated reports) and folds them into ONE
// consistent outcome table — the basis for future VTRACE-vs-baseline / VEXP-style
// measurement. It runs NO agents, NO Docker, changes NO retrieval / PIVOT_CHECK /
// telemetry, and reads — never writes — the raw run artifacts. It only writes its
// own Markdown + JSON ledger.
//
// It NEVER fabricates an outcome: a missing artifact yields `unknown`/`null`, not a
// guess. The interpretation rules below are load-bearing and enforced in code:
//   - pass@1 / resolved is reported ONLY when a run was actually evaluated (a
//     docker `_eval.meta.json` or the SWE-bench `resolved` flag in the run jsonl).
//   - token "savings" / unique wins are NEVER asserted by a single run; they live
//     only in `pairs[]`, where a comparable before/after or baseline/vtrace exists.
//   - inspection conversion, edited-file-set change, patch production, and docker
//     resolution are kept as SEPARATE fields and never conflated.

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { editedFilesFromPatch } from "../../src/capsule/finalEditDiagnostics";
import { delta, deltaPct } from "./run_stage5_pivot_check_report";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Resolution = boolean | null; // null === unknown (never evaluated)
export type DataCompleteness = "complete" | "partial" | "metadata_only" | "missing";
export type PairType = "baseline_vs_vtrace" | "pivot_check_before_after" | "unknown";

export interface TokenUsage {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheCreation: number | null;
  // input + output + cache* when any component is known; null when nothing is.
  readonly total: number | null;
}

export interface LedgerRun {
  readonly runLabel: string;
  readonly condition: string; // vtrace | baseline | vexp | unknown
  readonly instanceId: string | null;
  // Protocol / capsule configuration (DERIVED from meta; `unknown` when absent).
  readonly protocol: string;
  readonly contextPolicy: string | null;
  readonly capsuleEngine: string | null;
  readonly capsuleIntent: string | null;
  readonly capsuleBudget: number | null;
  // Treatment validity / injection (vtrace condition only).
  readonly treatmentValid: boolean | null;
  readonly injectionObserved: boolean | null;
  readonly pivotCheckEnabled: boolean | null;
  readonly pivotCheckInjected: boolean | null;
  readonly pivotCheckDisabledByFlag: boolean | null;
  // Run status + patch + resolution.
  readonly exitCode: number | null;
  readonly completedPatch: boolean | null; // run completed (exitCode 0); null if exit unknown
  readonly patchProduced: boolean; // a non-empty modelPatch was extracted
  readonly resolved: Resolution; // null unless actually evaluated
  readonly resolutionSource: string; // docker_eval | swebench_jsonl | unknown
  // Cost / tokens / duration.
  readonly tokens: TokenUsage;
  readonly cost: number | null;
  readonly durationMs: number | null;
  // Capsule pivots + ordered tool log.
  readonly pivotCount: number | null;
  readonly toolLogOrdered: boolean; // an ordered _tool_calls.json exists
  readonly toolCallCount: number | null;
  // File sets (repo-relative).
  readonly editedFiles: readonly string[];
  readonly readFiles: readonly string[];
  readonly searchedFiles: readonly string[];
  // Hidden-pivot engagement (DERIVED from capsule pivots × tool log; null/unknown
  // when either input is missing).
  readonly hiddenPivotCount: number | null;
  readonly hiddenPivotsInspected: number | null;
  readonly hiddenPivotsEdited: number | null;
  readonly hiddenPivotsIgnored: number | null;
  readonly rawArtifactPaths: readonly string[];
  readonly dataCompleteness: DataCompleteness;
}

export interface LedgerPair {
  readonly instanceId: string | null;
  readonly beforeRunLabel: string;
  readonly afterRunLabel: string;
  readonly pairType: PairType;
  readonly beforeTokens: number | null;
  readonly afterTokens: number | null;
  readonly tokenDelta: number | null;
  readonly tokenDeltaPct: number | null;
  readonly beforeCost: number | null;
  readonly afterCost: number | null;
  readonly costDelta: number | null;
  readonly costDeltaPct: number | null;
  readonly beforeResolved: Resolution;
  readonly afterResolved: Resolution;
  readonly resolvedChanged: boolean;
  readonly beforeEditedFiles: readonly string[];
  readonly afterEditedFiles: readonly string[];
  readonly editedFileSetChanged: boolean;
  // null on baseline_vs_vtrace pairs (baseline carries no pivots).
  readonly hiddenPivotsConvertedToInspected: number | null;
  readonly hiddenPivotsConvertedToEdited: number | null;
  readonly sourceReport: string;
}

export interface LedgerSummary {
  readonly totalRuns: number;
  readonly validVtraceRuns: number;
  readonly runsWithOrderedToolLogs: number;
  readonly runsWithResolutionKnown: number;
  readonly runsWithResolutionUnknown: number;
  readonly totalCost: number | null;
  readonly meanCostPerRun: number | null;
  readonly meanTokensPerRun: number | null;
  readonly pivotCheckPairs: number;
  readonly baselineVsVtracePairs: number;
  readonly completeness: Record<DataCompleteness, number>;
  // Plain-language honesty flag: true when most runs have no evaluated resolution.
  readonly resolutionMostlyUnknown: boolean;
}

export interface LedgerReport {
  readonly generatedAt: string | null;
  readonly resultsDir: string;
  readonly summary: LedgerSummary;
  readonly runs: readonly LedgerRun[];
  readonly pairs: readonly LedgerPair[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const DEFAULT_OUT_NAME = "stage5_outcome_ledger";

// Curated/generated reports scanned for already-computed before/after pairs.
export const PIVOT_CHECK_PAIR_REPORTS: readonly string[] = [
  "stage5_pivot_check_targeted_summary.json",
  "stage5_pivot_check_sphinx_7462.json",
  "stage5_pivot_check_seaborn_3187.json",
];

export const NON_CLAIMS: readonly string[] = [
  "This ledger does not run agents, Docker, or any evaluation — it indexes existing artifacts only.",
  "Resolved / pass@1 is reported ONLY for runs that were actually evaluated; every other run is `unknown`, never `false`.",
  "A single run never proves token savings or a unique win — those require a comparable baseline/before run and live only in `pairs[]`.",
  "Inspection conversion, edited-file-set change, patch production, and docker resolution are SEPARATE signals and are never conflated.",
  "Token/cost deltas describe spend, not quality; a cheaper run is not necessarily a better run.",
  "Pair token/cost deltas are arithmetic over the paired runs; they are not normalized for task difficulty.",
];

// ---------------------------------------------------------------------------
// Pure helpers (typed JSON access)
// ---------------------------------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// Sum the token components into a total. null only when EVERY component is null
// (so a run that reported just input/output still gets a real total).
export function tokenTotal(t: Omit<TokenUsage, "total">): number | null {
  const parts = [t.input, t.output, t.cacheRead, t.cacheCreation].filter((n): n is number => n !== null);
  return parts.length === 0 ? null : parts.reduce((a, b) => a + b, 0);
}

// Two file sets are equal order-insensitively (used for editedFileSetChanged).
export function fileSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    // length can still match after dedup; fall through to set comparison.
  }
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

export function editedFileSetChanged(before: readonly string[], after: readonly string[]): boolean {
  return !fileSetsEqual(before, after);
}

// A capsule pivot is hidden when its role-reason does NOT cite the issue's source
// line anchor (mirrors run_stage5_vexp_swe_bench_smoke.ts `pivotIsHidden`).
export function pivotIsHidden(roleReason: string | null): boolean {
  return !(roleReason ?? "").includes("source line anchor");
}

// Reduce an absolute tool-call path to repo-relative by stripping the
// `.bench-repos/<repo>/` prefix; falls back to the path as-is. Keeps file sets
// comparable with capsule pivot paths (which are repo-relative).
export function repoRelativePath(p: string): string {
  const marker = ".bench-repos/";
  const idx = p.indexOf(marker);
  if (idx < 0) return p;
  const after = p.slice(idx + marker.length); // "<repo>/rest/of/path.py"
  const slash = after.indexOf("/");
  return slash >= 0 ? after.slice(slash + 1) : after;
}

// Does a repo-relative pivot path match a (possibly absolute) tool-call path?
export function toolPathMatchesPivot(toolPath: string, pivotPath: string): boolean {
  const rel = repoRelativePath(toolPath);
  return rel === pivotPath || rel.endsWith(`/${pivotPath}`) || pivotPath.endsWith(`/${rel}`);
}

// ---------------------------------------------------------------------------
// Raw artifact shapes (only the fields we read)
// ---------------------------------------------------------------------------

export interface RawToolCall {
  readonly tool: string | null;
  readonly category: string | null; // read | search | edit | other
  readonly path: string | null;
}

export interface RawPivot {
  readonly path: string;
  readonly roleReason: string | null;
}

// Everything the run loader assembles from disk (or a fixture) before building a
// LedgerRun. Splitting load (impure) from build (pure) keeps the build testable.
export interface RawRunParts {
  readonly runLabel: string;
  readonly condition: string;
  readonly meta: Record<string, unknown> | null; // _run.meta.json
  readonly evalMeta: Record<string, unknown> | null; // _eval.meta.json
  readonly record: Record<string, unknown> | null; // first swebench jsonl record
  readonly toolCalls: readonly RawToolCall[] | null; // _tool_calls.json (null = absent)
  readonly rawArtifactPaths: readonly string[];
}

// ---------------------------------------------------------------------------
// Resolution + completeness (pure, interpretation-rule-bearing)
// ---------------------------------------------------------------------------

// Resolution is KNOWN only when actually evaluated. Priority:
//   1. docker `_eval.meta.json` with evaluationRan === true → resolvedCount >= 1.
//   2. the SWE-bench `resolved` boolean in the run jsonl (the eval pipeline's flag).
//   3. otherwise unknown (null) — NEVER defaulted to false.
export function deriveResolution(
  evalMeta: Record<string, unknown> | null,
  record: Record<string, unknown> | null,
): { resolved: Resolution; source: string } {
  if (evalMeta !== null && asBool(evalMeta.evaluationRan) === true) {
    const count = asNumber(evalMeta.resolvedCount);
    if (count !== null) return { resolved: count >= 1, source: "docker_eval" };
  }
  if (record !== null && typeof record.resolved === "boolean") {
    return { resolved: record.resolved, source: "swebench_jsonl" };
  }
  return { resolved: null, source: "unknown" };
}

// complete:      meta + treatment status + tokens/cost + edited files + resolution.
// partial:       meta + some fields, but resolution OR ordered tool log missing.
// metadata_only: meta exists but no tool log AND no patch/result details.
// missing:       the run folder exists but its meta is absent.
export function classifyCompleteness(parts: {
  hasMeta: boolean;
  treatmentKnown: boolean;
  tokensKnown: boolean;
  costKnown: boolean;
  editedFilesKnown: boolean;
  resolutionKnown: boolean;
  toolLogOrdered: boolean;
  patchOrResultDetails: boolean;
}): DataCompleteness {
  if (!parts.hasMeta) return "missing";
  if (
    parts.treatmentKnown &&
    parts.tokensKnown &&
    parts.costKnown &&
    parts.editedFilesKnown &&
    parts.resolutionKnown
  ) {
    return "complete";
  }
  if (!parts.toolLogOrdered && !parts.patchOrResultDetails) return "metadata_only";
  return "partial";
}

// ---------------------------------------------------------------------------
// Build a LedgerRun from raw parts (pure)
// ---------------------------------------------------------------------------

// Protocol is not stored explicitly; derive it from the condition + capsule engine.
function deriveProtocol(condition: string, capsuleEngine: string | null, meta: Record<string, unknown> | null): string {
  if (condition === "baseline") return "baseline";
  if (condition === "vexp") return "vexp";
  if (condition === "vtrace") {
    // A vtrace condition with capsule retrieval is the indexed-context protocol.
    if (capsuleEngine !== null || asBool(meta?.vtraceIndexedContext) === true) return "vtrace-indexed";
    return "vtrace";
  }
  return "unknown";
}

export function buildRun(parts: RawRunParts): LedgerRun {
  const { meta, evalMeta, record, toolCalls } = parts;
  const hasMeta = meta !== null;

  const condition = asString(meta?.condition) ?? parts.condition;
  const instanceId = asString(record?.instanceId) ?? asString((meta?.instances as unknown[] | undefined)?.[0]) ?? null;

  const capsuleEngine = asString(meta?.vtraceCapsuleEngine);
  const capsuleIntent = asString(meta?.vtraceCapsuleIntent);
  const capsuleBudget = asNumber(meta?.vtraceCapsuleBudget);
  const contextPolicy = asString(meta?.vtraceContextPolicyOverride) ?? asString(meta?.vtraceContextPolicyAction);

  const treatmentValid = asBool(meta?.vtraceTreatmentValid);
  const injectionObserved = asBool(meta?.vtraceInjectionObserved);
  const pivotCheckEnabled = asBool(meta?.vtracePivotCheckEnabled);
  const pivotCheckInjected = asBool(meta?.vtracePivotCheckInjected);
  const pivotCheckDisabledByFlag = asBool(meta?.vtracePivotCheckDisabledByFlag);

  const exitCode = asNumber(meta?.exitCode);
  const modelPatch = asString(record?.modelPatch) ?? "";
  const patchProduced = modelPatch.trim().length > 0;
  const completedPatch = exitCode === null ? null : exitCode === 0;

  const { resolved, source: resolutionSource } = deriveResolution(evalMeta, record);

  const tokensBase = {
    input: asNumber(record?.inputTokens),
    output: asNumber(record?.outputTokens),
    cacheRead: asNumber(record?.cacheReadTokens),
    cacheCreation: asNumber(record?.cacheCreationTokens),
  };
  const tokens: TokenUsage = { ...tokensBase, total: tokenTotal(tokensBase) };
  const cost = asNumber(record?.costUsd);
  const durationMs = asNumber(record?.durationMs) ?? asNumber(meta?.durationMs);

  const pivotsRaw = Array.isArray(meta?.vtraceCapsulePivots) ? (meta!.vtraceCapsulePivots as unknown[]) : [];
  const pivots: RawPivot[] = pivotsRaw
    .filter(isRecord)
    .map((p) => ({ path: asString(p.path) ?? "", roleReason: asString(p.roleReason) }))
    .filter((p) => p.path !== "");
  const pivotCount = asNumber(meta?.vtracePivotCount) ?? (pivots.length > 0 ? pivots.length : null);

  // Tool log (ordered _tool_calls.json). Absent => unknown counts.
  const toolLogOrdered = toolCalls !== null;
  const toolCallCount = toolCalls !== null ? toolCalls.length : null;
  const readFiles = toolCalls
    ? uniq(toolCalls.filter((t) => t.category === "read" && t.path).map((t) => repoRelativePath(t.path!)))
    : [];
  const searchedFiles = toolCalls
    ? uniq(toolCalls.filter((t) => t.category === "search" && t.path).map((t) => repoRelativePath(t.path!)))
    : [];
  // Edited files: prefer the authoritative modelPatch; union with edit tool calls.
  const editFromPatch = editedFilesFromPatch(modelPatch);
  const editFromTools = toolCalls
    ? toolCalls.filter((t) => t.category === "edit" && t.path).map((t) => repoRelativePath(t.path!))
    : [];
  const editedFiles = uniq([...editFromPatch, ...editFromTools]);

  // Hidden-pivot engagement: only derivable when BOTH capsule pivots AND an ordered
  // tool log exist; otherwise every count is unknown (null), never invented.
  let hiddenPivotCount: number | null = null;
  let hiddenPivotsInspected: number | null = null;
  let hiddenPivotsEdited: number | null = null;
  let hiddenPivotsIgnored: number | null = null;
  const hiddenPivots = pivots.filter((p) => pivotIsHidden(p.roleReason));
  if (pivots.length > 0 && toolCalls !== null) {
    hiddenPivotCount = hiddenPivots.length;
    let inspected = 0;
    let edited = 0;
    for (const hp of hiddenPivots) {
      const readOrEdited = toolCalls.some(
        (t) => (t.category === "read" || t.category === "edit") && t.path !== null && toolPathMatchesPivot(t.path, hp.path),
      );
      const wasEdited = toolCalls.some(
        (t) => t.category === "edit" && t.path !== null && toolPathMatchesPivot(t.path, hp.path),
      );
      if (readOrEdited) inspected += 1;
      if (wasEdited) edited += 1;
    }
    hiddenPivotsInspected = inspected;
    hiddenPivotsEdited = edited;
    hiddenPivotsIgnored = hiddenPivots.length - inspected;
  }

  const tokensKnown = tokens.total !== null;
  const costKnown = cost !== null;
  // "edited files known" = we had a patch or tool log to read them from.
  const editedFilesKnown = patchProduced || toolLogOrdered;
  const treatmentKnown = condition !== "vtrace" || treatmentValid !== null;
  const patchOrResultDetails = patchProduced || resolved !== null || tokensKnown;

  const dataCompleteness = classifyCompleteness({
    hasMeta,
    treatmentKnown,
    tokensKnown,
    costKnown,
    editedFilesKnown,
    resolutionKnown: resolved !== null,
    toolLogOrdered,
    patchOrResultDetails,
  });

  return {
    runLabel: parts.runLabel,
    condition,
    instanceId,
    protocol: deriveProtocol(condition, capsuleEngine, meta),
    contextPolicy,
    capsuleEngine,
    capsuleIntent,
    capsuleBudget,
    treatmentValid,
    injectionObserved,
    pivotCheckEnabled,
    pivotCheckInjected,
    pivotCheckDisabledByFlag,
    exitCode,
    completedPatch,
    patchProduced,
    resolved,
    resolutionSource,
    tokens,
    cost,
    durationMs,
    pivotCount,
    toolLogOrdered,
    toolCallCount,
    editedFiles,
    readFiles,
    searchedFiles,
    hiddenPivotCount,
    hiddenPivotsInspected,
    hiddenPivotsEdited,
    hiddenPivotsIgnored,
    rawArtifactPaths: [...parts.rawArtifactPaths],
    dataCompleteness,
  };
}

// ---------------------------------------------------------------------------
// Pair builders (pure)
// ---------------------------------------------------------------------------

// A baseline_vs_vtrace pair from the two condition runs that share a run label.
export function buildBaselineVtracePair(label: string, baseline: LedgerRun, vtrace: LedgerRun): LedgerPair {
  const beforeTokens = baseline.tokens.total;
  const afterTokens = vtrace.tokens.total;
  const beforeCost = baseline.cost;
  const afterCost = vtrace.cost;
  const bothResolved = baseline.resolved !== null && vtrace.resolved !== null;
  return {
    instanceId: vtrace.instanceId ?? baseline.instanceId,
    beforeRunLabel: `${label} [baseline]`,
    afterRunLabel: `${label} [vtrace]`,
    pairType: "baseline_vs_vtrace",
    beforeTokens,
    afterTokens,
    tokenDelta: beforeTokens !== null && afterTokens !== null ? delta(beforeTokens, afterTokens) : null,
    tokenDeltaPct: beforeTokens !== null && afterTokens !== null ? deltaPct(beforeTokens, afterTokens) : null,
    beforeCost,
    afterCost,
    costDelta: beforeCost !== null && afterCost !== null ? delta(beforeCost, afterCost) : null,
    costDeltaPct: beforeCost !== null && afterCost !== null ? deltaPct(beforeCost, afterCost) : null,
    beforeResolved: baseline.resolved,
    afterResolved: vtrace.resolved,
    resolvedChanged: bothResolved ? baseline.resolved !== vtrace.resolved : false,
    beforeEditedFiles: baseline.editedFiles,
    afterEditedFiles: vtrace.editedFiles,
    editedFileSetChanged: editedFileSetChanged(baseline.editedFiles, vtrace.editedFiles),
    hiddenPivotsConvertedToInspected: null, // baseline carries no pivots
    hiddenPivotsConvertedToEdited: null,
    sourceReport: `runs/${label} (baseline+vtrace conditions)`,
  };
}

// Normalize one already-computed pivot-check pair record (from a curated report)
// into the ledger pair schema. Hidden-pivot conversions are DERIVED as the positive
// change in inspected/edited counts across the pair.
export function normalizePivotCheckPair(raw: Record<string, unknown>, sourceReport: string): LedgerPair {
  const beforeTokens = asNumber(raw.beforeTokens);
  const afterTokens = asNumber(raw.afterTokens);
  const beforeCost = asNumber(raw.beforeCost);
  const afterCost = asNumber(raw.afterCost);
  const beforeResolved = asBool(raw.beforeResolved);
  const afterResolved = asBool(raw.afterResolved);
  const beforeEdited = asStringArray(raw.editedFilesBefore);
  const afterEdited = asStringArray(raw.editedFilesAfter);
  const inspectedBefore = asNumber(raw.hiddenPivotsInspectedBefore);
  const inspectedAfter = asNumber(raw.hiddenPivotsInspectedAfter);
  const editedBefore = asNumber(raw.hiddenPivotsEditedBefore);
  const editedAfter = asNumber(raw.hiddenPivotsEditedAfter);
  const conv = (b: number | null, a: number | null): number | null =>
    b !== null && a !== null ? Math.max(0, a - b) : null;

  return {
    instanceId: asString(raw.instanceId),
    beforeRunLabel: asString(raw.beforeLabel) ?? "unknown",
    afterRunLabel: asString(raw.afterLabel) ?? "unknown",
    pairType: "pivot_check_before_after",
    beforeTokens,
    afterTokens,
    tokenDelta: asNumber(raw.tokenDelta) ?? (beforeTokens !== null && afterTokens !== null ? delta(beforeTokens, afterTokens) : null),
    tokenDeltaPct:
      asNumber(raw.tokenDeltaPct) ?? (beforeTokens !== null && afterTokens !== null ? deltaPct(beforeTokens, afterTokens) : null),
    beforeCost,
    afterCost,
    costDelta: asNumber(raw.costDelta) ?? (beforeCost !== null && afterCost !== null ? delta(beforeCost, afterCost) : null),
    costDeltaPct:
      asNumber(raw.costDeltaPct) ?? (beforeCost !== null && afterCost !== null ? deltaPct(beforeCost, afterCost) : null),
    beforeResolved,
    afterResolved,
    resolvedChanged:
      typeof raw.resolvedChanged === "boolean"
        ? raw.resolvedChanged
        : beforeResolved !== null && afterResolved !== null
          ? beforeResolved !== afterResolved
          : false,
    beforeEditedFiles: beforeEdited,
    afterEditedFiles: afterEdited,
    editedFileSetChanged: editedFileSetChanged(beforeEdited, afterEdited),
    hiddenPivotsConvertedToInspected: conv(inspectedBefore, inspectedAfter),
    hiddenPivotsConvertedToEdited: conv(editedBefore, editedAfter),
    sourceReport,
  };
}

// ---------------------------------------------------------------------------
// Summary (pure)
// ---------------------------------------------------------------------------

export function buildSummary(runs: readonly LedgerRun[], pairs: readonly LedgerPair[]): LedgerSummary {
  const costs = runs.map((r) => r.cost).filter((c): c is number => c !== null);
  const tokenTotals = runs.map((r) => r.tokens.total).filter((t): t is number => t !== null);
  const totalCost = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;
  const resolutionKnown = runs.filter((r) => r.resolved !== null).length;
  const completeness: Record<DataCompleteness, number> = { complete: 0, partial: 0, metadata_only: 0, missing: 0 };
  for (const r of runs) completeness[r.dataCompleteness] += 1;

  return {
    totalRuns: runs.length,
    validVtraceRuns: runs.filter((r) => r.condition === "vtrace" && r.treatmentValid === true).length,
    runsWithOrderedToolLogs: runs.filter((r) => r.toolLogOrdered).length,
    runsWithResolutionKnown: resolutionKnown,
    runsWithResolutionUnknown: runs.length - resolutionKnown,
    totalCost,
    meanCostPerRun: costs.length > 0 ? totalCost! / costs.length : null,
    meanTokensPerRun: tokenTotals.length > 0 ? tokenTotals.reduce((a, b) => a + b, 0) / tokenTotals.length : null,
    pivotCheckPairs: pairs.filter((p) => p.pairType === "pivot_check_before_after").length,
    baselineVsVtracePairs: pairs.filter((p) => p.pairType === "baseline_vs_vtrace").length,
    completeness,
    resolutionMostlyUnknown: runs.length > 0 && resolutionKnown * 2 < runs.length,
  };
}

// A concrete, conservative next-step recommendation derived from the discovered
// data — never an aspirational claim beyond what the ledger supports.
export function recommendNextStep(summary: LedgerSummary): string[] {
  const recs: string[] = [];
  if (summary.resolutionMostlyUnknown) {
    recs.push(
      "1. Fill missing resolution data: most discovered runs have no evaluated resolved/pass status, so no pass@1 or unique-win claim is possible yet. Re-evaluate the existing run patches (docker or lightweight) to populate `resolved` before any comparative claim.",
    );
  }
  if (summary.baselineVsVtracePairs === 0) {
    recs.push(
      "2. Build baseline-vs-vtrace pairing: no run label currently carries both a baseline and a vtrace condition, so no within-task comparison exists. Run a small fixed subset with BOTH conditions per instance.",
    );
  } else {
    recs.push(
      `2. Extend the ${summary.baselineVsVtracePairs} baseline-vs-vtrace pair(s) into a fixed 10-task controlled subset run with both conditions per instance, so token/cost/resolution deltas are comparable across a stable set.`,
    );
  }
  recs.push(
    "3. Add a VEXP-style savings estimate ONLY where a baseline context size (or baseline token spend) is known for the same instance — never extrapolate savings from a vtrace-only run.",
  );
  return recs;
}

// ---------------------------------------------------------------------------
// Report assembly (pure)
// ---------------------------------------------------------------------------

const CONDITION_RANK: Record<string, number> = { vtrace: 0, baseline: 1, vexp: 2 };

export function buildReport(
  runs: readonly LedgerRun[],
  pairs: readonly LedgerPair[],
  resultsDir: string,
  generatedAt: string | null,
): LedgerReport {
  const sortedRuns = [...runs].sort((a, b) => {
    if (a.runLabel !== b.runLabel) return a.runLabel.localeCompare(b.runLabel);
    return (CONDITION_RANK[a.condition] ?? 9) - (CONDITION_RANK[b.condition] ?? 9);
  });
  const sortedPairs = [...pairs].sort((a, b) => {
    if (a.pairType !== b.pairType) return a.pairType.localeCompare(b.pairType);
    return a.afterRunLabel.localeCompare(b.afterRunLabel);
  });
  return {
    generatedAt,
    resultsDir,
    summary: buildSummary(sortedRuns, sortedPairs),
    runs: sortedRuns,
    pairs: sortedPairs,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderJson(report: LedgerReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function fmtNum(n: number | null, digits = 0): string {
  return n === null ? "unknown" : n.toFixed(digits);
}

function fmtBool(v: boolean | null): string {
  return v === null ? "unknown" : v ? "yes" : "no";
}

function fmtResolved(v: Resolution): string {
  return v === null ? "unknown" : v ? "resolved" : "unresolved";
}

function fmtList(values: readonly string[]): string {
  return values.length === 0 ? "—" : values.join(", ");
}

export function renderMarkdown(report: LedgerReport): string {
  const lines: string[] = [];
  const s = report.summary;
  lines.push("# Stage 5 outcome ledger");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Reporting / indexing only. No agents, no Docker, no retrieval / PIVOT_CHECK / telemetry " +
      "changes. Folds existing Stage 5 run artifacts into one outcome table for future " +
      "VTRACE-vs-baseline / VEXP-style measurement._",
  );
  lines.push("");

  // --- Summary -------------------------------------------------------------
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total runs discovered: ${s.totalRuns}`);
  lines.push(`- Valid VTRACE runs: ${s.validVtraceRuns}`);
  lines.push(`- Runs with ordered tool logs: ${s.runsWithOrderedToolLogs}`);
  lines.push(`- Runs with resolution known: ${s.runsWithResolutionKnown}`);
  lines.push(`- Runs with resolution unknown: ${s.runsWithResolutionUnknown}`);
  lines.push(`- Total cost (USD): ${fmtNum(s.totalCost, 4)}`);
  lines.push(`- Mean cost per run (USD): ${fmtNum(s.meanCostPerRun, 4)}`);
  lines.push(`- Mean tokens per run: ${fmtNum(s.meanTokensPerRun, 0)}`);
  lines.push(`- PIVOT_CHECK before/after pairs discovered: ${s.pivotCheckPairs}`);
  lines.push(`- baseline-vs-vtrace pairs discovered: ${s.baselineVsVtracePairs}`);
  lines.push("");
  if (s.resolutionMostlyUnknown) {
    lines.push(
      "> **Resolution is unknown for most runs.** No pass@1, resolved-rate, token-savings, or " +
        "unique-win claim can be made from this ledger yet — those require evaluated resolution and a " +
        "comparable baseline. See _Recommended next benchmark step_.",
    );
    lines.push("");
  }

  // --- What this ledger measures ------------------------------------------
  lines.push("## What this ledger measures");
  lines.push("");
  lines.push(
    "This ledger INDEXES existing artifacts; it does not evaluate. For each run it records the " +
      "protocol/treatment validity, PIVOT_CHECK state, tokens/cost, edited/read/searched files, " +
      "capsule pivots, ordered tool-call presence, hidden-pivot engagement (when both a capsule and " +
      "an ordered tool log exist), and resolution (ONLY when actually evaluated). It keeps four " +
      "signals strictly separate and never conflates them:",
  );
  lines.push("");
  lines.push("- **patch production** — a non-empty `modelPatch` was extracted.");
  lines.push("- **edited-file-set change** — the set of edited files differs across a pair.");
  lines.push("- **inspection conversion** — a hidden pivot moved from ignored → inspected/edited across a pair.");
  lines.push("- **docker resolution** — the SWE-bench evaluation said the patch resolves the task.");
  lines.push("");

  // --- Run inventory -------------------------------------------------------
  lines.push("## Run inventory");
  lines.push("");
  lines.push("| run label | cond | instance | protocol | treat. valid | pivot-check inj | tokens | cost | resolved | pivots | tool log | edited | completeness |");
  lines.push("| --- | --- | --- | --- | :---: | :---: | ---: | ---: | :---: | ---: | :---: | --- | --- |");
  for (const r of report.runs) {
    lines.push(
      `| ${r.runLabel} | ${r.condition} | ${r.instanceId ?? "unknown"} | ${r.protocol} | ${fmtBool(r.treatmentValid)} | ` +
        `${fmtBool(r.pivotCheckInjected)} | ${fmtNum(r.tokens.total)} | ${fmtNum(r.cost, 4)} | ${fmtResolved(r.resolved)} | ` +
        `${r.pivotCount ?? "?"} | ${r.toolLogOrdered ? "yes" : "no"} | ${fmtList(r.editedFiles)} | ${r.dataCompleteness} |`,
    );
  }
  lines.push("");

  // --- Pair inventory ------------------------------------------------------
  lines.push("## Pair inventory");
  lines.push("");
  if (report.pairs.length === 0) {
    lines.push("_No before/after or baseline-vs-vtrace pairs were detectable from the discovered artifacts._");
    lines.push("");
  } else {
    lines.push("| type | instance | before → after | token Δ | token Δ% | cost Δ | resolved Δ | edited-set Δ | →inspected | →edited | source |");
    lines.push("| --- | --- | --- | ---: | ---: | ---: | :---: | :---: | ---: | ---: | --- |");
    for (const p of report.pairs) {
      const resolvedDelta = `${fmtResolved(p.beforeResolved)}→${fmtResolved(p.afterResolved)}`;
      lines.push(
        `| ${p.pairType} | ${p.instanceId ?? "unknown"} | ${p.beforeRunLabel} → ${p.afterRunLabel} | ` +
          `${fmtNum(p.tokenDelta)} | ${fmtNum(p.tokenDeltaPct, 1)} | ${fmtNum(p.costDelta, 4)} | ${resolvedDelta} | ` +
          `${p.editedFileSetChanged ? "yes" : "no"} | ${p.hiddenPivotsConvertedToInspected ?? "—"} | ${p.hiddenPivotsConvertedToEdited ?? "—"} | ${p.sourceReport} |`,
      );
    }
    lines.push("");
  }

  // --- Token and cost summary ---------------------------------------------
  lines.push("## Token and cost summary");
  lines.push("");
  lines.push(`- Total cost across runs with known cost: ${fmtNum(s.totalCost, 4)} USD.`);
  lines.push(`- Mean cost per run (known-cost runs): ${fmtNum(s.meanCostPerRun, 4)} USD.`);
  lines.push(`- Mean tokens per run (known-token runs): ${fmtNum(s.meanTokensPerRun, 0)}.`);
  lines.push(
    "- Token/cost deltas live ONLY in the pair inventory; a standalone run's spend is not a saving " +
      "or a loss without a comparable counterpart.",
  );
  lines.push("");

  // --- Resolution summary --------------------------------------------------
  lines.push("## Resolution summary");
  lines.push("");
  lines.push(`- Resolution known: ${s.runsWithResolutionKnown} / ${s.totalRuns} runs.`);
  lines.push(`- Resolution unknown: ${s.runsWithResolutionUnknown} / ${s.totalRuns} runs.`);
  const resolvedRuns = report.runs.filter((r) => r.resolved === true).length;
  const evaluatedRuns = report.runs.filter((r) => r.resolved !== null).length;
  if (evaluatedRuns === 0) {
    lines.push("- **No run has an evaluated resolution — pass@1 / resolved-rate is not defined for this ledger.**");
  } else {
    lines.push(
      `- Of the ${evaluatedRuns} EVALUATED run(s), ${resolvedRuns} resolved. This is a resolved count over evaluated runs only — NOT a pass@1 over all runs.`,
    );
  }
  lines.push("");

  // --- Pivot inspection summary -------------------------------------------
  lines.push("## Pivot inspection summary");
  lines.push("");
  const withHidden = report.runs.filter((r) => r.hiddenPivotCount !== null);
  if (withHidden.length === 0) {
    lines.push("_No run had both a capsule pivot set and an ordered tool log, so per-run hidden-pivot engagement is unknown._");
  } else {
    lines.push("| run label | hidden pivots | inspected | edited | ignored |");
    lines.push("| --- | ---: | ---: | ---: | ---: |");
    for (const r of withHidden) {
      lines.push(
        `| ${r.runLabel} | ${r.hiddenPivotCount} | ${r.hiddenPivotsInspected} | ${r.hiddenPivotsEdited} | ${r.hiddenPivotsIgnored} |`,
      );
    }
    lines.push("");
    lines.push(
      "Inspection conversion across before/after pairs is in the pair inventory (`→inspected` / `→edited`). " +
        "Engagement here is per-run and is NOT a claim about patch correctness or resolution.",
    );
  }
  lines.push("");

  // --- Data completeness ---------------------------------------------------
  lines.push("## Data completeness");
  lines.push("");
  lines.push(`- complete: ${s.completeness.complete}`);
  lines.push(`- partial: ${s.completeness.partial}`);
  lines.push(`- metadata_only: ${s.completeness.metadata_only}`);
  lines.push(`- missing: ${s.completeness.missing}`);
  lines.push("");
  lines.push(
    "`complete` = meta + treatment status + tokens/cost + edited files + resolution all known. " +
      "`partial` = meta + some fields but resolution or ordered tool log missing. `metadata_only` = " +
      "meta but no tool log and no patch/result details. `missing` = run folder present but meta absent.",
  );
  lines.push("");

  // --- Recommended next benchmark step ------------------------------------
  lines.push("## Recommended next benchmark step");
  lines.push("");
  for (const rec of recommendNextStep(s)) lines.push(`- ${rec}`);
  lines.push("");

  // --- Non-claims ----------------------------------------------------------
  lines.push("## Non-claims");
  lines.push("");
  for (const claim of NON_CLAIMS) lines.push(`- ${claim}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Loading (impure)
// ---------------------------------------------------------------------------

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Read the FIRST non-empty JSON line of a swebench-*.jsonl in a condition dir.
async function readFirstSwebenchRecord(condDir: string): Promise<Record<string, unknown> | null> {
  let entries: string[];
  try {
    entries = await readdir(condDir);
  } catch {
    return null;
  }
  const jsonl = entries.filter((e) => e.startsWith("swebench-") && e.endsWith(".jsonl")).sort()[0];
  if (!jsonl) return null;
  try {
    const content = await readFile(path.join(condDir, jsonl), "utf8");
    const firstLine = content.split("\n").find((l) => l.trim() !== "");
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseToolCalls(raw: unknown): RawToolCall[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter(isRecord).map((t) => ({
    tool: asString(t.tool),
    category: asString(t.category),
    path: asString(t.path),
  }));
}

// Load all raw parts for one (runLabel, condition) condition dir.
export async function loadRunParts(runsDir: string, runLabel: string, condition: string): Promise<RawRunParts> {
  const condDir = path.join(runsDir, runLabel, "raw", condition);
  const metaPath = path.join(condDir, "_run.meta.json");
  const evalMetaPath = path.join(condDir, "_eval.meta.json");
  const toolCallsPath = path.join(condDir, "_tool_calls.json");

  const meta = (await readJsonFile(metaPath)) as Record<string, unknown> | null;
  const evalMeta = (await readJsonFile(evalMetaPath)) as Record<string, unknown> | null;
  const record = await readFirstSwebenchRecord(condDir);
  const toolCalls = parseToolCalls(await readJsonFile(toolCallsPath));

  const rawArtifactPaths: string[] = [];
  const rel = path.join("runs", runLabel, "raw", condition);
  if (meta !== null) rawArtifactPaths.push(path.join(rel, "_run.meta.json"));
  if (evalMeta !== null) rawArtifactPaths.push(path.join(rel, "_eval.meta.json"));
  if (record !== null) rawArtifactPaths.push(path.join(rel, "swebench-*.jsonl"));
  if (toolCalls !== null) rawArtifactPaths.push(path.join(rel, "_tool_calls.json"));

  return { runLabel, condition, meta, evalMeta, record, toolCalls, rawArtifactPaths };
}

// Enumerate every (runLabel, condition) under results/runs and build LedgerRuns.
export async function loadRuns(resultsDir: string): Promise<LedgerRun[]> {
  const runsDir = path.join(resultsDir, "runs");
  let labels: string[];
  try {
    labels = (await readdir(runsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const runs: LedgerRun[] = [];
  for (const label of labels.sort()) {
    const rawDir = path.join(runsDir, label, "raw");
    let conditions: string[];
    try {
      conditions = (await readdir(rawDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      // A run folder with no raw/ subtree: record a `missing` run.
      runs.push(buildRun({ runLabel: label, condition: "unknown", meta: null, evalMeta: null, record: null, toolCalls: null, rawArtifactPaths: [] }));
      continue;
    }
    for (const condition of conditions.sort()) {
      const parts = await loadRunParts(runsDir, label, condition);
      runs.push(buildRun(parts));
    }
  }
  return runs;
}

// Build baseline_vs_vtrace pairs from labels that carry BOTH conditions.
export function detectBaselineVtracePairs(runs: readonly LedgerRun[]): LedgerPair[] {
  const byLabel = new Map<string, LedgerRun[]>();
  for (const r of runs) {
    const list = byLabel.get(r.runLabel) ?? [];
    list.push(r);
    byLabel.set(r.runLabel, list);
  }
  const pairs: LedgerPair[] = [];
  for (const [label, group] of byLabel) {
    const baseline = group.find((r) => r.condition === "baseline");
    const vtrace = group.find((r) => r.condition === "vtrace");
    if (baseline && vtrace) pairs.push(buildBaselineVtracePair(label, baseline, vtrace));
  }
  return pairs;
}

// Load pivot_check_before_after pairs from the curated report JSONs. Dedupes by
// (beforeLabel, afterLabel, instanceId) — the targeted summary and a per-instance
// report can carry the same pair.
export async function loadPivotCheckPairs(resultsDir: string): Promise<LedgerPair[]> {
  const seen = new Set<string>();
  const pairs: LedgerPair[] = [];
  for (const name of PIVOT_CHECK_PAIR_REPORTS) {
    const raw = await readJsonFile(path.join(resultsDir, name));
    if (!isRecord(raw) || !Array.isArray(raw.pairs)) continue;
    for (const entry of raw.pairs) {
      if (!isRecord(entry)) continue;
      const normalized = normalizePivotCheckPair(entry, name);
      const key = `${normalized.beforeRunLabel}::${normalized.afterRunLabel}::${normalized.instanceId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(normalized);
    }
  }
  return pairs;
}

export async function buildLedger(resultsDir: string, generatedAt: string | null): Promise<LedgerReport> {
  const runs = await loadRuns(resultsDir);
  const baselinePairs = detectBaselineVtracePairs(runs);
  const pivotPairs = await loadPivotCheckPairs(resultsDir);
  return buildReport(runs, [...baselinePairs, ...pivotPairs], resultsDir, generatedAt);
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
  const report = await buildLedger(config.resultsDir, generatedAt);

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const s = report.summary;
  process.stdout.write(
    [
      "Stage 5 outcome ledger written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Runs: ${s.totalRuns}   Valid VTRACE: ${s.validVtraceRuns}   Resolution known: ${s.runsWithResolutionKnown}/${s.totalRuns}`,
      `Pairs: ${s.baselineVsVtracePairs} baseline-vs-vtrace, ${s.pivotCheckPairs} pivot-check before/after`,
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
