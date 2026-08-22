/**
 * M169-F — the economic diagnosis, three verdicts, and one next lever.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m169_diagnosis.ts
 *
 * Reads the artifacts M169-A..E produced and derives the verdicts from them
 * mechanically, so that the conclusion in the report and the numbers in the JSON
 * cannot drift apart. Every decision rule is written here in the open; where a
 * rule was frozen earlier it is imported rather than restated.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const read = (name: string): any | null => {
  const file = path.join(RESULTS, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : null;
};

const ledger = read("stage5_m169_paired_ledger.json");
const economics = read("stage5_m169_economic_classes.json");
const composition = read("stage5_m169_payload_composition.json");
const phases = read("stage5_m169_phase_decomposition.json");
const breakEven = read("stage5_m169_break_even_budget.json");
const predictors = read("stage5_m169_predictor_audit.json");
const doseM168 = read("stage5_m169_dose_simulation_m168.json");
const doseA = read("stage5_m169_dose_simulation_broad100a.json");
const doseB = read("stage5_m169_dose_simulation_broad100b.json");
for (const [name, doc] of Object.entries({ ledger, economics, composition, phases, breakEven, predictors })) {
  if (doc === null) throw new Error(`missing input artifact: ${name}`);
}

const byKey = new Map<string, any>();
for (const run of ledger.perRun) byKey.set(`${run.instanceId}|${run.arm}`, run);
const measurable = economics.rows.filter((r: any) => r.measurable);

// ── the aggregate that decides everything ───────────────────────────

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const pipelineTotal = sum(measurable.map((r: any) => r.pipelineAttributableCostUsd ?? 0));
const displacedPreEditTotal = sum(measurable.map((r: any) =>
  byKey.get(`${r.instanceId}|baseline`).investigationCostUsdPreEdit
  - byKey.get(`${r.instanceId}|vtrace_clean`).investigationCostUsdPreEdit));
const baselineWholeRun = sum(measurable.map((r: any) => byKey.get(`${r.instanceId}|baseline`).investigationCostUsdAll));
const cleanWholeRun = sum(measurable.map((r: any) => byKey.get(`${r.instanceId}|vtrace_clean`).investigationCostUsdAll));
const premiumTotal = sum(ledger.pairs.filter((p: any) => p.uncensoredEconomicPair).map((p: any) => p.deltaCostUsd ?? 0));
const pairs = measurable.length;

const aggregate = {
  uncensoredPairs: pairs,
  pipelineAttributableCostUsdTotal: Number(pipelineTotal.toFixed(4)),
  pipelineAttributableCostUsdPerTask: Number((pipelineTotal / pairs).toFixed(4)),
  netInvestigationDisplacedPreEditUsdTotal: Number(displacedPreEditTotal.toFixed(4)),
  netInvestigationDisplacedPreEditUsdPerTask: Number((displacedPreEditTotal / pairs).toFixed(4)),
  wholeRunInvestigationBaselineUsd: Number(baselineWholeRun.toFixed(4)),
  wholeRunInvestigationCleanUsd: Number(cleanWholeRun.toFixed(4)),
  wholeRunInvestigationNetDisplacedUsd: Number((baselineWholeRun - cleanWholeRun).toFixed(4)),
  aggregateEconomicRatio: displacedPreEditTotal <= 0 ? null : Number((pipelineTotal / displacedPreEditTotal).toFixed(1)),
  pairedCostPremiumUsdTotal: Number(premiumTotal.toFixed(4)),
  pairedCostPremiumUsdPerTask: Number((premiumTotal / pairs).toFixed(4)),
  premiumExplainedByPayloadPercent: premiumTotal === 0 ? null
    : Number(((100 * pipelineTotal) / premiumTotal).toFixed(1)),
};

// ── verdicts ────────────────────────────────────────────────────────

const classCounts = economics.classCounts as Record<string, number>;
const lossShare = (classCounts.PIPELINE_ECONOMIC_LOSS ?? 0) / pairs;
const deliveredFits = breakEven.fitCounts.generousDeliveredAsShipped as Record<string, number>;
const usefulFitsGenerous = breakEven.fitCounts.generousEvidencePlusControl as Record<string, number>;
const usefulFitsPrimary = breakEven.fitCounts.primaryEvidencePlusControl as Record<string, number>;

/**
 * H1 vs H2, decided by two independent facts rather than by a preference:
 *
 *   overfed          the shipped payload exceeds the break-even budget on almost
 *                    every task, AND its useful core would not have
 *   selective        a substantial minority of tasks displaced nothing, so no
 *                    payload size makes them economic
 *
 * When both hold, the diagnosis is MULTI_FACTOR and §54 requires naming the
 * larger measured lever rather than doing both.
 */
