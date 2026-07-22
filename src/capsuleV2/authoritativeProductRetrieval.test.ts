import assert from "node:assert/strict";
import { test } from "bun:test";

import { RunPipelinePresetIntent } from "../runPipeline/types";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import { buildAuthoritativeProductRetrieval } from "./authoritativeProductRetrieval";
import { CapsuleIntent } from "./types";
import { INLINES_TASK, seedCapsuleV2Fixture } from "./__fixtures__/capsuleV2Fixture";

test("authoritative adapter preserves Capsule v2 selection, roles, and lead pivot", () => {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  try {
    const expected = buildCapsuleV2({
      db,
      repoRoot,
      task: INLINES_TASK,
      intent: CapsuleIntent.Debug,
      maxTokens: 8_000,
    });
    const actual = buildAuthoritativeProductRetrieval(db, repoRoot, {
      query: INLINES_TASK,
      preset: RunPipelinePresetIntent.Debug,
      maxBudgetCharacters: 32_000,
    });

    assert.equal(actual.version, "product-retrieval-v2");
    assert.deepEqual(
      actual.capsule.pivots.map((item) => item.filePath),
      expected.pivots.map((item) => item.path),
    );
    assert.deepEqual(
      actual.capsule.supportingItems.map((item) => item.filePath),
      expected.support.map((item) => item.path),
    );
    assert.equal(actual.capsule.pivots[0]?.localName, expected.pivots[0]?.symbol);
    assert.ok(actual.capsule.budget.usedCharacters <= 32_000);
  } finally {
    db.close();
  }
});

test("candidate score diagnostics are deterministic and reproduce final scores", () => {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  try {
    const build = () => buildAuthoritativeProductRetrieval(db, repoRoot, {
      query: INLINES_TASK,
      preset: RunPipelinePresetIntent.Debug,
      maxBudgetCharacters: 32_000,
    }).result.diagnostics.candidate_scores;
    const first = build();
    const second = build();
    assert.deepEqual(first, second);
    assert.ok((first?.length ?? 0) > 0);
    for (const row of first ?? []) {
      assert.ok(row.rank >= 1);
      assert.ok(Number.isFinite(row.scores.final));
      assert.ok(row.sources.length > 0);
    }
  } finally {
    db.close();
  }
});
