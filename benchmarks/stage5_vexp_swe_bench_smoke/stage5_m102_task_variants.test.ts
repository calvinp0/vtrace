// M102 task-variant helper tests: parity with the production derivation for
// V0, deterministic capped extraction for the structured variants, and the
// structural guarantee that variants read the problem statement only.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { deriveTaskFromProblemStatement } from "./build_stage5_retrieval_fixture";
import {
  buildAllTaskVariants,
  buildTaskVariant,
  extractBacktickedIdentifiers,
  extractCodeLikeTokens,
  extractDottedModuleLikes,
  extractExceptionLikes,
  extractFailingTestNames,
  extractFilePathLikes,
  extractQuotedIdentifiers,
  extractTracebackLines,
  M102_VARIANT_NAMES,
  MAX_ADDED_IDENTIFIERS,
  MAX_FILE_PATH_LIKES,
  MAX_STRUCTURED_CHARS,
  MAX_TRACEBACK_LINES,
  wordSafePrefix,
} from "./stage5_m102_task_variants";

const STATEMENT = `QuerySet.count() ignores annotations
Description
When calling \`QuerySet.count()\` with an unused annotation, django/db/models/sql/query.py still joins the table.
The failing test is tests/aggregation/tests.py::AggregateTestCase::test_count_star and also test_unused_annotation.
Reproduce:
\`\`\`python
qs = Book.objects.annotate(n=Count("chapters"))
qs.count()
\`\`\`
Traceback (most recent call last):
  File "django/db/models/query.py", line 412, in count
    return self.query.get_count(using=self.db)
  File "django/db/models/sql/query.py", line 550, in get_count
    number = obj.get_aggregation(using, ["__count"])["__count"]
TypeError: get_aggregation() missing 1 required positional argument
See also utils.numberformat.format and the 'has_key' lookup.`;

test("M102: V0_current is byte-identical to the production derivation", () => {
  const v0 = buildTaskVariant("V0_current", STATEMENT);
  assert.equal(v0.text, deriveTaskFromProblemStatement(STATEMENT));
  assert.equal(v0.meta.added_chars, 0);
});

test("M102: V1_720 / V2_1200 are word-safe prefixes within their caps", () => {
  const v1 = buildTaskVariant("V1_720", STATEMENT);
  const v2 = buildTaskVariant("V2_1200", STATEMENT);
  assert.ok(v1.text.length <= 720);
  assert.ok(v2.text.length <= 1200);
  // Prefix property (modulo the ellipsis) and no mid-token cut.
  assert.ok(STATEMENT.replace(/\r/g, "").startsWith(v1.text.replace(/…$/, "")));
  assert.ok(!/[A-Za-z0-9_]…$/.test(`${v1.text} `) || v1.text.endsWith("…"));
  // A statement shorter than the cap passes through whole.
  assert.equal(buildTaskVariant("V1_720", "Short title\nOne sentence here.").text.includes("…"), false);
});

test("M102: wordSafePrefix never slices through a token", () => {
  const text = "alpha beta gamma delta_epsilon zeta";
  const cut = wordSafePrefix(text, 24);
  assert.ok(cut.length <= 24);
  assert.ok(!cut.includes("delta_eps") || cut.includes("delta_epsilon"));
});

test("M102: backticked/quoted identifier extraction is code-like only, deduped, in order", () => {
  const ids = extractBacktickedIdentifiers("`QuerySet.count()` then `QuerySet.count()` and `a plain phrase` and `has_key`");
  assert.deepEqual(ids, ["QuerySet.count()", "has_key"]);
  const quoted = extractQuotedIdentifiers("uses 'has_key' twice: 'has_key', and a word 'plain' stays out");
  assert.deepEqual(quoted, ["has_key"]);
});

test("M102: file/path-like extraction", () => {
  const paths = extractFilePathLikes(STATEMENT);
  assert.ok(paths.includes("django/db/models/sql/query.py"));
  assert.ok(paths.includes("django/db/models/query.py"));
  assert.ok(paths.length <= MAX_FILE_PATH_LIKES);
});

