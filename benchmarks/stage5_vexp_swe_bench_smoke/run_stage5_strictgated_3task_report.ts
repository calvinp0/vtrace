// Stage 5 strict-gated 3-task comparison report.
//
// SCOPE: reporting / accounting ONLY. This reads EXISTING run artifacts for the 3-task
// strict-gated set (matplotlib, astropy, requests) and reports three conditions where
// available:
//   old    = controlled VTRACE        (eval-controlled-vtrace-*)
//   risk   = risk_gated VTRACE rerun  (eval-riskgated-vtrace-*)
//   strict = strict_risk_gated rerun  (eval-strictgated-vtrace-*)
// The primary comparison is risk → strict.
//
// It runs NO agents, NO live critic, NO repair, NO Docker, and changes NO retrieval /
// Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator
// / policy behavior. It never mutates a raw artifact; it only writes its own Markdown + JSON.
//
// Provenance is split deliberately (same rule as the reports it reuses):
//   * model usage / cost / resolution → the SWE-bench JSONL row under raw/vtrace/*.jsonl
//   * VTRACE policy / context metadata → _run.meta.json
//   * ordered tool-call count          → _tool_calls.json (falling back to meta count)
//   * evaluation metadata              → _eval.meta.json
// Token/cost numbers are NEVER read from _run.meta.json.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { delta, deltaPct } from "./run_stage5_pivot_check_report";
import { isRecord } from "./run_stage5_outcome_ledger";
import { discoverOldLabel } from "./run_stage5_riskgated_3task_report";
import {
  buildRunUsage,
  loadRun,
  type RawRunParts,
  type RunUsage,
} from "./run_stage5_riskgated_matplotlib_comparison";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const DEFAULT_OUT_NAME = "stage5_strictgated_3task_report";
export const PLAN_FILE = "stage5_controlled_10_task_plan.json";

export type TaskStatus = "complete" | "missing_strict" | "missing_risk" | "missing_old" | "incomplete";

// The 3-task strict-gated set. `oldLabelFallback` is the canonical controlled VTRACE label;
// the actual old label is preferably DISCOVERED from the controlled 10-task plan and only
// falls back when the plan has no entry. `riskLabel`/`strictLabel` are the rerun labels.
export interface TaskSeed {
  readonly instanceId: string;
  readonly oldLabelFallback: string;
  readonly riskLabel: string;
  readonly strictLabel: string;
}

export const TASK_SEEDS: readonly TaskSeed[] = [
  {
    instanceId: "matplotlib__matplotlib-22719",
    oldLabelFallback: "eval-controlled-vtrace-matplotlib-22719",
    riskLabel: "eval-riskgated-vtrace-matplotlib-22719",
    strictLabel: "eval-strictgated-vtrace-matplotlib-22719",
  },
  {
    instanceId: "astropy__astropy-14369",
    oldLabelFallback: "eval-controlled-vtrace-astropy-14369",
    riskLabel: "eval-riskgated-vtrace-astropy-14369",
    strictLabel: "eval-strictgated-vtrace-astropy-14369",
  },
  {
    instanceId: "psf__requests-5414",
    oldLabelFallback: "eval-controlled-vtrace-requests-5414",
    riskLabel: "eval-riskgated-vtrace-requests-5414",
    strictLabel: "eval-strictgated-vtrace-requests-5414",
  },
];

// The required interpretation statements, verbatim. They are emitted by the report and asserted
// by the tests so the framing cannot silently drift.
export const SUPPRESSION_CLAIMABLE_STATEMENT =
  "Unlike the risk_gated 3-task report, suppression is claimable here: strict_risk_gated " +
  "suppressed PIVOT_CHECK on hidden-pivot-only cases where multi_pivot would have injected.";

export const EFFICIENCY_STATEMENT =
  "Strict gating reduced tokens, cost, turns, and ordered tool calls on all three tasks without " +
  "reducing the resolved count in this small set.";

export const CAUTION_STATEMENTS: readonly string[] = [
  "This is n=3 and does not prove aggregate benchmark improvement.",
  "Astropy and Requests remain unresolved; strict gating improves efficiency, not necessarily patch quality.",
];

