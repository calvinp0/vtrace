import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  additionalSignalCount,
  buildAggregate,
  buildReport,
  buildRunCalibration,
  chooseRecommendation,
  classifyRun,
  deriveSignals,
  extraMetaOf,
  hasPivotDecisionMetadata,
  parseArgs,
  POLICY_NAMES,
  renderJson,
  renderMarkdown,
  shapeSidecar,
  simulateInject,
  STRICTER_POLICY_RECOMMENDATION,
  type RunCalibration,
  type Sidecar,
} from "./run_stage5_pivot_policy_calibration";
import { buildRunUsage, type RawRunParts } from "./run_stage5_riskgated_matplotlib_comparison";

// ---------------------------------------------------------------------------
// Fixtures — synthetic parts, never live raw artifacts. Pure functions only; no Docker / model /
// agent is ever invoked. Usage/cost lives ONLY in `record` (JSONL row); policy/signal/capsule
// metadata ONLY in `meta` (_run.meta.json).
// ---------------------------------------------------------------------------

function row(opts: {
  instanceId: string;
  cost: number;
  cacheReadTokens: number;
  resolved: boolean;
}): Record<string, unknown> {
  return {
    instanceId: opts.instanceId,
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: opts.cacheReadTokens,
    cacheCreationTokens: 50_000,
    costUsd: opts.cost,
    numTurns: 34,
    toolCalls: { Read: 5, Bash: 4 },
    modelPatch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    resolved: opts.resolved,
  };
}

// hidden_pivot ONLY, injected, would inject under multi-pivot, 2 pivots, 0 edit-risk directives.
// This is the real shape of all three risk_gated verification runs.
function hiddenOnly(instanceId: string): RawRunParts {
  return {
    runLabel: `eval-riskgated-vtrace-${instanceId}`,
    meta: {
      vtracePivotCheckInjected: true,
      vtracePivotCheckPolicy: "risk_gated",
      vtracePivotCheckPolicyReason: "risk_gated: risk signals [hidden_pivot]",
      vtracePivotCheckRiskSignals: ["hidden_pivot"],
      vtracePivotCheckWouldInjectUnderMultiPivot: true,
      vtraceCapsulePivots: [{ path: "a.py" }, { path: "b.py" }],
      vtraceCapsuleEditRiskDirectivesCount: 0,
      vtracePivotCount: 2,
      vtraceCapsuleEstimatedTokens: 601,
      vtraceToolCallCount: 12,
    },
    evalMeta: { evaluationRan: true, dockerUsed: true, resolvedCount: 0 },
    record: row({ instanceId, cost: 0.77, cacheReadTokens: 1_121_725, resolved: false }),
    toolCalls: Array.from({ length: 12 }, () => ({ category: "read", path: ".bench-repos/r/f.py" })),
  };
}

// hidden_pivot PLUS a genuine second signal (3+ pivots) — still high risk under a stricter policy.
function multiSignal(instanceId: string): RawRunParts {
  return {
    runLabel: `eval-riskgated-vtrace-${instanceId}`,
    meta: {
      vtracePivotCheckInjected: true,
      vtracePivotCheckPolicy: "risk_gated",
      vtracePivotCheckRiskSignals: ["hidden_pivot", "three_or_more_pivots"],
      vtracePivotCheckWouldInjectUnderMultiPivot: true,
      vtraceCapsulePivots: [{}, {}, {}, {}],
      vtraceCapsuleEditRiskDirectivesCount: 2,
      vtracePivotCount: 4,
      vtraceToolCallCount: 20,
    },
    evalMeta: {},
    record: row({ instanceId, cost: 1.2, cacheReadTokens: 900_000, resolved: true }),
    toolCalls: null,
  };
}

// A run with NO pivot-check decision metadata (controlled/baseline shape) → not analyzable.
const NO_PIVOT_META: RawRunParts = {
  runLabel: "eval-controlled-vtrace-x",
  meta: { vtracePivotCheckInjected: true, vtracePivotCheckEnabled: true },
  evalMeta: {},
  record: row({ instanceId: "x__x-1", cost: 0.4, cacheReadTokens: 100_000, resolved: false }),
  toolCalls: null,
};

// A would-inject run where risk_gated SUPPRESSED PIVOT_CHECK (genuine suppression).
const SUPPRESSED: RawRunParts = {
  runLabel: "eval-riskgated-vtrace-supp",
  meta: {
    vtracePivotCheckInjected: false,
    vtracePivotCheckPolicy: "risk_gated",
    vtracePivotCheckRiskSignals: [],
    vtracePivotCheckWouldInjectUnderMultiPivot: true,
    vtracePivotCount: 2,
    vtraceCapsuleEditRiskDirectivesCount: 0,
  },
  evalMeta: {},
  record: row({ instanceId: "supp__supp-1", cost: 0.2, cacheReadTokens: 50_000, resolved: true }),
  toolCalls: null,
};

