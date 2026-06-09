import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { classifyPivotInspection } from "../../src/capsule/finalEditDiagnostics";
import {
  NON_CLAIMS,
  SAFE_INTERPRETATION,
  buildConversionRows,
  buildPair,
  buildReport,
  classifyConversion,
  loadRun,
  parsePairArg,
  parseReportArgs,
  pivotPhase,
  renderJson,
  renderMarkdown,
  summarize,
  type PivotCheckRun,
} from "./run_stage5_pivot_check_report";

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
  assert.ok(md.includes(SAFE_INTERPRETATION));
  // The checklist-vs-tools distinction must be stated.
  assert.ok(md.includes("Ordered tool evidence"));
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
// buildPair unit (in-memory runs, no disk) + missing-row degradation.
// --------------------------------------------------------------------------

test("buildPair handles a missing JSONL row by zeroing tokens/cost without crashing", () => {
  const emptyRun: PivotCheckRun = {
    label: "missing",
    row: null,
    treatmentValid: null,
    pivotCheckInjected: false,
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
      checklistEmitted: null, toolLogOrdered: true, toolCallCount: 1, records: before,
      editedFiles: [], hiddenCounts: { ignored: 1, discoveredOnly: 1, inspected: 0, edited: 0 },
    },
    {
      label: "a", row: null, treatmentValid: null, pivotCheckInjected: true,
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
