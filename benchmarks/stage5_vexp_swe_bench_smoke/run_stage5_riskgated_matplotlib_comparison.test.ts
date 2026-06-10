import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  CAUSAL_NON_CLAIM,
  buildDeltas,
  buildPivotCheckDecision,
  buildReport,
  buildRunUsage,
  orderedToolCallCountOf,
  parseArgs,
  patchHash,
  renderJson,
  renderMarkdown,
  tokenTotalOf,
  type RawRunParts,
} from "./run_stage5_riskgated_matplotlib_comparison";

// ---------------------------------------------------------------------------
// Fixtures — synthetic old/new parts, never the live raw artifacts. These mirror the real
// matplotlib__matplotlib-22719 runs: old = controlled VTRACE loss, new = risk_gated rerun
// that resolved. Token/cost/resolution live ONLY in `record` (the JSONL row); policy metadata
// lives ONLY in `meta` (_run.meta.json); docker result lives in `evalMeta`.
// ---------------------------------------------------------------------------

const OLD_PATCH =
  "diff --git a/lib/matplotlib/category.py b/lib/matplotlib/category.py\n" +
  "--- a/lib/matplotlib/category.py\n+++ b/lib/matplotlib/category.py\n" +
  "@@ -58,7 +58,7 @@\n-        if is_numlike:\n+        if is_numlike and values.size:\n";

const NEW_PATCH =
  "diff --git a/lib/matplotlib/category.py b/lib/matplotlib/category.py\n" +
  "--- a/lib/matplotlib/category.py\n+++ b/lib/matplotlib/category.py\n" +
  "@@ -54,6 +54,8 @@\n+        if values.size == 0:\n+            return np.asarray(values, dtype=float)\n";

const REPO = ".bench-repos/matplotlib__matplotlib";

const OLD_PARTS: RawRunParts = {
  runLabel: "eval-controlled-vtrace-matplotlib-22719",
  meta: {
    // policy/context only — NO usage or cost here.
    vtraceCapsuleEstimatedTokens: 601,
    vtraceContextChars: 3533,
    vtraceToolCallCount: 30,
    vtracePivotCheckInjected: true,
    // old run predates the risk_gated policy fields → absent.
  },
  evalMeta: { evaluationRan: true, dockerUsed: true, resolvedCount: 0, evaluationError: null },
  record: {
    instanceId: "matplotlib__matplotlib-22719",
    inputTokens: 491,
    outputTokens: 158,
    cacheReadTokens: 2632899,
    cacheCreationTokens: 84850,
    costUsd: 0.9627022500000002,
    numTurns: 69,
    toolCalls: { Read: 9, Grep: 4, Edit: 1, Bash: 16 },
    modelPatch: OLD_PATCH,
    resolved: false,
  },
  toolCalls: [
    { category: "read", path: `${REPO}/lib/matplotlib/axis.py` },
    { category: "read", path: `${REPO}/lib/matplotlib/category.py` },
    { category: "read", path: `${REPO}/lib/matplotlib/axis.py` }, // duplicate read
    { category: "grep", path: null },
    { category: "edit", path: `${REPO}/lib/matplotlib/category.py` },
    { category: "command", path: null },
  ],
};

const NEW_PARTS: RawRunParts = {
  runLabel: "eval-riskgated-vtrace-matplotlib-22719",
  meta: {
    vtraceCapsuleEstimatedTokens: 601,
    vtraceContextChars: 3615,
    vtraceToolCallCount: 12,
    vtracePivotCheckInjected: true,
    vtracePivotCheckPolicy: "risk_gated",
    vtracePivotCheckPolicyReason: "risk_gated: risk signals [hidden_pivot]",
    vtracePivotCheckRiskSignals: ["hidden_pivot"],
    vtracePivotCheckWouldInjectUnderMultiPivot: true,
    vtraceEditGuardInjected: true,
    vtracePatchVerifyInjected: true,
  },
  evalMeta: { evaluationRan: true, dockerUsed: true, resolvedCount: 1, evaluationError: null },
  record: {
    instanceId: "matplotlib__matplotlib-22719",
    inputTokens: 246,
    outputTokens: 85,
    cacheReadTokens: 1121725,
    cacheCreationTokens: 155616,
    costUsd: 0.7694869999999998,
    numTurns: 34,
    toolCalls: { Read: 5, Grep: 2, Edit: 1, Bash: 4 },
    modelPatch: NEW_PATCH,
    resolved: true,
  },
  toolCalls: [
    { category: "read", path: `${REPO}/lib/matplotlib/category.py` },
    { category: "read", path: `${REPO}/lib/matplotlib/axis.py` },
    { category: "grep", path: null },
    { category: "edit", path: `${REPO}/lib/matplotlib/category.py` },
  ],
};

