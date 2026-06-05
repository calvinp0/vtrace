import assert from "node:assert/strict";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { shapeSweQuery } from "../capsule/sweQueryShaping";
import { hybridRetrieve, HybridCandidateSource } from "./hybridRetrieval";
import { seedHybridDjangoFixture } from "./hybridFixture";

const SCORE_KEYS = [
  "lexical",
  "fts",
  "tfidf",
  "symbol",
  "path",
  "graph",
  "centrality",
  "inDegree",
  "localEvidence",
  "hubPenalty",
  "final",
] as const;

function firstImplementation(filePathFragment: string, candidates: ReturnType<typeof hybridRetrieve>["candidates"]) {
  return candidates.find(
    (candidate) =>
      candidate.filePath.includes(filePathFragment) && !/tests?\//.test(candidate.filePath),
  );
}

test("recovers the aggregate implementation target from a failing test (10880-style)", () => {
  const db = openIndexerDatabase();
  try {
    seedHybridDjangoFixture(db);
    const shaped = shapeSweQuery({
      problemStatement: "Count annotation with distinct=True produces wrong SQL in aggregates",
      failToPass: [
        "tests/aggregation/tests.py::AggregateTestCase::test_count_distinct_expression",
      ],
    });

    const { candidates } = hybridRetrieve(db, { query: shaped.query, shaped });

    const impl = firstImplementation("aggregates.py", candidates);
    assert.ok(impl, `expected an aggregates.py target, got ${JSON.stringify(candidates.map((c) => c.filePath))}`);
    // It was reached via the failing test's import edge.
    assert.ok(impl?.sources.includes(HybridCandidateSource.Test));
    assert.ok(impl?.evidence.some((line) => /test file .*imports/.test(line)));
  } finally {
    db.close();
  }
});

test("recovers the ModelAdmin options target from a failing test (11095-style)", () => {
  const db = openIndexerDatabase();
  try {
    const ids = seedHybridDjangoFixture(db);
    const shaped = shapeSweQuery({
      problemStatement: "add ModelAdmin.get_inlines() hook to set inlines based on the request",
      failToPass: [
        "admin_inlines.tests.GenericInlineModelAdminTest.test_get_inline_instances_override_get_inlines",
      ],
    });

    const { candidates } = hybridRetrieve(db, { query: shaped.query, shaped });
    assert.ok(
      candidates.some((candidate) => candidate.symbolId === ids.modelAdmin),
      `expected ModelAdmin in pool, got ${JSON.stringify(candidates.map((c) => c.fqName))}`,
    );
  } finally {
    db.close();
  }
});

test("every candidate carries a full, stable score breakdown and evidence", () => {
  const db = openIndexerDatabase();
  try {
    seedHybridDjangoFixture(db);
    const shaped = shapeSweQuery({
      problemStatement: "Count annotation distinct aggregate",
      failToPass: [
        "tests/aggregation/tests.py::AggregateTestCase::test_count_distinct_expression",
      ],
    });

    const run = () => hybridRetrieve(db, { query: shaped.query, shaped });
    const first = run();
    const second = run();

    // Deterministic across runs (Requirement 5: diagnostics stable).
    assert.deepEqual(first, second);

    assert.ok(first.candidates.length > 0);
    for (const candidate of first.candidates) {
      for (const key of SCORE_KEYS) {
        assert.equal(
          typeof candidate.scores[key],
          "number",
          `missing score component ${key}`,
        );
        assert.ok(candidate.scores[key] >= 0);
      }
      assert.ok(candidate.sources.length > 0);
      assert.ok(Array.isArray(candidate.evidence));
    }

    // Sorted by final score, descending.
    for (let index = 1; index < first.candidates.length; index += 1) {
      assert.ok(
        first.candidates[index - 1]!.scores.final >= first.candidates[index]!.scores.final,
      );
    }
  } finally {
    db.close();
  }
});

test("graph expansion lets a non-lexical neighbour enter the ranked pool", () => {
  const db = openIndexerDatabase();
  try {
    const ids = seedHybridDjangoFixture(db);
    // A query that lexically names only the aggregate area; QuerySet shares no
    // lexical token but is a same-module / call neighbour.
    const shaped = shapeSweQuery({ problemStatement: "Aggregate count distinct expression" });

    const { candidates } = hybridRetrieve(db, { query: shaped.query, shaped, maxResults: 20 });
    const querySet = candidates.find((candidate) => candidate.symbolId === ids.querySet);

    assert.ok(querySet, "expected QuerySet to enter the pool via graph expansion");
    assert.ok(querySet?.sources.includes(HybridCandidateSource.Graph));
    assert.ok(querySet ? querySet.scores.graph > 0 : false);
  } finally {
    db.close();
  }
});

test("a high-centrality hub with no local evidence is penalized and outranked", () => {
  const db = openIndexerDatabase();
  try {
    const ids = seedHybridDjangoFixture(db);
    // 10880-style: the failing test exercises the aggregate implementation; the
    // base Model class is only a central hub reachable through inheritance.
    const shaped = shapeSweQuery({
      problemStatement: "Count annotation with distinct=True produces wrong SQL in aggregates",
      failToPass: [
        "tests/aggregation/tests.py::AggregateTestCase::test_count_distinct_expression",
      ],
    });

    const { candidates } = hybridRetrieve(db, { query: shaped.query, shaped, maxResults: 20 });
    const model = candidates.find((candidate) => candidate.symbolId === ids.model);

    // The hub is in the pool, flagged as a hub, and penalized.
    assert.ok(model, "expected Model hub to enter the pool");
    assert.ok((model?.scores.inDegree ?? 0) >= 5, "Model should have high in-degree");
    assert.equal(model?.scores.localEvidence ?? -1, 0, "Model should have no local evidence");
    assert.ok((model?.scores.hubPenalty ?? 0) > 0, "Model should be penalized");
    assert.ok(
      model?.evidence.some((line) => /downranked: generic hub/.test(line)),
      "penalty should be explained in evidence",
    );

    // The locally-relevant aggregate target outranks the hub.
    const aggregateIndex = candidates.findIndex((c) => c.filePath.includes("aggregates.py"));
    const modelIndex = candidates.findIndex((c) => c.symbolId === ids.model);
    assert.ok(aggregateIndex !== -1 && aggregateIndex < modelIndex,
      `aggregates.py (#${aggregateIndex}) should rank before base.py::Model (#${modelIndex})`);
  } finally {
    db.close();
  }
});
