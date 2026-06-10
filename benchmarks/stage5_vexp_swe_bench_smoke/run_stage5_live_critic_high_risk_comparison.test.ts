import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PatchCriticReport } from "./stage5_patch_critic";
import type { LiveCriticMeta } from "./stage5_patch_critic_live";
import {
  type RunRecord,
  CRITIC_RUN_LABELS,
  buildComparison,
  classifyInstruction,
  defectClassFor,
  loadRunRecord,
  parseArgs,
  renderJson,
  renderMarkdown,
} from "./run_stage5_live_critic_high_risk_comparison";

// ---------------------------------------------------------------------------
// Fixtures — mirror the six real runs' meta/report (no fs, no model, no Docker).
// ---------------------------------------------------------------------------

function meta(over: Partial<LiveCriticMeta>): LiveCriticMeta {
  return {
    enabled: true,
    ran: true,
    validReport: true,
    failedOpen: false,
    error: null,
    criticModel: null,
    criticCostUsd: 0.1,
    criticInputTokens: 4300,
    criticOutputTokens: 2000,
    deterministicRepairRequired: true,
    liveRepairRequired: true,
    agreementWithDeterministic: true,
    ...over,
  };
}

function report(over: Partial<PatchCriticReport> & { instanceId: string; runLabel: string }): PatchCriticReport {
  return {
    scope_ok: true,
    scope_evidence: "—",
    failing_behavior_handled: true,
    failing_behavior_evidence: "—",
    minimality_ok: true,
    minimality_evidence: "—",
    test_evidence_ok: null,
    test_evidence: "—",
    risk: "medium",
    repair_required: true,
    repair_reason: "—",
    repair_instructions: "—",
    confidence: "medium",
    evidence_probe_ids: [],
    ...over,
  };
}

const SYMPY_INSTR =
  "Relocate the existing _print_Indexed method out of AbstractPythonCodePrinter and into the PythonCodePrinter class body, preserving the same implementation and indentation.";
const REQ_INSTR =
  "Modify the existing block rather than rewriting it: restore the original `if not unicode_is_ascii(host):` branch, then add only a narrow empty-label guard instead of unconditionally IDNA-encoding all ASCII hosts.";

function records(): RunRecord[] {
  return [
    {
      runLabel: "eval-patchverify-before-sympy-16766",
      meta: meta({ criticCostUsd: 0.1218, criticInputTokens: 4343, criticOutputTokens: 2487 }),
      report: report({ instanceId: "sympy__sympy-16766", runLabel: "eval-patchverify-before-sympy-16766", scope_ok: false, repair_instructions: SYMPY_INSTR }),
      firstPatch: "PATCH-A",
      firstPatchDiff: "PATCH-A",
    },
    {
      runLabel: "eval-editguard-before-matplotlib-22719",
      meta: meta({ liveRepairRequired: false, agreementWithDeterministic: false, criticCostUsd: 0.096, criticInputTokens: 4268, criticOutputTokens: 1413 }),
      report: report({ instanceId: "matplotlib__matplotlib-22719", runLabel: "eval-editguard-before-matplotlib-22719", risk: "low", repair_required: false, repair_reason: "", repair_instructions: "" }),
      firstPatch: "PATCH-B",
      firstPatchDiff: "PATCH-B",
    },
    {
      runLabel: "eval-patchverify-after-matplotlib-22719",
      meta: meta({ liveRepairRequired: false, agreementWithDeterministic: false, criticCostUsd: 0.0984, criticInputTokens: 4234, criticOutputTokens: 1524 }),
      report: report({ instanceId: "matplotlib__matplotlib-22719", runLabel: "eval-patchverify-after-matplotlib-22719", risk: "low", repair_required: false, repair_reason: "", repair_instructions: "" }),
      firstPatch: "PATCH-C",
      firstPatchDiff: "PATCH-C",
    },
    {
      runLabel: "eval-editguard-before-requests-5414",
      meta: meta({ criticCostUsd: 0.138, criticInputTokens: 4343, criticOutputTokens: 3005 }),
      report: report({ instanceId: "psf__requests-5414", runLabel: "eval-editguard-before-requests-5414", minimality_ok: false, repair_instructions: REQ_INSTR }),
      firstPatch: "PATCH-D",
      firstPatchDiff: "PATCH-D",
    },
    {
      runLabel: "eval-editguard-after-requests-5414",
      meta: meta({ criticCostUsd: 0.1195, criticInputTokens: 4343, criticOutputTokens: 2288 }),
      report: report({ instanceId: "psf__requests-5414", runLabel: "eval-editguard-after-requests-5414", minimality_ok: false, repair_instructions: REQ_INSTR }),
      firstPatch: "PATCH-E",
      firstPatchDiff: "PATCH-E",
    },
    {
      runLabel: "eval-patchverify-before-requests-5414",
      meta: meta({ criticCostUsd: 0.1365, criticInputTokens: 4343, criticOutputTokens: 2993 }),
      report: report({ instanceId: "psf__requests-5414", runLabel: "eval-patchverify-before-requests-5414", minimality_ok: false, repair_instructions: REQ_INSTR }),
      firstPatch: "PATCH-F",
      firstPatchDiff: "PATCH-F",
    },
  ];
}

