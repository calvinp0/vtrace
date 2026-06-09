// Stage 5 Capsule v2 force-inject validation report generator.
//
// SCOPE: This is a Stage 5 *smoke* validation. It compares a set of named
// baseline run labels against a set of named Capsule v2 run labels on a fixed
// set of Django SWE-bench smoke instances, and writes a reproducible,
// auditable report (.md / .json / .csv) from the RAW per-run JSONL + meta
// files under `results/runs/<label>/`.
//
// It is NOT a public SWE-bench pass@1 claim and NOT a vtrace-vs-vexp claim.
// See `NON_CLAIMS` below and the rendered "Caveats / non-claims" section.
//
// The runner (`run_stage5_vexp_swe_bench_smoke.ts`) stays untouched: this is a
// standalone read-only reporter so the live runner stays clean.

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  classifyPivotInspection,
  editedFilesFromPatch,
  type InspectionToolCall,
  type PivotForInspection,
  type PivotInspectionRecord,
} from "../../src/capsule/finalEditDiagnostics";
import { inspectionCallsFromLog } from "../../src/capsule/toolCallLog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// A baseline -> [baselineLabel, capsuleLabel] mapping. The first label is the
// baseline run, the second is the Capsule v2 force-inject run. Keyed by
// SWE-bench instance id.
export type ValidationLabelMap = Record<string, [string, string]>;

// One parsed row from a `swebench-*.jsonl` results file. Only the fields the
// report needs; extra fields are ignored.
export interface SweBenchRow {
  instanceId: string;
  resolved: boolean | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  commitHash: string | null;
  model: string | null;
  agent: string | null;
}

// Capsule v2 audit metadata, extracted from the capsule run's `_run.meta.json`
// plus the injected-instructions snapshot.
export interface CapsuleMeta {
  engine: string | null;
  intent: string | null;
  budget: number | null;
  estimatedTokens: number | null;
  actualMode: string | null;
  topPivotFile: string | null;
  topPivotSymbol: string | null;
  topPivotHasSource: boolean | null;
  pivotSourceChars: number | null;
  pivotSourceMode: string | null;
  contextPolicyOverride: string | null;
  policyReason: string | null;
  treatmentValid: boolean | null;
  injectionObserved: boolean | null;
  freshWorkspace: boolean | null;
  indexStartedAt: string | null;
  indexFinishedAt: string | null;
  indexDurationMs: number | null;
  snapshotPath: string | null;
  snapshotSha256: string | null;
  snapshotExists: boolean;
  editRiskDirectivePresent: boolean;
}

// A fully-resolved instance comparison: baseline row, capsule row, capsule
// metadata, and the labels they came from.
export interface ValidationPair {
  instanceId: string;
  baselineLabel: string;
  capsuleLabel: string;
  baseline: SweBenchRow;
  capsule: SweBenchRow;
  capsuleMeta: CapsuleMeta;
  // Post-hoc pivot-inspection classification (one record per surfaced Capsule v2
  // pivot/support item). Optional so older fixtures and partial runs still build;
  // loadPair always populates it.
  pivotInspection?: PivotInspectionRecord[];
  // Whether the capsule run's result record carried an ORDERED tool-call log
  // (with file targets). SWE-bench records usually report only aggregate tool
  // counts, in which case `inspected`/`discovered` cannot be observed and read as
  // false-by-absence rather than confirmed-not-inspected. null when no record.
  pivotInspectionToolLogOrdered?: boolean | null;
}

// Per-task percentage reductions (positive = capsule used less than baseline).
export interface PairReduction {
  tokenReductionPct: number;
  costReductionPct: number;
  durationReductionPct: number;
}

export interface AggregateMetrics {
  instanceCount: number;
  resolvedBaseline: number;
  resolvedCapsule: number;
  meanPerTaskTokenReductionPct: number;
  pooledBaselineTokens: number;
  pooledCapsuleTokens: number;
  pooledTokenReductionPct: number;
  pooledBaselineCostUsd: number;
  pooledCapsuleCostUsd: number;
  pooledCostReductionPct: number;
  pooledBaselineDurationMs: number;
  pooledCapsuleDurationMs: number;
  pooledDurationReductionPct: number;
}

export interface ValidationReport {
  generatedAt: string | null;
  scope: string;
  protocol: string;
  instanceSet: string[];
  pairs: ValidationPair[];
  aggregate: AggregateMetrics;
  nonClaims: string[];
}

