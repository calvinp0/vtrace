import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildAggregate,
  buildOldToStrictDeltas,
  buildReport,
  buildTask,
  chooseDecision,
  discoverPlanLabels,
  planBaselineOf,
  parseArgs,
  renderJson,
  renderMarkdown,
  resolutionChangeOf,
  seedsFromPlan,
  strictLabelFor,
  riskLabelFor,
  MAKE_DEFAULT_STATEMENT,
  INTERNAL_NOT_TOGGLE_STATEMENT,
  HOLD_RESOLUTION_LOSS_STATEMENT,
  HOLD_NO_TOKEN_SAVING_STATEMENT,
  MEANINGFUL_SUPPRESSION_MIN,
  type TaskSeed,
} from "./run_stage5_strictgated_10task_report";
import { toRunView } from "./run_stage5_strictgated_3task_report";
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

function toolLog(n: number) {
  return Array.from({ length: n }, (_, i) => ({ category: "read", path: `${REPO}/f${i}.py` }));
}

function baselineParts(instanceId: string, cost: number, inTok: number, cacheTok: number, resolved: boolean): RawRunParts {
  return {
    runLabel: `baseline-${instanceId}`,
    meta: { vtraceToolCallCount: 20 },
    evalMeta: { evaluationRan: true, resolvedCount: resolved ? 1 : 0 },
    record: row({ instanceId, cost, inputTokens: inTok, cacheReadTokens: cacheTok, numTurns: 30, toolCalls: { Read: 5 }, resolved }),
    toolCalls: toolLog(20),
  };
}

function oldVtraceParts(instanceId: string, cost: number, inTok: number, cacheTok: number, turns: number, calls: number, resolved: boolean): RawRunParts {
  return {
    runLabel: `old-${instanceId}`,
    meta: { vtracePivotCheckInjected: true, vtraceToolCallCount: calls },
    evalMeta: { evaluationRan: true, dockerUsed: true, resolvedCount: resolved ? 1 : 0 },
    record: row({ instanceId, cost, inputTokens: inTok, cacheReadTokens: cacheTok, numTurns: turns, toolCalls: { Read: 6, Bash: 4 }, resolved }),
    toolCalls: toolLog(calls),
  };
}

// strict run with PIVOT_CHECK suppressed (hidden_pivot only).
function strictParts(instanceId: string, cost: number, inTok: number, cacheTok: number, turns: number, calls: number, resolved: boolean, suppress = true): RawRunParts {
  return {
    runLabel: strictLabelFor(instanceId),
    meta: {
      vtracePivotCheckInjected: !suppress,
      vtracePivotCheckPolicy: "strict_risk_gated",
      vtracePivotCheckPolicyReason: suppress
        ? "strict_risk_gated: no strong risk signal (hidden_pivot alone is insufficient)"
        : "strict_risk_gated: strong risk signal",
      vtracePivotCheckRiskSignals: ["hidden_pivot"],
      vtracePivotCheckWouldInjectUnderMultiPivot: true,
      vtraceEditGuardInjected: false,
      vtracePatchVerifyInjected: false,
      vtraceToolCallCount: calls,
    },
    evalMeta: { evaluationRan: true, dockerUsed: true, resolvedCount: resolved ? 1 : 0 },
    record: row({ instanceId, cost, inputTokens: inTok, cacheReadTokens: cacheTok, numTurns: turns, toolCalls: { Read: 3, Bash: 2 }, resolved }),
    toolCalls: toolLog(calls),
  };
}

const MISSING: RawRunParts = { runLabel: "missing", meta: null, evalMeta: null, record: null, toolCalls: null };
const NO_PLAN_BASELINE = { totalTokens: null, costUsd: null, resolved: null };

function seed(instanceId: string): TaskSeed {
  return {
    instanceId,
    baselineLabel: `baseline-${instanceId}`,
    oldVtraceLabel: `old-${instanceId}`,
    strictLabel: strictLabelFor(instanceId),
    riskLabel: riskLabelFor(instanceId),
  };
}

// A complete task: strict is cheaper than old VTRACE and resolution unchanged.
function completeTask(instanceId: string, resolved = false, suppress = true) {
  return buildTask(
    seed(instanceId),
    baselineParts(instanceId, 1.0, 400, 1_000_000, resolved),
    oldVtraceParts(instanceId, 0.8, 300, 900_000, 50, 30, resolved),
    MISSING,
    strictParts(instanceId, 0.5, 200, 600_000, 35, 18, resolved, suppress),
    NO_PLAN_BASELINE,
  );
}

