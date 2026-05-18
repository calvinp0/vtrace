import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { persistParseResult } from "../db/persistParseResult";
import { openIndexerDatabase } from "../db/sqlite";
import { EdgeType, SymbolKind, type ParseResult, type SymbolRecord } from "../domain/types";
import { indexProject } from "../indexer/indexProject";
import { withMixedPyCythonRepo } from "../testing/mixedPyCythonFixture";
import { searchSymbols } from "./searchSymbols";
import { rerankGraph } from "./rerankGraph";
import { searchSymbolsGraph } from "./searchSymbolsGraph";
import {
  makeSearchParseResult,
  seedNarrowQuerySearchFixture,
  seedSearchFixture,
  seedWorkflowSearchFixture,
} from "./testUtils";
import { GraphScoreSignal, SymbolSearchBackend } from "./types";

test("graph-connected candidates receive expected bonus", () => {
  const db = openIndexerDatabase();

  try {
    seedGraphFixture(db);

    const results = searchSymbolsGraph(db, { query: "Session", maxResults: 6 });
    const service = findGraphResult(results, "SessionService");
    const store = findGraphResult(results, "SessionStore");

    assert.equal(service.graphScore > 0, true);
    assert.equal(store.graphScore, 0);
    assert.equal(service.finalScore > store.finalScore, true);
  } finally {
    db.close();
  }
});

test("contains and imports neighborhoods affect reranking deterministically", () => {
  const db = openIndexerDatabase();

  try {
    seedGraphFixture(db);

    const results = searchSymbolsGraph(db, { query: "Session", maxResults: 6 });
    const service = findGraphResult(results, "SessionService");
    const createSession = findGraphResult(results, "createSession");

    assert.equal(hasGraphSignal(service, GraphScoreSignal.ContainsNeighborhood), true);
    assert.equal(hasGraphSignal(service, GraphScoreSignal.ImportsNeighborhood), true);
    assert.equal(hasGraphSignal(createSession, GraphScoreSignal.ContainsNeighborhood), true);
  } finally {
    db.close();
  }
});

test("isolated candidates do not receive graph bonuses", () => {
  const db = openIndexerDatabase();

  try {
    seedGraphFixture(db);

    const results = searchSymbolsGraph(db, { query: "Session", maxResults: 6 });
    const store = findGraphResult(results, "SessionStore");

    assert.equal(store.graphScore, 0);
    assert.deepEqual(store.graphContributions, []);
  } finally {
    db.close();
  }
});

test("lexical ranking remains dominant when graph evidence is weak", () => {
  const db = openIndexerDatabase();

  try {
    seedGraphFixture(db);

    const results = searchSymbolsGraph(db, { query: "Session", maxResults: 6 });

    assert.equal(results[0]?.localName, "Session");
    assert.equal(results[0]?.lexicalScore > (results[1]?.lexicalScore ?? 0), true);
  } finally {
    db.close();
  }
});

test("repeated identical queries produce identical ordering", () => {
  const db = openIndexerDatabase();

  try {
    seedGraphFixture(db);

    const first = searchSymbolsGraph(db, { query: "Session", maxResults: 6 });
    const second = searchSymbolsGraph(db, { query: "Session", maxResults: 6 });

    assert.deepEqual(second, first);
  } finally {
    db.close();
  }
});

test("no-graph-data cases fall back cleanly to lexical ranking", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    const lexical = searchSymbols(db, { query: "SessionToken", maxResults: 5 });
    const reranked = searchSymbolsGraph(db, { query: "SessionToken", maxResults: 5 });

    assert.deepEqual(
      reranked.map((result) => result.symbolId),
      lexical.map((result) => result.symbolId),
    );
    assert.equal(reranked.every((result) => result.graphScore === 0), true);
    assert.equal(
      reranked.every((result, index) => result.finalScore === (lexical[index]?.score ?? -1)),
      true,
    );
  } finally {
    db.close();
  }
});

