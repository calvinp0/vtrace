import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  checklistToolAgreement,
  classifyPivotInspection,
  contextMentionsFile,
  contextMentionsSymbol,
  editedFilesFromPatch,
  editedSymbolsFromPatch,
  parseNeighborhoodUse,
  parsePivotCheckRows,
  primaryEditedFile,
  primaryEditedSymbol,
  type PivotForInspection,
} from "./finalEditDiagnostics";

const PATCH = `diff --git a/django/contrib/admin/options.py b/django/contrib/admin/options.py
--- a/django/contrib/admin/options.py
+++ b/django/contrib/admin/options.py
@@ -580,7 +580,10 @@ class ModelAdmin(BaseModelAdmin):
     def get_inline_instances(self, request, obj=None):
         inline_instances = []
-        for inline_class in self.inlines:
+        for inline_class in self.get_inlines(request, obj):
             inline = inline_class(self.model, self.admin_site)
+
+    def get_inlines(self, request, obj=None):
+        return self.inlines
diff --git a/tests/admin_inlines/tests.py b/tests/admin_inlines/tests.py
--- a/tests/admin_inlines/tests.py
+++ b/tests/admin_inlines/tests.py
@@ -100,0 +101,4 @@ class TestInline(TestCase):
+    def test_get_inlines_override(self):
+        pass
`;

test("editedFilesFromPatch lists every written file, prefixes stripped", () => {
  assert.deepEqual(editedFilesFromPatch(PATCH), [
    "django/contrib/admin/options.py",
    "tests/admin_inlines/tests.py",
  ]);
});

test("primaryEditedFile prefers the non-test source file", () => {
  assert.equal(primaryEditedFile(PATCH), "django/contrib/admin/options.py");
});

test("primaryEditedFile falls back to the first file when only tests change", () => {
  const testsOnly = `--- a/tests/admin_inlines/tests.py
+++ b/tests/admin_inlines/tests.py
@@ -1,0 +2,1 @@
+x = 1
`;
  assert.equal(primaryEditedFile(testsOnly), "tests/admin_inlines/tests.py");
});

test("editedSymbolsFromPatch surfaces added definitions before enclosing ones", () => {
  const symbols = editedSymbolsFromPatch(PATCH);
  assert.ok(symbols.includes("get_inlines")); // added `+    def get_inlines`
  assert.ok(symbols.includes("ModelAdmin")); // enclosing class from the hunk header
  assert.equal(primaryEditedSymbol(PATCH), "get_inlines");
});

test("deletions and /dev/null are ignored", () => {
  const deletion = `--- a/old/file.py
+++ /dev/null
@@ -1 +0,0 @@
-gone = True
`;
  assert.deepEqual(editedFilesFromPatch(deletion), []);
  assert.equal(primaryEditedFile(deletion), null);
});

test("contextMentionsFile matches full path or basename, but not unrelated text", () => {
  const ctx = "## likely edit targets\n- django/contrib/admin/options.py — ModelAdmin";
  assert.equal(contextMentionsFile(ctx, "django/contrib/admin/options.py"), true);
  assert.equal(contextMentionsFile("see options.py for the hook", "x/y/options.py"), true);
  assert.equal(contextMentionsFile("nothing relevant here", "django/db/models/query.py"), false);
  assert.equal(contextMentionsFile("", "any.py"), false);
});

test("contextMentionsSymbol is word-boundary aware", () => {
  assert.equal(contextMentionsSymbol("calls get_inlines(request)", "get_inlines"), true);
  assert.equal(contextMentionsSymbol("get_inline_instances only", "get_inlines"), false);
  assert.equal(contextMentionsSymbol("", "get_inlines"), false);
});

// ----- classifyPivotInspection -----------------------------------------------

const AST_PIVOT: PivotForInspection = {
  path: "sphinx/pycode/ast.py",
  symbol: "unparse",
  role: "pivot",
  hidden: true,
};

function only(records: ReturnType<typeof classifyPivotInspection>) {
  assert.equal(records.length, 1);
  return records[0]!;
}

test("1. direct read/open of pivot path => inspected", () => {
  const record = only(
    classifyPivotInspection(
      [AST_PIVOT],
      [{ tool: "Read", target: "sphinx/pycode/ast.py" }],
      [],
    ),
  );
  assert.equal(record.inspected, true);
  assert.equal(record.discovered, false);
  assert.equal(record.edited, false);
  assert.equal(record.status, "inspected");
});

