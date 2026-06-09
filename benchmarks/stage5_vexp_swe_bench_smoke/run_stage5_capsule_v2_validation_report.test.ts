import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  NON_CLAIMS,
  REPORT_SCOPE,
  aggregateMetrics,
  buildPivotInspection,
  buildReport,
  checklistVsToolsAgreement,
  extractCapsuleMeta,
  extractCapsulePivots,
  extractOrderedToolCalls,
  hiddenPivotCountsFor,
  loadPair,
  readOrderedToolCallLog,
  parseLabelMap,
  parseSweBenchRow,
  pairReductions,
  parseReportArgs,
  reductionPct,
  renderCsv,
  renderJson,
  renderMarkdown,
  snapshotHasEditRiskDirective,
  snapshotHasPivotCheck,
  totalTokens,
  type SweBenchRow,
  type ValidationPair,
} from "./run_stage5_capsule_v2_validation_report";
import type { PivotInspectionRecord } from "../../src/capsule/finalEditDiagnostics";

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

function makeRow(overrides: Partial<SweBenchRow> = {}): SweBenchRow {
  return {
    instanceId: "django__django-10880",
    resolved: true,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 1,
    durationMs: 1000,
    commitHash: "abc123",
    model: "claude-opus-4-5-20251101",
    agent: "claude-code",
    ...overrides,
  };
}

// Mirrors the real expected values so the test doubles as a regression guard
// on the math.
const EXPECTED = {
  "django__django-10880": { baseTok: 432600, capTok: 385653, baseCost: 0.20882475, capCost: 0.18072675, baseDur: 45190, capDur: 33168 },
  "django__django-11095": { baseTok: 535997, capTok: 646809, baseCost: 0.22295474999999998, capCost: 0.27222250000000003, baseDur: 43486, capDur: 57775 },
  "django__django-11490": { baseTok: 4661640, capTok: 1088993, baseCost: 1.6255705, capCost: 0.49748925000000005, baseDur: 335316, capDur: 127525 },
  "django__django-11728": { baseTok: 1716132, capTok: 909044, baseCost: 0.7335555000000001, capCost: 0.4382019999999999, baseDur: 150789, capDur: 116001 },
  "django__django-11740": { baseTok: 2387415, capTok: 697287, baseCost: 0.9118657499999999, capCost: 0.2919255, baseDur: 123844, capDur: 53158 },
} as const;

function pairFor(instanceId: keyof typeof EXPECTED): ValidationPair {
  const e = EXPECTED[instanceId];
  return {
    instanceId,
    baselineLabel: `eval-${instanceId.split("-").pop()}`,
    capsuleLabel: `eval-capsulev2-risk5-${instanceId.split("-").pop()}`,
    baseline: makeRow({ instanceId, inputTokens: e.baseTok, outputTokens: 0, costUsd: e.baseCost, durationMs: e.baseDur, resolved: true }),
    capsule: makeRow({ instanceId, inputTokens: e.capTok, outputTokens: 0, costUsd: e.capCost, durationMs: e.capDur, resolved: true }),
    capsuleMeta: {
      engine: "v2",
      intent: "debug",
      budget: 8000,
      estimatedTokens: 489,
      actualMode: "standard",
      topPivotFile: "django/db/models/query.py",
      topPivotSymbol: "count",
      topPivotHasSource: true,
      pivotSourceChars: 410,
      pivotSourceMode: "full",
      contextPolicyOverride: "force-inject",
      policyReason: "context policy forced to inject for validation",
      treatmentValid: true,
      injectionObserved: true,
      freshWorkspace: true,
      indexStartedAt: "2026-06-07T10:47:40.179Z",
      indexFinishedAt: "2026-06-07T11:12:43.139Z",
      indexDurationMs: 1502960,
      snapshotPath: `/runs/${instanceId}/_vtrace_instructions.snapshot.md`,
      snapshotSha256: "dde84da62e6f1c3f2a4e8657a759cbf0e782f91ea4209f8162456b172226badc",
      snapshotExists: true,
      editRiskDirectivePresent: instanceId === "django__django-11490",
      pivotCheckInjected: false,
    },
  };
}

function allPairs(): ValidationPair[] {
  return (Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]).map(pairFor);
}

// --------------------------------------------------------------------------
// Label-map loading
// --------------------------------------------------------------------------

test("parseLabelMap loads a valid mapping", () => {
  const map = parseLabelMap(
    JSON.stringify({ "django__django-10880": ["eval-10880", "eval-capsulev2-risk5-10880"] }),
  );
  assert.deepEqual(map["django__django-10880"], ["eval-10880", "eval-capsulev2-risk5-10880"]);
});

