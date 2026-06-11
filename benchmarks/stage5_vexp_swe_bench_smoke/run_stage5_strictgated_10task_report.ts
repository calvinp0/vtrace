// Stage 5 strict-gated 10-task comparison report.
//
// SCOPE: reporting / accounting ONLY. This reads EXISTING run artifacts for the controlled
// 10-task set and reports, per task:
//   baseline   = non-VTRACE baseline run        (raw/baseline)
//   oldVtrace  = controlled VTRACE run           (raw/vtrace)
//   strict     = strict_risk_gated VTRACE rerun  (raw/vtrace)
// risk_gated VTRACE is shown where available. The primary comparison is oldVtrace → strict.
// The report answers: should strict_risk_gated become the INTERNAL Stage 5 default PIVOT_CHECK
// policy? (Internal behavior — never a user-facing toggle.)
//
// It runs NO agents, NO live critic, NO repair, NO Docker, and changes NO retrieval /
// Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator
// / policy behavior. It never mutates a raw artifact; it only writes its own Markdown + JSON.
//
// Provenance is split deliberately (same rule as the reports it reuses):
//   * model usage / cost / resolution → the SWE-bench JSONL row under raw/<condition>/*.jsonl
//   * VTRACE policy / context metadata → _run.meta.json
//   * ordered tool-call count          → _tool_calls.json (falling back to meta count)
//   * evaluation metadata              → _eval.meta.json
// Token/cost numbers are NEVER read from _run.meta.json.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { delta, deltaPct } from "./run_stage5_pivot_check_report";
import { isRecord } from "./run_stage5_outcome_ledger";
import {
  buildRunUsage,
  type RawRunParts,
  type RawToolCall,
} from "./run_stage5_riskgated_matplotlib_comparison";
import { toRunView, type TaskRunView } from "./run_stage5_strictgated_3task_report";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const DEFAULT_OUT_NAME = "stage5_strictgated_10task_report";
export const PLAN_FILE = "stage5_controlled_10_task_plan.json";

// A meaningful number of suppression-claimable tasks in the 10-task set. Below this, strict's
// suppression is not yet "meaningful" enough to anchor an internal-default decision on its own.
export const MEANINGFUL_SUPPRESSION_MIN = 3;

export type TaskStatus = "complete" | "missing_strict" | "missing_old" | "missing_baseline" | "incomplete";

export type ResolutionChange = "win" | "loss" | "same" | "unknown";

export type DefaultDecision =
  | "make_default"
  | "hold_resolution_loss"
  | "hold_no_token_saving"
  | "hold_insufficient_evidence";

// The required recommendation statements, verbatim. Asserted by tests so the framing cannot drift.
export const MAKE_DEFAULT_STATEMENT =
  "Make strict_risk_gated the internal Stage 5 default PIVOT_CHECK policy.";
export const INTERNAL_NOT_TOGGLE_STATEMENT =
  "This should be an internal default policy, not a normal user toggle. Users should see simple " +
  "modes such as auto/fast/thorough/debug.";
export const HOLD_RESOLUTION_LOSS_STATEMENT =
  "Do not make it default yet. Identify which lost task needs a stronger risk signal.";
export const HOLD_NO_TOKEN_SAVING_STATEMENT =
  "Do not make it default. Keep current risk_gated and continue investigating tool-loop causes.";
export const HOLD_INSUFFICIENT_STATEMENT =
  "Do not make it default yet. Strict saved tokens without a net resolution regression, but the " +
  "cost saving or suppression evidence is not yet decisive; gather more controlled runs.";

export const NON_CLAIMS: readonly string[] = [
  "This is a single controlled 10-task set, not a statistical benchmark; no significance is claimed.",
  "It does not isolate which factor (tool-loop behavior, stochasticity, sampling) drove any token change.",
  "It does not change retrieval, Capsule v2, PIVOT_CHECK, EDIT_GUARD, PATCH_VERIFY, probes, critic, repair, the evaluator, or policy behavior.",
  "It does not rerun agents or Docker; usage/cost/resolution are read verbatim from existing run + docker-eval artifacts.",
  "CLI policy flags are benchmark/dev controls only; the recommendation concerns the internal default, not a user-facing toggle.",
  "Repair accounting is tracked by separate reports; this report does not re-run or re-account repair.",
];

