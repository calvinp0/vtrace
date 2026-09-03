// Capsule v2 product-output tests.
//
// Drives the full v2 pipeline (intent -> generators -> scorecards -> roles ->
// budget -> renderer) over an on-disk fixture repo and asserts the product
// contract: pivots carry focused source, support is skeletonised, the token
// budget is respected, a centrality-only hub is never a pivot, a failing test
// routes to its implementation, doc sections can appear as support, the JSON
// surface carries full diagnostics, and the human output matches the product
// shape. No benchmark instance ids or expected paths reach the pipeline.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildCapsuleV2 } from "./buildCapsuleV2";
import { renderCapsuleV2Human } from "./renderHuman";
import { retrieveDocSections } from "./docRetrieval";
import { formatThousands } from "./renderHuman";
import {
  CapsuleIntent,
  CapsuleV2ContentMode,
  CapsuleV2Mode,
  type CapsuleV2Result,
} from "./types";
import {
  INLINES_TASK,
  seedCapsuleV2Fixture,
} from "./__fixtures__/capsuleV2Fixture";

const SCORECARD_KEYS = [
  "lexical",
  "symbol",
  "path",
  "test_to_impl",
  "body_literal",
  "graph_proximity",
  "centrality",
  "actionability",
  "hub_penalty",
  "direct_answer",
  // M150: bounded behavioural-mechanism evidence. Always present, 0 for any
  // request that declares no operation.
  "mechanism_evidence",
  "final",
] as const;

function buildInlines(maxTokens: number, intent: CapsuleIntent = CapsuleIntent.Auto): CapsuleV2Result {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  try {
    return buildCapsuleV2({ db, repoRoot, task: INLINES_TASK, intent, maxTokens });
  } finally {
    db.close();
  }
}

test("capsule contains pivot and support sections", () => {
  const result = buildInlines(8_000);
  assert.equal(result.actual_mode, CapsuleV2Mode.Standard);
  assert.ok(result.pivots.length >= 1, "expected at least one pivot");
  assert.ok(result.support.length >= 1, "expected at least one support item");

  // The lead pivot is the implementation the failing test exercises.
  const lead = result.pivots[0]!;
  assert.equal(lead.role, "pivot");
  assert.equal(lead.path, "pkg/options.py");
  assert.equal(lead.symbol, "get_inline_instances");
});

test("pivots include focused source; support is skeletonised (no body)", () => {
  const result = buildInlines(8_000);

  const sourcePivot = result.pivots.find(
    (p) => p.content_mode === CapsuleV2ContentMode.Full && (p.source ?? "").includes("def get_inline_instances"),
  );
  assert.ok(sourcePivot, "a pivot must carry focused source for the edit target");

  // Support never carries a source body — only a signature or skeleton.
  for (const item of result.support) {
    assert.notEqual(item.content_mode, CapsuleV2ContentMode.Full, `${item.symbol} support must not be full source`);
    assert.equal(item.source, undefined, `${item.symbol} support must have no source body`);
    assert.ok(
      item.content_mode === CapsuleV2ContentMode.Signature
        || item.content_mode === CapsuleV2ContentMode.Skeleton,
      `${item.symbol} support must be a signature or skeleton`,
    );
  }
});

test("token budget is respected across micro / standard / full tiers", () => {
  const micro = buildInlines(500);
  const standard = buildInlines(8_000);
  const full = buildInlines(20_000);

  assert.equal(micro.actual_mode, CapsuleV2Mode.Micro);
  assert.equal(standard.actual_mode, CapsuleV2Mode.Standard);
  assert.equal(full.actual_mode, CapsuleV2Mode.Full);

  for (const result of [micro, standard, full]) {
    assert.ok(
      result.budget.estimated_tokens <= result.budget.max_tokens,
      `estimated ${result.budget.estimated_tokens} must not exceed budget ${result.budget.max_tokens}`,
    );
    // The reported total equals the sum of the rendered items it accounts for.
    const summed = [...result.pivots, ...result.support].reduce((sum, item) => sum + item.estimated_tokens, 0);
    assert.equal(result.budget.estimated_tokens, summed);
  }

  // Micro is decisive on the EDIT TARGET: one pivot. Support is bounded by the
  // token budget, not by a count (M206), so what is asserted is that every
  // packed item fits and nothing ranked was discarded merely for being past a
  // count.
  assert.equal(micro.pivots.length, 1);
  for (const result of [micro, standard, full]) {
    assert.ok(
      result.discarded.every((d) => !/^beyond \w+ support budget/.test(d.discard_reason)),
      "no ranked support candidate is discarded for a tier item count",
    );
  }
});