test("parseLabelMap rejects non-JSON", () => {
  assert.throws(() => parseLabelMap("{not json"), /not valid JSON/);
});

test("parseLabelMap rejects a non-object top level", () => {
  assert.throws(() => parseLabelMap("[]"), /must be a JSON object/);
});

test("parseLabelMap rejects a non-pair value", () => {
  assert.throws(() => parseLabelMap(JSON.stringify({ x: ["only-one"] })), /\[baselineLabel, capsuleLabel\] pair/);
});

test("parseLabelMap rejects an empty baseline label", () => {
  assert.throws(() => parseLabelMap(JSON.stringify({ x: ["", "cap"] })), /invalid baseline label/);
});

test("parseLabelMap rejects an empty capsule label", () => {
  assert.throws(() => parseLabelMap(JSON.stringify({ x: ["base", ""] })), /invalid capsule label/);
});

test("parseLabelMap rejects an empty map", () => {
  assert.throws(() => parseLabelMap("{}"), /empty/);
});

// --------------------------------------------------------------------------
// Token / reduction math
// --------------------------------------------------------------------------

test("totalTokens sums the four token components", () => {
  assert.equal(
    totalTokens({ inputTokens: 111, outputTokens: 29, cacheReadTokens: 397486, cacheCreationTokens: 34974 }),
    432600,
  );
});

test("reductionPct computes percentage reduction", () => {
  assert.equal(Number(reductionPct(432600, 385653).toFixed(2)), 10.85);
});

test("reductionPct returns 0 when baseline is 0", () => {
  assert.equal(reductionPct(0, 5), 0);
});

test("pairReductions computes per-task token, cost, and duration reductions", () => {
  const r = pairReductions(
    makeRow({ inputTokens: 432600, outputTokens: 0, costUsd: 0.20882475, durationMs: 45190 }),
    makeRow({ inputTokens: 385653, outputTokens: 0, costUsd: 0.18072675, durationMs: 33168 }),
  );
  assert.equal(Number(r.tokenReductionPct.toFixed(2)), 10.85);
  assert.equal(Number(r.costReductionPct.toFixed(2)), 13.46);
  assert.equal(Number(r.durationReductionPct.toFixed(2)), 26.6);
});

// --------------------------------------------------------------------------
// Aggregation
// --------------------------------------------------------------------------

test("aggregateMetrics matches the expected five-task aggregate", () => {
  const a = aggregateMetrics(allPairs());
  assert.equal(a.instanceCount, 5);
  assert.equal(a.resolvedBaseline, 5);
  assert.equal(a.resolvedCapsule, 5);
  assert.equal(Number(a.meanPerTaskTokenReductionPct.toFixed(2)), 36.93);
  assert.equal(Number(a.pooledTokenReductionPct.toFixed(2)), 61.7);
  assert.equal(Number(a.pooledCostReductionPct.toFixed(2)), 54.61);
  assert.equal(Number(a.pooledDurationReductionPct.toFixed(2)), 44.52);
});

test("aggregateMetrics counts resolved correctly when some are unresolved", () => {
  const pairs = allPairs();
  pairs[0]!.capsule.resolved = false;
  pairs[1]!.baseline.resolved = null;
  const a = aggregateMetrics(pairs);
  assert.equal(a.resolvedBaseline, 4);
  assert.equal(a.resolvedCapsule, 4);
});

// --------------------------------------------------------------------------
// Capsule v2 metadata extraction
// --------------------------------------------------------------------------

const SNAPSHOT_WITH_RISK = `# vtrace indexed context

## Edit risk / patch hint

This pivot mutates shared state under a guard.
`;

const SNAPSHOT_NO_RISK = `# vtrace indexed context

## Instruction

Use the vtrace context above.
`;

