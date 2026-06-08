// Stage 5R retrieval-eval tests.
//
// Pure scoring (file/symbol role, top-1/top-3, aggregate, report rendering) is
// exercised with injected CapsuleSummary values — no DB required. Two tests use a
// real on-disk indexed workspace (real parser) to prove (a) production retrieval
// is a pure function of (task, intent, budget) — expected labels never reach it —
// and (b) a missing workspace is reported as workspace_error, not a crash.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { indexProject } from "../../src/indexer/indexProject";
import {
  aggregate,
  aggregateByLabelSource,
  aggregateByRepo,
  assertNoUnexpectedDuplicates,
  classifyMiss,
  comparisonBaselineFor,
  renderComparison,
  renderMissSummary,
  CROSS_REPO_16_BASELINE,
  expectedFilesAreUnparsedLanguage,
  evaluateEntryLive,
  evaluateExpectedFile,
  evaluateExpectedSymbol,
  evaluateInstance,
  extractChangedFromDiff,
  extractExpectedLabelsFromJsonl,
  fileMatches,
  isLabelSource,
  loadRetrievalFixture,
  parseArgs,
  rankedFiles,
  renderByRepoTable,
  renderCsv,
  renderMarkdown,
  runRetrievalEval,
  taskHasBodyLiteral,
  summarizeCapsule,
  symbolMatches,
  taskHasLineAnchor,
  topKDiagnostics,
  validateFixtureEntry,
  validateFixtureOnDisk,
  writeReports,
  type CapsuleSummary,
  type RetrievalEvalArtifact,
  type RetrievalEvalFixtureEntry,
  type SelectedItem,
} from "./run_stage5_retrieval_eval";

// --- builders ----------------------------------------------------------------

function entry(overrides: Partial<RetrievalEvalFixtureEntry> = {}): RetrievalEvalFixtureEntry {
  return {
    instance_id: "x__y-1",
    repo: "x/y",
    workspace: "/tmp/does-not-matter",
    task: "fix the thing",
    intent: "debug",
    budget: 8000,
    label_source: "gold_patch",
    expected_files: ["pkg/target.py"],
    expected_symbols: ["do_thing"],
    ...overrides,
  };
}

function selected(
  role: "pivot" | "support",
  file: string,
  symbol: string,
  final = 1,
  signals: Partial<Pick<SelectedItem, "roleReason" | "isEntryPoint" | "isGenericInfrastructure">> = {},
): SelectedItem {
  return {
    role,
    path: file,
    symbol,
    fqName: `${file}::${symbol}`,
    final,
    roleReason: signals.roleReason ?? `${role} by score`,
    isEntryPoint: signals.isEntryPoint ?? false,
    isGenericInfrastructure: signals.isGenericInfrastructure ?? false,
  };
}

function summary(overrides: Partial<CapsuleSummary> = {}): CapsuleSummary {
  return {
    intent: "debug",
    actualMode: "standard",
    budgetTokens: 8000,
    estimatedTokens: 400,
    usedPercent: 5,
    pivots: [],
    support: [],
    discarded: [],
    candidateCount: 10,
    subsystemRoot: null,
    lineAnchorResolutionUsed: false,
    filteredGenericSymbols: [],
    filteredRunnerFiles: [],
    downweightedLexicalTokens: [],
    deanchoredExceptionTokens: [],
    bodyLiteralMatches: [],
    nonSourceDownranked: [],
    titleSymbolTerms: [],
    titleSymbolMatches: [],
    literalAnchorTerms: [],
    literalAnchorMatches: [],
    genericLexicalDecoysSuppressed: [],
    ...overrides,
  };
}

// --- fixture loading ---------------------------------------------------------

test("loadRetrievalFixture parses the real Django fixture", async () => {
  const fixture = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "retrieval_eval.django.json");
  const entries = await loadRetrievalFixture(fixture);
  assert.equal(entries.length, 5);
  const ids = entries.map((e) => e.instance_id).sort();
  assert.deepEqual(ids, [
    "django__django-10880",
    "django__django-11095",
    "django__django-11490",
    "django__django-11728",
    "django__django-11740",
  ]);
  // 10880 is the aggregates task, NOT html.py/json_script.
  const i10880 = entries.find((e) => e.instance_id === "django__django-10880")!;
  assert.deepEqual(i10880.expected_files, ["django/db/models/aggregates.py"]);
  for (const e of entries) {
    assert.ok(e.workspace.length > 0 && e.task.length > 0);
  }
});

test("validateFixtureEntry rejects a row with no expected_files", () => {
  assert.throws(
    () => validateFixtureEntry({ instance_id: "a", repo: "r", workspace: "w", task: "t", expected_files: [] }, 0),
    /at least one expected_files/,
  );
});

test("validateFixtureEntry rejects a row missing workspace", () => {
  assert.throws(
    () => validateFixtureEntry({ instance_id: "a", repo: "r", task: "t", expected_files: ["f"] }, 0),
    /missing workspace/,
  );
});

// --- file matching + role ----------------------------------------------------

test("fileMatches is boundary-aware", () => {
  assert.ok(fileMatches("django/contrib/admindocs/utils.py", "django/contrib/admindocs/utils.py"));
  assert.ok(fileMatches("admindocs/utils.py", "django/contrib/admindocs/utils.py"));
  assert.ok(!fileMatches("utils.py", "django/contrib/admindocs_utils.py"));
});

test("expected file role: pivot at rank 1 (top-1 + top-3)", () => {
  const s = summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing", 2)] });
  const r = evaluateExpectedFile(["pkg/target.py"], s);
  assert.equal(r.role, "pivot");
  assert.equal(r.rank, 1);
});

test("expected file role: support when only present in support", () => {
  const s = summary({
    pivots: [selected("pivot", "pkg/other.py", "other", 2)],
    support: [selected("support", "pkg/target.py", "do_thing", 1)],
  });
  const r = evaluateExpectedFile(["pkg/target.py"], s);
  assert.equal(r.role, "support");
  assert.equal(r.rank, 2);
});

test("expected file role: discarded when only present in discarded", () => {
  const s = summary({
    pivots: [selected("pivot", "pkg/other.py", "other")],
    discarded: [{ path: "pkg/target.py", symbol: "do_thing", fqName: "", reason: "a test symbol" }],
  });
  const r = evaluateExpectedFile(["pkg/target.py"], s);
  assert.equal(r.role, "discarded");
  assert.equal(r.rank, null);
});

test("expected file role: missing when not surfaced at all", () => {
  const s = summary({ pivots: [selected("pivot", "pkg/other.py", "other")] });
  const r = evaluateExpectedFile(["pkg/target.py"], s);
  assert.equal(r.role, "missing");
  assert.equal(r.rank, null);
});