test("support admission is governed by the token budget, not by a tier count", () => {
  // The standard tier's historical count was 4 support items. With the count
  // gone, every support-authorised candidate that fits the budget is packed,
  // in rank order, and a candidate that does not fit is discarded for the
  // budget with that reason.
  const standard = buildInlines(8_000);
  assert.ok(standard.support.length >= 1, "support is delivered");
  const summed = [...standard.pivots, ...standard.support].reduce((sum, item) => sum + item.estimated_tokens, 0);
  assert.ok(summed <= standard.budget.max_tokens, "packed items fit the budget");
  const countBound = standard.discarded.filter((d) => /support budget \(max/.test(d.discard_reason));
  assert.equal(countBound.length, 0, "no count-bound discard exists any more");
  // A budget too small for anything but the lead pivot's skeleton discards for the budget, never for a count.
  const tiny = buildInlines(60);
  assert.equal(tiny.pivots.length, 1, "the lead pivot is always emitted");
  assert.ok(tiny.discarded.every((d) => !/support budget \(max/.test(d.discard_reason)));
  assert.ok(
    tiny.discarded.some((d) => d.discard_reason === "over budget: no room for this support item")
      || tiny.support.length === 0,
    "what a tiny budget cannot hold is discarded for the budget",
  );
});

test("a centrality-only hub is never a pivot, at any budget", () => {
  for (const budget of [500, 8_000, 20_000]) {
    const result = buildInlines(budget);
    assert.ok(
      result.pivots.every((p) => p.symbol !== "AppConfig"),
      `AppConfig (generic hub) must never be a pivot at budget ${budget}`,
    );
  }

  // At standard budget the hub is reachable (graph + centrality) but lands as
  // support at most — and its scorecard shows the centrality without a pivot.
  const standard = buildInlines(8_000);
  const hub = [...standard.support, ...standard.discarded].find((item) => item.symbol === "AppConfig");
  assert.ok(hub, "the hub should be retrieved as support or discarded, not silently dropped");
});

test("a failing test routes to its implementation as the pivot", () => {
  const result = buildInlines(8_000);

  // Intent auto-resolves to test-failure from the named failing test.
  assert.equal(result.intent, CapsuleIntent.TestFailure);
  assert.ok(result.diagnostics.failing_tests.length >= 1, "the failing test must be detected");

  const lead = result.pivots[0]!;
  assert.equal(lead.symbol, "get_inline_instances");
  assert.ok(
    lead.evidence.some((line) => /failing test/i.test(line)),
    `the pivot's evidence must cite the failing-test route, got ${JSON.stringify(lead.evidence)}`,
  );
});

test("documentation sections can appear as support", () => {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  try {
    // The doc retriever surfaces the matching section and ignores the unrelated one.
    const sections = retrieveDocSections(repoRoot, "get_inlines inline instances ModelAdmin", 5);
    assert.ok(sections.some((s) => s.heading === "Overriding inline instances"));
    assert.ok(sections.every((s) => s.heading !== "Unrelated section"));

    const result = buildCapsuleV2({ db, repoRoot, task: INLINES_TASK, intent: CapsuleIntent.Auto, maxTokens: 8_000 });
    const doc = result.support.find((item) => item.kind === "markdown_section");
    assert.ok(doc, "a markdown section should appear as support");
    assert.equal(doc?.content_mode, CapsuleV2ContentMode.Signature);
    assert.ok((doc?.signature ?? "").length > 0, "the doc support must carry a section summary");
  } finally {
    db.close();
  }
});

test("JSON output contains full diagnostics and snake_case scorecards", () => {
  const result = buildInlines(8_000);

  // Budget block.
  assert.equal(result.budget.max_tokens, 8_000);
  assert.ok(typeof result.budget.estimated_tokens === "number");
  assert.ok(result.budget.used_percent >= 0 && result.budget.used_percent <= 100);

  // Diagnostics block carries every field a consumer relies on.
  const d = result.diagnostics;
  assert.ok(d.intent_reason.length > 0);
  assert.ok(d.candidate_count > 0);
  assert.equal(d.pivot_count, result.pivots.length);
  assert.equal(d.support_count, result.support.length);
  assert.equal(d.discarded_count, result.discarded.length);
  assert.equal(d.tier, result.actual_mode);
  assert.ok(typeof d.weights.testToImpl === "number");
  assert.ok(Array.isArray(d.likely_files) && Array.isArray(d.likely_symbols));
  assert.ok(d.failing_tests.length >= 1);

  // Every selected and discarded item exposes the full snake_case scorecard.
  for (const item of [...result.pivots, ...result.support, ...result.discarded]) {
    assert.deepEqual(Object.keys(item.scorecard).sort(), [...SCORECARD_KEYS].sort());
    assert.ok(item.evidence.length > 0, `${item.symbol} must carry evidence`);
  }

  // The result round-trips as JSON without loss.
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("no_context is returned when no high-confidence edit target exists", () => {
  // Sanity: the real task DOES find a pivot, so no_context is meaningful.
  assert.notEqual(buildInlines(8_000).actual_mode, CapsuleV2Mode.NoContext);

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
    assert.equal(empty.reason, "no high-confidence edit target recovered");
    assert.equal(empty.pivots.length, 0);
    assert.equal(empty.support.length, 0);
    assert.equal(empty.budget.estimated_tokens, 0);
  } finally {
    db.close();
  }
});

test("human output resembles the product example", () => {
  const result = buildInlines(8_000);
  const human = renderCapsuleV2Human(result);

  assert.match(human, /^intent: test-failure \((high|medium|low) confidence\)$/m);
  assert.match(human, /^budget: [\d,]+ \/ 8,000 tokens used$/m);
  assert.match(human, /^● pivot pkg\/options\.py::get_inline_instances$/m);
  assert.match(human, /^ {2}reason:$/m);
  assert.match(human, /^ {2}source:$/m);
  assert.match(human, /def get_inline_instances/);
  assert.match(human, /^○ support /m);
});

test("no_context human output states the actual_mode and reason", () => {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  try {
    const empty = buildCapsuleV2({
      db,
      repoRoot,
      task: "zzqq nonexistent xyzzy gibberish wibble frobnicate",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    const human = renderCapsuleV2Human(empty);
    assert.match(human, /^actual_mode: no_context$/m);
    assert.match(human, /^reason: no high-confidence edit target recovered$/m);
  } finally {
    db.close();
  }
});

test("an explicit intent overrides auto-detection and reweights retrieval", () => {
  const refactor = buildInlines(8_000, CapsuleIntent.Refactor);
  assert.equal(refactor.intent, CapsuleIntent.Refactor);
  assert.ok(refactor.diagnostics.intent_reason.some((r) => /explicitly/.test(r)));
  // Refactor leans on symbol identity.
  assert.equal(refactor.diagnostics.weights.symbol, 1.4);
});

test("assembly is deterministic — identical inputs yield identical output", () => {
  const first = buildInlines(8_000);
  const second = buildInlines(8_000);
  assert.deepEqual(first, second);
});

test("formatThousands groups digits deterministically", () => {
  assert.equal(formatThousands(0), "0");
  assert.equal(formatThousands(8_000), "8,000");
  assert.equal(formatThousands(2_140), "2,140");
  assert.equal(formatThousands(1_234_567), "1,234,567");
});
