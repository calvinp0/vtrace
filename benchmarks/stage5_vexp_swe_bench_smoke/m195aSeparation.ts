/**
 * M195A - separating validation-target selection from validation scaffolding.
 *
 * M195's §12 classifier folded two different relations into one class:
 *
 *   (bestRelation === "DIFFERENT_VALIDATION" || bestRelation === "NO_VALIDATION")
 *     && anyRelevant   ->  I6_VALIDATION_SELECTION_MISS
 *
 * Those relations answer different questions. `DIFFERENT_VALIDATION` says a test
 * runner started and its target set did not contain the candidate - the agent
 * aimed, and aimed elsewhere. `NO_VALIDATION` says no runner started at all -
 * the agent did not aim. Only the first is evidence about *selection*; the
 * second is evidence about *workflow*. M195's own §71 forbade merging them, and
 * its gate merged them anyway.
 *
 * This module is a pure downstream reclassifier. It derives nothing, ranks
 * nothing and re-scores nothing: every input it takes is a value the frozen
 * M195 mechanism already computed and committed. `m195Mechanism.ts` and
 * `m195Evaluation.ts` are untouched by M195A.
 *
 * Frozen by results/stage5_m195a_preregistration.md at 45c39d9a.
 */

import type { DecisionClass, FamilyScore, Relation } from "./m195Evaluation";
import { evaluateGates } from "./m195Evaluation";

export const M195A_SCHEMA_VERSION = "stage5.m195a.separation.v1";

// ── §4 the intervention taxonomy ────────────────────────────────────

export type SeparationClass =
  /** S6 - the family abstained; there is nothing to intervene on. */
  | "NO_DERIVABLE_VALIDATION_TARGET"
  /** S2 - the agent already selected the candidate or an equivalent. */
  | "VALIDATION_TARGET_ALREADY_SELECTED"
  /** S3 - the agent ran something broader, which may subsume the candidate. */
  | "VALIDATION_BROADER_SELECTION"
  /** S1 - a runner started and aimed elsewhere. The I6 selection hypothesis. */
  | "VALIDATION_TARGET_SELECTION_OPPORTUNITY"
  /** S4 - no runner started at all. A workflow question, not a selection one. */
  | "VALIDATION_SCAFFOLD_OPPORTUNITY"
  /** S5 - attempts existed but none is trustworthy enough to classify. */
  | "VALIDATION_EVIDENCE_UNUSABLE"
  /** S0 - candidates fired but none is confirmed relevant. */
  | "CANDIDATE_FIRED_NOT_CONFIRMED";

export const SEPARATION_IDS: Record<SeparationClass, string> = {
  NO_DERIVABLE_VALIDATION_TARGET: "S6",
  VALIDATION_TARGET_ALREADY_SELECTED: "S2",
  VALIDATION_BROADER_SELECTION: "S3",
  VALIDATION_TARGET_SELECTION_OPPORTUNITY: "S1",
  VALIDATION_SCAFFOLD_OPPORTUNITY: "S4",
  VALIDATION_EVIDENCE_UNUSABLE: "S5",
  CANDIDATE_FIRED_NOT_CONFIRMED: "S0",
};

export interface SeparationInputs {
  /** Delivered candidates, after the frozen bound of 3. */
  candidateCount: number;
  /** Best relation over delivered candidates, inside the frozen credit window. */
  bestRelation: Relation;
  /** At least one delivered candidate confirmed relevant by the frozen oracle. */
  anyRelevant: boolean;
  /** M195's own class for the row, used only to inherit S5 verbatim. */
  m195Class: DecisionClass;
}

/**
 * §4. Exactly one class per (decision point, family) row, evaluated in the
 * frozen order S6, S2, S3, S1, S4, S5, S0.
 *
 * The split between S1 and S4 needs no new evidence and no new heuristic.
 * `relateOne` returns BROADER/DIFFERENT only behind `obs.runnerStarted`, so
 * `NO_VALIDATION` is already a proof that no runner started in the window and
 * `DIFFERENT_VALIDATION` is already a proof that one did. M195 recorded the
 * distinction and then discarded it one line later.
 */
