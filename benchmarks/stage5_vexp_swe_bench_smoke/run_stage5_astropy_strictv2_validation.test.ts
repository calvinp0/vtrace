import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  CONDITION,
  INSTANCE_ID,
  NON_CLAIMS,
  RUN_LABEL,
  buildClaims,
  buildReport,
  detectCapsuleManifest,
  editedFilesFromPatch,
  grammarChangeDetected,
  parseDockerEvaluation,
  parseOrderedTelemetry,
  parseReportArgs,
  parseRunMetaFlags,
  parseSweBenchRow,
  renderJson,
  renderMarkdown,
  summarizePatch,
  totalTokens,
} from "./run_stage5_astropy_strictv2_validation";

// --------------------------------------------------------------------------
// Fixtures — mirror the real strict-v2 Astropy run artifacts. No Docker, no
// model, no agent: every test reads from synthetic in-memory / on-disk data.
// --------------------------------------------------------------------------

const PATCH =
  "diff --git a/astropy/units/format/cds.py b/astropy/units/format/cds.py\n" +
  "index 307e987..1e3425e 100644\n" +
  "--- a/astropy/units/format/cds.py\n" +
  "+++ b/astropy/units/format/cds.py\n" +
  "@@\n" +
  "-        division_of_units : unit_expression DIVISION combined_units\n" +
  "+        division_of_units : combined_units DIVISION unit_expression\n" +
  "diff --git a/astropy/units/format/cds_parsetab.py b/astropy/units/format/cds_parsetab.py\n" +
  "index aaa..bbb 100644\n" +
  "--- a/astropy/units/format/cds_parsetab.py\n" +
  "+++ b/astropy/units/format/cds_parsetab.py\n" +
  "@@\n" +
  "-_lr_productions = []\n" +
  "+_lr_productions = [1]\n";

const SWEBENCH_ROW = {
  instanceId: INSTANCE_ID,
  repo: "astropy/astropy",
  timestamp: "2026-06-11T16:34:17.057Z",
  commitHash: "fa4e8d1cd279acf9b24560813c8652494ccd5922",
  model: "claude-opus-4-5-20251101",
  agent: "claude-code",
  inputTokens: 533,
  outputTokens: 165,
  cacheReadTokens: 3915859,
  cacheCreationTokens: 163036,
  costUsd: 1.6942299999999997,
  numTurns: 75,
  durationMs: 310811,
  toolCalls: { Grep: 6, Glob: 4, Read: 8, Edit: 1, Bash: 12 },
  modelPatch: PATCH,
  resolved: true,
  vexpMetrics: null,
};

const EVAL_META = {
  condition: "vtrace",
  evaluationRan: true,
  evaluationMethod: "docker",
  dockerUsed: true,
  evaluationError: null,
  resultsFile: "swebench-2026-06-11.jsonl",
  instancesEvaluated: 1,
  resolvedCount: 1,
  notes: [],
};

const TOOL_SUMMARY = {
  runLabel: RUN_LABEL,
  condition: "vtrace",
  instanceId: INSTANCE_ID,
  totalToolCalls: 31,
  bashToolCalls: 12,
  grepLikeToolCalls: 10,
  fileReadToolCalls: 8,
  fileWriteToolCalls: 1,
  uniqueFilesTouchedByTools: 9,
  longBashLoopHeuristic: true,
  repeatedSearchHeuristic: true,
  orderedTelemetryAvailable: true,
  pivotChecklistEmitted: false,
  missingReason: null,
};

const RUN_META = {
  condition: "vtrace",
  stage5ToolUseDisciplineInjected: true,
  stage5ToolUseDisciplineVersion: "v1",
  stage5ToolUseDisciplineDisabledByFlag: false,
  vtraceInjectionObserved: true,
  vtraceToolLogOrdered: true,
  vtraceToolCallCount: 31,
  vtracePivotChecklistEmitted: false,
  orderedTelemetryAvailable: true,
  exitCode: 0,
  durationMs: 311017,
};

// Lay down a synthetic run tree under a fresh tmp results dir.
async function writeRunTree(): Promise<string> {
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "stage5-strictv2-"));
  const conditionDir = path.join(resultsDir, "runs", RUN_LABEL, "raw", CONDITION);
  await mkdir(conditionDir, { recursive: true });
  await writeFile(
    path.join(conditionDir, "swebench-2026-06-11.jsonl"),
    `${JSON.stringify(SWEBENCH_ROW)}\n`,
  );
  await writeFile(path.join(conditionDir, "_eval.meta.json"), JSON.stringify(EVAL_META));
  await writeFile(path.join(conditionDir, "_tool_calls.summary.json"), JSON.stringify(TOOL_SUMMARY));
  await writeFile(path.join(conditionDir, "_run.meta.json"), JSON.stringify(RUN_META));
  return resultsDir;
}

