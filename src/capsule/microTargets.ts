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

import {
  hybridRetrieve,
  type HybridCandidate,
} from "../retrieval/hybridRetrieval";
import type { GraphExpansionOptions } from "../retrieval/graphExpansion";
import {
  assignCandidateRoles,
  CandidateRole,
  pivotsOf,
  supportOf,
  type RoledCandidate,
} from "./assignCandidateRoles";
import type { ShapedSweQuery } from "./sweQueryShaping";

export interface RecoverMicroTargetsOptions {
  /** Hard cap on micro PIVOTS (defaults to a single high-confidence pivot). */
  maxTargets?: number;
  /** Candidate pool the hybrid pipeline ranks before role assignment. */
  poolSize?: number;
  /** Graph-expansion bounds forwarded to the hybrid pipeline. */
  expansion?: GraphExpansionOptions;
}

export interface MicroCapsuleRecovery {
  /** Every ranked candidate with its assigned role + why (for diagnostics). */
  roled: RoledCandidate[];
  /** The recovered pivots, in rank order (micro: at most `maxTargets`). */
  pivots: HybridCandidate[];
  /** Support context related to the pivots, in rank order. */
  support: HybridCandidate[];
}

// Micro is single-pivot by policy: one high-confidence edit target, or skip.
const DEFAULT_MAX_TARGETS = 1;
const DEFAULT_POOL_SIZE = 12;

// Recover the micro capsule: run hybrid graph-expanded retrieval, then assign
// pivot/support/discard roles under the STRICT micro policy (a pivot needs a
// concrete failing-test/symbol/path pointer and an actionable kind; a generic
// hub or module variable is support at most). The caller emits the pivot — or,
// when none survives, recommends skip rather than vague support-only context.
export function recoverMicroCapsule(
  db: Database,
  shaped: ShapedSweQuery,
  options: RecoverMicroTargetsOptions = {},
): MicroCapsuleRecovery {
  const maxTargets = options.maxTargets ?? DEFAULT_MAX_TARGETS;
  if (maxTargets <= 0) {
    return { roled: [], pivots: [], support: [] };
  }

  const { candidates } = hybridRetrieve(db, {
    query: shaped.query,
    shaped,
    symbolSeeds: selectImplementationSymbols(shaped),
    maxResults: options.poolSize ?? DEFAULT_POOL_SIZE,
    ...(options.expansion ? { expansion: options.expansion } : {}),
  });

  const assigned = assignCandidateRoles(candidates, { micro: true, maxPivots: maxTargets });
  // A micro capsule is tiny and high-precision: its support must be LOCALLY
  // relevant context (lexical/symbol/path/domain/test evidence), never a
  // zero-local-evidence graph neighbour (a base `Model` reached only by
  // inheritance) — that is exactly the "vague support" Requirement 5 forbids. A
  // demoted support entry leaves the emitted set entirely (becomes a discard),
  // so the diagnostics' selection mirrors what the capsule actually carries.
  const roled = assigned.filter(
    (entry) =>
      entry.role === CandidateRole.Pivot
      || (entry.role === CandidateRole.Support && entry.candidate.scores.localEvidence > 0),
  );
  return { roled, pivots: pivotsOf(roled), support: supportOf(roled) };
}

// Back-compat thin wrapper: the recovered micro PIVOTS only.
export function recoverMicroTargets(
  db: Database,
  shaped: ShapedSweQuery,
  options: RecoverMicroTargetsOptions = {},
): HybridCandidate[] {
  return recoverMicroCapsule(db, shaped, options).pivots;
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
