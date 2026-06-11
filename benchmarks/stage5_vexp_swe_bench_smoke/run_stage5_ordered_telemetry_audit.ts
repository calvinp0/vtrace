// Stage 5 ordered-telemetry completeness audit.
//
// Scans the Stage 5 result run directories and reports, per (run-label, condition)
// run, whether ordered tool-call telemetry was captured:
//   - ordered                 → `_tool_calls.json` present and parsed (orderedTelemetryAvailable)
//   - raw-stream-no-parsed    → the stream patch ran but produced no usable parsed log
//                               (sentinel / parse error): raw stream present, no ordered telemetry
//   - none                    → neither (legacy run that never captured stream-json)
//
// It also flags high-token/high-cost runs that are missing telemetry (joined from
// the normalized artifact) and runs that tripped the diagnostic loop heuristics.
//
// This report does NOT re-run agents, does NOT infer tool order when stream-json is
// missing, and the loop heuristics are diagnostic only — they never affect patch
// generation. (Implementation recommendation 3: make missing ordered telemetry
// visible immediately.)

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OrderedToolCallSummary } from "../../src/capsule/toolCallLog";
import {
  NORMALIZED_FILENAME,
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

// A run is "high cost" if either threshold is met. Conservative defaults — these
// only decide which missing-telemetry runs are surfaced as high-priority, never
// anything load-bearing.
export const HIGH_COST_USD_THRESHOLD = 0.5;
export const HIGH_COST_TOKENS_THRESHOLD = 1_000_000;

export type TelemetryState = "ordered" | "raw-stream-no-parsed" | "none";

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
  costUsd: number | null;
  totalTokens: number | null;
  highCost: boolean;
  toolUseDisciplineInjected: boolean | null;
}

export interface TelemetryAudit {
  resultsDir: string;
  totalRuns: number;
  ordered: number;
  rawStreamNoParsed: number;
  none: number;
  highCostMissing: number;
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

  const cost = instanceId !== null ? costIndex.get(`${instanceId}|${condition}`) ?? null : null;
  const costUsd = cost?.costUsd ?? null;
  const totalTokens = cost?.totalTokens ?? null;
  const highCost =
    (costUsd !== null && costUsd >= HIGH_COST_USD_THRESHOLD) ||
    (totalTokens !== null && totalTokens >= HIGH_COST_TOKENS_THRESHOLD);

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
    costUsd,
    totalTokens,
    highCost,
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
];

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
    totalRuns: runs.length,
    ordered: runs.filter((run) => run.state === "ordered").length,
    rawStreamNoParsed: runs.filter((run) => run.state === "raw-stream-no-parsed").length,
    none: runs.filter((run) => run.state === "none").length,
    highCostMissing: runs.filter((run) => run.highCost && run.state !== "ordered").length,
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

export function renderTelemetryAuditMarkdown(audit: TelemetryAudit): string {
  const lines: string[] = [];
  lines.push("# Stage 5 ordered telemetry audit", "");

  lines.push("## Summary", "");
  lines.push(`- Results dir: \`${audit.resultsDir}\``);
  lines.push(`- Total agent runs scanned: ${audit.totalRuns}`);
  lines.push(`- Ordered telemetry present: ${audit.ordered}`);
  lines.push(`- Raw stream present but not parsed: ${audit.rawStreamNoParsed}`);
  lines.push(`- No telemetry (legacy / never captured): ${audit.none}`);
  lines.push(`- High-cost runs missing telemetry: ${audit.highCostMissing}`);
  lines.push(`- Runs tripping a loop heuristic: ${audit.loopHeuristicHits}`);
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
  const highCostMissing = audit.runs.filter((run) => run.highCost && run.state !== "ordered");
  if (highCostMissing.length === 0) {
    lines.push(
      `_None above the high-cost thresholds (≥ ${fmtCost(HIGH_COST_USD_THRESHOLD)} or ≥ ${fmtTokens(HIGH_COST_TOKENS_THRESHOLD)} tokens)._`,
      "",
    );
  } else {
    lines.push("| run-label | condition | instance | cost | tokens | state |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const run of highCostMissing) {
      lines.push(
        `| ${runLabelCell(run)} | ${run.condition} | ${run.instanceId ?? "—"} | ${fmtCost(run.costUsd)} | ${fmtTokens(run.totalTokens)} | ${run.state} |`,
      );
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
      `${audit.highCostMissing} high-cost run(s) are missing telemetry — prioritize re-capturing these, since the largest unexplained deltas are the ones worth ordered tool logs.`,
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

function parseResultsDir(argv: readonly string[]): string {
  const index = argv.indexOf("--out");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return path.resolve(value ?? DEFAULT_RESULTS_DIR);
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
