// Capsule v2 intent-planner tests.
//
// Two layers: (1) deterministic intent detection + strategy selection over task
// prose (pure `planIntent`), and (2) proof that the plan is a real behavioural
// lever — the selected `role_policy` changes the role-assignment branch in
// `buildCapsuleV2`, not just a printed label.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { shapeSweQuery, type ShapedSweQuery } from "../capsule/sweQueryShaping";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import { planIntent, strategyForIntent } from "./intent";
import { CapsuleIntent, type CapsuleV2Result } from "./types";
import { ADMINDOCS_TASK, seedAdmindocsFixture } from "./__fixtures__/admindocsFixture";

function plan(task: string, requested: CapsuleIntent = CapsuleIntent.Auto) {
  const shaped: ShapedSweQuery = shapeSweQuery({ problemStatement: task, failToPass: [] });
  return planIntent(requested, task, shaped);
}

// --- detection ---------------------------------------------------------------

test("'fix ModelAdmin.get_inlines hook...' resolves to debug with the debug strategy", () => {
  const p = plan("fix ModelAdmin.get_inlines hook for generic inline admin failing test");
  // debug (fix/failing) wins over the incidental modify cue (hook) — either way
  // the strategy must be the debug strategy.
  assert.ok(p.intent === CapsuleIntent.Debug || p.intent === CapsuleIntent.TestFailure);
  assert.equal(p.strategy.role_policy, "debug_refinement");
  assert.ok(p.intent_reason.length > 0);
});

test("'simplify_regexp doesn't replace trailing groups' resolves to debug, not refactor", () => {
  // `simplify_regexp` is a function NAME — the identifier-aware refactor rule must
  // not fire on it; the debug cue ("doesn't") decides.
  const p = plan("simplify_regexp doesn't replace trailing named groups");
  assert.equal(p.intent, CapsuleIntent.Debug);
  assert.equal(p.strategy.role_policy, "debug_refinement");
});

test("'refactor auth middleware' resolves to refactor", () => {
  const p = plan("refactor auth middleware");
  assert.equal(p.intent, CapsuleIntent.Refactor);
  assert.equal(p.strategy.role_policy, "caller_oriented");
});

test("'what files are impacted by changing authenticate' resolves to impact", () => {
  const p = plan("what files are impacted by changing authenticate");
  assert.equal(p.intent, CapsuleIntent.Impact);
  assert.equal(p.strategy.role_policy, "caller_oriented");
});

test("'add support for custom cache limits' resolves to modify", () => {
  const p = plan("add support for custom cache limits");
  assert.equal(p.intent, CapsuleIntent.Modify);
  assert.equal(p.strategy.role_policy, "sibling_oriented");
  // Two corroborating cues (add, support) -> high confidence.
  assert.equal(p.intent_confidence, "high");
});

test("explanation language resolves to explain", () => {
  const p = plan("explain how does the request middleware pipeline work");
  assert.equal(p.intent, CapsuleIntent.Explain);
  assert.equal(p.strategy.role_policy, "entry_point_oriented");
});

test("a named failing test forces test-failure at high confidence with the debug strategy", () => {
  const shaped = shapeSweQuery({
    problemStatement: "the admin inline test is failing",
    failToPass: ["tests/admin/test_inlines.py::InlineTest::test_get_inline_instances"],
  });
  const p = planIntent(CapsuleIntent.Auto, "the admin inline test is failing", shaped);
  assert.equal(p.intent, CapsuleIntent.TestFailure);
  assert.equal(p.intent_confidence, "high");
  assert.equal(p.strategy.role_policy, "debug_refinement");
});

test("an explicit intent is honoured verbatim at high confidence", () => {
  const p = plan("anything at all", CapsuleIntent.Explain);
  assert.equal(p.intent, CapsuleIntent.Explain);
  assert.equal(p.intent_confidence, "high");
  assert.match(p.intent_reason[0]!, /explicitly/);
});

test("no signal defaults to debug at low confidence", () => {
  const p = plan("the quarterly report numbers for widgets");
  assert.equal(p.intent, CapsuleIntent.Debug);
  assert.equal(p.intent_confidence, "low");
});

test("every resolved intent maps to a strategy with generators, role policy, and budget policy", () => {
  for (const intent of [
    CapsuleIntent.Debug,
    CapsuleIntent.TestFailure,
    CapsuleIntent.Refactor,
    CapsuleIntent.Modify,
    CapsuleIntent.Explain,
    CapsuleIntent.Impact,
  ] as const) {
    const s = strategyForIntent(intent);
    assert.ok(s.candidate_generators.length > 0, `${intent} has generators`);
    assert.ok(s.role_policy.length > 0, `${intent} has a role policy`);
    assert.ok(s.budget_policy.length > 0, `${intent} has a budget policy`);
  }
});

// --- the plan is a behavioural lever, not just a label -----------------------

function admindocs(intent: CapsuleIntent): CapsuleV2Result {
  const { db, repoRoot } = seedAdmindocsFixture();
  try {
    return buildCapsuleV2({ db, repoRoot, task: ADMINDOCS_TASK, intent, maxTokens: 8_000 });
  } finally {
    db.close();
  }
}

test("intent planner changes the role policy, not just the printed label", () => {
  const debug = admindocs(CapsuleIntent.Debug);
  const refactor = admindocs(CapsuleIntent.Refactor);

  // The strategy is surfaced in diagnostics...
  assert.equal(debug.diagnostics.strategy.role_policy, "debug_refinement");
  assert.equal(refactor.diagnostics.strategy.role_policy, "caller_oriented");

  // ...and it actually changes the pipeline branch: only debug_refinement runs the
  // caller/helper/infra refinement (which infers a subsystem root + may backfill).
  assert.ok(debug.diagnostics.subsystem_root, "debug refinement infers a subsystem root");
  assert.notEqual(debug.diagnostics.production_backfill_used, undefined);
  assert.equal(refactor.diagnostics.subsystem_root, undefined);
  assert.equal(refactor.diagnostics.production_backfill_used, undefined);

  // The refinement also re-decides roles: under debug the local helper is a pivot.
  assert.ok(debug.pivots.some((p) => p.symbol === "replace_named_groups"));
});

test("test-failure uses the debug refinement branch (shared strategy)", () => {
  const r = admindocs(CapsuleIntent.TestFailure);
  assert.equal(r.diagnostics.strategy.role_policy, "debug_refinement");
  assert.notEqual(r.diagnostics.production_backfill_used, undefined);
});

test("intent planning is deterministic", () => {
  assert.deepEqual(plan("add support for custom cache limits"), plan("add support for custom cache limits"));
});
