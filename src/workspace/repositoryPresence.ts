/**
 * M147: proving an exact identifier is ABSENT from repositories, so bounded
 * workspace retrieval can still make a global uniqueness claim.
 *
 * M146 established the ceiling this module exists to lift. Finding one match is
 * cheap; proving it is the ONLY match means proving every other eligible
 * repository does not match, and a search truncated at `maxDeepProbes` cannot
 * make that global negative claim — so M146 correctly abstained whenever the
 * ready set outgrew the bound.
 *
 * The distinction the proof turns on:
 *
 *   PRESENT           the repository defines the name. Measured, not inferred.
 *   DEFINITELY_ABSENT the repository was asked and does not define it.
 *   UNKNOWN           nobody asked, or the answer cannot be trusted.
 *
 * UNKNOWN is not ABSENT. A repository whose index this runtime refused, or that
 * the scan never reached, contributes no absence truth — and one such member is
 * enough to leave a global negative unproven, however many others answered.
 *
 * Nothing here opens a database or ranks anything. It consumes observations and
 * returns what they entitle a caller to conclude, which is the only reason the
 * rule can be read in one place and tested without a workspace.
 */
import { boundedJoin, MAX_REPORTED_COVERAGE_EXAMPLES } from "./evidenceClaims";

/**
 * Members named in a proof's lists and reason. M149 §51: the proof is read by a
 * model, and a 1000-member workspace must not spend its budget on 1000 aliases
 * when a count says the same thing.
 */
const MAX_REPORTED_PROOF_MEMBERS = MAX_REPORTED_COVERAGE_EXAMPLES;

/** What a single repository contributed to the proof. */
export const RepositoryPresenceState = Object.freeze({
  Present: "present",
  DefinitelyAbsent: "definitely_absent",
  Unknown: "unknown",
});

export type RepositoryPresenceState =
  (typeof RepositoryPresenceState)[keyof typeof RepositoryPresenceState];

/**
 * Why a member could contribute no trustworthy answer. Bounded and
 * machine-readable: "unknown" alone would send someone looking for the wrong
 * problem, and these three have genuinely different remedies.
 */
export const PresenceUnknownReason = Object.freeze({
  /**
   * This runtime will not read the member's derived state: a refused
   * derivation, an incompatible schema, or a source snapshot that has moved on.
   * The precise readiness verdict travels in `reposExcludedNotReady`; this names
   * the CLASS of remedy — repair that index — as distinct from raising a bound.
   */
  IndexRefused: "index_refused",
  /** The scan bound was reached before this member. Cost bound, not a judgement. */
  BeyondScanBound: "beyond_scan_bound",
  /** Ready, but its index could not be opened for a membership question. */
  ProbeUnavailable: "probe_unavailable",
  /**
   * M156. The member answered from an index that is READABLE and FRESH but
   * semantically incomplete: one or more source files in scope could not be
   * parsed, and one of them could define the name being asked about.
   *
   * Distinct from `IndexRefused`, which means we would not read the index at
   * all, and from `BeyondScanBound`, which is a cost bound we chose. Here we
   * asked and got a real answer — it simply does not cover the whole repository,
   * and the remedy is to fix the source file, not the index or the bound.
   */
  CoverageIncomplete: "coverage_incomplete",
});

export type PresenceUnknownReason =
  (typeof PresenceUnknownReason)[keyof typeof PresenceUnknownReason];

/**
 * Which physical access path answered a membership question. Recorded because
 * the router may not assume performance it has not observed: an index carrying
 * the name access path answers in microseconds, one without it scans its whole
 * symbol table, and both return the same answer.
 */
export const MembershipAccessPath = Object.freeze({
  /** A name index exists; membership is a b-tree lookup. */
  Indexed: "indexed",
  /** No name index; membership is a full scan of the symbol table. */
  Fallback: "fallback",
  /** The probe did not report which path it used. */
  Unreported: "unreported",
});

export type MembershipAccessPath =
  (typeof MembershipAccessPath)[keyof typeof MembershipAccessPath];

export interface RepositoryPresenceObservation {
  readonly alias: string;
  readonly state: RepositoryPresenceState;
  /** Set only when `state` is Unknown. */
  readonly unknownReason: PresenceUnknownReason | null;
  readonly accessPath: MembershipAccessPath;
}

/** What the observations entitle a caller to conclude. */
export const UniquenessProofStatus = Object.freeze({
  /** Exactly one repository present, every other eligible one proven absent. */
  Unique: "unique",
  /** More than one repository present. Genuinely ambiguous, not unproven. */
  Ambiguous: "ambiguous",
  /** Every eligible repository answered, and none defines the name. */
  Absent: "absent",
  /** At least one eligible repository contributed no trustworthy answer. */
  Unproven: "unproven",
});

export type UniquenessProofStatus =
  (typeof UniquenessProofStatus)[keyof typeof UniquenessProofStatus];

