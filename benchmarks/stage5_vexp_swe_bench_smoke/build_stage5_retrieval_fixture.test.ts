// Tests for the Stage 5R fixture builder: deterministic task derivation from a
// problem statement, gold-patch label extraction (source preferred over tests,
// best-effort symbols), workspace resolution, and row construction with a label
// source. No DB / network — pure functions plus a tmp workspace for resolution.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  buildGoldRow,
  deriveTaskFromProblemStatement,
  extractLabelsFromPatch,
  loadSweBench,
  resolveWorkspace,
  type SweBenchInstance,
} from "./build_stage5_retrieval_fixture";

// --- task derivation ---------------------------------------------------------

test("deriveTaskFromProblemStatement combines the title and first body sentence", () => {
  const ps = [
    "HttpResponse doesn't handle memoryview objects",
    "Description",
    "I am trying to write a BinaryField into a HttpResponse. It fails on Sqlite. Second sentence.",
  ].join("\n");
  const task = deriveTaskFromProblemStatement(ps);
  assert.match(task, /^HttpResponse doesn't handle memoryview objects —/);
  assert.match(task, /BinaryField/);
  assert.ok(!task.includes("Second sentence")); // only the first sentence
});

test("deriveTaskFromProblemStatement strips zero-width chars and skips code lines", () => {
  const ps = [
    "pk setup for MTI gets confused",
    "Description",
    "class Document(models.Model):", // code — must be skipped
    "​The parent link is not set up correctly.",
  ].join("\n");
  const task = deriveTaskFromProblemStatement(ps);
  assert.ok(!task.includes("class Document"));
  assert.ok(!task.includes("​"));
  assert.match(task, /parent link/);
});

test("deriveTaskFromProblemStatement falls back to the title alone and caps length", () => {
  assert.equal(deriveTaskFromProblemStatement("Just a title"), "Just a title");
  assert.equal(deriveTaskFromProblemStatement(""), "");
  const long = "T".repeat(400);
  assert.ok(deriveTaskFromProblemStatement(long).length <= 280);
});

// --- gold-patch label extraction ---------------------------------------------

test("extractLabelsFromPatch prefers source files and drops test-only files", () => {
  const patch = [
    "--- a/django/db/models/aggregates.py",
    "+++ b/django/db/models/aggregates.py",
    "@@ -50,7 +50,7 @@ class Aggregate(Func):",
    "     def as_sql(self, compiler, connection):",
    "-        return 'DISTINCT'",
    "+        return 'DISTINCT '",
    "--- a/tests/aggregation/tests.py",
    "+++ b/tests/aggregation/tests.py",
    "@@ -1,3 +1,4 @@ def test_count_distinct():",
    "+    pass",
    "",
  ].join("\n");
  const labels = extractLabelsFromPatch(patch);
  assert.deepEqual(labels.expected_files, ["django/db/models/aggregates.py"]);
  assert.ok(labels.expected_symbols.includes("as_sql"));
  assert.ok(labels.expected_symbols.includes("Aggregate"));
});

test("extractLabelsFromPatch keeps test files when the patch touches only tests", () => {
  const patch = [
    "--- a/tests/foo/test_bar.py",
    "+++ b/tests/foo/test_bar.py",
    "@@ -1,2 +1,3 @@",
    "+x = 1",
    "",
  ].join("\n");
  const labels = extractLabelsFromPatch(patch);
  assert.deepEqual(labels.expected_files, ["tests/foo/test_bar.py"]);
});

// --- workspace resolution ----------------------------------------------------

test("resolveWorkspace finds an indexed expanded workspace and returns null otherwise", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vtrace-r5r-resolve-"));
  const ws = path.join(root, "workspaces", "expanded", "django__django-99999");
  mkdirSync(path.join(ws, ".vtrace"), { recursive: true });
  writeFileSync(path.join(ws, ".vtrace", "index.sqlite"), "");
  assert.equal(await resolveWorkspace(root, "django__django-99999"), ws);
  assert.equal(await resolveWorkspace(root, "django__django-00000"), null);
});

// --- row construction --------------------------------------------------------

const INSTANCE: SweBenchInstance = {
  instance_id: "django__django-10880",
  repo: "django/django",
  patch: [
    "--- a/django/db/models/aggregates.py",
    "+++ b/django/db/models/aggregates.py",
    "@@ -50,7 +50,7 @@ class Aggregate(Func):",
    "     def as_sql(self, compiler, connection):",
    "-        return 'DISTINCT'",
    "+        return 'DISTINCT '",
    "",
  ].join("\n"),
  problem_statement: "Count(Case, distinct=True) emits a missing space\nDescription\nThe aggregate SQL is wrong.",
};

test("buildGoldRow produces a gold_patch row whose task is derived (not the patch)", () => {
  const { row } = buildGoldRow(INSTANCE, "/ws/path");
  assert.ok(row);
  assert.equal(row!.label_source, "gold_patch");
  assert.equal(row!.workspace, "/ws/path");
  assert.deepEqual(row!.expected_files, ["django/db/models/aggregates.py"]);
  assert.ok(row!.expected_symbols.includes("as_sql"));
  assert.match(row!.task, /missing space/);
  // The task must not be sourced from the patch contents.
  assert.ok(!row!.task.includes("DISTINCT"));
});

test("buildGoldRow can tag a passing_model_patch source", () => {
  const { row } = buildGoldRow(INSTANCE, "/ws/path", "passing_model_patch");
  assert.equal(row!.label_source, "passing_model_patch");
});

test("buildGoldRow skips an instance whose patch changes no files", () => {
  const { row, skipped } = buildGoldRow({ ...INSTANCE, patch: "no diff here" }, "/ws/path");
  assert.equal(row, null);
  assert.match(skipped ?? "", /no files/);
});

// --- swe-bench loading --------------------------------------------------------

test("loadSweBench indexes records by instance_id", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vtrace-r5r-swe-"));
  const dataPath = path.join(dir, "data.jsonl");
  writeFileSync(
    dataPath,
    [
      JSON.stringify({ instance_id: "a__b-1", repo: "a/b", patch: "+++ b/x.py\n", problem_statement: "Title\nbody." }),
      "not json",
      JSON.stringify({ instance_id: "a__b-2", repo: "a/b", patch: "", problem_statement: "" }),
    ].join("\n"),
  );
  const map = await loadSweBench(dataPath);
  assert.equal(map.size, 2);
  assert.equal(map.get("a__b-1")!.repo, "a/b");
});
