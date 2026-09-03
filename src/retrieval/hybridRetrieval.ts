// Hybrid graph-expanded retrieval.
//
// The legacy path is: lexical candidates -> intra-pool graph rerank. Its
// weakness (per the tooling audit) is that the rerank can only reshuffle what
// lexical search already found — it can never PULL IN an implementation target
// that lexical search missed. This orchestrator fixes that by treating retrieval
// as a UNION of independent candidate sources:
//
//   lexical candidates            (FTS5 + heuristic ranking)
//   + symbol/path candidates      (likely symbols / likely files from shaping)
//   + failing-test candidates     (test imports/calls/references -> impl)
//   + graph-expanded neighbours   (bounded BFS over the relationship graph)
//   + centrality/rerank           (in-degree boost among the working set)
//   -> compact, target-ranked candidates with a full score breakdown + evidence
//
// Every candidate reports WHY it was selected: a normalised component score for
// each signal, the final weighted score, and human-readable evidence lines.

import type { Database } from "bun:sqlite";

import { getSymbolById, listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { isStructuralSymbolKind } from "../domain/types";
import type { SymbolId, SymbolKind, SymbolRecord } from "../domain/types";
import { expandTestsToImplementation } from "../capsule/testToImplementation";
import type { ShapedSweQuery } from "../capsule/sweQueryShaping";
import {
  computeInDegreeCentrality,
  expandGraphCandidates,
  ExpansionRelation,
  type ExpandedCandidate,
  type GraphExpansionOptions,
} from "./graphExpansion";
import {
  analyzeLexicalGenericMatch,
  blendLexical,
  classifyLexicalQueryTokens,
  combineFinalScore,
  computeBm25Scores,
  computeDomainRaw,
  evaluateActionability,
  evaluateHub,
  gateCentralityOnRelevance,
  HYBRID_SCORE_WEIGHTS,
  normalizeAgainst,
  tokenize,
  type Bm25Document,
  type HybridScoreComponents,
  type HybridScoreWeights,
} from "./hybridScoring";
import { searchSymbols } from "./searchSymbols";
import { normalizeMaxResults, rankSearchCandidates } from "./searchSymbolsShared";
import type { SymbolSearchMatch } from "./types";
import { searchBodyLiterals } from "../db/repositories/bodyLiteralsRepository";
import { extractBodyLiterals, type BodyLiteral } from "../indexer/extractBodyLiterals";
import { GENERIC_TOKEN_STOPLIST } from "../capsule/sweQueryShaping";
import {
  deriveQueryIntent,
  evaluateCandidateContrast,
  evaluateDirectAnswer,
  evaluateOrchestrationIntent,
  exactSymbolEligibleTerms,
  identifierConfidenceForSymbol,
  type DerivedQueryIntent,
  type IdentifierConfidence,
} from "./querySemantics";
import {
  inactiveConceptOwner,
  retrieveConceptOwners,
  type ConceptOwnerDiagnostics,
  type ConceptOwnerOptions,
  type ConceptOwnerResult,
} from "./conceptOwnerRetrieval";
import {
  deriveBehavioralObjective,
  hasBehavioralOperation,
  type BehavioralObjective,
  type BehavioralObjectiveResult,
} from "./behavioralObjective";
import {
  inactiveOperationRoles,
  resolveOperationRoles,
  type OperationRoleDiagnostics,
} from "./operationRole";
import {
  evaluateMechanismEvidence,
  mechanismEvidenceReason,
  type MechanismEvidence,
} from "./mechanismEvidence";
import { loadMechanismFactsFor } from "../db/repositories/mechanismFactsRepository";
import {
  generateOperationFactCandidates,
  inactiveOperationFacts,
  type OperationFactResult,
} from "./operationFactCandidates";
import type { MechanismFact } from "../indexer/extractMechanismFacts";
import {
  inactiveUpstreamRescue,
  rescueUpstreamCandidates,
  selectUpstreamRescueSeeds,
  type RescuedUpstreamCandidate,
  type UpstreamRescueDiagnostics,
  type UpstreamRescueOptions,
} from "./upstreamRescue";

export enum HybridCandidateSource {
  Lexical = "lexical",
  Symbol = "symbol",
  Path = "path",
  /** Reached because a failing TEST METHOD (test_*) calls/asserts it. */
  FailingTest = "failing_test",
  /** Reached because a failing test FILE imports it (test -> implementation). */
  TestToImpl = "test_to_impl",
  Graph = "graph",
  /** A same-package sibling of an in-pool symbol (no edge required). */
  SameModule = "same_module",
  /** Reached because a distinctive literal in the task appears in this symbol's body. */
  BodyLiteral = "body_literal",
  /** Reached by walking incoming `calls` edges up from a strong seed (M140-B). */
  UpstreamRescue = "upstream_rescue",
  /** Reached because its FILE aggregates the behaviour the request describes (M142-C). */
  ConceptOwner = "concept_owner",
  /**
   * Reached because an indexed mechanism fact says this definition performs the
   * OPERATION the request asked about, on the subject it asked about (M150).
   * Kept as its own source so a behaviourally-found candidate is never mistaken
   * for a lexical hit in diagnostics.
   */
  OperationFact = "operation_fact",
}

export interface HybridCandidate {
  symbolId: SymbolId;
  filePath: string;
  fqName: string;
  localName: string;
  kind: SymbolKind;
  scores: HybridScoreComponents;
  sources: HybridCandidateSource[];
  evidence: string[];
  matches: SymbolSearchMatch[];
  /** Contextual confidence of an exact local-name reading of task text. */
  identifierConfidence?: IdentifierConfidence;
}

export interface HybridRetrievalInput {
  query: string;
  shaped: ShapedSweQuery;
  /**
   * Extra symbol-name seeds to resolve against the index, beyond
   * `shaped.likelySymbols`. Callers that derive richer seeds (e.g. SWE micro
   * recovery stripping a Test/TestCase affix to recover the subject under test)
   * pass them here so those names enter the pool as symbol candidates.
   */
  symbolSeeds?: readonly string[];
  maxResults?: number;
  lexicalPoolSize?: number;
  expansion?: GraphExpansionOptions;
  weights?: HybridScoreWeights;
  /**
   * Full task prose for body-literal extraction. The shaped `query` is a compact
   * signal-first string that may drop a diagnostic literal the body-literal search
   * relies on; when the raw task is supplied it is used for literal extraction.
   * Falls back to `query` when absent.
   */
  taskText?: string;
  /** M123 no-candidate fallback: use M121 bounded compound/exact FTS admission. */
  enableCompoundTaskRescue?: boolean;
  /**
   * M140-B bounded upstream orchestration rescue. On by default; the lane gates
   * itself on orchestration-shaped intent, so an ordinary lookup pays only the
   * (already-derived) intent check. Set false to disable it outright.
   */
  enableUpstreamRescue?: boolean;
  upstreamRescue?: UpstreamRescueOptions;
  /**
   * M142-C behavioural concept-owner rescue. On by default; the lane gates itself
   * on behavioural-objective density, so an explicit lookup pays only the
   * (already-derived) intent check. Set false to disable it outright.
   */
  enableConceptOwnerRetrieval?: boolean;
  conceptOwner?: ConceptOwnerOptions;
  /** Optional request-local profiler. Omitted on product paths unless explicitly requested. */
  profile?: HybridRetrievalProfile;
  requestCache?: HybridRetrievalRequestCache;
}

export interface HybridRetrievalRequestCache {
  broadCandidates: Map<string, unknown>;
}

export function createHybridRetrievalRequestCache(): HybridRetrievalRequestCache {
  return { broadCandidates: new Map() };
}

export interface HybridRetrievalProfile {
  timingsMs: Record<string, number>;
  counters: Record<string, number>;
}

export function createHybridRetrievalProfile(): HybridRetrievalProfile {
  return { timingsMs: {}, counters: {} };
}

// A distinctive task literal that recovered a symbol from its source body.
export interface BodyLiteralMatch {
  /** The literal as it appeared in the task (e.g. "models.E015"). */
  readonly literal: string;
  readonly path: string;
  readonly symbol: string;
}

/**
 * One symbol the M140-B rescue lane reached, paired with the ordinary ranking it
 * actually earned (M140-C).
 *
 * Retrieval returns a CAPPED pool, so "absent from `candidates`" conflates two
 * very different outcomes: the lane never reached the symbol, or it reached and
 * scored it and the cap cut it. Selection needs the second case — a weakly
 * lexical orchestration entry point is by construction far down the ranking — so
 * the lane's findings are reported alongside the cap rather than through it.
 *
 * `ordinaryRank`/`ordinaryScore` are the truthful ranking numbers and are NEVER
 * adjusted to make selection easier: a downstream selector may give such a
 * candidate a bounded support slot, but it may not pretend the candidate is a
 * stronger direct match than it is.
 */
export interface OrchestrationPathCandidate {
  readonly candidate: HybridCandidate;
  /** 1-based position in the FULL ranked pool, before the output cap. */
  readonly ordinaryRank: number;
  readonly ordinaryScore: number;
  /** True when the ordinary ranking alone already returned it. */
  readonly withinPool: boolean;
  /** Incoming exact-`calls` hops from the nearest seed. */
  readonly depth: number;
  /** `candidate -> ... -> seed`, all exact `calls` edges. */
  readonly path: readonly string[];
  /** Every seed reached; at depth 1, exactly the seeds called directly. */
  readonly seedFqNames: readonly string[];
  readonly relevance: number;
  readonly rescueScore: number;
  readonly matchedTerms: readonly string[];
  readonly reason: string;
}

export interface HybridRetrievalResult {
  candidates: HybridCandidate[];
  /** Body-literal recoveries this run made, for diagnostics. */
  bodyLiteralMatches: BodyLiteralMatch[];
  /** What the upstream orchestration rescue lane did, including "nothing". */
  upstreamRescue: UpstreamRescueDiagnostics;
  /** What the behavioural concept-owner lane did, including "nothing". */
  conceptOwner: ConceptOwnerDiagnostics;
  /** What the operation-fact candidate lane admitted, refused, and why (M150). */
  operationFactCandidates: OperationFactResult;
  /** How each candidate stands to the requested operation, and any corrections. */
  operationRoles: OperationRoleDiagnostics;
  /**
   * Every rescued symbol with its ordinary rank, including the ones the output
   * cap excluded. Empty whenever the lane did not activate.
   */
  orchestrationPaths: readonly OrchestrationPathCandidate[];
  /**
   * Every candidate retrieval SCORED, including those the output cap excluded.
   *
   * Downstream anchor lanes inject a synthesized candidate for a symbol they
   * cannot find in `candidates`. Absence from the capped pool has two very
   * different causes — never retrieved at all, or retrieved, scored and ranked
   * out — and treating them alike lets a symbol that lost on its own evidence
   * re-enter at a synthesized score far above the one it earned. Holding the
   * scored candidates lets a lane re-admit the real scorecard instead.
   */
  evaluatedById: ReadonlyMap<string, HybridCandidate>;
  /** What operation the request asked about, or why none was derived (M150-B). */
  behavioralObjective: BehavioralObjectiveResult;
  /**
   * Mechanism evidence per scored candidate, including the withheld ones. A
   * downstream selector needs the MATCHES (which statement, at which line) to
   * deliver a slice, and needs the withheld reasons to explain a candidate that
   * carries a mechanism but earned nothing for it.
   */
  mechanismEvidenceById: ReadonlyMap<string, MechanismEvidence>;
}

const DEFAULTS = Object.freeze({
  maxResults: 6,
  lexicalPoolMinimum: 20,
  lexicalPoolMultiplier: 4,
  symbolPoolSize: 6,
});

/**
 * The lexical lane's row budget when the caller does not name one: four rows
 * for every candidate the pool may return, never fewer than twenty. Exported so
 * a caller that varies the pool width can hold the lexical universe — and with
 * it every BM25/normalisation-dependent score — at the value the product uses.
 */
export function lexicalPoolSizeFor(maxResults: number): number {
  return Math.max(DEFAULTS.lexicalPoolMinimum, maxResults * DEFAULTS.lexicalPoolMultiplier);
}

// Raw (un-normalised) per-signal accumulation for one candidate.
interface RawCandidate {
  symbol: SymbolRecord;
  fts: number;
  matches: SymbolSearchMatch[];
  graph: number;
  /** Raw test-to-implementation strength (failing-test routing). */
  testToImpl: number;
  /** Raw body-literal strength (distinctive task literal found in this body). */
  bodyLiteral: number;
  /** Bounded upstream-orchestration evidence; already capped by the lane. */
  upstreamRescue: number;
  /** Bounded concept-owner evidence; already capped by the lane. */
  conceptOwner: number;
  sources: Set<HybridCandidateSource>;
  evidence: Set<string>;
}

const ROUND = 1e4;
const round = (value: number): number => Math.round(value * ROUND) / ROUND;

export function hybridRetrieve(
  db: Database,
  input: HybridRetrievalInput,
): HybridRetrievalResult {
  const totalStarted = input.profile === undefined ? 0 : performance.now();
  const maxResults = normalizeMaxResults(input.maxResults ?? DEFAULTS.maxResults);
  if (maxResults === 0) {
    return {
      candidates: [],
      bodyLiteralMatches: [],
      upstreamRescue: inactiveUpstreamRescue("no results requested"),
      conceptOwner: inactiveConceptOwner("no results requested"),
      orchestrationPaths: [],
      evaluatedById: new Map(),
      behavioralObjective: { operation: null, suppressedBy: "no results requested", considered: [] },
      operationFactCandidates: inactiveOperationFacts("no results requested"),
      mechanismEvidenceById: new Map(),
    operationRoles: inactiveOperationRoles("retrieval produced no candidates").diagnostics,
    };
  }
  const lexicalPoolSize = input.lexicalPoolSize ?? lexicalPoolSizeFor(maxResults);

  const raw = new Map<SymbolId, RawCandidate>();

  // The request grammar is derived ONCE, before any generator runs: the lexical
  // lane needs it to decide which task terms may claim an exact symbol-name
  // reading (M142 §10), and the scoring pass needs the same value. Deriving it
  // twice would let the two disagree.
  const derivedIntent = input.shaped.derivedIntent
    ?? deriveQueryIntent(input.taskText ?? input.query);
  const exactNameEligible = exactSymbolEligibleTerms(derivedIntent);
  // The requested OPERATION, derived once from the same grammar for the same
  // reason: the scoring pass and the diagnostics must not be able to disagree
  // about what the request asked for.
  const behavioralObjective = deriveBehavioralObjective(derivedIntent);
  const mechanismEvidenceById = new Map<string, MechanismEvidence>();
  const roleOut = {
    diagnostics: inactiveOperationRoles("retrieval produced no candidates").diagnostics,
  };

  // Retrieval is a UNION of independent candidate generators. Each emits the
  // SAME structured candidate (file/symbol identity + source + evidence) and a
  // candidate surfaced by several generators merges, accumulating every source
  // and evidence line. The first four seed the pool from the query; the last two
  // expand it to neighbours the query alone could never have named.
  timed(input.profile, "lexical.symbol_search", () =>
    lexicalCandidates(db, input, lexicalPoolSize, raw, exactNameEligible));
  count(input.profile, "symbols.after_lexical", raw.size);
  timed(input.profile, "lexical.symbol_path", () =>
    symbolPathCandidates(db, input, raw));
  count(input.profile, "symbols.after_symbol_path", raw.size);
  timed(input.profile, "structural.test_import_reference", () =>
    failingTestCandidates(db, input, raw));
  count(input.profile, "symbols.after_test_expansion", raw.size);
  // Body-literal recovery: a distinctive literal cited in the task (a diagnostic
  // code, a quoted message) found in a symbol's SOURCE BODY — the one signal that
  // reaches a symbol named purely by what it emits, invisible to name/path search.
  const bodyLiteralMatches = timed(input.profile, "lexical.body_literal", () =>
    bodyLiteralCandidates(db, input, raw));
  count(input.profile, "body_literal_matches", bodyLiteralMatches.length);
  // The operation-fact lane. It runs with the query-side generators rather than
  // with the rescue lanes because what it produces is an ORDINARY candidate: a
  // definition the request is genuinely about, found through indexed behaviour
  // instead of through its name. Placed before graph expansion so an admitted
  // definition can seed neighbours like any other candidate.
  const operationFacts = timed(input.profile, "lexical.operation_facts", () =>
    hasBehavioralOperation(behavioralObjective)
      ? generateOperationFactCandidates(db, behavioralObjective)
      : inactiveOperationFacts("request declares no behavioural operation"));
  for (const admitted of operationFacts.candidates) {
    const entry = ensureCandidate(db, raw, admitted.symbol.id, admitted.symbol);
    if (entry === undefined) continue;
    entry.sources.add(HybridCandidateSource.OperationFact);
    entry.evidence.add(admitted.reason);
    // Score its LEXICAL evidence with the same function the lexical lane uses.
    //
    // A candidate admitted here would otherwise carry `fts = 0` and be judged as
    // if it had no name match at all — not because it lacks one, but because a
    // different lane found it first. Measured on ARC: `get_all_families` on a
    // request naming `families` was scored as though the word never appeared in
    // its name. That is an artifact of lane order, not a ranking judgement, and
    // removing it is not the same as boosting the candidate: the score is
    // whatever `rankSearchCandidates` says it is, which for an unrelated
    // definition is still nothing.
    const [scored] = rankSearchCandidates(
      [{
        symbol_id: admitted.symbol.id,
        file_path: admitted.symbol.filePath,
        fq_name: admitted.symbol.fqName,
        local_name: admitted.symbol.localName,
        kind: admitted.symbol.kind,
        signature: admitted.symbol.signature,
        docstring: admitted.symbol.docstring ?? null,
      }],
      input.query,
      1,
    );
    if (scored !== undefined) {
      entry.fts = Math.max(entry.fts, scored.score);
      if (entry.matches.length === 0) entry.matches = scored.matches;
    }
  }
  count(input.profile, "operation_fact_candidates", operationFacts.diagnostics.candidatesAdmitted);
  count(input.profile, "operation_fact_owners_examined", operationFacts.diagnostics.ownersExamined);

  // Graph + same-module expansion run over EVERYTHING the query-side generators
  // surfaced, so they can pull in a target lexical search missed.
  const seeds = [...raw.keys()];
  count(input.profile, "graph_seed_symbols", seeds.length);
  timed(input.profile, "structural.graph_expansion", () =>
    graphExpandedCandidates(db, input, seeds, raw));
  count(input.profile, "symbols.before_scoring", raw.size);

  // Upstream orchestration rescue needs RANKED candidates to choose seeds from,
  // so it runs between two scoring passes. The first pass is only a ranking; the
  // second is authoritative and scores rescued and ordinary candidates together
  // under one normalisation, which is what keeps rescued content inside the
  // normal selection/budget path rather than beside it.
  let ranked = timed(input.profile, "candidate_processing.score_sort_cap", () =>
    assemble(db, raw, input, derivedIntent, behavioralObjective, mechanismEvidenceById, roleOut));
  const upstreamRescue = timed(input.profile, "structural.upstream_rescue", () =>
    upstreamRescueCandidates(db, input, derivedIntent, ranked, raw));
  // Concept-owner rescue needs the RANKING too, for a different reason: "the pool
  // already covers this file" has to mean the DELIVERABLE pool. The raw map holds
  // hundreds of graph-expanded symbols, so judged against it almost every good
  // owner counts as represented — measured on ARC, 31 of them, including the file
  // the request was actually about.
  const conceptOwner = timed(input.profile, "lexical.concept_owner", () =>
    conceptOwnerCandidates(db, input, derivedIntent, ranked.slice(0, maxResults), raw));
  count(input.profile, "conceptOwnerCandidates", conceptOwner.diagnostics.candidatesAdmitted);
  count(input.profile, "conceptOwnerFilesExamined", conceptOwner.diagnostics.filesExamined);
  count(input.profile, "sourceReads", conceptOwner.diagnostics.sourceReads);
  if (
    upstreamRescue.diagnostics.rescuedCandidatesAdmitted > 0
    || conceptOwner.diagnostics.candidatesAdmitted > 0
  ) {
    ranked = timed(input.profile, "candidate_processing.score_sort_cap", () =>
      assemble(db, raw, input, derivedIntent, behavioralObjective, mechanismEvidenceById, roleOut));
  }
  count(input.profile, "upstream_rescue_seeds", upstreamRescue.diagnostics.seeds.length);
  count(input.profile, "upstream_rescue_candidates", upstreamRescue.diagnostics.rescuedCandidatesAdmitted);
  count(input.profile, "upstream_rescue_edges_examined", upstreamRescue.diagnostics.incomingEdgesExamined);

  const candidates = admitBoundedLanesBesideCap(ranked, maxResults, [
    ...conceptOwner.candidates.map((admitted) => admitted.symbol.id),
    ...operationFacts.candidates.map((admitted) => admitted.symbol.id),
  ]);
  count(input.profile, "candidates.after_cap", candidates.length);
  count(input.profile, "literal_symbol_candidates", candidates.filter((candidate) =>
    candidate.sources.includes(HybridCandidateSource.Symbol)).length);
  count(input.profile, "high_confidence_literal_candidates", candidates.filter((candidate) =>
    candidate.sources.includes(HybridCandidateSource.Symbol)
    && candidate.identifierConfidence === "explicit_identifier").length);
  count(input.profile, "weak_short_token_candidates", candidates.filter((candidate) =>
    candidate.identifierConfidence === "ordinary_prose"
    || candidate.identifierConfidence === "weak_short_literal").length);
  if (input.profile !== undefined) {
    input.profile.timingsMs.total =
      (input.profile.timingsMs.total ?? 0) + performance.now() - totalStarted;
  }
  // Pair each rescued symbol with the rank it earned in the FULL pool. This is a
  // read of results already computed — no traversal, no DB query, no source read.
  const rankBySymbolId = new Map(ranked.map((candidate, index) => [candidate.symbolId, index]));
  const orchestrationPaths: OrchestrationPathCandidate[] = [];
  for (const rescued of upstreamRescue.candidates) {
    const index = rankBySymbolId.get(rescued.symbol.id);
    if (index === undefined) {
      continue;
    }
    const candidate = ranked[index]!;
    orchestrationPaths.push({
      candidate,
      ordinaryRank: index + 1,
      ordinaryScore: candidate.scores.final,
      withinPool: index < maxResults,
      depth: rescued.depth,
      path: rescued.path,
      seedFqNames: rescued.seedFqNames,
      relevance: rescued.relevance,
      rescueScore: rescued.rescueScore,
      matchedTerms: rescued.matchedTerms,
      reason: rescued.reason,
    });
  }

  return {
    candidates,
    bodyLiteralMatches,
    upstreamRescue: upstreamRescue.diagnostics,
    conceptOwner: conceptOwner.diagnostics,
    orchestrationPaths,
    evaluatedById: new Map(ranked.map((candidate) => [candidate.symbolId, candidate])),
    behavioralObjective,
    operationFactCandidates: operationFacts,
    mechanismEvidenceById,
    operationRoles: roleOut.diagnostics,
  };
}

// --- candidate generators -----------------------------------------------------
//
// Each generator MUTATES the shared raw-candidate pool (merging by symbol id) so
// a symbol reached by several routes keeps every source and evidence line. They
// are split out so the union is legible and individually testable.

// Lexical candidates from the shaped query (FTS5 + heuristic ranking).
function lexicalCandidates(
  db: Database,
  input: HybridRetrievalInput,
  poolSize: number,
  raw: Map<SymbolId, RawCandidate>,
  exactNameEligibleTerms: ReadonlySet<string>,
): void {
  const results = searchSymbols(db, {
    query: input.query,
    maxResults: poolSize,
    enableTestAwareDownweighting: true,
    enableCompoundTaskDecomposition: input.enableCompoundTaskRescue === true,
    enableExactIdentifierLane: input.enableCompoundTaskRescue === true,
    broadCandidateCache: input.requestCache?.broadCandidates,
    // The prose lane searches the TASK, so its terms are governed by the request
    // grammar. The per-symbol lane below deliberately does not pass this: its
    // query IS an identifier the caller already resolved.
    exactNameEligibleTerms,
  });
  increment(input.profile, "symbol_search_calls");
  increment(input.profile, "symbol_search_rows", results.length);
  for (const result of results) {
    const entry = ensureCandidate(db, raw, result.symbolId);
    if (entry === undefined) {
      continue;
    }
    entry.fts = Math.max(entry.fts, result.score);
    entry.matches = result.matches;
    entry.sources.add(HybridCandidateSource.Lexical);
    if (result.matches.length > 0) {
      entry.evidence.add(
        `lexical match on ${result.matches.map((m) => m.field).join(", ")}`,
      );
    }
  }
}

// Symbol candidates (each likely symbol / caller seed resolved against the index)
// and path candidates (every symbol in a likely edit file). Both seed the pool
// directly so a target enters even when the prose-level query under-ranked it.
function symbolPathCandidates(
  db: Database,
  input: HybridRetrievalInput,
  raw: Map<SymbolId, RawCandidate>,
): void {
  const symbolQueries = dedupeNonEmpty([
    ...(input.symbolSeeds ?? []),
    ...input.shaped.likelySymbols,
  ]);
  for (const symbolName of symbolQueries) {
    const results = searchSymbols(db, {
      query: symbolName,
      maxResults: DEFAULTS.symbolPoolSize,
      enableTestAwareDownweighting: true,
      broadCandidateCache: input.requestCache?.broadCandidates,
    });
    increment(input.profile, "symbol_search_calls");
    increment(input.profile, "symbol_search_rows", results.length);
    for (const result of results) {
      if (!nameRelated(result.localName, symbolName)) {
        continue;
      }
      const entry = ensureCandidate(db, raw, result.symbolId);
      if (entry === undefined) {
        continue;
      }
      entry.sources.add(HybridCandidateSource.Symbol);
      entry.evidence.add(`symbol name matches "${symbolName}"`);
    }
  }

  for (const file of input.shaped.likelyFiles) {
    const symbols = listSymbolsForFile(db, file);
    increment(input.profile, "path_symbol_queries");
    increment(input.profile, "path_symbol_rows", symbols.length);
    for (const symbol of symbols) {
      const entry = ensureCandidate(db, raw, symbol.id, symbol);
      if (entry === undefined) {
        continue;
      }
      entry.sources.add(HybridCandidateSource.Path);
      entry.evidence.add(`declared in likely edit file ${file}`);
    }
  }
}

function timed<T>(
  profile: HybridRetrievalProfile | undefined,
  name: string,
  operation: () => T,
): T {
  if (profile === undefined) {
    return operation();
  }
  const started = performance.now();
  try {
    return operation();
  } finally {
    profile.timingsMs[name] = (profile.timingsMs[name] ?? 0) + performance.now() - started;
  }
}

function increment(
  profile: HybridRetrievalProfile | undefined,
  name: string,
  delta = 1,
): void {
  if (profile !== undefined) {
    profile.counters[name] = (profile.counters[name] ?? 0) + delta;
  }
}

function count(
  profile: HybridRetrievalProfile | undefined,
  name: string,
  value: number,
): void {
  if (profile !== undefined) {
    profile.counters[name] = value;
  }
}

// Failing-test -> implementation candidates. The routing distinguishes two
// routes (Requirement 6): a module-level import from the test FILE
// (`test_to_impl`) and a call/reference from the test METHOD (`failing_test`).
// Both feed the dedicated `testToImpl` ranking signal — never `graph` — so a
// failing test's pull on the edit target is reported and weighted on its own.
function failingTestCandidates(
  db: Database,
  input: HybridRetrievalInput,
  raw: Map<SymbolId, RawCandidate>,
): void {
  const issueSymbols = dedupeNonEmpty([
    ...input.shaped.likelySymbols,
    ...input.shaped.identifiers,
  ]);
  for (const testImpl of expandTestsToImplementation(db, input.shaped, { issueSymbols })) {
    const entry = ensureCandidate(db, raw, testImpl.symbol.id, testImpl.symbol);
    if (entry === undefined) {
      continue;
    }
    if (testImpl.importedByTestFile) {
      entry.sources.add(HybridCandidateSource.TestToImpl);
    }
    if (testImpl.usedByTestMethod) {
      entry.sources.add(HybridCandidateSource.FailingTest);
    }
    // Default to the broad route when neither flag is set (older edge shapes).
    if (!testImpl.importedByTestFile && !testImpl.usedByTestMethod) {
      entry.sources.add(HybridCandidateSource.TestToImpl);
    }
    entry.testToImpl += testToImplRaw(testImpl.relations.length, testImpl.viaTestFiles.length, testImpl.usedByTestMethod);
    for (const line of testImpl.evidence) {
      entry.evidence.add(line);
    }
  }
}

// Raw body-literal strength per match. A code is the most precise (the bug names
// the exact diagnostic the symbol emits); a quoted message is medium/high.
const BODY_LITERAL_CODE_RAW = 1.0;
const BODY_LITERAL_MESSAGE_RAW = 0.7;
// A distinctive literal should resolve to very few symbols; cap defensively.
const BODY_LITERAL_POOL_SIZE = 10;

// Body-literal recovery. Extract the DISTINCTIVE literals from the task (diagnostic
// codes, quoted messages), search symbol bodies for each, and add the emitting
// symbol as a candidate. This is the only generator that reaches a symbol named
// purely by a literal it contains — invisible to name/signature/path search.
function bodyLiteralCandidates(
  db: Database,
  input: HybridRetrievalInput,
  raw: Map<SymbolId, RawCandidate>,
): BodyLiteralMatch[] {
  const literals = effectiveTaskLiterals(extractBodyLiterals(input.taskText ?? input.query));
  const matches: BodyLiteralMatch[] = [];
  const seen = new Set<string>();

  for (const literal of literals) {
    // Ordered candidate expressions: most precise first, a looser fallback next.
    // We use the FIRST expression that returns any hit, so a qualified code
    // (`models` AND `e015`) is preferred over the bare digit token (`e015`),
    // which alone would conflate `models.E015` with `admin.E015`.
    const exprs = bodyLiteralMatchExprs(literal);
    let rows: ReturnType<typeof searchBodyLiterals> = [];
    for (const expr of exprs) {
      try {
        rows = searchBodyLiterals(db, expr, BODY_LITERAL_POOL_SIZE);
      } catch {
        // A malformed FTS expression must never abort retrieval; try the next.
        rows = [];
      }
      if (rows.length > 0) {
        break;
      }
    }
    const rawStrength =
      literal.kind === "code" ? BODY_LITERAL_CODE_RAW : BODY_LITERAL_MESSAGE_RAW;
    for (const row of rows) {
      const entry = ensureCandidate(db, raw, row.symbol_id);
      if (entry === undefined) {
        continue;
      }
      entry.sources.add(HybridCandidateSource.BodyLiteral);
      entry.bodyLiteral += rawStrength;
      entry.evidence.add(`task literal \`${literal.text}\` appears in symbol body`);
      const key = `${row.symbol_id}::${literal.text.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push({ literal: literal.text, path: row.file_path, symbol: row.local_name });
      }
    }
  }
  return matches;
}

// Drop a bare code that is merely the last segment of a qualified one we also
// extracted (`E015` when `models.E015` is present), so the precise qualified form
// drives the search instead of the ambiguous bare token.
function effectiveTaskLiterals(literals: readonly BodyLiteral[]): BodyLiteral[] {
  const qualified = literals.filter((l) => l.kind === "code" && l.text.includes("."));
  return literals.filter((literal) => {
    if (literal.kind !== "code" || literal.text.includes(".")) {
      return true;
    }
    const bare = literal.text.toLowerCase();
    return !qualified.some((q) => q.text.toLowerCase().endsWith(`.${bare}`));
  });
}

// FTS5 MATCH expressions for a literal, MOST PRECISE first. Generic words never
// drive a search (filtered out), so a single common word can never match alone.
function bodyLiteralMatchExprs(literal: BodyLiteral): string[] {
  const terms = literal.text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  if (literal.kind === "code") {
    const distinctive = terms.filter((t) => t.length >= 2 && !GENERIC_TOKEN_STOPLIST.has(t));
    if (distinctive.length === 0) {
      return [];
    }
    const exprs: string[] = [];
    // Precise: require ALL tokens (`"models" AND "e015"`) — disambiguates codes that
    // share a number across namespaces (models.E015 vs admin.E015).
    if (distinctive.length >= 2) {
      exprs.push(distinctive.map((t) => `"${t}"`).join(" AND "));
    }
    // Fallback: the single digit-bearing token, for a body that emits the code
    // unqualified. Less precise, only used when the precise form found nothing.
    const digitTerm = distinctive.find((t) => /[0-9]/.test(t) && t.length >= 3);
    if (digitTerm !== undefined) {
      exprs.push(`"${digitTerm}"`);
    } else if (distinctive.length === 1) {
      exprs.push(`"${distinctive[0]}"`);
    }
    return exprs;
  }
  const words = terms.filter((t) => t.length >= 3 && !GENERIC_TOKEN_STOPLIST.has(t));
  // A message needs at least two distinctive words so no single generic word matches.
  return words.length >= 2 ? [words.map((t) => `"${t}"`).join(" AND ")] : [];
}

// Graph-expanded neighbours of the seed pool. Edge-based neighbours carry the
// `graph` source; same-package siblings (no edge) carry `same_module`. Both feed
// the `graph` proximity score — distinct from centrality (global in-degree).
function graphExpandedCandidates(
  db: Database,
  input: HybridRetrievalInput,
  seeds: readonly SymbolId[],
  raw: Map<SymbolId, RawCandidate>,
): void {
  for (const expanded of expandGraphCandidates(db, seeds, input.expansion)) {
    const entry = ensureCandidate(db, raw, expanded.symbol.id, expanded.symbol);
    if (entry === undefined) {
      continue;
    }
    const relations = new Set(expanded.evidence.map((item) => item.relation));
    const onlySameModule =
      relations.size === 1 && relations.has(ExpansionRelation.SameModule);
    entry.sources.add(
      onlySameModule ? HybridCandidateSource.SameModule : HybridCandidateSource.Graph,
    );
    // A neighbour reached BOTH by an edge and as a same-module sibling earns both.
    if (!onlySameModule && relations.has(ExpansionRelation.SameModule)) {
      entry.sources.add(HybridCandidateSource.SameModule);
    }
    entry.graph += expansionGraphRaw(expanded);
    for (const line of expansionEvidence(db, expanded)) {
      entry.evidence.add(line);
    }
  }
}

/**
 * Keep a BOUNDED LANE's findings inside the returned pool without inflating
 * their scores, and without evicting anything (M142-C).
 *
 * M153-C4 generalised this from the concept-owner lane to every lane of its
 * kind, because applying it to only one of them was the defect.
 *
 * The rule is a property of what a lane IS, not of which lane it happens to be:
 * a lane exists because ordinary ranking cannot see its findings, so subjecting
 * those findings to ordinary ranking's cap discards exactly what the lane was
 * built to recover. The operation-fact lane's own header states the premise
 * outright — the definition it admits is one that "no lexical, symbol, path or
 * domain signal reaches" — and it was nonetheless routed through the cap.
 *
 * Measured, paired, on the frozen corpus:
 *
 *   requests  Session.get_adapter  rank   1 / 96   final 2.44   delivered
 *   sphinx    get_filetype         rank 202 / 273  final 0.60   truncated
 *
 * Both were admitted by the lane; both were scored; only one survived the cut at
 * 60. The control survived it on `fts = 1` — a full lexical name match — which
 * means it never needed the lane at all, and the lane's containment had gone
 * unnoticed precisely because the case that exercised it was also the case that
 * did not depend on it.
 *
 * Nothing here changes a score. `get_filetype` enters the pool at the 0.60 it
 * earned and competes for the lead on that; what it no longer does is lose its
 * place to a cap it was structurally guaranteed to fail (§18, §19).
 *
 * A definition the request could not name is, by construction, weakly ranked —
 * that is why nothing found it. Measured on ARC: the recovered `arc/checks/nmd.py`
 * definitions score around 0.8 against a pool floor of ~1.4, so ranking alone
 * discards exactly the candidates the lane exists to recover. Raising the lane's
 * score contribution until it clears the floor would be tuning a constant to an
 * outcome, so its findings are admitted BESIDE the ranking rather than through it.
 *
 * They are not admitted at the ranking's EXPENSE. The first cut took the slots
 * from the weakest ordinary candidates, on the M140-C precedent. That is wrong
 * here, for a reason M140-C never faced: the output cap does not just decide what
 * is delivered, it decides the evidence base that later, rank-derived inferences
 * read. Evicting the tail silently rewrites those inferences.
 *
 * Measured on django-11815: four recoveries evicted four ranked candidates, two of
 * them from `db/migrations`, which moved that directory from 8 anchored candidates
 * to 6 against `contrib/auth/migrations`' 7 to 6 — an exact tie, broken
 * alphabetically, so `resolveLocalSubsystem` elected the wrong subsystem. The gold
 * lead `EnumSerializer` was then outside it, and `isGenericInfrastructure` demotes
 * an out-of-subsystem CLASS with no symbol/path/test pointer (the strong-lexical
 * exemption is function/method only). It fell from lead to support to discarded.
 *
 * So the cap bounds what ORDINARY RANKING returns, and a lane that exists because
 * ranking cannot see its findings does not compete for ranking's slots. The pool
 * is still bounded: each lane admits at most its own cap, so the overflow this
 * can add is `maxConceptOwnerCandidates + OPERATION_FACT_LIMITS.maxAdmitted`.
 */
function admitBoundedLanesBesideCap(
  ranked: readonly HybridCandidate[],
  maxResults: number,
  laneAdmittedIds: readonly SymbolId[],
): HybridCandidate[] {
  const capped = ranked.slice(0, maxResults);
  if (laneAdmittedIds.length === 0 || ranked.length <= maxResults) {
    return capped;
  }
  // `present` also absorbs each addition, so a definition admitted by two lanes
  // is carried across once rather than duplicated in the pool.
  const present = new Set(capped.map((candidate) => candidate.symbolId));
  const missing: HybridCandidate[] = [];
  for (const symbolId of laneAdmittedIds) {
    if (present.has(symbolId)) continue;
    const candidate = ranked.find((entry) => entry.symbolId === symbolId);
    if (candidate === undefined) continue;
    present.add(symbolId);
    missing.push(candidate);
  }
  if (missing.length === 0) {
    return capped;
  }
  return [...capped, ...missing].sort(
    (left, right) =>
      right.scores.final - left.scores.final
      || left.fqName.localeCompare(right.fqName)
      || left.symbolId.localeCompare(right.symbolId),
  );
}

// Concept-owner rescue (M142-C). Aggregates indexed evidence per FILE, picks the
// few files that appear to own the requested behaviour, and admits their
// strongest definitions. Files the pool already represents are skipped by the
// lane itself, so this can only ever ADD a candidate.
function conceptOwnerCandidates(
  db: Database,
  input: HybridRetrievalInput,
  intent: DerivedQueryIntent,
  deliverable: readonly HybridCandidate[],
  raw: Map<SymbolId, RawCandidate>,
): ConceptOwnerResult {
  if (input.enableConceptOwnerRetrieval === false) {
    return { candidates: [], diagnostics: inactiveConceptOwner("disabled by caller") };
  }
  const representedDefinitionsByFile = new Map<string, number>();
  for (const candidate of deliverable) {
    representedDefinitionsByFile.set(
      candidate.filePath,
      (representedDefinitionsByFile.get(candidate.filePath) ?? 0) + 1,
    );
  }

  const result = retrieveConceptOwners({
    db,
    intent,
    representedDefinitionsByFile,
    existingSymbolIds: new Set(raw.keys()),
    ...(input.conceptOwner === undefined ? {} : { options: input.conceptOwner }),
  });

  for (const admitted of result.candidates) {
    const entry = ensureCandidate(db, raw, admitted.symbol.id, admitted.symbol);
    if (entry === undefined) continue;
    entry.sources.add(HybridCandidateSource.ConceptOwner);
    entry.conceptOwner = Math.max(entry.conceptOwner, admitted.contribution);
    entry.evidence.add(admitted.reason);
  }
  return result;
}

// Upstream orchestration rescue. Unlike every other generator this one needs the
// pool already RANKED, because its whole premise is "expand upward from the few
// candidates we are most confident about". It merges its results into the same
// raw pool, so they are scored, capped and delivered like anything else.
function upstreamRescueCandidates(
  db: Database,
  input: HybridRetrievalInput,
  intent: DerivedQueryIntent,
  ranked: readonly HybridCandidate[],
  raw: Map<SymbolId, RawCandidate>,
): { candidates: readonly RescuedUpstreamCandidate[]; diagnostics: UpstreamRescueDiagnostics } {
  if (input.enableUpstreamRescue === false) {
    return { candidates: [], diagnostics: inactiveUpstreamRescue("disabled by caller") };
  }
  // The gate is a read of the already-derived intent, so a request that is not
  // orchestration-shaped does no extra graph work at all.
  const orchestration = evaluateOrchestrationIntent(intent);
  if (!orchestration.active) {
    return {
      candidates: [],
      diagnostics: inactiveUpstreamRescue(orchestration.suppressedBy ?? "not an orchestration question"),
    };
  }

  const seedStarted = performance.now();
  const seeds = selectUpstreamRescueSeeds(
    ranked.map((candidate) => ({
      symbolId: candidate.symbolId,
      fqName: candidate.fqName,
      localName: candidate.localName,
      filePath: candidate.filePath,
      kind: candidate.kind,
      final: candidate.scores.final,
    })),
    input.upstreamRescue ?? {},
  );
  const seedSelectionMs = Math.round((performance.now() - seedStarted) * 1e4) / 1e4;
  if (seeds.length === 0) {
    return {
      candidates: [],
      diagnostics: {
        ...inactiveUpstreamRescue("no eligible seed in the base ranking"),
        ...(orchestration.reason === undefined ? {} : { activationReason: orchestration.reason }),
      },
    };
  }

  const result = rescueUpstreamCandidates({
    db,
    seeds,
    intent,
    existingSymbolIds: new Set(raw.keys()),
    options: input.upstreamRescue ?? {},
    ...(orchestration.reason === undefined ? {} : { activationReason: orchestration.reason }),
  });

  for (const rescued of result.candidates) {
    const entry = ensureCandidate(db, raw, rescued.symbol.id, rescued.symbol);
    if (entry === undefined) {
      continue;
    }
    entry.sources.add(HybridCandidateSource.UpstreamRescue);
    entry.upstreamRescue = Math.max(entry.upstreamRescue, rescued.rescueScore);
    entry.evidence.add(rescued.reason);
    entry.evidence.add(`upstream call path: ${rescued.path.join(" -> ")}`);
  }

  return {
    candidates: result.candidates,
    diagnostics: {
      ...result.diagnostics,
      timingsMs: { ...result.diagnostics.timingsMs, seedSelection: seedSelectionMs },
    },
  };
}

// ----- assembly: raw signals -> normalised components -> ranked candidates ----

// Returns the FULL ranked pool; the caller applies `maxResults`. Upstream rescue
// selects its seeds from this ranking, so truncating here would hide candidates
// from seed selection that the request is otherwise willing to consider.
function assemble(
  db: Database,
  raw: ReadonlyMap<SymbolId, RawCandidate>,
  input: HybridRetrievalInput,
  derivedIntent: DerivedQueryIntent,
  behavioralObjective: BehavioralObjectiveResult,
  mechanismEvidenceById: Map<string, MechanismEvidence>,
  roleOut: { diagnostics: OperationRoleDiagnostics },
): HybridCandidate[] {
  const entries = [...raw.values()];
  if (entries.length === 0) {
    return [];
  }

  // Mechanism facts are read ONLY when the request declared an operation, and
  // only for the symbols already in the pool — one indexed lookup over a bounded
  // id list, no source read and no repository scan (§56, §94). A request with no
  // operation never touches the table at all.
  const mechanismFacts: ReadonlyMap<SymbolId, MechanismFact[]> =
    hasBehavioralOperation(behavioralObjective)
      ? loadMechanismFactsFor(db, entries.map((entry) => entry.symbol.id))
      : new Map();
  count(input.profile, "mechanism_facts_loaded", mechanismFacts.size);

  // BM25 over the candidate pool: idf is computed across exactly the symbols in
  // contention, so a rare discriminating term outweighs a ubiquitous one.
  const bm25 = computeBm25Scores(
    input.query,
    entries.map((entry) => bm25Document(entry.symbol)),
  );
  const centrality = computeInDegreeCentrality(db, entries.map((entry) => entry.symbol.id));

  // Query token decomposition for generic-token lexical down-weighting: a candidate
  // whose NAME is matched only by a generic word ("multiple") has its blended
  // lexical score scaled down so the word cannot carry it to a pivot.
  const lexicalQueryTokens = classifyLexicalQueryTokens(input.query);

  // Compute the remaining raw signals (symbol/path/domain) that apply to EVERY
  // candidate regardless of which source first surfaced it.
  const symbolRaw = new Map<SymbolId, number>();
  const pathRaw = new Map<SymbolId, number>();
  const domainRaw = new Map<SymbolId, number>();
  const symbolEvidence = input.enableCompoundTaskRescue === true
    ? dedupeNonEmpty([...(input.symbolSeeds ?? []), ...input.shaped.likelySymbols])
    : input.shaped.likelySymbols;
  for (const entry of entries) {
    // Normal ranking preserves the frozen legacy policy. In the bounded M121
    // rescue only, exact extra seeds also contribute the symbol component.
    symbolRaw.set(entry.symbol.id, symbolMatchRaw(entry.symbol.localName, symbolEvidence));
    pathRaw.set(entry.symbol.id, pathMatchRaw(entry.symbol.filePath, input.shaped.likelyFiles));
    domainRaw.set(entry.symbol.id, computeDomainRaw(input.query, entry.symbol));
  }

  const maxFts = maxOf(entries, (entry) => entry.fts);
  const maxTfidf = maxOf(entries, (entry) => bm25.get(entry.symbol.id) ?? 0);
  const maxSymbol = maxMapValue(symbolRaw);
  const maxPath = maxMapValue(pathRaw);
  const maxDomain = maxMapValue(domainRaw);
  const maxTestToImpl = maxOf(entries, (entry) => entry.testToImpl);
  const maxBodyLiteral = maxOf(entries, (entry) => entry.bodyLiteral);
  const maxGraph = maxOf(entries, (entry) => entry.graph);
  const maxCentrality = maxMapValue(centrality);

  const candidates = entries.map((entry) => {
    const fts = round(normalizeAgainst(entry.fts, maxFts));
    const tfidf = round(normalizeAgainst(bm25.get(entry.symbol.id) ?? 0, maxTfidf));
    const symbol = round(normalizeAgainst(symbolRaw.get(entry.symbol.id) ?? 0, maxSymbol));
    const path = round(normalizeAgainst(pathRaw.get(entry.symbol.id) ?? 0, maxPath));
    const domain = round(normalizeAgainst(domainRaw.get(entry.symbol.id) ?? 0, maxDomain));
    const testToImpl = round(normalizeAgainst(entry.testToImpl, maxTestToImpl));
    const bodyLiteral = round(normalizeAgainst(entry.bodyLiteral, maxBodyLiteral));
    const graph = round(normalizeAgainst(entry.graph, maxGraph));
    const centralityScore = round(
      normalizeAgainst(centrality.get(entry.symbol.id) ?? 0, maxCentrality),
    );
    const lexicalMatch = analyzeLexicalGenericMatch(lexicalQueryTokens, entry.symbol);
    const identifierConfidence = identifierConfidenceForSymbol(derivedIntent, entry.symbol.localName);
    const identifierFactor = identifierConfidence === "ordinary_prose"
      ? 0.1
      : identifierConfidence === "weak_short_literal" ? 0.5 : 1;
    const lexical = round(blendLexical(fts, tfidf) * lexicalMatch.factor * identifierFactor);
    const weights = input.weights ?? HYBRID_SCORE_WEIGHTS;
    // Centrality is excluded here and added back below through the relevance
    // gate, which caps it at the candidate's own identifying evidence.
    const rawFinalWithoutCentrality = combineFinalScore(
      { lexical, symbol, path, domain, testToImpl, bodyLiteral, graph, centrality: 0 },
      weights,
    );

    const graphContribution = weights.graph * graph;
    const domainContribution = weights.domain * domain;

    // Strip the graph + centrality boost from a generic high-centrality hub that
    // has no local evidence, so it cannot outrank a locally-relevant target.
    const inDegree = centrality.get(entry.symbol.id) ?? 0;
    const hasTestEvidence =
      entry.sources.has(HybridCandidateSource.TestToImpl)
      || entry.sources.has(HybridCandidateSource.FailingTest);
    const hub = evaluateHub({
      inDegree,
      lexical,
      symbol,
      path,
      domain,
      testToImpl,
      bodyLiteral,
      hasTestEvidence,
      graphContribution,
      centralityContribution: weights.centrality * centralityScore,
    });

    // Strip the soft graph + domain boost from a low-actionability module-level
    // symbol (a `compiler = '…'` config var) that lacks strong direct evidence.
    const action = evaluateActionability({
      kind: entry.symbol.kind,
      lexical,
      symbol,
      path,
      bodyLiteral,
      graphContribution,
      domainContribution,
    });

    const hubPenalty = round(hub.penalty);
    const actionabilityPenalty = round(action.penalty);
    const contrast = evaluateCandidateContrast(derivedIntent, entry.symbol);
    const directAnswer = evaluateDirectAnswer(derivedIntent, entry.symbol);
    const positiveObjectiveScore = round(contrast.positiveObjectiveScore);
    const contrastPenalty = round(contrast.contrastPenalty);
    const directAnswerScore = round(directAnswer.score);
    // Already bounded by the rescue lane's own cap; added here (rather than
    // inside `combineFinalScore`) alongside the other bounded, attributable
    // adjustments so the contribution stays separable and inspectable.
    const upstreamRescueScore = round(entry.upstreamRescue);
    const conceptOwnerScore = round(entry.conceptOwner);

    // M150: does this definition PERFORM the operation the request asked about?
    //
    // The subject gate reads the candidate's own already-normalised subject
    // signals. It asks whether the request is about this code at all, which is a
    // different question from whether the code implements the behaviour — and
    // mechanism evidence is only allowed to answer the second.
    let mechanismEvidence = 0;
    if (hasBehavioralOperation(behavioralObjective)) {
      const evaluated = evaluateMechanismEvidence({
        objective: behavioralObjective,
        facts: mechanismFacts.get(entry.symbol.id) ?? [],
        localName: entry.symbol.localName,
        fqName: entry.symbol.fqName,
        filePath: entry.symbol.filePath,
        // IDENTIFYING evidence only — deliberately excluding `domain`. Issue-domain
        // affinity is the component every symbol in a topically relevant package
        // earns, so it says nothing about which of them the request is about; the
        // M142 centrality gate excludes it for exactly this reason. Measured on
        // ARC's Gaussian route-keyword request, letting domain satisfy the gate
        // handed a Hessian PARSER full selection evidence on the strength of the
        // token `gaussian` in its path, and took the lead off the owner file.
        subjectRelevance: Math.max(lexical, path, symbol),
      });
      if (evaluated.matched.length > 0) mechanismEvidenceById.set(entry.symbol.id, evaluated);
      mechanismEvidence = evaluated.score;
    }

    const finalWithoutCentrality = round(Math.max(
      0,
      rawFinalWithoutCentrality - hub.penalty - action.penalty + positiveObjectiveScore
      + directAnswerScore + upstreamRescueScore + conceptOwnerScore + mechanismEvidence
      - contrastPenalty,
    ));

    // The hub penalty already stripped this candidate's centrality when it had no
    // local evidence at all; adding it back would undo that rule.
    const ungatedCentrality = hubPenalty > 0 ? 0 : weights.centrality * centralityScore;
    const gate = gateCentralityOnRelevance({
      centralityContribution: ungatedCentrality,
      centrality: centralityScore,
      identifyingEvidence: hub.identifyingEvidence,
    });
    const final = round(finalWithoutCentrality + gate.support);

    const evidence = [...entry.evidence];
    if (ungatedCentrality > 0 && gate.support < ungatedCentrality) {
      evidence.push(
        `centrality support capped at ${(gate.relevanceShare * 100).toFixed(0)}% of full: `
        + `this candidate's own identifying evidence (${hub.identifyingEvidence.toFixed(2)}) `
        + `is below its centrality (${centralityScore.toFixed(2)})`,
      );
    }
    if (inDegree > 0) {
      evidence.push(`${inDegree} indexed symbol(s) depend on this`);
    }
    if (hubPenalty > 0) {
      evidence.push(
        `downranked: generic hub (${inDegree} dependents) lacks local lexical/symbol/path/test evidence`,
      );
    }
    if (actionabilityPenalty > 0) {
      evidence.push(
        `downranked: ${entry.symbol.kind} is a low-actionability edit target without strong direct evidence`,
      );
    }
    if (lexicalMatch.factor < 1) {
      evidence.push(
        `lexical down-weighted: name matched only by generic token(s) ${lexicalMatch.downweightedTokens.join(", ")}`,
      );
    }
    if (identifierFactor < 1) {
      evidence.push(
        `literal identifier confidence ${identifierConfidence}: short token \`${entry.symbol.localName}\` lacks explicit symbol context`,
      );
    }
    if (positiveObjectiveScore > 0) {
      evidence.push(`preferred contrast side matched: ${contrast.matchedPositiveTerms.join(", ")} (+${positiveObjectiveScore.toFixed(2)})`);
    }
    if (contrastPenalty > 0) {
      evidence.push(`downranked: ${contrast.reason} (-${contrastPenalty.toFixed(2)})`);
    }
    if (directAnswerScore > 0) {
      evidence.push(`${directAnswer.reason} (+${directAnswerScore.toFixed(2)} direct answer)`);
    }
    // §66: the `why` must say what the candidate DOES, not merely that a name
    // matched. A lead on a behavioural question whose only explanation is
    // "strong lexical match" is exactly the uninformative reason M150 set out to
    // replace.
    if (mechanismEvidence > 0) {
      const reason = mechanismEvidenceReason(
        behavioralObjective as BehavioralObjective,
        mechanismEvidenceById.get(entry.symbol.id)!,
      );
      if (reason !== undefined) evidence.push(`${reason} (+${mechanismEvidence.toFixed(2)} mechanism)`);
    }

    const scores: HybridScoreComponents = {
      lexical,
      fts,
      tfidf,
      bm25: tfidf,
      symbol,
      path,
      testToImpl,
      bodyLiteral,
      domain,
      graph,
      graphProximity: graph,
      centrality: centralityScore,
      actionability: action.actionability,
      inDegree,
      localEvidence: round(hub.localEvidence),
      hubPenalty,
      actionabilityPenalty,
      positiveObjectiveScore,
      contrastPenalty,
      directAnswerScore,
      ...(upstreamRescueScore > 0 ? { upstreamRescueScore } : {}),
      ...(conceptOwnerScore > 0 ? { conceptOwnerScore } : {}),
      ...(mechanismEvidence > 0 ? { mechanismEvidence } : {}),
      centralityRelevanceShare: gate.relevanceShare,
      centralitySupport: gate.support,
      final,
    };

    return {
      symbolId: entry.symbol.id,
      filePath: entry.symbol.filePath,
      fqName: entry.symbol.fqName,
      localName: entry.symbol.localName,
      kind: entry.symbol.kind,
      scores,
      sources: [...entry.sources].sort(),
      evidence: evidence.sort(),
      matches: entry.matches,
      identifierConfidence,
    } satisfies HybridCandidate;
  });

  // M150: the answer-role correction. Everything above scored each candidate on
  // its own evidence, which cannot see that one of them produces what another
  // consumes. This is the only step that compares two candidates to each other,
  // and it runs last so the organic scores it reads are final.
  const roleResult = hasBehavioralOperation(behavioralObjective)
    ? resolveOperationRoles({
      db,
      operation: behavioralObjective.operation,
      candidates: candidates.map((candidate) => ({
        symbolId: candidate.symbolId,
        fqName: candidate.fqName,
        final: candidate.scores.final,
      })),
      evidenceById: mechanismEvidenceById,
      factsById: mechanismFacts,
    })
    : inactiveOperationRoles("no behavioural operation in request");

  const ranked = candidates.map((candidate) => {
    const promoted = roleResult.promotedFinals.get(candidate.symbolId);
    if (promoted === undefined) return candidate;
    // The organic final stays on the scorecard as `final`'s companion so an
    // audit can always separate what this candidate earned from where the
    // relation placed it (§65).
    const promotion = roleResult.diagnostics.promotions
      .find((entry) => entry.symbolId === candidate.symbolId);
    return {
      ...candidate,
      scores: {
        ...candidate.scores,
        organicFinal: candidate.scores.final,
        operationFulfillment: round(promoted - candidate.scores.final),
        final: promoted,
      },
      evidence: [
        ...candidate.evidence,
        `${promotion?.reason ?? "directly implements the requested operation"} (answer role)`,
      ].sort(),
    } satisfies HybridCandidate;
  });

  ranked.sort(
    (left, right) =>
      right.scores.final - left.scores.final
      || left.fqName.localeCompare(right.fqName)
      || left.symbolId.localeCompare(right.symbolId),
  );

  roleOut.diagnostics = roleResult.diagnostics;
  return ranked;
}

