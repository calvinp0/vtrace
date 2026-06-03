import assert from "node:assert/strict";
import { test } from "bun:test";

import { parseTestNodeId, shapeSweQuery } from "./sweQueryShaping";
import { SWE_10880, SWE_11490, SWE_11740 } from "./__fixtures__/sweRecords";

test("parseTestNodeId handles django dotted node ids", () => {
  const parts = parseTestNodeId(
    "tests.admin_docs.test_utils.TestUtils.test_replace_named_groups",
  );
  assert.deepEqual(parts.symbols, ["TestUtils", "test_replace_named_groups"]);
  assert.equal(parts.file, undefined);
});

test("parseTestNodeId handles pytest path::node ids", () => {
  const parts = parseTestNodeId("tests/admin_docs/test_utils.py::TestUtils::test_x");
  assert.equal(parts.file, "tests/admin_docs/test_utils.py");
  assert.deepEqual(parts.symbols, ["TestUtils", "test_x"]);
});

test("shaping surfaces failing tests, files, and symbols", () => {
  const shaped = shapeSweQuery(SWE_11490);

  assert.equal(shaped.failingTests.length, 2);
  assert.ok(shaped.likelyFiles.includes("django/db/models/sql/compiler.py"));
  assert.ok(shaped.likelyFiles.includes("django/db/models/sql/query.py"));
  assert.ok(shaped.likelySymbols.includes("get_combinator_sql"));
  assert.ok(shaped.likelySymbols.includes("set_values"));
});

test("shaped query is signal-first and bounded, not the whole issue", () => {
  const shaped = shapeSweQuery(SWE_11490, { maxQueryChars: 600 });

  assert.ok(shaped.query.length <= 600);
  // High-signal lines appear before the prose lead.
  const filesIdx = shaped.query.indexOf("files:");
  const issueIdx = shaped.query.indexOf("issue:");
  assert.ok(filesIdx !== -1 && issueIdx !== -1 && filesIdx < issueIdx);
  // It must NOT contain the full multi-sentence problem statement.
  assert.ok(!shaped.query.includes("cross-module column resolution"));
});

test("shaping a small/local record yields few files and symbols", () => {
  const shaped = shapeSweQuery(SWE_10880);

  assert.equal(shaped.failingTests.length, 1);
  assert.deepEqual(shaped.likelyFiles, []); // dotted module path, no .py path string
  assert.ok(shaped.likelySymbols.includes("json_script"));
});

test("shaping picks up repo-relative path and autodetector symbol", () => {
  const shaped = shapeSweQuery(SWE_11740);

  assert.ok(shaped.likelyFiles.includes("django/db/migrations/autodetector.py"));
  assert.ok(shaped.likelySymbols.includes("generate_altered_fields"));
  assert.ok(shaped.query.startsWith("repo: django/django"));
});

test("shaping is deterministic", () => {
  assert.deepEqual(shapeSweQuery(SWE_11490), shapeSweQuery(SWE_11490));
});

test("shaping tolerates an empty record", () => {
  const shaped = shapeSweQuery({});
  assert.deepEqual(shaped, {
    query: "",
    failingTests: [],
    likelyFiles: [],
    likelySymbols: [],
    identifiers: [],
  });
});
