import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildAggregate,
  buildReport,
  buildRiskToStrictDeltas,
  buildTask,
  chooseRecommendation,
  parseArgs,
  renderJson,
  renderMarkdown,
  suppressionClaimableOf,
  toRunView,
  TASK_SEEDS,
  SUPPRESSION_CLAIMABLE_STATEMENT,
  EFFICIENCY_STATEMENT,
} from "./run_stage5_strictgated_3task_report";
import { buildRunUsage, type RawRunParts } from "./run_stage5_riskgated_matplotlib_comparison";

// ---------------------------------------------------------------------------
// Fixtures — synthetic parts, never live raw artifacts. Usage/cost/resolution live ONLY in
// `record` (JSONL row); policy metadata ONLY in `meta` (_run.meta.json).
// ---------------------------------------------------------------------------

const REPO = ".bench-repos/x";

function row(opts: {
  instanceId: string;
  cost: number;
  inputTokens: number;
  cacheReadTokens: number;
  numTurns: number;
  toolCalls: Record<string, number>;
  resolved: boolean;
}): Record<string, unknown> {
  return {
    instanceId: opts.instanceId,
    inputTokens: opts.inputTokens,
    outputTokens: 100,
    cacheReadTokens: opts.cacheReadTokens,
    cacheCreationTokens: 50_000,
    costUsd: opts.cost,
    numTurns: opts.numTurns,
    toolCalls: opts.toolCalls,
    modelPatch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    resolved: opts.resolved,
  };
}

function toolLog(n: number): { category: string | null; path: string | null }[] {
  return Array.from({ length: n }, (_, i) => ({ category: "read", path: `${REPO}/f${i}.py` }));
}

// risk_gated meta: PIVOT_CHECK still injected (hidden_pivot forces it on under risk_gated).
function riskMeta(toolCount: number): Record<string, unknown> {
  return {
    vtracePivotCheckInjected: true,
    vtracePivotCheckPolicy: "risk_gated",
    vtracePivotCheckPolicyReason: "risk_gated: risk signals [hidden_pivot]",
    vtracePivotCheckRiskSignals: ["hidden_pivot"],
    vtracePivotCheckWouldInjectUnderMultiPivot: true,
    vtraceEditGuardInjected: false,
    vtracePatchVerifyInjected: false,
    vtraceToolCallCount: toolCount,
  };
}

// strict_risk_gated meta: PIVOT_CHECK suppressed (hidden_pivot alone is insufficient).
function strictMeta(toolCount: number): Record<string, unknown> {
  return {
    vtracePivotCheckInjected: false,
    vtracePivotCheckPolicy: "strict_risk_gated",
    vtracePivotCheckPolicyReason:
      "strict_risk_gated: no strong risk signal (hidden_pivot alone is insufficient)",
    vtracePivotCheckRiskSignals: ["hidden_pivot"],
    vtracePivotCheckWouldInjectUnderMultiPivot: true,
    vtraceEditGuardInjected: false,
    vtracePatchVerifyInjected: false,
    vtraceToolCallCount: toolCount,
  };
}

// matplotlib (real-shaped): risk & strict both resolved; strict cheaper and fewer turns/calls.
const MPL_OLD: RawRunParts = {
  runLabel: "eval-controlled-vtrace-matplotlib-22719",
  meta: { vtracePivotCheckInjected: true, vtraceToolCallCount: 40 },
  evalMeta: { evaluationRan: true, dockerUsed: true, resolvedCount: 0 },
  record: row({ instanceId: "matplotlib__matplotlib-22719", cost: 0.9627, inputTokens: 491, cacheReadTokens: 2_632_899, numTurns: 69, toolCalls: { Read: 9, Bash: 16 }, resolved: false }),
  toolCalls: toolLog(40),
};
const MPL_RISK: RawRunParts = {
  runLabel: "eval-riskgated-vtrace-matplotlib-22719",
  meta: riskMeta(34),
  evalMeta: { evaluationRan: true, dockerUsed: true, resolvedCount: 1 },
  record: row({ instanceId: "matplotlib__matplotlib-22719", cost: 0.7695, inputTokens: 300, cacheReadTokens: 1_227_272, numTurns: 34, toolCalls: { Read: 6, Bash: 8 }, resolved: true }),
  toolCalls: toolLog(34),
};
const MPL_STRICT: RawRunParts = {
  runLabel: "eval-strictgated-vtrace-matplotlib-22719",
  meta: strictMeta(30),
  evalMeta: { evaluationRan: true, dockerUsed: true, resolvedCount: 1 },
  record: row({ instanceId: "matplotlib__matplotlib-22719", cost: 0.4900, inputTokens: 216, cacheReadTokens: 1_008_825, numTurns: 30, toolCalls: { Read: 2, Bash: 7 }, resolved: true }),
  toolCalls: toolLog(30),
};

