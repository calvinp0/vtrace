import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type DryRunRepairReportDoc,
  DEFAULT_DRY_RUN_OUT_NAME,
  DEFAULT_OUT_NAME,
  HISTORICAL_REPAIR_OUT_NAME,
  NON_CLAIMS,
  PRE_CALL_ESTIMATED_MAX,
  RECOMMENDED_NEXT_STEP,
  REQUIRED_INTERPRETATION,
  REQUIRED_MARKDOWN_SECTIONS,
  buildProof,
  parseArgs,
  renderJson,
  renderMarkdown,
  run,
} from "./run_stage5_repair_cost_cap_block_proof";

// ---------------------------------------------------------------------------
// Fixture — the committed no-model dry-run repair report subset (no Docker/model/agent/critic/repair).
// ---------------------------------------------------------------------------

const RL = "eval-strictv2-artifacts-protocol-vtrace-astropy-14369";
const CAP = 0.4;
const EST_MAX = 3;

// Mirrors the real dry-run report: eligible by defect class, but pre_call_estimated_max enforcement with
// est $3.00 over a $0.40 cap; dry-run invokes no model.
const DRY_RUN_DOC: DryRunRepairReportDoc = {
  gates: {
    dryRun: true,
    allowGeneratedParserRepair: true,
    repairCostCapUsd: CAP,
    runLabels: [RL],
  },
  costCapEnforcement: {
    repairCostCapUsd: CAP,
    repairCostCapEnforcementMode: PRE_CALL_ESTIMATED_MAX,
    repairEstimatedMaxCallCostUsd: EST_MAX,
    singleCallMayExceedCap: false,
    repairPreCallCumulativeCostUsd: 0,
    repairStoppedByCostCap: 0,
  },
  summary: {
    eligibleRuns: 1,
    repairCallsAttempted: 0,
    repairExecuted: false,
  },
  generatedParser: {
    allowed: true,
    eligibleRuns: 1,
    wouldRepairRuns: 1,
    repairExecuted: false,
  },
};

