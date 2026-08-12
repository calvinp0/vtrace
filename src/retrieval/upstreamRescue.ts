// Bounded upstream orchestration rescue (M140-B).
//
// Retrieval finds symbols that LOOK like the query. For a "how does X happen?"
// question that is systematically not enough: the implementation that performs
// the work shares vocabulary with the question, but the function that DECIDES to
// call it — the orchestration entry point the reader actually asked about — often
// shares none. ARC's serialization question is the canonical case:
//
//   ARCSpecies.from_dict  ->  ARCSpecies.mol_from_xyz  ->  perceive_molecule_from_xyz
//   (asked about)             (asked about)                (the only one retrieved)
//
// The path is already in the index as exact `calls` edges. What was missing is a
// generator that walks it. This module is that generator: given a few strong,
// query-matching seeds it expands INCOMING call edges upward and offers the
// callers as ordinary candidates.
//
// Three properties make that safe rather than a caller explosion:
//
//   * it only runs for requests whose intent is orchestration-shaped;
//   * every dimension is capped — seeds, callers examined per seed, callers
//     admitted per seed, total rescued, and depth;
//   * a caller must independently match the ORIGINAL query to be admitted.
//     Calling the seed is what makes a symbol reachable, never what makes it
//     relevant.
//
// It produces CANDIDATES, not selections: everything it returns is scored,
// ranked, budgeted and rendered by exactly the same machinery as every other
// candidate, so there is no path by which rescued content bypasses delivery
// filtering.

import type { Database } from "bun:sqlite";

import {
  countIncomingEdgesOfTypeForSymbols,
  listIncomingEdgesOfTypeForSymbols,
} from "../db/repositories/edgesRepository";
import { getSymbolsByIds } from "../db/repositories/symbolsRepository";
import {
  EdgeType,
  isStructuralSymbolKind,
  SymbolKind,
  type SymbolId,
  type SymbolRecord,
} from "../domain/types";
import { computeBm25Scores, tokenize, type Bm25Document } from "./hybridScoring";
import { isLikelyTestCandidate } from "./searchSymbolsShared";
import type { DerivedQueryIntent } from "./querySemantics";

/**
 * Every bound the lane obeys. The shape of the work is
 * `seeds x callersPerSeed x depth`, none of which depends on repository size or
 * on how popular the seed happens to be.
 */
export interface UpstreamRescueOptions {
  /** Base candidates allowed to trigger rescue. */
  readonly maxRescueSeeds?: number;
  /** Callers ADMITTED per seed, per depth level. */
  readonly maxUpstreamCandidatesPerSeed?: number;
  /** Callers rescued across the whole request. */
  readonly maxUpstreamRescueCandidates?: number;
  /** Hops walked upward. Clamped to [1, 2]. */
  readonly maxDepth?: number;
  /** Incoming edges READ per target — the DB-side bound on a popular helper. */
  readonly maxIncomingEdgesPerSeed?: number;
  /** Distinct query content terms a caller must match to be admissible. */
  readonly minMatchedQueryTerms?: number;
  /** Share of the best relevance in its pool a caller must reach. */
  readonly minRelativeRelevance?: number;
  /** Rank window in the base ranking from which seeds may be drawn. */
  readonly seedRankWindow?: number;
  /** Share of the top base score a seed must reach. */
  readonly seedMinScoreRatio?: number;
}

export const UPSTREAM_RESCUE_DEFAULTS = Object.freeze({
  maxRescueSeeds: 3,
  maxUpstreamCandidatesPerSeed: 3,
  maxUpstreamRescueCandidates: 8,
  maxDepth: 2,
  // A safety ceiling against pathological fan-in, NOT a relevance filter. The
  // retained prefix is ordered by edge id, which is uncorrelated with relevance,
  // so a cap tight enough to bite routinely would drop the very caller the
  // request needed — measured: at 1,000 callers a 400 cap discarded both
  // relevant ones. What actually bounds the OUTPUT is the admission caps; what
  // this bounds is the pathological case. Reading these rows is one indexed
  // query plus one batched hydration, and no source is read at any fan-in.
  maxIncomingEdgesPerSeed: 2000,
  minMatchedQueryTerms: 2,
  minRelativeRelevance: 0.25,
  seedRankWindow: 5,
  seedMinScoreRatio: 0.75,
});

