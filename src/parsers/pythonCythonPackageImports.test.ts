import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { EdgeType, Language, SymbolKind, type EdgeRecord, type ParseResult, type SymbolRecord } from "../domain/types";
import { getImpactGraph } from "../impact/getImpactGraph";
import { indexProject } from "../indexer/indexProject";
import { searchLogicFlow } from "../logicFlow/searchLogicFlow";
import { createCythonParser, createPythonParser } from "./index";

interface FileEntry {
  readonly path: string;
  readonly content: string;
}

const KERNELS_PYX = [
  "cpdef int fast_kernel(int x):",
  "    return x",
  "",
  "cdef class Engine:",
  "    cpdef int run(self):",
  "        return 1",
  "",
].join("\n");

async function parsePython(files: readonly FileEntry[], targetPath: string): Promise<ParseResult> {
  const parser = createPythonParser({ knownFiles: [...files] });
  const target = files.find((file) => file.path === targetPath)!;

  return parser.parse({ path: target.path, language: Language.Python, content: target.content });
}

async function parseCython(files: readonly FileEntry[], targetPath: string): Promise<ParseResult> {
  const parser = createCythonParser({ knownFiles: [...files] });
  const target = files.find((file) => file.path === targetPath)!;

  return parser.parse({ path: target.path, language: Language.Cython, content: target.content });
}

function edgesOfType(result: ParseResult, edgeType: EdgeType): EdgeRecord[] {
  return result.edges.filter((edge) => edge.edgeType === edgeType);
}

function findSymbol(
  symbols: readonly SymbolRecord[],
  localName: string,
  kind: SymbolKind,
): SymbolRecord {
  const symbol = symbols.find((candidate) => candidate.localName === localName && candidate.kind === kind);
  assert.notEqual(symbol, undefined, `expected ${kind} ${localName}`);

  return symbol as SymbolRecord;
}

function assertCallsEdge(wrapper: ParseResult, from: SymbolRecord, to: SymbolRecord): void {
  assert.equal(
    edgesOfType(wrapper, EdgeType.Calls).some((edge) => edge.srcSymbolId === from.id && edge.dstSymbolId === to.id),
    true,
  );
}

test("a Python relative import to a Cython function emits a calls edge", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "" },
    { path: "pkg/kernels.pyx", content: KERNELS_PYX },
    { path: "pkg/wrapper.py", content: ["from .kernels import fast_kernel", "", "def wrap(v):", "    return fast_kernel(v)", ""].join("\n") },
  ];
  const wrapper = await parsePython(files, "pkg/wrapper.py");
  const kernels = await parseCython(files, "pkg/kernels.pyx");

  assertCallsEdge(wrapper, findSymbol(wrapper.symbols, "wrap", SymbolKind.Function), findSymbol(kernels.symbols, "fast_kernel", SymbolKind.Function));
});

test("a Python relative parent import to a Cython class constructor emits a calls edge", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "" },
    { path: "pkg/kernels.pyx", content: KERNELS_PYX },
    { path: "pkg/sub/__init__.py", content: "" },
    { path: "pkg/sub/wrapper.py", content: ["from ..kernels import Engine", "", "def wrap():", "    return Engine()", ""].join("\n") },
  ];
  const wrapper = await parsePython(files, "pkg/sub/wrapper.py");
  const kernels = await parseCython(files, "pkg/kernels.pyx");

  assertCallsEdge(wrapper, findSymbol(wrapper.symbols, "wrap", SymbolKind.Function), findSymbol(kernels.symbols, "Engine", SymbolKind.Class));
});

test("an aliased module import to a Cython function emits a calls edge", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "" },
    { path: "pkg/kernels.pyx", content: KERNELS_PYX },
    { path: "pkg/wrapper.py", content: ["import pkg.kernels as kz", "", "def wrap(v):", "    return kz.fast_kernel(v)", ""].join("\n") },
  ];
  const wrapper = await parsePython(files, "pkg/wrapper.py");
  const kernels = await parseCython(files, "pkg/kernels.pyx");

  assertCallsEdge(wrapper, findSymbol(wrapper.symbols, "wrap", SymbolKind.Function), findSymbol(kernels.symbols, "fast_kernel", SymbolKind.Function));
});

