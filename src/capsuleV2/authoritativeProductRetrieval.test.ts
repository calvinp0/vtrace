import assert from "node:assert/strict";
import { test } from "bun:test";

import { SymbolKind } from "../domain/types";
import { RunPipelinePresetIntent } from "../runPipeline/types";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import { buildAuthoritativeProductRetrieval } from "./authoritativeProductRetrieval";
import { CapsuleIntent } from "./types";
import {
  INLINES_TASK,
  seedCapsuleV2Fixture,
  seedCustomFixture,
} from "./__fixtures__/capsuleV2Fixture";

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
      [...expected.support.map((item) => item.path), "tests/test_inlines.py"],
    );
    assert.deepEqual(actual.result.diagnostics.routed_rescue, {
      attempted: true,
      trigger: "missing_path",
      missing_clues: ["tests test inlines py"],
      candidates_added: 1,
      selected_candidates_added: 1,
      timing_ms: actual.result.diagnostics.routed_rescue?.timing_ms,
    });
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

test("hybrid-sufficient exact clue skips routed rescue with explicit diagnostics", () => {
  const { db, repoRoot } = seedRescueFixture();
  try {
    const actual = retrieve(db, repoRoot, "Change RecordReproducibilityAssessment");
    assert.deepEqual(actual.result.diagnostics.routed_rescue, {
      attempted: false,
      reason: "authoritative_context_sufficient",
      missing_clues: [],
      candidates_added: 0,
      selected_candidates_added: 0,
      timing_ms: 0,
    });
    assert.equal(actual.routedQuery, null);
  } finally {
    db.close();
  }
});

test("no authoritative candidates trigger bounded routed rescue", () => {
  const { db, repoRoot } = seedRescueFixture();
  try {
    const actual = retrieve(db, repoRoot, "!!!");
    assert.equal(actual.result.diagnostics.routed_rescue?.attempted, true);
    assert.equal(actual.result.diagnostics.routed_rescue?.trigger, "no_candidates");
    assert.ok((actual.result.diagnostics.routed_rescue?.timing_ms ?? -1) >= 0);
  } finally {
    db.close();
  }
});

test("missing exact identifier triggers rescue independently of task length", () => {
  const { db, repoRoot } = seedRescueFixture();
  try {
    const actual = retrieve(
      db,
      repoRoot,
      "Change RecordReproducibilityAssessment and MissingProjectionBuilder",
    );
    assert.equal(actual.result.diagnostics.routed_rescue?.trigger, "missing_exact_identifier");
    assert.deepEqual(actual.result.diagnostics.routed_rescue?.missing_clues, ["missingprojectionbuilder"]);
  } finally {
    db.close();
  }
});

test("standalone missing path triggers rescue while represented path suppresses it", () => {
  const { db, repoRoot } = seedRescueFixture();
  try {
    const missing = retrieve(db, repoRoot, "app/services/missing_projection.py");
    assert.equal(missing.result.diagnostics.routed_rescue?.trigger, "missing_path");

    const represented = retrieve(db, repoRoot, "app/models/reproducibility_assessment.py");
    assert.equal(represented.result.diagnostics.routed_rescue?.attempted, false);
  } finally {
    db.close();
  }
});

test("long compound artifact coverage triggers rescue under the documented threshold", () => {
  const { db, repoRoot } = seedRescueFixture();
  try {
    const task = [
      "Update the exact immutable reproducibility assessment across thermo kinetics statmech transport",
      "and trace assessment models public reference schemas migrations projection builders OpenAPI",
      "tests docs Python client types while preserving supersession behavior and stable summaries",
    ].join(" ");
    const actual = retrieve(db, repoRoot, task);
    assert.equal(actual.result.diagnostics.routed_rescue?.trigger, "low_compound_coverage");
    assert.ok((actual.result.diagnostics.routed_rescue?.missing_clues.length ?? 0) >= 2);
    assert.ok((actual.result.diagnostics.routed_rescue?.candidates_added ?? -1) <= 2);
    assert.equal(
      actual.result.diagnostics.routed_rescue?.candidates_added,
      actual.result.diagnostics.routed_rescue?.selected_candidates_added,
    );
    assert.doesNotMatch(JSON.stringify(actual.result.diagnostics.routed_rescue), /class\s+/);
  } finally {
    db.close();
  }
});

function seedRescueFixture() {
  return seedCustomFixture([
    {
      relPath: "app/models/reproducibility_assessment.py",
      specs: [{
        localName: "RecordReproducibilityAssessment",
        kind: SymbolKind.Class,
        body: "class RecordReproducibilityAssessment:\n    public_ref: str",
      }],
    },
    {
      relPath: "app/services/public_assessments.py",
      specs: [{
        localName: "compact_public_assessment",
        kind: SymbolKind.Function,
        body: "def compact_public_assessment(value):\n    return value.public_ref",
      }],
    },
  ]);
}

function retrieve(
  db: ReturnType<typeof seedRescueFixture>["db"],
  repoRoot: string,
  query: string,
) {
  return buildAuthoritativeProductRetrieval(db, repoRoot, {
    query,
    preset: RunPipelinePresetIntent.Modify,
    maxBudgetCharacters: 32_000,
  });
}

test("authoritative adapter passes the M207 pool-width instrument through unchanged", () => {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  try {
    const product = buildAuthoritativeProductRetrieval(db, repoRoot, {
      query: INLINES_TASK, preset: RunPipelinePresetIntent.Debug, maxBudgetCharacters: 32_000,
    });
    const narrow = buildAuthoritativeProductRetrieval(db, repoRoot, {
      query: INLINES_TASK, preset: RunPipelinePresetIntent.Debug, maxBudgetCharacters: 32_000, candidatePoolSize: 1,
    });
    assert.ok(narrow.result.diagnostics.candidate_count < product.result.diagnostics.candidate_count);
    assert.equal(narrow.result.pivots[0]?.fq_name, product.result.pivots[0]?.fq_name, "the lead is the top-ranked candidate at either width");
  } finally {
    db.close();
  }
});