// ---------------------------------------------------------------------------
// 1. Reads usage/cost/resolution from JSONL rows.
// ---------------------------------------------------------------------------

test("usage/cost/resolution come from the JSONL row", () => {
  const view = toRunView(buildRunUsage(strictParts("x__x-1", 0.5, 200, 600_000, 35, 18, true)));
  assert.equal(view.costUsd, 0.5);
  assert.equal(view.totalTokens, 200 + 100 + 600_000 + 50_000);
  assert.equal(view.resolved, true);
  assert.equal(view.numTurns, 35);
});

// ---------------------------------------------------------------------------
// 2. Reads VTRACE policy metadata from _run.meta.json.
// ---------------------------------------------------------------------------

test("policy metadata comes from _run.meta.json", () => {
  const view = toRunView(buildRunUsage(strictParts("x__x-1", 0.5, 200, 600_000, 35, 18, true)));
  assert.equal(view.pivotCheckPolicy, "strict_risk_gated");
  assert.deepEqual(view.riskSignals, ["hidden_pivot"]);
  assert.equal(view.wouldInjectUnderMultiPivot, true);
  assert.equal(view.pivotCheckInjected, false);
  assert.equal(view.editGuardInjected, false);
  assert.equal(view.patchVerifyInjected, false);
});

// ---------------------------------------------------------------------------
// 3. Discovers controlled 10-task labels from the plan.
// ---------------------------------------------------------------------------

test("discoverPlanLabels + seedsFromPlan read baseline/vtrace labels and derive strict labels", () => {
  const plan = {
    selectedTasks: [
      { instanceId: "django__django-10880", baselineRunLabel: "eval-10880", vtraceRunLabel: "eval-10880", baselineTokens: 432600, baselineCost: 0.21, baselineResolved: true },
      { instanceId: "astropy__astropy-14369", baselineRunLabel: "eval-baseline-vs-vtrace-baseline-astropy-14369", vtraceRunLabel: "eval-controlled-vtrace-astropy-14369" },
    ],
  };
  assert.deepEqual(discoverPlanLabels(plan, "django__django-10880"), {
    baselineLabel: "eval-10880",
    oldVtraceLabel: "eval-10880",
  });
  const seeds = seedsFromPlan(plan);
  assert.equal(seeds.length, 2);
  assert.equal(seeds[0]!.strictLabel, "eval-strictgated-vtrace-django-10880");
  assert.equal(seeds[1]!.strictLabel, "eval-strictgated-vtrace-astropy-14369");
  // canonical label derivation handles the psf/sphinx-doc prefixes too.
  assert.equal(strictLabelFor("psf__requests-5414"), "eval-strictgated-vtrace-requests-5414");
  assert.equal(strictLabelFor("sphinx-doc__sphinx-7462"), "eval-strictgated-vtrace-sphinx-7462");
  // plan-recorded baseline fallback.
  assert.deepEqual(planBaselineOf(plan, "django__django-10880"), { totalTokens: 432600, costUsd: 0.21, resolved: true });
});

// ---------------------------------------------------------------------------
// 4. Handles already-run strict tasks and missing strict tasks.
// ---------------------------------------------------------------------------

test("missing strict run is marked, not a failure; plan baseline fallback is used", () => {
  const t = buildTask(
    seed("sympy__sympy-16766"),
    MISSING, // no baseline run dir
    oldVtraceParts("sympy__sympy-16766", 0.8, 300, 900_000, 50, 30, false),
    MISSING,
    MISSING, // strict not run yet
    { totalTokens: 123456, costUsd: 0.33, resolved: false }, // plan fallback present
  );
  assert.equal(t.status, "missing_strict");
  assert.equal(t.strict, null);
  // baseline filled from plan fallback.
  assert.equal(t.baseline!.totalTokens, 123456);
  assert.equal(t.baseline!.resolved, false);
  // old→strict deltas are null when strict absent.
  assert.equal(t.oldToStrict.tokenDelta, null);
  assert.equal(t.oldToStrict.resolutionChange, "unknown");
});

test("a fully present task is complete", () => {
  const t = completeTask("matplotlib__matplotlib-22719", true);
  assert.equal(t.status, "complete");
  assert.ok(t.strict !== null && t.oldVtrace !== null && t.baseline !== null);
});

// ---------------------------------------------------------------------------
// 5. Computes old→strict token/cost/turn/tool deltas.
// ---------------------------------------------------------------------------

