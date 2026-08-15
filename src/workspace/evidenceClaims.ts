/**
 * M149: what a set of evidence observations entitles a consumer to SAY.
 *
 * M146-M148 made the routing and access layers tell the truth about what they
 * know. Every one of those milestones fixed the same shape of bug in a new lane:
 * a bounded or filtered observation reached a consumer, and the consumer stated
 * it as a global fact. `maxDeepProbes` (M146), the refused-member pool (M147) and
 * the 8-probe indexed-path prefix (M148) were all cost bounds that silently
 * became correctness bounds.
 *
 * This module exists so the next lane cannot repeat it. The rule it encodes:
 *
 *   EVIDENCE MAY BE COMBINED, BUT UNCERTAINTY MAY NOT DISAPPEAR IN THE COMBINING.
 *
 * Concretely, a consumer may compose evidence and it may narrow a claim, but it
 * may never widen the claim's SCOPE or strengthen its AUTHORITY beyond what the
 * observations support. The two are separate axes and both are enforced here:
 *
 *   scope      which members a claim is about
 *   strength   how firmly the observations settle it
 *
 * WHY NEGATIVES NEED THEIR OWN MODEL. Positive evidence is self-supporting — one
 * member answering "I index this path" settles that a member indexes it, and no
 * unasked member can retract it. A negative is a claim about everyone who did
 * NOT answer, so it is only as strong as the coverage behind it. That asymmetry
 * is why `present.length > 1` settles ambiguity immediately in
 * `proveExactUniqueness` while every other verdict waits on the unknowns, and it
 * is the same asymmetry this module generalises past the uniqueness question.
 *
 * COMPLETENESS IS PER CAPABILITY, NEVER GLOBAL. "We checked everything" means
 * something different for an exact keyed lookup than for a ranked retrieval that
 * returns a capped pool. A single `complete: true` spanning both would be the
 * defect this module prevents, so coverage always names the capability it is
 * complete FOR.
 */

/** The population a claim is about. Ordered weakest to widest. */
export const EvidenceScope = Object.freeze({
  /** One member's own index. The only scope a single probe can settle. */
  MemberLocal: "member_local",
  /** Exactly the members that actually answered. Never the whole workspace. */
  ScannedMembers: "scanned_members",
  /** Every enabled member of the workspace. */
  EnabledMembers: "enabled_members",
  /** Every registered member, enabled or not. */
  Workspace: "workspace",
});

export type EvidenceScope = (typeof EvidenceScope)[keyof typeof EvidenceScope];

const SCOPE_ORDER: readonly EvidenceScope[] = [
  EvidenceScope.MemberLocal,
  EvidenceScope.ScannedMembers,
  EvidenceScope.EnabledMembers,
  EvidenceScope.Workspace,
];

/** True when `claimed` is no wider than `proven`. The §32 scope invariant. */
export function scopeWithin(claimed: EvidenceScope, proven: EvidenceScope): boolean {
  return SCOPE_ORDER.indexOf(claimed) <= SCOPE_ORDER.indexOf(proven);
}

/**
 * Which evidence source answered. The distinction that matters here is not
 * speed but whether a MISS from this source is authoritative for one member.
 */
export const EvidenceCapability = Object.freeze({
  /** M148-B: `files` carries a UNIQUE covering index on `path`. Exact. */
  PathMembership: "path_membership",
  /** M147: `symbols.local_name` / `fq_name` equality. Exact. */
  SymbolExactLookup: "symbol_exact_lookup",
  /** Ranked, capped, fuzzy. A miss proves nothing at all. */
  RankedRetrieval: "ranked_retrieval",
});

export type EvidenceCapability = (typeof EvidenceCapability)[keyof typeof EvidenceCapability];

/**
 * Whether a MISS from this capability settles absence for the member that was
 * asked. This is the §55 question — is the underlying query exact and complete
 * for the requested identity, or ranked and truncated — answered once, in a
 * table, so a new lane cannot quietly assume the stronger reading.
 *
 * Note what this is NOT keyed on: whether the lookup used an index. M148-A's
 * `nameLookupAccess` reports `indexed` or `fallback`, and both run the SAME
 * statement over the same rows — only the latency differs. A fallback answer is
 * exactly as authoritative as an indexed one, so access path never appears here.
 */
export const CAPABILITY_SETTLES_MEMBER_ABSENCE: Readonly<Record<EvidenceCapability, boolean>> =
  Object.freeze({
    [EvidenceCapability.PathMembership]: true,
    [EvidenceCapability.SymbolExactLookup]: true,
    [EvidenceCapability.RankedRetrieval]: false,
  });