// ---------------------------------------------------------------------------
// 1. Reads usage/cost/resolved from the JSONL row, not _run.meta.json.
// ---------------------------------------------------------------------------

test("usage/cost/resolved come from the JSONL row, never from _run.meta.json", () => {
  const usage = buildRunUsage(NEW_PARTS);
  // costUsd is the JSONL value, not anything in meta.
  assert.equal(usage.costUsd, 0.7694869999999998);
  assert.equal(usage.inputTokens, 246);
  assert.equal(usage.resolved, true);

  // If the JSONL row lacks usage/cost, they are null even when meta carries policy numbers
  // (proving the reader does NOT fall back to _run.meta.json for spend).
  const noRecord: RawRunParts = { ...NEW_PARTS, record: null };
  const usageNoRecord = buildRunUsage(noRecord);
  assert.equal(usageNoRecord.costUsd, null);
  assert.equal(usageNoRecord.totalTokens, null);
  assert.equal(usageNoRecord.resolved, null);
  // Capsule estimate from meta must NOT be used as the token total.
  assert.notEqual(usageNoRecord.totalTokens, 601);
});

// ---------------------------------------------------------------------------
// 2. Reads pivot-check metadata from _run.meta.json.
// ---------------------------------------------------------------------------

test("pivot-check metadata is read from _run.meta.json", () => {
  const usage = buildRunUsage(NEW_PARTS);
  assert.equal(usage.vtracePivotCheckPolicy, "risk_gated");
  assert.equal(usage.vtracePivotCheckPolicyReason, "risk_gated: risk signals [hidden_pivot]");
  assert.deepEqual(usage.vtracePivotCheckRiskSignals, ["hidden_pivot"]);
  assert.equal(usage.vtracePivotCheckWouldInjectUnderMultiPivot, true);
  assert.equal(usage.vtracePivotCheckInjected, true);
  assert.equal(usage.vtraceEditGuardInjected, true);
  assert.equal(usage.vtracePatchVerifyInjected, true);

  // With no meta, all policy fields are null even though the JSONL row is present.
  const noMeta = buildRunUsage({ ...NEW_PARTS, meta: null });
  assert.equal(noMeta.vtracePivotCheckPolicy, null);
  assert.equal(noMeta.vtracePivotCheckInjected, null);
  // ...but usage still resolves from the JSONL row.
  assert.equal(noMeta.costUsd, 0.7694869999999998);
});

// ---------------------------------------------------------------------------
// 3. Computes total tokens from input + output + cacheRead + cacheCreation.
// ---------------------------------------------------------------------------

test("totalTokens sums all four components", () => {
  assert.equal(tokenTotalOf(NEW_PARTS.record), 246 + 85 + 1121725 + 155616);
  assert.equal(buildRunUsage(NEW_PARTS).totalTokens, 1277672);
  assert.equal(buildRunUsage(OLD_PARTS).totalTokens, 491 + 158 + 2632899 + 84850);
  // null when no components present at all.
  assert.equal(tokenTotalOf({}), null);
  assert.equal(tokenTotalOf(null), null);
});

// ---------------------------------------------------------------------------
// 4. Computes token/cost deltas.
// ---------------------------------------------------------------------------

