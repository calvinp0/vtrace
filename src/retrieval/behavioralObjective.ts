// What OPERATION a request asks about, as distinct from what SUBJECT it names.
//
// Retrieval already decomposes a request into terms, identifiers and contrast
// clauses. Every one of those answers "what is this about?". None of them answers
// "what is it asking the code to DO?", and that gap is what M150 exists to close:
//
//   "How does ARC decide which reaction family wins?"
//
// scores `reaction` and `family` on four independent signals and scores the
// requested operation — choosing a winner among alternatives — on none. So a
// memoisation helper named `get_reaction_family` leads, because it names the
// subject perfectly and the ranking has no way to notice that it does not choose
// anything (M150 §5, §29).
//
// This module derives the operation from the ALREADY-parsed request grammar, the
// same seam `evaluateOrchestrationIntent` uses. It is deliberately not a second
// parser: it reads `DerivedQueryIntent` and adds one typed reading on top.
//
// Three properties matter more than coverage:
//
//   - it is NOT an identifier hypothesis. An operation is a behavioural
//     objective; it never seeds a symbol-name lookup, so it cannot reintroduce
//     the M142 prose-to-identifier failure (§9, §10).
//   - it discriminates between requests over the SAME subject. "how is it
//     cached", "where is it stored", "which one wins" must reach different code
//     (§11), which is why cue STRENGTH is modelled rather than mere presence.
//   - it is independent of the intent classifier's confidence. The real ARC
//     request was classified low-confidence with a fallback applied, and the
//     operator cues in it were unambiguous regardless (§67, §68, §69).

import {
  evaluateOrchestrationIntent,
  type DerivedQueryIntent,
} from "./querySemantics";

/**
 * The behavioural operations M150 can both RECOGNISE in a request and EVIDENCE
 * in code. The vocabulary is deliberately small (§18): an operation earns its
 * place here only when `MechanismFactKind` carries a fact that implements it, so
 * a recognised operation always has something to retrieve. `validate`, `convert`,
 * `retry` and the rest of §9's list are real behavioural objectives and are
 * intentionally absent until they have mechanism evidence to match.
 */
export type BehavioralOperation =
  /** Which of several alternatives is picked. */
  | "selection"
  /** What establishes the order/precedence the selection then consumes. */
  | "ordering"
  /** What happens when the primary route does not produce an answer. */
  | "fallback"
  /** Whether a result is reused rather than recomputed. */
  | "caching"
  /** Where a value is held/read on an object. */
  | "storage";

/**
 * How strongly the cue commits the request to this operation.
 *
 * `predicate` — the operation is what the sentence is ASKING ("how is it
 * selected?", "where is it stored?"). `modifier` — the operation word qualifies
 * a noun and merely describes the subject ("the SELECTED family", "the CACHED
 * value"). The distinction is the whole reason §43's control works: "Where is
 * the selected reaction family stored on ARCReaction?" contains a selection word
 * and is not a selection question.
 */
export type OperationCueStrength = "predicate" | "modifier";

/** Bounded, deterministic qualifiers. Reported; never scored on their own. */
export type OperationQualifier = "multiple_alternatives" | "order_matters";

export interface BehavioralObjective {
  readonly operation: BehavioralOperation;
  /** The matched cue text, lowercased. Present so a ranking is explainable. */
  readonly cue: string;
  readonly strength: OperationCueStrength;
  readonly qualifiers: readonly OperationQualifier[];
  /**
   * The request's terms with the operation vocabulary removed — what the
   * question is ABOUT once you take out what it asks. This is the half of §30's
   * comparison that mechanism evidence is scored against.
   */
  readonly subjectTerms: readonly string[];
  /** Every operation that matched, strongest first. For the audit artifact. */
  readonly considered: readonly OperationCandidate[];
}

export interface OperationCandidate {
  readonly operation: BehavioralOperation;
  readonly cue: string;
  readonly strength: OperationCueStrength;
}

/** Why no operation was derived. Never a silent absence. */
export interface NoBehavioralObjective {
  readonly operation: null;
  readonly suppressedBy: string;
  readonly considered: readonly OperationCandidate[];
}

export type BehavioralObjectiveResult = BehavioralObjective | NoBehavioralObjective;

interface CueRule {
  readonly operation: BehavioralOperation;
  readonly strength: OperationCueStrength;
  readonly pattern: RegExp;
}

/**
 * Words that belong to the QUESTION rather than to the subject. Removed from
 * `subjectTerms` only — they stay in every other lane, because M150 §7 forbids
 * solving this with another stopword list. `reaction` and `family` are subject
 * terms and must keep every signal they already earn.
 */