test("top-3 ranking is pivots-then-support, de-duplicated", () => {
  const s = summary({
    pivots: [selected("pivot", "a.py", "a"), selected("pivot", "b.py", "b")],
    support: [selected("support", "a.py", "a2"), selected("support", "c.py", "c")],
  });
  assert.deepEqual(rankedFiles(s), ["a.py", "b.py", "c.py"]);
  const r = evaluateExpectedFile(["c.py"], s);
  assert.equal(r.rank, 3);
});

// --- symbol matching ---------------------------------------------------------

test("symbolMatches accepts Class.method against a bare method item", () => {
  const item = { symbol: "get_inline_instances", fqName: "django/contrib/admin/options.py::ModelAdmin.get_inline_instances" };
  assert.ok(symbolMatches("ModelAdmin.get_inline_instances", item));
  assert.ok(symbolMatches("get_inline_instances", item));
  assert.ok(!symbolMatches("get_inlines", item));
});

test("evaluateExpectedSymbol finds a pivot symbol and its rank", () => {
  const s = summary({
    pivots: [selected("pivot", "options.py", "get_inline_instances", 2)],
    support: [selected("support", "options.py", "ModelAdmin", 1)],
  });
  const r = evaluateExpectedSymbol(["ModelAdmin.get_inline_instances"], s);
  assert.equal(r.role, "pivot");
  assert.equal(r.rank, 1);
});

test("evaluateExpectedSymbol reports missing when no expected symbol surfaces", () => {
  const s = summary({ pivots: [selected("pivot", "options.py", "unrelated")] });
  assert.equal(evaluateExpectedSymbol(["get_inlines"], s).role, "missing");
});

// --- per-instance result classification --------------------------------------

test("evaluateInstance: hit_top1_pivot", () => {
  const s = summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing", 2)] });
  const row = evaluateInstance(entry(), s);
  assert.equal(row.result, "hit_top1_pivot");
  assert.equal(row.contains_expected_file_top1, true);
  assert.equal(row.failure_reason, null);
});

test("evaluateInstance: hit_top3 when expected file is a non-first pivot", () => {
  const s = summary({
    pivots: [selected("pivot", "pkg/other.py", "other", 3), selected("pivot", "pkg/target.py", "do_thing", 2)],
  });
  const row = evaluateInstance(entry(), s);
  assert.equal(row.result, "hit_top3");
  assert.equal(row.contains_expected_file_top1, false);
  assert.equal(row.contains_expected_file_top3, true);
});

test("evaluateInstance: hit_discarded surfaces the discard reason", () => {
  const s = summary({
    pivots: [selected("pivot", "pkg/other.py", "other")],
    discarded: [{ path: "pkg/target.py", symbol: "do_thing", fqName: "", reason: "a test symbol" }],
  });
  const row = evaluateInstance(entry(), s);
  assert.equal(row.result, "hit_discarded");
  assert.match(row.failure_reason ?? "", /discarded/);
});

test("evaluateInstance: missing", () => {
  const row = evaluateInstance(entry(), summary({ pivots: [selected("pivot", "pkg/other.py", "other")] }));
  assert.equal(row.result, "missing");
});

test("evaluateInstance: skipped_no_context", () => {
  const row = evaluateInstance(entry(), summary({ actualMode: "no_context", pivots: [] }));
  assert.equal(row.result, "skipped_no_context");
});

test("evaluateInstance: workspace_error from an injected error", () => {
  const row = evaluateInstance(entry(), null, { kind: "workspace_error", detail: "no index" });
  assert.equal(row.result, "workspace_error");
  assert.equal(row.actual_mode, null);
  assert.equal(row.failure_reason, "no index");
});

// --- aggregate ---------------------------------------------------------------

test("aggregate computes rates over evaluated rows only", () => {
  const rows = [
    evaluateInstance(entry({ instance_id: "a" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] })),
    evaluateInstance(entry({ instance_id: "b" }), summary({ pivots: [selected("pivot", "pkg/other.py", "other")] })),
    evaluateInstance(entry({ instance_id: "c" }), null, { kind: "workspace_error", detail: "x" }),
  ];
  const a = aggregate(rows);
  assert.equal(a.instances_total, 3);
  assert.equal(a.instances_evaluated, 2); // workspace_error excluded
  assert.equal(a.workspace_error_count, 1);
  assert.equal(a.top_1_file_accuracy, 0.5);
  assert.equal(a.expected_file_as_pivot_rate, 0.5);
  assert.equal(a.expected_file_missing_rate, 0.5);
  assert.equal(a.mean_pivot_count, 1);
});

// --- report rendering --------------------------------------------------------

function artifactOf(rows: RetrievalEvalArtifact["rows"]): RetrievalEvalArtifact {
  return {
    generatedFrom: { fixture: "f.json", resultsDir: "out", builder: "buildCapsuleV2" },
    rows,
    aggregate: aggregate(rows),
    byLabelSource: aggregateByLabelSource(rows),
    byRepo: aggregateByRepo(rows),
  };
}

test("Stage 5R rows + CSV surface title-symbol diagnostics from the capsule summary", () => {
  const row = evaluateInstance(
    entry({ instance_id: "ts1" }),
    summary({
      pivots: [selected("pivot", "pkg/pycode.py", "PythonCodePrinter")],
      titleSymbolTerms: ["PythonCodePrinter"],
      titleSymbolMatches: ["PythonCodePrinter -> pkg/pycode.py::PythonCodePrinter"],
    }),
  );
  assert.deepEqual(row.title_symbol_terms, ["PythonCodePrinter"]);
  assert.deepEqual(row.title_symbol_matches, ["PythonCodePrinter -> pkg/pycode.py::PythonCodePrinter"]);
  const csv = renderCsv([row]);
  assert.match(csv.split("\n")[0]!, /title_symbol_terms,title_symbol_matches/);
  assert.match(csv.split("\n")[1]!, /PythonCodePrinter -> pkg\/pycode\.py::PythonCodePrinter/);
});

test("renderCsv emits a header row and one row per instance", () => {
  const rows = [evaluateInstance(entry({ instance_id: "a" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] }))];
  const csv = renderCsv(rows);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^instance_id,repo,label_source,intent,actual_mode/);
  assert.match(lines[1]!, /^a,x\/y,gold_patch,debug,standard/);
});

