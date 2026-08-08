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

test("a direct same-file function call creates a calls edge", async () => {
  const result = await parseFixture(`
function helper(x: number): number { return x + 1; }
function main(): number { return helper(1); }
`);

  const helper = findSymbol(result.symbols, "helper");
  const main = findSymbol(result.symbols, "main");
  const calls = edgesOfType(result, EdgeType.Calls);

  assert.deepEqual(calls, [
    {
      id: calls[0]?.id,
      srcSymbolId: main.id,
      dstSymbolId: helper.id,
      edgeType: EdgeType.Calls,
      confidence: 1,
      // `helper(1)` sits on line 3 of the fixture (it opens with a newline).
      callSites: [{ startLine: 3, startColumn: 33, endLine: 3, endColumn: 42, precision: "span" }],
    },
  ]);
  assert.equal(calls[0]?.id.length, 64);
});

test("an imported function call creates a calls edge to the exact import target", async () => {
  const targetContent = "export function build(): number { return 1; }\n";
  const parser = createTypeScriptParser({
    knownFiles: [{ path: "src/factory.ts", content: targetContent }],
  });
  const result = await parser.parse({
    path: "src/service.ts",
    language: Language.TypeScript,
    content: `
import { build } from "./factory";
export function make(): number { return build(); }
`,
  });
  const target = await typescriptParser.parse({
    path: "src/factory.ts",
    language: Language.TypeScript,
    content: targetContent,
  });
  const make = findSymbol(result.symbols, "make");
  const build = findSymbol(target.symbols, "build");
  const calls = edgesOfType(result, EdgeType.Calls);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.srcSymbolId, make.id);
  assert.equal(calls[0]?.dstSymbolId, build.id);
});

test("a this.method() call resolves to the enclosing class method", async () => {
  const result = await parseFixture(`
class Worker {
  helper(): void {}
  run(): void { this.helper(); }
}
`);

  const helper = findSymbolOfKind(result.symbols, "helper", SymbolKind.Method);
  const run = findSymbolOfKind(result.symbols, "run", SymbolKind.Method);
  const calls = edgesOfType(result, EdgeType.Calls);

  assert.deepEqual(calls, [
    {
      id: calls[0]?.id,
      srcSymbolId: run.id,
      dstSymbolId: helper.id,
      edgeType: EdgeType.Calls,
      confidence: 1,
      callSites: [{ startLine: 4, startColumn: 16, endLine: 4, endColumn: 29, precision: "span" }],
    },
  ]);
});

test("a static ClassName.method() call resolves on a same-file class", async () => {
  const result = await parseFixture(`
class Factory {
  static make(): void {}
}
function build(): void { Factory.make(); }
`);

  const make = findSymbolOfKind(result.symbols, "make", SymbolKind.Method);
  const build = findSymbol(result.symbols, "build");
  const calls = edgesOfType(result, EdgeType.Calls);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.srcSymbolId, build.id);
  assert.equal(calls[0]?.dstSymbolId, make.id);
});

test("an ambiguous object receiver call is skipped conservatively", async () => {
  const result = await parseFixture(`
function run(obj: Worker): void { obj.helper(); }
`);

  assert.deepEqual(edgesOfType(result, EdgeType.Calls), []);
});

test("a shadowing local binding suppresses a same-name calls edge", async () => {
  const result = await parseFixture(`
function helper(): void {}
function outer(): void {
  const helper = () => {};
  helper();
}
`);

  assert.deepEqual(edgesOfType(result, EdgeType.Calls), []);
});

test("a type annotation creates a references edge to an exact same-file type", async () => {
  const result = await parseFixture(`
interface Account {}
function load(id: string): Account { throw new Error("not implemented"); }
`);

  const account = findSymbolOfKind(result.symbols, "Account", SymbolKind.Interface);
  const load = findSymbol(result.symbols, "load");
  const references = edgesOfType(result, EdgeType.References);

  assert.deepEqual(references, [
    {
      id: references[0]?.id,
      srcSymbolId: load.id,
      dstSymbolId: account.id,
      edgeType: EdgeType.References,
      confidence: 1,
    },
  ]);
});

