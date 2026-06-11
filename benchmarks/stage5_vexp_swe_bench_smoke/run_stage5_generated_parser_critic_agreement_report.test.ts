import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  CRITIC_SUMMARY_BASENAME,
  INTERPRETATION,
  NON_CLAIMS,
  RECOMMENDED_NEXT_STEP,
  REPAIR_BOUNDARY,
  TARGET_INSTANCE,
  TARGET_RUN_LABEL,
  buildReport,
  collectRunRows,
  extractAgreement,
  extractContextQuality,
  extractDeterministicProbe,
  extractLiveCritic,
  extractRunIdentity,
  findRunRow,
  parseReportArgs,
  renderJson,
  renderMarkdown,
} from "./run_stage5_generated_parser_critic_agreement_report";

// --------------------------------------------------------------------------
// Fixtures — mirror the real artifact shapes for the Astropy protocol run.
// No Docker, model, agent, live critic, or repair is invoked anywhere here.
// --------------------------------------------------------------------------

// The summary run row as it appears in `stage5_live_critic_generated_parser_astropy.json`
// under the top-level `runs` array (NOT `.decisions`).
function summaryRunRow(): Record<string, unknown> {
  return {
    runLabel: TARGET_RUN_LABEL,
    instanceId: TARGET_INSTANCE,
    source: "ad_hoc_run_label",
    deterministicRepairRequired: true,
    eligible: true,
    called: true,
    reason: "live critic invoked [eligible: generated-parser-minimality]",
    meta: {
      enabled: true,
      ran: true,
      validReport: true,
      failedOpen: false,
      criticCostUsd: 0.18575950000000002,
      criticInputTokens: 4240,
      criticOutputTokens: 2453,
      deterministicRepairRequired: true,
      liveRepairRequired: true,
      agreementWithDeterministic: true,
    },
    liveReport: {
      instanceId: TARGET_INSTANCE,
      runLabel: TARGET_RUN_LABEL,
      scope_ok: true,
      failing_behavior_handled: true,
      minimality_ok: false,
      test_evidence_ok: false,
      risk: "high",
      repair_required: true,
      repair_reason: "Broad non-minimal rewrite of a generated parser.",
      repair_instructions: "Keep p_product_of_units and p_division_of_units as separate functions.",
      confidence: "high",
    },
    patchMinimalityRepairRequired: true,
    patchMinimalityDefectClass: "generated_parser_broad_rewrite / grammar_patch_minimality",
    patchMinimalityRisk: "high",
    patchMinimalityConfidence: "high",
    patchMinimalitySignals: [
      "generated_parser_table_deleted",
      "grammar_function_removed",
      "multiple_grammar_functions_changed",
      "grammar_productions_relocated",
      "narrow_alternative_available",
      "grammar_patch_minimality",
    ],
    patchMinimalityReasons: [
      "Patch deletes generated parser table file(s): cds_lextab.py, cds_parsetab.py.",
      "Parser function(s) removed entirely: p_division_of_units, p_product_of_units.",
    ],
    patchMinimalityNarrowAlternativeHint:
      "Narrower alternative likely exists: reorder the division_of_units grammar production within its own parser function.",
  };
}

function summaryDoc(): Record<string, unknown> {
  return {
    generatedAt: "2026-06-11T18:57:07.681Z",
    summary: { liveRepairRequired: 1, deterministicRepairRequired: 1, agreementCount: 1 },
    runs: [
      { runLabel: "eval-editguard-before-sympy-16766", instanceId: "sympy__sympy-16766", deterministicRepairRequired: false },
      summaryRunRow(),
    ],
  };
}

function criticReportFixture(): Record<string, unknown> {
  return {
    instanceId: TARGET_INSTANCE,
    runLabel: TARGET_RUN_LABEL,
    scope_ok: true,
    failing_behavior_handled: true,
    minimality_ok: false,
    test_evidence_ok: false,
    risk: "high",
    repair_required: true,
    repair_reason: "Broad non-minimal rewrite of a generated parser.",
    repair_instructions: "Confine the fix to making the division production left-associative.",
    confidence: "high",
  };
}

function criticMetaFixture(): Record<string, unknown> {
  return {
    enabled: true,
    ran: true,
    validReport: true,
    failedOpen: false,
    criticCostUsd: 0.18575950000000002,
    criticInputTokens: 4240,
    criticOutputTokens: 2453,
    deterministicRepairRequired: true,
    liveRepairRequired: true,
    agreementWithDeterministic: true,
  };
}