export const NON_CLAIMS: readonly string[] = [
  ...CAUTION_STATEMENTS,
  "It does not isolate which factor (tool-loop behavior, stochasticity, sampling) drove any token drop.",
  "It does not change retrieval, Capsule v2, PIVOT_CHECK, EDIT_GUARD, PATCH_VERIFY, probes, critic, repair, the evaluator, or policy behavior.",
  "It does not rerun agents or Docker; usage/cost/resolution are read verbatim from existing run + docker-eval artifacts.",
];

// ---------------------------------------------------------------------------
// Per-condition view (pure)
// ---------------------------------------------------------------------------

// The slice of a run used by this report — derived directly from a RunUsage so the provenance
// split (JSONL spend vs meta policy) is inherited unchanged. `suppressionClaimable` is computed:
// true ONLY when the policy WOULD have injected under multi_pivot but did NOT inject here.
export interface TaskRunView {
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly numTurns: number | null;
  readonly orderedToolCallCount: number | null;
  readonly resolved: boolean | null;
  readonly toolCallsByType: Record<string, number> | null;
  readonly pivotCheckPolicy: string | null;
  readonly policyReason: string | null;
  readonly riskSignals: readonly string[] | null;
  readonly wouldInjectUnderMultiPivot: boolean | null;
  readonly pivotCheckInjected: boolean | null;
  readonly editGuardInjected: boolean | null;
  readonly patchVerifyInjected: boolean | null;
  readonly suppressionClaimable: boolean | null;
}

// suppressionClaimable: true ONLY when the policy WOULD inject under multi_pivot AND did NOT
// inject here — i.e. the gate actively withheld a checklist the multi-pivot heuristic wanted.
export function suppressionClaimableOf(usage: RunUsage): boolean | null {
  if (usage.vtracePivotCheckWouldInjectUnderMultiPivot === null && usage.vtracePivotCheckInjected === null) {
    return null;
  }
  return (
    usage.vtracePivotCheckWouldInjectUnderMultiPivot === true &&
    usage.vtracePivotCheckInjected === false
  );
}

export function toRunView(usage: RunUsage): TaskRunView {
  return {
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
    numTurns: usage.numTurns,
    orderedToolCallCount: usage.orderedToolCallCount,
    resolved: usage.resolved,
    toolCallsByType: usage.toolCallsByType,
    pivotCheckPolicy: usage.vtracePivotCheckPolicy,
    policyReason: usage.vtracePivotCheckPolicyReason,
    riskSignals: usage.vtracePivotCheckRiskSignals,
    wouldInjectUnderMultiPivot: usage.vtracePivotCheckWouldInjectUnderMultiPivot,
    pivotCheckInjected: usage.vtracePivotCheckInjected,
    editGuardInjected: usage.vtraceEditGuardInjected,
    patchVerifyInjected: usage.vtracePatchVerifyInjected,
    suppressionClaimable: suppressionClaimableOf(usage),
  };
}

// ---------------------------------------------------------------------------
// Per-task comparison (pure)
// ---------------------------------------------------------------------------

export interface RiskToStrictDeltas {
  readonly tokenDelta: number | null;
  readonly tokenDeltaPct: number | null;
  readonly costDelta: number | null;
  readonly costDeltaPct: number | null;
  readonly turnDelta: number | null;
  readonly orderedToolCallDelta: number | null;
  // True when risk resolved the instance but strict did NOT — a resolution regression.
  readonly resolutionRegression: boolean;
}

export interface TaskComparison {
  readonly instanceId: string;
  readonly oldLabel: string | null;
  readonly riskLabel: string;
  readonly strictLabel: string;
  readonly status: TaskStatus;

  readonly old: TaskRunView | null;
  readonly risk: TaskRunView | null;
  readonly strict: TaskRunView | null;

  readonly riskToStrict: RiskToStrictDeltas;
}

function pairDelta(before: number | null, after: number | null): number | null {
  return before !== null && after !== null ? delta(before, after) : null;
}
function pairDeltaPct(before: number | null, after: number | null): number | null {
  return before !== null && after !== null ? deltaPct(before, after) : null;
}

