import type { Database } from "bun:sqlite";

import { type SymbolKind } from "../domain/types";
import type { SearchSymbolsOptions, SymbolSearchResult } from "./types";
import {
  buildFtsMatchQueryForContext,
  buildFtsSingleTermRecoveryQueryForContext,
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

export function searchSymbolsFts(
  db: Database,
  options: SearchSymbolsOptions,
): SymbolSearchResult[] {
  const normalizedQuery = normalizeSearchQuery(options.query);
  const maxResults = normalizeMaxResults(options.maxResults);
  const boundaryContext = resolveBoundaryQueryContext(
    options.query,
    options.enableBoundaryBoosts !== false,
  );
  const broadContext = resolveBroadQueryContext(
    options.query,
    options.enableBroadQueryBoosts !== false,
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
  );

  if (normalizedQuery.length === 0 || maxResults === 0) {
    return [];
  }

  const matchQuery = buildFtsMatchQueryForContext(options.query, broadContext);

  if (matchQuery === undefined) {
    return [];
  }

  const primaryCandidates = queryCandidates(db, matchQuery, options.kind);
  const recoveryCandidates = primaryCandidates.length === 0
    ? queryRecoveryCandidates(
      db,
      buildFtsSingleTermRecoveryQueryForContext(broadContext),
      options.kind,
    )
    : [];
  const pathSignalCandidates = queryPathSignalCandidates(db, pathSignalContext, options.kind);

  return rankSearchCandidates(
    mergeSearchCandidates(
      mergeSearchCandidates(
        mergeSearchCandidates(primaryCandidates, recoveryCandidates),
        pathSignalCandidates,
      ),
      queryBoundaryCandidates(db, boundaryContext, options.kind),
    ),
    normalizedQuery,
    maxResults,
    {
      boundaryContext,
      broadContext,
      testContext,
      technicalContext,
      pathSignalContext,
    },
  );
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
