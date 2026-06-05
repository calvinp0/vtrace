import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProcessResult } from "./run_stage5_vexp_swe_bench_smoke";
import {
  aggregate,
  buildCapsuleQueryCommand,
  containsExpectedSymbol,
  evaluateExpectedFile,
  evaluateInstance,
  expectedFileMatches,
  loadRetrievalFixture,
  normalizeFilePath,
  parseArgs,
  parseCapsuleDiagnostics,
  rankedFilesFromSelection,
  renderCsv,
  renderMarkdown,
  resolveIndexedWorkspace,
  runRetrievalEval,
  type ParsedCapsuleDiagnostics,
  type ParsedSelectionItem,
  type RetrievalEvalFixtureEntry,
  type RetrievalEvalRow,
} from "./run_stage5_retrieval_eval";

// --- helpers ---------------------------------------------------------------

function sel(role: "pivot" | "support", filePath: string, symbol: string, finalScore = 1): ParsedSelectionItem {
  return { role, path: filePath, symbol, finalScore };
}

function diagnostics(overrides: Partial<ParsedCapsuleDiagnostics> = {}): ParsedCapsuleDiagnostics {
  return {
    recommendedMode: "micro",
    actualMode: "micro",
    targetConfidence: "medium",
    pivotCount: 1,
    supportCount: 0,
    candidateCountBeforeRoles: 12,
    contextChars: 1000,
    likelyFiles: [],
    likelySymbols: [],
    selection: [],
    discarded: [],
    ...overrides,
  };
}

function row(entry: RetrievalEvalFixtureEntry, diag: ParsedCapsuleDiagnostics): RetrievalEvalRow {
  return evaluateInstance({
    entry,
    recommendedMode: "micro",
    classification: null,
    diagnostics: diag,
    policy: { action: "inject", reason: "", expectedContextValue: "medium", expectedOverheadRisk: "medium" },
    status: "evaluated",
    statusDetail: null,
    workspace: "/ws",
  });
}

const ENTRY: RetrievalEvalFixtureEntry = {
  instance_id: "django__django-11728",
  repo: "django/django",
  expected_files: ["django/contrib/admindocs/utils.py"],
  expected_symbols: ["replace_named_groups"],
};

// --- normalize + match -----------------------------------------------------

test("normalizeFilePath strips ./ and normalizes slashes", () => {
  assert.equal(normalizeFilePath("./a\\b/c.py"), "a/b/c.py");
  assert.equal(normalizeFilePath("/x/y.py"), "x/y.py");
});

test("expectedFileMatches is exact or path-boundary suffix, not substring", () => {
  assert.equal(expectedFileMatches("a/b/c.py", "a/b/c.py"), true);
  assert.equal(expectedFileMatches("b/c.py", "/repo/a/b/c.py"), true);
  // boundary-aware: utils.py must not match a different file that merely ends in "utils.py"
  assert.equal(expectedFileMatches("admindocs/utils.py", "admindocs_utils.py"), false);
  assert.equal(expectedFileMatches("a.py", "b.py"), false);
});

// --- rank calculation ------------------------------------------------------

test("rankedFilesFromSelection dedupes preserving pivot-first order", () => {
  const ranking = rankedFilesFromSelection([
    sel("pivot", "a.py", "x"),
    sel("support", "b.py", "y"),
    sel("support", "a.py", "z"), // dup file -> dropped
    sel("support", "c.py", "w"),
  ]);
  assert.deepEqual(ranking, ["a.py", "b.py", "c.py"]);
});

test("expected file rank is 1-based position in the file ranking", () => {
  const selection = [
    sel("pivot", "django/db/models/query.py", "count"),
    sel("support", "django/db/models/sql/query.py", "count_active_tables"),
    sel("support", "django/contrib/admindocs/utils.py", "replace_named_groups"),
  ];
  const result = evaluateExpectedFile(["django/contrib/admindocs/utils.py"], selection, []);
  assert.equal(result.rank, 3);
  assert.equal(result.containsTop1, false);
  assert.equal(result.containsTop3, true);
});

test("expected file rank picks the best (lowest) of multiple expected files", () => {
  const selection = [sel("pivot", "b.py", "x"), sel("support", "a.py", "y")];
  const result = evaluateExpectedFile(["a.py", "b.py"], selection, []);
  assert.equal(result.rank, 1);
  assert.equal(result.matchedFile, "b.py");
});

// --- role calculation ------------------------------------------------------

