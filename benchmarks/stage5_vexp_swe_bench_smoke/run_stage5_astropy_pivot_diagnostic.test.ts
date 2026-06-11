import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  analyzeAstropyRun,
  ASTROPY_DIAGNOSTIC_JSON_FILENAME,
  ASTROPY_DIAGNOSTIC_MD_FILENAME,
  buildAstropyDiagnostic,
  classifyAstropy,
  loadAstropyDiagnostic,
  matchesAstropy,
  median,
  parseCapsuleSnapshot,
  renderAstropyDiagnosticMarkdown,
  runAstropyPivotDiagnostic,
  type AstropyRunDiagnostic,
  type AstropyRunInputs,
  type StrictSetMedians,
} from "./run_stage5_astropy_pivot_diagnostic";
import type { OrderedToolCall } from "../../src/capsule/toolCallLog";

// --- Fixtures ---------------------------------------------------------------

// A Capsule snapshot whose TOP pivot is in vounit.py (a large snippet) but whose
// edit lands in cds.py — mirrors the real strict Astropy run.
const NOISY_SNAPSHOT = `# vtrace indexed context

## vtrace context

budget: 2,772 / 8,000 tokens used

## Multiple edit targets

● pivot astropy/units/format/vounit.py::VOUnit
  reason:
  - actionable class

  source:
  class VOUnit(generic.Generic):
      ${"x".repeat(800)}

  hidden candidate:
  Inspect it before finalizing.

● pivot astropy/units/format/cds.py::to_string
  reason:
  - actionable method

  source:
  def to_string(cls, unit):
      return s

○ support astropy/units/format/cds.py::CDS

  signature:
  class CDS(Base):

○ support astropy/coordinates/matching.py::_get_cartesian_kdtree

  signature:
  def _get_cartesian_kdtree(

## Instruction
`;

// A Capsule whose top pivot IS the edited file but the budget is very large.
const BIG_CAPSULE_SNAPSHOT = `# vtrace indexed context

budget: 6,000 / 8,000 tokens used

● pivot pkg/core/widget.py::Widget
  source:
  class Widget:
      ${"y".repeat(2000)}

● pivot pkg/core/helper.py::helper
  source:
  def helper():
      pass

○ support pkg/core/base.py::Base

○ support pkg/core/util.py::util

○ support pkg/core/extra.py::extra

○ support pkg/core/more.py::more

## Instruction
`;

function toolCall(index: number, tool: string, category: OrderedToolCall["category"], p: string | null): OrderedToolCall {
  return { index, tool, category, path: p, query: null, args: {}, output_summary: null };
}

const REPO = "/home/u/.bench-repos/astropy__astropy";
const EDIT_CDS: OrderedToolCall[] = [
  toolCall(0, "Read", "read", `${REPO}/astropy/units/format/cds.py`),
  toolCall(1, "Edit", "edit", `${REPO}/astropy/units/format/cds.py`),
];

const MEDIANS: StrictSetMedians = {
  taskCount: 10,
  capsuleTokenMedian: 1148,
  capsuleItemMedian: 6,
  deferredRefMedian: 4,
  perTask: [],
};

function baseInputs(over: Partial<AstropyRunInputs> = {}): AstropyRunInputs {
  return {
    runLabel: "eval-strictgated-vtrace-astropy-14369",
    condition: "vtrace",
    instanceId: "astropy__astropy-14369",
    snapshotMd: NOISY_SNAPSHOT,
    toolCalls: EDIT_CDS,
    evalMeta: { resolvedCount: 0 },
    runMeta: { vtracePivotChecklistEmitted: false, stage5ToolUseDisciplineInjected: true },
    reportOutcome: { resolved: false, totalTokens: 2_508_804, costUsd: 1.41 },
    ...over,
  };
}

// --- Tests ------------------------------------------------------------------

// (1) Finds Astropy runs by instance id and run label.
test("matchesAstropy finds runs by instance id and label", () => {
  assert.equal(matchesAstropy("eval-strictgated-vtrace-astropy-14369", null), true);
  assert.equal(matchesAstropy("some-label", "astropy__astropy-14369"), true);
  assert.equal(matchesAstropy("eval-strictgated-vtrace-django-10880", "django__django-10880"), false);
});