function runMetaFixture(): Record<string, unknown> {
  return {
    vtraceMethod: "indexed-context",
    vtraceTreatmentValid: true,
    capsuleV2ArtifactsPersisted: true,
    capsuleEngine: "v2",
    pivotRankingVersion: "v2",
    vtraceCapsuleTopPivotFile: "astropy/units/format/cds.py",
    vtraceCapsuleTopPivotSymbol: "CDS",
    orderedTelemetryAvailable: true,
  };
}

function toolSummaryFixture(): Record<string, unknown> {
  return {
    runLabel: TARGET_RUN_LABEL,
    instanceId: TARGET_INSTANCE,
    longBashLoopHeuristic: false,
    repeatedSearchHeuristic: false,
    orderedTelemetryAvailable: true,
  };
}

function sweRowFixture(): Record<string, unknown> {
  return { instanceId: TARGET_INSTANCE, repo: "astropy/astropy", resolved: false };
}

// Materialize the on-disk artifact layout the reporter reads from.
async function writeFixtures(resultsDir: string): Promise<void> {
  await mkdir(resultsDir, { recursive: true });
  await writeFile(
    path.join(resultsDir, `${CRITIC_SUMMARY_BASENAME}.json`),
    JSON.stringify(summaryDoc(), null, 2),
  );
  const rawDir = path.join(resultsDir, "runs", TARGET_RUN_LABEL, "raw", "vtrace");
  await mkdir(rawDir, { recursive: true });
  await writeFile(path.join(rawDir, "_patch_critic_report.json"), JSON.stringify(criticReportFixture()));
  await writeFile(path.join(rawDir, "_patch_critic.meta.json"), JSON.stringify(criticMetaFixture()));
  await writeFile(path.join(rawDir, "_patch_critic_input.json"), JSON.stringify(criticReportFixture()));
  await writeFile(path.join(rawDir, "_run.meta.json"), JSON.stringify(runMetaFixture()));
  await writeFile(path.join(rawDir, "_tool_calls.summary.json"), JSON.stringify(toolSummaryFixture()));
  await writeFile(path.join(rawDir, "swebench-2026-06-11.jsonl"), `${JSON.stringify(sweRowFixture())}\n`);
}

// --------------------------------------------------------------------------
// Robust run-row finder
// --------------------------------------------------------------------------

test("findRunRow locates the run under the `runs` array", () => {
  const row = findRunRow(summaryDoc(), TARGET_RUN_LABEL);
  assert.ok(row);
  assert.equal(row?.runLabel, TARGET_RUN_LABEL);
});

test("findRunRow supports a `decisions` array shape (not just `runs`)", () => {
  const doc = { decisions: [summaryRunRow()] };
  const row = findRunRow(doc, TARGET_RUN_LABEL);
  assert.ok(row);
  assert.equal(row?.instanceId, TARGET_INSTANCE);
});

test("findRunRow supports a top-level array shape", () => {
  const row = findRunRow([summaryRunRow()], TARGET_RUN_LABEL);
  assert.ok(row);
});

test("findRunRow supports a single-object run document", () => {
  const row = findRunRow(summaryRunRow(), TARGET_RUN_LABEL);
  assert.ok(row);
});

test("findRunRow returns null on null/missing shape without throwing", () => {
  // The previous manual jq command failed with "Cannot iterate over null" when it
  // assumed `.decisions`. The reader must degrade to null instead.
  assert.equal(findRunRow(null, TARGET_RUN_LABEL), null);
  assert.equal(findRunRow({ somethingElse: 1 }, TARGET_RUN_LABEL), null);
  assert.equal(collectRunRows(null).length, 0);
});

// --------------------------------------------------------------------------
// Field extraction
// --------------------------------------------------------------------------

test("extractDeterministicProbe reads patchMinimality fields", () => {
  const dp = extractDeterministicProbe(summaryRunRow());
  assert.equal(dp.patchMinimalityRepairRequired, true);
  assert.equal(dp.patchMinimalityRisk, "high");
  assert.equal(dp.patchMinimalityConfidence, "high");
  assert.equal(dp.patchMinimalityDefectClass, "generated_parser_broad_rewrite / grammar_patch_minimality");
  assert.ok(dp.patchMinimalitySignals.includes("generated_parser_table_deleted"));
  assert.ok(dp.patchMinimalityReasons.length >= 1);
  assert.ok(dp.patchMinimalityNarrowAlternativeHint);
});

