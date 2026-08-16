import assert from "node:assert/strict";
import { test } from "bun:test";

import { INLINES_TASK, seedCapsuleV2Fixture } from "../capsuleV2/__fixtures__/capsuleV2Fixture";
import { createTestProductStores } from "../testing/productStores";
import { CapsuleIntent } from "../capsuleV2/types";
import { estimateTokens } from "../capsuleV2/tokens";
import { assembleProductContext, buildUnresolvedProductContext } from "./assembleProductContext";
import { PRODUCT_CONTEXT_ROLES } from "./types";

const FRESH_FIXTURE = { status: "fresh", reason: "fixture_index", action: "none" } as const;

test("shared product response is role-aware, structural, deduplicated, and honestly accounted", async () => {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  const stores = createTestProductStores(db);
  try {
    let tick = 0;
    const response = await assembleProductContext({
      stores,
      repoRoot,
      task: INLINES_TASK,
      intent: CapsuleIntent.Modify,
      budgetTokens: 8_000,
      freshnessOverride: FRESH_FIXTURE,
      now: () => ++tick,
    });

    assert.equal(response.responseVersion, 2);
    assert.equal(response.resolved, true);
    assert.equal(response.intent, "modify");
    assert.equal(response.accounting.estimateMethod, "character_ratio");
    assert.equal(response.accounting.estimateExact, false);
    assert.equal(response.accounting.renderedCharacters, response.modelVisibleContext.length);
    assert.equal(response.accounting.usedTokensEstimate, estimateTokens(response.modelVisibleContext));
    assert.equal(response.accounting.savedTokensEstimate,
      response.accounting.naiveTokensEstimate! - response.accounting.usedTokensEstimate);
    assert.match(response.accounting.baseline, /every unique selected source file/);
    assert.match(response.accounting.claimBoundary, /not the repository/);
    assert.equal(response.timing.totalMs >= response.timing.capsuleBuildMs, true);
    assert.equal(PRODUCT_CONTEXT_ROLES.every((role) => response.roleCounts[role] >= 0), true);

    const pivot = response.items.find((item) => item.roles.includes("pivot"));
    assert.ok(pivot);
    assert.equal(pivot.roles.includes("required"), true);
    assert.equal(pivot.contentMode, "focused_source");
    assert.match(pivot.content ?? "", /get_inline_instances/);
    assert.ok(pivot.lineSpan);
    assert.equal(pivot.metadata?.applicability, "EDIT_OR_RULE_OUT");

    const skeleton = response.items.find((item) => item.roles.includes("skeleton"));
    assert.ok(skeleton);
    assert.match(skeleton.content ?? "", /(get_inline_formsets|class |def |\()/);
    assert.notEqual(skeleton.metadata?.skeletonFallback, "first_n_lines");
    assert.equal(response.items.some((item) => item.roles.includes("documentation")), true);

    const identities = response.items.map((item) => `${item.path ?? ""}::${item.symbol ?? item.stableId}`);
    assert.equal(new Set(identities).size, identities.length);
    assert.equal(new Set(response.items.map((item) => item.stableId)).size, response.items.length);
    assert.doesNotMatch(response.modelVisibleContext, /FAIL_TO_PASS|PASS_TO_PASS|gold files?/iu);
    assert.match(response.modelVisibleContext, /static structural evidence; they are not dynamic execution flow/);

    const impactItems = response.items.filter((item) => item.roles.includes("impact"));
    for (const impact of impactItems) {
      assert.equal(impact.metadata?.contextReference, `[${impact.id}]`);
      assert.equal(typeof impact.metadata?.evidenceStrength, "string");
      assert.equal(typeof impact.metadata?.resolutionMethod, "string");
      assert.equal(typeof impact.metadata?.truncated, "boolean");
      assert.ok(Number(impact.metadata?.affectedFileCount ?? 0) >= 0);
      if (!impact.roles.some((role) => role === "pivot" || role === "required" || role === "support")) {
        assert.match(impact.content ?? "", /^(CALLS|IMPORTS|RE_EXPORTS|REFERENCES|INHERITS|IMPLEMENTS|DECORATES|CONTAINS)\b/u);
      }
    }
  } finally {
    db.close();
  }
});

test("stable IDs and ordering do not depend on timing", async () => {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  const stores = createTestProductStores(db);
  try {
    let firstTick = 0;
    let secondTick = 100;
    const first = await assembleProductContext({ stores, repoRoot, task: INLINES_TASK, budgetTokens: 8_000, freshnessOverride: FRESH_FIXTURE, now: () => ++firstTick });
    const second = await assembleProductContext({ stores, repoRoot, task: INLINES_TASK, budgetTokens: 8_000, freshnessOverride: FRESH_FIXTURE, now: () => secondTick += 3 });
    assert.deepEqual(
      second.items.map(({ id, stableId, path, symbol, roles }) => ({ id, stableId, path, symbol, roles })),
      first.items.map(({ id, stableId, path, symbol, roles }) => ({ id, stableId, path, symbol, roles })),
    );
    assert.equal(second.selectedFileHash, first.selectedFileHash);
    assert.equal(second.taskHash, first.taskHash);
    assert.equal(second.leadPivot, first.leadPivot);
  } finally {
    db.close();
  }
});

test("shared assembler fails closed before rendering when the index snapshot is not fresh", async () => {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  const stores = createTestProductStores(db);
  try {
    const response = await assembleProductContext({ stores, repoRoot, task: INLINES_TASK, budgetTokens: 8_000 });
    assert.equal(response.resolved, false);
    assert.equal(response.freshness.status, "missing");
    assert.equal(response.items.length, 0);
    assert.equal(response.modelVisibleContext, "");
    assert.equal(response.accounting.usedTokensEstimate, 0);
    assert.equal(response.accounting.naiveTokensEstimate, null);
    assert.equal(response.accounting.savedTokensEstimate, null);
  } finally {
    db.close();
  }
});

test("unresolved stale response reports no fabricated baseline or savings", () => {
  const response = buildUnresolvedProductContext({
    task: "find target",
    repoRoot: "/repo",
    repositoryId: "repo-id",
    worktreeId: "worktree-id",
    headCommit: "abc",
    branch: "main",
    detached: false,
    freshnessStatus: "stale",
    freshnessReason: "working_tree_changed",
    freshnessAction: "call_index_repo",
    totalMs: 2,
  });
  assert.equal(response.resolved, false);
  assert.equal(response.modelVisibleContext, "");
  assert.equal(response.accounting.usedTokensEstimate, 0);
  assert.equal(response.accounting.naiveTokensEstimate, null);
  assert.equal(response.accounting.savedTokensEstimate, null);
  assert.equal(response.accounting.reductionPercent, null);
  assert.equal(response.timing.totalMs, 2);
});
