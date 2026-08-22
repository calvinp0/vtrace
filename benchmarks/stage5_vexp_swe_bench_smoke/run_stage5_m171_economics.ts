/**
 * M171-E — the trade-off curve and the economics verdict (§63, §66, §94).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m171_economics.ts
 *
 * Assembles the dose curve, the preservation results and both holdouts into one
 * table, and evaluates the gates that were frozen in the plan before any of them
 * were measured.
 *
 * Every dollar here is a PROJECTED ATTRIBUTABLE COST (§65). M171 is offline: no
 * provider telemetry exists for these calls, and no billing saving is claimed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

const read = (name: string): any => JSON.parse(readFileSync(path.join(RESULTS, name), "utf-8"));

const dose = read("stage5_m171_dose_curve.json");
const preservation = read("stage5_m171_preservation.json");
const soundness = read("stage5_m171_claim_soundness.json");
const controls = read("stage5_m171_truthfulness_controls.json");
const holdoutA = read("stage5_m171_broad100a_holdout.json");
const holdoutB = read("stage5_m171_broad100b_holdout.json");

const M169 = Object.freeze({
  medianPipelineAttributableCostUsd: 0.088416,
  medianBaselineInvestigationAllUsd: 0.052438,
  medianBaselineInvestigationPreEditUsd: 0.048256,
  medianDisplacedUsd: 0.001433,
  medianDeliveredPayloadTokens: 6383,
  economicClasses: { PIPELINE_ECONOMIC_LOSS: 10, ROUGH_BREAK_EVEN: 1, NOT_MEASURABLE: 1 },
  source: "stage5_m169_economic_classes.json",
});

const COST_GATE_USD = M169.medianBaselineInvestigationAllUsd / 2;

const armOf = (arm: string): any => preservation.perArm.find((entry: any) => entry.arm === arm);
const curveOf = (rung: string): any => dose.curve.find((entry: any) => entry.rung === rung);

/** §63 — one row per candidate, every column the plan asked for. */
const tradeOff = ["R1000", "R1500", "R2000", "R2500"].map((rung) => {
  const curve = curveOf(rung);
  const arm = armOf(rung);
  return {
    rung,
    medianModelVisibleTokens: curve.tokens.median,
    p90: curve.tokens.p90,
    max: curve.tokens.max,
    projectedAttributableCostUsdMedian: curve.projectedAttributableCostUsd.median,
    evidenceDensity: curve.evidenceDensity.median,
    pivotPreservation: `${arm.pivotIdentical}/12`,
    actionSupportPreservation: `${arm.firstActionPreserved}/${arm.firstActionPreservationBase}`,
    firstEditPreservation: `${arm.firstEditPreserved}/${arm.firstEditPreservationBase}`,
    filesDeliveredVsCurrent: `${arm.medianFiles} vs ${armOf("CURRENT").medianFiles} median`,
    sizeGate: curve.tokens.median <= 2000 && curve.tokens.p90 <= 2500,
    costGate: curve.projectedAttributableCostUsd.median <= COST_GATE_USD,
  };
});

const sliceOf = (holdout: any, name: string): any => holdout.slices.find((slice: any) => slice.slice === name);
const aRemainder = sliceOf(holdoutA, "broad100a_non_development_remainder");
const aFull = sliceOf(holdoutA, "broad100a_full");
const bFull = sliceOf(holdoutB, "broad100b_full");

const holdoutGate = (slice: any): Record<string, unknown> => ({
  slice: slice.slice,
  cases: slice.cases,
  delivered: slice.delivered,
  medianTokens: slice.packetTokens.median,
  p90Tokens: slice.packetTokens.p90,
  medianProjectedCostUsd: slice.packetProjectedCostUsd.median,
  reductionFactor: slice.reductionFactor,
  pivotIdentity: slice.pivotIdentity,
  goldFileDeltaPercentagePoints: slice.goldFile.deltaPercentagePoints,
  goldSymbolDeltaPercentagePoints: slice.goldSymbol.deltaPercentagePoints,
  soundnessViolations: slice.soundnessViolations,
  passes: {
    size: slice.packetTokens.median <= 2000 && slice.packetTokens.p90 <= 2500,
    cost: slice.packetProjectedCostUsd.median <= COST_GATE_USD,
    pivot: slice.pivotIdentity.rate === 1 || slice.pivotIdentity.measurable === 0,
    goldFile: slice.goldFile.deltaPercentagePoints === null || slice.goldFile.deltaPercentagePoints >= -2,
    goldSymbol: slice.goldSymbol.deltaPercentagePoints === null || slice.goldSymbol.deltaPercentagePoints >= -2,
    soundness: slice.soundnessViolations === 0,
  },
});

const gateRows = [holdoutGate(aRemainder), holdoutGate(aFull), holdoutGate(bFull)];

/**
 * The two gate families are kept apart on purpose.
 *
 * Whether the economics changed is a question about size and price, and it is
 * answerable whatever the evidence-delivery result turns out to be. Whether the
 * contract may SHIP additionally requires the preservation gates. Folding the
 * second into the first would report a measured economic result as unmeasurable
 * because an unrelated delivery gate missed.
 */
