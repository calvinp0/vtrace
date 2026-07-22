import type { Database } from "bun:sqlite";

import { rerankGraph } from "../retrieval/rerankGraph";
import { searchSymbols } from "../retrieval/searchSymbols";
import { searchSymbolsFtsDetailed } from "../retrieval/searchSymbolsFts";
import {
  extractPathSegments,
  normalizeMaxResults,
  resolveBroadQueryContext,
  resolveBoundaryQueryContext,
  resolvePathSignalQueryContext,
} from "../retrieval/searchSymbolsShared";
import {
  SymbolSearchBackend,
  type GraphSearchResult,
  type RetrievalPathSignalDiagnostics,
} from "../retrieval/types";
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
  enableExactIdentifierLane?: boolean;
  includeTimingDiagnostics?: boolean;
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

  const broadContext = resolveBroadQueryContext(query, options.enableBroadQueryBoosts !== false, true);
  const boundaryContext = resolveBoundaryQueryContext(query, options.enableBoundaryBoosts !== false);
  const pathSignalContext = resolvePathSignalQueryContext(
    query,
    broadContext,
    options.enablePathSignalBoosts !== false,
    true,
  );

  const searchOptions = {
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
    enableExactIdentifierLane: options.enableExactIdentifierLane,
  };
  const detailedSearch = profile.backend === SymbolSearchBackend.Fts
    ? searchSymbolsFtsDetailed(db, searchOptions)
    : undefined;
  const lexicalCandidates = detailedSearch?.results ?? searchSymbols(db, searchOptions);

  const graphStarted = performance.now();
  const rerankedResults = rerankGraph(
    db,
    lexicalCandidates,
    maxResults,
    profile.graphWeights,
  );
  const graphMs = performance.now() - graphStarted;

  return {
    query,
    intent: classification.intent,
    classification,
    profile,
    rerankedResults,
    pathSignalDiagnostics: collectPathSignalDiagnostics(
      pathSignalContext,
      lexicalCandidates.map((candidate) => candidate.filePath),
      detailedSearch?.diagnostics,
      options.includeTimingDiagnostics === true ? graphMs : 0,
      options.includeTimingDiagnostics === true,
    ),
  };
}

function emptyPathSignalDiagnostics(): RetrievalPathSignalDiagnostics {
  return {
    pathSignalsConsidered: [],
    pathSignalsMatched: [],
    candidateFilesConsidered: 0,
    weakPathCoverage: false,
    normalizedQuery: "",
    queryVariants: [],
    identifierTerms: [],
    pathTerms: [],
    ftsTerms: [],
    laneResults: { path: 0, symbol: 0, lexical: 0, documentation: 0, tests: 0, graph: 0 },
    preFilterCandidates: 0,
    rejectedByThreshold: 0,
    rejectedByScope: 0,
    graphExpansions: 0,
    fallbackAttempted: false,
    finalReason: "max_results_zero",
    timingsMs: { normalization: 0, laneSearch: 0, candidateMerge: 0, graphExpansion: 0, total: 0 },
  };
}

function collectPathSignalDiagnostics(
  pathSignalContext: ReturnType<typeof resolvePathSignalQueryContext>,
  candidateFilePaths: readonly string[],
  searchDiagnostics?: ReturnType<typeof searchSymbolsFtsDetailed>["diagnostics"],
  graphMs = 0,
  includeTimings = false,
): RetrievalPathSignalDiagnostics {
  const candidateFiles = Array.from(new Set(candidateFilePaths));
  const detailed = {
    normalizedQuery: searchDiagnostics?.normalizedQuery ?? "",
    queryVariants: searchDiagnostics?.queryVariants ?? [],
    identifierTerms: searchDiagnostics?.identifierTerms ?? [],
    pathTerms: searchDiagnostics?.pathTerms ?? [],
    ftsTerms: searchDiagnostics?.ftsTerms ?? [],
    laneResults: {
      path: searchDiagnostics?.rawLaneHits.path ?? 0,
      symbol: searchDiagnostics?.rawLaneHits.symbol ?? 0,
      lexical: searchDiagnostics?.rawLaneHits.lexical ?? candidateFilePaths.length,
      documentation: searchDiagnostics?.rawLaneHits.documentation ?? 0,
      tests: searchDiagnostics?.rawLaneHits.tests ?? 0,
      graph: 0,
    },
    preFilterCandidates: searchDiagnostics?.preFilterCandidates ?? candidateFilePaths.length,
    rejectedByThreshold: searchDiagnostics?.rejectedByThreshold ?? 0,
    rejectedByScope: searchDiagnostics?.rejectedByScope ?? 0,
    graphExpansions: 0,
    fallbackAttempted: searchDiagnostics?.fallbackAttempted ?? false,
    ...(searchDiagnostics?.fallbackReason === undefined
      ? {}
      : { fallbackReason: searchDiagnostics.fallbackReason }),
    ...(candidateFiles.length === 0 ? { finalReason: "no_candidates" } : {}),
    timingsMs: {
      normalization: includeTimings ? searchDiagnostics?.timingsMs.normalization ?? 0 : 0,
      laneSearch: includeTimings ? searchDiagnostics?.timingsMs.laneSearch ?? 0 : 0,
      candidateMerge: includeTimings ? searchDiagnostics?.timingsMs.candidateMerge ?? 0 : 0,
      graphExpansion: graphMs,
      total: includeTimings ? (searchDiagnostics?.timingsMs.total ?? 0) + graphMs : 0,
    },
  };

  if (pathSignalContext === undefined) {
    return {
      pathSignalsConsidered: [],
      pathSignalsMatched: [],
      candidateFilesConsidered: candidateFiles.length,
      weakPathCoverage: false,
      ...detailed,
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
    ...detailed,
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