// astropy: unresolved in both risk & strict; strict cheaper.
const ASTRO_OLD: RawRunParts = {
  runLabel: "eval-controlled-vtrace-astropy-14369",
  meta: { vtracePivotCheckInjected: true, vtraceToolCallCount: 50 },
  evalMeta: { evaluationRan: true, resolvedCount: 0 },
  record: row({ instanceId: "astropy__astropy-14369", cost: 1.9, inputTokens: 300, cacheReadTokens: 4_000_000, numTurns: 80, toolCalls: { Read: 10 }, resolved: false }),
  toolCalls: toolLog(50),
};
const ASTRO_RISK: RawRunParts = {
  runLabel: "eval-riskgated-vtrace-astropy-14369",
  meta: riskMeta(68),
  evalMeta: { evaluationRan: true, resolvedCount: 0 },
  record: row({ instanceId: "astropy__astropy-14369", cost: 1.7340, inputTokens: 400, cacheReadTokens: 3_599_397, numTurns: 68, toolCalls: { Read: 12 }, resolved: false }),
  toolCalls: toolLog(68),
};
const ASTRO_STRICT: RawRunParts = {
  runLabel: "eval-strictgated-vtrace-astropy-14369",
  meta: strictMeta(47),
  evalMeta: { evaluationRan: true, resolvedCount: 0 },
  record: row({ instanceId: "astropy__astropy-14369", cost: 1.4102, inputTokens: 300, cacheReadTokens: 2_458_404, numTurns: 47, toolCalls: { Read: 8 }, resolved: false }),
  toolCalls: toolLog(47),
};

const MISSING: RawRunParts = { runLabel: "missing", meta: null, evalMeta: null, record: null, toolCalls: null };

// ---------------------------------------------------------------------------
// 1. Reads usage/cost/resolution from JSONL rows.
// ---------------------------------------------------------------------------

test("usage/cost/resolution come from the JSONL row", () => {
  const view = toRunView(buildRunUsage(MPL_STRICT));
  assert.equal(view.costUsd, 0.49);
  assert.equal(view.totalTokens, 216 + 100 + 1_008_825 + 50_000);
  assert.equal(view.resolved, true);
  assert.equal(view.numTurns, 30);
  assert.deepEqual(view.toolCallsByType, { Read: 2, Bash: 7 });
});

// ---------------------------------------------------------------------------
// 2. Reads policy metadata from _run.meta.json.
// ---------------------------------------------------------------------------

test("policy metadata comes from _run.meta.json", () => {
  const view = toRunView(buildRunUsage(MPL_STRICT));
  assert.equal(view.pivotCheckPolicy, "strict_risk_gated");
  assert.equal(
    view.policyReason,
    "strict_risk_gated: no strong risk signal (hidden_pivot alone is insufficient)",
  );
  assert.deepEqual(view.riskSignals, ["hidden_pivot"]);
  assert.equal(view.wouldInjectUnderMultiPivot, true);
  assert.equal(view.pivotCheckInjected, false);
  assert.equal(view.editGuardInjected, false);
  assert.equal(view.patchVerifyInjected, false);
});

// ---------------------------------------------------------------------------
// 3. Computes risk→strict token/cost/turn/tool deltas.
// ---------------------------------------------------------------------------

