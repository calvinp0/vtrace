// Stage 5 Pivot Check comparison report generator.
//
// SCOPE: reporting / analysis ONLY. Given one or more before/after vtrace run
// label pairs (e.g. a PIVOT_CHECK-off run vs. a PIVOT_CHECK-on run on the same
// instance), this reads the RAW per-run artifacts already on disk and writes a
// reproducible Markdown + JSON report describing how each surfaced Capsule v2
// pivot's engagement changed — in particular whether a HIDDEN pivot moved out of
// `ignored` / `discovered-only` into `inspected` / `edited`.
//
// It changes NOTHING about retrieval, Capsule v2 scoring, prompt injection,
// telemetry capture, or benchmark run behavior. It reuses the existing,
// already-tested classifier (`classifyPivotInspection`) so the load-bearing
// definitions — a grep that surfaces a path is `discovered`, only a read/open is
// `inspected` — are not re-implemented or weakened here.
//
// This is NOT a public SWE-bench claim and NOT a claim that PIVOT_CHECK improves
// Docker resolution or guarantees correct edits. See `NON_CLAIMS` and the
// rendered "Non-claims" section.

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { editedFilesFromPatch, type PivotInspectionRecord } from "../../src/capsule/finalEditDiagnostics";
import {
  buildPivotInspection,
  hiddenPivotCountsFor,
  parseSweBenchRow,
  readOrderedToolCallLog,
  snapshotHasPivotCheck,
  totalTokens,
  type HiddenPivotCounts,
  type SweBenchRow,
} from "./run_stage5_capsule_v2_validation_report";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// A before/after run-label pair to compare. Both labels point at `vtrace`
// condition runs of the SAME instance; the only intended difference is whether
// PIVOT_CHECK enforcement was injected.
export interface PivotCheckPairSpec {
  beforeLabel: string;
  afterLabel: string;
}

// The terminal "phase" a pivot reached in one run. `discovered_only` is broken
// out from `ignored` (its terminal status in the classifier) so before/after
// conversion can distinguish a search-surfaced pivot from one never touched at
// all. `not_comparable` means the pivot was absent from that run's pivot set.
export type PivotPhase = "ignored" | "discovered_only" | "inspected" | "edited" | "not_comparable";

// How one pivot's engagement changed from the before run to the after run. The
// enumerated values below are the spec's suggested set; `inspected_to_edited` is
// an honest extra for the (rare) read-then-edit improvement that the suggested
// set omits.
export type ConversionValue =
  | "ignored_to_inspected"
  | "ignored_to_edited"
  | "discovered_only_to_inspected"
  | "discovered_only_to_edited"
  | "inspected_to_edited"
  | "unchanged_ignored"
  | "unchanged_inspected"
  | "unchanged_edited"
  | "regressed_to_ignored"
  | "not_comparable";

// Everything loaded for one side (before or after) of a pair.
export interface PivotCheckRun {
  label: string;
  // null when the run's JSONL record is missing entirely.
  row: SweBenchRow | null;
  treatmentValid: boolean | null;
  // Whether the PIVOT_CHECK block is actually present in the injected snapshot
  // (ground truth from `_vtrace_instructions.snapshot.md`).
  pivotCheckInjected: boolean;
  // PIVOT_CHECK feature state from `_run.meta.json`. `enabled` is false only when
  // the run passed --disable-pivot-check; `disabledByFlag` mirrors that flag.
  // Both null on older runs whose meta predates these fields. Together they let
  // the report tell a controlled "before" (disabled by flag) apart from a failed
  // or naturally-absent injection.
  pivotCheckEnabled: boolean | null;
  pivotCheckDisabledByFlag: boolean | null;
  checklistEmitted: boolean | null;
  // true => a real ORDERED `_tool_calls.json` was loaded; false => only aggregate
  // counts were available (inspection signals degrade to patch-only); null => no
  // tool evidence at all.
  toolLogOrdered: boolean | null;
  toolCallCount: number | null;
  records: PivotInspectionRecord[];
  editedFiles: string[];
  hiddenCounts: HiddenPivotCounts;
}

