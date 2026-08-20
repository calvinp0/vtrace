import assert from "node:assert/strict";
import { test } from "bun:test";

import { queryOf } from "./run_stage5_m164_analysis";

// §35. M163 discovered that tool inputs live in a field its analyzer ignored,
// which scored every query as empty and therefore misaligned — a finding about
// the capture format, not the agent. This is the known-positive that keeps the
// ported reader honest: a call with a known query must come back byte-identical.

const QUERY = "Count annotation with distinct=True produces invalid SQL";

test("known-positive: the query reader recovers the harness `query` field byte-identically", () => {
  assert.equal(queryOf({ tool: "mcp__vtrace__get_code_context", query: QUERY }, undefined), QUERY);
});

test("known-positive: structured args win when present, and 'None' is not a query", () => {
  assert.equal(queryOf({ query: "ignored" }, { args: { query: QUERY } } as never), QUERY);
  assert.equal(queryOf({ query: "ignored" }, { args: { task: QUERY } } as never), QUERY);
  // The harness writes the literal string "None" for an absent input.
  assert.equal(queryOf({ query: "None" }, undefined), "");
  assert.equal(queryOf(undefined, undefined), "");
});

test("known-positive: the query is recovered from the product's own echoed request", () => {
  // The M164 capture reality: the harness writes "None" into its query column for
  // MCP calls, and the only faithful record of what the agent sent is what the
  // product echoed back.
  const output = JSON.stringify({
    result: { ok: true, output: { request: { query: QUERY, task: QUERY }, capsuleResult: { pivots: [] } } },
  });
  assert.equal(queryOf({ tool: "mcp__vtrace__get_code_context", query: "None", output }, undefined), QUERY);
});