export function classifySeparation(i: SeparationInputs): SeparationClass {
  if (i.candidateCount === 0) return "NO_DERIVABLE_VALIDATION_TARGET";
  if (i.bestRelation === "EXACT_MATCH" || i.bestRelation === "EQUIVALENT") {
    return "VALIDATION_TARGET_ALREADY_SELECTED";
  }
  if (i.bestRelation === "BROADER_THAN_CANDIDATE") return "VALIDATION_BROADER_SELECTION";
  if (i.bestRelation === "DIFFERENT_VALIDATION" && i.anyRelevant) {
    return "VALIDATION_TARGET_SELECTION_OPPORTUNITY";
  }
  if (i.bestRelation === "NO_VALIDATION" && i.anyRelevant) return "VALIDATION_SCAFFOLD_OPPORTUNITY";
  if (i.m195Class === "VALIDATION_EVIDENCE_UNUSABLE") return "VALIDATION_EVIDENCE_UNUSABLE";
  return "CANDIDATE_FIRED_NOT_CONFIRMED";
}

/** S1 ∪ S4 is exactly M195's miss set, partitioned on runner intent alone. */
export function isM195Miss(c: SeparationClass): boolean {
  return c === "VALIDATION_TARGET_SELECTION_OPPORTUNITY" || c === "VALIDATION_SCAFFOLD_OPPORTUNITY";
}

// ── §5 the key quantity ─────────────────────────────────────────────

export interface GenuineMissInputs extends SeparationInputs {
  /** §5.3 - at least one attempt in the window carries usable provenance. */
  trustworthyInWindow: boolean;
  /**
   * §5.6 - false when the row's relation rests on a `bash_pre` with no
   * `bash_post`, i.e. the agent's selection is observed but the runner outcome
   * is not. Such a row cannot be scored as a selection miss either way.
   */
  runnerEvidenceObservable: boolean;
}

/**
 * §5. The class is relational; the predicate adds the two evidence clauses the
 * class deliberately does not encode. Clauses 1, 2, 4 and 5 are carried by
 * `classifySeparation` returning S1 - a best relation of DIFFERENT_VALIDATION
 * already implies no delivered candidate reached EXACT/EQUIVALENT/BROADER
 * inside the window, since the relation is the minimum over candidates.
 *
 * NO_VALIDATION rows can never reach this predicate. That is the point.
 */
export function isGenuineSelectionMiss(i: GenuineMissInputs): boolean {
  return (
    classifySeparation(i) === "VALIDATION_TARGET_SELECTION_OPPORTUNITY" &&
    i.trustworthyInWindow &&
    i.runnerEvidenceObservable
  );
}

export function isScaffoldOpportunity(i: SeparationInputs): boolean {
  return classifySeparation(i) === "VALIDATION_SCAFFOLD_OPPORTUNITY";
}

// ── §5 the credit-window flag ───────────────────────────────────────

/**
 * Never a class. The row keeps whatever the frozen forward-only window says it
 * is; this only records that a relevant candidate was in fact selected
 * elsewhere in the trajectory. M195A does not change the window.
 */
export function creditWindowEdgeCase(i: {
  separation: SeparationClass;
  selectedAnywhereInTrajectory: boolean;
}): boolean {
  return isM195Miss(i.separation) && i.selectedAnywhereInTrajectory;
}

// ── §12 the partition of M195's 14 union misses ─────────────────────

export type MissPartition =
  | "GENUINE_TARGET_SELECTION_MISS"
  | "SCAFFOLD_OPPORTUNITY"
  | "CREDIT_WINDOW_ONLY"
  | "RUNNER_CLASSIFICATION_EDGE_CASE"
  | "OTHER";

export interface PartitionInputs extends GenuineMissInputs {
  selectedAnywhereInTrajectory: boolean;
}

/**
 * §14 demands the 14 sum exactly, so the buckets are ordered and exhaustive.
 * A credit-window case is reported as its own bucket rather than as a scaffold
 * one, because the agent did eventually run the candidate and calling that
 * "performed no validation" would overstate the scaffold opportunity.
 */
