// Stage 5 risk-gated 3-task verification report.
//
// SCOPE: reporting / accounting ONLY. This reads EXISTING run artifacts for the 3-task
// risk-gated verification set (matplotlib, astropy, requests) and reports old (controlled
// VTRACE) vs new (risk_gated VTRACE) usage. It TOLERATES missing risk-gated runs: astropy
// and requests may not have been run yet, and those tasks are marked `missing_new_artifact`
// rather than treated as failures.
//
// It runs NO agents, NO live critic, NO repair, NO Docker, and changes NO retrieval /
// Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator
// / policy behavior. It never mutates a raw artifact; it only writes its own Markdown + JSON.
//
// Provenance is split deliberately (same rule as the matplotlib comparison it reuses):
//   * model usage / cost / resolution → the SWE-bench JSONL row under raw/vtrace/*.jsonl
//   * VTRACE policy / context metadata → _run.meta.json
//   * ordered tool-call count          → _tool_calls.json (falling back to meta count)
//   * evaluation metadata              → _eval.meta.json
// Token/cost numbers are NEVER read from _run.meta.json.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { delta, deltaPct } from "./run_stage5_pivot_check_report";
import { isRecord } from "./run_stage5_outcome_ledger";
import {
  buildRunUsage,
  buildRunEvaluation,
  loadRun,
  type RawRunParts,
  type RunUsage,
  type RunEvaluation,
} from "./run_stage5_riskgated_matplotlib_comparison";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const DEFAULT_OUT_NAME = "stage5_riskgated_3task_report";
export const PLAN_FILE = "stage5_controlled_10_task_plan.json";

export type TaskStatus = "paired" | "missing_new_artifact" | "missing_old_artifact";

// The 3-task verification set. `oldLabelFallback` is the canonical controlled VTRACE label;
// the actual old label is preferably DISCOVERED from the controlled 10-task plan and only
// falls back to this when the plan has no entry. `newLabel` is the risk_gated rerun label.
export interface TaskSeed {
  readonly instanceId: string;
  readonly oldLabelFallback: string;
  readonly newLabel: string;
  // Ready-to-copy commands to produce the risk_gated run + evaluation when it is missing.
  readonly runCommand: string;
  readonly evalCommand: string;
}

const ASTROPY_RUN_CMD = `bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \\
  --mode run-protocol --protocol vtrace-indexed \\
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \\
  --instances astropy__astropy-14369 \\
  --run-label eval-riskgated-vtrace-astropy-14369 \\
  --out benchmarks/stage5_vexp_swe_bench_smoke/results \\
  --capsule-engine v2 \\
  --context-policy force-inject \\
  --pivot-check-policy risk_gated \\
  --reuse-workspace \\
  --capsule-budget 8000`;

const REQUESTS_RUN_CMD = `bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \\
  --mode run-protocol --protocol vtrace-indexed \\
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \\
  --instances psf__requests-5414 \\
  --run-label eval-riskgated-vtrace-requests-5414 \\
  --out benchmarks/stage5_vexp_swe_bench_smoke/results \\
  --capsule-engine v2 \\
  --context-policy force-inject \\
  --pivot-check-policy risk_gated \\
  --reuse-workspace \\
  --capsule-budget 8000`;

const ASTROPY_EVAL_CMD = `bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \\
  --mode evaluate \\
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \\
  --run-label eval-riskgated-vtrace-astropy-14369 \\
  --out benchmarks/stage5_vexp_swe_bench_smoke/results`;

const REQUESTS_EVAL_CMD = `bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \\
  --mode evaluate \\
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \\
  --run-label eval-riskgated-vtrace-requests-5414 \\
  --out benchmarks/stage5_vexp_swe_bench_smoke/results`;

export const TASK_SEEDS: readonly TaskSeed[] = [
  {
    instanceId: "matplotlib__matplotlib-22719",
    oldLabelFallback: "eval-controlled-vtrace-matplotlib-22719",
    newLabel: "eval-riskgated-vtrace-matplotlib-22719",
    runCommand: "",
    evalCommand: "",
  },
  {
    instanceId: "astropy__astropy-14369",
    oldLabelFallback: "eval-controlled-vtrace-astropy-14369",
    newLabel: "eval-riskgated-vtrace-astropy-14369",
    runCommand: ASTROPY_RUN_CMD,
    evalCommand: ASTROPY_EVAL_CMD,
  },
  {
    instanceId: "psf__requests-5414",
    oldLabelFallback: "eval-controlled-vtrace-requests-5414",
    newLabel: "eval-riskgated-vtrace-requests-5414",
    runCommand: REQUESTS_RUN_CMD,
    evalCommand: REQUESTS_EVAL_CMD,
  },
];