test("an aliased symbol import to a Cython function emits a calls edge", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "" },
    { path: "pkg/kernels.pyx", content: KERNELS_PYX },
    { path: "pkg/wrapper.py", content: ["from pkg.kernels import fast_kernel as kek", "", "def wrap(v):", "    return kek(v)", ""].join("\n") },
  ];
  const wrapper = await parsePython(files, "pkg/wrapper.py");
  const kernels = await parseCython(files, "pkg/kernels.pyx");

  assertCallsEdge(wrapper, findSymbol(wrapper.symbols, "wrap", SymbolKind.Function), findSymbol(kernels.symbols, "fast_kernel", SymbolKind.Function));
});

test("a package __init__.py exact re-export to a Cython symbol emits a calls edge", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "from .kernels import fast_kernel\n" },
    { path: "pkg/kernels.pyx", content: KERNELS_PYX },
    { path: "user.py", content: ["from pkg import fast_kernel", "", "def wrap(v):", "    return fast_kernel(v)", ""].join("\n") },
  ];
  const wrapper = await parsePython(files, "user.py");
  const kernels = await parseCython(files, "pkg/kernels.pyx");

  assertCallsEdge(wrapper, findSymbol(wrapper.symbols, "wrap", SymbolKind.Function), findSymbol(kernels.symbols, "fast_kernel", SymbolKind.Function));
});

test("a chained package re-export to a Cython symbol emits a calls edge", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "from .sub import fast_kernel\n" },
    { path: "pkg/sub/__init__.py", content: "from .kernels import fast_kernel\n" },
    { path: "pkg/sub/kernels.pyx", content: KERNELS_PYX },
    { path: "user.py", content: ["from pkg import fast_kernel", "", "def wrap(v):", "    return fast_kernel(v)", ""].join("\n") },
  ];
  const wrapper = await parsePython(files, "user.py");
  const kernels = await parseCython(files, "pkg/sub/kernels.pyx");

  assertCallsEdge(wrapper, findSymbol(wrapper.symbols, "wrap", SymbolKind.Function), findSymbol(kernels.symbols, "fast_kernel", SymbolKind.Function));
});

test("an ambiguous package re-export is skipped (no calls edge)", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "from .a import dup\nfrom .b import dup\n" },
    { path: "pkg/a.pyx", content: "cpdef int dup(int x):\n    return x\n" },
    { path: "pkg/b.pyx", content: "cpdef int dup(int y):\n    return y\n" },
    { path: "user.py", content: ["from pkg import dup", "", "def wrap():", "    return dup(1)", ""].join("\n") },
  ];
  const wrapper = await parsePython(files, "user.py");

  assert.equal(edgesOfType(wrapper, EdgeType.Calls).length, 0);
});

test(".py wins over .pyx for the same module name, deterministically", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "" },
    { path: "pkg/mod.py", content: "def shared(x):\n    return x\n" },
    { path: "pkg/mod.pyx", content: "cpdef int shared(int x):\n    return x\n" },
    { path: "user.py", content: ["from pkg.mod import shared", "", "def wrap(v):", "    return shared(v)", ""].join("\n") },
  ];
  const wrapper = await parsePython(files, "user.py");
  const pySymbol = findSymbol((await parsePython(files, "pkg/mod.py")).symbols, "shared", SymbolKind.Function);
  const pyxSymbol = findSymbol((await parseCython(files, "pkg/mod.pyx")).symbols, "shared", SymbolKind.Function);
  const wrap = findSymbol(wrapper.symbols, "wrap", SymbolKind.Function);
  const calls = edgesOfType(wrapper, EdgeType.Calls);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.dstSymbolId, pySymbol.id);
  assert.notEqual(calls[0]?.dstSymbolId, pyxSymbol.id);

  // Deterministic across repeats.
  const repeat = await parsePython(files, "user.py");
  assert.deepEqual(repeat.edges, wrapper.edges);
});