test("median handles empty/odd/even", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

// (3) Reads ordered telemetry summary when present.
test("analyzeAstropyRun reads ordered telemetry when present", () => {
  const run = analyzeAstropyRun(baseInputs());
  assert.equal(run.orderedTelemetryAvailable, true);
  assert.ok(run.toolCallSummary !== null);
  assert.equal(run.toolCallSummary?.fileReadToolCalls, 1);
  assert.equal(run.missingTelemetryReason, null);
  assert.deepEqual(run.editedFiles, [`${REPO}/astropy/units/format/cds.py`]);
});

// (4) Marks ordered telemetry missing when absent.
test("analyzeAstropyRun marks telemetry missing when absent", () => {
  const run = analyzeAstropyRun(baseInputs({ toolCalls: null }));
  assert.equal(run.orderedTelemetryAvailable, false);
  assert.equal(run.toolCallSummary, null);
  assert.equal(run.missingTelemetryReason, "no_tool_calls_artifact");
  assert.equal(run.topPivotInEditedFiles, null); // no edited files known
});

test("parseCapsuleSnapshot extracts budget, pivots, deferred refs, largest snippet", () => {
  const capsule = parseCapsuleSnapshot(NOISY_SNAPSHOT);
  assert.equal(capsule.available, true);
  assert.equal(capsule.budgetTokensUsed, 2772);
  assert.equal(capsule.budgetTokensTotal, 8000);
  assert.equal(capsule.pivots.length, 2);
  assert.equal(capsule.pivots[0]!.path, "astropy/units/format/vounit.py");
  assert.equal(capsule.deferredRefs.length, 2);
  assert.equal(capsule.capsuleItemCount, 4);
  // The VOUnit pivot has the large snippet.
  assert.equal(capsule.largestSnippetPath, "astropy/units/format/vounit.py");
  assert.equal(parseCapsuleSnapshot(null).available, false);
});

// (8) Classifies noisy_pivot_ranking when top pivots do not overlap edited files.
test("classifies noisy_pivot_ranking when top pivot is not in edited file", () => {
  const run = analyzeAstropyRun(baseInputs());
  assert.equal(run.topPivotInEditedFiles, false);
  const cls = classifyAstropy(run, MEDIANS, 2000);
  assert.equal(cls.primaryIssue, "noisy_pivot_ranking");
  // Capsule (2772 > 2000) is reported as secondary.
  assert.ok(cls.secondaryIssues.includes("capsule_budget_too_large"));
});

// (7) Classifies capsule_budget_too_large when capsule tokens above threshold and
// the top pivot IS in the edited file (so noisy ranking does not pre-empt it).
test("classifies capsule_budget_too_large when budget high and top pivot is edited", () => {
  const inputs = baseInputs({
    runLabel: "eval-x-widget",
    snapshotMd: BIG_CAPSULE_SNAPSHOT,
    toolCalls: [toolCall(0, "Edit", "edit", "/repo/pkg/core/widget.py")],
    reportOutcome: { resolved: false, totalTokens: 9, costUsd: 0.1 },
  });
  const run = analyzeAstropyRun(inputs);
  assert.equal(run.topPivotInEditedFiles, true);
  assert.equal(run.capsuleTokenEstimate, 6000);
  const cls = classifyAstropy(run, MEDIANS, 2000);
  assert.equal(cls.primaryIssue, "capsule_budget_too_large");
});

// (6) Classifies insufficient_evidence when telemetry/pivot artifacts are missing.
test("classifies insufficient_evidence when telemetry and pivots missing", () => {
  const run = analyzeAstropyRun(baseInputs({ snapshotMd: null, toolCalls: null }));
  const cls = classifyAstropy(run, MEDIANS, 2000);
  assert.equal(cls.primaryIssue, "insufficient_evidence");
});

test("classifyAstropy with no focus run is insufficient_evidence", () => {
  const cls = classifyAstropy(null, MEDIANS, 2000);
  assert.equal(cls.primaryIssue, "insufficient_evidence");
  assert.equal(cls.focusRunLabel, null);
});

// (5) Computes strict-set medians when comparison data exists (via buildAstropyDiagnostic).
test("buildAstropyDiagnostic surfaces medians and recommendation", () => {
  const run = analyzeAstropyRun(baseInputs());
  const diag = buildAstropyDiagnostic("/tmp/results", [run], MEDIANS, []);
  assert.equal(diag.strictSetMedians.deferredRefMedian, 4);
  assert.equal(diag.classification.primaryIssue, "noisy_pivot_ranking");
  // noisy primary + telemetry present → recommendation 1.
  assert.equal(diag.recommendedNextChange.id, 1);
});

test("missing telemetry biases recommendation to #4", () => {
  // Noisy-looking but telemetry absent → prefer gathering a fresh run (rec 4).
  const run = analyzeAstropyRun(baseInputs({ toolCalls: null }));
  const diag = buildAstropyDiagnostic("/tmp/results", [run], MEDIANS, []);
  assert.equal(diag.recommendedNextChange.id, 4);
});

// (9) + (10) Emits required Markdown sections and JSON fields.
test("renderAstropyDiagnosticMarkdown emits all required sections", () => {
  const run = analyzeAstropyRun(baseInputs());
  const diag = buildAstropyDiagnostic("/tmp/results", [run], MEDIANS, []);
  const md = renderAstropyDiagnosticMarkdown(diag);
  for (const section of [
    "# Stage 5 Astropy pivot diagnostic",
    "## Summary",
    "## Runs analyzed",
    "## Outcome and cost",
    "## Pivot evidence",
    "## Capsule budget evidence",
    "## Deferred reference evidence",
    "## Tool-loop evidence",
    "## Classification",
    "## Recommended next change",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(section), `missing section: ${section}`);
  }
});

test("diagnostic JSON exposes all required fields", () => {
  const run = analyzeAstropyRun(baseInputs());
  const diag = buildAstropyDiagnostic("/tmp/results", [run], MEDIANS, []);
  for (const key of [
    "resultsDir",
    "capsuleTokenBudgetThreshold",
    "runsAnalyzed",
    "focusRunLabel",
    "strictSetMedians",
    "classification",
    "recommendedNextChange",
    "missingArtifacts",
    "nonClaims",
  ]) {
    assert.ok(key in diag, `missing top-level field: ${key}`);
  }
  const r = diag.runsAnalyzed[0]!;
  for (const key of [
    "runLabel",
    "resolved",
    "totalCostUsd",
    "totalTokens",
    "orderedTelemetryAvailable",
    "missingTelemetryReason",
    "toolCallSummary",
    "capsuleTokenEstimate",
    "capsuleItemCount",
    "pivotCount",
    "pivotPaths",
    "topPivotPath",
    "deferredRefCount",
    "expandedDeferredRefCount",
    "editedFiles",
    "firstPatchPaths",
  ] satisfies (keyof AstropyRunDiagnostic)[]) {
    assert.ok(key in r, `missing run field: ${key}`);
  }
});

// (2) Handles missing artifacts without crashing — empty results dir.
test("loadAstropyDiagnostic handles a results dir with no artifacts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "astropy-diag-empty-"));
  const results = path.join(dir, "results");
  await mkdir(results, { recursive: true });
  const diag = await loadAstropyDiagnostic(results);
  assert.equal(diag.runsAnalyzed.length, 0);
  assert.equal(diag.classification.primaryIssue, "insufficient_evidence");
  assert.ok(diag.missingArtifacts.length > 0);
  // (4 cont.) recommendation defaults to gathering evidence.
  assert.equal(diag.recommendedNextChange.id, 4);
});

