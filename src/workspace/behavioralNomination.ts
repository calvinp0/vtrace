// M153: which repository implements the behaviour a request describes.
//
// WHAT WAS MISSING
// ----------------
// M146-M149 could route on an explicit selection, an absolute path, an indexed
// path or an exact symbol. Every one of those is something the CALLER already
// knew. A request like "how does the system decide which backend wins?" names
// none of them, so `productRoute` said so plainly — the honest outcome was the
// configured default or an abstention, never the member whose name the query
// happened to mention. Measured on the behavioural corpus, all 35 workspace
// requests were answered by the configured default and none by evidence.
//
// WHY IT IS A LADDER AND NOT A SCORE
// ----------------
// The existing tiers compare repositories by the KIND of evidence they hold and
// refuse to compare raw retrieval scores across repositories, because one
// repository's number was never calibrated against another's. Behavioural
// evidence is graded rather than binary, so the tier rule "more than one match
// means ambiguous" cannot be applied unchanged — it would abstain on nearly
// every behavioural request.
//
// The resolution is to keep comparing KINDS, one level further down. A
// repository is represented by the strongest class of subject-aligned
// behavioural evidence it contains, and by NOTHING ELSE:
//
//   direct_aligned      a definition directly implements the requested
//                       operation, and the mechanism acts on the requested
//                       subject                                    DECIDES
//   direct_unaligned    directly implements the operation, but about
//                       something else                             DECIDES only if
//                                                                  nothing stronger
//   partial             a mechanism fact exists, neither direct nor aligned
//   lexical_only        name or document overlap alone             NEVER DECIDES
//
// A repository gains nothing from VOLUME. Forty partial facts still lose to one
// aligned direct implementer, because only the best item is retained. That is
// what keeps a large repository from winning on the §44 size argument without
// needing a normalisation constant nobody could justify.
//
// There is deliberately no runner-up margin and no threshold. A margin over a
// COUNT would reintroduce exactly the size advantage the ladder removes, and a
// threshold would be a number calibrated on four repositories and asserted about
// the other three.
//
// WHAT THIS MODULE DOES NOT DO
// ----------------
// It never decides that a behaviour is ABSENT. Failing to nominate means no
// repository was demonstrated to implement the behaviour, which is not the same
// claim and cannot support one (§58). And it does not outrank the exact lanes:
// a caller who named a path or an identifier gets the answer that evidence
// supports, not a fuzzier one this module preferred.

import type { SubjectAlignment } from "../retrieval/mechanismEvidence";

/**
 * The strongest kind of behavioural evidence a repository holds. Ordered by
 * authority, strongest first; `lexical_only` is present so "we looked and found
 * only word overlap" is expressible, and is never admissible.
 */
export const BehavioralEvidenceClass = Object.freeze({
  DirectAligned: "direct_aligned",
  DirectUnaligned: "direct_unaligned",
  Partial: "partial",
  LexicalOnly: "lexical_only",
});

export type BehavioralEvidenceClass =
  (typeof BehavioralEvidenceClass)[keyof typeof BehavioralEvidenceClass];

/** Strongest first. Membership in the admissible prefix is what may decide. */
export const BEHAVIORAL_CLASS_ORDER: readonly BehavioralEvidenceClass[] = Object.freeze([
  BehavioralEvidenceClass.DirectAligned,
  BehavioralEvidenceClass.DirectUnaligned,
  BehavioralEvidenceClass.Partial,
  BehavioralEvidenceClass.LexicalOnly,
]);

/**
 * Classes that may decide a route. `lexical_only` is excluded by construction
 * rather than by a condition at the call site, so a future class has to declare
 * which side of the line it is on.
 */
export const ADMISSIBLE_CLASSES: ReadonlySet<BehavioralEvidenceClass> = new Set([
  BehavioralEvidenceClass.DirectAligned,
  BehavioralEvidenceClass.DirectUnaligned,
  BehavioralEvidenceClass.Partial,
]);

export function isAdmissible(evidenceClass: BehavioralEvidenceClass): boolean {
  return ADMISSIBLE_CLASSES.has(evidenceClass);
}

function rankOf(evidenceClass: BehavioralEvidenceClass): number {
  const index = BEHAVIORAL_CLASS_ORDER.indexOf(evidenceClass);
  return index === -1 ? BEHAVIORAL_CLASS_ORDER.length : index;
}

/**
 * One admitted candidate, reduced to what nomination is allowed to look at. The
 * shape deliberately excludes any score: a router that could see one would
 * eventually be asked to compare two.
 */
export interface BehavioralCandidateSummary {
  /** Indexed fully-qualified name. Provenance for the decision, never an input. */
  readonly fqName: string;
  readonly factKind: string;
  /** Whether the mechanism's subject matched the request's. */
  readonly alignment: SubjectAlignment;
  /** `direct` when the fact kind implements the operation outright. */
  readonly compatibility: "direct" | "partial";
}