/**
 * How firmly a set of observations settles a NEGATIVE claim.
 *
 *   not_observed           nobody authoritative was asked, or the source cannot
 *                          settle absence at all. Says nothing about the world.
 *   bounded_absence        every member IN THE CLAIMED SCOPE answered, but that
 *                          scope is narrower than the eligible population.
 *   authoritative_absence  every eligible member answered from a source whose
 *                          miss is exact. The only negative that may be stated
 *                          as a fact about the workspace.
 */
export const NegativeClaimStrength = Object.freeze({
  NotObserved: "not_observed",
  BoundedAbsence: "bounded_absence",
  AuthoritativeAbsence: "authoritative_absence",
});

export type NegativeClaimStrength =
  (typeof NegativeClaimStrength)[keyof typeof NegativeClaimStrength];

const NEGATIVE_ORDER: readonly NegativeClaimStrength[] = [
  NegativeClaimStrength.NotObserved,
  NegativeClaimStrength.BoundedAbsence,
  NegativeClaimStrength.AuthoritativeAbsence,
];

/** True when `claimed` is no stronger than `proven`. The §32 strength invariant. */
export function negativeStrengthWithin(
  claimed: NegativeClaimStrength,
  proven: NegativeClaimStrength,
): boolean {
  return NEGATIVE_ORDER.indexOf(claimed) <= NEGATIVE_ORDER.indexOf(proven);
}

/**
 * How firmly a POSITIVE claim is settled.
 *
 * Deliberately only two values. A repository that holds a definition and a
 * repository that holds a caller are both OBSERVED — the difference between
 * them is what kind of relation was seen, not how sure we are of seeing it, and
 * collapsing those two questions into one scale is how "has supporting code"
 * becomes "owns the behaviour" (§22).
 */
export const PositiveClaimStrength = Object.freeze({
  /** An indication that did not settle the question. Label it as such (§63). */
  SupportingHint: "supporting_hint",
  /** Directly observed from an authoritative source. */
  ObservedPositive: "observed_positive",
});

export type PositiveClaimStrength =
  (typeof PositiveClaimStrength)[keyof typeof PositiveClaimStrength];

/** Why one member contributed no answer. Bounded example rows only. */
export interface CoverageExample {
  readonly alias: string;
  readonly reason: string;
}

/**
 * Members reported by name in any bounded list. Four matches the cap M145 chose
 * for matched paths and M146 for reported candidates, so every bounded list in
 * this layer truncates at the same width.
 */
export const MAX_REPORTED_COVERAGE_EXAMPLES = 4;

/**
 * What a scan actually covered. Counts first, names only as bounded examples:
 * §51's rule, and the reason a 1000-member workspace does not produce a
 * 1000-record response.
 */
export interface EvidenceCoverage {
  readonly capability: EvidenceCapability;
  /** Whether this scan could DECIDE, or only gather context beneath a lead. */
  readonly purpose: "deciding" | "support";
  /** The population the scan was meant to cover. */
  readonly scope: EvidenceScope;
  /** Members in that population. */
  readonly considered: number;
  /** Members that returned a trustworthy answer. */
  readonly answered: number;
  /** Members whose index this runtime refused. Repair the index. */
  readonly refusedWithoutEvidence: number;
  /** Members the scan bound never reached. Raise the bound. */
  readonly omittedByBound: number;
  /** Ready, but unanswerable for some other reason. */
  readonly unknownOther: number;
  /** True only when every considered member answered. */
  readonly complete: boolean;
  readonly examples: readonly CoverageExample[];
  readonly examplesOmitted: number;
}

export interface ComposeCoverageInput {
  readonly capability: EvidenceCapability;
  readonly purpose: "deciding" | "support";
  readonly scope: EvidenceScope;
  readonly considered: number;
  readonly answered: number;
  readonly refusedWithoutEvidence?: number;
  readonly omittedByBound?: number;
  readonly unknownOther?: number;
  readonly examples?: readonly CoverageExample[];
}

/**
 * Build a bounded coverage record. The single place a coverage object is
 * constructed, so `complete` cannot be set by a caller that merely hopes so:
 * it is DERIVED from whether anything went unanswered.
 */
