// Micro-capsule implementation-target recovery.
//
// A failing test names the test method, the test class, and the symbols the
// issue exercises; the edit target is almost never the test itself but the
// IMPLEMENTATION those symbols resolve to. A micro capsule is tiny on purpose,
// so it must spend its budget on that implementation — not on the test file,
// and not on nothing.
//
// Recovery runs the hybrid graph-expanded retrieval pipeline over the shaped
// query (lexical + symbol/path + failing-test + graph-expanded candidates with
// centrality rerank) and keeps the best NON-test targets. Because graph
// expansion and test-to-implementation expansion are CANDIDATE SOURCES — not
// just rerankers — a target that lexical search alone missed (e.g. the impl a
// failing test imports) can still be recovered. The result feeds both the
// capsule pivots and the diagnostics' likely_files/likely_symbols, with a full
// per-target score breakdown and evidence trail.
//
// This is purely index-driven: it never hardcodes instance ids or file paths.

import type { Database } from "bun:sqlite";

import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";
import {
  hybridRetrieve,
  type HybridCandidate,
} from "../retrieval/hybridRetrieval";
import type { GraphExpansionOptions } from "../retrieval/graphExpansion";
import type { ShapedSweQuery } from "./sweQueryShaping";

export interface RecoverMicroTargetsOptions {
  /** Hard cap on recovered targets (defaults to the micro item budget, 2). */
  maxTargets?: number;
  /** Candidate pool the hybrid pipeline ranks before filtering. */
  poolSize?: number;
  /** Graph-expansion bounds forwarded to the hybrid pipeline. */
  expansion?: GraphExpansionOptions;
}

const DEFAULT_MAX_TARGETS = 2;
const DEFAULT_POOL_SIZE = 12;

export function recoverMicroTargets(
  db: Database,
  shaped: ShapedSweQuery,
  options: RecoverMicroTargetsOptions = {},
): HybridCandidate[] {
  const maxTargets = options.maxTargets ?? DEFAULT_MAX_TARGETS;
  if (maxTargets <= 0) {
    return [];
  }

  const { candidates } = hybridRetrieve(db, {
    query: shaped.query,
    shaped,
    symbolSeeds: selectImplementationSymbols(shaped),
    maxResults: options.poolSize ?? DEFAULT_POOL_SIZE,
    ...(options.expansion ? { expansion: options.expansion } : {}),
  });

  // A micro capsule's targets must be locally relevant — never a generic,
  // high-centrality framework hub (django's `Model`) nor a low-actionability
  // module variable that floated up on graph reach alone. Keep only eligible
  // candidates, then order them STRICTLY by final score (which already reflects
  // every boost and penalty). The previous local-vs-support partition is gone:
  // it could rank a weaker-but-locally-evidenced candidate above a stronger one.
  const eligible = candidates.filter(isEligibleMicroTarget);
  if (eligible.length === 0) {
    // Nothing locally relevant recovered: do not anchor the micro capsule on a
    // hub. Returning empty makes the caller recommend skip.
    return [];
  }

  return [...eligible].sort(byFinalScoreDescending).slice(0, maxTargets);
}

// A micro candidate eligible to appear at all: implementation (not a test), not
// a penalised generic hub, and carrying at least one LOCAL signal that ties it
// to this task — strong-enough lexical, a symbol-name/path match, issue-derived
// domain relevance, or a test-to-implementation edge. `localEvidence` encodes
// exactly that. A low-actionability module variable can still be eligible (and
// appear as trailing support), but its actionability penalty pushes its final
// score — and therefore its rank — below any real edit target.
function isEligibleMicroTarget(candidate: HybridCandidate): boolean {
  if (isLikelyTestCandidate(candidate)) {
    return false;
  }
  return candidate.scores.hubPenalty === 0 && candidate.scores.localEvidence > 0;
}

// Order by final score descending. The only tie-breaker is symbol id, so the
// ordering is total and deterministic.
function byFinalScoreDescending(left: HybridCandidate, right: HybridCandidate): number {
  return (
    right.scores.final - left.scores.final
    || left.symbolId.localeCompare(right.symbolId)
  );
}

// The symbols worth resolving to an implementation, in priority order:
//   1. the explicit identifiers the issue/shaping surfaced (function calls,
//      backtick-quoted names, CamelCase types like ModelAdmin/QuerySet) — minus
//      the failing test's own method/class names;
//   2. the SUBJECT of each test class — the class name with its Test/TestCase
//      affix stripped (AggregateTestCase -> Aggregate, FooTest -> Foo), which is
//      the thing under test and usually names the implementation directly.
// These feed the hybrid pipeline's symbol-candidate step so a target named only
// by the failing test class still enters the pool.
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
