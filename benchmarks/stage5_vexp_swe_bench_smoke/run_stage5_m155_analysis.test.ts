import assert from "node:assert/strict";
import { test } from "bun:test";

import type { RetrievalEvalRow } from "./run_stage5_retrieval_eval";
import {
  caseScore,
  changedCases,
  classifyChange,
  direction,
  emptyResult,
  isEvaluated,
  misleadingLead,
  summarizeCheckpoint,
  symbolIdentifiable,
} from "./run_stage5_m155_analysis";

// M155 §6: a detector reporting zero is not trusted until it has a known-positive
// fixture. Every detector below therefore gets BOTH a positive and a negative
// control, so a zero in the broad run is evidence about the product rather than
// evidence about the instrument.

function row(overrides: Partial<RetrievalEvalRow> = {}): RetrievalEvalRow {
  return {
    instance_id: "acme__widget-1",
    repo: "acme/widget",
    label_source: "gold_patch",
    intent: "debug",
    actual_mode: "capsule_v2",
    budget_tokens: 8000,
    estimated_tokens: 4000,
    used_percent: 50,
    expected_files: ["src/target.py"],
    expected_symbols: ["target_fn"],
    top_1_pivot_file: "src/target.py",
    top_1_pivot_symbol: "target_fn",
    top_3_files: ["src/target.py", "src/other.py"],
    expected_file_best_rank: 1,
    expected_file_role: "pivot",
    expected_symbol_best_rank: 1,
    expected_symbol_role: "pivot",
    contains_expected_file_top1: true,
    contains_expected_file_top3: true,
    contains_expected_file_anywhere: true,
    contains_expected_symbol_anywhere: true,
    pivot_count: 1,
    support_count: 2,
    discarded_count: 0,
    result: "hit_top1_pivot",
    miss_category: "none",
    failure_reason: null,
    filtered_generic_symbols: [],
    filtered_runner_files: [],
    downweighted_lexical_tokens: [],
    ...overrides,
  } as RetrievalEvalRow;
}

// --- misleading lead --------------------------------------------------------

test("misleading-lead detector: POSITIVE when the lead is not gold", () => {
  assert.equal(misleadingLead(row({ top_1_pivot_file: "src/decoy.py" })), true);
});

test("misleading-lead detector: NEGATIVE when the lead is gold", () => {
  assert.equal(misleadingLead(row()), false);
});

test("misleading-lead detector: repository-relative gold matches a workspace-relative lead", () => {
  // The defect this guards: gold is `django/http/response.py` but the capsule
  // reports the lead workspace-relative as `http/response.py`. A literal string
  // comparison called 26 of the 100 broad cases misleading when the lead was
  // exactly gold. M143-A hit the same trap and it inverted that milestone's
  // conclusion, which is why `samePath` exists.
  assert.equal(
    misleadingLead(row({
      expected_files: ["django/http/response.py"],
      top_1_pivot_file: "http/response.py",
    })),
    false,
  );
});

test("misleading-lead detector: a suffix match on a different file is still misleading", () => {
  assert.equal(
    misleadingLead(row({
      expected_files: ["django/http/response.py"],
      top_1_pivot_file: "django/http/request.py",
    })),
    true,
  );
});

test("misleading-lead detector: no lead is not a misleading lead", () => {
  // Delivering nothing is measured by the empty-result detector. Counting it here
  // too would double-charge one failure against two different metrics.
  assert.equal(misleadingLead(row({ top_1_pivot_file: null })), false);
});

// --- empty result -----------------------------------------------------------

test("empty-result detector: POSITIVE when nothing was delivered", () => {
  assert.equal(emptyResult(row({ pivot_count: 0, support_count: 0 })), true);
});

test("empty-result detector: NEGATIVE when support was delivered without a pivot", () => {
  assert.equal(emptyResult(row({ pivot_count: 0, support_count: 3 })), false);
});

// --- denominators -----------------------------------------------------------

test("unevaluable rows are excluded from the denominator", () => {
  assert.equal(isEvaluated(row({ result: "workspace_error" })), false);
  assert.equal(isEvaluated(row({ result: "fixture_error" })), false);
  assert.equal(isEvaluated(row({ result: "missing" })), true);
});

