// Micro recovery + skip-diagnosis tests.
//
// Two concerns:
//   1. recoverMicroCapsule exposes the FULL candidate accounting — the pool size
//      and the rejected (discarded) candidates — not just the emitted pivots, so
//      a caller can tell an over-strict pivot gate from an empty recovery.
//   2. classifyMicroSkipReason turns "no pivot" into a precise, mutually-exclusive
//      diagnosis (Requirement 2): no candidates vs only-support vs low-actionability
//      vs below-threshold vs ambiguous.
//
// The fixture recoveries (1/2) run over the real hybrid Django index so the
// 10880-style aggregate target and 11095-style admin-options target are recovered
// with genuine domain/path/test evidence — they must NOT skip. The classifier
// cases (3) use synthetic candidates so each reason is exercised in isolation.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { seedHybridDjangoFixture } from "../retrieval/hybridFixture";
import { SymbolKind } from "../domain/types";
import type { HybridCandidate } from "../retrieval/hybridRetrieval";
import type { HybridScoreComponents } from "../retrieval/hybridScoring";
import { CandidateRole, type RoledCandidate } from "./assignCandidateRoles";
import {
  classifyMicroSkipReason,
  recoverMicroCapsule,
  type MicroCapsuleRecovery,
} from "./microTargets";
import { shapeSweQuery } from "./sweQueryShaping";

function recoverFor(problemStatement: string, failToPass: string[]): MicroCapsuleRecovery {
  const db = openIndexerDatabase();
  try {
    seedHybridDjangoFixture(db);
    const shaped = shapeSweQuery({ problemStatement, failToPass });
    return recoverMicroCapsule(db, shaped, { maxTargets: 1, poolSize: 30 });
  } finally {
    db.close();
  }
}

// --- (1/2) the two small/local targets are recovered, never skipped ------------

test("10880-style: an aggregates.py target with domain/path evidence is a pivot, not a skip", () => {
  const recovery = recoverFor(
    "Count annotation with distinct=True produces wrong SQL in aggregates",
    ["tests/aggregation/tests.py::AggregateTestCase::test_count_distinct_expression"],
  );

  assert.equal(recovery.pivots.length, 1, "expected exactly one micro pivot (no skip)");
  assert.ok(
    recovery.pivots[0]!.filePath.includes("aggregates.py"),
    `pivot should be in aggregates.py, got ${recovery.pivots[0]!.filePath}`,
  );
  // Sufficient evidence: the pivot clears the local-evidence bar on a concrete
  // pointer, not graph reach alone.
  assert.ok(recovery.pivots[0]!.scores.localEvidence >= 0.3);
});

test("11095-style: an admin options.py target with issue/test evidence is a pivot, not a skip", () => {
  const recovery = recoverFor(
    "Add ModelAdmin.get_inlines() hook to set inlines based on the request",
    ["admin_inlines.tests.GenericInlineModelAdminTest.test_get_inline_instances_override_get_inlines"],
  );

  assert.equal(recovery.pivots.length, 1, "expected exactly one micro pivot (no skip)");
  assert.ok(
    recovery.pivots[0]!.filePath.includes("admin/options.py"),
    `pivot should be in admin/options.py, got ${recovery.pivots[0]!.filePath}`,
  );
});

test("a recovery exposes the full pool: candidateCount and the discarded rejects", () => {
  const recovery = recoverFor(
    "Count annotation with distinct=True produces wrong SQL in aggregates",
    ["tests/aggregation/tests.py::AggregateTestCase::test_count_distinct_expression"],
  );

  // The pool the gate ran over reconciles with pivots + support + discarded.
  assert.ok(recovery.candidateCount > 0);
  assert.equal(
    recovery.candidateCount,
    recovery.pivots.length + recovery.support.length + recovery.discarded.length,
  );
  // The failing test method is recovered but discarded (never an edit target),
  // and the discard carries the role-assignment reason.
  const testDiscard = recovery.discarded.find((entry) =>
    entry.candidate.localName.startsWith("test_"),
  );
  assert.ok(testDiscard, "the failing test method should be a discarded candidate");
  assert.match(testDiscard!.why, /discard: a test symbol/);
});

test("the generic Model hub is never promoted to a micro pivot", () => {
  const recovery = recoverFor(
    "Count annotation with distinct=True produces wrong SQL in aggregates",
    ["tests/aggregation/tests.py::AggregateTestCase::test_count_distinct_expression"],
  );

  const modelIsPivot = recovery.pivots.some((p) => p.filePath.includes("base.py"));
  assert.equal(modelIsPivot, false, "the framework hub (base.py Model) must not be a pivot");
});

// --- (3) the skip-reason taxonomy, one synthetic case per reason ---------------

