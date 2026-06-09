import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { classifyPivotInspection } from "../../src/capsule/finalEditDiagnostics";
import {
  NON_CLAIMS,
  buildConversionRows,
  buildInterpretation,
  buildPair,
  buildReport,
  classifyConversion,
  editedFileSetChanged,
  hiddenConversionsFor,
  loadRun,
  parseEditRelevanceAnnotations,
  parsePairArg,
  parseReportArgs,
  pivotCheckStateLabel,
  pivotPhase,
  renderJson,
  renderMarkdown,
  summarize,
  summarizeEditRelevance,
  type EditRelevanceAnnotation,
  type PivotCheckRun,
} from "./run_stage5_pivot_check_report";

// Curated edit-relevance annotations mirroring the post-inspection analysis:
// sphinx's hidden pivot is edit-relevant (gold) but was not edited; seaborn's is
// not edit-relevant. Used to drive the edit-relevance subset tests.
const EDIT_RELEVANCE_FIXTURE: EditRelevanceAnnotation[] = [
  {
    instanceId: "sphinx-doc__sphinx-7462",
    hiddenPivot: "sphinx/pycode/ast.py::unparse",
    classification: "failed_to_connect_to_edit",
    editRelevant: true,
    inspectedAfter: true,
    editedAfter: false,
    implication: "one edit-planning miss",
  },
  {
    instanceId: "mwaskom__seaborn-3187",
    hiddenPivot: "seaborn/relational.py::scatterplot",
    classification: "not_actually_edit_relevant",
    editRelevant: false,
    inspectedAfter: true,
    editedAfter: false,
    implication: "correct/no-edit context or weak edit-conversion evidence",
  },
];

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

// Scaffold a `results/runs/<label>/` tree mirroring the live layout: a vtrace
// condition dir with the JSONL row, `_run.meta.json`, optional `_tool_calls.json`,
// and the snapshot one level up.
async function scaffoldRun(
  runsDir: string,
  label: string,
  opts: {
    instanceId: string;
    resolved: boolean | null;
    inputTokens?: number;
    costUsd?: number;
    patch: string;
    pivots: Array<{ path: string; symbol: string; roleReason: string }>;
    support?: Array<{ path: string; symbol: string; roleReason: string }>;
    toolCalls: Array<{ tool: string; category?: string; path?: string | null; query?: string | null }> | null;
    pivotCheckInjected: boolean;
    checklistEmitted: boolean | null;
    treatmentValid?: boolean;
    // Optional PIVOT_CHECK feature/flag meta. Omitted => the keys are absent from
    // `_run.meta.json` (mirrors a run whose meta predates the flag).
    pivotCheckEnabled?: boolean;
    pivotCheckDisabledByFlag?: boolean;
  },
): Promise<void> {
  const condDir = path.join(runsDir, label, "raw", "vtrace");
  await mkdir(condDir, { recursive: true });

  const row = {
    instanceId: opts.instanceId,
    resolved: opts.resolved,
    inputTokens: opts.inputTokens ?? 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: opts.costUsd ?? 0.1,
    durationMs: 1000,
    model: "claude-opus-4-5-20251101",
    agent: "claude-code",
    modelPatch: opts.patch,
  };
  await writeFile(path.join(condDir, "swebench-test.jsonl"), `${JSON.stringify(row)}\n`);

  const meta: Record<string, unknown> = {
    vtraceTreatmentValid: opts.treatmentValid ?? true,
    vtracePivotChecklistEmitted: opts.checklistEmitted,
    vtraceToolLogOrdered: opts.toolCalls !== null,
    vtraceToolCallCount: opts.toolCalls?.length ?? null,
    vtraceCapsulePivots: opts.pivots,
    vtraceCapsuleSupport: opts.support ?? [],
  };
  if (opts.pivotCheckEnabled !== undefined) meta.vtracePivotCheckEnabled = opts.pivotCheckEnabled;
  if (opts.pivotCheckDisabledByFlag !== undefined) {
    meta.vtracePivotCheckDisabledByFlag = opts.pivotCheckDisabledByFlag;
  }
  await writeFile(path.join(condDir, "_run.meta.json"), JSON.stringify(meta));

  if (opts.toolCalls !== null) {
    const calls = opts.toolCalls.map((c, index) => ({
      index,
      tool: c.tool,
      category: c.category ?? "other",
      path: c.path ?? null,
      query: c.query ?? null,
      args: {},
      output_summary: null,
    }));
    await writeFile(path.join(condDir, "_tool_calls.json"), JSON.stringify(calls));
  }

  const snapshot = opts.pivotCheckInjected
    ? "# vtrace context\n\n## PIVOT_CHECK\nInspect every pivot before editing.\n"
    : "# vtrace context\n\nNo enforcement block.\n";
  await writeFile(path.join(runsDir, label, "_vtrace_instructions.snapshot.md"), snapshot);
}

const SOURCE_ANCHOR_REASON = "source line anchor in the issue points at this symbol";
const HIDDEN_REASON = "actionable function — exercised by a failing test; symbol-name match";

// --------------------------------------------------------------------------
// Test 1 + 2: search-only before + read after => discovered_only_to_inspected
// (also exercises the real classifier so the report cannot weaken `inspected`).
// --------------------------------------------------------------------------

