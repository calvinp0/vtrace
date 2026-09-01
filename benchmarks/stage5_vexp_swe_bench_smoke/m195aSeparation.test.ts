/**
 * M195A - falsification controls and unit tests for the separation layer.
 *
 * F1..F5 are the §38 controls, written against the preregistered definitions
 * before any corpus verdict was read.
 */

import { describe, expect, test } from "bun:test";
import { M195_MAX_TARGETS } from "./m195Mechanism";
import {
  type SeparationInputs,
  classifySeparation,
  classifyWitness,
  creditWindowEdgeCase,
  deadGateControl,
  evaluateSelectionGate,
  g2CanFail,
  isGenuineSelectionMiss,
  isM195Miss,
  isScaffoldOpportunity,
  partitionMiss,
  quantile,
  scaffoldVerdict,
  selectionVerdict,
  selectivityStats,
  selectivityVerdict,
} from "./m195aSeparation";

const base: SeparationInputs = {
  candidateCount: 1,
  bestRelation: "NO_VALIDATION",
  anyRelevant: true,
  m195Class: "I6_VALIDATION_SELECTION_MISS",
};

// ── §38 falsification controls ──────────────────────────────────────

describe("F1 - a candidate exists and the agent does nothing", () => {
  const point = { ...base, bestRelation: "NO_VALIDATION" as const };

  test("classifies as a scaffold opportunity", () => {
    expect(classifySeparation(point)).toBe("VALIDATION_SCAFFOLD_OPPORTUNITY");
  });

  test("is never a genuine selection miss, however generous the evidence flags", () => {
    expect(
      isGenuineSelectionMiss({ ...point, trustworthyInWindow: true, runnerEvidenceObservable: true }),
    ).toBe(false);
  });

  test("is still one of M195's misses - the specimen does not disappear", () => {
    expect(isM195Miss(classifySeparation(point))).toBe(true);
    expect(isScaffoldOpportunity(point)).toBe(true);
  });
});

describe("F2 - the candidate is test_A and the agent starts a runner on test_B", () => {
  const point = { ...base, bestRelation: "DIFFERENT_VALIDATION" as const };

  test("classifies as a target-selection opportunity", () => {
    expect(classifySeparation(point)).toBe("VALIDATION_TARGET_SELECTION_OPPORTUNITY");
  });

  test("is a genuine selection miss when the runner evidence is trustworthy", () => {
    expect(
      isGenuineSelectionMiss({ ...point, trustworthyInWindow: true, runnerEvidenceObservable: true }),
    ).toBe(true);
  });

  test("is withheld when the evidence clauses fail", () => {
    expect(
      isGenuineSelectionMiss({ ...point, trustworthyInWindow: false, runnerEvidenceObservable: true }),
    ).toBe(false);
    expect(
      isGenuineSelectionMiss({ ...point, trustworthyInWindow: true, runnerEvidenceObservable: false }),
    ).toBe(false);
  });

  test("a different validation with no relevant candidate is not a miss at all", () => {
    expect(classifySeparation({ ...point, anyRelevant: false, m195Class: "CANDIDATE_FIRED_NOT_CONFIRMED" }))
      .toBe("CANDIDATE_FIRED_NOT_CONFIRMED");
  });
});

describe("F3 - the agent already selected the candidate", () => {
  test("an exact match is not a miss", () => {
    const p = { ...base, bestRelation: "EXACT_MATCH" as const };
    expect(classifySeparation(p)).toBe("VALIDATION_TARGET_ALREADY_SELECTED");
    expect(isM195Miss(classifySeparation(p))).toBe(false);
  });

  test("an equivalent target is not a miss", () => {
    const p = { ...base, bestRelation: "EQUIVALENT" as const };
    expect(classifySeparation(p)).toBe("VALIDATION_TARGET_ALREADY_SELECTED");
    expect(isGenuineSelectionMiss({ ...p, trustworthyInWindow: true, runnerEvidenceObservable: true }))
      .toBe(false);
  });
});

describe("F4 - a broader validation stays distinct from a wrong-target one", () => {
  const broader = { ...base, bestRelation: "BROADER_THAN_CANDIDATE" as const };

  test("classifies as its own class", () => {
    expect(classifySeparation(broader)).toBe("VALIDATION_BROADER_SELECTION");
  });

  test("is not counted as a selection miss - it may subsume the candidate", () => {
    expect(classifySeparation(broader)).not.toBe(classifySeparation({
      ...base,
      bestRelation: "DIFFERENT_VALIDATION",
    }));
    expect(isGenuineSelectionMiss({ ...broader, trustworthyInWindow: true, runnerEvidenceObservable: true }))
      .toBe(false);
  });
});

