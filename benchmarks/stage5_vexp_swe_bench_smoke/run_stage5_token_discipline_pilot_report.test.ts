// Tests for the Stage 5 token-discipline pilot comparison report (Phase 3).
//   * reads the historical matplotlib overhead fixture,
//   * reads the new rerun fixture (ledger tokens + tool-call stats + eval meta),
//   * computes token / tool / Bash deltas,
//   * detects improved turn count,
//   * detects quality regression (new resolved=false while baseline resolved=true),
//   * readyFor100TaskBenchmark stays false,
//   * required Markdown sections are emitted.
// All fixtures on a temp dir — NO Docker, model, or agent calls occur.

import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildPilotReport,
  computeVerdict,
  loadHistoricalOverhead,
  loadNewRerun,
  renderMarkdown,
  type HistoricalOverhead,
  type NewRerun,
} from "./run_stage5_token_discipline_pilot_report";

const INSTANCE = "matplotlib__matplotlib-22719";

// The historical worst-overhead numbers (from the token-path audit).
function historicalFixture(): HistoricalOverhead {
  return {
    vtraceRunLabel: "eval-controlled-vtrace-matplotlib-22719",
    baselineRunLabel: "eval-localization-gap-baseline-matplotlib-22719",
    vtraceTotalTokens: 2_718_398,
    baselineTotalTokens: 1_167_993,
    cacheReadTokens: 2_632_899,
    tokenDeltaPct: 132.74,
    vtraceToolCallCount: 30,
    vtraceBashCount: 16,
    vtraceRepeatedReadOrSearch: 9,
    vtraceResolved: false,
    baselineResolved: true,
    tokenReductionRisk: "high",
  };
}

// A "good" new rerun: tokens and turns down, Bash below high-risk, risk medium.
function improvedRerun(resolved: boolean): NewRerun {
  return {
    newRunLabel: "eval-token-discipline-pilot-matplotlib-22719",
    vtrace: {
      runLabel: "eval-token-discipline-pilot-matplotlib-22719",
      totalTokens: 1_300_000,
      cacheReadTokens: 1_100_000,
      costUsd: 0.6,
      toolCallCount: 8,
      bashCount: 2,
      repeatedReadOrSearch: 0,
      resolved,
    },
    baseline: {
      runLabel: "eval-token-discipline-pilot-matplotlib-22719",
      totalTokens: 1_150_000,
      cacheReadTokens: 1_080_000,
      costUsd: 0.55,
      toolCallCount: 9,
      bashCount: 3,
      repeatedReadOrSearch: 0,
      resolved: true,
    },
    tokenReductionRisk: "medium",
    tokenDisciplineInjected: true,
    tokenDisciplineMode: "strong_context_patch_first",
  };
}

// 3. Pilot report reads the historical matplotlib fixture from disk.
test("loadHistoricalOverhead reads the matplotlib audit + risk fixtures", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pilot-hist-"));
  await writeFile(
    path.join(dir, "stage5_token_path_audit.json"),
    JSON.stringify({
      tasks: [
        {
          instanceId: INSTANCE,
          baselineRunLabel: "base",
          vtraceRunLabel: "vt",
          baselineTotalTokens: 1_167_993,
          vtraceTotalTokens: 2_718_398,
          tokenDeltaPct: 132.74,
          cacheReadTokens: 2_632_899,
          baselineResolved: true,
          vtraceResolved: false,
          toolCallCount: 30,
          bashCallCount: 16,
          repeatedReadOrSearchCalls: 9,
        },
      ],
    }),
  );
  await writeFile(
    path.join(dir, "stage5_turn_count_reduction.json"),
    JSON.stringify({ cases: [{ instanceId: INSTANCE, risk: "high" }] }),
  );
  const h = await loadHistoricalOverhead(dir, INSTANCE);
  assert.ok(h);
  assert.equal(h!.vtraceTotalTokens, 2_718_398);
  assert.equal(h!.vtraceBashCount, 16);
  assert.equal(h!.tokenReductionRisk, "high");
  assert.equal(h!.baselineResolved, true);
});