// ---------------------------------------------------------------------------
// 1 + 2: loads exactly six runs; computes valid/fail-open/agreement counts.
// ---------------------------------------------------------------------------
test("loads six runs and computes valid/fail-open/agreement/repair counts", () => {
  const report = buildComparison({ generatedAt: "t", records: records() });
  assert.equal(report.runs.length, 6);
  const s = report.summary;
  assert.equal(s.runsAnalyzed, 6);
  assert.equal(s.validReportCount, 6);
  assert.equal(s.failedOpenCount, 0);
  assert.equal(s.agreementCount, 4);
  assert.equal(s.disagreementCount, 2);
  assert.equal(s.liveRepairRequiredCount, 4);
  assert.equal(s.deterministicRepairRequiredCount, 6);
  // Cost computed, not hard-coded.
  assert.ok(Math.abs(s.totalCostUsd - (0.1218 + 0.096 + 0.0984 + 0.138 + 0.1195 + 0.1365)) < 1e-9);
  assert.ok(Math.abs(s.meanCostUsd - s.totalCostUsd / 6) < 1e-9);
  assert.equal(s.totalOutputTokens, 2487 + 1413 + 1524 + 3005 + 2288 + 2993);
});

// ---------------------------------------------------------------------------
// 3: groups agreement by defect class.
// ---------------------------------------------------------------------------
test("groups agreement and live-repair by defect class", () => {
  const report = buildComparison({ generatedAt: "t", records: records() });
  const a = report.summary.agreementByDefectClass;
  assert.equal(a.wrong_scope.total, 1);
  assert.equal(a.wrong_scope.agree, 1);
  assert.equal(a.broad_rewrite_minimality.total, 3);
  assert.equal(a.broad_rewrite_minimality.agree, 3);
  assert.equal(a.missing_failing_behavior.total, 2);
  assert.equal(a.missing_failing_behavior.agree, 0);
  assert.equal(a.missing_failing_behavior.disagree, 2);

  const rep = report.summary.liveRepairRequiredByDefectClass;
  assert.equal(rep.wrong_scope.liveRepairRequired, 1);
  assert.equal(rep.broad_rewrite_minimality.liveRepairRequired, 3);
  assert.equal(rep.missing_failing_behavior.liveRepairRequired, 0);

  // defectClasses[] rollup present for all three observed classes.
  const classes = report.defectClasses.map((d) => d.defectClass);
  assert.deepEqual(new Set(classes), new Set(["wrong_scope", "missing_failing_behavior", "broad_rewrite_minimality"]));
});

// ---------------------------------------------------------------------------
// 4: classifies repair-instruction quality.
// ---------------------------------------------------------------------------
test("classifies repair-instruction quality (sympy/requests actionable, matplotlib none)", () => {
  const report = buildComparison({ generatedAt: "t", records: records() });
  const byLabel = Object.fromEntries(report.runs.map((r) => [r.runLabel, r.instructionQuality]));
  assert.equal(byLabel["eval-patchverify-before-sympy-16766"], "actionable");
  assert.equal(byLabel["eval-editguard-before-requests-5414"], "actionable");
  assert.equal(byLabel["eval-editguard-before-matplotlib-22719"], "none");
  assert.equal(byLabel["eval-patchverify-after-matplotlib-22719"], "none");

  // Unit-level: no-repair => none; vague => generic; specific => actionable.
  assert.equal(classifyInstruction(false, ""), "none");
  assert.equal(classifyInstruction(true, ""), "none");
  assert.equal(classifyInstruction(true, "fix it"), "generic");
  assert.equal(classifyInstruction(true, SYMPY_INSTR), "actionable");
});

// ---------------------------------------------------------------------------
// 5: surfaces the Matplotlib disagreement.
// ---------------------------------------------------------------------------
test("surfaces the Matplotlib missing_failing_behavior disagreement honestly", () => {
  const report = buildComparison({ generatedAt: "t", records: records() });
  const mpl = report.defectClasses.find((d) => d.defectClass === "missing_failing_behavior")!;
  assert.equal(mpl.disagree, 2);
  assert.equal(mpl.liveRepairRequired, 0);
  assert.equal(mpl.justifiesCost, "uncertain");
  // The narrative names the over-conservative literal-pattern probe, not a flat "under-call" assumption.
  assert.match(mpl.note, /over-conservative|string match/i);

  const md = renderMarkdown(report);
  assert.match(md, /over-conservative/i);
  assert.match(md, /failing_behavior_pattern/);
  assert.match(md, /executable reproduction/i);
});