test("role is pivot when the expected file leads as a pivot", () => {
  const result = evaluateExpectedFile(["a.py"], [sel("pivot", "a.py", "x")], []);
  assert.equal(result.role, "pivot");
  assert.equal(result.containsTop1, true);
});

test("role is support when the expected file is only a support item", () => {
  const result = evaluateExpectedFile(
    ["a.py"],
    [sel("pivot", "b.py", "x"), sel("support", "a.py", "y")],
    [],
  );
  assert.equal(result.role, "support");
});

test("role is missing when the expected file is absent, with discarded flag", () => {
  const result = evaluateExpectedFile(
    ["a.py"],
    [sel("pivot", "b.py", "x")],
    [{ path: "a.py", symbol: "y", reason: "discard: a test symbol" }],
  );
  assert.equal(result.role, "missing");
  assert.equal(result.rank, null);
  assert.equal(result.discarded, true);
});

test("role is missing and not discarded when truly absent", () => {
  const result = evaluateExpectedFile(["a.py"], [sel("pivot", "b.py", "x")], []);
  assert.equal(result.role, "missing");
  assert.equal(result.discarded, false);
});

// --- symbol matching -------------------------------------------------------

test("containsExpectedSymbol matches selection or likely symbols, case-sensitive", () => {
  assert.equal(
    containsExpectedSymbol(["replace_named_groups"], [sel("pivot", "u.py", "replace_named_groups")], []),
    true,
  );
  assert.equal(containsExpectedSymbol(["as_sql"], [], ["as_sql"]), true);
  assert.equal(containsExpectedSymbol(["As_Sql"], [], ["as_sql"]), false);
  assert.equal(containsExpectedSymbol([], [], []), false);
});

// --- parseCapsuleDiagnostics ----------------------------------------------

test("parseCapsuleDiagnostics extracts selection + discards from capsule --json", () => {
  const json = JSON.stringify({
    diagnostics: {
      recommended_mode: "micro",
      actual_mode: "micro",
      target_confidence: "medium",
      pivot_count: 1,
      support_count: 1,
      candidate_count_before_roles: 12,
      context_chars: 1166,
      likely_files: ["django/db/models/query.py"],
      likely_symbols: ["count"],
      selection: [
        { role: "pivot", path: "django/db/models/query.py", symbol: "count", scores: { final: 2.66 } },
        { role: "support", path: "django/db/models/aggregates.py", symbol: "Count", scores: { final: 1.81 } },
      ],
      top_discarded_candidates: [
        { path: "django/test/html.py", symbol: "count", discard_reason: "discard: a test symbol" },
      ],
    },
    context: "# vtrace context ...",
  });
  const parsed = parseCapsuleDiagnostics(json);
  assert.ok(parsed);
  assert.equal(parsed.selection.length, 2);
  assert.equal(parsed.selection[0]?.role, "pivot");
  assert.equal(parsed.selection[1]?.path, "django/db/models/aggregates.py");
  assert.equal(parsed.discarded[0]?.reason, "discard: a test symbol");
  assert.equal(parsed.contextChars, 1166);
  assert.equal(parsed.candidateCountBeforeRoles, 12);
});

test("parseCapsuleDiagnostics returns null for non-JSON output", () => {
  assert.equal(parseCapsuleDiagnostics("vtrace failed: not indexed"), null);
});

// --- aggregate metric calculation -----------------------------------------

test("aggregate computes rates over evaluated rows only", () => {
  const pivotRow = row(ENTRY, diagnostics({ selection: [sel("pivot", "django/contrib/admindocs/utils.py", "replace_named_groups")] }));
  const supportRow = row(ENTRY, diagnostics({ selection: [sel("pivot", "x.py", "a"), sel("support", "django/contrib/admindocs/utils.py", "b")] }));
  const missingRow = row(ENTRY, diagnostics({ selection: [sel("pivot", "x.py", "a")] }));
  const noWorkspaceRow = evaluateInstance({
    entry: ENTRY,
    recommendedMode: "micro",
    classification: null,
    diagnostics: null,
    policy: null,
    status: "no_workspace",
    statusDetail: "no ws",
    workspace: null,
  });

  const agg = aggregate([pivotRow, supportRow, missingRow, noWorkspaceRow]);
  assert.equal(agg.instances_total, 4);
  assert.equal(agg.instances_evaluated, 3);
  assert.equal(agg.instances_no_workspace, 1);
  // top-1 only the pivotRow (its expected file is the lead) -> 1/3
  assert.ok(Math.abs(agg.top_1_file_accuracy - 1 / 3) < 1e-9);
  // top-3: pivotRow + supportRow -> 2/3
  assert.ok(Math.abs(agg.top_3_file_recall - 2 / 3) < 1e-9);
  assert.ok(Math.abs(agg.expected_file_as_pivot_rate - 1 / 3) < 1e-9);
  assert.ok(Math.abs(agg.expected_file_as_support_rate - 1 / 3) < 1e-9);
  assert.ok(Math.abs(agg.expected_file_missing_rate - 1 / 3) < 1e-9);
});

