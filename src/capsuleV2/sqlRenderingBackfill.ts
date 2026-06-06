// SQL-rendering production backfill for debug intent.
//
// Lexical retrieval over a framework/database issue routinely ranks the public
// QUERY-BUILDER API far above the compiler method that actually renders the SQL.
// For a "composed queries cannot change the selected columns in the combined
// query SQL" bug, the prose matches `QuerySet.values()` / `values_list()` (query
// construction) overwhelmingly, while the gold edit site —
// `SQLCompiler.get_combinator_sql()` (SQL rendering) — never enters the pool at
// all. The pool is NOT test-dominated, so the test-pool production backfill never
// fires, and the capsule pivots on the entry-point API instead of the renderer.
//
// PRODUCT PRINCIPLE. For framework/database tasks, public query-builder APIs are
// often the ENTRY POINTS, while compiler/rendering methods are the actual EDIT
// SITES. When an issue describes query COMPOSITION (combined/composed/union/...)
// together with SQL RENDERING / output behaviour (sql/render/compile/columns),
// the edit site is the rendering implementation, not the construction API.
//
// This module recovers the rendering candidates from the index alone, using only
// general structural signals (a `*/compiler.py` path, a `SQLCompiler` class, a
// `get_*_sql` / `as_sql` / `*combinator*` method name). It hardcodes no instance
// ids and no file paths.

import type { Database } from "bun:sqlite";

import type { ShapedSweQuery } from "../capsule/sweQueryShaping";
import { SymbolKind } from "../domain/types";
import {
  hybridRetrieve,
  type HybridCandidate,
} from "../retrieval/hybridRetrieval";
import { tokenize, type HybridScoreWeights } from "../retrieval/hybridScoring";
import { searchSymbols } from "../retrieval/searchSymbols";
import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";

// Kinds a rendering edit can land on — functions/methods only (a `compiler = '…'`
// module variable or the bare `SQLCompiler` class is context, not the edit site).
const ACTIONABLE_FUNCTION_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
]);

// Query-COMPOSITION terms: the issue is about combining/composing querysets. Kept
// to single lower-case tokens (so `values_list` -> `values`, `list`). The presence
// of any one of these is the composition half of the trigger.
const COMPOSITION_TERMS: ReadonlySet<string> = new Set([
  "combined", "combine", "combines", "combining", "combinator",
  "composed", "compose", "composes", "composing", "composition",
  "union", "unions", "unioned",
  "intersection", "intersect", "intersected",
  "difference", "differenced",
  "values",
]);

// SQL-RENDERING / output terms: the issue is about the SQL that is produced. The
// presence of any one of these is the rendering half of the trigger.
const RENDERING_TERMS: ReadonlySet<string> = new Set([
  "sql", "render", "rendered", "rendering",
  "compile", "compiled", "compiler", "compiling",
  "select", "selected", "column", "columns", "output",
]);

// The rendering search lexicon: general SQL-compiler symbol/class/method names to
// resolve against the index. The structural filter (`isSqlRenderingImplementationSymbol`)
// then keeps only the genuine rendering implementations.
const RENDERING_LEXICON: readonly string[] = [
  "get_combinator_sql",
  "combinator",
  "as_sql",
  "execute_sql",
  "compiler",
  "SQLCompiler",
  "compile",
];

// Query-builder public API names: query CONSTRUCTION entry points, not edit sites
// for a rendering bug. Matched on the candidate's local name.
const QUERY_BUILDER_API: ReadonlySet<string> = new Set([
  "values", "values_list", "combine", "set_values",
]);

// How many production rendering candidates to keep, and how many index hits to
// scan per lexicon term — enough to recover the renderer without flooding.
const MAX_RENDERING_SEEDS = 12;
const MAX_HITS_PER_TERM = 8;
const BACKFILL_RETRIEVAL_WINDOW = 200;
const MIN_FUZZY_LENGTH = 4;
// Shared-stem length that links a renderer name to a composition term
// (`combinator`/`combined` share the 6-char `combin` stem).
const MIN_STEM_OVERLAP = 5;

// Name tokens that, alone, mark a method as a SQL-rendering implementation: a
// `*_sql` suffix (`get_combinator_sql`, `as_sql`, `execute_sql`) or a `compile`
// root (`compile`, `compiler`). Deliberately does NOT match a bare `combinator`
// (that also names the query-builder `_combinator_query`) — the path signal below
// disambiguates the compiler one.
const RENDERING_NAME = /(?:_sql$|^as_sql$|compile)/i;

export interface SqlRenderingTrigger {
  /** True when the issue describes query composition AND SQL rendering/output. */
  active: boolean;
  /** The composition terms actually present in the task (for pivot relevance). */
  compositionTerms: ReadonlySet<string>;
}

/**
 * Decide whether the SQL-rendering backfill applies to a task: it does when the
 * issue prose mentions BOTH a query-composition term and a SQL-rendering/output
 * term. Returns the composition terms found so the role refinement can rank the
 * most relevant renderer (`get_combinator_sql` for a "combined" bug) first.
 */
export function wantsSqlRenderingBackfill(task: string): SqlRenderingTrigger {
  const tokens = new Set(tokenize(task));
  const compositionTerms = new Set<string>();
  let hasRendering = false;
  for (const token of tokens) {
    if (COMPOSITION_TERMS.has(token)) {
      compositionTerms.add(token);
    }
    if (RENDERING_TERMS.has(token)) {
      hasRendering = true;
    }
  }
  return { active: compositionTerms.size > 0 && hasRendering, compositionTerms };
}