// One pivot compared across before/after, keyed by path::symbol.
export interface PivotConversionRow {
  path: string;
  symbol: string;
  hidden: boolean;
  beforeDiscovered: boolean;
  beforeInspected: boolean;
  beforeEdited: boolean;
  beforeStatus: string;
  afterDiscovered: boolean;
  afterInspected: boolean;
  afterEdited: boolean;
  afterStatus: string;
  conversion: ConversionValue;
}

// The full per-pair summary (the spec's required-fields list, verbatim).
export interface PivotCheckPair {
  beforeLabel: string;
  afterLabel: string;
  instanceId: string;

  treatmentValidBefore: boolean | null;
  treatmentValidAfter: boolean | null;

  beforeTokens: number;
  afterTokens: number;
  tokenDelta: number;
  tokenDeltaPct: number;

  beforeCost: number;
  afterCost: number;
  costDelta: number;
  costDeltaPct: number;

  beforeResolved: boolean | null;
  afterResolved: boolean | null;
  resolvedChanged: boolean;

  pivotCheckInjectedBefore: boolean;
  pivotCheckInjectedAfter: boolean;

  // Feature/flag state, so a "before" run (PIVOT_CHECK disabled by flag) is never
  // confused with a failed injection. null on runs whose meta predates the flag.
  pivotCheckEnabledBefore: boolean | null;
  pivotCheckEnabledAfter: boolean | null;
  pivotCheckDisabledByFlagBefore: boolean | null;
  pivotCheckDisabledByFlagAfter: boolean | null;

  checklistEmittedBefore: boolean | null;
  checklistEmittedAfter: boolean | null;

  toolLogOrderedBefore: boolean | null;
  toolLogOrderedAfter: boolean | null;
  toolCallCountBefore: number | null;
  toolCallCountAfter: number | null;

  hiddenPivotCountBefore: number;
  hiddenPivotCountAfter: number;

  hiddenPivotsIgnoredBefore: number;
  hiddenPivotsIgnoredAfter: number;

  hiddenPivotsDiscoveredOnlyBefore: number;
  hiddenPivotsDiscoveredOnlyAfter: number;

  hiddenPivotsInspectedBefore: number;
  hiddenPivotsInspectedAfter: number;

  hiddenPivotsEditedBefore: number;
  hiddenPivotsEditedAfter: number;

  editedFilesBefore: string[];
  editedFilesAfter: string[];

  // Per-pivot conversion detail (all pivots, hidden flagged).
  pivots: PivotConversionRow[];
}

export interface PivotCheckReport {
  generatedAt: string | null;
  scope: string;
  pairs: PivotCheckPair[];
  summary: PivotCheckSummary;
  safeInterpretation: string;
  nonClaims: string[];
}

export interface PivotCheckSummary {
  pairCount: number;
  // Hidden pivots that moved from ignored/discovered-only into inspected/edited.
  hiddenPivotsConverted: number;
  // Hidden pivots that regressed out of inspected/edited.
  hiddenPivotsRegressed: number;
  // Tally of every conversion value seen, across all pairs' pivots.
  conversionCounts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REPORT_SCOPE =
  "Stage 5 PIVOT_CHECK before/after comparison: per-pivot engagement (ignored / " +
  "discovered-only / inspected / edited) for one or more vtrace run-label pairs on a " +
  "fixed instance. Reporting only — no retrieval, scoring, injection, or run behavior changed.";

// Claims this report MUST NOT make. Rendered verbatim in the Markdown and
// asserted by the test suite, so editing these is a deliberate, tested change.
export const NON_CLAIMS: readonly string[] = [
  "PIVOT_CHECK improves Docker resolution.",
  "PIVOT_CHECK guarantees correct edits.",
  "Checklist emission is required for compliance.",
  "One sphinx-7462 run proves broad benchmark improvement.",
  "This is a public SWE-bench result.",
];

export const SAFE_INTERPRETATION =
  "On sphinx-7462, PIVOT_CHECK converted the hidden pivot from discovered-only / " +
  "ignored to inspected. Docker resolution and patch correctness remain separate outcomes.";

// `vtrace` condition subdirectory under `results/runs/<label>/raw/`. Both sides of
// a PIVOT_CHECK pair are vtrace runs; overridable via CLI for future label sets.
export const DEFAULT_CONDITION = "vtrace";

export const DEFAULT_RESULTS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "results",
);

