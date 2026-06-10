// Stage 5 pivot-check policy calibration report.
//
// SCOPE: reporting / accounting ONLY. This reads EXISTING run metadata for the risk_gated
// verification runs and SIMULATES alternative PIVOT_CHECK injection policies over that metadata.
// Its purpose is to answer one question: should `hidden_pivot` alone remain sufficient to inject
// PIVOT_CHECK under the risk_gated policy, given that on the 3-task verification set risk_gated
// never actually suppressed PIVOT_CHECK?
//
// It runs NO agents, NO live critic, NO repair, NO Docker, and changes NO retrieval / Capsule v2 /
// PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator / policy behavior.
// The simulated policies are computed in-process from recorded metadata; production behavior is
// untouched. It never mutates a raw artifact; it only writes its own Markdown + JSON.
//
// Provenance is split deliberately (same rule as the comparison reports it reuses):
//   * model usage / cost / resolution → the SWE-bench JSONL row under raw/vtrace/*.jsonl
//   * VTRACE policy / signal / capsule metadata → _run.meta.json
// Token/cost numbers are NEVER read from _run.meta.json.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { isRecord } from "./run_stage5_outcome_ledger";
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
export const DEFAULT_OUT_NAME = "stage5_pivot_policy_calibration";
export const THREE_TASK_REPORT_FILE = "stage5_riskgated_3task_report.json";
export const TOKEN_AUDIT_FILE = "stage5_token_path_audit.json";

export const POLICY_NAMES = [
  "multi_pivot",
  "current_risk_gated",
  "strict_risk_gated",
  "no_hidden_pivot_only",
  "off",
] as const;
export type PolicyName = (typeof POLICY_NAMES)[number];

// Required interpretation statements, verbatim. They are emitted by the report and asserted by
// the tests so the framing cannot silently drift.
export const HIDDEN_PIVOT_FIRED_STATEMENT =
  "In the 3-task risk-gated verification set, risk_gated did not suppress PIVOT_CHECK because " +
  "hidden_pivot fired on every task.";

export const STRICTER_POLICY_RECOMMENDATION =
  "Do not rerun the full 10-task set yet. First test a stricter risk-gated policy where " +
  "hidden_pivot alone is not sufficient.";

export const NON_CLAIMS: readonly string[] = [
  "This is a simulation over existing run metadata; it does NOT change PIVOT_CHECK, the risk_gated policy, or any production behavior.",
  "Simulated injection decisions are recomputed from recorded risk signals and capsule metadata, not by re-running agents.",
  "It does not run agents, live critic, repair, or Docker; usage/cost/resolution are read verbatim from existing run + docker-eval artifacts.",
  "Token/cost figures come from the SWE-bench JSONL row; pivot-check policy/signal metadata from `_run.meta.json`. Token/cost are never sourced from `_run.meta.json`.",
  "It does not prove a stricter policy would resolve more tasks or cut tokens — only that hidden_pivot alone forced injection on every analyzed run.",
  "n is small (analyzed risk_gated runs only); no statistical significance is claimed.",
];

// ---------------------------------------------------------------------------
// Pure coercion helpers
// ---------------------------------------------------------------------------

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Extra meta fields not carried by RunUsage (capsule shape) — pure.
// ---------------------------------------------------------------------------

export interface RunMetaExtras {
  readonly capsulePivotCount: number | null;
  readonly editRiskDirectivesCount: number | null;
  readonly pivotCount: number | null;
}

export function extraMetaOf(meta: Record<string, unknown> | null): RunMetaExtras {
  const capsulePivotCount =
    meta && Array.isArray(meta.vtraceCapsulePivots) ? meta.vtraceCapsulePivots.length : null;
  return {
    capsulePivotCount,
    editRiskDirectivesCount: asNumber(meta?.vtraceCapsuleEditRiskDirectivesCount),
    pivotCount: asNumber(meta?.vtracePivotCount),
  };
}

// ---------------------------------------------------------------------------
// Risk signal derivation (pure)
// ---------------------------------------------------------------------------