// ----- raw signal helpers -----------------------------------------------------

function ensureCandidate(
  db: Database,
  raw: Map<SymbolId, RawCandidate>,
  symbolId: SymbolId,
  known?: SymbolRecord,
): RawCandidate | undefined {
  const existing = raw.get(symbolId);
  if (existing !== undefined) {
    return existing;
  }
  const symbol = known ?? getSymbolById(db, symbolId);
  if (symbol === undefined) {
    return undefined;
  }
  // Every hybrid lane funnels through here, including the path lane, which admits
  // ALL symbols declared in a likely edit file. A <module> is one of those symbols
  // now, but it is a structural scope: not retrievable, not selectable, not
  // editable. Rejecting it once at admission keeps each lane from having to
  // remember the rule.
  if (isStructuralSymbolKind(symbol.kind)) {
    return undefined;
  }
  const entry: RawCandidate = {
    symbol,
    fts: 0,
    matches: [],
    graph: 0,
    testToImpl: 0,
    bodyLiteral: 0,
    upstreamRescue: 0,
    conceptOwner: 0,
    sources: new Set(),
    evidence: new Set(),
  };
  raw.set(symbolId, entry);
  return entry;
}

const SYMBOL_EXACT = 3;
const SYMBOL_PREFIX = 1.8;
const SYMBOL_TOKEN = 1.0;