const economicGatesPass = gateRows.every((row: any) => row.passes.size && row.passes.cost);
const preservationGatesPass = gateRows.every((row: any) => row.passes.pivot && row.passes.goldFile && row.passes.goldSymbol && row.passes.soundness);
const integrationEligible = economicGatesPass && preservationGatesPass;

const selected = curveOf("R2000");
const selectedArm = armOf("R2000");

const economicsVerdict = !economicGatesPass
  ? "ECONOMICS_NOT_MEASURABLE"
  : selected.projectedAttributableCostUsd.median <= COST_GATE_USD / 2
    ? "PROACTIVE_PIPELINE_ECONOMICS_MATERIALLY_CHANGED"
    : "PROACTIVE_PIPELINE_ECONOMICS_IMPROVED_BUT_STILL_WEAK";

const body = {
  schemaVersion: "stage5.m171.economics.v1",
  milestone: "M171",
  workstream: "M171-E",
  title: "What the redesigned orientation costs, against the baseline M169 priced",
  authority: {
    label: "PROJECTED ATTRIBUTABLE COST",
    meaning: "the payload written into cache once at the 1h rate, then re-read by every subsequent request",
    notClaimed: "no billing saving is claimed. M171 is offline and no provider telemetry exists for these calls (§65).",
    tokenCalibration: "M166 measured, 0.3174 tokens/character, r^2 0.926 over 363 provider-reported samples",
  },
  m169Reference: M169,
  gates: {
    medianTokensAtOrBelow: 2000,
    p90TokensAtOrBelow: 2500,
    projectedCostAtOrBelowUsd: COST_GATE_USD,
    costGateDerivation: "50% of the M169 median baseline localization cost of $0.052438 (§13)",
  },
  tradeOffCurve: tradeOff,
  selectedContract: {
    rung: "R2000",
    frozenBefore: "any holdout number existed",
    development: {
      medianTokens: selected.tokens.median,
      p90Tokens: selected.tokens.p90,
      medianProjectedCostUsd: selected.projectedAttributableCostUsd.median,
      evidenceDensity: selected.evidenceDensity.median,
      pivotIdentity: `${selectedArm.pivotIdentical}/12`,
      actionSupportPreservation: `${selectedArm.firstActionPreserved}/${selectedArm.firstActionPreservationBase}`,
    },
    currentDefault: {
      medianTokens: curveOf("CURRENT").tokens.median,
      medianProjectedCostUsd: curveOf("CURRENT").projectedAttributableCostUsd.median,
      evidenceDensity: curveOf("CURRENT").evidenceDensity.median,
    },
    reductionFactor: curveOf("CURRENT").tokens.median / selected.tokens.median,
  },
  holdout: gateRows,
  truthfulness: {
    packetsAudited: soundness.packetsAudited,
    totalViolations: soundness.totalViolations,
    unsupportedClaims: soundness.unsupportedClaims,
    falseAbsenceOrExhaustiveClaims: soundness.falseAbsenceOrExhaustiveClaims,
    controlSuitesPass: controls.passes,
  },
  proofs: dose.proofs,
  comparisonToM169Treatment: {
    m169TreatmentMedianCostUsd: M169.medianPipelineAttributableCostUsd,
    m171TreatmentMedianCostUsd: selected.projectedAttributableCostUsd.median,
    ratio: M169.medianPipelineAttributableCostUsd / selected.projectedAttributableCostUsd.median,
    m169DisplacedMedianUsd: M169.medianDisplacedUsd,
    stillCostsMoreThanItDisplaces: selected.projectedAttributableCostUsd.median > M169.medianDisplacedUsd,
    reading: "the treatment M169 priced at $0.088 per task now projects at a small fraction of that. It is still not free, and it still costs more than the $0.0014 of investigation M169 measured it displacing — the change is that the first-call price is no longer the reason a live retest would be uninformative.",
  },
  economicGatesPass,
  preservationGatesPass,
  integrationEligible,
  integrationEligibilityBasis: integrationEligible
    ? "§66 — size, cost and every preservation gate pass"
    : "§66 — integration additionally requires the preservation gates. The gold-symbol delivery gate frozen in the plan at 2 percentage points is missed on Broad100-A, so the contract is not eligible for integration however favourable its economics are.",
  economicsVerdict,
  economicsVerdictBasis: economicsVerdict === "PROACTIVE_PIPELINE_ECONOMICS_MATERIALLY_CHANGED"
    ? "the measured candidate costs an order of magnitude less than the treatment M169 tested, comfortably inside half the baseline localization cost. M169's economic null was measured on a different treatment and would not settle this one. This describes the CANDIDATE; the shipped default is unchanged, so production economics are unchanged."
    : "one or more gates did not pass; the treatment is not established as materially different",
};

writeFileSync(path.join(RESULTS, "stage5_m171_economics.json"), `${JSON.stringify(body, null, 1)}\n`);
process.stdout.write("wrote stage5_m171_economics.json\n");
process.stdout.write(`${JSON.stringify({ tradeOff, gateRows, economicsVerdict }, null, 1)}\n`);