test("search-only before + read after converts a hidden pivot to discovered_only_to_inspected", () => {
  const pivots = [{ path: "a/b.py", symbol: "foo", role: "pivot" as const, hidden: true }];

  const before = classifyPivotInspection(pivots, [{ tool: "Grep", target: "a/b.py" }], []);
  const after = classifyPivotInspection(pivots, [{ tool: "Read", target: "a/b.py" }], []);

  assert.equal(before[0]!.discovered, true);
  assert.equal(before[0]!.inspected, false);
  assert.equal(after[0]!.inspected, true);

  const rows = buildConversionRows(before, after);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.conversion, "discovered_only_to_inspected");
  assert.equal(rows[0]!.beforeStatus, "ignored");
  assert.equal(rows[0]!.afterStatus, "inspected");
  assert.equal(rows[0]!.hidden, true);
});

// --------------------------------------------------------------------------
// Test 3: ignored before + edited after => ignored_to_edited
// --------------------------------------------------------------------------

test("ignored before + edited after converts to ignored_to_edited", () => {
  const pivots = [{ path: "a/b.py", symbol: "foo", role: "pivot" as const, hidden: true }];

  const before = classifyPivotInspection(pivots, [], []);
  const after = classifyPivotInspection(pivots, [], ["a/b.py"]);

  assert.equal(before[0]!.status, "ignored");
  assert.equal(after[0]!.edited, true);

  const rows = buildConversionRows(before, after);
  assert.equal(rows[0]!.conversion, "ignored_to_edited");
});

// --------------------------------------------------------------------------
// classifyConversion / pivotPhase unit coverage of the mapping table.
// --------------------------------------------------------------------------

test("classifyConversion maps the phase pairs deterministically", () => {
  assert.equal(classifyConversion("ignored", "inspected"), "ignored_to_inspected");
  assert.equal(classifyConversion("ignored", "edited"), "ignored_to_edited");
  assert.equal(classifyConversion("discovered_only", "inspected"), "discovered_only_to_inspected");
  assert.equal(classifyConversion("discovered_only", "edited"), "discovered_only_to_edited");
  assert.equal(classifyConversion("inspected", "edited"), "inspected_to_edited");
  assert.equal(classifyConversion("ignored", "ignored"), "unchanged_ignored");
  assert.equal(classifyConversion("discovered_only", "discovered_only"), "unchanged_ignored");
  assert.equal(classifyConversion("ignored", "discovered_only"), "unchanged_ignored");
  assert.equal(classifyConversion("inspected", "inspected"), "unchanged_inspected");
  assert.equal(classifyConversion("edited", "edited"), "unchanged_edited");
  assert.equal(classifyConversion("inspected", "ignored"), "regressed_to_ignored");
  assert.equal(classifyConversion("edited", "discovered_only"), "regressed_to_ignored");
  assert.equal(classifyConversion("discovered_only", "ignored"), "unchanged_ignored");
  assert.equal(classifyConversion("not_comparable", "inspected"), "not_comparable");
  assert.equal(classifyConversion("inspected", "not_comparable"), "not_comparable");
});

test("pivotPhase breaks discovered_only out of ignored and treats null as not_comparable", () => {
  assert.equal(pivotPhase(null), "not_comparable");
  const [ignored] = classifyPivotInspection(
    [{ path: "x.py", symbol: "s", role: "pivot", hidden: true }],
    [],
    [],
  );
  assert.equal(pivotPhase(ignored), "ignored");
  const [discovered] = classifyPivotInspection(
    [{ path: "x.py", symbol: "s", role: "pivot", hidden: true }],
    [{ tool: "Grep", target: "x.py" }],
    [],
  );
  assert.equal(pivotPhase(discovered), "discovered_only");
});

// --------------------------------------------------------------------------
// Test 4: missing _tool_calls.json degrades honestly and does not crash
// --------------------------------------------------------------------------

test("missing _tool_calls.json degrades to patch-only inspection without crashing", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pivot-check-degrade-"));
  const runsDir = path.join(tmp, "runs");
  await scaffoldRun(runsDir, "lbl-notools", {
    instanceId: "demo__demo-1",
    resolved: null,
    patch: "diff --git a/a/b.py b/a/b.py\n--- a/a/b.py\n+++ b/a/b.py\n@@ -1 +1 @@\n-x\n+y\n",
    pivots: [{ path: "a/b.py", symbol: "foo", roleReason: HIDDEN_REASON }],
    toolCalls: null, // no _tool_calls.json on disk
    pivotCheckInjected: false,
    checklistEmitted: null,
  });

  const run = await loadRun("lbl-notools", { runsDir });
  // No ordered log => falls back to the record's (absent) aggregate counts.
  assert.equal(run.toolLogOrdered, false);
  assert.equal(run.toolCallCount, null);
  // Patch evidence still classifies the edit honestly; no read => no inspection.
  assert.equal(run.records[0]!.edited, true);
  assert.equal(run.records[0]!.inspected, false);
  assert.equal(run.editedFiles.includes("a/b.py"), true);
});

// --------------------------------------------------------------------------
// Test 5: checklist emitted=false does not override tool evidence
// --------------------------------------------------------------------------

