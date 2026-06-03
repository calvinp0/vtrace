import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildPrompt,
  buildSharedInstruction,
  comparePairs,
  computeCcusageDelta,
  computePromptPair,
  parseCcusageSnapshot,
  qualityScore,
  renderPrepareMarkdown,
  scoreResponseJson,
  type IngestRow,
} from "./run_arc_stage3_agent_usage";
import type { ArcStage2Task, ExpectedTarget } from "../arc_stage2_orientation/run_arc_stage2_orientation";

const TASK: ArcStage2Task = {
  id: "workflow_arkane_input",
  category: "workflow",
  task: "Identify where Arkane input files are written or rendered.",
  query: "where is Arkane input written",
};

const EXPECTED: ExpectedTarget = {
  expected_paths: ["arc/statmech/arkane.py"],
  expected_symbols: ["render_arkane_input_template", "ArkaneAdapter.render_arkane_input_template"],
};

test("prompt generation creates baseline and vtrace condition prompts", () => {
  const pair = computePromptPair(TASK, "grep context", "vtrace context");

  assert.match(pair.baselinePrompt, /## Provided context: grep snippets/);
  assert.match(pair.vtracePrompt, /## Provided context: vtrace capsule/);
  assert.match(pair.baselinePrompt, /Do not use vtrace or MCP tools/);
  assert.match(pair.vtracePrompt, /Use the provided vtrace capsule/);
  assert.equal(pair.baselinePromptEstTokens, Math.ceil(pair.baselinePrompt.length / 4));
  assert.equal(pair.vtracePromptEstTokens, Math.ceil(pair.vtracePrompt.length / 4));
});

test("shared instruction is identical across conditions except condition context", () => {
  const baseline = buildPrompt(TASK, "baseline", "grep context");
  const vtrace = buildPrompt(TASK, "vtrace", "vtrace context");
  const shared = buildSharedInstruction(TASK);

  assert.equal(baseline.startsWith(shared), true);
  assert.equal(vtrace.startsWith(shared), true);
  assert.match(shared, /Use only the provided context\. Do not edit files\. Do not run commands\./);
  assert.match(shared, /Return JSON only with this shape:/);
});

test("ccusage parser handles mocked Claude-style session data", () => {
  const parsed = parseCcusageSnapshot({
    sessions: [
      {
        sessionId: "claude-1",
        model: "claude-sonnet-4",
        inputTokens: 100,
        outputTokens: 25,
        cacheCreationTokens: 10,
        cacheReadTokens: 40,
        totalTokens: 175,
        costUSD: 0.12,
      },
    ],
    totals: {
      inputTokens: 100,
      outputTokens: 25,
      cacheCreationTokens: 10,
      cacheReadTokens: 40,
      totalTokens: 175,
      costUSD: 0.12,
    },
  });

  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0]!.sessionId, "claude-1");
  assert.equal(parsed.sessions[0]!.model, "claude-sonnet-4");
  assert.equal(parsed.aggregate.totalTokens, 175);
  assert.equal(parsed.aggregate.costUsd, 0.12);
});

test("ccusage parser handles mocked Codex-style session data", () => {
  const parsed = parseCcusageSnapshot({
    data: {
      rows: [
        {
          id: "codex-1",
          model_name: "gpt-5-codex",
          input_tokens: 200,
          output_tokens: 50,
          cache_creation_tokens: 15,
          cache_read_tokens: 35,
          total_tokens: 300,
          cost_usd: 0.2,
        },
      ],
      summary: {
        input_tokens: 200,
        output_tokens: 50,
        cache_creation_tokens: 15,
        cache_read_tokens: 35,
        total_tokens: 300,
        cost_usd: 0.2,
      },
    },
  });

  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0]!.sessionId, "codex-1");
  assert.equal(parsed.sessions[0]!.model, "gpt-5-codex");
  assert.equal(parsed.aggregate.totalTokens, 300);
});