test("renderMarkdown includes scope, metrics, per-instance table, and the label-only note", () => {
  const rows = [
    evaluateInstance(entry({ instance_id: "hit" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] })),
    evaluateInstance(entry({ instance_id: "miss" }), summary({ pivots: [selected("pivot", "pkg/other.py", "o")] })),
  ];
  const md = renderMarkdown(artifactOf(rows));
  assert.match(md, /## Scope/);
  assert.match(md, /## Methodology/);
  assert.match(md, /## Aggregate metrics/);
  assert.match(md, /## Per-instance results/);
  assert.match(md, /\| hit \|.*hit_top1_pivot \|/);
  assert.match(md, /## Misses \/ failures/);
  assert.match(md, /EVALUATION LABELS only/);
});

// --- expected-label extraction helper ----------------------------------------

test("extractChangedFromDiff pulls files and def/class symbols from a unified diff", () => {
  const patch = [
    "diff --git a/django/db/models/aggregates.py b/django/db/models/aggregates.py",
    "--- a/django/db/models/aggregates.py",
    "+++ b/django/db/models/aggregates.py",
    "@@ -50,7 +50,7 @@ class Aggregate(Func):",
    "     def as_sql(self, compiler, connection, **extra_context):",
    "-        return 'DISTINCT'",
    "+        return 'DISTINCT '",
    "",
  ].join("\n");
  const changed = extractChangedFromDiff(patch);
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.file, "django/db/models/aggregates.py");
  assert.ok(changed[0]!.symbols.includes("Aggregate"));
});

test("extractExpectedLabelsFromJsonl aggregates changed files per instance", () => {
  const jsonl = [
    JSON.stringify({ instanceId: "x__y-1", modelPatch: "+++ b/pkg/a.py\n@@ @@ def foo():\n" }),
    JSON.stringify({ instanceId: "x__y-1", modelPatch: "+++ b/pkg/b.py\n" }),
    "not json",
  ].join("\n");
  const labels = extractExpectedLabelsFromJsonl(jsonl);
  assert.equal(labels.length, 1);
  assert.deepEqual(labels[0]!.changed_files, ["pkg/a.py", "pkg/b.py"]);
  assert.ok(labels[0]!.changed_symbols_guess.includes("foo"));
});

// --- live: no label leak + workspace_error -----------------------------------

// Build a small on-disk indexed workspace with the real parser pipeline.
async function indexedWorkspace(prefix: string, files: Record<string, string>): Promise<string> {
  const repoRoot = mkdtempSync(path.join(tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repoRoot, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  mkdirSync(path.join(repoRoot, ".vtrace"), { recursive: true });
  const db = openIndexerDatabase(path.join(repoRoot, ".vtrace", "index.sqlite"));
  try {
    await indexProject({ repoRoot, db });
  } finally {
    db.close();
  }
  return repoRoot;
}

const PARSER_FILES: Record<string, string> = {
  "pkg/widget.py":
    "class Widget:\n" +
    '    """A widget."""\n\n' +
    "    def render_widget(self, ctx):\n" +
    "        return ctx\n",
};

test("production retrieval is a pure function of (task,intent,budget) — expected labels never leak in", async () => {
  const workspace = await indexedWorkspace("vtrace-r5r-leak-", PARSER_FILES);

  // Same task/intent/budget, but wildly different expected labels. If retrieval
  // ever consulted the labels, the capsule would differ. It must not.
  const a = await evaluateEntryLive(
    entry({ workspace, task: "fix Widget.draw_widget rendering", expected_files: ["pkg/widget.py"], expected_symbols: ["render_widget"] }),
  );
  const b = await evaluateEntryLive(
    entry({ workspace, task: "fix Widget.draw_widget rendering", expected_files: ["totally/unrelated.py"], expected_symbols: ["nonexistent_symbol"] }),
  );
  assert.deepEqual(a, b);
});

test("runRetrievalEval reports a missing workspace as workspace_error, not a crash", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vtrace-r5r-ws-"));
  const fixturePath = path.join(dir, "fixture.json");
  writeFileSync(
    fixturePath,
    JSON.stringify([
      {
        instance_id: "missing__ws-1",
        repo: "x/y",
        workspace: path.join(dir, "does-not-exist"),
        task: "fix something",
        intent: "debug",
        budget: 8000,
        expected_files: ["pkg/target.py"],
        expected_symbols: ["do_thing"],
      },
    ]),
  );
  const artifact = await runRetrievalEval({ fixture: fixturePath, out: dir });
  assert.equal(artifact.rows.length, 1);
  assert.equal(artifact.rows[0]!.result, "workspace_error");
  assert.match(artifact.rows[0]!.failure_reason ?? "", /workspace not found/);
  assert.equal(artifact.aggregate.workspace_error_count, 1);
  assert.equal(artifact.aggregate.instances_evaluated, 0);
});

test("summarizeCapsule produces a usable summary shape from a live build", async () => {
  const workspace = await indexedWorkspace("vtrace-r5r-sum-", PARSER_FILES);
  const s = await evaluateEntryLive(entry({ workspace, task: "fix Widget.render_widget", expected_files: ["pkg/widget.py"] }));
  assert.ok(typeof s.actualMode === "string");
  assert.ok(Array.isArray(s.pivots) && Array.isArray(s.support) && Array.isArray(s.discarded));
  void summarizeCapsule;
});

// --- label source ------------------------------------------------------------

test("isLabelSource accepts the three sources and rejects others", () => {
  assert.ok(isLabelSource("gold_patch"));
  assert.ok(isLabelSource("passing_model_patch"));
  assert.ok(isLabelSource("manual_verified"));
  assert.ok(!isLabelSource("guess"));
  assert.ok(!isLabelSource(undefined));
});

test("validateFixtureEntry defaults a missing label_source to manual_verified", () => {
  const e = validateFixtureEntry(
    { instance_id: "a", repo: "r", workspace: "w", task: "t", expected_files: ["f"] },
    0,
  );
  assert.equal(e.label_source, "manual_verified");
});

test("validateFixtureEntry rejects an invalid label_source", () => {
  assert.throws(
    () => validateFixtureEntry(
      { instance_id: "a", repo: "r", workspace: "w", task: "t", expected_files: ["f"], label_source: "bogus" },
      0,
    ),
    /invalid label_source/,
  );
});

test("validateFixtureEntry preserves a declared gold_patch source", () => {
  const e = validateFixtureEntry(
    { instance_id: "a", repo: "r", workspace: "w", task: "t", expected_files: ["f"], label_source: "gold_patch" },
    0,
  );
  assert.equal(e.label_source, "gold_patch");
});

// --- duplicate instance handling ---------------------------------------------

test("assertNoUnexpectedDuplicates throws on a repeated id without allow_duplicate", () => {
  assert.throws(
    () => assertNoUnexpectedDuplicates([entry({ instance_id: "dup" }), entry({ instance_id: "dup" })]),
    /Duplicate instance_id dup/,
  );
});

test("assertNoUnexpectedDuplicates allows a repeat that opts in via allow_duplicate", () => {
  assert.doesNotThrow(() =>
    assertNoUnexpectedDuplicates([
      entry({ instance_id: "dup", label_source: "gold_patch" }),
      entry({ instance_id: "dup", label_source: "passing_model_patch", allow_duplicate: true }),
    ]),
  );
});

test("loadRetrievalFixture rejects a fixture with an un-opted duplicate id", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vtrace-r5r-dup-"));
  const fixturePath = path.join(dir, "dup.json");
  writeFileSync(
    fixturePath,
    JSON.stringify([
      { instance_id: "d", repo: "r", workspace: "w", task: "t", label_source: "gold_patch", expected_files: ["f"] },
      { instance_id: "d", repo: "r", workspace: "w", task: "t", label_source: "gold_patch", expected_files: ["g"] },
    ]),
  );
  await assert.rejects(() => loadRetrievalFixture(fixturePath), /Duplicate instance_id/);
});

// --- expected file / workspace validation ------------------------------------

test("validateFixtureOnDisk flags a missing workspace, absolute paths, and escapes", async () => {
  const entries: RetrievalEvalFixtureEntry[] = [
    entry({ instance_id: "ws", workspace: "/nope/does-not-exist", expected_files: ["pkg/a.py"] }),
    entry({ instance_id: "abs", workspace: "/nope/does-not-exist", expected_files: ["/etc/passwd"] }),
    entry({ instance_id: "esc", workspace: "/nope/does-not-exist", expected_files: ["../escape.py"] }),
    entry({ instance_id: "empty", workspace: "/nope/does-not-exist", task: "  ", expected_files: ["pkg/a.py"] }),
  ];
  const issues = await validateFixtureOnDisk(entries, new Set(["ws", "abs", "esc", "empty"]));
  const checks = issues.map((i) => i.check);
  assert.ok(checks.includes("workspace_missing"));
  assert.ok(checks.includes("expected_file_absolute"));
  assert.ok(checks.includes("expected_file_escapes_repo"));
  assert.ok(checks.includes("task_empty"));
});

test("validateFixtureOnDisk warns when a row had no declared label_source", async () => {
  const issues = await validateFixtureOnDisk(
    [entry({ instance_id: "nolabel", workspace: "/nope" })],
    new Set<string>(), // raw object declared no label_source
  );
  assert.ok(issues.some((i) => i.check === "label_source_missing" && i.severity === "warning"));
});

test("validateFixtureOnDisk passes a real indexed workspace with an existing expected file", async () => {
  const workspace = await indexedWorkspace("vtrace-r5r-val-", PARSER_FILES);
  const issues = await validateFixtureOnDisk(
    [entry({ instance_id: "ok", workspace, expected_files: ["pkg/widget.py"] })],
    new Set(["ok"]),
  );
  assert.equal(issues.filter((i) => i.severity === "error").length, 0);
});

test("validateFixtureOnDisk flags an expected file that is not in the workspace", async () => {
  const workspace = await indexedWorkspace("vtrace-r5r-valmiss-", PARSER_FILES);
  const issues = await validateFixtureOnDisk(
    [entry({ instance_id: "miss", workspace, expected_files: ["pkg/ghost.py"] })],
    new Set(["miss"]),
  );
  assert.ok(issues.some((i) => i.check === "expected_file_not_in_workspace"));
});

// --- gold vs passing_model_patch aggregation ---------------------------------

test("aggregateByLabelSource splits metrics by source", () => {
  const rows = [
    evaluateInstance(
      entry({ instance_id: "g1", label_source: "gold_patch" }),
      summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] }),
    ),
    evaluateInstance(
      entry({ instance_id: "g2", label_source: "gold_patch" }),
      summary({ pivots: [selected("pivot", "pkg/other.py", "other")] }),
    ),
    evaluateInstance(
      entry({ instance_id: "m1", label_source: "passing_model_patch" }),
      summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] }),
    ),
  ];
  const bySource = aggregateByLabelSource(rows);
  assert.ok(bySource.gold_patch && bySource.passing_model_patch);
  assert.equal(bySource.gold_patch!.instances_total, 2);
  assert.equal(bySource.gold_patch!.top_1_file_accuracy, 0.5);
  assert.equal(bySource.passing_model_patch!.instances_total, 1);
  assert.equal(bySource.passing_model_patch!.top_1_file_accuracy, 1);
  assert.equal(bySource.manual_verified, undefined); // no rows of that source
});