test("extractDeterministicProbe degrades a null row to null/[] fields", () => {
  const dp = extractDeterministicProbe(null);
  assert.equal(dp.patchMinimalityRepairRequired, null);
  assert.deepEqual(dp.patchMinimalitySignals, []);
  assert.deepEqual(dp.patchMinimalityReasons, []);
});

test("extractAgreement reads liveRepairRequired and agreement from meta", () => {
  const ag = extractAgreement(criticMetaFixture(), null);
  assert.equal(ag.deterministicRepairRequired, true);
  assert.equal(ag.liveRepairRequired, true);
  assert.equal(ag.agreementWithDeterministic, true);
});

test("extractAgreement falls back to the summary row's meta object", () => {
  const ag = extractAgreement(null, summaryRunRow());
  assert.equal(ag.liveRepairRequired, true);
  assert.equal(ag.agreementWithDeterministic, true);
});

test("extractLiveCritic reads the live critic verdict and cost", () => {
  const lc = extractLiveCritic(criticReportFixture(), criticMetaFixture(), null);
  assert.equal(lc.scopeOk, true);
  assert.equal(lc.minimalityOk, false);
  assert.equal(lc.testEvidenceOk, false);
  assert.equal(lc.risk, "high");
  assert.equal(lc.repairRequired, true);
  assert.equal(lc.confidence, "high");
  assert.equal(lc.criticCostUsd, 0.18575950000000002);
  assert.equal(lc.criticInputTokens, 4240);
  assert.ok(lc.repairInstructions);
});

test("extractContextQuality reads run meta + loop heuristics + Docker resolved", () => {
  const cq = extractContextQuality(runMetaFixture(), toolSummaryFixture(), sweRowFixture());
  assert.equal(cq.vtraceMethod, "indexed-context");
  assert.equal(cq.vtraceTreatmentValid, true);
  assert.equal(cq.capsuleV2ArtifactsPersisted, true);
  assert.equal(cq.capsuleEngine, "v2");
  assert.equal(cq.pivotRankingVersion, "v2");
  assert.equal(cq.leadPivot, "astropy/units/format/cds.py::CDS");
  assert.equal(cq.orderedTelemetryAvailable, true);
  assert.equal(cq.longBashLoopHeuristic, false);
  assert.equal(cq.repeatedSearchHeuristic, false);
  // Docker unresolved.
  assert.equal(cq.dockerResolved, false);
});

test("extractRunIdentity reads label/instance/source", () => {
  const id = extractRunIdentity(summaryRunRow());
  assert.equal(id.runLabel, TARGET_RUN_LABEL);
  assert.equal(id.instanceId, TARGET_INSTANCE);
  assert.equal(id.source, "ad_hoc_run_label");
});

// --------------------------------------------------------------------------
// End-to-end build from on-disk fixtures
// --------------------------------------------------------------------------

test("buildReport assembles the agreement report from existing artifacts", async () => {
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "gp-critic-agreement-"));
  await writeFixtures(resultsDir);

  const report = await buildReport({ resultsDir }, "2026-06-11T00:00:00.000Z");

  assert.equal(report.runIdentity.runLabel, TARGET_RUN_LABEL);
  assert.equal(report.runIdentity.instanceId, TARGET_INSTANCE);
  assert.equal(report.contextQuality.leadPivot, "astropy/units/format/cds.py::CDS");
  assert.equal(report.contextQuality.dockerResolved, false);
  assert.equal(report.deterministicProbe.patchMinimalityRepairRequired, true);
  assert.equal(report.agreement.liveRepairRequired, true);
  assert.equal(report.agreement.agreementWithDeterministic, true);
  assert.equal(report.liveCritic.minimalityOk, false);
  assert.equal(report.interpretation, INTERPRETATION);
});

test("buildReport degrades gracefully when artifacts are missing", async () => {
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "gp-critic-agreement-empty-"));
  // No fixtures written. Should not throw; fields degrade to null.
  const report = await buildReport({ resultsDir }, null);
  assert.equal(report.runIdentity.runLabel, TARGET_RUN_LABEL);
  assert.equal(report.agreement.agreementWithDeterministic, null);
  assert.equal(report.contextQuality.dockerResolved, null);
  // Verbatim constants are still emitted.
  assert.equal(report.recommendedNextStep, RECOMMENDED_NEXT_STEP);
});

