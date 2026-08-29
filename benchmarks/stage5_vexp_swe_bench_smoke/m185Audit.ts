/**
 * M185 audit core — cohort reconstruction and failure-stage classification.
 *
 * PURE. No I/O, no clock. M185 is an audit of M183, so every number it reports
 * has to be a deterministic function of M183's committed records; a reader who
 * disagrees with a verdict must be able to recompute the cohort that produced it.
 *
 * THREE THINGS THIS MODULE REFUSES TO DO.
 *
 *   It does not redefine "correct focus" (§59). A gold file is a file changed by
 *   the reference patch, and the focus is correct when the orientation's focus
 *   file is one of them — M183's definition, kept even where a different one
 *   would make a cohort cleaner. The gold-symbol-in-non-gold-file edge case is
 *   recorded as its own field rather than folded into the main predicate.
 *
 *   It does not let the outcome pick the failure stage. `classifyStage` takes an
 *   evidence record that never contains `resolved`, so a stage label cannot be
 *   derived from knowing the run failed (§36/§61). The ordering of the rules is
 *   the contract: the FIRST decisive divergence wins, so localization is tested
 *   before understanding and understanding before repair.
 *
 *   It does not accept a missing fact without a witness (§37). A candidate fact
 *   carries the file/symbol/test that evidences it, and `witnessQuality` degrades
 *   to `NONE` when that field is empty, which in turn caps counterfactual support
 *   at `NO_COUNTERFACTUAL_SUPPORT`. Post-hoc storytelling cannot score.
 */

// ── cohorts (§58) ───────────────────────────────────────────────────

export interface GoldRow {
  readonly instanceId: string;
  readonly repo: string;
  readonly goldFiles: readonly string[];
  readonly focusFile: string | null;
  readonly focusAt: string | null;
  readonly focusIsGoldFile: boolean;
  readonly goldFileInOrientation: boolean;
  readonly goldSymbolInOrientation: boolean;
  readonly treatmentEditedFocus: boolean;
  readonly treatmentEditedAnyGoldFile: boolean;
  readonly baselineEditedAnyGoldFile: boolean;
  readonly orientationFiles: readonly string[];
  readonly baselineResolved: boolean;
  readonly treatmentResolved: boolean;
}

export type Cohort =
  | "A_CORRECT_FOCUS_FAILURE"
  | "B_CORRECT_FOCUS_SUCCESS"
  | "C_WRONG_FOCUS_SUCCESS"
  | "D_VTRACE_ONLY_WIN"
  | "E_BASELINE_ONLY_WIN"
  | "F_BOTH_FAIL"
  | "G_WRONG_FOCUS_FAILURE";

/**
 * Focus cohorts (A/B/C/G) partition the 30 treatment arms; outcome cohorts
 * (D/E/F) partition the 30 pairs. A task therefore carries one of each, and the
 * two families deliberately overlap — cohort D is asked a different question
 * than cohort A, and collapsing them would lose the pairing.
 */
export const focusCohort = (r: GoldRow): Cohort =>
  r.focusIsGoldFile
    ? (r.treatmentResolved ? "B_CORRECT_FOCUS_SUCCESS" : "A_CORRECT_FOCUS_FAILURE")
    : (r.treatmentResolved ? "C_WRONG_FOCUS_SUCCESS" : "G_WRONG_FOCUS_FAILURE");

export const outcomeCohort = (r: GoldRow): Cohort | "BOTH_SOLVED" =>
  r.treatmentResolved && r.baselineResolved
    ? "BOTH_SOLVED"
    : r.treatmentResolved
      ? "D_VTRACE_ONLY_WIN"
      : r.baselineResolved
        ? "E_BASELINE_ONLY_WIN"
        : "F_BOTH_FAIL";

/**
 * §59's edge case: the focus names a symbol the reference patch introduces, but
 * in a file the reference patch does not touch. Recorded, never merged into
 * `focusIsGoldFile`.
 */
export const focusIsGoldSymbolInNonGoldFile = (r: GoldRow): boolean =>
  !r.focusIsGoldFile && r.goldSymbolInOrientation;

// ── failure-stage taxonomy (§11/§62) ────────────────────────────────

export type FailureStage =
  | "S0_LOCALIZATION"
  | "S1_BEHAVIORAL_UNDERSTANDING"
  | "S2_REPAIR_HYPOTHESIS"
  | "S3_CROSS_FILE_CONTRACT"
  | "S4_IMPLEMENTATION"
  | "S5_VALIDATION_SELECTION"
  | "S6_VALIDATION_INTERPRETATION"
  | "S7_CORRECTIVE_REVISION"
  | "S8_ENVIRONMENT"
  | "S9_STOCHASTIC_NOT_REPO_INFO";

