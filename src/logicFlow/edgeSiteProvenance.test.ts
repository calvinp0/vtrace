// M131 edge-site provenance suite.
//
// M130 attached a call-site excerpt by scanning the caller's body for the first
// textual occurrence of the callee's name and labelling the result `edge_site`.
// That produces the right relationship with the wrong evidence whenever a caller
// mentions the callee more than once — and there is no way for a reader to tell.
//
// M131 records every occurrence the parser saw, alongside the edge. These tests
// pin the three states the product must distinguish: exact recorded provenance,
// an honestly-labelled scan when no provenance was recorded, and no located
// occurrence at all.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { listAllEdges, listCallSitesForEdges } from "../db/repositories/edgesRepository";
import { listSymbolsByFqName } from "../db/repositories/symbolsRepository";
import { EdgeType } from "../domain/types";
import { searchLogicFlow, type LogicFlowStep } from "./searchLogicFlow";

async function withPythonRepo<T>(
  files: Readonly<Record<string, string>>,
  run: (repoRoot: string, db: Database) => Promise<T> | T,
): Promise<T> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m131-site-"));
  const db = openIndexerDatabase();
  try {
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(repoRoot, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }
    await indexProject({ repoRoot, db });
    return await run(repoRoot, db);
  } finally {
    db.close();
    await rm(repoRoot, { recursive: true, force: true });
  }
}

function firstStep(db: Database, repoRoot: string, start: string, end: string): LogicFlowStep {
  const result = searchLogicFlow(db, { start, end, maxPaths: 3 }, { repoRoot });
  assert.equal(result.ok, true);
  if (result.ok === false) throw new Error(result.error.message);
  const step = result.output.paths[0]?.steps[0];
  assert.ok(step !== undefined, `expected a path ${start} -> ${end}`);
  return step;
}

// A caller that names the callee three times: twice in text that is not the call
// the parser resolved, then the real invocation. A first-occurrence scan lands on
// line 6; the parser recorded line 8.
const DECOY_MODULE = [
  "def target(value):",
  "    return value",
  "",
  "",
  "def caller(value):",
  '    note = "target(value) is documented here"',
  "    # target(value) is mentioned here too",
  "    return target(value)",
  "",
].join("\n");

test("flow evidence uses the parser-recorded call site, not the first textual match", async () => {
  await withPythonRepo({ "pkg/mod.py": DECOY_MODULE }, (repoRoot, db) => {
    const step = firstStep(db, repoRoot, "pkg/mod.py::caller", "pkg/mod.py::target");

    assert.equal(step.edgeType, EdgeType.Calls);
    assert.equal(step.relation?.evidence.locationKind, "edge_site");
    assert.deepEqual(step.relation?.source.lineSpan, { start: 8, end: 8 });
    assert.equal(step.relation?.evidence.callSiteCount, 1);
    assert.deepEqual(step.relation?.evidence.callSites, [
      { startLine: 8, endLine: 8, precision: "span" },
    ]);
    assert.equal(step.relation?.evidence.sourceText, "return target(value)");
  });
});

test("every call site of a repeated relation is recorded and reported", async () => {
  const repeated = [
    "def target(value):",
    "    return value",
    "",
    "",
    "def caller(a, b, c):",
    "    first = target(a)",
    "    middle = a + b",
    "    second = target(b)",
    "    tail = middle + 1",
    "    third = target(c)",
    "    return first + second + third + tail",
    "",
  ].join("\n");

  await withPythonRepo({ "pkg/mod.py": repeated }, (repoRoot, db) => {
    const step = firstStep(db, repoRoot, "pkg/mod.py::caller", "pkg/mod.py::target");

    assert.equal(step.relation?.evidence.locationKind, "edge_site");
    assert.equal(step.relation?.evidence.callSiteCount, 3);
    assert.deepEqual(
      step.relation?.evidence.callSites?.map((site) => site.startLine),
      [6, 8, 10],
    );
    // The representative site is the first, and the result says so rather than
    // implying that one site is the whole relationship.
    assert.deepEqual(step.relation?.source.lineSpan, { start: 6, end: 6 });
    assert.equal(
      step.relation?.limitations.some((limitation) => limitation.includes("observed at 3 call sites")),
      true,
    );
  });
});

test("the graph deduplicates the relation but keeps one edge per caller pair", async () => {
  const repeated = [
    "def target(value):",
    "    return value",
    "",
    "",
    "def caller(a, b):",
    "    return target(a) + target(b)",
    "",
  ].join("\n");

  await withPythonRepo({ "pkg/mod.py": repeated }, (_repoRoot, db) => {
    const caller = listSymbolsByFqName(db, "pkg/mod.py::caller")[0]!;
    const target = listSymbolsByFqName(db, "pkg/mod.py::target")[0]!;
    const callEdges = listAllEdges(db).filter((edge) =>
      edge.edgeType === EdgeType.Calls
      && edge.srcSymbolId === caller.id
      && edge.dstSymbolId === target.id);

    assert.equal(callEdges.length, 1, "one (caller, callee) pair is one edge");
    const sites = listCallSitesForEdges(db, [callEdges[0]!.id]).get(callEdges[0]!.id) ?? [];
    assert.equal(sites.length, 2, "both occurrences survive the edge deduplication");
    assert.deepEqual(sites.map((site) => site.startLine), [6, 6]);
    assert.equal(sites[0]!.startColumn < sites[1]!.startColumn, true);
  });
});