// ---------------------------------------------------------------------------
// Task seeds (pure)
// ---------------------------------------------------------------------------

export interface TaskSeed {
  readonly instanceId: string;
  readonly baselineLabel: string | null; // discovered from plan (baselineRunLabel)
  readonly oldVtraceLabel: string | null; // discovered from plan (vtraceRunLabel)
  readonly strictLabel: string; // canonical eval-strictgated-vtrace-<short>
  readonly riskLabel: string; // canonical eval-riskgated-vtrace-<short> (optional on disk)
}

// The canonical strict/risk run label for an instance: prefix + the post-`__` short id.
export function strictLabelFor(instanceId: string): string {
  const short = instanceId.includes("__") ? instanceId.split("__")[1]! : instanceId;
  return `eval-strictgated-vtrace-${short}`;
}
export function riskLabelFor(instanceId: string): string {
  const short = instanceId.includes("__") ? instanceId.split("__")[1]! : instanceId;
  return `eval-riskgated-vtrace-${short}`;
}

// Discover baseline + old-VTRACE labels for an instance from the controlled 10-task plan's
// selectedTasks. Returns nulls when the plan has no entry for the instance.
export function discoverPlanLabels(
  plan: Record<string, unknown> | null,
  instanceId: string,
): { baselineLabel: string | null; oldVtraceLabel: string | null } {
  if (plan !== null && Array.isArray(plan.selectedTasks)) {
    const entry = plan.selectedTasks.filter(isRecord).find((t) => t.instanceId === instanceId);
    if (entry) {
      return {
        baselineLabel: typeof entry.baselineRunLabel === "string" ? entry.baselineRunLabel : null,
        oldVtraceLabel: typeof entry.vtraceRunLabel === "string" ? entry.vtraceRunLabel : null,
      };
    }
  }
  return { baselineLabel: null, oldVtraceLabel: null };
}

// Build the ordered list of task seeds from the plan's selectedTasks (preserving plan order).
export function seedsFromPlan(plan: Record<string, unknown> | null): TaskSeed[] {
  const tasks = plan !== null && Array.isArray(plan.selectedTasks) ? plan.selectedTasks.filter(isRecord) : [];
  return tasks
    .map((t) => (typeof t.instanceId === "string" ? t.instanceId : null))
    .filter((id): id is string => id !== null)
    .map((instanceId) => {
      const { baselineLabel, oldVtraceLabel } = discoverPlanLabels(plan, instanceId);
      return {
        instanceId,
        baselineLabel,
        oldVtraceLabel,
        strictLabel: strictLabelFor(instanceId),
        riskLabel: riskLabelFor(instanceId),
      };
    });
}

// ---------------------------------------------------------------------------
// Plan-recorded baseline fallback (pure)
// ---------------------------------------------------------------------------

// When a baseline run dir is unavailable, the plan still records baselineTokens / baselineCost /
// baselineResolved. This is a fallback ONLY; the JSONL row is preferred when present.
export interface PlanBaseline {
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly resolved: boolean | null;
}
export function planBaselineOf(
  plan: Record<string, unknown> | null,
  instanceId: string,
): PlanBaseline {
  const tasks = plan !== null && Array.isArray(plan.selectedTasks) ? plan.selectedTasks.filter(isRecord) : [];
  const entry = tasks.find((t) => t.instanceId === instanceId);
  return {
    totalTokens: entry && typeof entry.baselineTokens === "number" ? entry.baselineTokens : null,
    costUsd: entry && typeof entry.baselineCost === "number" ? entry.baselineCost : null,
    resolved: entry && typeof entry.baselineResolved === "boolean" ? entry.baselineResolved : null,
  };
}

// ---------------------------------------------------------------------------
// Per-task comparison (pure)
// ---------------------------------------------------------------------------

export interface OldToStrictDeltas {
  readonly tokenDelta: number | null;
  readonly tokenDeltaPct: number | null;
  readonly costDelta: number | null;
  readonly costDeltaPct: number | null;
  readonly turnDelta: number | null;
  readonly orderedToolCallDelta: number | null;
  readonly resolutionChange: ResolutionChange;
}

export interface TaskComparison {
  readonly instanceId: string;
  readonly baselineLabel: string | null;
  readonly oldVtraceLabel: string | null;
  readonly strictLabel: string;
  readonly riskLabel: string;
  readonly status: TaskStatus;

