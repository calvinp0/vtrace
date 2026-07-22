import type { Database } from "bun:sqlite";

import { type SymbolKind } from "../domain/types";
import {
  SymbolSearchMatchField,
  SymbolSearchMatchType,
  type RetrievalQueryVariant,
  type SearchSymbolsOptions,
  type SymbolSearchResult,
} from "./types";
import {
  buildFtsMatchQueryForContext,
  buildFtsMatchQuery,
  buildFtsSingleTermRecoveryQueryForContext,
  buildFtsSearchText,
  isLikelyTestCandidate,
  mergeSearchCandidates,
  normalizeMaxResults,
  normalizeSearchQuery,
  queryPathSignalCandidates,
  resolveBroadQueryContext,
  resolvePathSignalQueryContext,
  resolveTechnicalQueryContext,
  resolveTestAwareQueryContext,
  queryBoundaryCandidates,
  rankSearchCandidates,
  resolveBoundaryQueryContext,
  type SearchCandidateRow,
} from "./searchSymbolsShared";

export interface SearchSymbolsFtsDiagnostics {
  readonly normalizedQuery: string;
  readonly matchQuery: string | null;
  readonly queryVariants: readonly RetrievalQueryVariant[];
  readonly identifierTerms: readonly string[];
  readonly pathTerms: readonly string[];
  readonly ftsTerms: readonly string[];
  readonly rawLaneHits: {
    readonly path: number;
    readonly symbol: number;
    readonly lexical: number;
    readonly documentation: number;
    readonly tests: number;
  };
  readonly rawLaneFiles: {
    readonly path: readonly string[];
    readonly symbol: readonly string[];
    readonly lexical: readonly string[];
    readonly documentation: readonly string[];
    readonly tests: readonly string[];
  };
  readonly candidateUnionFiles: readonly string[];
  readonly preFilterCandidates: number;
  readonly rejectedByThreshold: number;
  readonly rejectedByScope: number;
  readonly fallbackAttempted: boolean;
  readonly fallbackReason?: string;
  readonly timingsMs: {
    readonly normalization: number;
    readonly laneSearch: number;
    readonly candidateMerge: number;
    readonly total: number;
  };
}

export interface SearchSymbolsFtsDetailedResult {
  readonly results: SymbolSearchResult[];
  readonly diagnostics: SearchSymbolsFtsDiagnostics;
}

const QUERY_SQL = `
  SELECT
    symbols.id AS symbol_id,
    files.path AS file_path,
    symbols.fq_name,
    symbols.local_name,
    symbols.kind,
    symbols.signature,
    symbols.docstring
  FROM symbol_search_fts
  INNER JOIN symbols ON symbols.id = symbol_search_fts.symbol_id
  INNER JOIN files ON files.id = symbols.file_id
  WHERE symbol_search_fts MATCH ?
`;

const EXACT_IDENTIFIER_LANE_BONUS = 80;
const EXACT_FILENAME_LANE_BONUS = 160;
const EXACT_SNAKE_CASE_LANE_BONUS = 100;

export function searchSymbolsFts(
  db: Database,
  options: SearchSymbolsOptions,
): SymbolSearchResult[] {
  return searchSymbolsFtsDetailed(db, options).results;
}

