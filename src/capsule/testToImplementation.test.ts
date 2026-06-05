import assert from "node:assert/strict";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { seedHybridDjangoFixture } from "../retrieval/hybridFixture";
import { ExpansionRelation } from "../retrieval/graphExpansion";
import { shapeSweQuery } from "./sweQueryShaping";
import { expandTestsToImplementation } from "./testToImplementation";

test("pytest node id -> test file imports -> implementation candidates", () => {
  const db = openIndexerDatabase();
  try {
    const ids = seedHybridDjangoFixture(db);

    const shaped = shapeSweQuery({
      failToPass: [
        "tests/aggregation/tests.py::AggregateTestCase::test_count_distinct_expression",
      ],
    });

    const candidates = expandTestsToImplementation(db, shaped);
    const byId = new Map(candidates.map((candidate) => [candidate.symbol.id, candidate]));

    // The test imports both Count and Aggregate from aggregates.py.
    assert.ok(byId.has(ids.count));
    assert.ok(byId.has(ids.aggregate));
    // No test symbol is ever offered as an edit target.
    assert.ok(candidates.every((candidate) => !/test/i.test(candidate.symbol.filePath)));
    // The relation and evidence explain WHY.
    assert.ok(byId.get(ids.count)?.relations.includes(ExpansionRelation.Imports));
    assert.ok(
      byId.get(ids.count)?.evidence.some((line) => line.includes("imports") && line.includes("Count")),
    );
  } finally {
    db.close();
  }
});

test("Django dotted node id resolves the test class by name then its imports", () => {
  const db = openIndexerDatabase();
  try {
    const ids = seedHybridDjangoFixture(db);

    const shaped = shapeSweQuery({
      failToPass: [
        "admin_inlines.tests.GenericInlineModelAdminTest.test_get_inline_instances_override_get_inlines",
      ],
    });

    const candidates = expandTestsToImplementation(db, shaped);
    assert.ok(candidates.some((candidate) => candidate.symbol.id === ids.modelAdmin));
    assert.ok(candidates.every((candidate) => candidate.symbol.id !== ids.inlineAdminTest));
  } finally {
    db.close();
  }
});

test("no failing tests yields no test-derived candidates", () => {
  const db = openIndexerDatabase();
  try {
    seedHybridDjangoFixture(db);
    const shaped = shapeSweQuery({ problemStatement: "some prose with no test ids" });
    assert.deepEqual(expandTestsToImplementation(db, shaped), []);
  } finally {
    db.close();
  }
});
