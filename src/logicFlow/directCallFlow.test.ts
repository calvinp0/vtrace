// M130 flow-correctness regression suite.
//
// The incident: VTRACE reported two directly connected Python functions as
// unconnected. The parser had extracted the `calls` edge and the database had
// stored it; `searchLogicFlow` then sliced the repository-ordered edge list to
// `maxEdges` before building its graph, so in any repo with more edges than the
// bound a real relationship could simply be absent from the search — reported as
// "endpoints not connected".
//
// These tests pin the general rule (conservative direct calls resolve and are
// reachable in one hop) and the specific defect (edge count must not decide edge
// membership).

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { EdgeType } from "../domain/types";
import { listAllEdges } from "../db/repositories/edgesRepository";
import { listSymbolsByFqName } from "../db/repositories/symbolsRepository";
import { LOGIC_FLOW_ERROR_CODE, searchLogicFlow } from "./searchLogicFlow";

async function withPythonRepo(
  files: Readonly<Record<string, string>>,
  run: (repoRoot: string, db: Database) => Promise<void> | void,
): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m130-flow-"));
  const db = openIndexerDatabase();
  try {
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(repoRoot, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }
    await indexProject({ repoRoot, db });
    await run(repoRoot, db);
  } finally {
    db.close();
    await rm(repoRoot, { recursive: true, force: true });
  }
}

function requireOneHopCall(
  db: Database,
  repoRoot: string,
  start: string,
  end: string,
): void {
  const result = searchLogicFlow(db, { start, end, maxPaths: 4 }, { repoRoot });
  assert.equal(result.ok, true, `expected ${start} -> ${end} to resolve`);
  if (!result.ok) return;

  assert.equal(result.output.summary.reachable, true, `expected an indexed path ${start} -> ${end}`);
  assert.equal(result.output.summary.shortestPathEdgeCount, 1, "expected a single-edge path");
  assert.equal(result.output.summary.traversalLimitReached, false);

  const shortest = result.output.paths.find((candidate) => candidate.edgeCount === 1);
  assert.ok(shortest !== undefined, "expected a one-edge path in the returned set");
  assert.equal(shortest.steps[0]?.edgeType, EdgeType.Calls);
  assert.equal(shortest.steps[0]?.fromFqName, start);
  assert.equal(shortest.steps[0]?.toFqName, end);
}

function hasDirectCallEdge(db: Database, start: string, end: string): boolean {
  const from = listSymbolsByFqName(db, start)[0];
  const to = listSymbolsByFqName(db, end)[0];
  if (from === undefined || to === undefined) return false;
  return listAllEdges(db).some((edge) =>
    edge.edgeType === EdgeType.Calls
    && edge.srcSymbolId === from.id
    && edge.dstSymbolId === to.id);
}

test("a same-module bare function call is a direct calls edge and a one-hop flow", async () => {
  await withPythonRepo({
    "pkg/mod.py": [
      "def target():",
      "    return 1",
      "",
      "def caller():",
      "    return target()",
      "",
    ].join("\n"),
  }, (repoRoot, db) => {
    assert.equal(hasDirectCallEdge(db, "pkg/mod.py::caller", "pkg/mod.py::target"), true);
    requireOneHopCall(db, repoRoot, "pkg/mod.py::caller", "pkg/mod.py::target");
  });
});

test("callee defined after the caller resolves the same as callee defined before", async () => {
  await withPythonRepo({
    "pkg/before.py": [
      "def target():",
      "    return 1",
      "",
      "def caller():",
      "    return target()",
      "",
    ].join("\n"),
    "pkg/after.py": [
      "def caller():",
      "    return target()",
      "",
      "def target():",
      "    return 1",
      "",
    ].join("\n"),
  }, (repoRoot, db) => {
    requireOneHopCall(db, repoRoot, "pkg/before.py::caller", "pkg/before.py::target");
    requireOneHopCall(db, repoRoot, "pkg/after.py::caller", "pkg/after.py::target");
  });
});

test("imported, aliased and module-qualified calls each resolve to one direct edge", async () => {
  await withPythonRepo({
    "pkg/__init__.py": "",
    "pkg/module.py": [
      "def target():",
      "    return 1",
      "",
    ].join("\n"),
    "pkg/plain.py": [
      "from pkg.module import target",
      "",
      "def caller():",
      "    return target()",
      "",
    ].join("\n"),
    "pkg/aliased.py": [
      "from pkg.module import target as alias",
      "",
      "def caller():",
      "    return alias()",
      "",
    ].join("\n"),
    "pkg/qualified.py": [
      "import pkg.module as module",
      "",
      "def caller():",
      "    return module.target()",
      "",
    ].join("\n"),
  }, (repoRoot, db) => {
    for (const caller of ["pkg/plain.py::caller", "pkg/aliased.py::caller", "pkg/qualified.py::caller"]) {
      requireOneHopCall(db, repoRoot, caller, "pkg/module.py::target");
    }
  });
});