test("per-task risk→strict deltas", () => {
  const t = buildTask(TASK_SEEDS[0]!, "eval-controlled-vtrace-matplotlib-22719", MPL_OLD, MPL_RISK, MPL_STRICT);
  assert.equal(t.status, "complete");
  assert.equal(t.risk!.totalTokens, 300 + 100 + 1_227_272 + 50_000);
  assert.equal(t.strict!.totalTokens, 216 + 100 + 1_008_825 + 50_000);
  assert.equal(t.riskToStrict.tokenDelta, t.strict!.totalTokens! - t.risk!.totalTokens!);
  assert.ok(t.riskToStrict.tokenDelta! < 0);
  assert.ok(t.riskToStrict.costDelta! < 0);
  assert.ok(t.riskToStrict.tokenDeltaPct! < 0);
  assert.ok(t.riskToStrict.costDeltaPct! < 0);
  assert.equal(t.riskToStrict.turnDelta, 30 - 34);
  assert.equal(t.riskToStrict.orderedToolCallDelta, 30 - 34);
  assert.equal(t.riskToStrict.resolutionRegression, false);
});

test("buildRiskToStrictDeltas returns null deltas when a side is missing", () => {
  const risk = toRunView(buildRunUsage(MPL_RISK));
  const d = buildRiskToStrictDeltas(risk, null);
  assert.equal(d.tokenDelta, null);
  assert.equal(d.costDelta, null);
  assert.equal(d.turnDelta, null);
  assert.equal(d.orderedToolCallDelta, null);
  assert.equal(d.resolutionRegression, false);
});

// ---------------------------------------------------------------------------
// 4. Computes suppressionClaimable for strict.
// ---------------------------------------------------------------------------

test("suppressionClaimable requires wouldInject=true AND injected=false", () => {
  // strict: wouldInject=true, injected=false → claimable.
  assert.equal(suppressionClaimableOf(buildRunUsage(MPL_STRICT)), true);
  // risk: wouldInject=true but injected=true → NOT claimable.
  assert.equal(suppressionClaimableOf(buildRunUsage(MPL_RISK)), false);
  // injected=false but wouldInject not set → NOT claimable.
  const noWould = buildRunUsage({
    ...MPL_STRICT,
    meta: { vtracePivotCheckInjected: false, vtracePivotCheckPolicy: "strict_risk_gated" },
  });
  assert.equal(suppressionClaimableOf(noWould), false);
  // both signals absent → null.
  const blank = buildRunUsage({ ...MPL_STRICT, meta: {} });
  assert.equal(suppressionClaimableOf(blank), null);

  // surfaced on the strict view.
  assert.equal(toRunView(buildRunUsage(MPL_STRICT)).suppressionClaimable, true);
});

// ---------------------------------------------------------------------------
// 5. Aggregates three paired tasks.
// ---------------------------------------------------------------------------

test("aggregate over three paired tasks sums risk and strict and computes deltas", () => {
  const t0 = buildTask(TASK_SEEDS[0]!, "old-mpl", MPL_OLD, MPL_RISK, MPL_STRICT);
  const t1 = buildTask(TASK_SEEDS[1]!, "old-astro", ASTRO_OLD, ASTRO_RISK, ASTRO_STRICT);
  // reuse the matplotlib triple as a stand-in for requests (both resolved, strict cheaper).
  const t2 = buildTask(TASK_SEEDS[2]!, "old-req", MPL_OLD, MPL_RISK, MPL_STRICT);
  const agg = buildAggregate([t0, t1, t2]);

  assert.equal(agg.pairedCount, 3);
  assert.equal(agg.riskTotalTokens, t0.risk!.totalTokens! + t1.risk!.totalTokens! + t2.risk!.totalTokens!);
  assert.equal(agg.strictTotalTokens, t0.strict!.totalTokens! + t1.strict!.totalTokens! + t2.strict!.totalTokens!);
  assert.ok(agg.tokenDelta! < 0);
  assert.ok(agg.costDelta! < 0);
  assert.ok(agg.turnDelta! < 0);
  assert.ok(agg.orderedToolCallDelta! < 0);
  // matplotlib + requests resolved in both; astropy unresolved in both.
  assert.equal(agg.riskResolved, 2);
  assert.equal(agg.strictResolved, 2);
  assert.equal(agg.resolutionDelta, 0);
  assert.equal(agg.resolutionRegressionCount, 0);
  // every strict run suppressed PIVOT_CHECK.
  assert.equal(agg.suppressionClaimableCount, 3);
  assert.equal(agg.strictPivotCheckInjectedCount, 0);
  assert.equal(agg.strictEditGuardInjectedCount, 0);
  assert.equal(agg.strictPatchVerifyInjectedCount, 0);
});