  readonly baseline: TaskRunView | null;
  readonly oldVtrace: TaskRunView | null;
  readonly risk: TaskRunView | null;
  readonly strict: TaskRunView | null;

  readonly oldToStrict: OldToStrictDeltas;
}

function pairDelta(before: number | null, after: number | null): number | null {
  return before !== null && after !== null ? delta(before, after) : null;
}
function pairDeltaPct(before: number | null, after: number | null): number | null {
  return before !== null && after !== null ? deltaPct(before, after) : null;
}

export function resolutionChangeOf(
  oldResolved: boolean | null,
  strictResolved: boolean | null,
): ResolutionChange {
  if (oldResolved === null || strictResolved === null) return "unknown";
  if (oldResolved === strictResolved) return "same";
  return !oldResolved && strictResolved ? "win" : "loss";
}

export function buildOldToStrictDeltas(
  oldView: TaskRunView | null,
  strictView: TaskRunView | null,
): OldToStrictDeltas {
  return {
    tokenDelta: pairDelta(oldView?.totalTokens ?? null, strictView?.totalTokens ?? null),
    tokenDeltaPct: pairDeltaPct(oldView?.totalTokens ?? null, strictView?.totalTokens ?? null),
    costDelta: pairDelta(oldView?.costUsd ?? null, strictView?.costUsd ?? null),
    costDeltaPct: pairDeltaPct(oldView?.costUsd ?? null, strictView?.costUsd ?? null),
    turnDelta: pairDelta(oldView?.numTurns ?? null, strictView?.numTurns ?? null),
    orderedToolCallDelta: pairDelta(
      oldView?.orderedToolCallCount ?? null,
      strictView?.orderedToolCallCount ?? null,
    ),
    resolutionChange: resolutionChangeOf(oldView?.resolved ?? null, strictView?.resolved ?? null),
  };
}

function statusOf(baseline: boolean, old: boolean, strict: boolean): TaskStatus {
  if (baseline && old && strict) return "complete";
  const missing = [!baseline ? "baseline" : null, !old ? "old" : null, !strict ? "strict" : null].filter(
    (s): s is string => s !== null,
  );
  if (missing.length === 1) return `missing_${missing[0]}` as TaskStatus;
  return "incomplete";
}

// A run view from a plan-recorded baseline fallback (only the three recorded fields are known).
function planBaselineView(b: PlanBaseline): TaskRunView | null {
  if (b.totalTokens === null && b.costUsd === null && b.resolved === null) return null;
  return {
    totalTokens: b.totalTokens,
    costUsd: b.costUsd,
    numTurns: null,
    orderedToolCallCount: null,
    resolved: b.resolved,
    toolCallsByType: null,
    pivotCheckPolicy: null,
    policyReason: null,
    riskSignals: null,
    wouldInjectUnderMultiPivot: null,
    pivotCheckInjected: null,
    editGuardInjected: null,
    patchVerifyInjected: null,
    suppressionClaimable: null,
  };
}

export function buildTask(
  seed: TaskSeed,
  baselineParts: RawRunParts,
  oldParts: RawRunParts,
  riskParts: RawRunParts,
  strictParts: RawRunParts,
  planBaseline: PlanBaseline,
): TaskComparison {
  const baseline = baselineParts.record !== null ? toRunView(buildRunUsage(baselineParts)) : planBaselineView(planBaseline);
  const oldVtrace = oldParts.record !== null ? toRunView(buildRunUsage(oldParts)) : null;
  const risk = riskParts.record !== null ? toRunView(buildRunUsage(riskParts)) : null;
  const strict = strictParts.record !== null ? toRunView(buildRunUsage(strictParts)) : null;

  return {
    instanceId: seed.instanceId,
    baselineLabel: seed.baselineLabel,
    oldVtraceLabel: seed.oldVtraceLabel,
    strictLabel: seed.strictLabel,
    riskLabel: seed.riskLabel,
    status: statusOf(baseline !== null, oldVtrace !== null, strict !== null),
    baseline,
    oldVtrace,
    risk,
    strict,
    oldToStrict: buildOldToStrictDeltas(oldVtrace, strict),
  };
}

// ---------------------------------------------------------------------------
// Aggregate (pure) — paired = old-VTRACE AND strict both present
// ---------------------------------------------------------------------------

