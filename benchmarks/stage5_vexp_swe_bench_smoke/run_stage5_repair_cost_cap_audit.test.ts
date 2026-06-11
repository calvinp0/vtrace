import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type ConversionEvidenceDoc,
  AUDIT_HEADLINE,
  AUDIT_NON_CLAIMS,
  DEFAULT_CONVERSION_REPORT_NAME,
  buildAuditReport,
  parseArgs,
  renderJson,
  renderMarkdown,
  run,
} from "./run_stage5_repair_cost_cap_audit";

const INSTANCE = "astropy__astropy-14369";
const RL = "eval-strictv2-artifacts-protocol-vtrace-astropy-14369";

// The committed historical conversion evidence (subset the audit consumes).
const EVIDENCE: ConversionEvidenceDoc = {
  instanceId: INSTANCE,
  sourceRunLabel: RL,
  convertedUnresolvedToResolved: true,
  criticCostUsd: 0.18575950000000002,
  repairCostUsd: 2.8185425,
  totalRecoveryCostUsd: 3.004302,
  repairCostCapUsd: 0.4,
  repairCostExceededCap: true,
};

async function makeFixture(root: string, doc: ConversionEvidenceDoc | null = EVIDENCE): Promise<string> {
  const results = path.join(root, "results");
  await mkdir(results, { recursive: true });
  if (doc !== null) {
    await writeFile(path.join(results, `${DEFAULT_CONVERSION_REPORT_NAME}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  }
  return results;
}

function cfg(resultsDir: string) {
  return { resultsDir, conversionReportName: DEFAULT_CONVERSION_REPORT_NAME, outName: "stage5_repair_cost_cap_audit" };
}

// ---------------------------------------------------------------------------
// parseArgs.
// ---------------------------------------------------------------------------
test("parseArgs: conservative defaults; rejects unknown args", () => {
  const c = parseArgs([]);
  assert.equal(c.conversionReportName, DEFAULT_CONVERSION_REPORT_NAME);
  assert.equal(c.outName, "stage5_repair_cost_cap_audit");
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// buildAuditReport (pure): records the historical over-cap, existing + fixed semantics.
// ---------------------------------------------------------------------------
test("buildAuditReport: records the over-cap repair and the fix semantics", () => {
  const r = buildAuditReport({ generatedAt: null, conversionReportName: DEFAULT_CONVERSION_REPORT_NAME, evidence: EVIDENCE });
  // historical over-cap fact.
  assert.equal(r.historicalOverCapRepair.instanceId, INSTANCE);
  assert.equal(r.historicalOverCapRepair.repairCostUsd, 2.8185425);
  assert.equal(r.historicalOverCapRepair.repairCostCapUsd, 0.4);
  assert.equal(r.historicalOverCapRepair.repairCostExceededCap, true);
  assert.equal(r.historicalOverCapRepair.evidenceFound, true);
  // existing (buggy) mode: cumulative-only, single call may exceed.
  assert.equal(r.existingEnforcement.enforcementMode, "pre_call_cumulative_only");
  assert.equal(r.existingEnforcement.singleCallMayExceedCap, true);
  // fixed default mode: estimated-max, single call NOT allowed to exceed.
  assert.equal(r.fixedEnforcement.enforcementMode, "pre_call_estimated_max");
  assert.equal(r.fixedEnforcement.singleCallMayExceedCap, false);
  assert.ok(r.fixedEnforcement.reportedFields.includes("repairStoppedByCostCap"));
  assert.ok(r.fixedEnforcement.reportedFields.includes("repairCostCapEnforcementMode"));
  // does NOT change accounting / conversion result.
  assert.equal(r.policyAccountingUpdated, false);
  assert.equal(r.conversionResultChanged, false);
  // required non-claims verbatim.
  assert.deepEqual([...r.nonClaims], [...AUDIT_NON_CLAIMS]);
  assert.equal(r.headline, AUDIT_HEADLINE);
});

test("buildAuditReport: degrades gracefully when evidence is missing", () => {
  const r = buildAuditReport({ generatedAt: null, conversionReportName: DEFAULT_CONVERSION_REPORT_NAME, evidence: null });
  assert.equal(r.historicalOverCapRepair.evidenceFound, false);
  assert.equal(r.historicalOverCapRepair.repairCostUsd, null);
  // The semantics + non-claims are still emitted.
  assert.equal(r.fixedEnforcement.enforcementMode, "pre_call_estimated_max");
  assert.deepEqual([...r.nonClaims], [...AUDIT_NON_CLAIMS]);
});

// ---------------------------------------------------------------------------
// Required Markdown sections + statement.
// ---------------------------------------------------------------------------
test("renderMarkdown emits all required sections, the headline statement, and non-claims", () => {
  const md = renderMarkdown(
    buildAuditReport({ generatedAt: "2026-06-12T00:00:00.000Z", conversionReportName: DEFAULT_CONVERSION_REPORT_NAME, evidence: EVIDENCE }),
  );
  for (const section of [
    "# Stage 5 repair cost-cap audit",
    "## Summary",
    "## Historical over-cap repair",
    "## Existing enforcement behavior",
    "## Fix or clarified semantics",
    "## Generated-parser repair implications",
    "## Recommended next step",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(section), `missing section ${section}`);
  }
  assert.ok(md.includes(AUDIT_HEADLINE));
  for (const n of AUDIT_NON_CLAIMS) assert.ok(md.includes(n), `missing non-claim: ${n}`);
  // figures + modes surfaced.
  assert.ok(md.includes("$2.8185"));
  assert.ok(md.includes("$0.4000"));
  assert.ok(md.includes("pre_call_cumulative_only"));
  assert.ok(md.includes("pre_call_estimated_max"));
});

test("renderJson emits the required top-level fields", () => {
  const parsed = JSON.parse(renderJson(buildAuditReport({ generatedAt: null, conversionReportName: DEFAULT_CONVERSION_REPORT_NAME, evidence: EVIDENCE })));
  for (const f of [
    "headline",
    "rootCause",
    "historicalOverCapRepair",
    "existingEnforcement",
    "fixedEnforcement",
    "generatedParserRepairImplications",
    "recommendedNextStep",
    "policyAccountingUpdated",
    "conversionResultChanged",
    "nonClaims",
  ]) {
    assert.ok(f in parsed, `missing JSON field ${f}`);
  }
});

// ---------------------------------------------------------------------------
// run(): read-only, writes only its own outputs, does NOT mutate the evidence or accounting rows.
// ---------------------------------------------------------------------------
test("run: writes audit JSON+MD and mutates no existing evidence/accounting row", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cap-audit-"));
  try {
    const results = await makeFixture(root);
    // Pre-existing accounting + conversion rows that must NOT be touched.
    const acctPath = path.join(results, "stage5_generated_parser_repair_accounting.json");
    const acctBefore = JSON.stringify({ row: { rowName: "single_instance_verified_generated_parser_repair_astropy" } });
    await writeFile(acctPath, acctBefore);
    const evidencePath = path.join(results, `${DEFAULT_CONVERSION_REPORT_NAME}.json`);
    const evidenceBefore = await readFile(evidencePath, "utf8");

    const report = await run(cfg(results));
    assert.equal(report.historicalOverCapRepair.repairCostExceededCap, true);

    // Wrote its own outputs.
    assert.ok((await readFile(path.join(results, "stage5_repair_cost_cap_audit.json"), "utf8")).includes("pre_call_estimated_max"));
    assert.ok((await readFile(path.join(results, "stage5_repair_cost_cap_audit.md"), "utf8")).includes(AUDIT_HEADLINE));

    // Existing rows unchanged.
    assert.equal(await readFile(acctPath, "utf8"), acctBefore);
    assert.equal(await readFile(evidencePath, "utf8"), evidenceBefore);

    // Only expected files exist (no Docker/raw artifacts written).
    assert.deepEqual((await readdir(results)).sort(), [
      "stage5_generated_parser_repair_accounting.json",
      `${DEFAULT_CONVERSION_REPORT_NAME}.json`,
      "stage5_repair_cost_cap_audit.json",
      "stage5_repair_cost_cap_audit.md",
    ].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
