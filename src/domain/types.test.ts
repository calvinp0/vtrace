import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  EdgeType,
  Language,
  SymbolKind,
  buildFQName,
  computeFileId,
  computeSymbolId,
  type EdgeRecord,
  type FileRecord,
  type ParseResult,
  type SymbolRecord,
} from "./types";
import {
  assertValidEdgeReferences,
  isEdgeType,
  isLanguage,
  isSymbolKind,
  parseEdgeType,
  parseLanguage,
  parseSymbolKind,
} from "./guards";

test("domain records represent Layer 1 files, symbols, edges, and parse results", () => {
  const file: FileRecord = {
    id: computeFileId("src/example.ts"),
    path: "src/example.ts",
    language: Language.TypeScript,
    contentHash: "sha256:abc123",
    sizeBytes: 256,
  };

  const classSymbol: SymbolRecord = {
    id: "symbol:class",
    filePath: file.path,
    fqName: buildFQName({ filePath: file.path, symbolPath: ["Example"] }),
    localName: "Example",
    kind: SymbolKind.Class,
    signature: "export class Example",
    startLine: 1,
    endLine: 5,
    startByte: 0,
    endByte: 120,
    exported: true,
    docstring: "Example class.",
    decorators: ["model"],
  };

  const methodSymbol: SymbolRecord = {
    id: "symbol:method",
    filePath: file.path,
    fqName: buildFQName({ filePath: file.path, symbolPath: ["Example", "run"] }),
    localName: "run",
    kind: SymbolKind.Method,
    signature: "run(): void",
    startLine: 2,
    endLine: 4,
    startByte: 24,
    endByte: 110,
    parentSymbolId: classSymbol.id,
    exported: false,
  };

  const edge: EdgeRecord = {
    id: "edge:contains",
    srcSymbolId: classSymbol.id,
    dstSymbolId: methodSymbol.id,
    edgeType: EdgeType.Contains,
    confidence: 1,
  };

  const result: ParseResult = {
    file,
    symbols: [classSymbol, methodSymbol],
    edges: [edge],
    diagnostics: [],
  };

  assert.equal(result.file.language, Language.TypeScript);
  assert.equal(result.symbols[0]?.fqName, "src/example.ts::Example");
  assert.equal(result.symbols[1]?.fqName, "src/example.ts::Example.run");
  assert.equal(result.symbols[1]?.parentSymbolId, classSymbol.id);
  assert.deepEqual(result.symbols[0]?.decorators, ["model"]);
  assert.equal(result.edges[0]?.edgeType, EdgeType.Contains);
});

test("enum guards accept only supported Layer 1 enum values", () => {
  assert.equal(isLanguage("typescript"), true);
  assert.equal(isLanguage("python"), true);
  assert.equal(isLanguage("cython"), true);
  assert.equal(isLanguage("go"), true);
  assert.equal(isLanguage("rust"), true);
  assert.equal(isLanguage("ruby"), true);
  assert.equal(isLanguage("fortran"), false);
  assert.equal(parseLanguage("javascript"), Language.JavaScript);
  assert.equal(parseLanguage("python"), Language.Python);
  assert.equal(parseLanguage("cython"), Language.Cython);
  assert.throws(() => parseLanguage("ts"), /Invalid Language/);

  assert.equal(isSymbolKind("class"), true);
  assert.equal(isSymbolKind("variable"), false);
  assert.equal(parseSymbolKind("type_alias"), SymbolKind.TypeAlias);
  assert.throws(() => parseSymbolKind("type"), /Invalid SymbolKind/);

  assert.equal(isEdgeType("contains"), true);
  assert.equal(isEdgeType("calls"), true);
  assert.equal(isEdgeType("references"), true);
  assert.equal(isEdgeType("invokes"), false);
  assert.equal(parseEdgeType("imports"), EdgeType.Imports);
  assert.equal(parseEdgeType("references"), EdgeType.References);
  assert.throws(() => parseEdgeType(null), /Invalid EdgeType/);
});

test("produces identical symbol IDs for identical input", () => {
  const input = {
    filePath: "auth/session.ts",
    fqName: buildFQName({
      filePath: "auth/session.ts",
      symbolPath: ["SessionManager", "createSession"],
    }),
    kind: SymbolKind.Method,
    startByte: 42,
    endByte: 84,
  };

  const id1 = computeSymbolId(input);
  const id2 = computeSymbolId(input);

  assert.equal(id1, id2);
});

test("rejects invalid SymbolKind", () => {
  assert.throws(() => parseSymbolKind("banana"), /Invalid SymbolKind/);
});

test("validates edge references against known symbol IDs", () => {
  const classSymbol: SymbolRecord = {
    id: "symbol:class",
    filePath: "auth/session.ts",
    fqName: "auth/session.ts::SessionManager",
    localName: "SessionManager",
    kind: SymbolKind.Class,
    signature: "class SessionManager",
    startLine: 1,
    endLine: 5,
    startByte: 0,
    endByte: 120,
    exported: false,
  };

  const methodSymbol: SymbolRecord = {
    id: "symbol:method",
    filePath: "auth/session.ts",
    fqName: "auth/session.ts::SessionManager.createSession",
    localName: "createSession",
    kind: SymbolKind.Method,
    signature: "createSession(): void",
    startLine: 2,
    endLine: 4,
    startByte: 24,
    endByte: 110,
    parentSymbolId: classSymbol.id,
    exported: false,
  };

  const validEdge: EdgeRecord = {
    id: "edge:contains",
    srcSymbolId: classSymbol.id,
    dstSymbolId: methodSymbol.id,
    edgeType: EdgeType.Contains,
    confidence: 1,
  };

  const orphanEdge: EdgeRecord = {
    ...validEdge,
    dstSymbolId: "symbol:missing",
  };

  assert.doesNotThrow(() => {
    assertValidEdgeReferences([validEdge], [classSymbol, methodSymbol]);
  });
  assert.throws(() => {
    assertValidEdgeReferences([orphanEdge], [classSymbol, methodSymbol]);
  }, /destination symbol does not exist/);
});
