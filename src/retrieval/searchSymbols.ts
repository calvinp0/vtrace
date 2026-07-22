import type { Database } from "bun:sqlite";

import { type SymbolKind } from "../domain/types";
import { searchSymbolsFts } from "./searchSymbolsFts";
import {
  SymbolSearchBackend,
  type SearchSymbolsOptions,
  type SymbolSearchResult,
} from "./types";
import {
  mergeSearchCandidates,
  makeLikePattern,
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
  type BroadQueryContext,
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
  FROM symbols
  INNER JOIN files ON files.id = symbols.file_id
  WHERE (
    lower(symbols.local_name) LIKE ? ESCAPE '\\'
    OR lower(symbols.fq_name) LIKE ? ESCAPE '\\'
    OR lower(symbols.signature) LIKE ? ESCAPE '\\'
    OR lower(COALESCE(symbols.docstring, '')) LIKE ? ESCAPE '\\'
    OR lower(files.path) LIKE ? ESCAPE '\\'
  )
`;

export function searchSymbols(
  db: Database,
  options: SearchSymbolsOptions,
): SymbolSearchResult[] {
  switch (options.backend ?? SymbolSearchBackend.PlainSql) {
    case SymbolSearchBackend.Fts:
      return searchSymbolsFts(db, options);
    case SymbolSearchBackend.PlainSql:
      return searchSymbolsPlainSql(db, options);
  }
}

export function searchSymbolsPlainSql(
  db: Database,
  options: SearchSymbolsOptions,
): SymbolSearchResult[] {
  const query = normalizeSearchQuery(options.query);
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

  if (query.length === 0 || maxResults === 0) {
    return [];
  }

  return rankSearchCandidates(
    mergeSearchCandidates(
      mergeSearchCandidates(
        queryCandidates(db, query, options.kind, broadContext),
        queryPathSignalCandidates(db, pathSignalContext, options.kind),
      ),
      queryBoundaryCandidates(db, boundaryContext, options.kind),
    ),
    query,
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

function queryCandidates(
  db: Database,
  query: string,
  kind?: SymbolKind,
  broadContext?: BroadQueryContext,
): SearchCandidateRow[] {
  if (broadContext !== undefined) {
    return queryBroadCandidates(db, broadContext, kind, query);
  }

  const pattern = makeLikePattern(query);
  const orderByClause = " ORDER BY symbols.fq_name ASC, symbols.id ASC";

  if (kind === undefined) {
    return db.query(`${QUERY_SQL}${orderByClause}`).all(
      pattern,
      pattern,
      pattern,
      pattern,
      pattern,
    ) as SearchCandidateRow[];
  }

  return db.query(`${QUERY_SQL} AND symbols.kind = ?${orderByClause}`).all(
    pattern,
    pattern,
    pattern,
    pattern,
    pattern,
    kind,
  ) as SearchCandidateRow[];
}

function queryBroadCandidates(
  db: Database,
  broadContext: BroadQueryContext,
  kind: SymbolKind | undefined,
  query: string,
): SearchCandidateRow[] {
  const disjuncts = broadContext.admissionDisjuncts.map((groups) => {
    return {
      clause: groups
        .map((group) => buildVariantFieldClause(group.variants.length))
        .join(" AND "),
      variants: groups.flatMap((group) => group.variants),
    };
  });
  const fullQueryPattern = makeLikePattern(query);
  const whereClauses = [
    buildSinglePatternFieldClause(),
    ...disjuncts.map((disjunct) => `(${disjunct.clause})`),
  ];
  const sql = `
    SELECT
      symbols.id AS symbol_id,
      files.path AS file_path,
      symbols.fq_name,
      symbols.local_name,
      symbols.kind,
      symbols.signature,
      symbols.docstring
    FROM symbols
    INNER JOIN files ON files.id = symbols.file_id
    WHERE (
      ${whereClauses.join(" OR ")}
    )
    ${kind === undefined ? "" : "AND symbols.kind = ?"}
    ORDER BY symbols.fq_name ASC, symbols.id ASC
  `;
  const params: string[] = [];

  for (let index = 0; index < 5; index += 1) {
    params.push(fullQueryPattern);
  }

  for (const disjunct of disjuncts) {
    for (const variant of disjunct.variants) {
      const pattern = makeLikePattern(variant);

      for (let index = 0; index < 5; index += 1) {
        params.push(pattern);
      }
    }
  }

  if (kind === undefined) {
    return db.query(sql).all(...params) as SearchCandidateRow[];
  }

  return db.query(sql).all(...params, kind) as SearchCandidateRow[];
}

function buildSinglePatternFieldClause(): string {
  return `(
    lower(symbols.local_name) LIKE ? ESCAPE '\\'
    OR lower(symbols.fq_name) LIKE ? ESCAPE '\\'
    OR lower(symbols.signature) LIKE ? ESCAPE '\\'
    OR lower(COALESCE(symbols.docstring, '')) LIKE ? ESCAPE '\\'
    OR lower(files.path) LIKE ? ESCAPE '\\'
  )`;
}

function buildVariantFieldClause(variantCount: number): string {
  return `(
    ${new Array(variantCount).fill(buildSinglePatternFieldClause()).join(" OR ")}
  )`;
}