// --- miss taxonomy -----------------------------------------------------------

test("classifyMiss returns none for a top-3 hit", () => {
  const row = evaluateInstance(entry(), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] }));
  assert.equal(row.miss_category, "none");
});

test("classifyMiss: present_but_support when the expected file is only support", () => {
  const s = summary({
    pivots: [selected("pivot", "a.py", "a"), selected("pivot", "b.py", "b"), selected("pivot", "c.py", "c")],
    support: [selected("support", "pkg/target.py", "do_thing")],
  });
  const row = evaluateInstance(entry(), s);
  assert.equal(row.expected_file_role, "support");
  assert.equal(row.contains_expected_file_top3, false);
  assert.equal(row.miss_category, "present_but_support");
});

test("classifyMiss: test_symbol_pollution when expected file is discarded as a test", () => {
  const s = summary({
    pivots: [selected("pivot", "pkg/other.py", "other")],
    discarded: [{ path: "pkg/target.py", symbol: "do_thing", fqName: "", reason: "test symbol excluded" }],
  });
  const row = evaluateInstance(entry(), s);
  assert.equal(row.miss_category, "test_symbol_pollution");
});

test("classifyMiss: generic_infrastructure when the top pivot is generic infra", () => {
  const s = summary({
    pivots: [selected("pivot", "pkg/other.py", "other", 1, { isGenericInfrastructure: true })],
  });
  const cat = classifyMiss(
    { result: "missing", expected_file_role: "missing", contains_expected_file_top3: false, expected_files: ["pkg/target.py"] },
    s,
    "fix the thing",
  );
  assert.equal(cat, "generic_infrastructure_ranked_above_target");
});

test("classifyMiss: wrong_entry_point when the top pivot is an entry point", () => {
  const s = summary({ pivots: [selected("pivot", "pkg/other.py", "other", 1, { isEntryPoint: true })] });
  const cat = classifyMiss(
    { result: "missing", expected_file_role: "missing", contains_expected_file_top3: false, expected_files: ["pkg/target.py"] },
    s,
    "fix the thing",
  );
  assert.equal(cat, "wrong_entry_point");
});

test("classifyMiss: line_anchor_not_resolved when the task cites an anchor that did not resolve", () => {
  const s = summary({ pivots: [selected("pivot", "pkg/other.py", "other")], lineAnchorResolutionUsed: false });
  const cat = classifyMiss(
    { result: "missing", expected_file_role: "missing", contains_expected_file_top3: false, expected_files: ["pkg/target.py"] },
    s,
    "see compiler.py#L428-L433 for the bug",
  );
  assert.equal(cat, "line_anchor_not_resolved");
});