// ---------------------------------------------------------------------------
// Constants: scope, protocol wording, non-claims
// ---------------------------------------------------------------------------

export const REPORT_SCOPE =
  "Stage 5 Capsule v2 five-task force-inject validation on the Django SWE-bench smoke set.";

export const REPORT_PROTOCOL =
  "vtrace-indexed protocol with forced Capsule v2 injection " +
  "(--protocol vtrace-indexed --context-policy force-inject --capsule-engine v2 " +
  "--capsule-intent debug --capsule-budget 8000). Baseline is the identical " +
  "`run --no-vexp` command with no vtrace context injected.";

// Caveats the report MUST state. Rendered verbatim in the Markdown report and
// asserted by the test suite, so editing these is a deliberate, tested change.
export const NON_CLAIMS: readonly string[] = [
  "This validation used forced Capsule v2 injection (--context-policy force-inject), not the auto context policy.",
  "This validation used five Django SWE-bench smoke instances only.",
  "This is NOT a public SWE-bench pass@1 claim.",
  "This is NOT a claim that vtrace beats vexp.",
  "This measures whether Capsule v2 context can preserve resolution while reducing live agent effort on this fixed smoke set.",
];

// Default location of the raw per-run results, relative to this file.
export const DEFAULT_RUNS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "results",
  "runs",
);
export const DEFAULT_OUT_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "results",
);
export const DEFAULT_LABEL_MAP = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "capsule_v2_validation_labels.json",
);

// Condition subdirectory under `results/runs/<label>/raw/` for each role. The
// baseline label dir holds a `baseline/` condition; the Capsule v2 label dir
// holds a `vtrace/` condition. Overridable via CLI for future label sets.
export const DEFAULT_BASELINE_CONDITION = "baseline";
export const DEFAULT_CAPSULE_CONDITION = "vtrace";

export const REPORT_BASENAME = "stage5_capsule_v2_validation";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// Sum of the four token components that make up a run's total token usage.
export function totalTokens(row: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  return (
    asNumber(row.inputTokens) +
    asNumber(row.outputTokens) +
    asNumber(row.cacheReadTokens) +
    asNumber(row.cacheCreationTokens)
  );
}

// Percentage reduction from baseline to treatment. Positive means the
// treatment used less. Returns 0 when the baseline is 0 (no basis to reduce).
export function reductionPct(baseline: number, treatment: number): number {
  if (!Number.isFinite(baseline) || baseline === 0) return 0;
  return ((baseline - treatment) / baseline) * 100;
}

export function pairReductions(baseline: SweBenchRow, capsule: SweBenchRow): PairReduction {
  return {
    tokenReductionPct: reductionPct(totalTokens(baseline), totalTokens(capsule)),
    costReductionPct: reductionPct(baseline.costUsd, capsule.costUsd),
    durationReductionPct: reductionPct(baseline.durationMs, capsule.durationMs),
  };
}

// Tolerant parse of one JSONL record into a SweBenchRow. `resolved` is left as
// null if absent so an unevaluated run is not silently counted as unresolved.
export function parseSweBenchRow(raw: Record<string, unknown>): SweBenchRow {
  return {
    instanceId: asNullableString(raw.instanceId) ?? "",
    resolved: asNullableBool(raw.resolved),
    inputTokens: asNumber(raw.inputTokens),
    outputTokens: asNumber(raw.outputTokens),
    cacheReadTokens: asNumber(raw.cacheReadTokens),
    cacheCreationTokens: asNumber(raw.cacheCreationTokens),
    costUsd: asNumber(raw.costUsd),
    durationMs: asNumber(raw.durationMs),
    commitHash: asNullableString(raw.commitHash),
    model: asNullableString(raw.model),
    agent: asNullableString(raw.agent),
  };
}

// True when the injected-instructions snapshot carries the Capsule v2 edit-risk
// / patch-hint directive (the `## Edit risk` section). Absent snapshot => false.
export function snapshotHasEditRiskDirective(snapshot: string | null): boolean {
  if (!snapshot) return false;
  return /^##\s+Edit risk/im.test(snapshot);
}