export interface Aggregate {
  readonly taskCount: number;
  readonly pairedCount: number;
  readonly missingStrictCount: number;

  readonly baselineResolved: number;
  readonly oldVtraceResolved: number;
  readonly strictResolved: number;

  readonly baselineTotalTokens: number | null;
  readonly oldVtraceTotalTokens: number | null;
  readonly strictTotalTokens: number | null;

  readonly baselineTotalCost: number | null;
  readonly oldVtraceTotalCost: number | null;
  readonly strictTotalCost: number | null;

  readonly oldToStrictTokenDelta: number | null;
  readonly oldToStrictTokenDeltaPct: number | null;
  readonly oldToStrictCostDelta: number | null;
  readonly oldToStrictCostDeltaPct: number | null;

  readonly oldToStrictResolutionWins: number;
  readonly oldToStrictResolutionLosses: number;
  readonly oldToStrictResolutionNet: number;

  readonly suppressionClaimableCount: number;
  readonly strictPivotCheckInjectedCount: number;
  readonly strictEditGuardInjectedCount: number;
  readonly strictPatchVerifyInjectedCount: number;

  readonly strictInternalDefaultRecommendation: string;
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  const nums = values.filter((n): n is number => n !== null);
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
}

function isPaired(t: TaskComparison): boolean {
  return t.oldVtrace !== null && t.strict !== null;
}

// The internal-default decision. Order matters: a token regression blocks first, then a net
// resolution loss, then the positive make-default case, then a conservative hold. We never
// recommend duplicate repair experiments.
export function chooseDecision(args: {
  tokensSaved: boolean;
  costSaved: boolean;
  resolutionNet: number;
  suppressionClaimableCount: number;
}): { decision: DefaultDecision; statements: string[] } {
  if (!args.tokensSaved) {
    return { decision: "hold_no_token_saving", statements: [HOLD_NO_TOKEN_SAVING_STATEMENT] };
  }
  if (args.resolutionNet < 0) {
    return { decision: "hold_resolution_loss", statements: [HOLD_RESOLUTION_LOSS_STATEMENT] };
  }
  if (args.costSaved && args.suppressionClaimableCount >= MEANINGFUL_SUPPRESSION_MIN) {
    return { decision: "make_default", statements: [MAKE_DEFAULT_STATEMENT, INTERNAL_NOT_TOGGLE_STATEMENT] };
  }
  return { decision: "hold_insufficient_evidence", statements: [HOLD_INSUFFICIENT_STATEMENT] };
}

export function buildAggregate(tasks: readonly TaskComparison[]): Aggregate {
  const paired = tasks.filter(isPaired);

  const baselineTotalTokens = sumOrNull(tasks.map((t) => t.baseline?.totalTokens ?? null));
  const oldVtraceTotalTokens = sumOrNull(paired.map((t) => t.oldVtrace?.totalTokens ?? null));
  const strictTotalTokens = sumOrNull(paired.map((t) => t.strict?.totalTokens ?? null));
  const baselineTotalCost = sumOrNull(tasks.map((t) => t.baseline?.costUsd ?? null));
  const oldVtraceTotalCost = sumOrNull(paired.map((t) => t.oldVtrace?.costUsd ?? null));
  const strictTotalCost = sumOrNull(paired.map((t) => t.strict?.costUsd ?? null));

  const wins = paired.filter((t) => t.oldToStrict.resolutionChange === "win").length;
  const losses = paired.filter((t) => t.oldToStrict.resolutionChange === "loss").length;

  const oldToStrictTokenDelta = pairDelta(oldVtraceTotalTokens, strictTotalTokens);
  const oldToStrictCostDelta = pairDelta(oldVtraceTotalCost, strictTotalCost);
  const suppressionClaimableCount = paired.filter((t) => t.strict?.suppressionClaimable === true).length;

  const decision = chooseDecision({
    tokensSaved: oldToStrictTokenDelta !== null && oldToStrictTokenDelta < 0,
    costSaved: oldToStrictCostDelta !== null && oldToStrictCostDelta < 0,
    resolutionNet: wins - losses,
    suppressionClaimableCount,
  });

  return {
    taskCount: tasks.length,
    pairedCount: paired.length,
    missingStrictCount: tasks.filter((t) => t.strict === null).length,
    baselineResolved: tasks.filter((t) => t.baseline?.resolved === true).length,
    oldVtraceResolved: paired.filter((t) => t.oldVtrace?.resolved === true).length,
    strictResolved: paired.filter((t) => t.strict?.resolved === true).length,
    baselineTotalTokens,
    oldVtraceTotalTokens,
    strictTotalTokens,
    baselineTotalCost,
    oldVtraceTotalCost,
    strictTotalCost,
    oldToStrictTokenDelta,
    oldToStrictTokenDeltaPct: pairDeltaPct(oldVtraceTotalTokens, strictTotalTokens),
    oldToStrictCostDelta,
    oldToStrictCostDeltaPct: pairDeltaPct(oldVtraceTotalCost, strictTotalCost),
    oldToStrictResolutionWins: wins,
    oldToStrictResolutionLosses: losses,
    oldToStrictResolutionNet: wins - losses,
    suppressionClaimableCount,
    strictPivotCheckInjectedCount: paired.filter((t) => t.strict?.pivotCheckInjected === true).length,
    strictEditGuardInjectedCount: paired.filter((t) => t.strict?.editGuardInjected === true).length,
    strictPatchVerifyInjectedCount: paired.filter((t) => t.strict?.patchVerifyInjected === true).length,
    strictInternalDefaultRecommendation: decision.statements.join(" "),
  };
}