// --------------------------------------------------------------------------
// Pure-helper unit tests
// --------------------------------------------------------------------------

test("totalTokens sums the four token components", () => {
  assert.equal(totalTokens(parseSweBenchRow(SWEBENCH_ROW)), 533 + 165 + 3915859 + 163036);
});

test("editedFilesFromPatch extracts both CDS parser files", () => {
  assert.deepEqual(editedFilesFromPatch(PATCH).sort(), [
    "astropy/units/format/cds.py",
    "astropy/units/format/cds_parsetab.py",
  ]);
});

test("grammarChangeDetected sees the division_of_units reorder", () => {
  assert.equal(grammarChangeDetected(PATCH), true);
  assert.equal(grammarChangeDetected("no grammar here"), false);
});

test("summarizePatch confirms the expected CDS files were edited", () => {
  const p = summarizePatch(PATCH);
  assert.equal(p.patchPresent, true);
  assert.equal(p.editedExpectedFiles, true);
  assert.equal(p.grammarChangeDetected, true);
  assert.deepEqual(p.unexpectedFiles, []);
});

test("parseDockerEvaluation reads resolved=true from resolvedCount", () => {
  const d = parseDockerEvaluation(EVAL_META);
  assert.equal(d.evaluationRan, true);
  assert.equal(d.evaluationMethod, "docker");
  assert.equal(d.dockerUsed, true);
  assert.equal(d.evaluationError, null);
  assert.equal(d.resolvedCount, 1);
  assert.equal(d.resolved, true);
});

test("parseOrderedTelemetry reports the loop heuristics", () => {
  const t = parseOrderedTelemetry(TOOL_SUMMARY);
  assert.equal(t.totalToolCalls, 31);
  assert.equal(t.bashToolCalls, 12);
  assert.equal(t.grepLikeToolCalls, 10);
  assert.equal(t.orderedTelemetryAvailable, true);
  assert.equal(t.longBashLoopHeuristic, true);
  assert.equal(t.repeatedSearchHeuristic, true);
});

test("parseRunMetaFlags reports anti-loop guidance metadata", () => {
  const m = parseRunMetaFlags(RUN_META);
  assert.equal(m.stage5ToolUseDisciplineInjected, true);
  assert.equal(m.stage5ToolUseDisciplineVersion, "v1");
  assert.equal(m.stage5ToolUseDisciplineDisabledByFlag, false);
  assert.equal(m.vtraceToolLogOrdered, true);
  assert.equal(m.orderedTelemetryAvailable, true);
});

test("detectCapsuleManifest reports a missing manifest (the caveat)", () => {
  const finding = detectCapsuleManifest(
    ["swebench-2026-06-11.jsonl", "_eval.meta.json", "_tool_calls.summary.json", "_run.meta.json"],
    RUN_META,
  );
  assert.equal(finding.present, false);
  assert.deepEqual(finding.foundFilenames, []);
  assert.deepEqual(finding.capsuleMetaKeysFound, []);
  assert.ok(finding.checkedFilenames.length > 0);
});

test("detectCapsuleManifest reports present when a manifest file exists", () => {
  const finding = detectCapsuleManifest(["_capsule.manifest.json"], RUN_META);
  assert.equal(finding.present, true);
  assert.deepEqual(finding.foundFilenames, ["_capsule.manifest.json"]);
});

test("buildClaims gates each claim on its evidence", () => {
  const claims = buildClaims(
    parseDockerEvaluation(EVAL_META),
    summarizePatch(PATCH),
    parseOrderedTelemetry(TOOL_SUMMARY),
    parseRunMetaFlags(RUN_META),
  );
  assert.ok(claims.includes("The fresh strict-v2 Astropy run produced a patch."));
  assert.ok(claims.includes("Docker evaluation resolved astropy__astropy-14369."));
  assert.ok(claims.includes("The patch edited the expected CDS parser files."));
  assert.ok(claims.includes("Ordered telemetry was available."));
  assert.ok(claims.includes("Anti-loop guidance was injected."));
  assert.ok(claims.includes("The run still triggered long Bash/search loop heuristics."));
});

// --------------------------------------------------------------------------
// IO: buildReport against the synthetic run tree
// --------------------------------------------------------------------------