/**
 * The evidence a case must carry before a stage can be assigned. Deliberately
 * does NOT include the outcome: see the module header.
 */
export interface StageEvidence {
  /** did the run meaningfully read the implementation the fix belongs in? */
  readonly contactedCorrectImplementation: boolean;
  /** an environment/tooling failure prevented the run from finishing its work */
  readonly environmentBlocked: boolean;
  /** the run's stated model of the buggy behaviour contradicts repository evidence it could see */
  readonly behaviouralAssumptionContradictedByRepo: boolean;
  /** the failure turns on a caller/consumer/test contract in another file */
  readonly missedCrossFileContract: boolean;
  /** behaviour understood, but the chosen repair mechanism cannot produce it */
  readonly repairMechanismWrong: boolean;
  /** repair concept right, code wrong (typo, wrong branch, wrong variable) */
  readonly implementationDefect: boolean;
  /** a decisive existing test was never run or discovered */
  readonly decisiveTestNotSelected: boolean;
  /** validation ran and its output was read wrongly */
  readonly validationOutputMisread: boolean;
  /** validation failed, the run had turns left, and it did not revise */
  readonly failedToReviseAfterSignal: boolean;
}

/**
 * First decisive divergence (§12). Order is the contract: the earliest stage
 * whose predicate holds wins, because a wrong behavioural model makes every
 * downstream repair decision unreliable and labelling such a run
 * "implementation" would hide the real cause.
 */
export const classifyStage = (e: StageEvidence): FailureStage => {
  if (e.environmentBlocked) return "S8_ENVIRONMENT";
  if (!e.contactedCorrectImplementation) return "S0_LOCALIZATION";
  if (e.behaviouralAssumptionContradictedByRepo) return "S1_BEHAVIORAL_UNDERSTANDING";
  if (e.missedCrossFileContract) return "S3_CROSS_FILE_CONTRACT";
  if (e.repairMechanismWrong) return "S2_REPAIR_HYPOTHESIS";
  if (e.implementationDefect) return "S4_IMPLEMENTATION";
  if (e.decisiveTestNotSelected) return "S5_VALIDATION_SELECTION";
  if (e.validationOutputMisread) return "S6_VALIDATION_INTERPRETATION";
  if (e.failedToReviseAfterSignal) return "S7_CORRECTIVE_REVISION";
  return "S9_STOCHASTIC_NOT_REPO_INFO";
};

// ── evidence acquisition (§14) ──────────────────────────────────────

export type EvidenceClass =
  | "EVIDENCE_NOT_ACQUIRED"
  | "EVIDENCE_ACQUIRED_BUT_MISUNDERSTOOD"
  | "EVIDENCE_ACQUIRED_AND_UNDERSTOOD_BUT_BAD_REPAIR"
  | "EVIDENCE_CORRECT_BUT_VALIDATION_INSUFFICIENT"
  | "RELEVANT_EVIDENCE_NOT_PRESENT_IN_REPOSITORY"
  | "ENVIRONMENTAL"
  | "NOT_DETERMINABLE";

/**
 * Only `EVIDENCE_NOT_ACQUIRED` is plausibly a VTRACE-addressable class, and
 * `EVIDENCE_ACQUIRED_BUT_MISUNDERSTOOD` only if a different presentation of the
 * same fact would have changed the reading. Everything else is out of reach of a
 * repository-intelligence product by construction (§14).
 */
export const evidenceClassIsVtraceAddressable = (c: EvidenceClass): "YES" | "PARTIAL" | "NO" =>
  c === "EVIDENCE_NOT_ACQUIRED"
    ? "YES"
    : c === "EVIDENCE_ACQUIRED_BUT_MISUNDERSTOOD"
      ? "PARTIAL"
      : "NO";

// ── addressability (§17) ────────────────────────────────────────────

export type Addressability =
  | "CURRENTLY_DERIVABLE"
  | "DERIVABLE_WITH_EXISTING_PRIMITIVE_COMPOSITION"
  | "NOT_CURRENTLY_DERIVABLE"
  | "REQUIRES_NEW_SEMANTIC_ANALYSIS"
  | "REQUIRES_MODEL_REASONING_NOT_INDEX_EVIDENCE"
  | "NOT_A_REPOSITORY_FACT";