// ---------------------------------------------------------------------------
// Report assembly (pure)
// ---------------------------------------------------------------------------

export interface Report {
  readonly generatedAt: string | null;
  readonly question: string;
  readonly tasks: readonly TaskComparison[];
  readonly aggregate: Aggregate;
  readonly decision: DefaultDecision;
  readonly recommendation: string;
  readonly nonClaims: readonly string[];
}

export function buildReport(generatedAt: string | null, tasks: readonly TaskComparison[]): Report {
  const aggregate = buildAggregate(tasks);
  // Re-derive the decision code (the aggregate stores the statement text).
  const paired = tasks.filter(isPaired);
  const wins = paired.filter((t) => t.oldToStrict.resolutionChange === "win").length;
  const losses = paired.filter((t) => t.oldToStrict.resolutionChange === "loss").length;
  const decision = chooseDecision({
    tokensSaved: aggregate.oldToStrictTokenDelta !== null && aggregate.oldToStrictTokenDelta < 0,
    costSaved: aggregate.oldToStrictCostDelta !== null && aggregate.oldToStrictCostDelta < 0,
    resolutionNet: wins - losses,
    suppressionClaimableCount: aggregate.suppressionClaimableCount,
  });
  return {
    generatedAt,
    question: "Should strict_risk_gated become the internal default policy for Stage 5 first-pass VTRACE?",
    tasks,
    aggregate,
    decision: decision.decision,
    recommendation: aggregate.strictInternalDefaultRecommendation,
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

  lines.push("# Stage 5 strict-gated 10-task comparison");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Reporting / accounting only. No agents, no live critic, no repair, no Docker. Usage / cost / " +
      "resolution come from the SWE-bench JSONL row; VTRACE policy / context metadata from " +
      "`_run.meta.json`; ordered tool calls from `_tool_calls.json`; evaluation from `_eval.meta.json`. " +
      "Token and cost numbers are never sourced from `_run.meta.json`. The primary comparison is " +
      "controlled VTRACE → strict_risk_gated; baseline is shown for context. CLI policy flags are " +
      "benchmark/dev controls only. No retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / " +
      "probe / critic / repair / evaluator / policy behavior is changed, and no raw artifact is mutated._",
  );
  lines.push("");
  lines.push(`**Question:** ${report.question}`);
  lines.push("");

  // --- Summary -------------------------------------------------------------
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `Controlled set: ${agg.taskCount} tasks. Paired (old VTRACE + strict present): ${agg.pairedCount}; ` +
      `missing strict: ${agg.missingStrictCount}.`,
  );
  lines.push("");
  if (agg.pairedCount > 0) {
    lines.push(
      `Across paired tasks, controlled VTRACE → strict: tokens ${fmtInt(agg.oldVtraceTotalTokens)} → ` +
        `${fmtInt(agg.strictTotalTokens)} (${fmtSignedInt(agg.oldToStrictTokenDelta)}, ${fmtPct(agg.oldToStrictTokenDeltaPct)}); ` +
        `cost ${fmtCost(agg.oldVtraceTotalCost)} → ${fmtCost(agg.strictTotalCost)} (${fmtCost(agg.oldToStrictCostDelta)}, ` +
        `${fmtPct(agg.oldToStrictCostDeltaPct)}); resolved ${agg.oldVtraceResolved} → ${agg.strictResolved}.`,
    );
    lines.push("");
  }
  lines.push(
    `Resolved counts — baseline: ${agg.baselineResolved}, controlled VTRACE: ${agg.oldVtraceResolved}, ` +
      `strict: ${agg.strictResolved}. Resolution wins: ${agg.oldToStrictResolutionWins}; losses: ` +
      `${agg.oldToStrictResolutionLosses}; net: ${agg.oldToStrictResolutionNet >= 0 ? "+" : ""}${agg.oldToStrictResolutionNet}. ` +
      `Suppression claimable (strict): ${agg.suppressionClaimableCount}/${agg.pairedCount}.`,
  );
  lines.push("");
  lines.push(`**Decision: ${report.decision}** — ${report.recommendation}`);
  lines.push("");

  // --- Task coverage -------------------------------------------------------
  lines.push("## Task coverage");
  lines.push("");
  lines.push("| instance | status | baseline label | old VTRACE label | strict label |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    lines.push(
      `| ${t.instanceId} | ${t.status} | ${t.baselineLabel ? `\`${t.baselineLabel}\`` : "null"} | ` +
        `${t.oldVtraceLabel ? `\`${t.oldVtraceLabel}\`` : "null"} | \`${t.strictLabel}\` |`,
    );
  }
  lines.push("");

  // --- Aggregate comparison ------------------------------------------------
  lines.push("## Aggregate comparison");
  lines.push("");
  lines.push("_Token/cost aggregates for old VTRACE and strict are over paired tasks only._");
  lines.push("");
  lines.push("| metric | baseline | old VTRACE | strict | old→strict Δ |");
  lines.push("| --- | --- | --- | --- | --- |");
  lines.push(`| totalTokens | ${fmtInt(agg.baselineTotalTokens)} | ${fmtInt(agg.oldVtraceTotalTokens)} | ${fmtInt(agg.strictTotalTokens)} | ${fmtSignedInt(agg.oldToStrictTokenDelta)} (${fmtPct(agg.oldToStrictTokenDeltaPct)}) |`);
  lines.push(`| totalCost | ${fmtCost(agg.baselineTotalCost)} | ${fmtCost(agg.oldVtraceTotalCost)} | ${fmtCost(agg.strictTotalCost)} | ${fmtCost(agg.oldToStrictCostDelta)} (${fmtPct(agg.oldToStrictCostDeltaPct)}) |`);
  lines.push(`| resolved | ${agg.baselineResolved} | ${agg.oldVtraceResolved} | ${agg.strictResolved} | wins ${agg.oldToStrictResolutionWins} / losses ${agg.oldToStrictResolutionLosses} / net ${agg.oldToStrictResolutionNet >= 0 ? "+" : ""}${agg.oldToStrictResolutionNet} |`);
  lines.push("");
  lines.push("| metric | value |");
  lines.push("| --- | --- |");
  lines.push(`| taskCount | ${agg.taskCount} |`);
  lines.push(`| pairedCount | ${agg.pairedCount} |`);
  lines.push(`| missingStrictCount | ${agg.missingStrictCount} |`);
  lines.push(`| suppressionClaimableCount | ${agg.suppressionClaimableCount} |`);
  lines.push(`| strictPivotCheckInjectedCount | ${agg.strictPivotCheckInjectedCount} |`);
  lines.push(`| strictEditGuardInjectedCount | ${agg.strictEditGuardInjectedCount} |`);
  lines.push(`| strictPatchVerifyInjectedCount | ${agg.strictPatchVerifyInjectedCount} |`);
  lines.push("");

  // --- Per-task comparison -------------------------------------------------
  lines.push("## Per-task comparison");
  lines.push("");
  lines.push("| instance | tokens base / old / strict | cost base / old / strict | resolved base / old / strict | old→strict token Δ (Δ%) | old→strict cost Δ | resolution |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    const tokens = `${fmtInt(t.baseline?.totalTokens ?? null)} / ${fmtInt(t.oldVtrace?.totalTokens ?? null)} / ${fmtInt(t.strict?.totalTokens ?? null)}`;
    const cost = `${fmtCost(t.baseline?.costUsd ?? null)} / ${fmtCost(t.oldVtrace?.costUsd ?? null)} / ${fmtCost(t.strict?.costUsd ?? null)}`;
    const resolved = `${fmtBool(t.baseline?.resolved ?? null)} / ${fmtBool(t.oldVtrace?.resolved ?? null)} / ${fmtBool(t.strict?.resolved ?? null)}`;
    const d = t.oldToStrict;
    lines.push(
      `| ${t.instanceId} | ${tokens} | ${cost} | ${resolved} | ${fmtSignedInt(d.tokenDelta)} (${fmtPct(d.tokenDeltaPct)}) | ${fmtCost(d.costDelta)} | ${d.resolutionChange} |`,
    );
  }
  lines.push("");
  lines.push("Where a risk_gated run is available, its tokens are shown for reference:");
  lines.push("");
  lines.push("| instance | risk_gated tokens | risk_gated cost | risk_gated resolved |");
  lines.push("| --- | --- | --- | --- |");
  for (const t of tasks) {
    if (t.risk === null) continue;
    lines.push(`| ${t.instanceId} | ${fmtInt(t.risk.totalTokens)} | ${fmtCost(t.risk.costUsd)} | ${fmtBool(t.risk.resolved)} |`);
  }
  lines.push("");

  // --- Pivot-check suppression outcomes ------------------------------------
  lines.push("## Pivot-check suppression outcomes");
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
      "`pivotCheckInjected === false` — strict_risk_gated actively withheld a checklist the multi-pivot " +
      "heuristic would have injected.",
  );
  lines.push("");

  // --- Token/cost/turn impact ----------------------------------------------
  lines.push("## Token/cost/turn impact");
  lines.push("");
  lines.push("| instance | turns old→strict (Δ) | ordered tool calls old→strict (Δ) | tokens Δ% | cost Δ% |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    const d = t.oldToStrict;
    lines.push(
      `| ${t.instanceId} | ${fmtInt(t.oldVtrace?.numTurns ?? null)}→${fmtInt(t.strict?.numTurns ?? null)} (${fmtSignedInt(d.turnDelta)}) | ` +
        `${fmtInt(t.oldVtrace?.orderedToolCallCount ?? null)}→${fmtInt(t.strict?.orderedToolCallCount ?? null)} (${fmtSignedInt(d.orderedToolCallDelta)}) | ` +
        `${fmtPct(d.tokenDeltaPct)} | ${fmtPct(d.costDeltaPct)} |`,
    );
  }
  lines.push("");

  // --- Resolution outcomes -------------------------------------------------
  lines.push("## Resolution outcomes");
  lines.push("");
  lines.push("| instance | baseline | old VTRACE | strict | old→strict |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    lines.push(
      `| ${t.instanceId} | ${fmtBool(t.baseline?.resolved ?? null)} | ${fmtBool(t.oldVtrace?.resolved ?? null)} | ` +
        `${fmtBool(t.strict?.resolved ?? null)} | ${t.oldToStrict.resolutionChange} |`,
    );
  }
  lines.push("");
  lines.push(
    `Resolution wins (old unresolved → strict resolved): ${agg.oldToStrictResolutionWins}; ` +
      `losses (old resolved → strict unresolved): ${agg.oldToStrictResolutionLosses}; ` +
      `net: ${agg.oldToStrictResolutionNet >= 0 ? "+" : ""}${agg.oldToStrictResolutionNet}.`,
  );
  lines.push("");

  // --- Relationship to repair accounting -----------------------------------
  lines.push("## Relationship to repair accounting");
  lines.push("");
  lines.push(
    "Verified repair is a SEPARATE downstream pass and is accounted by its own reports (e.g. the " +
      "Stage 5 patch-repair smoke reports). This report covers FIRST-PASS VTRACE only: strict gating " +
      "reduces first-pass tokens/turns by suppressing PIVOT_CHECK on hidden-pivot-only tasks, but does " +
      "not itself repair an unresolved patch. A task that strict leaves unresolved may still be recovered " +
      "by verified repair, which is counted elsewhere. This report does not re-run or re-account repair, " +
      "and does not recommend duplicate repair experiments.",
  );
  lines.push("");

  // --- Default-policy recommendation ---------------------------------------
  lines.push("## Default-policy recommendation");
  lines.push("");
  lines.push(`**Decision: ${report.decision}.** ${report.recommendation}`);
  lines.push("");
  lines.push(
    "Recommendation rule: recommend making strict_risk_gated the internal default only when strict has " +
      "lower total tokens AND lower total cost than controlled VTRACE, no net resolution regression, and a " +
      `meaningful suppression count (≥ ${MEANINGFUL_SUPPRESSION_MIN}). If strict saves tokens but loses ` +
      "resolution, hold and find the lost task's missing risk signal. If strict does not save tokens, hold " +
      "and keep risk_gated while investigating tool-loop causes.",
  );
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

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