test("checklist emitted false does not override ordered tool evidence of inspection", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pivot-check-checklist-"));
  const runsDir = path.join(tmp, "runs");
  await scaffoldRun(runsDir, "lbl-after", {
    instanceId: "demo__demo-2",
    resolved: null,
    patch: "",
    pivots: [{ path: "sphinx/pycode/ast.py", symbol: "unparse", roleReason: HIDDEN_REASON }],
    toolCalls: [
      { tool: "Read", category: "read", path: "sphinx/pycode/ast.py" },
    ],
    pivotCheckInjected: true,
    checklistEmitted: false, // agent did NOT echo a checklist
  });

  const run = await loadRun("lbl-after", { runsDir });
  assert.equal(run.checklistEmitted, false);
  assert.equal(run.toolLogOrdered, true);
  // Tool evidence is the source of truth: the file was read => inspected.
  assert.equal(run.records[0]!.inspected, true);
  assert.equal(run.records[0]!.status, "inspected");
  assert.equal(run.hiddenCounts.inspected, 1);
});

// --------------------------------------------------------------------------
// Test 6 + 7: full report — markdown includes non-claims, JSON has summary fields
// --------------------------------------------------------------------------

async function scaffoldSphinxLikePair(runsDir: string): Promise<void> {
  const pivots = [
    { path: "sphinx/domains/python.py", symbol: "_parse_annotation", roleReason: SOURCE_ANCHOR_REASON },
    { path: "sphinx/pycode/ast.py", symbol: "unparse", roleReason: HIDDEN_REASON },
  ];
  const patch =
    "diff --git a/sphinx/domains/python.py b/sphinx/domains/python.py\n" +
    "--- a/sphinx/domains/python.py\n+++ b/sphinx/domains/python.py\n@@ -1 +1 @@\n-x\n+y\n";

  // before: hidden pivot only grep-surfaced (discovered-only), edit on python.py
  await scaffoldRun(runsDir, "before-lbl", {
    instanceId: "sphinx-doc__sphinx-7462",
    resolved: null,
    inputTokens: 100,
    costUsd: 0.2,
    patch,
    pivots,
    toolCalls: [
      { tool: "Read", category: "read", path: "sphinx/domains/python.py" },
      { tool: "Edit", category: "edit", path: "sphinx/domains/python.py" },
      { tool: "Grep", category: "search", path: "sphinx/pycode/ast.py", query: "unparse" },
    ],
    pivotCheckInjected: false,
    checklistEmitted: null,
    // before = controlled PIVOT_CHECK-off run (the new --disable-pivot-check path).
    pivotCheckEnabled: false,
    pivotCheckDisabledByFlag: true,
  });

  // after: hidden pivot directly read (inspected); checklist NOT emitted
  await scaffoldRun(runsDir, "after-lbl", {
    instanceId: "sphinx-doc__sphinx-7462",
    resolved: null,
    inputTokens: 150,
    costUsd: 0.3,
    patch,
    pivots,
    toolCalls: [
      { tool: "Read", category: "read", path: "sphinx/domains/python.py" },
      { tool: "Read", category: "read", path: "sphinx/pycode/ast.py" },
      { tool: "Edit", category: "edit", path: "sphinx/domains/python.py" },
    ],
    pivotCheckInjected: true,
    checklistEmitted: false,
    // after = default PIVOT_CHECK-on run.
    pivotCheckEnabled: true,
    pivotCheckDisabledByFlag: false,
  });
}

// A second, non-sphinx pair (mirrors the real seaborn-3187 shape: two edited
// files unchanged before→after, one hidden pivot converted discovered_only →
// inspected, cost + tokens both up). Used to prove the interpretation is not
// hard-coded to sphinx and to drive the multi-pair aggregate.
async function scaffoldSeabornLikePair(runsDir: string): Promise<void> {
  const pivots = [
    { path: "seaborn/_core/scales.py", symbol: "get_view_interval", roleReason: SOURCE_ANCHOR_REASON },
    { path: "seaborn/relational.py", symbol: "scatterplot", roleReason: HIDDEN_REASON },
    { path: "seaborn/utils.py", symbol: "spacer", roleReason: SOURCE_ANCHOR_REASON },
  ];
  const patch =
    "diff --git a/seaborn/_core/scales.py b/seaborn/_core/scales.py\n" +
    "--- a/seaborn/_core/scales.py\n+++ b/seaborn/_core/scales.py\n@@ -1 +1 @@\n-x\n+y\n" +
    "diff --git a/seaborn/utils.py b/seaborn/utils.py\n" +
    "--- a/seaborn/utils.py\n+++ b/seaborn/utils.py\n@@ -1 +1 @@\n-a\n+b\n";

  // before: hidden pivot only grep-surfaced (discovered-only); both gold files edited.
  await scaffoldRun(runsDir, "seaborn-before", {
    instanceId: "mwaskom__seaborn-3187",
    resolved: null,
    inputTokens: 100,
    costUsd: 1.0,
    patch,
    pivots,
    toolCalls: [
      { tool: "Read", category: "read", path: "seaborn/_core/scales.py" },
      { tool: "Read", category: "read", path: "seaborn/utils.py" },
      { tool: "Edit", category: "edit", path: "seaborn/_core/scales.py" },
      { tool: "Edit", category: "edit", path: "seaborn/utils.py" },
      { tool: "Grep", category: "search", path: "seaborn/relational.py", query: "scatterplot" },
    ],
    pivotCheckInjected: false,
    checklistEmitted: null,
    pivotCheckEnabled: false,
    pivotCheckDisabledByFlag: true,
  });

  // after: hidden pivot directly read (inspected); same two gold files edited.
  await scaffoldRun(runsDir, "seaborn-after", {
    instanceId: "mwaskom__seaborn-3187",
    resolved: null,
    inputTokens: 150,
    costUsd: 1.1,
    patch,
    pivots,
    toolCalls: [
      { tool: "Read", category: "read", path: "seaborn/_core/scales.py" },
      { tool: "Read", category: "read", path: "seaborn/utils.py" },
      { tool: "Read", category: "read", path: "seaborn/relational.py" },
      { tool: "Edit", category: "edit", path: "seaborn/_core/scales.py" },
      { tool: "Edit", category: "edit", path: "seaborn/utils.py" },
    ],
    pivotCheckInjected: true,
    checklistEmitted: false,
    pivotCheckEnabled: true,
    pivotCheckDisabledByFlag: false,
  });
}

