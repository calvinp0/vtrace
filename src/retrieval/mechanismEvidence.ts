// Scoring the match between what a request ASKS FOR and what a definition DOES.
//
// The two halves already exist by the time this runs: `deriveBehavioralObjective`
// says which operation the request wants, and the index carries mechanism facts
// saying which operations each definition performs. This module is only the
// comparison between them, and it exists as its own module because that
// comparison is the one thing M150 adds to relevance — everything else in the
// scorecard measures the SUBJECT.
//
// The contribution is gated three ways, and every gate is load-bearing:
//
//   1. no declared operation -> zero. An ordinary lookup or a SWE bug report
//      pays nothing and cannot move (§29). This is what keeps the frozen
//      benchmarks still.
//   2. no COMPATIBLE fact -> zero. A cache helper on a selection question scores
//      nothing here — not because caching is penalised (§12, §39), but because
//      caching is not an answer to "which one wins". On a cache question the
//      same fact is the strongest evidence in the pool. The relationship
//      reverses, which is what makes this relevance rather than a heuristic.
//   3. no subject relevance -> zero. Mechanism evidence STRENGTHENS a candidate
//      the request is already about; it can never rescue one the request has
//      nothing to do with. Without this, every `xs[0]` in the repository becomes
//      a selection answer (§37) and centrality's old mistake returns in a new
//      costume (§77).

import type { MechanismFact, MechanismFactKind } from "../indexer/extractMechanismFacts";
import type { BehavioralObjective, BehavioralOperation } from "./behavioralObjective";
import { tokenize } from "./hybridScoring";

/**
 * How much of the requested operation a fact kind actually implements.
 *
 * `direct` — the fact IS the operation being asked about. `partial` — the fact
 * contributes to it without being it: an ordering is half of "which one wins",
 * because taking the first of an arbitrary order decides nothing on its own.
 * Absent — no evidence for this question, scored zero.
 *
 * Read the table by row and the §11/§12 contrast controls are visible in it:
 * `cache_lookup` is direct for `caching` and absent for `selection`;
 * `attribute_return` is direct for `storage` and absent everywhere else.
 */
const COMPATIBILITY: Readonly<
  Record<BehavioralOperation, Readonly<Partial<Record<MechanismFactKind, "direct" | "partial">>>>
> = Object.freeze({
  selection: {
    first_item_selection: "direct",
    sort_then_first: "direct",
    min_selection: "direct",
    max_selection: "direct",
    first_success_return: "direct",
    priority_lookup: "direct",
    conditional_choice: "partial",
    // An order is not a choice, but the choice cannot be explained without it.
    ordering_established: "partial",
  },
  ordering: {
    ordering_established: "direct",
    priority_lookup: "direct",
    sort_then_first: "partial",
    min_selection: "partial",
    max_selection: "partial",
  },
  fallback: {
    fallback_branch: "direct",
    default_then_override: "direct",
    conditional_choice: "partial",
    first_success_return: "partial",
  },
  caching: {
    cache_lookup: "direct",
  },
  storage: {
    attribute_return: "direct",
    default_then_override: "partial",
  },
});

/**
 * Bounded contribution per compatibility class.
 *
 * These are the only two magnitudes in M150 and they are CALIBRATED against the
 * generic mechanism corpus, never chosen to clear a particular candidate's score
 * on a particular query. The bound matters more than the exact value: the sum is
 * capped at `MAX_MECHANISM_EVIDENCE` so no amount of stacked facts can turn a
 * weak subject match into a lead on mechanism alone.
 */
export const DIRECT_MECHANISM_EVIDENCE = 0.55;
export const PARTIAL_MECHANISM_EVIDENCE = 0.2;
/**
 * Ceiling on the mechanism contribution for one candidate.
 *
 * Equal to the direct tier because the contribution is the STRONGEST single fact,
 * never a sum. Adding compatible facts together rewarded the wrong thing: on ARC,
 * `get_reactive_bonds_from_family` carried four weakly-compatible mechanisms and
 * out-earned `determine_family`, which carries the one that actually decides.
 * Containing more control flow is not being more decisive.
 */
export const MAX_MECHANISM_EVIDENCE = DIRECT_MECHANISM_EVIDENCE;

/**
 * Minimum subject relevance before mechanism evidence may contribute at all.
 *
 * Expressed against the candidate's own already-normalised subject signals, so
 * it asks "is the request even about this code?" and not "is this code popular?".
 */
