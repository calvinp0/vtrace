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
  HybridCandidateSource,
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

  // A micro capsule's TOP targets must be locally relevant — never a generic,
  // high-centrality framework hub (django's `Model`) that floated up on
  // dependent count alone. Partition: locally-evidenced implementation first,
  // then non-test hubs/support only to fill any remaining budget. Candidates are
  // already ranked by penalised final score, so locals precede hubs naturally.
  const local = candidates.filter(isLocalTarget);
  if (local.length === 0) {
    // Nothing locally relevant recovered: do not anchor the micro capsule on a
    // hub. Returning empty makes the caller recommend skip.
    return [];
  }
  const support = candidates.filter(
    (candidate) => !isLocalTarget(candidate) && isSupportCandidate(candidate),
  );

  return [...local, ...support].slice(0, maxTargets);
}

// A locally-relevant micro edit target: implementation (not a test), not a
// penalised generic hub, and carrying at least one LOCAL signal that ties it to
// this task (strong-enough lexical, a symbol-name/path match, or a
// test-to-implementation edge). `localEvidence` already encodes exactly that.
function isLocalTarget(candidate: HybridCandidate): boolean {
  if (isLikelyTestCandidate(candidate)) {
    return false;
  }
  return candidate.scores.hubPenalty === 0 && candidate.scores.localEvidence > 0;
}

// A non-test candidate eligible as SUPPORT context (including a downranked hub):
// it carries some signal, but is not strong enough — or too generic — to be a
// top edit target. Surfaced only when micro budget remains after local targets.
function isSupportCandidate(candidate: HybridCandidate): boolean {
  if (isLikelyTestCandidate(candidate)) {
    return false;
  }
  const { symbol, path, graph } = candidate.scores;
  return (
    symbol > 0
    || path > 0
    || graph > 0
    || candidate.sources.includes(HybridCandidateSource.Test)
    || candidate.sources.includes(HybridCandidateSource.Symbol)
    || candidate.sources.includes(HybridCandidateSource.Path)
    || candidate.sources.includes(HybridCandidateSource.Graph)
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