test("buildReport produces the expected hidden-pivot conversion and resolves all required pair fields", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pivot-check-report-"));
  const runsDir = path.join(tmp, "runs");
  await scaffoldSphinxLikePair(runsDir);

  const report = await buildReport(
    [{ beforeLabel: "before-lbl", afterLabel: "after-lbl" }],
    { runsDir },
    "2026-06-09T00:00:00.000Z",
  );

  assert.equal(report.pairs.length, 1);
  const pair = report.pairs[0]!;
  assert.equal(pair.instanceId, "sphinx-doc__sphinx-7462");

  // The hidden pivot converted discovered_only -> inspected.
  const hidden = pair.pivots.find((p) => p.path === "sphinx/pycode/ast.py")!;
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.beforeDiscovered, true);
  assert.equal(hidden.beforeInspected, false);
  assert.equal(hidden.afterInspected, true);
  assert.equal(hidden.conversion, "discovered_only_to_inspected");

  // checklist emitted false on the after side, yet tool log is ordered.
  assert.equal(pair.checklistEmittedAfter, false);
  assert.equal(pair.toolLogOrderedAfter, true);

  // Every required pair field is present and well-typed.
  const requiredKeys = [
    "beforeLabel", "afterLabel", "instanceId",
    "treatmentValidBefore", "treatmentValidAfter",
    "beforeTokens", "afterTokens", "tokenDelta", "tokenDeltaPct",
    "beforeCost", "afterCost", "costDelta", "costDeltaPct",
    "beforeResolved", "afterResolved", "resolvedChanged",
    "pivotCheckInjectedBefore", "pivotCheckInjectedAfter",
    "pivotCheckEnabledBefore", "pivotCheckEnabledAfter",
    "pivotCheckDisabledByFlagBefore", "pivotCheckDisabledByFlagAfter",
    "checklistEmittedBefore", "checklistEmittedAfter",
    "toolLogOrderedBefore", "toolLogOrderedAfter", "toolCallCountBefore", "toolCallCountAfter",
    "hiddenPivotCountBefore", "hiddenPivotCountAfter",
    "hiddenPivotsIgnoredBefore", "hiddenPivotsIgnoredAfter",
    "hiddenPivotsDiscoveredOnlyBefore", "hiddenPivotsDiscoveredOnlyAfter",
    "hiddenPivotsInspectedBefore", "hiddenPivotsInspectedAfter",
    "hiddenPivotsEditedBefore", "hiddenPivotsEditedAfter",
    "editedFilesBefore", "editedFilesAfter",
  ];
  for (const key of requiredKeys) {
    assert.ok(key in pair, `missing pair field: ${key}`);
  }

  // Token/cost deltas computed as after - before.
  assert.equal(pair.tokenDelta, pair.afterTokens - pair.beforeTokens);
  assert.ok(Math.abs(pair.costDelta - (pair.afterCost - pair.beforeCost)) < 1e-9);

  // Hidden-pivot count summary reflects the conversion.
  assert.equal(pair.hiddenPivotsDiscoveredOnlyBefore, 1);
  assert.equal(pair.hiddenPivotsInspectedAfter, 1);

  // Summary aggregates.
  assert.equal(report.summary.pairCount, 1);
  assert.equal(report.summary.hiddenPivotsConverted, 1);
  assert.equal(report.summary.hiddenPivotsRegressed, 0);
  assert.equal(report.summary.conversionCounts["discovered_only_to_inspected"], 1);
});

test("renderMarkdown includes every required section and all non-claims", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pivot-check-md-"));
  const runsDir = path.join(tmp, "runs");
  await scaffoldSphinxLikePair(runsDir);
  const report = await buildReport(
    [{ beforeLabel: "before-lbl", afterLabel: "after-lbl" }],
    { runsDir },
    null,
  );

  const md = renderMarkdown(report);
  for (const section of [
    "# Stage 5 Pivot Check comparison",
    "## Summary",
    "## Compared runs",
    "## Hidden pivot conversion",
    "## Tool evidence",
    "## Cost / token delta",
    "## Patch / resolution outcome",
    "## Interpretation",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(section), `markdown missing section: ${section}`);
  }
  for (const claim of NON_CLAIMS) {
    assert.ok(md.includes(claim), `markdown missing non-claim: ${claim}`);
  }
  // The interpretation names the actual compared instance, not a hard-coded case.
  assert.ok(md.includes(buildInterpretation(report.pairs, report.summary)));
  assert.ok(md.includes("On sphinx-doc__sphinx-7462, PIVOT_CHECK converted"));
  // The checklist-vs-tools distinction must be stated.
  assert.ok(md.includes("Ordered tool evidence"));
});