test("token and cost deltas are computed old→new", () => {
  const oldRun = buildRunUsage(OLD_PARTS);
  const newRun = buildRunUsage(NEW_PARTS);
  const deltas = buildDeltas(oldRun, newRun);

  assert.equal(deltas.tokenDelta, newRun.totalTokens! - oldRun.totalTokens!);
  assert.ok(deltas.tokenDelta! < 0, "new run used fewer tokens");
  assert.ok(deltas.tokenDeltaPct! < 0);

  assert.ok(Math.abs(deltas.costDelta! - (newRun.costUsd! - oldRun.costUsd!)) < 1e-9);
  assert.ok(deltas.costDelta! < 0, "new run cost less");

  assert.equal(deltas.orderedToolCallDelta, newRun.orderedToolCallCount! - oldRun.orderedToolCallCount!);
  assert.equal(deltas.resolvedChanged, true);
});

// ---------------------------------------------------------------------------
// 5. Handles old runs with missing new policy metadata.
// ---------------------------------------------------------------------------

test("old run with no risk_gated policy fields yields null, not a crash", () => {
  const oldRun = buildRunUsage(OLD_PARTS);
  assert.equal(oldRun.vtracePivotCheckPolicy, null);
  assert.equal(oldRun.vtracePivotCheckPolicyReason, null);
  assert.equal(oldRun.vtracePivotCheckRiskSignals, null);
  assert.equal(oldRun.vtracePivotCheckWouldInjectUnderMultiPivot, null);
  assert.equal(oldRun.vtraceEditGuardInjected, null);
  assert.equal(oldRun.vtracePatchVerifyInjected, null);
  // The report still builds and the new-run policy is what drives the decision.
  const report = buildReport("2026-06-11T00:00:00.000Z", OLD_PARTS, NEW_PARTS);
  assert.equal(report.pivotCheckDecision.policy, "risk_gated");
});

// ---------------------------------------------------------------------------
// 6. Counts ordered tool calls from _tool_calls.json when available.
// ---------------------------------------------------------------------------

test("orderedToolCallCount prefers the ordered log length, falls back to meta", () => {
  // From the ordered log: new fixture has 4 entries.
  assert.equal(orderedToolCallCountOf(NEW_PARTS.toolCalls, NEW_PARTS.meta), 4);
  assert.equal(buildRunUsage(NEW_PARTS).orderedToolCallCount, 4);

  // No ordered log → fall back to vtraceToolCallCount in meta.
  assert.equal(orderedToolCallCountOf(null, NEW_PARTS.meta), 12);
  // Neither present → null.
  assert.equal(orderedToolCallCountOf(null, null), null);

  // unique read / edit file counts dedupe by repo-relative path.
  const oldRun = buildRunUsage(OLD_PARTS);
  assert.equal(oldRun.uniqueFilesRead, 2); // axis.py read twice + category.py
  assert.equal(oldRun.uniqueFilesEdited, 1);
});

// ---------------------------------------------------------------------------
// 7. Emits the causal non-claim that PIVOT_CHECK was not suppressed.
// ---------------------------------------------------------------------------

test("causal non-claim: suppression is NOT claimable because PIVOT_CHECK still injected", () => {
  const decision = buildPivotCheckDecision(buildRunUsage(NEW_PARTS));
  assert.equal(decision.injected, true);
  assert.equal(decision.suppressionClaimable, false);
  assert.equal(decision.causalNonClaim, CAUSAL_NON_CLAIM);

  const report = buildReport(null, OLD_PARTS, NEW_PARTS);
  assert.ok(report.nonClaims.includes(CAUSAL_NON_CLAIM));
  assert.ok(report.interpretation.includes(CAUSAL_NON_CLAIM));

  const md = renderMarkdown(report);
  assert.ok(md.includes(CAUSAL_NON_CLAIM));

  // Counter-case: if a hypothetical run actually suppressed PIVOT_CHECK, suppression IS claimable.
  const suppressed = buildRunUsage({
    ...NEW_PARTS,
    meta: { ...(NEW_PARTS.meta as object), vtracePivotCheckInjected: false },
  });
  assert.equal(buildPivotCheckDecision(suppressed).suppressionClaimable, true);
});

// ---------------------------------------------------------------------------
// 8. Emits required Markdown sections.
// ---------------------------------------------------------------------------

