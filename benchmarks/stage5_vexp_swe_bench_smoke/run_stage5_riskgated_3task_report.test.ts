import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildAggregate,
  buildReport,
  buildTask,
  chooseRecommendation,
  classifyOutcome,
  discoverOldLabel,
  parseArgs,
  renderJson,
  renderMarkdown,
  suppressionClaimableOf,
  TASK_SEEDS,
  taskImproves,
  toRunView,
  type TaskComparison,
} from "./run_stage5_riskgated_3task_report";
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

// matplotlib: old controlled loss, new risk_gated resolved. PIVOT_CHECK still injected.
const MPL_OLD: RawRunParts = {
  runLabel: "eval-controlled-vtrace-matplotlib-22719",
  meta: { vtracePivotCheckInjected: true, vtraceToolCallCount: 30 },
  evalMeta: { evaluationRan: true, dockerUsed: true, resolvedCount: 0 },
  record: row({ instanceId: "matplotlib__matplotlib-22719", cost: 0.9627, inputTokens: 491, cacheReadTokens: 2_632_899, numTurns: 69, toolCalls: { Read: 9, Grep: 4, Edit: 1, Bash: 16 }, resolved: false }),
  toolCalls: toolLog(30),
};
const MPL_NEW: RawRunParts = {
  runLabel: "eval-riskgated-vtrace-matplotlib-22719",
  meta: {
    vtracePivotCheckInjected: true,
    vtracePivotCheckPolicy: "risk_gated",
    vtracePivotCheckPolicyReason: "risk_gated: risk signals [hidden_pivot]",
    vtracePivotCheckRiskSignals: ["hidden_pivot"],
    vtracePivotCheckWouldInjectUnderMultiPivot: true,
    vtraceToolCallCount: 12,
  },
  evalMeta: { evaluationRan: true, dockerUsed: true, resolvedCount: 1 },
  record: row({ instanceId: "matplotlib__matplotlib-22719", cost: 0.7695, inputTokens: 246, cacheReadTokens: 1_121_725, numTurns: 34, toolCalls: { Read: 5, Grep: 2, Edit: 1, Bash: 4 }, resolved: true }),
  toolCalls: toolLog(12),
};

// A present old, MISSING new (astropy/requests case).
const ASTRO_OLD: RawRunParts = {
  runLabel: "eval-controlled-vtrace-astropy-14369",
  meta: { vtracePivotCheckInjected: true, vtraceToolCallCount: 20 },
  evalMeta: { evaluationRan: true, resolvedCount: 1 },
  record: row({ instanceId: "astropy__astropy-14369", cost: 0.4, inputTokens: 300, cacheReadTokens: 800_000, numTurns: 40, toolCalls: { Read: 6, Bash: 3 }, resolved: true }),
  toolCalls: toolLog(20),
};
const MISSING: RawRunParts = { runLabel: "missing", meta: null, evalMeta: null, record: null, toolCalls: null };

// ---------------------------------------------------------------------------
// 1. Reads usage/cost/resolution from JSONL.
// ---------------------------------------------------------------------------

test("usage/cost/resolution come from the JSONL row", () => {
  const view = toRunView(buildRunUsage(MPL_NEW));
  assert.equal(view.costUsd, 0.7695);
  assert.equal(view.totalTokens, 246 + 100 + 1_121_725 + 50_000);
  assert.equal(view.resolved, true);
  assert.equal(view.numTurns, 34);
  assert.deepEqual(view.toolCallsByType, { Read: 5, Grep: 2, Edit: 1, Bash: 4 });
});

// ---------------------------------------------------------------------------
// 2. Reads VTRACE policy metadata from _run.meta.json.
// ---------------------------------------------------------------------------

test("policy metadata comes from _run.meta.json", () => {
  const view = toRunView(buildRunUsage(MPL_NEW));
  assert.equal(view.vtracePivotCheckPolicy, "risk_gated");
  assert.equal(view.vtracePivotCheckPolicyReason, "risk_gated: risk signals [hidden_pivot]");
  assert.deepEqual(view.vtracePivotCheckRiskSignals, ["hidden_pivot"]);
  assert.equal(view.vtracePivotCheckWouldInjectUnderMultiPivot, true);
  assert.equal(view.vtracePivotCheckInjected, true);
});

