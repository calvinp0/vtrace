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
  blendLexical,
  combineFinalScore,
  computeBm25Scores,
  evaluateHub,
  HYBRID_SCORE_WEIGHTS,
  normalizeAgainst,
  tokenize,
  type Bm25Document,
  type HybridScoreComponents,
  type HybridScoreWeights,
} from "./hybridScoring";
import { searchSymbols } from "./searchSymbols";
import { normalizeMaxResults } from "./searchSymbolsShared";
import type { SymbolSearchMatch } from "./types";

export enum HybridCandidateSource {
  Lexical = "lexical",
  Symbol = "symbol",
  Path = "path",
  Test = "test",
  Graph = "graph",
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
}

export interface HybridRetrievalResult {
  candidates: HybridCandidate[];
}

const DEFAULTS = Object.freeze({
  maxResults: 6,
  lexicalPoolMinimum: 20,
  lexicalPoolMultiplier: 4,
  symbolPoolSize: 6,
});

// Raw (un-normalised) per-signal accumulation for one candidate.
interface RawCandidate {
  symbol: SymbolRecord;
  fts: number;
  matches: SymbolSearchMatch[];
  graph: number;
  sources: Set<HybridCandidateSource>;
  evidence: Set<string>;
}

const ROUND = 1e4;
const round = (value: number): number => Math.round(value * ROUND) / ROUND;