export interface UniquenessProof {
  readonly status: UniquenessProofStatus;
  /** Non-null only for `unique`. */
  readonly owner: string | null;
  /**
   * Members holding the evidence, BOUNDED (M149 §51). `presentTotal` is the real
   * count; this list is capped so a workspace-scale answer does not carry a
   * member record per repository. The verdict is computed from the totals, never
   * from these lists.
   */
  readonly present: readonly string[];
  readonly presentTotal: number;
  readonly presentOmitted: number;
  /** Members that could not answer, bounded the same way. */
  readonly unknown: readonly { readonly alias: string; readonly reason: PresenceUnknownReason }[];
  readonly unknownTotal: number;
  readonly unknownOmitted: number;
  readonly definitelyAbsent: number;
  readonly reason: string;
}

/**
 * How a lane describes the thing it is proving membership of.
 *
 * M148-B reuses this reducer for indexed-path evidence, and the proof's reasons
 * are read by users: a path lane reporting "defines this name" would describe a
 * question nobody asked. The logic is identical for every lane — only the noun
 * changes — so the noun is a parameter and the rule stays in one place.
 */
export interface PresenceClaimSubject {
  /** Verb for a repository that HAS the evidence. */
  readonly verb: string;
  /** What is being looked for, as it reads mid-sentence. */
  readonly noun: string;
}

const EXACT_NAME_SUBJECT: PresenceClaimSubject = Object.freeze({ verb: "defines", noun: "this name" });

/**
 * Decide what a set of presence observations proves about global uniqueness.
 *
 * The invariants this must hold, in the order they bite:
 *
 *   FINDING ONE MATCH DOES NOT PROVE UNIQUENESS.
 *   UNIQUENESS REQUIRES ONE PRESENT + ALL OTHERS PROVEN ABSENT.
 *   UNKNOWN IS NOT ABSENT.
 *
 * Two or more present repositories is `ambiguous` even when other members are
 * unknown — a further answer could not reduce the count below two, so the
 * conclusion is already earned. That asymmetry is deliberate: `unproven` means
 * "a missing answer could have changed this", and here none could.
 */
export function proveExactUniqueness(
  observations: readonly RepositoryPresenceObservation[],
  subject: PresenceClaimSubject = EXACT_NAME_SUBJECT,
): UniquenessProof {
  const present = observations
    .filter((entry) => entry.state === RepositoryPresenceState.Present)
    .map((entry) => entry.alias)
    .sort();
  const unknown = observations
    .filter((entry) => entry.state === RepositoryPresenceState.Unknown)
    .map((entry) => ({
      alias: entry.alias,
      reason: entry.unknownReason ?? PresenceUnknownReason.ProbeUnavailable,
    }))
    .sort((left, right) => left.alias.localeCompare(right.alias));
  const definitelyAbsent = observations
    .filter((entry) => entry.state === RepositoryPresenceState.DefinitelyAbsent)
    .length;

  // The lists travel BOUNDED; the verdict is decided from the totals. Keeping
  // those two apart is the whole point — truncating a report must never be able
  // to change what the report concludes (M149 §51/§134).
  const base = {
    present: present.slice(0, MAX_REPORTED_PROOF_MEMBERS),
    presentTotal: present.length,
    presentOmitted: Math.max(0, present.length - MAX_REPORTED_PROOF_MEMBERS),
    unknown: unknown.slice(0, MAX_REPORTED_PROOF_MEMBERS),
    unknownTotal: unknown.length,
    unknownOmitted: Math.max(0, unknown.length - MAX_REPORTED_PROOF_MEMBERS),
    definitelyAbsent,
  };

  // Settled by the count alone. A missing answer can only add a third owner, so
  // waiting for it would not change the conclusion.
  if (present.length > 1) {
    return {
      ...base,
      status: UniquenessProofStatus.Ambiguous,
      owner: null,
      reason: `${present.length} repositories ${subject.verb} ${subject.noun}: ${boundedJoin(present)}.`,
    };
  }

  // Every remaining conclusion is a claim ABOUT the repositories that did not
  // answer, so one unknown member is enough to withhold it.
  if (unknown.length > 0) {
    const blockers = boundedJoin(unknown.map((entry) => `${entry.alias} (${entry.reason})`));
    return {
      ...base,
      status: UniquenessProofStatus.Unproven,
      owner: null,
      reason: present.length === 1
        ? `${present[0]} ${subject.verb} ${subject.noun}, but ${unknown.length} eligible repository/repositories could not be checked, so it is not provably the only one: ${blockers}.`
        : `No checked repository ${subject.verb} ${subject.noun}, but ${unknown.length} eligible repository/repositories could not be checked: ${blockers}.`,
    };
  }

  if (present.length === 1) {
    return {
      ...base,
      status: UniquenessProofStatus.Unique,
      owner: present[0]!,
      reason: `${present[0]} ${subject.verb} ${subject.noun} and all ${definitelyAbsent} other eligible repositories are proven not to.`,
    };
  }

  return {
    ...base,
    status: UniquenessProofStatus.Absent,
    owner: null,
    reason: `No eligible repository ${subject.verb} ${subject.noun}; all ${definitelyAbsent} were checked.`,
  };
}
