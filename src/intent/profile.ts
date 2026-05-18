import { GRAPH_RERANK_SCORE_WEIGHTS } from "../retrieval/rerankGraph";
import {
  SymbolSearchBackend,
  type GraphRerankScoreWeights,
} from "../retrieval/types";
import { QueryIntent } from "./types";

export interface IntentRoutingProfile {
  readonly id: QueryIntent;
  readonly backend: SymbolSearchBackend;
  readonly candidatePoolSize: number;
  readonly graphWeights: GraphRerankScoreWeights;
  readonly summary: string;
}

export const INTENT_ROUTING_DEFAULTS = Object.freeze({
  maxResults: 6,
});

// Routed natural-language queries work better against the multi-term FTS backend.
export const INTENT_ROUTING_PROFILES = Object.freeze({
  [QueryIntent.Debug]: makeIntentRoutingProfile({
    id: QueryIntent.Debug,
    backend: SymbolSearchBackend.Fts,
    candidatePoolSize: 16,
    graphWeights: makeGraphWeights({
      inDegreePerEdge: 3,
      inDegreeMax: 9,
      containsNeighbor: 10,
      containsNeighborMax: 20,
      importsNeighbor: 8,
      importsNeighborMax: 16,
      connectedMatchedCandidate: 5,
      connectedMatchedCandidateMax: 10,
    }),
    summary: "Broad FTS retrieval with aggressive graph emphasis for failures and breakages.",
  }),
  [QueryIntent.Refactor]: makeIntentRoutingProfile({
    id: QueryIntent.Refactor,
    backend: SymbolSearchBackend.Fts,
    candidatePoolSize: 14,
    graphWeights: makeGraphWeights({
      containsNeighbor: 12,
      containsNeighborMax: 24,
      importsNeighbor: 4,
      importsNeighborMax: 8,
      connectedMatchedCandidate: 4,
      connectedMatchedCandidateMax: 8,
    }),
    summary: "FTS retrieval with stronger structural-neighborhood emphasis for code movement.",
  }),
  [QueryIntent.Explain]: makeIntentRoutingProfile({
    id: QueryIntent.Explain,
    backend: SymbolSearchBackend.Fts,
    candidatePoolSize: 10,
    graphWeights: makeGraphWeights(),
    summary: "Balanced FTS retrieval with conservative graph reranking for understanding queries.",
  }),
  [QueryIntent.Feature]: makeIntentRoutingProfile({
    id: QueryIntent.Feature,
    backend: SymbolSearchBackend.Fts,
    candidatePoolSize: 14,
    graphWeights: makeGraphWeights({
      containsNeighbor: 9,
      containsNeighborMax: 18,
      importsNeighbor: 7,
      importsNeighborMax: 14,
      connectedMatchedCandidate: 4,
      connectedMatchedCandidateMax: 8,
    }),
    summary: "Broader FTS retrieval with balanced graph context for implementation work.",
  }),
}) satisfies Record<QueryIntent, IntentRoutingProfile>;

export function getIntentRoutingProfile(intent: QueryIntent): IntentRoutingProfile {
  return INTENT_ROUTING_PROFILES[intent];
}

function makeIntentRoutingProfile(profile: IntentRoutingProfile): IntentRoutingProfile {
  return Object.freeze({
    ...profile,
    graphWeights: Object.freeze({ ...profile.graphWeights }),
  });
}

function makeGraphWeights(
  overrides: Partial<GraphRerankScoreWeights> = {},
): GraphRerankScoreWeights {
  return Object.freeze({
    ...GRAPH_RERANK_SCORE_WEIGHTS,
    ...overrides,
  });
}
