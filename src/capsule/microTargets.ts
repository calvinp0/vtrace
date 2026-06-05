// Micro-capsule implementation-target recovery.
//
// A failing test names the test method, the test class, and the symbols the
// issue exercises; the edit target is almost never the test itself but the
// IMPLEMENTATION those symbols resolve to. A micro capsule is tiny on purpose,
// so it must spend its budget on that implementation — not on the test file,
// and not on nothing.
//
// Recovery walks: failing test + issue text -> candidate implementation symbols
// (dropping the test's own method/class names) -> look each up in the index ->
// keep the best NON-test definition. The result feeds both the capsule pivots
// and the diagnostics' likely_files/likely_symbols, so a micro capsule points
// at the code to change.
//
// This is purely index-driven: it never hardcodes instance ids or file paths.

import type { Database } from "bun:sqlite";

import { searchSymbolsGraph } from "../retrieval/searchSymbolsGraph";
import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";
import { SymbolSearchMatchField, type GraphSearchResult } from "../retrieval/types";
import type { ShapedSweQuery } from "./sweQueryShaping";

export interface RecoverMicroTargetsOptions {
  /** Hard cap on recovered targets (defaults to the micro item budget, 2). */
  maxTargets?: number;
  /** How many candidates to consider per symbol before filtering tests. */
  perSymbolPoolSize?: number;
}

const DEFAULT_MAX_TARGETS = 2;
const DEFAULT_PER_SYMBOL_POOL = 6;

// Fields that mean the candidate matched on its NAME (not merely a docstring or
// path coincidence). We require one so recovery stays precise.
const NAME_MATCH_FIELDS: ReadonlySet<SymbolSearchMatchField> = new Set([
  SymbolSearchMatchField.LocalName,
  SymbolSearchMatchField.FQName,
]);

export function recoverMicroTargets(
  db: Database,
  shaped: ShapedSweQuery,
  options: RecoverMicroTargetsOptions = {},
): GraphSearchResult[] {
  const maxTargets = options.maxTargets ?? DEFAULT_MAX_TARGETS;
  if (maxTargets <= 0) {
    return [];
  }

  const candidateSymbols = selectImplementationSymbols(shaped);
  if (candidateSymbols.length === 0) {
    return [];
  }

  const poolSize = options.perSymbolPoolSize ?? DEFAULT_PER_SYMBOL_POOL;
  const seenSymbolIds = new Set<string>();
  const recovered: GraphSearchResult[] = [];

  for (const symbol of candidateSymbols) {
    if (recovered.length >= maxTargets) {
      break;
    }

    const candidates = searchSymbolsGraph(db, {
      query: symbol,
      maxResults: poolSize,
      // Push the test that names the symbol below the implementation it covers.
      enableTestAwareDownweighting: true,
    });

    const best = candidates.find(
      (candidate) =>
        !seenSymbolIds.has(candidate.symbolId)
        && matchedOnName(candidate)
        && !isLikelyTestCandidate(candidate),
    );

    if (best !== undefined) {
      seenSymbolIds.add(best.symbolId);
      recovered.push(best);
    }
  }

  return recovered;
}

// The symbols worth resolving to an implementation, in priority order:
//   1. the explicit identifiers the issue/shaping surfaced (function calls,
//      backtick-quoted names, CamelCase types like ModelAdmin/QuerySet) — minus
//      the failing test's own method/class names;
//   2. the SUBJECT of each test class — the class name with its Test/TestCase
//      affix stripped (AggregateTestCase -> Aggregate, FooTest -> Foo), which is
//      the thing under test and usually names the implementation directly.
function selectImplementationSymbols(shaped: ShapedSweQuery): string[] {
  const explicit = shaped.identifiers.filter((symbol) => !isTestSymbol(symbol));
  const subjects = shaped.identifiers
    .filter(isTestClassName)
    .map(testClassSubject)
    .filter((subject) => subject.length >= 3);

  return dedupe([...explicit, ...subjects]);
}

// A test method (test_*) or a test class (CamelCase containing "Test", e.g.
// AggregateTestCase, TestInline, GenericInlineModelAdminTest).
function isTestSymbol(symbol: string): boolean {
  if (/^test[_A-Z]/.test(symbol) || /^test$/i.test(symbol)) {
    return true;
  }
  return isTestClassName(symbol);
}

function isTestClassName(symbol: string): boolean {
  return /^[A-Z]/.test(symbol) && /Test/.test(symbol);
}

// Strip a leading or trailing Test/TestCase/Tests affix from a test class name
// to recover the subject under test.
function testClassSubject(className: string): string {
  return className
    .replace(/^Test(?=[A-Z])/, "")
    .replace(/(?:TestCase|Tests|Test)$/, "");
}

function matchedOnName(candidate: GraphSearchResult): boolean {
  return candidate.matches.some((match) => NAME_MATCH_FIELDS.has(match.field));
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
