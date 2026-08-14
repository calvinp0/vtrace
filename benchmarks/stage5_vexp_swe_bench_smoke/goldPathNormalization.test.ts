// M143 §54 — permanent guard for the gold-path comparison used by evaluation.
//
// WHY THIS EXISTS
// ---------------
// Gold paths in the Stage 5 fixtures are REPOSITORY-relative
// (`django/forms/widgets.py`); the lead a capsule reports is workspace-relative
// (`forms/widgets.py`). M143-A's first audit pass compared them literally and
// scored THREE correct leads as wrong. That single defect inverted the
// conclusion: blanket title demotion looked net-positive when it is in fact
// net-negative, and the milestone was one commit away from shipping a change
// measured against a broken evaluator.
//
// The comparison is therefore anchored on a path-SEGMENT boundary in either
// direction. A test lives here rather than beside a product module because the
// helper is part of the benchmark harness, not the product.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { samePath } from "./run_stage5_m143b_ownership_evidence_audit";

test("M143 §54: repository-relative gold matches workspace-relative lead", () => {
  // The exact shape that misscored three leads.
  assert.ok(samePath("django/forms/widgets.py", "forms/widgets.py"));
  assert.ok(samePath("forms/widgets.py", "django/forms/widgets.py"));
  assert.ok(samePath("django/db/models/fields/related.py", "db/models/fields/related.py"));
});

test("M143 §54: identical paths match", () => {
  assert.ok(samePath("sympy/printing/pycode.py", "sympy/printing/pycode.py"));
});

test("M143 §54: a shared text suffix that is not a segment boundary does not match", () => {
  // `related.py` is a suffix of `unrelated.py` as TEXT. Anchoring on `/` is what
  // stops the evaluator from crediting the wrong file.
  assert.ok(!samePath("app/unrelated.py", "related.py"));
  assert.ok(!samePath("related.py", "app/unrelated.py"));
});

test("M143 §54: same basename in different directories does not match", () => {
  assert.ok(!samePath("arc/job/adapters/gaussian.py", "arc/parser/adapters/gaussian.py"));
  assert.ok(!samePath("a/widgets.py", "b/widgets.py"));
});

test("M143 §54: unrelated paths do not match", () => {
  assert.ok(!samePath("django/db/migrations/autodetector.py", "django/db/models/fields/related.py"));
});
