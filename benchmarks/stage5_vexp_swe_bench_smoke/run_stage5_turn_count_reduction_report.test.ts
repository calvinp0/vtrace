// Tests for the Stage 5 turn-count reduction policy:
//   * STAGE5_TOKEN_DISCIPLINE block injection (strong vs weak Capsule v2 context),
//   * the pure turn-count-waste scorer,
//   * the read-only intervention report.
// All fixtures/mocks — NO Docker, model, or agent calls occur.

import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  analyzeTurnCountWaste,
  DEFAULT_PRE_EDIT_BASH_BUDGET,
  DEFAULT_PRE_EDIT_SEARCH_BUDGET,
} from "../../src/capsule/turnCountWaste";
import type { OrderedToolCall } from "../../src/capsule/toolCallLog";
import {
  buildTokenDisciplineBlock,
  buildVtraceContextMarkdown,
  classifyContextStrength,
  detectTokenDisciplineText,
  TOKEN_DISCIPLINE_MARKER,
  type VtraceContextSection,
} from "./run_stage5_vexp_swe_bench_smoke";
import {
  analyzeReductionCase,
  buildTurnCountReductionReport,
  renderMarkdown,
  type ReductionCaseInput,
} from "./run_stage5_turn_count_reduction_report";

// ---- fixtures -------------------------------------------------------------

function call(
  index: number,
  tool: string,
  category: OrderedToolCall["category"],
  extra: Partial<OrderedToolCall> = {},
): OrderedToolCall {
  return {
    index,
    tool,
    category,
    path: extra.path ?? null,
    query: extra.query ?? null,
    args: extra.args ?? {},
    output_summary: extra.output_summary ?? null,
  };
}

const STRONG_INSTANCE = {
  instanceId: "matplotlib__matplotlib-22719",
  repo: "matplotlib/matplotlib",
  baseCommit: "abc123",
} as unknown as VtraceContextSection["instance"];

function strongSection(): VtraceContextSection {
  return {
    instance: STRONG_INSTANCE,
    rawContext: "## pivot\nlib/matplotlib/axis.py :: _update_ticks\n(some focused source body)\n",
    error: null,
    preformatted: true,
    classification: {
      capsulePivots: [
        { path: "lib/matplotlib/axis.py", symbol: "_update_ticks", roleReason: "source line anchor", estimatedTokens: 100 },
      ],
      capsuleSupport: [
        { path: "lib/matplotlib/ticker.py", symbol: "Locator", roleReason: "support", estimatedTokens: 50 },
      ],
    } as unknown as VtraceContextSection["classification"],
  };
}

function weakSection(): VtraceContextSection {
  return {
    instance: STRONG_INSTANCE,
    rawContext: "(vtrace context unavailable: empty output)",
    error: "no high-confidence pivot recovered",
    preformatted: false,
    classification: {
      capsulePivots: null,
      capsuleSupport: null,
    } as unknown as VtraceContextSection["classification"],
  };
}

// A 30-call run mirroring the matplotlib-22719 blowup: 16 Bash, 9 Read, 4 search,
// 1 edit, with repeated reads/searches.
function matplotlibToolCalls(): OrderedToolCall[] {
  const calls: OrderedToolCall[] = [];
  let i = 0;
  for (let r = 0; r < 9; r += 1) {
    // Two distinct files re-read several times → repeated reads.
    const p = r % 2 === 0 ? "axis.py" : "ticker.py";
    calls.push(call(i++, "Read", "read", { path: p }));
  }
  for (let g = 0; g < 4; g += 1) {
    calls.push(call(i++, "Grep", "search", { query: g % 2 === 0 ? "Locator" : "set_ticks" }));
  }
  for (let b = 0; b < 16; b += 1) {
    calls.push(call(i++, "Bash", "other", { args: { command: `ls dir${b}` } }));
  }
  calls.push(call(i++, "Edit", "edit", { path: "axis.py" }));
  return calls;
}

// A small clean run: read the pivot, patch. No loops.
function cleanToolCalls(): OrderedToolCall[] {
  return [
    call(0, "Read", "read", { path: "axis.py" }),
    call(1, "Edit", "edit", { path: "axis.py" }),
  ];
}