/** What one repository's bounded probe found. */
export interface BehavioralRepositoryEvidence {
  readonly alias: string;
  readonly evidenceClass: BehavioralEvidenceClass;
  /**
   * The single best item, kept ONLY as provenance so the decision can be
   * explained. Nomination compares classes; it never reads this.
   */
  readonly bestCandidate: BehavioralCandidateSummary | null;
  /** Candidates the probe admitted. Reported for cost accounting, never compared. */
  readonly candidatesConsidered: number;
}

/**
 * An alignment counts as subject-aligned when the mechanism's own operand names
 * the subject, or when the call that produced that operand does. Both are M150
 * decisions about the same question, and collapsing them here would re-litigate
 * a discrimination that module already made.
 */
export function isSubjectAligned(alignment: SubjectAlignment): boolean {
  return alignment === "direct_operand" || alignment === "local_producer";
}

/**
 * Reduce a repository's admitted candidates to its single strongest evidence
 * class. Volume is discarded on purpose: the returned class is a property of the
 * BEST candidate, so a repository with many weak facts is represented by its
 * best weak fact and not by the fact that it has many.
 */
export function classifyRepositoryEvidence(
  alias: string,
  candidates: readonly BehavioralCandidateSummary[],
): BehavioralRepositoryEvidence {
  let best: BehavioralCandidateSummary | null = null;
  let bestClass: BehavioralEvidenceClass = BehavioralEvidenceClass.LexicalOnly;

  for (const candidate of candidates) {
    const evidenceClass = candidate.compatibility === "direct"
      ? (isSubjectAligned(candidate.alignment)
        ? BehavioralEvidenceClass.DirectAligned
        : BehavioralEvidenceClass.DirectUnaligned)
      : BehavioralEvidenceClass.Partial;
    if (best === null || rankOf(evidenceClass) < rankOf(bestClass)) {
      best = candidate;
      bestClass = evidenceClass;
    }
  }

  return {
    alias,
    evidenceClass: bestClass,
    bestCandidate: bestClass === BehavioralEvidenceClass.LexicalOnly ? null : best,
    candidatesConsidered: candidates.length,
  };
}

export const BehavioralNominationStatus = Object.freeze({
  /** Exactly one repository holds the strongest admissible class. */
  Selected: "selected",
  /** Two or more tie at that class. Genuinely ambiguous; the lane abstains. */
  Ambiguous: "ambiguous",
  /**
   * Nothing admissible anywhere. The lane declines to decide and control
   * returns UNCHANGED to the existing default/abstention policy. This is not an
   * absence claim about the workspace.
   */
  NoDecision: "no_decision",
});

export type BehavioralNominationStatus =
  (typeof BehavioralNominationStatus)[keyof typeof BehavioralNominationStatus];

export interface BehavioralNomination {
  readonly status: BehavioralNominationStatus;
  /** Set only for `selected`. */
  readonly lead: BehavioralRepositoryEvidence | null;
  /** The tied set for `ambiguous`. Bounded by the caller's probe cap. */
  readonly tied: readonly BehavioralRepositoryEvidence[];
  /** The class that decided, or would have. */
  readonly decidingClass: BehavioralEvidenceClass | null;
  readonly reason: string;
}

/**
 * Compare repositories by evidence class and nominate at most one.
 *
 * The rule in full: take the strongest class any repository holds; if it is not
 * admissible, decide nothing; if exactly one repository holds it, that is the
 * lead; otherwise the request is ambiguous and the lane abstains rather than
 * breaking the tie. Ties are never broken by candidate count, registration order
 * or anything a SQLite row order could influence (§103, §104).
 */
export function nominateByEvidenceClass(
  evidence: readonly BehavioralRepositoryEvidence[],
): BehavioralNomination {
  const admissible = evidence.filter((entry) => isAdmissible(entry.evidenceClass));
  if (admissible.length === 0) {
    return {
      status: BehavioralNominationStatus.NoDecision,
      lead: null,
      tied: [],
      decidingClass: null,
      reason: evidence.length === 0
        ? "No repository could be probed for behavioural evidence."
        : "No repository carries behavioural evidence stronger than word overlap.",
    };
  }

  const strongest = admissible.reduce<BehavioralEvidenceClass>(
    (winner, entry) => (rankOf(entry.evidenceClass) < rankOf(winner) ? entry.evidenceClass : winner),
    BehavioralEvidenceClass.LexicalOnly,
  );
  const holders = admissible
    .filter((entry) => entry.evidenceClass === strongest)
    .slice()
    .sort((a, b) => a.alias.localeCompare(b.alias));

  if (holders.length === 1) {
    const lead = holders[0]!;
    return {
      status: BehavioralNominationStatus.Selected,
      lead,
      tied: [],
      decidingClass: strongest,
      reason: strongest === BehavioralEvidenceClass.DirectAligned
        ? `${lead.alias} contains a subject-aligned implementation of the requested operation.`
        : `${lead.alias} holds the strongest behavioural evidence available (${strongest}).`,
    };
  }

  return {
    status: BehavioralNominationStatus.Ambiguous,
    lead: null,
    tied: holders,
    decidingClass: strongest,
    reason: `${holders.length} repositories hold equally strong behavioural evidence (${strongest}); no lead can be chosen.`,
  };
}
