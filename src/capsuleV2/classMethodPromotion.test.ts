// Capsule v2 — Class.method edit-site promotion (REAL-PARSER tests).
//
// When an issue names `Class.method` and the method need not exist yet
// (`ModelAdmin.get_inlines`), debug-intent recovery expands to the EXISTING nearby
// methods under the class. Those methods are the actionable edit sites and must
// claim the pivot slots ahead of the broad containing class — the class is
// context, not the primary edit target.
//
// These tests index real Python with the actual parser pipeline (no hand-seeded
// symbols/edges) and assert the role assignment. A generic `Widget.draw_widget`
// fixture (no Django, no hardcoded names/paths in production logic) proves the
// rule is a general product rule.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import {
  CapsuleIntent,
  CapsuleV2Mode,
  type CapsuleV2Item,
  type CapsuleV2Result,
} from "./types";

interface RealRepo {
  db: Database;
  repoRoot: string;
}

async function indexRepo(prefix: string, files: Record<string, string>): Promise<RealRepo> {
  const repoRoot = mkdtempSync(path.join(tmpdir(), prefix));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(repoRoot, relPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, content);
  }
  const db = openIndexerDatabase();
  await indexProject({ repoRoot, db });
  return { db, repoRoot };
}

const pivot = (r: CapsuleV2Result, symbol: string): CapsuleV2Item | undefined =>
  r.pivots.find((p) => p.symbol === symbol);
const support = (r: CapsuleV2Result, symbol: string): CapsuleV2Item | undefined =>
  r.support.find((s) => s.symbol === symbol);

// --- 11095-style admin inline repo -------------------------------------------

const ADMIN_OPTIONS = "django/contrib/admin/options.py";

const ADMIN_FILES: Record<string, string> = (() => {
  const files: Record<string, string> = {
    [ADMIN_OPTIONS]:
      "class ModelAdmin:\n" +
      '    """Encapsulate all admin options and functionality for a given model."""\n\n' +
      "    inlines = []\n\n" +
      "    def get_inline_instances(self, request, obj=None):\n" +
      "        inline_instances = []\n" +
      "        for inline_class in self.inlines:\n" +
      "            inline_instances.append(inline_class(self.model))\n" +
      "        return inline_instances\n\n" +
      "    def get_formsets_with_inlines(self, request, obj=None):\n" +
      "        for inline in self.get_inline_instances(request, obj):\n" +
      "            yield inline.get_formset(request, obj), inline\n\n" +
      "    def get_fieldsets(self, request, obj=None):\n" +
      "        return []\n",
  };
  // Test fixtures that lexically dominate the issue prose, so the first pass is a
  // test-only pool and the backfill + expansion must recover the production edit.
  for (let index = 0; index < 6; index += 1) {
    files[`tests/generic_inline_admin/tests${index}.py`] =
      `class GenericInlineModelAdminTest${index}:\n` +
      `    def test_get_inline_instances_${index}(self):\n` +
      "        return None\n\n" +
      `    def test_get_formsets_with_inlines_${index}(self):\n` +
      "        return None\n";
  }
  return files;
})();

const ADMIN_TASK = "fix ModelAdmin.get_inlines hook for generic inline admin failing test";

async function adminCapsule(maxTokens: number): Promise<CapsuleV2Result> {
  const { db, repoRoot } = await indexRepo("vtrace-promote-admin-", ADMIN_FILES);
  try {
    return buildCapsuleV2({ db, repoRoot, task: ADMIN_TASK, intent: CapsuleIntent.Debug, maxTokens });
  } finally {
    db.close();
  }
}

test("promotion 11095: get_inline_instances is a pivot, flagged as an expansion target", async () => {
  const r = await adminCapsule(8_000);
  assert.notEqual(r.actual_mode, CapsuleV2Mode.NoContext);
  const item = pivot(r, "get_inline_instances");
  assert.ok(item, "get_inline_instances must be a pivot");
  assert.equal(item!.path, ADMIN_OPTIONS);
  assert.equal(item!.is_class_method_expansion_target, true);
  assert.equal(item!.is_containing_class_context, false);
  assert.match(item!.role_reason, /Class\.method expansion|more actionable than containing class/i);
});