export function partitionMiss(i: PartitionInputs): MissPartition {
  const c = classifySeparation(i);
  if (!isM195Miss(c)) return "OTHER";
  if (isGenuineSelectionMiss(i)) return "GENUINE_TARGET_SELECTION_MISS";
  if (!i.runnerEvidenceObservable) return "RUNNER_CLASSIFICATION_EDGE_CASE";
  if (i.selectedAnywhereInTrajectory) return "CREDIT_WINDOW_ONLY";
  if (c === "VALIDATION_SCAFFOLD_OPPORTUNITY") return "SCAFFOLD_OPPORTUNITY";
  return "OTHER";
}

// ── §6 witness typing ───────────────────────────────────────────────

export type WitnessType = "SELECTION_WITNESS" | "SCAFFOLD_WITNESS" | "NEITHER";

export interface WitnessInputs {
  /** The success-side row ran the candidate or an equivalent. */
  successSideSelectedCandidate: boolean;
  /** A failed analogue exists that started a runner and aimed elsewhere. */
  failedAnalogueChoseDifferentTarget: boolean;
  /** A failed analogue exists that started no runner at all. */
  failedAnaloguePerformedNoValidation: boolean;
}

/**
 * §6. A witness for *selection* has to instantiate a contrast about choice:
 * the failed side aimed somewhere else. Where the only available contrast is
 * "the failed side did not aim", the witness supports a scaffold hypothesis
 * and must not be counted toward a selection gate.
 */
export function classifyWitness(i: WitnessInputs): WitnessType {
  if (!i.successSideSelectedCandidate) return "NEITHER";
  if (i.failedAnalogueChoseDifferentTarget) return "SELECTION_WITNESS";
  if (i.failedAnaloguePerformedNoValidation) return "SCAFFOLD_WITNESS";
  return "NEITHER";
}

// ── §7 Axis A, the selection-specific replication gate ──────────────

export interface SelectionGateInputs {
  missTasks: number;
  missRepos: number;
  selectionWitnesses: number;
  selectionWitnessRepos: number;
}

export interface GateRow {
  id: string;
  requirement: string;
  observed: string;
  pass: boolean;
}

export function evaluateSelectionGate(i: SelectionGateInputs): GateRow[] {
  const g = (id: string, requirement: string, observed: string | number, pass: boolean): GateRow => ({
    id,
    requirement,
    observed: String(observed),
    pass,
  });
  return [
    g("A1", "genuine selection misses span >= 3 distinct tasks", i.missTasks, i.missTasks >= 3),
    g("A2", "genuine selection misses span >= 3 distinct repositories", i.missRepos, i.missRepos >= 3),
    g("A3", ">= 2 success-side SELECTION witnesses", i.selectionWitnesses, i.selectionWitnesses >= 2),
    g("A4", "those witnesses span >= 2 distinct repositories", i.selectionWitnessRepos,
      i.selectionWitnessRepos >= 2),
  ];
}

export type SelectionVerdict =
  | "VALIDATION_SELECTION_MECHANISM_REMAINS_WITNESSED"
  | "VALIDATION_SELECTION_MECHANISM_NOT_WITNESSED";

export function selectionVerdict(gates: GateRow[]): SelectionVerdict {
  return gates.every((g) => g.pass)
    ? "VALIDATION_SELECTION_MECHANISM_REMAINS_WITNESSED"
    : "VALIDATION_SELECTION_MECHANISM_NOT_WITNESSED";
}

// ── §8 Axis B, the scaffold observation ─────────────────────────────

export type ScaffoldVerdict =
  | "VALIDATION_SCAFFOLD_OPPORTUNITY_OBSERVED"
  | "VALIDATION_SCAFFOLD_OPPORTUNITY_NOT_OBSERVED";

export function scaffoldVerdict(i: { tasks: number; repos: number }): ScaffoldVerdict {
  return i.tasks >= 2 && i.repos >= 2
    ? "VALIDATION_SCAFFOLD_OPPORTUNITY_OBSERVED"
    : "VALIDATION_SCAFFOLD_OPPORTUNITY_NOT_OBSERVED";
}

// ── §9 selectivity ──────────────────────────────────────────────────

/** M195's own quantiler, restated so the two reports are commensurable. */
export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] as number;
}

export interface SelectivityStats {
  points: number;
  rawMedian: number;
  rawP90: number;
  rawMax: number;
  fractionOver3Pct: number;
  fractionOver5Pct: number;
  fractionOver10Pct: number;
  deliveredMedian: number;
  deliveredMax: number;
}