// The recorded `vtracePivotCheckRiskSignals` list is authoritative for what the production policy
// saw, but we ALSO derive `three_or_more_pivots` and `edit_risk_directives` independently from
// capsule metadata so a stricter policy can be simulated even when the production policy did not
// record those signals (because hidden_pivot already short-circuited the decision).
export interface RiskSignalSet {
  readonly hiddenPivot: boolean;
  readonly threeOrMorePivots: boolean;
  readonly editRiskDirectives: boolean;
  // Recorded signals outside the three known names — treated as additional (non-hidden) signals.
  readonly otherSignals: readonly string[];
}

const KNOWN_SIGNALS = new Set(["hidden_pivot", "three_or_more_pivots", "edit_risk_directives"]);

export function deriveSignals(usage: RunUsage, extras: RunMetaExtras): RiskSignalSet {
  const recorded = usage.vtracePivotCheckRiskSignals ?? [];
  const hiddenPivot = recorded.includes("hidden_pivot");
  const threeOrMorePivots =
    recorded.includes("three_or_more_pivots") ||
    (extras.pivotCount !== null && extras.pivotCount >= 3) ||
    (extras.capsulePivotCount !== null && extras.capsulePivotCount >= 3);
  const editRiskDirectives =
    recorded.includes("edit_risk_directives") ||
    (extras.editRiskDirectivesCount !== null && extras.editRiskDirectivesCount > 0);
  const otherSignals = recorded.filter((s) => !KNOWN_SIGNALS.has(s));
  return { hiddenPivot, threeOrMorePivots, editRiskDirectives, otherSignals };
}

// Count of risk signals OTHER than hidden_pivot. Used by the stricter policies, which treat
// hidden_pivot as insufficient on its own.
export function additionalSignalCount(signals: RiskSignalSet): number {
  return (
    (signals.threeOrMorePivots ? 1 : 0) +
    (signals.editRiskDirectives ? 1 : 0) +
    signals.otherSignals.length
  );
}

// ---------------------------------------------------------------------------
// Policy simulation (pure)
// ---------------------------------------------------------------------------

// Simulate whether a given policy WOULD inject PIVOT_CHECK for one run, from its metadata.
//   multi_pivot           — inject when the recorded wouldInjectUnderMultiPivot is true.
//   current_risk_gated    — inject under any risk signal (hidden_pivot OR three_or_more_pivots OR
//                            edit_risk_directives OR any other recorded signal). This reproduces
//                            the production risk_gated decision.
//   strict_risk_gated     — inject only on a non-hidden risk: three_or_more_pivots OR
//                            edit_risk_directives OR (when available) edit-relevant hidden-pivot
//                            metadata OR hidden_pivot accompanied by ≥1 additional signal.
//   no_hidden_pivot_only  — hidden_pivot alone is NOT sufficient: inject only when some non-hidden
//                            signal is present.
//   off                   — never inject.
// `editRelevantHiddenAvailable` is an optional extra input (defaults false / unavailable); when a
// hidden pivot is independently known to be edit-relevant it lets strict_risk_gated inject even
// without another signal. It is false for every current run, so strict and no_hidden coincide here.
export function simulateInject(
  policy: PolicyName,
  signals: RiskSignalSet,
  wouldInjectUnderMultiPivot: boolean | null,
  editRelevantHiddenAvailable: boolean,
): boolean | null {
  const nonHiddenSignalPresent =
    signals.threeOrMorePivots || signals.editRiskDirectives || signals.otherSignals.length > 0;
  switch (policy) {
    case "multi_pivot":
      return wouldInjectUnderMultiPivot;
    case "current_risk_gated":
      return signals.hiddenPivot || nonHiddenSignalPresent;
    case "strict_risk_gated":
      return (
        signals.threeOrMorePivots ||
        signals.editRiskDirectives ||
        editRelevantHiddenAvailable ||
        (signals.hiddenPivot && additionalSignalCount(signals) >= 1) ||
        signals.otherSignals.length > 0
      );
    case "no_hidden_pivot_only":
      return nonHiddenSignalPresent;
    case "off":
      return false;
  }
}