test("classifyMiss: workspace_error and fixture_label_error from the result", () => {
  const wsRow = { result: "workspace_error" as const, expected_file_role: "missing" as const, contains_expected_file_top3: false, expected_files: ["x"] };
  assert.equal(classifyMiss(wsRow, null, "t"), "workspace_error");
  const fxRow = { result: "fixture_error" as const, expected_file_role: "missing" as const, contains_expected_file_top3: false, expected_files: ["x"] };
  assert.equal(classifyMiss(fxRow, null, "t"), "fixture_label_error");
});

test("aggregate tallies the miss taxonomy across rows", () => {
  const rows = [
    evaluateInstance(entry({ instance_id: "hit" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] })),
    evaluateInstance(entry({ instance_id: "miss" }), summary({ pivots: [selected("pivot", "pkg/other.py", "o")] })),
  ];
  const a = aggregate(rows);
  assert.equal(a.miss_taxonomy.none, 1);
  assert.equal(a.miss_taxonomy.missing_from_candidates, 1);
});

// --- top-k diagnostics -------------------------------------------------------

test("topKDiagnostics returns role-reasoned pivots/support and discard reasons", () => {
  const s = summary({
    pivots: [selected("pivot", "a.py", "a", 1, { roleReason: "actual edit site" })],
    support: [selected("support", "b.py", "b", 1, { roleReason: "caller context" })],
    discarded: [{ path: "t.py", symbol: "test_x", fqName: "", reason: "test symbol" }],
  });
  const d = topKDiagnostics(s);
  assert.equal(d.top_pivots[0]!.path, "a.py");
  assert.equal(d.top_pivots[0]!.role_reason, "actual edit site");
  assert.equal(d.top_support[0]!.role_reason, "caller context");
  assert.equal(d.top_discarded[0]!.discard_reason, "test symbol");
});

test("renderMarkdown includes by-source, taxonomy, and top-k diagnostics for a miss", () => {
  const rows = [
    evaluateInstance(
      entry({ instance_id: "g_hit", label_source: "gold_patch" }),
      summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] }),
    ),
    evaluateInstance(
      entry({ instance_id: "m_miss", label_source: "passing_model_patch" }),
      summary({ pivots: [selected("pivot", "pkg/other.py", "o", 1, { roleReason: "ranked first" })] }),
    ),
  ];
  const md = renderMarkdown(artifactOf(rows));
  assert.match(md, /## Aggregate metrics — by label source/);
  assert.match(md, /## Miss taxonomy/);
  assert.match(md, /This is deterministic retrieval-quality evaluation only/);
  assert.match(md, /does \*\*not\*\* run Claude/);
  assert.match(md, /top-k diagnostics/);
  assert.match(md, /m_miss/);
  assert.match(md, /ranked first/); // role_reason surfaced in the miss diagnostics
});

test("renderMarkdown surfaces filtered generic/runner noise on a miss row", () => {
  const rows = [
    evaluateInstance(
      entry({ instance_id: "noisy_miss" }),
      summary({
        pivots: [selected("pivot", "pkg/other.py", "o", 1)],
        filteredGenericSymbols: ["error", "multiple"],
        filteredRunnerFiles: ["manage.py"],
      }),
    ),
  ];
  const md = renderMarkdown(artifactOf(rows));
  assert.match(md, /filtered generic symbols: error, multiple/);
  assert.match(md, /filtered runner files: manage\.py/);
});

test("evaluateInstance carries filtered-noise diagnostics onto the row", () => {
  const row = evaluateInstance(
    entry(),
    summary({ filteredGenericSymbols: ["command"], filteredRunnerFiles: ["manage.py"] }),
  );
  assert.deepEqual(row.filtered_generic_symbols, ["command"]);
  assert.deepEqual(row.filtered_runner_files, ["manage.py"]);
});

test("down-weighted lexical tokens flow onto the row and into a miss report", () => {
  const row = evaluateInstance(
    entry({ instance_id: "lex_miss" }),
    summary({
      pivots: [selected("pivot", "pkg/other.py", "o", 1)],
      downweightedLexicalTokens: ["multiple", "error"],
    }),
  );
  assert.deepEqual(row.downweighted_lexical_tokens, ["multiple", "error"]);
  const md = renderMarkdown(artifactOf([row]));
  assert.match(md, /down-weighted lexical tokens: multiple, error/);
});

test("body-literal matches flow onto the row and into a miss report", () => {
  const row = evaluateInstance(
    entry({ instance_id: "lit_miss" }),
    summary({
      pivots: [selected("pivot", "pkg/other.py", "o", 1)],
      bodyLiteralMatches: ["models.E015 -> _check_ordering"],
    }),
  );
  assert.deepEqual(row.body_literal_matches, ["models.E015 -> _check_ordering"]);
  const md = renderMarkdown(artifactOf([row]));
  assert.match(md, /body-literal matches: models\.E015 -> _check_ordering/);
});

test("taskHasLineAnchor detects source coordinates", () => {
  assert.ok(taskHasLineAnchor("bug in compiler.py#L10"));
  assert.ok(taskHasLineAnchor("see utils.py:42-50"));
  assert.ok(!taskHasLineAnchor("just prose with no anchor"));
});

// --- report-name output routing ----------------------------------------------

test("parseArgs routes a custom --report-name and rejects path separators", () => {
  const cfg = parseArgs(["--report-name", "stage5_retrieval_eval_expanded"]);
  assert.equal(cfg.reportName, "stage5_retrieval_eval_expanded");
  assert.equal(parseArgs(["--report-name", "x.md"]).reportName, "x"); // extension stripped
  assert.throws(() => parseArgs(["--report-name", "../escape"]), /Invalid --report-name/);
  assert.throws(() => parseArgs(["--report-name", "sub/dir"]), /Invalid --report-name/);
});

test("writeReports writes {json,csv,md} under the configured report name", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vtrace-r5r-name-"));
  const rows = [evaluateInstance(entry(), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] }))];
  await writeReports(
    { fixture: "f.json", out: dir, reportName: "stage5_retrieval_eval_expanded" },
    artifactOf(rows),
  );
  assert.ok(existsSync(path.join(dir, "stage5_retrieval_eval_expanded.json")));
  assert.ok(existsSync(path.join(dir, "stage5_retrieval_eval_expanded.csv")));
  assert.ok(existsSync(path.join(dir, "stage5_retrieval_eval_expanded.md")));
  // The default-named reports must NOT be written when a custom name is set.
  assert.ok(!existsSync(path.join(dir, "stage5_retrieval_eval.json")));
  const csv = readFileSync(path.join(dir, "stage5_retrieval_eval_expanded.csv"), "utf8");
  assert.match(csv.split("\n")[0]!, /^instance_id,repo,label_source,intent/);
});

