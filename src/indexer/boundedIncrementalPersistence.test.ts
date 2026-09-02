/**
 * M199. An incremental refresh must write the changed closure and nothing else,
 * and it must still produce the graph a cold build produces.
 *
 * These are the seams the bounded path introduced, so they are the ones a future
 * change can silently break:
 *
 *   - the untouched majority of the graph is no longer rewritten, so a stale row
 *     that the wholesale DELETE used to sweep away now survives;
 *   - an edge pointing INTO a changed file is owned by the file at its other
 *     end, which the refresh does not re-persist;
 *   - a changed file that stops parsing contributes no result, and the graph
 *     must not keep the rows it had;
 *   - M184's materialization recovery keeps an incremental plan while the graph
 *     is missing, and must still write all of it.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";

import { EdgeType } from "../domain/types";
import { openIndexerDatabase } from "../db/sqlite";
import { listAllEdges } from "../db/repositories/edgesRepository";
import { listAllSymbols, listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { getFileByPath } from "../db/repositories/filesRepository";
import { normalizedGraphHash } from "./normalizedGraph";
import { indexProject } from "./indexProject";

/**
 * Row writes counted by trigger rather than by the product, because a product
 * counter is exactly what an unbounded implementation would keep reporting
 * correctly while writing the whole graph.
 */
const COUNTED_TABLES = ["files", "symbols", "edges", "edge_call_sites", "symbol_mechanism_facts"] as const;

function installRowCounters(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS _m199_writes (n INTEGER NOT NULL)");
  for (const table of COUNTED_TABLES) {
    for (const [op, timing] of [["ins", "INSERT"], ["del", "DELETE"], ["upd", "UPDATE"]] as const) {
      db.run(`CREATE TRIGGER IF NOT EXISTS _m199_${table}_${op} AFTER ${timing} ON ${table}
        BEGIN INSERT INTO _m199_writes (n) VALUES (1); END`);
    }
  }
}

function takeRowWrites(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS c FROM _m199_writes").get() as { c: number };
  db.run("DELETE FROM _m199_writes");
  return row.c;
}

