import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PatchCriticReport } from "./stage5_patch_critic";
import type { LiveCriticMeta } from "./stage5_patch_critic_live";
import {
  type ComparisonInputs,
  buildComparison,
  loadComparisonInputs,
  parseArgs,
  renderJson,
  renderMarkdown,
} from "./run_stage5_live_critic_smoke_comparison";

const RUN_LABEL = "eval-patchverify-before-sympy-16766";
const INSTANCE = "sympy__sympy-16766";

const FIRST_PATCH =
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py\n" +
  "@@ -346,6 +346,10 @@ def _print_Stream(self, strm):\n" +
  "+    def _print_Indexed(self, expr):\n";

// Deterministic critic verdict for this run (as it appears in the dry-run report): high-risk scope fail.
const DET_REPORT: PatchCriticReport = {
  instanceId: INSTANCE,
  runLabel: RUN_LABEL,
  scope_ok: false,
  scope_evidence: "inserted method(s) _print_Indexed in AbstractPythonCodePrinter (line 349) landed outside PythonCodePrinter.",
  failing_behavior_handled: null,
  failing_behavior_evidence: "no failing-behavior pattern configured",
  minimality_ok: true,
  minimality_evidence: "+4/-0",
  test_evidence_ok: false,
  test_evidence: "ad-hoc python check only",
  risk: "high",
  repair_required: true,
  repair_reason: "inserted method(s) landed outside the expected class (high-confidence scope fail).",
  repair_instructions: "Move the inserted _print_* methods into PythonCodePrinter.",
  confidence: "high",
  evidence_probe_ids: ["inserted_method_scope"],
};

// A second deterministic report that is also repair_required (for the next-step derivation test).
const DET_REPORT_MPL: PatchCriticReport = {
  ...DET_REPORT,
  instanceId: "matplotlib__matplotlib-22719",
  runLabel: "eval-editguard-before-matplotlib-22719",
};
// A low-risk one that should NOT be suggested.
const DET_REPORT_LOWRISK: PatchCriticReport = {
  ...DET_REPORT,
  instanceId: "matplotlib__matplotlib-22719",
  runLabel: "eval-patchverify-before-matplotlib-22719",
  scope_ok: true,
  risk: "low",
  repair_required: false,
};

const LIVE_REPORT: PatchCriticReport = {
  instanceId: INSTANCE,
  runLabel: RUN_LABEL,
  scope_ok: false,
  scope_evidence: "inserted_method_scope (high) shows _print_Indexed was inserted into AbstractPythonCodePrinter (line 349), not PythonCodePrinter.",
  failing_behavior_handled: true,
  failing_behavior_evidence: "method is inherited via AbstractPythonCodePrinter, so the behavior is functionally produced.",
  minimality_ok: true,
  minimality_evidence: "+4/-0, purely additive.",
  test_evidence_ok: null,
  test_evidence: "only an ad-hoc python3 -c smoke check; too weak to confirm.",
  risk: "medium",
  repair_required: true,
  repair_reason: "Wrong scope: _print_Indexed landed in AbstractPythonCodePrinter, broadening behavior.",
  repair_instructions: "Relocate _print_Indexed out of AbstractPythonCodePrinter into PythonCodePrinter, preserving implementation and indentation.",
  confidence: "medium",
  evidence_probe_ids: ["inserted_method_scope"],
};

const LIVE_META: LiveCriticMeta = {
  enabled: true,
  ran: true,
  validReport: true,
  failedOpen: false,
  error: null,
  criticModel: null,
  criticCostUsd: 0.12178375,
  criticInputTokens: 4343,
  criticOutputTokens: 2487,
  deterministicRepairRequired: true,
  liveRepairRequired: true,
  agreementWithDeterministic: true,
};

