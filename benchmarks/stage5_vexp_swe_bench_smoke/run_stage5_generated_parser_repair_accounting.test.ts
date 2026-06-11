import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type ConversionReportDoc,
  ACCOUNTING_ROW_NAME,
  DEFAULT_CONVERSION_REPORT_NAME,
  LINEAGE_LIMITATIONS,
  REQUIRED_INTERPRETATION,
  buildAccountingRow,
  buildCostCapFollowUp,
  parseArgs,
  renderJson,
  renderMarkdown,
  run,
} from "./run_stage5_generated_parser_repair_accounting";

// ---------------------------------------------------------------------------
// Fixture — the committed Docker-verified shape-gated conversion report (no Docker/model/agent run).
// ---------------------------------------------------------------------------

const RL = "eval-strictv2-artifacts-protocol-vtrace-astropy-14369";
const INSTANCE = "astropy__astropy-14369";
const REPAIR_OUT_NAME = "stage5_generated_parser_astropy_repair_attempt_shape_gate";
const CDS_PARSETAB = "astropy/units/format/cds_parsetab.py";

const REPAIR_COST = 2.8185425;
const CRITIC_COST = 0.18575950000000002;
const TOTAL_RECOVERY = 3.004302;
const REPAIR_COST_CAP = 0.4;

// The real conversion report shape (subset the accounting row consumes).
const CONVERSION_DOC: ConversionReportDoc = {
  sourceRunLabel: RL,
  repairOutName: REPAIR_OUT_NAME,
  instanceId: INSTANCE,
  sourcePatchResolved: false,
  repairedPatchResolved: true,
  convertedUnresolvedToResolved: true,
  criticCostUsd: CRITIC_COST,
  repairCostUsd: REPAIR_COST,
  totalRecoveryCostUsd: TOTAL_RECOVERY,
  repairCostCapUsd: REPAIR_COST_CAP,
  repairCostExceededCap: true,
  generatedParserRepairShapeAccepted: true,
  generatedParserTablesUpdatedByRepair: [CDS_PARSETAB],
  generatedParserTablesDeletedByRepair: false,
};