// Extract Capsule v2 audit metadata from the capsule run's `_run.meta.json`
// object and the snapshot text. Missing fields degrade to null rather than
// throwing, so partial older runs still render.
export function extractCapsuleMeta(
  runMeta: Record<string, unknown>,
  snapshot: string | null,
): CapsuleMeta {
  return {
    engine: asNullableString(runMeta.vtraceCapsuleEngine),
    intent: asNullableString(runMeta.vtraceCapsuleIntent),
    budget: asNullableNumber(runMeta.vtraceCapsuleBudget),
    estimatedTokens: asNullableNumber(runMeta.vtraceCapsuleEstimatedTokens),
    actualMode: asNullableString(runMeta.vtraceCapsuleActualMode),
    topPivotFile: asNullableString(runMeta.vtraceCapsuleTopPivotFile),
    topPivotSymbol: asNullableString(runMeta.vtraceCapsuleTopPivotSymbol),
    topPivotHasSource: asNullableBool(runMeta.vtraceCapsuleTopPivotHasSource),
    pivotSourceChars: asNullableNumber(runMeta.vtraceCapsulePivotSourceChars),
    pivotSourceMode: asNullableString(runMeta.vtraceCapsulePivotSourceMode),
    contextPolicyOverride: asNullableString(runMeta.vtraceContextPolicyOverride),
    policyReason: asNullableString(runMeta.vtracePolicyReason),
    treatmentValid: asNullableBool(runMeta.vtraceTreatmentValid),
    injectionObserved: asNullableBool(runMeta.vtraceInjectionObserved),
    freshWorkspace: asNullableBool(runMeta.freshWorkspace),
    indexStartedAt: asNullableString(runMeta.vtraceIndexStartedAt),
    indexFinishedAt: asNullableString(runMeta.vtraceIndexFinishedAt),
    indexDurationMs: asNullableNumber(runMeta.vtraceIndexDurationMs),
    snapshotPath: asNullableString(runMeta.vtraceInstructionsSnapshotFile),
    snapshotSha256: asNullableString(runMeta.vtraceInstructionsSha256),
    snapshotExists: snapshot !== null,
    editRiskDirectivePresent: snapshotHasEditRiskDirective(snapshot),
  };
}

// A source-anchored pivot's role_reason names the issue/traceback line that
// pointed straight at it; everything else is a "hidden" pivot surfaced by
// symbol/graph/literal reasoning. Mirrors renderHuman.isSourceAnchoredPivot,
// reading the role_reason the audit metadata records (`vtraceCapsulePivots`).
function pivotIsHidden(roleReason: string | null): boolean {
  return !(roleReason ?? "").includes("source line anchor");
}

function readAuditItems(value: unknown, role: "pivot" | "support"): PivotForInspection[] {
  if (!Array.isArray(value)) return [];
  const items: PivotForInspection[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const itemPath = asNullableString(record.path);
    if (itemPath === null) continue;
    items.push({
      path: itemPath,
      symbol: asNullableString(record.symbol) ?? "",
      role,
      // Support items are never "hidden pivots" — the flag is a pivot concept.
      hidden: role === "pivot" ? pivotIsHidden(asNullableString(record.roleReason)) : false,
    });
  }
  return items;
}

// The Capsule v2 pivots + support items the run surfaced, from the audit metadata
// in `_run.meta.json`. Pivots first, then support (the order the agent saw them).
export function extractCapsulePivots(runMeta: Record<string, unknown>): PivotForInspection[] {
  return [
    ...readAuditItems(runMeta.vtraceCapsulePivots, "pivot"),
    ...readAuditItems(runMeta.vtraceCapsuleSupport, "support"),
  ];
}

// Pull an ORDERED tool-call list (with file targets) out of a result record, if
// one is present. SWE-bench records usually carry only an AGGREGATE count object
// ({Read: 2, Edit: 2}); that has no ordering or targets, so this returns
// `ordered: false` and the inspection signals degrade honestly to patch-only.
export function extractOrderedToolCalls(
  record: Record<string, unknown>,
): { calls: InspectionToolCall[]; ordered: boolean } {
  const raw =
    record.toolCalls ?? record.tool_calls ?? record.toolUses ?? record.tool_uses ?? record.actions;
  if (!Array.isArray(raw)) return { calls: [], ordered: false };
  const calls: InspectionToolCall[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const name = asNullableString(r.name) ?? asNullableString(r.tool) ?? asNullableString(r.tool_name);
    if (name === null) continue;
    const input = r.input ?? r.args ?? r.arguments ?? r.parameters;
    const target =
      input !== null && typeof input === "object"
        ? asNullableString((input as Record<string, unknown>).file_path) ??
          asNullableString((input as Record<string, unknown>).filePath) ??
          asNullableString((input as Record<string, unknown>).path) ??
          asNullableString((input as Record<string, unknown>).file)
        : null;
    const output =
      asNullableString(r.output) ?? asNullableString(r.result) ?? asNullableString(r.content);
    calls.push({ tool: name, target, output });
  }
  return { calls, ordered: true };
}