/** The minimum a candidate must look like to be worth expanding upward from. */
export interface UpstreamRescueSeedInput {
  readonly symbolId: SymbolId;
  readonly fqName: string;
  readonly localName: string;
  readonly filePath: string;
  readonly kind: SymbolKind;
  readonly final: number;
}

export interface UpstreamRescueSeed {
  readonly symbolId: SymbolId;
  readonly fqName: string;
  readonly rank: number;
  readonly final: number;
  readonly reason: string;
}

export interface RescuedUpstreamCandidate {
  readonly symbol: SymbolRecord;
  /** Incoming-call hops from the nearest seed. */
  readonly depth: number;
  /** Query relevance in [0, 1], normalised within the pool it was drawn from. */
  readonly relevance: number;
  /** Bounded score contribution this candidate earns for being orchestration. */
  readonly rescueScore: number;
  readonly seedSymbolIds: readonly SymbolId[];
  /**
   * The seeds this candidate reaches, by name. At depth 1 these are exactly the
   * seeds it CALLS directly, which is what lets a later stage tell a function
   * that chooses between two delivered alternatives from one that happens to use
   * a single popular helper.
   */
  readonly seedFqNames: readonly string[];
  /** Best (shortest, then strongest) path: candidate -> ... -> seed. */
  readonly path: readonly string[];
  readonly matchedTerms: readonly string[];
  /** Truthful, non-lexical explanation of why this symbol is here. */
  readonly reason: string;
}

export interface UpstreamRescueDiagnostics {
  readonly activated: boolean;
  readonly activationReason?: string;
  readonly suppressedBy?: string;
  readonly seeds: readonly UpstreamRescueSeed[];
  readonly incomingEdgesExamined: number;
  /** True fan-in of the seeds, counted without materialising the edges. */
  readonly incomingEdgesAvailable: number;
  readonly rescuedCandidatesAdmitted: number;
  readonly rescuedCandidatesScored: number;
  readonly maxDepthReached: number;
  readonly limitReached: readonly string[];
  readonly dbQueries: number;
  readonly timingsMs: {
    readonly seedSelection: number;
    readonly incomingTraversal: number;
    readonly rescueScoring: number;
    readonly total: number;
  };
  /** Per-seed fan-in accounting; the §92 high-fan-in evidence table. */
  readonly perSeed: ReadonlyArray<{
    readonly fqName: string;
    readonly incomingCallersTotal: number;
    readonly incomingCallersExamined: number;
    readonly callersAdmitted: number;
    readonly limitReached: boolean;
  }>;
}

export interface UpstreamRescueResult {
  readonly candidates: readonly RescuedUpstreamCandidate[];
  readonly diagnostics: UpstreamRescueDiagnostics;
}

/** Kinds that can meaningfully sit in a call chain. */
const SEED_KINDS: ReadonlySet<SymbolKind> = new Set([SymbolKind.Function, SymbolKind.Method]);

// Score contribution, calibrated against the bounded-component family it joins:
// `positiveObjectiveScore` caps at 0.36, `contrastPenalty` at 0.75 and
// `directAnswerScore` at 0.95. Rescue sits with the last of these because it
// requires TWO independent facts — an exact static call edge into a
// strongly-matched implementation, AND the caller matching the query on its own
// definition — which is comparable evidence to a definition matching a requested
// capability. It is a ceiling, not a typical value: only a candidate that tops
// the rescued pool at depth 1 ever reaches it.
const RESCUE_WEIGHT = 0.95;
const RESCUE_SCORE_CAP = 0.95;
const DEPTH_FACTOR: Readonly<Record<number, number>> = Object.freeze({ 1: 1, 2: 0.8 });
// Reaching a candidate from several seeds is corroboration, but five paths are
// not five times the evidence (§26).
const MULTI_SEED_BONUS = 0.05;
const MULTI_SEED_BONUS_CAP = 0.1;