test("2. grep/search hit only => discovered but not inspected", () => {
  const record = only(
    classifyPivotInspection(
      [AST_PIVOT],
      [{ tool: "grep", target: null, output: "sphinx/pycode/ast.py:42: def unparse(node):" }],
      [],
    ),
  );
  assert.equal(record.discovered, true);
  assert.equal(record.inspected, false);
  // Search visibility is not engagement: the pivot is still ignored.
  assert.equal(record.status, "ignored");
});

test("3. patch touches pivot path after read => inspected + edited", () => {
  const record = only(
    classifyPivotInspection(
      [AST_PIVOT],
      [{ tool: "Read", target: "sphinx/pycode/ast.py" }],
      ["sphinx/pycode/ast.py"],
    ),
  );
  assert.equal(record.inspected, true);
  assert.equal(record.edited, true);
  assert.equal(record.edited_without_inspection, false);
  assert.equal(record.status, "edited");
});

test("4. patch touches pivot path without read => edited_without_inspection", () => {
  const record = only(
    classifyPivotInspection(
      [AST_PIVOT],
      [{ tool: "grep", output: "found in sphinx/pycode/ast.py" }],
      ["sphinx/pycode/ast.py"],
    ),
  );
  assert.equal(record.edited, true);
  assert.equal(record.inspected, false);
  assert.equal(record.edited_without_inspection, true);
  assert.equal(record.status, "edited_without_inspection");
});

test("5. surfaced pivot with no read and no edit => ignored (sphinx-7462)", () => {
  const record = only(classifyPivotInspection([AST_PIVOT], [], []));
  assert.equal(record.discovered, false);
  assert.equal(record.inspected, false);
  assert.equal(record.edited, false);
  assert.equal(record.ruled_out, false);
  assert.equal(record.status, "ignored");
});

test("6. explicit ruled-out statement after read => ruled_out", () => {
  const record = only(
    classifyPivotInspection(
      [AST_PIVOT],
      [{ tool: "Read", target: "sphinx/pycode/ast.py" }],
      [],
      [{ path: "sphinx/pycode/ast.py" }],
    ),
  );
  assert.equal(record.inspected, true);
  assert.equal(record.ruled_out, true);
  assert.equal(record.status, "ruled_out");

  // A rule-out claim WITHOUT a prior read does not count — you cannot grounded-ly
  // dismiss a pivot you never opened.
  const noRead = only(
    classifyPivotInspection([AST_PIVOT], [], [], [{ path: "sphinx/pycode/ast.py" }]),
  );
  assert.equal(noRead.ruled_out, false);
  assert.equal(noRead.status, "ignored");
});

test("7. path normalization works (absolute target, diff-style suffix, basename)", () => {
  // Absolute checkout path read matches a repo-relative pivot.
  const abs = only(
    classifyPivotInspection(
      [AST_PIVOT],
      [{ tool: "open", target: "/tmp/ws/sphinx-7462/sphinx/pycode/ast.py" }],
      [],
    ),
  );
  assert.equal(abs.inspected, true);
  assert.equal(abs.status, "inspected");

  // Edited-file list carrying only the basename still matches.
  const base = only(classifyPivotInspection([AST_PIVOT], [], ["ast.py"]));
  assert.equal(base.edited, true);
});

test("8. classifier does not leak gold labels", () => {
  // The pivot here IS the correct fix location, but the agent never read or
  // edited it. A gold-aware classifier would mark it relevant/edited; a pure
  // observation-only classifier must report `ignored`. The function signature
  // takes no gold patch or expected-label argument, so it cannot peek.
  const goldButUntouched = only(
    classifyPivotInspection(
      [AST_PIVOT],
      [
        { tool: "Read", target: "sphinx/domains/python.py" },
        { tool: "grep", output: "sphinx/domains/python.py" },
      ],
      ["sphinx/domains/python.py"],
    ),
  );
  assert.equal(goldButUntouched.inspected, false);
  assert.equal(goldButUntouched.edited, false);
  assert.equal(goldButUntouched.status, "ignored");

  // Output shape is exactly the documented observation fields — no gold/expected
  // field leaks into the record.
  assert.deepEqual(Object.keys(goldButUntouched).sort(), [
    "discovered",
    "edited",
    "edited_without_inspection",
    "hidden",
    "inspected",
    "path",
    "role",
    "ruled_out",
    "status",
    "symbol",
  ]);
});

