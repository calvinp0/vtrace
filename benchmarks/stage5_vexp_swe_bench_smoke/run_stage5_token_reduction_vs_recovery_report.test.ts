import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type ConversionDoc,
  type CostCapAuditDoc,
  type CostCapProofDoc,
  type PolicyAccountingDoc,
  type RepairAccountingDoc,
  CANNOT_CLAIM,
  CAN_CLAIM,
  DEFAULT_OUT_NAME,
  HEADLINE_CLAIM,
  NON_CLAIMS,
  RECOMMENDED_NEXT_MILESTONES,
  REQUIRED_INTERPRETATION,
  REQUIRED_MARKDOWN_SECTIONS,
  SOURCE_CONTROL_LOOP,
  SOURCE_CONVERSION,
  SOURCE_COSTCAP_AUDIT,
  SOURCE_COSTCAP_PROOF,
  SOURCE_POLICY,
  SOURCE_REPAIR_ACCOUNTING,
  buildFirstPassEvidence,
  buildReport,
  parseArgs,
  renderJson,
  renderMarkdown,
  run,
} from "./run_stage5_token_reduction_vs_recovery_report";

// ---------------------------------------------------------------------------
// Fixtures — committed source-report subsets (no Docker/model/agent/critic/repair run).
// ---------------------------------------------------------------------------

const INSTANCE = "astropy__astropy-14369";

// Real strict-vs-baseline first-pass totals (from stage5_policy_accounting.json strictAccounting).
const BASELINE_TOKENS = 16756692;
const STRICT_TOKENS = 12526985;
const BASELINE_COST = 6.97774825;
const STRICT_COST = 6.4080495000000015;

const POLICY_DOC: PolicyAccountingDoc = {
  strictAccounting: {
    baselineResolved: 8,
    strictResolved: 7,
    baselineTotalTokens: BASELINE_TOKENS,
    strictTotalTokens: STRICT_TOKENS,
    baselineTotalCostUsd: BASELINE_COST,
    strictTotalCostUsd: STRICT_COST,
  },
};

const REPAIR_ACCOUNTING_DOC: RepairAccountingDoc = {
  row: {
    instanceId: INSTANCE,
    criticCostUsd: 0.18575950000000002,
    repairCostUsd: 2.8185425,
    totalRecoveryCostUsd: 3.004302,
    repairCostExceededCap: true,
    convertedUnresolvedToResolved: true,
  },
};

const CONVERSION_DOC: ConversionDoc = {
  instanceId: INSTANCE,
  sourcePatchResolved: false,
  repairedPatchResolved: true,
  convertedUnresolvedToResolved: true,
};

const COSTCAP_AUDIT_DOC: CostCapAuditDoc = {
  historicalOverCapRepair: { repairCostExceededCap: true },
  fixedEnforcement: { enforcementMode: "pre_call_estimated_max", singleCallMayExceedCap: false },
};

const COSTCAP_PROOF_DOC: CostCapProofDoc = { proofPassed: true };

const CONTROL_LOOP_DOC = { status: "single_instance_verified_control_loop" };

