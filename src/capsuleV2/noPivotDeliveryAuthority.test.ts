// M157-A — the no-pivot delivery decision must be auditable.
//
// When no candidate clears the pivot gate the capsule returns `no_context` and
// discards everything. Two very different things produce that shape: a candidate
// the role layer never granted any authority to, and a candidate it classified
// as SUPPORT that a query-global "no pivot -> deliver nothing" rule then dropped.
// The published result could not tell them apart — `support_count` is written as
// a literal 0 on this path, and the global discard reason overwrote each
// candidate's own role decision — so "0 support" read as "nothing was relevant"
// when the truth was "four relevant candidates were withheld".
//
// These tests pin the distinction itself, not any particular delivery policy:
// they assert the state is REPORTED honestly, and deliberately do NOT assert
// that support-only context becomes deliverable.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildCapsuleV2 } from "./buildCapsuleV2";
import { seedCapsuleV2Fixture } from "./__fixtures__/capsuleV2Fixture";
import { CapsuleIntent, CapsuleV2Mode } from "./types";

/** The reason string the query-global no-pivot gate stamps on support candidates. */
const GLOBAL_COLLAPSE = "support-only: no actionable edit target";

/** A task that retrieves relevant candidates but promotes none of them to a pivot. */
function buildNoPivotWithSupport() {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  try {
    return buildCapsuleV2({
      db,
      repoRoot,
      task: "options",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
  } finally {
    db.close();
  }
}

test("a no-pivot capsule reports how much support authority it withheld", () => {
  const result = buildNoPivotWithSupport();

  assert.equal(result.actual_mode, CapsuleV2Mode.NoContext);
  assert.equal(result.pivots.length, 0);
  // `support_count` keeps its meaning: support DELIVERED, which is genuinely 0.
  assert.equal(result.diagnostics.support_count, 0);

  // The withheld count is the fact that used to be unrecoverable.
  const withheld = result.diagnostics.support_authority_withheld;
  assert.ok(withheld !== undefined && withheld > 0, "expected withheld support to be reported");
  assert.equal(
    withheld,
    result.discarded.filter((item) => item.discard_reason === GLOBAL_COLLAPSE).length,
    "withheld count must equal the candidates the global gate collapsed",
  );
});

test("the global no-pivot gate does not erase a candidate's own role decision", () => {
  const result = buildNoPivotWithSupport();

  const collapsed = result.discarded.filter((item) => item.discard_reason === GLOBAL_COLLAPSE);
  assert.ok(collapsed.length > 0, "fixture must produce globally collapsed support candidates");
  for (const item of collapsed) {
    assert.ok(
      typeof item.role_reason === "string" && item.role_reason.length > 0,
      `expected a preserved role reason for ${item.path}::${item.symbol}`,
    );
    assert.notEqual(item.role_reason, item.discard_reason);
  }
});

test("a candidate-local denial is distinguishable from a query-global one", () => {
  const result = buildNoPivotWithSupport();

  // The fixture's test symbols are refused by the role layer itself, so they
  // carry their OWN reason rather than the global one. If both kinds collapsed
  // to a single string the audit question could not be answered at all.
  const local = result.discarded.filter((item) => item.discard_reason !== GLOBAL_COLLAPSE);
  const global = result.discarded.filter((item) => item.discard_reason === GLOBAL_COLLAPSE);
  assert.ok(local.length > 0, "fixture must produce a candidate-local denial");
  assert.ok(global.length > 0, "fixture must produce a query-global collapse");
  assert.equal(local.length + global.length, result.discarded.length);
});

test("withheld support is not reported when nothing was retrieved at all", () => {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  try {
    const empty = buildCapsuleV2({
      db,
      repoRoot,
      task: "zzqq nonexistent xyzzy gibberish wibble frobnicate",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    assert.equal(empty.actual_mode, CapsuleV2Mode.NoContext);
    assert.equal(empty.discarded.length, 0);
    // A true-empty result must not claim anything was withheld — the field is
    // absent, so "no useful evidence" stays distinguishable from "withheld".
    assert.equal(empty.diagnostics.support_authority_withheld, undefined);
  } finally {
    db.close();
  }
});