// (11) End-to-end on a seeded fixture dir — no Docker/model/agent invoked.
test("runAstropyPivotDiagnostic writes JSON+MD from seeded run dirs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "astropy-diag-seed-"));
  const results = path.join(dir, "results");
  const runDir = path.join(results, "runs", "eval-strictgated-vtrace-astropy-14369");
  const raw = path.join(runDir, "raw", "vtrace");
  await mkdir(raw, { recursive: true });
  await writeFile(path.join(runDir, "_vtrace_instructions.snapshot.md"), NOISY_SNAPSHOT);
  await writeFile(path.join(raw, "_tool_calls.json"), JSON.stringify(EDIT_CDS));
  await writeFile(path.join(raw, "_eval.meta.json"), JSON.stringify({ resolvedCount: 0 }));
  await writeFile(
    path.join(raw, "_run.meta.json"),
    JSON.stringify({ instances: ["astropy__astropy-14369"], vtracePivotChecklistEmitted: false }),
  );

  const diag = await runAstropyPivotDiagnostic(results);
  assert.equal(diag.runsAnalyzed.length, 1);
  assert.equal(diag.classification.primaryIssue, "noisy_pivot_ranking");
  assert.equal(diag.strictSetMedians.taskCount, 1);
  // Files written.
  const { readFile } = await import("node:fs/promises");
  const json = await readFile(path.join(results, ASTROPY_DIAGNOSTIC_JSON_FILENAME), "utf8");
  const md = await readFile(path.join(results, ASTROPY_DIAGNOSTIC_MD_FILENAME), "utf8");
  assert.ok(json.includes("noisy_pivot_ranking"));
  assert.ok(md.includes("# Stage 5 Astropy pivot diagnostic"));
});
