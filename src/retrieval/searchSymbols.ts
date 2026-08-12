import type { Database } from "bun:sqlite";

import { type SymbolKind } from "../domain/types";
import { searchSymbolsFts } from "./searchSymbolsFts";
import {
  SymbolSearchBackend,
  type SearchSymbolsOptions,
  type SymbolSearchResult,
} from "./types";
import {
  EXCLUDE_STRUCTURAL_SYMBOLS_SQL,
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
  WHERE ${EXCLUDE_STRUCTURAL_SYMBOLS_SQL}
  AND (
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
    options.exactNameEligibleTerms,
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
        queryCandidates(
          db,
          query,
          options.kind,
          broadContext,
          options.enableCompoundTaskDecomposition === true,
          options.broadCandidateCache,
        ),
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
  compoundDecomposition = false,
  broadCandidateCache?: Map<string, unknown>,
): SearchCandidateRow[] {
  if (broadContext !== undefined) {
    return queryBroadCandidates(
      db,
      broadContext,
      kind,
      query,
      compoundDecomposition,
      broadCandidateCache,
    );
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
  compoundDecomposition: boolean,
  cache?: Map<string, unknown>,
): SearchCandidateRow[] {
  const cacheKey = `${kind ?? "*"}\0${compoundDecomposition ? "compound" : "legacy"}\0${query}`;
  const cached = cache?.get(cacheKey) as SearchCandidateRow[] | undefined;
  if (cached !== undefined) {
    return cached;
  }
  // The former query expanded every broad disjunct into five lower(field) LIKE
  // predicates. A 17-term task can produce 150+ disjuncts and thousands of LIKE
  // evaluations inside SQLite for every symbol row. The query is necessarily a
  // full symbols scan (all patterns have a leading wildcard), so load that scan
  // once and apply the identical substring admission predicate in-process.
  //
  // asciiLower mirrors SQLite's built-in lower() exactly for the identifier/path
  // data this index stores; unlike String#toLowerCase it does not broaden Unicode
  // matching. ORDER BY remains in SQL, preserving the legacy input order.
  const rows = db.query(`
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
    WHERE ${EXCLUDE_STRUCTURAL_SYMBOLS_SQL}
    ${kind === undefined ? "" : "AND symbols.kind = ?"}
    ORDER BY symbols.fq_name ASC, symbols.id ASC
  `);
  const candidates = (kind === undefined ? rows.all() : rows.all(kind)) as SearchCandidateRow[];
  const normalizedQuery = asciiLower(query);
  const normalizedVariants = new Map<string, string>();
  for (const groups of broadContext.admissionDisjuncts) {
    for (const group of groups) {
      for (const variant of group.variants) {
        if (!normalizedVariants.has(variant)) {
          normalizedVariants.set(variant, asciiLower(variant));
        }
      }
    }
  }
  const admitted = candidates.filter((candidate) => {
    const fields = [
      candidate.local_name,
      candidate.fq_name,
      candidate.signature,
      candidate.docstring ?? "",
      candidate.file_path,
    ].map(asciiLower);
    if (fields.some((field) => field.includes(normalizedQuery))) {
      return true;
    }
    // The disjunct list deliberately reuses term groups across many pair/triple
    // combinations. Compute each group's five-field substring predicate once per
    // candidate rather than once per combination.
    const groupMatches = new Map<object, boolean>();
    return broadContext.admissionDisjuncts.some((groups) =>
      groups.every((group) => {
        const cachedMatch = groupMatches.get(group);
        if (cachedMatch !== undefined) {
          return cachedMatch;
        }
        const matches = group.variants.some((variant) => {
          const normalizedVariant = normalizedVariants.get(variant) ?? asciiLower(variant);
          return fields.some((field) => field.includes(normalizedVariant));
        });
        groupMatches.set(group, matches);
        return matches;
      })
    );
  });
  cache?.set(cacheKey, admitted);
  return admitted;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32));
}
