import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  aggregate,
  buildArtifact,
  buildInstanceRow,
  computeTokens,
  extractAutoPolicy,
  loadLabelMap,
  parseArgs,
  readRunRecord,
  reduction,
  renderCsv,
  renderInterpretationLines,
  renderMarkdown,
  runAutoPolicyEval,
  writeReports,
  type AutoPolicyLabelEntry,
  type InstanceRow,
  type RunRecord,
} from "./run_stage5_capsule_v2_auto_policy_eval";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The five recorded instances, reduced to the numbers this report depends on.
// Mirrors the real Stage 5 artifacts so the synthetic end-to-end run reproduces
// the manual comparison exactly.
const RECORDED: Array<{
  id: string;
  baselineTok: number;
  forceTok: number;
  autoTok: number;
  baselineCost: number;
  forceCost: number;
  autoCost: number;
  baselineDur: number;
  forceDur: number;
  autoDur: number;
  autoAction: "inject" | "no_context";
}> = [
  { id: "django__django-10880", baselineTok: 432600, forceTok: 385653, autoTok: 753097, baselineCost: 1, forceCost: 0.9, autoCost: 1.7, baselineDur: 100, forceDur: 90, autoDur: 170, autoAction: "no_context" },
  { id: "django__django-11095", baselineTok: 535997, forceTok: 646809, autoTok: 665993, baselineCost: 1, forceCost: 1.2, autoCost: 1.25, baselineDur: 100, forceDur: 120, autoDur: 125, autoAction: "no_context" },
  { id: "django__django-11490", baselineTok: 4661640, forceTok: 1088993, autoTok: 1610878, baselineCost: 1.6256, forceCost: 0.4975, autoCost: 0.6387, baselineDur: 335316, forceDur: 127525, autoDur: 166568, autoAction: "inject" },
  { id: "django__django-11728", baselineTok: 1716132, forceTok: 909044, autoTok: 1373090, baselineCost: 0.6, forceCost: 0.32, autoCost: 0.49, baselineDur: 200000, forceDur: 105000, autoDur: 160000, autoAction: "inject" },
  { id: "django__django-11740", baselineTok: 2387415, forceTok: 697287, autoTok: 2074004, baselineCost: 0.85, forceCost: 0.25, autoCost: 0.74, baselineDur: 250000, forceDur: 75000, autoDur: 220000, autoAction: "inject" },
];

function shortId(id: string): string {
  return id.split("-").pop()!;
}

function jsonlRow(id: string, tokens: number, costUsd: number, durationMs: number, resolved: boolean): string {
  // Split the token total across the four buckets so computeTokens() reconstructs it.
  return JSON.stringify({
    instanceId: id,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: tokens - 300 - 50,
    cacheCreationTokens: 50,
    costUsd,
    durationMs,
    resolved,
  });
}

async function writeRun(runsRoot: string, label: string, condition: string, rowJson: string): Promise<void> {
  const dir = path.join(runsRoot, label, "raw", condition);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "swebench-2026-06-07.jsonl"), rowJson + "\n", "utf8");
}

async function buildRecordedTree(): Promise<{ root: string; runsRoot: string; labelMap: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-policy-eval-"));
  const runsRoot = path.join(root, "runs");
  const instances: AutoPolicyLabelEntry[] = [];
  for (const rec of RECORDED) {
    const sid = shortId(rec.id);
    const baselineLabel = `eval-${sid}`;
    const forceLabel = `eval-capsulev2-risk5-${sid}`;
    const autoLabel = `eval-capsulev2-auto-${sid}`;
    await writeRun(runsRoot, baselineLabel, "baseline", jsonlRow(rec.id, rec.baselineTok, rec.baselineCost, rec.baselineDur, true));
    await writeRun(runsRoot, forceLabel, "vtrace", jsonlRow(rec.id, rec.forceTok, rec.forceCost, rec.forceDur, true));
    await writeRun(runsRoot, autoLabel, "vtrace", jsonlRow(rec.id, rec.autoTok, rec.autoCost, rec.autoDur, true));
    await writeFile(
      path.join(runsRoot, autoLabel, "raw", "vtrace", "_run.meta.json"),
      JSON.stringify({
        vtraceContextPolicyAction: rec.autoAction,
        vtracePolicyReason: rec.autoAction === "inject" ? "High-value context." : "Small/local task.",
        expectedContextValue: rec.autoAction === "inject" ? "high" : "low",
        expectedOverheadRisk: rec.autoAction === "inject" ? "low" : "high",
        vtraceContextPolicyDecisionSignals: rec.autoAction === "inject" ? ["edit_risk_directive_present"] : ["micro_capsule"],
      }),
      "utf8",
    );
    instances.push({ instance_id: rec.id, baseline_label: baselineLabel, force_label: forceLabel, auto_label: autoLabel });
  }
  const labelMap = path.join(root, "labels.json");
  await writeFile(labelMap, JSON.stringify({ instances }), "utf8");
  return { root, runsRoot, labelMap };
}