function okInputs(overrides: Partial<ComparisonInputs> = {}): ComparisonInputs {
  return {
    liveMeta: LIVE_META,
    liveReport: LIVE_REPORT,
    criticInput: {
      instanceId: INSTANCE,
      firstPatch: FIRST_PATCH,
      probeSummary: {
        overallRisk: "high",
        knownDefectLikelyCaught: true,
        probes: [
          {
            probeId: "inserted_method_scope",
            status: "fail",
            confidence: "high",
            evidence: ["inserted _print_Indexed in AbstractPythonCodePrinter (line 349) landed outside PythonCodePrinter."],
          },
        ],
      },
    },
    firstPatchDiff: FIRST_PATCH,
    deterministicReport: DET_REPORT,
    deterministicReports: [DET_REPORT, DET_REPORT_MPL, DET_REPORT_LOWRISK],
    smoke: { gates: { criticCostCapUsd: 0.25 }, counters: { totalCriticCostUsd: 0.12178375 } },
    missing: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1 + 2 + 3 + 4: ok smoke — valid report, repair_required agreement, cost, no fail-open.
// ---------------------------------------------------------------------------
test("ok smoke: valid report, repair_required agreement, same core defect, cost/tokens, no fail-open", () => {
  const report = buildComparison({ generatedAt: "2026-06-10T00:00:00.000Z", runLabel: RUN_LABEL, inputs: okInputs() });

  assert.equal(report.status, "ok");
  assert.equal(report.instanceId, INSTANCE);

  // (1) valid structured report detected
  assert.equal(report.live.validReport, true);
  assert.equal(report.live.ran, true);

  // (2) live repair_required compared with deterministic repair_required
  assert.equal(report.deterministic.repairRequired, true);
  assert.equal(report.live.repairRequired, true);
  assert.equal(report.agreement.repairRequiredAgreement, true);
  assert.equal(report.summary.sameCoreDefect, true);
  assert.ok(report.agreement.coreDefect && report.agreement.coreDefect.includes("AbstractPythonCodePrinter"));

  // Per-field nuance is surfaced, not hidden: risk/confidence differ even though repair_required agrees.
  assert.equal(report.agreement.riskComparison.deterministic, "high");
  assert.equal(report.agreement.riskComparison.live, "medium");

  // (3) cost/tokens computed and within cap
  assert.equal(report.cost.criticCostUsd, 0.12178375);
  assert.equal(report.cost.criticInputTokens, 4343);
  assert.equal(report.cost.criticOutputTokens, 2487);
  assert.equal(report.cost.costCapUsd, 0.25);
  assert.equal(report.cost.withinCostCap, true);

  // (4) valid, no fail-open smoke
  assert.equal(report.live.failedOpen, false);
  assert.equal(report.safety.failedOpen, false);

  // Safety: patch confirmed unchanged (input.firstPatch === _first_patch.diff).
  assert.equal(report.safety.patchUnchanged, true);
  assert.equal(report.safety.repairPerformed, false);
  assert.equal(report.safety.dockerRun, false);
});

// ---------------------------------------------------------------------------
// 5: emits Markdown sections and JSON fields.
// ---------------------------------------------------------------------------
test("emits all required Markdown sections and JSON fields", () => {
  const report = buildComparison({ generatedAt: "t", runLabel: RUN_LABEL, inputs: okInputs() });

  const parsed = JSON.parse(renderJson(report));
  for (const field of [
    "generatedAt",
    "runLabel",
    "instanceId",
    "summary",
    "deterministic",
    "live",
    "agreement",
    "cost",
    "safety",
    "recommendation",
    "nonClaims",
  ]) {
    assert.ok(field in parsed, `missing JSON field ${field}`);
  }
  assert.ok(Array.isArray(parsed.nonClaims) && parsed.nonClaims.length > 0);

  const md = renderMarkdown(report, []);
  for (const heading of [
    "# Stage 5 live critic smoke comparison",
    "## Summary",
    "## Smoke setup",
    "## Deterministic critic result",
    "## Live critic result",
    "## Agreement analysis",
    "## Added value over deterministic probes",
    "## Cost and token impact",
    "## Safety properties",
    "## Recommended next step",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `markdown missing section: ${heading}`);
  }
});

// ---------------------------------------------------------------------------
// Recommended next step derives the remaining deterministic high-risk runs, excludes low-risk + smoked.
// ---------------------------------------------------------------------------
test("recommendation derives remaining deterministic repair_required runs, excludes low-risk and the smoked run", () => {
  const report = buildComparison({ generatedAt: "t", runLabel: RUN_LABEL, inputs: okInputs() });
  const labels = report.recommendation.suggestedRunLabels;
  assert.ok(!labels.includes(RUN_LABEL), "must exclude the already-smoked run");
  assert.ok(!labels.includes("eval-patchverify-before-matplotlib-22719"), "must exclude low-risk run");
  assert.ok(labels.includes("eval-editguard-before-matplotlib-22719"));
  assert.equal(report.recommendation.excludesLowRisk, true);
  // Conservative: no repair recommended.
  assert.ok(/no-repair/i.test(report.recommendation.choice));
});

// ---------------------------------------------------------------------------
// 6: missing live critic artifacts -> clear status, no throw.
// ---------------------------------------------------------------------------
test("missing live artifacts yields a clear status and does not throw", () => {
  const report = buildComparison({
    generatedAt: "t",
    runLabel: RUN_LABEL,
    inputs: okInputs({ liveMeta: null, liveReport: null, missing: ["/x/_patch_critic.meta.json"] }),
  });
  assert.equal(report.status, "missing-live-artifacts");
  assert.ok(report.summary.text.toLowerCase().includes("not found"));
  // Still renders without throwing.
  const md = renderMarkdown(report, ["/x/_patch_critic.meta.json"]);
  assert.ok(md.includes("## Summary"));
  assert.ok(md.includes("Missing/unreadable inputs"));
});

test("invalid (failed-open) live report is reported as invalid-live-report", () => {
  const badMeta: LiveCriticMeta = { ...LIVE_META, validReport: false, failedOpen: true };
  const report = buildComparison({
    generatedAt: "t",
    runLabel: RUN_LABEL,
    inputs: okInputs({ liveMeta: badMeta }),
  });
  assert.equal(report.status, "invalid-live-report");
  assert.equal(report.safety.failedOpen, true);
});

// ---------------------------------------------------------------------------
// 7: loader is read-only; no model calls or Docker. Reads real artifact files from a temp fixture.
// ---------------------------------------------------------------------------
test("loadComparisonInputs reads meta/report/input artifacts read-only and fails soft on absent files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vtrace-critic-cmp-"));
  try {
    const vtraceDir = path.join(dir, "runs", RUN_LABEL, "raw", "vtrace");
    await mkdir(vtraceDir, { recursive: true });
    await writeFile(path.join(vtraceDir, "_patch_critic.meta.json"), JSON.stringify(LIVE_META));
    await writeFile(path.join(vtraceDir, "_patch_critic_report.json"), JSON.stringify(LIVE_REPORT));
    await writeFile(
      path.join(vtraceDir, "_patch_critic_input.json"),
      JSON.stringify({ instanceId: INSTANCE, firstPatch: FIRST_PATCH, probeSummary: { probes: [] } }),
    );
    await writeFile(path.join(vtraceDir, "_first_patch.diff"), FIRST_PATCH);
    await writeFile(
      path.join(dir, "stage5_patch_critic_dry_run_existing_runs.json"),
      JSON.stringify({ reports: [DET_REPORT, DET_REPORT_MPL] }),
    );
    // Intentionally omit the smoke summary file to exercise fail-soft + missing tracking.

    const inputs = await loadComparisonInputs(dir, RUN_LABEL);
    assert.ok(inputs.liveMeta && inputs.liveMeta.validReport === true);
    assert.ok(inputs.liveReport && inputs.liveReport.repair_required === true);
    assert.ok(inputs.deterministicReport && inputs.deterministicReport.risk === "high");
    assert.equal(inputs.firstPatchDiff, FIRST_PATCH);
    assert.equal(inputs.smoke, null);
    assert.ok(inputs.missing.some((m) => m.endsWith("stage5_patch_critic_live_smoke_sympy.json")));

    // Build a full report from the loaded inputs without any model/Docker.
    const report = buildComparison({ generatedAt: "t", runLabel: RUN_LABEL, inputs });
    assert.equal(report.status, "ok");
    assert.equal(report.cost.costCapUsd, 0.25); // falls back to default when smoke summary absent
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A completely empty results dir must degrade to a missing-artifacts report, not throw.
test("loadComparisonInputs on an empty dir degrades to missing artifacts", async () => {
  const inputs = await loadComparisonInputs("/tmp/vtrace-does-not-exist-critic-cmp", "no-such-run");
  assert.equal(inputs.liveMeta, null);
  assert.equal(inputs.liveReport, null);
  assert.ok(inputs.missing.length >= 4);
  const report = buildComparison({ generatedAt: null, runLabel: "no-such-run", inputs });
  assert.equal(report.status, "missing-live-artifacts");
});

// ---------------------------------------------------------------------------
// parseArgs honors documented flags.
// ---------------------------------------------------------------------------
test("parseArgs honors --results / --run-label / --out-name with defaults", () => {
  const cfg = parseArgs(["--results", "some/dir", "--run-label", "lbl", "--out-name", "custom"]);
  assert.equal(cfg.resultsDir, "some/dir");
  assert.equal(cfg.runLabel, "lbl");
  assert.equal(cfg.outName, "custom");
  const def = parseArgs([]);
  assert.equal(def.runLabel, "eval-patchverify-before-sympy-16766");
  assert.equal(def.outName, "stage5_live_critic_smoke_comparison");
  assert.throws(() => parseArgs(["--nope"]));
});
