import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import {
  EdgeType,
  Language,
  SymbolKind,
  type EdgeRecord,
  type ParseResult,
  type SymbolRecord,
} from "../domain/types";
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

function packageFiles(wrapperContent: string): FileEntry[] {
  return [
    { path: "pkg/__init__.py", content: "" },
    { path: "pkg/kernels.pyx", content: KERNELS_PYX },
    { path: "pkg/wrapper.py", content: wrapperContent },
  ];
}

async function parsePython(files: readonly FileEntry[], targetPath: string): Promise<ParseResult> {
  const parser = createPythonParser({ knownFiles: [...files] });
  const target = files.find((file) => file.path === targetPath);
  assert.notEqual(target, undefined);

  return parser.parse({
    path: target!.path,
    language: Language.Python,
    content: target!.content,
  });
}

async function parseCython(files: readonly FileEntry[], targetPath: string): Promise<ParseResult> {
  const parser = createCythonParser({ knownFiles: [...files] });
  const target = files.find((file) => file.path === targetPath);
  assert.notEqual(target, undefined);

  return parser.parse({
    path: target!.path,
    language: Language.Cython,
    content: target!.content,
  });
}

function edgesOfType(result: ParseResult, edgeType: EdgeType): EdgeRecord[] {
  return result.edges.filter((edge) => edge.edgeType === edgeType);
}

function findSymbol(
  symbols: readonly SymbolRecord[],
  localName: string,
  kind: SymbolKind,
): SymbolRecord {
  const symbol = symbols.find(
    (candidate) => candidate.localName === localName && candidate.kind === kind,
  );
  assert.notEqual(symbol, undefined, `expected ${kind} ${localName}`);

  return symbol as SymbolRecord;
}

test("`from cython_mod import kernel; kernel()` emits a Python->Cython calls edge", async () => {
  const files = packageFiles(
    ["from pkg.kernels import fast_kernel", "", "def wrap(v):", "    return fast_kernel(v)", ""].join("\n"),
  );
  const wrapper = await parsePython(files, "pkg/wrapper.py");
  const kernels = await parseCython(files, "pkg/kernels.pyx");

  const wrap = findSymbol(wrapper.symbols, "wrap", SymbolKind.Function);
  const fastKernel = findSymbol(kernels.symbols, "fast_kernel", SymbolKind.Function);
  const calls = edgesOfType(wrapper, EdgeType.Calls);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.srcSymbolId, wrap.id);
  assert.equal(calls[0]?.dstSymbolId, fastKernel.id);
});

test("`import cython_mod; cython_mod.kernel()` emits a Python->Cython calls edge", async () => {
  const files: FileEntry[] = [
    { path: "kernels.pyx", content: KERNELS_PYX },
    {
      path: "wrapper.py",
      content: ["import kernels", "", "def wrap(v):", "    return kernels.fast_kernel(v)", ""].join("\n"),
    },
  ];
  const wrapper = await parsePython(files, "wrapper.py");
  const kernels = await parseCython(files, "kernels.pyx");

  const wrap = findSymbol(wrapper.symbols, "wrap", SymbolKind.Function);
  const fastKernel = findSymbol(kernels.symbols, "fast_kernel", SymbolKind.Function);
  const calls = edgesOfType(wrapper, EdgeType.Calls);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.srcSymbolId, wrap.id);
  assert.equal(calls[0]?.dstSymbolId, fastKernel.id);
});

test("a Python wrapper calling a Cython class constructor emits a calls edge to the class", async () => {
  const files = packageFiles(
    ["from pkg.kernels import Engine", "", "def wrap():", "    return Engine()", ""].join("\n"),
  );
  const wrapper = await parsePython(files, "pkg/wrapper.py");
  const kernels = await parseCython(files, "pkg/kernels.pyx");

  const wrap = findSymbol(wrapper.symbols, "wrap", SymbolKind.Function);
  const engine = findSymbol(kernels.symbols, "Engine", SymbolKind.Class);
  const calls = edgesOfType(wrapper, EdgeType.Calls);

  assert.equal(calls.some((edge) => edge.srcSymbolId === wrap.id && edge.dstSymbolId === engine.id), true);
});

