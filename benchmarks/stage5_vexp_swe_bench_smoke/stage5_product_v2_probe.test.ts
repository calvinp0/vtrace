// Tests for the product-path Capsule v2 probe helpers.
// Pure unit tests — NO Docker, model, agent, or process calls occur.

import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  PRODUCT_V2_CONDITION,
  PRODUCT_V2_ENGINE,
  PRODUCT_V2_RUN_LABEL,
  PRODUCT_V2_SUBCOMMAND,
  buildProductV2RunPipelineArgs,
  parseProductV2Response,
  productV2ProbeDir,
  productV2ProbeFilePath,
} from "./stage5_product_v2_probe";

test("buildProductV2RunPipelineArgs emits the product run-pipeline v2 opt-in", () => {
  const args = buildProductV2RunPipelineArgs({
    baseArgs: ["src/cli/index.ts"],
    workspace: "/tmp/ws",
    query: "fix the bug",
    intent: "debug",
    budgetTokens: 8000,
  });
  assert.deepEqual(args, [
    "src/cli/index.ts",
    "run-pipeline",
    "/tmp/ws",
    "fix the bug",
    "--capsule-engine",
    "v2",
    "--capsule-intent",
    "debug",
    "--capsule-budget-tokens",
    "8000",
  ]);
  // Uses the product surface, never the benchmark-only `capsule` subcommand.
  assert.equal(args[1], PRODUCT_V2_SUBCOMMAND);
  assert.ok(args.includes(PRODUCT_V2_ENGINE));
});

test("constants name the product condition and run label", () => {
  assert.equal(PRODUCT_V2_CONDITION, "vtrace-product-v2");
  assert.equal(PRODUCT_V2_RUN_LABEL, "eval-product-v2-turn-reduction-4case");
});

test("productV2ProbeFilePath sanitizes the instance id", () => {
  assert.equal(
    productV2ProbeFilePath("/out", "django-10880"),
    "/out/_product_v2_probe.django-10880.json",
  );
  // A slashy instance id cannot escape the out dir.
  assert.equal(
    productV2ProbeFilePath("/out", "a/b c"),
    "/out/_product_v2_probe.a_b_c.json",
  );
});

test("productV2ProbeDir targets the label dir, not the vexp-cleaned raw/vtrace", () => {
  // Labeled: the per-run label dir (one level above raw/vtrace, which vexp cleans).
  assert.equal(productV2ProbeDir("/results", "canary-x"), "/results/runs/canary-x");
  // Unlabeled: the results root (also outside any vexp --output dir).
  assert.equal(productV2ProbeDir("/results", null), "/results");
  assert.equal(productV2ProbeDir("/results", ""), "/results");
  // The path must NOT contain raw/vtrace.
  assert.ok(!productV2ProbeDir("/results", "canary-x").includes("raw"));
});

test("parseProductV2Response reads contextEngine, capsuleV2, and accounting", () => {
  const stdout = JSON.stringify({
    contextEngine: "v2",
    capsuleV2: { pivots: [{ path: "x.py" }] },
    accounting: {
      latencyMs: 12,
      estimatedOutputTokens: 100,
      estimatedNaiveFullFileTokens: 900,
      estimatedTokensSavedVsNaiveFullFile: 800,
      estimatedSavingsPercentVsNaiveFullFile: 88.9,
      uniqueFilesCounted: 3,
      method: "chars_div_4",
      baseline: "naive full file",
    },
  });
  const signals = parseProductV2Response(`${stdout}\n`);
  assert.equal(signals.parseOk, true);
  assert.equal(signals.contextEngine, "v2");
  assert.equal(signals.contextEngineIsV2, true);
  assert.equal(signals.capsuleV2Present, true);
  assert.equal(signals.accounting?.estimatedTokensSavedVsNaiveFullFile, 800);
});

test("parseProductV2Response treats a v1 (no-engine) response as honest negatives", () => {
  const signals = parseProductV2Response(JSON.stringify({ schemaVersion: 1, context: {} }));
  assert.equal(signals.parseOk, true);
  assert.equal(signals.contextEngine, null);
  assert.equal(signals.contextEngineIsV2, false);
  assert.equal(signals.capsuleV2Present, false);
  assert.equal(signals.accounting, null);
});

test("parseProductV2Response degrades on non-JSON and partial accounting", () => {
  assert.equal(parseProductV2Response("not json").parseOk, false);
  assert.equal(parseProductV2Response("").parseOk, false);
  // Accounting missing a required numeric field -> null, not a wrong figure.
  const partial = parseProductV2Response(
    JSON.stringify({ contextEngine: "v2", accounting: { latencyMs: 5 } }),
  );
  assert.equal(partial.contextEngineIsV2, true);
  assert.equal(partial.accounting, null);
});