test("extractCapsuleMeta pulls Capsule v2 fields from _run.meta.json", () => {
  const runMeta = {
    vtraceCapsuleEngine: "v2",
    vtraceCapsuleIntent: "debug",
    vtraceCapsuleBudget: 8000,
    vtraceCapsuleEstimatedTokens: 489,
    vtraceCapsuleActualMode: "standard",
    vtraceCapsuleTopPivotFile: "django/db/models/query.py",
    vtraceCapsuleTopPivotSymbol: "count",
    vtraceCapsuleTopPivotHasSource: true,
    vtraceCapsulePivotSourceChars: 410,
    vtraceCapsulePivotSourceMode: "full",
    vtraceContextPolicyOverride: "force-inject",
    vtracePolicyReason: "context policy forced to inject for validation",
    vtraceTreatmentValid: true,
    vtraceInjectionObserved: true,
    freshWorkspace: true,
    vtraceIndexStartedAt: "2026-06-07T10:47:40.179Z",
    vtraceIndexFinishedAt: "2026-06-07T11:12:43.139Z",
    vtraceIndexDurationMs: 1502960,
    vtraceInstructionsSnapshotFile: "/runs/x/_vtrace_instructions.snapshot.md",
    vtraceInstructionsSha256: "deadbeef",
  };
  const m = extractCapsuleMeta(runMeta, SNAPSHOT_NO_RISK);
  assert.equal(m.engine, "v2");
  assert.equal(m.intent, "debug");
  assert.equal(m.budget, 8000);
  assert.equal(m.topPivotFile, "django/db/models/query.py");
  assert.equal(m.topPivotSymbol, "count");
  assert.equal(m.topPivotHasSource, true);
  assert.equal(m.pivotSourceChars, 410);
  assert.equal(m.pivotSourceMode, "full");
  assert.equal(m.contextPolicyOverride, "force-inject");
  assert.equal(m.snapshotPath, "/runs/x/_vtrace_instructions.snapshot.md");
  assert.equal(m.snapshotSha256, "deadbeef");
  assert.equal(m.snapshotExists, true);
  assert.equal(m.editRiskDirectivePresent, false);
});

test("extractCapsuleMeta degrades missing fields to null", () => {
  const m = extractCapsuleMeta({}, null);
  assert.equal(m.engine, null);
  assert.equal(m.budget, null);
  assert.equal(m.snapshotExists, false);
  assert.equal(m.editRiskDirectivePresent, false);
});

test("snapshotHasEditRiskDirective detects the edit-risk section", () => {
  assert.equal(snapshotHasEditRiskDirective(SNAPSHOT_WITH_RISK), true);
  assert.equal(snapshotHasEditRiskDirective(SNAPSHOT_NO_RISK), false);
  assert.equal(snapshotHasEditRiskDirective(null), false);
});

test("parseSweBenchRow leaves resolved null when absent", () => {
  const row = parseSweBenchRow({ instanceId: "x", inputTokens: 5 });
  assert.equal(row.resolved, null);
  assert.equal(row.inputTokens, 5);
  assert.equal(row.costUsd, 0);
});

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

function fullReport() {
  const pairs = allPairs();
  return {
    generatedAt: "2026-06-07T17:00:00.000Z",
    scope: REPORT_SCOPE,
    protocol: "test-protocol",
    instanceSet: pairs.map((p) => p.instanceId),
    pairs,
    aggregate: aggregateMetrics(pairs),
    nonClaims: [...NON_CLAIMS],
  };
}

test("renderMarkdown includes all required sections", () => {
  const md = renderMarkdown(fullReport());
  for (const heading of [
    "## Scope",
    "## Protocol",
    "## Instance set",
    "## Fresh-index evidence",
    "## Capsule v2 metadata",
    "## PIVOT_CHECK enforcement",
    "## Resolution",
    "## Token / cost / duration comparison",
    "## Aggregate metrics",
    "## Caveats / non-claims",
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
});

test("renderMarkdown reports the expected aggregate numbers", () => {
  const md = renderMarkdown(fullReport());
  assert.ok(md.includes("Resolved baseline: 5/5"));
  assert.ok(md.includes("Resolved capsule-v2: 5/5"));
  assert.ok(md.includes("Mean per-task token reduction: 36.93%"));
  assert.ok(md.includes("Pooled token reduction: 61.70%"));
  assert.ok(md.includes("Pooled cost reduction: 54.61%"));
  assert.ok(md.includes("Pooled duration reduction: 44.52%"));
});

test("renderMarkdown includes every non-claim verbatim", () => {
  const md = renderMarkdown(fullReport());
  for (const claim of NON_CLAIMS) assert.ok(md.includes(claim), `missing non-claim: ${claim}`);
});

test("renderMarkdown surfaces capsule v2 metadata and snapshot SHA/path", () => {
  const md = renderMarkdown(fullReport());
  assert.ok(md.includes("django/db/models/query.py"));
  assert.ok(md.includes("dde84da62e6f1c3f2a4e8657a759cbf0e782f91ea4209f8162456b172226badc"));
  assert.ok(md.includes("_vtrace_instructions.snapshot.md"));
  // edit-risk directive presence shown (11490 = yes)
  assert.ok(/django__django-11490 \|.*\| yes \|/.test(md) || md.includes("yes"));
});

test("renderJson is valid JSON carrying aggregate, non-claims, and per-instance meta", () => {
  const parsed = JSON.parse(renderJson(fullReport()));
  assert.equal(parsed.aggregate.resolvedBaseline, 5);
  assert.equal(parsed.instances.length, 5);
  assert.equal(parsed.instances[0].capsuleMeta.engine, "v2");
  assert.deepEqual(parsed.nonClaims, [...NON_CLAIMS]);
});

test("renderCsv has a header plus one row per instance with snapshot SHA", () => {
  const csv = renderCsv(fullReport());
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 6); // header + 5
  assert.ok(lines[0]!.includes("token_reduction_pct"));
  assert.ok(lines[0]!.includes("snapshot_sha256"));
  assert.ok(lines[1]!.includes("django__django-10880"));
});

// --------------------------------------------------------------------------
// IO: loadPair / buildReport against a synthetic run tree
// --------------------------------------------------------------------------

async function writeJsonl(dir: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "swebench-2026-06-07.jsonl"), `${JSON.stringify(record)}\n`);
}