describe("F5 - M195's G2 cannot see a raw set of 10", () => {
  test("raw 10 truncated to 3 still passes the old gate", () => {
    const c = deadGateControl(10, [3, 3, 3]);
    expect(c.rawCandidateCount).toBe(10);
    expect(c.deliveredCandidateCount).toBe(M195_MAX_TARGETS);
    expect(c.g2Pass).toBe(true);
    expect(c.verdict).toBe("M195_G2_OUTPUT_BOUND_ONLY");
  });

  test("G2 has no failing input anywhere in the domain the cap permits", () => {
    expect(g2CanFail([0, 1, 2, 3])).toBe(false);
  });

  test("G2 would have failed had it been given the pre-truncation counts", () => {
    const c = deadGateControl(10, [10, 10, 10]);
    expect(c.g2Pass).toBe(false);
    expect(c.verdict).toBe("M195_G2_MEASURES_SELECTIVITY");
  });
});

// ── taxonomy completeness ───────────────────────────────────────────

describe("the taxonomy is total and mutually exclusive", () => {
  test("an abstaining family yields no obligation", () => {
    expect(classifySeparation({ ...base, candidateCount: 0 })).toBe("NO_DERIVABLE_VALIDATION_TARGET");
  });

  test("S6 wins over every relation, including a stale relation value", () => {
    for (const r of ["EXACT_MATCH", "EQUIVALENT", "BROADER_THAN_CANDIDATE", "DIFFERENT_VALIDATION",
      "NO_VALIDATION"] as const) {
      expect(classifySeparation({ ...base, candidateCount: 0, bestRelation: r }))
        .toBe("NO_DERIVABLE_VALIDATION_TARGET");
    }
  });

  test("unusable evidence is inherited verbatim from M195", () => {
    expect(classifySeparation({
      ...base,
      bestRelation: "NO_VALIDATION",
      anyRelevant: false,
      m195Class: "VALIDATION_EVIDENCE_UNUSABLE",
    })).toBe("VALIDATION_EVIDENCE_UNUSABLE");
  });

  test("every relation with a fired candidate lands in exactly one class", () => {
    const seen = new Set<string>();
    for (const r of ["EXACT_MATCH", "EQUIVALENT", "BROADER_THAN_CANDIDATE", "DIFFERENT_VALIDATION",
      "NO_VALIDATION"] as const) {
      for (const rel of [true, false]) {
        const c = classifySeparation({ ...base, bestRelation: r, anyRelevant: rel,
          m195Class: "CANDIDATE_FIRED_NOT_CONFIRMED" });
        expect(typeof c).toBe("string");
        seen.add(c);
      }
    }
    expect(seen.has("VALIDATION_TARGET_SELECTION_OPPORTUNITY")).toBe(true);
    expect(seen.has("VALIDATION_SCAFFOLD_OPPORTUNITY")).toBe(true);
  });

  test("S1 union S4 is exactly M195's miss condition", () => {
    for (const r of ["EXACT_MATCH", "EQUIVALENT", "BROADER_THAN_CANDIDATE", "DIFFERENT_VALIDATION",
      "NO_VALIDATION"] as const) {
      for (const anyRelevant of [true, false]) {
        const m195Miss =
          (r === "DIFFERENT_VALIDATION" || r === "NO_VALIDATION") && anyRelevant;
        expect(isM195Miss(classifySeparation({ ...base, bestRelation: r, anyRelevant })))
          .toBe(m195Miss);
      }
    }
  });
});

// ── the 14-miss partition ───────────────────────────────────────────

describe("the miss partition is exhaustive", () => {
  const p = (o: Partial<Parameters<typeof partitionMiss>[0]>) =>
    partitionMiss({ ...base, trustworthyInWindow: true, runnerEvidenceObservable: true,
      selectedAnywhereInTrajectory: false, ...o });

  test("a scaffold specimen lands in the scaffold bucket", () => {
    expect(p({})).toBe("SCAFFOLD_OPPORTUNITY");
  });

  test("a wrong-target specimen lands in the genuine bucket", () => {
    expect(p({ bestRelation: "DIFFERENT_VALIDATION" })).toBe("GENUINE_TARGET_SELECTION_MISS");
  });

  test("a specimen whose candidate ran outside the window is its own bucket", () => {
    expect(p({ selectedAnywhereInTrajectory: true })).toBe("CREDIT_WINDOW_ONLY");
  });

  test("an unobservable runner is an instrument edge case, not a selection miss", () => {
    expect(p({ bestRelation: "DIFFERENT_VALIDATION", runnerEvidenceObservable: false }))
      .toBe("RUNNER_CLASSIFICATION_EDGE_CASE");
  });

  test("a non-miss row is never partitioned into a miss bucket", () => {
    expect(p({ bestRelation: "EXACT_MATCH" })).toBe("OTHER");
    expect(p({ bestRelation: "BROADER_THAN_CANDIDATE" })).toBe("OTHER");
  });

  test("the credit-window flag is a flag, never a class", () => {
    expect(creditWindowEdgeCase({ separation: "VALIDATION_SCAFFOLD_OPPORTUNITY",
      selectedAnywhereInTrajectory: true })).toBe(true);
    expect(creditWindowEdgeCase({ separation: "VALIDATION_TARGET_ALREADY_SELECTED",
      selectedAnywhereInTrajectory: true })).toBe(false);
  });
});