// --- improved symbol extraction ----------------------------------------------

test("extractChangedFromDiff emits Class.method from class hunk context", () => {
  const patch = [
    "--- a/django/contrib/admin/options.py",
    "+++ b/django/contrib/admin/options.py",
    "@@ -100,6 +100,10 @@ class ModelAdmin(BaseModelAdmin):",
    "+    def get_inlines(self, request, obj=None):",
    "+        return self.inlines",
    "",
  ].join("\n");
  const changed = extractChangedFromDiff(patch);
  assert.equal(changed[0]!.file, "django/contrib/admin/options.py");
  assert.ok(changed[0]!.symbols.includes("get_inlines"));
  assert.ok(changed[0]!.symbols.includes("ModelAdmin.get_inlines"));
});

test("extractChangedFromDiff captures a module-level assignment name", () => {
  const patch = [
    "--- a/pkg/settings.py",
    "+++ b/pkg/settings.py",
    "@@ -1,3 +1,3 @@",
    "-DEFAULT_TIMEOUT = 30",
    "+DEFAULT_TIMEOUT = 60",
    "",
  ].join("\n");
  const changed = extractChangedFromDiff(patch);
  assert.ok(changed[0]!.symbols.includes("DEFAULT_TIMEOUT"));
});

// --- cross-repo expansion ----------------------------------------------------

test("cross-repo fixture loading: a multi-repo fixture loads with its repo slugs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vtrace-r5r-xrepo-"));
  const fixturePath = path.join(dir, "cross_repo.json");
  writeFileSync(
    fixturePath,
    JSON.stringify([
      { instance_id: "sympy__sympy-1", repo: "sympy/sympy", workspace: "/ws/a", task: "fix simplify", intent: "debug", budget: 8000, label_source: "gold_patch", expected_files: ["sympy/core/expr.py"], expected_symbols: ["simplify"] },
      { instance_id: "psf__requests-1", repo: "psf/requests", workspace: "/ws/b", task: "fix session", intent: "debug", budget: 8000, label_source: "gold_patch", expected_files: ["requests/sessions.py"], expected_symbols: ["Session"] },
    ]),
  );
  const entries = await loadRetrievalFixture(fixturePath);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.repo).sort(), ["psf/requests", "sympy/sympy"]);
  // Not one Django row — this is the whole point of the cross-repo set.
  assert.ok(entries.every((e) => e.repo !== "django/django"));
});

test("the committed cross_repo fixture (if present) is entirely non-Django", async () => {
  const fixture = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "retrieval_eval.cross_repo.json");
  if (!existsSync(fixture)) return; // built by the prepare/build step; skip if absent
  const entries = await loadRetrievalFixture(fixture);
  assert.ok(entries.length >= 10, `expected >=10 cross-repo instances, got ${entries.length}`);
  assert.ok(entries.every((e) => e.repo !== "django/django"));
  // Gold-patch labels, and every row names at least one expected file.
  assert.ok(entries.every((e) => e.expected_files.length > 0));
});

test("repo split aggregation: aggregateByRepo splits metrics per repo, sorted by size", () => {
  const rows = [
    evaluateInstance(entry({ instance_id: "s1", repo: "sympy/sympy" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] })),
    evaluateInstance(entry({ instance_id: "s2", repo: "sympy/sympy" }), summary({ pivots: [selected("pivot", "pkg/other.py", "other")] })),
    evaluateInstance(entry({ instance_id: "r1", repo: "psf/requests" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] })),
  ];
  const byRepo = aggregateByRepo(rows);
  assert.equal(byRepo.length, 2);
  // sympy (2 instances) sorts before requests (1 instance).
  assert.equal(byRepo[0]!.repo, "sympy/sympy");
  assert.equal(byRepo[0]!.instances_total, 2);
  assert.equal(byRepo[0]!.top_1_file_accuracy, 0.5); // one of two hit
  assert.equal(byRepo[1]!.repo, "psf/requests");
  assert.equal(byRepo[1]!.top_1_file_accuracy, 1);
});

test("report rendering by repo: renderByRepoTable + renderMarkdown emit a per-repo section", () => {
  const rows = [
    evaluateInstance(entry({ instance_id: "s1", repo: "sympy/sympy" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] })),
    evaluateInstance(entry({ instance_id: "r1", repo: "psf/requests" }), summary({ pivots: [selected("pivot", "pkg/other.py", "o")] })),
  ];
  const table = renderByRepoTable(aggregateByRepo(rows)).join("\n");
  assert.match(table, /\| repo \| instances \| top-1 file \|/);
  assert.match(table, /sympy\/sympy/);
  assert.match(table, /psf\/requests/);
  const md = renderMarkdown(artifactOf(rows));
  assert.match(md, /## Metrics by repo/);
  assert.match(md, /sympy\/sympy/);
});

test("report rendering by repo: a Django-only fixture still renders a single-repo table", () => {
  const rows = [evaluateInstance(entry({ instance_id: "d1", repo: "django/django" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] }))];
  const md = renderMarkdown(artifactOf(rows));
  assert.match(md, /## Metrics by repo/);
  assert.match(md, /django\/django/);
});

test("non-Django workspace validation: validateFixtureOnDisk passes a real non-Django indexed workspace", async () => {
  const workspace = await indexedWorkspace("vtrace-r5r-xrepo-ws-", {
    "requests/sessions.py": "class Session:\n    def request(self, method, url):\n        return (method, url)\n",
  });
  const e = entry({ repo: "psf/requests", workspace, expected_files: ["requests/sessions.py"], expected_symbols: ["Session.request"] });
  const issues = await validateFixtureOnDisk([e], new Set([e.instance_id]));
  assert.deepEqual(issues, []);
});

test("expected labels never leak in (cross-repo): same task, different labels → identical capsule", async () => {
  const workspace = await indexedWorkspace("vtrace-r5r-xrepo-leak-", {
    "requests/sessions.py": "class Session:\n    def request(self, method, url):\n        return (method, url)\n",
  });
  const a = await evaluateEntryLive(entry({ repo: "psf/requests", workspace, task: "fix Session.request", expected_files: ["requests/sessions.py"], expected_symbols: ["request"] }));
  const b = await evaluateEntryLive(entry({ repo: "psf/requests", workspace, task: "fix Session.request", expected_files: ["totally/unrelated.py"], expected_symbols: ["nope"] }));
  assert.deepEqual(a, b);
});