async function buildRunTree(root: string): Promise<void> {
  // baseline label dir with a baseline condition
  const baseDir = path.join(root, "eval-10880", "raw", "baseline");
  await writeJsonl(baseDir, {
    instanceId: "django__django-10880",
    resolved: true,
    inputTokens: 111,
    outputTokens: 29,
    cacheReadTokens: 397486,
    cacheCreationTokens: 34974,
    costUsd: 0.20882475,
    durationMs: 45190,
    commitHash: "838e432e",
  });

  // capsule label dir with a vtrace condition + meta + snapshot
  const capDir = path.join(root, "eval-capsulev2-risk5-10880", "raw", "vtrace");
  await writeJsonl(capDir, {
    instanceId: "django__django-10880",
    resolved: true,
    inputTokens: 97,
    outputTokens: 25,
    cacheReadTokens: 350184,
    cacheCreationTokens: 35347,
    costUsd: 0.18072675,
    durationMs: 33168,
    commitHash: "838e432e",
  });
  await writeFile(
    path.join(capDir, "_run.meta.json"),
    JSON.stringify({
      vtraceCapsuleEngine: "v2",
      vtraceCapsuleIntent: "debug",
      vtraceCapsuleBudget: 8000,
      vtraceCapsuleTopPivotFile: "django/db/models/query.py",
      vtraceCapsuleTopPivotSymbol: "count",
      vtraceCapsuleTopPivotHasSource: true,
      vtraceContextPolicyOverride: "force-inject",
      vtraceTreatmentValid: true,
      vtraceInstructionsSnapshotFile: path.join(root, "eval-capsulev2-risk5-10880", "_vtrace_instructions.snapshot.md"),
      vtraceInstructionsSha256: "deadbeef",
    }),
  );
  await writeFile(path.join(capDir, "_eval.meta.json"), JSON.stringify({ resolvedCount: 1 }));
  await writeFile(
    path.join(root, "eval-capsulev2-risk5-10880", "_vtrace_instructions.snapshot.md"),
    SNAPSHOT_NO_RISK,
  );
}

test("loadPair reads baseline + capsule rows and metadata from disk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stage5-cap-"));
  await buildRunTree(root);
  const pair = await loadPair(
    "django__django-10880",
    ["eval-10880", "eval-capsulev2-risk5-10880"],
    { runsDir: root },
  );
  assert.equal(totalTokens(pair.baseline), 432600);
  assert.equal(totalTokens(pair.capsule), 385653);
  assert.equal(pair.baseline.resolved, true);
  assert.equal(pair.capsule.resolved, true);
  assert.equal(pair.capsuleMeta.engine, "v2");
  assert.equal(pair.capsuleMeta.snapshotSha256, "deadbeef");
  assert.equal(pair.capsuleMeta.snapshotExists, true);
});

test("loadPair throws a clear error for a missing baseline row", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stage5-cap-"));
  await buildRunTree(root);
  await assert.rejects(
    loadPair("django__django-10880", ["eval-MISSING", "eval-capsulev2-risk5-10880"], { runsDir: root }),
    /Missing baseline row for django__django-10880/,
  );
});

