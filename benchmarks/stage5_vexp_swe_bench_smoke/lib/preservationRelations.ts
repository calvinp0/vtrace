// M141 Workstream E — provenance-aware preservation assertions.
//
// M140-C recorded M132 as 20/21 because one row demanded a strict query
// reduction against a baseline that ALREADY contained the optimization being
// preserved. `34 -> 34 queries for 40 dependents` is the correct unchanged
// result; the row was unsatisfiable by construction.
//
// The defect is not the number 34. It is that a preservation check did not know
// what kind of claim it was making, or whether its baseline predates the change
// it asserts. A historical-improvement claim is only meaningful against a
// pre-optimization baseline; against a successor the same measurement is a
// non-regression claim, and must be evaluated as one.

import { execFileSync } from "node:child_process";

/** What a preservation check is actually asserting. These are not the same contract. */
export type PreservationAssertionKind =
  /** The value must equal a known-correct constant, baseline or not. */
  | "absolute_correctness"
  /** A change improved a measurement relative to the implementation before it. */
  | "historical_improvement"
  /** The measurement must not get worse than the baseline. */
  | "non_regression"
  /** The measurement must match the baseline exactly. */
  | "equivalence"
  /** The measurement must stay under a declared bound. */
  | "boundedness"
  /** A capability must be present; the number is incidental. */
  | "capability_presence";

export type PreservationRelation =
  | "equal"
  | "less_than"
  | "less_or_equal"
  | "greater_than"
  | "greater_or_equal"
  | "preserved";

export interface BaselineProvenance {
  /** Label or commit of the implementation that produced the baseline. */
  readonly implementation: string | null;
  /**
   * Whether the baseline already contains the change under test. `null` means
   * unknown, which fails closed: an improvement cannot be claimed against a
   * baseline whose provenance cannot be established.
   */
  readonly containsChangeUnderTest: boolean | null;
  /** How `containsChangeUnderTest` was established. */
  readonly evidence: string;
}

export interface PreservationCheckInput {
  readonly check: string;
  readonly kind: PreservationAssertionKind;
  /** The relation the check was originally written for. */
  readonly declaredRelation: PreservationRelation;
  readonly baseline: BaselineProvenance;
  readonly baselineValue: number | null;
  readonly observed: number | null;
  /** Extra context for the evidence line (dependent counts, set sizes, …). */
  readonly context?: string;
}

export interface PreservationCheckResult {
  readonly check: string;
  readonly kind: PreservationAssertionKind;
  readonly declaredRelation: PreservationRelation;
  /** The relation actually applied, after reading the baseline's provenance. */
  readonly effectiveRelation: PreservationRelation;
  readonly relationAdjusted: boolean;
  readonly baselineImplementation: string | null;
  readonly baselineContainsChangeUnderTest: boolean | null;
  readonly baselineValue: number | null;
  readonly observed: number | null;
  readonly pass: boolean;
  readonly reason: string;
  readonly evidence: string;
}

/**
 * Evaluate one preservation check against its baseline's provenance.
 *
 * The single substantive rule: a `historical_improvement` claim whose baseline
 * already contains the change degrades to `less_or_equal` — "no regression /
 * expected equivalence" — because the improvement it names already happened on
 * both sides of the comparison. A genuine pre-change baseline keeps the strict
 * relation, so real historical reductions stay real gates.
 */
export function evaluatePreservationCheck(input: PreservationCheckInput): PreservationCheckResult {
  const { effectiveRelation, relationAdjusted, adjustmentReason } = resolveRelation(input);
  const pass = satisfies(effectiveRelation, input.observed, input.baselineValue);

  return {
    check: input.check,
    kind: input.kind,
    declaredRelation: input.declaredRelation,
    effectiveRelation,
    relationAdjusted,
    baselineImplementation: input.baseline.implementation,
    baselineContainsChangeUnderTest: input.baseline.containsChangeUnderTest,
    baselineValue: input.baselineValue,
    observed: input.observed,
    pass,
    reason: pass
      ? (relationAdjusted ? adjustmentReason : `${describe(effectiveRelation)} satisfied`)
      : `${describe(effectiveRelation)} violated`,
    evidence: [
      `${input.baselineValue ?? "n/a"} -> ${input.observed ?? "n/a"}`,
      input.context,
      `relation=${effectiveRelation}`,
      `baseline=${input.baseline.implementation ?? "unknown"}`,
      `baselineContainsChange=${String(input.baseline.containsChangeUnderTest)}`,
    ].filter(Boolean).join("; "),
  };
}