async function makeFixture(root: string, doc: DryRunRepairReportDoc | null = DRY_RUN_DOC): Promise<string> {
  const results = path.join(root, "results");
  await mkdir(results, { recursive: true });
  if (doc !== null) {
    await writeFile(path.join(results, `${DEFAULT_DRY_RUN_OUT_NAME}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  }
  return results;
}

function cfg(resultsDir: string) {
  return { resultsDir, dryRunOutName: DEFAULT_DRY_RUN_OUT_NAME, outName: DEFAULT_OUT_NAME };
}

const PROOF = () => buildProof({ generatedAt: "2026-06-12T00:00:00.000Z", dryRunOutName: DEFAULT_DRY_RUN_OUT_NAME, doc: DRY_RUN_DOC });

// ---------------------------------------------------------------------------
// parseArgs.
// ---------------------------------------------------------------------------
test("parseArgs: conservative defaults; rejects unknown args", () => {
  const c = parseArgs([]);
  assert.equal(c.outName, DEFAULT_OUT_NAME);
  assert.equal(c.dryRunOutName, DEFAULT_DRY_RUN_OUT_NAME);
  assert.equal(parseArgs(["--dry-run-out-name", "custom"]).dryRunOutName, "custom");
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// 1/2/3/4/5/6/7/8. buildProof reads the dry-run fixture and proves the cap blocks before any model call.
// ---------------------------------------------------------------------------
test("buildProof: proves the hardened cost cap blocks the historical repair before any model call", () => {
  const p = PROOF();
  // 1. read the dry-run report fixture.
  assert.equal(p.dryRunReportAvailable, true);
  assert.equal(p.sourceRunLabel, RL);
  assert.equal(p.historicalRepairOutName, HISTORICAL_REPAIR_OUT_NAME);
  // 2. pre_call_estimated_max enforcement.
  assert.equal(p.repairCostCapEnforcementMode, PRE_CALL_ESTIMATED_MAX);
  // 3. estimated max call cost $3.00.
  assert.equal(p.repairEstimatedMaxCallCostUsd, EST_MAX);
  // 4. estimatedTotalIfCalledUsd > repairCostCapUsd.
  assert.equal(p.priorCumulativeCostUsd, 0);
  assert.equal(p.estimatedTotalIfCalledUsd, 3);
  assert.equal(p.repairCostCapUsd, CAP);
  assert.ok(p.estimatedTotalIfCalledUsd > p.repairCostCapUsd);
  // 5. blocked before model call.
  assert.equal(p.blockedBeforeModelCall, true);
  assert.equal(p.repairStoppedByCostCap, true);
  assert.equal(p.singleCallMayExceedCap, false);
  // 6. no repair call attempted.
  assert.equal(p.repairCallsAttempted, 0);
  assert.equal(p.repairExecuted, false);
  // 7. no model called.
  assert.equal(p.modelCalled, false);
  // 8. proofPassed=true.
  assert.equal(p.proofPassed, true);
  // eligible by defect class but blocked by cap.
  assert.equal(p.generatedParserRepairAllowed, true);
  assert.equal(p.generatedParserRepairEligibleBeforeCostCap, true);
  assert.equal(p.interpretation, REQUIRED_INTERPRETATION);
});

// ---------------------------------------------------------------------------
// 9. renderMarkdown emits the required sections + interpretation + recommended next step + non-claims.
// ---------------------------------------------------------------------------
test("renderMarkdown: emits all required sections, interpretation, next step, non-claims", () => {
  const md = renderMarkdown(PROOF());
  for (const section of REQUIRED_MARKDOWN_SECTIONS) {
    assert.ok(md.includes(section), `missing markdown section: ${section}`);
  }
  assert.ok(md.includes(REQUIRED_INTERPRETATION));
  assert.ok(md.includes(RECOMMENDED_NEXT_STEP));
  for (const n of NON_CLAIMS) assert.ok(md.includes(n), `md missing non-claim: ${n}`);
  // The block arithmetic is shown.
  assert.ok(md.includes("$0.0000 + $3.0000 = $3.0000 > $0.4000"));
  // It clearly states no model/repair call was made and the cap blocked before the call.
  assert.ok(md.includes("modelCalled=false"));
  assert.ok(md.includes("blockedBeforeModelCall | true"));
});

// ---------------------------------------------------------------------------
// 10. renderJson emits all required JSON fields.
// ---------------------------------------------------------------------------
test("renderJson: emits all required JSON fields with proofPassed=true", () => {
  const parsed = JSON.parse(renderJson(PROOF()));
  for (const field of [
    "generatedAt",
    "sourceRunLabel",
    "historicalRepairOutName",
    "dryRunOutName",
    "repairCostCapUsd",
    "repairEstimatedMaxCallCostUsd",
    "repairCostCapEnforcementMode",
    "priorCumulativeCostUsd",
    "estimatedTotalIfCalledUsd",
    "blockedBeforeModelCall",
    "repairStoppedByCostCap",
    "repairCallsAttempted",
    "repairExecuted",
    "wouldRepair",
    "modelCalled",
    "generatedParserRepairAllowed",
    "generatedParserRepairEligibleBeforeCostCap",
    "singleCallMayExceedCap",
    "proofPassed",
  ]) {
    assert.ok(field in parsed, `missing JSON field: ${field}`);
  }
  assert.equal(parsed.proofPassed, true);
  assert.equal(parsed.blockedBeforeModelCall, true);
  assert.equal(parsed.modelCalled, false);
  assert.equal(parsed.repairCallsAttempted, 0);
  assert.equal(parsed.repairCostCapEnforcementMode, PRE_CALL_ESTIMATED_MAX);
});

// ---------------------------------------------------------------------------
// Degrades gracefully when enforcement is the OLD cumulative-only mode (proof must NOT pass).
// ---------------------------------------------------------------------------
test("buildProof: does NOT pass under old cumulative-only enforcement (single call may exceed cap)", () => {
  const p = buildProof({
    generatedAt: "2026-06-12T00:00:00.000Z",
    dryRunOutName: DEFAULT_DRY_RUN_OUT_NAME,
    doc: {
      ...DRY_RUN_DOC,
      costCapEnforcement: {
        ...DRY_RUN_DOC.costCapEnforcement,
        repairCostCapEnforcementMode: "pre_call_cumulative_only",
        repairEstimatedMaxCallCostUsd: null,
        singleCallMayExceedCap: true,
      },
    },
  });
  assert.equal(p.blockedBeforeModelCall, false);
  assert.equal(p.proofPassed, false);
  assert.equal(p.singleCallMayExceedCap, true);
});

// ---------------------------------------------------------------------------
// 1/11. End-to-end: reads fixture, writes proof, mutates no source report, no Docker/model/agent/repair.
// ---------------------------------------------------------------------------
test("run: reads the dry-run report and writes proof JSON+MD only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cap-proof-"));
  try {
    const results = await makeFixture(root);
    const sourcePath = path.join(results, `${DEFAULT_DRY_RUN_OUT_NAME}.json`);
    const sourceBefore = await readFile(sourcePath, "utf8");

    const proof = await run(cfg(results));
    assert.equal(proof.proofPassed, true);
    assert.equal(proof.modelCalled, false);

    const writtenJson = await readFile(path.join(results, `${DEFAULT_OUT_NAME}.json`), "utf8");
    const writtenMd = await readFile(path.join(results, `${DEFAULT_OUT_NAME}.md`), "utf8");
    assert.ok(writtenJson.includes("\"proofPassed\": true"));
    assert.ok(writtenMd.includes("# Stage 5 repair cost-cap block proof"));

    // 11. source dry-run report unchanged (no side-effects).
    assert.equal(await readFile(sourcePath, "utf8"), sourceBefore);
    const entries = (await readdir(results)).sort();
    assert.deepEqual(entries, [
      `${DEFAULT_OUT_NAME}.json`,
      `${DEFAULT_OUT_NAME}.md`,
      `${DEFAULT_DRY_RUN_OUT_NAME}.json`,
    ].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run: throws clearly when the dry-run report is missing (no fabrication)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cap-proof-missing-"));
  try {
    const results = await makeFixture(root, null);
    await assert.rejects(run(cfg(results)), /nothing to prove/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