test("loadPair throws a clear error for a missing vtrace/capsule row", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stage5-cap-"));
  await buildRunTree(root);
  await assert.rejects(
    loadPair("django__django-10880", ["eval-10880", "eval-MISSING"], { runsDir: root }),
    /Missing vtrace\/capsule row for django__django-10880/,
  );
});

test("loadPair falls back to eval-meta resolvedCount when JSONL omits resolved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stage5-cap-"));
  await buildRunTree(root);
  // overwrite capsule jsonl without `resolved`
  await writeJsonl(path.join(root, "eval-capsulev2-risk5-10880", "raw", "vtrace"), {
    instanceId: "django__django-10880",
    inputTokens: 97,
    outputTokens: 25,
    cacheReadTokens: 350184,
    cacheCreationTokens: 35347,
    costUsd: 0.18072675,
    durationMs: 33168,
  });
  const pair = await loadPair(
    "django__django-10880",
    ["eval-10880", "eval-capsulev2-risk5-10880"],
    { runsDir: root },
  );
  assert.equal(pair.capsule.resolved, true); // from resolvedCount: 1
});

test("buildReport assembles a full report from disk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stage5-cap-"));
  await buildRunTree(root);
  const report = await buildReport(
    { "django__django-10880": ["eval-10880", "eval-capsulev2-risk5-10880"] },
    { runsDir: root },
    "2026-06-07T17:00:00.000Z",
  );
  assert.equal(report.scope, REPORT_SCOPE);
  assert.equal(report.pairs.length, 1);
  assert.equal(report.aggregate.resolvedBaseline, 1);
  assert.deepEqual(report.nonClaims, [...NON_CLAIMS]);
});

// --------------------------------------------------------------------------
// CLI arg parsing
// --------------------------------------------------------------------------

test("parseReportArgs reads label-map and out overrides", () => {
  const cfg = parseReportArgs(["--label-map", "/tmp/lm.json", "--out", "/tmp/out", "--runs-dir", "/tmp/runs"]);
  assert.equal(cfg.labelMapPath, "/tmp/lm.json");
  assert.equal(cfg.outDir, "/tmp/out");
  assert.equal(cfg.runsDir, "/tmp/runs");
});

test("parseReportArgs rejects unknown args", () => {
  assert.throws(() => parseReportArgs(["--nope"]), /Unknown argument/);
});

test("parseReportArgs allows overriding condition subdirs", () => {
  const cfg = parseReportArgs(["--baseline-condition", "b2", "--capsule-condition", "c2"]);
  assert.equal(cfg.baselineCondition, "b2");
  assert.equal(cfg.capsuleCondition, "c2");
});

// --------------------------------------------------------------------------
// Pivot inspection wiring
// --------------------------------------------------------------------------

// The sphinx-7462 force-inject run, reduced to the fields the wiring reads.
const SPHINX_RUN_META = {
  vtraceCapsulePivots: [
    {
      path: "sphinx/domains/python.py",
      symbol: "_parse_annotation",
      roleReason: "source line anchor in the issue points at this symbol — explicit edit site",
    },
    {
      path: "sphinx/pycode/ast.py",
      symbol: "unparse",
      roleReason: "actionable function — exercised by a failing test; symbol-name match; 9 dependents",
    },
  ],
  vtraceCapsuleSupport: [
    { path: "sphinx/domains/python.py", symbol: "_parse_arglist", roleReason: "strong target beyond the pivot budget" },
  ],
};

// The agent edited only the traceback-named file (python.py), skipping the hidden
// pivot (ast.py). toolCalls is the aggregate count object SWE-bench emits.
const SPHINX_RESULT = {
  modelPatch:
    "diff --git a/sphinx/domains/python.py b/sphinx/domains/python.py\n" +
    "--- a/sphinx/domains/python.py\n+++ b/sphinx/domains/python.py\n" +
    "@@ -110,0 +111,1 @@ def _parse_annotation(annotation):\n+    pass\n",
  toolCalls: { Read: 2, Edit: 2, Bash: 3 },
};

test("extractCapsulePivots flags the non-source-anchored pivot as hidden", () => {
  const pivots = extractCapsulePivots(SPHINX_RUN_META);
  assert.equal(pivots.length, 3);
  const ast = pivots.find((p) => p.path === "sphinx/pycode/ast.py");
  const python = pivots.find((p) => p.path === "sphinx/domains/python.py" && p.role === "pivot");
  assert.equal(ast?.hidden, true);
  assert.equal(python?.hidden, false);
  // Support items are never flagged as hidden pivots.
  assert.equal(pivots.find((p) => p.role === "support")?.hidden, false);
});

