// M103 structured task derivation tests: V0 base parity, capped deterministic
// extraction, V5 byte-equivalence against the frozen M102 variant helper, the
// no-long-prose guarantee, and the provenance-based leakage policy.

import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  deriveStructuredTaskFromProblemStatement,
  deriveTaskFromProblemStatement,
  extractExceptionNames,
  extractFailingTestIds,
  extractTracebackFrames,
  MAX_STRUCTURED_TASK_CHARS,
  MAX_TASK_EXCEPTIONS,
  MAX_TASK_FAILING_TESTS,
  MAX_TASK_TRACEBACK_FRAMES,
} from "./stage5_task_derivation";
import { buildTaskVariant } from "./stage5_m102_task_variants";
import { assessGoldLeakage, assertNoGoldLeakage, extractGold } from "./stage5_m94_lib";

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

// psf__requests-5414 shape: the ISSUE ITSELF names the gold file in its traceback.
const ISSUE_NAMES_GOLD = `Getting http://.example.com raises UnicodeError
Attempting to get e.g. http://.example.com results in a UnicodeError.
Traceback (most recent call last):
  File "requests/models.py", line 401, in prepare_url
    host = self._get_idna_encoded_host(host)
UnicodeError: label empty or too long`;

const GOLD_PATCH_5414 = `diff --git a/requests/models.py b/requests/models.py
--- a/requests/models.py
+++ b/requests/models.py
@@ -400,3 +400,3 @@ class PreparedRequest:
-        if not host:
+        if not host or "." not in host:
             raise InvalidURL
`;

test("M103: base task derivation is unchanged (V0 parity)", () => {
  const d = deriveStructuredTaskFromProblemStatement(STATEMENT);
  assert.equal(d.baseTask, deriveTaskFromProblemStatement(STATEMENT));
  assert.ok(d.taskText.startsWith(d.baseTask));
  // The historical entry points keep working byte-identically.
  assert.equal(deriveTaskFromProblemStatement("Just a title"), "Just a title");
  assert.equal(deriveTaskFromProblemStatement(""), "");
});

test("M103: taskText is byte-identical to the measured M102 V5 variant", () => {
  for (const ps of [
    STATEMENT,
    ISSUE_NAMES_GOLD,
    "Just a title",
    "",
    "Title only\nA prose sentence without any error evidence at all.",
    // Long traceback: exercises head+tail frame selection AND section trimming.
    `Big crash\nSomething broke badly in the scheduler.\n${Array.from(
      { length: 30 },
      (_, i) => `  File "pkg/module_${i}.py", line ${i + 1}, in fn_${i}`,
    ).join("\n")}\nRuntimeError: boom`,
  ]) {
    assert.equal(
      deriveStructuredTaskFromProblemStatement(ps).taskText,
      buildTaskVariant("V5_title_plus_errors", ps).text,
    );
  }
});

test("M103: exception extraction — class-like names, deduped, ordered, capped", () => {
  assert.deepEqual(extractExceptionNames(STATEMENT).kept, ["TypeError"]);
  const many = Array.from({ length: 10 }, (_, i) => `Alpha${i}Error`).join(" then ")
    + " AlphaWarning SomeException typeerror lowercase_error";
  const ex = extractExceptionNames(many);
  assert.equal(ex.kept.length, MAX_TASK_EXCEPTIONS);
  assert.deepEqual(ex.kept.slice(0, 2), ["Alpha0Error", "Alpha1Error"]); // first-occurrence order
  assert.equal(ex.unique, 12);
  // Lowercase words and prose never match.
  assert.deepEqual(extractExceptionNames("no errors here, just prose").kept, []);
  // Dedupe is exact-token.
  assert.deepEqual(extractExceptionNames("TypeError TypeError ValueError").kept, ["TypeError", "ValueError"]);
});

test("M103: failing-test extraction — node ids preferred, bare test names, no generic 'test'", () => {
  const t = extractFailingTestIds(STATEMENT);
  assert.equal(t.kept[0], "tests/aggregation/tests.py::AggregateTestCase::test_count_star");
  assert.ok(t.kept.includes("test_unused_annotation"));
  // A full node id is collected before the bare name, so it wins the dedupe order.
  const both = extractFailingTestIds("run path/to/test_file.py::test_alpha and test_alpha and test_beta");
  assert.equal(both.kept[0], "path/to/test_file.py::test_alpha");
  // "test" alone never matches; caps hold.
  assert.deepEqual(extractFailingTestIds("the test suite and a test run").kept, []);
  const many = Array.from({ length: 12 }, (_, i) => `test_case_${i}`).join(" ");
  assert.equal(extractFailingTestIds(many).kept.length, MAX_TASK_FAILING_TESTS);
});