test("promotion 11095: get_formsets_with_inlines is a pivot at a standard budget", async () => {
  const r = await adminCapsule(8_000);
  assert.ok(pivot(r, "get_formsets_with_inlines"), "get_formsets_with_inlines must be a pivot at standard budget");
});

test("promotion 11095: ModelAdmin is support context, never the first pivot", async () => {
  const r = await adminCapsule(8_000);
  assert.ok(!pivot(r, "ModelAdmin"), "the broad class must not be a pivot when methods exist");

  const cls = support(r, "ModelAdmin");
  assert.ok(cls, "ModelAdmin should be retained as support context");
  assert.equal(cls!.is_containing_class_context, true);
  assert.match(cls!.role_reason, /containing class/i);

  // The first pivot is a method under the class, not the class object.
  assert.equal(r.pivots[0]!.path, ADMIN_OPTIONS);
  assert.notEqual(r.pivots[0]!.symbol, "ModelAdmin");
  assert.equal(r.pivots[0]!.is_class_method_expansion_target, true);
});

test("promotion 11095: test symbols are discarded, never selected", async () => {
  const r = await adminCapsule(8_000);
  const selected = [...r.pivots, ...r.support];
  assert.ok(selected.every((item) => !item.path.startsWith("tests/")), "no test symbol may be selected");
  assert.ok(r.discarded.some((d) => d.symbol.startsWith("test_")), "test methods must be discarded");
});

test("promotion 11095: under a micro budget the single pivot is still a method, not the class", async () => {
  const r = await adminCapsule(500);
  assert.equal(r.actual_mode, CapsuleV2Mode.Micro);
  assert.equal(r.pivots.length, 1);
  assert.equal(r.pivots[0]!.is_class_method_expansion_target, true);
  assert.notEqual(r.pivots[0]!.symbol, "ModelAdmin");
  // The runner-up method is recovered as support (pivot or top support by budget).
  const formsets =
    pivot(r, "get_formsets_with_inlines") ?? support(r, "get_formsets_with_inlines");
  assert.ok(formsets, "get_formsets_with_inlines must be recovered as pivot or support");
});

// --- generic ClassName.missing_method repo (no Django, no hardcoding) --------

const WIDGET_FILE = "src/ui/widget.py";

const WIDGET_FILES: Record<string, string> = {
  [WIDGET_FILE]:
    "class Widget:\n" +
    '    """A reusable user interface widget."""\n\n' +
    "    def render_widget(self, context):\n" +
    "        return context\n\n" +
    "    def build_widget(self, context):\n" +
    "        return self.render_widget(context)\n\n" +
    "    def unrelated_helper(self):\n" +
    "        return None\n",
  "tests/ui/test_widget.py":
    "class WidgetTests:\n" +
    "    def test_draw_widget(self):\n" +
    "        return None\n",
};

// `draw_widget` does NOT exist; `render_widget` / `build_widget` are the nearby
// existing methods that must be preferred over the `Widget` class.
const WIDGET_TASK = "fix Widget.draw_widget rendering glitch in the widget";

async function widgetCapsule(maxTokens = 8_000): Promise<CapsuleV2Result> {
  const { db, repoRoot } = await indexRepo("vtrace-promote-widget-", WIDGET_FILES);
  try {
    return buildCapsuleV2({ db, repoRoot, task: WIDGET_TASK, intent: CapsuleIntent.Debug, maxTokens });
  } finally {
    db.close();
  }
}

test("promotion generic: existing methods under ClassName outrank the containing class", async () => {
  const r = await widgetCapsule();
  assert.notEqual(r.actual_mode, CapsuleV2Mode.NoContext);

  // The missing method's nearby existing methods are the pivots.
  const methodPivots = r.pivots.filter((p) => p.is_class_method_expansion_target).map((p) => p.symbol).sort();
  assert.deepEqual(methodPivots, ["build_widget", "render_widget"]);

  // The class itself is not a pivot; it is containing-class support context.
  assert.ok(!pivot(r, "Widget"), "the Widget class must not be a pivot");
  const cls = support(r, "Widget");
  assert.ok(cls, "the Widget class should be support context");
  assert.equal(cls!.is_containing_class_context, true);
});

test("promotion role assignment is deterministic", async () => {
  assert.deepEqual(await adminCapsule(8_000), await adminCapsule(8_000));
  assert.deepEqual(await widgetCapsule(), await widgetCapsule());
});