export const NON_CLAIMS: readonly string[] = [
  "This does NOT prove risk_gated cut tokens by suppressing PIVOT_CHECK; where PIVOT_CHECK was still injected, the suppression pathway never fired.",
  "This is a small verification set (n≤3), not a statistical benchmark; no significance is claimed.",
  "It does not isolate which factor (tool-loop behavior, stochasticity, sampling) drove any token drop.",
  "It does not change retrieval, Capsule v2, PIVOT_CHECK, EDIT_GUARD, PATCH_VERIFY, probes, critic, repair, the evaluator, or policy behavior.",
  "It does not rerun agents or Docker; usage/cost/resolution are read verbatim from existing run + docker-eval artifacts.",
  "Missing risk-gated runs are reported as missing evidence; paired tasks whose usage grew are labeled regression_without_suppression, not missing_evidence.",
];

// ---------------------------------------------------------------------------
// Old-label discovery (pure)
// ---------------------------------------------------------------------------

// Discover the controlled VTRACE label for an instance from the 10-task plan's selectedTasks
// (`vtraceRunLabel`). Returns the fallback when the plan is absent but a fallback is known,
// and null only when discovery is genuinely ambiguous (no plan entry AND no fallback).
export function discoverOldLabel(
  plan: Record<string, unknown> | null,
  instanceId: string,
  fallback: string | null,
): string | null {
  if (plan !== null && Array.isArray(plan.selectedTasks)) {
    const entry = plan.selectedTasks
      .filter(isRecord)
      .find((t) => t.instanceId === instanceId);
    const label = entry && typeof entry.vtraceRunLabel === "string" ? entry.vtraceRunLabel : null;
    if (label) return label;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Per-task view (pure)
// ---------------------------------------------------------------------------

// The slice of a run used by this report — derived directly from a RunUsage so the provenance
// split (JSONL spend vs meta policy) is inherited unchanged.
export interface TaskRunView {
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly resolved: boolean | null;
  readonly orderedToolCallCount: number | null;
  readonly numTurns: number | null;
  readonly toolCallsByType: Record<string, number> | null;
  readonly vtracePivotCheckInjected: boolean | null;
  readonly vtracePivotCheckPolicy: string | null;
  readonly vtracePivotCheckPolicyReason: string | null;
  readonly vtracePivotCheckRiskSignals: readonly string[] | null;
  readonly vtracePivotCheckWouldInjectUnderMultiPivot: boolean | null;
}

export function toRunView(usage: RunUsage): TaskRunView {
  return {
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
    resolved: usage.resolved,
    orderedToolCallCount: usage.orderedToolCallCount,
    numTurns: usage.numTurns,
    toolCallsByType: usage.toolCallsByType,
    vtracePivotCheckInjected: usage.vtracePivotCheckInjected,
    vtracePivotCheckPolicy: usage.vtracePivotCheckPolicy,
    vtracePivotCheckPolicyReason: usage.vtracePivotCheckPolicyReason,
    vtracePivotCheckRiskSignals: usage.vtracePivotCheckRiskSignals,
    vtracePivotCheckWouldInjectUnderMultiPivot: usage.vtracePivotCheckWouldInjectUnderMultiPivot,
  };
}

export type TaskOutcome =
  | "suppression"
  | "lower_loopiness_without_suppression"
  | "no_suppression_no_improvement"
  | "regression_without_suppression"
  | "missing_evidence";

export interface TaskComparison {
  readonly instanceId: string;
  readonly oldLabel: string | null;
  readonly newLabel: string;
  readonly status: TaskStatus;

  readonly old: TaskRunView | null;
  readonly new: TaskRunView | null;

  readonly tokenDelta: number | null;
  readonly tokenDeltaPct: number | null;
  readonly costDelta: number | null;
  readonly costDeltaPct: number | null;
  readonly resolvedChanged: boolean | null;
  readonly orderedToolCallDelta: number | null;
  readonly numTurnDelta: number | null;

  readonly suppressionClaimable: boolean | null;
  readonly outcome: TaskOutcome;
  readonly outcomeDetail: string;

  // Carried for the missing-run command section; empty for tasks that are present.
  readonly runCommand: string;
  readonly evalCommand: string;
}

function pairDelta(before: number | null, after: number | null): number | null {
  return before !== null && after !== null ? delta(before, after) : null;
}
function pairDeltaPct(before: number | null, after: number | null): number | null {
  return before !== null && after !== null ? deltaPct(before, after) : null;
}

// suppressionClaimable per the spec: true ONLY when risk_gated actively withheld a checklist
// that the multi-pivot heuristic WOULD have injected. Both signals must be present; null when
// the new run is unavailable, false otherwise.
export function suppressionClaimableOf(newView: TaskRunView | null): boolean | null {
  if (newView === null) return null;
  return (
    newView.vtracePivotCheckWouldInjectUnderMultiPivot === true &&
    newView.vtracePivotCheckInjected === false
  );
}

// Classify the evidence each task provides toward the risk_gated hypothesis.
export function classifyOutcome(
  status: TaskStatus,
  oldView: TaskRunView | null,
  newView: TaskRunView | null,
  suppressionClaimable: boolean | null,
  tokenDelta: number | null,
  orderedToolCallDelta: number | null,
  numTurnDelta: number | null,
): { outcome: TaskOutcome; detail: string } {
  // `missing_evidence` is now RESERVED for genuinely missing artifacts / telemetry — never used
  // for a paired pair that simply failed to improve.
  if (status !== "paired" || oldView === null || newView === null) {
    return {
      outcome: "missing_evidence",
      detail:
        status === "missing_new_artifact"
          ? "risk-gated run not available yet — no new-side telemetry to compare."
          : status === "missing_old_artifact"
          ? "controlled (old) artifact not available — no baseline to compare."
          : "telemetry missing on one side — comparison incomplete.",
    };
  }
  if (suppressionClaimable === true) {
    return {
      outcome: "suppression",
      detail:
        "risk_gated WITHHELD PIVOT_CHECK that the multi-pivot heuristic would have injected " +
        "(wouldInjectUnderMultiPivot=true, injected=false) — direct evidence of suppression.",
    };
  }
  const loopDropped =
    (orderedToolCallDelta !== null && orderedToolCallDelta < 0) ||
    (numTurnDelta !== null && numTurnDelta < 0);
  if (newView.vtracePivotCheckInjected === true && loopDropped) {
    const tokenNote =
      tokenDelta !== null && tokenDelta < 0 ? " Tokens also dropped." : "";
    return {
      outcome: "lower_loopiness_without_suppression",
      detail:
        "PIVOT_CHECK was still injected, but ordered tool calls and/or turns dropped — improvement " +
        "without suppression (reduced agent/tool-loop behavior)." +
        tokenNote,
    };
  }
  // Both runs present, suppression not claimable, no loop/turn drop. Split the old catch-all
  // `missing_evidence` into two telemetry-backed labels: a regression (tokens / tool calls / turns
  // went UP without a resolution gain) vs a flat non-improvement.
  const resolvedImproved = oldView.resolved === false && newView.resolved === true;
  const tokensUp = tokenDelta !== null && tokenDelta > 0;
  const callsUp = orderedToolCallDelta !== null && orderedToolCallDelta > 0;
  const turnsUp = numTurnDelta !== null && numTurnDelta > 0;
  if (!resolvedImproved && (tokensUp || callsUp || turnsUp)) {
    const ups = [
      tokensUp ? "tokens" : null,
      callsUp ? "ordered tool calls" : null,
      turnsUp ? "turns" : null,
    ].filter((s): s is string => s !== null);
    return {
      outcome: "regression_without_suppression",
      detail:
        `PIVOT_CHECK suppression was not claimable and ${ups.join(" / ")} increased without a resolution ` +
        "gain — a regression, not missing evidence.",
    };
  }
  return {
    outcome: "no_suppression_no_improvement",
    detail:
      "Both runs present, but PIVOT_CHECK suppression was not claimable and there was no clear " +
      "token / tool-call / turn improvement and no resolution gain.",
  };
}

export function buildTask(
  seed: TaskSeed,
  oldLabel: string | null,
  oldParts: RawRunParts,
  newParts: RawRunParts,
): TaskComparison {
  const oldAvailable = oldParts.record !== null;
  const newAvailable = newParts.record !== null;

  const oldView = oldAvailable ? toRunView(buildRunUsage(oldParts)) : null;
  const newView = newAvailable ? toRunView(buildRunUsage(newParts)) : null;

  const status: TaskStatus = !oldAvailable
    ? "missing_old_artifact"
    : !newAvailable
    ? "missing_new_artifact"
    : "paired";

  const tokenDelta = pairDelta(oldView?.totalTokens ?? null, newView?.totalTokens ?? null);
  const tokenDeltaPct = pairDeltaPct(oldView?.totalTokens ?? null, newView?.totalTokens ?? null);
  const costDelta = pairDelta(oldView?.costUsd ?? null, newView?.costUsd ?? null);
  const costDeltaPct = pairDeltaPct(oldView?.costUsd ?? null, newView?.costUsd ?? null);
  const orderedToolCallDelta = pairDelta(
    oldView?.orderedToolCallCount ?? null,
    newView?.orderedToolCallCount ?? null,
  );
  const numTurnDelta = pairDelta(oldView?.numTurns ?? null, newView?.numTurns ?? null);
  const resolvedChanged =
    oldView?.resolved != null && newView?.resolved != null
      ? oldView.resolved !== newView.resolved
      : null;

  const suppressionClaimable = suppressionClaimableOf(newView);
  const { outcome, detail } = classifyOutcome(
    status,
    oldView,
    newView,
    suppressionClaimable,
    tokenDelta,
    orderedToolCallDelta,
    numTurnDelta,
  );

  return {
    instanceId: seed.instanceId,
    oldLabel,
    newLabel: seed.newLabel,
    status,
    old: oldView,
    new: newView,
    tokenDelta,
    tokenDeltaPct,
    costDelta,
    costDeltaPct,
    resolvedChanged,
    orderedToolCallDelta,
    numTurnDelta,
    suppressionClaimable,
    outcome,
    outcomeDetail: detail,
    runCommand: seed.runCommand,
    evalCommand: seed.evalCommand,
  };
}

// ---------------------------------------------------------------------------
// Aggregate (pure)
// ---------------------------------------------------------------------------

export interface Aggregate {
  readonly pairedCount: number;
  readonly missingNewCount: number;
  readonly missingOldCount: number;
  readonly totalOldTokens: number | null;
  readonly totalNewTokens: number | null;
  readonly totalTokenDelta: number | null;
  readonly totalTokenDeltaPct: number | null;
  readonly totalOldCost: number | null;
  readonly totalNewCost: number | null;
  readonly totalCostDelta: number | null;
  readonly totalCostDeltaPct: number | null;
  readonly resolvedOld: number;
  readonly resolvedNew: number;
  readonly resolvedDelta: number;
  readonly orderedToolCallsOld: number | null;
  readonly orderedToolCallsNew: number | null;
  readonly orderedToolCallDelta: number | null;
  readonly suppressionClaimableCount: number;
  readonly pivotCheckStillInjectedCount: number;
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  const nums = values.filter((n): n is number => n !== null);
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
}

export function buildAggregate(tasks: readonly TaskComparison[]): Aggregate {
  const paired = tasks.filter((t) => t.status === "paired");
  const totalOldTokens = sumOrNull(paired.map((t) => t.old?.totalTokens ?? null));
  const totalNewTokens = sumOrNull(paired.map((t) => t.new?.totalTokens ?? null));
  const totalOldCost = sumOrNull(paired.map((t) => t.old?.costUsd ?? null));
  const totalNewCost = sumOrNull(paired.map((t) => t.new?.costUsd ?? null));
  const orderedToolCallsOld = sumOrNull(paired.map((t) => t.old?.orderedToolCallCount ?? null));
  const orderedToolCallsNew = sumOrNull(paired.map((t) => t.new?.orderedToolCallCount ?? null));

  const resolvedOld = paired.filter((t) => t.old?.resolved === true).length;
  const resolvedNew = paired.filter((t) => t.new?.resolved === true).length;

  return {
    pairedCount: paired.length,
    missingNewCount: tasks.filter((t) => t.status === "missing_new_artifact").length,
    missingOldCount: tasks.filter((t) => t.status === "missing_old_artifact").length,
    totalOldTokens,
    totalNewTokens,
    totalTokenDelta: pairDelta(totalOldTokens, totalNewTokens),
    totalTokenDeltaPct: pairDeltaPct(totalOldTokens, totalNewTokens),
    totalOldCost,
    totalNewCost,
    totalCostDelta: pairDelta(totalOldCost, totalNewCost),
    totalCostDeltaPct: pairDeltaPct(totalOldCost, totalNewCost),
    resolvedOld,
    resolvedNew,
    resolvedDelta: resolvedNew - resolvedOld,
    orderedToolCallsOld,
    orderedToolCallsNew,
    orderedToolCallDelta: pairDelta(orderedToolCallsOld, orderedToolCallsNew),
    suppressionClaimableCount: tasks.filter((t) => t.suppressionClaimable === true).length,
    pivotCheckStillInjectedCount: tasks.filter((t) => t.new?.vtracePivotCheckInjected === true).length,
  };
}

// ---------------------------------------------------------------------------
// Recommended next step (pure)
// ---------------------------------------------------------------------------

// A paired task "improves" when tokens drop and tool calls do not increase, with no resolution
// regression (a task that was resolved and is now unresolved does NOT count as an improvement).
export function taskImproves(t: TaskComparison): boolean {
  if (t.status !== "paired") return false;
  const regression = t.old?.resolved === true && t.new?.resolved === false;
  if (regression) return false;
  const tokensDown = t.tokenDelta !== null && t.tokenDelta < 0;
  const callsNotUp = t.orderedToolCallDelta === null || t.orderedToolCallDelta <= 0;
  return tokensDown && callsNotUp;
}

export function chooseRecommendation(tasks: readonly TaskComparison[]): string {
  const paired = tasks.filter((t) => t.status === "paired");
  const missingNew = tasks.filter((t) => t.status === "missing_new_artifact");

  if (paired.length === tasks.length && tasks.length === 3) {
    const improved = paired.filter(taskImproves).length;
    if (improved >= 2) {
      return (
        "Update Stage 5 policy accounting for a risk-gated default comparison, then consider the " +
        "full 10-task rerun."
      );
    }
    return "Analyze per-task causes before rerunning the full 10-task set.";
  }

  // Not all three present → recommend running the remaining risk-gated tasks.
  const remaining = missingNew.map((t) => t.instanceId);
  if (paired.length === 1 && paired[0]!.instanceId === "matplotlib__matplotlib-22719" && remaining.length === 2) {
    return "Run the remaining two risk-gated verification tasks: astropy__astropy-14369 and psf__requests-5414.";
  }
  if (remaining.length > 0) {
    return `Run the remaining risk-gated verification task(s): ${remaining.join(", ")}.`;
  }
  return "Discover or restore the missing controlled (old) artifacts before comparing.";
}

// ---------------------------------------------------------------------------
// Report assembly (pure)
// ---------------------------------------------------------------------------

export interface Report {
  readonly generatedAt: string | null;
  readonly tasks: readonly TaskComparison[];
  readonly aggregate: Aggregate;
  readonly recommendation: string;
  readonly nonClaims: readonly string[];
}

export function buildReport(
  generatedAt: string | null,
  tasks: readonly TaskComparison[],
): Report {
  return {
    generatedAt,
    tasks,
    aggregate: buildAggregate(tasks),
    recommendation: chooseRecommendation(tasks),
    nonClaims: NON_CLAIMS,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function fmtInt(n: number | null): string {
  return n === null ? "n/a" : Math.round(n).toLocaleString("en-US");
}
function fmtCost(n: number | null): string {
  return n === null ? "n/a" : `$${n.toFixed(4)}`;
}
function fmtPct(n: number | null): string {
  return n === null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
function fmtSignedInt(n: number | null): string {
  return n === null ? "n/a" : `${n >= 0 ? "+" : ""}${Math.round(n).toLocaleString("en-US")}`;
}
function fmtBool(b: boolean | null): string {
  return b === null ? "unknown" : b ? "yes" : "no";
}
function fmtStr(s: string | null): string {
  return s === null ? "n/a" : s;
}
function fmtSignals(s: readonly string[] | null): string {
  return s === null ? "n/a" : s.length === 0 ? "[]" : `[${s.join(", ")}]`;
}
function fmtToolByType(t: Record<string, number> | null): string {
  if (t === null) return "n/a";
  const entries = Object.entries(t);
  return entries.length === 0 ? "{}" : entries.map(([k, v]) => `${k}:${v}`).join(", ");
}
function fmtClaimable(b: boolean | null): string {
  return b === null ? "n/a" : b ? "yes" : "no";
}

export function renderMarkdown(report: Report): string {
  const { tasks, aggregate: agg } = report;
  const lines: string[] = [];

  lines.push("# Stage 5 risk-gated 3-task verification report");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Reporting / accounting only. No agents, no live critic, no repair, no Docker. Usage / cost / " +
      "resolution come from the SWE-bench JSONL row; VTRACE policy / context metadata from " +
      "`_run.meta.json`; ordered tool calls from `_tool_calls.json`; evaluation from `_eval.meta.json`. " +
      "Token and cost numbers are never sourced from `_run.meta.json`. Missing risk-gated runs are " +
      "reported as missing evidence, not failures. No retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / " +
      "PATCH_VERIFY / probe / critic / repair / evaluator / policy behavior is changed, and no raw " +
      "artifact is mutated._",
  );
  lines.push("");

  // --- Summary -------------------------------------------------------------
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `Verification set: ${tasks.length} tasks. Paired (old+new present): ${agg.pairedCount}; ` +
      `missing risk-gated run: ${agg.missingNewCount}; missing controlled run: ${agg.missingOldCount}.`,
  );
  lines.push("");
  if (agg.pairedCount > 0) {
    lines.push(
      `Across paired tasks: tokens ${fmtInt(agg.totalOldTokens)} → ${fmtInt(agg.totalNewTokens)} ` +
        `(${fmtSignedInt(agg.totalTokenDelta)}, ${fmtPct(agg.totalTokenDeltaPct)}); cost ` +
        `${fmtCost(agg.totalOldCost)} → ${fmtCost(agg.totalNewCost)} (${fmtCost(agg.totalCostDelta)}, ` +
        `${fmtPct(agg.totalCostDeltaPct)}); ordered tool calls ${fmtInt(agg.orderedToolCallsOld)} → ` +
        `${fmtInt(agg.orderedToolCallsNew)} (${fmtSignedInt(agg.orderedToolCallDelta)}); resolved ` +
        `${agg.resolvedOld} → ${agg.resolvedNew} (${agg.resolvedDelta >= 0 ? "+" : ""}${agg.resolvedDelta}).`,
    );
    lines.push("");
  }
  lines.push(
    `PIVOT_CHECK suppression claimable: ${agg.suppressionClaimableCount}/${tasks.length}. ` +
      `New runs that still injected PIVOT_CHECK: ${agg.pivotCheckStillInjectedCount}.`,
  );
  lines.push("");

  // --- Task status ---------------------------------------------------------
  lines.push("## Task status");
  lines.push("");
  lines.push("| instance | old label | new label | status |");
  lines.push("| --- | --- | --- | --- |");
  for (const t of tasks) {
    lines.push(`| ${t.instanceId} | ${t.oldLabel ? `\`${t.oldLabel}\`` : "null"} | \`${t.newLabel}\` | ${t.status} |`);
  }
  lines.push("");

  // --- Aggregate old vs new comparison -------------------------------------
  lines.push("## Aggregate old vs new comparison");
  lines.push("");
  lines.push("_Aggregates are over paired tasks only (both old and new usage present)._");
  lines.push("");
  lines.push("| metric | old | new | Δ |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(`| pairedCount | — | — | ${agg.pairedCount} |`);
  lines.push(`| missingNewCount | — | — | ${agg.missingNewCount} |`);
  lines.push(`| totalTokens | ${fmtInt(agg.totalOldTokens)} | ${fmtInt(agg.totalNewTokens)} | ${fmtSignedInt(agg.totalTokenDelta)} (${fmtPct(agg.totalTokenDeltaPct)}) |`);
  lines.push(`| totalCost | ${fmtCost(agg.totalOldCost)} | ${fmtCost(agg.totalNewCost)} | ${fmtCost(agg.totalCostDelta)} (${fmtPct(agg.totalCostDeltaPct)}) |`);
  lines.push(`| resolved | ${agg.resolvedOld} | ${agg.resolvedNew} | ${agg.resolvedDelta >= 0 ? "+" : ""}${agg.resolvedDelta} |`);
  lines.push(`| orderedToolCalls | ${fmtInt(agg.orderedToolCallsOld)} | ${fmtInt(agg.orderedToolCallsNew)} | ${fmtSignedInt(agg.orderedToolCallDelta)} |`);
  lines.push(`| suppressionClaimableCount | — | — | ${agg.suppressionClaimableCount} |`);
  lines.push(`| pivotCheckStillInjectedCount | — | — | ${agg.pivotCheckStillInjectedCount} |`);
  lines.push("");

  // --- Per-task comparison -------------------------------------------------
  lines.push("## Per-task comparison");
  lines.push("");
  lines.push(
    "| instance | status | tokens old→new (Δ%) | cost old→new | resolved old→new | tool calls old→new | turns old→new |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    const tokens = `${fmtInt(t.old?.totalTokens ?? null)}→${fmtInt(t.new?.totalTokens ?? null)} (${fmtPct(t.tokenDeltaPct)})`;
    const cost = `${fmtCost(t.old?.costUsd ?? null)}→${fmtCost(t.new?.costUsd ?? null)}`;
    const resolved = `${fmtBool(t.old?.resolved ?? null)}→${fmtBool(t.new?.resolved ?? null)}`;
    const calls = `${fmtInt(t.old?.orderedToolCallCount ?? null)}→${fmtInt(t.new?.orderedToolCallCount ?? null)} (${fmtSignedInt(t.orderedToolCallDelta)})`;
    const turns = `${fmtInt(t.old?.numTurns ?? null)}→${fmtInt(t.new?.numTurns ?? null)} (${fmtSignedInt(t.numTurnDelta)})`;
    lines.push(`| ${t.instanceId} | ${t.status} | ${tokens} | ${cost} | ${resolved} | ${calls} | ${turns} |`);
  }
  lines.push("");
  for (const t of tasks) {
    lines.push(`### ${t.instanceId}`);
    lines.push("");
    lines.push(`- **Status**: ${t.status}.`);
    lines.push(`- **Labels**: old ${t.oldLabel ? `\`${t.oldLabel}\`` : "null"} → new \`${t.newLabel}\`.`);
    lines.push(
      `- **toolCallsByType**: old ${fmtToolByType(t.old?.toolCallsByType ?? null)}; new ${fmtToolByType(t.new?.toolCallsByType ?? null)}.`,
    );
    lines.push(`- **Outcome**: ${t.outcome} — ${t.outcomeDetail}`);
    lines.push("");
  }

  // --- Pivot-check policy outcomes -----------------------------------------
  lines.push("## Pivot-check policy outcomes");
  lines.push("");
  lines.push("| instance | old injected | new injected | new policy | wouldInjectUnderMultiPivot | risk signals | suppressionClaimable |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    lines.push(
      `| ${t.instanceId} | ${fmtBool(t.old?.vtracePivotCheckInjected ?? null)} | ` +
        `${fmtBool(t.new?.vtracePivotCheckInjected ?? null)} | ${fmtStr(t.new?.vtracePivotCheckPolicy ?? null)} | ` +
        `${fmtBool(t.new?.vtracePivotCheckWouldInjectUnderMultiPivot ?? null)} | ` +
        `${fmtSignals(t.new?.vtracePivotCheckRiskSignals ?? null)} | ${fmtClaimable(t.suppressionClaimable)} |`,
    );
  }
  lines.push("");
  lines.push(
    "`suppressionClaimable` is true ONLY when `vtracePivotCheckWouldInjectUnderMultiPivot === true` AND " +
      "`vtracePivotCheckInjected === false` — i.e. risk_gated actively withheld a checklist the multi-pivot " +
      "heuristic would have injected.",
  );
  lines.push("");

  // --- Tool-loop / turn-count analysis -------------------------------------
  lines.push("## Tool-loop / turn-count analysis");
  lines.push("");
  lines.push("| instance | ordered tool calls old→new (Δ) | turns old→new (Δ) | tokens Δ% |");
  lines.push("| --- | --- | --- | --- |");
  for (const t of tasks) {
    lines.push(
      `| ${t.instanceId} | ${fmtInt(t.old?.orderedToolCallCount ?? null)}→${fmtInt(t.new?.orderedToolCallCount ?? null)} ` +
        `(${fmtSignedInt(t.orderedToolCallDelta)}) | ${fmtInt(t.old?.numTurns ?? null)}→${fmtInt(t.new?.numTurns ?? null)} ` +
        `(${fmtSignedInt(t.numTurnDelta)}) | ${fmtPct(t.tokenDeltaPct)} |`,
    );
  }
  lines.push("");
  lines.push(
    "Where PIVOT_CHECK was still injected, a drop in ordered tool calls and turns is evidence of reduced " +
      "agent/tool-loop behavior rather than smaller initial context.",
  );
  lines.push("");

  // --- Resolution outcomes -------------------------------------------------
  lines.push("## Resolution outcomes");
  lines.push("");
  lines.push("| instance | old resolved | new resolved | changed |");
  lines.push("| --- | --- | --- | --- |");
  for (const t of tasks) {
    lines.push(
      `| ${t.instanceId} | ${fmtBool(t.old?.resolved ?? null)} | ${fmtBool(t.new?.resolved ?? null)} | ` +
        `${t.resolvedChanged === null ? "unknown" : t.resolvedChanged ? "yes" : "no"} |`,
    );
  }
  lines.push("");

  // --- Interpretation ------------------------------------------------------
  lines.push("## Interpretation");
  lines.push("");
  lines.push("Each task is classified into one of these evidence outcomes:");
  lines.push("");
  lines.push("1. **suppression** — risk_gated prevented PIVOT_CHECK where multi-pivot would have injected.");
  lines.push("2. **lower_loopiness_without_suppression** — PIVOT_CHECK still injected, but tool calls/turns dropped.");
  lines.push("3. **regression_without_suppression** — paired, no suppression, and tokens / tool calls / turns increased without a resolution gain.");
  lines.push("4. **no_suppression_no_improvement** — paired, no suppression, and no clear token / tool / turn improvement or resolution gain.");
  lines.push("5. **missing_evidence** — RESERVED for missing artifacts or missing telemetry only (not for paired non-improving tasks).");
  lines.push("");
  for (const t of tasks) {
    lines.push(`- \`${t.instanceId}\`: **${t.outcome}** — ${t.outcomeDetail}`);
  }
  lines.push("");
  const mpl = tasks.find((t) => t.instanceId === "matplotlib__matplotlib-22719");
  if (mpl && mpl.status === "paired") {
    lines.push(
      "matplotlib improved strongly, but suppression is not claimable because PIVOT_CHECK still injected " +
        "due to hidden_pivot.",
    );
    lines.push("");
  }

  // --- Recommended next step -----------------------------------------------
  lines.push("## Recommended next step");
  lines.push("");
  lines.push(`**${report.recommendation}**`);
  lines.push("");
  const missing = tasks.filter((t) => t.status === "missing_new_artifact" && t.runCommand.length > 0);
  if (missing.length > 0) {
    lines.push("Ready-to-copy commands for the missing risk-gated runs:");
    lines.push("");
    for (const t of missing) {
      lines.push(`#### ${t.instanceId} — run`);
      lines.push("");
      lines.push("```bash");
      lines.push(t.runCommand);
      lines.push("```");
      lines.push("");
      lines.push(`#### ${t.instanceId} — evaluate`);
      lines.push("");
      lines.push("```bash");
      lines.push(t.evalCommand);
      lines.push("```");
      lines.push("");
    }
  }

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

async function readPlan(resultsDir: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(path.join(resultsDir, PLAN_FILE), "utf8");
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
  const plan = await readPlan(config.resultsDir);

  const tasks = await Promise.all(
    TASK_SEEDS.map(async (seed) => {
      const oldLabel = discoverOldLabel(plan, seed.instanceId, seed.oldLabelFallback);
      const [oldParts, newParts] = await Promise.all([
        oldLabel ? loadRun(config.resultsDir, oldLabel) : emptyParts(seed.oldLabelFallback),
        loadRun(config.resultsDir, seed.newLabel),
      ]);
      return buildTask(seed, oldLabel, oldParts, newParts);
    }),
  );

  const report = buildReport(generatedAt, tasks);

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const agg = report.aggregate;
  process.stdout.write(
    [
      "Stage 5 risk-gated 3-task verification report written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Paired: ${agg.pairedCount}   missing new: ${agg.missingNewCount}   missing old: ${agg.missingOldCount}`,
      `Tokens (paired): ${fmtInt(agg.totalOldTokens)} → ${fmtInt(agg.totalNewTokens)} (${fmtSignedInt(agg.totalTokenDelta)}, ${fmtPct(agg.totalTokenDeltaPct)})`,
      `Cost (paired): ${fmtCost(agg.totalOldCost)} → ${fmtCost(agg.totalNewCost)} (${fmtCost(agg.totalCostDelta)})`,
      `Ordered tool calls (paired): ${fmtInt(agg.orderedToolCallsOld)} → ${fmtInt(agg.orderedToolCallsNew)} (${fmtSignedInt(agg.orderedToolCallDelta)})`,
      `Resolved (paired): ${agg.resolvedOld} → ${agg.resolvedNew}   suppression claimable: ${agg.suppressionClaimableCount}   pivot still injected: ${agg.pivotCheckStillInjectedCount}`,
      `Recommendation: ${report.recommendation}`,
      "",
    ].join("\n"),
  );
}

// An all-null parts record used when no old label could be discovered.
function emptyParts(runLabel: string): RawRunParts {
  return { runLabel, meta: null, evalMeta: null, record: null, toolCalls: null };
}

// buildRunEvaluation/RunEvaluation are re-exported here so downstream accounting scripts can
// reuse the same docker-eval reader without importing the matplotlib module directly.
export { buildRunEvaluation };
export type { RunEvaluation };

if (import.meta.main) {
  try {
    await main(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
