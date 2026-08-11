import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  EdgeType,
  Language,
  SymbolKind,
  type SymbolRecord,
} from "../domain/types";
import { detectLanguage } from "../fs/languageDetection";
import {
  createCythonParser,
  createParserRegistry,
  cythonParser,
  type ParseFileInput,
} from "./index";

const MODULE_FIXTURE_URL = new URL("../../fixtures/cython/core_symbols/src/pkg/module.pyx", import.meta.url);
const INTERFACE_FIXTURE_URL = new URL(
  "../../fixtures/cython/core_symbols/src/pkg/interface.pxd",
  import.meta.url,
);
const INLINE_FIXTURE_URL = new URL("../../fixtures/cython/core_symbols/src/pkg/inline.pxi", import.meta.url);
const BROKEN_FIXTURE_URL = new URL("../../fixtures/cython/broken_syntax.pyx", import.meta.url);
const IMPORTS_INCLUDES_FIXTURE_URL = new URL(
  "../../fixtures/cython/imports_includes/",
  import.meta.url,
);

test(".pyx, .pxd, and .pxi fixtures are detected as Cython and parse successfully", async () => {
  assert.equal(detectLanguage("src/pkg/module.pyx"), Language.Cython);
  assert.equal(detectLanguage("src/pkg/interface.pxd"), Language.Cython);
  assert.equal(detectLanguage("src/pkg/inline.pxi"), Language.Cython);

  const pyxResult = await cythonParser.parse(await fixtureInput("src/pkg/module.pyx", MODULE_FIXTURE_URL));
  const pxdResult = await cythonParser.parse(await fixtureInput("src/pkg/interface.pxd", INTERFACE_FIXTURE_URL));
  const pxiResult = await cythonParser.parse(await fixtureInput("src/pkg/inline.pxi", INLINE_FIXTURE_URL));

  assert.equal(pyxResult.file.language, Language.Cython);
  assert.equal(pxdResult.file.language, Language.Cython);
  assert.equal(pxiResult.file.language, Language.Cython);
});

test("top-level def functions are extracted from the Cython fixture", async () => {
  const result = await parseCoreFixture("src/pkg/module.pyx", MODULE_FIXTURE_URL);

  const symbol = findTopLevelFunction(result.symbols, "integrate");
  assert.equal(symbol.fqName, "src/pkg/module.pyx::integrate");
  assert.equal(symbol.signature, "def integrate(double x, double y):");
  assert.equal(symbol.kind, SymbolKind.Function);

  const outer = findTopLevelFunction(result.symbols, "outer");
  assert.equal(outer.signature, "def outer():");
});

test("top-level cdef functions are extracted conservatively when the declaration is clear", async () => {
  const pyxResult = await parseCoreFixture("src/pkg/module.pyx", MODULE_FIXTURE_URL);
  const pxdResult = await parseCoreFixture("src/pkg/interface.pxd", INTERFACE_FIXTURE_URL);

  assert.equal(
    findTopLevelFunction(pyxResult.symbols, "solve_system").signature,
    "cdef double solve_system(double x, double y):",
  );
  assert.equal(
    findTopLevelFunction(pxdResult.symbols, "declared_add").signature,
    "cdef int declared_add(int left, int right)",
  );
});

test("top-level cpdef functions are extracted conservatively when the declaration is clear", async () => {
  const pyxResult = await parseCoreFixture("src/pkg/module.pyx", MODULE_FIXTURE_URL);
  const pxdResult = await parseCoreFixture("src/pkg/interface.pxd", INTERFACE_FIXTURE_URL);
  const pxiResult = await parseCoreFixture("src/pkg/inline.pxi", INLINE_FIXTURE_URL);

  assert.equal(
    findTopLevelFunction(pyxResult.symbols, "clamp").signature,
    "cpdef int clamp(int value):",
  );
  assert.equal(
    findTopLevelFunction(pxdResult.symbols, "declared_scale").signature,
    "cpdef int declared_scale(int value)",
  );
  assert.equal(
    findTopLevelFunction(pxiResult.symbols, "include_scale").signature,
    "cpdef int include_scale(int value):",
  );
});

