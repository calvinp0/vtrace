// Stage 5 ordered-telemetry completeness audit.
//
// Scans the Stage 5 result run directories and reports, per (run-label, condition)
// run, whether ordered tool-call telemetry was captured:
//   - ordered                 → `_tool_calls.json` present and parsed (orderedTelemetryAvailable)
//   - raw-stream-no-parsed    → the stream patch ran but produced no usable parsed log
//                               (sentinel / parse error): raw stream present, no ordered telemetry
//   - none                    → neither (legacy run that never captured stream-json)
//
// It also flags high-token/high-cost runs that are missing telemetry and runs that
// tripped the diagnostic loop heuristics. Cost/token metrics are resolved from the
// current normalized report FIRST, then — for historical runs absent from that
// report — from each run's own committed per-run result artifact (the canonical
// `swebench-*.jsonl`). Unavailable metrics remain null and are never guessed; the
// source of every metric is recorded (`costSource` / `tokenSource`).
//
// This report does NOT re-run agents, does NOT infer tool order when stream-json is
// missing, does NOT guess cost/token totals, and the loop heuristics are diagnostic
// only — they never affect patch generation or policy accounting. (Implementation
// recommendation 3: make missing ordered telemetry visible immediately.)

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OrderedToolCallSummary } from "../../src/capsule/toolCallLog";
import {
  NORMALIZED_FILENAME,
  parseConditionDir,
  STAGE5_CONDITIONS,
  TELEMETRY_MISSING_LEGACY,
  TELEMETRY_MISSING_PARSE_ERROR,
  TELEMETRY_MISSING_SENTINEL,
  toolCallLogFilePath,
  toolCallSummaryFilePath,
  type NormalizedArtifact,
  type Stage5Condition,
  type Stage5Row,
} from "./run_stage5_vexp_swe_bench_smoke";

// Default results root (mirrors the runner's --out default).
const DEFAULT_RESULTS_DIR = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const TELEMETRY_AUDIT_JSON_FILENAME = "stage5_ordered_telemetry_audit.json";
export const TELEMETRY_AUDIT_MD_FILENAME = "stage5_ordered_telemetry_audit.md";

// Conservative thresholds. They only decide which missing-telemetry runs are
// surfaced as high-priority for re-capture — never anything load-bearing, and never
// any change to policy accounting.
export const HIGH_COST_THRESHOLD_USD = 0.5;
export const HIGH_TOKEN_THRESHOLD = 1_000_000;

export type TelemetryState = "ordered" | "raw-stream-no-parsed" | "none";

// Where a resolved metric came from. `normalized` = the current normalized report;
// `run_artifact` = the run's own committed/raw `swebench-*.jsonl`; `ordered_summary`
// is reserved (the ordered summary records tool-call counts, not model tokens, so it
// is not currently a token source); `unavailable` = no artifact records it.
export type CostSource = "normalized" | "run_artifact" | "unavailable";
export type TokenSource = "normalized" | "run_artifact" | "ordered_summary" | "unavailable";

export interface TelemetryRunRecord {
  runLabel: string | null;
  condition: Stage5Condition;
  relDir: string;
  instances: readonly string[];
  instanceId: string | null;
  hasRunMeta: boolean;
  hasOrderedLog: boolean;
  hasSummary: boolean;
  orderedTelemetryAvailable: boolean;
  missingReason: string | null;
  state: TelemetryState;
  summary: OrderedToolCallSummary | null;
  longBashLoopHeuristic: boolean;
  repeatedSearchHeuristic: boolean;
  totalCostUsd: number | null;
  totalTokens: number | null;
  costSource: CostSource;
  tokenSource: TokenSource;
  // True when this run is missing ordered telemetry AND meets the high-cost (or,
  // when cost is unavailable, high-token) threshold from a KNOWN metric.
  highCostMissingTelemetry: boolean;
  highCostReason: "cost" | "tokens" | null;
  toolUseDisciplineInjected: boolean | null;
}