export function searchSymbolsFtsDetailed(
  db: Database,
  options: SearchSymbolsOptions,
): SearchSymbolsFtsDetailedResult {
  const totalStarted = performance.now();
  const normalizationStarted = performance.now();
  const normalizedQuery = normalizeSearchQuery(options.query);
  const maxResults = normalizeMaxResults(options.maxResults);
  const boundaryContext = resolveBoundaryQueryContext(
    options.query,
    options.enableBoundaryBoosts !== false,
  );
  const broadContext = resolveBroadQueryContext(
    options.query,
    options.enableBroadQueryBoosts !== false,
    options.enableCompoundTaskDecomposition === true,
  );
  const testContext = resolveTestAwareQueryContext(
    options.query,
    broadContext,
    options.enableTestAwareDownweighting !== false,
  );
  const technicalContext = resolveTechnicalQueryContext(
    options.query,
    broadContext,
    options.enableTechnicalQueryBoosts !== false,
  );
  const pathSignalContext = resolvePathSignalQueryContext(
    options.query,
    broadContext,
    options.enablePathSignalBoosts !== false,
    options.enableCompoundTaskDecomposition === true,
  );
  const matchQuery = buildFtsMatchQueryForContext(options.query, broadContext);
  const identifierTerms = collectIdentifierTerms(options.query);
  const queryVariants = collectQueryVariants(
    matchQuery,
    broadContext,
    identifierTerms,
    pathSignalContext?.pathTerms ?? [],
  );
  const normalizationMs = performance.now() - normalizationStarted;

  if (normalizedQuery.length === 0 || maxResults === 0 || matchQuery === undefined) {
    return {
      results: [],
      diagnostics: {
        normalizedQuery,
        matchQuery: matchQuery ?? null,
        queryVariants,
        identifierTerms,
        pathTerms: pathSignalContext?.pathTerms ?? [],
        ftsTerms: buildFtsSearchText(options.query).split(" ").filter(Boolean),
        rawLaneHits: { path: 0, symbol: 0, lexical: 0, documentation: 0, tests: 0 },
        rawLaneFiles: { path: [], symbol: [], lexical: [], documentation: [], tests: [] },
        candidateUnionFiles: [],
        preFilterCandidates: 0,
        rejectedByThreshold: 0,
        rejectedByScope: 0,
        fallbackAttempted: false,
        timingsMs: {
          normalization: normalizationMs,
          laneSearch: 0,
          candidateMerge: 0,
          total: performance.now() - totalStarted,
        },
      },
    };
  }

  const laneStarted = performance.now();
  const primaryCandidates = queryCandidates(db, matchQuery, options.kind);
  const recoveryQuery = primaryCandidates.length === 0
    ? buildFtsSingleTermRecoveryQueryForContext(broadContext)
    : undefined;
  const fallbackAttempted = recoveryQuery !== undefined;
  const recoveryCandidates = fallbackAttempted
    ? queryRecoveryCandidates(db, recoveryQuery, options.kind)
    : [];
  const pathSignalCandidates = queryPathSignalCandidates(db, pathSignalContext, options.kind);
  const boundaryCandidates = queryBoundaryCandidates(db, boundaryContext, options.kind);
  const identifierCandidates = options.enableExactIdentifierLane === false ? [] : identifierTerms.flatMap((identifier) => {
    const identifierQuery = buildFtsMatchQuery(identifier);
    if (identifierQuery === undefined) return [];
    const rows = queryCandidates(db, identifierQuery, options.kind);
    const bonus = identifier.includes(".")
      ? EXACT_FILENAME_LANE_BONUS
      : identifier.includes("_")
        ? EXACT_SNAKE_CASE_LANE_BONUS
        : EXACT_IDENTIFIER_LANE_BONUS;
    return rankSearchCandidates(rows, normalizeSearchQuery(identifier), 1).map((result) => ({
      ...result,
      score: result.score + bonus,
      matches: [
        ...result.matches,
        {
          field: SymbolSearchMatchField.QueryCoverage,
          matchType: SymbolSearchMatchType.Exact,
          scoreContribution: bonus,
        },
      ],
    }));
  });
  const laneSearchMs = performance.now() - laneStarted;

  const mergeStarted = performance.now();
  const mergedCandidates = mergeSearchCandidates(
    mergeSearchCandidates(
      mergeSearchCandidates(primaryCandidates, recoveryCandidates),
      pathSignalCandidates,
    ),
    boundaryCandidates,
  );
  const allRanked = rankSearchCandidates(
    mergedCandidates,
    normalizedQuery,
    Number.MAX_SAFE_INTEGER,
    {
      boundaryContext,
      broadContext,
      testContext,
      technicalContext,
      pathSignalContext,
    },
  );
  // Exact identifiers and filenames are an independent strong lane. Keep at
  // most one best candidate per detected identifier, then union the broad lane;
  // no file is admitted merely for centrality and duplicate symbols collapse.
  const prioritized = new Map<string, SymbolSearchResult>();
  for (const result of identifierCandidates) prioritized.set(result.symbolId, result);
  for (const result of allRanked) {
    if (!prioritized.has(result.symbolId)) prioritized.set(result.symbolId, result);
  }
  const results = [...prioritized.values()].slice(0, maxResults);
  const candidateMergeMs = performance.now() - mergeStarted;
  const documentation = allRanked.filter((result) =>
    result.matches.some((match) => match.field === SymbolSearchMatchField.Docstring)
  ).length;
  const symbol = new Set(identifierCandidates.map((result) => result.symbolId)).size;
  const tests = allRanked.filter((result) => isLikelyTestCandidate(result)).length;
  const candidateUnionFiles = uniqueSorted([
    ...mergedCandidates.map((candidate) => candidate.file_path),
    ...identifierCandidates.map((candidate) => candidate.filePath),
  ]);
  const documentationFiles = uniqueSorted(allRanked
    .filter((result) => result.matches.some((match) => match.field === SymbolSearchMatchField.Docstring))
    .map((result) => result.filePath));
  const testFiles = uniqueSorted(allRanked.filter((result) => isLikelyTestCandidate(result)).map((result) => result.filePath));

  return {
    results,
    diagnostics: {
      normalizedQuery,
      matchQuery,
      queryVariants: fallbackAttempted && recoveryQuery !== undefined
        ? [...queryVariants, { kind: "fallback", query: recoveryQuery }]
        : queryVariants,
      identifierTerms,
      pathTerms: pathSignalContext?.pathTerms ?? [],
      ftsTerms: buildFtsSearchText(options.query).split(" ").filter(Boolean),
      rawLaneHits: {
        path: pathSignalCandidates.length,
        symbol,
        lexical: primaryCandidates.length + recoveryCandidates.length,
        documentation,
        tests,
      },
      rawLaneFiles: {
        path: uniqueSorted(pathSignalCandidates.map((candidate) => candidate.file_path)),
        symbol: uniqueSorted(identifierCandidates.map((candidate) => candidate.filePath)),
        lexical: uniqueSorted([...primaryCandidates, ...recoveryCandidates].map((candidate) => candidate.file_path)),
        documentation: documentationFiles,
        tests: testFiles,
      },
      candidateUnionFiles,
      preFilterCandidates: new Set([...mergedCandidates.map((candidate) => candidate.symbol_id), ...identifierCandidates.map((candidate) => candidate.symbolId)]).size,
      rejectedByThreshold: mergedCandidates.length - allRanked.length,
      rejectedByScope: 0,
      fallbackAttempted,
      ...(fallbackAttempted ? { fallbackReason: "primary_lexical_no_hits" } : {}),
      timingsMs: {
        normalization: normalizationMs,
        laneSearch: laneSearchMs,
        candidateMerge: candidateMergeMs,
        total: performance.now() - totalStarted,
      },
    },
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function collectIdentifierTerms(query: string): string[] {
  const matches = query.match(
    /\b(?:[A-Za-z0-9_-]+\.[A-Za-z0-9]+|[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g,
  ) ?? [];
  return [...new Set(matches)];
}

function collectQueryVariants(
  matchQuery: string | undefined,
  broadContext: ReturnType<typeof resolveBroadQueryContext>,
  identifiers: readonly string[],
  pathTerms: readonly string[],
): RetrievalQueryVariant[] {
  const variants: RetrievalQueryVariant[] = identifiers.map((query) => ({
    kind: query.includes(".") ? "path" : "identifier",
    query,
  }));
  for (const query of pathTerms.slice(0, 8)) {
    variants.push({ kind: "path", query });
  }
  for (const phrase of broadContext?.phraseGroups.slice(0, 8) ?? []) {
    variants.push({ kind: "phrase", query: phrase.label });
  }
  if (matchQuery !== undefined) {
    variants.push({ kind: "semantic_terms", query: matchQuery });
  }
  const seen = new Set<string>();
  return variants.filter((variant) => {
    const key = `${variant.kind}\0${variant.query}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function queryRecoveryCandidates(
  db: Database,
  matchQuery: string | undefined,
  kind?: SymbolKind,
): SearchCandidateRow[] {
  if (matchQuery === undefined) {
    return [];
  }

  return queryCandidates(db, matchQuery, kind);
}

function queryCandidates(
  db: Database,
  matchQuery: string,
  kind?: SymbolKind,
): SearchCandidateRow[] {
  const orderByClause = " ORDER BY symbols.fq_name ASC, symbols.id ASC";

  if (kind === undefined) {
    return db.query(`${QUERY_SQL}${orderByClause}`).all(matchQuery) as SearchCandidateRow[];
  }

  return db.query(`${QUERY_SQL} AND symbols.kind = ?${orderByClause}`).all(
    matchQuery,
    kind,
  ) as SearchCandidateRow[];
}
