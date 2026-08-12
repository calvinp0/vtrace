// M141 Workstream E — the preservation-assertion contract.
//
// The M132 row that reported FAIL for `34 -> 34 queries for 40 dependents` is
// the worked example: a historical-improvement claim re-run against a baseline
// that already contained the improvement. These tests pin the general rule and
// the specific interpretation, and prove genuine pre-change reductions stay
// strict gates.

import { describe, expect, test } from "bun:test";

import {
  baselineContainsCommit,
  evaluatePreservationCheck,
  type BaselineProvenance,
} from "./preservationRelations";
import { REPO_ROOT } from "./runnerPaths";

const PRE_CHANGE: BaselineProvenance = {
  implementation: "predecessor",
  containsChangeUnderTest: false,
  evidence: "baseline predates the change",
};
const POST_CHANGE: BaselineProvenance = {
  implementation: "successor",
  containsChangeUnderTest: true,
  evidence: "baseline already contains the change",
};
const UNKNOWN: BaselineProvenance = {
  implementation: null,
  containsChangeUnderTest: null,
  evidence: "no baseline commit recorded",
};

describe("M141 preservation assertion provenance", () => {
  test("a genuine pre-change baseline keeps the strict historical reduction", () => {
    const verdict = evaluatePreservationCheck({
      check: "impact_hydration_batched",
      kind: "historical_improvement",
      declaredRelation: "less_than",
      baseline: PRE_CHANGE,
      baselineValue: 74,
      observed: 34,
    });

    expect(verdict.effectiveRelation).toBe("less_than");
    expect(verdict.relationAdjusted).toBe(false);
    expect(verdict.pass).toBe(true);
  });

  test("a strict reduction that did not happen still fails against a pre-change baseline", () => {
    const verdict = evaluatePreservationCheck({
      check: "impact_hydration_batched",
      kind: "historical_improvement",
      declaredRelation: "less_than",
      baseline: PRE_CHANGE,
      baselineValue: 34,
      observed: 34,
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.effectiveRelation).toBe("less_than");
  });

  test("34 -> 34 against a post-change baseline is preserved, not a regression", () => {
    const verdict = evaluatePreservationCheck({
      check: "impact_hydration_batched",
      kind: "historical_improvement",
      declaredRelation: "less_than",
      baseline: POST_CHANGE,
      baselineValue: 34,
      observed: 34,
      context: "40 dependents",
    });

    expect(verdict.pass).toBe(true);
    expect(verdict.relationAdjusted).toBe(true);
    expect(verdict.effectiveRelation).toBe("less_or_equal");
    expect(verdict.reason).toContain("baseline already contains the change under test");
    expect(verdict.evidence).toContain("40 dependents");
  });

  test("a real regression still fails against a post-change baseline", () => {
    const verdict = evaluatePreservationCheck({
      check: "impact_hydration_batched",
      kind: "historical_improvement",
      declaredRelation: "less_than",
      baseline: POST_CHANGE,
      baselineValue: 34,
      observed: 74,
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.effectiveRelation).toBe("less_or_equal");
  });

  test("unknown baseline provenance does not silently grant the relaxation", () => {
    const verdict = evaluatePreservationCheck({
      check: "impact_hydration_batched",
      kind: "historical_improvement",
      declaredRelation: "less_than",
      baseline: UNKNOWN,
      baselineValue: 34,
      observed: 34,
    });

    expect(verdict.relationAdjusted).toBe(false);
    expect(verdict.pass).toBe(false);
  });

  test("non-improvement assertion kinds are never relaxed by provenance", () => {
    for (const kind of ["equivalence", "non_regression", "boundedness", "absolute_correctness"] as const) {
      const verdict = evaluatePreservationCheck({
        check: kind,
        kind,
        declaredRelation: "equal",
        baseline: POST_CHANGE,
        baselineValue: 34,
        observed: 35,
      });
      expect(verdict.relationAdjusted).toBe(false);
      expect(verdict.pass).toBe(false);
    }
  });

  test("ancestry against the real repository decides the M132 baseline's provenance", () => {
    // 9260d37 introduced the batched hydration; c267816 is a later M140 commit,
    // which is exactly the baseline M140-C compared against.
    const post = baselineContainsCommit({
      repoRoot: REPO_ROOT,
      baselineCommit: "c267816999ce73664ccceba5bcc71892681c05dc",
      changeCommit: "9260d378f2aa96ce56d3f10c7cd120ae132d3836",
      changeDescription: "batched impact dependent hydration",
    });
    expect(post.containsChangeUnderTest).toBe(true);

    // An ancestor of the batching commit does not contain it.
    const pre = baselineContainsCommit({
      repoRoot: REPO_ROOT,
      baselineCommit: "9260d378f2aa96ce56d3f10c7cd120ae132d3836~1",
      changeCommit: "9260d378f2aa96ce56d3f10c7cd120ae132d3836",
      changeDescription: "batched impact dependent hydration",
    });
    expect(pre.containsChangeUnderTest).toBe(false);
  });

  test("an unresolvable baseline commit reports unknown, not false", () => {
    const provenance = baselineContainsCommit({
      repoRoot: REPO_ROOT,
      baselineCommit: "0000000000000000000000000000000000000000",
      changeCommit: "9260d378f2aa96ce56d3f10c7cd120ae132d3836",
      changeDescription: "batched impact dependent hydration",
    });

    expect(provenance.containsChangeUnderTest).toBeNull();
    expect(provenance.evidence).toContain("could not resolve ancestry");
  });

  test("a missing baseline commit is unknown provenance", () => {
    expect(baselineContainsCommit({
      repoRoot: REPO_ROOT,
      baselineCommit: null,
      changeCommit: "9260d378f2aa96ce56d3f10c7cd120ae132d3836",
      changeDescription: "batched impact dependent hydration",
    }).containsChangeUnderTest).toBeNull();
  });
});
