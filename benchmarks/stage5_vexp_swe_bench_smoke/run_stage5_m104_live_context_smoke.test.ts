// M104 no-agent smoke helper — unit tests for the pure leakage-scan /
// parity primitives and the psf-5414-style provenance policy.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FORBIDDEN_MARKERS,
  SMOKE_CASE_IDS,
  derivableFromWorkspace,
  goldAddedLines,
  presentInWorkspace,
  scanForbiddenStrings,
  scanLeakage,
  sha256,
} from "./run_stage5_m104_live_context_smoke";
import { buildCapsuleV2Task, toSweBenchInstance } from "./run_stage5_vexp_swe_bench_smoke";
import { deriveStructuredTaskFromProblemStatement } from "./stage5_task_derivation";
import { assessGoldLeakage, extractGold } from "./stage5_m94_lib";

const GOLD_PATCH = [
  "diff --git a/requests/models.py b/requests/models.py",
  "--- a/requests/models.py",
  "+++ b/requests/models.py",
  "@@ -400,6 +400,8 @@ class PreparedRequest:",
  "     def prepare_url(self, url, params):",
  "+        if not unicode_is_ascii(host):",
  "+            raise InvalidURL('URL has an invalid label.')",
  "+",
].join("\n");

test("scanForbiddenStrings finds needles with snippets and skips blanks", () => {
  const hay = "context …\nrun tests.admin_docs.test_utils.TestUtils.test_replace_named_groups now";
  const hits = scanForbiddenStrings(hay, "fail_to_pass_id", [
    "tests.admin_docs.test_utils.TestUtils.test_replace_named_groups",
    "",
    "not_present_anywhere",
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.kind, "fail_to_pass_id");
  assert.match(hits[0]!.snippet, /test_replace_named_groups/);
});

test("goldAddedLines keeps non-trivial added lines only", () => {
  const lines = goldAddedLines(GOLD_PATCH);
  assert.deepEqual(lines, [
    "if not unicode_is_ascii(host):",
    "raise InvalidURL('URL has an invalid label.')",
  ]);
});

test("scanLeakage is clean on issue-only text and fires on hidden labels / gold added lines", () => {
  const labels = {
    failToPass: ["tests/test_requests.py::TestRequests::test_invalid_label"],
    passToPass: ["tests/test_requests.py::TestRequests::test_ok"],
    goldPatch: GOLD_PATCH,
  };
  const clean = scanLeakage("Fix InvalidURL handling in requests/models.py prepare_url", labels);
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.hits, []);
  assert.deepEqual(clean.goldAddedLineMatches, []);

  // A FAIL_TO_PASS node id in the context is a leak…
  const failLeak = scanLeakage(
    "run tests/test_requests.py::TestRequests::test_invalid_label to verify",
    labels,
  );
  assert.equal(failLeak.clean, false);
  assert.equal(failLeak.hits[0]!.kind, "fail_to_pass_id");

  // …as is post-fix gold code…
  const goldLeak = scanLeakage("insert raise InvalidURL('URL has an invalid label.') here", labels);
  assert.equal(goldLeak.clean, false);
  assert.deepEqual(goldLeak.goldAddedLineMatches, ["raise InvalidURL('URL has an invalid label.')"]);

  // …and the old pre-M104 composite labels are forbidden markers.
  for (const marker of ["failing tests:", "hints:", "FAIL_TO_PASS"]) {
    assert.ok(FORBIDDEN_MARKERS.includes(marker));
    assert.equal(scanLeakage(`x ${marker} y`, labels).clean, false);
  }
});

