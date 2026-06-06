// Stage 5R retrieval-eval tests.
//
// Pure scoring (file/symbol role, top-1/top-3, aggregate, report rendering) is
// exercised with injected CapsuleSummary values — no DB required. Two tests use a
// real on-disk indexed workspace (real parser) to prove (a) production retrieval
// is a pure function of (task, intent, budget) — expected labels never reach it —
// and (b) a missing workspace is reported as workspace_error, not a crash.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { indexProject } from "../../src/indexer/indexProject";
import {
  aggregate,
  evaluateEntryLive,
  evaluateExpectedFile,
  evaluateExpectedSymbol,
  evaluateInstance,
  extractChangedFromDiff,
  extractExpectedLabelsFromJsonl,
  fileMatches,
  loadRetrievalFixture,
  rankedFiles,
  renderCsv,
  renderMarkdown,
  runRetrievalEval,
  summarizeCapsule,
  symbolMatches,
  validateFixtureEntry,
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
    expected_files: ["pkg/target.py"],
    expected_symbols: ["do_thing"],
    ...overrides,
  };
}

function selected(role: "pivot" | "support", file: string, symbol: string, final = 1): SelectedItem {
  return { role, path: file, symbol, fqName: `${file}::${symbol}`, final };
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
  };
}

test("renderCsv emits a header row and one row per instance", () => {
  const rows = [evaluateInstance(entry({ instance_id: "a" }), summary({ pivots: [selected("pivot", "pkg/target.py", "do_thing")] }))];
  const csv = renderCsv(rows);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^instance_id,intent,actual_mode/);
  assert.match(lines[1]!, /^a,debug,standard/);
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