function syntheticRow(over: Partial<InstanceRow> = {}): InstanceRow {
  const base: InstanceRow = {
    instance_id: "django__django-11490",
    baseline_label: "eval-11490",
    force_label: "eval-capsulev2-risk5-11490",
    auto_label: "eval-capsulev2-auto-11490",
    baseline_resolved: true,
    force_resolved: true,
    auto_resolved: true,
    baseline_tokens: 4661640,
    force_tokens: 1088993,
    auto_tokens: 1610878,
    force_token_reduction: 0.7664,
    auto_token_reduction: 0.6544,
    baseline_cost: 1.6256,
    force_cost: 0.4975,
    auto_cost: 0.6387,
    force_cost_reduction: 0.6939,
    auto_cost_reduction: 0.6071,
    baseline_duration_ms: 335316,
    force_duration_ms: 127525,
    auto_duration_ms: 166568,
    force_duration_reduction: 0.6197,
    auto_duration_reduction: 0.5033,
    auto_policy_action: "inject",
    auto_policy_reason: "High-value context.",
    auto_expected_context_value: "high",
    auto_expected_overhead_risk: "low",
    auto_decision_signals: ["edit_risk_directive_present"],
  };
  return { ...base, ...over };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("label map loading validates and returns entries", async () => {
  const map = await loadLabelMap(path.join(import.meta.dir, "capsule_v2_auto_policy_labels.json"));
  assert.equal(map.instances.length, 5);
  assert.equal(map.instances[0]!.instance_id, "django__django-10880");
  assert.equal(map.instances[0]!.baseline_label, "eval-10880");
  assert.equal(map.instances[0]!.force_label, "eval-capsulev2-risk5-10880");
  assert.equal(map.instances[0]!.auto_label, "eval-capsulev2-auto-10880");
});

test("label map loading rejects a malformed entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-policy-badmap-"));
  try {
    const bad = path.join(root, "bad.json");
    await writeFile(bad, JSON.stringify({ instances: [{ instance_id: "x", baseline_label: "b" }] }));
    await assert.rejects(loadLabelMap(bad), /missing a non-empty "force_label"/);
    await assert.rejects(loadLabelMap(path.join(root, "nope.json")), /not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing row handling throws a clear error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-policy-missing-"));
  try {
    const dir = path.join(root, "runs", "eval-x", "raw", "baseline");
    await mkdir(dir, { recursive: true });
    // A file present, but no row for the requested instance.
    await writeFile(path.join(dir, "swebench-2026-06-07.jsonl"), jsonlRow("other__instance-1", 1000, 1, 1, true) + "\n");
    await assert.rejects(
      readRunRecord(path.join(dir, "swebench-2026-06-07.jsonl"), "django__django-11490"),
      /No row for instance "django__django-11490"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("token calculation sums the four token buckets", () => {
  const record: RunRecord = {
    instanceId: "x",
    inputTokens: 755,
    outputTokens: 221,
    cacheReadTokens: 4554535,
    cacheCreationTokens: 106129,
    costUsd: 1.6256,
    durationMs: 335316,
    resolved: true,
  };
  assert.equal(computeTokens(record), 4661640);
});

test("per-instance reduction calculation matches the manual table", () => {
  // 11490: force 76.64%, auto 65.44%.
  assert.equal(reduction(4661640, 1088993), 0.7664);
  assert.equal(reduction(4661640, 1610878), 0.6544);
  // 10880 auto regressed: -74.09%.
  assert.equal(reduction(432600, 753097), -0.7409);
  // A zero baseline has no basis for a reduction.
  assert.equal(reduction(0, 100), 0);
});

test("pooled reduction calculation weighs by summed totals", () => {
  const rows = RECORDED.map((rec, i) =>
    buildInstanceRow({
      entry: { instance_id: rec.id, baseline_label: `b${i}`, force_label: `f${i}`, auto_label: `a${i}` },
      baseline: recordToRun(rec.id, rec.baselineTok, rec.baselineCost, rec.baselineDur),
      force: recordToRun(rec.id, rec.forceTok, rec.forceCost, rec.forceDur),
      auto: recordToRun(rec.id, rec.autoTok, rec.autoCost, rec.autoDur),
      policy: { action: rec.autoAction, reason: null, expected_context_value: null, expected_overhead_risk: null, decision_signals: [] },
    }),
  );
  const agg = aggregate(rows);
  assert.equal(agg.force_pooled_token_reduction, 0.617);
  assert.equal(agg.auto_pooled_token_reduction, 0.3346);
});

test("resolved count calculation counts resolved rows per condition", () => {
  const rows = [
    syntheticRow({ baseline_resolved: true, force_resolved: true, auto_resolved: true }),
    syntheticRow({ instance_id: "i2", baseline_resolved: false, force_resolved: true, auto_resolved: false }),
  ];
  const agg = aggregate(rows);
  assert.equal(agg.baseline_resolved_count, 1);
  assert.equal(agg.force_resolved_count, 2);
  assert.equal(agg.auto_resolved_count, 1);
});

test("auto policy action extraction from meta", () => {
  const inject = extractAutoPolicy({
    vtraceContextPolicyAction: "inject",
    vtracePolicyReason: "High-value context.",
    expectedContextValue: "high",
    expectedOverheadRisk: "low",
    vtraceContextPolicyDecisionSignals: ["edit_risk_directive_present", 5, "line_anchor_resolution_used"],
  });
  assert.equal(inject.action, "inject");
  assert.equal(inject.reason, "High-value context.");
  assert.equal(inject.expected_context_value, "high");
  assert.equal(inject.expected_overhead_risk, "low");
  assert.deepEqual(inject.decision_signals, ["edit_risk_directive_present", "line_anchor_resolution_used"]);

  assert.equal(extractAutoPolicy({ vtraceContextPolicyAction: "no_context" }).action, "no_context");
  assert.equal(extractAutoPolicy({}).action, "unknown");
});

test("auto inject/no_context and regression counts", () => {
  const rows = RECORDED.map((rec, i) =>
    buildInstanceRow({
      entry: { instance_id: rec.id, baseline_label: `b${i}`, force_label: `f${i}`, auto_label: `a${i}` },
      baseline: recordToRun(rec.id, rec.baselineTok, rec.baselineCost, rec.baselineDur),
      force: recordToRun(rec.id, rec.forceTok, rec.forceCost, rec.forceDur),
      auto: recordToRun(rec.id, rec.autoTok, rec.autoCost, rec.autoDur),
      policy: { action: rec.autoAction, reason: null, expected_context_value: null, expected_overhead_risk: null, decision_signals: [] },
    }),
  );
  const agg = aggregate(rows);
  assert.equal(agg.auto_inject_count, 3);
  assert.equal(agg.auto_no_context_count, 2);
  assert.equal(agg.auto_worse_than_force_count, 5);
  assert.equal(agg.auto_better_than_force_count, 0);
  assert.equal(agg.auto_worse_than_baseline_count, 2);
});

test("Markdown report includes the required interpretation", () => {
  const rows = RECORDED.map((rec, i) =>
    buildInstanceRow({
      entry: { instance_id: rec.id, baseline_label: `b${i}`, force_label: `f${i}`, auto_label: `a${i}` },
      baseline: recordToRun(rec.id, rec.baselineTok, rec.baselineCost, rec.baselineDur),
      force: recordToRun(rec.id, rec.forceTok, rec.forceCost, rec.forceDur),
      auto: recordToRun(rec.id, rec.autoTok, rec.autoCost, rec.autoDur),
      policy: { action: rec.autoAction, reason: "r", expected_context_value: "v", expected_overhead_risk: "o", decision_signals: [] },
    }),
  );
  const artifact = buildArtifact("labels.json", rows);
  const interpretation = renderInterpretationLines(artifact).join("\n");
  assert.match(interpretation, /Auto-policy preserved correctness: 5\/5 resolved\./);
  assert.match(interpretation, /Auto-policy did not outperform force-inject on this smoke set\./);
  assert.match(interpretation, /Force-inject achieved stronger pooled token\/cost\/duration reduction\./);
  assert.match(interpretation, /no_context assumption did not hold for 10880\/11095/);
  assert.match(interpretation, /no_context did not reproduce cheap baseline behavior\./);

  const md = renderMarkdown(artifact);
  for (const section of ["## Scope", "## Protocol", "## Label mapping", "## Policy decisions", "## Baseline vs force vs auto", "## Aggregate metrics", "## Interpretation", "## Recommendation", "## Caveats / non-claims"]) {
    assert.ok(md.includes(section), `markdown should contain section ${section}`);
  }
  for (const option of ["A. make auto more aggressive", "B. collect repeated-run estimates", "C. keep force-inject as the preferred experimental mode", "D. expand to more instances before tuning further"]) {
    assert.ok(md.includes(option), `markdown should contain next-step ${option}`);
  }
});

test("JSON/CSV/Markdown report generation end-to-end", async () => {
  const { root, runsRoot, labelMap } = await buildRecordedTree();
  try {
    const out = path.join(root, "out");
    const config = { labelMap, out, runsRoot };
    const artifact = await runAutoPolicyEval(config);

    // Reproduces the manual comparison from synthetic recorded artifacts.
    assert.equal(artifact.rows.length, 5);
    assert.equal(artifact.aggregate.auto_resolved_count, 5);
    assert.equal(artifact.aggregate.force_pooled_token_reduction, 0.617);
    assert.equal(artifact.aggregate.auto_pooled_token_reduction, 0.3346);
    assert.equal(artifact.rows[0]!.auto_policy_action, "no_context");

    await writeReports(config, artifact);
    const json = JSON.parse(await readFile(path.join(out, "stage5_capsule_v2_auto_policy_eval.json"), "utf8"));
    assert.equal(json.rows.length, 5);
    const csv = await readFile(path.join(out, "stage5_capsule_v2_auto_policy_eval.csv"), "utf8");
    assert.ok(csv.startsWith("instance_id,auto_policy_action,"));
    assert.equal(csv.trim().split("\n").length, 6); // header + 5 rows
    const md = await readFile(path.join(out, "stage5_capsule_v2_auto_policy_eval.md"), "utf8");
    assert.ok(md.includes("# Stage 5 — Capsule v2 Auto-Policy Evaluation"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CSV serializes reductions and decision signals", () => {
  const csv = renderCsv([syntheticRow({ auto_decision_signals: ["a", "b"] })]);
  const lines = csv.trim().split("\n");
  assert.ok(lines[0]!.includes("auto_decision_signals"));
  assert.ok(lines[1]!.includes("a | b"));
});

test("parseArgs resolves runs root under out by default", () => {
  const config = parseArgs(["--label-map", "m.json", "--out", "/o"]);
  assert.equal(config.labelMap, "m.json");
  assert.equal(config.out, "/o");
  assert.equal(config.runsRoot, path.join("/o", "runs"));
  assert.equal(parseArgs(["--runs-root", "/custom"]).runsRoot, "/custom");
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});

function recordToRun(id: string, tokens: number, costUsd: number, durationMs: number): RunRecord {
  return {
    instanceId: id,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: tokens - 350,
    cacheCreationTokens: 50,
    costUsd,
    durationMs,
    resolved: true,
  };
}