test("psf-5414-style provenance: issue-authored gold path allowed, gold-patch-derived path blocked", () => {
  // The issue ITSELF names the gold file — legitimate issue-authored evidence.
  const statement = [
    "UnicodeError not caught in prepare_url",
    "",
    "Attempting to get a URL with an invalid label raises UnicodeError from requests/models.py instead of InvalidURL.",
  ].join("\n");
  const gold = extractGold(GOLD_PATCH);
  const instance = toSweBenchInstance({
    repo: "psf/requests",
    instance_id: "psf__requests-5414",
    base_commit: "deadbeef",
    problem_statement: statement,
    FAIL_TO_PASS: '["tests/test_requests.py::TestRequests::test_invalid_label"]',
  });
  const task = buildCapsuleV2Task(instance);
  assert.equal(task, deriveStructuredTaskFromProblemStatement(statement).taskText);
  assert.match(task, /requests\/models\.py/);

  const allowed = assessGoldLeakage(task, statement, gold);
  assert.equal(allowed.verdict, "issue_authored_gold_path");
  assert.deepEqual(allowed.issueAuthoredPaths, ["requests/models.py"]);
  assert.deepEqual(allowed.leakedPaths, []);

  // The same gold path in a task whose issue never mentioned it stays blocked.
  const blocked = assessGoldLeakage(
    "fix the bug in requests/models.py",
    "Some issue that never names the file.",
    gold,
  );
  assert.equal(blocked.verdict, "gold_patch_leak");
  assert.deepEqual(blocked.leakedPaths, ["requests/models.py"]);
});

test("presentInWorkspace distinguishes base-commit content from absent needles", () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "m104-ws-"));
  mkdirSync(path.join(ws, ".vtrace"), { recursive: true });
  writeFileSync(path.join(ws, "models.py"), "def prepare_url(self, url, params):\n    pass\n");
  writeFileSync(path.join(ws, ".vtrace", "notes.txt"), "SECRET_NEEDLE_IN_BOOKKEEPING\n");
  // Real repo content is found…
  assert.equal(presentInWorkspace(ws, "def prepare_url(self, url, params):"), true);
  // …absent strings are not…
  assert.equal(presentInWorkspace(ws, "tests/test_requests.py::TestRequests::test_invalid_label"), false);
  // …and .vtrace bookkeeping never counts as repo content.
  assert.equal(presentInWorkspace(ws, "SECRET_NEEDLE_IN_BOOKKEEPING"), false);
});

test("derivableFromWorkspace resolves path::symbol composites from base-commit content", () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "m104-ws-"));
  mkdirSync(path.join(ws, "tests"), { recursive: true });
  writeFileSync(path.join(ws, "tests", "test_domain_py.py"), "def test_parse_annotation(app):\n    pass\n");
  // The pytest-node-id-shaped composite is derivable: the file exists and the
  // symbol appears in it (vtrace's own caller rendering built it from the index).
  assert.equal(derivableFromWorkspace(ws, "tests/test_domain_py.py::test_parse_annotation"), true);
  // A composite whose symbol is NOT in the file is not derivable…
  assert.equal(derivableFromWorkspace(ws, "tests/test_domain_py.py::test_added_by_gold_patch"), false);
  // …nor one whose file does not exist, nor a plain absent string.
  assert.equal(derivableFromWorkspace(ws, "tests/missing.py::test_parse_annotation"), false);
  assert.equal(derivableFromWorkspace(ws, "test_parse_annotation_absent"), false);
});

test("smoke helper primitives are deterministic and the case set is pinned", () => {
  assert.equal(sha256("abc"), sha256("abc"));
  assert.notEqual(sha256("abc"), sha256("abd"));
  // 12–16 representative cases, incl. the mandated ids.
  assert.ok(SMOKE_CASE_IDS.length >= 12 && SMOKE_CASE_IDS.length <= 16);
  for (const id of [
    "psf__requests-5414",
    "django__django-13513",
    "matplotlib__matplotlib-22719",
    "pydata__xarray-4695",
    "sympy__sympy-13372",
    "sympy__sympy-13480",
    "django__django-16938",
    "django__django-16256",
  ]) {
    assert.ok(SMOKE_CASE_IDS.includes(id), `${id} must be in the smoke set`);
  }
});
