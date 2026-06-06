// Production-candidate backfill for debug intent.
//
// Lexical retrieval can return a candidate pool that is ENTIRELY (or almost
// entirely) test symbols: the failing test names match the issue prose far more
// strongly than the implementation they exercise, so the production edit target
// never enters the pool and the capsule degrades to `no_context`. (Issue 11095:
// the pool is 25 test symbols; `ModelAdmin.get_inline_instances` is missing.)
//
// This module backfills the pool with PRODUCTION candidates, recovered from the
// index alone:
//
//   * `Class.method` query expansion — when the issue names `ModelAdmin.get_inlines`
//     (a method that may not even exist in the base repo), find the class, list
//     its real methods, and score them by token overlap with the requested method
//     and the issue, so nearby existing methods (`get_inline_instances`,
//     `get_formsets_with_inlines`) become seeds;
//   * class names and method/snake identifiers surfaced from the issue;
//
// then it re-runs retrieval with those seeds promoted to likely-symbols (so they
// earn a real symbol score, not just a pool slot) and EXCLUDES test symbols from
// the result. The caller merges the production candidates ahead of the original
// pool. No instance ids or file paths are hardcoded.

import type { Database } from "bun:sqlite";

import type { ShapedSweQuery } from "../capsule/sweQueryShaping";
import { getSymbolById, listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { SymbolKind, type SymbolRecord } from "../domain/types";
import {
  hybridRetrieve,
  type HybridCandidate,
} from "../retrieval/hybridRetrieval";
import { tokenize, type HybridScoreWeights } from "../retrieval/hybridScoring";
import { searchSymbols } from "../retrieval/searchSymbols";
import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";
import { STOPWORDS } from "./debugRoles";

// Kinds a debug edit can land on — the same set the role gate treats as
// actionable. A pool with none of these (only tests / module variables) cannot
// produce a pivot, so it is the trigger for backfill.
const ACTIONABLE_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Class,
]);

// A pool counts as test-dominated when it contains NO non-test actionable
// candidate (nothing the gate could pivot on), or tests make up the vast bulk of
// it. Either way the production target is missing and a backfill is warranted.
const TEST_DOMINANCE_RATIO = 0.8;

// The backfill retrieves from a WIDE window before filtering tests: a test-only
// pool is exactly the case where test fixtures crowd the top ranks, so the
// production targets (even with a strong symbol score) sit deep in the ranking.
// We pull a large window, drop the tests, then hand the caller the survivors.
const BACKFILL_RETRIEVAL_WINDOW = 200;

// How many class names to find per requested class, and how many nearby methods
// to seed per class — enough to recover the real edit site without flooding.
const MAX_CLASS_MATCHES = 6;
const MAX_EXPANDED_METHODS = 6;
const MIN_FUZZY_LENGTH = 4;
const MIN_TOKEN_LENGTH = 3;

// `Class.method` mentions in the issue text, e.g. `ModelAdmin.get_inlines`.
const CLASS_METHOD = /\b([A-Z][A-Za-z0-9_]*)\.([a-z_][A-Za-z0-9_]*)\b/g;

export interface ProductionBackfillInput {
  db: Database;
  shaped: ShapedSweQuery;
  weights: HybridScoreWeights;
  task: string;
  issueTokens: ReadonlySet<string>;
  poolSize: number;
}

export interface ProductionBackfillResult {
  /** Non-test production candidates recovered by the backfill (may be empty). */
  candidates: HybridCandidate[];
  /** True when a `Class.method` expansion contributed seeds. */
  classMethodExpansionUsed: boolean;
}

/**
 * True when the candidate pool is (almost) all test symbols — the signal that the
 * production edit target was crowded out and a backfill is needed.
 */
export function isTestDominatedPool(candidates: readonly HybridCandidate[]): boolean {
  if (candidates.length === 0) {
    return false;
  }
  const nonTestActionable = candidates.filter(
    (candidate) => !isLikelyTestCandidate(candidate) && ACTIONABLE_KINDS.has(candidate.kind),
  );
  if (nonTestActionable.length === 0) {
    return true;
  }
  const testCount = candidates.filter((candidate) => isLikelyTestCandidate(candidate)).length;
  return testCount / candidates.length >= TEST_DOMINANCE_RATIO;
}

/**
 * Recover production candidates for a test-dominated pool. The result excludes
 * test symbols; the caller merges it ahead of the original pool.
 */
export function backfillProductionCandidates(
  input: ProductionBackfillInput,
): ProductionBackfillResult {
  const { seeds, classMethodExpansionUsed } = buildProductionSeeds(
    input.db,
    input.task,
    input.shaped,
    input.issueTokens,
  );
  if (seeds.length === 0) {
    return { candidates: [], classMethodExpansionUsed: false };
  }

  // Promote the production seeds to likely-symbols so they earn a real symbol
  // score (a pool slot alone would leave them out-ranked again), and pass them as
  // symbol seeds so they resolve into the pool.
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

  return {
    candidates: candidates
      .filter((candidate) => !isLikelyTestCandidate(candidate))
      .slice(0, input.poolSize),
    classMethodExpansionUsed,
  };
}