test("rerankGraph operates as a second stage over lexical candidates", () => {
  const db = openIndexerDatabase();

  try {
    seedGraphFixture(db);
    const lexicalCandidates = searchSymbols(db, { query: "Session", maxResults: 6 });
    const reranked = rerankGraph(db, lexicalCandidates, 6);

    assert.equal(reranked.length, lexicalCandidates.length);
    assert.equal(reranked.every((result) => result.finalScore >= result.lexicalScore), true);
  } finally {
    db.close();
  }
});

test("mixed Python/Cython graph reranking is deterministic and uses persisted import structure", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      const first = searchSymbolsGraph(db, { query: "concentration", maxResults: 6 });
      const second = searchSymbolsGraph(db, { query: "concentration", maxResults: 6 });
      const diffuseProfile = findGraphResult(first, "diffuse_profile");
      const declaredStep = findGraphResult(first, "declared_step");

      assert.deepEqual(second, first);
      assert.equal(first[0]?.localName, "diffuse_profile");
      assert.equal(diffuseProfile.graphScore > 0, true);
      assert.equal(hasGraphSignal(diffuseProfile, GraphScoreSignal.OutDegree), true);
      assert.equal(hasGraphSignal(diffuseProfile, GraphScoreSignal.ImportsNeighborhood), true);
      assert.equal(hasGraphSignal(diffuseProfile, GraphScoreSignal.ConnectedMatchedCandidates), true);
      assert.equal(diffuseProfile.finalScore > declaredStep.finalScore, true);
    } finally {
      db.close();
    }
  });
});

test("boundary graph search stays deterministic and surfaces Cython candidates more reliably than the no-boost baseline", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      for (const query of ["cython", "compiled helper", "cimport", "extension module"]) {
        const first = searchSymbolsGraph(db, {
          query,
          maxResults: 6,
          backend: SymbolSearchBackend.Fts,
        });
        const second = searchSymbolsGraph(db, {
          query,
          maxResults: 6,
          backend: SymbolSearchBackend.Fts,
        });
        const baseline = searchSymbolsGraph(db, {
          query,
          maxResults: 6,
          backend: SymbolSearchBackend.Fts,
          enableBoundaryBoosts: false,
        });
        const firstBoostedCython = first.findIndex((result) => /\.(pyx|pxd|pxi)$/.test(result.filePath));
        const firstBaselineCython = baseline.findIndex((result) => /\.(pyx|pxd|pxi)$/.test(result.filePath));

        assert.deepEqual(second, first);
        assert.equal(firstBoostedCython !== -1, true);
        assert.equal(firstBaselineCython === -1 || firstBoostedCython < firstBaselineCython, true);
      }
    } finally {
      db.close();
    }
  });
});

test("broad-query graph search stays deterministic and falls back cleanly when no graph data exists", () => {
  const db = openIndexerDatabase();

  try {
    seedWorkflowSearchFixture(db);

    const first = searchSymbolsGraph(db, {
      query: "how are transition state jobs validated",
      maxResults: 6,
      backend: SymbolSearchBackend.Fts,
    });
    const second = searchSymbolsGraph(db, {
      query: "how are transition state jobs validated",
      maxResults: 6,
      backend: SymbolSearchBackend.Fts,
    });
    const lexical = searchSymbols(db, {
      query: "how are transition state jobs validated",
      maxResults: 10,
      backend: SymbolSearchBackend.Fts,
    });
    const baseline = searchSymbolsGraph(db, {
      query: "how are transition state jobs validated",
      maxResults: 6,
      backend: SymbolSearchBackend.Fts,
      enableBroadQueryBoosts: false,
    });

    assert.deepEqual(second, first);
    assert.equal(first[0]?.localName, "validateTransitionStateJobs");
    assert.deepEqual(
      first.map((result) => result.symbolId),
      lexical.slice(0, 6).map((result) => result.symbolId),
    );
    assert.equal(first.every((result) => result.graphScore === 0), true);
    assert.equal(baseline.some((result) => result.localName === "validateTransitionStateJobs"), false);
  } finally {
    db.close();
  }
});