test("old→strict deltas", () => {
  const t = completeTask("django__django-11095", false);
  const d = t.oldToStrict;
  assert.equal(d.tokenDelta, t.strict!.totalTokens! - t.oldVtrace!.totalTokens!);
  assert.ok(d.tokenDelta! < 0);
  assert.ok(d.costDelta! < 0);
  assert.ok(d.tokenDeltaPct! < 0);
  assert.equal(d.turnDelta, 35 - 50);
  assert.equal(d.orderedToolCallDelta, 18 - 30);
  assert.equal(d.resolutionChange, "same");
});

test("buildOldToStrictDeltas returns nulls when a side is missing", () => {
  const old = toRunView(buildRunUsage(oldVtraceParts("a__a-1", 0.8, 300, 900_000, 50, 30, true)));
  const d = buildOldToStrictDeltas(old, null);
  assert.equal(d.tokenDelta, null);
  assert.equal(d.costDelta, null);
  assert.equal(d.resolutionChange, "unknown");
});

// ---------------------------------------------------------------------------
// 6. Computes suppressionClaimable.
// ---------------------------------------------------------------------------

test("suppressionClaimable surfaced on strict view", () => {
  const suppressed = completeTask("a__a-1", false, true);
  assert.equal(suppressed.strict!.suppressionClaimable, true);
  // strict that still injected (strong signal) → not claimable.
  const injected = completeTask("a__a-2", false, false);
  assert.equal(injected.strict!.suppressionClaimable, false);
  assert.equal(injected.strict!.pivotCheckInjected, true);
});

// ---------------------------------------------------------------------------
// 7. Detects resolution wins and losses.
// ---------------------------------------------------------------------------

test("resolutionChangeOf classifies win/loss/same/unknown", () => {
  assert.equal(resolutionChangeOf(false, true), "win");
  assert.equal(resolutionChangeOf(true, false), "loss");
  assert.equal(resolutionChangeOf(true, true), "same");
  assert.equal(resolutionChangeOf(false, false), "same");
  assert.equal(resolutionChangeOf(null, true), "unknown");
});

test("aggregate counts resolution wins and losses", () => {
  // win: old unresolved, strict resolved.
  const win = buildTask(seed("w__w-1"), MISSING, oldVtraceParts("w__w-1", 0.8, 300, 900_000, 50, 30, false), MISSING, strictParts("w__w-1", 0.5, 200, 600_000, 35, 18, true), NO_PLAN_BASELINE);
  // loss: old resolved, strict unresolved.
  const loss = buildTask(seed("l__l-1"), MISSING, oldVtraceParts("l__l-1", 0.8, 300, 900_000, 50, 30, true), MISSING, strictParts("l__l-1", 0.5, 200, 600_000, 35, 18, false), NO_PLAN_BASELINE);
  const agg = buildAggregate([win, loss]);
  assert.equal(agg.oldToStrictResolutionWins, 1);
  assert.equal(agg.oldToStrictResolutionLosses, 1);
  assert.equal(agg.oldToStrictResolutionNet, 0);
});

// ---------------------------------------------------------------------------
// 8. Produces internal-default recommendation only when evidence supports it.
// ---------------------------------------------------------------------------

test("chooseDecision recommends make_default only with tokens+cost saved, no regression, meaningful suppression", () => {
  const good = chooseDecision({ tokensSaved: true, costSaved: true, resolutionNet: 0, suppressionClaimableCount: MEANINGFUL_SUPPRESSION_MIN });
  assert.equal(good.decision, "make_default");
  assert.ok(good.statements.includes(MAKE_DEFAULT_STATEMENT));
  assert.ok(good.statements.includes(INTERNAL_NOT_TOGGLE_STATEMENT));

  // token saving but a net resolution loss → hold_resolution_loss.
  const loss = chooseDecision({ tokensSaved: true, costSaved: true, resolutionNet: -1, suppressionClaimableCount: 5 });
  assert.equal(loss.decision, "hold_resolution_loss");
  assert.ok(loss.statements.includes(HOLD_RESOLUTION_LOSS_STATEMENT));

  // no token saving → hold_no_token_saving.
  const noTok = chooseDecision({ tokensSaved: false, costSaved: false, resolutionNet: 0, suppressionClaimableCount: 5 });
  assert.equal(noTok.decision, "hold_no_token_saving");
  assert.ok(noTok.statements.includes(HOLD_NO_TOKEN_SAVING_STATEMENT));

  // tokens saved, no regression, but suppression below threshold → hold_insufficient_evidence.
  const weak = chooseDecision({ tokensSaved: true, costSaved: true, resolutionNet: 0, suppressionClaimableCount: MEANINGFUL_SUPPRESSION_MIN - 1 });
  assert.equal(weak.decision, "hold_insufficient_evidence");
});

