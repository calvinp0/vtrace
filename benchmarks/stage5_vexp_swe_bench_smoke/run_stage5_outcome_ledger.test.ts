import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildLedger,
  buildRun,
  buildBaselineVtracePair,
  buildCrossLabelControlledPair,
  classifyCompleteness,
  deriveResolution,
  detectCrossLabelControlledPairs,
  editedFileSetChanged,
  loadRuns,
  normalizePivotCheckPair,
  renderJson,
  renderMarkdown,
  buildReport,
  tokenTotal,
  type LedgerRun,
  type RawRunParts,
} from "./run_stage5_outcome_ledger";

// A minimal LedgerRun for pairing tests (only the fields the pair/detector read).
function makeRun(overrides: Partial<LedgerRun> & Pick<LedgerRun, "runLabel" | "condition">): LedgerRun {
  return {
    instanceId: null,
    protocol: "unknown",
    contextPolicy: null,
    capsuleEngine: null,
    capsuleIntent: null,
    capsuleBudget: null,
    treatmentValid: null,
    injectionObserved: null,
    pivotCheckEnabled: null,
    pivotCheckInjected: null,
    pivotCheckDisabledByFlag: null,
    exitCode: null,
    completedPatch: null,
    patchProduced: false,
    resolved: null,
    resolutionSource: "unknown",
    tokens: { input: null, output: null, cacheRead: null, cacheCreation: null, total: null },
    cost: null,
    durationMs: null,
    pivotCount: null,
    toolLogOrdered: false,
    toolCallCount: null,
    editedFiles: [],
    readFiles: [],
    searchedFiles: [],
    hiddenPivotCount: null,
    hiddenPivotsInspected: null,
    hiddenPivotsEdited: null,
    hiddenPivotsIgnored: null,
    rawArtifactPaths: [],
    dataCompleteness: "partial",
    ...overrides,
  };
}