export const MECHANISM_SUBJECT_FLOOR = 0.15;

export interface MechanismEvidenceInput {
  readonly objective: BehavioralObjective;
  readonly facts: readonly MechanismFact[];
  /** Candidate identity, for subject matching. */
  readonly localName: string;
  readonly fqName: string;
  readonly filePath: string;
  /**
   * The candidate's existing subject-side relevance, already normalised: the
   * lexical/domain/path evidence that says the request is about this code. The
   * gate reads it rather than recomputing it, so mechanism evidence can never
   * disagree with the rest of the scorecard about what the request is about.
   */
  readonly subjectRelevance: number;
}

export interface MechanismEvidence {
  /** Bounded contribution to the final score. Zero unless every gate passes. */
  readonly score: number;
  /** The facts that matched the requested operation, strongest first. */
  readonly matched: readonly MatchedMechanism[];
  /** Why the score is zero, when it is. Never a silent absence. */
  readonly withheldReason?: string;
}

export interface MatchedMechanism {
  readonly kind: MechanismFactKind;
  readonly compatibility: "direct" | "partial";
  readonly subject: string;
  readonly lineOffset: number;
  readonly evidence: string;
  /** Did the fact's own operand match a subject term of the request? */
  readonly subjectMatched: boolean;
  /** Does this mechanism produce the definition's returned value? */
  readonly resultBearing: boolean;
}

export const NO_MECHANISM_EVIDENCE: MechanismEvidence = Object.freeze({
  score: 0,
  matched: [],
  withheldReason: "no behavioural operation in request",
});

/**
 * Score one candidate's mechanism facts against the requested operation.
 *
 * Deliberately pool-independent: a candidate's mechanism evidence must not
 * change because some unrelated candidate got stronger, the same property the
 * M142 centrality gate established for centrality. Two runs over the same
 * request and the same definition give the same number.
 */
export function evaluateMechanismEvidence(input: MechanismEvidenceInput): MechanismEvidence {
  if (input.facts.length === 0) {
    return { score: 0, matched: [], withheldReason: "no mechanism facts for this definition" };
  }
  const table = COMPATIBILITY[input.objective.operation];
  const matched: MatchedMechanism[] = [];
  const subjectTerms = new Set(input.objective.subjectTerms);

  for (const fact of input.facts) {
    const compatibility = table[fact.kind];
    if (compatibility === undefined) continue;
    matched.push({
      kind: fact.kind,
      compatibility,
      subject: fact.subject,
      lineOffset: fact.lineOffset,
      evidence: fact.evidence,
      subjectMatched: operandMatchesSubject(fact.subject, subjectTerms),
      resultBearing: fact.resultBearing,
    });
  }
  if (matched.length === 0) {
    return {
      score: 0,
      matched: [],
      withheldReason: `no fact implements the requested ${input.objective.operation} operation`,
    };
  }
  // Gate 3. Mechanism evidence answers "how", never "about what". A definition
  // the request is not about does not become the answer by containing a loop.
  if (input.subjectRelevance < MECHANISM_SUBJECT_FLOOR) {
    return {
      score: 0,
      matched,
      withheldReason:
        `mechanism matched but subject relevance ${round(input.subjectRelevance)} is below the ${MECHANISM_SUBJECT_FLOOR} floor`,
    };
  }

  matched.sort((a, b) => strengthOf(b) - strengthOf(a));
  // The STRONGEST single fact, not a sum over facts.
  const score = strengthOf(matched[0]!);
  if (score <= 0) {
    return {
      score: 0,
      matched,
      withheldReason: "compatible mechanism does not produce the definition's result",
    };
  }
  return { score: round(Math.min(MAX_MECHANISM_EVIDENCE, score)), matched };
}

/**
 * Does the fact's operand name something the request is about?
 *
 * Reported, never required: `options[0]` in a repository whose request says
 * "option" should read as a stronger match than `rows[0]`, but a request that
 * describes behaviour without naming the variable — which is the normal case,
 * and the whole point of §47 — must not be punished for it.
 */