test("missing workspace handled cleanly (cross-repo): a missing non-Django workspace is workspace_error", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vtrace-r5r-xrepo-miss-"));
  const fixturePath = path.join(dir, "fixture.json");
  writeFileSync(
    fixturePath,
    JSON.stringify([
      { instance_id: "matplotlib__matplotlib-1", repo: "matplotlib/matplotlib", workspace: path.join(dir, "nope"), task: "fix axes", intent: "debug", budget: 8000, label_source: "gold_patch", expected_files: ["lib/matplotlib/axes/_axes.py"], expected_symbols: ["plot"] },
    ]),
  );
  const artifact = await runRetrievalEval({ fixture: fixturePath, out: dir });
  assert.equal(artifact.rows[0]!.result, "workspace_error");
  assert.equal(artifact.rows[0]!.repo, "matplotlib/matplotlib");
  assert.equal(artifact.byRepo[0]!.repo, "matplotlib/matplotlib");
  assert.equal(artifact.byRepo[0]!.workspace_error_count, 1);
});

test("report-name routing still works for the cross-repo report name", async () => {
  const cfg = parseArgs(["--retrieval-fixture", "f.json", "--report-name", "stage5_retrieval_eval_cross_repo", "--out", "o"]);
  assert.equal(cfg.reportName, "stage5_retrieval_eval_cross_repo");
  assert.equal(cfg.fixture, "f.json");
  assert.equal(cfg.out, "o");
  const dir = mkdtempSync(path.join(tmpdir(), "vtrace-r5r-xrepo-name-"));
  const rows = [evaluateInstance(entry({ repo: "sympy/sympy" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] }))];
  await writeReports({ fixture: "f.json", out: dir, reportName: "stage5_retrieval_eval_cross_repo" }, artifactOf(rows));
  assert.ok(existsSync(path.join(dir, "stage5_retrieval_eval_cross_repo.md")));
  assert.ok(existsSync(path.join(dir, "stage5_retrieval_eval_cross_repo.csv")));
  assert.ok(existsSync(path.join(dir, "stage5_retrieval_eval_cross_repo.json")));
});

// --- 30-instance cross-repo expansion: comparison + compact miss summary -----

test("comparisonBaselineFor routes ONLY the 30-instance report name to the 16-instance baseline", () => {
  assert.equal(comparisonBaselineFor("stage5_retrieval_eval_cross_repo_30"), CROSS_REPO_16_BASELINE);
  // The plain cross-repo / Django reports carry no baseline → no comparison section.
  assert.equal(comparisonBaselineFor("stage5_retrieval_eval_cross_repo"), null);
  assert.equal(comparisonBaselineFor("stage5_retrieval_eval"), null);
});

test("CROSS_REPO_16_BASELINE holds the published prior numbers", () => {
  assert.equal(CROSS_REPO_16_BASELINE.instances, 16);
  assert.equal(CROSS_REPO_16_BASELINE.top_1_file_accuracy, 0.625);
  assert.equal(CROSS_REPO_16_BASELINE.top_3_file_recall, 0.875);
  assert.equal(CROSS_REPO_16_BASELINE.expected_file_as_pivot_rate, 0.8125);
  assert.equal(CROSS_REPO_16_BASELINE.expected_file_missing_rate, 0.0625);
});

test("renderComparison emits prior, current, and signed percentage-point deltas", () => {
  // Two of three hit top-1; the third recovers its file only as support (present,
  // not top-1, not missing) — gives non-trivial top-1 + zero-missing deltas.
  const rows = [
    evaluateInstance(entry({ instance_id: "a", repo: "sympy/sympy" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] })),
    evaluateInstance(entry({ instance_id: "b", repo: "psf/requests" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] })),
    evaluateInstance(
      entry({ instance_id: "c", repo: "psf/requests" }),
      summary({ pivots: [selected("pivot", "pkg/other.py", "other")], support: [selected("support", "pkg/target.py", "do_thing")] }),
    ),
  ];
  const table = renderComparison(CROSS_REPO_16_BASELINE, aggregate(rows)).join("\n");
  assert.match(table, /previous 16-instance cross-repo/);
  assert.match(table, /new 3-instance cross-repo/);
  assert.match(table, /top-1 file accuracy \| 62\.5% \| 66\.7% \| \+4\.2 pp ▲/);
  // missing fell (improved) here → lower-is-better arrow is ▲ on a negative delta.
  assert.match(table, /expected file missing \| 6\.3% \| 0\.0% \| -6\.3 pp ▲/);
});

test("renderMarkdown includes the comparison section only when a baseline is passed", () => {
  const rows = [evaluateInstance(entry({ repo: "sympy/sympy" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] }))];
  const withBaseline = renderMarkdown(artifactOf(rows), CROSS_REPO_16_BASELINE);
  assert.match(withBaseline, /## Comparison vs prior cross-repo baseline/);
  assert.match(withBaseline, /16 to 1 non-Django instances/);
  const without = renderMarkdown(artifactOf(rows));
  assert.ok(!without.includes("## Comparison vs prior cross-repo baseline"));
});

test("renderMissSummary lists every requested bucket, always (even at zero)", () => {
  const rows = [
    // a clean top-1 hit (no miss)
    evaluateInstance(entry({ instance_id: "hit" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] })),
    // expected file present only as support → non-top-3 + present-but-support
    evaluateInstance(
      entry({ instance_id: "sup", expected_files: ["pkg/target.py"] }),
      summary({
        pivots: [selected("pivot", "pkg/a.py", "a"), selected("pivot", "pkg/b.py", "b"), selected("pivot", "pkg/c.py", "c")],
        support: [selected("support", "pkg/target.py", "do_thing")],
      }),
    ),
  ];
  const text = renderMissSummary(rows).join("\n");
  assert.match(text, /non-top-3 cases: 1/);
  assert.match(text, /present-but-support: 1/);
  assert.match(text, /missing \(not surfaced\): 0/);
  assert.match(text, /wrong-subsystem: 0/);
  assert.match(text, /body-literal misses: 0/);
  assert.match(text, /parser\/language gaps: 0/);
});

test("writeReports for the 30-instance report name renders the comparison section", async () => {
  const cfg = parseArgs(["--retrieval-fixture", "f.json", "--report-name", "stage5_retrieval_eval_cross_repo_30", "--out", "o"]);
  assert.equal(cfg.reportName, "stage5_retrieval_eval_cross_repo_30");
  const dir = mkdtempSync(path.join(tmpdir(), "vtrace-r5r-xrepo30-"));
  const rows = [evaluateInstance(entry({ repo: "sympy/sympy" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] }))];
  await writeReports({ fixture: "f.json", out: dir, reportName: "stage5_retrieval_eval_cross_repo_30" }, artifactOf(rows));
  const md = readFileSync(path.join(dir, "stage5_retrieval_eval_cross_repo_30.md"), "utf8");
  assert.match(md, /## Comparison vs prior cross-repo baseline/);
  assert.match(md, /previous 16-instance cross-repo/);
  assert.match(md, /## Miss summary \(compact\)/);
});

test("the committed cross_repo.30 fixture (if present) is non-Django, dup-free, multi-repo", async () => {
  const fixture = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "retrieval_eval.cross_repo.30.json");
  if (!existsSync(fixture)) return; // built by the prepare/build step; skip if absent
  const entries = await loadRetrievalFixture(fixture); // throws on a duplicate instance_id
  assert.ok(entries.length >= 28, `expected >=28 instances, got ${entries.length}`);
  assert.ok(entries.every((e) => e.repo !== "django/django"));
  assert.ok(entries.every((e) => e.expected_files.length > 0));
  assert.ok(entries.every((e) => e.label_source === "gold_patch"));
  // Genuine cross-repo coverage: many distinct repos, including the new ones.
  const repos = new Set(entries.map((e) => e.repo));
  assert.ok(repos.size >= 10, `expected >=10 repos, got ${repos.size}`);
});