function resolveRelation(input: PreservationCheckInput): {
  effectiveRelation: PreservationRelation;
  relationAdjusted: boolean;
  adjustmentReason: string;
} {
  if (input.kind !== "historical_improvement") {
    return { effectiveRelation: input.declaredRelation, relationAdjusted: false, adjustmentReason: "" };
  }
  if (input.baseline.containsChangeUnderTest === true) {
    return {
      effectiveRelation: relaxStrict(input.declaredRelation),
      relationAdjusted: true,
      adjustmentReason:
        "baseline already contains the change under test, so the historical improvement is not re-demandable; "
        + "evaluated as non-regression (preserved)",
    };
  }
  if (input.baseline.containsChangeUnderTest === null) {
    return {
      effectiveRelation: input.declaredRelation,
      relationAdjusted: false,
      adjustmentReason: "",
    };
  }
  return { effectiveRelation: input.declaredRelation, relationAdjusted: false, adjustmentReason: "" };
}

function relaxStrict(relation: PreservationRelation): PreservationRelation {
  switch (relation) {
    case "less_than":
      return "less_or_equal";
    case "greater_than":
      return "greater_or_equal";
    default:
      return relation;
  }
}

function satisfies(
  relation: PreservationRelation,
  observed: number | null,
  baselineValue: number | null,
): boolean {
  if (observed === null) return false;
  if (relation === "preserved") return baselineValue === null || observed === baselineValue;
  if (baselineValue === null) return false;
  switch (relation) {
    case "equal":
      return observed === baselineValue;
    case "less_than":
      return observed < baselineValue;
    case "less_or_equal":
      return observed <= baselineValue;
    case "greater_than":
      return observed > baselineValue;
    case "greater_or_equal":
      return observed >= baselineValue;
  }
}

function describe(relation: PreservationRelation): string {
  return `relation ${relation}`;
}

/**
 * Decide whether a baseline commit already contains a named change, by asking
 * git for ancestry. This is what makes the rule provenance-driven rather than
 * inferred from an artifact filename.
 *
 * Returns `null` when ancestry cannot be established (unknown commit, shallow
 * clone, no repository) — the caller must then treat the improvement claim as
 * unverifiable rather than assume either answer.
 */
export function baselineContainsCommit(input: {
  readonly repoRoot: string;
  readonly baselineCommit: string | null | undefined;
  readonly changeCommit: string;
  readonly changeDescription: string;
}): BaselineProvenance {
  const baselineCommit = input.baselineCommit ?? null;
  if (baselineCommit === null || baselineCommit.trim().length === 0) {
    return {
      implementation: null,
      containsChangeUnderTest: null,
      evidence: "baseline recorded no implementation commit",
    };
  }
  try {
    execFileSync(
      "git",
      ["-C", input.repoRoot, "merge-base", "--is-ancestor", input.changeCommit, baselineCommit],
      { stdio: "ignore" },
    );
    return {
      implementation: baselineCommit,
      containsChangeUnderTest: true,
      evidence: `${input.changeCommit} (${input.changeDescription}) is an ancestor of the baseline commit`,
    };
  } catch (error) {
    // Exit status 1 is a definite "not an ancestor"; anything else means the
    // ancestry question could not be answered at all.
    const status = (error as { status?: number }).status;
    if (status === 1) {
      return {
        implementation: baselineCommit,
        containsChangeUnderTest: false,
        evidence: `${input.changeCommit} (${input.changeDescription}) is not an ancestor of the baseline commit`,
      };
    }
    return {
      implementation: baselineCommit,
      containsChangeUnderTest: null,
      evidence: `git could not resolve ancestry for ${input.changeCommit} against the baseline commit`,
    };
  }
}