export function buildRiskToStrictDeltas(
  riskView: TaskRunView | null,
  strictView: TaskRunView | null,
): RiskToStrictDeltas {
  return {
    tokenDelta: pairDelta(riskView?.totalTokens ?? null, strictView?.totalTokens ?? null),
    tokenDeltaPct: pairDeltaPct(riskView?.totalTokens ?? null, strictView?.totalTokens ?? null),
    costDelta: pairDelta(riskView?.costUsd ?? null, strictView?.costUsd ?? null),
    costDeltaPct: pairDeltaPct(riskView?.costUsd ?? null, strictView?.costUsd ?? null),
    turnDelta: pairDelta(riskView?.numTurns ?? null, strictView?.numTurns ?? null),
    orderedToolCallDelta: pairDelta(
      riskView?.orderedToolCallCount ?? null,
      strictView?.orderedToolCallCount ?? null,
    ),
    // A regression requires BOTH sides known: risk resolved, strict did not.
    resolutionRegression: riskView?.resolved === true && strictView?.resolved === false,
  };
}

function statusOf(
  oldAvailable: boolean,
  riskAvailable: boolean,
  strictAvailable: boolean,
): TaskStatus {
  if (oldAvailable && riskAvailable && strictAvailable) return "complete";
  const missing = [
    !oldAvailable ? "old" : null,
    !riskAvailable ? "risk" : null,
    !strictAvailable ? "strict" : null,
  ].filter((s): s is string => s !== null);
  if (missing.length === 1) return `missing_${missing[0]}` as TaskStatus;
  return "incomplete";
}

export function buildTask(
  seed: TaskSeed,
  oldLabel: string | null,
  oldParts: RawRunParts,
  riskParts: RawRunParts,
  strictParts: RawRunParts,
): TaskComparison {
  const oldAvailable = oldParts.record !== null;
  const riskAvailable = riskParts.record !== null;
  const strictAvailable = strictParts.record !== null;

  const old = oldAvailable ? toRunView(buildRunUsage(oldParts)) : null;
  const risk = riskAvailable ? toRunView(buildRunUsage(riskParts)) : null;
  const strict = strictAvailable ? toRunView(buildRunUsage(strictParts)) : null;

  return {
    instanceId: seed.instanceId,
    oldLabel,
    riskLabel: seed.riskLabel,
    strictLabel: seed.strictLabel,
    status: statusOf(oldAvailable, riskAvailable, strictAvailable),
    old,
    risk,
    strict,
    riskToStrict: buildRiskToStrictDeltas(risk, strict),
  };
}

// ---------------------------------------------------------------------------
// Aggregate (pure) — over tasks with BOTH risk and strict present
// ---------------------------------------------------------------------------

export interface Aggregate {
  readonly pairedCount: number;
  readonly riskTotalTokens: number | null;
  readonly strictTotalTokens: number | null;
  readonly tokenDelta: number | null;
  readonly tokenDeltaPct: number | null;
  readonly riskTotalCost: number | null;
  readonly strictTotalCost: number | null;
  readonly costDelta: number | null;
  readonly costDeltaPct: number | null;
  readonly riskTotalTurns: number | null;
  readonly strictTotalTurns: number | null;
  readonly turnDelta: number | null;
  readonly riskOrderedToolCalls: number | null;
  readonly strictOrderedToolCalls: number | null;
  readonly orderedToolCallDelta: number | null;
  readonly riskResolved: number;
  readonly strictResolved: number;
  readonly resolutionDelta: number;
  readonly resolutionRegressionCount: number;
  readonly suppressionClaimableCount: number;
  readonly strictPivotCheckInjectedCount: number;
  readonly strictEditGuardInjectedCount: number;
  readonly strictPatchVerifyInjectedCount: number;
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  const nums = values.filter((n): n is number => n !== null);
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
}

// A task is "paired" for the risk→strict aggregate when both risk and strict views are present.
function isPaired(t: TaskComparison): boolean {
  return t.risk !== null && t.strict !== null;
}

