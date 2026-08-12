// Path-coherent orchestration delivery (M140-C).
//
// M140-B closed a DISCOVERY gap: for a "how does X happen?" question the bounded
// rescue lane now walks incoming call edges upward and recovers the orchestration
// above an implementation retrieval already found. ARC's serialization chain is
// the canonical case:
//
//   ARCSpecies.from_dict -> ARCSpecies.mol_from_xyz -> perceive_molecule_from_xyz
//
// All three are now discovered. Only two are delivered. The entry point ranks ~93
// of 132 because it is exactly what the premise of a rescue says it is: weakly
// lexical. Ranking it higher would take roughly another point of graph-only score,
// which is the same as saying two-hop callers should outrank exact direct answers.
//
// So this module does not touch ranking at all. It answers a different question:
//
//   RANKING   — how directly does this candidate match the request?
//   SELECTION — which bounded set of evidence answers the request coherently?
//
// A candidate may be truthfully weak on the first and still be required by the
// second, when it is the last missing link of a short exact call path whose every
// other node is ALREADY being delivered. Delivering `mol_from_xyz` while silently
// dropping the function that decides to call it leaves the reader holding a chain
// with its first link cut.
//
// The role is deliberately hard to earn and capped at ONE item per request:
//
//   * it consumes an ordinary support slot under ordinary budget accounting;
//   * it can never be a pivot, and never the lead;
//   * it requires the entire downstream path to be selected already, so it can
//     only ever finish a chain, never start a speculative one;
//   * it operates on candidates the M140-B lane already produced — no second
//     graph walk, no new DB query, no new source read.

import type { HybridCandidate, OrchestrationPathCandidate } from "../retrieval/hybridRetrieval";
import { isStructuralSymbolKind } from "../domain/types";

export interface PathCompletionOptions {
  /**
   * Items this role may add to one request. Deliberately 1, and 1 is the only
   * value above zero the selector implements: 0 disables the role, anything else
   * selects exactly one. A second guaranteed upstream slot has no evidence behind
   * it, so widening this is a design decision, not a configuration change.
   */
  readonly maxPathCompletionItems?: number;
  /** Query relevance a candidate must retain to be worth a guaranteed slot. */
  readonly minRelevance?: number;
  /** Distinct query terms the candidate's own definition must match. */
  readonly minMatchedQueryTerms?: number;
  /** Support slots the capsule must have before the role is affordable at all. */
  readonly minSupportSlots?: number;
  /** Hops the completed path may span. Never more than the lane's own bound. */
  readonly maxDepth?: number;
}

export const PATH_COMPLETION_DEFAULTS = Object.freeze({
  // §17: one slot. The ARC chain needs exactly one entry point, and a second
  // guaranteed upstream slot has no evidence behind it.
  maxPathCompletionItems: 1,
  // §38: a bounded floor, NOT the ordinary delivery threshold. The point of the
  // role is that the candidate is below that threshold; the floor only excludes a
  // symbol whose sole claim is its position in the graph.
  minRelevance: 0.3,
  minMatchedQueryTerms: 2,
  // §57: the role must never consume a capsule's only support slot. With one slot
  // available, ordinary evidence is the better use of it.
  minSupportSlots: 2,
  maxDepth: 2,
});

/**
 * Which lifecycle dimension the completed path contributes (§24). Structural,
 * derived from the path shape and the parsed request — never a guess about
 * semantics the index cannot back.
 */
export type PathCoverageRole =
  /** Reaches a selected seed THROUGH a selected intermediate: a real chain head. */
  | "orchestration_entry"
  /** Calls two or more delivered alternatives: the code that chooses between them. */
  | "branch_controller";

export interface PathCompletionSelection {
  readonly candidate: HybridCandidate;
  /** The rank the candidate genuinely earned. Reported, never rewritten. */
  readonly ordinaryRank: number;
  readonly ordinaryScore: number;
  readonly depth: number;
  readonly path: readonly string[];
  /** Downstream path nodes already in the selected set. Always `path.length - 1`. */
  readonly downstreamSelected: number;
  readonly coverageRole: PathCoverageRole;
  readonly matchedTerms: readonly string[];
  readonly selectionReason: string;
}

