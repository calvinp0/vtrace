/**
 * M169-C — what the pipeline replaced, what it cost, and the ratio between them.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m169_economics.ts
 *
 * Reads the M169-A ledger. The thresholds and the denominator were frozen in
 * `stage5_m169_plan.md` before any of these numbers existed, and are imported
 * from the module rather than restated here so that they cannot drift.
 *
 * Two rules do the work:
 *
 *   §17  a blocked or absent search is not a saved search. The denominator is
 *        the measured PAIRED REDUCTION in investigation traffic, not the count
 *        of tools the treatment arm did not call.
 *   §21  the grader outcome is not an input to the economic class. It is
 *        overlaid afterwards, so that "cheaper" and "better" stay separable.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { EconomicClass, breakEvenPayloadTokens, classifyEconomics, ECONOMIC_THRESHOLDS } from "./m169Economics";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

interface LedgerRun extends Record<string, any> {
  readonly arm: string;
  readonly instanceId: string;
}

const ledger = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m169_paired_ledger.json"), "utf-8")) as {
  perRun: LedgerRun[];
  pairs: Record<string, any>[];
};

const byKey = new Map<string, LedgerRun>();
for (const run of ledger.perRun) byKey.set(`${run.instanceId}|${run.arm}`, run);

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(middle)]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const rows = ledger.pairs.map((pair) => {
  const instanceId = pair.instanceId as string;
  const a = byKey.get(`${instanceId}|baseline`);
  const c = byKey.get(`${instanceId}|vtrace_clean`);
  const measurable = Boolean(pair.uncensoredEconomicPair) && a !== undefined && c !== undefined
    && a.cacheIdentityHolds && c.cacheIdentityHolds;

  const pipelineCostUsd = c?.pipelineAttributableCostUsd ?? null;

  // §17 — the paired reduction actually observed, floored at zero.
  const displacedUsd = a === undefined || c === undefined
    ? null
    : Number(Math.max(0, a.investigationCostUsdPreEdit - c.investigationCostUsdPreEdit).toFixed(6));
  // One-way sensitivity: credit VTRACE with everything the baseline ever inspected.
  const displacedGenerousUsd = a?.investigationCostUsdAll ?? null;

  const verdict = classifyEconomics(pipelineCostUsd, displacedUsd, measurable);
  const generous = classifyEconomics(pipelineCostUsd, displacedGenerousUsd, measurable);

  const amplification = c?.pipelineAmplificationRequests ?? 0;
  return {
    instanceId,
    measurable,
    censoredArms: pair.censoredArms,

    pipelineAttributableCostUsd: pipelineCostUsd,
    pipelinePayloadTokens: c?.pipelinePayloadTokens ?? null,
    pipelineAmplificationRequests: amplification,

    baselineInvestigationPreEditUsd: a?.investigationCostUsdPreEdit ?? null,
    cleanInvestigationPreEditUsd: c?.investigationCostUsdPreEdit ?? null,
    displacedUsd,
    baselineInvestigationAllUsd: displacedGenerousUsd,

    economicRatio: verdict.ratio,
    economicRatioLabel: verdict.ratioLabel,
    economicClass: verdict.economicClass,
    economicRatioGenerous: generous.ratio,
    economicClassGenerous: generous.economicClass,

    breakEvenPayloadTokens: displacedUsd === null ? null : breakEvenPayloadTokens(displacedUsd, amplification),
    breakEvenPayloadTokensGenerous: displacedGenerousUsd === null
      ? null
      : breakEvenPayloadTokens(displacedGenerousUsd, amplification),

    // §22 — overlay, never an input.
    outcome: {
      baselineResolved: pair.resolvedBaseline,
      cleanResolved: pair.resolvedClean,
      cleanUniqueWin: pair.resolvedClean === true && pair.resolvedBaseline === false,
      baselineUniqueWin: pair.resolvedBaseline === true && pair.resolvedClean === false,
    },
    deltaCostUsd: pair.deltaCostUsd,
    deltaSearches: pair.deltaSearches,
    deltaReads: pair.deltaReads,
    deltaShellInspections: pair.deltaShellInspections,
  };
});

const measurableRows = rows.filter((r) => r.measurable);
const tally = (key: "economicClass" | "economicClassGenerous"): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of measurableRows) counts[row[key]] = (counts[row[key]] ?? 0) + 1;
  return counts;
};

// §22 — does saving correlate with harm? Computed, not asserted.
const overlay = {
  note: "Economic class was assigned without reference to the grader (§21). This table only asks whether the two happen to line up.",
  byClass: Object.fromEntries(
    [EconomicClass.Win, EconomicClass.BreakEven, EconomicClass.Loss].map((economicClass) => {
      const bucket = measurableRows.filter((r) => r.economicClass === economicClass);
      return [economicClass, {
        tasks: bucket.length,
        cleanResolved: bucket.filter((r) => r.outcome.cleanResolved === true).length,
        baselineResolved: bucket.filter((r) => r.outcome.baselineResolved === true).length,
        cleanUniqueWins: bucket.filter((r) => r.outcome.cleanUniqueWin).length,
        baselineUniqueWins: bucket.filter((r) => r.outcome.baselineUniqueWin).length,
      }];
    }),
  ),
};

const document = {
  schemaVersion: "stage5.m169.economic-classes.v1",
  milestone: "M169",
  workstream: "M169-C",
  thresholds: ECONOMIC_THRESHOLDS,
  thresholdProvenance: "frozen in stage5_m169_plan.md before any economic result was computed (§20)",
  denominator: {
    primary: "max(0, baseline pre-edit investigation cost - clean pre-edit investigation cost)",
    generous: "baseline whole-run investigation cost; a one-way sensitivity check that credits VTRACE with replacing everything the baseline ever inspected",
  },
  graderPairs: rows.length,
  measurablePairs: measurableRows.length,
  classCounts: tally("economicClass"),
  classCountsGenerous: tally("economicClassGenerous"),
  medians: {
    pipelineAttributableCostUsd: Number(median(measurableRows.map((r) => r.pipelineAttributableCostUsd ?? 0)).toFixed(6)),
    displacedUsd: Number(median(measurableRows.map((r) => r.displacedUsd ?? 0)).toFixed(6)),
    baselineInvestigationPreEditUsd: Number(median(measurableRows.map((r) => r.baselineInvestigationPreEditUsd ?? 0)).toFixed(6)),
    baselineInvestigationAllUsd: Number(median(measurableRows.map((r) => r.baselineInvestigationAllUsd ?? 0)).toFixed(6)),
    breakEvenPayloadTokens: median(measurableRows.map((r) => r.breakEvenPayloadTokens ?? 0)),
    breakEvenPayloadTokensGenerous: median(measurableRows.map((r) => r.breakEvenPayloadTokensGenerous ?? 0)),
    deliveredPayloadTokens: median(measurableRows.map((r) => r.pipelinePayloadTokens ?? 0)),
  },
  outcomeOverlay: overlay,
  rows,
};

writeFileSync(path.join(RESULTS, "stage5_m169_economic_classes.json"), `${JSON.stringify(document, null, 2)}\n`);
console.log("wrote stage5_m169_economic_classes.json\n");

console.log(`${"instance".padEnd(32)} ${"pipe$".padStart(7)} ${"displ$".padStart(7)} ${"ratio".padStart(8)}  ${"class".padEnd(24)} ${"breakEven".padStart(9)} ${"delivered".padStart(9)}`);
for (const row of rows) {
  console.log(
    `${row.instanceId.padEnd(32)} ${String(row.pipelineAttributableCostUsd ?? "-").slice(0, 7).padStart(7)} `
    + `${String(row.displacedUsd ?? "-").slice(0, 7).padStart(7)} ${row.economicRatioLabel.padStart(8)}  `
    + `${row.economicClass.padEnd(24)} ${String(row.breakEvenPayloadTokens ?? "-").padStart(9)} ${String(row.pipelinePayloadTokens ?? "-").padStart(9)}`,
  );
}
console.log(`\nclasses (primary denominator):  ${JSON.stringify(tally("economicClass"))}`);
console.log(`classes (generous denominator): ${JSON.stringify(tally("economicClassGenerous"))}`);
console.log(`\nmedian delivered payload      ${document.medians.deliveredPayloadTokens} tokens`);
console.log(`median break-even payload     ${document.medians.breakEvenPayloadTokens} tokens (primary)`);
console.log(`median break-even payload     ${document.medians.breakEvenPayloadTokensGenerous} tokens (generous)`);
console.log(`\noutcome overlay: ${JSON.stringify(overlay.byClass)}`);