export function buildAggregate(tasks: readonly TaskComparison[]): Aggregate {
  const paired = tasks.filter(isPaired);

  const riskTotalTokens = sumOrNull(paired.map((t) => t.risk?.totalTokens ?? null));
  const strictTotalTokens = sumOrNull(paired.map((t) => t.strict?.totalTokens ?? null));
  const riskTotalCost = sumOrNull(paired.map((t) => t.risk?.costUsd ?? null));
  const strictTotalCost = sumOrNull(paired.map((t) => t.strict?.costUsd ?? null));
  const riskTotalTurns = sumOrNull(paired.map((t) => t.risk?.numTurns ?? null));
  const strictTotalTurns = sumOrNull(paired.map((t) => t.strict?.numTurns ?? null));
  const riskOrderedToolCalls = sumOrNull(paired.map((t) => t.risk?.orderedToolCallCount ?? null));
  const strictOrderedToolCalls = sumOrNull(paired.map((t) => t.strict?.orderedToolCallCount ?? null));

  const riskResolved = paired.filter((t) => t.risk?.resolved === true).length;
  const strictResolved = paired.filter((t) => t.strict?.resolved === true).length;

  return {
    pairedCount: paired.length,
    riskTotalTokens,
    strictTotalTokens,
    tokenDelta: pairDelta(riskTotalTokens, strictTotalTokens),
    tokenDeltaPct: pairDeltaPct(riskTotalTokens, strictTotalTokens),
    riskTotalCost,
    strictTotalCost,
    costDelta: pairDelta(riskTotalCost, strictTotalCost),
    costDeltaPct: pairDeltaPct(riskTotalCost, strictTotalCost),
    riskTotalTurns,
    strictTotalTurns,
    turnDelta: pairDelta(riskTotalTurns, strictTotalTurns),
    riskOrderedToolCalls,
    strictOrderedToolCalls,
    orderedToolCallDelta: pairDelta(riskOrderedToolCalls, strictOrderedToolCalls),
    riskResolved,
    strictResolved,
    resolutionDelta: strictResolved - riskResolved,
    resolutionRegressionCount: paired.filter((t) => t.riskToStrict.resolutionRegression).length,
    suppressionClaimableCount: paired.filter((t) => t.strict?.suppressionClaimable === true).length,
    strictPivotCheckInjectedCount: paired.filter((t) => t.strict?.pivotCheckInjected === true).length,
    strictEditGuardInjectedCount: paired.filter((t) => t.strict?.editGuardInjected === true).length,
    strictPatchVerifyInjectedCount: paired.filter((t) => t.strict?.patchVerifyInjected === true).length,
  };
}

// ---------------------------------------------------------------------------
// Recommendation (pure)
// ---------------------------------------------------------------------------

// All three strict runs present, suppression claimable on all three, token/cost/turns all
// improved (risk→strict deltas negative), and no resolution regression → promote strict_gated to
// a candidate default and run the 10-task strict-gated controlled comparison. Otherwise, hold and
// analyze. We never recommend more duplicate repair experiments.
export function chooseRecommendation(tasks: readonly TaskComparison[], agg: Aggregate): string {
  const allStrictPresent = tasks.length === 3 && tasks.every((t) => t.strict !== null);
  const tokensImproved = agg.tokenDelta !== null && agg.tokenDelta < 0;
  const costImproved = agg.costDelta !== null && agg.costDelta < 0;
  const turnsImproved = agg.turnDelta !== null && agg.turnDelta < 0;
  if (
    allStrictPresent &&
    agg.suppressionClaimableCount === 3 &&
    tokensImproved &&
    costImproved &&
    turnsImproved &&
    agg.resolutionRegressionCount === 0
  ) {
    return (
      "Update the Stage 5 controlled policy/accounting to include strict_risk_gated as a candidate " +
      "default, then run a 10-task strict-gated controlled comparison."
    );
  }
  return "Hold strict_risk_gated as a candidate and analyze per-task causes before a 10-task strict-gated comparison.";
}

// ---------------------------------------------------------------------------
// Report assembly (pure)
// ---------------------------------------------------------------------------

export interface Report {
  readonly generatedAt: string | null;
  readonly tasks: readonly TaskComparison[];
  readonly aggregate: Aggregate;
  readonly interpretation: readonly string[];
  readonly recommendation: string;
  readonly nonClaims: readonly string[];
}