test("pivotCheckStateLabel disambiguates disabled-by-flag from a naturally-absent injection", () => {
  // Controlled before run: --disable-pivot-check was passed.
  assert.equal(pivotCheckStateLabel(false, false, true), "disabled (flag)");
  // Default after run: block actually injected.
  assert.equal(pivotCheckStateLabel(true, true, false), "injected");
  // Enabled but nothing to inject (e.g. single-pivot capsule) — NOT a flag-disable.
  assert.equal(pivotCheckStateLabel(false, true, false), "enabled, not injected");
  // Older run with no flag meta but a present block.
  assert.equal(pivotCheckStateLabel(true, null, null), "injected");
  // Older run with no flag meta and no block.
  assert.equal(pivotCheckStateLabel(false, null, null), "not injected");
});

test("report carries and renders PIVOT_CHECK enabled/disabled-by-flag state per side", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pivot-check-state-"));
  const runsDir = path.join(tmp, "runs");
  await scaffoldSphinxLikePair(runsDir);
  const report = await buildReport(
    [{ beforeLabel: "before-lbl", afterLabel: "after-lbl" }],
    { runsDir },
    null,
  );

  const pair = report.pairs[0]!;
  // The before run is a controlled PIVOT_CHECK-off run; the after run has it on.
  assert.equal(pair.pivotCheckDisabledByFlagBefore, true);
  assert.equal(pair.pivotCheckEnabledBefore, false);
  assert.equal(pair.pivotCheckDisabledByFlagAfter, false);
  assert.equal(pair.pivotCheckEnabledAfter, true);

  const md = renderMarkdown(report);
  // The disambiguated state is rendered so a before run is not read as a failed
  // injection.
  assert.ok(md.includes("PIVOT_CHECK state (before→after)"));
  assert.ok(md.includes("disabled (flag) → injected"));
});

test("renderJson contains the expected summary fields and is valid JSON", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pivot-check-json-"));
  const runsDir = path.join(tmp, "runs");
  await scaffoldSphinxLikePair(runsDir);
  const report = await buildReport(
    [{ beforeLabel: "before-lbl", afterLabel: "after-lbl" }],
    { runsDir },
    null,
  );

  const parsed = JSON.parse(renderJson(report));
  assert.ok("summary" in parsed);
  for (const key of ["pairCount", "hiddenPivotsConverted", "hiddenPivotsRegressed", "conversionCounts"]) {
    assert.ok(key in parsed.summary, `summary missing field: ${key}`);
  }
  assert.ok(Array.isArray(parsed.pairs));
  assert.ok(Array.isArray(parsed.nonClaims));
  assert.equal(parsed.nonClaims.length, NON_CLAIMS.length);
  assert.equal(parsed.scope.length > 0, true);
});

// --------------------------------------------------------------------------
// Wording: interpretation names the actual instance; non-claims are generic.
// --------------------------------------------------------------------------

test("single-pair interpretation names the actual instance, not a hard-coded sphinx", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pivot-check-seaborn-"));
  const runsDir = path.join(tmp, "runs");
  await scaffoldSeabornLikePair(runsDir);
  const report = await buildReport(
    [{ beforeLabel: "seaborn-before", afterLabel: "seaborn-after" }],
    { runsDir },
    null,
  );

  // The Interpretation refers to seaborn, never sphinx.
  assert.ok(report.safeInterpretation.includes("On mwaskom__seaborn-3187, PIVOT_CHECK converted"));
  assert.ok(report.safeInterpretation.includes("to inspected"));
  assert.ok(!report.safeInterpretation.toLowerCase().includes("sphinx"));

  const md = renderMarkdown(report);
  assert.ok(md.includes("On mwaskom__seaborn-3187, PIVOT_CHECK converted"));
  assert.ok(!md.includes("On sphinx-7462"));
});

test("non-claim wording is generic, not pinned to sphinx-7462", () => {
  // No non-claim hard-codes a single instance id.
  for (const claim of NON_CLAIMS) {
    assert.ok(!claim.includes("sphinx-7462"), `non-claim should be generic: ${claim}`);
  }
  // The generic broad-improvement non-claim is present.
  assert.ok(
    NON_CLAIMS.some((c) => c.includes("targeted live runs do not prove broad benchmark improvement")),
    "expected a generic 'targeted live runs do not prove broad benchmark improvement' non-claim",
  );
});