test("extractOrderedToolCalls treats an aggregate count object as no ordered log", () => {
  assert.deepEqual(extractOrderedToolCalls({ toolCalls: { Read: 2, Edit: 2 } }), {
    calls: [],
    ordered: false,
  });
  // An actual ordered list is parsed into {tool,target} entries.
  const ordered = extractOrderedToolCalls({
    toolCalls: [{ name: "Read", input: { file_path: "sphinx/pycode/ast.py" } }],
  });
  assert.equal(ordered.ordered, true);
  assert.equal(ordered.calls[0]?.target, "sphinx/pycode/ast.py");
});

test("buildPivotInspection reproduces the sphinx-7462 hidden-pivot statement", () => {
  const { records, toolLogOrdered } = buildPivotInspection(SPHINX_RUN_META, SPHINX_RESULT);
  // Aggregate-only tool counts => no ordered log.
  assert.equal(toolLogOrdered, false);

  const ast = records.find((r) => r.path === "sphinx/pycode/ast.py");
  assert.ok(ast);
  // hidden pivot sphinx/pycode/ast.py::unparse — inspected: no, edited: no, ignored.
  assert.equal(ast.hidden, true);
  assert.equal(ast.inspected, false);
  assert.equal(ast.edited, false);
  assert.equal(ast.status, "ignored");

  // The traceback-named pivot was the one edited.
  const python = records.find((r) => r.path === "sphinx/domains/python.py" && r.role === "pivot");
  assert.equal(python?.edited, true);
  // No prior ordered read could be observed, so it reads as edited-without-inspection.
  assert.equal(python?.status, "edited_without_inspection");
});

test("buildPivotInspection degrades to patch-only when the record is missing", () => {
  const { records, toolLogOrdered } = buildPivotInspection(SPHINX_RUN_META, null);
  assert.equal(toolLogOrdered, null);
  assert.equal(records.length, 3);
  assert.ok(records.every((r) => r.edited === false && r.status === "ignored"));
});

// --------------------------------------------------------------------------
// PIVOT_CHECK enforcement metrics
// --------------------------------------------------------------------------

// Build a hidden-pivot inspection record with explicit outcome flags.
function hiddenRecord(overrides: Partial<PivotInspectionRecord>): PivotInspectionRecord {
  return {
    path: "p.py",
    symbol: "f",
    role: "pivot",
    hidden: true,
    discovered: false,
    inspected: false,
    edited: false,
    edited_without_inspection: false,
    ruled_out: false,
    status: "ignored",
    ...overrides,
  };
}

test("hiddenPivotCountsFor distinguishes discovered-only / inspected / edited / ignored hidden pivots", () => {
  const records: PivotInspectionRecord[] = [
    // discovered-only: seen in search, never read, never edited → ignored + discoveredOnly.
    hiddenRecord({ path: "a.py", discovered: true, status: "ignored" }),
    // plainly ignored: never seen, never read, never edited → ignored, NOT discoveredOnly.
    hiddenRecord({ path: "b.py", status: "ignored" }),
    // inspected: direct read.
    hiddenRecord({ path: "c.py", inspected: true, status: "inspected" }),
    // edited.
    hiddenRecord({ path: "d.py", edited: true, status: "edited" }),
    // a NON-hidden pivot is never counted, whatever its status.
    hiddenRecord({ path: "e.py", hidden: false, inspected: true, status: "inspected" }),
  ];
  const counts = hiddenPivotCountsFor(records);
  assert.equal(counts.ignored, 2);
  assert.equal(counts.discoveredOnly, 1);
  assert.equal(counts.inspected, 1);
  assert.equal(counts.edited, 1);
});

test("hiddenPivotCountsFor returns zeros for missing/empty records", () => {
  assert.deepEqual(hiddenPivotCountsFor(undefined), { ignored: 0, discoveredOnly: 0, inspected: 0, edited: 0 });
  assert.deepEqual(hiddenPivotCountsFor([]), { ignored: 0, discoveredOnly: 0, inspected: 0, edited: 0 });
});

test("checklistVsToolsAgreement is null unless a checklist was emitted AND an ordered log exists", () => {
  const inspected = [hiddenRecord({ inspected: true, status: "inspected" })];
  // No claim → null.
  assert.equal(checklistVsToolsAgreement(null, true, inspected), null);
  assert.equal(checklistVsToolsAgreement(false, true, inspected), null);
  // Claim but no ordered log to verify against → null.
  assert.equal(checklistVsToolsAgreement(true, false, inspected), null);
  assert.equal(checklistVsToolsAgreement(true, null, inspected), null);
});