test("a Python reference to an imported Cython symbol emits a references edge, not a calls edge", async () => {
  const files = packageFiles(
    ["from pkg.kernels import Engine", "", "engine_type = Engine", ""].join("\n"),
  );
  const wrapper = await parsePython(files, "pkg/wrapper.py");
  const kernels = await parseCython(files, "pkg/kernels.pyx");

  const engineType = findSymbol(wrapper.symbols, "engine_type", SymbolKind.ModuleAlias);
  const engine = findSymbol(kernels.symbols, "Engine", SymbolKind.Class);
  const references = edgesOfType(wrapper, EdgeType.References);
  const calls = edgesOfType(wrapper, EdgeType.Calls);

  assert.equal(references.some((edge) => edge.srcSymbolId === engineType.id && edge.dstSymbolId === engine.id), true);
  assert.equal(calls.length, 0);
});

test("a Python wrapper calling an exact Cython static/class method emits a calls edge to the method", async () => {
  const files = packageFiles(
    ["from pkg.kernels import Engine", "", "def wrap():", "    return Engine.run(None)", ""].join("\n"),
  );
  const wrapper = await parsePython(files, "pkg/wrapper.py");
  const kernels = await parseCython(files, "pkg/kernels.pyx");

  const wrap = findSymbol(wrapper.symbols, "wrap", SymbolKind.Function);
  const run = findSymbol(kernels.symbols, "run", SymbolKind.Method);
  const calls = edgesOfType(wrapper, EdgeType.Calls);

  assert.equal(calls.some((edge) => edge.srcSymbolId === wrap.id && edge.dstSymbolId === run.id), true);
});

test("an ambiguous imported Cython target is skipped (no calls edge)", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "" },
    {
      path: "pkg/ambiguous.pyx",
      content: ["cpdef int dup(int x):", "    return x", "", "cpdef int dup(int y):", "    return y", ""].join("\n"),
    },
    {
      path: "pkg/wrapper.py",
      content: ["from pkg.ambiguous import dup", "", "def wrap():", "    return dup(1)", ""].join("\n"),
    },
  ];
  const wrapper = await parsePython(files, "pkg/wrapper.py");

  assert.equal(edgesOfType(wrapper, EdgeType.Calls).length, 0);
  assert.equal(edgesOfType(wrapper, EdgeType.Imports).length, 0);
});

test("a missing Cython module is skipped cleanly (no edges, no throw)", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "" },
    {
      path: "pkg/wrapper.py",
      content: ["from pkg.nonexistent import thing", "", "def wrap():", "    return thing(1)", ""].join("\n"),
    },
  ];
  const wrapper = await parsePython(files, "pkg/wrapper.py");

  assert.equal(edgesOfType(wrapper, EdgeType.Calls).length, 0);
  assert.equal(edgesOfType(wrapper, EdgeType.Imports).length, 0);
  assert.equal(edgesOfType(wrapper, EdgeType.References).length, 0);
});