export function buildReport(generatedAt: string | null, tasks: readonly TaskComparison[]): Report {
  const aggregate = buildAggregate(tasks);
  return {
    generatedAt,
    tasks,
    aggregate,
    interpretation: [SUPPRESSION_CLAIMABLE_STATEMENT, EFFICIENCY_STATEMENT, ...CAUTION_STATEMENTS],
    recommendation: chooseRecommendation(tasks, aggregate),
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

export function renderMarkdown(report: Report): string {
  const { tasks, aggregate: agg } = report;
  const lines: string[] = [];

  lines.push("# Stage 5 strict-gated 3-task comparison");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Reporting / accounting only. No agents, no live critic, no repair, no Docker. Usage / cost / " +
      "resolution come from the SWE-bench JSONL row; VTRACE policy / context metadata from " +
      "`_run.meta.json`; ordered tool calls from `_tool_calls.json`; evaluation from `_eval.meta.json`. " +
      "Token and cost numbers are never sourced from `_run.meta.json`. The primary comparison is " +
      "risk_gated → strict_risk_gated; the controlled (old) run is shown for context. No retrieval / " +
      "Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator / " +
      "policy behavior is changed, and no raw artifact is mutated._",
  );
  lines.push("");

  // --- Summary -------------------------------------------------------------
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `Comparison set: ${tasks.length} tasks (old controlled, risk_gated, strict_risk_gated). ` +
      `Paired (risk + strict present): ${agg.pairedCount}.`,
  );
  lines.push("");
  if (agg.pairedCount > 0) {
    lines.push(
      `Across paired tasks, risk_gated → strict_risk_gated: tokens ${fmtInt(agg.riskTotalTokens)} → ` +
        `${fmtInt(agg.strictTotalTokens)} (${fmtSignedInt(agg.tokenDelta)}, ${fmtPct(agg.tokenDeltaPct)}); cost ` +
        `${fmtCost(agg.riskTotalCost)} → ${fmtCost(agg.strictTotalCost)} (${fmtCost(agg.costDelta)}, ` +
        `${fmtPct(agg.costDeltaPct)}); turns ${fmtInt(agg.riskTotalTurns)} → ${fmtInt(agg.strictTotalTurns)} ` +
        `(${fmtSignedInt(agg.turnDelta)}); ordered tool calls ${fmtInt(agg.riskOrderedToolCalls)} → ` +
        `${fmtInt(agg.strictOrderedToolCalls)} (${fmtSignedInt(agg.orderedToolCallDelta)}); resolved ` +
        `${agg.riskResolved} → ${agg.strictResolved} (${agg.resolutionDelta >= 0 ? "+" : ""}${agg.resolutionDelta}).`,
    );
    lines.push("");
  }
  lines.push(
    `PIVOT_CHECK suppression claimable (strict): ${agg.suppressionClaimableCount}/${agg.pairedCount}. ` +
      `Resolution regressions (risk→strict): ${agg.resolutionRegressionCount}. Strict runs that still injected ` +
      `PIVOT_CHECK: ${agg.strictPivotCheckInjectedCount}.`,
  );
  lines.push("");

  // --- Aggregate risk-gated vs strict-gated --------------------------------
  lines.push("## Aggregate risk-gated vs strict-gated");
  lines.push("");
  lines.push("_Aggregates are over paired tasks only (both risk and strict usage present)._");
  lines.push("");
  lines.push("| metric | risk_gated | strict_risk_gated | Δ |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(`| pairedCount | — | — | ${agg.pairedCount} |`);
  lines.push(`| totalTokens | ${fmtInt(agg.riskTotalTokens)} | ${fmtInt(agg.strictTotalTokens)} | ${fmtSignedInt(agg.tokenDelta)} (${fmtPct(agg.tokenDeltaPct)}) |`);
  lines.push(`| totalCost | ${fmtCost(agg.riskTotalCost)} | ${fmtCost(agg.strictTotalCost)} | ${fmtCost(agg.costDelta)} (${fmtPct(agg.costDeltaPct)}) |`);
  lines.push(`| totalTurns | ${fmtInt(agg.riskTotalTurns)} | ${fmtInt(agg.strictTotalTurns)} | ${fmtSignedInt(agg.turnDelta)} |`);
  lines.push(`| orderedToolCalls | ${fmtInt(agg.riskOrderedToolCalls)} | ${fmtInt(agg.strictOrderedToolCalls)} | ${fmtSignedInt(agg.orderedToolCallDelta)} |`);
  lines.push(`| resolved | ${agg.riskResolved} | ${agg.strictResolved} | ${agg.resolutionDelta >= 0 ? "+" : ""}${agg.resolutionDelta} |`);
  lines.push(`| resolutionRegressionCount | — | — | ${agg.resolutionRegressionCount} |`);
  lines.push(`| suppressionClaimableCount | — | — | ${agg.suppressionClaimableCount} |`);
  lines.push(`| strictPivotCheckInjectedCount | — | — | ${agg.strictPivotCheckInjectedCount} |`);
  lines.push(`| strictEditGuardInjectedCount | — | — | ${agg.strictEditGuardInjectedCount} |`);
  lines.push(`| strictPatchVerifyInjectedCount | — | — | ${agg.strictPatchVerifyInjectedCount} |`);
  lines.push("");

  // --- Per-task comparison -------------------------------------------------
  lines.push("## Per-task comparison");
  lines.push("");
  lines.push("| instance | status | old label | risk label | strict label |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    lines.push(
      `| ${t.instanceId} | ${t.status} | ${t.oldLabel ? `\`${t.oldLabel}\`` : "null"} | ` +
        `\`${t.riskLabel}\` | \`${t.strictLabel}\` |`,
    );
  }
  lines.push("");
  lines.push("| instance | tokens old / risk / strict | cost old / risk / strict | turns old / risk / strict | resolved old / risk / strict |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    const tokens = `${fmtInt(t.old?.totalTokens ?? null)} / ${fmtInt(t.risk?.totalTokens ?? null)} / ${fmtInt(t.strict?.totalTokens ?? null)}`;
    const cost = `${fmtCost(t.old?.costUsd ?? null)} / ${fmtCost(t.risk?.costUsd ?? null)} / ${fmtCost(t.strict?.costUsd ?? null)}`;
    const turns = `${fmtInt(t.old?.numTurns ?? null)} / ${fmtInt(t.risk?.numTurns ?? null)} / ${fmtInt(t.strict?.numTurns ?? null)}`;
    const resolved = `${fmtBool(t.old?.resolved ?? null)} / ${fmtBool(t.risk?.resolved ?? null)} / ${fmtBool(t.strict?.resolved ?? null)}`;
    lines.push(`| ${t.instanceId} | ${tokens} | ${cost} | ${turns} | ${resolved} |`);
  }
  lines.push("");
  lines.push("Risk → strict deltas per task:");
  lines.push("");
  lines.push("| instance | token Δ (Δ%) | cost Δ (Δ%) | turn Δ | tool-call Δ | resolution regression |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    const d = t.riskToStrict;
    lines.push(
      `| ${t.instanceId} | ${fmtSignedInt(d.tokenDelta)} (${fmtPct(d.tokenDeltaPct)}) | ` +
        `${fmtCost(d.costDelta)} (${fmtPct(d.costDeltaPct)}) | ${fmtSignedInt(d.turnDelta)} | ` +
        `${fmtSignedInt(d.orderedToolCallDelta)} | ${d.resolutionRegression ? "yes" : "no"} |`,
    );
  }
  lines.push("");

  // --- Pivot-check suppression ---------------------------------------------
  lines.push("## Pivot-check suppression");
  lines.push("");
  lines.push("| instance | strict policy | risk signals | wouldInjectUnderMultiPivot | pivotCheckInjected | editGuardInjected | patchVerifyInjected | suppressionClaimable |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    const s = t.strict;
    lines.push(
      `| ${t.instanceId} | ${fmtStr(s?.pivotCheckPolicy ?? null)} | ${fmtSignals(s?.riskSignals ?? null)} | ` +
        `${fmtBool(s?.wouldInjectUnderMultiPivot ?? null)} | ${fmtBool(s?.pivotCheckInjected ?? null)} | ` +
        `${fmtBool(s?.editGuardInjected ?? null)} | ${fmtBool(s?.patchVerifyInjected ?? null)} | ` +
        `${fmtBool(s?.suppressionClaimable ?? null)} |`,
    );
  }
  lines.push("");
  lines.push(
    "`suppressionClaimable` is true ONLY when `wouldInjectUnderMultiPivot === true` AND " +
      "`pivotCheckInjected === false` — i.e. strict_risk_gated actively withheld a checklist that the " +
      "multi-pivot heuristic would have injected. Here every strict run had risk signals `[hidden_pivot]` " +
      "and strict treats hidden_pivot alone as insufficient, so PIVOT_CHECK was suppressed.",
  );
  lines.push("");
  lines.push(`> ${SUPPRESSION_CLAIMABLE_STATEMENT}`);
  lines.push("");

  // --- Tool-loop and turn-count impact -------------------------------------
  lines.push("## Tool-loop and turn-count impact");
  lines.push("");
  lines.push("| instance | ordered tool calls risk→strict (Δ) | turns risk→strict (Δ) | tokens Δ% |");
  lines.push("| --- | --- | --- | --- |");
  for (const t of tasks) {
    lines.push(
      `| ${t.instanceId} | ${fmtInt(t.risk?.orderedToolCallCount ?? null)}→${fmtInt(t.strict?.orderedToolCallCount ?? null)} ` +
        `(${fmtSignedInt(t.riskToStrict.orderedToolCallDelta)}) | ${fmtInt(t.risk?.numTurns ?? null)}→${fmtInt(t.strict?.numTurns ?? null)} ` +
        `(${fmtSignedInt(t.riskToStrict.turnDelta)}) | ${fmtPct(t.riskToStrict.tokenDeltaPct)} |`,
    );
  }
  lines.push("");
  lines.push(
    "With PIVOT_CHECK suppressed under strict gating, the drop in ordered tool calls and turns reflects " +
      "reduced agent/tool-loop behavior rather than a smaller initial context.",
  );
  lines.push("");

  // --- Resolution outcomes -------------------------------------------------
  lines.push("## Resolution outcomes");
  lines.push("");
  lines.push("| instance | old resolved | risk resolved | strict resolved | regression (risk→strict) |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    lines.push(
      `| ${t.instanceId} | ${fmtBool(t.old?.resolved ?? null)} | ${fmtBool(t.risk?.resolved ?? null)} | ` +
        `${fmtBool(t.strict?.resolved ?? null)} | ${t.riskToStrict.resolutionRegression ? "yes" : "no"} |`,
    );
  }
  lines.push("");
  lines.push(
    `Resolved count risk → strict: ${agg.riskResolved} → ${agg.strictResolved} ` +
      `(${agg.resolutionDelta >= 0 ? "+" : ""}${agg.resolutionDelta}); resolution regressions: ` +
      `${agg.resolutionRegressionCount}.`,
  );
  lines.push("");

  // --- Interpretation ------------------------------------------------------
  lines.push("## Interpretation");
  lines.push("");
  for (const claim of report.interpretation) lines.push(`- ${claim}`);
  lines.push("");

  // --- Recommendation ------------------------------------------------------
  lines.push("## Recommendation");
  lines.push("");
  lines.push(`**${report.recommendation}**`);
  lines.push("");
  lines.push("This report does not recommend further duplicate repair experiments.");
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