// ---- Part 2/3: token-discipline injection --------------------------------

test("1. token-discipline block is injected for strong Capsule v2 context", () => {
  const assembled = buildVtraceContextMarkdown([strongSection()], {
    maxChars: 100_000,
    maxItems: 1_000,
    injectTokenDiscipline: true,
  });
  assert.ok(detectTokenDisciplineText(assembled.markdown), "marker present in assembled markdown");
  assert.equal(assembled.tokenDisciplineInjected, true);
  assert.equal(assembled.tokenDisciplineMode, "strong_context_patch_first");
});

test("2. weak context gets weaker/exploratory guidance, not patch-first", () => {
  const strength = classifyContextStrength(weakSection());
  assert.equal(strength.strongContext, false);
  assert.equal(strength.mode, "weak_context_explore");
  const block = buildTokenDisciplineBlock("weak_context_explore");
  assert.ok(block !== null);
  assert.match(block!, /more exploration is warranted/i);
  assert.ok(!/patch first/i.test(block!), "weak block does not force patch-first");
});

test("3. strong-context guidance includes the pre-edit search budget", () => {
  const block = buildTokenDisciplineBlock("strong_context_patch_first");
  assert.ok(block !== null);
  assert.match(block!, new RegExp(`At most ${DEFAULT_PRE_EDIT_SEARCH_BUDGET} search/grep/read calls before the first edit`));
});

test("4. strong-context guidance includes the pre-edit Bash budget", () => {
  const block = buildTokenDisciplineBlock("strong_context_patch_first");
  assert.ok(block !== null);
  assert.match(block!, new RegExp(`At most ${DEFAULT_PRE_EDIT_BASH_BUDGET} Bash inspection command before the first edit`));
});

test("5. strong-context guidance says patch before broad rediscovery", () => {
  const block = buildTokenDisciplineBlock("strong_context_patch_first");
  assert.ok(block !== null);
  assert.match(block!, /patch first; do not rediscover it with grep/i);
  assert.match(block!, /make the minimal patch before doing more search/i);
});

test("strong context classification requires lead pivot + file + support + injected", () => {
  assert.equal(classifyContextStrength(strongSection()).strongContext, true);
  // Drop support → weak.
  const noSupport = strongSection();
  (noSupport.classification as { capsuleSupport: unknown }).capsuleSupport = [];
  assert.equal(classifyContextStrength(noSupport).strongContext, false);
});

test("token-discipline block is NOT injected when the caller does not opt in", () => {
  const assembled = buildVtraceContextMarkdown([strongSection()], {
    maxChars: 100_000,
    maxItems: 1_000,
  });
  assert.equal(assembled.tokenDisciplineInjected, false);
  assert.equal(assembled.tokenDisciplineMode, "disabled");
  assert.ok(!assembled.markdown.includes(TOKEN_DISCIPLINE_MARKER));
});

// ---- Part 4: turn-count scorer -------------------------------------------

test("6. scorer flags repeated grep/read loops", () => {
  const calls = [
    call(0, "Read", "read", { path: "a.py" }),
    call(1, "Read", "read", { path: "a.py" }),
    call(2, "Grep", "search", { query: "foo" }),
    call(3, "Grep", "search", { query: "foo" }),
  ];
  const result = analyzeTurnCountWaste(calls, { strongContext: false });
  assert.ok(result.repeatedFileReads >= 1, "repeated read counted");
  assert.ok(result.repeatedSearches >= 1, "repeated search counted");
  assert.notEqual(result.tokenReductionRisk, "low");
});

test("7. scorer flags long Bash loops as high risk", () => {
  const calls = Array.from({ length: 10 }, (_, i) => call(i, "Bash", "other", { args: { command: `echo ${i}` } }));
  const result = analyzeTurnCountWaste(calls, { strongContext: false });
  assert.equal(result.longBashLoopHeuristic, true);
  assert.equal(result.tokenReductionRisk, "high");
});