const OPERATION_VOCABULARY: ReadonlySet<string> = new Set([
  "how", "does", "do", "did", "is", "are", "was", "were", "when", "where",
  "what", "which", "who", "whose", "why", "the", "a", "an", "of", "on", "in",
  "to", "for", "by", "it", "its", "system", "code",
  // operation words themselves
  "decide", "decides", "decided", "deciding", "decision", "choose", "chooses",
  "chose", "chosen", "choice", "select", "selects", "selected", "selecting",
  "selection", "pick", "picks", "picked", "win", "wins", "winning", "winner",
  "prefer", "prefers", "preferred", "preference", "priority", "prioritize",
  "prioritise", "precedence", "order", "ordered", "ordering", "rank", "ranked",
  "ranking", "sort", "sorted", "first", "fallback", "default", "defaults",
  "override", "cache", "cached", "caching", "memoised", "memoized",
  "memoisation", "memoization", "stored", "store", "saved", "kept", "held",
  "determines", "determine", "determined", "multiple", "several",
]);

/**
 * Ordered cue table. Evaluation picks the strongest match and breaks ties by
 * this order, so the table itself encodes precedence between operations that
 * legitimately co-occur.
 *
 * Storage and caching come FIRST on purpose. Both are frames that describe what
 * is being asked about a value that some other code already chose, and both
 * routinely mention the choosing ("where is the SELECTED family stored"). Asking
 * the selection question is the more specific reading only when nothing frames
 * the sentence as a storage or cache question.
 */
const CUE_RULES: readonly CueRule[] = [
  // --- storage -------------------------------------------------------------
  // A location frame that names the act of holding a value.
  { operation: "storage", strength: "predicate", pattern: /\bwhere\s+(?:is|are)\b[^?.!;\n]*\b(?:stored|saved|kept|held|persisted|assigned)\b/iu },
  { operation: "storage", strength: "predicate", pattern: /\b(?:stored|saved|kept|held)\s+(?:on|in|as)\b/iu },
  { operation: "storage", strength: "predicate", pattern: /\bwhere\s+(?:is|are)\b[^?.!;\n]*\b(?:attribute|field|property)\b/iu },
  { operation: "storage", strength: "modifier", pattern: /\b(?:attribute|field|property|accessor)\b/iu },

  // --- caching -------------------------------------------------------------
  // Clause-final participle: "how is X cached?" asks about the caching itself.
  { operation: "caching", strength: "predicate", pattern: /\b(?:cached|memoi[sz]ed)\s*[?.!;]?\s*$/iu },
  { operation: "caching", strength: "predicate", pattern: /\b(?:how|when|where|why)\b[^?.!;\n]*\b(?:cached|caching|memoi[sz]ed|memoi[sz]ation|cache)\b/iu },
  { operation: "caching", strength: "predicate", pattern: /\b(?:reused|reuse)\s+(?:rather\s+than|instead\s+of)\s+recomput/iu },
  { operation: "caching", strength: "modifier", pattern: /\b(?:cache|cached|caching|memoi[sz]ation)\b/iu },

  // --- fallback ------------------------------------------------------------
  { operation: "fallback", strength: "predicate", pattern: /\bfalls?\s+back\b/iu },
  { operation: "fallback", strength: "predicate", pattern: /\bfallback\b[^?.!;\n]*\b(?:take[sn]?\s+over|used|kick[s]?\s+in|apply|applies)\b/iu },
  { operation: "fallback", strength: "predicate", pattern: /\b(?:when|why|how)\b[^?.!;\n]*\bfallback\b/iu },
  { operation: "fallback", strength: "predicate", pattern: /\bdefaults?\s+to\b/iu },
  { operation: "fallback", strength: "modifier", pattern: /\bfallback\b/iu },

  // --- ordering ------------------------------------------------------------
  // Precedence/order nouns name the ordering itself, not the pick that follows.
  { operation: "ordering", strength: "predicate", pattern: /\b(?:precedence|priority|priorities)\b/iu },
  { operation: "ordering", strength: "predicate", pattern: /\b(?:what|which|how)\b[^?.!;\n]*\b(?:order|orders|ordering|ordered|sorts|sorted|sort\s+order|ranks?|ranked|ranking)\b/iu },
  { operation: "ordering", strength: "modifier", pattern: /\b(?:order|orders|ordering|ranks?|ranked|ranking|sorted)\b/iu },

  // --- selection -----------------------------------------------------------
  // Bare decision verbs are always predicates: nothing else in a request says
  // "choose". `\b` does not match across `_`, so `choose_candidate` is untouched.
  // M153. The inflections here must cover the same verb families that
  // OPERATION_VOCABULARY strips from the subject terms, because the two
  // disagreeing is a silent failure rather than a wrong answer: the vocabulary
  // listed `decide/decides/decided/deciding` while this pattern matched only the
  // first two, so "How does the system DECIDE which backend wins" derived
  // selection and "How is it DECIDED which backend opens a file" derived
  // nothing at all. Same verb, same question, ordinary English inflection.
  { operation: "selection", strength: "predicate", pattern: /\b(?:decides?|decided|deciding|choose|chooses|chose|choosing|picks?|selects?|prefers?|wins?|winning)\b/iu },
  // Clause-final participle: "how is the preferred item selected?"
  { operation: "selection", strength: "predicate", pattern: /\b(?:selected|chosen|picked|preferred)\s*[?.!;]?\s*$/iu },
  { operation: "selection", strength: "predicate", pattern: /\bwhich\s+(?:one|of\s+\w+)\s+(?:is|are|gets?)\b/iu },
  { operation: "selection", strength: "modifier", pattern: /\b(?:selected|chosen|picked|preferred|winner|winning)\b/iu },
];