test(".pyx wins over .pxd for the same module name", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "" },
    { path: "pkg/mod.pyx", content: "cpdef int shared(int x):\n    return x\n" },
    { path: "pkg/mod.pxd", content: "cpdef int shared(int x)\n" },
    { path: "user.py", content: ["from pkg.mod import shared", "", "def wrap(v):", "    return shared(v)", ""].join("\n") },
  ];
  const wrapper = await parsePython(files, "user.py");
  const pyxSymbol = findSymbol((await parseCython(files, "pkg/mod.pyx")).symbols, "shared", SymbolKind.Function);
  const calls = edgesOfType(wrapper, EdgeType.Calls);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.dstSymbolId, pyxSymbol.id);
});

test("direct Python->Cython import resolution does not regress", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "" },
    { path: "pkg/kernels.pyx", content: KERNELS_PYX },
    { path: "pkg/wrapper.py", content: ["from pkg.kernels import fast_kernel", "", "def wrap(v):", "    return fast_kernel(v)", ""].join("\n") },
  ];
  const wrapper = await parsePython(files, "pkg/wrapper.py");
  const kernels = await parseCython(files, "pkg/kernels.pyx");

  assertCallsEdge(wrapper, findSymbol(wrapper.symbols, "wrap", SymbolKind.Function), findSymbol(kernels.symbols, "fast_kernel", SymbolKind.Function));
});

test("Cython->Python resolution does not regress", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "" },
    { path: "pkg/helpers.py", content: "def helper(x):\n    return x\n" },
    { path: "pkg/kernels.pyx", content: ["from pkg.helpers import helper", "", "cpdef int run(int x):", "    return helper(x)", ""].join("\n") },
  ];
  const kernels = await parseCython(files, "pkg/kernels.pyx");
  const helpers = await parsePython(files, "pkg/helpers.py");

  assertCallsEdge(kernels, findSymbol(kernels.symbols, "run", SymbolKind.Function), findSymbol(helpers.symbols, "helper", SymbolKind.Function));
});

async function withReExportRepo(
  run: (ctx: { db: ReturnType<typeof openIndexerDatabase> }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-pkg-imports-"));
  const repoRoot = path.join(root, "repo");
  const db = openIndexerDatabase();
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "from .kernels import fast_kernel\n" },
    { path: "pkg/kernels.pyx", content: KERNELS_PYX },
    { path: "user.py", content: ["from pkg import fast_kernel", "", "def wrap(v):", "    return fast_kernel(v)", ""].join("\n") },
  ];

  try {
    for (const file of files) {
      const absolute = path.join(repoRoot, file.path);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, file.content);
    }
    await indexProject({ repoRoot, db });
    await run({ db });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("get_impact_graph surfaces Python callers through a package re-export path", async () => {
  await withReExportRepo(async ({ db }) => {
    const result = getImpactGraph(db, { symbolFqn: "pkg/kernels.pyx::fast_kernel", depth: 2, format: "list" });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }

    assert.equal(result.output.nodes.some((node) => node.fqName === "user.py::wrap"), true);
    assert.equal(
      result.output.coverage.notes.some((note) => note.includes("Cross-language Python<->Cython evidence")),
      true,
    );
  });
});

test("search_logic_flow traverses a Python->Cython path through a package re-export", async () => {
  await withReExportRepo(async ({ db }) => {
    const result = searchLogicFlow(db, { start: "user.py::wrap", end: "pkg/kernels.pyx::fast_kernel", maxPaths: 5 });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }

    assert.equal(result.output.summary.reachable, true);
    assert.equal(result.output.coverage.callFlowEvidenceUsed, true);
  });
});

test("repeated indexing of a re-export repo is deterministic", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "from .kernels import fast_kernel\n" },
    { path: "pkg/kernels.pyx", content: KERNELS_PYX },
    { path: "user.py", content: ["from pkg import fast_kernel", "", "def wrap(v):", "    return fast_kernel(v)", ""].join("\n") },
  ];

  const first = await parsePython(files, "user.py");
  const second = await parsePython(files, "user.py");

  assert.deepEqual(second.edges, first.edges);
  assert.equal(edgesOfType(first, EdgeType.Calls).length, 1);
});