test("buildInterpretation reads differently for single vs multiple pairs", () => {
  const single = buildInterpretation(
    [{ instanceId: "mwaskom__seaborn-3187" } as never],
    {
      pairCount: 1, hiddenPivotsConverted: 1, hiddenPivotsConvertedToInspected: 1,
      hiddenPivotsConvertedToEdited: 0, hiddenPivotsRegressed: 0, editedFileSetChangedCount: 0,
      costIncreasedCount: 1, tokenIncreasedCount: 1, dockerEvaluatedCount: 0, conversionCounts: {},
    },
  );
  assert.ok(single.startsWith("On mwaskom__seaborn-3187, PIVOT_CHECK converted one hidden pivot"));

  const multi = buildInterpretation(
    [{ instanceId: "a" } as never, { instanceId: "b" } as never],
    {
      pairCount: 2, hiddenPivotsConverted: 2, hiddenPivotsConvertedToInspected: 2,
      hiddenPivotsConvertedToEdited: 0, hiddenPivotsRegressed: 0, editedFileSetChangedCount: 0,
      costIncreasedCount: 2, tokenIncreasedCount: 2, dockerEvaluatedCount: 0, conversionCounts: {},
    },
  );
  assert.ok(multi.includes("Across 2 targeted pairs"));
  assert.ok(multi.includes("2 hidden pivots from ignored / discovered-only to inspected"));
  assert.ok(multi.includes("No hidden pivots were converted to edited"));
  assert.ok(multi.includes("no edited-file-set changes were observed"));
  assert.ok(multi.includes("inspection-enforcement mechanism, not yet as a patch-quality"));
});

// --------------------------------------------------------------------------
// Aggregate: multi-pair report headline numbers + concise rollup table.
// --------------------------------------------------------------------------

test("multi-pair aggregate report carries the correct headline totals and rollup", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pivot-check-aggregate-"));
  const runsDir = path.join(tmp, "runs");
  await scaffoldSphinxLikePair(runsDir);
  await scaffoldSeabornLikePair(runsDir);

  const report = await buildReport(
    [
      { beforeLabel: "before-lbl", afterLabel: "after-lbl" },
      { beforeLabel: "seaborn-before", afterLabel: "seaborn-after" },
    ],
    { runsDir },
    null,
  );

  const s = report.summary;
  assert.equal(s.pairCount, 2);
  // Two hidden pivots reached inspected; none reached edited.
  assert.equal(s.hiddenPivotsConvertedToInspected, 2);
  assert.equal(s.hiddenPivotsConvertedToEdited, 0);
  assert.equal(s.hiddenPivotsConverted, 2);
  assert.equal(s.hiddenPivotsRegressed, 0);
  // No pair changed its edited-file set; both cost and tokens went up on both.
  assert.equal(s.editedFileSetChangedCount, 0);
  assert.equal(s.costIncreasedCount, 2);
  assert.equal(s.tokenIncreasedCount, 2);
  // Neither pair was Docker-evaluated in these reports.
  assert.equal(s.dockerEvaluatedCount, 0);

  const md = renderMarkdown(report);
  // Headline numbers are rendered explicitly.
  assert.ok(md.includes("Compared targeted pairs: 2"));
  assert.ok(md.includes("Hidden pivots converted to inspected: 2"));
  assert.ok(md.includes("Hidden pivots converted to edited: 0"));
  assert.ok(md.includes("Edited-file-set changes: 0"));
  assert.ok(md.includes("Cost increased: 2/2"));
  assert.ok(md.includes("Token count increased: 2/2"));
  assert.ok(md.includes("Docker evaluated: no / not in these reports"));
  // The concise rollup table is present with both instances.
  assert.ok(md.includes("## Targeted summary"));
  assert.ok(md.includes("| instance | hidden pivot conversion | before edited files |"));
  assert.ok(md.includes("sphinx-doc__sphinx-7462"));
  assert.ok(md.includes("mwaskom__seaborn-3187"));
  // Honest aggregate interpretation: inspection improved, edits did not.
  assert.ok(md.includes("Across 2 targeted pairs"));
  assert.ok(md.includes("inspection-enforcement mechanism, not yet as a patch-quality"));

  // JSON exposes the aggregate fields for automation.
  const parsed = JSON.parse(renderJson(report));
  for (const key of [
    "pairCount", "hiddenPivotsConvertedToInspected", "hiddenPivotsConvertedToEdited",
    "editedFileSetChangedCount", "costIncreasedCount", "tokenIncreasedCount", "dockerEvaluatedCount",
  ]) {
    assert.ok(key in parsed.summary, `aggregate summary missing field: ${key}`);
  }
});

test("editedFileSetChanged and hiddenConversionsFor summarize a pair correctly", () => {
  const base = {
    editedFilesBefore: ["a.py", "b.py"],
    editedFilesAfter: ["b.py", "a.py"], // same set, different order
    pivots: [
      { hidden: true, conversion: "discovered_only_to_inspected" },
      { hidden: false, conversion: "ignored_to_inspected" },
    ],
  } as never as import("./run_stage5_pivot_check_report").PivotCheckPair;
  assert.equal(editedFileSetChanged(base), false);
  assert.equal(hiddenConversionsFor(base), "discovered_only_to_inspected");

  const changed = { ...base, editedFilesAfter: ["a.py", "c.py"] } as never as
    import("./run_stage5_pivot_check_report").PivotCheckPair;
  assert.equal(editedFileSetChanged(changed), true);

  const noHidden = { ...base, pivots: [{ hidden: false, conversion: "unchanged_edited" }] } as never as
    import("./run_stage5_pivot_check_report").PivotCheckPair;
  assert.equal(hiddenConversionsFor(noHidden), "—");
});

// --------------------------------------------------------------------------
// buildPair unit (in-memory runs, no disk) + missing-row degradation.
// --------------------------------------------------------------------------

