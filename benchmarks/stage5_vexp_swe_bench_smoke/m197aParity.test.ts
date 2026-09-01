/**
 * M197A — falsification controls F1, F2 and F3 over the aggregate evaluator.
 *
 * The evaluator decides whether VTRACE cleared VEXP's frozen engineering bar.
 * These tests exist to prove it can still say NO: an evaluator that cannot fail
 * is not a measurement, and the whole milestone rests on this one function.
 */

import { describe, expect, test } from "bun:test";

import {
  A8_VETO_MINIMUM_COVERAGE_PERCENT,
  ClaimVerdict,
  ReproductionStatus,
  TRACK_A_CLAIM_COUNT,
  TRACK_A_MATCH_OR_EXCEED_THRESHOLD,
  comparisonIsPartiallyNonReproducible,
  evaluateTrackAParity,
  type ClaimRow,
  type CorpusCoverage,
} from "./m197aParity";

/** n claims that MATCH, followed by (15 - n) that are BELOW. */
function claims(matching: number, over: Partial<ClaimRow> = {}): ClaimRow[] {
  return Array.from({ length: TRACK_A_CLAIM_COUNT }, (_unused, i) => ({
    id: `A${i + 1}`,
    vexpClaim: `claim ${i + 1}`,
    reproduction: ReproductionStatus.Reproduced,
    verdict: i < matching ? ClaimVerdict.Matches : ClaimVerdict.Below,
    ...over,
  }));
}

const CLEAN_A8: CorpusCoverage[] = [
  { corpus: "C-SMALL", coveragePercent: 100 },
  { corpus: "C-MED", coveragePercent: 100 },
  { corpus: "C-LARGE", coveragePercent: 100 },
];

describe("F1 — the parity threshold can fail", () => {
  test("fewer than 10 of 15 matches does not meet the threshold", () => {
    const result = evaluateTrackAParity(claims(9), CLEAN_A8);

    expect(result.matchOrExceed).toBe(9);
    expect(result.thresholdMet).toBe(false);
    expect(result.verdict).toBe("VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_NOT_MET");
  });

  test("exactly 10 of 15 with a clean A8 meets it", () => {
    const result = evaluateTrackAParity(claims(TRACK_A_MATCH_OR_EXCEED_THRESHOLD), CLEAN_A8);

    expect(result.matchOrExceed).toBe(10);
    expect(result.thresholdMet).toBe(true);
    expect(result.verdict).toBe("VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_MET");
  });

  test("EXCEED counts toward the threshold alongside MATCH", () => {
    const rows = claims(9);
    rows[9] = { ...rows[9]!, verdict: ClaimVerdict.Exceeds };

    const result = evaluateTrackAParity(rows, CLEAN_A8);

    expect(result.match).toBe(9);
    expect(result.exceed).toBe(1);
    expect(result.thresholdMet).toBe(true);
  });
});

describe("F2 — A8 is a veto", () => {
  test("14 of 15 matches with A8 at 98.9% still fails", () => {
    const result = evaluateTrackAParity(claims(14), [
      { corpus: "C-SMALL", coveragePercent: 100 },
      { corpus: "C-MED", coveragePercent: 98.9 },
      { corpus: "C-LARGE", coveragePercent: 100 },
    ]);

    expect(result.matchOrExceed).toBe(14);
    expect(result.a8VetoSatisfied).toBe(false);
    expect(result.thresholdMet).toBe(false);
  });

  test("the veto reads coverage, not A8's own verdict row", () => {
    // A8 asserts it matched; one corpus says otherwise. Coverage governs.
    const rows = claims(14);
    rows[0] = { ...rows[0]!, id: "A8", verdict: ClaimVerdict.Exceeds };

    const result = evaluateTrackAParity(rows, [
      { corpus: "C-LARGE", coveragePercent: 98.9 },
    ]);

    expect(result.thresholdMet).toBe(false);
  });

  test("an unmeasured corpus cannot satisfy the veto", () => {
    const result = evaluateTrackAParity(claims(14), [
      { corpus: "C-LARGE", coveragePercent: null },
    ]);

    expect(result.a8MinimumCoveragePercent).toBeNull();
    expect(result.a8VetoSatisfied).toBe(false);
  });

  test("exactly the minimum coverage satisfies the veto", () => {
    const result = evaluateTrackAParity(claims(10), [
      { corpus: "C-LARGE", coveragePercent: A8_VETO_MINIMUM_COVERAGE_PERCENT },
    ]);

    expect(result.a8VetoSatisfied).toBe(true);
  });
});

describe("F3 — incomparable claims cannot count as matches", () => {
  test("a NOT_COMPARABLE row carrying MATCHES does not raise the count", () => {
    const rows = claims(9);
    rows[9] = {
      ...rows[9]!,
      reproduction: ReproductionStatus.NotComparable,
      verdict: ClaimVerdict.Matches,
    };

    const result = evaluateTrackAParity(rows, CLEAN_A8);

    expect(result.matchOrExceed).toBe(9);
    expect(result.notComparable).toBe(1);
    expect(result.thresholdMet).toBe(false);
  });

  test("the discarded win is reported rather than silently dropped", () => {
    const rows = claims(9);
    rows[9] = {
      ...rows[9]!,
      reproduction: ReproductionStatus.InsufficientlySpecified,
      verdict: ClaimVerdict.Exceeds,
    };

    const result = evaluateTrackAParity(rows, CLEAN_A8);

    expect(result.structuralViolations).toHaveLength(1);
    expect(result.structuralViolations[0]).toContain("A10");
    expect(result.insufficientMethod).toBe(1);
  });

  test("a comparable claim left unscored counts as unmeasured, never as a pass", () => {
    const rows = claims(10);
    rows[9] = { ...rows[9]!, verdict: null };

    const result = evaluateTrackAParity(rows, CLEAN_A8);

    expect(result.matchOrExceed).toBe(9);
    expect(result.insufficientMethod).toBe(1);
    expect(result.thresholdMet).toBe(false);
  });

  test("an interpreted reproduction still counts — interpretation describes the test", () => {
    const result = evaluateTrackAParity(
      claims(10, { reproduction: ReproductionStatus.ReproducedWithInterpretation }),
      CLEAN_A8,
    );

    expect(result.matchOrExceed).toBe(10);
    expect(result.thresholdMet).toBe(true);
  });
});

describe("CASE 3 — partial non-reproducibility is reported alongside the threshold", () => {
  test("more than a third unreproducible is flagged", () => {
    const rows = claims(0, { reproduction: ReproductionStatus.NotComparable, verdict: null });

    expect(comparisonIsPartiallyNonReproducible(evaluateTrackAParity(rows, CLEAN_A8))).toBe(true);
  });

  test("a fully reproduced set is not flagged, whatever the verdicts", () => {
    expect(comparisonIsPartiallyNonReproducible(evaluateTrackAParity(claims(0), CLEAN_A8)))
      .toBe(false);
  });
});