// Classify what the agent did with each surfaced pivot, from the capsule run's
// metadata (pivot list), the final patch, and — when available — a real ORDERED
// tool-call log (`orderedCalls`, loaded from `_tool_calls.json`). Pure read-over
// of artifacts; no gold labels.
//
// Precedence: a loaded ordered log wins (`toolLogOrdered: true`); otherwise we
// fall back to the result record, whose aggregate tool counts have no ordering
// (`toolLogOrdered: false`); with neither, `null`.
export function buildPivotInspection(
  runMeta: Record<string, unknown>,
  capsuleRecord: Record<string, unknown> | null,
  orderedCalls: InspectionToolCall[] | null = null,
): { records: PivotInspectionRecord[]; toolLogOrdered: boolean | null } {
  const pivots = extractCapsulePivots(runMeta);
  const patch =
    capsuleRecord === null
      ? ""
      : asNullableString(capsuleRecord.modelPatch) ?? asNullableString(capsuleRecord.patch) ?? "";
  const editedFiles = editedFilesFromPatch(patch);

  if (orderedCalls !== null) {
    return { records: classifyPivotInspection(pivots, orderedCalls, editedFiles), toolLogOrdered: true };
  }
  if (capsuleRecord === null) {
    return { records: classifyPivotInspection(pivots, [], []), toolLogOrdered: null };
  }
  const { calls, ordered } = extractOrderedToolCalls(capsuleRecord);
  return { records: classifyPivotInspection(pivots, calls, editedFiles), toolLogOrdered: ordered };
}

// Load and coerce the ordered tool-call log (`_tool_calls.json`) for one run
// directory into the classifier's call shape, or null when absent/invalid (so
// the caller keeps the honest false-by-absence behavior).
export async function readOrderedToolCallLog(dir: string): Promise<InspectionToolCall[] | null> {
  const parsed = await readJsonArrayFile(path.join(dir, "_tool_calls.json"));
  return parsed === null ? null : inspectionCallsFromLog(parsed);
}