/** §47 — three separate questions that are routinely conflated. */
export interface ExposureRow {
  readonly authorityAvailable: boolean;
  readonly onDemandToolExposes: boolean;
  readonly defaultProjectionExposes: boolean;
}

// ── counterfactual support (§19) ────────────────────────────────────

export type WitnessQuality = "NONE" | "COMPATIBLE_ONLY" | "OBSERVED_USE";
export type CounterfactualSupport =
  | "STRONG_COUNTERFACTUAL_SUPPORT"
  | "MODERATE_COUNTERFACTUAL_SUPPORT"
  | "WEAK_COUNTERFACTUAL_SUPPORT"
  | "NO_COUNTERFACTUAL_SUPPORT";

export interface CounterfactualInputs {
  /** the failed run demonstrably never acquired the fact */
  readonly failedRunLackedFact: boolean;
  /** a successful comparator's transcript shows it recovering AND using the fact */
  readonly witness: WitnessQuality;
  /** a concrete file/symbol/test evidences the fact, derived without gold */
  readonly repositoryWitnessNamed: boolean;
  /** current VTRACE authority can derive it */
  readonly addressability: Addressability;
  /** the fact precedes the divergent repair decision in the timeline */
  readonly precedesDivergence: boolean;
}

/**
 * §19's ladder. `STRONG` needs the full conjunction; anything without a named
 * repository witness collapses to NO regardless of how good the story is (§37).
 */
export const counterfactualSupport = (i: CounterfactualInputs): CounterfactualSupport => {
  if (!i.repositoryWitnessNamed) return "NO_COUNTERFACTUAL_SUPPORT";
  if (i.addressability === "NOT_A_REPOSITORY_FACT") return "NO_COUNTERFACTUAL_SUPPORT";
  const derivable =
    i.addressability === "CURRENTLY_DERIVABLE" ||
    i.addressability === "DERIVABLE_WITH_EXISTING_PRIMITIVE_COMPOSITION";
  if (i.failedRunLackedFact && i.witness === "OBSERVED_USE" && derivable && i.precedesDivergence) {
    return "STRONG_COUNTERFACTUAL_SUPPORT";
  }
  if (i.failedRunLackedFact && derivable && i.witness !== "NONE") {
    return "MODERATE_COUNTERFACTUAL_SUPPORT";
  }
  if (i.failedRunLackedFact || i.witness === "OBSERVED_USE") {
    return "WEAK_COUNTERFACTUAL_SUPPORT";
  }
  return "NO_COUNTERFACTUAL_SUPPORT";
};

// ── continuation gate (§83) ─────────────────────────────────────────

export interface ContinuationGates {
  readonly repeated: boolean;
  readonly downstreamOfCorrectLocalization: boolean;
  readonly repositoryDerived: boolean;
  readonly currentlyVtraceDerivable: boolean;
  readonly successWitnessed: boolean;
  readonly causallyPlausible: boolean;
  readonly narrowlyIntervenable: boolean;
}

export type ContinuationVerdict =
  | "NARROW_COUNTERFACTUAL_INTERVENTION_LICENSED"
  | "COUNTERFACTUAL_INTERVENTION_WEAKLY_SUPPORTED"
  | "NO_COUNTERFACTUAL_INTERVENTION_LICENSED";

/** All seven or downgrade (§83). One missing gate is not a rounding error. */
export const continuationVerdict = (g: ContinuationGates): ContinuationVerdict => {
  const gates = Object.values(g);
  const held = gates.filter(Boolean).length;
  if (held === gates.length) return "NARROW_COUNTERFACTUAL_INTERVENTION_LICENSED";
  if (g.repositoryDerived && g.successWitnessed && held >= gates.length - 1) {
    return "COUNTERFACTUAL_INTERVENTION_WEAKLY_SUPPORTED";
  }
  return "NO_COUNTERFACTUAL_INTERVENTION_LICENSED";
};

// ── breadth (§43/§44) ───────────────────────────────────────────────

export interface Breadth {
  readonly tasks: number;
  readonly repositories: number;
}

/**
 * §43 — two nearly identical tasks in one repository are weak. A mechanism is
 * "repeated" when it spans at least three tasks across at least two
 * repositories; anything less is an anecdote and is reported as one.
 */
export const isRepeatedMechanism = (b: Breadth): boolean =>
  b.tasks >= 3 && b.repositories >= 2;