test("ccusage parser sums sessions when no separate aggregate object exists", () => {
  const parsed = parseCcusageSnapshot({
    sessions: [
      { sessionId: "one", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { sessionId: "two", inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    ],
  });

  assert.equal(parsed.aggregate.inputTokens, 30);
  assert.equal(parsed.aggregate.outputTokens, 15);
  assert.equal(parsed.aggregate.totalTokens, 45);
});

test("aggregate before/after delta calculation works without session IDs", () => {
  const delta = computeCcusageDelta(
    { totals: { input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 0.1 } },
    { totals: { input_tokens: 180, output_tokens: 70, total_tokens: 250, cost_usd: 0.18 } },
  );

  assert.equal(delta.method, "aggregate_difference");
  assert.equal(delta.inputTokens, 80);
  assert.equal(delta.outputTokens, 20);
  assert.equal(delta.totalTokens, 100);
  assert.equal(delta.costUsd.toFixed(2), "0.08");
});

test("new-session delta calculation uses the newly added session row", () => {
  const delta = computeCcusageDelta(
    { sessions: [{ sessionId: "old", inputTokens: 10, outputTokens: 5, totalTokens: 15 }] },
    { sessions: [
      { sessionId: "old", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { sessionId: "new", model: "claude-sonnet-4", inputTokens: 80, outputTokens: 20, totalTokens: 100, costUSD: 0.05 },
    ] },
  );

  assert.equal(delta.method, "new_session");
  assert.equal(delta.sessionId, "new");
  assert.equal(delta.model, "claude-sonnet-4");
  assert.equal(delta.totalTokens, 100);
});

test("multiple new sessions are ambiguous unless aggregate fallback is allowed", () => {
  const delta = computeCcusageDelta(
    { sessions: [{ sessionId: "old", inputTokens: 10, outputTokens: 5, totalTokens: 15 }] },
    { sessions: [
      { sessionId: "old", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { sessionId: "new-a", inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      { sessionId: "new-b", inputTokens: 30, outputTokens: 5, totalTokens: 35 },
    ] },
  );

  assert.equal(delta.method, "unavailable");
  assert.equal(delta.ambiguous, true);
  assert.match(delta.notes.join("; "), /multiple new sessions found: 2/);
});

test("response JSON scoring covers strong acceptable weak missing and invalid", () => {
  assert.equal(scoreResponseJson({ target_file: "arc/statmech/arkane.py", target_symbol: null }, EXPECTED).quality, "strong");
  assert.equal(scoreResponseJson({ target_file: "arc/statmech/helper.py", target_symbol: null }, EXPECTED).quality, "acceptable");
  assert.equal(scoreResponseJson({ target_file: "arc/common.py", target_symbol: "helper" }, EXPECTED).quality, "weak");
  assert.equal(scoreResponseJson({ target_file: null, target_symbol: null }, EXPECTED).quality, "missing");
  assert.equal(scoreResponseJson("not-object", EXPECTED).quality, "invalid");
  assert.equal(scoreResponseJson({ target_file: null, target_symbol: "ArkaneAdapter.render_arkane_input_template" }, EXPECTED).quality, "strong");
});

test("pair comparison computes token reduction", () => {
  const pairs = comparePairs([
    makeRow("baseline", 100, "acceptable"),
    makeRow("vtrace", 40, "acceptable"),
  ]);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.actualTotalTokenReductionPct, 60);
  assert.equal(pairs[0]!.qualityPreserving, true);
});

test("quality-preserving reduction is null when vtrace quality regresses", () => {
  const pairs = comparePairs([
    makeRow("baseline", 100, "strong"),
    makeRow("vtrace", 40, "weak"),
  ]);

  assert.equal(pairs[0]!.actualTotalTokenReductionPct, 60);
  assert.equal(pairs[0]!.qualityPreserving, false);
  assert.equal(pairs[0]!.qualityPreservingActualReductionPct, null);
});

test("quality scores follow benchmark ordering", () => {
  assert.equal(qualityScore("invalid"), 0);
  assert.equal(qualityScore("missing"), 0);
  assert.equal(qualityScore("weak"), 1);
  assert.equal(qualityScore("acceptable"), 2);
  assert.equal(qualityScore("strong"), 3);
});

test("markdown prepare-mode summary avoids actual ccusage claims", () => {
  const pair = computePromptPair(TASK, "a".repeat(400), "b".repeat(100));
  const markdown = renderPrepareMarkdown([pair], {
    arcRepoPath: "/home/calvin/code/ARC",
    agentSource: "claude",
  });

  assert.match(markdown, /Prompts generated: 2/);
  assert.match(markdown, /No actual ccusage claims are made yet/);
  assert.match(markdown, /Estimated prompt token comparison/);
});

function makeRow(condition: "baseline" | "vtrace", totalTokens: number, quality: "strong" | "acceptable" | "weak"): IngestRow {
  return {
    taskId: TASK.id,
    condition,
    agentSource: "claude",
    model: "claude-sonnet-4",
    sessionId: `${TASK.id}.${condition}`,
    deltaMethod: "new_session",
    promptEstTokens: 10,
    actualInputTokens: totalTokens - 10,
    actualOutputTokens: 10,
    actualCacheCreationTokens: 0,
    actualCacheReadTokens: 0,
    actualTotalTokens: totalTokens,
    actualCostUsd: 0.01,
    responseQuality: quality,
    responseQualityScore: qualityScore(quality),
    targetFile: "arc/statmech/arkane.py",
    targetSymbol: "render_arkane_input_template",
    matchedExpectedPath: "arc/statmech/arkane.py",
    matchedExpectedSymbol: "render_arkane_input_template",
    parseError: null,
    notes: [],
  };
}