test("duplicate short names never connect a caller to an arbitrary same-name symbol", async () => {
  await withPythonRepo({
    "pkg/__init__.py": "",
    "pkg/left.py": [
      "def map_two_species():",
      "    return 'left'",
      "",
      "def caller():",
      "    return map_two_species()",
      "",
    ].join("\n"),
    "pkg/right.py": [
      "def map_two_species():",
      "    return 'right'",
      "",
    ].join("\n"),
  }, (repoRoot, db) => {
    // The caller resolves to its own module's definition...
    requireOneHopCall(db, repoRoot, "pkg/left.py::caller", "pkg/left.py::map_two_species");
    // ...and never to the identically named symbol in the other module.
    assert.equal(hasDirectCallEdge(db, "pkg/left.py::caller", "pkg/right.py::map_two_species"), false);

    const crossModule = searchLogicFlow(db, {
      start: "pkg/left.py::caller",
      end: "pkg/right.py::map_two_species",
      maxPaths: 4,
    }, { repoRoot });
    assert.equal(crossModule.ok, true);
    if (crossModule.ok) {
      assert.equal(crossModule.output.summary.reachable, false);
    }
  });
});

test("an ambiguous short name is an explicit diagnostic, never a silent pick", async () => {
  await withPythonRepo({
    "pkg/__init__.py": "",
    "pkg/left.py": "def shared():\n    return 1\n",
    "pkg/right.py": "def shared():\n    return 2\n",
  }, (repoRoot, db) => {
    // A bare short name is not an indexed FQN, so resolution fails explicitly.
    const shortName = searchLogicFlow(db, { start: "shared", end: "pkg/right.py::shared", maxPaths: 2 }, { repoRoot });
    assert.equal(shortName.ok, false);
    if (!shortName.ok) {
      assert.equal(shortName.error.code, LOGIC_FLOW_ERROR_CODE.UnknownStart);
      assert.equal(shortName.error.details.resolutionMode, "exact_fqn");
    }

    // The unambiguous exact FQN of each same-named symbol resolves on its own.
    for (const fqName of ["pkg/left.py::shared", "pkg/right.py::shared"]) {
      const exact = searchLogicFlow(db, { start: fqName, end: fqName, maxPaths: 2 }, { repoRoot });
      assert.equal(exact.ok, true, `expected exact FQN ${fqName} to resolve`);
    }
  });
});

test("calls are owned by the enclosing method, not merely by the module", async () => {
  await withPythonRepo({
    "pkg/nested.py": [
      "def target():",
      "    return 1",
      "",
      "class Holder:",
      "    def method(self):",
      "        return target()",
      "",
      "def free_function():",
      "    return 2",
      "",
    ].join("\n"),
  }, (repoRoot, db) => {
    assert.equal(hasDirectCallEdge(db, "pkg/nested.py::Holder.method", "pkg/nested.py::target"), true);
    // Ownership is precise: a sibling function that never calls target has no edge.
    assert.equal(hasDirectCallEdge(db, "pkg/nested.py::free_function", "pkg/nested.py::target"), false);
    requireOneHopCall(db, repoRoot, "pkg/nested.py::Holder.method", "pkg/nested.py::target");
  });
});