export const DEFAULT_REPORT_NAME = "stage5_pivot_check";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// after - before. Positive means the after run used more.
export function delta(before: number, after: number): number {
  return after - before;
}

// Percentage change from before to after. 0 when before is 0 (no basis).
export function deltaPct(before: number, after: number): number {
  if (!Number.isFinite(before) || before === 0) return 0;
  return ((after - before) / before) * 100;
}

// Reduce one classifier record to its terminal phase, breaking `discovered_only`
// out of `ignored`. null record (pivot absent from that run) => not_comparable.
export function pivotPhase(record: PivotInspectionRecord | null | undefined): PivotPhase {
  if (!record) return "not_comparable";
  if (record.edited) return "edited";
  if (record.inspected) return "inspected";
  if (record.discovered) return "discovered_only";
  return "ignored";
}

const PHASE_RANK: Record<Exclude<PivotPhase, "not_comparable">, number> = {
  ignored: 0,
  discovered_only: 1,
  inspected: 2,
  edited: 3,
};

// Map a before-phase / after-phase pair onto a conversion label. Deterministic
// and total over all phase pairs. `discovered_only` ranks above `ignored` but
// both are terminally "ignored", so an ignored→discovered_only move (more
// visibility, still untouched) reads as `unchanged_ignored`, and a
// discovered_only→ignored move is not a real regression.
export function classifyConversion(before: PivotPhase, after: PivotPhase): ConversionValue {
  if (before === "not_comparable" || after === "not_comparable") return "not_comparable";

  if (before === after) {
    if (after === "edited") return "unchanged_edited";
    if (after === "inspected") return "unchanged_inspected";
    return "unchanged_ignored"; // ignored or discovered_only: terminally ignored
  }

  if (PHASE_RANK[after] > PHASE_RANK[before]) {
    // Engagement improved.
    if (after === "inspected") {
      return before === "discovered_only" ? "discovered_only_to_inspected" : "ignored_to_inspected";
    }
    if (after === "edited") {
      if (before === "discovered_only") return "discovered_only_to_edited";
      if (before === "inspected") return "inspected_to_edited";
      return "ignored_to_edited";
    }
    // after === "discovered_only" from "ignored": still terminally ignored.
    return "unchanged_ignored";
  }

  // Engagement decreased.
  if (before === "inspected" || before === "edited") return "regressed_to_ignored";
  // discovered_only -> ignored: both terminally ignored, not a real regression.
  return "unchanged_ignored";
}

// Index a run's pivot records by `path::symbol` for before/after matching.
function recordKey(path: string, symbol: string): string {
  return `${path}::${symbol}`;
}

function indexRecords(records: readonly PivotInspectionRecord[]): Map<string, PivotInspectionRecord> {
  const map = new Map<string, PivotInspectionRecord>();
  for (const record of records) map.set(recordKey(record.path, record.symbol), record);
  return map;
}

