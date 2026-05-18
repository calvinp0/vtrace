import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { persistParseResult } from "../db/persistParseResult";
import { openIndexerDatabase } from "../db/sqlite";
import { EdgeType, SymbolKind, type ParseResult, type SymbolRecord } from "../domain/types";
import { rerankGraph } from "../retrieval/rerankGraph";
import { searchSymbols } from "../retrieval/searchSymbols";
import { searchSymbolsGraph } from "../retrieval/searchSymbolsGraph";
import { makeSearchParseResult } from "../retrieval/testUtils";
import { SymbolSearchBackend } from "../retrieval/types";
import { getIntentRoutingProfile } from "./profile";
import { routeQuery } from "./routeQuery";
import { QueryIntent } from "./types";

const SHARED_ROUTE_DOCSTRING = "bug session explain session rename session add session";

test("each intent maps to an explicit routing profile", () => {
  assert.deepEqual(
    [
      getIntentRoutingProfile(QueryIntent.Debug),
      getIntentRoutingProfile(QueryIntent.Refactor),
      getIntentRoutingProfile(QueryIntent.Explain),
      getIntentRoutingProfile(QueryIntent.Feature),
    ].map((profile) => ({
      id: profile.id,
      backend: profile.backend,
      candidatePoolSize: profile.candidatePoolSize,
      containsNeighbor: profile.graphWeights.containsNeighbor,
      importsNeighbor: profile.graphWeights.importsNeighbor,
      connectedMatchedCandidate: profile.graphWeights.connectedMatchedCandidate,
    })),
    [
      {
        id: QueryIntent.Debug,
        backend: SymbolSearchBackend.Fts,
        candidatePoolSize: 16,
        containsNeighbor: 10,
        importsNeighbor: 8,
        connectedMatchedCandidate: 5,
      },
      {
        id: QueryIntent.Refactor,
        backend: SymbolSearchBackend.Fts,
        candidatePoolSize: 14,
        containsNeighbor: 12,
        importsNeighbor: 4,
        connectedMatchedCandidate: 4,
      },
      {
        id: QueryIntent.Explain,
        backend: SymbolSearchBackend.Fts,
        candidatePoolSize: 10,
        containsNeighbor: 8,
        importsNeighbor: 6,
        connectedMatchedCandidate: 3,
      },
      {
        id: QueryIntent.Feature,
        backend: SymbolSearchBackend.Fts,
        candidatePoolSize: 14,
        containsNeighbor: 9,
        importsNeighbor: 7,
        connectedMatchedCandidate: 4,
      },
    ],
  );
});

test("routeQuery returns structured intent, profile, and reranked results", () => {
  const db = openIndexerDatabase();

  try {
    seedIntentRouteGraphFixture(db);

    const result = routeQuery(db, "bug session", { maxResults: 4 });

    assert.equal(result.intent, QueryIntent.Debug);
    assert.equal(result.classification.intent, QueryIntent.Debug);
    assert.equal(result.profile.id, QueryIntent.Debug);
    assert.equal(result.profile.backend, SymbolSearchBackend.Fts);
    assert.equal(result.rerankedResults.length, 4);
    assert.equal(
      result.rerankedResults.every((candidate) => candidate.finalScore >= candidate.lexicalScore),
      true,
    );
  } finally {
    db.close();
  }
});

test("routing is deterministic across repeated runs", () => {
  const db = openIndexerDatabase();

  try {
    seedIntentRouteGraphFixture(db);

    const first = routeQuery(db, "explain session", { maxResults: 5 });
    const second = routeQuery(db, "explain session", { maxResults: 5 });

    assert.deepEqual(second, first);
  } finally {
    db.close();
  }
});

test("different intents can drive different reranking behavior on the same seeded data", () => {
  const db = openIndexerDatabase();

  try {
    seedIntentRouteGraphFixture(db);

    const debugResult = routeQuery(db, "bug session", { maxResults: 5 });
    const explainResult = routeQuery(db, "explain session", { maxResults: 5 });

    assert.deepEqual(
      debugResult.rerankedResults.map((candidate) => candidate.localName),
      explainResult.rerankedResults.map((candidate) => candidate.localName),
    );

    const debugService = findGraphResult(debugResult.rerankedResults, "SessionService");
    const explainService = findGraphResult(explainResult.rerankedResults, "SessionService");

    assert.equal(debugService.lexicalScore, explainService.lexicalScore);
    assert.equal(debugService.graphScore > explainService.graphScore, true);
    assert.notDeepEqual(debugResult.profile.graphWeights, explainResult.profile.graphWeights);
  } finally {
    db.close();
  }
});

test("routeQuery falls back cleanly when graph data is absent", () => {
  const db = openIndexerDatabase();

  try {
    seedIntentRouteGraphlessFixture(db);

    const result = routeQuery(db, "explain session", { maxResults: 3 });

    assert.equal(result.intent, QueryIntent.Explain);
    assert.equal(result.rerankedResults.length > 0, true);
    assert.equal(result.rerankedResults.every((candidate) => candidate.graphScore === 0), true);
    assert.equal(
      result.rerankedResults.every((candidate) => candidate.finalScore === candidate.lexicalScore),
      true,
    );
  } finally {
    db.close();
  }
});

test("existing retrieval and reranking entrypoints remain unchanged when used directly", () => {
  const db = openIndexerDatabase();

  try {
    seedIntentRouteGraphFixture(db);

    const manual = rerankGraph(
      db,
      searchSymbols(db, { query: "Session", maxResults: 24 }),
      6,
    );
    const wrapped = searchSymbolsGraph(db, { query: "Session", maxResults: 6 });

    assert.deepEqual(wrapped, manual);
  } finally {
    db.close();
  }
});

function seedIntentRouteGraphFixture(db: ReturnType<typeof openIndexerDatabase>): void {
  const sessionResult = makeSearchParseResult({
    path: "src/session/types.ts",
    symbols: [
      {
        localName: "Session",
        kind: SymbolKind.TypeAlias,
        startByte: 0,
        endByte: 18,
        signature: "type Session = string",
        docstring: SHARED_ROUTE_DOCSTRING,
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
        docstring: SHARED_ROUTE_DOCSTRING,
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
        docstring: SHARED_ROUTE_DOCSTRING,
      },
      {
        localName: "createSession",
        kind: SymbolKind.Method,
        startByte: 29,
        endByte: 62,
        signature: "createSession(): Session",
        docstring: SHARED_ROUTE_DOCSTRING,
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
        docstring: SHARED_ROUTE_DOCSTRING,
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
        docstring: SHARED_ROUTE_DOCSTRING,
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

function seedIntentRouteGraphlessFixture(db: ReturnType<typeof openIndexerDatabase>): void {
  const result = makeSearchParseResult({
    path: "src/session/guide.ts",
    symbols: [
      {
        localName: "SessionGuide",
        kind: SymbolKind.Class,
        startByte: 0,
        endByte: 24,
        signature: "class SessionGuide",
        docstring: SHARED_ROUTE_DOCSTRING,
      },
      {
        localName: "SessionGlossary",
        kind: SymbolKind.Class,
        startByte: 25,
        endByte: 54,
        signature: "class SessionGlossary",
        docstring: SHARED_ROUTE_DOCSTRING,
      },
    ],
  });

  persistParseResult(db, result);
}

function findGraphResult(
  results: ReturnType<typeof routeQuery>["rerankedResults"],
  localName: string,
) {
  const result = results.find((candidate) => candidate.localName === localName);

  assert.notEqual(result, undefined);

  return result!;
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
