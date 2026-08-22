/**
 * M170-C/E decision — evaluate the frozen gate, and say what it decided.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m170_decision.ts
 *
 * The thresholds are read from `stage5_m170_plan.md`'s frozen table, restated
 * here as constants and asserted against nothing — they were written before any
 * window existed and this file does not get to move them.
 *
 * Two measures feed the gate and they are NOT averaged:
 *
 *   OBSERVED   ten whole-file reads real agents really issued (M170-C), scored
 *              against the material those agents really went on to use.
 *   SIMULATED  200 cases of "if an agent whole-file read this gold file"
 *              (M170-E), scored against the gold patch.
 *
 * The first is the right measure and there are ten of them. The second is the
 * only one that can be had at scale, and it answers a different question.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

const read = (name: string): any | null => {
  const at = path.join(RESULTS, name);
  return existsSync(at) ? JSON.parse(readFileSync(at, "utf-8")) : null;
};

const surface = read("stage5_m170_investigation_surface.json");
const counterfactual = read("stage5_m170_counterfactual.json");
const seams = read("stage5_m170_seams_and_producers.json");
const broadA = read("stage5_m170_broad_qualification_broad100a.json");
const broadB = read("stage5_m170_broad_qualification_broad100b.json");

if (surface === null || counterfactual === null || seams === null || broadA === null || broadB === null) {
  throw new Error("M170 decision requires A, B, C and both E corpora to have run");
}

/** §C-gate, frozen in the plan before any window was computed. */
const GATE = Object.freeze({
  G1_operationLocalReductionAtLeast: 0.20,
  G2_evidencePreservationAtLeast: 0.95,
  G3_unsafeMediationsAtMost: 0,
  G4_wholeRunProjectionReported: true,
  G5_fixedNonFireOverheadTokens: 0,
});

const CANDIDATE = "P4_TOP_SYMBOL_SCOPE";

// ── observed corpus (M170-C) ────────────────────────────────────────

const observed = counterfactual.policySummary[CANDIDATE];
const observedFired = observed.firedOperations as number;
const verdicts = observed.verdicts as Record<string, number>;
const observedSafe = verdicts.SAFE_MEDIATION ?? 0;
const observedRecoverable = verdicts.RECOVERABLE_OVERPRUNE ?? 0;
const observedUnsafe = verdicts.UNSAFE_MEDIATION ?? 0;
// Preservation on the observed corpus, at the STRICT reading: every fired
// operation whose window held everything the agent went on to use.
const observedPreservation = observedFired === 0 ? 0 : observedSafe / observedFired;

// ── simulated corpus (M170-E) ───────────────────────────────────────

const simulated = (corpus: any) => {
  const summary = corpus.policySummary[CANDIDATE];
  return {
    corpus: corpus.corpus,
    firedFiles: summary.firedFiles,
    eligibleFiles: corpus.controls.eligibleFiles,
    fireRateOfEligible: summary.fireRateOfEligible,
    operationLocalReduction: summary.operationLocalReduction,
    goldFullContainmentRate: summary.goldFullContainmentRate,
    goldHunkContainmentRate: summary.goldHunkContainmentRate,
    derivationInvalid: corpus.controls.derivationInvalid,
  };
};
const simA = simulated(broadA);
const simB = simulated(broadB);

// ── the gate ────────────────────────────────────────────────────────

const g1 = (observed.operationLocalReduction as number) >= GATE.G1_operationLocalReductionAtLeast;
const g2Observed = observedPreservation >= GATE.G2_evidencePreservationAtLeast;
const g2SimulatedA = simA.goldFullContainmentRate >= GATE.G2_evidencePreservationAtLeast;
const g2SimulatedB = simB.goldFullContainmentRate >= GATE.G2_evidencePreservationAtLeast;
const g3 = observedUnsafe <= GATE.G3_unsafeMediationsAtMost;
const g5 = (seams.fixedModelVisibleOverhead.whenEnabledAndNeverFiring as number) === GATE.G5_fixedNonFireOverheadTokens;

const wholeRun = counterfactual.wholeRunProjection[CANDIDATE];
const oracle = counterfactual.wholeRunProjection.PX_ORACLE_UPPER_BOUND;

