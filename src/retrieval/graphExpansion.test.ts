import assert from "node:assert/strict";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { searchSymbols } from "./searchSymbols";
import {
  computeInDegreeCentrality,
  expandGraphCandidates,
  ExpansionRelation,
} from "./graphExpansion";
import { seedHybridDjangoFixture } from "./hybridFixture";

test("expansion walks contains, references, and same-module edges from a seed", () => {
  const db = openIndexerDatabase();
  try {
    const ids = seedHybridDjangoFixture(db);

    const expanded = expandGraphCandidates(db, [ids.aggregate]);
    const byId = new Map(expanded.map((candidate) => [candidate.symbol.id, candidate]));

    // contains: Aggregate -> as_sql.
    assert.ok(byId.has(ids.aggregateAsSql));
    // references (inheritance): Count -> Aggregate, reachable incoming.
    assert.ok(byId.has(ids.count));
    // same module: query.py::QuerySet sits in the same package directory.
    assert.ok(byId.has(ids.querySet));

    const asSqlEvidence = byId.get(ids.aggregateAsSql)?.evidence ?? [];
    assert.ok(asSqlEvidence.some((item) => item.relation === ExpansionRelation.Contains));
  } finally {
    db.close();
  }
});

test("graph expansion adds a candidate lexical search alone never found", () => {
  const db = openIndexerDatabase();
  try {
    const ids = seedHybridDjangoFixture(db);

    // Lexical retrieval for "Aggregate" matches the aggregate symbols (name +
    // docstring) but has no token/docstring overlap with QuerySet.
    const lexical = searchSymbols(db, { query: "Aggregate", maxResults: 10 });
    const lexicalIds = new Set(lexical.map((result) => result.symbolId));
    assert.equal(lexicalIds.has(ids.querySet), false);

    const expanded = expandGraphCandidates(db, [...lexicalIds]);
    const novel = expanded.filter((candidate) => !lexicalIds.has(candidate.symbol.id));

    // The expansion pulls in QuerySet — a candidate lexical search missed.
    assert.ok(novel.some((candidate) => candidate.symbol.id === ids.querySet));
  } finally {
    db.close();
  }
});

test("expansion is bounded by maxExpandedCandidates and depth", () => {
  const db = openIndexerDatabase();
  try {
    const ids = seedHybridDjangoFixture(db);

    const capped = expandGraphCandidates(db, [ids.aggregate], {
      maxExpandedCandidates: 1,
      includeSameModule: false,
    });
    assert.equal(capped.length, 1);

    // Determinism: same inputs -> identical output.
    const first = expandGraphCandidates(db, [ids.count]);
    const second = expandGraphCandidates(db, [ids.count]);
    assert.deepEqual(first, second);
  } finally {
    db.close();
  }
});

test("in-degree centrality counts incoming dependents within the working set", () => {
  const db = openIndexerDatabase();
  try {
    const ids = seedHybridDjangoFixture(db);

    const centrality = computeInDegreeCentrality(db, [
      ids.count,
      ids.aggregate,
      ids.querySet,
    ]);

    // Count is depended on by QuerySet (calls) and the test (imports).
    assert.ok((centrality.get(ids.count) ?? 0) >= 2);
    // QuerySet has nothing pointing at it in this fixture.
    assert.equal(centrality.get(ids.querySet) ?? 0, 0);
  } finally {
    db.close();
  }
});