test("aggregate guards divide-by-zero with no evaluated rows", () => {
  const agg = aggregate([]);
  assert.equal(agg.instances_evaluated, 0);
  assert.equal(agg.top_1_file_accuracy, 0);
  assert.equal(agg.mean_capsule_chars, 0);
});

// --- evaluateInstance end-to-end ------------------------------------------

test("evaluateInstance fills the honest verdict fields", () => {
  const r = row(ENTRY, diagnostics({
    selection: [
      sel("pivot", "django/db/models/query.py", "count"),
      sel("support", "django/contrib/admindocs/utils.py", "replace_named_groups"),
    ],
    likelySymbols: ["count"],
  }));
  assert.equal(r.top_1_pivot_file, "django/db/models/query.py");
  assert.equal(r.expected_file_role, "support");
  assert.equal(r.expected_file_rank, 2);
  assert.equal(r.contains_expected_file_top1, false);
  assert.equal(r.contains_expected_file_top3, true);
  assert.equal(r.contains_expected_symbol, true); // selection carries replace_named_groups
});

// --- fixture loading -------------------------------------------------------

test("loadRetrievalFixture parses a JSON array and validates required fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stage5r-fix-"));
  const file = path.join(dir, "fix.json");
  await writeFile(file, JSON.stringify([
    { instance_id: "a", repo: "r/r", expected_files: ["x.py"], expected_symbols: ["f"] },
  ]));
  const fixture = await loadRetrievalFixture(file);
  assert.equal(fixture.length, 1);
  assert.equal(fixture[0]?.instance_id, "a");
  assert.deepEqual(fixture[0]?.expected_files, ["x.py"]);
});

test("loadRetrievalFixture rejects an entry with no expected_files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stage5r-fix-"));
  const file = path.join(dir, "bad.json");
  await writeFile(file, JSON.stringify([{ instance_id: "a", repo: "r/r", expected_files: [] }]));
  await assert.rejects(() => loadRetrievalFixture(file), /at least one expected_files/);
});

// --- report rendering ------------------------------------------------------

test("renderCsv emits a header and one row per instance with array columns joined", () => {
  const r = row(ENTRY, diagnostics({ selection: [sel("pivot", "django/contrib/admindocs/utils.py", "replace_named_groups")] }));
  const csv = renderCsv([r]);
  const lines = csv.trim().split("\n");
  assert.ok(lines[0]?.startsWith("instance_id,repo,status,"));
  assert.equal(lines.length, 2);
  assert.ok(lines[1]?.includes("django__django-11728"));
});

test("renderMarkdown reports aggregate and a per-instance verdict", () => {
  const r = row(ENTRY, diagnostics({ selection: [sel("pivot", "x.py", "a")] })); // missing
  const md = renderMarkdown({
    generatedFrom: { fixture: "f.json", sweBenchData: null, resultsDir: "res", vtraceCommand: "bun x" },
    rows: [r],
    aggregate: aggregate([r]),
  });
  assert.ok(md.includes("# Stage 5R"));
  assert.ok(md.includes("top-1 file accuracy"));
  assert.ok(md.includes("expected file MISSING"));
});

test("renderMarkdown explains a missing file as a routing miss when 0 candidates retrieved", () => {
  const r = row(ENTRY, diagnostics({ selection: [], candidateCountBeforeRoles: 0 }));
  const md = renderMarkdown({
    generatedFrom: { fixture: "f.json", sweBenchData: null, resultsDir: "res", vtraceCommand: "bun x" },
    rows: [r],
    aggregate: aggregate([r]),
  });
  assert.ok(md.includes("retrieval returned 0 candidates"));
});

// --- CLI parsing -----------------------------------------------------------

