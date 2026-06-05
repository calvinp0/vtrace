// Role-assignment policy tests.
//
// Exercises the pivot/support/discard rules of Requirement 2/3 directly on the
// hybrid Django fixture (a real aggregate target, a generic `Model` hub, and a
// low-actionability `compiler` module variable share one index).

import assert from "node:assert/strict";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { hybridRetrieve } from "../retrieval/hybridRetrieval";
import { seedHybridDjangoFixture } from "../retrieval/hybridFixture";
import { shapeSweQuery } from "./sweQueryShaping";
import { assignCandidateRoles, CandidateRole } from "./assignCandidateRoles";

function roleAssignmentFor(problemStatement: string, failToPass: string[]) {
  const db = openIndexerDatabase();
  try {
    const ids = seedHybridDjangoFixture(db);
    const shaped = shapeSweQuery({ problemStatement, failToPass });
    const { candidates } = hybridRetrieve(db, { query: shaped.query, shaped, maxResults: 25 });
    const roled = assignCandidateRoles(candidates);
    const bySymbol = new Map(roled.map((r) => [r.candidate.symbolId, r]));
    return { ids, roled, bySymbol };
  } finally {
    db.close();
  }
}

test("the aggregate edit target is a pivot; the framework hub never is", () => {
  const { ids, roled, bySymbol } = roleAssignmentFor(
    "Count annotation with distinct=True produces wrong SQL in aggregates",
    ["tests/aggregation/tests.py::AggregateTestCase::test_count_distinct_expression"],
  );

  // The aggregates.py implementation is selected as a pivot.
  const aggregatePivot = roled.some(
    (r) => r.candidate.filePath.includes("aggregates.py") && r.role === CandidateRole.Pivot,
  );
  assert.ok(aggregatePivot, "an aggregates.py symbol must be a pivot");

  // The generic Model hub is support at most — never a pivot.
  const model = bySymbol.get(ids.model);
  assert.ok(model, "Model should be in the pool");
  assert.notEqual(model?.role, CandidateRole.Pivot, "the framework hub must not be a pivot");
});

test("a low-actionability module variable is never a pivot", () => {
  const { ids, bySymbol } = roleAssignmentFor(
    "Count annotation with distinct=True produces wrong SQL in aggregates",
    ["tests/aggregation/tests.py::AggregateTestCase::test_count_distinct_expression"],
  );

  const compiler = bySymbol.get(ids.compilerVar);
  if (compiler) {
    assert.notEqual(compiler.role, CandidateRole.Pivot,
      "a module-level config variable must not be a pivot");
    assert.match(compiler.why, /low-actionability/);
  }
});

test("a test symbol is always discarded as an edit target", () => {
  const { ids, bySymbol } = roleAssignmentFor(
    "Count annotation with distinct=True produces wrong SQL in aggregates",
    ["tests/aggregation/tests.py::AggregateTestCase::test_count_distinct_expression"],
  );

  const testMethod = bySymbol.get(ids.aggregateTestMethod);
  if (testMethod) {
    assert.equal(testMethod.role, CandidateRole.Discard, "the failing test method is not an edit target");
  }
});

test("a pivot's why explains why it is a pivot", () => {
  const { roled } = roleAssignmentFor(
    "add ModelAdmin.get_inlines() hook to set inlines based on the request",
    ["admin_inlines.tests.GenericInlineModelAdminTest.test_get_inline_instances_override_get_inlines"],
  );
  const pivot = roled.find((r) => r.role === CandidateRole.Pivot);
  assert.ok(pivot, "expected at least one pivot");
  assert.match(pivot!.why, /^pivot: actionable/);
});