test("aggregate only counts tasks with both risk and strict present", () => {
  const paired = buildTask(TASK_SEEDS[0]!, "old-mpl", MPL_OLD, MPL_RISK, MPL_STRICT);
  const missingStrict = buildTask(TASK_SEEDS[1]!, "old-astro", ASTRO_OLD, ASTRO_RISK, MISSING);
  const agg = buildAggregate([paired, missingStrict]);
  assert.equal(agg.pairedCount, 1);
  assert.equal(agg.riskTotalTokens, paired.risk!.totalTokens);
  assert.equal(agg.strictTotalTokens, paired.strict!.totalTokens);
  assert.equal(missingStrict.status, "missing_strict");
  assert.equal(missingStrict.strict, null);
});

// ---------------------------------------------------------------------------
// 6. Detects resolution regression.
// ---------------------------------------------------------------------------

test("detects a risk→strict resolution regression", () => {
  // risk resolved, strict did not → regression.
  const regress = buildRiskToStrictDeltas(
    toRunView(buildRunUsage(MPL_RISK)), // resolved=true
    toRunView(buildRunUsage(ASTRO_STRICT)), // resolved=false
  );
  assert.equal(regress.resolutionRegression, true);

  // both unresolved → not a regression.
  const noRegress = buildRiskToStrictDeltas(
    toRunView(buildRunUsage(ASTRO_RISK)),
    toRunView(buildRunUsage(ASTRO_STRICT)),
  );
  assert.equal(noRegress.resolutionRegression, false);

  // surfaced in the aggregate count.
  const t = buildTask(TASK_SEEDS[0]!, "x", MPL_OLD, MPL_RISK, ASTRO_STRICT);
  assert.equal(buildAggregate([t]).resolutionRegressionCount, 1);
});

// ---------------------------------------------------------------------------
// 7. Emits required Markdown sections.
// ---------------------------------------------------------------------------