const MPL = hiddenOnly("matplotlib-22719");
const ASTRO = hiddenOnly("astropy-14369");
const REQ = hiddenOnly("requests-5414");

const EMPTY_SIDECAR: Sidecar = {
  threeTaskTotalTokenDeltaPct: null,
  threeTaskTotalCostDeltaPct: null,
  threeTaskSuppressionClaimableCount: null,
  tokenAuditDominantCategories: null,
};

// ---------------------------------------------------------------------------
// 1. Simulates all requested policies from metadata.
// ---------------------------------------------------------------------------

test("simulates all requested policies for a hidden_pivot-only run", () => {
  const r = buildRunCalibration(MPL);
  for (const p of POLICY_NAMES) {
    assert.ok(p in r.simulated, `missing simulated policy: ${p}`);
  }
  // hidden_pivot sole signal, 2 pivots, 0 edit-risk directives:
  assert.equal(r.simulated.multi_pivot.inject, true); // wouldInjectUnderMultiPivot
  assert.equal(r.simulated.current_risk_gated.inject, true); // hidden_pivot fires
  assert.equal(r.simulated.strict_risk_gated.inject, false); // hidden alone insufficient
  assert.equal(r.simulated.no_hidden_pivot_only.inject, false);
  assert.equal(r.simulated.off.inject, false);
});

test("simulateInject reflects multi-signal and missing-metadata inputs", () => {
  const sigHidden = deriveSignals(buildRunUsage(MPL), extraMetaOf(MPL.meta));
  assert.equal(additionalSignalCount(sigHidden), 0);
  // strict injects when hidden_pivot has an additional signal.
  const sigMulti = deriveSignals(buildRunUsage(multiSignal("y")), extraMetaOf(multiSignal("y").meta));
  assert.ok(additionalSignalCount(sigMulti) >= 1);
  assert.equal(simulateInject("strict_risk_gated", sigMulti, true, false), true);
  assert.equal(simulateInject("no_hidden_pivot_only", sigMulti, true, false), true);
  // multi_pivot passes through a null wouldInject as null.
  assert.equal(simulateInject("multi_pivot", sigHidden, null, false), null);
  // strict injects on a sole hidden_pivot only when it is known edit-relevant.
  assert.equal(simulateInject("strict_risk_gated", sigHidden, true, true), true);
});

// ---------------------------------------------------------------------------
// 2. Classifies hidden_pivot-only injected runs as suppression_candidate_hidden_only.
// ---------------------------------------------------------------------------

test("hidden_pivot-only injected run is a suppression candidate", () => {
  const r = buildRunCalibration(MPL);
  assert.equal(r.classification, "suppression_candidate_hidden_only");
  assert.equal(r.hiddenPivotSoleSignal, true);

  // multi-signal injected run stays high-risk.
  assert.equal(buildRunCalibration(multiSignal("z")).classification, "still_high_risk_multi_signal");
  // would-inject but suppressed → already_suppressed.
  assert.equal(buildRunCalibration(SUPPRESSED).classification, "already_suppressed");
});

// ---------------------------------------------------------------------------
// 3. Counts cases where current risk_gated equals multi_pivot.
// ---------------------------------------------------------------------------

test("counts runs where risk_gated equals multi_pivot", () => {
  const runs = [MPL, ASTRO, REQ].map((p) => buildRunCalibration(p));
  for (const r of runs) assert.equal(r.riskGatedEqualsMultiPivot, true);
  const agg = buildAggregate(runs, 12);
  assert.equal(agg.runsWhereRiskGatedEqualsMultiPivot, 3);
  assert.equal(agg.runsAnalyzed, 3);
  assert.equal(agg.runsDiscovered, 12);
});

// ---------------------------------------------------------------------------
// 4. Counts strict/no-hidden suppression opportunities + token/cost mass.
// ---------------------------------------------------------------------------

test("counts strict and no-hidden suppression opportunities and mass", () => {
  const runs = [MPL, ASTRO, REQ].map((p) => buildRunCalibration(p));
  const agg = buildAggregate(runs, 3);
  assert.equal(agg.runsWithPivotCheckInjected, 3);
  assert.equal(agg.runsWhereHiddenPivotWasSoleSignal, 3);
  assert.equal(agg.suppressionOpportunitiesUnderStrict, 3);
  assert.equal(agg.suppressionOpportunitiesUnderNoHiddenPivotOnly, 3);
  assert.equal(agg.hiddenPivotAppearsTooBroad, true);
  // token/cost mass is summed from the JSONL row (200+100+1,121,725+50,000 per run) × 3.
  const perRun = 200 + 100 + 1_121_725 + 50_000;
  assert.equal(agg.tokenMassWhereHiddenPivotSoleSignal, perRun * 3);
  assert.ok(Math.abs(agg.costMassWhereHiddenPivotSoleSignal! - 0.77 * 3) < 1e-9);
  assert.equal(agg.classificationCounts.suppression_candidate_hidden_only, 3);
});