async function withFixture(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m199-"));
  try {
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

/**
 * One imported definition, one importer, and enough unrelated files that a
 * wholesale rewrite is distinguishable from a bounded one by row count alone.
 */
async function writeRepo(repoRoot: string, bystanders = 12): Promise<void> {
  await mkdir(path.join(repoRoot, "pkg"), { recursive: true });
  // Present so `from pkg.target import ...` resolves: without a package surface
  // the parser emits no cross-file edge and the inbound-edge test would pass by
  // having nothing to preserve.
  await writeFile(path.join(repoRoot, "pkg", "__init__.py"), "");
  await writeFile(
    path.join(repoRoot, "pkg", "target.py"),
    ["def target():", "    return 0", "", "", "def also_target():", "    return 1", ""].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "pkg", "caller.py"),
    ["from pkg.target import target", "", "", "def call_it():", "    return target()", ""].join("\n"),
  );
  for (let i = 0; i < bystanders; i += 1) {
    await writeFile(
      path.join(repoRoot, "pkg", `bystander_${i}.py`),
      [`def bystander_${i}():`, `    return ${i}`, "", "", `class Holder${i}:`,
       "    def method(self):", "        return 1", ""].join("\n"),
    );
  }
}

/** Cold index, then one no-op, leaving a snapshot an incremental refresh can use. */
async function primeIndex(repoRoot: string, db: Database) {
  const cold: any = await indexProject({ repoRoot, db });
  const noop: any = await indexProject({
    repoRoot, db, previousSnapshot: cold.snapshot, hasExistingGraph: true,
  });
  return noop.snapshot ?? cold.snapshot;
}

test("M199: a one-file refresh writes the changed file's rows, not the repository's", async () => {
  await withFixture(async (repoRoot) => {
    await writeRepo(repoRoot);
    const db = openIndexerDatabase();
    try {
      const snapshot = await primeIndex(repoRoot, db);
      const graphRows = listAllSymbols(db).length + listAllEdges(db).length;
      installRowCounters(db);
      takeRowWrites(db);

      await writeFile(
        path.join(repoRoot, "pkg", "bystander_0.py"),
        ["def bystander_0():", "    return 99", "", "", "class Holder0:",
         "    def method(self):", "        return 1", ""].join("\n"),
      );
      const refreshed: any = await indexProject({
        repoRoot, db, previousSnapshot: snapshot, hasExistingGraph: true,
      });
      const written = takeRowWrites(db);

      assert.equal(refreshed.performance.mode, "incremental");
      // The changed file holds a handful of symbols and edges; the graph holds
      // an order of magnitude more. A wholesale rewrite writes 2x the graph.
      const changedFileRows = listSymbolsForFile(db, "pkg/bystander_0.py").length;
      assert.ok(changedFileRows > 0);
      assert.ok(
        written < graphRows,
        `refresh wrote ${written} rows for a file holding ${changedFileRows} symbols, `
        + `against a graph of ${graphRows} rows`,
      );
    } finally { db.close(); }
  });
});

test("M199: a no-op refresh writes no semantic rows at all", async () => {
  await withFixture(async (repoRoot) => {
    await writeRepo(repoRoot);
    const db = openIndexerDatabase();
    try {
      const snapshot = await primeIndex(repoRoot, db);
      installRowCounters(db);
      takeRowWrites(db);

      const result: any = await indexProject({
        repoRoot, db, previousSnapshot: snapshot, hasExistingGraph: true,
      });

      assert.equal(result.performance.mode, "noop");
      assert.equal(takeRowWrites(db), 0);
    } finally { db.close(); }
  });
});

test("M199: an edge pointing into a changed file survives the refresh resolved", async () => {
  await withFixture(async (repoRoot) => {
    await writeRepo(repoRoot);
    const db = openIndexerDatabase();
    try {
      const snapshot = await primeIndex(repoRoot, db);
      const importEdgesBefore = listAllEdges(db)
        .filter((edge) => edge.edgeType === EdgeType.Imports).length;
      assert.ok(importEdgesBefore > 0, "fixture must produce a cross-file import edge");

      // Prepend a line so every symbol in the target file moves and takes a new
      // content-derived id. The importer is untouched and is not re-persisted,
      // so its edge can only survive if the refresh repaired it.
      await writeFile(
        path.join(repoRoot, "pkg", "target.py"),
        ["# moved", "def target():", "    return 0", "", "", "def also_target():",
         "    return 1", ""].join("\n"),
      );
      await indexProject({ repoRoot, db, previousSnapshot: snapshot, hasExistingGraph: true });

      const symbolIds = new Set(listAllSymbols(db).map((symbol) => symbol.id));
      const edges = listAllEdges(db);
      assert.equal(
        edges.filter((edge) => edge.edgeType === EdgeType.Imports).length,
        importEdgesBefore,
      );
      const dangling = edges.filter((edge) =>
        !symbolIds.has(edge.srcSymbolId) || !symbolIds.has(edge.dstSymbolId));
      assert.deepEqual(dangling, []);
    } finally { db.close(); }
  });
});

/**
 * The end state, whichever route reaches it: today a newly unparseable file
 * changes the semantic surface and the run falls back to a full rebuild, so this
 * asserts the graph rather than the route. If that fallback is ever narrowed,
 * this is the test that notices the rows it used to sweep away.
 */
test("M199: a changed file that stops parsing leaves no rows behind", async () => {
  await withFixture(async (repoRoot) => {
    await writeRepo(repoRoot);
    const db = openIndexerDatabase();
    try {
      const snapshot = await primeIndex(repoRoot, db);
      assert.ok(listSymbolsForFile(db, "pkg/bystander_1.py").length > 0);

      await writeFile(path.join(repoRoot, "pkg", "bystander_1.py"), "def broken(:\n");
      await indexProject({ repoRoot, db, previousSnapshot: snapshot, hasExistingGraph: true });

      assert.deepEqual(listSymbolsForFile(db, "pkg/bystander_1.py"), []);
      assert.equal(getFileByPath(db, "pkg/bystander_1.py"), undefined);
      const symbolIds = new Set(listAllSymbols(db).map((symbol) => symbol.id));
      assert.deepEqual(
        listAllEdges(db).filter((edge) =>
          !symbolIds.has(edge.srcSymbolId) || !symbolIds.has(edge.dstSymbolId)),
        [],
      );
    } finally { db.close(); }
  });
});

test("M199: the materialization recovery still writes the whole graph", async () => {
  await withFixture(async (repoRoot) => {
    await writeRepo(repoRoot);
    const db = openIndexerDatabase();
    try {
      const snapshot = await primeIndex(repoRoot, db);
      const expected = normalizedGraphHash(db);
      const symbolsBefore = listAllSymbols(db).length;

      // M184's case: the source has not changed and the graph is gone. The plan
      // stays incremental — the parse cache is still valid — but nothing was
      // invalidated, so a scope taken from the change set would write nothing.
      db.run("DELETE FROM symbol_search_fts");
      db.run("DELETE FROM symbol_body_literals_fts");
      db.run("DELETE FROM symbol_mechanism_facts");
      db.run("DELETE FROM edges");
      db.run("DELETE FROM symbols");
      db.run("DELETE FROM files");

      const recovered: any = await indexProject({
        repoRoot, db, previousSnapshot: snapshot, hasExistingGraph: true,
      });

      assert.equal(recovered.performance.mode, "incremental");
      assert.equal(recovered.performance.fallbackReason, "materialization_missing");
      assert.equal(listAllSymbols(db).length, symbolsBefore);
      assert.equal(normalizedGraphHash(db), expected);
    } finally { db.close(); }
  });
});