// A complete vtrace run's raw parts (meta + eval + jsonl record + tool log).
function completeVtraceParts(overrides: Partial<RawRunParts> = {}): RawRunParts {
  return {
    runLabel: "eval-pivot-check-vtrace-sphinx-7462",
    condition: "vtrace",
    meta: {
      condition: "vtrace",
      instances: ["sphinx-doc__sphinx-7462"],
      exitCode: 0,
      vtraceTreatmentValid: true,
      vtraceInjectionObserved: true,
      vtraceContextPolicyOverride: "force-inject",
      vtraceCapsuleEngine: "v2",
      vtraceCapsuleIntent: "debug",
      vtraceCapsuleBudget: 8000,
      vtracePivotCount: 2,
      vtraceCapsulePivots: [
        { path: "sphinx/domains/python.py", roleReason: "source line anchor in the issue — explicit edit site" },
        { path: "sphinx/pycode/ast.py", roleReason: "actionable function exercised by a failing test" },
      ],
    },
    evalMeta: { evaluationRan: true, evaluationMethod: "docker", resolvedCount: 1, instancesEvaluated: 1 },
    record: {
      instanceId: "sphinx-doc__sphinx-7462",
      resolved: true,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
      costUsd: 0.42,
      durationMs: 53000,
      modelPatch:
        "diff --git a/sphinx/domains/python.py b/sphinx/domains/python.py\n--- a/sphinx/domains/python.py\n+++ b/sphinx/domains/python.py\n@@ -1 +1 @@\n-old\n+new",
    },
    toolCalls: [
      { tool: "Read", category: "read", path: "/x/.bench-repos/sphinx-doc__sphinx/sphinx/pycode/ast.py" },
      { tool: "Edit", category: "edit", path: "/x/.bench-repos/sphinx-doc__sphinx/sphinx/domains/python.py" },
      { tool: "Grep", category: "search", path: "/x/.bench-repos/sphinx-doc__sphinx/sphinx/util.py" },
    ],
    rawArtifactPaths: ["runs/eval-pivot-check-vtrace-sphinx-7462/raw/vtrace/_run.meta.json"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Ledger loads runs with complete metadata.
// ---------------------------------------------------------------------------
test("edit-guard metadata is recorded when present and tolerated (null) when absent", () => {
  // Present: a run whose meta carries the EDIT_GUARD treatment fields.
  const withGuard = buildRun(
    completeVtraceParts({
      meta: {
        ...completeVtraceParts().meta,
        vtracePivotCheckEnabled: true,
        vtracePivotCheckInjected: true,
        vtraceEditGuardEnabled: true,
        vtraceEditGuardInjected: true,
        vtraceEditGuardDisabledByFlag: false,
        vtraceEditGuardTextPresent: true,
      },
    }),
  );
  assert.equal(withGuard.editGuardEnabled, true);
  assert.equal(withGuard.editGuardInjected, true);
  assert.equal(withGuard.editGuardDisabledByFlag, false);
  assert.equal(withGuard.editGuardTextPresent, true);

  // Absent (old run): the default fixture meta has no edit-guard fields → all null,
  // never a fabricated false. PIVOT_CHECK fields are likewise null here.
  const oldRun = buildRun(completeVtraceParts());
  assert.equal(oldRun.editGuardEnabled, null);
  assert.equal(oldRun.editGuardInjected, null);
  assert.equal(oldRun.editGuardDisabledByFlag, null);
  assert.equal(oldRun.editGuardTextPresent, null);
});

test("buildRun produces a complete run from full metadata", () => {
  const run = buildRun(completeVtraceParts());
  assert.equal(run.condition, "vtrace");
  assert.equal(run.instanceId, "sphinx-doc__sphinx-7462");
  assert.equal(run.protocol, "vtrace-indexed");
  assert.equal(run.treatmentValid, true);
  assert.equal(run.capsuleEngine, "v2");
  assert.equal(run.tokens.total, 1260);
  assert.equal(run.cost, 0.42);
  assert.equal(run.resolved, true);
  assert.equal(run.resolutionSource, "docker_eval");
  assert.equal(run.dataCompleteness, "complete");
  assert.deepEqual(run.editedFiles, ["sphinx/domains/python.py"]);
  // Hidden pivot ast.py was read => inspected; python.py is source-anchored (not hidden).
  assert.equal(run.hiddenPivotCount, 1);
  assert.equal(run.hiddenPivotsInspected, 1);
  assert.equal(run.hiddenPivotsEdited, 0);
  assert.equal(run.hiddenPivotsIgnored, 0);
});

// ---------------------------------------------------------------------------
// 2. Missing _tool_calls.json does not crash and marks partial completeness.
// ---------------------------------------------------------------------------
test("missing tool log does not crash and yields partial completeness when resolution also missing", () => {
  const run = buildRun(
    completeVtraceParts({
      toolCalls: null,
      evalMeta: null, // no resolution => not complete
      record: {
        instanceId: "sphinx-doc__sphinx-7462",
        inputTokens: 1000,
        outputTokens: 200,
        costUsd: 0.42,
        modelPatch: "diff --git a/f.py b/f.py\n--- a/f.py\n+++ b/f.py\n@@ -1 +1 @@\n-a\n+b",
      },
    }),
  );
  assert.equal(run.toolLogOrdered, false);
  assert.equal(run.toolCallCount, null);
  assert.equal(run.hiddenPivotCount, null); // no tool log => unknown engagement
  assert.equal(run.resolved, null);
  assert.equal(run.dataCompleteness, "partial");
});

// ---------------------------------------------------------------------------
// 3. Missing resolution is reported as unknown, not false.
// ---------------------------------------------------------------------------
test("missing resolution is unknown, never false", () => {
  assert.deepEqual(deriveResolution(null, null), { resolved: null, source: "unknown" });
  assert.deepEqual(deriveResolution(null, { resolved: false }), { resolved: false, source: "swebench_jsonl" });
  assert.deepEqual(deriveResolution({ evaluationRan: true, resolvedCount: 0 }, null), {
    resolved: false,
    source: "docker_eval",
  });
  // evaluationRan false and no jsonl flag => still unknown, NOT false.
  assert.deepEqual(deriveResolution({ evaluationRan: false }, {}), { resolved: null, source: "unknown" });
  const run = buildRun(completeVtraceParts({ evalMeta: null, record: { instanceId: "i", inputTokens: 1 } }));
  assert.equal(run.resolved, null);
});

// ---------------------------------------------------------------------------
// 4. Pivot-check before/after pairs are detected from known report JSON.
// ---------------------------------------------------------------------------
test("normalizePivotCheckPair maps a curated pair record into the ledger schema", () => {
  const raw = {
    beforeLabel: "eval-pivot-telemetry-vtrace-sphinx-7462-r2",
    afterLabel: "eval-pivot-check-vtrace-sphinx-7462",
    instanceId: "sphinx-doc__sphinx-7462",
    beforeTokens: 581546,
    afterTokens: 1034743,
    tokenDelta: 453197,
    tokenDeltaPct: 77.9,
    beforeCost: 0.217,
    afterCost: 0.423,
    beforeResolved: null,
    afterResolved: null,
    hiddenPivotsInspectedBefore: 0,
    hiddenPivotsInspectedAfter: 1,
    hiddenPivotsEditedBefore: 0,
    hiddenPivotsEditedAfter: 0,
    editedFilesBefore: ["sphinx/domains/python.py"],
    editedFilesAfter: ["sphinx/domains/python.py"],
  };
  const p = normalizePivotCheckPair(raw, "stage5_pivot_check_targeted_summary.json");
  assert.equal(p.pairType, "pivot_check_before_after");
  assert.equal(p.beforeRunLabel, "eval-pivot-telemetry-vtrace-sphinx-7462-r2");
  assert.equal(p.afterRunLabel, "eval-pivot-check-vtrace-sphinx-7462");
  assert.equal(p.tokenDelta, 453197);
  assert.equal(p.hiddenPivotsConvertedToInspected, 1);
  assert.equal(p.hiddenPivotsConvertedToEdited, 0);
  assert.equal(p.editedFileSetChanged, false);
  assert.equal(p.sourceReport, "stage5_pivot_check_targeted_summary.json");
});

// ---------------------------------------------------------------------------
// 5. Token/cost deltas are calculated correctly.
// ---------------------------------------------------------------------------
test("baseline-vs-vtrace pair computes token/cost deltas correctly", () => {
  const baseline = buildRun(
    completeVtraceParts({
      condition: "baseline",
      meta: { condition: "baseline", exitCode: 0 },
      evalMeta: { evaluationRan: true, resolvedCount: 0 },
      record: { instanceId: "i", resolved: false, inputTokens: 80, outputTokens: 20, costUsd: 0.2, modelPatch: "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x\n+y" },
      toolCalls: null,
    }),
  );
  const vtrace = buildRun(
    completeVtraceParts({
      evalMeta: { evaluationRan: true, resolvedCount: 1 },
      record: { instanceId: "i", resolved: true, inputTokens: 160, outputTokens: 40, costUsd: 0.5, modelPatch: "diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-x\n+y" },
      toolCalls: null,
    }),
  );
  const pair = buildBaselineVtracePair("eval-pair-1", baseline, vtrace);
  assert.equal(pair.beforeTokens, 100);
  assert.equal(pair.afterTokens, 200);
  assert.equal(pair.tokenDelta, 100);
  assert.equal(pair.tokenDeltaPct, 100);
  assert.equal(pair.beforeCost, 0.2);
  assert.equal(pair.afterCost, 0.5);
  assert.ok(Math.abs(pair.costDelta! - 0.3) < 1e-9);
  assert.ok(Math.abs(pair.costDeltaPct! - 150) < 1e-9);
  assert.equal(pair.beforeResolved, false);
  assert.equal(pair.afterResolved, true);
  assert.equal(pair.resolvedChanged, true);
  assert.equal(pair.hiddenPivotsConvertedToInspected, null); // baseline has no pivots
});

test("tokenTotal is null only when every component is null", () => {
  assert.equal(tokenTotal({ input: null, output: null, cacheRead: null, cacheCreation: null }), null);
  assert.equal(tokenTotal({ input: 5, output: null, cacheRead: null, cacheCreation: null }), 5);
});

// ---------------------------------------------------------------------------
// 6. Edited-file-set changes are calculated order-insensitively.
// ---------------------------------------------------------------------------
test("editedFileSetChanged is order-insensitive", () => {
  assert.equal(editedFileSetChanged(["a.py", "b.py"], ["b.py", "a.py"]), false);
  assert.equal(editedFileSetChanged(["a.py"], ["a.py", "b.py"]), true);
  assert.equal(editedFileSetChanged([], []), false);
});

// ---------------------------------------------------------------------------
// 7 + 9. Markdown includes non-claims and does not claim pass@1 when unknown.
// ---------------------------------------------------------------------------
test("markdown includes non-claims and refuses pass@1 when resolution is unknown", () => {
  const run = buildRun(
    completeVtraceParts({ evalMeta: null, record: { instanceId: "i", inputTokens: 10, outputTokens: 5, costUsd: 0.1 }, toolCalls: null }),
  );
  const report = buildReport([run], [], "results", "2026-06-09T00:00:00.000Z");
  const md = renderMarkdown(report);
  assert.match(md, /## Non-claims/);
  assert.match(md, /## Summary/);
  assert.match(md, /## Run inventory/);
  assert.match(md, /## Pair inventory/);
  assert.match(md, /## Resolution summary/);
  assert.match(md, /## Data completeness/);
  assert.match(md, /## Recommended next benchmark step/);
  // No evaluated resolution => explicit refusal to define pass@1.
  assert.match(md, /pass@1 \/ resolved-rate is not defined/);
  assert.doesNotMatch(md, /pass@1 = /);
});

// ---------------------------------------------------------------------------
// 8. JSON exposes runs[] and pairs[].
// ---------------------------------------------------------------------------
test("json exposes runs[] and pairs[] with required fields", () => {
  const run = buildRun(completeVtraceParts());
  const baselinePair = buildBaselineVtracePair("eval-pair-1", run, run);
  const report = buildReport([run], [baselinePair], "results", "2026-06-09T00:00:00.000Z");
  const json = JSON.parse(renderJson(report));
  assert.ok(Array.isArray(json.runs));
  assert.ok(Array.isArray(json.pairs));
  assert.equal(json.resultsDir, "results");
  for (const f of ["runLabel", "instanceId", "protocol", "treatmentValid", "tokens", "resolved", "resolutionSource", "dataCompleteness", "rawArtifactPaths"]) {
    assert.ok(f in json.runs[0], `runs[] missing ${f}`);
  }
  for (const f of ["instanceId", "beforeRunLabel", "afterRunLabel", "pairType", "tokenDelta", "editedFileSetChanged", "sourceReport"]) {
    assert.ok(f in json.pairs[0], `pairs[] missing ${f}`);
  }
});

// ---------------------------------------------------------------------------
// classifyCompleteness direct coverage.
// ---------------------------------------------------------------------------
test("classifyCompleteness covers all four states", () => {
  const base = {
    hasMeta: true,
    treatmentKnown: true,
    tokensKnown: true,
    costKnown: true,
    editedFilesKnown: true,
    resolutionKnown: true,
    toolLogOrdered: true,
    patchOrResultDetails: true,
  };
  assert.equal(classifyCompleteness(base), "complete");
  assert.equal(classifyCompleteness({ ...base, resolutionKnown: false }), "partial");
  assert.equal(
    classifyCompleteness({ ...base, resolutionKnown: false, tokensKnown: false, toolLogOrdered: false, patchOrResultDetails: false }),
    "metadata_only",
  );
  assert.equal(classifyCompleteness({ ...base, hasMeta: false }), "missing");
});

// ---------------------------------------------------------------------------
// Loader end-to-end over a temp fixture dir (no dependency on real artifacts).
// ---------------------------------------------------------------------------
test("loadRuns + buildLedger read a temp fixture results dir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stage5-ledger-"));
  const condDir = path.join(dir, "runs", "eval-fixture-1", "raw", "vtrace");
  await mkdir(condDir, { recursive: true });
  await writeFile(
    path.join(condDir, "_run.meta.json"),
    JSON.stringify({
      condition: "vtrace",
      instances: ["x__y-1"],
      exitCode: 0,
      vtraceTreatmentValid: true,
      vtraceCapsuleEngine: "v2",
      vtraceCapsuleIntent: "debug",
      vtraceCapsuleBudget: 8000,
      vtracePivotCount: 1,
    }),
  );
  await writeFile(
    path.join(condDir, "swebench-2026-01-01.jsonl"),
    `${JSON.stringify({ instanceId: "x__y-1", resolved: true, inputTokens: 10, outputTokens: 5, costUsd: 0.05, modelPatch: "diff --git a/z.py b/z.py\n--- a/z.py\n+++ b/z.py\n@@ -1 +1 @@\n-a\n+b" })}\n`,
  );
  await writeFile(path.join(condDir, "_eval.meta.json"), JSON.stringify({ evaluationRan: true, resolvedCount: 1 }));

  const runs = await loadRuns(dir);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.runLabel, "eval-fixture-1");
  assert.equal(runs[0]!.resolved, true);
  assert.equal(runs[0]!.resolutionSource, "docker_eval");

  const report = await buildLedger(dir, "2026-06-09T00:00:00.000Z");
  assert.equal(report.summary.totalRuns, 1);
  assert.equal(report.summary.runsWithResolutionKnown, 1);
  assert.equal(report.summary.validVtraceRuns, 1);
});

// ---------------------------------------------------------------------------
// Cross-label controlled pairs (the fix): baseline + vtrace from SEPARATE labels.
// ---------------------------------------------------------------------------
test("same-label baseline-vs-vtrace pair is tagged same_label", () => {
  const run = buildRun(completeVtraceParts());
  const pair = buildBaselineVtracePair("eval-pair-1", run, run);
  assert.equal(pair.labelScope, "same_label");
});

test("buildCrossLabelControlledPair preserves both real labels and computes deltas", () => {
  const baseline = makeRun({
    runLabel: "eval-localization-gap-baseline-matplotlib-22719",
    condition: "baseline",
    instanceId: "matplotlib__matplotlib-22719",
    resolved: true,
    cost: 0.46,
    tokens: { input: 1, output: 1, cacheRead: null, cacheCreation: null, total: 1167993 },
  });
  const vtrace = makeRun({
    runLabel: "eval-controlled-vtrace-matplotlib-22719",
    condition: "vtrace",
    instanceId: "matplotlib__matplotlib-22719",
    resolved: false,
    cost: 0.96,
    tokens: { input: 1, output: 1, cacheRead: null, cacheCreation: null, total: 2718398 },
  });
  const pair = buildCrossLabelControlledPair(baseline, vtrace);
  assert.equal(pair.pairType, "baseline_vs_vtrace");
  assert.equal(pair.labelScope, "cross_label");
  assert.equal(pair.beforeRunLabel, "eval-localization-gap-baseline-matplotlib-22719");
  assert.equal(pair.afterRunLabel, "eval-controlled-vtrace-matplotlib-22719");
  assert.notEqual(pair.beforeRunLabel, pair.afterRunLabel);
  assert.equal(pair.tokenDelta, 2718398 - 1167993);
  assert.equal(pair.beforeResolved, true);
  assert.equal(pair.afterResolved, false);
  assert.equal(pair.resolvedChanged, true);
});

test("detectCrossLabelControlledPairs pairs an evaluated controlled vtrace with the best baseline", () => {
  const runs: LedgerRun[] = [
    makeRun({ runLabel: "eval-baseline-vs-vtrace-baseline-astropy-14369", condition: "baseline", instanceId: "astropy__astropy-14369", resolved: false }),
    makeRun({ runLabel: "eval-controlled-vtrace-astropy-14369", condition: "vtrace", instanceId: "astropy__astropy-14369", resolved: false }),
    // Unrelated baseline for a different instance must not be paired.
    makeRun({ runLabel: "eval-x-baseline", condition: "baseline", instanceId: "other__o-1", resolved: true }),
  ];
  const pairs = detectCrossLabelControlledPairs(runs);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.instanceId, "astropy__astropy-14369");
  assert.equal(pairs[0]!.labelScope, "cross_label");
  assert.equal(pairs[0]!.beforeRunLabel, "eval-baseline-vs-vtrace-baseline-astropy-14369");
  assert.equal(pairs[0]!.afterRunLabel, "eval-controlled-vtrace-astropy-14369");
});

test("an unevaluated controlled vtrace yields NO cross-label pair", () => {
  const runs: LedgerRun[] = [
    makeRun({ runLabel: "eval-some-baseline-sphinx-7462", condition: "baseline", instanceId: "sphinx-doc__sphinx-7462", resolved: false }),
    // resolved === null => never evaluated => not a finished comparable pair.
    makeRun({ runLabel: "eval-controlled-vtrace-sphinx-7462", condition: "vtrace", instanceId: "sphinx-doc__sphinx-7462", resolved: null }),
  ];
  assert.deepEqual(detectCrossLabelControlledPairs(runs), []);
});

test("a controlled vtrace with no baseline for its instance yields NO pair", () => {
  const runs: LedgerRun[] = [
    makeRun({ runLabel: "eval-controlled-vtrace-requests-5414", condition: "vtrace", instanceId: "psf__requests-5414", resolved: false }),
  ];
  assert.deepEqual(detectCrossLabelControlledPairs(runs), []);
});

test("detectCrossLabelControlledPairs prefers an evaluated baseline on ties", () => {
  const runs: LedgerRun[] = [
    makeRun({ runLabel: "eval-aaa-baseline-sympy-16766", condition: "baseline", instanceId: "sympy__sympy-16766", resolved: null }),
    makeRun({ runLabel: "eval-zzz-baseline-sympy-16766", condition: "baseline", instanceId: "sympy__sympy-16766", resolved: true }),
    makeRun({ runLabel: "eval-controlled-vtrace-sympy-16766", condition: "vtrace", instanceId: "sympy__sympy-16766", resolved: false }),
  ];
  const pairs = detectCrossLabelControlledPairs(runs);
  assert.equal(pairs.length, 1);
  // The EVALUATED baseline wins despite sorting later alphabetically.
  assert.equal(pairs[0]!.beforeRunLabel, "eval-zzz-baseline-sympy-16766");
});

test("buildLedger emits cross-label pairs end-to-end from a temp fixture", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stage5-ledger-cross-"));
  const write = async (label: string, cond: string, instanceId: string, resolved: boolean) => {
    const condDir = path.join(dir, "runs", label, "raw", cond);
    await mkdir(condDir, { recursive: true });
    await writeFile(
      path.join(condDir, "_run.meta.json"),
      JSON.stringify({ condition: cond, instances: [instanceId], exitCode: 0, vtraceTreatmentValid: cond === "vtrace" ? true : undefined }),
    );
    await writeFile(path.join(condDir, "_eval.meta.json"), JSON.stringify({ evaluationRan: true, resolvedCount: resolved ? 1 : 0 }));
    await writeFile(
      path.join(condDir, "swebench-x.jsonl"),
      `${JSON.stringify({ instanceId, resolved, inputTokens: 100, outputTokens: 0, costUsd: 0.2, modelPatch: "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-a\n+b" })}\n`,
    );
  };
  // Separate-label baseline + controlled vtrace for one instance.
  await write("eval-localization-gap-baseline-sphinx-7462", "baseline", "sphinx-doc__sphinx-7462", false);
  await write("eval-controlled-vtrace-sphinx-7462", "vtrace", "sphinx-doc__sphinx-7462", false);

  const report = await buildLedger(dir, null);
  const cross = report.pairs.filter((p) => p.labelScope === "cross_label");
  assert.equal(cross.length, 1);
  assert.equal(cross[0]!.beforeRunLabel, "eval-localization-gap-baseline-sphinx-7462");
  assert.equal(cross[0]!.afterRunLabel, "eval-controlled-vtrace-sphinx-7462");
  assert.equal(report.summary.baselineVsVtracePairs, 1);
  // Markdown marks it cross-label.
  assert.match(renderMarkdown(report), /cross-label/);
});

test("loadRuns enumerates both conditions and detectBaselineVtracePairs pairs them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stage5-ledger-pair-"));
  for (const [cond, resolved, tokens] of [
    ["baseline", false, 100],
    ["vtrace", true, 200],
  ] as const) {
    const condDir = path.join(dir, "runs", "eval-both-1", "raw", cond);
    await mkdir(condDir, { recursive: true });
    await writeFile(path.join(condDir, "_run.meta.json"), JSON.stringify({ condition: cond, instances: ["x__y-1"], exitCode: 0, vtraceTreatmentValid: cond === "vtrace" ? true : undefined }));
    await writeFile(path.join(condDir, "_eval.meta.json"), JSON.stringify({ evaluationRan: true, resolvedCount: resolved ? 1 : 0 }));
    await writeFile(
      path.join(condDir, "swebench-x.jsonl"),
      `${JSON.stringify({ instanceId: "x__y-1", resolved, inputTokens: tokens, outputTokens: 0, costUsd: 0.1, modelPatch: "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-a\n+b" })}\n`,
    );
  }
  const report = await buildLedger(dir, null);
  assert.equal(report.summary.totalRuns, 2);
  assert.equal(report.summary.baselineVsVtracePairs, 1);
  const pair = report.pairs.find((p) => p.pairType === "baseline_vs_vtrace")!;
  assert.equal(pair.beforeTokens, 100);
  assert.equal(pair.afterTokens, 200);
  assert.equal(pair.resolvedChanged, true);
});