// 4. Pilot report reads the new rerun fixture (tool stats + eval meta + ledger).
test("loadNewRerun reads tool-call stats, eval resolution, and ledger tokens", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pilot-new-"));
  const label = "eval-token-discipline-pilot-matplotlib-22719";
  const vtRaw = path.join(dir, "runs", label, "raw", "vtrace");
  await mkdir(vtRaw, { recursive: true });
  await writeFile(
    path.join(vtRaw, "_tool_calls.json"),
    JSON.stringify([
      { tool: "Read", category: "read", path: "a.py" },
      { tool: "Edit", category: "edit", path: "a.py" },
      { tool: "Bash", category: "other", path: null },
    ]),
  );
  await writeFile(path.join(vtRaw, "_eval.meta.json"), JSON.stringify({ resolvedCount: 1 }));
  await writeFile(
    path.join(dir, "stage5_outcome_ledger.json"),
    JSON.stringify({
      runs: [
        { runLabel: label, condition: "vtrace", tokens: { total: 1_300_000, cacheRead: 1_100_000 }, resolved: true },
      ],
    }),
  );
  const n = await loadNewRerun(dir, label, { injected: true, mode: "strong_context_patch_first", risk: "medium" });
  assert.ok(n);
  assert.equal(n!.vtrace.totalTokens, 1_300_000);
  assert.equal(n!.vtrace.cacheReadTokens, 1_100_000);
  assert.equal(n!.vtrace.toolCallCount, 3);
  assert.equal(n!.vtrace.bashCount, 1);
  assert.equal(n!.vtrace.resolved, true);
  assert.equal(n!.tokenDisciplineInjected, true);
});

// loadNewRerun reads token/cost from the swebench-*.jsonl row when _run.meta.json
// carries no token totals (the real new-rerun path: tool counts in _run.meta.json,
// token/cost only in the per-instance swebench results row).
test("loadNewRerun reads token/cost from swebench-*.jsonl when _run.meta.json lacks token totals", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pilot-jsonl-"));
  const label = "eval-token-discipline-pilot-matplotlib-22719";
  for (const condition of ["vtrace", "baseline"] as const) {
    const raw = path.join(dir, "runs", label, "raw", condition);
    await mkdir(raw, { recursive: true });
    // _run.meta.json: ordered telemetry / tool counts, but NO token totals.
    await writeFile(
      path.join(raw, "_run.meta.json"),
      JSON.stringify({ condition, vtraceToolCallCount: condition === "vtrace" ? 10 : 11, orderedTelemetryAvailable: true }),
    );
    await writeFile(
      path.join(raw, "_tool_calls.json"),
      JSON.stringify([
        { tool: "Read", category: "read", path: "a.py" },
        { tool: "Edit", category: "edit", path: "a.py" },
        { tool: "Bash", category: "other", path: null },
      ]),
    );
    await writeFile(path.join(raw, "_eval.meta.json"), JSON.stringify({ resolvedCount: 0 }));
  }
  // VTRACE swebench row: total = 230 + 56 + 1_120_119 + 67_260 = 1_187_665.
  await writeFile(
    path.join(dir, "runs", label, "raw", "vtrace", "swebench-2026-06-12.jsonl"),
    JSON.stringify({
      instanceId: INSTANCE,
      inputTokens: 230,
      outputTokens: 56,
      cacheReadTokens: 1_120_119,
      cacheCreationTokens: 67_260,
      costUsd: 0.545993,
      resolved: false,
    }) + "\n",
  );
  // Baseline swebench row: total = 230 + 52 + 1_060_520 + 55_448 = 1_116_250.
  await writeFile(
    path.join(dir, "runs", label, "raw", "baseline", "swebench-2026-06-12.jsonl"),
    JSON.stringify({
      instanceId: INSTANCE,
      inputTokens: 230,
      outputTokens: 52,
      cacheReadTokens: 1_060_520,
      cacheCreationTokens: 55_448,
      costUsd: 0.509173,
      resolved: false,
    }) + "\n",
  );
  const n = await loadNewRerun(dir, label, { injected: true, mode: "strong_context_patch_first", risk: "medium" });
  assert.ok(n);
  assert.equal(n!.vtrace.totalTokens, 1_187_665);
  assert.equal(n!.vtrace.cacheReadTokens, 1_120_119);
  assert.equal(n!.vtrace.costUsd, 0.545993);
  assert.equal(n!.vtrace.resolved, false);
  assert.equal(n!.baseline.totalTokens, 1_116_250);
  assert.equal(n!.baseline.resolved, false);
});