test("a case with no gold symbol label is unscorable, not a symbol miss", () => {
  assert.equal(symbolIdentifiable(row({ expected_symbols: [] })), false);
  assert.equal(symbolIdentifiable(row()), true);
});

test("summary keeps symbol rates on the scorable denominator only", () => {
  const rows = [
    row({ instance_id: "a" }),
    row({ instance_id: "b", expected_symbols: [], contains_expected_symbol_anywhere: false, expected_symbol_best_rank: null }),
  ];
  const summary = summarizeCheckpoint("T", rows);
  assert.equal(summary.evaluated, 2);
  assert.equal(summary.goldSymbolScorable, 1);
  // 1 of 1 scorable, NOT 1 of 2 evaluated.
  assert.equal(summary.goldSymbolAnywhere, 1);
  assert.equal(summary.goldSymbolTop1, 1);
});

test("workspace errors leave the file denominator untouched", () => {
  const summary = summarizeCheckpoint("T", [row(), row({ instance_id: "b", result: "workspace_error" })]);
  assert.equal(summary.cases, 2);
  assert.equal(summary.evaluated, 1);
  assert.equal(summary.unevaluated, 1);
  assert.equal(summary.goldFileTop1, 1);
});

// --- direction --------------------------------------------------------------

test("direction: gold falling out of top-1 is a REGRESSION", () => {
  const before = row();
  const after = row({
    contains_expected_file_top1: false,
    top_1_pivot_file: "src/decoy.py",
    expected_file_role: "support",
  });
  assert.equal(caseScore(before), 3);
  assert.equal(caseScore(after), 2);
  assert.equal(direction(before, after), "REGRESSION");
});

test("direction: gold appearing where it was missing is an IMPROVEMENT", () => {
  const before = row({
    contains_expected_file_top1: false,
    contains_expected_file_top3: false,
    contains_expected_file_anywhere: false,
    expected_file_role: "missing",
  });
  assert.equal(direction(before, row()), "IMPROVEMENT");
});

test("direction: same gold placement is NEUTRAL even if delivery moved", () => {
  assert.equal(direction(row(), row({ estimated_tokens: 7000, support_count: 5 })), "NEUTRAL");
});

// --- change classification --------------------------------------------------

test("classify: lead moved and gold moved is path authority", () => {
  const before = row();
  const after = row({
    top_1_pivot_file: "src/decoy.py",
    contains_expected_file_top1: false,
    expected_file_role: "support",
  });
  assert.equal(classifyChange(before, after), "path authority");
});

test("classify: same lead, different symbol, gold moved is symbol authority", () => {
  const before = row();
  const after = row({
    top_1_pivot_symbol: "other_fn",
    contains_expected_file_top1: false,
    expected_file_role: "support",
  });
  assert.equal(classifyChange(before, after), "symbol authority");
});

test("classify: gold crossing the discard boundary is candidate cap", () => {
  const before = row();
  const after = row({ expected_file_role: "discarded", contains_expected_file_top1: false });
  assert.equal(classifyChange(before, after), "candidate cap");
});

test("classify: identical gold and lead with moved delivery is contract-only", () => {
  assert.equal(classifyChange(row(), row({ estimated_tokens: 5500 })), "contract-only change");
});

// --- changed-case detection -------------------------------------------------

test("changed-case detector: POSITIVE on a delivery-only change", () => {
  // The reachability guard for `contract-only change`: without this disjunct the
  // class could never be observed, only asserted.
  const changed = changedCases("A", "B", [row()], [row({ estimated_tokens: 6000 })]);
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.classification, "contract-only change");
  assert.equal(changed[0]!.directionLabel, "NEUTRAL");
});

test("changed-case detector: NEGATIVE on byte-identical rows", () => {
  assert.equal(changedCases("A", "B", [row()], [row()]).length, 0);
});

test("changed-case detector ignores cases absent from one side", () => {
  const changed = changedCases("A", "B", [row({ instance_id: "only-before" })], [row({ instance_id: "only-after" })]);
  assert.equal(changed.length, 0);
});