const overfed = (deliveredFits.NO ?? 0) / pairs >= 0.7
  && (usefulFitsGenerous.YES_COMFORTABLY ?? 0) + (usefulFitsGenerous.YES_NARROWLY ?? 0) > (usefulFitsGenerous.NO ?? 0);
const displacedNothing = measurable.filter((r: any) => (r.displacedUsd ?? 0) <= 0.005).length;
const selective = displacedNothing / pairs >= 0.3;

const economicDiagnosis = overfed && selective
  ? "PIPELINE_ECONOMICS_MULTI_FACTOR"
  : overfed ? "PIPELINE_INTRINSICALLY_OVERFED"
    : selective ? "PIPELINE_SELECTIVELY_ECONOMIC"
      : "PIPELINE_ECONOMIC_DIAGNOSIS_INCONCLUSIVE";

/**
 * The dose verdict weighs what a smaller payload would recover against what the
 * premium actually is. "Plausible" rather than "strongly justified" is the
 * honest ceiling when the recoverable share leaves a residual premium behind.
 */
const evidencePlusControlTokens = breakEven.medians.evidencePlusControlTokens as number;
const deliveredTokens = breakEven.medians.deliveredPayloadTokens as number;
const removableShare = deliveredTokens === 0 ? 0 : 1 - evidencePlusControlTokens / deliveredTokens;
const recoverableUsdPerTask = aggregate.pipelineAttributableCostUsdPerTask * removableShare;
const residualPremiumUsdPerTask = aggregate.pairedCostPremiumUsdPerTask - recoverableUsdPerTask;

const doseVerdict = removableShare >= 0.5 && residualPremiumUsdPerTask > 0
  ? "LOWER_EVIDENCE_DOSE_PLAUSIBLE"
  : removableShare >= 0.5 ? "LOWER_EVIDENCE_DOSE_STRONGLY_JUSTIFIED"
    : (usefulFitsPrimary.NO ?? 0) > (usefulFitsPrimary.YES_COMFORTABLY ?? 0)
      ? "LOWER_EVIDENCE_DOSE_UNLIKELY_TO_FIX_ECONOMICS"
      : "EVIDENCE_DOSE_NOT_MEASURABLE";

/**
 * §55 — the question that comes BEFORE how big the payload should be.
 *
 * If the MINIMUM useful payload still costs more than the investigation actually
 * displaced, then no dose makes proactive invocation economic and squeezing the
 * response further is answering the wrong question.
 *
 * This gate was added after the generous denominator was shown to be
 * counterfactually false: whole-run investigation went UP in the treatment arm,
 * so crediting VTRACE with replacing everything the baseline inspected credits
 * it with a replacement that demonstrably did not happen. The rule is recorded
 * as a revision rather than presented as the original, because it changed the
 * recommendation.
 */
const usefulShare = deliveredTokens === 0 ? 0 : evidencePlusControlTokens / deliveredTokens;
const perTaskFloor = measurable.map((r: any) => ({
  instanceId: r.instanceId,
  minimumUsefulPayloadCostUsd: Number(((r.pipelineAttributableCostUsd ?? 0) * usefulShare).toFixed(6)),
  displacedUsd: r.displacedUsd as number | null,
  floorExceedsDisplacement: (r.pipelineAttributableCostUsd ?? 0) * usefulShare > (r.displacedUsd ?? 0),
}));
const floorExceedsCount = perTaskFloor.filter((r) => r.floorExceedsDisplacement).length;
const noDoseCanWork = floorExceedsCount / pairs >= 0.7;

const separations = predictors.separations as { verdict: string; tier: string; feature: string }[];
const separates = separations.filter((s) => s.verdict === "SEPARATES");
const weakPreInvocation = separations.filter((s) => s.verdict === "WEAK" && s.tier === "PRE_INVOCATION");
const routingVerdict = separates.length > 0
  ? "SELECTIVE_INVOCATION_PLAUSIBLE"
  : weakPreInvocation.length > 0
    ? "SELECTIVE_INVOCATION_INCONCLUSIVE"
    : "SELECTIVE_INVOCATION_NOT_SUPPORTED";