test("graph reranking keeps production workflow code ahead of graph-connected test code for broad queries", () => {
  const db = openIndexerDatabase();

  try {
    seedTestAwareGraphFixture(db);

    const current = searchSymbolsGraph(db, {
      query: "how are transition state jobs validated",
      maxResults: 6,
    });
    const second = searchSymbolsGraph(db, {
      query: "how are transition state jobs validated",
      maxResults: 6,
    });
    const baseline = searchSymbolsGraph(db, {
      query: "how are transition state jobs validated",
      maxResults: 6,
      enableTestAwareDownweighting: false,
    });

    assert.deepEqual(second, current);
    assert.equal(current[0]?.localName, "validateTransitionStateJobs");
    assert.equal(current[0]?.filePath, "src/workflows/transition_state_validation.ts");
    assert.equal(baseline[0]?.filePath, "src/workflows/transition_state_validation_test.ts");
    assert.equal(hasGraphSignal(findGraphResult(baseline, "TestTransitionStateValidation"), GraphScoreSignal.ContainsNeighborhood), true);
    assert.equal(hasGraphSignal(findGraphResult(baseline, "TestTransitionStateValidation"), GraphScoreSignal.ImportsNeighborhood), true);
  } finally {
    db.close();
  }
});

test("technical narrow queries preserve lexical ordering when no graph data exists", () => {
  const db = openIndexerDatabase();

  try {
    seedNarrowQuerySearchFixture(db);

    for (const query of ["species_to_dict", "fast parser", "where is the output parsed"]) {
      const lexical = searchSymbols(db, {
        query,
        maxResults: 6,
        backend: SymbolSearchBackend.Fts,
      });
      const reranked = searchSymbolsGraph(db, {
        query,
        maxResults: 6,
        backend: SymbolSearchBackend.Fts,
      });

      assert.deepEqual(
        reranked.map((result) => result.symbolId),
        lexical.map((result) => result.symbolId),
      );
      assert.equal(reranked.every((result) => result.graphScore === 0), true);
      assert.equal(
        reranked.every((result, index) => result.finalScore === (lexical[index]?.score ?? -1)),
        true,
      );
    }
  } finally {
    db.close();
  }
});

function seedGraphFixture(db: ReturnType<typeof openIndexerDatabase>): void {
  const sessionResult = makeSearchParseResult({
    path: "src/session/types.ts",
    symbols: [
      {
        localName: "Session",
        kind: SymbolKind.TypeAlias,
        startByte: 0,
        endByte: 18,
        signature: "type Session = string",
      },
    ],
  });

  const storeResult = makeSearchParseResult({
    path: "src/session/store.ts",
    symbols: [
      {
        localName: "SessionStore",
        kind: SymbolKind.Class,
        startByte: 0,
        endByte: 24,
        signature: "class SessionStore",
      },
    ],
  });

  const serviceResult = makeSearchParseResult({
    path: "src/session/service.ts",
    symbols: [
      {
        localName: "SessionService",
        kind: SymbolKind.Class,
        startByte: 0,
        endByte: 28,
        signature: "class SessionService",
      },
      {
        localName: "createSession",
        kind: SymbolKind.Method,
        startByte: 29,
        endByte: 62,
        signature: "createSession(): Session",
        parentLocalName: "SessionService",
      },
    ],
  });
  serviceResult.edges.push(
    makeEdge(
      findSymbol(serviceResult, "SessionService"),
      findSymbol(serviceResult, "createSession"),
      EdgeType.Contains,
    ),
  );

  const controllerResult = makeSearchParseResult({
    path: "src/session/controller.ts",
    symbols: [
      {
        localName: "SessionController",
        kind: SymbolKind.Class,
        startByte: 0,
        endByte: 31,
        signature: "class SessionController",
      },
    ],
  });
  controllerResult.edges.push(
    makeEdge(
      findSymbol(controllerResult, "SessionController"),
      findSymbol(serviceResult, "SessionService"),
      EdgeType.Imports,
    ),
  );

  const viewResult = makeSearchParseResult({
    path: "src/session/view.ts",
    symbols: [
      {
        localName: "SessionView",
        kind: SymbolKind.Class,
        startByte: 0,
        endByte: 22,
        signature: "class SessionView",
      },
    ],
  });
  viewResult.edges.push(
    makeEdge(
      findSymbol(viewResult, "SessionView"),
      findSymbol(controllerResult, "SessionController"),
      EdgeType.Imports,
    ),
  );

  persistParseResult(db, sessionResult);
  persistParseResult(db, storeResult);
  persistParseResult(db, serviceResult);
  persistParseResult(db, controllerResult);
  persistParseResult(db, viewResult);
}

