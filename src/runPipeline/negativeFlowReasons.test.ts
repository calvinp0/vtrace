// M130 negative-flow truthfulness.
//
// `endpoints_not_connected` claimed something static analysis cannot establish:
// that two symbols are unconnected. Every replacement reason below states a fact
// about the SEARCH — which endpoint failed to resolve, whether the budget ran
// out, whether the language is covered, or that this index holds no path — and
// carries the scope of that claim alongside it.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { RunPipelineFlowClaimScope, RunPipelineFlowSkipReason } from "./types";

test("the retired reason is gone from the product vocabulary", () => {
  const reasons = Object.values(RunPipelineFlowSkipReason);
  assert.equal(
    reasons.includes("endpoints_not_connected" as never),
    false,
    "endpoints_not_connected overclaims and must not be reachable",
  );
  assert.equal(reasons.includes(RunPipelineFlowSkipReason.NoIndexedPathFound), true);
});

test("every distinguishable failure mode has its own reason", () => {
  const required = [
    "start_endpoint_not_found",
    "end_endpoint_not_found",
    "endpoint_ambiguous",
    "index_stale",
    "unsupported_language",
    "no_indexed_path_found",
    "traversal_limit_reached",
  ];
  const reasons = new Set<string>(Object.values(RunPipelineFlowSkipReason));
  for (const reason of required) {
    assert.equal(reasons.has(reason), true, `missing flow skip reason ${reason}`);
  }
});

test("the only claim scope a static index can support is the index itself", () => {
  assert.deepEqual(Object.values(RunPipelineFlowClaimScope), ["current_index"]);
});

test("reason strings stay snake_case and stable for downstream consumers", () => {
  for (const [key, value] of Object.entries(RunPipelineFlowSkipReason)) {
    assert.match(value, /^[a-z][a-z_]*[a-z]$/u, `${key} must be a stable snake_case code`);
  }
});