test("buildPair handles a missing JSONL row by zeroing tokens/cost without crashing", () => {
  const emptyRun: PivotCheckRun = {
    label: "missing",
    row: null,
    treatmentValid: null,
    pivotCheckInjected: false,
    pivotCheckEnabled: null,
    pivotCheckDisabledByFlag: null,
    checklistEmitted: null,
    toolLogOrdered: null,
    toolCallCount: null,
    records: [],
    editedFiles: [],
    hiddenCounts: { ignored: 0, discoveredOnly: 0, inspected: 0, edited: 0 },
  };
  const pair = buildPair(emptyRun, emptyRun);
  assert.equal(pair.beforeTokens, 0);
  assert.equal(pair.afterCost, 0);
  assert.equal(pair.tokenDeltaPct, 0);
  assert.equal(pair.pivots.length, 0);
});

// --------------------------------------------------------------------------
// CLI parsing
// --------------------------------------------------------------------------

test("parsePairArg requires a two-label comma pair", () => {
  assert.deepEqual(parsePairArg("a,b"), { beforeLabel: "a", afterLabel: "b" });
  assert.throws(() => parsePairArg("only-one"));
  assert.throws(() => parsePairArg("a,"));
});

test("parseReportArgs derives runsDir/outDir from --results and collects pairs", () => {
  const config = parseReportArgs([
    "--results", "/tmp/res",
    "--pair", "b1,a1",
    "--pair", "b2,a2",
    "--report-name", "my_report",
  ]);
  assert.equal(config.runsDir, path.join("/tmp/res", "runs"));
  assert.equal(config.outDir, "/tmp/res");
  assert.equal(config.reportName, "my_report");
  assert.equal(config.pairs.length, 2);
  assert.throws(() => parseReportArgs(["--results", "/tmp/res"]), /At least one --pair/);
});

test("summarize tallies conversions and counts only hidden pivots toward conversion", () => {
  const pivots = [
    { path: "h.py", symbol: "s", role: "pivot" as const, hidden: true },
    { path: "v.py", symbol: "t", role: "pivot" as const, hidden: false },
  ];
  const before = classifyPivotInspection(pivots, [{ tool: "Grep", target: "h.py" }], []);
  const after = classifyPivotInspection(
    pivots,
    [{ tool: "Read", target: "h.py" }, { tool: "Read", target: "v.py" }],
    [],
  );
  const rows = buildConversionRows(before, after);
  const pair = buildPair(
    {
      label: "b", row: null, treatmentValid: null, pivotCheckInjected: false,
      pivotCheckEnabled: false, pivotCheckDisabledByFlag: true,
      checklistEmitted: null, toolLogOrdered: true, toolCallCount: 1, records: before,
      editedFiles: [], hiddenCounts: { ignored: 1, discoveredOnly: 1, inspected: 0, edited: 0 },
    },
    {
      label: "a", row: null, treatmentValid: null, pivotCheckInjected: true,
      pivotCheckEnabled: true, pivotCheckDisabledByFlag: false,
      checklistEmitted: false, toolLogOrdered: true, toolCallCount: 2, records: after,
      editedFiles: [], hiddenCounts: { ignored: 0, discoveredOnly: 0, inspected: 1, edited: 0 },
    },
  );
  assert.deepEqual(
    pair.pivots.map((p) => p.conversion),
    rows.map((r) => r.conversion),
  );
  const summary = summarize([pair]);
  // Hidden pivot converted; the visible pivot's ignored->inspected does not count.
  assert.equal(summary.hiddenPivotsConverted, 1);
});

// --------------------------------------------------------------------------
// Edit-relevance subset (curated): accounting that distinguishes "converted to
// inspected" (telemetry) from "edit-target conversion" (curated edit-relevance).
// --------------------------------------------------------------------------

test("summarizeEditRelevance separates edit-relevant inspection from edit conversion", () => {
  const er = summarizeEditRelevance(EDIT_RELEVANCE_FIXTURE);
  assert.equal(er.annotated, 2);
  assert.equal(er.editRelevantInspected, 1);
  assert.equal(er.editRelevantConvertedToEdited, 0);
  assert.equal(er.nonEditRelevantInspected, 1);
  // Effective N for "does inspection convert to an edit?" is only the edit-relevant
  // inspected subset — NOT the total targeted pair count.
  assert.equal(er.effectiveNForEditConversion, 1);
});

test("non-edit-relevant inspected pivots are not counted as edit-conversion failures", () => {
  const er = summarizeEditRelevance(EDIT_RELEVANCE_FIXTURE);
  // seaborn was inspected but not edit-relevant: it must not inflate the
  // edit-conversion denominator.
  assert.equal(er.effectiveNForEditConversion, 1);
  assert.notEqual(er.effectiveNForEditConversion, EDIT_RELEVANCE_FIXTURE.length);
  // It is still recorded as a non-edit-relevant inspection, not dropped.
  assert.equal(er.nonEditRelevantInspected, 1);
});

test("buildReport attaches edit-relevance only when curated annotations are supplied", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pivot-check-er-attach-"));
  const runsDir = path.join(tmp, "runs");
  await scaffoldSphinxLikePair(runsDir);
  await scaffoldSeabornLikePair(runsDir);
  const specs = [
    { beforeLabel: "before-lbl", afterLabel: "after-lbl" },
    { beforeLabel: "seaborn-before", afterLabel: "seaborn-after" },
  ];

  // Without annotations: keys are omitted entirely (not invented).
  const plain = await buildReport(specs, { runsDir }, null);
  assert.equal(plain.editRelevance, undefined);
  assert.equal(plain.editRelevanceSummary, undefined);
  assert.equal("editRelevance" in JSON.parse(renderJson(plain)), false);

  // With annotations: report exposes both the curated array and the summary.
  const annotated = await buildReport(specs, { runsDir }, null, EDIT_RELEVANCE_FIXTURE);
  assert.equal(annotated.editRelevance?.length, 2);
  assert.equal(annotated.editRelevanceSummary?.effectiveNForEditConversion, 1);
});