test("checklistVsToolsAgreement corroborates the claim against hidden-pivot tool evidence", () => {
  // Emitted + ordered + every hidden pivot inspected/edited → agreement true.
  assert.equal(
    checklistVsToolsAgreement(true, true, [hiddenRecord({ inspected: true }), hiddenRecord({ edited: true })]),
    true,
  );
  // Emitted + ordered but a hidden pivot was only ignored → disagreement.
  assert.equal(
    checklistVsToolsAgreement(true, true, [hiddenRecord({ inspected: true }), hiddenRecord({ status: "ignored" })]),
    false,
  );
  // No hidden pivots to verify → vacuously true.
  assert.equal(checklistVsToolsAgreement(true, true, []), true);
});

test("snapshotHasPivotCheck detects the PIVOT_CHECK block in an injected snapshot", () => {
  assert.equal(snapshotHasPivotCheck("# vtrace indexed context\n\n## PIVOT_CHECK\n| pivot |"), true);
  assert.equal(snapshotHasPivotCheck("# vtrace indexed context\n\n## vtrace context\n"), false);
  assert.equal(snapshotHasPivotCheck(null), false);
});

test("extractCapsuleMeta records whether a PIVOT_CHECK block was injected", () => {
  assert.equal(extractCapsuleMeta({}, "## PIVOT_CHECK\n...").pivotCheckInjected, true);
  assert.equal(extractCapsuleMeta({}, "no checklist here").pivotCheckInjected, false);
  assert.equal(extractCapsuleMeta({}, null).pivotCheckInjected, false);
});

test("aggregateMetrics pools hidden-pivot conversion and checklist counts", () => {
  const pairs = allPairs();
  pairs[0]!.pivotInspection = [
    hiddenRecord({ path: "a.py", discovered: true, status: "ignored" }),
    hiddenRecord({ path: "b.py", inspected: true, status: "inspected" }),
  ];
  pairs[0]!.hiddenPivotCounts = hiddenPivotCountsFor(pairs[0]!.pivotInspection);
  pairs[0]!.checklistEmitted = true;
  pairs[0]!.checklistVsToolsAgreement = false;
  pairs[1]!.pivotInspection = [hiddenRecord({ path: "c.py", edited: true, status: "edited" })];
  pairs[1]!.hiddenPivotCounts = hiddenPivotCountsFor(pairs[1]!.pivotInspection);
  pairs[1]!.checklistEmitted = true;
  pairs[1]!.checklistVsToolsAgreement = true;

  const a = aggregateMetrics(pairs);
  assert.equal(a.hiddenPivotsIgnored, 1);
  assert.equal(a.hiddenPivotsDiscoveredOnly, 1);
  assert.equal(a.hiddenPivotsInspected, 1);
  assert.equal(a.hiddenPivotsEdited, 1);
  assert.equal(a.checklistEmittedRuns, 2);
  assert.equal(a.checklistVsToolsAgreementRuns, 1);
});

// --------------------------------------------------------------------------
// Ordered tool-call log: loading + wiring into pivot inspection
// --------------------------------------------------------------------------

// A persisted _tool_calls.json: the agent grepped (surfacing ast.py in output),
// directly read ast.py, then edited python.py.
const TOOL_CALL_LOG = [
  { index: 0, tool: "Grep", category: "search", path: null, query: "unparse", output_summary: "sphinx/pycode/ast.py:42" },
  { index: 1, tool: "Read", category: "read", path: "sphinx/pycode/ast.py", query: null, output_summary: "def unparse(node):" },
  { index: 2, tool: "Edit", category: "edit", path: "sphinx/domains/python.py", query: null, output_summary: null },
];

test("1. readOrderedToolCallLog loads the ordered log from run artifacts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage5-tcl-"));
  await writeFile(path.join(dir, "_tool_calls.json"), JSON.stringify(TOOL_CALL_LOG));
  const calls = await readOrderedToolCallLog(dir);
  assert.ok(calls);
  assert.equal(calls!.length, 3);
  assert.equal(calls![1]!.target, "sphinx/pycode/ast.py");
});