export function selectivityStats(raw: number[], delivered: number[]): SelectivityStats {
  const pct = (n: number): number => (raw.length === 0 ? 0 : Number(((n / raw.length) * 100).toFixed(1)));
  return {
    points: raw.length,
    rawMedian: quantile(raw, 0.5),
    rawP90: quantile(raw, 0.9),
    rawMax: raw.length ? Math.max(...raw) : 0,
    fractionOver3Pct: pct(raw.filter((x) => x > 3).length),
    fractionOver5Pct: pct(raw.filter((x) => x > 5).length),
    fractionOver10Pct: pct(raw.filter((x) => x > 10).length),
    deliveredMedian: quantile(delivered, 0.5),
    deliveredMax: delivered.length ? Math.max(...delivered) : 0,
  };
}

export type SelectivityVerdict = "PRE_TRUNCATION_DERIVATION_SELECTIVE" | "PRE_TRUNCATION_DERIVATION_BROAD";

/**
 * §9. Not a new bar - this is M195's own G2 requirement applied to the set G2
 * should have been reading. Descriptive only; it does not rescore M195.
 */
export function selectivityVerdict(s: SelectivityStats): SelectivityVerdict {
  return s.rawP90 <= 3 && s.fractionOver3Pct <= 10
    ? "PRE_TRUNCATION_DERIVATION_SELECTIVE"
    : "PRE_TRUNCATION_DERIVATION_BROAD";
}

// ── §10 the dead-gate control ───────────────────────────────────────

export interface DeadGateControl {
  rawCandidateCount: number;
  deliveredCandidateCount: number;
  g2Observed: string;
  g2Pass: boolean;
  verdict: "M195_G2_OUTPUT_BOUND_ONLY" | "M195_G2_MEASURES_SELECTIVITY";
}

const SYNTHETIC_SCORE: FamilyScore = {
  family: "I6-UNION",
  fingerprintDiffs: 0,
  medianCandidates: 0,
  p90Candidates: 0,
  maxCandidates: 0,
  emptyRatePct: 0,
  missTasks: 0,
  missRepos: 0,
  successWitnesses: 0,
  successWitnessRepos: 0,
  unnecessaryFireRatePctResolved: 0,
  redundantRecommendationRatePct: 0,
  largestTaskSharePct: 0,
  missPrecision: 0,
};

/**
 * §24. Replays M195's own `evaluateGates` on a decision point whose raw set is
 * far above the bound and whose delivered set is exactly the bound. G2 reads
 * the delivered counts, so it passes - which is the whole demonstration.
 */
export function deadGateControl(rawCount: number, deliveredCounts: number[]): DeadGateControl {
  const g2 = evaluateGates({
    ...SYNTHETIC_SCORE,
    medianCandidates: quantile(deliveredCounts, 0.5),
    p90Candidates: quantile(deliveredCounts, 0.9),
    maxCandidates: Math.max(...deliveredCounts),
  }).find((g) => g.id === "G2") as GateRow;
  return {
    rawCandidateCount: rawCount,
    deliveredCandidateCount: Math.max(...deliveredCounts),
    g2Observed: g2.observed,
    g2Pass: g2.pass,
    verdict: g2.pass ? "M195_G2_OUTPUT_BOUND_ONLY" : "M195_G2_MEASURES_SELECTIVITY",
  };
}

/**
 * The stronger statement: `cap()` clamps every delivered count into [0, 3], so
 * `median <= 3 && p90 <= 3` holds for every corpus the mechanism can produce.
 * G2 has no failing input in its own domain. Exhaustively checked in the tests.
 */
export function g2CanFail(deliveredCountDomain: number[]): boolean {
  const combos: number[][] = [];
  for (const a of deliveredCountDomain) {
    for (const b of deliveredCountDomain) {
      for (const c of deliveredCountDomain) combos.push([a, b, c]);
    }
  }
  return combos.some((counts) => {
    const g2 = evaluateGates({
      ...SYNTHETIC_SCORE,
      medianCandidates: quantile(counts, 0.5),
      p90Candidates: quantile(counts, 0.9),
      maxCandidates: Math.max(...counts),
    }).find((g) => g.id === "G2") as GateRow;
    return !g2.pass;
  });
}
