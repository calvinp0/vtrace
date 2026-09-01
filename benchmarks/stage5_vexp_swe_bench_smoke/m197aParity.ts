/**
 * M197A — Track-A parity vocabulary and aggregate evaluator. PURE.
 *
 * The frozen M196 threshold (preregistration §5 / prompt §32) is
 *
 *   >= 10 of 15 claims MATCH-or-EXCEED   AND   A8 >= 99% on every measured corpus
 *
 * and nothing here may weaken it. Two properties are enforced STRUCTURALLY
 * rather than by convention, because a convention is only as good as the last
 * person who remembered it:
 *
 *   - a claim whose comparison was never reproduced cannot contribute a win
 *     (§10, F3). The evaluator ignores any verdict attached to such a row and
 *     records the attempt in `structuralViolations`, so an incomparable claim
 *     dressed up as a match is visible instead of merely uncounted;
 *   - the A8 veto is evaluated from the per-corpus coverage numbers, not from
 *     A8's own verdict, so an A8 row asserting MATCHES while a corpus sits at
 *     98% cannot carry the gate (F2).
 */

/** Whether a fair local comparison could be constructed AT ALL (§10). */
export const ReproductionStatus = Object.freeze({
  Reproduced: "VEXP_CLAIM_REPRODUCED",
  ReproducedWithInterpretation: "VEXP_CLAIM_REPRODUCED_WITH_INTERPRETATION",
  InsufficientlySpecified: "VEXP_CLAIM_INSUFFICIENTLY_SPECIFIED",
  NotComparable: "VEXP_CLAIM_NOT_COMPARABLE",
} as const);

export type ReproductionStatus = (typeof ReproductionStatus)[keyof typeof ReproductionStatus];

/** How VTRACE scored, where comparison is meaningful (§10). */
export const ClaimVerdict = Object.freeze({
  Below: "VTRACE_BELOW_VEXP_CLAIM",
  Matches: "VTRACE_MATCHES_VEXP_CLAIM",
  Exceeds: "VTRACE_EXCEEDS_VEXP_CLAIM",
} as const);

export type ClaimVerdict = (typeof ClaimVerdict)[keyof typeof ClaimVerdict];

/**
 * Reproduction states under which a verdict may be counted. An interpreted
 * reproduction still counts: the interpretation is declared per claim and is a
 * statement about the TEST, never about who won.
 */
const COMPARABLE = new Set<ReproductionStatus>([
  ReproductionStatus.Reproduced,
  ReproductionStatus.ReproducedWithInterpretation,
]);

export interface ClaimRow {
  readonly id: string;
  readonly vexpClaim: string;
  readonly reproduction: ReproductionStatus;
  /** Omitted or null wherever the comparison was not meaningful. */
  readonly verdict?: ClaimVerdict | null;
  /**
   * Set where hardware, corpus, tokenizer or cache state differ from anything
   * VEXP stated. Recorded and reported; it does not by itself void a verdict,
   * because §16 explicitly keeps the threshold while labelling the analogue.
   */
  readonly comparabilityCaveat?: string | null;
}

export interface CorpusCoverage {
  readonly corpus: string;
  /** Represented ÷ eligible, as a percentage. */
  readonly coveragePercent: number | null;
}

export const TRACK_A_MATCH_OR_EXCEED_THRESHOLD = 10;
export const TRACK_A_CLAIM_COUNT = 15;
export const A8_VETO_MINIMUM_COVERAGE_PERCENT = 99;

export interface ParityResult {
  readonly claimsScored: number;
  readonly matchOrExceed: number;
  readonly match: number;
  readonly exceed: number;
  readonly below: number;
  readonly notComparable: number;
  readonly insufficientMethod: number;
  readonly a8VetoSatisfied: boolean;
  readonly a8MinimumCoveragePercent: number | null;
  readonly thresholdMet: boolean;
  readonly verdict:
    | "VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_MET"
    | "VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_NOT_MET";
  /** Rows that attached a verdict to a comparison that was never reproduced. */
  readonly structuralViolations: readonly string[];
}

/**
 * Mechanically apply the frozen threshold. No argument weakens it: there is no
 * option to change the count, the A8 minimum, or which reproduction states may
 * contribute a win.
 */
export function evaluateTrackAParity(
  claims: readonly ClaimRow[],
  a8Coverage: readonly CorpusCoverage[],
): ParityResult {
  const structuralViolations: string[] = [];

  let match = 0;
  let exceed = 0;
  let below = 0;
  let notComparable = 0;
  let insufficientMethod = 0;

  for (const row of claims) {
    const comparable = COMPARABLE.has(row.reproduction);

    if (!comparable) {
      // F3: the verdict is DISCARDED, not merely uncounted. A row that claimed
      // a win it was not entitled to is reported rather than silently dropped.
      if (row.verdict === ClaimVerdict.Matches || row.verdict === ClaimVerdict.Exceeds) {
        structuralViolations.push(
          `${row.id}: ${row.verdict} attached to ${row.reproduction}; discarded`,
        );
      }
      if (row.reproduction === ReproductionStatus.NotComparable) notComparable += 1;
      else insufficientMethod += 1;
      continue;
    }

    switch (row.verdict) {
      case ClaimVerdict.Exceeds: exceed += 1; break;
      case ClaimVerdict.Matches: match += 1; break;
      case ClaimVerdict.Below: below += 1; break;
      default:
        // A comparable claim with no verdict is not a pass. It is counted as an
        // unmeasured method so the aggregate cannot be inflated by omission.
        insufficientMethod += 1;
        structuralViolations.push(`${row.id}: comparable but carries no verdict`);
    }
  }

  // The A8 veto reads COVERAGE, never A8's own verdict row (F2).
  const coverages = a8Coverage.map((c) => c.coveragePercent);
  const a8MinimumCoveragePercent = coverages.length === 0 || coverages.some((c) => c === null)
    ? null
    : Math.min(...(coverages as number[]));
  const a8VetoSatisfied = a8MinimumCoveragePercent !== null
    && a8MinimumCoveragePercent >= A8_VETO_MINIMUM_COVERAGE_PERCENT;

  const matchOrExceed = match + exceed;
  const thresholdMet = matchOrExceed >= TRACK_A_MATCH_OR_EXCEED_THRESHOLD && a8VetoSatisfied;

  return {
    claimsScored: claims.length,
    matchOrExceed,
    match,
    exceed,
    below,
    notComparable,
    insufficientMethod,
    a8VetoSatisfied,
    a8MinimumCoveragePercent,
    thresholdMet,
    verdict: thresholdMet
      ? "VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_MET"
      : "VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_NOT_MET",
    structuralViolations,
  };
}

/**
 * §34 CASE 3. Reported ALONGSIDE the threshold, never instead of it: a
 * comparison can be both largely non-reproducible and below the bar, and
 * collapsing the two would hide one of them.
 */
export function comparisonIsPartiallyNonReproducible(result: ParityResult): boolean {
  return result.notComparable + result.insufficientMethod > TRACK_A_CLAIM_COUNT / 3;
}
