import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type AccountingDoc,
  type ConversionDoc,
  type CostCapAuditDoc,
  type CriticAgreementDoc,
  type ProtocolDiagnosticDoc,
  DEFAULT_OUT_NAME,
  NON_CLAIMS,
  RECOMMENDED_NEXT_MILESTONES,
  REQUIRED_INTERPRETATION,
  REQUIRED_MARKDOWN_SECTIONS,
  SAFETY_GATES,
  SOURCE_ACCOUNTING,
  SOURCE_CONVERSION,
  SOURCE_COSTCAP,
  SOURCE_CRITIC,
  SOURCE_PROBE,
  SOURCE_PROTOCOL,
  buildStatus,
  parseArgs,
  renderJson,
  renderMarkdown,
  run,
} from "./run_stage5_control_loop_status_report";

// ---------------------------------------------------------------------------
// Fixtures — the committed source report subsets (no Docker/model/agent/critic/repair run).
// ---------------------------------------------------------------------------

const RL = "eval-strictv2-artifacts-protocol-vtrace-astropy-14369";
const INSTANCE = "astropy__astropy-14369";
const CDS = "astropy/units/format/cds.py";
const CDS_PARSETAB = "astropy/units/format/cds_parsetab.py";
const LEAD_PIVOT = "astropy/units/format/cds.py::CDS";
const TOTAL_RECOVERY = 3.004302;

const PROTOCOL_DOC: ProtocolDiagnosticDoc = {
  runLabel: RL,
  instanceId: INSTANCE,
  capsule: {
    capsuleV2ArtifactsPersisted: true,
    treatmentValid: true,
    contextInjected: true,
    topPivotFile: CDS,
    topPivotSymbol: "CDS",
  },
  orderedTelemetry: {
    longBashLoopHeuristic: false,
    repeatedSearchHeuristic: false,
    orderedTelemetryAvailable: true,
  },
  docker: { resolved: false },
  contextGood: true,
};

const CRITIC_DOC: CriticAgreementDoc = {
  contextQuality: {
    leadPivot: LEAD_PIVOT,
    longBashLoopHeuristic: false,
    repeatedSearchHeuristic: false,
  },
  deterministicRepairRequired: true,
  liveRepairRequired: true,
  agreementWithDeterministic: true,
};

const CONVERSION_DOC: ConversionDoc = {
  sourceRunLabel: RL,
  instanceId: INSTANCE,
  sourcePatchResolved: false,
  repairedPatchResolved: true,
  convertedUnresolvedToResolved: true,
  generatedParserRepairShapeAccepted: true,
  generatedParserTablesUpdatedByRepair: [CDS_PARSETAB],
  totalRecoveryCostUsd: TOTAL_RECOVERY,
  repairCostExceededCap: true,
};

const ACCOUNTING_DOC: AccountingDoc = {
  row: {
    instanceId: INSTANCE,
    totalRecoveryCostUsd: TOTAL_RECOVERY,
    repairCostExceededCap: true,
  },
};

const COSTCAP_DOC: CostCapAuditDoc = {
  historicalOverCapRepair: { repairCostExceededCap: true },
  fixedEnforcement: {
    enforcementMode: "pre_call_estimated_max",
    singleCallMayExceedCap: false,
  },
};

const PROBE_DOC = { summary: { runsAnalyzed: 5 }, findings: [] };