test("M103: traceback extraction — frames + error line, dedupe, head+tail cap, long-line truncation", () => {
  const tb = extractTracebackFrames(STATEMENT);
  assert.ok(tb.kept.some((l) => l.includes('File "django/db/models/sql/query.py"')));
  assert.ok(tb.kept.some((l) => l.startsWith("TypeError:")));
  const many = Array.from({ length: 20 }, (_, i) => `  File "pkg/m${i}.py", line ${i + 1}, in f${i}`).join("\n");
  const capped = extractTracebackFrames(many);
  assert.equal(capped.kept.length, MAX_TASK_TRACEBACK_FRAMES);
  assert.ok(capped.kept[0]!.includes("m0.py"));
  assert.ok(capped.kept.at(-1)!.includes("m19.py"));
  assert.equal(capped.unique, 20);
  // Repeated frames dedupe; a huge line is truncated at 160 chars.
  const dup = 'File "a/b.py", line 1, in f\n' + 'File "a/b.py", line 1, in f';
  assert.equal(extractTracebackFrames(dup).kept.length, 1);
  const huge = `RuntimeError: ${"x".repeat(500)}`;
  assert.equal(extractTracebackFrames(huge).kept[0]!.length, 160);
});

test("M103: structured evidence formatting is labelled lines, not raw prose", () => {
  const d = deriveStructuredTaskFromProblemStatement(STATEMENT);
  assert.deepEqual(d.addedEvidence, [
    `Errors: TypeError`,
    `Failing tests: ${d.failingTests.join(" | ")}`,
    `Traceback: ${d.tracebackFrames.join(" | ")}`,
  ]);
  assert.equal(d.taskText, [d.baseTask, ...d.addedEvidence].join("\n"));
  // No evidence ⇒ the task IS the base, with no dangling labels.
  const bare = deriveStructuredTaskFromProblemStatement("Title only\nA prose sentence with no evidence.");
  assert.equal(bare.taskText, bare.baseTask);
  assert.deepEqual(bare.addedEvidence, []);
});

test("M103: no long-prose default — total cap holds and base is never trimmed", () => {
  const longProse = `Title of the issue\n${"prose ".repeat(2000)}`;
  const d = deriveStructuredTaskFromProblemStatement(longProse);
  // The base stays the word-safe 360-char derivation, NOT a longer prose window.
  assert.ok(d.baseTask.length <= 360);
  assert.equal(d.taskText, d.baseTask);
  // A statement with a huge traceback still respects the total cap by dropping
  // whole sections from the end, never by injecting raw prose.
  const hugeTb = `Crash title\nA short description sentence.\n${Array.from(
    { length: 8 },
    (_, i) => `  File "pkg/very/long/path/segment/number/${i}/${"x".repeat(120)}.py", line ${i}, in f${i}`,
  ).join("\n")}\nRuntimeError: boom`;
  const d2 = deriveStructuredTaskFromProblemStatement(hugeTb);
  assert.ok(d2.taskText.length <= MAX_STRUCTURED_TASK_CHARS);
  assert.ok(d2.taskText.startsWith(d2.baseTask));
  assert.equal(d2.diagnostics.capped, true);
  assert.ok(d2.diagnostics.omittedCounts.evidence_sections_trimmed! >= 1);
});

test("M103: derivation is deterministic and structurally gold-blind", () => {
  const a = deriveStructuredTaskFromProblemStatement(STATEMENT);
  const b = deriveStructuredTaskFromProblemStatement(STATEMENT);
  assert.deepEqual(a, b);
  // Single-parameter signature: no channel for gold patch / benchmark metadata.
  assert.equal(deriveStructuredTaskFromProblemStatement.length, 1);
  assert.equal(a.diagnostics.provenance, "issue_problem_statement");
  assert.equal(a.diagnostics.taskChars, a.taskText.length);
  assert.equal(a.diagnostics.baseChars, a.baseTask.length);
});

test("M103: issue-authored gold path is evidence, not leakage", () => {
  const gold = extractGold(GOLD_PATCH_5414);
  const d = deriveStructuredTaskFromProblemStatement(ISSUE_NAMES_GOLD);
  // The structured task now carries the gold path (from the issue's traceback)…
  assert.ok(d.taskText.includes("requests/models.py"));
  // …the legacy guard would block it…
  assert.equal(assertNoGoldLeakage(d.taskText, gold), "requests/models.py");
  // …but the provenance-aware guard classifies it as issue-authored and scoreable.
  const assessed = assessGoldLeakage(d.taskText, ISSUE_NAMES_GOLD, gold);
  assert.equal(assessed.verdict, "issue_authored_gold_path");
  assert.deepEqual(assessed.issueAuthoredPaths, ["requests/models.py"]);
  assert.deepEqual(assessed.leakedPaths, []);
});

test("M103: gold-patch-derived path is still a blocking leak", () => {
  const gold = extractGold(GOLD_PATCH_5414);
  // A task that names the gold path the ISSUE NEVER MENTIONED is contamination.
  const statement = "Some crash\nA description that never names any file at all.";
  const contaminated = `${statement.split("\n")[0]} — fix requests/models.py`;
  const assessed = assessGoldLeakage(contaminated, statement, gold);
  assert.equal(assessed.verdict, "gold_patch_leak");
  assert.deepEqual(assessed.leakedPaths, ["requests/models.py"]);
  // Clean task ⇒ clean verdict; bare basenames are never flagged.
  assert.equal(assessGoldLeakage("mentions models.py only", statement, gold).verdict, "clean");
});