// When no run is on disk, loadNewRerun returns null (the run has not happened).
test("loadNewRerun returns null when no telemetry exists", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pilot-empty-"));
  const n = await loadNewRerun(dir, "missing-label", { injected: true, mode: "strong_context_patch_first", risk: null });
  assert.equal(n, null);
});

// 5. Computes token / tool / Bash deltas.
test("computeVerdict computes token/tool/Bash reductions", () => {
  const v = computeVerdict(historicalFixture(), improvedRerun(false));
  // total: (2,718,398 - 1,300,000) / 2,718,398 ≈ 0.52
  assert.ok(v.totalTokenReductionFraction! > 0.5);
  // cacheRead: (2,632,899 - 1,100,000) / 2,632,899 ≈ 0.58
  assert.ok(v.cacheReadReductionFraction! > 0.5);
  assert.equal(v.tokenOverheadImproved, true);
});

// 6. Detects improved turn count (fewer tools, Bash below high-risk, lower risk).
test("computeVerdict detects improved turn count", () => {
  const v = computeVerdict(historicalFixture(), improvedRerun(false));
  assert.equal(v.turnCountImproved, true);
  assert.equal(v.bashDroppedBelowHighRisk, true);
  assert.equal(v.riskTierImproved, true);
});

// 7. Detects quality regression: new resolved=false while baseline resolved=true.
test("computeVerdict flags quality regression when new VTRACE loses to baseline", () => {
  const v = computeVerdict(historicalFixture(), improvedRerun(false));
  assert.equal(v.qualityRegressed, true);
  // Historical VTRACE was already unresolved, so this is NOT worse-than-historical.
  assert.equal(v.qualityWorseThanHistorical, false);
});

// When the new VTRACE run RESOLVES, there is no quality regression.
test("computeVerdict reports no regression when new VTRACE resolves", () => {
  const v = computeVerdict(historicalFixture(), improvedRerun(true));
  assert.equal(v.qualityRegressed, false);
  assert.equal(v.qualityWorseThanHistorical, false);
});

// 8. readyFor100TaskBenchmark stays false (and is the literal false type).
test("buildPilotReport keeps readyFor100TaskBenchmark false", () => {
  const resolved = buildPilotReport({
    generatedAt: null,
    historical: historicalFixture(),
    newRerun: improvedRerun(true),
    newRunLabel: "eval-token-discipline-pilot-matplotlib-22719",
    preflightPassed: true,
  });
  assert.equal(resolved.readyFor100TaskBenchmark, false);
  // Overhead win + no regression vs historical → ready for MORE overhead cases.
  assert.equal(resolved.readyForMoreOverheadCases, true);

  const noRun = buildPilotReport({
    generatedAt: null,
    historical: historicalFixture(),
    newRerun: null,
    newRunLabel: "eval-token-discipline-pilot-matplotlib-22719",
    preflightPassed: true,
  });
  assert.equal(noRun.readyFor100TaskBenchmark, false);
  // No new run → cannot be ready for more.
  assert.equal(noRun.readyForMoreOverheadCases, false);
  assert.equal(noRun.tokenOverheadImproved, null);
});

// Readiness withholds when the new run loses ground historical VTRACE held.
test("buildPilotReport withholds readiness on a worse-than-historical regression", () => {
  const hist: HistoricalOverhead = { ...historicalFixture(), vtraceResolved: true };
  const report = buildPilotReport({
    generatedAt: null,
    historical: hist,
    newRerun: improvedRerun(false),
    newRunLabel: "eval-token-discipline-pilot-matplotlib-22719",
    preflightPassed: true,
  });
  assert.equal(report.verdict.qualityWorseThanHistorical, true);
  assert.equal(report.readyForMoreOverheadCases, false);
});