export function composeCoverage(input: ComposeCoverageInput): EvidenceCoverage {
  const refusedWithoutEvidence = input.refusedWithoutEvidence ?? 0;
  const omittedByBound = input.omittedByBound ?? 0;
  const unknownOther = input.unknownOther ?? 0;
  const examples = input.examples ?? [];
  return {
    capability: input.capability,
    purpose: input.purpose,
    scope: input.scope,
    considered: input.considered,
    answered: input.answered,
    refusedWithoutEvidence,
    omittedByBound,
    unknownOther,
    complete: input.answered >= input.considered
      && refusedWithoutEvidence + omittedByBound + unknownOther === 0,
    examples: examples.slice(0, MAX_REPORTED_COVERAGE_EXAMPLES),
    examplesOmitted: Math.max(0, examples.length - MAX_REPORTED_COVERAGE_EXAMPLES),
  };
}

/** Coverage for a lane that never ran. Nothing was asked, so nothing is known. */
export function unobservedCoverage(
  capability: EvidenceCapability,
  scope: EvidenceScope,
  considered: number,
): EvidenceCoverage {
  return composeCoverage({
    capability,
    purpose: "deciding",
    scope,
    considered,
    answered: 0,
    unknownOther: considered,
  });
}

/**
 * The strongest NEGATIVE claim this coverage earns.
 *
 * See `classifyNegativeClaim` below — this is the one decision in the module
 * that is policy rather than bookkeeping.
 */
export function classifyNegativeClaim(coverage: EvidenceCoverage): NegativeClaimStrength {
  // A source whose miss is not exact can never support absence, however many
  // members answered. §54: a ranked retrieval that returns nothing has not
  // proven the implementation does not exist.
  if (!CAPABILITY_SETTLES_MEMBER_ABSENCE[coverage.capability]) {
    return NegativeClaimStrength.NotObserved;
  }
  // Nobody answered. §26: declining to look is not a finding.
  if (coverage.answered === 0) {
    return NegativeClaimStrength.NotObserved;
  }
  // Every considered member answered from an exact source. This is the only
  // path to a workspace-wide negative.
  if (coverage.complete) {
    return NegativeClaimStrength.AuthoritativeAbsence;
  }
  // Some answered, some did not. The members that answered are still settled —
  // that is a real, usable negative — but only over the set that answered, so
  // the claim is legitimate exactly as long as it stays bounded to them.
  return NegativeClaimStrength.BoundedAbsence;
}

/**
 * Whether a negative claim at `claimedScope` is earned by this coverage.
 *
 * The mechanical form of §32. A `bounded_absence` may be stated over the
 * members that answered and no wider; only an `authoritative_absence` may be
 * stated over the eligible population.
 */
export function canClaimAbsence(
  coverage: EvidenceCoverage,
  claimedScope: EvidenceScope,
): boolean {
  const strength = classifyNegativeClaim(coverage);
  if (strength === NegativeClaimStrength.NotObserved) return false;
  if (strength === NegativeClaimStrength.AuthoritativeAbsence) {
    return scopeWithin(claimedScope, coverage.scope);
  }
  return scopeWithin(claimedScope, EvidenceScope.ScannedMembers);
}

/**
 * Join names for a human-readable reason without letting the sentence grow with
 * the workspace. §51: a 1000-member workspace must not produce a 1000-name
 * string, and a count carries the same actionable information.
 */
export function boundedJoin(
  items: readonly string[],
  cap: number = MAX_REPORTED_COVERAGE_EXAMPLES,
): string {
  if (items.length <= cap) return items.join(", ");
  const shown = items.slice(0, cap).join(", ");
  return `${shown} and ${items.length - cap} more`;
}

/**
 * A truthful one-sentence negative, qualified exactly as far as the coverage
 * requires and no further.
 *
 * §111: an ordinary complete answer gets no epistemic paragraph, because the
 * qualifier would be noise. §110: an incomplete one never gets a bare negative.
 */
export function describeNegativeClaim(
  coverage: EvidenceCoverage,
  subject: { readonly verb: string; readonly noun: string },
): string {
  switch (classifyNegativeClaim(coverage)) {
    case NegativeClaimStrength.AuthoritativeAbsence:
      return `No eligible repository ${subject.verb} ${subject.noun}; all ${coverage.considered} were checked.`;
    case NegativeClaimStrength.BoundedAbsence:
      return `None of the ${coverage.answered} repositories checked ${subject.verb} ${subject.noun}, `
        + `and ${coverage.considered - coverage.answered} of ${coverage.considered} could not be checked, `
        + `so this is not a claim about the whole workspace.`;
    default:
      return `No repository was checked for ${subject.noun}, so nothing is known about where it lives.`;
  }
}