// ── §6 witness typing ───────────────────────────────────────────────

describe("witness typing separates choice from workflow", () => {
  test("a contrasting choice on the failed side is a selection witness", () => {
    expect(classifyWitness({ successSideSelectedCandidate: true,
      failedAnalogueChoseDifferentTarget: true, failedAnaloguePerformedNoValidation: true }))
      .toBe("SELECTION_WITNESS");
  });

  test("a failed side that never validated is a scaffold witness only", () => {
    expect(classifyWitness({ successSideSelectedCandidate: true,
      failedAnalogueChoseDifferentTarget: false, failedAnaloguePerformedNoValidation: true }))
      .toBe("SCAFFOLD_WITNESS");
  });

  test("no failed analogue at all supports neither hypothesis", () => {
    expect(classifyWitness({ successSideSelectedCandidate: true,
      failedAnalogueChoseDifferentTarget: false, failedAnaloguePerformedNoValidation: false }))
      .toBe("NEITHER");
  });

  test("a success side that did not run the candidate is not a witness", () => {
    expect(classifyWitness({ successSideSelectedCandidate: false,
      failedAnalogueChoseDifferentTarget: true, failedAnaloguePerformedNoValidation: true }))
      .toBe("NEITHER");
  });
});

// ── §7/§8 the two verdict axes ──────────────────────────────────────

describe("the selection gate cannot be satisfied by scaffold evidence", () => {
  test("all four sub-gates must pass", () => {
    const g = evaluateSelectionGate({ missTasks: 3, missRepos: 3, selectionWitnesses: 2,
      selectionWitnessRepos: 2 });
    expect(g.every((x) => x.pass)).toBe(true);
    expect(selectionVerdict(g)).toBe("VALIDATION_SELECTION_MECHANISM_REMAINS_WITNESSED");
  });

  test("an empty genuine-miss set fails the gate", () => {
    const g = evaluateSelectionGate({ missTasks: 0, missRepos: 0, selectionWitnesses: 0,
      selectionWitnessRepos: 0 });
    expect(selectionVerdict(g)).toBe("VALIDATION_SELECTION_MECHANISM_NOT_WITNESSED");
    expect(g.filter((x) => !x.pass)).toHaveLength(4);
  });

  test("misses without matching-type witnesses still fail", () => {
    const g = evaluateSelectionGate({ missTasks: 9, missRepos: 9, selectionWitnesses: 1,
      selectionWitnessRepos: 1 });
    expect(selectionVerdict(g)).toBe("VALIDATION_SELECTION_MECHANISM_NOT_WITNESSED");
  });

  test("the scaffold axis is independent of the selection axis", () => {
    expect(scaffoldVerdict({ tasks: 13, repos: 8 })).toBe("VALIDATION_SCAFFOLD_OPPORTUNITY_OBSERVED");
    expect(scaffoldVerdict({ tasks: 1, repos: 1 })).toBe("VALIDATION_SCAFFOLD_OPPORTUNITY_NOT_OBSERVED");
    expect(scaffoldVerdict({ tasks: 5, repos: 1 })).toBe("VALIDATION_SCAFFOLD_OPPORTUNITY_NOT_OBSERVED");
  });
});

// ── §9 selectivity ──────────────────────────────────────────────────

describe("output boundedness and derivation selectivity are different measures", () => {
  test("a family that never exceeds the bound is selective", () => {
    const s = selectivityStats([1, 1, 2, 2, 3], [1, 1, 2, 2, 3]);
    expect(s.rawP90).toBeLessThanOrEqual(3);
    expect(s.fractionOver3Pct).toBe(0);
    expect(selectivityVerdict(s)).toBe("PRE_TRUNCATION_DERIVATION_SELECTIVE");
  });

  test("a family whose raw set runs wide is broad even though delivery is bounded", () => {
    const raw = [1, 2, 4, 8, 12, 15, 2, 1, 6, 9];
    const s = selectivityStats(raw, raw.map((x) => Math.min(x, 3)));
    expect(s.deliveredMax).toBe(3);
    expect(s.rawMax).toBe(15);
    expect(selectivityVerdict(s)).toBe("PRE_TRUNCATION_DERIVATION_BROAD");
  });

  test("the quantiler matches the one M195 scored with", () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    // M195 indexes s[floor(q * (n - 1))], so p90 of five points is the fourth,
    // not the fifth. Restated here so the two reports are commensurable.
    expect(quantile([1, 2, 3, 4, 5], 0.9)).toBe(4);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });

  test("a single wide point does not by itself flip a large family", () => {
    const raw = [...Array(99).fill(1), 15];
    const s = selectivityStats(raw, raw.map((x) => Math.min(x, 3)));
    expect(s.fractionOver3Pct).toBe(1);
    expect(selectivityVerdict(s)).toBe("PRE_TRUNCATION_DERIVATION_SELECTIVE");
  });
});