function seedTestAwareGraphFixture(db: ReturnType<typeof openIndexerDatabase>): void {
  const productionResult = makeSearchParseResult({
    path: "src/workflows/transition_state_validation.ts",
    symbols: [
      {
        localName: "validateTransitionStateJobs",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 64,
        signature: "function validateTransitionStateJobs(jobBatch: JobBatch): ValidationSummary",
        docstring: "Validate transition state jobs before scheduler promotion and workflow updates.",
      },
    ],
  });
  const testResult = makeSearchParseResult({
    path: "src/workflows/transition_state_validation_test.ts",
    symbols: [
      {
        localName: "TestTransitionStateValidation",
        kind: SymbolKind.Class,
        startByte: 0,
        endByte: 48,
        signature: "class TestTransitionStateValidation",
        docstring: "Transition state jobs validated in workflow regression coverage.",
      },
      {
        localName: "testValidateTransitionStateJobs",
        kind: SymbolKind.Method,
        startByte: 49,
        endByte: 108,
        signature: "testValidateTransitionStateJobs(): ValidationSummary",
        docstring: "Validate transition state jobs in regression coverage.",
        parentLocalName: "TestTransitionStateValidation",
      },
    ],
  });
  testResult.edges.push(
    makeEdge(
      findSymbol(testResult, "TestTransitionStateValidation"),
      findSymbol(testResult, "testValidateTransitionStateJobs"),
      EdgeType.Contains,
    ),
  );
  testResult.edges.push(
    makeEdge(
      findSymbol(testResult, "TestTransitionStateValidation"),
      findSymbol(productionResult, "validateTransitionStateJobs"),
      EdgeType.Imports,
    ),
  );

  persistParseResult(db, productionResult);
  persistParseResult(db, testResult);
}

function findGraphResult(
  results: ReturnType<typeof searchSymbolsGraph>,
  localName: string,
) {
  const result = results.find((candidate) => candidate.localName === localName);

  assert.notEqual(result, undefined);

  return result!;
}

function hasGraphSignal(
  result: ReturnType<typeof findGraphResult>,
  signal: GraphScoreSignal,
): boolean {
  return result.graphContributions.some((contribution) => contribution.signal === signal);
}

function findSymbol(result: ParseResult, localName: string): SymbolRecord {
  const symbol = result.symbols.find((candidate) => candidate.localName === localName);

  assert.notEqual(symbol, undefined);

  return symbol!;
}

function makeEdge(
  srcSymbol: SymbolRecord,
  dstSymbol: SymbolRecord,
  edgeType: EdgeType,
) {
  return {
    id: stableHash([srcSymbol.id, dstSymbol.id, edgeType]),
    srcSymbolId: srcSymbol.id,
    dstSymbolId: dstSymbol.id,
    edgeType,
    confidence: 1,
  };
}

function stableHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
