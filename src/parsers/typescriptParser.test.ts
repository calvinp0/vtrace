import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  EdgeType,
  Language,
  SymbolKind,
  type SymbolRecord,
} from "../domain/types";
import {
  createTypeScriptParser,
  createParserRegistry,
  typescriptParser,
  type ParseFileInput,
} from "./index";

test("function declarations are extracted", async () => {
  const result = await parseFixture("export function add(a: number, b: number): number { return a + b; }\n");

  const symbol = onlySymbolOfKind(result.symbols, SymbolKind.Function);
  assert.equal(symbol.localName, "add");
  assert.equal(symbol.fqName, "src/example.ts::add");
  assert.equal(symbol.signature, "function add(a: number, b: number): number");
  assert.equal(symbol.exported, true);
});

test("class declarations are extracted", async () => {
  const result = await parseFixture("export class SessionManager {}\n");

  const symbol = onlySymbolOfKind(result.symbols, SymbolKind.Class);
  assert.equal(symbol.localName, "SessionManager");
  assert.equal(symbol.fqName, "src/example.ts::SessionManager");
  assert.equal(symbol.signature, "class SessionManager");
  assert.equal(symbol.exported, true);
});

test("methods inside classes are extracted", async () => {
  const result = await parseFixture(`
class SessionManager {
  createSession(id: string): void {}
}
`);

  const symbol = onlySymbolOfKind(result.symbols, SymbolKind.Method);
  assert.equal(symbol.localName, "createSession");
  assert.equal(symbol.fqName, "src/example.ts::SessionManager.createSession");
  assert.equal(symbol.signature, "createSession(id: string): void");
  assert.equal(symbol.parentSymbolId, onlySymbolOfKind(result.symbols, SymbolKind.Class).id);
});

test("interfaces are extracted", async () => {
  const result = await parseFixture("export interface User { id: string }\n");

  const symbol = onlySymbolOfKind(result.symbols, SymbolKind.Interface);
  assert.equal(symbol.localName, "User");
  assert.equal(symbol.fqName, "src/example.ts::User");
  assert.equal(symbol.signature, "interface User");
  assert.equal(symbol.exported, true);
});

test("type aliases are extracted", async () => {
  const result = await parseFixture("export type UserId = string;\n");

  const symbol = onlySymbolOfKind(result.symbols, SymbolKind.TypeAlias);
  assert.equal(symbol.localName, "UserId");
  assert.equal(symbol.fqName, "src/example.ts::UserId");
  assert.equal(symbol.signature, "type UserId = string;");
  assert.equal(symbol.exported, true);
});

test("contains edges are created for class to method relationships", async () => {
  const result = await parseFixture(`
class SessionManager {
  createSession(): void {}
}
`);
  const classSymbol = onlySymbolOfKind(result.symbols, SymbolKind.Class);
  const methodSymbol = onlySymbolOfKind(result.symbols, SymbolKind.Method);

  assert.deepEqual(result.edges, [
    {
      id: result.edges[0]?.id,
      srcSymbolId: classSymbol.id,
      dstSymbolId: methodSymbol.id,
      edgeType: EdgeType.Contains,
      confidence: 1,
    },
  ]);
  assert.equal(result.edges[0]?.id.length, 64);
});

test("export status is detected for exported declarations", async () => {
  const result = await parseFixture(`
export function exportedFunction() {}
function localFunction() {}
export class ExportedClass {}
class LocalClass {}
`);

  assert.equal(findSymbol(result.symbols, "exportedFunction").exported, true);
  assert.equal(findSymbol(result.symbols, "localFunction").exported, false);
  assert.equal(findSymbol(result.symbols, "ExportedClass").exported, true);
  assert.equal(findSymbol(result.symbols, "LocalClass").exported, false);
});

test("symbol IDs are deterministic across repeated parses", async () => {
  const source = `
export function add(a: number, b: number): number { return a + b; }
class Calculator {
  total(): number { return 1; }
}
`;

  const first = await parseFixture(source);
  const second = await parseFixture(source);

  assert.deepEqual(
    first.symbols.map((symbol) => symbol.id),
    second.symbols.map((symbol) => symbol.id),
  );
  assert.deepEqual(first.edges, second.edges);
});

test("invalid or partial syntax is reported through parser result without crashing", async () => {
  const registry = createParserRegistry([typescriptParser]);
  const result = await registry.parse({
    path: "src/broken.ts",
    language: Language.TypeScript,
    content: "export function broken( {",
  });

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.result.file.path, "src/broken.ts");
    assert.equal(result.result.diagnostics.length > 0, true);
    assert.equal(result.result.diagnostics[0]?.message, "Syntax error");
  }
});