test("markdown contains all required sections and required statements", () => {
  const md = renderMarkdown(buildReport("2026-06-11T00:00:00.000Z", OLD_PARTS, NEW_PARTS));
  for (const heading of [
    "# Stage 5 risk-gated matplotlib comparison",
    "## Summary",
    "## Old vs new usage",
    "## Pivot-check policy decision",
    "## Tool-call comparison",
    "## Patch comparison",
    "## Evaluation result",
    "## Interpretation",
    "## Recommended next step",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  // Required interpretation statements.
  assert.ok(md.includes("used far fewer ordered tool calls than the old controlled VTRACE run"));
  assert.ok(md.includes("reduced agent/tool-loop behavior, not smaller initial context"));
  // Recommended next step + candidates.
  assert.ok(md.includes("Run a small 3-task risk_gated verification set, not the full 10-task set yet"));
  assert.ok(md.includes("matplotlib__matplotlib-22719"));
  assert.ok(md.includes("astropy__astropy-14369"));
  assert.ok(md.includes("psf__requests-5414"));
});

// ---------------------------------------------------------------------------
// 9. Emits required JSON shape.
// ---------------------------------------------------------------------------

test("json shape has the required run, delta, and decision fields", () => {
  const report = buildReport("2026-06-11T00:00:00.000Z", OLD_PARTS, NEW_PARTS);
  const parsed = JSON.parse(renderJson(report));

  assert.equal(parsed.instanceId, "matplotlib__matplotlib-22719");
  for (const key of ["oldRun", "newRun", "oldEvaluation", "newEvaluation", "deltas", "pivotCheckDecision", "interpretation", "recommendation", "nonClaims"]) {
    assert.ok(key in parsed, `missing top-level key: ${key}`);
  }
  for (const field of [
    "runLabel", "instanceId", "resolved", "costUsd", "inputTokens", "outputTokens",
    "cacheReadTokens", "cacheCreationTokens", "totalTokens", "numTurns", "toolCallsByType",
    "orderedToolCallCount", "uniqueFilesRead", "uniqueFilesEdited", "modelPatchHash",
    "modelPatchSummary", "vtraceCapsuleEstimatedTokens", "vtraceContextChars",
    "vtracePivotCheckPolicy", "vtracePivotCheckPolicyReason", "vtracePivotCheckRiskSignals",
    "vtracePivotCheckWouldInjectUnderMultiPivot", "vtracePivotCheckInjected",
    "vtraceEditGuardInjected", "vtracePatchVerifyInjected",
  ]) {
    assert.ok(field in parsed.newRun, `newRun missing field: ${field}`);
  }
  for (const field of ["tokenDelta", "tokenDeltaPct", "costDelta", "costDeltaPct", "orderedToolCallDelta", "resolvedChanged"]) {
    assert.ok(field in parsed.deltas, `deltas missing field: ${field}`);
  }
  assert.equal(parsed.pivotCheckDecision.suppressionClaimable, false);
  assert.equal(parsed.newRun.totalTokens, 1277672);
  assert.equal(parsed.newRun.resolved, true);
});

// ---------------------------------------------------------------------------
// 10. (mechanics) parseArgs + patchHash are pure — no Docker/model/agent anywhere in tests.
// ---------------------------------------------------------------------------

test("parseArgs honors overrides and defaults", () => {
  const def = parseArgs([]);
  assert.equal(def.oldLabel, "eval-controlled-vtrace-matplotlib-22719");
  assert.equal(def.newLabel, "eval-riskgated-vtrace-matplotlib-22719");
  assert.equal(def.outName, "stage5_riskgated_matplotlib_comparison");

  const custom = parseArgs(["--old-label", "a", "--new-label", "b", "--out-name", "c", "--results", "d"]);
  assert.equal(custom.oldLabel, "a");
  assert.equal(custom.newLabel, "b");
  assert.equal(custom.outName, "c");
  assert.equal(custom.resultsDir, "d");

  assert.throws(() => parseArgs(["--bogus"]));
});

test("patchHash is stable and distinguishes old vs new patches", () => {
  assert.equal(patchHash(""), null);
  assert.equal(patchHash(OLD_PATCH), patchHash(OLD_PATCH));
  assert.notEqual(patchHash(OLD_PATCH), patchHash(NEW_PATCH));
});
