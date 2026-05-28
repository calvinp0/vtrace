import type { Database } from "bun:sqlite";

import { rerankGraph } from "../retrieval/rerankGraph";
import { searchSymbols } from "../retrieval/searchSymbols";
import {
  extractPathSegments,
  normalizeMaxResults,
  resolveBroadQueryContext,
  resolveBoundaryQueryContext,
  resolvePathSignalQueryContext,
} from "../retrieval/searchSymbolsShared";
import type { GraphSearchResult, RetrievalPathSignalDiagnostics } from "../retrieval/types";
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
  enablePathSignalBoosts?: boolean;
}

export interface RoutedQueryResult {
  query: string;
  intent: QueryIntent;
  classification: IntentClassificationResult;
  profile: IntentRoutingProfile;
  rerankedResults: GraphSearchResult[];
  pathSignalDiagnostics: RetrievalPathSignalDiagnostics;
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
      pathSignalDiagnostics: emptyPathSignalDiagnostics(),
    };
  }

  const broadContext = resolveBroadQueryContext(query, options.enableBroadQueryBoosts !== false);
  const boundaryContext = resolveBoundaryQueryContext(query, options.enableBoundaryBoosts !== false);
  const pathSignalContext = resolvePathSignalQueryContext(
    query,
    broadContext,
    options.enablePathSignalBoosts !== false,
  );

  const lexicalCandidates = searchSymbols(db, {
    query,
    maxResults: resolveCandidatePoolSize(
      maxResults,
      profile.candidatePoolSize,
      broadContext,
      boundaryContext,
      pathSignalContext,
    ),
    backend: profile.backend,
    enableBoundaryBoosts: options.enableBoundaryBoosts,
    enableBroadQueryBoosts: options.enableBroadQueryBoosts,
    enableTestAwareDownweighting: options.enableTestAwareDownweighting,
    enableTechnicalQueryBoosts: options.enableTechnicalQueryBoosts,
    enablePathSignalBoosts: options.enablePathSignalBoosts,
  });

  const rerankedResults = rerankGraph(
    db,
    lexicalCandidates,
    maxResults,
    profile.graphWeights,
  );

  return {
    query,
    intent: classification.intent,
    classification,
    profile,
    rerankedResults,
    pathSignalDiagnostics: collectPathSignalDiagnostics(
      pathSignalContext,
      lexicalCandidates.map((candidate) => candidate.filePath),
    ),
  };
}

function emptyPathSignalDiagnostics(): RetrievalPathSignalDiagnostics {
  return {
    pathSignalsConsidered: [],
    pathSignalsMatched: [],
    candidateFilesConsidered: 0,
    weakPathCoverage: false,
  };
}

function collectPathSignalDiagnostics(
  pathSignalContext: ReturnType<typeof resolvePathSignalQueryContext>,
  candidateFilePaths: readonly string[],
): RetrievalPathSignalDiagnostics {
  const candidateFiles = Array.from(new Set(candidateFilePaths));

  if (pathSignalContext === undefined) {
    return {
      pathSignalsConsidered: [],
      pathSignalsMatched: [],
      candidateFilesConsidered: candidateFiles.length,
      weakPathCoverage: false,
    };
  }

  const segmentSetsByFile = candidateFiles.map((file) => new Set(extractPathSegments(file)));
  const pathSignalsMatched: string[] = [];

  for (const term of pathSignalContext.pathTerms) {
    const variants = pathSignalContext.variantsByTerm.get(term) ?? [term];
    const matched = segmentSetsByFile.some((segments) => {
      return variants.some((variant) => segments.has(variant));
    });

    if (matched) {
      pathSignalsMatched.push(term);
    }
  }

  const considered = pathSignalContext.pathTerms.length;
  const weakPathCoverage = considered >= 2
    && pathSignalsMatched.length < Math.ceil(considered / 2);

  return {
    pathSignalsConsidered: pathSignalContext.pathTerms,
    pathSignalsMatched,
    candidateFilesConsidered: candidateFiles.length,
    weakPathCoverage,
  };
}

function resolveCandidatePoolSize(
  maxResults: number,
  profileCandidatePoolSize: number,
  broadContext?: ReturnType<typeof resolveBroadQueryContext>,
  boundaryContext?: ReturnType<typeof resolveBoundaryQueryContext>,
  pathSignalContext?: ReturnType<typeof resolvePathSignalQueryContext>,
): number {
  return Math.max(
    maxResults,
    normalizeMaxResults(profileCandidatePoolSize),
    broadContext === undefined ? 0 : 32,
    boundaryContext === undefined ? 0 : 24,
    pathSignalContext === undefined ? 0 : 48,
  );
}