const round = (value: number): number => Math.round(value * 1e4) / 1e4;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Which base candidates may trigger rescue.
 *
 * Narrow by construction (§15): rescue exists to recover the orchestration above
 * an implementation we are already confident about, so a seed must be a
 * call-graph-shaped symbol near the top of the base ranking and close to the best
 * score in it. A weak candidate's callers are speculation about speculation.
 */
export function selectUpstreamRescueSeeds(
  candidates: readonly UpstreamRescueSeedInput[],
  options: UpstreamRescueOptions = {},
): UpstreamRescueSeed[] {
  const rankWindow = Math.max(1, options.seedRankWindow ?? UPSTREAM_RESCUE_DEFAULTS.seedRankWindow);
  const minRatio = options.seedMinScoreRatio ?? UPSTREAM_RESCUE_DEFAULTS.seedMinScoreRatio;
  const maxSeeds = Math.max(0, options.maxRescueSeeds ?? UPSTREAM_RESCUE_DEFAULTS.maxRescueSeeds);
  if (candidates.length === 0 || maxSeeds === 0) {
    return [];
  }

  const top = candidates[0]?.final ?? 0;
  const seeds: UpstreamRescueSeed[] = [];

  for (const [index, candidate] of candidates.slice(0, rankWindow).entries()) {
    if (seeds.length >= maxSeeds) {
      break;
    }
    if (isStructuralSymbolKind(candidate.kind) || !SEED_KINDS.has(candidate.kind)) {
      continue;
    }
    // A test is the TOP of a call chain, not orchestration within one, and the
    // failing-test lane already owns test -> implementation routing.
    if (isLikelyTestCandidate(candidate)) {
      continue;
    }
    if (top > 0 && candidate.final < top * minRatio) {
      continue;
    }
    seeds.push({
      symbolId: candidate.symbolId,
      fqName: candidate.fqName,
      rank: index + 1,
      final: round(candidate.final),
      reason: `rank ${index + 1} ${candidate.kind} at ${round(candidate.final)} (>= ${round(minRatio)} of top ${round(top)})`,
    });
  }

  return seeds;
}

/** Index metadata only — never source. Keeps §28's zero-source-read property. */
function rescueDocument(symbol: SymbolRecord): Bm25Document {
  return {
    id: symbol.id,
    text: [
      symbol.localName,
      symbol.fqName,
      symbol.signature ?? "",
      symbol.docstring ?? "",
      symbol.filePath.replace(/\\/g, "/").split("/").join(" "),
    ].join(" "),
  };
}

/**
 * Distinct query content terms a caller's definition mentions.
 *
 * This is the ABSOLUTE admission floor, and it is separate from the BM25 ranking
 * on purpose. BM25 is normalised within a pool, so the best of 1,000 irrelevant
 * callers still scores 1.0; requiring real term overlap is what stops a popular
 * helper's arbitrary favourite caller from being admitted on a technicality.
 */
function matchedQueryTerms(
  symbol: SymbolRecord,
  queryTerms: ReadonlySet<string>,
): string[] {
  const tokens = new Set(tokenize(rescueDocument(symbol).text));
  return [...queryTerms].filter((term) => tokens.has(term)).sort();
}

interface Pending {
  symbol: SymbolRecord;
  depth: number;
  relevance: number;
  matchedTerms: string[];
  seedSymbolIds: Set<SymbolId>;
  path: string[];
}

/**
 * Walk incoming `calls` edges upward from `seeds` and return the callers that
 * independently match the query.
 *
 * Only exact `calls` edges are traversed (§13/§51). `imports`/`references`/
 * `contains` describe proximity rather than invocation, and M139's unresolved
 * "potential callers" are explicitly not canonical edges — using either here
 * would make a rescued path claim a static guarantee the index cannot back.
 */