test("extends and implements clauses create references edges", async () => {
  const result = await parseFixture(`
interface Walker {}
class Animal {}
class Dog extends Animal implements Walker {}
`);

  const animal = findSymbolOfKind(result.symbols, "Animal", SymbolKind.Class);
  const walker = findSymbolOfKind(result.symbols, "Walker", SymbolKind.Interface);
  const dog = findSymbolOfKind(result.symbols, "Dog", SymbolKind.Class);
  const referencePairs = edgesOfType(result, EdgeType.References).map((edge) => [
    edge.srcSymbolId,
    edge.dstSymbolId,
  ]);

  assert.equal(referencePairs.some(([src, dst]) => src === dog.id && dst === animal.id), true);
  assert.equal(referencePairs.some(([src, dst]) => src === dog.id && dst === walker.id), true);
});

test("an interface extends clause creates a references edge", async () => {
  const result = await parseFixture(`
interface Base {}
interface Admin extends Base { level: number; }
`);

  const base = findSymbolOfKind(result.symbols, "Base", SymbolKind.Interface);
  const admin = findSymbolOfKind(result.symbols, "Admin", SymbolKind.Interface);
  const references = edgesOfType(result, EdgeType.References);

  assert.equal(references.length, 1);
  assert.equal(references[0]?.srcSymbolId, admin.id);
  assert.equal(references[0]?.dstSymbolId, base.id);
});

test("a class decorator creates a references edge to an exact decorator symbol", async () => {
  const result = await parseFixture(`
function Injectable() { return (target: unknown) => target; }
@Injectable()
class Service {}
`);

  const injectable = findSymbol(result.symbols, "Injectable");
  const service = findSymbolOfKind(result.symbols, "Service", SymbolKind.Class);
  const references = edgesOfType(result, EdgeType.References);

  assert.equal(references.length, 1);
  assert.equal(references[0]?.srcSymbolId, service.id);
  assert.equal(references[0]?.dstSymbolId, injectable.id);
});

test("calls and references are kept distinct with no spurious overlap", async () => {
  const result = await parseFixture(`
class Account {}
function build(): Account { return new Account(); }
`);

  // `new Account()` is a class reference, not a call; build references Account
  // exactly once and produces no calls edge.
  assert.deepEqual(edgesOfType(result, EdgeType.Calls), []);
  assert.equal(edgesOfType(result, EdgeType.References).length, 1);
});

test("call and reference extraction does not regress contains or imports edges", async () => {
  const targetContent = "export interface User { id: string }\n";
  const parser = createTypeScriptParser({
    knownFiles: [{ path: "src/models.ts", content: targetContent }],
  });
  const result = await parser.parse({
    path: "src/service.ts",
    language: Language.TypeScript,
    content: `
import { User } from "./models";
export class Repo {
  read(): User { throw new Error("not implemented"); }
}
`,
  });
  const target = await typescriptParser.parse({
    path: "src/models.ts",
    language: Language.TypeScript,
    content: targetContent,
  });
  const repo = findSymbolOfKind(result.symbols, "Repo", SymbolKind.Class);
  const read = findSymbolOfKind(result.symbols, "read", SymbolKind.Method);
  const user = findSymbol(target.symbols, "User");

  const contains = edgesOfType(result, EdgeType.Contains);
  assert.deepEqual(contains, [
    {
      id: contains[0]?.id,
      srcSymbolId: repo.id,
      dstSymbolId: read.id,
      edgeType: EdgeType.Contains,
      confidence: 1,
    },
  ]);

  const imports = edgesOfType(result, EdgeType.Imports);
  assert.equal(imports.length, 1);
  assert.equal(imports[0]?.dstSymbolId, user.id);

  // The return type still resolves to a references edge alongside the import.
  const references = edgesOfType(result, EdgeType.References);
  assert.equal(references.length, 1);
  assert.equal(references[0]?.srcSymbolId, read.id);
  assert.equal(references[0]?.dstSymbolId, user.id);
});

async function parseFixture(content: string) {
  const input: ParseFileInput = {
    path: "src/example.ts",
    language: Language.TypeScript,
    content,
  };

  return typescriptParser.parse(input);
}

function edgesOfType(result: { edges: readonly { edgeType: EdgeType }[] }, edgeType: EdgeType) {
  return result.edges.filter((edge) => edge.edgeType === edgeType);
}

function findSymbolOfKind(
  symbols: readonly SymbolRecord[],
  localName: string,
  kind: SymbolKind,
): SymbolRecord {
  const symbol = symbols.find(
    (candidate) => candidate.localName === localName && candidate.kind === kind,
  );

  assert.notEqual(symbol, undefined);

  return symbol as SymbolRecord;
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