// Write a temp results dir holding the committed conversion report. Returns the resultsDir.
async function makeFixture(root: string, doc: ConversionReportDoc = CONVERSION_DOC): Promise<string> {
  const results = path.join(root, "results");
  await mkdir(results, { recursive: true });
  await writeFile(path.join(results, `${DEFAULT_CONVERSION_REPORT_NAME}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  return results;
}

function cfg(resultsDir: string) {
  return {
    resultsDir,
    conversionReportName: DEFAULT_CONVERSION_REPORT_NAME,
    outName: "stage5_generated_parser_repair_accounting",
  };
}

// ---------------------------------------------------------------------------
// parseArgs.
// ---------------------------------------------------------------------------
test("parseArgs: conservative defaults; rejects unknown args", () => {
  const c = parseArgs([]);
  assert.equal(c.conversionReportName, DEFAULT_CONVERSION_REPORT_NAME);
  assert.equal(c.outName, "stage5_generated_parser_repair_accounting");
  assert.equal(parseArgs(["--conversion-report", "custom"]).conversionReportName, "custom");
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// 2/3/4/5/6. buildAccountingRow (pure): conversion + shape acceptance + costs + cap + comparability.
// ---------------------------------------------------------------------------
test("buildAccountingRow: records conversion, shape acceptance, costs, cap, and aggregateComparable=false", () => {
  const row = buildAccountingRow(CONVERSION_DOC);
  assert.equal(row.rowName, ACCOUNTING_ROW_NAME);
  // 2. conversion detected.
  assert.equal(row.convertedUnresolvedToResolved, true);
  // 3. shape gate acceptance detected.
  assert.equal(row.generatedParserRepairShapeAccepted, true);
  assert.deepEqual([...row.generatedParserTablesUpdatedByRepair], [CDS_PARSETAB]);
  assert.equal(row.generatedParserTablesDeletedByRepair, false);
  // 4. critic + repair + total recovery cost recorded.
  assert.equal(row.criticCostUsd, CRITIC_COST);
  assert.equal(row.repairCostUsd, REPAIR_COST);
  assert.equal(row.totalRecoveryCostUsd, TOTAL_RECOVERY);
  // 5. cap exceedance recorded.
  assert.equal(row.repairCostCapUsd, REPAIR_COST_CAP);
  assert.equal(row.repairCostExceededCap, true);
  // 6. aggregateComparable=false, and a real (labelled) accounting row WAS added.
  assert.equal(row.aggregateComparable, false);
  assert.equal(row.policyAccountingUpdated, true);
  // Lineage limitations carried verbatim.
  assert.deepEqual([...row.lineageLimitations], [...LINEAGE_LIMITATIONS]);
  assert.equal(row.interpretation, REQUIRED_INTERPRETATION);
});

test("buildAccountingRow: degrades gracefully on partial report (no throw)", () => {
  const row = buildAccountingRow({});
  assert.equal(row.convertedUnresolvedToResolved, false);
  assert.equal(row.generatedParserRepairShapeAccepted, null);
  assert.equal(row.repairCostExceededCap, false);
  assert.equal(row.aggregateComparable, false);
  assert.equal(row.policyAccountingUpdated, true);
  assert.deepEqual([...row.generatedParserTablesUpdatedByRepair], []);
});

// ---------------------------------------------------------------------------
// cost-cap follow-up wording carries the concrete $ figures.
// ---------------------------------------------------------------------------
test("buildCostCapFollowUp: names cost-cap audit with concrete figures", () => {
  const s = buildCostCapFollowUp(REPAIR_COST, REPAIR_COST_CAP);
  assert.ok(s.includes("Audit repair cost-cap enforcement before enabling broader generated-parser repair usage."));
  assert.ok(s.includes("repairCostUsd=$2.8185"));
  assert.ok(s.includes("repairCostCapUsd=$0.4000"));
});

// ---------------------------------------------------------------------------
// 1/9/11/12. End-to-end: reads the conversion report, writes its row, does NOT run Docker/model/agent,
// does NOT mutate the source report or any aggregate row.
// ---------------------------------------------------------------------------
test("run: reads conversion report and writes a single labelled accounting row only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gp-acct-"));
  try {
    const results = await makeFixture(root);
    // Pre-existing aggregate report that must NOT be touched.
    const aggregatePath = path.join(results, "stage5_policy_accounting.json");
    const aggregateBefore = JSON.stringify({ policies: [{ policyName: "strict_vtrace_first_patch", resolvedCount: 3 }] });
    await writeFile(aggregatePath, aggregateBefore);
    // The source conversion report content, captured to assert it is not mutated.
    const sourcePath = path.join(results, `${DEFAULT_CONVERSION_REPORT_NAME}.json`);
    const sourceBefore = await readFile(sourcePath, "utf8");

    const report = await run(cfg(results));

    // 1. read the conversion report and recorded the row.
    assert.equal(report.row.rowName, ACCOUNTING_ROW_NAME);
    assert.equal(report.row.instanceId, INSTANCE);
    assert.equal(report.row.convertedUnresolvedToResolved, true);
    assert.equal(report.row.policyAccountingUpdated, true);
    assert.equal(report.row.aggregateComparable, false);

    // Wrote its own JSON + MD.
    const writtenJson = await readFile(path.join(results, "stage5_generated_parser_repair_accounting.json"), "utf8");
    const writtenMd = await readFile(path.join(results, "stage5_generated_parser_repair_accounting.md"), "utf8");
    assert.ok(writtenJson.includes(ACCOUNTING_ROW_NAME));
    assert.ok(writtenMd.includes(ACCOUNTING_ROW_NAME));

    // 9/12. existing aggregate report unchanged; source conversion report unchanged.
    assert.equal(await readFile(aggregatePath, "utf8"), aggregateBefore);
    assert.equal(await readFile(sourcePath, "utf8"), sourceBefore);

    // 12. only the two output files were created in the results dir (no Docker/raw artifacts written).
    const entries = (await readdir(results)).sort();
    assert.deepEqual(entries, [
      "stage5_generated_parser_repair_accounting.json",
      "stage5_generated_parser_repair_accounting.md",
      `${DEFAULT_CONVERSION_REPORT_NAME}.json`,
      "stage5_policy_accounting.json",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run: throws clearly when the conversion report is missing (no fabrication)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gp-acct-missing-"));
  try {
    const results = path.join(root, "results");
    await mkdir(results, { recursive: true });
    await assert.rejects(run(cfg(results)), /nothing to account for/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8/10. Required Markdown interpretation + required JSON fields.
// ---------------------------------------------------------------------------
test("renderMarkdown emits required interpretation, lineage limitations, and cost-cap follow-up", () => {
  const md = renderMarkdown({
    generatedAt: "2026-06-12T00:00:00.000Z",
    conversionReportName: DEFAULT_CONVERSION_REPORT_NAME,
    headline: "h",
    row: buildAccountingRow(CONVERSION_DOC),
  });
  // 8. required interpretation sentence verbatim.
  assert.ok(md.includes(REQUIRED_INTERPRETATION));
  // lineage limitation statements present.
  for (const limitation of LINEAGE_LIMITATIONS) assert.ok(md.includes(limitation), `missing limitation: ${limitation}`);
  // sections present.
  for (const section of [
    "## Accounting row: `single_instance_verified_generated_parser_repair_astropy`",
    "## Interpretation",
    "## Aggregate-comparability boundary",
    "## Cost-cap follow-up",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(section), `missing markdown section ${section}`);
  }
  // cost-cap follow-up with concrete figures.
  assert.ok(md.includes("repairCostUsd=$2.8185"));
  assert.ok(md.includes("repairCostCapUsd=$0.4000"));
  assert.ok(md.includes("aggregateComparable | false"));
});

test("renderJson emits all required fields with aggregateComparable=false and policyAccountingUpdated=true", () => {
  const report = {
    generatedAt: null,
    conversionReportName: DEFAULT_CONVERSION_REPORT_NAME,
    headline: "h",
    row: buildAccountingRow(CONVERSION_DOC),
  };
  const parsed = JSON.parse(renderJson(report));
  for (const field of [
    "rowName",
    "sourceRunLabel",
    "repairOutName",
    "instanceId",
    "sourcePatchResolved",
    "repairedPatchResolved",
    "convertedUnresolvedToResolved",
    "criticCostUsd",
    "repairCostUsd",
    "totalRecoveryCostUsd",
    "repairCostCapUsd",
    "repairCostExceededCap",
    "generatedParserRepairShapeAccepted",
    "generatedParserTablesUpdatedByRepair",
    "generatedParserTablesDeletedByRepair",
    "policyAccountingUpdated",
    "aggregateComparable",
  ]) {
    assert.ok(field in parsed.row, `missing JSON field ${field}`);
  }
  assert.equal(parsed.row.policyAccountingUpdated, true);
  assert.equal(parsed.row.aggregateComparable, false);
  assert.equal(parsed.row.repairCostExceededCap, true);
  assert.equal(parsed.row.sourceRunLabel, RL);
  assert.deepEqual(parsed.row.generatedParserTablesUpdatedByRepair, [CDS_PARSETAB]);
});