export interface TelemetryAudit {
  resultsDir: string;
  highCostThresholdUsd: number;
  highTokenThreshold: number;
  totalRuns: number;
  ordered: number;
  rawStreamNoParsed: number;
  none: number;
  // Missing telemetry whose KNOWN cost/tokens meet a threshold (flagged for re-capture).
  highCostMissing: number;
  // Missing telemetry whose cost/tokens are unavailable (cannot be ranked, not guessed).
  missingMetricsUnavailable: number;
  loopHeuristicHits: number;
  runs: readonly TelemetryRunRecord[];
  nonClaims: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function pathExists(file: string): Promise<boolean> {
  return readFile(file, "utf8").then(
    () => true,
    () => false,
  );
}

async function listSubdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Build a (instanceId|condition) → {costUsd, totalTokens} index from the normalized
// artifact, so the audit can flag high-cost runs missing telemetry. Best-effort:
// a missing/invalid normalized file just leaves every cost null (nothing flagged).
function costIndexFromArtifact(artifact: unknown): Map<string, { costUsd: number | null; totalTokens: number | null }> {
  const index = new Map<string, { costUsd: number | null; totalTokens: number | null }>();
  if (!isRecord(artifact) || !Array.isArray(artifact.rows)) return index;
  for (const row of artifact.rows as Stage5Row[]) {
    if (!isRecord(row) || typeof row.instanceId !== "string" || typeof row.condition !== "string") continue;
    index.set(`${row.instanceId}|${row.condition}`, {
      costUsd: numberOrNull(row.costUsd),
      totalTokens: numberOrNull(row.totalTokens),
    });
  }
  return index;
}

function classifyState(hasOrderedLog: boolean, orderedTelemetryAvailable: boolean, missingReason: string | null): TelemetryState {
  if (hasOrderedLog && orderedTelemetryAvailable) return "ordered";
  if (missingReason === TELEMETRY_MISSING_SENTINEL || missingReason === TELEMETRY_MISSING_PARSE_ERROR) {
    return "raw-stream-no-parsed";
  }
  return "none";
}

// Coerce an Unknownable<number> ("unknown" | number) into a plain number or null.
function unknownableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Pick the result row for this run: prefer the one matching the run's instanceId,
// else the sole row when the run produced exactly one (per-condition dirs usually
// hold a single instance). Returns null when no usable row exists.
function pickRunRow(rows: readonly Stage5Row[], instanceId: string | null): Stage5Row | null {
  if (instanceId !== null) {
    const match = rows.find((row) => row.instanceId === instanceId);
    if (match) return match;
  }
  return rows.length === 1 ? rows[0] : null;
}

export interface ResolvedRunMetrics {
  totalCostUsd: number | null;
  totalTokens: number | null;
  costSource: CostSource;
  tokenSource: TokenSource;
}

// Resolve a run's cost/tokens with a historical fallback:
//   1. Prefer the current normalized report's joined metrics (`normalized`).
//   2. For whatever the normalized report is missing, read the run's OWN committed
//      per-run result artifact (the canonical `swebench-*.jsonl`) via the shared
//      `parseConditionDir` reader (`run_artifact`).
//   3. If still missing, leave null and mark `unavailable` — never guessed.
// Cost and tokens are sourced independently, but the per-run artifact is read at
// most once.
export async function resolveRunMetrics(
  runDir: string,
  condition: Stage5Condition,
  instanceId: string | null,
  costIndex: Map<string, { costUsd: number | null; totalTokens: number | null }>,
): Promise<ResolvedRunMetrics> {
  const normalized = instanceId !== null ? costIndex.get(`${instanceId}|${condition}`) ?? null : null;
  let totalCostUsd = normalized?.costUsd ?? null;
  let totalTokens = normalized?.totalTokens ?? null;
  let costSource: CostSource = totalCostUsd !== null ? "normalized" : "unavailable";
  let tokenSource: TokenSource = totalTokens !== null ? "normalized" : "unavailable";

  // Fallback to the run's own committed artifact only for the metrics the
  // normalized report did not supply. Best-effort: a run dir with no parseable
  // result row leaves the missing metrics null/unavailable.
  if (totalCostUsd === null || totalTokens === null) {
    const rows = await parseConditionDir(runDir, condition).catch(() => [] as Stage5Row[]);
    const row = pickRunRow(rows, instanceId);
    if (row !== null) {
      if (totalCostUsd === null) {
        const cost = unknownableNumber(row.costUsd);
        if (cost !== null) {
          totalCostUsd = cost;
          costSource = "run_artifact";
        }
      }
      if (totalTokens === null) {
        const tokens = unknownableNumber(row.totalTokens);
        if (tokens !== null) {
          totalTokens = tokens;
          tokenSource = "run_artifact";
        }
      }
    }
  }
  return { totalCostUsd, totalTokens, costSource, tokenSource };
}

// Inspect one condition run directory and classify its ordered-telemetry state.
export async function auditRunDir(
  runDir: string,
  relDir: string,
  runLabel: string | null,
  condition: Stage5Condition,
  costIndex: Map<string, { costUsd: number | null; totalTokens: number | null }>,
): Promise<TelemetryRunRecord> {
  const metaPath = path.join(runDir, "_run.meta.json");
  const meta = (await readJson(metaPath).catch(() => null)) as Record<string, unknown> | null;
  const summaryRaw = (await readJson(toolCallSummaryFilePath(runDir)).catch(() => null)) as Record<string, unknown> | null;
  const hasOrderedLog = await pathExists(toolCallLogFilePath(runDir));
  const hasSummary = summaryRaw !== null;

  const instances = Array.isArray(meta?.instances)
    ? (meta?.instances as unknown[]).filter((value): value is string => typeof value === "string")
    : Array.isArray(summaryRaw?.instances)
      ? (summaryRaw?.instances as unknown[]).filter((value): value is string => typeof value === "string")
      : [];
  const instanceId = instances.length === 1 ? instances[0] : null;

  // orderedTelemetryAvailable and missingReason come from the summary first (the
  // canonical telemetry artifact), falling back to the run meta. A legacy run with
  // neither defaults to unavailable / legacy.
  const orderedTelemetryAvailable =
    typeof summaryRaw?.orderedTelemetryAvailable === "boolean"
      ? (summaryRaw.orderedTelemetryAvailable as boolean)
      : typeof meta?.orderedTelemetryAvailable === "boolean"
        ? (meta.orderedTelemetryAvailable as boolean)
        : meta?.vtraceToolLogOrdered === true;
  const missingReason =
    typeof summaryRaw?.missingReason === "string"
      ? (summaryRaw.missingReason as string)
      : typeof meta?.orderedTelemetryMissingReason === "string"
        ? (meta.orderedTelemetryMissingReason as string)
        : orderedTelemetryAvailable
          ? null
          : TELEMETRY_MISSING_LEGACY;

  const summary: OrderedToolCallSummary | null =
    summaryRaw !== null
      ? {
          totalToolCalls: numberOrNull(summaryRaw.totalToolCalls) ?? 0,
          bashToolCalls: numberOrNull(summaryRaw.bashToolCalls) ?? 0,
          grepLikeToolCalls: numberOrNull(summaryRaw.grepLikeToolCalls) ?? 0,
          fileReadToolCalls: numberOrNull(summaryRaw.fileReadToolCalls) ?? 0,
          fileWriteToolCalls: numberOrNull(summaryRaw.fileWriteToolCalls) ?? 0,
          uniqueFilesTouchedByTools: numberOrNull(summaryRaw.uniqueFilesTouchedByTools) ?? 0,
          longBashLoopHeuristic: summaryRaw.longBashLoopHeuristic === true,
          repeatedSearchHeuristic: summaryRaw.repeatedSearchHeuristic === true,
          orderedTelemetryAvailable,
        }
      : null;

  const { totalCostUsd, totalTokens, costSource, tokenSource } = await resolveRunMetrics(
    runDir,
    condition,
    instanceId,
    costIndex,
  );

  // High-cost missing telemetry: only when ordered telemetry is absent and a KNOWN
  // metric meets a threshold. Cost is preferred; tokens are used only when cost is
  // unavailable (so a run is never flagged twice or on a guessed metric).
  const telemetryMissing = !orderedTelemetryAvailable;
  let highCostReason: "cost" | "tokens" | null = null;
  if (telemetryMissing) {
    if (totalCostUsd !== null && totalCostUsd >= HIGH_COST_THRESHOLD_USD) highCostReason = "cost";
    else if (totalCostUsd === null && totalTokens !== null && totalTokens >= HIGH_TOKEN_THRESHOLD) highCostReason = "tokens";
  }

  return {
    runLabel,
    condition,
    relDir,
    instances,
    instanceId,
    hasRunMeta: meta !== null,
    hasOrderedLog,
    hasSummary,
    orderedTelemetryAvailable,
    missingReason,
    state: classifyState(hasOrderedLog, orderedTelemetryAvailable, missingReason),
    summary,
    longBashLoopHeuristic: summary?.longBashLoopHeuristic ?? false,
    repeatedSearchHeuristic: summary?.repeatedSearchHeuristic ?? false,
    totalCostUsd,
    totalTokens,
    costSource,
    tokenSource,
    highCostMissingTelemetry: highCostReason !== null,
    highCostReason,
    toolUseDisciplineInjected:
      typeof meta?.stage5ToolUseDisciplineInjected === "boolean"
        ? (meta.stage5ToolUseDisciplineInjected as boolean)
        : null,
  };
}

// Discover every condition run dir under the results root — both the flat layout
// (results/raw/<condition>) and the labeled layout (results/runs/<label>/raw/<condition>).
async function discoverRunDirs(resultsDir: string): Promise<Array<{ runDir: string; relDir: string; runLabel: string | null; condition: Stage5Condition }>> {
  const found: Array<{ runDir: string; relDir: string; runLabel: string | null; condition: Stage5Condition }> = [];
  // Flat layout.
  for (const condition of STAGE5_CONDITIONS) {
    const runDir = path.join(resultsDir, "raw", condition);
    if (await pathExists(path.join(runDir, "_run.meta.json"))) {
      found.push({ runDir, relDir: path.join("raw", condition), runLabel: null, condition });
    }
  }
  // Labeled layout.
  const runsRoot = path.join(resultsDir, "runs");
  for (const label of await listSubdirs(runsRoot)) {
    for (const condition of STAGE5_CONDITIONS) {
      const runDir = path.join(runsRoot, label, "raw", condition);
      if (await pathExists(path.join(runDir, "_run.meta.json"))) {
        found.push({ runDir, relDir: path.join("runs", label, "raw", condition), runLabel: label, condition });
      }
    }
  }
  return found;
}

export const TELEMETRY_AUDIT_NON_CLAIMS: readonly string[] = [
  "This report does not re-run agents.",
  "This report does not infer tool order when stream-json is missing.",
  "Loop heuristics are diagnostic only and do not affect patch generation.",
  "This audit does not guess cost or token totals when no artifact records them.",
  "Fallback cost/token extraction is for prioritization only and does not change policy accounting.",
];

// A missing-telemetry run whose cost AND tokens are both unavailable cannot be
// ranked (and is never guessed).
function missingMetricsUnavailable(run: TelemetryRunRecord): boolean {
  return run.state !== "ordered" && run.totalCostUsd === null && run.totalTokens === null;
}

export async function auditOrderedTelemetry(resultsDir: string): Promise<TelemetryAudit> {
  const artifact = await readJson(path.join(resultsDir, NORMALIZED_FILENAME)).catch(() => null);
  const costIndex = costIndexFromArtifact(artifact);
  const dirs = await discoverRunDirs(resultsDir);
  const runs: TelemetryRunRecord[] = [];
  for (const entry of dirs) {
    runs.push(await auditRunDir(entry.runDir, entry.relDir, entry.runLabel, entry.condition, costIndex));
  }
  // Stable order: by relative dir.
  runs.sort((a, b) => a.relDir.localeCompare(b.relDir));
  return {
    resultsDir,
    highCostThresholdUsd: HIGH_COST_THRESHOLD_USD,
    highTokenThreshold: HIGH_TOKEN_THRESHOLD,
    totalRuns: runs.length,
    ordered: runs.filter((run) => run.state === "ordered").length,
    rawStreamNoParsed: runs.filter((run) => run.state === "raw-stream-no-parsed").length,
    none: runs.filter((run) => run.state === "none").length,
    highCostMissing: runs.filter((run) => run.highCostMissingTelemetry).length,
    missingMetricsUnavailable: runs.filter(missingMetricsUnavailable).length,
    loopHeuristicHits: runs.filter((run) => run.longBashLoopHeuristic || run.repeatedSearchHeuristic).length,
    runs,
    nonClaims: TELEMETRY_AUDIT_NON_CLAIMS,
  };
}

function fmtCost(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

function fmtTokens(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function runLabelCell(run: TelemetryRunRecord): string {
  return run.runLabel ?? "(flat)";
}

// Rank flagged runs by cost then tokens (descending), so the most expensive
// missing-telemetry runs lead the table. Nulls sort last.
function byCostThenTokensDesc(a: TelemetryRunRecord, b: TelemetryRunRecord): number {
  const cost = (b.totalCostUsd ?? -1) - (a.totalCostUsd ?? -1);
  if (cost !== 0) return cost;
  return (b.totalTokens ?? -1) - (a.totalTokens ?? -1);
}

export function renderTelemetryAuditMarkdown(audit: TelemetryAudit): string {
  const lines: string[] = [];
  lines.push("# Stage 5 ordered telemetry audit", "");

  lines.push("## Summary", "");
  lines.push(`- Results dir: \`${audit.resultsDir}\``);
  lines.push(`- Total agent runs scanned: ${audit.totalRuns}`);
  lines.push(`- Ordered telemetry present: ${audit.ordered}`);
  lines.push(`- Raw stream present but not parsed: ${audit.rawStreamNoParsed}`);
  lines.push(`- No telemetry (legacy / never captured): ${audit.none}`);
  lines.push(
    `- High-cost/high-token runs missing telemetry: ${audit.highCostMissing} (thresholds: ≥ ${fmtCost(audit.highCostThresholdUsd)} or ≥ ${fmtTokens(audit.highTokenThreshold)} tokens)`,
  );
  lines.push(`- Missing telemetry with unavailable cost/token: ${audit.missingMetricsUnavailable}`);
  lines.push(`- Runs tripping a loop heuristic: ${audit.loopHeuristicHits}`);
  lines.push(
    "- Cost/token metrics are resolved from normalized reports first, then per-run artifacts when available; unavailable metrics remain null and are not guessed.",
  );
  lines.push("");

  lines.push("## Coverage", "");
  if (audit.runs.length === 0) {
    lines.push("_No Stage 5 agent run directories found._", "");
  } else {
    lines.push("| run-label | condition | instance | state | ordered? | discipline |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const run of audit.runs) {
      lines.push(
        `| ${runLabelCell(run)} | ${run.condition} | ${run.instanceId ?? (run.instances.join(",") || "—")} | ${run.state} | ${run.orderedTelemetryAvailable ? "yes" : "no"} | ${run.toolUseDisciplineInjected === null ? "—" : run.toolUseDisciplineInjected ? "yes" : "no"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Missing telemetry", "");
  const missing = audit.runs.filter((run) => run.state !== "ordered");
  if (missing.length === 0) {
    lines.push("_None — every scanned run has ordered telemetry._", "");
  } else {
    lines.push("| run-label | condition | instance | state | reason |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const run of missing) {
      lines.push(`| ${runLabelCell(run)} | ${run.condition} | ${run.instanceId ?? "—"} | ${run.state} | ${run.missingReason ?? "—"} |`);
    }
    lines.push("");
  }

  lines.push("## High-cost runs missing telemetry", "");
  lines.push(
    `Thresholds: cost ≥ ${fmtCost(audit.highCostThresholdUsd)}, or tokens ≥ ${fmtTokens(audit.highTokenThreshold)} when cost is unavailable. Metrics fall back from the normalized report to each run's own \`swebench-*.jsonl\`.`,
    "",
  );

  // Subsection (a): flagged missing-telemetry runs with KNOWN cost/token over threshold.
  lines.push("### Missing telemetry with known cost/token (flagged)", "");
  const highCostMissing = audit.runs.filter((run) => run.highCostMissingTelemetry);
  if (highCostMissing.length === 0) {
    lines.push("_None above the thresholds._", "");
  } else {
    lines.push("| run-label | condition | instance | cost | costSrc | tokens | tokenSrc | by | state |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const run of [...highCostMissing].sort(byCostThenTokensDesc)) {
      lines.push(
        `| ${runLabelCell(run)} | ${run.condition} | ${run.instanceId ?? "—"} | ${fmtCost(run.totalCostUsd)} | ${run.costSource} | ${fmtTokens(run.totalTokens)} | ${run.tokenSource} | ${run.highCostReason ?? "—"} | ${run.state} |`,
      );
    }
    lines.push("");
  }

  // Subsection (b): missing-telemetry runs we cannot rank because metrics are unavailable.
  lines.push("### Missing telemetry with unavailable cost/token (cannot rank)", "");
  const unavailable = audit.runs.filter(missingMetricsUnavailable);
  if (unavailable.length === 0) {
    lines.push("_None — every missing-telemetry run has at least one known metric._", "");
  } else {
    lines.push(`${unavailable.length} missing-telemetry run(s) have no cost/token artifact and are not guessed:`, "");
    lines.push("| run-label | condition | instance | state | reason |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const run of unavailable) {
      lines.push(`| ${runLabelCell(run)} | ${run.condition} | ${run.instanceId ?? "—"} | ${run.state} | ${run.missingReason ?? "—"} |`);
    }
    lines.push("");
  }

  lines.push("## Loop heuristics", "");
  const loopHits = audit.runs.filter((run) => run.longBashLoopHeuristic || run.repeatedSearchHeuristic);
  if (loopHits.length === 0) {
    lines.push("_No scanned run tripped the diagnostic loop heuristics._", "");
  } else {
    lines.push("| run-label | condition | instance | bash | grep-like | longBashLoop | repeatedSearch |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const run of loopHits) {
      const s = run.summary;
      lines.push(
        `| ${runLabelCell(run)} | ${run.condition} | ${run.instanceId ?? "—"} | ${s?.bashToolCalls ?? "—"} | ${s?.grepLikeToolCalls ?? "—"} | ${run.longBashLoopHeuristic ? "yes" : "no"} | ${run.repeatedSearchHeuristic ? "yes" : "no"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Recommendations", "");
  const recs: string[] = [];
  if (audit.none > 0) {
    recs.push(
      `${audit.none} run(s) have no ordered telemetry. These are legacy runs that never captured stream-json; future runs capture it universally — re-run them only if their tool order is needed.`,
    );
  }
  if (audit.rawStreamNoParsed > 0) {
    recs.push(
      `${audit.rawStreamNoParsed} run(s) captured a raw stream but produced no parsed ordered log (sentinel / parse error). Inspect the adapter stream patch for those runs.`,
    );
  }
  if (audit.highCostMissing > 0) {
    recs.push(
      `${audit.highCostMissing} high-cost/high-token run(s) are missing telemetry (cost/tokens resolved from per-run artifacts) — prioritize re-capturing these, since the largest unexplained deltas are the ones worth ordered tool logs.`,
    );
  }
  if (audit.missingMetricsUnavailable > 0) {
    recs.push(
      `${audit.missingMetricsUnavailable} missing-telemetry run(s) have no recorded cost/token artifact, so they cannot be ranked; they are reported as unavailable and not guessed.`,
    );
  }
  if (audit.loopHeuristicHits > 0) {
    recs.push(
      `${audit.loopHeuristicHits} run(s) tripped a loop heuristic (long Bash loop or repeated search). Diagnostic only — review whether the anti-loop guidance needs strengthening.`,
    );
  }
  if (recs.length === 0) recs.push("All scanned runs have ordered telemetry and none tripped a loop heuristic.");
  for (const rec of recs) lines.push(`- ${rec}`);
  lines.push("");

  lines.push("## Non-claims", "");
  for (const claim of audit.nonClaims) lines.push(`- ${claim}`);
  lines.push("");

  return lines.join("\n");
}

export async function runOrderedTelemetryAudit(resultsDir: string): Promise<TelemetryAudit> {
  const audit = await auditOrderedTelemetry(resultsDir);
  await writeFile(path.join(resultsDir, TELEMETRY_AUDIT_JSON_FILENAME), `${JSON.stringify(audit, null, 2)}\n`);
  await writeFile(path.join(resultsDir, TELEMETRY_AUDIT_MD_FILENAME), renderTelemetryAuditMarkdown(audit));
  return audit;
}

// Accept either --results or --out (the runner's flag) for the results root.
export function parseResultsDir(argv: readonly string[]): string {
  for (const flag of ["--results", "--out"]) {
    const index = argv.indexOf(flag);
    if (index >= 0 && argv[index + 1] !== undefined) return path.resolve(argv[index + 1] as string);
  }
  return path.resolve(DEFAULT_RESULTS_DIR);
}

if (import.meta.main) {
  const resultsDir = parseResultsDir(process.argv.slice(2));
  runOrderedTelemetryAudit(resultsDir)
    .then((audit) => {
      process.stdout.write(
        `Stage 5 ordered telemetry audit: ${audit.ordered}/${audit.totalRuns} runs have ordered telemetry ` +
          `(${audit.none} none, ${audit.rawStreamNoParsed} raw-only, ${audit.highCostMissing} high-cost missing).\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    });
}