test("markdown contains all required sections and interpretation statements", () => {
  const tasks = [
    buildTask(TASK_SEEDS[0]!, "old-mpl", MPL_OLD, MPL_RISK, MPL_STRICT),
    buildTask(TASK_SEEDS[1]!, "old-astro", ASTRO_OLD, ASTRO_RISK, ASTRO_STRICT),
    buildTask(TASK_SEEDS[2]!, "old-req", MPL_OLD, MPL_RISK, MPL_STRICT),
  ];
  const md = renderMarkdown(buildReport("2026-06-11T00:00:00.000Z", tasks));
  for (const heading of [
    "# Stage 5 strict-gated 3-task comparison",
    "## Summary",
    "## Aggregate risk-gated vs strict-gated",
    "## Per-task comparison",
    "## Pivot-check suppression",
    "## Tool-loop and turn-count impact",
    "## Resolution outcomes",
    "## Interpretation",
    "## Recommendation",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(md.includes(SUPPRESSION_CLAIMABLE_STATEMENT));
  assert.ok(md.includes(EFFICIENCY_STATEMENT));
  assert.ok(md.includes("This is n=3 and does not prove aggregate benchmark improvement."));
  assert.ok(
    md.includes(
      "Astropy and Requests remain unresolved; strict gating improves efficiency, not necessarily patch quality.",
    ),
  );
});

// ---------------------------------------------------------------------------
// 8. Emits required JSON shape.
// ---------------------------------------------------------------------------

test("json shape has required task, riskToStrict, strict, and aggregate fields", () => {
  const tasks = [
    buildTask(TASK_SEEDS[0]!, "old-mpl", MPL_OLD, MPL_RISK, MPL_STRICT),
    buildTask(TASK_SEEDS[1]!, "old-astro", ASTRO_OLD, ASTRO_RISK, ASTRO_STRICT),
    buildTask(TASK_SEEDS[2]!, "old-req", MPL_OLD, MPL_RISK, MPL_STRICT),
  ];
  const parsed = JSON.parse(renderJson(buildReport("2026-06-11T00:00:00.000Z", tasks)));

  for (const key of ["tasks", "aggregate", "interpretation", "recommendation", "nonClaims"]) {
    assert.ok(key in parsed, `missing top-level key: ${key}`);
  }
  const t0 = parsed.tasks[0];
  for (const field of ["instanceId", "oldLabel", "riskLabel", "strictLabel", "status", "old", "risk", "strict", "riskToStrict"]) {
    assert.ok(field in t0, `task missing field: ${field}`);
  }
  for (const field of ["tokenDelta", "tokenDeltaPct", "costDelta", "costDeltaPct", "turnDelta", "orderedToolCallDelta", "resolutionRegression"]) {
    assert.ok(field in t0.riskToStrict, `riskToStrict missing field: ${field}`);
  }
  for (const field of ["suppressionClaimable", "pivotCheckInjected", "editGuardInjected", "patchVerifyInjected", "policyReason", "riskSignals"]) {
    assert.ok(field in t0.strict, `strict view missing field: ${field}`);
  }
  for (const field of [
    "pairedCount", "riskTotalTokens", "strictTotalTokens", "tokenDelta", "tokenDeltaPct",
    "riskTotalCost", "strictTotalCost", "costDelta", "costDeltaPct",
    "riskTotalTurns", "strictTotalTurns", "turnDelta",
    "riskOrderedToolCalls", "strictOrderedToolCalls", "orderedToolCallDelta",
    "riskResolved", "strictResolved", "resolutionDelta",
    "resolutionRegressionCount", "suppressionClaimableCount",
    "strictPivotCheckInjectedCount", "strictEditGuardInjectedCount", "strictPatchVerifyInjectedCount",
  ]) {
    assert.ok(field in parsed.aggregate, `aggregate missing field: ${field}`);
  }
  assert.equal(parsed.tasks[0].strict.suppressionClaimable, true);
});

// ---------------------------------------------------------------------------
// Recommendation + parseArgs mechanics (pure; no Docker/model/agent).
// ---------------------------------------------------------------------------

test("recommendation promotes strict when all three suppress and improve without regression", () => {
  const allGood = [
    buildTask(TASK_SEEDS[0]!, "a", MPL_OLD, MPL_RISK, MPL_STRICT),
    buildTask(TASK_SEEDS[1]!, "b", ASTRO_OLD, ASTRO_RISK, ASTRO_STRICT),
    buildTask(TASK_SEEDS[2]!, "c", MPL_OLD, MPL_RISK, MPL_STRICT),
  ];
  const rec = chooseRecommendation(allGood, buildAggregate(allGood));
  assert.ok(rec.includes("candidate"));
  assert.ok(rec.includes("10-task strict-gated controlled comparison"));

  // a resolution regression holds the promotion back.
  const withRegression = [
    buildTask(TASK_SEEDS[0]!, "a", MPL_OLD, MPL_RISK, ASTRO_STRICT), // risk resolved, strict not
    buildTask(TASK_SEEDS[1]!, "b", ASTRO_OLD, ASTRO_RISK, ASTRO_STRICT),
    buildTask(TASK_SEEDS[2]!, "c", MPL_OLD, MPL_RISK, MPL_STRICT),
  ];
  assert.ok(chooseRecommendation(withRegression, buildAggregate(withRegression)).startsWith("Hold"));
});

test("recommendation never recommends duplicate repair experiments", () => {
  const tasks = [
    buildTask(TASK_SEEDS[0]!, "a", MPL_OLD, MPL_RISK, MPL_STRICT),
    buildTask(TASK_SEEDS[1]!, "b", ASTRO_OLD, ASTRO_RISK, ASTRO_STRICT),
    buildTask(TASK_SEEDS[2]!, "c", MPL_OLD, MPL_RISK, MPL_STRICT),
  ];
  const md = renderMarkdown(buildReport("2026-06-11T00:00:00.000Z", tasks));
  assert.ok(!/recommend.*repair/i.test(chooseRecommendation(tasks, buildAggregate(tasks))));
  assert.ok(md.includes("does not recommend further duplicate repair experiments"));
});

test("parseArgs honors overrides and defaults", () => {
  assert.equal(parseArgs([]).outName, "stage5_strictgated_3task_report");
  const c = parseArgs(["--results", "d", "--out-name", "o"]);
  assert.equal(c.resultsDir, "d");
  assert.equal(c.outName, "o");
  assert.throws(() => parseArgs(["--bogus"]));
});