// Build the per-pivot conversion rows for one pair, over the union of pivots seen
// in either run (so a pivot that appears on only one side renders as
// not_comparable rather than vanishing).
export function buildConversionRows(
  before: readonly PivotInspectionRecord[],
  after: readonly PivotInspectionRecord[],
): PivotConversionRow[] {
  const beforeMap = indexRecords(before);
  const afterMap = indexRecords(after);
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const record of [...before, ...after]) {
    const key = recordKey(record.path, record.symbol);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }

  return keys.map((key) => {
    const b = beforeMap.get(key) ?? null;
    const a = afterMap.get(key) ?? null;
    const ref = b ?? a!; // at least one side is present by construction
    return {
      path: ref.path,
      symbol: ref.symbol,
      // A pivot is hidden if either run classified it hidden.
      hidden: Boolean(b?.hidden) || Boolean(a?.hidden),
      beforeDiscovered: Boolean(b?.discovered),
      beforeInspected: Boolean(b?.inspected),
      beforeEdited: Boolean(b?.edited),
      beforeStatus: b ? b.status : "not_comparable",
      afterDiscovered: Boolean(a?.discovered),
      afterInspected: Boolean(a?.inspected),
      afterEdited: Boolean(a?.edited),
      afterStatus: a ? a.status : "not_comparable",
      conversion: classifyConversion(pivotPhase(b), pivotPhase(a)),
    };
  });
}

// Conversion values that represent a hidden pivot gaining real engagement.
const CONVERSIONS_IMPROVED = new Set<ConversionValue>([
  "ignored_to_inspected",
  "ignored_to_edited",
  "discovered_only_to_inspected",
  "discovered_only_to_edited",
  "inspected_to_edited",
]);

export function summarize(pairs: readonly PivotCheckPair[]): PivotCheckSummary {
  const conversionCounts: Record<string, number> = {};
  let hiddenPivotsConverted = 0;
  let hiddenPivotsRegressed = 0;
  for (const pair of pairs) {
    for (const pivot of pair.pivots) {
      conversionCounts[pivot.conversion] = (conversionCounts[pivot.conversion] ?? 0) + 1;
      if (!pivot.hidden) continue;
      if (CONVERSIONS_IMPROVED.has(pivot.conversion)) hiddenPivotsConverted += 1;
      if (pivot.conversion === "regressed_to_ignored") hiddenPivotsRegressed += 1;
    }
  }
  return {
    pairCount: pairs.length,
    hiddenPivotsConverted,
    hiddenPivotsRegressed,
    conversionCounts,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

// First non-empty JSONL record in the single `swebench-*.jsonl` under `dir`.
async function readFirstJsonlRecord(dir: string): Promise<Record<string, unknown> | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of entries.filter((e) => e.endsWith(".jsonl")).sort()) {
    const text = await readTextFile(path.join(dir, name));
    if (!text) continue;
    const firstLine = text.split("\n").find((line) => line.trim() !== "");
    if (!firstLine) continue;
    try {
      const parsed = JSON.parse(firstLine);
      if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // try next file
    }
  }
  return null;
}

function asNullableBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface LoadOptions {
  runsDir: string;
  condition?: string;
}

// Load one side of a pair from disk. Degrades honestly: a missing JSONL record
// yields `row: null` (and zeroed token/cost) rather than throwing; a missing
// `_tool_calls.json` yields `toolLogOrdered: false` (patch-only inspection) via
// the shared `buildPivotInspection`.
export async function loadRun(label: string, options: LoadOptions): Promise<PivotCheckRun> {
  const condition = options.condition ?? DEFAULT_CONDITION;
  const runDir = path.join(options.runsDir, label, "raw", condition);

  const record = await readFirstJsonlRecord(runDir);
  const runMeta = (await readJsonFile(path.join(runDir, "_run.meta.json"))) ?? {};
  const snapshot = await readTextFile(
    path.join(options.runsDir, label, "_vtrace_instructions.snapshot.md"),
  );
  const orderedCalls = await readOrderedToolCallLog(runDir);

  const row = record === null ? null : parseSweBenchRow(record);
  const inspection = buildPivotInspection(runMeta, record, orderedCalls);
  const patch =
    record === null
      ? ""
      : typeof record.modelPatch === "string"
        ? record.modelPatch
        : typeof record.patch === "string"
          ? record.patch
          : "";

  const toolCallCount =
    orderedCalls !== null ? orderedCalls.length : asNullableNumber(runMeta.vtraceToolCallCount);

  return {
    label,
    row,
    treatmentValid: asNullableBool(runMeta.vtraceTreatmentValid),
    pivotCheckInjected: snapshotHasPivotCheck(snapshot),
    pivotCheckEnabled: asNullableBool(runMeta.vtracePivotCheckEnabled),
    pivotCheckDisabledByFlag: asNullableBool(runMeta.vtracePivotCheckDisabledByFlag),
    checklistEmitted: asNullableBool(runMeta.vtracePivotChecklistEmitted),
    toolLogOrdered: inspection.toolLogOrdered,
    toolCallCount,
    records: inspection.records,
    editedFiles: editedFilesFromPatch(patch),
    hiddenCounts: hiddenPivotCountsFor(inspection.records),
  };
}