async function makeFixture(root: string, opts: { omit?: readonly string[] } = {}): Promise<string> {
  const results = path.join(root, "results");
  await mkdir(results, { recursive: true });
  const omit = new Set(opts.omit ?? []);
  const docs: Record<string, unknown> = {
    [SOURCE_POLICY]: POLICY_DOC,
    [SOURCE_CONTROL_LOOP]: CONTROL_LOOP_DOC,
    [SOURCE_REPAIR_ACCOUNTING]: REPAIR_ACCOUNTING_DOC,
    [SOURCE_CONVERSION]: CONVERSION_DOC,
    [SOURCE_COSTCAP_AUDIT]: COSTCAP_AUDIT_DOC,
    [SOURCE_COSTCAP_PROOF]: COSTCAP_PROOF_DOC,
  };
  for (const [name, doc] of Object.entries(docs)) {
    if (omit.has(name)) continue;
    await writeFile(path.join(results, `${name}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  }
  return results;
}

function cfg(resultsDir: string) {
  return { resultsDir, outName: DEFAULT_OUT_NAME };
}

const FULL_REPORT = () =>
  buildReport({
    generatedAt: "2026-06-12T00:00:00.000Z",
    policy: POLICY_DOC,
    controlLoop: CONTROL_LOOP_DOC,
    repairAccounting: REPAIR_ACCOUNTING_DOC,
    conversion: CONVERSION_DOC,
    costCapAudit: COSTCAP_AUDIT_DOC,
    costCapProof: COSTCAP_PROOF_DOC,
  });

// ---------------------------------------------------------------------------
// parseArgs.
// ---------------------------------------------------------------------------
test("parseArgs: conservative defaults; rejects unknown args", () => {
  const c = parseArgs([]);
  assert.equal(c.outName, DEFAULT_OUT_NAME);
  assert.equal(parseArgs(["--out-name", "custom"]).outName, "custom");
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// 1. Reads fixture first-pass evidence when present (and computes reductions, not invented).
// ---------------------------------------------------------------------------
test("buildFirstPassEvidence: reads totals and computes reductions from fixture", () => {
  const fp = buildFirstPassEvidence(POLICY_DOC);
  assert.equal(fp.available, true);
  assert.equal(fp.baselineResolvedCount, 8);
  assert.equal(fp.vtraceFirstPassResolvedCount, 7);
  assert.equal(fp.baselineTotalTokens, BASELINE_TOKENS);
  assert.equal(fp.vtraceFirstPassTotalTokens, STRICT_TOKENS);
  // ~25.24% token reduction, ~8.17% cost reduction (computed, not hardcoded).
  assert.ok(Math.abs(fp.tokenReductionPercent! - 25.2418) < 0.01, `got ${fp.tokenReductionPercent}`);
  assert.ok(Math.abs(fp.costReductionPercent! - 8.1646) < 0.01, `got ${fp.costReductionPercent}`);
});

// ---------------------------------------------------------------------------
// 2. Handles missing first-pass evidence without inventing numbers.
// ---------------------------------------------------------------------------
test("buildFirstPassEvidence: missing policy report yields unavailable, no invented numbers", () => {
  const fp = buildFirstPassEvidence(null);
  assert.equal(fp.available, false);
  assert.equal(fp.baselineTotalTokens, null);
  assert.equal(fp.vtraceFirstPassTotalTokens, null);
  assert.equal(fp.tokenReductionPercent, null);
  assert.equal(fp.costReductionPercent, null);
  assert.equal(fp.baselineResolvedCount, null);
});

test("buildReport: missing policy report keeps firstPassEvidenceAvailable=false but recovery intact", () => {
  const r = buildReport({
    generatedAt: "2026-06-12T00:00:00.000Z",
    policy: null,
    controlLoop: null,
    repairAccounting: REPAIR_ACCOUNTING_DOC,
    conversion: CONVERSION_DOC,
    costCapAudit: COSTCAP_AUDIT_DOC,
    costCapProof: COSTCAP_PROOF_DOC,
  });
  assert.equal(r.firstPassEvidenceAvailable, false);
  assert.equal(r.firstPassTokenReductionPercent, null);
  assert.equal(r.baselineResolvedCount, null);
  // recovery still recorded.
  assert.equal(r.recoveryEvidenceAvailable, true);
  assert.equal(r.totalRecoveryCostUsd, 3.004302);
  assert.equal(r.sourceReports.find((s) => s.name === SOURCE_POLICY)?.available, false);
});

// ---------------------------------------------------------------------------
// 3/4/5/6/7. buildReport: recovery + cost-cap evidence + separation invariants.
// ---------------------------------------------------------------------------
test("buildReport: records recovery + cost-cap evidence and keeps separation invariants", () => {
  const r = FULL_REPORT();
  assert.equal(r.status, "first_pass_and_recovery_separated");
  // 3. repair accounting evidence.
  assert.equal(r.recoveryInstanceId, INSTANCE);
  assert.equal(r.sourcePatchResolved, false);
  assert.equal(r.repairedPatchResolved, true);
  assert.equal(r.convertedUnresolvedToResolved, true);
  assert.equal(r.criticCostUsd, 0.18575950000000002);
  assert.equal(r.repairCostUsd, 2.8185425);
  assert.equal(r.totalRecoveryCostUsd, 3.004302);
  // 4. cost-cap audit + block-proof evidence.
  assert.equal(r.historicalRepairCostCapExceeded, true);
  assert.equal(r.repairCostCapHardened, true);
  assert.equal(r.repairCostCapBlockProofPassed, true);
  // 5/6/7. separation invariants.
  assert.equal(r.recoveryMergedIntoFirstPass, false);
  assert.equal(r.aggregateComparable, false);
  assert.equal(r.userFacingRepairCostControls, false);
  assert.equal(r.interpretation, REQUIRED_INTERPRETATION);
  assert.equal(r.headlineClaim, HEADLINE_CLAIM);
});

// ---------------------------------------------------------------------------
// 8. Careful canClaim / cannotClaim language.
// ---------------------------------------------------------------------------
test("buildReport: emits careful canClaim/cannotClaim language", () => {
  const r = FULL_REPORT();
  assert.deepEqual([...r.canClaim], [...CAN_CLAIM]);
  assert.deepEqual([...r.cannotClaim], [...CANNOT_CLAIM]);
  assert.ok(r.canClaim.some((c) => c.includes("reduce first-pass token usage")));
  assert.ok(r.canClaim.some((c) => c.includes("one verified generated-parser repair conversion")));
  assert.ok(r.cannotClaim.some((c) => c.includes("improves the aggregate Stage 5 score")));
  assert.ok(r.cannotClaim.some((c) => c.includes("generalizes beyond the verified Astropy case")));
  assert.ok(r.cannotClaim.some((c) => c.includes("users should configure repair cost caps")));
  assert.ok(r.cannotClaim.some((c) => c.includes("public headline product feature")));
});

// ---------------------------------------------------------------------------
// 9. Required recommended next milestones.
// ---------------------------------------------------------------------------
test("buildReport: emits required recommended next milestones in order", () => {
  const r = FULL_REPORT();
  assert.deepEqual([...r.recommendedNextMilestones], [...RECOMMENDED_NEXT_MILESTONES]);
  assert.ok(r.recommendedNextMilestones[0]!.includes("keeps token reduction as the headline"));
  assert.ok(r.recommendedNextMilestones[1]!.includes("expected-value policy for repair"));
  assert.ok(r.recommendedNextMilestones[3]!.includes("product/engineering split"));
});

// ---------------------------------------------------------------------------
// 10. Required Markdown sections + JSON fields.
// ---------------------------------------------------------------------------
test("renderMarkdown: emits all required sections and headline/interpretation", () => {
  const md = renderMarkdown(FULL_REPORT());
  for (const section of REQUIRED_MARKDOWN_SECTIONS) {
    assert.ok(md.includes(section), `missing markdown section: ${section}`);
  }
  assert.ok(md.includes(HEADLINE_CLAIM));
  assert.ok(md.includes(REQUIRED_INTERPRETATION));
  assert.ok(md.includes("first-pass context/token reduction != repair-side recovery cost"));
  for (const c of CAN_CLAIM) assert.ok(md.includes(c), `md missing canClaim: ${c}`);
  for (const c of CANNOT_CLAIM) assert.ok(md.includes(c), `md missing cannotClaim: ${c}`);
  for (const n of NON_CLAIMS) assert.ok(md.includes(n), `md missing non-claim: ${n}`);
});

test("renderJson: emits all required JSON fields with separation invariants", () => {
  const parsed = JSON.parse(renderJson(FULL_REPORT()));
  for (const field of [
    "generatedAt",
    "status",
    "firstPassEvidenceAvailable",
    "firstPassTokenReductionPercent",
    "firstPassCostReductionPercent",
    "baselineResolvedCount",
    "vtraceFirstPassResolvedCount",
    "recoveryEvidenceAvailable",
    "recoveryInstanceId",
    "sourcePatchResolved",
    "repairedPatchResolved",
    "convertedUnresolvedToResolved",
    "criticCostUsd",
    "repairCostUsd",
    "totalRecoveryCostUsd",
    "historicalRepairCostCapExceeded",
    "repairCostCapHardened",
    "repairCostCapBlockProofPassed",
    "recoveryMergedIntoFirstPass",
    "aggregateComparable",
    "userFacingRepairCostControls",
    "headlineClaim",
    "technicalControlLoopSummary",
    "canClaim",
    "cannotClaim",
    "recommendedNextMilestones",
    "nonClaims",
  ]) {
    assert.ok(field in parsed, `missing JSON field: ${field}`);
  }
  assert.equal(parsed.status, "first_pass_and_recovery_separated");
  assert.equal(parsed.recoveryMergedIntoFirstPass, false);
  assert.equal(parsed.aggregateComparable, false);
  assert.equal(parsed.userFacingRepairCostControls, false);
});

// ---------------------------------------------------------------------------
// Graceful degradation: missing cost-cap audit/proof does NOT throw; flags fall back to false.
// ---------------------------------------------------------------------------
test("buildReport: missing cost-cap audit/proof degrades to false (no throw)", () => {
  const r = buildReport({
    generatedAt: "2026-06-12T00:00:00.000Z",
    policy: POLICY_DOC,
    controlLoop: CONTROL_LOOP_DOC,
    repairAccounting: REPAIR_ACCOUNTING_DOC,
    conversion: CONVERSION_DOC,
    costCapAudit: null,
    costCapProof: null,
  });
  assert.equal(r.repairCostCapHardened, false);
  assert.equal(r.repairCostCapBlockProofPassed, false);
  // historical exceedance still recoverable from the accounting row.
  assert.equal(r.historicalRepairCostCapExceeded, true);
});

// ---------------------------------------------------------------------------
// 11. End-to-end: reads fixtures, writes report, mutates no source report; no Docker/model/agent/repair.
// ---------------------------------------------------------------------------
test("run: reads source reports and writes report JSON+MD only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tok-rec-"));
  try {
    const results = await makeFixture(root);
    const before: Record<string, string> = {};
    for (const name of [
      SOURCE_POLICY,
      SOURCE_REPAIR_ACCOUNTING,
      SOURCE_CONVERSION,
      SOURCE_COSTCAP_AUDIT,
      SOURCE_COSTCAP_PROOF,
    ]) {
      before[name] = await readFile(path.join(results, `${name}.json`), "utf8");
    }

    const report = await run(cfg(results));
    assert.equal(report.status, "first_pass_and_recovery_separated");
    assert.equal(report.firstPassEvidenceAvailable, true);
    assert.equal(report.recoveryMergedIntoFirstPass, false);

    const writtenJson = await readFile(path.join(results, `${DEFAULT_OUT_NAME}.json`), "utf8");
    const writtenMd = await readFile(path.join(results, `${DEFAULT_OUT_NAME}.md`), "utf8");
    assert.ok(writtenJson.includes("first_pass_and_recovery_separated"));
    assert.ok(writtenMd.includes("# Stage 5 token reduction vs recovery cost"));

    // source reports unchanged (no side-effects).
    for (const [name, content] of Object.entries(before)) {
      assert.equal(await readFile(path.join(results, `${name}.json`), "utf8"), content, `${name} mutated`);
    }
    const entries = (await readdir(results)).sort();
    assert.deepEqual(entries, [
      `${SOURCE_CONTROL_LOOP}.json`,
      `${SOURCE_CONVERSION}.json`,
      `${SOURCE_COSTCAP_AUDIT}.json`,
      `${SOURCE_COSTCAP_PROOF}.json`,
      `${SOURCE_POLICY}.json`,
      `${SOURCE_REPAIR_ACCOUNTING}.json`,
      `${DEFAULT_OUT_NAME}.json`,
      `${DEFAULT_OUT_NAME}.md`,
    ].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run: completes when first-pass policy report is missing (graceful, marks unavailable)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tok-rec-missing-"));
  try {
    const results = await makeFixture(root, { omit: [SOURCE_POLICY] });
    const report = await run(cfg(results));
    assert.equal(report.firstPassEvidenceAvailable, false);
    assert.equal(report.firstPassTokenReductionPercent, null);
    const md = await readFile(path.join(results, `${DEFAULT_OUT_NAME}.md`), "utf8");
    assert.ok(md.includes("unavailable"));
    assert.ok(md.includes("Source reports unavailable"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