test("typed cdef module variables with initializer calls are not extracted as functions", async () => {
  const result = await parseCythonSource(
    [
      "cdef class VF2:",
      "    pass",
      "",
      "cdef VF2 vf2 = VF2()",
      "cdef int counter = compute()",
      "",
      "cpdef int real_function(int value):",
      "    return value",
      "",
    ].join("\n"),
  );

  const functions = result.symbols.filter(
    (symbol) => symbol.kind === SymbolKind.Function,
  );

  assert.deepEqual(
    functions.map((symbol) => symbol.localName),
    ["real_function"],
  );
  assert.equal(
    result.symbols.some(
      (symbol) => symbol.localName === "VF2" && symbol.kind === SymbolKind.Function,
    ),
    false,
  );
  assert.equal(
    findSymbolOfKind(result.symbols, "VF2", SymbolKind.Class).signature,
    "cdef class VF2:",
  );
});

test("cdef classes and their methods are indexed while nested defs stay skipped", async () => {
  const result = await parseCoreFixture("src/pkg/module.pyx", MODULE_FIXTURE_URL);

  const solver = result.symbols.find(
    (symbol) => symbol.localName === "Solver" && symbol.kind === SymbolKind.Class,
  );
  const method = result.symbols.find(
    (symbol) => symbol.localName === "method" && symbol.kind === SymbolKind.Method,
  );

  assert.notEqual(solver, undefined);
  assert.notEqual(method, undefined);
  assert.equal(method?.parentSymbolId, solver?.id);

  // A def nested inside a function body is still not indexed as a symbol.
  assert.equal(result.symbols.some((symbol) => symbol.localName === "inner"), false);

  // The class-to-method relationship surfaces as a contains edge.
  assert.deepEqual(
    result.edges.filter((edge) => edge.edgeType === EdgeType.Contains),
    [
      {
        id: result.edges.find((edge) => edge.edgeType === EdgeType.Contains)?.id,
        srcSymbolId: solver?.id,
        dstSymbolId: method?.id,
        edgeType: EdgeType.Contains,
        confidence: 1,
      },
    ],
  );
});

test("Cython fqNames keep the path-based shared model shape", async () => {
  const result = await parseCoreFixture("src/pkg/module.pyx", MODULE_FIXTURE_URL);

  assert.deepEqual(
    result.symbols.map((symbol) => symbol.fqName),
    [
      "src/pkg/module.pyx::<module>",
      "src/pkg/module.pyx::integrate",
      "src/pkg/module.pyx::solve_system",
      "src/pkg/module.pyx::clamp",
      "src/pkg/module.pyx::Solver",
      "src/pkg/module.pyx::Solver.method",
      "src/pkg/module.pyx::outer",
    ],
  );
});

test("repeated parses produce identical Cython symbol IDs and ordering", async () => {
  const first = await parseCoreFixture("src/pkg/module.pyx", MODULE_FIXTURE_URL);
  const second = await parseCoreFixture("src/pkg/module.pyx", MODULE_FIXTURE_URL);

  assert.deepEqual(
    first.symbols.map((symbol) => ({
      id: symbol.id,
      fqName: symbol.fqName,
      kind: symbol.kind,
    })),
    second.symbols.map((symbol) => ({
      id: symbol.id,
      fqName: symbol.fqName,
      kind: symbol.kind,
    })),
  );
  assert.deepEqual(first.edges, second.edges);
});

test("the Cython parser is reachable through the existing registry", async () => {
  const registry = createParserRegistry([cythonParser]);
  const input = await fixtureInput("src/pkg/module.pyx", MODULE_FIXTURE_URL);
  const result = await registry.parse(input);

  assert.equal(registry.getParser(Language.Cython), cythonParser);
  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.result.file.language, Language.Cython);
    assert.equal(result.result.diagnostics.length, 0);
  }
});

