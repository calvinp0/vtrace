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

test("unsupported class-like constructs and nested defs are skipped conservatively", async () => {
  const result = await parseCoreFixture("src/pkg/module.pyx", MODULE_FIXTURE_URL);

  assert.equal(result.symbols.some((symbol) => symbol.localName === "Solver"), false);
  assert.equal(result.symbols.some((symbol) => symbol.localName === "method"), false);
  assert.equal(result.symbols.some((symbol) => symbol.localName === "inner"), false);
  assert.deepEqual(importEdges(result), []);
});

test("Cython fqNames keep the path-based shared model shape", async () => {
  const result = await parseCoreFixture("src/pkg/module.pyx", MODULE_FIXTURE_URL);

  assert.deepEqual(
    result.symbols.map((symbol) => symbol.fqName),
    [
      "src/pkg/module.pyx::integrate",
      "src/pkg/module.pyx::solve_system",
      "src/pkg/module.pyx::clamp",
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
  const sourceSymbol = findTopLevelFunction(result.symbols, "use_runtime");
  const targetResult = await parseFixtureFile(fixture, "src/pkg/runtime_target.pyx");
  const targetSymbol = findTopLevelFunction(targetResult.symbols, "runtime_target");

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
  const sourceSymbol = findTopLevelFunction(result.symbols, "use_runtime_alias");
  const targetResult = await parseFixtureFile(fixture, "src/pkg/runtime_target.pyx");
  const targetSymbol = findTopLevelFunction(targetResult.symbols, "runtime_target");

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
  const sourceSymbol = findTopLevelFunction(result.symbols, "use_named");
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
  const sourceSymbol = findTopLevelFunction(result.symbols, "use_header");
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

test("from module cimport name creates imports edges when target resolution is clear", async () => {
  const fixture = await loadCythonFixture(IMPORTS_INCLUDES_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/from_cimport_source.pyx");
  const sourceSymbol = findTopLevelFunction(result.symbols, "use_declared");
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
  const sourceSymbol = findTopLevelFunction(result.symbols, "use_include");
  const targetResult = await parseFixtureFile(fixture, "src/pkg/shared_defs.pxi");
  const targetSymbol = findTopLevelFunction(targetResult.symbols, "shared_helper");

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

test("existing Cython core symbol extraction remains unchanged after adding import and include support", async () => {
  const result = await parseCoreFixture("src/pkg/module.pyx", MODULE_FIXTURE_URL);

  assert.deepEqual(
    result.symbols.map((symbol) => [symbol.localName, symbol.kind]),
    [
      ["integrate", SymbolKind.Function],
      ["solve_system", SymbolKind.Function],
      ["clamp", SymbolKind.Function],
      ["outer", SymbolKind.Function],
    ],
  );
  assert.equal(importEdges(result).length, 0);
});

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

function findTopLevelFunction(symbols: readonly SymbolRecord[], localName: string): SymbolRecord {
  const symbol = symbols.find((candidate) => {
    return candidate.localName === localName
      && candidate.kind === SymbolKind.Function
      && candidate.parentSymbolId === undefined;
  });

  assert.notEqual(symbol, undefined);

  return symbol as SymbolRecord;
}
