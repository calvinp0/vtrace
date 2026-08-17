import assert from "node:assert/strict";
import { test } from "bun:test";

import type { RetrievalEvalFixtureEntry, RetrievalEvalRow } from "./run_stage5_retrieval_eval";
import type { DerivationVerdict } from "./indexDerivationGate";
import { buildManifest, restrictFixture, summarizeFastGate } from "./run_stage5_m155_fast_gate";

function entry(id: string): RetrievalEvalFixtureEntry {
  return {
    instance_id: id, repo: "acme/widget", workspace: `/tmp/${id}`,
    task: "t", intent: "debug", budget: 8000, label_source: "gold_patch",
    expected_files: ["src/a.py"], expected_symbols: ["f"],
  } as RetrievalEvalFixtureEntry;
}

function verdict(valid: boolean, reason: string): DerivationVerdict {
  return {
    valid, reason, workspace: "/tmp/x",
    storedVtraceCommit: null, storedFormatVersion: valid ? 5 : 1,
    storedIndexerFingerprint: null, expectedIndexerFingerprint: "abc",
    expectedFormatVersion: 5, detail: reason,
  } as DerivationVerdict;
}

function row(overrides: Partial<RetrievalEvalRow> = {}): RetrievalEvalRow {
  return {
    instance_id: "a", repo: "acme/widget", label_source: "gold_patch", intent: "debug",
    actual_mode: "capsule_v2", budget_tokens: 8000, estimated_tokens: 1000, used_percent: 12,
    expected_files: ["src/a.py"], expected_symbols: ["f"],
    top_1_pivot_file: "src/a.py", top_1_pivot_symbol: "f", top_3_files: ["src/a.py"],
    expected_file_best_rank: 1, expected_file_role: "pivot",
    expected_symbol_best_rank: 1, expected_symbol_role: "pivot",
    contains_expected_file_top1: true, contains_expected_file_top3: true,
    contains_expected_file_anywhere: true, contains_expected_symbol_anywhere: true,
    pivot_count: 1, support_count: 1, discarded_count: 0,
    result: "hit_top1_pivot", miss_category: "none", failure_reason: null,
    filtered_generic_symbols: [], filtered_runner_files: [], downweighted_lexical_tokens: [],
    ...overrides,
  } as RetrievalEvalRow;
}

// --- suite restriction ------------------------------------------------------

test("restrictFixture keeps only declared ids, in fixture order", () => {
  const restricted = restrictFixture([entry("c"), entry("a"), entry("b")], new Set(["b", "c"]));
  assert.deepEqual(restricted.map((e) => e.instance_id), ["c", "b"]);
});

// --- gate usability ---------------------------------------------------------
// The whole point of B2: a suite is a usable stability signal only when EVERY
// case's evidence is derivation-valid. The committed Frozen50 was 5/50 valid
// across three different evidence regimes, and still reported as authoritative.

test("a fully derivation-valid suite is usable", () => {
  const entries = [entry("a"), entry("b")];
  const manifest = buildManifest({
    suite: "s", corpusRoot: "/tmp", entries,
    verdicts: new Map([["a", verdict(true, "derivation_agrees")], ["b", verdict(true, "derivation_agrees")]]),
    expectedIndexerFingerprint: "abc", expectedFormatVersion: 5,
  });
  assert.equal(manifest.gateUsable, true);
  assert.equal(manifest.derivationValidCases, 2);
  assert.deepEqual(manifest.invalidByReason, {});
});

test("ONE invalid case makes the whole suite unusable, not 'mostly fine'", () => {
  const entries = [entry("a"), entry("b")];
  const manifest = buildManifest({
    suite: "s", corpusRoot: "/tmp", entries,
    verdicts: new Map([["a", verdict(true, "derivation_agrees")], ["b", verdict(false, "schema_unsupported")]]),
    expectedIndexerFingerprint: "abc", expectedFormatVersion: 5,
  });
  assert.equal(manifest.gateUsable, false);
  assert.equal(manifest.derivationInvalidCases, 1);
  assert.deepEqual(manifest.invalidByReason, { schema_unsupported: 1 });
});

test("mixed invalidity reasons are counted separately", () => {
  const entries = [entry("a"), entry("b"), entry("c")];
  const manifest = buildManifest({
    suite: "s", corpusRoot: "/tmp", entries,
    verdicts: new Map([
      ["a", verdict(false, "schema_unsupported")],
      ["b", verdict(false, "meta_missing")],
      ["c", verdict(false, "schema_unsupported")],
    ]),
    expectedIndexerFingerprint: "abc", expectedFormatVersion: 5,
  });
  assert.deepEqual(manifest.invalidByReason, { schema_unsupported: 2, meta_missing: 1 });
  assert.equal(manifest.gateUsable, false);
});

// --- summary denominators ---------------------------------------------------

test("workspace errors are excluded from rates and counted separately", () => {
  const summary = summarizeFastGate("s", [row(), row({ instance_id: "b", result: "workspace_error" })]);
  assert.equal(summary.cases, 2);
  assert.equal(summary.evaluated, 1);
  assert.equal(summary.workspaceErrors, 1);
  assert.equal(summary.top1, 1);
});

test("the three gold states are reported separately and never collapsed", () => {
  const summary = summarizeFastGate("s", [
    row({ instance_id: "a", expected_file_role: "pivot" }),
    row({ instance_id: "b", expected_file_role: "support" }),
    row({ instance_id: "c", expected_file_role: "discarded" }),
    row({ instance_id: "d", expected_file_role: "missing" }),
  ]);
  // delivered = pivot + support only. discarded is NOT success (M155 §8).
  assert.equal(summary.goldDelivered, 0.5);
  assert.equal(summary.goldDiscarded, 0.25);
  assert.equal(summary.goldMissing, 0.25);
});

test("an all-invalid suite yields zero evaluated rather than a flattering rate", () => {
  const summary = summarizeFastGate("s", [
    row({ instance_id: "a", result: "workspace_error" }),
    row({ instance_id: "b", result: "workspace_error" }),
  ]);
  assert.equal(summary.evaluated, 0);
  assert.equal(summary.top1, 0);
  assert.equal(summary.meanTokens, null);
});
