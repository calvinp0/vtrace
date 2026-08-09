import assert from "node:assert/strict";
import { test } from "bun:test";

import { parseTestNodeId, shapeSweQuery, stripDiffPrefix } from "./sweQueryShaping";
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

test("URL path-tails do not leak into likelyFiles", () => {
  // A PR link and a google-groups link both have path tails that REPO_PATH_LIKE
  // would otherwise match (`.../django/django/pull/7920`, `.../searchin/...`).
  const shaped = shapeSweQuery({
    repo: "django/django",
    problemStatement:
      "See the fix in https://github.com/django/django/pull/7920 and the thread at "
      + "https://groups.google.com/forum/#!searchin/django-users/Django$20bug for context. "
      + "The real change is in django/contrib/admin/options.py.",
    failToPass: ["tests.admin.test_x.AdminTest.test_get_inlines"],
  });

  assert.ok(!shaped.likelyFiles.some((file) => file.includes("pull/7920")));
  assert.ok(!shaped.likelyFiles.some((file) => file.includes("searchin")));
  // The genuine repo-relative path still survives.
  assert.ok(shaped.likelyFiles.includes("django/contrib/admin/options.py"));
});

test("a/ and b/ diff prefixes normalize to one real path", () => {
  const shaped = shapeSweQuery({
    repo: "django/django",
    problemStatement:
      "Traceback points here:\n"
      + "--- a/django/contrib/admindocs/utils.py\n"
      + "+++ b/django/contrib/admindocs/utils.py\n"
      + "@@ def replace_named_groups @@",
    failToPass: ["tests.admin_docs.test_utils.TestUtils.test_replace_named_groups"],
  });

  // Both diff headers collapse to the single real path — not counted twice.
  assert.ok(shaped.likelyFiles.includes("django/contrib/admindocs/utils.py"));
  assert.ok(!shaped.likelyFiles.some((file) => file.startsWith("a/") || file.startsWith("b/")));
  assert.equal(
    shaped.likelyFiles.filter((file) => file.endsWith("admindocs/utils.py")).length,
    1,
  );
});

test("stripDiffPrefix removes a single leading a/ or b/ only", () => {
  assert.equal(stripDiffPrefix("a/django/x.py"), "django/x.py");
  assert.equal(stripDiffPrefix("b/django/x.py"), "django/x.py");
  // A real path that merely starts with a one-letter dir is untouched beyond the
  // first segment; and a normal path is returned as-is.
  assert.equal(stripDiffPrefix("django/x.py"), "django/x.py");
  assert.equal(stripDiffPrefix("c/django/x.py"), "c/django/x.py");
});

test("shaping tolerates an empty record", () => {
  const shaped = shapeSweQuery({});
  assert.deepEqual(shaped, {
    query: "",
    failingTests: [],
    likelyFiles: [],
    likelySymbols: [],
    identifiers: [],
    filteredGenericSymbols: [],
    filteredRunnerFiles: [],
    derivedIntent: {
      originalTask: "\n",
      positiveSearchText: "",
      positiveTerms: [],
      contrastTerms: [],
      contrastPhrases: [],
      normalizedContrastPhrases: [],
      contrastClauses: [],
      explicitIdentifiers: [],
      contrastIdentifiers: [],
      comparisonIdentifiers: [],
      identifierSignals: [],
      weakLiteralTokens: [],
    },
  });
});

// ---- generic lexical-noise filtering ----

test("generic words captured by a symbol regex do not become likely symbols", () => {
  const shaped = shapeSweQuery({
    repo: "django/django",
    problemStatement:
      // Backtick-quoted generics (`error`, `multiple`) are exactly what the
      // symbol regexes greedily capture and what then steered retrieval wrongly.
      "A model with multiple OneToOneField relations fails: `error` is raised for "
      + "`multiple` related fields. The real fix is in deconstruct().",
    failToPass: ["tests.model_fields.test_field.FieldTests.test_multiple_one_to_one"],
  });

  // The generic words were captured but dropped from the high-confidence signal.
  assert.ok(!shaped.likelySymbols.includes("multiple"));
  assert.ok(!shaped.likelySymbols.includes("error"));
  assert.ok(shaped.filteredGenericSymbols.includes("error"));
  assert.ok(shaped.filteredGenericSymbols.includes("multiple"));
  // Meaningful symbols are preserved: deconstruct() (a call) is a likely symbol;
  // the bare CamelCase OneToOneField survives in the broader identifier set.
  assert.ok(shaped.likelySymbols.includes("deconstruct"));
  assert.ok(shaped.identifiers.includes("OneToOneField"));
});

test("compound names containing a generic word survive (only whole-token matches drop)", () => {
  const shaped = shapeSweQuery({
    repo: "django/django",
    problemStatement: "The `multiple_chunks` helper and `create_model` are involved.",
    failToPass: [],
  });
  assert.ok(shaped.likelySymbols.includes("multiple_chunks"));
  assert.ok(shaped.likelySymbols.includes("create_model"));
  assert.deepEqual(shaped.filteredGenericSymbols, []);
});

test("a 'python manage.py' command invocation does not make manage.py a likely file", () => {
  const shaped = shapeSweQuery({
    repo: "django/django",
    problemStatement:
      "Running `python manage.py check` raises an exception. The real fix is in "
      + "django/core/checks/registry.py.",
    failToPass: [],
  });

  assert.ok(!shaped.likelyFiles.includes("manage.py"));
  assert.ok(shaped.filteredRunnerFiles.includes("manage.py"));
  // The genuine production path is kept.
  assert.ok(shaped.likelyFiles.includes("django/core/checks/registry.py"));
});

test("an explicit runner path (with a directory) is kept, not treated as noise", () => {
  const shaped = shapeSweQuery({
    repo: "django/django",
    problemStatement: "The change belongs in tests/runtests.py near the option parsing.",
    failToPass: [],
  });
  assert.ok(shaped.likelyFiles.includes("tests/runtests.py"));
  assert.ok(!shaped.filteredRunnerFiles.includes("tests/runtests.py"));
});

test("generic tokens stay in the raw query text but are not promoted to symbols", () => {
  const shaped = shapeSweQuery({
    repo: "django/django",
    problemStatement: "Multiple aggregates produce the wrong error message.",
    failToPass: [],
  });
  // Still present in the raw prose lead for BM25/full-text recall.
  assert.ok(/multiple/i.test(shaped.query));
  // But never a high-confidence symbol.
  assert.ok(!shaped.likelySymbols.some((s) => s.toLowerCase() === "multiple"));
  assert.ok(!shaped.identifiers.some((s) => s.toLowerCase() === "multiple"));
});

test("a dotted data value does not promote its generic leaf as an exact symbol seed", () => {
  const shaped = shapeSweQuery({
    problemStatement: "ImproperlyConfigured for appname.Picking.origin while setting up the parent link.",
  });
  assert.ok(!shaped.likelySymbols.includes("origin"));
  assert.ok(shaped.identifiers.includes("appname.Picking.origin"));
});