test("4. missing tool-call log sets pivotInspectionToolLogOrdered=false", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage5-tcl-"));
  assert.equal(await readOrderedToolCallLog(dir), null);
  // With no ordered log and an aggregate-only record, the flag is false.
  const result = buildPivotInspection(SPHINX_RUN_META, SPHINX_RESULT, null);
  assert.equal(result.toolLogOrdered, false);
});

test("5. buildPivotInspection uses real ordered calls when available", () => {
  const calls = TOOL_CALL_LOG.map((c) => ({
    tool: c.tool,
    target: c.path,
    output: c.output_summary ?? c.query,
  }));
  const { records, toolLogOrdered } = buildPivotInspection(SPHINX_RUN_META, SPHINX_RESULT, calls);
  assert.equal(toolLogOrdered, true);
  const ast = records.find((r) => r.path === "sphinx/pycode/ast.py");
  // With an ordered log we can now SEE the direct read — no longer false-by-absence.
  assert.equal(ast?.inspected, true);
  assert.equal(ast?.status, "inspected");
});

test("loadPair wires _tool_calls.json into pivot inspection (ordered log distinguishes inspected)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stage5-cap-tcl-"));
  await buildRunTree(root);
  const capDir = path.join(root, "eval-capsulev2-risk5-10880", "raw", "vtrace");
  // Re-point the run meta's pivots at the sphinx hidden pivot so the wiring is visible.
  await writeFile(
    path.join(capDir, "_run.meta.json"),
    JSON.stringify({
      vtraceCapsuleEngine: "v2",
      vtraceCapsulePivots: SPHINX_RUN_META.vtraceCapsulePivots,
    }),
  );
  await writeFile(path.join(capDir, "_tool_calls.json"), JSON.stringify(TOOL_CALL_LOG));

  const pair = await loadPair(
    "django__django-10880",
    ["eval-10880", "eval-capsulev2-risk5-10880"],
    { runsDir: root },
  );
  assert.equal(pair.pivotInspectionToolLogOrdered, true);
  const ast = pair.pivotInspection?.find((r) => r.path === "sphinx/pycode/ast.py");
  assert.equal(ast?.inspected, true);
});

test("loadPair keeps false-by-absence when no _tool_calls.json is present", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stage5-cap-notcl-"));
  await buildRunTree(root);
  const pair = await loadPair(
    "django__django-10880",
    ["eval-10880", "eval-capsulev2-risk5-10880"],
    { runsDir: root },
  );
  // No ordered log written => aggregate fallback => ordered:false (honest).
  assert.equal(pair.pivotInspectionToolLogOrdered, false);
  // No _tool_calls.json must not crash; checklist/hidden metrics still resolve.
  assert.ok(pair.hiddenPivotCounts);
  // No vtracePivotChecklistEmitted in meta → null (unobservable), not a crash.
  assert.equal(pair.checklistEmitted, null);
  assert.equal(pair.checklistVsToolsAgreement, null);
});

test("loadPair reads checklist emission + PIVOT_CHECK injection from run artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stage5-cap-checklist-"));
  await buildRunTree(root);
  const capLabelDir = path.join(root, "eval-capsulev2-risk5-10880");
  const capDir = path.join(capLabelDir, "raw", "vtrace");
  // Re-point at the sphinx hidden pivot, record that the agent emitted a checklist,
  // and write an ordered log showing the hidden pivot WAS directly read.
  await writeFile(
    path.join(capDir, "_run.meta.json"),
    JSON.stringify({
      vtraceCapsuleEngine: "v2",
      vtraceCapsulePivots: SPHINX_RUN_META.vtraceCapsulePivots,
      vtracePivotChecklistEmitted: true,
      vtraceInstructionsSnapshotFile: path.join(capLabelDir, "_vtrace_instructions.snapshot.md"),
    }),
  );
  await writeFile(path.join(capDir, "_tool_calls.json"), JSON.stringify(TOOL_CALL_LOG));
  await writeFile(
    path.join(capLabelDir, "_vtrace_instructions.snapshot.md"),
    "# vtrace indexed context\n\n## PIVOT_CHECK\n| pivot | symbol | inspected |\n",
  );

  const pair = await loadPair(
    "django__django-10880",
    ["eval-10880", "eval-capsulev2-risk5-10880"],
    { runsDir: root },
  );
  assert.equal(pair.capsuleMeta.pivotCheckInjected, true);
  assert.equal(pair.checklistEmitted, true);
  // The ordered log shows ast.py was read → hidden pivot inspected, agreement true.
  assert.equal(pair.hiddenPivotCounts?.inspected, 1);
  assert.equal(pair.checklistVsToolsAgreement, true);
});
