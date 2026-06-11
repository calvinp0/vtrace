import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { analyzeGeneratedParserConsistency } from "../../src/capsule/patchMinimalityProbes";
import {
  CONVERSION_REPORT_NAME,
  DIAGNOSIS_DEFECT_CLASS,
  RESOLVED_RUN_LABEL,
  SOURCE_RUN_LABEL,
  buildReport,
  loadArtifacts,
  parseArgs,
  renderJson,
  renderMarkdown,
  type BuildReportInput,
} from "./run_stage5_generated_parser_repair_failure_diagnostic";

// ---------------------------------------------------------------------------
// Synthetic patches (no live artifacts, no Docker, no model, no agent).
// ---------------------------------------------------------------------------

// Narrow division_of_units reorder in cds.py, NO cds_parsetab.py update.
const REPAIRED_NARROW = [
  "diff --git a/astropy/units/format/cds.py b/astropy/units/format/cds.py",
  "--- a/astropy/units/format/cds.py",
  "+++ b/astropy/units/format/cds.py",
  "@@ -182,7 +182,7 @@ class CDS(Base):",
  "         def p_division_of_units(p):",
  '             """',
  "             division_of_units : DIVISION unit_expression",
  "-                              | unit_expression DIVISION combined_units",
  "+                              | combined_units DIVISION unit_expression",
  '             """',
  "             if len(p) == 3:",
].join("\n");

// Same narrow reorder in cds.py PLUS the regenerated cds_parsetab.py — the resolved shape.
const RESOLVED_CONSISTENT = [
  REPAIRED_NARROW,
  "diff --git a/astropy/units/format/cds_parsetab.py b/astropy/units/format/cds_parsetab.py",
  "--- a/astropy/units/format/cds_parsetab.py",
  "+++ b/astropy/units/format/cds_parsetab.py",
  "@@ -17,9 +17,9 @@ _tabversion = '3.10'",
  "-_lr_signature = 'division_of_units : DIVISION unit_expression | unit_expression DIVISION combined_units'",
  "+_lr_signature = 'division_of_units : DIVISION unit_expression | combined_units DIVISION unit_expression'",
].join("\n");

// Broad first patch: relocates productions and DELETES both generated tables.
const FIRST_BROAD = [
  "diff --git a/astropy/units/format/cds.py b/astropy/units/format/cds.py",
  "--- a/astropy/units/format/cds.py",
  "+++ b/astropy/units/format/cds.py",
  "@@ -164,30 +164,20 @@ class CDS(Base):",
  "         def p_combined_units(p):",
  '             """',
  "-            combined_units : product_of_units",
  "-                           | division_of_units",
  '-            """',
  "-        def p_product_of_units(p):",
  '-            """',
  "-            product_of_units : unit_expression PRODUCT combined_units",
  "+            combined_units : combined_units DIVISION unit_expression",
  "+                           | unit_expression",
  '             """',
  "diff --git a/astropy/units/format/cds_lextab.py b/astropy/units/format/cds_lextab.py",
  "deleted file mode 100644",
  "--- a/astropy/units/format/cds_lextab.py",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-# generated",
  "diff --git a/astropy/units/format/cds_parsetab.py b/astropy/units/format/cds_parsetab.py",
  "deleted file mode 100644",
  "--- a/astropy/units/format/cds_parsetab.py",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-# generated",
].join("\n");

// Grammar-only reorder with parsetab updated but lextab NOT touched — must stay low-risk.
const GRAMMAR_WITH_PARSETAB_ONLY = RESOLVED_CONSISTENT;

const CONVERSION_REPORT = {
  sourcePatchResolved: false,
  repairedPatchResolved: false,
  convertedUnresolvedToResolved: false,
  dockerUsed: true,
  evaluationMethod: "isolated_derived_jsonl_external_evaluate",
};

function fullInput(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    generatedAt: "t",
    conversionReportFound: true,
    dockerOutcome: {
      dockerUsed: true,
      evaluationMethod: "isolated_derived_jsonl_external_evaluate",
      sourcePatchResolved: false,
      repairedPatchResolved: false,
      convertedUnresolvedToResolved: false,
    },
    repairedPatchDiff: REPAIRED_NARROW,
    firstPatchDiff: FIRST_BROAD,
    resolvedPatchDiff: RESOLVED_CONSISTENT,
    ...overrides,
  };
}

