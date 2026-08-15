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
  /** M146-A refused its derivation. Its symbol table may not reflect this runtime. */
  IndexRefused: "index_refused",
  /** The scan bound was reached before this member. Cost bound, not a judgement. */
  BeyondScanBound: "beyond_scan_bound",
  /** Ready, but its index could not be opened for a membership question. */
  ProbeUnavailable: "probe_unavailable",
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
  readonly present: readonly string[];
  readonly unknown: readonly { readonly alias: string; readonly reason: PresenceUnknownReason }[];
  readonly definitelyAbsent: number;
  readonly reason: string;
}

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

  const base = { present, unknown, definitelyAbsent };

  // Settled by the count alone. A missing answer can only add a third owner, so
  // waiting for it would not change the conclusion.
  if (present.length > 1) {
    return {
      ...base,
      status: UniquenessProofStatus.Ambiguous,
      owner: null,
      reason: `${present.length} repositories define this name: ${present.join(", ")}.`,
    };
  }

  // Every remaining conclusion is a claim ABOUT the repositories that did not
  // answer, so one unknown member is enough to withhold it.
  if (unknown.length > 0) {
    const blockers = unknown.map((entry) => `${entry.alias} (${entry.reason})`).join(", ");
    return {
      ...base,
      status: UniquenessProofStatus.Unproven,
      owner: null,
      reason: present.length === 1
        ? `${present[0]} defines this name, but ${unknown.length} eligible repository/repositories could not be checked, so it is not provably the only one: ${blockers}.`
        : `No checked repository defines this name, but ${unknown.length} eligible repository/repositories could not be checked: ${blockers}.`,
    };
  }

  if (present.length === 1) {
    return {
      ...base,
      status: UniquenessProofStatus.Unique,
      owner: present[0]!,
      reason: `${present[0]} defines this name and all ${definitelyAbsent} other eligible repositories are proven not to.`,
    };
  }

  return {
    ...base,
    status: UniquenessProofStatus.Absent,
    owner: null,
    reason: `No eligible repository defines this name; all ${definitelyAbsent} were checked.`,
  };
}