function symbolMatchRaw(localName: string, likelySymbols: readonly string[]): number {
  let best = 0;
  const localLower = localName.toLowerCase();
  const localTokens = new Set(tokenize(localName));
  for (const symbol of likelySymbols) {
    const symbolLower = symbol.toLowerCase();
    if (localLower === symbolLower) {
      best = Math.max(best, SYMBOL_EXACT);
      continue;
    }
    if (localLower.startsWith(symbolLower) || symbolLower.startsWith(localLower)) {
      best = Math.max(best, SYMBOL_PREFIX);
      continue;
    }
    const symbolTokens = tokenize(symbol);
    if (symbolTokens.length > 0 && symbolTokens.every((token) => localTokens.has(token))) {
      best = Math.max(best, SYMBOL_TOKEN);
    }
  }
  return best;
}

const PATH_EXACT = 3;
const PATH_SUFFIX = 2.6;
const PATH_BASENAME = 2;
const PATH_DIR = 1;

function pathMatchRaw(filePath: string, likelyFiles: readonly string[]): number {
  let best = 0;
  const normalizedPath = filePath.replace(/\\/g, "/");
  const base = basename(normalizedPath);
  const dir = directoryOf(normalizedPath);
  for (const file of likelyFiles) {
    const normalizedFile = file.replace(/\\/g, "/");
    if (normalizedPath === normalizedFile) {
      best = Math.max(best, PATH_EXACT);
      continue;
    }
    if (
      normalizedPath.endsWith(`/${normalizedFile}`)
      || normalizedFile.endsWith(`/${normalizedPath}`)
    ) {
      best = Math.max(best, PATH_SUFFIX);
      continue;
    }
    if (base.length > 0 && base === basename(normalizedFile)) {
      best = Math.max(best, PATH_BASENAME);
      continue;
    }
    if (dir.length > 0 && dir === directoryOf(normalizedFile)) {
      best = Math.max(best, PATH_DIR);
    }
  }
  return best;
}