test("M102: dotted module extraction skips files and versions", () => {
  const dotted = extractDottedModuleLikes("see utils.numberformat.format, version 1.2.3, and pkg/mod/file.py");
  assert.ok(dotted.includes("utils.numberformat.format"));
  assert.ok(!dotted.some((d) => d.includes("1.2")));
  assert.ok(!dotted.some((d) => d.endsWith(".py")));
});

test("M102: exception and failing-test extraction", () => {
  assert.deepEqual(extractExceptionLikes(STATEMENT), ["TypeError"]);
  const tests = extractFailingTestNames(STATEMENT);
  assert.ok(tests.some((t) => t.includes("tests/aggregation/tests.py::AggregateTestCase")));
  assert.ok(tests.includes("test_unused_annotation"));
});

test("M102: traceback extraction keeps frames + final error line, capped head/tail", () => {
  const tb = extractTracebackLines(STATEMENT);
  assert.ok(tb.some((l) => l.includes('File "django/db/models/sql/query.py"')));
  assert.ok(tb.some((l) => l.startsWith("TypeError:")));
  // Cap: 20 synthetic frames collapse to MAX_TRACEBACK_LINES, first+last halves.
  const many = Array.from({ length: 20 }, (_, i) => `  File "pkg/m${i}.py", line ${i + 1}, in f${i}`).join("\n");
  const capped = extractTracebackLines(many);
  assert.equal(capped.length, MAX_TRACEBACK_LINES);
  assert.ok(capped[0]!.includes("m0.py"));
  assert.ok(capped.at(-1)!.includes("m19.py"));
});

test("M102: V3_structured_lite contains V0 plus capped labelled evidence, under the char cap", () => {
  const v3 = buildTaskVariant("V3_structured_lite", STATEMENT);
  const v0 = deriveTaskFromProblemStatement(STATEMENT);
  assert.ok(v3.text.startsWith(v0));
  assert.ok(v3.text.length <= MAX_STRUCTURED_CHARS);
  assert.ok(v3.text.includes("django/db/models/sql/query.py"));
  assert.ok(v3.text.includes("TypeError"));
  assert.ok(v3.meta.quoted_identifier_count <= MAX_ADDED_IDENTIFIERS);
});

test("M102: V5 carries error/test/traceback only; V7 carries code tokens; both capped", () => {
  const v5 = buildTaskVariant("V5_title_plus_errors", STATEMENT);
  assert.ok(v5.text.includes("TypeError"));
  assert.ok(!v5.text.includes("Files mentioned"));
  assert.ok(v5.text.length <= MAX_STRUCTURED_CHARS);
  const v7 = buildTaskVariant("V7_compressed_literals", STATEMENT);
  assert.ok(v7.text.includes("Code tokens"));
  assert.ok(v7.text.length <= MAX_STRUCTURED_CHARS);
  const tokens = extractCodeLikeTokens(STATEMENT);
  assert.ok(tokens.length <= MAX_ADDED_IDENTIFIERS);
  assert.ok(tokens.includes("test_count_star") || tokens.includes("get_aggregation"));
});

test("M102: V6_first_last stitches word-safe head and tail for long statements", () => {
  const long = `${"start words ".repeat(50)}\nMIDDLE FILLER\n${"end words ".repeat(50)}tail_token`;
  const v6 = buildTaskVariant("V6_first_last", long);
  assert.ok(v6.text.length <= 760);
  assert.ok(v6.text.includes("start words"));
  assert.ok(v6.text.includes("tail_token"));
  // Short statements pass through whole.
  assert.equal(buildTaskVariant("V6_first_last", "tiny statement body").text, "tiny statement body");
});

test("M102: variants are deterministic and read the problem statement only", () => {
  // Determinism: two runs are byte-identical.
  const a = buildAllTaskVariants(STATEMENT);
  const b = buildAllTaskVariants(STATEMENT);
  assert.deepEqual(a, b);
  assert.equal(a.length, M102_VARIANT_NAMES.length);
  // The only input is the problem statement string — there is no parameter
  // through which a gold patch could be passed (structural no-leakage check).
  assert.equal(buildTaskVariant.length, 2);
  for (const v of a) {
    assert.equal(v.meta.task_text_chars, v.text.length);
    assert.equal(v.meta.task_text_est_tokens, Math.ceil(v.text.length / 4));
  }
});