test("an index without recorded call sites degrades to a labelled scan, never to edge_site", async () => {
  await withPythonRepo({ "pkg/mod.py": DECOY_MODULE }, (repoRoot, db) => {
    // Simulate an index written before occurrence capture existed.
    db.run("DELETE FROM edge_call_sites");

    const step = firstStep(db, repoRoot, "pkg/mod.py::caller", "pkg/mod.py::target");

    assert.equal(step.relation?.evidence.locationKind, "caller_span_scan");
    assert.equal(step.relation?.evidence.callSites, undefined);
    assert.equal(step.relation?.evidence.callSiteCount, undefined);
    assert.equal(
      step.relation?.limitations.some((limitation) =>
        limitation.includes("not proof that this occurrence produced the edge")),
      true,
    );
    assert.notEqual(step.sourceExcerpt?.reason, "edge_site");
  });
});

test("an index written before occurrence capture still answers, read-only", async () => {
  await withPythonRepo({ "pkg/mod.py": DECOY_MODULE }, (repoRoot, db) => {
    // Exactly what a pre-M131 index looks like: the table does not exist, and a
    // read-only consumer cannot create it. Flow must degrade, not throw.
    db.run("DROP TABLE edge_call_sites");

    const step = firstStep(db, repoRoot, "pkg/mod.py::caller", "pkg/mod.py::target");

    assert.equal(step.edgeType, EdgeType.Calls);
    assert.equal(step.relation?.evidence.locationKind, "caller_span_scan");
    assert.deepEqual(listCallSitesForEdges(db, [step.edgeId]), new Map());
  });
});

test("a call site outside the caller's indexed span is refused rather than reported", async () => {
  await withPythonRepo({ "pkg/mod.py": DECOY_MODULE }, (repoRoot, db) => {
    // A stale row, as if the file changed under a partially refreshed index.
    db.run("UPDATE edge_call_sites SET start_line = 9000, end_line = 9000");

    const step = firstStep(db, repoRoot, "pkg/mod.py::caller", "pkg/mod.py::target");

    assert.notEqual(step.relation?.evidence.locationKind, "edge_site");
    assert.equal(step.relation?.evidence.callSites, undefined);
  });
});

test("full, incremental, and no-op refreshes agree on edge-site provenance", async () => {
  const files = {
    "pkg/mod.py": DECOY_MODULE,
    "pkg/other.py": "def unrelated():\n    return 1\n",
  };

  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m131-refresh-"));
  const full = openIndexerDatabase();
  const incremental = openIndexerDatabase();
  const noop = openIndexerDatabase();

  try {
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(repoRoot, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }

    const fullRun = await indexProject({ repoRoot, db: full, refreshMode: "full" });
    await indexProject({ repoRoot, db: incremental });
    await indexProject({
      repoRoot,
      db: incremental,
      refreshMode: "incremental",
      previousSnapshot: fullRun.snapshot,
    });
    await indexProject({ repoRoot, db: noop });
    await indexProject({ repoRoot, db: noop, refreshMode: "incremental", previousSnapshot: fullRun.snapshot });
    await indexProject({ repoRoot, db: noop, refreshMode: "incremental", previousSnapshot: fullRun.snapshot });

    const shape = (db: Database): unknown => {
      const step = firstStep(db, repoRoot, "pkg/mod.py::caller", "pkg/mod.py::target");
      return {
        edgeType: step.edgeType,
        locationKind: step.relation?.evidence.locationKind,
        lineSpan: step.relation?.source.lineSpan,
        callSites: step.relation?.evidence.callSites,
        excerpt: [step.sourceExcerpt?.startLine, step.sourceExcerpt?.endLine, step.sourceExcerpt?.reason],
      };
    };

    assert.deepEqual(shape(incremental), shape(full));
    assert.deepEqual(shape(noop), shape(full));

    // Adding an unrelated file incrementally must not move the established result.
    await writeFile(path.join(repoRoot, "pkg", "added.py"), "def added():\n    return 2\n", "utf8");
    const before = shape(full);
    await indexProject({ repoRoot, db: full, refreshMode: "incremental", previousSnapshot: fullRun.snapshot });
    assert.deepEqual(shape(full), before);
  } finally {
    full.close();
    incremental.close();
    noop.close();
    await rm(repoRoot, { recursive: true, force: true });
  }
});