test("parseArgs accepts --retrieval-fixture and --out", () => {
  const config = parseArgs(["--retrieval-fixture", "fix.json", "--out", "out", "--swe-bench-data", "d.jsonl"]);
  assert.equal(config.fixture, "fix.json");
  assert.equal(config.out, "out");
  assert.equal(config.sweBenchData, "d.jsonl");
});

test("buildCapsuleQueryCommand requests the compact JSON capsule", () => {
  const { command, args } = buildCapsuleQueryCommand("bun src/cli/index.ts", "/ws", "q", "micro");
  assert.equal(command, "bun");
  assert.deepEqual(args, ["src/cli/index.ts", "capsule", "/ws", "q", "--mode", "micro", "--json"]);
});

// --- no production hardcoding of expected files ---------------------------

test("the runner source does not hardcode any expected file path", async () => {
  const runnerSource = await readFile(path.join(import.meta.dir, "run_stage5_retrieval_eval.ts"), "utf8");
  const fixtureSource = await readFile(path.join(import.meta.dir, "retrieval_eval.django.json"), "utf8");
  const fixture = JSON.parse(fixtureSource) as RetrievalEvalFixtureEntry[];
  for (const entry of fixture) {
    for (const expected of entry.expected_files) {
      // Expected files belong ONLY to the fixture, never baked into the scorer.
      assert.ok(
        !runnerSource.includes(expected),
        `runner must not hardcode expected file ${expected}`,
      );
    }
  }
});

// --- full orchestration with an injected runner (no spawn) -----------------

test("runRetrievalEval runs end-to-end with a fake capsule runner", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stage5r-run-"));
  // An indexed workspace the resolver can find: results/workspaces/<id>/.vtrace/index.sqlite
  const ws = path.join(dir, "workspaces", "django__django-11728");
  await mkdir(path.join(ws, ".vtrace"), { recursive: true });
  await writeFile(path.join(ws, ".vtrace", "index.sqlite"), "");

  const fixtureFile = path.join(dir, "fix.json");
  await writeFile(fixtureFile, JSON.stringify([
    {
      instance_id: "django__django-11728",
      repo: "django/django",
      expected_files: ["django/contrib/admindocs/utils.py"],
      expected_symbols: ["replace_named_groups"],
      problem_statement: "simplify_regexp() drops a trailing group; replace_named_groups fails on missing trailing slash.",
      fail_to_pass: ["test_simplify_regex (admin_docs.test_views.AdminDocViewFunctionsTests)"],
    },
  ]));

  const cannedJson = JSON.stringify({
    diagnostics: {
      recommended_mode: "micro",
      actual_mode: "micro",
      target_confidence: "medium",
      pivot_count: 1,
      support_count: 1,
      context_chars: 900,
      likely_files: ["django/contrib/admindocs/utils.py"],
      likely_symbols: ["replace_named_groups"],
      selection: [
        { role: "pivot", path: "django/contrib/admindocs/utils.py", symbol: "replace_named_groups", scores: { final: 3.1 } },
      ],
      top_discarded_candidates: [],
    },
    context: "# vtrace context\n## Primary edit target\n- django/contrib/admindocs/utils.py — replace_named_groups",
  });

  const fakeRunner = async (): Promise<ProcessResult> => ({ exitCode: 0, stdout: cannedJson, stderr: "" });

  const artifact = await runRetrievalEval(
    {
      fixture: fixtureFile,
      out: dir,
      resultsDir: dir,
      sweBenchData: null,
      vtraceCommand: "bun src/cli/index.ts",
    },
    { runProcess: fakeRunner },
  );

  assert.equal(artifact.rows.length, 1);
  const only = artifact.rows[0];
  assert.equal(only?.status, "evaluated");
  assert.equal(only?.expected_file_role, "pivot");
  assert.equal(only?.contains_expected_file_top1, true);
  assert.equal(only?.contains_expected_symbol, true);
  assert.equal(artifact.aggregate.top_1_file_accuracy, 1);
});

test("resolveIndexedWorkspace finds a nested run-label workspace, null when unindexed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stage5r-ws-"));
  const ws = path.join(dir, "workspaces", "eval-x", "inst-1");
  await mkdir(path.join(ws, ".vtrace"), { recursive: true });
  await writeFile(path.join(ws, ".vtrace", "index.sqlite"), "");
  assert.equal(await resolveIndexedWorkspace(dir, "inst-1"), ws);
  assert.equal(await resolveIndexedWorkspace(dir, "missing"), null);
});
