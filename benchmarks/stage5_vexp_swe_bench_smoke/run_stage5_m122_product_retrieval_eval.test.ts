import assert from "node:assert/strict";
import { test } from "bun:test";

import { classifyStage, stableProjection, type ComparisonRow } from "./run_stage5_m122_product_retrieval_eval";

const view = {
  candidateFiles: ["low.py", "picked.py", "compressed.py"],
  selectedFiles: ["picked.py", "compressed.py"],
  leadPivot: "picked.py",
  required: ["picked.py"],
  support: ["compressed.py"],
  modes: { "picked.py": "full", "compressed.py": "compressed" },
  contextTokens: 10,
  noCandidates: false,
  candidateFilesConsidered: 3,
  diagnostics: {},
  latencyMs: 1,
};

test("M122 stage classification covers every candidate/final state", () => {
  assert.equal(classifyStage("missing.py", view), "not generated");
  assert.equal(classifyStage("low.py", view), "reranked but not selected");
  assert.equal(classifyStage("picked.py", view), "selected and visible");
  assert.equal(classifyStage("compressed.py", view), "selected but compressed");
  const lowRanked = { ...view, candidateFiles: [...Array.from({ length: 20 }, (_, i) => `${i}.py`), "late.py"] };
  assert.equal(classifyStage("late.py", lowRanked), "generated but low-ranked");
});

test("M122 stable projections exclude nondeterministic timings", () => {
  const row = {
    instance_id: "case",
    corpus: "fixture",
    task_hash: "hash",
    expected_files: [],
    legacy_selected_files: [], product_selected_files: [],
    legacy_lead_pivot: null, product_lead_pivot: null,
    legacy_required: [], product_required: [], legacy_support: [], product_support: [],
    legacy_no_candidates: false, product_no_candidates: false,
    legacy_context_tokens: 0, product_context_tokens: 0,
    legacy_latency_ms: 1, product_latency_ms: 2,
    changed: false, change_classification: "ambiguous", explanation: "none",
    expected_file_stages: {}, product_diagnostics: {},
  } satisfies ComparisonRow;
  const stable = stableProjection(row);
  assert.equal("legacy_latency_ms" in stable, false);
  assert.equal("product_latency_ms" in stable, false);
  assert.equal(JSON.stringify(stable).includes("FAIL_TO_PASS"), false);
  assert.equal(JSON.stringify(stable).includes("PASS_TO_PASS"), false);
});