/**
 * §54 — with two factors, recommend the larger measured lever first, and only
 * that one. The dose lever is sized by what a smaller payload recovers on every
 * task; the routing lever by what not invoking recovers on the tasks that
 * displaced nothing. Routing is additionally discounted here for a reason the
 * arithmetic cannot see on its own: M169-E found nothing to route ON.
 */
const routingRecoverableUsdPerTask = (displacedNothing / pairs) * aggregate.pipelineAttributableCostUsdPerTask;
const nextLever = noDoseCanWork && routingVerdict !== "SELECTIVE_INVOCATION_PLAUSIBLE"
  ? "NO_FURTHER_PROACTIVE_PIPELINE_WORK"
  : routingVerdict === "SELECTIVE_INVOCATION_PLAUSIBLE"
    ? "SELECTIVE_PIPELINE_INVOCATION"
    : doseVerdict.startsWith("LOWER_EVIDENCE_DOSE") && recoverableUsdPerTask >= routingRecoverableUsdPerTask
      ? "GLOBAL_EVIDENCE_DOSE_REDUCTION"
      : "NO_FURTHER_PROACTIVE_PIPELINE_WORK";

const document = {
  schemaVersion: "stage5.m169.economic-diagnosis.v1",
  milestone: "M169",
  workstream: "M169-F",
  aggregate,
  payloadComposition: composition.cleanArmCategoryCost,
  temporalSplit: phases.pairedMedians,
  breakEvenFits: breakEven.fitCounts,
  economicClassCounts: economics.classCounts,
  economicClassCountsGenerous: economics.classCountsGenerous,
  doseLadderCorpora: {
    "M168-12": doseM168 === null ? "NOT_RUN" : { cases: doseM168.casesRun, perBudget: doseM168.perBudget, repeatControl: doseM168.repeatControl },
    "Broad100-A": doseA === null ? "NOT_RUN" : { cases: doseA.casesRun, perBudget: doseA.perBudget, repeatControl: doseA.repeatControl },
    "Broad100-B": doseB === null ? "NOT_RUN" : { cases: doseB.casesRun, perBudget: doseB.perBudget, repeatControl: doseB.repeatControl },
  },
  levers: {
    removablePayloadShare: Number(removableShare.toFixed(4)),
    doseRecoverableUsdPerTask: Number(recoverableUsdPerTask.toFixed(4)),
    routingRecoverableUsdPerTask: Number(routingRecoverableUsdPerTask.toFixed(4)),
    residualPremiumAfterDoseUsdPerTask: Number(residualPremiumUsdPerTask.toFixed(4)),
    tasksThatDisplacedNothing: displacedNothing,
    minimumUsefulPayloadShare: Number(usefulShare.toFixed(4)),
    tasksWhereMinimumUsefulPayloadExceedsDisplacement: floorExceedsCount,
    noDoseCanMakeProactiveInvocationEconomic: noDoseCanWork,
    perTaskFloor,
  },
  verdicts: {
    economicDiagnosis,
    evidenceDose: doseVerdict,
    selectiveInvocation: routingVerdict,
    nextLever,
  },
  decisionRules: {
    overfed: "delivered payload exceeds the generous break-even on >=70% of pairs AND its useful core would not have",
    selective: ">=30% of pairs displaced <= $0.005 of investigation, so no payload size makes them economic",
    caseD: "§55 — if the MINIMUM useful payload exceeds the displacement on >=70% of pairs, no dose makes proactive invocation economic; this gate runs first",
    nextLever: "§54 — otherwise the larger measured lever, discounted for whether M169-E found anything to route on",
    revisionNote: "The Case D gate was added after the generous denominator was falsified by whole-run investigation rising in the treatment arm. Recorded as a revision because it changed the recommendation from GLOBAL_EVIDENCE_DOSE_REDUCTION.",
  },
};

writeFileSync(path.join(RESULTS, "stage5_m169_economic_diagnosis.json"), `${JSON.stringify(document, null, 2)}\n`);
console.log("wrote stage5_m169_economic_diagnosis.json\n");
console.log(JSON.stringify(aggregate, null, 2));
console.log(`\nlevers: ${JSON.stringify(document.levers, null, 2)}`);
console.log(`\nVERDICTS`);
for (const [key, value] of Object.entries(document.verdicts)) console.log(`  ${key.padEnd(22)} ${value}`);