test("invalid Cython syntax fails through the existing parser failure path", async () => {
  const registry = createParserRegistry([cythonParser]);
  const result = await registry.parse({
    path: "src/pkg/broken.pyx",
    language: Language.Cython,
    content: await readFile(BROKEN_FIXTURE_URL, "utf8"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "parser_failed");
  assert.match(result.error.message, /^Parser failed: SyntaxError:/);
  assert.equal(result.error.filePath, "src/pkg/broken.pyx");
  assert.equal(result.error.language, Language.Cython);
});

test("import module is detected conservatively when the repo-local target is clear", async () => {
  const fixture = await loadCythonFixture(IMPORTS_INCLUDES_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/import_module_source.pyx");
  const sourceSymbol = moduleSymbolOf(result.symbols);
  const targetResult = await parseFixtureFile(fixture, "src/pkg/runtime_target.pyx");
  const targetSymbol = moduleSymbolOf(targetResult.symbols);

  assert.deepEqual(importEdges(result), [
    {
      id: importEdges(result)[0]?.id,
      srcSymbolId: sourceSymbol.id,
      dstSymbolId: targetSymbol.id,
      edgeType: EdgeType.Imports,
      confidence: 1,
    },
  ]);
});

test("import module as alias is handled conservatively", async () => {
  const fixture = await loadCythonFixture(IMPORTS_INCLUDES_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/import_module_alias_source.pyx");
  const sourceSymbol = moduleSymbolOf(result.symbols);
  const targetResult = await parseFixtureFile(fixture, "src/pkg/runtime_target.pyx");
  const targetSymbol = moduleSymbolOf(targetResult.symbols);

  assert.deepEqual(importEdges(result), [
    {
      id: importEdges(result)[0]?.id,
      srcSymbolId: sourceSymbol.id,
      dstSymbolId: targetSymbol.id,
      edgeType: EdgeType.Imports,
      confidence: 1,
    },
  ]);
});

test("from module import name creates imports edges when target resolution is clear", async () => {
  const fixture = await loadCythonFixture(IMPORTS_INCLUDES_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/from_import_source.pyx");
  const sourceSymbol = moduleSymbolOf(result.symbols);
  const targetResult = await parseFixtureFile(fixture, "src/pkg/named_target.pyx");
  const targetSymbol = findTopLevelFunction(targetResult.symbols, "named_target");

  assert.deepEqual(importEdges(result), [
    {
      id: importEdges(result)[0]?.id,
      srcSymbolId: sourceSymbol.id,
      dstSymbolId: targetSymbol.id,
      edgeType: EdgeType.Imports,
      confidence: 1,
    },
  ]);
});

test("cimport module is handled conservatively when the repo-local target is clear", async () => {
  const fixture = await loadCythonFixture(IMPORTS_INCLUDES_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/cimport_module_source.pyx");
  const sourceSymbol = moduleSymbolOf(result.symbols);
  const targetResult = await parseFixtureFile(fixture, "src/pkg/header_target.pxd");
  const targetSymbol = moduleSymbolOf(targetResult.symbols);

  assert.deepEqual(importEdges(result), [
    {
      id: importEdges(result)[0]?.id,
      srcSymbolId: sourceSymbol.id,
      dstSymbolId: targetSymbol.id,
      edgeType: EdgeType.Imports,
      confidence: 1,
    },
  ]);
});

test("from module cimport name creates imports edges when target resolution is clear", async () => {
  const fixture = await loadCythonFixture(IMPORTS_INCLUDES_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/from_cimport_source.pyx");
  const sourceSymbol = moduleSymbolOf(result.symbols);
  const targetResult = await parseFixtureFile(fixture, "src/pkg/header_target.pxd");
  const targetSymbol = findTopLevelFunction(targetResult.symbols, "declared_target");

  assert.deepEqual(importEdges(result), [
    {
      id: importEdges(result)[0]?.id,
      srcSymbolId: sourceSymbol.id,
      dstSymbolId: targetSymbol.id,
      edgeType: EdgeType.Imports,
      confidence: 1,
    },
  ]);
});

test("include file relationships are represented deterministically when the target is repo-local", async () => {
  const fixture = await loadCythonFixture(IMPORTS_INCLUDES_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/include_source.pyx");
  const sourceSymbol = moduleSymbolOf(result.symbols);
  const targetResult = await parseFixtureFile(fixture, "src/pkg/shared_defs.pxi");
  const targetSymbol = moduleSymbolOf(targetResult.symbols);

  assert.deepEqual(importEdges(result), [
    {
      id: importEdges(result)[0]?.id,
      srcSymbolId: sourceSymbol.id,
      dstSymbolId: targetSymbol.id,
      edgeType: EdgeType.Imports,
      confidence: 1,
    },
  ]);
});

test("third-party Cython imports create no imports edges", async () => {
  const fixture = await loadCythonFixture(IMPORTS_INCLUDES_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/third_party_source.pyx");

  assert.deepEqual(importEdges(result), []);
});

test("unresolved Cython imports and includes do not crash and do not guess", async () => {
  const fixture = await loadCythonFixture(IMPORTS_INCLUDES_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/unresolved_source.pyx");

  assert.deepEqual(importEdges(result), []);
  assert.deepEqual(result.diagnostics, []);
});

test("repeated parses produce identical Cython import and include edges and ordering", async () => {
  const fixture = await loadCythonFixture(IMPORTS_INCLUDES_FIXTURE_URL);
  const first = await parseFixtureFile(fixture, "src/pkg/stable_source.pyx");
  const second = await parseFixtureFile(fixture, "src/pkg/stable_source.pyx");

  assert.deepEqual(importEdges(first), importEdges(second));
});

test("Cython core symbol extraction includes top-level functions, classes, and methods", async () => {
  const result = await parseCoreFixture("src/pkg/module.pyx", MODULE_FIXTURE_URL);

  assert.deepEqual(
    result.symbols.map((symbol) => [symbol.localName, symbol.kind]),
    [
      ["<module>", SymbolKind.Module],
      ["integrate", SymbolKind.Function],
      ["solve_system", SymbolKind.Function],
      ["clamp", SymbolKind.Function],
      ["Solver", SymbolKind.Class],
      ["method", SymbolKind.Method],
      ["outer", SymbolKind.Function],
    ],
  );
  assert.equal(importEdges(result).length, 0);
});

test("a cdef class creates a class symbol with method symbols and contains edges", async () => {
  const result = await parseCythonSource(
    [
      "cdef class Matrix:",
      "    def __init__(self, int n):",
      "        self.n = n",
      "    cpdef int size(self):",
      "        return self.n",
      "",
    ].join("\n"),
  );

  const matrix = findSymbolOfKind(result.symbols, "Matrix", SymbolKind.Class);
  const init = findSymbolOfKind(result.symbols, "__init__", SymbolKind.Method);
  const size = findSymbolOfKind(result.symbols, "size", SymbolKind.Method);

  assert.equal(init.parentSymbolId, matrix.id);
  assert.equal(size.parentSymbolId, matrix.id);
  assert.equal(init.fqName, "src/sample.pyx::Matrix.__init__");

  const contains = callEdgesOf(result, EdgeType.Contains);
  assert.equal(contains.length, 2);
  assert.equal(contains.every((edge) => edge.srcSymbolId === matrix.id), true);
  assert.deepEqual(
    contains.map((edge) => edge.dstSymbolId).sort(),
    [init.id, size.id].sort(),
  );
});

test("a top-level Cython function call creates a calls edge", async () => {
  const result = await parseCythonSource(
    [
      "def helper(int x):",
      "    return x",
      "",
      "def main(int y):",
      "    return helper(y)",
      "",
    ].join("\n"),
  );

  const helper = findTopLevelFunction(result.symbols, "helper");
  const main = findTopLevelFunction(result.symbols, "main");
  const calls = callEdgesOf(result, EdgeType.Calls);

  assert.deepEqual(calls, [
    {
      id: calls[0]?.id,
      srcSymbolId: main.id,
      dstSymbolId: helper.id,
      edgeType: EdgeType.Calls,
      confidence: 1,
      // The Cython scanner knows the line but not the column, so the occurrence
      // is recorded at `line` precision rather than claiming an exact span.
      callSites: [{ startLine: 5, startColumn: 0, endLine: 5, endColumn: 0, precision: "line" }],
    },
  ]);
});

test("method-to-method and method-to-function calls resolve when exact", async () => {
  const result = await parseCythonSource(
    [
      "def helper(int x):",
      "    return x",
      "",
      "cdef class Engine:",
      "    cpdef int run(self, int v):",
      "        return self.step(v)",
      "    cdef int step(self, int v):",
      "        return helper(v)",
      "",
    ].join("\n"),
  );

  const helper = findTopLevelFunction(result.symbols, "helper");
  const run = findSymbolOfKind(result.symbols, "run", SymbolKind.Method);
  const step = findSymbolOfKind(result.symbols, "step", SymbolKind.Method);
  const callPairs = callEdgesOf(result, EdgeType.Calls).map((edge) => [
    edge.srcSymbolId,
    edge.dstSymbolId,
  ]);

  // self.step() resolves to the enclosing class method (method-to-method).
  assert.equal(callPairs.some(([src, dst]) => src === run.id && dst === step.id), true);
  // helper() resolves to the same-file top-level function (method-to-function).
  assert.equal(callPairs.some(([src, dst]) => src === step.id && dst === helper.id), true);
});

test("an imported Cython function call resolves to the exact import target", async () => {
  const targetContent = "cpdef int build(int x):\n    return x\n";
  const parser = createCythonParser({
    knownFiles: [{ path: "lib.pyx", content: targetContent }],
  });
  const result = await parser.parse({
    path: "main.pyx",
    language: Language.Cython,
    content: "from lib import build\n\ndef top(int a):\n    return build(a)\n",
  });
  const target = await parser.parse({
    path: "lib.pyx",
    language: Language.Cython,
    content: targetContent,
  });

  const top = findTopLevelFunction(result.symbols, "top");
  const build = findTopLevelFunction(target.symbols, "build");
  const calls = result.edges.filter((edge) => edge.edgeType === EdgeType.Calls);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.srcSymbolId, top.id);
  assert.equal(calls[0]?.dstSymbolId, build.id);
});

test("a cimported function call resolves to the exact .pxd declaration", async () => {
  const headerContent = "cdef int declared(int x)\n";
  const parser = createCythonParser({
    knownFiles: [{ path: "header.pxd", content: headerContent }],
  });
  const result = await parser.parse({
    path: "main.pyx",
    language: Language.Cython,
    content: "from header cimport declared\n\ndef top(int a):\n    return declared(a)\n",
  });
  const target = await parser.parse({
    path: "header.pxd",
    language: Language.Cython,
    content: headerContent,
  });

  const top = findTopLevelFunction(result.symbols, "top");
  const declared = findTopLevelFunction(target.symbols, "declared");
  const calls = result.edges.filter((edge) => edge.edgeType === EdgeType.Calls);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.srcSymbolId, top.id);
  assert.equal(calls[0]?.dstSymbolId, declared.id);
});

test("a base class reference creates a references edge when the base resolves exactly", async () => {
  const result = await parseCythonSource(
    [
      "cdef class Base:",
      "    pass",
      "",
      "cdef class Derived(Base):",
      "    pass",
      "",
    ].join("\n"),
  );

  const base = findSymbolOfKind(result.symbols, "Base", SymbolKind.Class);
  const derived = findSymbolOfKind(result.symbols, "Derived", SymbolKind.Class);
  const references = callEdgesOf(result, EdgeType.References);

  assert.deepEqual(references, [
    {
      id: references[0]?.id,
      srcSymbolId: derived.id,
      dstSymbolId: base.id,
      edgeType: EdgeType.References,
      confidence: 1,
    },
  ]);
});

test("an ambiguous receiver method call is skipped conservatively", async () => {
  const result = await parseCythonSource(
    ["def run(obj):", "    return obj.compute()", ""].join("\n"),
  );

  assert.deepEqual(callEdgesOf(result, EdgeType.Calls), []);
});

test("unsupported Cython constructs are skipped without crashing", async () => {
  const result = await parseCythonSource(
    [
      'cdef extern from "math.h":',
      "    double sin(double value)",
      "",
      "ctypedef int myint",
      "",
      "cdef packed struct Point:",
      "    int x",
      "    int y",
      "",
      "def usable(int v):",
      "    return v",
      "",
    ].join("\n"),
  );

  assert.equal(
    result.symbols.some((symbol) => symbol.localName === "usable" && symbol.kind === SymbolKind.Function),
    true,
  );
  assert.equal(result.symbols.some((symbol) => symbol.localName === "Point"), false);
  assert.equal(result.symbols.some((symbol) => symbol.localName === "myint"), false);
  assert.deepEqual(result.diagnostics, []);
});

test("Cython class, call, and reference extraction is deterministic across repeated parses", async () => {
  const source = [
    "def helper(int x):",
    "    return x",
    "",
    "cdef class Base:",
    "    pass",
    "",
    "cdef class Engine(Base):",
    "    cpdef int run(self, int v):",
    "        return helper(self.step(v))",
    "    cdef int step(self, int v):",
    "        return v",
    "",
  ].join("\n");

  const first = await parseCythonSource(source);
  const second = await parseCythonSource(source);

  assert.deepEqual(
    first.symbols.map((symbol) => ({ id: symbol.id, fqName: symbol.fqName, kind: symbol.kind })),
    second.symbols.map((symbol) => ({ id: symbol.id, fqName: symbol.fqName, kind: symbol.kind })),
  );
  assert.deepEqual(first.edges, second.edges);
});

async function parseCythonSource(content: string) {
  return cythonParser.parse({
    path: "src/sample.pyx",
    language: Language.Cython,
    content,
  });
}

function callEdgesOf(
  result: Awaited<ReturnType<typeof parseCoreFixture>>,
  edgeType: EdgeType,
) {
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

async function parseCoreFixture(filePath: string, fileUrl: URL) {
  return cythonParser.parse(await fixtureInput(filePath, fileUrl));
}

async function fixtureInput(filePath: string, fileUrl: URL): Promise<ParseFileInput> {
  return {
    path: filePath,
    language: Language.Cython,
    content: await readFile(fileUrl, "utf8"),
  };
}

interface LoadedCythonFixture {
  parser: ReturnType<typeof createCythonParser>;
  filesByPath: ReadonlyMap<string, string>;
}

async function loadCythonFixture(rootUrl: URL): Promise<LoadedCythonFixture> {
  const rootPath = fileURLToPath(rootUrl);
  const filePaths = await listFixtureFiles(rootPath);
  const knownFiles = await Promise.all(filePaths.map(async (filePath) => {
    return {
      path: path.relative(rootPath, filePath).replace(/\\/g, "/"),
      content: await readFile(filePath, "utf8"),
    };
  }));
  knownFiles.sort((left, right) => left.path.localeCompare(right.path));

  return {
    parser: createCythonParser({ knownFiles }),
    filesByPath: new Map(knownFiles.map((file) => [file.path, file.content])),
  };
}

async function parseFixtureFile(
  fixture: LoadedCythonFixture,
  filePath: string,
) {
  const content = fixture.filesByPath.get(filePath);

  assert.notEqual(content, undefined);

  return fixture.parser.parse({
    path: filePath,
    language: Language.Cython,
    content: content as string,
  });
}

async function listFixtureFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const filePaths: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      filePaths.push(...await listFixtureFiles(entryPath));
      continue;
    }

    if (
      entry.isFile()
      && (
        entry.name.endsWith(".py")
        || entry.name.endsWith(".pyx")
        || entry.name.endsWith(".pxd")
        || entry.name.endsWith(".pxi")
      )
    ) {
      filePaths.push(entryPath);
    }
  }

  return filePaths;
}

function importEdges(result: Awaited<ReturnType<typeof parseCoreFixture>>) {
  return result.edges.filter((edge) => edge.edgeType === EdgeType.Imports);
}

// M140: module-level imports are owned by the file's module scope symbol.
function moduleSymbolOf(symbols: readonly SymbolRecord[]): SymbolRecord {
  const matches = symbols.filter((symbol) => symbol.kind === SymbolKind.Module);
  assert.equal(matches.length, 1);
  return matches[0] as SymbolRecord;
}

function findTopLevelFunction(symbols: readonly SymbolRecord[], localName: string): SymbolRecord {
  const symbol = symbols.find((candidate) => {
    return candidate.localName === localName
      && candidate.kind === SymbolKind.Function
      && candidate.parentSymbolId === undefined;
  });

  assert.notEqual(symbol, undefined);

  return symbol as SymbolRecord;
}