export function rescueUpstreamCandidates(input: {
  readonly db: Database;
  readonly seeds: readonly UpstreamRescueSeed[];
  readonly intent: DerivedQueryIntent;
  /** Symbols already in the pool; never re-admitted, and cycle-safe. */
  readonly existingSymbolIds: ReadonlySet<SymbolId>;
  readonly options?: UpstreamRescueOptions;
  readonly activationReason?: string;
}): UpstreamRescueResult {
  const started = performance.now();
  const options = input.options ?? {};
  const maxDepth = clamp(options.maxDepth ?? UPSTREAM_RESCUE_DEFAULTS.maxDepth, 1, 2);
  const perSeedAdmit = Math.max(0, options.maxUpstreamCandidatesPerSeed ?? UPSTREAM_RESCUE_DEFAULTS.maxUpstreamCandidatesPerSeed);
  const globalCap = Math.max(0, options.maxUpstreamRescueCandidates ?? UPSTREAM_RESCUE_DEFAULTS.maxUpstreamRescueCandidates);
  const edgeLimit = Math.max(1, options.maxIncomingEdgesPerSeed ?? UPSTREAM_RESCUE_DEFAULTS.maxIncomingEdgesPerSeed);
  const minMatched = Math.max(0, options.minMatchedQueryTerms ?? UPSTREAM_RESCUE_DEFAULTS.minMatchedQueryTerms);
  const minRelative = options.minRelativeRelevance ?? UPSTREAM_RESCUE_DEFAULTS.minRelativeRelevance;

  const queryTerms = new Set<string>([...input.intent.positiveTerms, ...input.intent.branchTerms]);
  const limitReached = new Set<string>();
  const perSeed: Array<{
    fqName: string;
    incomingCallersTotal: number;
    incomingCallersExamined: number;
    callersAdmitted: number;
    limitReached: boolean;
  }> = [];

  const pending = new Map<SymbolId, Pending>();
  // Two distinct sets, because "do not rescue this" and "do not walk through this
  // again" are different rules. Conflating them loses cross-seed corroboration:
  // an orchestrator reached from a second seed would be dropped as "seen" instead
  // of recorded as reached twice.
  //
  // `blocked`  — never admissible as a rescue: the seeds themselves.
  // `expanded` — already had its own callers walked; revisiting would loop.
  //              `A -> B -> C -> A` terminates here rather than by depth.
  const blocked = new Set<SymbolId>(input.seeds.map((seed) => seed.symbolId));
  const expanded = new Set<SymbolId>(input.seeds.map((seed) => seed.symbolId));
  const seedFqBySymbolId = new Map(input.seeds.map((seed) => [seed.symbolId, seed.fqName]));

  let incomingEdgesExamined = 0;
  let incomingEdgesAvailable = 0;
  let dbQueries = 0;
  let maxDepthReached = 0;
  let traversalMs = 0;
  let scoringMs = 0;

  // The frontier carries, for each node, the seeds it descends from and the path
  // back to the nearest one, so depth-2 evidence stays attributable.
  let frontier: Array<{ symbolId: SymbolId; seedSymbolIds: Set<SymbolId>; path: string[] }> =
    input.seeds.map((seed) => ({
      symbolId: seed.symbolId,
      seedSymbolIds: new Set([seed.symbolId]),
      path: [seed.fqName],
    }));

  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && pending.size < globalCap; depth += 1) {
    const traversalStarted = performance.now();
    const frontierIds = frontier.map((entry) => entry.symbolId);

    // ONE batched, DB-capped adjacency query per level (§74/§75) — never one per
    // node, and never one per rescued candidate.
    const available = countIncomingEdgesOfTypeForSymbols(input.db, frontierIds, EdgeType.Calls);
    const edges = listIncomingEdgesOfTypeForSymbols(input.db, frontierIds, EdgeType.Calls, edgeLimit);
    dbQueries += 2;
    incomingEdgesExamined += edges.length;
    traversalMs += performance.now() - traversalStarted;

    const callerIdsByTarget = new Map<SymbolId, SymbolId[]>();
    for (const edge of edges) {
      const bucket = callerIdsByTarget.get(edge.dstSymbolId);
      if (bucket === undefined) {
        callerIdsByTarget.set(edge.dstSymbolId, [edge.srcSymbolId]);
      } else {
        bucket.push(edge.srcSymbolId);
      }
    }

    // One batched hydration for the whole level. No source is read at any point.
    const hydrationStarted = performance.now();
    const symbolsById = getSymbolsByIds(input.db, [...new Set(edges.map((edge) => edge.srcSymbolId))]);
    dbQueries += 1;
    traversalMs += performance.now() - hydrationStarted;

    const scoringStarted = performance.now();
    const nextFrontier: typeof frontier = [];

    for (const node of frontier) {
      const callerIds = [...new Set(callerIdsByTarget.get(node.symbolId) ?? [])];
      const total = available.get(node.symbolId) ?? 0;
      if (depth === 1) {
        incomingEdgesAvailable += total;
      }
      const capped = total > callerIds.length;
      if (capped) {
        limitReached.add("maxIncomingEdgesPerSeed");
      }

      const callers = callerIds
        .map((id) => symbolsById.get(id))
        .filter((symbol): symbol is SymbolRecord => symbol !== undefined)
        // A <module> is a graph bridge, never an answer (§14). It is dropped as a
        // CANDIDATE here; the A6 capsule backstop remains the final guarantee.
        .filter((symbol) => !isStructuralSymbolKind(symbol.kind))
        .filter((symbol) => !isLikelyTestCandidate(symbol))
        .filter((symbol) => !blocked.has(symbol.id) && !input.existingSymbolIds.has(symbol.id));

      // ADMISSION ordering only. idf is computed across exactly the callers of
      // this node, so a term they all share ("species" among ARC's 62) cannot
      // carry one of them. The resulting number is relative to THIS pool, which
      // is why it decides who gets in but never the final cross-seed ranking.
      const bm25 = computeBm25Scores(input.intent.positiveSearchText, callers.map(rescueDocument));
      const best = Math.max(0, ...callers.map((symbol) => bm25.get(symbol.id) ?? 0));

      const admissible = callers
        .map((symbol) => {
          const raw = bm25.get(symbol.id) ?? 0;
          return {
            symbol,
            poolRelevance: best === 0 ? 0 : round(raw / best),
            matchedTerms: matchedQueryTerms(symbol, queryTerms),
          };
        })
        .filter((entry) => entry.matchedTerms.length >= minMatched && entry.poolRelevance >= minRelative)
        .sort((left, right) =>
          right.poolRelevance - left.poolRelevance
          // Deterministic tie-breaks: never SQLite row order or Map insertion (§77).
          || left.symbol.fqName.localeCompare(right.symbol.fqName)
          || left.symbol.id.localeCompare(right.symbol.id));

      if (admissible.length > perSeedAdmit) {
        limitReached.add("maxUpstreamCandidatesPerSeed");
      }
      const admitted = admissible.slice(0, perSeedAdmit);

      if (depth === 1) {
        perSeed.push({
          fqName: seedFqBySymbolId.get(node.symbolId) ?? node.symbolId,
          incomingCallersTotal: total,
          incomingCallersExamined: callerIds.length,
          callersAdmitted: admitted.length,
          limitReached: capped,
        });
      }

      for (const entry of admitted) {
        maxDepthReached = Math.max(maxDepthReached, depth);
        const path = [entry.symbol.fqName, ...node.path];
        const existing = pending.get(entry.symbol.id);
        if (existing === undefined) {
          pending.set(entry.symbol.id, {
            symbol: entry.symbol,
            depth,
            relevance: 0,
            matchedTerms: entry.matchedTerms,
            seedSymbolIds: new Set(node.seedSymbolIds),
            path,
          });
        } else {
          // Same symbol, another route: keep the closest path and record the
          // extra seed, rather than accumulating evidence per path (§26).
          for (const seed of node.seedSymbolIds) {
            existing.seedSymbolIds.add(seed);
          }
          if (depth < existing.depth) {
            existing.depth = depth;
            existing.matchedTerms = entry.matchedTerms;
            existing.path = path;
          }
        }
        // Walk through a rescued node only the first time it is reached.
        if (!expanded.has(entry.symbol.id)) {
          expanded.add(entry.symbol.id);
          nextFrontier.push({
            symbolId: entry.symbol.id,
            seedSymbolIds: new Set(node.seedSymbolIds),
            path,
          });
        }
      }
    }

    scoringMs += performance.now() - scoringStarted;
    frontier = nextFrontier;
  }

  // Score the rescued set against the original query as ONE pool.
  //
  // The per-level numbers above are relative to a single seed's callers, so the
  // best caller of every seed ties at 1.0 no matter how relevant it actually is.
  // Ranking the global cap on those would let the top caller of a weakly-related
  // seed displace the genuine orchestration entry point. Re-scoring the survivors
  // against each other — the union is exactly the set in contention for the cap —
  // is what makes depth-1 and depth-2 candidates comparable at all.
  const scoringPassStarted = performance.now();
  const survivors = [...pending.values()];
  const globalBm25 = computeBm25Scores(
    input.intent.positiveSearchText,
    survivors.map((entry) => rescueDocument(entry.symbol)),
  );
  const bestGlobal = Math.max(0, ...survivors.map((entry) => globalBm25.get(entry.symbol.id) ?? 0));
  for (const entry of survivors) {
    entry.relevance = bestGlobal === 0
      ? 0
      : round((globalBm25.get(entry.symbol.id) ?? 0) / bestGlobal);
  }
  scoringMs += performance.now() - scoringPassStarted;

  const scored = survivors
    .map((entry) => {
      const depthFactor = DEPTH_FACTOR[entry.depth] ?? 0.8;
      const multiSeed = Math.min(MULTI_SEED_BONUS_CAP, MULTI_SEED_BONUS * (entry.seedSymbolIds.size - 1));
      const rescueScore = round(Math.min(
        RESCUE_SCORE_CAP,
        RESCUE_WEIGHT * depthFactor * entry.relevance + multiSeed,
      ));
      const seedNames = [...entry.seedSymbolIds]
        .map((id) => seedFqBySymbolId.get(id) ?? id)
        .sort();
      return {
        symbol: entry.symbol,
        depth: entry.depth,
        relevance: entry.relevance,
        rescueScore,
        seedSymbolIds: [...entry.seedSymbolIds].sort(),
        seedFqNames: seedNames,
        path: entry.path,
        matchedTerms: entry.matchedTerms,
        // Truthful attribution (§31): says "caller of", never "matched the query
        // directly". The terms it DID match are named separately.
        reason: `rescued upstream caller (incoming call depth ${entry.depth}) of ${seedNames.join(", ")}`
          + `; independently matches ${entry.matchedTerms.slice(0, 6).join(", ")}`,
      } satisfies RescuedUpstreamCandidate;
    })
    .sort((left, right) =>
      // Closer orchestration wins on equal relevance, but a strongly-matching
      // depth-2 entry point still outranks a barely-relevant depth-1 caller (§32).
      right.rescueScore - left.rescueScore
      || left.depth - right.depth
      || left.symbol.fqName.localeCompare(right.symbol.fqName)
      || left.symbol.id.localeCompare(right.symbol.id));

  if (scored.length > globalCap) {
    limitReached.add("maxUpstreamRescueCandidates");
  }
  const candidates = scored.slice(0, globalCap);

  return {
    candidates,
    diagnostics: {
      activated: true,
      ...(input.activationReason === undefined ? {} : { activationReason: input.activationReason }),
      seeds: input.seeds,
      incomingEdgesExamined,
      incomingEdgesAvailable,
      rescuedCandidatesAdmitted: candidates.length,
      rescuedCandidatesScored: scored.length,
      maxDepthReached,
      limitReached: [...limitReached].sort(),
      dbQueries,
      timingsMs: {
        seedSelection: 0,
        incomingTraversal: round(traversalMs),
        rescueScoring: round(scoringMs),
        total: round(performance.now() - started),
      },
      perSeed,
    },
  };
}

/** The diagnostics shape for a request where the lane never ran. */
export function inactiveUpstreamRescue(suppressedBy: string): UpstreamRescueDiagnostics {
  return {
    activated: false,
    suppressedBy,
    seeds: [],
    incomingEdgesExamined: 0,
    incomingEdgesAvailable: 0,
    rescuedCandidatesAdmitted: 0,
    rescuedCandidatesScored: 0,
    maxDepthReached: 0,
    limitReached: [],
    dbQueries: 0,
    timingsMs: { seedSelection: 0, incomingTraversal: 0, rescueScoring: 0, total: 0 },
    perSeed: [],
  };
}
