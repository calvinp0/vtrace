/**
 * M185 audit core — tests for the parts of the audit that must not be able to
 * drift toward a conclusion. The point of these is not coverage; it is that the
 * three refusals in the module header are enforced rather than intended.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyStage, continuationVerdict, counterfactualSupport, evidenceClassIsVtraceAddressable,
  focusCohort, focusIsGoldSymbolInNonGoldFile, isRepeatedMechanism, outcomeCohort,
  type GoldRow, type StageEvidence,
} from "./m185Audit";

const row = (over: Partial<GoldRow> = {}): GoldRow => ({
  instanceId: "x__x-1", repo: "x/x", goldFiles: ["a.py"], focusFile: "a.py", focusAt: "a.py::f",
  focusIsGoldFile: true, goldFileInOrientation: true, goldSymbolInOrientation: false,
  treatmentEditedFocus: true, treatmentEditedAnyGoldFile: true, baselineEditedAnyGoldFile: true,
  orientationFiles: ["a.py"], baselineResolved: true, treatmentResolved: true, ...over,
});

const evidence = (over: Partial<StageEvidence> = {}): StageEvidence => ({
  contactedCorrectImplementation: true, environmentBlocked: false,
  behaviouralAssumptionContradictedByRepo: false, missedCrossFileContract: false,
  repairMechanismWrong: false, implementationDefect: false,
  decisiveTestNotSelected: false, validationOutputMisread: false, failedToReviseAfterSignal: false, ...over,
});

describe("cohorts", () => {
  test("the focus family partitions the treatment arms four ways", () => {
    expect(focusCohort(row({ focusIsGoldFile: true, treatmentResolved: false }))).toBe("A_CORRECT_FOCUS_FAILURE");
    expect(focusCohort(row({ focusIsGoldFile: true, treatmentResolved: true }))).toBe("B_CORRECT_FOCUS_SUCCESS");
    expect(focusCohort(row({ focusIsGoldFile: false, treatmentResolved: true }))).toBe("C_WRONG_FOCUS_SUCCESS");
    expect(focusCohort(row({ focusIsGoldFile: false, treatmentResolved: false }))).toBe("G_WRONG_FOCUS_FAILURE");
  });

  test("the outcome family is independent of the focus family", () => {
    expect(outcomeCohort(row({ baselineResolved: false, treatmentResolved: true }))).toBe("D_VTRACE_ONLY_WIN");
    expect(outcomeCohort(row({ baselineResolved: true, treatmentResolved: false }))).toBe("E_BASELINE_ONLY_WIN");
    expect(outcomeCohort(row({ baselineResolved: false, treatmentResolved: false }))).toBe("F_BOTH_FAIL");
    expect(outcomeCohort(row())).toBe("BOTH_SOLVED");
  });

  test("a gold symbol in a non-gold file is recorded separately, never folded in (§59)", () => {
    const edge = row({ focusIsGoldFile: false, goldSymbolInOrientation: true });
    expect(focusIsGoldSymbolInNonGoldFile(edge)).toBe(true);
    expect(focusCohort(edge)).not.toBe("B_CORRECT_FOCUS_SUCCESS");
    expect(focusIsGoldSymbolInNonGoldFile(row({ focusIsGoldFile: true, goldSymbolInOrientation: true }))).toBe(false);
  });
});

describe("failure stage", () => {
  test("the outcome is not an input — the same evidence classifies the same way", () => {
    // StageEvidence has no `resolved` field at all; this is the structural guarantee.
    const e = evidence({ implementationDefect: true });
    expect(classifyStage(e)).toBe("S4_IMPLEMENTATION");
    expect(Object.keys(e)).not.toContain("resolved");
  });

  test("the first decisive divergence wins, in the declared order", () => {
    expect(classifyStage(evidence({ environmentBlocked: true, implementationDefect: true }))).toBe("S8_ENVIRONMENT");
    expect(classifyStage(evidence({ contactedCorrectImplementation: false, repairMechanismWrong: true }))).toBe("S0_LOCALIZATION");
    expect(classifyStage(evidence({ behaviouralAssumptionContradictedByRepo: true, missedCrossFileContract: true }))).toBe("S1_BEHAVIORAL_UNDERSTANDING");
  });

  test("a cross-file contract is never absorbed into the generic repair bucket", () => {
    expect(classifyStage(evidence({ missedCrossFileContract: true, repairMechanismWrong: true }))).toBe("S3_CROSS_FILE_CONTRACT");
  });

  test("no predicate holding is stochastic, not unmeasurable", () => {
    expect(classifyStage(evidence())).toBe("S9_STOCHASTIC_NOT_REPO_INFO");
  });

  test("validation stages are reachable and ordered", () => {
    expect(classifyStage(evidence({ decisiveTestNotSelected: true }))).toBe("S5_VALIDATION_SELECTION");
    expect(classifyStage(evidence({ validationOutputMisread: true }))).toBe("S6_VALIDATION_INTERPRETATION");
    expect(classifyStage(evidence({ failedToReviseAfterSignal: true }))).toBe("S7_CORRECTIVE_REVISION");
    expect(classifyStage(evidence({ decisiveTestNotSelected: true, validationOutputMisread: true }))).toBe("S5_VALIDATION_SELECTION");
  });
});

describe("evidence class addressability", () => {
  test("only an unacquired fact is fully addressable by a repository-intelligence product", () => {
    expect(evidenceClassIsVtraceAddressable("EVIDENCE_NOT_ACQUIRED")).toBe("YES");
    expect(evidenceClassIsVtraceAddressable("EVIDENCE_ACQUIRED_BUT_MISUNDERSTOOD")).toBe("PARTIAL");
    for (const c of ["EVIDENCE_ACQUIRED_AND_UNDERSTOOD_BUT_BAD_REPAIR", "EVIDENCE_CORRECT_BUT_VALIDATION_INSUFFICIENT",
      "RELEVANT_EVIDENCE_NOT_PRESENT_IN_REPOSITORY", "ENVIRONMENTAL", "NOT_DETERMINABLE"] as const) {
      expect(evidenceClassIsVtraceAddressable(c)).toBe("NO");
    }
  });
});

describe("counterfactual support", () => {
  const full = {
    failedRunLackedFact: true, witness: "OBSERVED_USE" as const, repositoryWitnessNamed: true,
    addressability: "CURRENTLY_DERIVABLE" as const, precedesDivergence: true,
  };

  test("the full conjunction is strong", () => {
    expect(counterfactualSupport(full)).toBe("STRONG_COUNTERFACTUAL_SUPPORT");
  });

  test("an unnamed repository witness collapses the score however good the story (§37)", () => {
    expect(counterfactualSupport({ ...full, repositoryWitnessNamed: false })).toBe("NO_COUNTERFACTUAL_SUPPORT");
  });

  test("a patch that merely happens to respect the invariant cannot reach strong (§18)", () => {
    expect(counterfactualSupport({ ...full, witness: "COMPATIBLE_ONLY" })).toBe("MODERATE_COUNTERFACTUAL_SUPPORT");
    expect(counterfactualSupport({ ...full, witness: "NONE" })).toBe("WEAK_COUNTERFACTUAL_SUPPORT");
  });

  test("a fact VTRACE cannot derive cannot reach strong or moderate", () => {
    expect(counterfactualSupport({ ...full, addressability: "REQUIRES_NEW_SEMANTIC_ANALYSIS" })).toBe("WEAK_COUNTERFACTUAL_SUPPORT");
    expect(counterfactualSupport({ ...full, addressability: "NOT_A_REPOSITORY_FACT" })).toBe("NO_COUNTERFACTUAL_SUPPORT");
  });

  test("a fact the failed run already had, with no witness, scores nothing", () => {
    expect(counterfactualSupport({ ...full, failedRunLackedFact: false, witness: "NONE" })).toBe("NO_COUNTERFACTUAL_SUPPORT");
  });
});

describe("continuation gate", () => {
  const all = {
    repeated: true, downstreamOfCorrectLocalization: true, repositoryDerived: true,
    currentlyVtraceDerivable: true, successWitnessed: true, causallyPlausible: true, narrowlyIntervenable: true,
  };

  test("all seven licenses, and only all seven", () => {
    expect(continuationVerdict(all)).toBe("NARROW_COUNTERFACTUAL_INTERVENTION_LICENSED");
    expect(continuationVerdict({ ...all, repeated: false })).toBe("COUNTERFACTUAL_INTERVENTION_WEAKLY_SUPPORTED");
  });

  test("a missing success witness is decisive on its own (§18/§83)", () => {
    expect(continuationVerdict({ ...all, successWitnessed: false })).toBe("NO_COUNTERFACTUAL_INTERVENTION_LICENSED");
  });

  test("M185's own observed gates do not license an intervention", () => {
    expect(continuationVerdict({
      repeated: false, downstreamOfCorrectLocalization: true, repositoryDerived: true,
      currentlyVtraceDerivable: true, successWitnessed: false, causallyPlausible: true, narrowlyIntervenable: true,
    })).toBe("NO_COUNTERFACTUAL_INTERVENTION_LICENSED");
  });
});

describe("breadth", () => {
  test("two near-identical tasks in one repository are not a repeated mechanism (§43)", () => {
    expect(isRepeatedMechanism({ tasks: 2, repositories: 1 })).toBe(false);
    expect(isRepeatedMechanism({ tasks: 2, repositories: 2 })).toBe(false);
    expect(isRepeatedMechanism({ tasks: 3, repositories: 1 })).toBe(false);
    expect(isRepeatedMechanism({ tasks: 3, repositories: 2 })).toBe(true);
  });
});
