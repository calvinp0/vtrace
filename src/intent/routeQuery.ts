import type { Database } from "bun:sqlite";

import { rerankGraph } from "../retrieval/rerankGraph";
import { searchSymbols } from "../retrieval/searchSymbols";
import {
  normalizeMaxResults,
  resolveBroadQueryContext,
  resolveBoundaryQueryContext,
} from "../retrieval/searchSymbolsShared";
import type { GraphSearchResult } from "../retrieval/types";
import {
  defaultIntentClassifier,
  type IntentClassifier,
} from "./classifier";
import {
  INTENT_ROUTING_DEFAULTS,
  getIntentRoutingProfile,
  type IntentRoutingProfile,
} from "./profile";
import {
  type IntentClassificationResult,
  type QueryIntent,
} from "./types";

export interface RouteQueryOptions {
  classifier?: IntentClassifier;
  maxResults?: number;
  enableBoundaryBoosts?: boolean;
  enableBroadQueryBoosts?: boolean;
  enableTestAwareDownweighting?: boolean;
  enableTechnicalQueryBoosts?: boolean;
}

export interface RoutedQueryResult {
  query: string;
  intent: QueryIntent;
  classification: IntentClassificationResult;
  profile: IntentRoutingProfile;
  rerankedResults: GraphSearchResult[];
}

export function routeQuery(
  db: Database,
  query: string,
  options: RouteQueryOptions = {},
): RoutedQueryResult {
  const classifier = options.classifier ?? defaultIntentClassifier;
  const classification = classifier.classify(query);
  const profile = getIntentRoutingProfile(classification.intent);
  const maxResults = normalizeMaxResults(
    options.maxResults ?? INTENT_ROUTING_DEFAULTS.maxResults,
  );

  if (maxResults === 0) {
    return {
      query,
      intent: classification.intent,
      classification,
      profile,
      rerankedResults: [],
    };
  }

  const lexicalCandidates = searchSymbols(db, {
    query,
    maxResults: resolveCandidatePoolSize(
      maxResults,
      profile.candidatePoolSize,
      resolveBroadQueryContext(query, options.enableBroadQueryBoosts !== false),
      resolveBoundaryQueryContext(query, options.enableBoundaryBoosts !== false),
    ),
    backend: profile.backend,
    enableBoundaryBoosts: options.enableBoundaryBoosts,
    enableBroadQueryBoosts: options.enableBroadQueryBoosts,
    enableTestAwareDownweighting: options.enableTestAwareDownweighting,
    enableTechnicalQueryBoosts: options.enableTechnicalQueryBoosts,
  });

  return {
    query,
    intent: classification.intent,
    classification,
    profile,
    rerankedResults: rerankGraph(
      db,
      lexicalCandidates,
      maxResults,
      profile.graphWeights,
    ),
  };
}

function resolveCandidatePoolSize(
  maxResults: number,
  profileCandidatePoolSize: number,
  broadContext?: ReturnType<typeof resolveBroadQueryContext>,
  boundaryContext?: ReturnType<typeof resolveBoundaryQueryContext>,
): number {
  return Math.max(
    maxResults,
    normalizeMaxResults(profileCandidatePoolSize),
    broadContext === undefined ? 0 : 32,
    boundaryContext === undefined ? 0 : 24,
  );
}