// Readiness requires REAL token totals: if the new rerun's totalTokens is null,
// readyForMoreOverheadCases is false regardless of any turn-count improvement.
test("buildPilotReport withholds readiness when token totals are unavailable", () => {
  const rerunNoTokens: NewRerun = {
    ...improvedRerun(true),
    vtrace: { ...improvedRerun(true).vtrace, totalTokens: null, cacheReadTokens: null },
  };
  const report = buildPilotReport({
    generatedAt: null,
    historical: historicalFixture(),
    newRerun: rerunNoTokens,
    newRunLabel: "eval-token-discipline-pilot-matplotlib-22719",
    preflightPassed: true,
  });
  // Turn count still improved, but without token totals we are not ready.
  assert.equal(report.turnCountImproved, true);
  assert.equal(report.readyForMoreOverheadCases, false);
});

// New VTRACE total-token overhead vs the same-label baseline is surfaced.
test("buildPilotReport computes new VTRACE overhead vs same-label baseline", () => {
  const report = buildPilotReport({
    generatedAt: null,
    historical: historicalFixture(),
    newRerun: improvedRerun(false),
    newRunLabel: "eval-token-discipline-pilot-matplotlib-22719",
    preflightPassed: true,
  });
  // (1,300,000 - 1,150,000) / 1,150,000 ≈ 0.1304
  assert.ok(report.newVtraceOverheadVsBaselineFraction! > 0.12);
  assert.ok(report.newVtraceOverheadVsBaselineFraction! < 0.14);
});

// Pending-state report (no live rerun) must say so unambiguously and honestly.
test("renderMarkdown pending state states Phase-2 pending and null new-side", () => {
  const report = buildPilotReport({
    generatedAt: "2026-06-12T00:00:00Z",
    historical: historicalFixture(),
    newRerun: null,
    newRunLabel: "eval-token-discipline-pilot-matplotlib-22719",
    preflightPassed: true,
    preflightMode: "strong_context_patch_first",
  });
  assert.equal(report.liveRerunPending, true);
  assert.equal(report.newVtraceTotalTokens, null);
  assert.equal(report.tokenOverheadImproved, null);
  assert.equal(report.readyForMoreOverheadCases, false);
  assert.equal(report.readyFor100TaskBenchmark, false);
  const md = renderMarkdown(report);
  assert.ok(md.includes("Phase 1 preflight PASSED"));
  assert.ok(md.includes("Phase 2 live paired rerun is PENDING"));
  assert.ok(md.includes("newVtrace*` fields are null/unavailable"));
  assert.ok(md.includes("not yet measured"));
  assert.ok(md.includes("deliberate, SUPERVISED live paired rerun"));
  // Preflight section reports the PREFLIGHT mode, not the (disabled) new-run mode.
  assert.ok(md.includes("strong_context_patch_first` mode"));
});

// 9. Required Markdown sections are emitted.
test("renderMarkdown emits every required section", () => {
  const report = buildPilotReport({
    generatedAt: "2026-06-12T00:00:00Z",
    historical: historicalFixture(),
    newRerun: improvedRerun(false),
    newRunLabel: "eval-token-discipline-pilot-matplotlib-22719",
    preflightPassed: true,
  });
  const md = renderMarkdown(report);
  for (const section of [
    "# Stage 5 token-discipline pilot: matplotlib-22719",
    "## Summary",
    "## Why this case",
    "## Preflight",
    "## Historical overhead",
    "## New paired rerun",
    "## Token-path comparison",
    "## Turn-count comparison",
    "## Resolution/quality comparison",
    "## Interpretation",
    "## Recommended next step",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(section), `missing section: ${section}`);
  }
  // Required interpretation + non-claims wording present.
  assert.ok(md.includes("targeted engineering check before scaling"));
  assert.ok(md.includes("does not establish the 100-task token-reduction number"));
});