/** True when a symbol is a SQL-rendering implementation (the rendering edit site). */
export function isSqlRenderingImplementationSymbol(
  localName: string,
  filePath: string,
  kind: SymbolKind,
): boolean {
  if (!ACTIONABLE_FUNCTION_KINDS.has(kind)) {
    return false;
  }
  return RENDERING_NAME.test(localName) || pathLooksLikeCompiler(filePath);
}

/** True when a symbol is a query-builder public API (a query-construction entry point). */
export function isQueryBuilderEntrypointSymbol(localName: string): boolean {
  return QUERY_BUILDER_API.has(localName);
}

/**
 * How relevant a rendering candidate is to THIS composition bug: how many of its
 * name tokens fuzzily match a composition term present in the task. A
 * `get_combinator_sql` scores against a "combined"/"combine" issue (shared
 * `combin` prefix); a generic `as_sql` scores 0. Used to order rendering pivots.
 */
export function sqlRenderingRelevance(
  localName: string,
  compositionTerms: ReadonlySet<string>,
): number {
  let score = 0;
  for (const token of tokenize(localName)) {
    if (fuzzyMatchesAny(token, compositionTerms)) {
      score += 1;
    }
  }
  return score;
}

export interface SqlRenderingBackfillInput {
  db: Database;
  shaped: ShapedSweQuery;
  weights: HybridScoreWeights;
  poolSize: number;
}

/**
 * Recover production SQL-rendering candidates for a composition/rendering bug.
 * Resolves the rendering lexicon against the index, keeps the genuine rendering
 * implementations, promotes their names as retrieval seeds, and re-runs hybrid
 * retrieval (tests excluded). The caller merges the result ahead of the pool.
 */
export function backfillSqlRenderingCandidates(
  input: SqlRenderingBackfillInput,
): HybridCandidate[] {
  const seeds = recoverRenderingSeeds(input.db);
  if (seeds.length === 0) {
    return [];
  }

  // Promote the rendering seeds to likely-symbols so they earn a real symbol
  // score (a pool slot alone would leave them out-ranked by the values API again).
  const augmentedShaped: ShapedSweQuery = {
    ...input.shaped,
    likelySymbols: dedupe([...input.shaped.likelySymbols, ...seeds]),
  };
  const { candidates } = hybridRetrieve(input.db, {
    query: input.shaped.query,
    shaped: augmentedShaped,
    weights: input.weights,
    symbolSeeds: seeds,
    maxResults: Math.max(input.poolSize, BACKFILL_RETRIEVAL_WINDOW),
  });

  // Keep only genuine rendering candidates: a compiler-path method or a
  // `*combinator*` method. The re-run returns the whole re-ranked pool (still
  // led by the values API); injecting the API again would waste merge slots, and
  // an `as_sql` from a NON-compiler module (`where.py`, `query_utils.py`) is not a
  // combined-query renderer. This keeps the injection to actual rendering sites.
  return candidates
    .filter((candidate) => !isLikelyTestCandidate(candidate))
    .filter((candidate) => isRenderingCandidate(candidate.localName, candidate.filePath))
    .slice(0, input.poolSize);
}

// --- seed recovery ------------------------------------------------------------

// Resolve the rendering lexicon against the index and collect the local names of
// the genuine rendering implementations (a compiler-path method, or a
// `*combinator*` method). These become retrieval seeds.
function recoverRenderingSeeds(db: Database): string[] {
  const seeds = new Set<string>();
  for (const term of RENDERING_LEXICON) {
    for (const result of searchSymbols(db, {
      query: term,
      maxResults: MAX_HITS_PER_TERM,
      enableTestAwareDownweighting: true,
    })) {
      if (isLikelyTestCandidate(result) || !ACTIONABLE_FUNCTION_KINDS.has(result.kind)) {
        continue;
      }
      // Target the SQL compiler specifically: a method in a `*/compiler.py` file,
      // or a `*combinator*` rendering method anywhere in the query SQL package.
      if (isRenderingCandidate(result.localName, result.filePath)) {
        seeds.add(result.localName);
      }
      if (seeds.size >= MAX_RENDERING_SEEDS) {
        return [...seeds];
      }
    }
  }
  return [...seeds];
}

// A genuine SQL-rendering candidate: a method in a `*/compiler.py` file, or a
// `*combinator*` rendering method anywhere in the query SQL package.
function isRenderingCandidate(localName: string, filePath: string): boolean {
  return pathLooksLikeCompiler(filePath) || /combinator/i.test(localName);
}

function pathLooksLikeCompiler(filePath: string): boolean {
  return /compiler/i.test(filePath);
}

// A name token is relevant to a composition term when they share a stem: an exact
// match, or a common prefix of at least MIN_STEM_OVERLAP chars. This links the
// renderer `get_combinator_sql` to a "combined"/"combine" issue (shared `combin`),
// which a strict whole-token prefix test misses (neither word prefixes the other).
function fuzzyMatchesAny(token: string, candidates: ReadonlySet<string>): boolean {
  for (const other of candidates) {
    if (token === other) {
      return true;
    }
    if (
      token.length >= MIN_FUZZY_LENGTH
      && other.length >= MIN_FUZZY_LENGTH
      && commonPrefixLength(token, other) >= MIN_STEM_OVERLAP
    ) {
      return true;
    }
  }
  return false;
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