test("8. scorer flags strong-context oversearch", () => {
  const result = analyzeTurnCountWaste(matplotlibToolCalls(), {
    strongContext: true,
    tokenDeltaPct: 132.7,
    cacheReadShareOfPositiveDelta: 0.96,
  });
  assert.equal(result.strongContextOversearch, true);
  assert.equal(result.tokenReductionRisk, "high");
  assert.equal(result.likelyCacheReadAmplification, true);
});

test("scorer rates a clean read-then-patch run as low risk", () => {
  const result = analyzeTurnCountWaste(cleanToolCalls(), { strongContext: true, tokenDeltaPct: -10 });
  assert.equal(result.tokenReductionRisk, "low");
  assert.equal(result.strongContextOversearch, false);
  assert.equal(result.preEditToolCalls, 1);
});

// ---- Part 5: report -------------------------------------------------------

function matplotlibInput(): ReductionCaseInput {
  return {
    instanceId: "matplotlib__matplotlib-22719",
    vtraceRunLabel: "eval-controlled-vtrace-matplotlib-22719",
    tokenDelta: 1_550_405,
    tokenDeltaPct: 132.7,
    cacheReadDelta: 1_523_668,
    strongContext: true,
    toolCalls: matplotlibToolCalls(),
  };
}

function djangoNoTelemetryInput(pct: number): ReductionCaseInput {
  return {
    instanceId: "django__django-11095",
    vtraceRunLabel: "eval-11095",
    tokenDelta: 464_000,
    tokenDeltaPct: pct,
    cacheReadDelta: 450_855,
    strongContext: false,
    toolCalls: null,
  };
}

test("9. report identifies matplotlib-22719 as high risk from fixture telemetry", () => {
  const c = analyzeReductionCase(matplotlibInput());
  assert.equal(c.risk, "high");
  assert.equal(c.turnCountCaused, true);
  assert.equal(c.wouldGetPatchFirst, true);
  assert.equal(c.wouldBeCappedByBudget, true);
  assert.equal(c.needsRerun, false);
  assert.ok(c.waste !== null && c.waste.bashCount === 16);
});

test("10. report marks telemetry-less django case as unknown / needs rerun", () => {
  const c = analyzeReductionCase(djangoNoTelemetryInput(86.5));
  assert.equal(c.hasTelemetry, false);
  assert.equal(c.risk, "unknown");
  assert.equal(c.needsRerun, true);
  assert.equal(c.turnCountCaused, false);
});

test("a telemetry-less SAVING (negative delta) is a gap but not a needed rerun", () => {
  const c = analyzeReductionCase({
    instanceId: "django__django-11490",
    vtraceRunLabel: "eval-11490",
    tokenDelta: -1_360_000,
    tokenDeltaPct: -29.2,
    cacheReadDelta: -1_343_520,
    strongContext: false,
    toolCalls: null,
  });
  assert.equal(c.hasTelemetry, false);
  assert.equal(c.needsRerun, false);
  assert.equal(c.isOverhead, false);
});

test("report aggregates and renders all required Markdown sections", () => {
  const report = buildTurnCountReductionReport([matplotlibInput(), djangoNoTelemetryInput(86.5)]);
  assert.equal(report.summary.caseCount, 2);
  assert.equal(report.summary.highRiskCount, 1);
  assert.equal(report.summary.needsRerunCount, 1);
  assert.ok(report.summary.highRiskInstances.includes("matplotlib__matplotlib-22719"));

  const md = renderMarkdown(report);
  for (const section of [
    "# Stage 5 turn-count reduction policy",
    "## Summary",
    "## Token-path audit finding",
    "## Policy added",
    "## Strong-context patch-first mode",
    "## Historical overhead cases",
    "## Expected token impact",
    "## Telemetry gaps",
    "## Recommended rerun",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(section), `missing section: ${section}`);
  }
  // Required interpretation + non-claims wording.
  assert.match(md, /turn-count\/cache-read amplification problem, not a capsule-size problem/);
  assert.match(md, /patch from the capsule before broad rediscovery/);
  assert.match(md, /does not prove a new token-reduction percentage/);
  assert.match(md, /does not run agents or Docker/);
  assert.match(md, /does not claim the loop issue is solved until paired reruns/);
  assert.match(md, /does not change generated-parser repair accounting/);
});