async function readPlan(resultsDir: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(path.join(resultsDir, PLAN_FILE), "utf8");
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// An all-null parts record used when no old label could be discovered.
function emptyParts(runLabel: string): RawRunParts {
  return { runLabel, meta: null, evalMeta: null, record: null, toolCalls: null };
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
      const [oldParts, riskParts, strictParts] = await Promise.all([
        oldLabel ? loadRun(config.resultsDir, oldLabel) : emptyParts(seed.oldLabelFallback),
        loadRun(config.resultsDir, seed.riskLabel),
        loadRun(config.resultsDir, seed.strictLabel),
      ]);
      return buildTask(seed, oldLabel, oldParts, riskParts, strictParts);
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
      "Stage 5 strict-gated 3-task comparison report written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Paired (risk + strict): ${agg.pairedCount}`,
      `Tokens (risk→strict): ${fmtInt(agg.riskTotalTokens)} → ${fmtInt(agg.strictTotalTokens)} (${fmtSignedInt(agg.tokenDelta)}, ${fmtPct(agg.tokenDeltaPct)})`,
      `Cost (risk→strict): ${fmtCost(agg.riskTotalCost)} → ${fmtCost(agg.strictTotalCost)} (${fmtCost(agg.costDelta)})`,
      `Turns (risk→strict): ${fmtInt(agg.riskTotalTurns)} → ${fmtInt(agg.strictTotalTurns)} (${fmtSignedInt(agg.turnDelta)})`,
      `Ordered tool calls (risk→strict): ${fmtInt(agg.riskOrderedToolCalls)} → ${fmtInt(agg.strictOrderedToolCalls)} (${fmtSignedInt(agg.orderedToolCallDelta)})`,
      `Resolved (risk→strict): ${agg.riskResolved} → ${agg.strictResolved}   suppression claimable: ${agg.suppressionClaimableCount}   resolution regressions: ${agg.resolutionRegressionCount}`,
      `Recommendation: ${report.recommendation}`,
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