// ---------------------------------------------------------------------------
// 3. Computes total tokens and deltas.
// ---------------------------------------------------------------------------

test("per-task total tokens and deltas", () => {
  const t = buildTask(TASK_SEEDS[0]!, "eval-controlled-vtrace-matplotlib-22719", MPL_OLD, MPL_NEW);
  assert.equal(t.status, "paired");
  assert.equal(t.old!.totalTokens, 491 + 100 + 2_632_899 + 50_000);
  assert.equal(t.new!.totalTokens, 246 + 100 + 1_121_725 + 50_000);
  assert.equal(t.tokenDelta, t.new!.totalTokens! - t.old!.totalTokens!);
  assert.ok(t.tokenDelta! < 0);
  assert.ok(t.costDelta! < 0);
  assert.equal(t.orderedToolCallDelta, 12 - 30);
  assert.equal(t.numTurnDelta, 34 - 69);
  assert.equal(t.resolvedChanged, true);
});

// ---------------------------------------------------------------------------
// 4. Computes aggregate deltas across available pairs.
// ---------------------------------------------------------------------------

test("aggregate only counts paired tasks", () => {
  const paired = buildTask(TASK_SEEDS[0]!, "old-mpl", MPL_OLD, MPL_NEW);
  const missingNew = buildTask(TASK_SEEDS[1]!, "old-astro", ASTRO_OLD, MISSING);
  const agg = buildAggregate([paired, missingNew]);

  assert.equal(agg.pairedCount, 1);
  assert.equal(agg.missingNewCount, 1);
  // Aggregate token totals exclude the missing-new task (only matplotlib paired).
  assert.equal(agg.totalOldTokens, paired.old!.totalTokens);
  assert.equal(agg.totalNewTokens, paired.new!.totalTokens);
  assert.equal(agg.totalTokenDelta, paired.tokenDelta);
  assert.equal(agg.resolvedOld, 0); // matplotlib old unresolved
  assert.equal(agg.resolvedNew, 1);
  assert.equal(agg.resolvedDelta, 1);
  assert.equal(agg.orderedToolCallsOld, 30);
  assert.equal(agg.orderedToolCallsNew, 12);
  assert.equal(agg.pivotCheckStillInjectedCount, 1);
});

// ---------------------------------------------------------------------------
// 5. Handles missing new risk-gated runs without failure.
// ---------------------------------------------------------------------------

test("missing new run is marked, not a failure", () => {
  const t = buildTask(TASK_SEEDS[1]!, "eval-controlled-vtrace-astropy-14369", ASTRO_OLD, MISSING);
  assert.equal(t.status, "missing_new_artifact");
  assert.equal(t.new, null);
  assert.equal(t.tokenDelta, null);
  assert.equal(t.suppressionClaimable, null);
  assert.equal(t.outcome, "missing_evidence");
  // old side is still populated.
  assert.equal(t.old!.resolved, true);
});

test("missing old artifact is marked when old record absent", () => {
  const t = buildTask(TASK_SEEDS[1]!, null, MISSING, MPL_NEW);
  assert.equal(t.status, "missing_old_artifact");
  assert.equal(t.old, null);
});

// ---------------------------------------------------------------------------
// 6. Emits commands for missing astropy/requests runs.
// ---------------------------------------------------------------------------

test("markdown emits run + evaluate commands for missing risk-gated runs", () => {
  const tasks = [
    buildTask(TASK_SEEDS[0]!, "old-mpl", MPL_OLD, MPL_NEW),
    buildTask(TASK_SEEDS[1]!, "old-astro", ASTRO_OLD, MISSING),
    buildTask(TASK_SEEDS[2]!, "old-req", ASTRO_OLD, MISSING),
  ];
  const md = renderMarkdown(buildReport("2026-06-11T00:00:00.000Z", tasks));
  assert.ok(md.includes("--run-label eval-riskgated-vtrace-astropy-14369"));
  assert.ok(md.includes("--run-label eval-riskgated-vtrace-requests-5414"));
  assert.ok(md.includes("--mode evaluate"));
  assert.ok(md.includes("--instances astropy__astropy-14369"));
  assert.ok(md.includes("--instances psf__requests-5414"));
});

// ---------------------------------------------------------------------------
// 7. Computes suppressionClaimable correctly.
// ---------------------------------------------------------------------------