// Write a temp results dir holding all committed source reports. Returns the resultsDir.
async function makeFixture(root: string, opts: { omit?: readonly string[] } = {}): Promise<string> {
  const results = path.join(root, "results");
  await mkdir(results, { recursive: true });
  const omit = new Set(opts.omit ?? []);
  const docs: Record<string, unknown> = {
    [SOURCE_PROTOCOL]: PROTOCOL_DOC,
    [SOURCE_PROBE]: PROBE_DOC,
    [SOURCE_CRITIC]: CRITIC_DOC,
    [SOURCE_CONVERSION]: CONVERSION_DOC,
    [SOURCE_ACCOUNTING]: ACCOUNTING_DOC,
    [SOURCE_COSTCAP]: COSTCAP_DOC,
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

const FULL_STATUS = () =>
  buildStatus({
    generatedAt: "2026-06-12T00:00:00.000Z",
    protocol: PROTOCOL_DOC,
    probe: PROBE_DOC,
    critic: CRITIC_DOC,
    conversion: CONVERSION_DOC,
    accounting: ACCOUNTING_DOC,
    costCap: COSTCAP_DOC,
  });

// ---------------------------------------------------------------------------
// parseArgs.
// ---------------------------------------------------------------------------
test("parseArgs: conservative defaults; rejects unknown args", () => {
  const c = parseArgs([]);
  assert.equal(c.outName, DEFAULT_OUT_NAME);
  assert.equal(parseArgs(["--out-name", "custom"]).outName, "custom");
  assert.equal(parseArgs(["--results", "/tmp/x"]).resultsDir, "/tmp/x");
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// 1/2/3/4/5. buildStatus reads source reports and emits the required verified fields.
// ---------------------------------------------------------------------------
test("buildStatus: consolidates source reports into verified control-loop status", () => {
  const s = FULL_STATUS();
  assert.equal(s.status, "single_instance_verified_control_loop");
  assert.equal(s.verifiedInstanceId, INSTANCE);
  assert.equal(s.sourceRunLabel, RL);
  assert.equal(s.leadPivot, LEAD_PIVOT);
  assert.equal(s.capsuleV2ContextValid, true);
  assert.equal(s.loopHeuristicsFalse, true);
  assert.equal(s.sourcePatchResolved, false);
  assert.equal(s.repairedPatchResolved, true);
  assert.equal(s.deterministicProbeRepairRequired, true);
  assert.equal(s.liveCriticRepairRequired, true);
  assert.equal(s.criticAgreement, true);
  assert.equal(s.shapeGateAccepted, true);
  assert.deepEqual([...s.generatedParserTablesUpdatedByRepair], [CDS_PARSETAB]);
  assert.equal(s.recoveryCostUsd, TOTAL_RECOVERY);
  // 2. convertedUnresolvedToResolved=true.
  assert.equal(s.convertedUnresolvedToResolved, true);
  // 3. aggregateComparable=false.
  assert.equal(s.aggregateComparable, false);
  // 4. repairCostCapExceededHistorically=true.
  assert.equal(s.repairCostCapExceededHistorically, true);
  // 5. costCapHardened=true.
  assert.equal(s.costCapHardened, true);
  assert.equal(s.interpretation, REQUIRED_INTERPRETATION);
  // every source report observed available.
  assert.ok(s.sourceReports.every((r) => r.available));
});

// ---------------------------------------------------------------------------
// 6. Emits the full safety-gate list.
// ---------------------------------------------------------------------------
test("buildStatus: emits all required safety gates", () => {
  const s = FULL_STATUS();
  assert.deepEqual([...s.safetyGates], [...SAFETY_GATES]);
  for (const gate of [
    "disabled by default",
    "explicit --run-label required",
    "--enable-patch-repair required",
    "--allow-generated-parser-repair required",
    "valid live critic artifact required",
    "deterministic/live agreement required",
    "actionable narrow guidance required",
    "one attempt only",
    "fail-open behavior",
    "post-repair shape gate",
    "cost-cap enforcement",
    "no default generated-parser allowlist entry",
  ]) {
    assert.ok(s.safetyGates.includes(gate), `missing gate: ${gate}`);
  }
});

// ---------------------------------------------------------------------------
// 7. Emits the required recommended next milestones, in order.
// ---------------------------------------------------------------------------
test("buildStatus: emits required recommended next milestones in order", () => {
  const s = FULL_STATUS();
  assert.deepEqual([...s.recommendedNextMilestones], [...RECOMMENDED_NEXT_MILESTONES]);
  assert.ok(s.recommendedNextMilestones[0]!.includes("$0.40 cap"));
  assert.ok(s.recommendedNextMilestones[1]!.includes("first-pass strict-v2 tokens vs repair-side recovery cost"));
  assert.ok(s.recommendedNextMilestones[3]!.includes("expected-value policy"));
});

// ---------------------------------------------------------------------------
// 8. Emits the required non-claims.
// ---------------------------------------------------------------------------
test("buildStatus: emits required non-claims", () => {
  const s = FULL_STATUS();
  assert.deepEqual([...s.nonClaims], [...NON_CLAIMS]);
  for (const claim of [
    "This report does not claim aggregate SWE-bench improvement.",
    "This report does not claim generated-parser repair generalizes beyond the verified Astropy case.",
    "This report does not merge repair recovery into first-pass token reduction.",
    "This report does not enable broader repair usage.",
    "This report does not change policy accounting.",
    "This report does not run agents, repair, live critic, or Docker.",
  ]) {
    assert.ok(s.nonClaims.includes(claim), `missing non-claim: ${claim}`);
  }
});

// ---------------------------------------------------------------------------
// Evidence chain carries the required ordered statements.
// ---------------------------------------------------------------------------
test("buildStatus: evidence chain includes the required verified statements", () => {
  const s = FULL_STATUS();
  for (const item of [
    "Astropy protocol run had valid indexed Capsule v2 context.",
    "cds.py::CDS was the lead pivot.",
    "loop heuristics were false.",
    "source patch resolved=false.",
    "deterministic generated-parser minimality probe repairRequired=true.",
    "live critic agreed repairRequired=true.",
    "first generated-parser repair failed because cds_parsetab.py was not updated.",
    "consistency diagnostic found source_grammar_changed_without_generated_table_update.",
    "shape-gated repair changed cds.py + cds_parsetab.py.",
    "Docker resolved=true for the shape-gated repair.",
    "convertedUnresolvedToResolved=true.",
    "recovery cost was about $3.0043.",
    "original repair cap was exceeded historically, and cost-cap enforcement has now been hardened.",
  ]) {
    assert.ok(s.evidenceChain.includes(item), `missing evidence-chain item: ${item}`);
  }
});

// ---------------------------------------------------------------------------
// 9. Emits the required Markdown sections.
// ---------------------------------------------------------------------------
test("renderMarkdown: emits all required sections + interpretation", () => {
  const md = renderMarkdown(FULL_STATUS());
  for (const section of REQUIRED_MARKDOWN_SECTIONS) {
    assert.ok(md.includes(section), `missing markdown section: ${section}`);
  }
  assert.ok(md.includes(REQUIRED_INTERPRETATION));
  for (const gate of SAFETY_GATES) assert.ok(md.includes(gate), `md missing gate: ${gate}`);
  for (const m of RECOMMENDED_NEXT_MILESTONES) assert.ok(md.includes(m), `md missing milestone: ${m}`);
  for (const n of NON_CLAIMS) assert.ok(md.includes(n), `md missing non-claim: ${n}`);
});

test("renderJson: emits all required JSON fields", () => {
  const parsed = JSON.parse(renderJson(FULL_STATUS()));
  for (const field of [
    "generatedAt",
    "status",
    "verifiedInstanceId",
    "sourceRunLabel",
    "sourcePatchResolved",
    "repairedPatchResolved",
    "convertedUnresolvedToResolved",
    "capsuleV2ContextValid",
    "leadPivot",
    "loopHeuristicsFalse",
    "deterministicProbeRepairRequired",
    "liveCriticRepairRequired",
    "criticAgreement",
    "shapeGateAccepted",
    "generatedParserTablesUpdatedByRepair",
    "recoveryCostUsd",
    "repairCostCapExceededHistorically",
    "costCapHardened",
    "aggregateComparable",
    "recommendedNextMilestones",
    "nonClaims",
  ]) {
    assert.ok(field in parsed, `missing JSON field: ${field}`);
  }
  assert.equal(parsed.status, "single_instance_verified_control_loop");
  assert.equal(parsed.aggregateComparable, false);
  assert.equal(parsed.convertedUnresolvedToResolved, true);
  assert.equal(parsed.repairCostCapExceededHistorically, true);
  assert.equal(parsed.costCapHardened, true);
});

// ---------------------------------------------------------------------------
// 10. Handles a missing source report gracefully (no throw, marks unavailable).
// ---------------------------------------------------------------------------
test("buildStatus: degrades gracefully when a source report is missing", () => {
  const s = buildStatus({
    generatedAt: "2026-06-12T00:00:00.000Z",
    protocol: PROTOCOL_DOC,
    probe: PROBE_DOC,
    critic: CRITIC_DOC,
    conversion: null, // missing
    accounting: ACCOUNTING_DOC,
    costCap: COSTCAP_DOC,
  });
  // Still emits a well-formed status; conversion-derived booleans fall back to false.
  assert.equal(s.status, "single_instance_verified_control_loop");
  assert.equal(s.convertedUnresolvedToResolved, false);
  assert.equal(s.shapeGateAccepted, false);
  assert.equal(s.repairedPatchResolved, false);
  // recovery cost still recoverable from the accounting row.
  assert.equal(s.recoveryCostUsd, TOTAL_RECOVERY);
  // availability marked false for the missing report only.
  const conv = s.sourceReports.find((r) => r.name === SOURCE_CONVERSION);
  assert.equal(conv?.available, false);
  assert.ok(s.sourceReports.filter((r) => r.name !== SOURCE_CONVERSION).every((r) => r.available));
});

test("buildStatus: empty inputs do not throw and produce conservative defaults", () => {
  const s = buildStatus({
    generatedAt: "2026-06-12T00:00:00.000Z",
    protocol: null,
    probe: null,
    critic: null,
    conversion: null,
    accounting: null,
    costCap: null,
  });
  assert.equal(s.verifiedInstanceId, "unknown");
  assert.equal(s.sourceRunLabel, "unknown");
  assert.equal(s.leadPivot, "unknown");
  assert.equal(s.capsuleV2ContextValid, false);
  assert.equal(s.criticAgreement, false);
  assert.equal(s.recoveryCostUsd, null);
  assert.equal(s.aggregateComparable, false);
  assert.ok(s.sourceReports.every((r) => !r.available));
  // The evidence chain still renders (with default recovery-cost wording).
  assert.ok(s.evidenceChain.includes("recovery cost was about $3.0043."));
});

// ---------------------------------------------------------------------------
// 1/11. End-to-end: reads fixtures, writes its own status, mutates no source report.
// ---------------------------------------------------------------------------
test("run: reads source reports from fixtures and writes status JSON+MD only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cl-status-"));
  try {
    const results = await makeFixture(root);
    // capture source files to assert they are untouched.
    const before: Record<string, string> = {};
    for (const name of [SOURCE_PROTOCOL, SOURCE_CRITIC, SOURCE_CONVERSION, SOURCE_ACCOUNTING, SOURCE_COSTCAP]) {
      before[name] = await readFile(path.join(results, `${name}.json`), "utf8");
    }

    const status = await run(cfg(results));
    assert.equal(status.status, "single_instance_verified_control_loop");
    assert.equal(status.convertedUnresolvedToResolved, true);

    const writtenJson = await readFile(path.join(results, `${DEFAULT_OUT_NAME}.json`), "utf8");
    const writtenMd = await readFile(path.join(results, `${DEFAULT_OUT_NAME}.md`), "utf8");
    assert.ok(writtenJson.includes("single_instance_verified_control_loop"));
    assert.ok(writtenMd.includes("# Stage 5 control-loop status"));

    // 11. source reports unchanged (no Docker/model/agent/critic/repair side-effects).
    for (const [name, content] of Object.entries(before)) {
      assert.equal(await readFile(path.join(results, `${name}.json`), "utf8"), content, `${name} mutated`);
    }
    // only the two output files were added on top of the six source reports.
    const entries = (await readdir(results)).sort();
    assert.deepEqual(entries, [
      `${SOURCE_ACCOUNTING}.json`,
      `${SOURCE_CONVERSION}.json`,
      `${SOURCE_COSTCAP}.json`,
      `${SOURCE_CRITIC}.json`,
      `${SOURCE_PROBE}.json`,
      `${SOURCE_PROTOCOL}.json`,
      `${DEFAULT_OUT_NAME}.json`,
      `${DEFAULT_OUT_NAME}.md`,
    ].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run: completes when a source report is missing (graceful degradation, no throw)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cl-status-missing-"));
  try {
    const results = await makeFixture(root, { omit: [SOURCE_COSTCAP] });
    const status = await run(cfg(results));
    // costCap-derived field falls back to false; report still written.
    assert.equal(status.costCapHardened, false);
    assert.equal(status.sourceReports.find((r) => r.name === SOURCE_COSTCAP)?.available, false);
    const md = await readFile(path.join(results, `${DEFAULT_OUT_NAME}.md`), "utf8");
    assert.ok(md.includes("Source reports unavailable"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