export function hybridRetrieve(
  db: Database,
  input: HybridRetrievalInput,
): HybridRetrievalResult {
  const maxResults = normalizeMaxResults(input.maxResults ?? DEFAULTS.maxResults);
  if (maxResults === 0) {
    return { candidates: [] };
  }
  const lexicalPoolSize = input.lexicalPoolSize
    ?? Math.max(DEFAULTS.lexicalPoolMinimum, maxResults * DEFAULTS.lexicalPoolMultiplier);

  const raw = new Map<SymbolId, RawCandidate>();

  // 1. Lexical candidates from the shaped query (FTS5 + heuristic ranking).
  for (const result of searchSymbols(db, {
    query: input.query,
    maxResults: lexicalPoolSize,
    enableTestAwareDownweighting: true,
  })) {
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

  // 2. Symbol candidates: each likely symbol (plus any caller-supplied seeds)
  //    resolved against the index. These seed the pool even when the prose-level
  //    query under-ranked them.
  const symbolQueries = dedupeNonEmpty([
    ...(input.symbolSeeds ?? []),
    ...input.shaped.likelySymbols,
  ]);
  for (const symbolName of symbolQueries) {
    for (const result of searchSymbols(db, {
      query: symbolName,
      maxResults: DEFAULTS.symbolPoolSize,
      enableTestAwareDownweighting: true,
    })) {
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

  // 3. Path candidates: every symbol that lives in a likely edit file enters the
  //    pool directly, so the target file is present even with no lexical hit.
  for (const file of input.shaped.likelyFiles) {
    for (const symbol of listSymbolsForFile(db, file)) {
      const entry = ensureCandidate(db, raw, symbol.id, symbol);
      if (entry === undefined) {
        continue;
      }
      entry.sources.add(HybridCandidateSource.Path);
      entry.evidence.add(`declared in likely edit file ${file}`);
    }
  }

  // 4. Failing-test -> implementation candidates (import/call/reference edges).
  for (const testImpl of expandTestsToImplementation(db, input.shaped)) {
    const entry = ensureCandidate(db, raw, testImpl.symbol.id, testImpl.symbol);
    if (entry === undefined) {
      continue;
    }
    entry.sources.add(HybridCandidateSource.Test);
    entry.graph += testGraphRaw(testImpl.relations.length, testImpl.viaTestFiles.length);
    for (const line of testImpl.evidence) {
      entry.evidence.add(line);
    }
  }

  // 5. Graph-expanded neighbours of everything found so far. THIS is what lets a
  //    target lexical search missed enter the pool.
  const seeds = [...raw.keys()];
  for (const expanded of expandGraphCandidates(db, seeds, input.expansion)) {
    const entry = ensureCandidate(db, raw, expanded.symbol.id, expanded.symbol);
    if (entry === undefined) {
      continue;
    }
    entry.sources.add(HybridCandidateSource.Graph);
    entry.graph += expansionGraphRaw(expanded);
    for (const line of expansionEvidence(db, expanded)) {
      entry.evidence.add(line);
    }
  }

  return { candidates: assemble(db, raw, input, maxResults) };
}

// ----- assembly: raw signals -> normalised components -> ranked candidates ----

function assemble(
  db: Database,
  raw: ReadonlyMap<SymbolId, RawCandidate>,
  input: HybridRetrievalInput,
  maxResults: number,
): HybridCandidate[] {
  const entries = [...raw.values()];
  if (entries.length === 0) {
    return [];
  }

  // BM25 over the candidate pool: idf is computed across exactly the symbols in
  // contention, so a rare discriminating term outweighs a ubiquitous one.
  const bm25 = computeBm25Scores(
    input.query,
    entries.map((entry) => bm25Document(entry.symbol)),
  );
  const centrality = computeInDegreeCentrality(db, entries.map((entry) => entry.symbol.id));

  // Compute the remaining raw signals (symbol/path) that apply to EVERY
  // candidate regardless of which source first surfaced it.
  const symbolRaw = new Map<SymbolId, number>();
  const pathRaw = new Map<SymbolId, number>();
  for (const entry of entries) {
    symbolRaw.set(entry.symbol.id, symbolMatchRaw(entry.symbol.localName, input.shaped.likelySymbols));
    pathRaw.set(entry.symbol.id, pathMatchRaw(entry.symbol.filePath, input.shaped.likelyFiles));
  }

  const maxFts = maxOf(entries, (entry) => entry.fts);
  const maxTfidf = maxOf(entries, (entry) => bm25.get(entry.symbol.id) ?? 0);
  const maxSymbol = maxMapValue(symbolRaw);
  const maxPath = maxMapValue(pathRaw);
  const maxGraph = maxOf(entries, (entry) => entry.graph);
  const maxCentrality = maxMapValue(centrality);

  const candidates = entries.map((entry) => {
    const fts = round(normalizeAgainst(entry.fts, maxFts));
    const tfidf = round(normalizeAgainst(bm25.get(entry.symbol.id) ?? 0, maxTfidf));
    const symbol = round(normalizeAgainst(symbolRaw.get(entry.symbol.id) ?? 0, maxSymbol));
    const path = round(normalizeAgainst(pathRaw.get(entry.symbol.id) ?? 0, maxPath));
    const graph = round(normalizeAgainst(entry.graph, maxGraph));
    const centralityScore = round(
      normalizeAgainst(centrality.get(entry.symbol.id) ?? 0, maxCentrality),
    );
    const lexical = round(blendLexical(fts, tfidf));
    const weights = input.weights ?? HYBRID_SCORE_WEIGHTS;
    const rawFinal = combineFinalScore(
      { lexical, symbol, path, graph, centrality: centralityScore },
      weights,
    );

    // Strip the graph + centrality boost from a generic high-centrality hub that
    // has no local evidence, so it cannot outrank a locally-relevant target.
    const inDegree = centrality.get(entry.symbol.id) ?? 0;
    const hasTestEvidence = entry.sources.has(HybridCandidateSource.Test);
    const hub = evaluateHub({
      inDegree,
      lexical,
      symbol,
      path,
      hasTestEvidence,
      graphContribution: weights.graph * graph,
      centralityContribution: weights.centrality * centralityScore,
    });
    const hubPenalty = round(hub.penalty);
    const final = round(Math.max(0, rawFinal - hub.penalty));

    const evidence = [...entry.evidence];
    if (inDegree > 0) {
      evidence.push(`${inDegree} indexed symbol(s) depend on this`);
    }
    if (hubPenalty > 0) {
      evidence.push(
        `downranked: generic hub (${inDegree} dependents) lacks local lexical/symbol/path/test evidence`,
      );
    }

    const scores: HybridScoreComponents = {
      lexical,
      fts,
      tfidf,
      symbol,
      path,
      graph,
      centrality: centralityScore,
      inDegree,
      localEvidence: round(hub.localEvidence),
      hubPenalty,
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
    } satisfies HybridCandidate;
  });

  candidates.sort(
    (left, right) =>
      right.scores.final - left.scores.final
      || left.fqName.localeCompare(right.fqName)
      || left.symbolId.localeCompare(right.symbolId),
  );

  return candidates.slice(0, maxResults);
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
  const entry: RawCandidate = {
    symbol,
    fts: 0,
    matches: [],
    graph: 0,
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

function testGraphRaw(relationCount: number, testFileCount: number): number {
  return TEST_BASE + TEST_PER_RELATION * relationCount + TEST_PER_FILE * Math.min(testFileCount, 3);
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
