import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import type { CapsuleV2ProductResponse } from "../capsuleV2/productAdapter";
import {
  PIVOT_NEIGHBORHOOD_DEFAULTS,
  buildPivotNeighborhoods,
} from "./pivotNeighborhood";

// A minimal product response carrying only the fields buildPivotNeighborhoods
// reads (pivots/support identity). Cast keeps the test focused without
// reconstructing the full Capsule v2 projection.
function makeResponse(
  pivots: Array<{ path: string; symbol: string; fqName: string }>,
  support: Array<{ path: string; symbol: string; fqName: string }> = [],
): CapsuleV2ProductResponse {
  return { pivots, support } as unknown as CapsuleV2ProductResponse;
}

test("pivot neighborhood surfaces caller/importer excerpts for a resolved pivot", async () => {
  await withFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const contexts = buildPivotNeighborhoods(
        db,
        repoRoot,
        makeResponse([{ path: "src/base.ts", symbol: "base", fqName: "src/base.ts::base" }]),
      );

      assert.equal(contexts.length, 1);
      const ctx = contexts[0]!;
      assert.equal(ctx.pivot.fqName, "src/base.ts::base");
      assert.ok(ctx.excerpts.length > 0, "expected at least one neighbor excerpt");

      // A caller (caller1, which calls base) must be reachable, and its excerpt
      // points at the caller file, not the pivot.
      const caller = ctx.excerpts.find((e) => e.fqName === "src/caller1.ts::caller1");
      assert.ok(caller, "expected caller1 as a neighbor");
      assert.ok(["caller", "importer"].includes(caller.reason));
      assert.equal(caller.filePath, "src/caller1.ts");
      assert.ok(caller.text.includes("caller1"));

      // Bounds: no excerpt exceeds the line ceiling.
      for (const e of ctx.excerpts) {
        assert.ok(e.text.split("\n").length <= 12, "excerpt must respect the 12-line ceiling");
      }
    } finally {
      db.close();
    }
  });
});

test("max pivots and max excerpts per pivot are enforced", async () => {
  await withFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const contexts = buildPivotNeighborhoods(
        db,
        repoRoot,
        makeResponse([
          { path: "src/base.ts", symbol: "base", fqName: "src/base.ts::base" },
          { path: "src/caller1.ts", symbol: "caller1", fqName: "src/caller1.ts::caller1" },
          { path: "src/caller2.ts", symbol: "caller2", fqName: "src/caller2.ts::caller2" },
        ]),
      );

      // Only the top 2 pivots are seeded.
      assert.equal(contexts.length, PIVOT_NEIGHBORHOOD_DEFAULTS.maxPivots);

      // base has >4 neighbors (5 callers + same-file fallbacks); excerpts are capped.
      const baseCtx = contexts.find((c) => c.pivot.fqName === "src/base.ts::base")!;
      assert.ok(
        baseCtx.excerpts.length <= PIVOT_NEIGHBORHOOD_DEFAULTS.maxExcerptsPerPivot,
        "per-pivot excerpt budget must be enforced",
      );
    } finally {
      db.close();
    }
  });
});

test("an unresolved pivot symbol yields a skipped marker, not a failure", async () => {
  await withFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const contexts = buildPivotNeighborhoods(
        db,
        repoRoot,
        makeResponse([{ path: "src/ghost.ts", symbol: "ghost", fqName: "src/ghost.ts::ghost" }]),
      );

      assert.equal(contexts.length, 1);
      assert.equal(contexts[0]!.excerpts.length, 0);
      assert.deepEqual(contexts[0]!.skipped, [
        { target: "src/ghost.ts::ghost", reason: "pivot_symbol_unresolved" },
      ]);
    } finally {
      db.close();
    }
  });
});

test("stale source degrades neighbors to skipped without failing", async () => {
  await withFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      // Drift every caller file after indexing; the freshness gate must reject
      // their source so neighbors become skipped rather than throwing.
      for (let i = 1; i <= 5; i += 1) {
        await writeFile(path.join(repoRoot, "src", `caller${i}.ts`), "// drifted after index\n");
      }

      const contexts = buildPivotNeighborhoods(
        db,
        repoRoot,
        makeResponse([{ path: "src/base.ts", symbol: "base", fqName: "src/base.ts::base" }]),
      );

      assert.equal(contexts.length, 1);
      const ctx = contexts[0]!;
      // base.ts itself is unchanged, so same-file fallback neighbors (if any) can
      // still resolve; the drifted callers must be recorded as skipped.
      assert.ok((ctx.skipped ?? []).some((s) => s.reason === "source_unavailable"));
    } finally {
      db.close();
    }
  });
});

test("output is deterministic across repeated builds", async () => {
  await withFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const response = makeResponse([{ path: "src/base.ts", symbol: "base", fqName: "src/base.ts::base" }]);
      const first = buildPivotNeighborhoods(db, repoRoot, response);
      const second = buildPivotNeighborhoods(db, repoRoot, response);
      assert.deepEqual(second, first);
    } finally {
      db.close();
    }
  });
});

test("no pivots yields an empty section", async () => {
  await withFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const contexts = buildPivotNeighborhoods(db, repoRoot, makeResponse([]));
      assert.deepEqual(contexts, []);
    } finally {
      db.close();
    }
  });
});

async function withFixture(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-pivot-nbhd-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "base.ts"),
      ["export function base(): string {", "  return \"base\";", "}", ""].join("\n"),
    );
    // Five callers, each importing and calling base() -> base has 5 callers.
    for (let i = 1; i <= 5; i += 1) {
      await writeFile(
        path.join(repoRoot, "src", `caller${i}.ts`),
        [
          "import { base } from \"./base\";",
          "",
          `export function caller${i}(): string {`,
          "  return base();",
          "}",
          "",
        ].join("\n"),
      );
    }
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
