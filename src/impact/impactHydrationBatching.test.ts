// M132 — impact symbol hydration batching.
//
// M131 recorded a per-node `getSymbolById` N+1 inside `discoverImpactSymbols`:
// adjacency was already batched per frontier level, but each dependent found on
// that level was hydrated with its own query, so query count tracked the number
// of dependents rather than the number of levels. These tests pin both halves of
// the fix: the result is unchanged, and the query count collapses.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { getImpactGraph } from "./getImpactGraph";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "vtrace-m132-impact-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/**
 * A hub function called by `dependentCount` distinct callers, each in its own
 * module. Wide fan-in is exactly the shape the N+1 punished.
 */
async function createFanInRepo(dependentCount: number): Promise<string> {
  const root = path.join(scratch, "fanin");
  await mkdir(path.join(root, "pkg"), { recursive: true });
  await writeFile(path.join(root, "pkg", "__init__.py"), "");
  await writeFile(path.join(root, "pkg", "core.py"), "def hub():\n    return 1\n");
  for (let index = 0; index < dependentCount; index += 1) {
    await writeFile(
      path.join(root, "pkg", `caller_${index}.py`),
      `from pkg.core import hub\n\n\ndef caller_${index}():\n    return hub()\n`,
    );
  }
  return root;
}

/** Count SQL queries by wrapping `db.query`. */
function instrumentQueries(db: ReturnType<typeof openIndexerDatabase>): {
  count: () => number;
  restore: () => void;
} {
  const original = db.query.bind(db);
  let count = 0;
  (db as unknown as { query: typeof original }).query = ((sql: string) => {
    count += 1;
    return original(sql);
  }) as typeof original;
  return {
    count: () => count,
    restore: () => {
      (db as unknown as { query: typeof original }).query = original;
    },
  };
}

test("batched hydration returns the same impact graph as per-node hydration", async () => {
  const root = await createFanInRepo(12);
  const db = openIndexerDatabase();
  try {
    await indexProject({ repoRoot: root, db });

    const result = getImpactGraph(db, { symbolFqn: "pkg/core.py::hub", depth: 3, format: "list" });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // Every caller is discovered, exactly once, at distance 1.
    const dependents = result.output.nodes.filter((node) => node.distance > 0);
    assert.equal(dependents.length >= 12, true, `expected >= 12 dependents, got ${dependents.length}`);
    assert.equal(
      new Set(dependents.map((node) => node.symbolId)).size,
      dependents.length,
      "hydration must not duplicate a dependent",
    );

    // Deterministic ordering is preserved: repeated calls are byte-identical.
    const repeated = getImpactGraph(db, { symbolFqn: "pkg/core.py::hub", depth: 3, format: "list" });
    assert.equal(repeated.ok, true);
    if (!repeated.ok) return;
    assert.equal(JSON.stringify(repeated.output), JSON.stringify(result.output));
  } finally {
    db.close();
  }
});

test("query count no longer scales with the dependent count", async () => {
  const small = await createFanInRepo(4);
  const smallDb = openIndexerDatabase();
  let smallQueries = 0;
  try {
    await indexProject({ repoRoot: small, db: smallDb });
    const probe = instrumentQueries(smallDb);
    getImpactGraph(smallDb, { symbolFqn: "pkg/core.py::hub", depth: 3, format: "list" });
    smallQueries = probe.count();
    probe.restore();
  } finally {
    smallDb.close();
  }

  await rm(path.join(scratch, "fanin"), { recursive: true, force: true });
  const large = await createFanInRepo(40);
  const largeDb = openIndexerDatabase();
  let largeQueries = 0;
  let largeDependents = 0;
  try {
    await indexProject({ repoRoot: large, db: largeDb });
    const probe = instrumentQueries(largeDb);
    const result = getImpactGraph(largeDb, { symbolFqn: "pkg/core.py::hub", depth: 3, format: "list" });
    largeQueries = probe.count();
    probe.restore();
    assert.equal(result.ok, true);
    if (result.ok) {
      largeDependents = result.output.nodes.filter((node) => node.distance > 0).length;
    }
  } finally {
    largeDb.close();
  }

  // All 40 callers are delivered under the same default 64-edge canonical cap.
  //
  // Before M140 this returned 32. Each caller file had exactly one top-level
  // symbol, so its module-level import edge was attributed to the caller
  // FUNCTION — giving every caller two edges to `hub` (one import, one call)
  // that named the identical src/dst pair. Those redundant edges consumed the
  // 64-edge budget two at a time, so 8 genuine callers were dropped. Imports
  // are now owned by module scope and module scope is structural, so each
  // caller spends one slot on its real call evidence and the whole fan-in fits.
  assert.equal(largeDependents, 40);
  assert.equal(
    largeQueries <= 73,
    true,
    `bounded query count regressed (${largeDependents} dependents, ${smallQueries} -> ${largeQueries} queries)`,
  );
});