test("named imports from a relative module create imports edges for clear target exports", async () => {
  const targetContent = "export interface User { id: string }\n";
  const parser = createTypeScriptParser({
    knownFiles: [{ path: "src/models.ts", content: targetContent }],
  });
  const result = await parser.parse({
    path: "src/service.ts",
    language: Language.TypeScript,
    content: `
import { User } from "./models";
export function readUser(): User { throw new Error("not implemented"); }
`,
  });
  const target = await typescriptParser.parse({
    path: "src/models.ts",
    language: Language.TypeScript,
    content: targetContent,
  });
  const sourceSymbol = findSymbol(result.symbols, "readUser");
  const targetSymbol = findSymbol(target.symbols, "User");
  const importEdges = result.edges.filter((edge) => edge.edgeType === EdgeType.Imports);

  assert.deepEqual(importEdges, [
    {
      id: importEdges[0]?.id,
      srcSymbolId: sourceSymbol.id,
      dstSymbolId: targetSymbol.id,
      edgeType: EdgeType.Imports,
      confidence: 1,
    },
  ]);
  assert.equal(importEdges[0]?.id.length, 64);
});

test("default imports resolve only explicit default exports", async () => {
  const targetContent = "export default function makeSession() { return {}; }\n";
  const parser = createTypeScriptParser({
    knownFiles: [{ path: "src/session.ts", content: targetContent }],
  });
  const result = await parser.parse({
    path: "src/service.ts",
    language: Language.TypeScript,
    content: `
import makeSession from "./session";
export function readSession() { return makeSession(); }
`,
  });
  const target = await typescriptParser.parse({
    path: "src/session.ts",
    language: Language.TypeScript,
    content: targetContent,
  });
  const targetSymbol = findSymbol(target.symbols, "makeSession");
  const importEdges = result.edges.filter((edge) => edge.edgeType === EdgeType.Imports);

  assert.equal(importEdges.length, 1);
  assert.equal(importEdges[0]?.dstSymbolId, targetSymbol.id);
});

test("namespace imports are detected but skipped conservatively", async () => {
  const parser = createTypeScriptParser({
    knownFiles: [{ path: "src/models.ts", content: "export interface User { id: string }\n" }],
  });
  const result = await parser.parse({
    path: "src/service.ts",
    language: Language.TypeScript,
    content: `
import * as Models from "./models";
export function readUser(): Models.User { throw new Error("not implemented"); }
`,
  });

  assert.equal(result.edges.some((edge) => edge.edgeType === EdgeType.Imports), false);
});

test("package imports do not create imports edges", async () => {
  const result = await parseFixture(`
import React from "react";
export function render() { return React.createElement("div"); }
`);

  assert.equal(result.edges.some((edge) => edge.edgeType === EdgeType.Imports), false);
});

test("unresolved relative imports do not crash and do not create guessed edges", async () => {
  const parser = createTypeScriptParser();
  const result = await parser.parse({
    path: "src/service.ts",
    language: Language.TypeScript,
    content: `
import { Missing } from "./missing";
export function readMissing(): Missing { throw new Error("not implemented"); }
`,
  });

  assert.equal(result.edges.some((edge) => edge.edgeType === EdgeType.Imports), false);
  assert.deepEqual(result.diagnostics, []);
});

test("repeated parses produce identical imports edges and IDs", async () => {
  const targetContent = "export type UserId = string;\n";
  const parser = createTypeScriptParser({
    knownFiles: [{ path: "src/models/index.ts", content: targetContent }],
  });
  const input: ParseFileInput = {
    path: "src/service.ts",
    language: Language.TypeScript,
    content: `
import { UserId } from "./models";
export function readUserId(): UserId { throw new Error("not implemented"); }
`,
  };

  const first = await parser.parse(input);
  const second = await parser.parse(input);

  assert.deepEqual(
    first.edges.filter((edge) => edge.edgeType === EdgeType.Imports),
    second.edges.filter((edge) => edge.edgeType === EdgeType.Imports),
  );
});

async function parseFixture(content: string) {
  const input: ParseFileInput = {
    path: "src/example.ts",
    language: Language.TypeScript,
    content,
  };

  return typescriptParser.parse(input);
}

function onlySymbolOfKind(symbols: readonly SymbolRecord[], kind: SymbolKind): SymbolRecord {
  const matches = symbols.filter((symbol) => symbol.kind === kind);

  assert.equal(matches.length, 1);

  return matches[0] as SymbolRecord;
}

function findSymbol(symbols: readonly SymbolRecord[], localName: string): SymbolRecord {
  const symbol = symbols.find((candidate) => candidate.localName === localName);

  assert.notEqual(symbol, undefined);

  return symbol as SymbolRecord;
}