test("suppressionClaimable requires wouldInject=true AND injected=false", () => {
  // matplotlib: wouldInject=true but injected=true → NOT claimable.
  assert.equal(suppressionClaimableOf(toRunView(buildRunUsage(MPL_NEW))), false);

  // Hypothetical genuine suppression: wouldInject=true, injected=false → claimable.
  const suppressed = toRunView(
    buildRunUsage({ ...MPL_NEW, meta: { ...(MPL_NEW.meta as object), vtracePivotCheckInjected: false } }),
  );
  assert.equal(suppressionClaimableOf(suppressed), true);

  // injected=false but wouldInject not set → NOT claimable.
  const noWould = toRunView(
    buildRunUsage({
      ...MPL_NEW,
      meta: { vtracePivotCheckInjected: false, vtracePivotCheckPolicy: "risk_gated" },
    }),
  );
  assert.equal(suppressionClaimableOf(noWould), false);

  // missing new → null.
  assert.equal(suppressionClaimableOf(null), null);
});

// ---------------------------------------------------------------------------
// 8. Distinguishes improvement-without-suppression from suppression.
// ---------------------------------------------------------------------------

test("classifyOutcome distinguishes the three outcomes", () => {
  const oldV = toRunView(buildRunUsage(MPL_OLD));
  const newV = toRunView(buildRunUsage(MPL_NEW));

  // matplotlib: still injected, calls dropped → lower loopiness without suppression.
  const mpl = classifyOutcome("paired", oldV, newV, false, -1_000_000, -18, -35);
  assert.equal(mpl.outcome, "lower_loopiness_without_suppression");

  // suppression claimable → suppression.
  const supp = classifyOutcome("paired", oldV, newV, true, -1_000_000, -18, -35);
  assert.equal(supp.outcome, "suppression");

  // missing new → missing evidence.
  const miss = classifyOutcome("missing_new_artifact", oldV, null, null, null, null, null);
  assert.equal(miss.outcome, "missing_evidence");

  // Real matplotlib task ends up lower_loopiness_without_suppression.
  const t = buildTask(TASK_SEEDS[0]!, "old-mpl", MPL_OLD, MPL_NEW);
  assert.equal(t.outcome, "lower_loopiness_without_suppression");
});

// ---------------------------------------------------------------------------
// 9. Emits required Markdown sections.
// ---------------------------------------------------------------------------

