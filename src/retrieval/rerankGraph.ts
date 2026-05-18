import type { Database } from "bun:sqlite";

import { listEdgesForSymbols } from "../db/repositories/edgesRepository";
import { EdgeType, type SymbolId } from "../domain/types";
import { normalizeMaxResults } from "./searchSymbolsShared";
import {
  GraphScoreSignal,
  type GraphRerankScoreWeights,
  type GraphScoreContribution,
  type GraphSearchResult,
  type SymbolSearchResult,
} from "./types";

interface CandidateGraphStats {
  inDegree: number;
  outDegree: number;
  containsNeighbors: Set<SymbolId>;
  importsNeighbors: Set<SymbolId>;
  connectedNeighbors: Set<SymbolId>;
}

export const GRAPH_RERANK_SCORE_WEIGHTS = Object.freeze({
  inDegreePerEdge: 2,
  inDegreeMax: 6,
  outDegreePerEdge: 1,
  outDegreeMax: 4,
  containsNeighbor: 8,
  containsNeighborMax: 16,
  importsNeighbor: 6,
  importsNeighborMax: 12,
  connectedMatchedCandidate: 3,
  connectedMatchedCandidateMax: 6,
}) satisfies GraphRerankScoreWeights;

export function rerankGraph(
  db: Database,
  lexicalCandidates: readonly SymbolSearchResult[],
  maxResults: number,
  weights: GraphRerankScoreWeights = GRAPH_RERANK_SCORE_WEIGHTS,
): GraphSearchResult[] {
  const normalizedMaxResults = normalizeMaxResults(maxResults);

  if (lexicalCandidates.length === 0 || normalizedMaxResults === 0) {
    return [];
  }

  const statsBySymbolId = buildCandidateGraphStats(db, lexicalCandidates);

  return lexicalCandidates
    .map((candidate) => applyGraphScores(
      candidate,
      statsBySymbolId.get(candidate.symbolId),
      weights,
    ))
    .sort(compareGraphSearchResults)
    .slice(0, normalizedMaxResults);
}

function buildCandidateGraphStats(
  db: Database,
  lexicalCandidates: readonly SymbolSearchResult[],
): ReadonlyMap<SymbolId, CandidateGraphStats> {
  const candidateIds = lexicalCandidates.map((candidate) => candidate.symbolId);
  const candidateIdSet = new Set(candidateIds);
  const statsBySymbolId = new Map<SymbolId, CandidateGraphStats>();

  for (const candidateId of candidateIds) {
    statsBySymbolId.set(candidateId, {
      inDegree: 0,
      outDegree: 0,
      containsNeighbors: new Set(),
      importsNeighbors: new Set(),
      connectedNeighbors: new Set(),
    });
  }

  for (const edge of listEdgesForSymbols(db, candidateIds)) {
    const srcStats = statsBySymbolId.get(edge.srcSymbolId);
    const dstStats = statsBySymbolId.get(edge.dstSymbolId);

    if (srcStats !== undefined) {
      srcStats.outDegree += 1;
    }

    if (dstStats !== undefined) {
      dstStats.inDegree += 1;
    }

    const srcIsCandidate = candidateIdSet.has(edge.srcSymbolId);
    const dstIsCandidate = candidateIdSet.has(edge.dstSymbolId);

    if (!srcIsCandidate || !dstIsCandidate) {
      continue;
    }

    srcStats!.connectedNeighbors.add(edge.dstSymbolId);
    dstStats!.connectedNeighbors.add(edge.srcSymbolId);

    if (edge.edgeType === EdgeType.Contains) {
      srcStats!.containsNeighbors.add(edge.dstSymbolId);
      dstStats!.containsNeighbors.add(edge.srcSymbolId);
    }

    if (edge.edgeType === EdgeType.Imports) {
      srcStats!.importsNeighbors.add(edge.dstSymbolId);
      dstStats!.importsNeighbors.add(edge.srcSymbolId);
    }
  }

  return statsBySymbolId;
}

function applyGraphScores(
  candidate: SymbolSearchResult,
  stats?: CandidateGraphStats,
  weights: GraphRerankScoreWeights = GRAPH_RERANK_SCORE_WEIGHTS,
): GraphSearchResult {
  const graphContributions: GraphScoreContribution[] = [];

  if (stats !== undefined) {
    addCountContribution(
      graphContributions,
      GraphScoreSignal.InDegree,
      stats.inDegree,
      weights.inDegreePerEdge,
      weights.inDegreeMax,
    );
    addCountContribution(
      graphContributions,
      GraphScoreSignal.OutDegree,
      stats.outDegree,
      weights.outDegreePerEdge,
      weights.outDegreeMax,
    );
    addNeighborContribution(
      graphContributions,
      GraphScoreSignal.ContainsNeighborhood,
      EdgeType.Contains,
      stats.containsNeighbors,
      weights.containsNeighbor,
      weights.containsNeighborMax,
    );
    addNeighborContribution(
      graphContributions,
      GraphScoreSignal.ImportsNeighborhood,
      EdgeType.Imports,
      stats.importsNeighbors,
      weights.importsNeighbor,
      weights.importsNeighborMax,
    );
    addNeighborContribution(
      graphContributions,
      GraphScoreSignal.ConnectedMatchedCandidates,
      undefined,
      stats.connectedNeighbors,
      weights.connectedMatchedCandidate,
      weights.connectedMatchedCandidateMax,
    );
  }

  const graphScore = graphContributions.reduce(
    (sum, contribution) => sum + contribution.scoreContribution,
    0,
  );

  return {
    symbolId: candidate.symbolId,
    filePath: candidate.filePath,
    fqName: candidate.fqName,
    localName: candidate.localName,
    kind: candidate.kind,
    matches: candidate.matches,
    lexicalScore: candidate.score,
    graphScore,
    finalScore: candidate.score + graphScore,
    graphContributions,
  };
}

function addCountContribution(
  contributions: GraphScoreContribution[],
  signal: GraphScoreSignal,
  count: number,
  perEdge: number,
  maxScore: number,
): void {
  if (count === 0) {
    return;
  }

  contributions.push({
    signal,
    count,
    scoreContribution: Math.min(count * perEdge, maxScore),
  });
}

function addNeighborContribution(
  contributions: GraphScoreContribution[],
  signal: GraphScoreSignal,
  edgeType: EdgeType | undefined,
  neighbors: ReadonlySet<SymbolId>,
  perNeighbor: number,
  maxScore: number,
): void {
  if (neighbors.size === 0) {
    return;
  }

  contributions.push({
    signal,
    count: neighbors.size,
    ...(edgeType === undefined ? {} : { edgeType }),
    relatedSymbolIds: [...neighbors].sort(),
    scoreContribution: Math.min(neighbors.size * perNeighbor, maxScore),
  });
}

function compareGraphSearchResults(
  left: GraphSearchResult,
  right: GraphSearchResult,
): number {
  return (
    right.finalScore - left.finalScore
    || right.lexicalScore - left.lexicalScore
    || left.fqName.localeCompare(right.fqName)
    || left.symbolId.localeCompare(right.symbolId)
  );
}