// --- seed construction --------------------------------------------------------

interface ProductionSeeds {
  seeds: string[];
  classMethodExpansionUsed: boolean;
}

function buildProductionSeeds(
  db: Database,
  task: string,
  shaped: ShapedSweQuery,
  issueTokens: ReadonlySet<string>,
): ProductionSeeds {
  const seeds = new Set<string>();
  let classMethodExpansionUsed = false;

  // 1) Class.method expansion: ModelAdmin.get_inlines -> ModelAdmin + nearby real
  // methods (get_inline_instances, get_formsets_with_inlines, ...).
  for (const { className, methodName } of parseClassMethodPairs(task)) {
    seeds.add(className);
    seeds.add(methodName);
    const targetTokens = new Set(meaningfulTokens(methodName));
    for (const cls of findClasses(db, className)) {
      for (const method of nearbyMethods(db, cls, targetTokens, issueTokens)) {
        seeds.add(method);
        classMethodExpansionUsed = true;
      }
    }
  }

  // 2) Class names (CamelCase) and method/snake identifiers from the issue prose:
  // production-focused terms that lexical search alone under-ranked.
  for (const identifier of [...shaped.identifiers, ...shaped.likelySymbols]) {
    if (/^[A-Z][a-z]/.test(identifier) || identifier.includes("_")) {
      seeds.add(identifier);
    }
  }

  return { seeds: [...seeds].filter((seed) => seed.length > 0), classMethodExpansionUsed };
}

function parseClassMethodPairs(task: string): Array<{ className: string; methodName: string }> {
  const seen = new Set<string>();
  const pairs: Array<{ className: string; methodName: string }> = [];
  for (const match of task.matchAll(CLASS_METHOD)) {
    const className = match[1]!;
    const methodName = match[2]!;
    const key = `${className}.${methodName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    pairs.push({ className, methodName });
  }
  return pairs;
}

// Resolve a class name to the indexed class symbol(s) bearing exactly that name.
function findClasses(db: Database, className: string): SymbolRecord[] {
  const classes: SymbolRecord[] = [];
  const seen = new Set<string>();
  for (const result of searchSymbols(db, {
    query: className,
    maxResults: MAX_CLASS_MATCHES,
    enableTestAwareDownweighting: true,
  })) {
    if (result.localName !== className || seen.has(result.symbolId)) {
      continue;
    }
    seen.add(result.symbolId);
    const symbol = getSymbolById(db, result.symbolId);
    if (
      symbol !== undefined
      && symbol.kind === SymbolKind.Class
      && !isLikelyTestCandidate(symbol)
    ) {
      classes.push(symbol);
    }
  }
  return classes;
}

// Methods under `cls` whose name overlaps the requested method or the issue,
// ranked best-first and capped. Token overlap with the REQUESTED method name
// weighs double; an issue-token overlap weighs single. Fuzzy on a prefix so
// `inline` matches `inlines`.
function nearbyMethods(
  db: Database,
  cls: SymbolRecord,
  targetTokens: ReadonlySet<string>,
  issueTokens: ReadonlySet<string>,
): string[] {
  const scored: Array<{ name: string; score: number }> = [];
  for (const symbol of listSymbolsForFile(db, cls.filePath)) {
    if (symbol.parentSymbolId !== cls.id || !ACTIONABLE_KINDS.has(symbol.kind)) {
      continue;
    }
    const score = scoreMethod(symbol.localName, targetTokens, issueTokens);
    if (score > 0) {
      scored.push({ name: symbol.localName, score });
    }
  }
  return scored
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, MAX_EXPANDED_METHODS)
    .map((entry) => entry.name);
}

function scoreMethod(
  localName: string,
  targetTokens: ReadonlySet<string>,
  issueTokens: ReadonlySet<string>,
): number {
  let score = 0;
  for (const token of meaningfulTokens(localName)) {
    if (fuzzyMatchesAny(token, targetTokens)) {
      score += 2;
    } else if (fuzzyMatchesAny(token, issueTokens)) {
      score += 1;
    }
  }
  return score;
}

function fuzzyMatchesAny(token: string, candidates: ReadonlySet<string>): boolean {
  for (const other of candidates) {
    if (token === other) {
      return true;
    }
    if (
      token.length >= MIN_FUZZY_LENGTH
      && other.length >= MIN_FUZZY_LENGTH
      && (token.startsWith(other) || other.startsWith(token))
    ) {
      return true;
    }
  }
  return false;
}

function meaningfulTokens(text: string): string[] {
  return tokenize(text).filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token));
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