const GRAPH_BASE = 1.0;
const GRAPH_SAME_MODULE_BASE = 0.5;
const GRAPH_PER_RELATION = 0.6;
const GRAPH_PER_SEED = 0.3;
const GRAPH_DEPTH2_DECAY = 0.5;

function expansionGraphRaw(expanded: ExpandedCandidate): number {
  const relations = new Set(expanded.evidence.map((item) => item.relation));
  const onlySameModule =
    relations.size === 1 && relations.has(ExpansionRelation.SameModule);
  const base = onlySameModule ? GRAPH_SAME_MODULE_BASE : GRAPH_BASE;
  const relationBonus = GRAPH_PER_RELATION * relations.size;
  const seedBonus = GRAPH_PER_SEED * Math.min(expanded.seedSymbolIds.length, 3);
  const raw = base + relationBonus + seedBonus;
  return expanded.depth >= 2 ? raw * GRAPH_DEPTH2_DECAY : raw;
}

const TEST_BASE = 2.0;
const TEST_PER_RELATION = 0.8;
const TEST_PER_FILE = 0.4;
// A candidate the test BODY exercises (method-level call/reference) is a sharper
// edit-target signal than one the test file merely imports.
const TEST_METHOD_USE_BONUS = 0.8;

function testToImplRaw(
  relationCount: number,
  testFileCount: number,
  usedByTestMethod: boolean,
): number {
  return (
    TEST_BASE
    + TEST_PER_RELATION * relationCount
    + TEST_PER_FILE * Math.min(testFileCount, 3)
    + (usedByTestMethod ? TEST_METHOD_USE_BONUS : 0)
  );
}