// ===========================================================================
// 1. Narrow source grammar reorder WITHOUT generated table update -> high-risk.
// ===========================================================================
test("probe: narrow grammar reorder without parsetab update is high-risk consistency issue", () => {
  const probe = analyzeGeneratedParserConsistency(REPAIRED_NARROW);
  assert.equal(probe.defectClass, "source_grammar_changed_without_generated_table_update");
  assert.equal(probe.consistencyRisk, true);
  assert.equal(probe.risk, "high");
  assert.equal(probe.confidence, "high");
  assert.equal(probe.narrowGrammarReorderDetected, true);
  assert.deepEqual(probe.sourceGrammarFilesChanged, ["astropy/units/format/cds.py"]);
  assert.deepEqual(probe.expectedGeneratedTables, ["astropy/units/format/cds_parsetab.py"]);
  assert.deepEqual(probe.generatedParserTablesChanged, []);
});

// ===========================================================================
// 2. Narrow source grammar reorder WITH parsetab update -> consistent / low-risk.
// ===========================================================================
test("probe: reorder with parsetab update is consistent/low-risk", () => {
  const probe = analyzeGeneratedParserConsistency(RESOLVED_CONSISTENT);
  assert.equal(probe.defectClass, "generated_table_updated_consistently");
  assert.equal(probe.consistencyRisk, false);
  assert.equal(probe.risk, "low");
  assert.deepEqual(probe.generatedParserTablesChanged, ["astropy/units/format/cds_parsetab.py"]);
});

// ===========================================================================
// 3. Generated parser table deletion -> high risk.
// ===========================================================================
test("probe: generated parser table deletion is high risk", () => {
  const probe = analyzeGeneratedParserConsistency(FIRST_BROAD);
  assert.equal(probe.defectClass, "generated_table_deleted");
  assert.equal(probe.risk, "high");
  assert.ok(probe.generatedParserTablesDeleted.includes("astropy/units/format/cds_parsetab.py"));
});

// ===========================================================================
// 4. lextab update is NOT required for a grammar-only change.
// ===========================================================================
test("probe: does not require lextab update for grammar-only change", () => {
  const probe = analyzeGeneratedParserConsistency(GRAMMAR_WITH_PARSETAB_ONLY);
  assert.equal(probe.defectClass, "generated_table_updated_consistently");
  assert.equal(probe.risk, "low");
  // No lextab was touched, yet the patch is consistent because the parsetab sibling updated.
  assert.ok(!probe.generatedParserTablesChanged.some((t) => t.endsWith("_lextab.py")));
});