test("aggregate markdown includes the Edit-relevance subset section, table, and headline numbers", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pivot-check-er-md-"));
  const runsDir = path.join(tmp, "runs");
  await scaffoldSphinxLikePair(runsDir);
  await scaffoldSeabornLikePair(runsDir);
  const report = await buildReport(
    [
      { beforeLabel: "before-lbl", afterLabel: "after-lbl" },
      { beforeLabel: "seaborn-before", afterLabel: "seaborn-after" },
    ],
    { runsDir },
    null,
    EDIT_RELEVANCE_FIXTURE,
  );
  const md = renderMarkdown(report);

  assert.ok(md.includes("## Edit-relevance subset"));
  // Curated provenance is explicit, not pretended automation.
  assert.ok(md.includes("CURATED post-inspection analysis"));
  // Table header + both annotated rows.
  assert.ok(md.includes("| instance | hidden pivot | classification | edit-relevant hidden pivot? |"));
  assert.ok(md.includes("sphinx/pycode/ast.py::unparse"));
  assert.ok(md.includes("seaborn/relational.py::scatterplot"));
  // Required headline numbers.
  assert.ok(md.includes("Targeted PIVOT_CHECK pairs: 2"));
  assert.ok(md.includes("Hidden pivots converted to inspected: 2"));
  assert.ok(md.includes("Known edit-relevant hidden pivots inspected: 1"));
  assert.ok(md.includes("Known edit-relevant hidden pivots converted to edited: 0"));
  assert.ok(md.includes("Known non-edit-relevant hidden pivots inspected: 1"));
  assert.ok(md.includes("Effective N for edit-target conversion: 1"));
});

test("edit-relevance-aware interpretation counts conversion over the relevant subset only", () => {
  const summary = summarize([]); // unused counts; interpretation reads editRelevance branch
  const text = buildInterpretation(
    [{ instanceId: "sphinx-doc__sphinx-7462" } as never, { instanceId: "mwaskom__seaborn-3187" } as never],
    { ...summary, pairCount: 2, hiddenPivotsConvertedToInspected: 2 },
    EDIT_RELEVANCE_FIXTURE,
  );
  assert.ok(text.includes("effective sample is only 1 case(s): sphinx-doc__sphinx-7462"));
  assert.ok(text.includes("inspection did not lead to editing the hidden pivot"));
  assert.ok(text.includes("mwaskom__seaborn-3187) were not actually edit targets"));
  // It must NOT read as two edit-conversion failures.
  assert.ok(!text.includes("2 edit"));
});

test("the aggregate report omits edit-relevance keys from JSON when not curated", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pivot-check-er-omit-"));
  const runsDir = path.join(tmp, "runs");
  await scaffoldSphinxLikePair(runsDir);
  const report = await buildReport(
    [{ beforeLabel: "before-lbl", afterLabel: "after-lbl" }],
    { runsDir },
    null,
  );
  const parsed = JSON.parse(renderJson(report));
  assert.equal("editRelevance" in parsed, false);
  assert.equal("editRelevanceSummary" in parsed, false);
  // And no Edit-relevance subset section is rendered.
  assert.ok(!renderMarkdown(report).includes("## Edit-relevance subset"));
});

test("parseEditRelevanceAnnotations validates shape and rejects malformed input", () => {
  const ok = parseEditRelevanceAnnotations(EDIT_RELEVANCE_FIXTURE);
  assert.equal(ok.length, 2);
  assert.equal(ok[0]!.editRelevant, true);
  // tri-state null is allowed.
  const withNull = parseEditRelevanceAnnotations([
    { ...EDIT_RELEVANCE_FIXTURE[0]!, editRelevant: null },
  ]);
  assert.equal(withNull[0]!.editRelevant, null);
  // Non-array, missing fields, and wrong types are rejected.
  assert.throws(() => parseEditRelevanceAnnotations({} as never), /must contain a JSON array/);
  assert.throws(
    () => parseEditRelevanceAnnotations([{ instanceId: "x" }] as never),
    /must be a non-empty string|must be a boolean/,
  );
  assert.throws(
    () => parseEditRelevanceAnnotations([{ ...EDIT_RELEVANCE_FIXTURE[0]!, editRelevant: "yes" }] as never),
    /editRelevant must be true, false, or null/,
  );
});

test("parseReportArgs captures --edit-relevance path", () => {
  const config = parseReportArgs([
    "--results", "/tmp/res",
    "--pair", "b1,a1",
    "--edit-relevance", "/tmp/res/edit_relevance.json",
  ]);
  assert.equal(config.editRelevancePath, "/tmp/res/edit_relevance.json");
  // Default is null when the flag is absent.
  const noFlag = parseReportArgs(["--results", "/tmp/res", "--pair", "b1,a1"]);
  assert.equal(noFlag.editRelevancePath, null);
});