// --------------------------------------------------------------------------
// Rendering: required Markdown sections, repair-boundary text, JSON fields
// --------------------------------------------------------------------------

const REQUIRED_SECTIONS = [
  "# Stage 5 generated-parser critic agreement",
  "## Summary",
  "## Run identity",
  "## Context quality",
  "## Deterministic probe finding",
  "## Live critic finding",
  "## Agreement",
  "## Observation-only boundary",
  "## Repair boundary",
  "## Recommended next step",
  "## Non-claims",
] as const;

async function builtReport() {
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "gp-critic-agreement-render-"));
  await writeFixtures(resultsDir);
  return buildReport({ resultsDir }, "2026-06-11T00:00:00.000Z");
}

test("renderMarkdown emits all required sections", async () => {
  const md = renderMarkdown(await builtReport());
  for (const section of REQUIRED_SECTIONS) {
    assert.ok(md.includes(section), `missing markdown section: ${section}`);
  }
});

test("renderMarkdown emits the repair-boundary text", async () => {
  const md = renderMarkdown(await builtReport());
  for (const statement of REPAIR_BOUNDARY) {
    assert.ok(md.includes(statement), `missing repair-boundary statement: ${statement}`);
  }
});

test("renderMarkdown emits interpretation, recommended next step, and non-claims", async () => {
  const md = renderMarkdown(await builtReport());
  assert.ok(md.includes(INTERPRETATION));
  assert.ok(md.includes(RECOMMENDED_NEXT_STEP));
  for (const claim of NON_CLAIMS) assert.ok(md.includes(claim), `missing non-claim: ${claim}`);
  // Agreement values surfaced.
  assert.ok(md.includes("agreementWithDeterministic: true"));
  assert.ok(md.includes("liveRepairRequired: true"));
});

test("renderMarkdown reports Docker unresolved", async () => {
  const md = renderMarkdown(await builtReport());
  assert.ok(md.includes("| Docker resolved | false |"));
});

test("renderJson emits the required JSON fields", async () => {
  const json = JSON.parse(renderJson(await builtReport()));
  assert.equal(json.report, "stage5_generated_parser_critic_agreement");
  assert.equal(json.runIdentity.runLabel, TARGET_RUN_LABEL);
  assert.equal(json.runIdentity.instanceId, TARGET_INSTANCE);
  assert.equal(json.contextQuality.leadPivot, "astropy/units/format/cds.py::CDS");
  assert.equal(json.contextQuality.dockerResolved, false);
  assert.equal(json.deterministicProbe.patchMinimalityRepairRequired, true);
  assert.equal(json.liveCritic.repairRequired, true);
  assert.equal(json.agreement.agreementWithDeterministic, true);
  // Top-level convenience fields.
  assert.equal(json.agreementWithDeterministic, true);
  assert.equal(json.liveRepairRequired, true);
  assert.equal(json.deterministicRepairRequired, true);
  assert.deepEqual(json.repairBoundary, [...REPAIR_BOUNDARY]);
  assert.equal(json.recommendedNextStep, RECOMMENDED_NEXT_STEP);
  assert.deepEqual(json.nonClaims, [...NON_CLAIMS]);
});

// --------------------------------------------------------------------------
// CLI argument parsing
// --------------------------------------------------------------------------

test("parseReportArgs defaults outDir to resultsDir", () => {
  const cfg = parseReportArgs(["--results", "/tmp/results"]);
  assert.equal(cfg.resultsDir, "/tmp/results");
  assert.equal(cfg.outDir, "/tmp/results");
  assert.equal(cfg.runLabel, TARGET_RUN_LABEL);
});

test("parseReportArgs honors an explicit --out and --run-label", () => {
  const cfg = parseReportArgs(["--results", "/tmp/r", "--out", "/tmp/o", "--run-label", "custom"]);
  assert.equal(cfg.outDir, "/tmp/o");
  assert.equal(cfg.runLabel, "custom");
});

test("parseReportArgs rejects unknown flags", () => {
  assert.throws(() => parseReportArgs(["--nope"]), /Unknown argument/);
});