export function simulateAll(
  signals: RiskSignalSet,
  wouldInjectUnderMultiPivot: boolean | null,
  editRelevantHiddenAvailable: boolean,
): Record<PolicyName, { inject: boolean | null }> {
  const out = {} as Record<PolicyName, { inject: boolean | null }>;
  for (const policy of POLICY_NAMES) {
    out[policy] = {
      inject: simulateInject(policy, signals, wouldInjectUnderMultiPivot, editRelevantHiddenAvailable),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

export type RunClassification =
  | "suppression_candidate_hidden_only"
  | "still_high_risk_multi_signal"
  | "already_suppressed"
  | "no_multi_pivot"
  | "unknown";

export function hiddenPivotSoleSignalOf(riskSignals: readonly string[] | null): boolean {
  return riskSignals !== null && riskSignals.length === 1 && riskSignals[0] === "hidden_pivot";
}

// Classify per the calibration spec. Order matters: missing metadata → unknown; multi-pivot would
// not have injected → no_multi_pivot; would-inject but suppressed → already_suppressed; would-inject
// + injected + hidden_pivot is the sole signal → suppression_candidate_hidden_only; injected with a
// genuine multi-signal / high-risk reason → still_high_risk_multi_signal.
export function classifyRun(usage: RunUsage, signals: RiskSignalSet): RunClassification {
  const would = usage.vtracePivotCheckWouldInjectUnderMultiPivot;
  const injected = usage.vtracePivotCheckInjected;
  const recorded = usage.vtracePivotCheckRiskSignals;
  if (would === null || injected === null || recorded === null) return "unknown";
  if (would === false) return "no_multi_pivot";
  // would === true beyond here.
  if (injected === false) return "already_suppressed";
  // would === true && injected === true.
  if (hiddenPivotSoleSignalOf(recorded)) return "suppression_candidate_hidden_only";
  const multiSignal =
    (recorded.includes("hidden_pivot") && recorded.length > 1) ||
    signals.threeOrMorePivots ||
    signals.editRiskDirectives;
  if (multiSignal) return "still_high_risk_multi_signal";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Per-run calibration view (pure)
// ---------------------------------------------------------------------------

export interface RunCalibration {
  readonly runLabel: string;
  readonly instanceId: string | null;
  readonly resolved: boolean | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly numTurns: number | null;
  readonly orderedToolCallCount: number | null;
  readonly toolCallsByType: Record<string, number> | null;
  readonly vtracePivotCheckPolicy: string | null;
  readonly vtracePivotCheckRiskSignals: readonly string[] | null;
  readonly vtracePivotCheckInjected: boolean | null;
  readonly vtracePivotCheckWouldInjectUnderMultiPivot: boolean | null;
  // Capsule shape (count of pivots, not the array).
  readonly vtraceCapsulePivots: number | null;
  readonly vtraceCapsuleEditRiskDirectivesCount: number | null;
  readonly vtraceCapsuleEstimatedTokens: number | null;
  readonly signals: RiskSignalSet;
  readonly classification: RunClassification;
  readonly simulated: Record<PolicyName, { inject: boolean | null }>;
  readonly hiddenPivotSoleSignal: boolean;
  // current_risk_gated and multi_pivot agree on injection for this run (gating made no difference).
  readonly riskGatedEqualsMultiPivot: boolean | null;
}

export function buildRunCalibration(
  parts: RawRunParts,
  editRelevantHiddenAvailable = false,
): RunCalibration {
  const usage = buildRunUsage(parts);
  const extras = extraMetaOf(parts.meta);
  const signals = deriveSignals(usage, extras);
  const would = usage.vtracePivotCheckWouldInjectUnderMultiPivot;
  const simulated = simulateAll(signals, would, editRelevantHiddenAvailable);
  const multi = simulated.multi_pivot.inject;
  const current = simulated.current_risk_gated.inject;
  const riskGatedEqualsMultiPivot = multi === null || current === null ? null : current === multi;

  return {
    runLabel: usage.runLabel,
    instanceId: usage.instanceId,
    resolved: usage.resolved,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
    numTurns: usage.numTurns,
    orderedToolCallCount: usage.orderedToolCallCount,
    toolCallsByType: usage.toolCallsByType,
    vtracePivotCheckPolicy: usage.vtracePivotCheckPolicy,
    vtracePivotCheckRiskSignals: usage.vtracePivotCheckRiskSignals,
    vtracePivotCheckInjected: usage.vtracePivotCheckInjected,
    vtracePivotCheckWouldInjectUnderMultiPivot: would,
    vtraceCapsulePivots: extras.capsulePivotCount,
    vtraceCapsuleEditRiskDirectivesCount: extras.editRiskDirectivesCount,
    vtraceCapsuleEstimatedTokens: usage.vtraceCapsuleEstimatedTokens,
    signals,
    classification: classifyRun(usage, signals),
    simulated,
    hiddenPivotSoleSignal: hiddenPivotSoleSignalOf(usage.vtracePivotCheckRiskSignals),
    riskGatedEqualsMultiPivot,
  };
}

// Only runs carrying pivot-check decision metadata (policy / wouldInject / riskSignals) are part of
// the calibration. Controlled / baseline runs that predate risk_gated lack these fields and are
// discovered but not analyzed.
export function hasPivotDecisionMetadata(parts: RawRunParts): boolean {
  const m = parts.meta;
  if (m === null) return false;
  return (
    m.vtracePivotCheckPolicy != null ||
    m.vtracePivotCheckWouldInjectUnderMultiPivot != null ||
    Array.isArray(m.vtracePivotCheckRiskSignals)
  );
}

// ---------------------------------------------------------------------------
// Aggregate (pure)
// ---------------------------------------------------------------------------

export interface Aggregate {
  readonly runsDiscovered: number;
  readonly runsAnalyzed: number;
  readonly runsWithPivotCheckInjected: number;
  readonly runsWhereHiddenPivotWasSoleSignal: number;
  readonly runsWhereRiskGatedEqualsMultiPivot: number;
  readonly suppressionOpportunitiesUnderStrict: number;
  readonly suppressionOpportunitiesUnderNoHiddenPivotOnly: number;
  readonly tokenMassWhereHiddenPivotSoleSignal: number | null;
  readonly costMassWhereHiddenPivotSoleSignal: number | null;
  readonly classificationCounts: Record<RunClassification, number>;
  // True when hidden_pivot alone explains injection on EVERY analyzed run AND a stricter policy
  // would suppress every one of them — i.e. hidden_pivot is doing all the gating work.
  readonly hiddenPivotAppearsTooBroad: boolean;
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  const nums = values.filter((n): n is number => n !== null);
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
}

export function buildAggregate(runs: readonly RunCalibration[], runsDiscovered: number): Aggregate {
  const injected = runs.filter((r) => r.vtracePivotCheckInjected === true);
  const soleHidden = runs.filter((r) => r.hiddenPivotSoleSignal);
  const classificationCounts: Record<RunClassification, number> = {
    suppression_candidate_hidden_only: 0,
    still_high_risk_multi_signal: 0,
    already_suppressed: 0,
    no_multi_pivot: 0,
    unknown: 0,
  };
  for (const r of runs) classificationCounts[r.classification] += 1;

  const suppressionOpportunitiesUnderStrict = runs.filter(
    (r) => r.vtracePivotCheckInjected === true && r.simulated.strict_risk_gated.inject === false,
  ).length;
  const suppressionOpportunitiesUnderNoHiddenPivotOnly = runs.filter(
    (r) => r.vtracePivotCheckInjected === true && r.simulated.no_hidden_pivot_only.inject === false,
  ).length;

  const runsWhereHiddenPivotWasSoleSignal = soleHidden.length;
  const hiddenPivotAppearsTooBroad =
    runs.length > 0 &&
    runsWhereHiddenPivotWasSoleSignal === runs.length &&
    suppressionOpportunitiesUnderStrict === runs.length;

  return {
    runsDiscovered,
    runsAnalyzed: runs.length,
    runsWithPivotCheckInjected: injected.length,
    runsWhereHiddenPivotWasSoleSignal,
    runsWhereRiskGatedEqualsMultiPivot: runs.filter((r) => r.riskGatedEqualsMultiPivot === true).length,
    suppressionOpportunitiesUnderStrict,
    suppressionOpportunitiesUnderNoHiddenPivotOnly,
    tokenMassWhereHiddenPivotSoleSignal: sumOrNull(soleHidden.map((r) => r.totalTokens)),
    costMassWhereHiddenPivotSoleSignal: sumOrNull(soleHidden.map((r) => r.costUsd)),
    classificationCounts,
    hiddenPivotAppearsTooBroad,
  };
}

// ---------------------------------------------------------------------------
// Recommendation (pure)
// ---------------------------------------------------------------------------

export interface Recommendation {
  readonly rerunFullTenTask: boolean;
  readonly headline: string;
  readonly rationale: string;
}

export function chooseRecommendation(agg: Aggregate): Recommendation {
  if (agg.runsAnalyzed === 0) {
    return {
      rerunFullTenTask: false,
      headline:
        "Insufficient risk_gated run metadata to calibrate — produce the 3-task risk-gated set first.",
      rationale: "No analyzed runs carried pivot-check decision metadata.",
    };
  }
  if (agg.hiddenPivotAppearsTooBroad) {
    return {
      rerunFullTenTask: false,
      headline: STRICTER_POLICY_RECOMMENDATION,
      rationale:
        `hidden_pivot was the sole risk signal on all ${agg.runsAnalyzed} analyzed runs and a stricter ` +
        `policy would have suppressed PIVOT_CHECK on every one of them, so risk_gated currently behaves ` +
        `like multi_pivot. Test the stricter gate before spending a full 10-task rerun.`,
    };
  }
  if (agg.suppressionOpportunitiesUnderStrict > 0) {
    return {
      rerunFullTenTask: false,
      headline: STRICTER_POLICY_RECOMMENDATION,
      rationale:
        `A stricter policy would have suppressed PIVOT_CHECK on ` +
        `${agg.suppressionOpportunitiesUnderStrict}/${agg.runsAnalyzed} analyzed runs; verify that gate ` +
        `before a full 10-task rerun.`,
    };
  }
  return {
    rerunFullTenTask: false,
    headline:
      "No hidden_pivot-only over-injection detected in the analyzed runs; no policy change is indicated yet.",
    rationale: "Every injected run had a non-hidden risk signal, so risk_gated already differs from multi_pivot.",
  };
}

// ---------------------------------------------------------------------------
// Sidecar inputs (token / cost outcome context) — pure shaping over loaded JSON.
// ---------------------------------------------------------------------------

export interface Sidecar {
  readonly threeTaskTotalTokenDeltaPct: number | null;
  readonly threeTaskTotalCostDeltaPct: number | null;
  readonly threeTaskSuppressionClaimableCount: number | null;
  readonly tokenAuditDominantCategories: readonly string[] | null;
}

export function shapeSidecar(
  threeTaskReport: Record<string, unknown> | null,
  tokenAudit: Record<string, unknown> | null,
): Sidecar {
  const agg = threeTaskReport && isRecord(threeTaskReport.aggregate) ? threeTaskReport.aggregate : null;
  const summary = tokenAudit && isRecord(tokenAudit.summary) ? tokenAudit.summary : null;
  const cats =
    summary && Array.isArray(summary.dominantCategories)
      ? summary.dominantCategories.filter((c): c is string => typeof c === "string")
      : null;
  return {
    threeTaskTotalTokenDeltaPct: asNumber(agg?.totalTokenDeltaPct),
    threeTaskTotalCostDeltaPct: asNumber(agg?.totalCostDeltaPct),
    threeTaskSuppressionClaimableCount: asNumber(agg?.suppressionClaimableCount),
    tokenAuditDominantCategories: cats,
  };
}

// ---------------------------------------------------------------------------
// Report assembly (pure)
// ---------------------------------------------------------------------------

export interface Report {
  readonly generatedAt: string | null;
  readonly policies: readonly PolicyName[];
  readonly runs: readonly RunCalibration[];
  readonly aggregate: Aggregate;
  readonly sidecar: Sidecar;
  readonly recommendation: Recommendation;
  readonly hiddenPivotFiredStatement: string;
  readonly nonClaims: readonly string[];
}

export function buildReport(
  generatedAt: string | null,
  runs: readonly RunCalibration[],
  runsDiscovered: number,
  sidecar: Sidecar,
): Report {
  const aggregate = buildAggregate(runs, runsDiscovered);
  return {
    generatedAt,
    policies: POLICY_NAMES,
    runs,
    aggregate,
    sidecar,
    recommendation: chooseRecommendation(aggregate),
    hiddenPivotFiredStatement: HIDDEN_PIVOT_FIRED_STATEMENT,
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
function fmtBool(b: boolean | null): string {
  return b === null ? "unknown" : b ? "yes" : "no";
}
function fmtInject(b: boolean | null): string {
  return b === null ? "n/a" : b ? "inject" : "suppress";
}
function fmtStr(s: string | null): string {
  return s === null ? "n/a" : s;
}
function fmtSignals(s: readonly string[] | null): string {
  return s === null ? "n/a" : s.length === 0 ? "[]" : `[${s.join(", ")}]`;
}

export function renderMarkdown(report: Report): string {
  const { runs, aggregate: agg, sidecar, recommendation: rec } = report;
  const lines: string[] = [];

  lines.push("# Stage 5 pivot-check policy calibration");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Reporting / accounting only. No agents, no live critic, no repair, no Docker. Simulated " +
      "injection decisions are recomputed in-process from recorded metadata; production PIVOT_CHECK / " +
      "risk_gated behavior is unchanged and no raw artifact is mutated. Usage / cost / resolution come " +
      "from the SWE-bench JSONL row; pivot-check policy / signal / capsule metadata from `_run.meta.json`; " +
      "token and cost numbers are never sourced from `_run.meta.json`._",
  );
  lines.push("");

  // --- Summary -------------------------------------------------------------
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `Discovered ${agg.runsDiscovered} run(s); analyzed ${agg.runsAnalyzed} carrying pivot-check decision ` +
      `metadata. PIVOT_CHECK was injected on ${agg.runsWithPivotCheckInjected}/${agg.runsAnalyzed}. ` +
      `hidden_pivot was the SOLE risk signal on ${agg.runsWhereHiddenPivotWasSoleSignal}/${agg.runsAnalyzed}, ` +
      `and current risk_gated matched multi_pivot on ${agg.runsWhereRiskGatedEqualsMultiPivot}/${agg.runsAnalyzed}.`,
  );
  lines.push("");
  lines.push(`> ${report.hiddenPivotFiredStatement}`);
  lines.push("");
  lines.push(
    `A stricter policy would have suppressed PIVOT_CHECK on ${agg.suppressionOpportunitiesUnderStrict} run(s) ` +
      `(strict_risk_gated) / ${agg.suppressionOpportunitiesUnderNoHiddenPivotOnly} run(s) (no_hidden_pivot_only). ` +
      `Token mass where hidden_pivot was the sole signal: ${fmtInt(agg.tokenMassWhereHiddenPivotSoleSignal)} ` +
      `tokens, ${fmtCost(agg.costMassWhereHiddenPivotSoleSignal)}.`,
  );
  lines.push("");
  lines.push(
    `**hidden_pivot appears too broad: ${agg.hiddenPivotAppearsTooBroad ? "yes" : "no"}.** ` +
      (agg.hiddenPivotAppearsTooBroad
        ? "On every analyzed run hidden_pivot alone forced injection and a stricter gate would have " +
          "suppressed it, so risk_gated is currently indistinguishable from multi_pivot."
        : "Not every injected run was driven by hidden_pivot alone."),
  );
  lines.push("");

  // --- Current risk-gated behavior -----------------------------------------
  lines.push("## Current risk-gated behavior");
  lines.push("");
  lines.push(
    "| instance | run label | injected | policy | risk signals | wouldInjectUnderMultiPivot | risk_gated≡multi_pivot |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of runs) {
    lines.push(
      `| ${fmtStr(r.instanceId)} | \`${r.runLabel}\` | ${fmtBool(r.vtracePivotCheckInjected)} | ` +
        `${fmtStr(r.vtracePivotCheckPolicy)} | ${fmtSignals(r.vtracePivotCheckRiskSignals)} | ` +
        `${fmtBool(r.vtracePivotCheckWouldInjectUnderMultiPivot)} | ${fmtBool(r.riskGatedEqualsMultiPivot)} |`,
    );
  }
  lines.push("");
  lines.push(
    "Where `risk_gated≡multi_pivot` is `yes`, the risk gate changed nothing relative to the old multi-pivot " +
      "heuristic — PIVOT_CHECK was injected on the same runs it always would have been.",
  );
  lines.push("");

  // --- Hidden-pivot signal analysis ----------------------------------------
  lines.push("## Hidden-pivot signal analysis");
  lines.push("");
  lines.push(
    "| instance | risk signals | hidden_pivot sole signal | pivots | editRiskDirectives | additional signals | classification |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of runs) {
    lines.push(
      `| ${fmtStr(r.instanceId)} | ${fmtSignals(r.vtracePivotCheckRiskSignals)} | ` +
        `${r.hiddenPivotSoleSignal ? "yes" : "no"} | ${fmtInt(r.vtraceCapsulePivots)} | ` +
        `${fmtInt(r.vtraceCapsuleEditRiskDirectivesCount)} | ${additionalSignalCount(r.signals)} | ` +
        `${r.classification} |`,
    );
  }
  lines.push("");
  lines.push(
    "`three_or_more_pivots` is derived from the capsule pivot count and `edit_risk_directives` from " +
      "`vtraceCapsuleEditRiskDirectivesCount`; both are independent of the recorded signal list so a stricter " +
      "gate can be simulated even where hidden_pivot short-circuited the production decision.",
  );
  lines.push("");

  // --- Simulated policy comparison -----------------------------------------
  lines.push("## Simulated policy comparison");
  lines.push("");
  lines.push(`| instance | actual injected | ${report.policies.join(" | ")} |`);
  lines.push(`| --- | --- | ${report.policies.map(() => "---").join(" | ")} |`);
  for (const r of runs) {
    const cells = report.policies.map((p) => fmtInject(r.simulated[p].inject));
    lines.push(`| ${fmtStr(r.instanceId)} | ${fmtBool(r.vtracePivotCheckInjected)} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("Policy definitions (simulation only — production behavior is unchanged):");
  lines.push("");
  lines.push("- **multi_pivot** — inject when `wouldInjectUnderMultiPivot` is true.");
  lines.push(
    "- **current_risk_gated** — inject under any risk signal (`hidden_pivot` OR `three_or_more_pivots` OR `edit_risk_directives`).",
  );
  lines.push(
    "- **strict_risk_gated** — inject only on a non-hidden risk, or hidden_pivot accompanied by ≥1 additional signal / known edit-relevant metadata.",
  );
  lines.push("- **no_hidden_pivot_only** — `hidden_pivot` alone is not sufficient.");
  lines.push("- **off** — never inject.");
  lines.push("");

  // --- Suppression candidates ----------------------------------------------
  lines.push("## Suppression candidates");
  lines.push("");
  lines.push("Classification counts:");
  lines.push("");
  lines.push("| classification | count |");
  lines.push("| --- | --- |");
  for (const [k, v] of Object.entries(agg.classificationCounts)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  const candidates = runs.filter((r) => r.classification === "suppression_candidate_hidden_only");
  if (candidates.length > 0) {
    lines.push(
      `${candidates.length} run(s) are **suppression_candidate_hidden_only** — injected solely because ` +
        "`hidden_pivot` fired, with no other risk signal. A stricter policy would suppress PIVOT_CHECK on these:",
    );
    lines.push("");
    for (const r of candidates) {
      lines.push(
        `- \`${fmtStr(r.instanceId)}\` (\`${r.runLabel}\`) — tokens ${fmtInt(r.totalTokens)}, ` +
          `${fmtCost(r.costUsd)}, ordered tool calls ${fmtInt(r.orderedToolCallCount)}, resolved ${fmtBool(r.resolved)}.`,
      );
    }
    lines.push("");
  } else {
    lines.push("No hidden_pivot-only suppression candidates among the analyzed runs.");
    lines.push("");
  }

  // --- Relationship to token/cost outcomes ---------------------------------
  lines.push("## Relationship to token/cost outcomes");
  lines.push("");
  if (
    sidecar.threeTaskTotalTokenDeltaPct !== null ||
    sidecar.threeTaskTotalCostDeltaPct !== null ||
    sidecar.threeTaskSuppressionClaimableCount !== null
  ) {
    lines.push(
      `The 3-task risk-gated verification report recorded aggregate tokens ${fmtPct(sidecar.threeTaskTotalTokenDeltaPct)} ` +
        `and cost ${fmtPct(sidecar.threeTaskTotalCostDeltaPct)} vs the controlled runs, with ` +
        `${fmtInt(sidecar.threeTaskSuppressionClaimableCount)} task(s) where PIVOT_CHECK suppression was claimable.`,
    );
    lines.push("");
  }
  lines.push(
    "Because PIVOT_CHECK was injected on every analyzed run, none of the observed token/cost movement can be " +
      "attributed to PIVOT_CHECK suppression — the suppression pathway never fired. Any token mass shown above " +
      "is what a stricter gate would have had the OPPORTUNITY to act on, not a realized saving.",
  );
  lines.push("");
  if (sidecar.tokenAuditDominantCategories && sidecar.tokenAuditDominantCategories.length > 0) {
    lines.push(
      `The token-path audit's dominant overhead categories were: ${sidecar.tokenAuditDominantCategories.join(", ")}. ` +
        "`pivot_check_overhead` is among them, which is the cost a stricter gate would target.",
    );
    lines.push("");
  }

  // --- Recommendation ------------------------------------------------------
  lines.push("## Recommendation");
  lines.push("");
  lines.push(`**${rec.headline}**`);
  lines.push("");
  lines.push(rec.rationale);
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

// Discover every run label under results/runs that has a vtrace dir. Tolerates a missing runs dir.
async function discoverRunLabels(resultsDir: string): Promise<string[]> {
  const runsDir = path.join(resultsDir, "runs");
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
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

  const labels = await discoverRunLabels(config.resultsDir);
  const allParts = await Promise.all(labels.map((label) => loadRun(config.resultsDir, label)));
  const analyzed = allParts.filter(hasPivotDecisionMetadata);
  const runs = analyzed
    .map((parts) => buildRunCalibration(parts))
    .sort((a, b) =>
      (a.instanceId ?? a.runLabel).localeCompare(b.instanceId ?? b.runLabel) ||
      a.runLabel.localeCompare(b.runLabel),
    );

  const [threeTaskReport, tokenAudit] = await Promise.all([
    readJsonFile(path.join(config.resultsDir, THREE_TASK_REPORT_FILE)),
    readJsonFile(path.join(config.resultsDir, TOKEN_AUDIT_FILE)),
  ]);
  const sidecar = shapeSidecar(threeTaskReport, tokenAudit);

  const report = buildReport(generatedAt, runs, labels.length, sidecar);

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const agg = report.aggregate;
  process.stdout.write(
    [
      "Stage 5 pivot-check policy calibration written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Discovered: ${agg.runsDiscovered}   analyzed: ${agg.runsAnalyzed}   injected: ${agg.runsWithPivotCheckInjected}`,
      `hidden_pivot sole signal: ${agg.runsWhereHiddenPivotWasSoleSignal}/${agg.runsAnalyzed}   risk_gated≡multi_pivot: ${agg.runsWhereRiskGatedEqualsMultiPivot}/${agg.runsAnalyzed}`,
      `Suppression opportunities — strict: ${agg.suppressionOpportunitiesUnderStrict}   no_hidden: ${agg.suppressionOpportunitiesUnderNoHiddenPivotOnly}`,
      `hidden_pivot appears too broad: ${agg.hiddenPivotAppearsTooBroad ? "yes" : "no"}`,
      `Recommendation: ${report.recommendation.headline}`,
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