function expansionEvidence(db: Database, expanded: ExpandedCandidate): string[] {
  const lines = new Set<string>();
  for (const item of expanded.evidence) {
    const via = getSymbolById(db, item.viaSymbolId);
    const viaName = via?.localName ?? item.viaSymbolId;
    if (item.relation === ExpansionRelation.SameModule) {
      lines.add(`same-module neighbour of ${viaName}`);
    } else {
      const arrow = item.direction === "incoming" ? "from" : "to";
      lines.add(`graph ${item.relation} ${arrow} ${viaName}`);
    }
  }
  return [...lines];
}

function bm25Document(symbol: SymbolRecord): Bm25Document {
  const pathTokens = symbol.filePath.replace(/\\/g, "/").split("/").join(" ");
  return {
    id: symbol.id,
    text: [
      symbol.localName,
      symbol.fqName,
      symbol.signature ?? "",
      symbol.docstring ?? "",
      pathTokens,
    ].join(" "),
  };
}

// Two names are "related" when one is the other (case-insensitive), one is a
// prefix of the other, or every token of one appears in the other. Keeps a
// per-symbol search from polluting the pool with coincidental substring hits.
function nameRelated(localName: string, symbol: string): boolean {
  const a = localName.toLowerCase();
  const b = symbol.toLowerCase();
  if (a === b || a.startsWith(b) || b.startsWith(a)) {
    return true;
  }
  const aTokens = new Set(tokenize(localName));
  const bTokens = tokenize(symbol);
  return bTokens.length > 0 && bTokens.every((token) => aTokens.has(token));
}

function maxOf(entries: readonly RawCandidate[], pick: (entry: RawCandidate) => number): number {
  let max = 0;
  for (const entry of entries) {
    max = Math.max(max, pick(entry));
  }
  return max;
}

function maxMapValue(map: ReadonlyMap<unknown, number>): number {
  let max = 0;
  for (const value of map.values()) {
    max = Math.max(max, value);
  }
  return max;
}

function dedupeNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function basename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

function directoryOf(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index === -1 ? "" : filePath.slice(0, index);
}