// --- new miss categories -----------------------------------------------------

test("taskHasBodyLiteral detects a quoted code literal but not quoted prose", () => {
  assert.ok(taskHasBodyLiteral('the helper "get_group_by_cols" drops a space'));
  assert.ok(taskHasBodyLiteral("emits 'COUNT(DISTINCT' without a trailing space"));
  assert.ok(!taskHasBodyLiteral('a quoted "plain english phrase here"'));
  assert.ok(!taskHasBodyLiteral("no quotes at all in this task"));
});

// G2: a quoted MODULE / FORMAT / PATH identifier is not a body-literal-class clue
// (it is resolved by symbol/import/path matching), so it must not count.
test("taskHasBodyLiteral excludes module/format/path identifiers", () => {
  assert.ok(!taskHasBodyLiteral("read with `format='ascii.cds'` incorrectly")); // dotted format key
  assert.ok(!taskHasBodyLiteral("import 'astropy.units.format' fails"));         // dotted module path
  assert.ok(!taskHasBodyLiteral("the call 'self.method' is wrong"));             // attribute access
  assert.ok(!taskHasBodyLiteral("see 'a/b/c.py' for the path"));                 // file path
});

test("classifyMiss: body_literal_not_resolved when a quoted literal resolved to nothing", () => {
  const s = summary({ pivots: [selected("pivot", "pkg/other.py", "other")], bodyLiteralMatches: [] });
  const cat = classifyMiss(
    { result: "missing", expected_file_role: "missing", contains_expected_file_top3: false, expected_files: ["pkg/target.py"] },
    s,
    'fix the "get_group_by_cols" helper',
  );
  assert.equal(cat, "body_literal_not_resolved");
});

test("expectedFilesAreUnparsedLanguage flags non-Python edit sites", () => {
  assert.ok(expectedFilesAreUnparsedLanguage(["sklearn/tree/_tree.pyx"]));
  assert.ok(expectedFilesAreUnparsedLanguage(["doc/whatsnew.rst"]));
  assert.ok(!expectedFilesAreUnparsedLanguage(["pkg/target.py"]));
  assert.ok(!expectedFilesAreUnparsedLanguage(["pkg/target.py", "doc/x.rst"])); // any .py present
  assert.ok(!expectedFilesAreUnparsedLanguage([]));
});

test("classifyMiss: language_parser_gap when the only edit site is a non-Python file", () => {
  const s = summary({ pivots: [selected("pivot", "pkg/other.py", "other")] });
  const cat = classifyMiss(
    { result: "missing", expected_file_role: "missing", contains_expected_file_top3: false, expected_files: ["sklearn/tree/_tree.pyx"] },
    s,
    "fix the cython splitter",
  );
  assert.equal(cat, "language_parser_gap");
});

// --- G2: miss-taxonomy precedence + irrelevant-literal gate -------------------

test("G2: an irrelevant quoted module/format literal is NOT body_literal_not_resolved", () => {
  // astropy-14369 shape: the task quotes a FORMAT key (`format='ascii.cds'`), the
  // expected units parser never enters candidates. This is a candidate-generation
  // gap, not a literal-search failure — must not be labelled body_literal_*.
  const s = summary({
    pivots: [selected("pivot", "astropy/io/ascii/mrt.py", "Mrt")],
    bodyLiteralMatches: [],
    candidateCount: 25,
    subsystemRoot: null,
  });
  const cat = classifyMiss(
    {
      result: "missing",
      expected_file_role: "missing",
      contains_expected_file_top3: false,
      expected_files: ["astropy/units/format/cds.py"],
    },
    s,
    "Incorrect units read with `format='ascii.cds'`, astropy.table mis-parses composite units",
  );
  assert.equal(cat, "missing_from_candidates");
});

test("G2: wrong_subsystem takes precedence over a body literal when the subsystem mismatches", () => {
  // Even with a relevant quoted literal, a structural wrong-subsystem signal is the
  // real cause and wins (precedence reorder).
  const s = summary({
    pivots: [selected("pivot", "astropy/io/ascii/mrt.py", "Mrt")],
    bodyLiteralMatches: [],
    candidateCount: 25,
    subsystemRoot: "astropy/io/ascii",
  });
  const cat = classifyMiss(
    {
      result: "missing",
      expected_file_role: "missing",
      contains_expected_file_top3: false,
      expected_files: ["astropy/units/format/cds.py"],
    },
    s,
    'parser drops the "p_product_of_units" rule',
  );
  assert.equal(cat, "wrong_subsystem");
});

test("G2: a relevant body literal is still classified when no structural cause applies", () => {
  // Regression: the genuine body-literal case (distinctive quoted clue, no
  // subsystem/infra/entry signal) still resolves to body_literal_not_resolved.
  const s = summary({
    pivots: [selected("pivot", "pkg/other.py", "other")],
    bodyLiteralMatches: [],
    candidateCount: 10,
    subsystemRoot: null,
  });
  const cat = classifyMiss(
    { result: "missing", expected_file_role: "missing", contains_expected_file_top3: false, expected_files: ["pkg/target.py"] },
    s,
    'the emitted message "could not parse value" is wrong',
  );
  // "could not parse value" is prose without code shape -> not a body literal;
  // a code-shaped clue does trigger it:
  const cat2 = classifyMiss(
    { result: "missing", expected_file_role: "missing", contains_expected_file_top3: false, expected_files: ["pkg/target.py"] },
    s,
    'the helper "get_group_by_cols" emits the wrong sql',
  );
  assert.equal(cat, "missing_from_candidates");
  assert.equal(cat2, "body_literal_not_resolved");
});

test("G2: deanchored exception tokens flow from summary onto the row", () => {
  const row = evaluateInstance(
    entry({ repo: "sphinx-doc/sphinx" }),
    summary({
      pivots: [selected("pivot", "pkg/target.py", "do_thing")],
      deanchoredExceptionTokens: ["index"],
    }),
  );
  assert.deepEqual(row.deanchored_exception_tokens, ["index"]);
});