test("Python->Python and Cython->Cython resolution do not regress when Cython modules coexist", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "" },
    { path: "pkg/kernels.pyx", content: KERNELS_PYX },
    { path: "pkg/helpers.py", content: "def helper(x):\n    return x\n" },
    {
      path: "pkg/wrapper.py",
      content: ["from pkg.helpers import helper", "", "def wrap(v):", "    return helper(v)", ""].join("\n"),
    },
  ];

  // Python -> Python still resolves with Cython files present in the index.
  const wrapper = await parsePython(files, "pkg/wrapper.py");
  const helpers = await parsePython(files, "pkg/helpers.py");
  const wrap = findSymbol(wrapper.symbols, "wrap", SymbolKind.Function);
  const helper = findSymbol(helpers.symbols, "helper", SymbolKind.Function);
  const pyCalls = edgesOfType(wrapper, EdgeType.Calls);
  assert.equal(pyCalls.length, 1);
  assert.equal(pyCalls[0]?.srcSymbolId, wrap.id);
  assert.equal(pyCalls[0]?.dstSymbolId, helper.id);

  // Cython -> Cython still resolves through the Cython parser.
  const cyFiles: FileEntry[] = [
    {
      path: "pkg/kernels.pyx",
      content: ["cpdef int leaf(int x):", "    return x", "", "cpdef int root(int y):", "    return leaf(y)", ""].join("\n"),
    },
  ];
  const cython = await parseCython(cyFiles, "pkg/kernels.pyx");
  const leaf = findSymbol(cython.symbols, "leaf", SymbolKind.Function);
  const root = findSymbol(cython.symbols, "root", SymbolKind.Function);
  const cyCalls = edgesOfType(cython, EdgeType.Calls);
  assert.equal(cyCalls.some((edge) => edge.srcSymbolId === root.id && edge.dstSymbolId === leaf.id), true);
});

async function withIndexedWrapperRepo(
  run: (ctx: { db: ReturnType<typeof openIndexerDatabase>; repoRoot: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-cross-lang-"));
  const repoRoot = path.join(root, "repo");
  const db = openIndexerDatabase();
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "" },
    { path: "pkg/kernels.pyx", content: KERNELS_PYX },
    {
      path: "pkg/wrapper.py",
      content: ["from pkg.kernels import fast_kernel", "", "def wrap(v):", "    return fast_kernel(v)", ""].join("\n"),
    },
  ];

  try {
    for (const file of files) {
      const absolute = path.join(repoRoot, file.path);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, file.content);
    }
    await indexProject({ repoRoot, db });
    await run({ db, repoRoot });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("get_impact_graph on a Cython function surfaces its Python callers", async () => {
  await withIndexedWrapperRepo(async ({ db }) => {
    const result = getImpactGraph(db, {
      symbolFqn: "pkg/kernels.pyx::fast_kernel",
      depth: 2,
      format: "list",
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }

    assert.equal(result.output.summary.dependentSymbolCount > 0, true);
    assert.equal(
      result.output.nodes.some((node) => node.fqName === "pkg/wrapper.py::wrap"),
      true,
    );
    assert.equal(result.output.dependentFiles.includes("pkg/wrapper.py"), true);
    assert.equal(
      result.output.coverage.notes.some((note) => note.includes("Cross-language Python<->Cython evidence")),
      true,
    );
  });
});

test("search_logic_flow traverses a Python wrapper to a Cython kernel via call edges", async () => {
  await withIndexedWrapperRepo(async ({ db }) => {
    const result = searchLogicFlow(db, {
      start: "pkg/wrapper.py::wrap",
      end: "pkg/kernels.pyx::fast_kernel",
      maxPaths: 5,
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }

    assert.equal(result.output.summary.reachable, true);
    assert.equal(result.output.coverage.callFlowEvidenceUsed, true);
    assert.equal(
      result.output.coverage.notes.some((note) => note.includes("Python<->Cython boundary")),
      true,
    );
  });
});

test("repeated indexing produces identical Python->Cython edges", async () => {
  const files: FileEntry[] = [
    { path: "pkg/__init__.py", content: "" },
    { path: "pkg/kernels.pyx", content: KERNELS_PYX },
    {
      path: "pkg/wrapper.py",
      content: ["from pkg.kernels import fast_kernel", "", "def wrap(v):", "    return fast_kernel(v)", ""].join("\n"),
    },
  ];

  const first = await parsePython(files, "pkg/wrapper.py");
  const second = await parsePython(files, "pkg/wrapper.py");

  assert.deepEqual(second.edges, first.edges);
  assert.equal(edgesOfType(first, EdgeType.Calls).length, 1);
});