function rowTokens(row: SweBenchRow | null): number {
  return row === null ? 0 : totalTokens(row);
}

function rowCost(row: SweBenchRow | null): number {
  return row === null ? 0 : row.costUsd;
}

function instanceIdOf(before: PivotCheckRun, after: PivotCheckRun): string {
  return after.row?.instanceId || before.row?.instanceId || "(unknown)";
}

// Assemble a fully-resolved comparison for one before/after label pair.
export async function loadPair(
  spec: PivotCheckPairSpec,
  options: LoadOptions,
): Promise<PivotCheckPair> {
  const before = await loadRun(spec.beforeLabel, options);
  const after = await loadRun(spec.afterLabel, options);
  return buildPair(before, after);
}

// Build the pair summary from two already-loaded runs (kept separate from disk
// I/O so tests can drive it with in-memory runs).
export function buildPair(before: PivotCheckRun, after: PivotCheckRun): PivotCheckPair {
  const beforeTokens = rowTokens(before.row);
  const afterTokens = rowTokens(after.row);
  const beforeCost = rowCost(before.row);
  const afterCost = rowCost(after.row);
  const beforeResolved = before.row?.resolved ?? null;
  const afterResolved = after.row?.resolved ?? null;
  const pivots = buildConversionRows(before.records, after.records);

  return {
    beforeLabel: before.label,
    afterLabel: after.label,
    instanceId: instanceIdOf(before, after),

    treatmentValidBefore: before.treatmentValid,
    treatmentValidAfter: after.treatmentValid,

    beforeTokens,
    afterTokens,
    tokenDelta: delta(beforeTokens, afterTokens),
    tokenDeltaPct: deltaPct(beforeTokens, afterTokens),

    beforeCost,
    afterCost,
    costDelta: delta(beforeCost, afterCost),
    costDeltaPct: deltaPct(beforeCost, afterCost),

    beforeResolved,
    afterResolved,
    resolvedChanged: beforeResolved !== afterResolved,

    pivotCheckInjectedBefore: before.pivotCheckInjected,
    pivotCheckInjectedAfter: after.pivotCheckInjected,

    pivotCheckEnabledBefore: before.pivotCheckEnabled,
    pivotCheckEnabledAfter: after.pivotCheckEnabled,
    pivotCheckDisabledByFlagBefore: before.pivotCheckDisabledByFlag,
    pivotCheckDisabledByFlagAfter: after.pivotCheckDisabledByFlag,

    checklistEmittedBefore: before.checklistEmitted,
    checklistEmittedAfter: after.checklistEmitted,

    toolLogOrderedBefore: before.toolLogOrdered,
    toolLogOrderedAfter: after.toolLogOrdered,
    toolCallCountBefore: before.toolCallCount,
    toolCallCountAfter: after.toolCallCount,

    hiddenPivotCountBefore: before.records.filter((r) => r.hidden).length,
    hiddenPivotCountAfter: after.records.filter((r) => r.hidden).length,

    hiddenPivotsIgnoredBefore: before.hiddenCounts.ignored,
    hiddenPivotsIgnoredAfter: after.hiddenCounts.ignored,

    hiddenPivotsDiscoveredOnlyBefore: before.hiddenCounts.discoveredOnly,
    hiddenPivotsDiscoveredOnlyAfter: after.hiddenCounts.discoveredOnly,

    hiddenPivotsInspectedBefore: before.hiddenCounts.inspected,
    hiddenPivotsInspectedAfter: after.hiddenCounts.inspected,

    hiddenPivotsEditedBefore: before.hiddenCounts.edited,
    hiddenPivotsEditedAfter: after.hiddenCounts.edited,

    editedFilesBefore: before.editedFiles,
    editedFilesAfter: after.editedFiles,

    pivots,
  };
}