// Parse and validate a label-map JSON document. Each value must be a 2-element
// [baselineLabel, capsuleLabel] array of non-empty strings.
export function parseLabelMap(text: string): ValidationLabelMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Label map is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Label map must be a JSON object of { instanceId: [baselineLabel, capsuleLabel] }.");
  }
  const map: ValidationLabelMap = {};
  for (const [instanceId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new Error(`Label map entry "${instanceId}" must be a [baselineLabel, capsuleLabel] pair.`);
    }
    const [baselineLabel, capsuleLabel] = value;
    if (typeof baselineLabel !== "string" || baselineLabel.trim() === "") {
      throw new Error(`Label map entry "${instanceId}" has an invalid baseline label.`);
    }
    if (typeof capsuleLabel !== "string" || capsuleLabel.trim() === "") {
      throw new Error(`Label map entry "${instanceId}" has an invalid capsule label.`);
    }
    map[instanceId] = [baselineLabel, capsuleLabel];
  }
  if (Object.keys(map).length === 0) {
    throw new Error("Label map is empty.");
  }
  return map;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregateMetrics(pairs: readonly ValidationPair[]): AggregateMetrics {
  let resolvedBaseline = 0;
  let resolvedCapsule = 0;
  let pooledBaselineTokens = 0;
  let pooledCapsuleTokens = 0;
  let pooledBaselineCostUsd = 0;
  let pooledCapsuleCostUsd = 0;
  let pooledBaselineDurationMs = 0;
  let pooledCapsuleDurationMs = 0;
  const perTaskTokenReductions: number[] = [];

  for (const pair of pairs) {
    if (pair.baseline.resolved === true) resolvedBaseline += 1;
    if (pair.capsule.resolved === true) resolvedCapsule += 1;
    const bt = totalTokens(pair.baseline);
    const ct = totalTokens(pair.capsule);
    pooledBaselineTokens += bt;
    pooledCapsuleTokens += ct;
    pooledBaselineCostUsd += pair.baseline.costUsd;
    pooledCapsuleCostUsd += pair.capsule.costUsd;
    pooledBaselineDurationMs += pair.baseline.durationMs;
    pooledCapsuleDurationMs += pair.capsule.durationMs;
    perTaskTokenReductions.push(reductionPct(bt, ct));
  }

  const meanPerTaskTokenReductionPct =
    perTaskTokenReductions.length === 0
      ? 0
      : perTaskTokenReductions.reduce((a, b) => a + b, 0) / perTaskTokenReductions.length;

  return {
    instanceCount: pairs.length,
    resolvedBaseline,
    resolvedCapsule,
    meanPerTaskTokenReductionPct,
    pooledBaselineTokens,
    pooledCapsuleTokens,
    pooledTokenReductionPct: reductionPct(pooledBaselineTokens, pooledCapsuleTokens),
    pooledBaselineCostUsd,
    pooledCapsuleCostUsd,
    pooledCostReductionPct: reductionPct(pooledBaselineCostUsd, pooledCapsuleCostUsd),
    pooledBaselineDurationMs,
    pooledCapsuleDurationMs,
    pooledDurationReductionPct: reductionPct(pooledBaselineDurationMs, pooledCapsuleDurationMs),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function boolMark(value: boolean | null): string {
  if (value === null) return "n/a";
  return value ? "yes" : "no";
}

function resolvedMark(value: boolean | null): string {
  if (value === null) return "n/a";
  return value ? "True" : "False";
}

export function renderJson(report: ValidationReport): string {
  const out = {
    scope: report.scope,
    protocol: report.protocol,
    generatedAt: report.generatedAt,
    instanceSet: report.instanceSet,
    aggregate: report.aggregate,
    nonClaims: report.nonClaims,
    instances: report.pairs.map((pair) => ({
      instanceId: pair.instanceId,
      baselineLabel: pair.baselineLabel,
      capsuleLabel: pair.capsuleLabel,
      commitHash: pair.capsule.commitHash ?? pair.baseline.commitHash,
      baseline: {
        resolved: pair.baseline.resolved,
        totalTokens: totalTokens(pair.baseline),
        costUsd: pair.baseline.costUsd,
        durationMs: pair.baseline.durationMs,
      },
      capsule: {
        resolved: pair.capsule.resolved,
        totalTokens: totalTokens(pair.capsule),
        costUsd: pair.capsule.costUsd,
        durationMs: pair.capsule.durationMs,
      },
      reductions: pairReductions(pair.baseline, pair.capsule),
      capsuleMeta: pair.capsuleMeta,
    })),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function renderCsv(report: ValidationReport): string {
  const header = [
    "instance",
    "baseline_label",
    "capsule_label",
    "baseline_resolved",
    "capsule_resolved",
    "baseline_tokens",
    "capsule_tokens",
    "token_reduction_pct",
    "cost_reduction_pct",
    "duration_reduction_pct",
    "capsule_engine",
    "capsule_intent",
    "capsule_budget",
    "top_pivot_file",
    "top_pivot_symbol",
    "pivot_source_present",
    "edit_risk_directive_present",
    "snapshot_sha256",
  ];
  const lines = [header.join(",")];
  for (const pair of report.pairs) {
    const r = pairReductions(pair.baseline, pair.capsule);
    const m = pair.capsuleMeta;
    const cells = [
      pair.instanceId,
      pair.baselineLabel,
      pair.capsuleLabel,
      resolvedMark(pair.baseline.resolved),
      resolvedMark(pair.capsule.resolved),
      String(totalTokens(pair.baseline)),
      String(totalTokens(pair.capsule)),
      r.tokenReductionPct.toFixed(2),
      r.costReductionPct.toFixed(2),
      r.durationReductionPct.toFixed(2),
      m.engine ?? "",
      m.intent ?? "",
      m.budget === null ? "" : String(m.budget),
      m.topPivotFile ?? "",
      m.topPivotSymbol ?? "",
      boolMark(m.topPivotHasSource),
      boolMark(m.editRiskDirectivePresent),
      m.snapshotSha256 ?? "",
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function renderMarkdown(report: ValidationReport): string {
  const a = report.aggregate;
  const lines: string[] = [];

  lines.push("# Stage 5 Capsule v2 force-inject validation");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");

  lines.push("## Scope");
  lines.push("");
  lines.push(report.scope);
  lines.push("");

  lines.push("## Protocol");
  lines.push("");
  lines.push(report.protocol);
  lines.push("");

  lines.push("## Instance set");
  lines.push("");
  for (const instanceId of report.instanceSet) lines.push(`- ${instanceId}`);
  lines.push("");

  // Fresh-index evidence
  lines.push("## Fresh-index evidence");
  lines.push("");
  lines.push(
    "Each Capsule v2 run reindexed a fresh workspace before the live agent ran. " +
      "Index start/finish timestamps and durations come from each run's `_run.meta.json`.",
  );
  lines.push("");
  lines.push("| instance | fresh workspace | index started | index finished | index duration (s) |");
  lines.push("| --- | --- | --- | --- | ---: |");
  for (const pair of report.pairs) {
    const m = pair.capsuleMeta;
    const dur = m.indexDurationMs === null ? "n/a" : (m.indexDurationMs / 1000).toFixed(1);
    lines.push(
      `| ${pair.instanceId} | ${boolMark(m.freshWorkspace)} | ${m.indexStartedAt ?? "n/a"} | ${m.indexFinishedAt ?? "n/a"} | ${dur} |`,
    );
  }
  lines.push("");

  // Capsule v2 metadata
  lines.push("## Capsule v2 metadata");
  lines.push("");
  lines.push(
    "| instance | engine | intent | budget | est tok | mode | top pivot file | top pivot symbol | pivot source | source chars | source mode | edit-risk directive | policy override |",
  );
  lines.push(
    "| --- | --- | --- | ---: | ---: | --- | --- | --- | --- | ---: | --- | --- | --- |",
  );
  for (const pair of report.pairs) {
    const m = pair.capsuleMeta;
    lines.push(
      `| ${pair.instanceId} | ${m.engine ?? "n/a"} | ${m.intent ?? "n/a"} | ${m.budget ?? "n/a"} | ${m.estimatedTokens ?? "n/a"} | ${m.actualMode ?? "n/a"} | ${m.topPivotFile ?? "n/a"} | ${m.topPivotSymbol ?? "n/a"} | ${boolMark(m.topPivotHasSource)} | ${m.pivotSourceChars ?? "n/a"} | ${m.pivotSourceMode ?? "n/a"} | ${boolMark(m.editRiskDirectivePresent)} | ${m.contextPolicyOverride ?? "n/a"} |`,
    );
  }
  lines.push("");
  lines.push("### Snapshot path / SHA per instance");
  lines.push("");
  lines.push("| instance | snapshot present | snapshot sha256 | snapshot path |");
  lines.push("| --- | --- | --- | --- |");
  for (const pair of report.pairs) {
    const m = pair.capsuleMeta;
    lines.push(
      `| ${pair.instanceId} | ${m.snapshotExists ? "yes" : "no"} | ${m.snapshotSha256 ?? "n/a"} | ${m.snapshotPath ?? "n/a"} |`,
    );
  }
  lines.push("");

  // Pivot inspection: what the agent did with each surfaced Capsule v2 pivot.
  lines.push("## Pivot inspection");
  lines.push("");
  lines.push(
    "Per surfaced Capsule v2 pivot, what the agent did with it — derived from the " +
      "run's ordered tool calls (when present) and the final patch. A search/grep " +
      "hit is `discovered`, not `inspected`: inspection means the agent opened the " +
      "file's contents. `ignored` = surfaced but neither inspected nor edited.",
  );
  lines.push("");
  const anyOrderedLog = report.pairs.some((pair) => pair.pivotInspectionToolLogOrdered === true);
  if (!anyOrderedLog) {
    lines.push(
      "> Note: no run carried an ordered tool-call log with file targets (SWE-bench " +
        "records report only aggregate tool counts), so `inspected` / `discovered` are " +
        "false-by-absence here, not confirmed-not-inspected. `edited` / `ignored` come " +
        "from the patch and are authoritative.",
    );
    lines.push("");
  }
  lines.push("| instance | pivot | symbol | role | hidden | discovered | inspected | edited | status |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const pair of report.pairs) {
    for (const record of pair.pivotInspection ?? []) {
      lines.push(
        `| ${pair.instanceId} | ${record.path} | ${record.symbol || "n/a"} | ${record.role} | ` +
          `${boolMark(record.hidden)} | ${boolMark(record.discovered)} | ${boolMark(record.inspected)} | ` +
          `${boolMark(record.edited)} | ${record.status} |`,
      );
    }
  }
  lines.push("");

  // Resolution table
  lines.push("## Resolution");
  lines.push("");
  lines.push("| instance | baseline resolved | capsule-v2 resolved | treatment valid | injection observed |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const pair of report.pairs) {
    const m = pair.capsuleMeta;
    lines.push(
      `| ${pair.instanceId} | ${resolvedMark(pair.baseline.resolved)} | ${resolvedMark(pair.capsule.resolved)} | ${boolMark(m.treatmentValid)} | ${boolMark(m.injectionObserved)} |`,
    );
  }
  lines.push("");

  // Token / cost / duration comparison
  lines.push("## Token / cost / duration comparison");
  lines.push("");
  lines.push(
    "| instance | baseline tok | capsule tok | token reduction | cost reduction | duration reduction |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const pair of report.pairs) {
    const r = pairReductions(pair.baseline, pair.capsule);
    lines.push(
      `| ${pair.instanceId} | ${totalTokens(pair.baseline)} | ${totalTokens(pair.capsule)} | ${fmtPct(r.tokenReductionPct)} | ${fmtPct(r.costReductionPct)} | ${fmtPct(r.durationReductionPct)} |`,
    );
  }
  lines.push("");

  // Aggregate metrics
  lines.push("## Aggregate metrics");
  lines.push("");
  lines.push(`- Resolved baseline: ${a.resolvedBaseline}/${a.instanceCount}`);
  lines.push(`- Resolved capsule-v2: ${a.resolvedCapsule}/${a.instanceCount}`);
  lines.push(`- Mean per-task token reduction: ${fmtPct(a.meanPerTaskTokenReductionPct)}`);
  lines.push(`- Pooled token reduction: ${fmtPct(a.pooledTokenReductionPct)}`);
  lines.push(`- Pooled cost reduction: ${fmtPct(a.pooledCostReductionPct)}`);
  lines.push(`- Pooled duration reduction: ${fmtPct(a.pooledDurationReductionPct)}`);
  lines.push("");

  // Caveats / non-claims
  lines.push("## Caveats / non-claims");
  lines.push("");
  for (const claim of report.nonClaims) lines.push(`- ${claim}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// IO layer
// ---------------------------------------------------------------------------

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Read a JSON file expected to hold a top-level array (e.g. `_tool_calls.json`).
// Returns null when missing, unparseable, or not an array.
async function readJsonArrayFile(filePath: string): Promise<unknown[] | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : null;
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

// Read the first record from the single `swebench-*.jsonl` file in `dir`.
// Returns null when the dir or file is missing/empty.
async function readFirstJsonlRecord(dir: string): Promise<Record<string, unknown> | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const jsonl = entries.filter((name) => name.endsWith(".jsonl")).sort();
  for (const name of jsonl) {
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

export interface LoadOptions {
  runsDir: string;
  baselineCondition?: string;
  capsuleCondition?: string;
}

// Resolve one instance's ValidationPair from disk. Throws clear errors when the
// baseline or capsule JSONL record is missing.
export async function loadPair(
  instanceId: string,
  labels: [string, string],
  options: LoadOptions,
): Promise<ValidationPair> {
  const [baselineLabel, capsuleLabel] = labels;
  const baselineCondition = options.baselineCondition ?? DEFAULT_BASELINE_CONDITION;
  const capsuleCondition = options.capsuleCondition ?? DEFAULT_CAPSULE_CONDITION;

  const baselineDir = path.join(options.runsDir, baselineLabel, "raw", baselineCondition);
  const capsuleDir = path.join(options.runsDir, capsuleLabel, "raw", capsuleCondition);

  const baselineRaw = await readFirstJsonlRecord(baselineDir);
  if (baselineRaw === null) {
    throw new Error(
      `Missing baseline row for ${instanceId}: no JSONL record under ${baselineDir} (label "${baselineLabel}").`,
    );
  }
  const capsuleRaw = await readFirstJsonlRecord(capsuleDir);
  if (capsuleRaw === null) {
    throw new Error(
      `Missing vtrace/capsule row for ${instanceId}: no JSONL record under ${capsuleDir} (label "${capsuleLabel}").`,
    );
  }

  const runMeta = (await readJsonFile(path.join(capsuleDir, "_run.meta.json"))) ?? {};
  const evalMeta = await readJsonFile(path.join(capsuleDir, "_eval.meta.json"));
  const snapshot = await readTextFile(
    path.join(options.runsDir, capsuleLabel, "_vtrace_instructions.snapshot.md"),
  );

  const baseline = parseSweBenchRow(baselineRaw);
  const capsule = parseSweBenchRow(capsuleRaw);

  // Prefer the JSONL `resolved` flag; fall back to the eval-meta resolvedCount
  // (single-instance runs => resolvedCount 1 means resolved).
  if (capsule.resolved === null && evalMeta && typeof evalMeta.resolvedCount === "number") {
    capsule.resolved = (evalMeta.resolvedCount as number) > 0;
  }

  const orderedCalls = await readOrderedToolCallLog(capsuleDir);
  const pivotInspection = buildPivotInspection(runMeta, capsuleRaw, orderedCalls);

  return {
    instanceId,
    baselineLabel,
    capsuleLabel,
    baseline,
    capsule,
    capsuleMeta: extractCapsuleMeta(runMeta, snapshot),
    pivotInspection: pivotInspection.records,
    pivotInspectionToolLogOrdered: pivotInspection.toolLogOrdered,
  };
}

export async function buildReport(
  labelMap: ValidationLabelMap,
  options: LoadOptions,
  generatedAt: string | null,
): Promise<ValidationReport> {
  const instanceSet = Object.keys(labelMap);
  const pairs: ValidationPair[] = [];
  for (const instanceId of instanceSet) {
    pairs.push(await loadPair(instanceId, labelMap[instanceId]!, options));
  }
  return {
    generatedAt,
    scope: REPORT_SCOPE,
    protocol: REPORT_PROTOCOL,
    instanceSet,
    pairs,
    aggregate: aggregateMetrics(pairs),
    nonClaims: [...NON_CLAIMS],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface ReportCliConfig {
  labelMapPath: string;
  runsDir: string;
  outDir: string;
  baselineCondition: string;
  capsuleCondition: string;
}

export function parseReportArgs(argv: readonly string[]): ReportCliConfig {
  const config: ReportCliConfig = {
    labelMapPath: DEFAULT_LABEL_MAP,
    runsDir: DEFAULT_RUNS_DIR,
    outDir: DEFAULT_OUT_DIR,
    baselineCondition: DEFAULT_BASELINE_CONDITION,
    capsuleCondition: DEFAULT_CAPSULE_CONDITION,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--label-map":
        config.labelMapPath = next();
        break;
      case "--runs-dir":
        config.runsDir = next();
        break;
      case "--out":
        config.outDir = next();
        break;
      case "--baseline-condition":
        config.baselineCondition = next();
        break;
      case "--capsule-condition":
        config.capsuleCondition = next();
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return config;
}

async function main(config: ReportCliConfig): Promise<void> {
  const labelMapText = await readFile(config.labelMapPath, "utf8");
  const labelMap = parseLabelMap(labelMapText);

  // ISO timestamp without a wall-clock dependency inside the pure builders.
  const generatedAt = new Date().toISOString();

  const report = await buildReport(
    labelMap,
    {
      runsDir: config.runsDir,
      baselineCondition: config.baselineCondition,
      capsuleCondition: config.capsuleCondition,
    },
    generatedAt,
  );

  await mkdir(config.outDir, { recursive: true });
  const mdPath = path.join(config.outDir, `${REPORT_BASENAME}.md`);
  const jsonPath = path.join(config.outDir, `${REPORT_BASENAME}.json`);
  const csvPath = path.join(config.outDir, `${REPORT_BASENAME}.csv`);

  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));
  await writeFile(csvPath, renderCsv(report));

  const a = report.aggregate;
  process.stdout.write(
    [
      `Stage 5 Capsule v2 validation report written:`,
      `  ${mdPath}`,
      `  ${jsonPath}`,
      `  ${csvPath}`,
      ``,
      `Resolved baseline:   ${a.resolvedBaseline}/${a.instanceCount}`,
      `Resolved capsule-v2: ${a.resolvedCapsule}/${a.instanceCount}`,
      `Mean per-task token reduction: ${fmtPct(a.meanPerTaskTokenReductionPct)}`,
      `Pooled token reduction:        ${fmtPct(a.pooledTokenReductionPct)}`,
      `Pooled cost reduction:         ${fmtPct(a.pooledCostReductionPct)}`,
      `Pooled duration reduction:     ${fmtPct(a.pooledDurationReductionPct)}`,
      ``,
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
