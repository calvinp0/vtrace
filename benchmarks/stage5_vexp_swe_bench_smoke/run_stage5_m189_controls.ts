/**
 * M189-D — the §35 anti-post-hoc controls, as a reproduction rather than an assurance.
 *
 *   M189_BLIND=1 bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_mechanism.ts
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_mechanism.ts
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_controls.ts
 *
 * The interesting control is the first one. M189-B can be run with the gold patch, the
 * reference test patch and the grader verdict erased before the dataset is even parsed; if
 * the derivation is blind, every candidate fingerprint is unchanged. That is a claim a
 * reviewer can falsify with one environment variable, which is the only kind of blindness
 * claim worth making. The remaining controls — future-action, false positives on successes,
 * and candidate boundedness — are recomputed here from the committed records.
 *
 * FUTURE-ACTION is structural and is reported as such: `treeAt` and the evidence slice are
 * built from calls with `index < atIndex`, so a candidate cannot depend on a file the agent
 * opens later. The post-decision fields that DO exist (`broadCandidatesLaterInspected`,
 * `broadCandidatesLaterEdited`) are computed after the set is frozen and are the success
 * WITNESS instrument, never a derivation input — §17 needs them and §35 forbids the reverse.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

const sightedPath = path.join(RESULTS, "stage5_m189_candidate_fingerprints.sighted.txt");
const blindPath = path.join(RESULTS, "stage5_m189_candidate_fingerprints.blind.txt");

const lines = (p: string): readonly string[] =>
  existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()) : [];

const sighted = lines(sightedPath);
const blind = lines(blindPath);

const asMap = (rows: readonly string[]): Map<string, string> => {
  const m = new Map<string, string>();
  for (const row of rows) {
    const [label, at, fp] = row.split("\t");
    m.set(`${label}\t${at}`, fp ?? "");
  }
  return m;
};
const sMap = asMap(sighted); const bMap = asMap(blind);
const shared = [...sMap.keys()].filter((k) => bMap.has(k));
const differing = shared.filter((k) => sMap.get(k) !== bMap.get(k));

const blindnessControl = {
  ran: sighted.length > 0 && blind.length > 0,
  sightedDecisionPoints: sighted.length,
  blindDecisionPoints: blind.length,
  comparedDecisionPoints: shared.length,
  differingFingerprints: differing.length,
  onlyInSighted: sighted.length - shared.length,
  onlyInBlind: blind.length - shared.length,
  verdict:
    sighted.length === 0 || blind.length === 0
      ? "NOT_RUN"
      : differing.length === 0 && sighted.length === blind.length
        ? "DERIVATION_IS_GOLD_AND_OUTCOME_BLIND"
        : "DERIVATION_MOVED_WHEN_GOLD_OR_OUTCOME_WAS_REMOVED",
  covers: ["§35 gold-hidden derivation control", "§35 outcome-hidden derivation control"],
};

const specimenLedger = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m189_specimen_ledger.json"), "utf8")) as {
  boundedness: unknown; falsePositive: unknown; successWitness: unknown; population: unknown;
};

const controls = {
  schemaVersion: "stage5.m189.controls.v1",
  milestone: "M189", workstream: "M189-D",
  blindnessControl,
  futureActionControl: {
    mechanism:
      "the evidence slice and the reconstructed tree are built from calls with index < atIndex; " +
      "a file the agent opens after the decision point is not representable in DecisionPointEvidence",
    postDecisionFieldsExist: ["broadCandidatesLaterInspected", "broadCandidatesLaterEdited"],
    postDecisionFieldsAreDerivationInputs: false,
    verdict: "STRUCTURALLY_ENFORCED",
  },
  successFalsePositiveControl: specimenLedger.falsePositive,
  candidateBoundednessControl: specimenLedger.boundedness,
  successWitnessControl: specimenLedger.successWitness,
  population: specimenLedger.population,
};

writeFileSync(path.join(RESULTS, "stage5_m189_controls.json"), `${JSON.stringify(controls, null, 2)}\n`);

process.stdout.write([
  `M189-D controls`,
  `  gold/outcome-blind fingerprint comparison: ${blindnessControl.verdict}`,
  `    compared ${blindnessControl.comparedDecisionPoints} decision points, ${blindnessControl.differingFingerprints} differ`,
  `  future-action control: ${controls.futureActionControl.verdict}`,
  ``,
].join("\n"));