async function readJsonFile(p: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(p, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readSwebenchRecord(dir: string): Promise<Record<string, unknown> | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const jsonl = entries.find((e) => e.startsWith("swebench-") && e.endsWith(".jsonl"));
  if (!jsonl) return null;
  try {
    const text = await readFile(path.join(dir, jsonl), "utf8");
    const firstLine = text.split("\n").find((l) => l.trim().length > 0);
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readToolCalls(dir: string): Promise<RawToolCall[] | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, "_tool_calls.json"), "utf8"));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isRecord).map((t) => ({ category: asString(t.category), path: asString(t.path) }));
  } catch {
    return null;
  }
}

// Load one condition of a run. `condition` selects the raw subdir: baseline runs live under
// raw/baseline, VTRACE/strict/risk runs under raw/vtrace.
export async function loadCondition(
  resultsDir: string,
  runLabel: string,
  condition: "baseline" | "vtrace",
): Promise<RawRunParts> {
  const dir = path.join(resultsDir, "runs", runLabel, "raw", condition);
  const [meta, evalMeta, record, toolCalls] = await Promise.all([
    readJsonFile(path.join(dir, "_run.meta.json")),
    readJsonFile(path.join(dir, "_eval.meta.json")),
    readSwebenchRecord(dir),
    readToolCalls(dir),
  ]);
  return { runLabel, meta, evalMeta, record, toolCalls };
}