test("parsePivotCheckRows extracts filled rows and skips header/separator/template", () => {
  const text = [
    "Here is my analysis.",
    "## PIVOT_CHECK",
    "| pivot | symbol | inspected | relevant | edit_needed | reason |",
    "|---|---|---:|---:|---:|---|",
    "| lib/a.py | foo | yes | yes | yes | root cause |",
    "| lib/b.py | bar | no | no | no | unrelated helper |",
    "| lib/c.py | baz | yes/no | yes/no | yes/no | ... |",
  ].join("\n");
  const rows = parsePivotCheckRows(text);
  assert.equal(rows.length, 2); // header, separator, and unfilled template row dropped
  assert.deepEqual(rows[0], { path: "lib/a.py", inspected: true, editNeeded: true, reason: "root cause" });
  assert.deepEqual(rows[1], { path: "lib/b.py", inspected: false, editNeeded: false, reason: "unrelated helper" });
});

test("checklistToolAgreement flags a claimed-inspected pivot the tools never opened", () => {
  const rows = parsePivotCheckRows(
    [
      "| pivot | symbol | inspected | relevant | edit_needed | reason |",
      "|---|---|---:|---:|---:|---|",
      "| lib/a.py | foo | yes | yes | yes | edited it |",
      "| lib/b.py | bar | yes | no | no | claims inspected but never opened |",
    ].join("\n"),
  );
  const pivots: PivotForInspection[] = [
    { path: "lib/a.py", symbol: "foo", role: "pivot", hidden: false },
    { path: "lib/b.py", symbol: "bar", role: "pivot", hidden: true },
  ];
  // Tools: opened+edited a.py; never opened b.py.
  const records = classifyPivotInspection(
    pivots,
    [{ tool: "read", target: "lib/a.py" }],
    ["lib/a.py"],
  );
  const agreement = checklistToolAgreement(rows, records);
  assert.equal(agreement.rowsMatched, 2);
  assert.equal(agreement.inspectedClaims, 2);
  assert.equal(agreement.inspectedAgreements, 1); // a.py honest; b.py false claim
  assert.equal(agreement.claimedInspectedButNot, 1);
  assert.equal(agreement.agreement, 0.5);
});

test("checklistToolAgreement is null when no rows match a pivot", () => {
  const rows = parsePivotCheckRows(
    [
      "| pivot | symbol | inspected | relevant | edit_needed | reason |",
      "|---|---|---:|---:|---:|---|",
      "| unrelated/x.py | x | yes | yes | no | ... reason here |",
    ].join("\n"),
  );
  const records = classifyPivotInspection(
    [{ path: "lib/a.py", symbol: "foo", role: "pivot", hidden: false }],
    [],
    [],
  );
  assert.equal(checklistToolAgreement(rows, records).agreement, null);
});

test("parseNeighborhoodUse extracts used/ruled-out excerpts from a bulleted block", () => {
  const text = [
    "## PIVOT_CHECK",
    "...",
    "neighborhood_use:",
    "- used: lib/c.py::helper, lib/e.py::g",
    "- ruled_out: lib/d.py::unrelated",
  ].join("\n");
  const use = parseNeighborhoodUse(text);
  assert.equal(use.present, true);
  assert.deepEqual([...use.used], ["lib/c.py::helper", "lib/e.py::g"]);
  assert.deepEqual([...use.ruledOut], ["lib/d.py::unrelated"]);
});

test("parseNeighborhoodUse reports absent when no neighborhood_use block is present", () => {
  const use = parseNeighborhoodUse("just some prose with no accounting");
  assert.equal(use.present, false);
  assert.deepEqual([...use.used], []);
  assert.deepEqual([...use.ruledOut], []);
});

test("parseNeighborhoodUse drops none/n-a placeholders", () => {
  const use = parseNeighborhoodUse("neighborhood_use:\n- used: none\n- ruled_out: lib/d.py");
  assert.equal(use.present, true);
  assert.deepEqual([...use.used], []);
  assert.deepEqual([...use.ruledOut], ["lib/d.py"]);
});
