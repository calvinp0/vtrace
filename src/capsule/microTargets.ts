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
import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";
import { STRONG_DIRECT_LEXICAL } from "../retrieval/hybridScoring";
import {
  assignCandidateRoles,
  CandidateRole,
  detectPivotAmbiguity,
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
  /** Every EMITTED candidate with its assigned role + why (pivot/support). */
  roled: RoledCandidate[];
  /** The recovered pivots, in rank order (micro: at most `maxTargets`). */
  pivots: HybridCandidate[];
  /** Support context related to the pivots, in rank order. */
  support: HybridCandidate[];
  /**
   * Size of the candidate pool BEFORE role assignment — what the pivot gate ran
   * over. `candidateCount > 0` with no pivots means candidates were generated and
   * then discarded, not that retrieval came up empty (Requirement 1).
   */
  candidateCount: number;
  /**
   * Candidates that were rejected — neither emitted as a pivot nor as a locally-
   * relevant support item (a discarded test/hub, or a zero-local-evidence support
   * neighbour the micro capsule drops). In rank order, with the role-assignment
   * "why" preserved as the rejection reason (Requirement 1).
   */
  discarded: RoledCandidate[];
  /**
   * True when two or more candidates clear the pivot bar with comparable scores
   * (Requirement 2): a single-pivot micro capsule cannot decisively pick one, so
   * the caller should recommend standard mode rather than render a coin-flip.
   */
  ambiguous: boolean;
}

/**
 * Why a micro recovery yielded no pivot — a precise, mutually-exclusive diagnosis
 * the skip directive reports instead of a vague "no actionable target" (Req 2).
 */
export type MicroSkipReason =
  | "no candidates recovered"
  | "candidates recovered but all were low-actionability"
  | "candidates recovered but only support-role"
  | "candidates recovered but ambiguous micro pivot"
  | "candidates recovered but below pivot confidence threshold";

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
    return { roled: [], pivots: [], support: [], candidateCount: 0, discarded: [], ambiguous: false };
  }

  const { candidates } = hybridRetrieve(db, {
    query: shaped.query,
    shaped,
    symbolSeeds: selectImplementationSymbols(shaped),
    maxResults: options.poolSize ?? DEFAULT_POOL_SIZE,
    ...(options.expansion ? { expansion: options.expansion } : {}),
  });

  // Ambiguity is judged on the UNCAPPED roles: a runner-up that would itself be a
  // pivot (and is only demoted by the single-pivot cap) still makes the choice
  // ambiguous, so it must be measured before the cap is applied.
  const ambiguous = detectPivotAmbiguity(assignCandidateRoles(candidates));

  const assigned = assignCandidateRoles(candidates, { micro: true, maxPivots: maxTargets });
  // A micro capsule is tiny and high-precision: its support must be LOCALLY
  // relevant context (lexical/symbol/path/domain/test evidence), never a
  // zero-local-evidence graph neighbour (a base `Model` reached only by
  // inheritance) — that is exactly the "vague support" Requirement 5 forbids. A
  // demoted support entry leaves the emitted set entirely (becomes a discard),
  // so the diagnostics' selection mirrors what the capsule actually carries.
  const isEmitted = (entry: RoledCandidate): boolean =>
    entry.role === CandidateRole.Pivot
    || (entry.role === CandidateRole.Support && entry.candidate.scores.localEvidence > 0);
  const roled = assigned.filter(isEmitted);
  // Everything the gate produced but did NOT carry: discards proper plus the
  // zero-local-evidence support neighbours dropped above. These feed the
  // rejected-candidate diagnostics so an over-strict gate is visible (Req 1).
  const discarded = assigned.filter((entry) => !isEmitted(entry));
  return {
    roled,
    pivots: pivotsOf(roled),
    support: supportOf(roled),
    candidateCount: candidates.length,
    discarded,
    ambiguous,
  };
}

// Classify WHY a micro recovery produced no pivot, as a precise diagnosis the
// skip directive can report (Requirement 2). The checks are ordered most- to
// least-decisive so each skip maps to exactly one reason:
//   1. nothing entered the pool at all                       -> no candidates
//   2. two near-pivots tied                                  -> ambiguous
//   3. every non-test candidate is a low-actionability kind  -> low-actionability
//   4. the actionable ones have no DIRECT pointer (graph/    -> only support-role
//      domain reach or a generic hub only)
//   5. an actionable, directly-pointed candidate fell just   -> below threshold
//      short of the local-evidence bar
export function classifyMicroSkipReason(recovery: MicroCapsuleRecovery): MicroSkipReason {
  if (recovery.candidateCount === 0) {
    return "no candidates recovered";
  }
  if (recovery.ambiguous) {
    return "candidates recovered but ambiguous micro pivot";
  }
  // Every non-pivot candidate the recovery produced (skip => pivots is empty):
  // the emitted support plus the discarded pool, minus the failing tests (never
  // edit targets, so they never explain a missing pivot).
  const considered = [
    ...recovery.support,
    ...recovery.discarded.map((entry) => entry.candidate),
  ].filter((candidate) => !isLikelyTestCandidate(candidate));

  if (considered.length === 0) {
    return "no candidates recovered";
  }
  const actionable = considered.filter((candidate) => candidate.scores.actionability === 1);
  if (actionable.length === 0) {
    return "candidates recovered but all were low-actionability";
  }
  if (!actionable.some(hasDirectEvidence)) {
    return "candidates recovered but only support-role";
  }
  return "candidates recovered but below pivot confidence threshold";
}

// A candidate has DIRECT edit-target evidence when a concrete pointer fired (a
// symbol-name/path/failing-test match or a strong lexical hit) — never graph or
// domain reach alone. Mirrors the pivot gate in `assignCandidateRoles`.
function hasDirectEvidence(candidate: HybridCandidate): boolean {
  const s = candidate.scores;
  return s.symbol > 0 || s.path > 0 || s.testToImpl > 0 || s.lexical >= STRONG_DIRECT_LEXICAL;
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
