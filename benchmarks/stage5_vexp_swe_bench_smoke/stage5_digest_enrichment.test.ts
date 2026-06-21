// M56B: DB-backed Stage 5 digest enrichment (Strategy A). Proves the Stage 5 parent
// can compute a REAL impact seam from the workspace index using the capsule pivot's
// fq_name — and is honest (null) about rules/memory on a fresh index that carries no
// rule/observation store. No live agents, no Docker, no subprocess.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { indexProject } from "../../src/indexer/indexProject";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import {
  buildStage5DigestEnrichments,
  buildStage5DigestEnrichmentsBestEffort,
} from "./run_stage5_vexp_swe_bench_smoke";

// base <- alpha <- beta (imports): base has two real reverse dependents.
async function withIndexedFixture(
  run: (ctx: { db: ReturnType<typeof openIndexerDatabase>; repoRoot: string; dbPath: string }) => void | Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-m56b-"));
  const repoRoot = path.join(root, "repo");
  const db = openIndexerDatabase();
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "base.ts"), 'export function base(): string {\n  return "base";\n}\n');
    await writeFile(path.join(repoRoot, "src", "alpha.ts"), 'import { base } from "./base";\nexport function alpha(): string {\n  return base();\n}\n');
    await writeFile(path.join(repoRoot, "src", "beta.ts"), 'import { alpha } from "./alpha";\nexport function beta(): string {\n  return alpha();\n}\n');
    await indexProject({ repoRoot, db });
    await run({ db, repoRoot, dbPath: path.join(repoRoot, ".vtrace", "index.sqlite") });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("M56B: buildStage5DigestEnrichments computes a real impact seam from the index", async () => {
  await withIndexedFixture(({ db, repoRoot }) => {
    const result = buildCapsuleV2({
      db,
      repoRoot,
      task: "refactor the base function in src/base.ts",
      intent: CapsuleIntent.Refactor,
      maxTokens: 8_000,
    });
    // The capsule must surface base (or a base-bearing pivot) for impact to resolve.
    const hasBasePivot = result.pivots.some((p) => p.fq_name.includes("base"));
    assert.ok(hasBasePivot, "expected base to be a pivot for this task");

    const enrich = buildStage5DigestEnrichments({
      db,
      repoRoot,
      query: "refactor the base function in src/base.ts",
      result,
      intent: "modify",
    });

    // Impact is REAL: base has reverse dependents (alpha + beta) in the index.
    assert.ok(enrich.impact, "impact seam should be present");
    assert.ok((enrich.impact?.dependentCount ?? 0) >= 1);
    assert.equal(enrich.impact?.available, true);
    assert.ok((enrich.impact?.representative?.length ?? 0) >= 1);

    // A fresh SWE-bench-style workspace index has no rule or observation store, so
    // those sections are honestly null (their warnings stay) — never fabricated.
    assert.equal(enrich.rules, null);
    assert.equal(enrich.memory, null);
  });
});

test("M56B: enrichments fold into an injectable digest that drops the impact warning", async () => {
  const { buildInjectedCapsuleV2DigestBlock } = await import("./run_stage5_vexp_swe_bench_smoke");
  await withIndexedFixture(({ db, repoRoot }) => {
    const result = buildCapsuleV2({
      db,
      repoRoot,
      task: "refactor the base function in src/base.ts",
      intent: CapsuleIntent.Refactor,
      maxTokens: 8_000,
    });
    const enrich = buildStage5DigestEnrichments({ db, repoRoot, query: "refactor base", result, intent: "modify" });
    const block = buildInjectedCapsuleV2DigestBlock(result, "modify base", enrich);
    // Real impact section present; impact warning dropped; rules/memory still honest.
    assert.match(block, /→ impact \d+ dependents/);
    assert.doesNotMatch(block, /impact_not_threaded_into_digest/);
    assert.match(block, /memory_not_threaded_into_digest/);
    assert.match(block, /rules_not_threaded_into_digest/);
  });
});

test("M56B: best-effort wrapper degrades to {} on a missing index (never throws)", () => {
  const enrich = buildStage5DigestEnrichmentsBestEffort({
    dbPath: "/nonexistent/path/.vtrace/index.sqlite",
    repoRoot: "/nonexistent",
    query: "q",
    result: { pivots: [], support: [], actual_mode: "no_context" } as never,
    intent: "auto",
    // Force the open to throw so we exercise the degrade-to-{} path deterministically.
    openDatabase: () => {
      throw new Error("synthetic open failure");
    },
  });
  assert.deepEqual(enrich, {});
});