/**
 * The only kinds exempt from proving they produce the definition's result.
 *
 * Everything else must prove it, because almost every mechanism CAN occur
 * incidentally. A `break` inside a loop, an `except` handler that returns, a
 * sort deep inside a builder — each produces a true fact about a statement that
 * is nonetheless not what the definition is for. Measured on ARC's Gaussian
 * route-keyword request, exempting first-success and fallback gave the direct
 * tier to nearly every candidate in the pool, which made the component a
 * constant and let tiny lexical differences decide the lead.
 *
 * These three cannot happen incidentally: consulting a keyed cache, returning a
 * stored attribute, or reading a precedence table IS the behaviour being asked
 * about. Requiring them to sit on a return line would measure how the author
 * spelled it rather than what the code does — `if key in CACHE:` is the whole
 * answer to "how is this cached?" and is not a return statement.
 */
const RESULT_BEARING_EXEMPT: ReadonlySet<MechanismFactKind> = new Set<MechanismFactKind>([
  "cache_lookup",
  "attribute_return",
  "priority_lookup",
]);

/**
 * What one fact is worth.
 *
 * A `direct` fact earns the direct tier only when it is RESULT-BEARING — when
 * the mechanism produces what the definition hands back. Otherwise the statement
 * is real but incidental to what this definition is for, and it drops to the
 * partial tier rather than to zero: `sorted()` deep inside a builder does order
 * something, it just is not the answer to "which one wins".
 *
 * This is the property that separates the three ARC functions that all take
 * element zero of a collection, and it is measured rather than assumed.
 */
function strengthOf(entry: MatchedMechanism): number {
  const proven = RESULT_BEARING_EXEMPT.has(entry.kind) || entry.resultBearing;
  if (entry.compatibility === "direct") {
    return proven ? DIRECT_MECHANISM_EVIDENCE : PARTIAL_MECHANISM_EVIDENCE;
  }
  return proven ? PARTIAL_MECHANISM_EVIDENCE : 0;
}

/** Do this definition's own name tokens overlap the request's subject terms? */
function namesSubject(name: string, subjectTerms: ReadonlySet<string>): boolean {
  if (subjectTerms.size === 0) return false;
  for (const token of tokenize(name)) {
    for (const term of subjectTerms) {
      if (stemEqual(token, term)) return true;
    }
  }
  return false;
}

/**
 * Equal, or sharing a long enough prefix that they are the same word: `option` /
 * `options`, `family` / `families`. Deliberately the same shape as the domain
 * lane's stem rule so two parts of the scorecard cannot disagree about whether a
 * candidate names a subject.
 */
function stemEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const limit = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < limit && a[shared] === b[shared]) shared += 1;
  return shared >= 4 && shared >= limit - 3;
}

function operandMatchesSubject(operand: string, subjectTerms: ReadonlySet<string>): boolean {
  if (operand.length === 0) return false;
  return namesSubject(operand, subjectTerms);
}

/** A human-readable `why` line for a delivered candidate (§66). */
export function mechanismEvidenceReason(
  objective: BehavioralObjective,
  evidence: MechanismEvidence,
): string | undefined {
  if (evidence.score <= 0 || evidence.matched.length === 0) return undefined;
  const direct = evidence.matched.filter((entry) => entry.compatibility === "direct");
  const lead = direct[0] ?? evidence.matched[0]!;
  const phrase = MECHANISM_PHRASES[lead.kind];
  const operand = lead.subject.length > 0 ? ` on \`${lead.subject}\`` : "";
  return direct.length > 0
    ? `implements the requested ${objective.operation}: ${phrase}${operand}`
    : `contributes to the requested ${objective.operation}: ${phrase}${operand}`;
}

/**
 * How each mechanism reads in prose.
 *
 * Every phrase describes only what the statement shows. `first_item_selection`
 * says the first element is taken, and pointedly does NOT say it is the best or
 * highest-priority one — that would be the §62 overclaim, and whether it is true
 * depends on ordering evidence that lives in another definition entirely.
 */
const MECHANISM_PHRASES: Readonly<Record<MechanismFactKind, string>> = Object.freeze({
  first_item_selection: "takes the first element of an ordered collection",
  sort_then_first: "orders the collection and takes the first element",
  min_selection: "picks the minimum",
  max_selection: "picks the maximum",
  first_success_return: "returns the first candidate that satisfies the condition",
  priority_lookup: "consults a precedence table",
  conditional_choice: "branches to different results per condition",
  ordering_established: "establishes the order of the collection",
  fallback_branch: "runs a secondary route when the primary produced nothing",
  default_then_override: "assigns a default and conditionally replaces it",
  cache_lookup: "reads and populates a keyed cache",
  attribute_return: "returns the stored attribute",
});

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