test("markdown contains all required sections + matplotlib statement", () => {
  const tasks = [
    buildTask(TASK_SEEDS[0]!, "old-mpl", MPL_OLD, MPL_NEW),
    buildTask(TASK_SEEDS[1]!, "old-astro", ASTRO_OLD, MISSING),
    buildTask(TASK_SEEDS[2]!, "old-req", ASTRO_OLD, MISSING),
  ];
  const md = renderMarkdown(buildReport("2026-06-11T00:00:00.000Z", tasks));
  for (const heading of [
    "# Stage 5 risk-gated 3-task verification report",
    "## Summary",
    "## Task status",
    "## Aggregate old vs new comparison",
    "## Per-task comparison",
    "## Pivot-check policy outcomes",
    "## Tool-loop / turn-count analysis",
    "## Resolution outcomes",
    "## Interpretation",
    "## Recommended next step",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(
    md.includes(
      "matplotlib improved strongly, but suppression is not claimable because PIVOT_CHECK still injected due to hidden_pivot",
    ),
  );
  // only-matplotlib-present recommendation wording.
  assert.ok(
    md.includes("Run the remaining two risk-gated verification tasks: astropy__astropy-14369 and psf__requests-5414"),
  );
});

// ---------------------------------------------------------------------------
// 10. Emits required JSON shape.
// ---------------------------------------------------------------------------

test("json shape has required task, aggregate, and decision fields", () => {
  const tasks = [
    buildTask(TASK_SEEDS[0]!, "old-mpl", MPL_OLD, MPL_NEW),
    buildTask(TASK_SEEDS[1]!, "old-astro", ASTRO_OLD, MISSING),
    buildTask(TASK_SEEDS[2]!, "old-req", ASTRO_OLD, MISSING),
  ];
  const parsed = JSON.parse(renderJson(buildReport("2026-06-11T00:00:00.000Z", tasks)));

  for (const key of ["tasks", "aggregate", "recommendation", "nonClaims"]) {
    assert.ok(key in parsed, `missing top-level key: ${key}`);
  }
  const t0 = parsed.tasks[0];
  for (const field of [
    "instanceId", "oldLabel", "newLabel", "status", "old", "new",
    "tokenDelta", "tokenDeltaPct", "costDelta", "costDeltaPct", "resolvedChanged",
    "orderedToolCallDelta", "numTurnDelta", "suppressionClaimable",
  ]) {
    assert.ok(field in t0, `task missing field: ${field}`);
  }
  for (const field of [
    "pairedCount", "missingNewCount", "totalOldTokens", "totalNewTokens", "totalTokenDelta",
    "totalTokenDeltaPct", "totalOldCost", "totalNewCost", "totalCostDelta", "totalCostDeltaPct",
    "resolvedOld", "resolvedNew", "resolvedDelta", "orderedToolCallsOld", "orderedToolCallsNew",
    "orderedToolCallDelta", "suppressionClaimableCount", "pivotCheckStillInjectedCount",
  ]) {
    assert.ok(field in parsed.aggregate, `aggregate missing field: ${field}`);
  }
  assert.equal(parsed.tasks[0].suppressionClaimable, false);
  assert.equal(parsed.tasks[1].suppressionClaimable, null);
});

// ---------------------------------------------------------------------------
// Discovery + recommendation + parseArgs mechanics (pure; no Docker/model/agent).
// ---------------------------------------------------------------------------

test("discoverOldLabel prefers the plan, falls back, and reports ambiguity", () => {
  const plan = {
    selectedTasks: [
      { instanceId: "astropy__astropy-14369", vtraceRunLabel: "eval-controlled-vtrace-astropy-14369" },
    ],
  };
  assert.equal(
    discoverOldLabel(plan, "astropy__astropy-14369", "fallback"),
    "eval-controlled-vtrace-astropy-14369",
  );
  // not in plan → fallback.
  assert.equal(discoverOldLabel(plan, "psf__requests-5414", "fb-req"), "fb-req");
  // no plan, no fallback → null (ambiguous).
  assert.equal(discoverOldLabel(null, "x", null), null);
});

test("recommendation logic covers the three cases", () => {
  const onlyMpl: TaskComparison[] = [
    buildTask(TASK_SEEDS[0]!, "old-mpl", MPL_OLD, MPL_NEW),
    buildTask(TASK_SEEDS[1]!, "old-astro", ASTRO_OLD, MISSING),
    buildTask(TASK_SEEDS[2]!, "old-req", ASTRO_OLD, MISSING),
  ];
  assert.ok(chooseRecommendation(onlyMpl).includes("Run the remaining two risk-gated verification tasks"));

  // all three present, ≥2 improve → policy accounting.
  const allImprove = [
    buildTask(TASK_SEEDS[0]!, "a", MPL_OLD, MPL_NEW),
    buildTask(TASK_SEEDS[1]!, "b", MPL_OLD, MPL_NEW),
    buildTask(TASK_SEEDS[2]!, "c", MPL_OLD, MPL_NEW),
  ];
  assert.ok(allImprove.every(taskImproves));
  assert.ok(chooseRecommendation(allImprove).includes("Update Stage 5 policy accounting"));

  // all three present, mixed (only one improves) → analyze per-task.
  const noImprove = buildTask(TASK_SEEDS[2]!, "c", MPL_NEW, MPL_OLD); // reversed → tokens up
  assert.equal(taskImproves(noImprove), false);
  const mixed = [
    buildTask(TASK_SEEDS[0]!, "a", MPL_OLD, MPL_NEW),
    buildTask(TASK_SEEDS[1]!, "b", MPL_NEW, MPL_OLD),
    buildTask(TASK_SEEDS[2]!, "c", MPL_NEW, MPL_OLD),
  ];
  assert.ok(chooseRecommendation(mixed).includes("Analyze per-task causes"));
});

test("parseArgs honors overrides and defaults", () => {
  assert.equal(parseArgs([]).outName, "stage5_riskgated_3task_report");
  const c = parseArgs(["--results", "d", "--out-name", "o"]);
  assert.equal(c.resultsDir, "d");
  assert.equal(c.outName, "o");
  assert.throws(() => parseArgs(["--bogus"]));
});