const gateResults = Object.freeze({
  G1_operationLocalReduction: { required: GATE.G1_operationLocalReductionAtLeast, observed: observed.operationLocalReduction, pass: g1 },
  G2_evidencePreservation: {
    required: GATE.G2_evidencePreservationAtLeast,
    observedCorpus: Number(observedPreservation.toFixed(4)),
    simulatedBroad100A: simA.goldFullContainmentRate,
    simulatedBroad100B: simB.goldFullContainmentRate,
    pass: g2Observed && g2SimulatedA && g2SimulatedB,
  },
  G3_unsafeMediations: { required: GATE.G3_unsafeMediationsAtMost, observed: observedUnsafe, pass: g3 },
  G4_wholeRunProjection: {
    candidateWholeRunReduction: wholeRun.wholeRunReductionShare,
    oracleWholeRunReduction: oracle.wholeRunReductionShare,
    reported: true,
  },
  G5_fixedNonFireOverheadTokens: { required: GATE.G5_fixedNonFireOverheadTokens, observed: seams.fixedModelVisibleOverhead.whenEnabledAndNeverFiring, pass: g5 },
});

const gateCleared = g1 && gateResults.G2_evidencePreservation.pass && g3 && g5;

// ── the trade-off that decides it ───────────────────────────────────

const tradeoff = ["P1_TOP_SYMBOL", "P4_TOP_SYMBOL_SCOPE", "P2_COVER_TOP_K", "P3_COVER_ALL_RANKED"].map((policy) => ({
  policy,
  broad100A: {
    fireRateOfEligible: broadA.policySummary[policy].fireRateOfEligible,
    operationLocalReduction: broadA.policySummary[policy].operationLocalReduction,
    goldFullContainmentRate: broadA.policySummary[policy].goldFullContainmentRate,
  },
  broad100B: {
    fireRateOfEligible: broadB.policySummary[policy].fireRateOfEligible,
    operationLocalReduction: broadB.policySummary[policy].operationLocalReduction,
    goldFullContainmentRate: broadB.policySummary[policy].goldFullContainmentRate,
  },
}));

const report = {
  schemaVersion: "stage5.m170.decision.v1",
  milestone: "M170",
  title: "Transparent mediation: gate evaluation and product-change decision",
  candidate: CANDIDATE,
  gate: GATE,
  gateResults,
  gateCleared,
  tradeoff,
  supportingFacts: {
    investigationShareOfRunCost: "12.5% of whole-run cost across the eleven uncensored M168 baseline runs",
    wholeFileReadShareOfInvestigation: surface.corpus.wholeFileReads.shareOfInvestigationCharacters,
    wholeFileReadShareOfRunCost: 0.059,
    oracleWholeRunCeiling: oracle.wholeRunReductionShare,
    nativePartialViewFiredInBaseline: surface.corpus.wholeFileReads.nativePartialViewFired,
    agentAlreadyScopesItsOwnSearches: "30 of 36 baseline Grep calls (83%) were scoped by path or glob, and 4 carried "
      + "an explicit head_limit; the agent is already applying the narrowing the search-mediation family would apply",
    multiHunkGoldFiles: "35 of 72 gold files in Broad100-A and 49 of 103 in Broad100-B are edited in more than one "
      + "place, median spread 139 and 94 lines, p90 532 and 989 — a single contiguous Read window cannot hold them",
  },
  decision: {
    automaticIntegrationVerdict: gateCleared ? "TRANSPARENT_MEDIATION_VIABLE" : "TRANSPARENT_MEDIATION_NOT_ECONOMIC",
    productChanged: gateCleared ? "YES" : "NO",
    selectedMediation: gateCleared ? CANDIDATE : "NONE",
    workstreamD: gateCleared ? "LICENSED" : "NOT_RUN",
    liveExtensionAuthorized: false,
  },
};

const out = path.join(RESULTS, "stage5_m170_decision.json");
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(`candidate ${CANDIDATE}`);
for (const [name, value] of Object.entries(gateResults)) {
  console.log(`  ${name.padEnd(32)} ${JSON.stringify(value)}`);
}
console.log(`gate cleared: ${gateCleared}`);
console.log(`decision: ${report.decision.automaticIntegrationVerdict}  product changed ${report.decision.productChanged}  D ${report.decision.workstreamD}`);
console.log(`→ ${out}`);