export async function buildReport(
  specs: readonly PivotCheckPairSpec[],
  options: LoadOptions,
  generatedAt: string | null,
): Promise<PivotCheckReport> {
  const pairs: PivotCheckPair[] = [];
  for (const spec of specs) pairs.push(await loadPair(spec, options));
  return {
    generatedAt,
    scope: REPORT_SCOPE,
    pairs,
    summary: summarize(pairs),
    safeInterpretation: SAFE_INTERPRETATION,
    nonClaims: [...NON_CLAIMS],
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function boolMark(value: boolean | null | undefined): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "—";
}

function resolvedMark(value: boolean | null): string {
  if (value === true) return "resolved";
  if (value === false) return "unresolved";
  return "not evaluated";
}

// Disambiguated PIVOT_CHECK state for one run side, so a controlled "before" run
// (PIVOT_CHECK disabled via --disable-pivot-check) is never read as a failed or
// accidentally-absent injection. Order matters: an explicit flag-disable is the
// strongest signal, then a real injection, then the honest "enabled but not
// injected" case (e.g. a single-pivot capsule), then unknowns.
export function pivotCheckStateLabel(
  injected: boolean,
  enabled: boolean | null,
  disabledByFlag: boolean | null,
): string {
  if (disabledByFlag === true) return "disabled (flag)";
  if (injected) return "injected";
  if (enabled === true) return "enabled, not injected";
  if (enabled === false) return "disabled (flag)";
  return "not injected";
}

function fmtPct(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function fmtSigned(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value}`;
}

function fmtCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

function fmtFiles(files: readonly string[]): string {
  return files.length === 0 ? "—" : files.join(", ");
}

export function renderJson(report: PivotCheckReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderMarkdown(report: PivotCheckReport): string {
  const lines: string[] = [];
  lines.push("# Stage 5 Pivot Check comparison");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(`_Scope: ${report.scope}_`);
  lines.push("");

  // --- Summary -------------------------------------------------------------
  const s = report.summary;
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Compared pairs: ${s.pairCount}`);
  lines.push(`- Hidden pivots converted (gained inspection/edit): ${s.hiddenPivotsConverted}`);
  lines.push(`- Hidden pivots regressed (lost inspection/edit): ${s.hiddenPivotsRegressed}`);
  const convEntries = Object.entries(s.conversionCounts).sort(([a], [b]) => a.localeCompare(b));
  if (convEntries.length > 0) {
    lines.push("- Conversion tally:");
    for (const [value, count] of convEntries) lines.push(`  - \`${value}\`: ${count}`);
  }
  lines.push("");

  // --- Compared runs -------------------------------------------------------
  lines.push("## Compared runs");
  lines.push("");
  lines.push(
    "| instance | before label | after label | treatment valid (before→after) | " +
      "pivot-check injected (before→after) | PIVOT_CHECK state (before→after) |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const p of report.pairs) {
    const beforeState = pivotCheckStateLabel(
      p.pivotCheckInjectedBefore,
      p.pivotCheckEnabledBefore,
      p.pivotCheckDisabledByFlagBefore,
    );
    const afterState = pivotCheckStateLabel(
      p.pivotCheckInjectedAfter,
      p.pivotCheckEnabledAfter,
      p.pivotCheckDisabledByFlagAfter,
    );
    lines.push(
      `| ${p.instanceId} | \`${p.beforeLabel}\` | \`${p.afterLabel}\` | ` +
        `${boolMark(p.treatmentValidBefore)} → ${boolMark(p.treatmentValidAfter)} | ` +
        `${boolMark(p.pivotCheckInjectedBefore)} → ${boolMark(p.pivotCheckInjectedAfter)} | ` +
        `${beforeState} → ${afterState} |`,
    );
  }
  lines.push("");
  lines.push(
    "PIVOT_CHECK state disambiguates a controlled before run from a failed injection: " +
      "`disabled (flag)` = the run passed `--disable-pivot-check` (a deliberate before " +
      "condition); `enabled, not injected` = PIVOT_CHECK was on but no block was emitted " +
      "(e.g. a single-pivot capsule); `injected` = the block was present.",
  );
  lines.push("");

  // --- Hidden pivot conversion --------------------------------------------
  lines.push("## Hidden pivot conversion");
  lines.push("");
  lines.push(
    "Per-pivot engagement, before vs. after. `discovered` = surfaced in a search " +
      "but not opened; `inspected` = the file's contents were read/opened; `edited` = " +
      "the final patch touched the file. `discovered` alone never counts as inspection.",
  );
  lines.push("");
  for (const p of report.pairs) {
    lines.push(`### ${p.instanceId}`);
    lines.push("");
    lines.push(
      "| path | symbol | hidden | before disc | before insp | before edit | before status | " +
        "after disc | after insp | after edit | after status | conversion |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const piv of p.pivots) {
      lines.push(
        `| \`${piv.path}\` | \`${piv.symbol}\` | ${boolMark(piv.hidden)} | ` +
          `${boolMark(piv.beforeDiscovered)} | ${boolMark(piv.beforeInspected)} | ${boolMark(piv.beforeEdited)} | ${piv.beforeStatus} | ` +
          `${boolMark(piv.afterDiscovered)} | ${boolMark(piv.afterInspected)} | ${boolMark(piv.afterEdited)} | ${piv.afterStatus} | ` +
          `\`${piv.conversion}\` |`,
      );
    }
    lines.push("");
    lines.push(
      `Hidden-pivot counts — before: ignored ${p.hiddenPivotsIgnoredBefore} ` +
        `(discovered-only ${p.hiddenPivotsDiscoveredOnlyBefore}), inspected ${p.hiddenPivotsInspectedBefore}, ` +
        `edited ${p.hiddenPivotsEditedBefore}; after: ignored ${p.hiddenPivotsIgnoredAfter} ` +
        `(discovered-only ${p.hiddenPivotsDiscoveredOnlyAfter}), inspected ${p.hiddenPivotsInspectedAfter}, ` +
        `edited ${p.hiddenPivotsEditedAfter}.`,
    );
    lines.push("");
  }

  // --- Tool evidence -------------------------------------------------------
  lines.push("## Tool evidence");
  lines.push("");
  lines.push(
    "Checklist emission is the agent echoing a PIVOT_CHECK section; it is NOT the source " +
      "of truth. Ordered tool evidence (`_tool_calls.json`) is. A run can show " +
      "`checklist emitted: no` while tool evidence still shows direct inspection.",
  );
  lines.push("");
  lines.push("| instance | tool log ordered (before→after) | tool calls (before→after) | checklist emitted (before→after) |");
  lines.push("| --- | --- | --- | --- |");
  for (const p of report.pairs) {
    lines.push(
      `| ${p.instanceId} | ${boolMark(p.toolLogOrderedBefore)} → ${boolMark(p.toolLogOrderedAfter)} | ` +
        `${p.toolCallCountBefore ?? "—"} → ${p.toolCallCountAfter ?? "—"} | ` +
        `${boolMark(p.checklistEmittedBefore)} → ${boolMark(p.checklistEmittedAfter)} |`,
    );
  }
  lines.push("");

  // --- Cost / token delta --------------------------------------------------
  lines.push("## Cost / token delta");
  lines.push("");
  lines.push("Delta is after − before (positive = the after run spent more).");
  lines.push("");
  lines.push("| instance | before tokens | after tokens | token Δ | token Δ% | before cost | after cost | cost Δ | cost Δ% |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const p of report.pairs) {
    lines.push(
      `| ${p.instanceId} | ${p.beforeTokens} | ${p.afterTokens} | ${fmtSigned(p.tokenDelta)} | ${fmtPct(p.tokenDeltaPct)} | ` +
        `${fmtCost(p.beforeCost)} | ${fmtCost(p.afterCost)} | ${fmtCost(p.costDelta)} | ${fmtPct(p.costDeltaPct)} |`,
    );
  }
  lines.push("");

  // --- Patch / resolution outcome -----------------------------------------
  lines.push("## Patch / resolution outcome");
  lines.push("");
  lines.push("| instance | before resolved | after resolved | resolved changed | edited files before | edited files after |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const p of report.pairs) {
    lines.push(
      `| ${p.instanceId} | ${resolvedMark(p.beforeResolved)} | ${resolvedMark(p.afterResolved)} | ${boolMark(p.resolvedChanged)} | ` +
        `${fmtFiles(p.editedFilesBefore)} | ${fmtFiles(p.editedFilesAfter)} |`,
    );
  }
  lines.push("");

  // --- Interpretation ------------------------------------------------------
  lines.push("## Interpretation");
  lines.push("");
  lines.push(report.safeInterpretation);
  lines.push("");

  // --- Non-claims ----------------------------------------------------------
  lines.push("## Non-claims");
  lines.push("");
  lines.push("This report does NOT claim:");
  lines.push("");
  for (const claim of report.nonClaims) lines.push(`- ${claim}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface ReportCliConfig {
  resultsDir: string;
  runsDir: string;
  outDir: string;
  condition: string;
  reportName: string;
  pairs: PivotCheckPairSpec[];
}

// Parse a `before,after` pair argument into a spec.
export function parsePairArg(value: string): PivotCheckPairSpec {
  const parts = value.split(",").map((s) => s.trim());
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    throw new Error(`--pair expects "beforeLabel,afterLabel", got "${value}".`);
  }
  return { beforeLabel: parts[0]!, afterLabel: parts[1]! };
}

export function parseReportArgs(argv: readonly string[]): ReportCliConfig {
  let resultsDir = DEFAULT_RESULTS_DIR;
  let runsDir: string | null = null;
  let outDir: string | null = null;
  let condition = DEFAULT_CONDITION;
  let reportName = DEFAULT_REPORT_NAME;
  const pairs: PivotCheckPairSpec[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--results":
        resultsDir = next();
        break;
      case "--runs-dir":
        runsDir = next();
        break;
      case "--out":
        outDir = next();
        break;
      case "--condition":
        condition = next();
        break;
      case "--report-name":
        reportName = next();
        break;
      case "--pair":
        pairs.push(parsePairArg(next()));
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (pairs.length === 0) {
    throw new Error("At least one --pair beforeLabel,afterLabel is required.");
  }

  return {
    resultsDir,
    runsDir: runsDir ?? path.join(resultsDir, "runs"),
    outDir: outDir ?? resultsDir,
    condition,
    reportName,
    pairs,
  };
}

async function main(config: ReportCliConfig): Promise<void> {
  const generatedAt = new Date().toISOString();
  const report = await buildReport(
    config.pairs,
    { runsDir: config.runsDir, condition: config.condition },
    generatedAt,
  );

  await mkdir(config.outDir, { recursive: true });
  const mdPath = path.join(config.outDir, `${config.reportName}.md`);
  const jsonPath = path.join(config.outDir, `${config.reportName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const s = report.summary;
  process.stdout.write(
    [
      "Stage 5 Pivot Check comparison report written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Compared pairs:            ${s.pairCount}`,
      `Hidden pivots converted:   ${s.hiddenPivotsConverted}`,
      `Hidden pivots regressed:   ${s.hiddenPivotsRegressed}`,
      "",
    ].join("\n"),
  );
}

if (import.meta.main) {
  try {
    await main(parseReportArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