test("a genuine multi-signal run is not a suppression opportunity", () => {
  const runs = [buildRunCalibration(multiSignal("y"))];
  const agg = buildAggregate(runs, 1);
  assert.equal(agg.suppressionOpportunitiesUnderStrict, 0);
  assert.equal(agg.suppressionOpportunitiesUnderNoHiddenPivotOnly, 0);
  assert.equal(agg.hiddenPivotAppearsTooBroad, false);
});

// ---------------------------------------------------------------------------
// 5. Handles missing metadata as unknown / not analyzable.
// ---------------------------------------------------------------------------

test("missing pivot metadata is excluded and classified unknown", () => {
  assert.equal(hasPivotDecisionMetadata(NO_PIVOT_META), false);
  assert.equal(hasPivotDecisionMetadata(MPL), true);
  // A run whose meta lacks would/injected/signals classifies as unknown.
  const usage = buildRunUsage(NO_PIVOT_META);
  const signals = deriveSignals(usage, extraMetaOf(NO_PIVOT_META.meta));
  assert.equal(classifyRun(usage, signals), "unknown");
});

// ---------------------------------------------------------------------------
// 6. Emits required Markdown sections + the verbatim interpretation statement.
// ---------------------------------------------------------------------------

test("markdown contains all required sections and statements", () => {
  const runs = [MPL, ASTRO, REQ].map((p) => buildRunCalibration(p));
  const sidecar: Sidecar = {
    threeTaskTotalTokenDeltaPct: -6.2,
    threeTaskTotalCostDeltaPct: -27.4,
    threeTaskSuppressionClaimableCount: 0,
    tokenAuditDominantCategories: ["pivot_check_overhead", "agent_oversearched"],
  };
  const md = renderMarkdown(buildReport("2026-06-11T00:00:00.000Z", runs, 12, sidecar));
  for (const heading of [
    "# Stage 5 pivot-check policy calibration",
    "## Summary",
    "## Current risk-gated behavior",
    "## Hidden-pivot signal analysis",
    "## Simulated policy comparison",
    "## Suppression candidates",
    "## Relationship to token/cost outcomes",
    "## Recommendation",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(
    md.includes(
      "risk_gated did not suppress PIVOT_CHECK because hidden_pivot fired on every task",
    ),
  );
  assert.ok(md.includes(STRICTER_POLICY_RECOMMENDATION));
  assert.ok(md.includes("hidden_pivot appears too broad: yes"));
  assert.ok(md.includes("pivot_check_overhead"));
});

// ---------------------------------------------------------------------------
// 7. Emits required JSON fields (per-run + aggregate + simulated nesting).
// ---------------------------------------------------------------------------

test("json shape has required per-run, aggregate, and simulated fields", () => {
  const runs = [MPL, ASTRO, REQ].map((p) => buildRunCalibration(p));
  const parsed = JSON.parse(renderJson(buildReport("2026-06-11T00:00:00.000Z", runs, 12, EMPTY_SIDECAR)));

  for (const key of ["runs", "aggregate", "recommendation", "nonClaims", "policies", "sidecar"]) {
    assert.ok(key in parsed, `missing top-level key: ${key}`);
  }
  const r0 = parsed.runs[0];
  for (const field of [
    "instanceId", "runLabel", "resolved", "totalTokens", "costUsd", "numTurns",
    "orderedToolCallCount", "toolCallsByType", "vtracePivotCheckPolicy",
    "vtracePivotCheckRiskSignals", "vtracePivotCheckInjected",
    "vtracePivotCheckWouldInjectUnderMultiPivot", "vtraceCapsulePivots",
    "vtraceCapsuleEditRiskDirectivesCount", "vtraceCapsuleEstimatedTokens",
    "classification", "simulated", "hiddenPivotSoleSignal", "riskGatedEqualsMultiPivot",
  ]) {
    assert.ok(field in r0, `run missing field: ${field}`);
  }
  for (const p of ["multi_pivot", "current_risk_gated", "strict_risk_gated", "no_hidden_pivot_only", "off"]) {
    assert.ok(p in r0.simulated, `simulated missing policy: ${p}`);
    assert.ok("inject" in r0.simulated[p], `simulated.${p} missing inject`);
  }
  for (const field of [
    "runsDiscovered", "runsAnalyzed", "runsWithPivotCheckInjected",
    "runsWhereHiddenPivotWasSoleSignal", "runsWhereRiskGatedEqualsMultiPivot",
    "suppressionOpportunitiesUnderStrict", "suppressionOpportunitiesUnderNoHiddenPivotOnly",
    "tokenMassWhereHiddenPivotSoleSignal", "costMassWhereHiddenPivotSoleSignal",
    "classificationCounts", "hiddenPivotAppearsTooBroad",
  ]) {
    assert.ok(field in parsed.aggregate, `aggregate missing field: ${field}`);
  }
});

// ---------------------------------------------------------------------------
// 8. No Docker / model / agent: the report builds from synthetic parts only.
// ---------------------------------------------------------------------------

test("report builds purely from in-memory parts (no Docker/model/agent)", () => {
  const runs = [MPL].map((p) => buildRunCalibration(p));
  const report = buildReport(null, runs, 1, EMPTY_SIDECAR);
  assert.equal(report.generatedAt, null);
  assert.equal(report.runs.length, 1);
  // empty analyzed set still produces a coherent report + recommendation.
  const empty = buildReport(null, [], 0, EMPTY_SIDECAR);
  assert.equal(empty.aggregate.runsAnalyzed, 0);
  assert.ok(empty.recommendation.headline.includes("Insufficient risk_gated run metadata"));
});

// ---------------------------------------------------------------------------
// Recommendation, sidecar shaping, parseArgs mechanics (pure).
// ---------------------------------------------------------------------------

test("recommendation is the stricter-policy step when hidden_pivot is too broad", () => {
  const runs = [MPL, ASTRO, REQ].map((p) => buildRunCalibration(p));
  const rec = chooseRecommendation(buildAggregate(runs, 12));
  assert.equal(rec.rerunFullTenTask, false);
  assert.equal(rec.headline, STRICTER_POLICY_RECOMMENDATION);
});

test("shapeSidecar pulls 3-task aggregate and token-audit categories, tolerating absence", () => {
  const sc = shapeSidecar(
    { aggregate: { totalTokenDeltaPct: -6.2, totalCostDeltaPct: -27.4, suppressionClaimableCount: 0 } },
    { summary: { dominantCategories: ["pivot_check_overhead"] } },
  );
  assert.equal(sc.threeTaskTotalTokenDeltaPct, -6.2);
  assert.equal(sc.threeTaskSuppressionClaimableCount, 0);
  assert.deepEqual(sc.tokenAuditDominantCategories, ["pivot_check_overhead"]);
  // missing inputs → all null.
  const empty = shapeSidecar(null, null);
  assert.equal(empty.threeTaskTotalTokenDeltaPct, null);
  assert.equal(empty.tokenAuditDominantCategories, null);
});

test("an actual strict_risk_gated run is tolerated and surfaces its policy + suppression", () => {
  // A run actually executed under strict_risk_gated that suppressed a hidden_pivot-only
  // capsule: would-inject true, injected false, recorded policy "strict_risk_gated".
  const strictRun: RawRunParts = {
    runLabel: "eval-strict-vtrace-matplotlib-22719",
    meta: {
      vtracePivotCheckInjected: false,
      vtracePivotCheckPolicy: "strict_risk_gated",
      vtracePivotCheckPolicyReason: "strict_risk_gated: no strong risk signal (hidden_pivot alone is insufficient)",
      vtracePivotCheckRiskSignals: ["hidden_pivot"],
      vtracePivotCheckWouldInjectUnderMultiPivot: true,
      vtraceCapsulePivots: [{}, {}],
      vtraceCapsuleEditRiskDirectivesCount: 0,
      vtracePivotCount: 2,
      vtraceToolCallCount: 8,
    },
    evalMeta: {},
    record: row({ instanceId: "matplotlib__matplotlib-22719", cost: 0.5, cacheReadTokens: 400_000, resolved: true }),
    toolCalls: null,
  };
  assert.equal(hasPivotDecisionMetadata(strictRun), true);
  const r = buildRunCalibration(strictRun);
  assert.equal(r.vtracePivotCheckPolicy, "strict_risk_gated");
  assert.equal(r.classification, "already_suppressed");
  // strict_risk_gated is one of the simulated policies and would suppress this run.
  assert.ok(POLICY_NAMES.includes("strict_risk_gated"));
  assert.equal(r.simulated.strict_risk_gated.inject, false);
});

test("parseArgs honors overrides and defaults", () => {
  assert.equal(parseArgs([]).outName, "stage5_pivot_policy_calibration");
  const c = parseArgs(["--results", "d", "--out-name", "o"]);
  assert.equal(c.resultsDir, "d");
  assert.equal(c.outName, "o");
  assert.throws(() => parseArgs(["--bogus"]));
});