/** Why one discovered candidate did or did not earn the slot. */
export interface PathCompletionCandidateTrace {
  readonly fqName: string;
  readonly ordinaryRank: number;
  readonly ordinaryScore: number;
  readonly depth: number;
  readonly path: readonly string[];
  readonly downstreamSelected: number;
  readonly matchedTerms: readonly string[];
  readonly eligible: boolean;
  readonly rejectedBy?: string;
  readonly selected: boolean;
}

export interface PathCompletionDiagnostics {
  /** The request reached the role's gate at all (orchestration-shaped intent). */
  readonly eligibleRequest: boolean;
  readonly requestRejectedBy?: string;
  readonly discoveredCandidates: number;
  readonly eligibleCandidates: number;
  readonly selectedCount: number;
  readonly rejectedNoIntent: number;
  readonly rejectedAlreadySelected: number;
  readonly rejectedNoCoherentPath: number;
  readonly rejectedWeakRelevance: number;
  readonly rejectedStructural: number;
  readonly rejectedDepth: number;
  readonly rejectedBudget: number;
  /** Eligible but out-ranked: exactly the cost of the one-item cap. */
  readonly rejectedSlotTaken: number;
  readonly evaluationMs: number;
  readonly candidates: readonly PathCompletionCandidateTrace[];
}

export interface PathCompletionResult {
  readonly selection?: PathCompletionSelection;
  readonly diagnostics: PathCompletionDiagnostics;
}

export interface PathCompletionInput {
  /** What the M140-B lane discovered, with truthful ordinary ranks. */
  readonly orchestrationPaths: readonly OrchestrationPathCandidate[];
  /**
   * The lane's own intent gate result. Reused rather than recomputed so the two
   * can never disagree: a request that was not orchestration-shaped never
   * produced a path in the first place.
   */
  readonly orchestrationIntentActive: boolean;
  readonly orchestrationIntentReason?: string;
  /** Fully-qualified names already heading for delivery (pivots + support winners). */
  readonly selectedFqNames: ReadonlySet<string>;
  /** Support slots this capsule has. Zero means the role is unaffordable. */
  readonly supportSlots: number;
  /** True when the request parsed as a conditional-alternative question. */
  readonly hasBranchClause: boolean;
  readonly options?: PathCompletionOptions;
}

const round = (value: number): number => Math.round(value * 1e4) / 1e4;

/**
 * Choose at most one already-discovered candidate to deliver as orchestration
 * support.
 *
 * Pure and deterministic: it reads the rescue lane's output and the selected set,
 * and nothing else. Ties never fall through to Map iteration or SQLite row order.
 */