test("buildReport reads the strict-v2 Astropy run JSONL and assembles the report", async () => {
  const resultsDir = await writeRunTree();
  const report = await buildReport({ resultsDir }, "2026-06-11T00:00:00.000Z");

  // 1. Reads the run JSONL.
  assert.equal(report.instanceId, INSTANCE_ID);
  assert.equal(report.runLabel, RUN_LABEL);
  assert.equal(report.row.numTurns, 75);
  assert.equal(report.patch.patchPresent, true);

  // 2. Reads evaluation result / resolved=true.
  assert.equal(report.docker.resolved, true);
  assert.equal(report.docker.evaluationMethod, "docker");

  // 3. Reads ordered telemetry summary.
  assert.equal(report.telemetry.totalToolCalls, 31);
  assert.equal(report.telemetry.orderedTelemetryAvailable, true);

  // 4. Reports loop heuristics.
  assert.equal(report.telemetry.longBashLoopHeuristic, true);
  assert.equal(report.telemetry.repeatedSearchHeuristic, true);

  // 5. Reports anti-loop guidance metadata from _run.meta.json.
  assert.equal(report.runMeta.stage5ToolUseDisciplineInjected, true);
  assert.equal(report.runMeta.stage5ToolUseDisciplineVersion, "v1");

  // 6. Detects missing Capsule/ranking manifest.
  assert.equal(report.capsuleManifest.present, false);
});

test("buildReport throws a clear error when the run row is missing", async () => {
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "stage5-strictv2-empty-"));
  await assert.rejects(
    () => buildReport({ resultsDir }, null),
    /Missing strict-v2 run row/,
  );
});

// --------------------------------------------------------------------------
// Rendering tests
// --------------------------------------------------------------------------

const REQUIRED_SECTIONS = [
  "# Stage 5 strict-v2 Astropy validation",
  "## Summary",
  "## Run identity",
  "## Docker evaluation",
  "## Patch summary",
  "## Cost and token outcome",
  "## Ordered telemetry outcome",
  "## Tool-loop finding",
  "## Capsule/ranking metadata caveat",
  "## Interpretation",
  "## Recommended next step",
  "## Non-claims",
];

test("renderMarkdown emits every required section", async () => {
  const resultsDir = await writeRunTree();
  const md = renderMarkdown(await buildReport({ resultsDir }, "2026-06-11T00:00:00.000Z"));
  for (const section of REQUIRED_SECTIONS) {
    assert.ok(md.includes(section), `missing section: ${section}`);
  }
});

test("renderMarkdown includes every non-claim verbatim", async () => {
  const resultsDir = await writeRunTree();
  const md = renderMarkdown(await buildReport({ resultsDir }, null));
  for (const claim of NON_CLAIMS) {
    assert.ok(md.includes(claim), `missing non-claim: ${claim}`);
  }
});

test("renderMarkdown states the loop and manifest findings", async () => {
  const resultsDir = await writeRunTree();
  const md = renderMarkdown(await buildReport({ resultsDir }, null));
  assert.ok(md.includes("Capsule/ranking manifest present: no"));
  assert.ok(md.includes("Long Bash loop heuristic: yes"));
  assert.ok(md.includes("Repeated search heuristic: yes"));
  assert.ok(md.includes("Tool-use discipline injected: yes"));
});

test("renderJson emits the required JSON fields", async () => {
  const resultsDir = await writeRunTree();
  const json = JSON.parse(renderJson(await buildReport({ resultsDir }, "2026-06-11T00:00:00.000Z")));

  // 8. Required JSON fields.
  assert.equal(json.runLabel, RUN_LABEL);
  assert.equal(json.instanceId, INSTANCE_ID);
  assert.equal(json.condition, CONDITION);
  assert.equal(json.docker.resolved, true);
  assert.equal(json.patch.editedExpectedFiles, true);
  assert.equal(json.cost.numTurns, 75);
  assert.equal(json.cost.totalTokens, 533 + 165 + 3915859 + 163036);
  assert.equal(json.orderedTelemetry.totalToolCalls, 31);
  assert.equal(json.antiLoopGuidance.stage5ToolUseDisciplineInjected, true);
  assert.equal(json.toolLoopFinding.anyLoopHeuristic, true);
  assert.equal(json.capsuleManifest.present, false);
  assert.ok(Array.isArray(json.claims));
  assert.ok(Array.isArray(json.nonClaims));
  assert.equal(json.nonClaims.length, NON_CLAIMS.length);
});

// --------------------------------------------------------------------------
// CLI arg parsing
// --------------------------------------------------------------------------

test("parseReportArgs reads --results and defaults the out dir to it", () => {
  const config = parseReportArgs(["--results", "/tmp/results"]);
  assert.equal(config.resultsDir, "/tmp/results");
  assert.equal(config.outDir, "/tmp/results");
  assert.equal(config.runLabel, RUN_LABEL);
});

test("parseReportArgs honors an explicit --out override", () => {
  const config = parseReportArgs(["--results", "/tmp/results", "--out", "/tmp/out"]);
  assert.equal(config.resultsDir, "/tmp/results");
  assert.equal(config.outDir, "/tmp/out");
});

test("parseReportArgs rejects unknown arguments", () => {
  assert.throws(() => parseReportArgs(["--nope"]), /Unknown argument/);
});
