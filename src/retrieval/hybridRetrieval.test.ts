import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";

import type { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../db/sqlite";
import { persistParseResult } from "../db/persistParseResult";
import {
  Language,
  SymbolKind,
  buildFQName,
  computeFileId,
  computeSymbolId,
} from "../domain/types";
import { shapeSweQuery } from "../capsule/sweQueryShaping";
import { extractBodyLiterals, bodyLiteralsSearchText } from "../indexer/extractBodyLiterals";
import { hybridRetrieve, HybridCandidateSource } from "./hybridRetrieval";
import { seedHybridDjangoFixture } from "./hybridFixture";

interface SymbolSpec {
  localName: string;
  kind: SymbolKind;
  parent?: string;
  docstring?: string;
  /** Source body text — its distinctive literals are indexed for body search. */
  body?: string;
}

// Persist a single file's worth of top-level symbols, for a minimal hand-built
// pool. A spec's `body` is run through the body-literal extractor and indexed, so
// body-literal retrieval can be exercised without a real on-disk file.
function persistSymbolFile(
  db: Database,
  filePath: string,
  specs: ReadonlyArray<SymbolSpec>,
): void {
  const content = `# ${filePath}\n`;
  const symbols = specs.map((spec, index) => {
    const symbolPath = spec.parent ? [spec.parent, spec.localName] : [spec.localName];
    const fqName = buildFQName({ filePath, symbolPath });
    const startByte = index * 100;
    const endByte = startByte + 60;
    return {
      id: computeSymbolId({ filePath, fqName, kind: spec.kind, startByte, endByte }),
      filePath,
      fqName,
      localName: spec.localName,
      kind: spec.kind,
      signature: `${spec.kind} ${spec.localName}`,
      ...(spec.docstring === undefined ? {} : { docstring: spec.docstring }),
      startLine: index + 1,
      endLine: index + 1,
      startByte,
      endByte,
      exported: true,
    };
  });
  const bodyLiterals = symbols
    .map((symbol, index) => ({ symbol, body: specs[index]!.body ?? "" }))
    .filter(({ body }) => body.length > 0)
    .map(({ symbol, body }) => ({
      symbolId: symbol.id,
      literalsText: bodyLiteralsSearchText(extractBodyLiterals(body)),
    }))
    .filter((entry) => entry.literalsText.length > 0);

  persistParseResult(
    db,
    {
      file: {
        id: computeFileId(filePath),
        path: filePath,
        language: Language.Python,
        contentHash: createHash("sha256").update(content).digest("hex"),
        sizeBytes: Buffer.byteLength(content),
      },
      symbols,
      edges: [],
      diagnostics: [],
    },
    { bodyLiterals },
  );
}

const SCORE_KEYS = [
  "lexical",
  "fts",
  "tfidf",
  "bm25",
  "symbol",
  "path",
  "testToImpl",
  "domain",
  "graph",
  "graphProximity",
  "centrality",
  "actionability",
  "inDegree",
  "localEvidence",
  "hubPenalty",
  "actionabilityPenalty",
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
    // It was reached via the failing test's import edge (test_to_impl route),
    // and that pull is recorded on the dedicated testToImpl signal, not graph.
    assert.ok(impl?.sources.includes(HybridCandidateSource.TestToImpl));
    assert.ok((impl?.scores.testToImpl ?? 0) > 0);
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

test("candidates are sorted strictly by final score", () => {
  const db = openIndexerDatabase();
  try {
    seedHybridDjangoFixture(db);
    const shaped = shapeSweQuery({
      problemStatement: "Count annotation distinct aggregation produces wrong SQL",
      failToPass: [
        "tests/aggregation/tests.py::AggregateTestCase::test_count_distinct_expression",
      ],
    });

    const { candidates } = hybridRetrieve(db, { query: shaped.query, shaped, maxResults: 20 });
    for (let index = 1; index < candidates.length; index += 1) {
      assert.ok(
        candidates[index - 1]!.scores.final >= candidates[index]!.scores.final,
        `candidate #${index - 1} final must be >= #${index}`,
      );
    }
  } finally {
    db.close();
  }
});

test("'multiple OneToOne' does not let multiple_chunks outrank the OneToOne model target", () => {
  const db = openIndexerDatabase();
  try {
    // A decoy whose NAME shares only the generic word "multiple" with the task,
    // and the genuine field target the task is actually about.
    persistSymbolFile(db, "django/core/files/base.py", [
      {
        localName: "multiple_chunks",
        kind: SymbolKind.Method,
        parent: "File",
        // Rich docstring so it is admitted to the pool on shared terms — but its
        // NAME ("multiple_chunks") still overlaps the task only on the generic
        // "multiple", which is exactly the spurious pull the down-weighting targets.
        docstring: "A model with multiple references to the same parent fails when reading chunks.",
      },
    ]);
    persistSymbolFile(db, "django/db/models/fields/related.py", [
      {
        localName: "OneToOneField",
        kind: SymbolKind.Class,
        docstring: "A OneToOneField on a model, referencing a parent model.",
      },
    ]);

    const shaped = shapeSweQuery({
      problemStatement:
        "A model with multiple OneToOneField references to the same parent fails.",
    });
    const { candidates } = hybridRetrieve(db, { query: shaped.query, shaped, maxResults: 20 });

    const chunksIndex = candidates.findIndex((c) => c.localName === "multiple_chunks");
    const oneToOneIndex = candidates.findIndex((c) => c.localName === "OneToOneField");
    assert.ok(chunksIndex !== -1 && oneToOneIndex !== -1, "both candidates should be in the pool");

    const chunks = candidates[chunksIndex]!;
    // The decoy's lexical match is explained only by the generic "multiple": its
    // blended lexical score is down-weighted, and the reason is inspectable.
    assert.ok(
      chunks.evidence.some((line) => /lexical down-weighted.*multiple/.test(line)),
      `expected a down-weight evidence line, got ${JSON.stringify(chunks.evidence)}`,
    );
    // And it must not rank above the genuine OneToOne model target on "multiple" alone.
    assert.ok(
      oneToOneIndex < chunksIndex,
      `OneToOneField (#${oneToOneIndex}) should rank above multiple_chunks (#${chunksIndex})`,
    );
  } finally {
    db.close();
  }
});

test("a low-actionability module variable ranks below the actionable aggregate target", () => {
  const db = openIndexerDatabase();
  try {
    const ids = seedHybridDjangoFixture(db);
    // 10880-style: a SQL-flavoured aggregate task. The sql/subqueries.py
    // `compiler` module variable matches on the "sql" path segment and is
    // graph-reachable, but it is a string constant, not an edit target.
    const shaped = shapeSweQuery({
      problemStatement: "Count annotation with distinct=True produces wrong SQL in aggregates",
      failToPass: [
        "tests/aggregation/tests.py::AggregateTestCase::test_count_distinct_expression",
      ],
    });

    const { candidates } = hybridRetrieve(db, { query: shaped.query, shaped, maxResults: 20 });
    const compiler = candidates.find((c) => c.symbolId === ids.compilerVar);
    assert.ok(compiler, "expected the compiler module variable to enter the pool");

    // It is flagged low-actionability and penalized.
    assert.equal(compiler?.scores.actionability, 0);
    assert.ok((compiler?.scores.actionabilityPenalty ?? 0) > 0, "module var should be penalized");
    assert.ok(
      compiler?.evidence.some((line) => /low-actionability/.test(line)),
      "penalty should be explained in evidence",
    );

    // An actionable aggregate symbol (method/class) ranks above it.
    const aggregateIndex = candidates.findIndex(
      (c) => c.filePath.includes("aggregates.py") && c.scores.actionability === 1,
    );
    const compilerIndex = candidates.findIndex((c) => c.symbolId === ids.compilerVar);
    assert.ok(aggregateIndex !== -1 && aggregateIndex < compilerIndex,
      `an aggregate target (#${aggregateIndex}) must rank before compiler (#${compilerIndex})`);
    assert.ok(
      (candidates[aggregateIndex]?.scores.final ?? 0) > (compiler?.scores.final ?? 0),
      "the aggregate target must have a higher final score",
    );
  } finally {
    db.close();
  }
});

// ----- body-literal retrieval -------------------------------------------------

test("a diagnostic code in the task recovers the symbol that emits it from its body", () => {
  const db = openIndexerDatabase();
  try {
    // The emitting method's NAME and signature say nothing about the code; only
    // its body carries `models.E015`.
    persistSymbolFile(db, "django/db/models/base.py", [
      {
        localName: "_check_ordering",
        kind: SymbolKind.Method,
        parent: "Model",
        body: "def _check_ordering(cls):\n    return [Error('bad ordering', id='models.E015')]\n",
      },
    ]);
    // An unrelated lexical decoy that shares the prose word "ordering".
    persistSymbolFile(db, "django/db/models/sql/compiler.py", [
      { localName: "find_ordering_name", kind: SymbolKind.Method, parent: "SQLCompiler" },
    ]);

    const shaped = shapeSweQuery({
      problemStatement: "models.E015 is raised when Meta.ordering contains a related field.",
    });
    const { candidates, bodyLiteralMatches } = hybridRetrieve(db, {
      query: shaped.query,
      shaped,
      taskText: "models.E015 is raised when Meta.ordering contains a related field.",
      maxResults: 20,
    });

    const emitter = candidates.find((c) => c.localName === "_check_ordering");
    assert.ok(emitter, "the body-literal emitter must be recovered into the pool");
    assert.ok(emitter!.sources.includes(HybridCandidateSource.BodyLiteral));
    assert.ok(emitter!.scores.bodyLiteral > 0, "body-literal signal is set");
    assert.ok(
      emitter!.evidence.some((line) => /task literal `models\.E015` appears in symbol body/.test(line)),
      `expected body-literal evidence, got ${JSON.stringify(emitter!.evidence)}`,
    );
    assert.ok(
      bodyLiteralMatches.some((m) => m.literal === "models.E015" && m.symbol === "_check_ordering"),
      "the match is surfaced for diagnostics",
    );
  } finally {
    db.close();
  }
});

test("an exact diagnostic-code body match outranks an unrelated lexical candidate", () => {
  const db = openIndexerDatabase();
  try {
    persistSymbolFile(db, "django/db/models/base.py", [
      {
        localName: "_check_ordering",
        kind: SymbolKind.Method,
        parent: "Model",
        body: "def _check_ordering(cls):\n    return [Error('msg', id='models.E015')]\n",
      },
    ]);
    // Decoys that match the prose lexically ("ordering", "field") but emit no code.
    persistSymbolFile(db, "django/db/models/sql/compiler.py", [
      { localName: "find_ordering_name", kind: SymbolKind.Method, parent: "SQLCompiler", docstring: "ordering field ordering field name" },
      { localName: "get_ordering", kind: SymbolKind.Method, parent: "Query", docstring: "ordering field ordering field clause" },
    ]);

    const task = "models.E015 is raised when Meta.ordering contains a related field.";
    const shaped = shapeSweQuery({ problemStatement: task });
    const { candidates } = hybridRetrieve(db, { query: shaped.query, shaped, taskText: task, maxResults: 20 });

    const emitterIdx = candidates.findIndex((c) => c.localName === "_check_ordering");
    assert.ok(emitterIdx !== -1, "emitter is in the pool");
    // It outranks every lexical-only decoy.
    const decoyIdxs = candidates
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.localName !== "_check_ordering")
      .map(({ i }) => i);
    for (const idx of decoyIdxs) {
      assert.ok(emitterIdx < idx, `emitter (#${emitterIdx}) must outrank decoy #${idx}`);
    }
  } finally {
    db.close();
  }
});

test("a quoted distinctive message in the task recovers the symbol that raises it", () => {
  const db = openIndexerDatabase();
  try {
    persistSymbolFile(db, "django/db/models/sql/query.py", [
      {
        localName: "names_to_path",
        kind: SymbolKind.Method,
        parent: "Query",
        body: "def names_to_path(self):\n    raise FieldError('Cannot resolve keyword %r into field')\n",
      },
    ]);

    const task = 'A query fails with "Cannot resolve keyword" when the field is missing.';
    const shaped = shapeSweQuery({ problemStatement: task });
    const { candidates, bodyLiteralMatches } = hybridRetrieve(db, {
      query: shaped.query,
      shaped,
      taskText: task,
      maxResults: 20,
    });

    const emitter = candidates.find((c) => c.localName === "names_to_path");
    assert.ok(emitter, "the message-emitting symbol is recovered");
    assert.ok(emitter!.sources.includes(HybridCandidateSource.BodyLiteral));
    assert.ok(bodyLiteralMatches.some((m) => /Cannot resolve keyword/.test(m.literal)));
  } finally {
    db.close();
  }
});

test("generic body words never create a body-literal candidate", () => {
  const db = openIndexerDatabase();
  try {
    // A body full of generic words but no distinctive literal.
    persistSymbolFile(db, "django/core/handlers/base.py", [
      {
        localName: "handle_error",
        kind: SymbolKind.Method,
        parent: "BaseHandler",
        body: "def handle_error(self):\n    error = 'multiple failed'\n    return error\n",
      },
    ]);

    const task = "An error occurred: multiple requests failed during the change.";
    const shaped = shapeSweQuery({ problemStatement: task });
    const { candidates, bodyLiteralMatches } = hybridRetrieve(db, {
      query: shaped.query,
      shaped,
      taskText: task,
      maxResults: 20,
    });

    assert.deepEqual(bodyLiteralMatches, [], "generic words must not produce body-literal matches");
    const symbol = candidates.find((c) => c.localName === "handle_error");
    if (symbol) {
      assert.ok(!symbol.sources.includes(HybridCandidateSource.BodyLiteral));
      assert.equal(symbol.scores.bodyLiteral, 0);
    }
  } finally {
    db.close();
  }
});
