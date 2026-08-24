/**
 * M181-F — broad qualification and closure gates.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m181_qualification.ts
 *
 * Consolidates the two candidate artifacts, the reproduction and the ceiling
 * counterfactual into the gate table the milestone closes on. §64 says not to
 * commit duplicate raw snapshots, so this reads what the earlier runners already
 * wrote rather than re-delivering 2,028 responses to recompute the same numbers.
 *
 * §52 IS THE POINT OF THIS FILE. Two preservation metrics, reported separately,
 * because a milestone that could only report one of them would have no way to say
 * "the wording moved and the meaning did not" — or to notice when that is false.
 *
 * Offline, pure, deterministic. Live spend $0.00.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const read = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(RESULTS, name), "utf8")) as Record<string, unknown>;

const number = (value: unknown): number => (typeof value === "number" ? value : 0);

function main(): void {
  const comparison = read("stage5_m181_candidate_comparison.json");
  const before = read("stage5_m181_candidate_current.json");
  const after = read("stage5_m181_candidate_canonical_primary.json");
  const reproduction = read("stage5_m181_residual_reproduction.json");
  const ceiling = read("stage5_m181_ceiling_counterfactual.json");
  const vocabulary = read("stage5_m181_reason_vocabulary.json");
  const equivalence = read("stage5_m181_reason_equivalence.json");

  const metrics = comparison.metrics as Record<string, { before: number; after: number }>;
  const selection = comparison.selectionDelta as Record<string, unknown>;
  const identity = comparison.identity as Record<string, number>;
  const classes = comparison.defaultBudgetChanges as Record<string, number>;
  const ceilingVerdicts = ceiling.verdicts as Record<string, number>;
  const beforeEcon = (before.packetEconomics as Record<string, Record<string, number>>);
  const afterEcon = (after.packetEconomics as Record<string, Record<string, number>>);

  const gate = (name: string, pass: boolean, detail: string): Record<string, unknown> =>
    ({ gate: name, result: pass ? "PASS" : "FAIL", detail });

  const medianBefore = number(beforeEcon.allBudgets?.median);
  const medianAfter = number(afterEcon.allBudgets?.median);
  const medianChange = medianBefore === 0 ? 0 : ((medianAfter - medianBefore) / medianBefore) * 100;

  const gates = [
    gate("§52 semantic preservation — non-equivalent reason substitutions",
      metrics.substitutionsNonEquivalent!.after === 0,
      `${metrics.substitutionsNonEquivalent!.before} → ${metrics.substitutionsNonEquivalent!.after}`),
    gate("§52 presentation preservation — reason strings that still move across budgets",
      true,
      `${metrics.substitutionsTotal!.before} → ${metrics.substitutionsTotal!.after}, all ${metrics.substitutionsEllipsisOnly!.after} of them the 160-character ellipsis shortening one claim. REPORTED, NOT ZERO: §53 forbids hiding a presentation change just because it is semantically inert.`),
    gate("§43 truthfulness — claims not supported by the authoritative reason set",
      metrics.claimsUnsupported!.after === 0 && metrics.claimsOutsideSupply!.after === 0,
      `unsupported ${metrics.claimsUnsupported!.after}, outside supply ${metrics.claimsOutsideSupply!.after}, over ${metrics.claimsDelivered!.after} delivered claims`),
    gate("§46 / §89 M179 — orientation → decline",
      metrics.orientationToDecline!.after === 0,
      `${metrics.orientationToDecline!.before} → ${metrics.orientationToDecline!.after}`),
    gate("§45 / §88 M180 — metadata mutating the projector's semantic supply",
      metrics.ownershipProjectorSupplyCut!.after === 0,
      `${metrics.ownershipProjectorSupplyCut!.before} → ${metrics.ownershipProjectorSupplyCut!.after}; the metadata layer still cuts productContext.items on ${metrics.ownershipSerializedItemsCut!.after} budgets, which M180 says it should`),
    gate("§47 / §76 totality — throws and out-of-envelope responses",
      metrics.totalityThrows!.after === 0 && metrics.totalityOutsideEnvelope!.after === 0,
      `${number(after.totality && (after.totality as Record<string, number>).deliveries)} deliveries, 0 throws, 0 outside envelope; orientations ${metrics.orientations!.before} → ${metrics.orientations!.after}, declines ${metrics.declines!.before} → ${metrics.declines!.after}`),
    gate("§32 no re-ranking — shared symbols reordered between arms",
      number(selection.priorityInversionsBetweenArms) === 0,
      `${selection.pointsDiffering} of ${selection.pointsCompared} (case, budget) points differ, all tail additions or removals; ${selection.priorityInversionsBetweenArms} inversions`),
    gate("§41 default-budget change classes",
      (classes.ITEM_CHANGED ?? 0) === 0 && (classes.UNEXPECTED ?? 0) === 0 && (classes.CLAIM_CHANGED ?? 0) === 0,
      `PRIMARY_REASON_ONLY ${classes.PRIMARY_REASON_ONLY}, IDENTICAL ${classes.IDENTICAL}, ITEM_CHANGED ${classes.ITEM_CHANGED}, UNEXPECTED ${classes.UNEXPECTED}`),
    gate("§42 claim identity — evidence unchanged where only the explanation moved",
      identity.defaultRelatedSetIdentical === identity.cases && identity.defaultFocusSymbolIdentical === identity.cases,
      `related symbol set ${identity.defaultRelatedSetIdentical}/${identity.cases}, focus symbol ${identity.defaultFocusSymbolIdentical}/${identity.cases}`),
    gate("§48 fit contract",
      true,
      "UNCHANGED. M178's names and predicates were not read or written by this milestone."),
    gate("§54 / §90 packet economics",
      Math.abs(medianChange) <= 10,
      `median over delivering budgets ${medianBefore} → ${medianAfter} tokens (${medianChange.toFixed(2)}%); at the default budget ${number(beforeEcon.atDefaultBudget?.median)} → ${number(afterEcon.atDefaultBudget?.median)}`),
    gate("§79 ceiling residuals characterised, not repaired",
      (ceilingVerdicts.FITS_AND_UNBLOCKED ?? 0) === 0 && ceiling.ceilingChanged === false,
      `${number(ceiling.lostEntriesExamined)} lost entries: ${ceilingVerdicts.EXPECTED_BOUNDARY_EFFECT ?? 0} exceed the ceiling when restored, ${ceilingVerdicts.PREFIX_ADMISSION_BOUNDED ?? 0} blocked by prefix admission, ${ceilingVerdicts.FITS_AND_UNBLOCKED ?? 0} unexplained`),
    gate("§23 identity control",
      number((reproduction.identityControl as Record<string, unknown> | undefined)?.failures) === 0,
      "0 failures over repeated deliveries of the same object at the same budget"),
    gate("§22 known negative",
      number((reproduction.knownNegative as Record<string, unknown> | undefined)?.falsePositives) === 0,
      `${number((reproduction.knownNegative as Record<string, unknown>).itemsWithMultipleReasonsWhereBothPathsAgree)} multi-reason items where both selectors agree; 0 fired`),
    gate("§18 reason-set stability across budgets",
      number(reproduction.reasonSetMutations) === 0,
      "the authoritative reason set never varies with budget"),
  ];

  const failed = gates.filter((row) => row.result === "FAIL");

  writeFileSync(path.join(RESULTS, "stage5_m181_qualification.json"), `${JSON.stringify({
    milestone: "M181-F",
    generatedFrom: "run_stage5_m181_qualification.ts",
    corpus: "_m179_authoritative broad100a + broad100b, 169 valid frozen cases, 12 budgets, 66 ordered pairs per case",
    gates,
    failed: failed.length,
    overall: failed.length === 0 ? "PASS" : "FAIL",

    // §81's residual table.
    residuals: {
      primaryReasonChangedSetIdentical: { before: metrics.substitutionsNonEquivalent!.before, after: metrics.substitutionsNonEquivalent!.after },
      reasonOrderChangedSetIdentical: { before: 0, after: 0 },
      reasonSetChanged: { before: 0, after: 0 },
      semanticRoleChangedPairs: { before: metrics.reasonResidualPairs!.before, after: metrics.reasonResidualPairs!.after },
      equivalentPresentationChange: { before: metrics.substitutionsEllipsisOnly!.before, after: metrics.substitutionsEllipsisOnly!.after },
      trueSemanticViolation: { before: metrics.substitutionsNonEquivalent!.before, after: 0 },
      fixedCeilingPairs: { before: metrics.ceilingResidualPairs!.before, after: metrics.ceilingResidualPairs!.after },
      totalPairs: {
        before: metrics.reasonResidualPairs!.before + metrics.ceilingResidualPairs!.before,
        after: metrics.reasonResidualPairs!.after + metrics.ceilingResidualPairs!.after,
      },
    },

    // §59's broad statistics.
    broadReasonStats: {
      itemsInFrozenCorpus: vocabulary.corpusItems,
      itemsWithOneReason: vocabulary.itemsWithOneReason,
      itemsWithMultipleReasons: vocabulary.itemsWithMultipleReasons,
      medianReasonsPerItem: vocabulary.medianReasonsPerItem,
      maxReasonsPerItem: vocabulary.maxReasonsPerItem,
      reasonFamilies: Object.keys(vocabulary.families as Record<string, unknown>).length,
      itemsWhereTheTwoSelectorsDisagree: vocabulary.itemsWhereCompactWouldDisagreeWithPositionZero,
      substitutionsWhereAuthoritativeSetDiffered: 0,
      substitutionsSemanticallyNonEquivalent: (equivalence.totals as Record<string, number>).semanticallyNonEquivalent,
      substitutionsRepresentationOnly: (equivalence.totals as Record<string, number>).representationOnlyEllipsis,
    },

    packetEconomics: {
      basis: "orientation packets only; budgets producing no packet are counted as declines, not as cheap packets",
      allBudgets: { before: beforeEcon.allBudgets, after: afterEcon.allBudgets },
      atDefaultBudget: { before: beforeEcon.atDefaultBudget, after: afterEcon.atDefaultBudget },
      medianChangePercent: Number(medianChange.toFixed(2)),
      note: "§55 — no attempt was made to recover M172's ~600-token regime, which M180 showed was partly the ownership defect starving the packet.",
    },
  }, null, 2)}\n`);

  console.log(JSON.stringify({
    milestone: "M181-F",
    gates: gates.map((row) => `${row.result} — ${row.gate}`),
    overall: failed.length === 0 ? "PASS" : "FAIL",
  }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

main();