export function selectPathCompletion(input: PathCompletionInput): PathCompletionResult {
  const started = performance.now();
  const options = input.options ?? {};
  const maxItems = Math.max(0, options.maxPathCompletionItems ?? PATH_COMPLETION_DEFAULTS.maxPathCompletionItems);
  const minRelevance = options.minRelevance ?? PATH_COMPLETION_DEFAULTS.minRelevance;
  const minMatched = Math.max(0, options.minMatchedQueryTerms ?? PATH_COMPLETION_DEFAULTS.minMatchedQueryTerms);
  const minSupportSlots = Math.max(0, options.minSupportSlots ?? PATH_COMPLETION_DEFAULTS.minSupportSlots);
  const maxDepth = Math.max(1, options.maxDepth ?? PATH_COMPLETION_DEFAULTS.maxDepth);

  const counters = {
    rejectedNoIntent: 0,
    rejectedAlreadySelected: 0,
    rejectedNoCoherentPath: 0,
    rejectedWeakRelevance: 0,
    rejectedStructural: 0,
    rejectedDepth: 0,
    rejectedBudget: 0,
    rejectedSlotTaken: 0,
  };

  const inactive = (requestRejectedBy: string): PathCompletionResult => ({
    diagnostics: {
      eligibleRequest: false,
      requestRejectedBy,
      discoveredCandidates: input.orchestrationPaths.length,
      eligibleCandidates: 0,
      selectedCount: 0,
      ...counters,
      evaluationMs: round(performance.now() - started),
      candidates: [],
    },
  });

  if (!input.orchestrationIntentActive) {
    counters.rejectedNoIntent = input.orchestrationPaths.length;
    return inactive(input.orchestrationIntentReason ?? "not an orchestration question");
  }
  if (maxItems === 0) {
    return inactive("path completion disabled");
  }
  // §57: with a single support slot, ordinary evidence is the better use of it —
  // and a capsule squeezed that hard must not be made less useful by this role.
  if (input.supportSlots < minSupportSlots) {
    counters.rejectedBudget = input.orchestrationPaths.length;
    return inactive(`only ${input.supportSlots} support slot(s); needs ${minSupportSlots}`);
  }
  if (input.orchestrationPaths.length === 0) {
    return inactive("no upstream orchestration candidate discovered");
  }

  interface Scored {
    readonly entry: OrchestrationPathCandidate;
    readonly downstreamSelected: number;
    readonly coverageRole: PathCoverageRole;
  }

  const traces: PathCompletionCandidateTrace[] = [];
  const eligible: Scored[] = [];

  for (const entry of input.orchestrationPaths) {
    // `path` is `candidate -> ... -> seed`; everything after the head is what the
    // reader would have to follow to make sense of the candidate.
    const downstream = entry.path.slice(1);
    const downstreamSelected = downstream.filter((fqName) => input.selectedFqNames.has(fqName)).length;
    const trace = (eligibleNow: boolean, rejectedBy?: string): void => {
      traces.push({
        fqName: entry.candidate.fqName,
        ordinaryRank: entry.ordinaryRank,
        ordinaryScore: entry.ordinaryScore,
        depth: entry.depth,
        path: entry.path,
        downstreamSelected,
        matchedTerms: entry.matchedTerms,
        eligible: eligibleNow,
        ...(rejectedBy === undefined ? {} : { rejectedBy }),
        selected: false,
      });
    };

    // Already delivered on its own merits: there is nothing to complete.
    if (input.selectedFqNames.has(entry.candidate.fqName)) {
      counters.rejectedAlreadySelected += 1;
      trace(false, "already selected on ordinary evidence");
      continue;
    }
    // §45: a `<module>` is a graph bridge, never an answer. The lane already
    // filters them; this is the selection-side half of the same guarantee, so a
    // future producer cannot reintroduce one through this role.
    if (isStructuralSymbolKind(entry.candidate.kind)) {
      counters.rejectedStructural += 1;
      trace(false, "structural symbol");
      continue;
    }
    if (entry.depth > maxDepth || entry.path.length < 2) {
      counters.rejectedDepth += 1;
      trace(false, `depth ${entry.depth} beyond ${maxDepth}`);
      continue;
    }
    // THE decisive condition (§34/§35). Not "a path exists" and not "it shares a
    // seed with something selected", but: every node the candidate calls through,
    // down to the seed, is already being delivered. Completing such a path adds
    // the one missing link of a chain the reader can otherwise already follow; a
    // candidate hanging off an undelivered intermediate would instead introduce a
    // dangling reference, which is a worse capsule, not a better one.
    if (downstreamSelected !== downstream.length) {
      counters.rejectedNoCoherentPath += 1;
      trace(false, `${downstreamSelected}/${downstream.length} downstream path nodes selected`);
      continue;
    }
    // Reaching a delivered symbol is not yet a reason to be delivered: EVERY
    // caller of a selected function passes the test above, and "one more caller"
    // is what impact analysis is for. The role recognises exactly two shapes, both
    // of which say something the selected set does not already say:
    //
    //   chain completion — the candidate reaches the seed THROUGH a delivered
    //     intermediate, so it is the head of a chain rather than a sibling of one
    //     (§34: `from_dict -> mol_from_xyz -> perceive_...`, never
    //     `some caller -> perceive_...`);
    //
    //   branch control — the request asked which of two alternatives runs, and
    //     the candidate calls at least two of the DELIVERED alternatives, i.e. it
    //     is the code that chooses between the branches on screen (§24/§27).
    //
    // Measured on ARC: without this, a broad process question ("how does ARC
    // handle linear segments…?") spent the slot on an ordinary rank-11 caller
    // whose only qualification was calling something already delivered.
    const selectedSeedsCalled = entry.depth === 1
      ? entry.seedFqNames.filter((fqName) => input.selectedFqNames.has(fqName)).length
      : 0;
    const completesChain = entry.depth >= 2;
    const controlsBranches = entry.depth === 1 && input.hasBranchClause && selectedSeedsCalled >= 2;
    if (!completesChain && !controlsBranches) {
      counters.rejectedNoCoherentPath += 1;
      trace(false, entry.depth === 1 && input.hasBranchClause
        ? `direct caller of ${selectedSeedsCalled} delivered alternative(s); a branch controller needs 2`
        : "direct caller of a delivered symbol, not a chain head or branch controller");
      continue;
    }
    // §25/§38: reachability is never relevance. The candidate must still say
    // something about the original request on its own definition.
    if (entry.relevance < minRelevance || entry.matchedTerms.length < minMatched) {
      counters.rejectedWeakRelevance += 1;
      trace(false, `relevance ${entry.relevance} / ${entry.matchedTerms.length} matched terms`);
      continue;
    }

    const coverageRole: PathCoverageRole = completesChain ? "orchestration_entry" : "branch_controller";
    eligible.push({ entry, downstreamSelected, coverageRole });
    trace(true);
  }

  if (eligible.length === 0) {
    return {
      diagnostics: {
        eligibleRequest: true,
        discoveredCandidates: input.orchestrationPaths.length,
        eligibleCandidates: 0,
        selectedCount: 0,
        ...counters,
        evaluationMs: round(performance.now() - started),
        candidates: traces,
      },
    };
  }

  // Ordering, in the order the request itself implies:
  //  1. the longest already-delivered chain completed — an entry point reached
  //     through a selected intermediate is far stronger evidence of orchestration
  //     than one more caller of a symbol that happens to be on screen (§34/§35);
  //  2. how much of the ORIGINAL request the candidate independently answers (§25);
  //  3. its truthful ordinary score, as the last substantive signal;
  //  4. names, so the result never depends on iteration order (§80).
  eligible.sort((left, right) =>
    right.downstreamSelected - left.downstreamSelected
    || right.entry.matchedTerms.length - left.entry.matchedTerms.length
    || right.entry.ordinaryScore - left.entry.ordinaryScore
    || left.entry.candidate.fqName.localeCompare(right.entry.candidate.fqName)
    || left.entry.candidate.symbolId.localeCompare(right.entry.candidate.symbolId));

  const winner = eligible[0]!;
  counters.rejectedSlotTaken = eligible.length - Math.min(maxItems, eligible.length);
  const chain = winner.entry.path.join(" -> ");
  const selection: PathCompletionSelection = {
    candidate: winner.entry.candidate,
    ordinaryRank: winner.entry.ordinaryRank,
    ordinaryScore: winner.entry.ordinaryScore,
    depth: winner.entry.depth,
    path: winner.entry.path,
    downstreamSelected: winner.downstreamSelected,
    coverageRole: winner.coverageRole,
    matchedTerms: winner.entry.matchedTerms,
    // Truthful on both counts: it says the candidate is weak in ordinary ranking
    // AND why it is nonetheless required.
    selectionReason:
      `selected as orchestration support (${winner.coverageRole}): completes the exact `
      + `${winner.entry.depth}-hop call path ${chain}, whose other ${winner.downstreamSelected} `
      + `node(s) are already delivered; ordinary rank ${winner.entry.ordinaryRank} `
      + `(score ${round(winner.entry.ordinaryScore)}) is unchanged`,
  };

  return {
    selection,
    diagnostics: {
      eligibleRequest: true,
      discoveredCandidates: input.orchestrationPaths.length,
      eligibleCandidates: eligible.length,
      selectedCount: 1,
      ...counters,
      evaluationMs: round(performance.now() - started),
      candidates: traces.map((trace) =>
        trace.fqName === winner.entry.candidate.fqName ? { ...trace, selected: true } : trace),
    },
  };
}
