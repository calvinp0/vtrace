import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  aggregateArm,
  classifyPair,
  gradeOf,
  mcnemarExactP,
  orientation,
  totalTokensOf,
  treatmentAvailable,
  wilson,
  type ArmRun,
} from "./run_stage5_m155_paired_analysis";

function run(overrides: Partial<ArmRun> = {}): ArmRun {
  return {
    instanceId: "a__1", arm: "vtrace", grade: "PASS", patchProduced: true,
    costUsd: 0.5, numTurns: 20, durationMs: 90_000,
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 200_000, cacheCreationTokens: 50_000,
    totalTokens: 250_150, toolCalls: { Read: 3, Grep: 1 },
    injectedContextTokens: 5000, contextInjected: true,
    treatmentValid: true, treatmentInvalidReason: null, orientation: null,
    ...overrides,
  };
}

// --- grading (§50) ----------------------------------------------------------
// "A patch exists" is not success. The grader is the only authority.

test("grade comes from the grader, and an ungraded run is not a FAIL", () => {
  assert.equal(gradeOf(true), "PASS");
  assert.equal(gradeOf(false), "FAIL");
  assert.equal(gradeOf(null), "UNGRADED");
  assert.equal(gradeOf(undefined), "UNGRADED");
});

test("a produced patch does not become a PASS", () => {
  const r = run({ grade: "UNGRADED", patchProduced: true });
  const agg = aggregateArm("vtrace", [r]);
  assert.equal(agg.patchProduced, 1);
  assert.equal(agg.pass, 0);
  assert.equal(agg.ungraded, 1);
});

// --- paired matrix (§51) ----------------------------------------------------

test("the four paired classifications are exhaustive and correctly oriented", () => {
  assert.equal(classifyPair("PASS", "PASS"), "shared success");
  assert.equal(classifyPair("FAIL", "PASS"), "VTRACE unique win");
  assert.equal(classifyPair("PASS", "FAIL"), "VTRACE unique loss");
  assert.equal(classifyPair("FAIL", "FAIL"), "shared failure");
});

test("an ungraded arm makes the pair incomplete, never a win or a loss", () => {
  // Otherwise an infrastructure gap would be silently scored as a VTRACE result.
  assert.equal(classifyPair("UNGRADED", "PASS"), "incomplete");
  assert.equal(classifyPair("PASS", "UNGRADED"), "incomplete");
  assert.equal(classifyPair("UNGRADED", "UNGRADED"), "incomplete");
});

// --- token accounting (§53/§55) ---------------------------------------------

test("total tokens include cache reads and creations", () => {
  // Excluding cache would understate whichever arm caches more — and the VTRACE arm
  // caches a larger prompt by construction.
  assert.equal(totalTokensOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 30, cacheCreationTokens: 400 }), 433);
});

test("total tokens are null when nothing was reported, not zero", () => {
  assert.equal(totalTokensOf({}), null);
  assert.equal(totalTokensOf({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null }), null);
});

test("a partially reported row still sums what exists", () => {
  assert.equal(totalTokensOf({ inputTokens: 10, outputTokens: null, cacheReadTokens: 5, cacheCreationTokens: null }), 15);
});

// --- aggregation ------------------------------------------------------------

test("aggregate reports totals, medians and p90 over reported values only", () => {
  const agg = aggregateArm("vtrace", [
    run({ costUsd: 0.1, numTurns: 10, totalTokens: 1000, durationMs: 10_000 }),
    run({ costUsd: 0.3, numTurns: 30, totalTokens: 3000, durationMs: 30_000 }),
    run({ costUsd: null, numTurns: null, totalTokens: null, durationMs: null }),
  ]);
  assert.equal(agg.runs, 3);
  assert.equal(agg.costTotal, 0.4);
  assert.equal(agg.tokensTotal, 4000);
  // Nearest-rank percentile, the M122 convention: the median of two reported values
  // is the lower one. Stated explicitly because the unreported third run must not
  // be imputed as a zero and drag the statistic down.
  assert.equal(agg.turnsMedian, 10);
  assert.equal(agg.wallSecTotal, 40);
});

test("tool calls are summed per tool across the arm", () => {
  const agg = aggregateArm("baseline", [
    run({ toolCalls: { Read: 2, Grep: 1 } }),
    run({ toolCalls: { Read: 3, Bash: 4 } }),
  ]);
  assert.deepEqual(agg.toolCallTotals, { Read: 5, Grep: 1, Bash: 4 });
});

test("treatment-invalid runs are counted, not silently dropped", () => {
  const agg = aggregateArm("vtrace", [
    run(),
    run({ treatmentValid: false, treatmentInvalidReason: "vtrace context empty (no_context case)" }),
  ]);
  assert.equal(agg.treatmentInvalid, 1);
  assert.equal(agg.runs, 2);
});

// --- uncertainty (§52) ------------------------------------------------------

test("McNemar exact p is 1 when there are no discordant pairs", () => {
  assert.equal(mcnemarExactP(0, 0), 1);
});

test("McNemar exact p is symmetric in wins and losses", () => {
  assert.equal(mcnemarExactP(3, 1), mcnemarExactP(1, 3));
});

test("a 1-0 split is nowhere near significant, a 10-0 split is", () => {
  // The property that matters at n=30: one unique win cannot carry a claim.
  assert.equal(mcnemarExactP(1, 0), 1);
  assert.ok(mcnemarExactP(10, 0) < 0.01);
});

test("McNemar exact p never exceeds 1", () => {
  for (const [w, l] of [[1, 1], [2, 2], [3, 2], [5, 4]] as const) {
    assert.ok(mcnemarExactP(w, l) <= 1, `${w}/${l}`);
  }
});