function emptyParts(runLabel: string): RawRunParts {
  return { runLabel, meta: null, evalMeta: null, record: null, toolCalls: null };
}

async function readPlan(resultsDir: string): Promise<Record<string, unknown> | null> {
  return readJsonFile(path.join(resultsDir, PLAN_FILE));
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
  const seeds = seedsFromPlan(plan);

  const tasks = await Promise.all(
    seeds.map(async (seed) => {
      const [baselineParts, oldParts, riskParts, strictParts] = await Promise.all([
        seed.baselineLabel ? loadCondition(config.resultsDir, seed.baselineLabel, "baseline") : emptyParts("baseline?"),
        seed.oldVtraceLabel ? loadCondition(config.resultsDir, seed.oldVtraceLabel, "vtrace") : emptyParts("old?"),
        loadCondition(config.resultsDir, seed.riskLabel, "vtrace"),
        loadCondition(config.resultsDir, seed.strictLabel, "vtrace"),
      ]);
      return buildTask(seed, baselineParts, oldParts, riskParts, strictParts, planBaselineOf(plan, seed.instanceId));
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
      "Stage 5 strict-gated 10-task comparison report written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Tasks: ${agg.taskCount}   paired (old+strict): ${agg.pairedCount}   missing strict: ${agg.missingStrictCount}`,
      `Tokens (old→strict): ${fmtInt(agg.oldVtraceTotalTokens)} → ${fmtInt(agg.strictTotalTokens)} (${fmtSignedInt(agg.oldToStrictTokenDelta)}, ${fmtPct(agg.oldToStrictTokenDeltaPct)})`,
      `Cost (old→strict): ${fmtCost(agg.oldVtraceTotalCost)} → ${fmtCost(agg.strictTotalCost)} (${fmtCost(agg.oldToStrictCostDelta)})`,
      `Resolved — baseline: ${agg.baselineResolved}   old VTRACE: ${agg.oldVtraceResolved}   strict: ${agg.strictResolved}`,
      `Resolution wins/losses/net: ${agg.oldToStrictResolutionWins}/${agg.oldToStrictResolutionLosses}/${agg.oldToStrictResolutionNet}`,
      `Suppression claimable: ${agg.suppressionClaimableCount}   decision: ${report.decision}`,
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