// ---------------------------------------------------------------------------
// 6: emits Markdown sections and JSON fields.
// ---------------------------------------------------------------------------
test("emits all required Markdown sections and JSON fields", () => {
  const report = buildComparison({ generatedAt: "t", records: records() });

  const parsed = JSON.parse(renderJson(report));
  for (const field of ["generatedAt", "summary", "runs", "defectClasses", "cost", "safety", "recommendation", "nonClaims"]) {
    assert.ok(field in parsed, `missing JSON field ${field}`);
  }
  for (const f of [
    "runLabel",
    "instanceId",
    "defectClass",
    "deterministicRepairRequired",
    "liveRepairRequired",
    "agreementWithDeterministic",
    "liveRisk",
    "liveConfidence",
    "criticCostUsd",
    "criticInputTokens",
    "criticOutputTokens",
    "failedOpen",
    "validReport",
    "repairReason",
    "repairInstructions",
    "addedValueSummary",
    "instructionQuality",
  ]) {
    assert.ok(f in parsed.runs[0], `runs[] entry missing ${f}`);
  }

  const md = renderMarkdown(report);
  for (const heading of [
    "# Stage 5 live critic high-risk comparison",
    "## Summary",
    "## Method",
    "## Runs included",
    "## Agreement with deterministic critic",
    "## Results by defect class",
    "## Added value over deterministic probes",
    "## Cost and token impact",
    "## Repair-instruction quality",
    "## Safety properties",
    "## Interpretation",
    "## Recommended next step",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `markdown missing section: ${heading}`);
  }
  // Recommendation excludes missing_failing_behavior and lists the four agreeing runs as eligible.
  assert.ok(parsed.recommendation.excludedDefectClasses.includes("missing_failing_behavior"));
  assert.equal(parsed.recommendation.eligibleForRepair.length, 4);
});

// ---------------------------------------------------------------------------
// 7: missing critic artifacts => skipped status, no throw, metrics exclude it.
// ---------------------------------------------------------------------------
test("missing critic artifacts yield a skipped status and do not corrupt counts", () => {
  const recs = records();
  recs[0] = { runLabel: recs[0]!.runLabel, meta: null, report: null, firstPatch: null, firstPatchDiff: null };
  const report = buildComparison({ generatedAt: "t", records: recs });
  assert.ok(report.skipped.includes("eval-patchverify-before-sympy-16766"));
  assert.equal(report.summary.runsAnalyzed, 5); // the skipped run is excluded from analyzed metrics
  assert.equal(report.summary.validReportCount, 5);
  const skipped = report.runs.find((r) => r.runLabel === "eval-patchverify-before-sympy-16766")!;
  assert.equal(skipped.status, "skipped-missing-artifacts");
  // Renders without throwing.
  assert.ok(renderMarkdown(report).includes("Skipped"));
});

// ---------------------------------------------------------------------------
// 8: loader reads artifacts read-only from a temp fixture; no model/Docker.
// ---------------------------------------------------------------------------
test("loadRunRecord reads meta/report/input/diff read-only and fails soft", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vtrace-hr-cmp-"));
  try {
    const vtraceDir = path.join(dir, "runs", "eval-x", "raw", "vtrace");
    await mkdir(vtraceDir, { recursive: true });
    await writeFile(path.join(vtraceDir, "_patch_critic.meta.json"), JSON.stringify(meta({})));
    await writeFile(
      path.join(vtraceDir, "_patch_critic_report.json"),
      JSON.stringify(report({ instanceId: "psf__requests-5414", runLabel: "eval-x", minimality_ok: false, repair_instructions: REQ_INSTR })),
    );
    await writeFile(path.join(vtraceDir, "_patch_critic_input.json"), JSON.stringify({ instanceId: "psf__requests-5414", firstPatch: "P" }));
    await writeFile(path.join(vtraceDir, "_first_patch.diff"), "P");

    const rec = await loadRunRecord(dir, "eval-x");
    assert.ok(rec.meta && rec.meta.validReport === true);
    assert.ok(rec.report && rec.report.repair_required === true);
    assert.equal(rec.firstPatch, "P");
    assert.equal(rec.firstPatchDiff, "P");

    const cmp = buildComparison({ generatedAt: "t", records: [rec] });
    assert.equal(cmp.runs[0]!.patchUnchanged, true);
    assert.equal(cmp.safety.allPatchesUnchanged, true);

    // Absent run degrades to nulls, never throws.
    const missing = await loadRunRecord(dir, "no-such-run");
    assert.equal(missing.meta, null);
    assert.equal(missing.report, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Misc: defect-class mapping, CRITIC_RUN_LABELS, parseArgs.
// ---------------------------------------------------------------------------
test("defect-class mapping, constants, and parseArgs", () => {
  assert.equal(defectClassFor("sympy__sympy-16766"), "wrong_scope");
  assert.equal(defectClassFor("matplotlib__matplotlib-22719"), "missing_failing_behavior");
  assert.equal(defectClassFor("psf__requests-5414"), "broad_rewrite_minimality");
  assert.equal(CRITIC_RUN_LABELS.length, 6);

  const cfg = parseArgs(["--results", "d", "--out-name", "c"]);
  assert.equal(cfg.resultsDir, "d");
  assert.equal(cfg.outName, "c");
  assert.equal(parseArgs([]).outName, "stage5_live_critic_high_risk_comparison");
  assert.throws(() => parseArgs(["--bad"]));
});