// ===========================================================================
// 5. Reads the repaired conversion report fixture (repairedPatchResolved=false).
// 6. Reads the repaired patch fixture and classifies the consistency defect.
// 7. Reads the earlier resolved patch fixture (cds.py + cds_parsetab.py update).
// 11. No Docker / model / agent / live critic / repair calls — only disk reads.
// ===========================================================================
test("loadArtifacts reads conversion report + repaired + first + resolved patches from disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stage5-gp-consistency-"));
  try {
    // Conversion report JSON.
    await writeFile(path.join(dir, `${CONVERSION_REPORT_NAME}.json`), `${JSON.stringify(CONVERSION_REPORT)}\n`);

    // Repaired patch artifact under the source run.
    const repairDir = path.join(dir, "runs", SOURCE_RUN_LABEL, "raw", "vtrace", "repair");
    await mkdir(repairDir, { recursive: true });
    await writeFile(path.join(repairDir, "_repaired_patch.diff"), REPAIRED_NARROW);

    // First (broad) patch from the source run's swebench JSONL.
    const sourceVtrace = path.join(dir, "runs", SOURCE_RUN_LABEL, "raw", "vtrace");
    await writeFile(
      path.join(sourceVtrace, "swebench-2026-06-11.jsonl"),
      `${JSON.stringify({ instanceId: "astropy__astropy-14369", resolved: false, modelPatch: FIRST_BROAD })}\n`,
    );

    // Earlier resolved strict run (resolved=true, cds.py + cds_parsetab.py).
    const resolvedVtrace = path.join(dir, "runs", RESOLVED_RUN_LABEL, "raw", "vtrace");
    await mkdir(resolvedVtrace, { recursive: true });
    await writeFile(
      path.join(resolvedVtrace, "swebench-2026-06-11.jsonl"),
      `${JSON.stringify({ instanceId: "astropy__astropy-14369", resolved: true, modelPatch: RESOLVED_CONSISTENT })}\n`,
    );

    const artifacts = await loadArtifacts(dir);
    // 5.
    assert.equal(artifacts.conversionReportFound, true);
    assert.equal(artifacts.dockerOutcome.repairedPatchResolved, false);
    // 6.
    assert.ok(artifacts.repairedPatchDiff);
    const report = buildReport({ generatedAt: "t", ...artifacts });
    assert.equal(report.repairedPatch.probe?.defectClass, DIAGNOSIS_DEFECT_CLASS);
    // 7.
    assert.ok(artifacts.resolvedPatchDiff);
    assert.equal(report.comparison.available, true);
    assert.equal(report.comparison.resolvedUpdatedGeneratedTable, true);
    assert.deepEqual(report.resolvedPatch.filesChanged, [
      "astropy/units/format/cds.py",
      "astropy/units/format/cds_parsetab.py",
    ]);
    assert.deepEqual(report.comparison.missingGeneratedTables, ["astropy/units/format/cds_parsetab.py"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// Resolved patch unavailable -> still suspicious, comparison marked unavailable.
// ===========================================================================
test("comparison marked unavailable when resolved patch missing, repaired still suspicious", () => {
  const report = buildReport(fullInput({ resolvedPatchDiff: null }));
  assert.equal(report.comparison.available, false);
  assert.equal(report.repairedPatch.probe?.defectClass, DIAGNOSIS_DEFECT_CLASS);
  assert.equal(report.repairedPatch.probe?.consistencyRisk, true);
  const md = renderMarkdown(report);
  assert.ok(md.toLowerCase().includes("unavailable"));
});

// ===========================================================================
// 8. Emits diagnosis update (required interpretation wording).
// 9. Emits required Markdown sections.
// ===========================================================================
test("markdown has all required sections and the diagnosis update", () => {
  const md = renderMarkdown(buildReport(fullInput()));
  for (const heading of [
    "# Stage 5 generated-parser repair failure diagnostic",
    "## Summary",
    "## Source run",
    "## Repair attempt",
    "## Docker outcome",
    "## Repaired patch shape",
    "## Consistency probe",
    "## Comparison with resolved patch",
    "## Diagnosis update",
    "## Recommended next step",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  // Required interpretation wording.
  assert.ok(md.includes("source_grammar_changed_without_generated_table_update"));
  assert.ok(md.includes("changed both cds.py and cds_parsetab.py"));
  assert.ok(md.toLowerCase().includes("not as a localization failure"));
  // Recommended next step requires regenerating/updating parsetab, forbids deletion.
  assert.ok(md.toLowerCase().includes("regenerat"));
  assert.ok(md.toLowerCase().includes("forbid deleting generated parser tables"));
  assert.ok(md.toLowerCase().includes("do not run another astropy"));
});

// ===========================================================================
// 10. Emits required JSON fields.
// ===========================================================================
test("json has the required shape and consistency-probe fields", () => {
  const parsed = JSON.parse(renderJson(buildReport(fullInput())));
  for (const key of [
    "generatedAt",
    "sourceRunLabel",
    "instanceId",
    "conversionReportFound",
    "dockerOutcome",
    "repairedPatch",
    "firstPatch",
    "resolvedPatch",
    "comparison",
    "diagnosisDefectClass",
    "diagnosis",
    "recommendedNextStep",
    "nonClaims",
  ]) {
    assert.ok(key in parsed, `missing top-level key: ${key}`);
  }
  for (const key of [
    "dockerUsed",
    "evaluationMethod",
    "sourcePatchResolved",
    "repairedPatchResolved",
    "convertedUnresolvedToResolved",
  ]) {
    assert.ok(key in parsed.dockerOutcome, `missing dockerOutcome key: ${key}`);
  }
  for (const key of [
    "consistencyRisk",
    "defectClass",
    "risk",
    "confidence",
    "reasons",
    "signals",
    "sourceGrammarFilesChanged",
    "generatedParserTablesChanged",
    "generatedParserTablesDeleted",
    "expectedGeneratedTables",
    "narrowGrammarReorderDetected",
  ]) {
    assert.ok(key in parsed.repairedPatch.probe, `missing probe key: ${key}`);
  }
  assert.equal(parsed.diagnosisDefectClass, DIAGNOSIS_DEFECT_CLASS);
  // Required non-claims all present.
  for (const claim of [
    "This report does not re-run agents, repair, live critic, or Docker.",
    "This report does not modify any patch.",
    "This report does not claim a repair conversion.",
    "This report does not change repair eligibility.",
    "This report does not change Stage 5 policy accounting.",
    "This report does not prove all generated-parser systems require committed parser-table updates.",
  ]) {
    assert.ok(parsed.nonClaims.includes(claim), `missing non-claim: ${claim}`);
  }
});

test("parseArgs honors --results and --out-name with defaults", () => {
  assert.deepEqual(parseArgs([]), {
    resultsDir: "benchmarks/stage5_vexp_swe_bench_smoke/results",
    outName: "stage5_generated_parser_repair_failure_diagnostic",
  });
  assert.deepEqual(parseArgs(["--results", "r", "--out-name", "o"]), { resultsDir: "r", outName: "o" });
  assert.throws(() => parseArgs(["--bogus"]));
});
