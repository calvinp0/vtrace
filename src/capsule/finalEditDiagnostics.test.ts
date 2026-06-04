import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  contextMentionsFile,
  contextMentionsSymbol,
  editedFilesFromPatch,
  editedSymbolsFromPatch,
  primaryEditedFile,
  primaryEditedSymbol,
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