test("report decision wires through the aggregate", () => {
  // 3 complete suppressed tasks, all cheaper, no regression → make_default.
  const tasks = [completeTask("a__a-1"), completeTask("b__b-1"), completeTask("c__c-1")];
  const report = buildReport("2026-06-11T00:00:00.000Z", tasks);
  assert.equal(report.decision, "make_default");
  assert.ok(report.recommendation.includes(MAKE_DEFAULT_STATEMENT));
  assert.equal(report.aggregate.suppressionClaimableCount, 3);
});

// ---------------------------------------------------------------------------
// 9. Emits required Markdown sections.
// ---------------------------------------------------------------------------

test("markdown contains all required sections", () => {
  const tasks = [completeTask("a__a-1"), completeTask("b__b-1"), completeTask("c__c-1")];
  const md = renderMarkdown(buildReport("2026-06-11T00:00:00.000Z", tasks));
  for (const heading of [
    "# Stage 5 strict-gated 10-task comparison",
    "## Summary",
    "## Task coverage",
    "## Aggregate comparison",
    "## Per-task comparison",
    "## Pivot-check suppression outcomes",
    "## Token/cost/turn impact",
    "## Resolution outcomes",
    "## Relationship to repair accounting",
    "## Default-policy recommendation",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  // internal-not-toggle framing present when make_default.
  assert.ok(md.includes(INTERNAL_NOT_TOGGLE_STATEMENT));
  assert.ok(md.includes("Should strict_risk_gated become the internal default"));
});

// ---------------------------------------------------------------------------
// 10. Emits required JSON shape.
// ---------------------------------------------------------------------------

test("json shape has required task, oldToStrict, strict, and aggregate fields", () => {
  const tasks = [completeTask("a__a-1"), completeTask("b__b-1"), completeTask("c__c-1")];
  const parsed = JSON.parse(renderJson(buildReport("2026-06-11T00:00:00.000Z", tasks)));

  for (const key of ["tasks", "aggregate", "decision", "recommendation", "nonClaims"]) {
    assert.ok(key in parsed, `missing top-level key: ${key}`);
  }
  const t0 = parsed.tasks[0];
  for (const field of ["instanceId", "baselineLabel", "oldVtraceLabel", "strictLabel", "status", "baseline", "oldVtrace", "strict", "oldToStrict"]) {
    assert.ok(field in t0, `task missing field: ${field}`);
  }
  for (const field of ["tokenDelta", "tokenDeltaPct", "costDelta", "costDeltaPct", "turnDelta", "orderedToolCallDelta", "resolutionChange"]) {
    assert.ok(field in t0.oldToStrict, `oldToStrict missing field: ${field}`);
  }
  for (const field of ["pivotCheckInjected", "wouldInjectUnderMultiPivot", "riskSignals", "suppressionClaimable", "editGuardInjected", "patchVerifyInjected"]) {
    assert.ok(field in t0.strict, `strict view missing field: ${field}`);
  }
  for (const field of [
    "taskCount", "pairedCount", "missingStrictCount",
    "baselineResolved", "oldVtraceResolved", "strictResolved",
    "baselineTotalTokens", "oldVtraceTotalTokens", "strictTotalTokens",
    "baselineTotalCost", "oldVtraceTotalCost", "strictTotalCost",
    "oldToStrictTokenDelta", "oldToStrictTokenDeltaPct", "oldToStrictCostDelta", "oldToStrictCostDeltaPct",
    "oldToStrictResolutionWins", "oldToStrictResolutionLosses", "oldToStrictResolutionNet",
    "suppressionClaimableCount", "strictPivotCheckInjectedCount", "strictEditGuardInjectedCount", "strictPatchVerifyInjectedCount",
    "strictInternalDefaultRecommendation",
  ]) {
    assert.ok(field in parsed.aggregate, `aggregate missing field: ${field}`);
  }
  assert.equal(parsed.tasks[0].strict.suppressionClaimable, true);
});

// ---------------------------------------------------------------------------
// parseArgs mechanics (pure; no Docker/model/agent).
// ---------------------------------------------------------------------------

test("parseArgs honors overrides and defaults", () => {
  assert.equal(parseArgs([]).outName, "stage5_strictgated_10task_report");
  const c = parseArgs(["--results", "d", "--out-name", "o"]);
  assert.equal(c.resultsDir, "d");
  assert.equal(c.outName, "o");
  assert.throws(() => parseArgs(["--bogus"]));
});