const MULTIPLE_ALTERNATIVES = /\b(?:multiple|several|many|alternatives?|candidates?|options?|which\s+(?:one|of))\b/iu;
const ORDER_MATTERS = /\b(?:precedence|priority|priorities|order|ordering|ranked|ranking|first)\b/iu;

const STRENGTH_RANK: Readonly<Record<OperationCueStrength, number>> = {
  predicate: 2,
  modifier: 1,
};

/**
 * Derive the requested behavioural operation, or say why there is none.
 *
 * Suppression is as important as detection. An EXPLICIT IDENTIFIER request —
 * "Where is `choose_candidate()` defined?" — asks for a definition by name; the
 * operation word inside that name is not a question about behaviour, and letting
 * it become one would break the §10/§44 controls that keep direct symbol lookup
 * working. Retrieval already decides what counts as an explicit request, so this
 * defers to that decision rather than re-deciding it.
 */
export function deriveBehavioralObjective(intent: DerivedQueryIntent): BehavioralObjectiveResult {
  const task = intent.originalTask;
  const considered: OperationCandidate[] = [];
  for (const rule of CUE_RULES) {
    const match = rule.pattern.exec(task);
    if (match === null) continue;
    considered.push({
      operation: rule.operation,
      cue: match[0].toLowerCase().trim().replace(/\s+/gu, " "),
      strength: rule.strength,
    });
  }
  // Rule order is the tie-break, so a stable sort on strength alone preserves it.
  const ordered = [...considered].sort(
    (a, b) => STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength],
  );

  // A request that names a symbol and asks where it lives is answered by that
  // definition. It is not a behavioural question even when the NAME contains an
  // operation word (§10).
  const orchestration = evaluateOrchestrationIntent(intent);
  if (orchestration.suppressedBy === "explicit symbol lookup command") {
    return { operation: null, suppressedBy: "explicit symbol lookup command", considered: ordered };
  }
  // M153. `capability_lookup` used to suppress outright, and that was too wide.
  // The rule it was enforcing is about requests that NAME a definition; it was
  // being applied to requests that DESCRIBE one. "Where is the function that
  // ranks the connection adapters?" is the exact shape M150 exists to answer —
  // no such function exists, and the truthful answer reconstructs the mechanism
  // that does the ranking. Suppressing it returned nothing at all.
  //
  // Naming is still protected, and by the stronger check: an explicit symbol
  // lookup is refused above, and a request like "Where is rank_adapters
  // defined?" derives no operation anyway because `\b` does not match inside
  // `rank_adapters`, so the cue never fires on the identifier's own words. The
  // discrimination that matters is therefore identifier-vs-prose, which the
  // intent already decided, rather than capability-vs-behaviour, which it did
  // not (§22, §68).
  const namesAnIdentifier = intent.explicitIdentifiers.length > 0
    || intent.symbolHypotheses.length > 0;
  if (intent.kind === "capability_lookup" && namesAnIdentifier) {
    return {
      operation: null,
      suppressedBy: `capability lookup (${intent.intentReason ?? "definition question"})`,
      considered: ordered,
    };
  }

  const best = ordered[0];
  if (best === undefined) {
    return { operation: null, suppressedBy: "no behavioural operation cue", considered: [] };
  }

  const qualifiers: OperationQualifier[] = [];
  if (MULTIPLE_ALTERNATIVES.test(task)) qualifiers.push("multiple_alternatives");
  if (ORDER_MATTERS.test(task)) qualifiers.push("order_matters");

  return {
    operation: best.operation,
    cue: best.cue,
    strength: best.strength,
    qualifiers,
    subjectTerms: subjectTermsOf(intent),
    considered: ordered,
  };
}

/**
 * The request's terms minus the operation vocabulary.
 *
 * Branch terms are included: a conditional-alternative question names both sides
 * of the choice, and both are subject matter. Contrast terms are not — an
 * excluded operand is the one thing the request said it does NOT want.
 */
export function subjectTermsOf(intent: DerivedQueryIntent): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of [...intent.positiveTerms, ...intent.branchTerms]) {
    const lower = term.toLowerCase();
    if (lower.length < 3 || OPERATION_VOCABULARY.has(lower) || seen.has(lower)) continue;
    // A repository/project name is context, never subject matter to match code
    // against — "ARC" appears in every path in the ARC repository.
    if (intent.projectReferences.some((reference) => reference.toLowerCase() === lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

/** Convenience predicate for lanes that only need "is this behavioural?". */
export function hasBehavioralOperation(
  result: BehavioralObjectiveResult,
): result is BehavioralObjective {
  return result.operation !== null;
}