test("the traversal budget bounds work, never which edges exist", async () => {
  // The M130 defect in miniature: enough call edges that a small bound would have
  // sliced the target edge out of the graph entirely.
  const modules: Record<string, string> = {};
  for (let index = 0; index < 40; index += 1) {
    modules[`pkg/filler_${index}.py`] = [
      `def filler_target_${index}():`,
      "    return 1",
      "",
      `def filler_caller_${index}():`,
      `    return filler_target_${index}()`,
      "",
    ].join("\n");
  }
  modules["pkg/zz_last.py"] = [
    "def target():",
    "    return 1",
    "",
    "def caller():",
    "    return target()",
    "",
  ].join("\n");

  await withPythonRepo(modules, (repoRoot, db) => {
    const totalEdges = listAllEdges(db).length;
    assert.ok(totalEdges > 20, `fixture should exceed the tiny bound, saw ${totalEdges}`);

    // The default budget sees the whole graph.
    requireOneHopCall(db, repoRoot, "pkg/zz_last.py::caller", "pkg/zz_last.py::target");

    // A deliberately tiny budget may fail to FIND the path, but it must say so
    // rather than reporting a clean negative.
    const starved = searchLogicFlow(db, {
      start: "pkg/zz_last.py::caller",
      end: "pkg/zz_last.py::target",
      maxPaths: 2,
      maxEdges: 1,
    }, { repoRoot });
    assert.equal(starved.ok, true);
    if (starved.ok && !starved.output.summary.reachable) {
      assert.equal(starved.output.summary.traversalLimitReached, true);
      assert.equal(starved.output.diagnostics.traversalLimitReached, true);
      assert.ok(starved.output.diagnostics.edgesAvailable > starved.output.diagnostics.edgesInspected);
    }
  });
});

test("full, incremental and no-op refreshes agree on the direct edge and the flow", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m130-incremental-"));
  const db = openIndexerDatabase();
  try {
    await mkdir(path.join(repoRoot, "pkg"), { recursive: true });
    const modulePath = path.join(repoRoot, "pkg", "mod.py");
    await writeFile(modulePath, "def target():\n    return 1\n", "utf8");
    let snapshot = (await indexProject({ repoRoot, db, refreshMode: "full" })).snapshot;

    const flowSnapshot = () => {
      const result = searchLogicFlow(db, {
        start: "pkg/mod.py::caller",
        end: "pkg/mod.py::target",
        maxPaths: 4,
      }, { repoRoot });
      return {
        edge: hasDirectCallEdge(db, "pkg/mod.py::caller", "pkg/mod.py::target"),
        reachable: result.ok && result.output.summary.reachable,
        edgeCount: result.ok ? result.output.summary.shortestPathEdgeCount : null,
      };
    };

    // Add the caller and refresh incrementally.
    await writeFile(modulePath, "def target():\n    return 1\n\ndef caller():\n    return target()\n", "utf8");
    snapshot = (await indexProject({
      repoRoot,
      db,
      refreshMode: "incremental",
      ...(snapshot === undefined ? {} : { previousSnapshot: snapshot }),
    })).snapshot;
    const afterIncremental = flowSnapshot();
    assert.deepEqual(afterIncremental, { edge: true, reachable: true, edgeCount: 1 });

    // A no-op refresh changes nothing.
    await indexProject({
      repoRoot,
      db,
      refreshMode: "incremental",
      ...(snapshot === undefined ? {} : { previousSnapshot: snapshot }),
    });
    assert.deepEqual(flowSnapshot(), afterIncremental);

    // A full rebuild of the same tree agrees with both.
    const fullDb = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db: fullDb, refreshMode: "full" });
      const fullResult = searchLogicFlow(fullDb, {
        start: "pkg/mod.py::caller",
        end: "pkg/mod.py::target",
        maxPaths: 4,
      }, { repoRoot });
      assert.deepEqual({
        edge: hasDirectCallEdge(fullDb, "pkg/mod.py::caller", "pkg/mod.py::target"),
        reachable: fullResult.ok && fullResult.output.summary.reachable,
        edgeCount: fullResult.ok ? fullResult.output.summary.shortestPathEdgeCount : null,
      }, afterIncremental);
    } finally {
      fullDb.close();
    }
  } finally {
    db.close();
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("the call-site excerpt covers the call, not just the caller's opening lines", async () => {
  const padding = Array.from({ length: 30 }, (_, index) => `    filler_${index} = ${index}`).join("\n");
  await withPythonRepo({
    "pkg/wide.py": [
      "def target():",
      "    return 1",
      "",
      "def caller():",
      '    """A caller whose body is longer than the excerpt budget."""',
      padding,
      "    return target()",
      "",
    ].join("\n"),
  }, (repoRoot, db) => {
    const result = searchLogicFlow(db, {
      start: "pkg/wide.py::caller",
      end: "pkg/wide.py::target",
      maxPaths: 2,
    }, { repoRoot });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const excerpt = result.output.paths[0]?.steps[0]?.sourceExcerpt;
    assert.ok(excerpt != null, "expected an inline excerpt for the edge source");
    assert.ok(
      excerpt.text.includes("return target()"),
      `expected the excerpt to contain the call site, got lines ${excerpt.startLine}-${excerpt.endLine}`,
    );
    assert.equal(excerpt.reason, "edge_site");
  });
});