function scores(overrides: Partial<HybridScoreComponents> = {}): HybridScoreComponents {
  return {
    lexical: 0,
    fts: 0,
    tfidf: 0,
    bm25: 0,
    symbol: 0,
    path: 0,
    testToImpl: 0,
    domain: 0,
    graph: 0,
    graphProximity: 0,
    centrality: 0,
    actionability: 1,
    inDegree: 0,
    localEvidence: 0,
    hubPenalty: 0,
    actionabilityPenalty: 0,
    final: 0.1,
    ...overrides,
  };
}

function candidate(
  localName: string,
  kind: SymbolKind,
  overrides: Partial<HybridScoreComponents> = {},
): HybridCandidate {
  return {
    symbolId: `id:${localName}`,
    filePath: `django/x/${localName}.py`,
    fqName: `django.x.${localName}`,
    localName,
    kind,
    scores: scores(overrides),
    sources: [],
    evidence: [],
    matches: [],
  };
}

function discardedRecovery(
  candidates: readonly HybridCandidate[],
  options: { ambiguous?: boolean; candidateCount?: number; support?: readonly HybridCandidate[] } = {},
): MicroCapsuleRecovery {
  const discarded: RoledCandidate[] = candidates.map((c) => ({
    candidate: c,
    role: CandidateRole.Support,
    why: "support: synthetic",
  }));
  const support = options.support ?? [];
  return {
    roled: support.map((c) => ({ candidate: c, role: CandidateRole.Support, why: "support: synthetic" })),
    pivots: [],
    support: [...support],
    candidateCount: options.candidateCount ?? candidates.length + support.length,
    discarded,
    ambiguous: options.ambiguous ?? false,
  };
}

test("skip reason distinguishes an empty pool from a discarded pool", () => {
  const empty = discardedRecovery([], { candidateCount: 0 });
  assert.equal(classifyMicroSkipReason(empty), "no candidates recovered");

  // Candidates WERE recovered (a low-actionability module var), so the skip is a
  // discard, not an empty pool.
  const discarded = discardedRecovery([
    candidate("compiler", SymbolKind.ModuleVariable, { actionability: 0, domain: 0.9, localEvidence: 0.5 }),
  ]);
  assert.notEqual(classifyMicroSkipReason(discarded), "no candidates recovered");
});

test("skip reason: only tests recovered reads as no candidates", () => {
  const onlyTests = discardedRecovery([
    candidate("test_thing", SymbolKind.Method, { symbol: 0.4, localEvidence: 0.4 }),
  ]);
  // test_thing lives in a non-test path here, so force the test classification by
  // putting it under a tests/ file.
  onlyTests.discarded[0]!.candidate.filePath = "tests/x/test_thing.py";
  onlyTests.discarded[0]!.candidate.fqName = "tests.x.test_thing";
  assert.equal(classifyMicroSkipReason(onlyTests), "no candidates recovered");
});

test("skip reason: every actionable candidate failed -> not blindly promoted", () => {
  // All candidates are low-actionability module variables.
  const lowAction = discardedRecovery([
    candidate("settings", SymbolKind.ModuleVariable, { actionability: 0, domain: 0.8, localEvidence: 0.6 }),
    candidate("config", SymbolKind.ModuleConstant, { actionability: 0, lexical: 0.4, localEvidence: 0.5 }),
  ]);
  assert.equal(
    classifyMicroSkipReason(lowAction),
    "candidates recovered but all were low-actionability",
  );
});

test("skip reason: actionable candidates with no direct evidence are support-only", () => {
  // Actionable kind, but reached ONLY by graph/domain proximity (no symbol/path/
  // test pointer, weak lexical) — exactly the support-only neighbour that must not
  // be promoted blindly.
  const supportOnly = discardedRecovery([
    candidate("helper", SymbolKind.Function, { graph: 0.9, domain: 0.4, lexical: 0.2, localEvidence: 0.5 }),
  ]);
  assert.equal(
    classifyMicroSkipReason(supportOnly),
    "candidates recovered but only support-role",
  );
});

test("skip reason: an actionable, directly-pointed near-miss is below the confidence threshold", () => {
  // Actionable + a concrete path pointer (direct evidence) but its local evidence
  // fell just short of the pivot bar.
  const nearMiss = discardedRecovery([
    candidate("save", SymbolKind.Method, { path: 0.6, actionability: 1, localEvidence: 0.2 }),
  ]);
  assert.equal(
    classifyMicroSkipReason(nearMiss),
    "candidates recovered but below pivot confidence threshold",
  );
});

test("skip reason: an ambiguous recovery is reported as such", () => {
  const ambiguous = discardedRecovery(
    [candidate("save", SymbolKind.Method, { path: 0.6 })],
    { ambiguous: true },
  );
  assert.equal(
    classifyMicroSkipReason(ambiguous),
    "candidates recovered but ambiguous micro pivot",
  );
});
