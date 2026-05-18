import type { Database } from "bun:sqlite";

import { searchSymbols } from "./searchSymbols";
import { normalizeMaxResults } from "./searchSymbolsShared";
import { rerankGraph } from "./rerankGraph";
import type { GraphSearchResult, SearchSymbolsGraphOptions } from "./types";

const GRAPH_SEARCH_DEFAULTS = Object.freeze({
  candidatePoolMinimum: 10,
  candidatePoolMultiplier: 4,
});

export function searchSymbolsGraph(
  db: Database,
  options: SearchSymbolsGraphOptions,
): GraphSearchResult[] {
  const maxResults = normalizeMaxResults(options.maxResults);

  if (maxResults === 0) {
    return [];
  }

  const candidatePoolSize = resolveCandidatePoolSize(maxResults, options.candidatePoolSize);
  const lexicalCandidates = searchSymbols(db, {
    query: options.query,
    maxResults: candidatePoolSize,
    kind: options.kind,
    backend: options.backend,
    enableBoundaryBoosts: options.enableBoundaryBoosts,
    enableBroadQueryBoosts: options.enableBroadQueryBoosts,
    enableTestAwareDownweighting: options.enableTestAwareDownweighting,
    enableTechnicalQueryBoosts: options.enableTechnicalQueryBoosts,
  });

  return rerankGraph(db, lexicalCandidates, maxResults);
}

function resolveCandidatePoolSize(
  maxResults: number,
  requestedCandidatePoolSize?: number,
): number {
  if (requestedCandidatePoolSize === undefined) {
    return Math.max(
      maxResults,
      GRAPH_SEARCH_DEFAULTS.candidatePoolMinimum,
      maxResults * GRAPH_SEARCH_DEFAULTS.candidatePoolMultiplier,
    );
  }

  return Math.max(maxResults, normalizeMaxResults(requestedCandidatePoolSize));
}
