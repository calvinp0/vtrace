/**
 * M173-C — what the orientation replaced, what it cost, and the ratio between
 * them, recomputed exactly as M169 computed it.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_economics.ts
 *
 * §26 makes this mandatory: M173 exists partly to see whether M169's ratio
 * changed, and a ratio computed a different way could not answer that. So the
 * thresholds, the denominator rule and the classifier are imported from
 * `m169Economics` rather than restated, and the arithmetic below is M169's with
 * `vtrace_clean` replaced by `vtrace_compact`.
 *
 * Two rules do the work, both frozen before any M173 number existed:
 *
 *   §17/§38  a blocked or absent search is not a saved search. The denominator
 *            is the measured PAIRED REDUCTION in investigation traffic, never
 *            the count of tools the treatment arm did not call.
 *   §24/§37  the grader outcome is not an input to the economic class. It is
 *            overlaid afterwards, so "cheaper" and "better" stay separable.
 *
 * Offline. Reads `stage5_m173_paired_ledger.json` only.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  EconomicClass,
  breakEvenPayloadTokens,
  classifyEconomics,
  ECONOMIC_THRESHOLDS,
} from "./m169Economics";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

const ledger = JSON.parse(
  readFileSync(path.join(RESULTS, "stage5_m173_paired_ledger.json"), "utf-8"),
) as { perRun: Record<string, any>[]; pairs: Record<string, any>[] };

const byKey = new Map<string, Record<string, any>>();
for (const run of ledger.perRun) byKey.set(`${run.instanceId}|${run.arm}`, run);

const numbers = (values: readonly (number | null)[]): number[] =>
  values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(middle)]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((t, v) => t + v, 0) / values.length;

const quantile = (values: readonly number[], q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
};

// ── per-task economics ──────────────────────────────────────────────

const rows = ledger.pairs.map((pair) => {
  const instanceId = pair.instanceId as string;
  const a = byKey.get(`${instanceId}|baseline`);
  const b = byKey.get(`${instanceId}|vtrace_compact`);
  const measurable = Boolean(pair.uncensoredEconomicPair)
    && a !== undefined && b !== undefined
    && a.cacheIdentityHolds === true && b.cacheIdentityHolds === true;

  // Orientation cost is the FIRST pipeline call only. Voluntary follow-up
  // calls are counted separately (§53) and never folded into the first call's
  // attributable cost, because the treatment under test is the automatic
  // orientation and not the agent's later choices.
  const orientationCostUsd = b?.orientationAttributableCostUsd ?? null;
  const allPipelineCostUsd = b?.allPipelineAttributableCostUsd ?? null;
  const voluntaryPipelineCostUsd = orientationCostUsd === null || allPipelineCostUsd === null
    ? null
    : Number(Math.max(0, allPipelineCostUsd - orientationCostUsd).toFixed(6));

  // §17 — the paired reduction actually observed, floored at zero.
  const displacedUsd = a === undefined || b === undefined
    ? null
    : Number(Math.max(0, a.investigationCostUsdPreEdit - b.investigationCostUsdPreEdit).toFixed(6));
  // One-way sensitivity: credit the orientation with everything the baseline
  // ever inspected, over the whole run.
  const displacedGenerousUsd = a?.investigationCostUsdAll ?? null;

  const verdict = classifyEconomics(orientationCostUsd, displacedUsd, measurable);
  const generous = classifyEconomics(orientationCostUsd, displacedGenerousUsd, measurable);

  const amplification = b?.orientationAmplificationRequests ?? 0;

  // The disclosure the model actually received. A run whose projector declined
  // did not receive the treatment under test, and saying so is the point.
  const disclosure = b?.orientationDisclosure ?? null;
  const treatmentAsShipped = disclosure === "COMPACT_ORIENTATION";

  return {
    instanceId,
    measurable,
    censoredArms: pair.censoredArms,

    orientationDisclosure: disclosure,
    orientationDeliveredAsCompact: treatmentAsShipped,
    orientationCharacters: b?.orientationCharacters ?? null,
    orientationPayloadTokens: b?.orientationPayloadTokens ?? null,
    orientationAmplificationRequests: amplification,
    orientationAttributableCostUsd: orientationCostUsd,
    voluntaryPipelineCalls: b?.voluntaryPipelineReuse ?? null,
    voluntaryPipelineCostUsd,

    baselineInvestigationPreEditUsd: a?.investigationCostUsdPreEdit ?? null,
    compactInvestigationPreEditUsd: b?.investigationCostUsdPreEdit ?? null,
    displacedUsd,
    baselineInvestigationAllUsd: displacedGenerousUsd,
    compactInvestigationAllUsd: b?.investigationCostUsdAll ?? null,

    economicRatio: verdict.ratio,
    economicRatioLabel: verdict.ratioLabel,
    economicClass: verdict.economicClass,
    economicRatioGenerous: generous.ratio,
    economicClassGenerous: generous.economicClass,

    breakEvenPayloadTokens: displacedUsd === null ? null : breakEvenPayloadTokens(displacedUsd, amplification),

    // §24 — overlay, never an input.
    outcome: {
      baselineResolved: pair.resolvedBaseline,
      compactResolved: pair.resolvedCompact,
      compactUniqueWin: pair.resolvedCompact === true && pair.resolvedBaseline === false,
      baselineUniqueWin: pair.resolvedBaseline === true && pair.resolvedCompact === false,
      sharedSuccess: pair.resolvedBaseline === true && pair.resolvedCompact === true,
      sharedFailure: pair.resolvedBaseline === false && pair.resolvedCompact === false,
    },

    deltaCostUsd: pair.deltaCostUsd,
    deltaTotalTrafficTokens: pair.deltaTotalTrafficTokens,
    deltaPreEditInputSideCostUsd: pair.deltaPreEditInputSideCostUsd,
    deltaInvestigationCostUsdPreEdit: pair.deltaInvestigationCostUsdPreEdit,
    deltaInvestigationCostUsdAll: pair.deltaInvestigationCostUsdAll,
    deltaRequests: pair.deltaRequests,
    deltaSearches: pair.deltaSearches,
    deltaReads: pair.deltaReads,
    deltaShellInspections: pair.deltaShellInspections,
    deltaFirstEditRequest: pair.deltaFirstEditRequest,
    baselineFirstEditRequest: a?.firstEditRequest ?? null,
    compactFirstEditRequest: b?.firstEditRequest ?? null,
  };
});

const measurableRows = rows.filter((r) => r.measurable);

const tally = (key: "economicClass" | "economicClassGenerous"): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of measurableRows) counts[row[key]] = (counts[row[key]] ?? 0) + 1;
  return counts;
};

// ── the aggregate that answers §26 and §83 ──────────────────────────

const sum = (values: readonly number[]): number => values.reduce((t, v) => t + v, 0);

const orientationTotal = sum(numbers(measurableRows.map((r) => r.orientationAttributableCostUsd)));
const displacedPreEditTotal = sum(measurableRows.map((r) => {
  const a = byKey.get(`${r.instanceId}|baseline`)!;
  const b = byKey.get(`${r.instanceId}|vtrace_compact`)!;
  return a.investigationCostUsdPreEdit - b.investigationCostUsdPreEdit;
}));
const baselineWholeRunInvestigation = sum(measurableRows.map(
  (r) => byKey.get(`${r.instanceId}|baseline`)!.investigationCostUsdAll as number,
));
const compactWholeRunInvestigation = sum(measurableRows.map(
  (r) => byKey.get(`${r.instanceId}|vtrace_compact`)!.investigationCostUsdAll as number,
));
const premiumTotal = sum(numbers(measurableRows.map((r) => r.deltaCostUsd)));
const pairs = measurableRows.length;

const aggregate = {
  measurablePairs: pairs,
  orientationAttributableCostUsdTotal: Number(orientationTotal.toFixed(4)),
  orientationAttributableCostUsdPerTask: pairs === 0 ? null : Number((orientationTotal / pairs).toFixed(4)),
  netInvestigationDisplacedPreEditUsdTotal: Number(displacedPreEditTotal.toFixed(4)),
  netInvestigationDisplacedPreEditUsdPerTask: pairs === 0 ? null : Number((displacedPreEditTotal / pairs).toFixed(4)),
  wholeRunInvestigationBaselineUsd: Number(baselineWholeRunInvestigation.toFixed(4)),
  wholeRunInvestigationCompactUsd: Number(compactWholeRunInvestigation.toFixed(4)),
  wholeRunInvestigationNetDisplacedUsd: Number((baselineWholeRunInvestigation - compactWholeRunInvestigation).toFixed(4)),
  aggregateEconomicRatio: displacedPreEditTotal <= 0 ? null : Number((orientationTotal / displacedPreEditTotal).toFixed(1)),
  pairedCostPremiumUsdTotal: Number(premiumTotal.toFixed(4)),
  pairedCostPremiumUsdPerTask: pairs === 0 ? null : Number((premiumTotal / pairs).toFixed(4)),
};

// ── distributions (§41, §42) ────────────────────────────────────────

const distribution = (label: string, values: readonly (number | null)[]) => {
  const v = numbers(values);
  return {
    metric: label,
    n: v.length,
    median: median(v),
    mean: mean(v) === null ? null : Number(mean(v)!.toFixed(6)),
    p10: quantile(v, 0.1),
    p90: quantile(v, 0.9),
    min: v.length === 0 ? null : Math.min(...v),
    max: v.length === 0 ? null : Math.max(...v),
    negative: v.filter((x) => x < 0).length,
    positive: v.filter((x) => x > 0).length,
  };
};

const distributions = [
  distribution("deltaCostUsd", measurableRows.map((r) => r.deltaCostUsd)),
  distribution("deltaTotalTrafficTokens", measurableRows.map((r) => r.deltaTotalTrafficTokens)),
  distribution("deltaPreEditInputSideCostUsd", measurableRows.map((r) => r.deltaPreEditInputSideCostUsd)),
  distribution("deltaInvestigationCostUsdPreEdit", measurableRows.map((r) => r.deltaInvestigationCostUsdPreEdit)),
  distribution("deltaInvestigationCostUsdAll", measurableRows.map((r) => r.deltaInvestigationCostUsdAll)),
  distribution("deltaRequests", measurableRows.map((r) => r.deltaRequests)),
  distribution("deltaSearches", measurableRows.map((r) => r.deltaSearches)),
  distribution("deltaReads", measurableRows.map((r) => r.deltaReads)),
  distribution("deltaFirstEditRequest", measurableRows.map((r) => r.deltaFirstEditRequest)),
  distribution("orientationAttributableCostUsd", measurableRows.map((r) => r.orientationAttributableCostUsd)),
  distribution("orientationCharacters", measurableRows.map((r) => r.orientationCharacters)),
  distribution("orientationPayloadTokens", measurableRows.map((r) => r.orientationPayloadTokens)),
];

// ── solve-rate classification (§39) ─────────────────────────────────

const graded = rows.filter((r) => typeof r.outcome.baselineResolved === "boolean"
  && typeof r.outcome.compactResolved === "boolean");
const solves = {
  gradedPairs: graded.length,
  baselineResolved: graded.filter((r) => r.outcome.baselineResolved === true).length,
  compactResolved: graded.filter((r) => r.outcome.compactResolved === true).length,
  sharedSuccess: graded.filter((r) => r.outcome.sharedSuccess).length,
  baselineUniqueWin: graded.filter((r) => r.outcome.baselineUniqueWin).length,
  compactUniqueWin: graded.filter((r) => r.outcome.compactUniqueWin).length,
  sharedFailure: graded.filter((r) => r.outcome.sharedFailure).length,
  baselineUniqueWinCases: graded.filter((r) => r.outcome.baselineUniqueWin).map((r) => r.instanceId),
  compactUniqueWinCases: graded.filter((r) => r.outcome.compactUniqueWin).map((r) => r.instanceId),
};

// ── M169 comparison (§82, §83) ──────────────────────────────────────

const m169 = {
  pipelineAttributableCostUsdPerTask: 0.0985,
  investigationDisplacedPerTaskUsd: 0.0026,
  wholeRunInvestigationNetDisplacedUsd: -0.0070,
  aggregateEconomicRatio: 38,
  classes: { PIPELINE_ECONOMIC_LOSS: 10, ROUGH_BREAK_EVEN: 1, PIPELINE_ECONOMIC_WIN: 0, NOT_MEASURABLE: 1 },
  treatment: "rich run_pipeline default, median ~6,884 model-visible tokens",
};

const m172Projection = { projectedOrientationCostUsd: 0.0084, projectedMedianTokens: 621 };

const orientationCosts = numbers(measurableRows.map((r) => r.orientationAttributableCostUsd));
const comparison = {
  m169,
  m172Projection,
  m173: {
    treatment: "compact run_pipeline default (M172), measured live",
    orientationAttributableCostUsdPerTask: aggregate.orientationAttributableCostUsdPerTask,
    orientationAttributableCostUsdMedian: median(orientationCosts),
    investigationDisplacedPerTaskUsd: aggregate.netInvestigationDisplacedPreEditUsdPerTask,
    wholeRunInvestigationNetDisplacedUsd: aggregate.wholeRunInvestigationNetDisplacedUsd,
    aggregateEconomicRatio: aggregate.aggregateEconomicRatio,
    classes: tally("economicClass"),
  },
  firstCallCostChange: aggregate.orientationAttributableCostUsdPerTask === null
    ? null
    : {
      m169PerTaskUsd: m169.pipelineAttributableCostUsdPerTask,
      m173PerTaskUsd: aggregate.orientationAttributableCostUsdPerTask,
      reductionFactor: aggregate.orientationAttributableCostUsdPerTask === 0
        ? null
        : Number((m169.pipelineAttributableCostUsdPerTask / aggregate.orientationAttributableCostUsdPerTask).toFixed(1)),
    },
  projectionError: median(orientationCosts) === null
    ? null
    : {
      m172ProjectedUsd: m172Projection.projectedOrientationCostUsd,
      m173ActualMedianUsd: Number(median(orientationCosts)!.toFixed(6)),
      ratio: Number((median(orientationCosts)! / m172Projection.projectedOrientationCostUsd).toFixed(2)),
      note:
        "M172's projection priced the packet's own tokens. The live figure also carries "
        + "amplification — every later request re-reads the packet as cache — so a ratio above "
        + "one is expected and its SIZE is the interesting number, not its sign.",
    },
};

const report = {
  schemaVersion: "stage5.m173.economics.v1",
  milestone: "M173",
  workstream: "M173-C",
  thresholds: ECONOMIC_THRESHOLDS,
  thresholdsFrozenBefore: "any M173 live run existed; imported from m169Economics",
  denominatorRule:
    "§17 — the measured PAIRED REDUCTION in pre-edit investigation traffic. Fewer search "
    + "calls are not savings.",
  treatmentDelivery: {
    note:
      "a run whose projector declined received the FULL authoritative payload, not the "
      + "treatment under test. Counted, never silently pooled.",
    deliveredAsCompact: rows.filter((r) => r.orientationDeliveredAsCompact).length,
    fellBackToAuthoritative: rows.filter(
      (r) => r.orientationDisclosure !== null && !r.orientationDeliveredAsCompact,
    ).length,
    noPipelineCall: rows.filter((r) => r.orientationDisclosure === null).length,
  },
  aggregate,
  classCounts: tally("economicClass"),
  classCountsGenerous: tally("economicClassGenerous"),
  distributions,
  solves,
  comparison,
  rows,
};

writeFileSync(path.join(RESULTS, "stage5_m173_task_economics.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`M173 economics over ${pairs} measurable pairs`);
console.log(`  orientation attributable cost   $${aggregate.orientationAttributableCostUsdPerTask ?? "-"} / task`);
console.log(`  investigation displaced         $${aggregate.netInvestigationDisplacedPreEditUsdPerTask ?? "-"} / task`);
console.log(`  aggregate ratio                 ${aggregate.aggregateEconomicRatio ?? "-"}x   (M169: 38x)`);
console.log(`  whole-run investigation net     $${aggregate.wholeRunInvestigationNetDisplacedUsd}`);
console.log(`  paired cost premium             $${aggregate.pairedCostPremiumUsdPerTask ?? "-"} / task`);
console.log(`  classes                         ${JSON.stringify(tally("economicClass"))}`);
console.log(`  solves                          A ${solves.baselineResolved}/${solves.gradedPairs}  B ${solves.compactResolved}/${solves.gradedPairs}`);
console.log(`  unique wins                     A ${solves.baselineUniqueWin}  B ${solves.compactUniqueWin}`);
console.log(`  delivered as compact            ${report.treatmentDelivery.deliveredAsCompact}, fell back ${report.treatmentDelivery.fellBackToAuthoritative}`);