test("Wilson interval brackets the point estimate and stays in [0,1]", () => {
  const ci = wilson(15, 30);
  assert.ok(ci.low < 0.5 && ci.high > 0.5);
  assert.ok(ci.low >= 0 && ci.high <= 1);
  const none = wilson(0, 30);
  assert.equal(none.low, 0);
  assert.ok(none.high > 0 && none.high < 0.2);
  const all = wilson(30, 30);
  assert.equal(all.high, 1);
});

test("Wilson interval on an empty arm is degenerate rather than NaN", () => {
  assert.deepEqual(wilson(0, 0), { low: 0, high: 0 });
});

// --- orientation from the ordered tool stream (§49/§58) ---------------------

test("orientation locates the first edit and the first gold touch", () => {
  const calls = [
    { index: 0, tool: "Grep", category: "search", path: null },
    { index: 1, tool: "Read", category: "read", path: "/bench/django__django/django/http/response.py" },
    { index: 2, tool: "Read", category: "read", path: "/bench/django__django/django/urls/base.py" },
    { index: 3, tool: "Edit", category: "edit", path: "/bench/django__django/django/http/response.py" },
  ];
  const o = orientation(calls, ["django/http/response.py"]);
  assert.equal(o.toolCalls, 4);
  assert.equal(o.firstEditIndex, 3);
  // Gold matched through samePath: repository-relative gold vs absolute bench path.
  assert.equal(o.firstGoldTouchIndex, 1);
  assert.equal(o.readsBeforeFirstEdit, 2);
  assert.equal(o.searchesBeforeFirstEdit, 1);
  assert.equal(o.goldTouchedBeforeFirstEdit, true);
});

test("orientation reports null rather than 0 when the agent never edited", () => {
  const o = orientation([{ index: 0, tool: "Grep", category: "search", path: null }], ["a/b.py"]);
  assert.equal(o.firstEditIndex, null);
  assert.equal(o.readsBeforeFirstEdit, null);
  assert.equal(o.goldTouchedBeforeFirstEdit, null);
});

test("orientation reports never-touched gold distinctly from touched-late", () => {
  const never = orientation([
    { index: 0, tool: "Read", category: "read", path: "/bench/x/other.py" },
    { index: 1, tool: "Edit", category: "edit", path: "/bench/x/other.py" },
  ], ["x/gold.py"]);
  assert.equal(never.firstGoldTouchIndex, null);
  assert.equal(never.goldTouchedBeforeFirstEdit, false);

  const late = orientation([
    { index: 0, tool: "Edit", category: "edit", path: "/bench/x/other.py" },
    { index: 1, tool: "Read", category: "read", path: "/bench/x/gold.py" },
  ], ["x/gold.py"]);
  assert.equal(late.firstGoldTouchIndex, 1);
  assert.equal(late.goldTouchedBeforeFirstEdit, false);
});

test("orientation is order-independent of the input array", () => {
  const calls = [
    { index: 2, tool: "Edit", category: "edit", path: "/bench/x/gold.py" },
    { index: 0, tool: "Grep", category: "search", path: null },
    { index: 1, tool: "Read", category: "read", path: "/bench/x/gold.py" },
  ];
  const o = orientation(calls, ["x/gold.py"]);
  assert.equal(o.firstEditIndex, 2);
  assert.equal(o.firstGoldTouchIndex, 1);
});

// --- treatment state taxonomy -----------------------------------------------
// A successful retrieval that truthfully selects nothing is a VALID treatment
// outcome, not a failure. The five states are never collapsed.

test("POSITIVE CONTROL: successful retrieval with zero selected context is a valid treatment", () => {
  const r = run({ treatmentState: "VALID_EMPTY", injectedContextTokens: 0, contextInjected: false, treatmentValid: true });
  assert.equal(treatmentAvailable(r.treatmentState), true);
  // The agent ran, so this arm carries an outcome — it may equal baseline, and that
  // is the evidence D exists to collect.
  assert.equal(aggregateArm("vtrace", [r]).treatmentInvalid, 0);
});

test("NEGATIVE CONTROL: a treatment that was never generated is not available", () => {
  assert.equal(treatmentAvailable("TREATMENT_UNAVAILABLE_INDEX_FAILURE"), false);
  assert.equal(treatmentAvailable("TREATMENT_GENERATION_FAILURE"), false);
  assert.equal(treatmentAvailable("NOT_RUN"), false);
});

test("a non-empty delivered treatment is available", () => {
  assert.equal(treatmentAvailable("VALID_NON_EMPTY"), true);
});

test("empty and unavailable are different states, not one bucket", () => {
  // Collapsing them would either overstate agent harm (counting an availability gap
  // as a VTRACE loss) or hide a real product limitation (calling it benchmark noise).
  assert.notEqual("VALID_EMPTY", "TREATMENT_UNAVAILABLE_INDEX_FAILURE");
  assert.equal(treatmentAvailable("VALID_EMPTY"), true);
  assert.equal(treatmentAvailable("TREATMENT_UNAVAILABLE_INDEX_FAILURE"), false);
});

test("a capsule-engine fallback invalidates an arm that did run", () => {
  // The fallback packs FAIL_TO_PASS into the retrieval query, so the arm is
  // parity-invalid by contamination even though the agent ran.
  const r = run({ treatmentState: "TREATMENT_GENERATION_FAILURE", treatmentValid: false, treatmentInvalidReason: "capsule engine fell back: hard_fail" });
  assert.equal(aggregateArm("vtrace", [r]).treatmentInvalid, 1);
  assert.equal(treatmentAvailable(r.treatmentState), false);
});
