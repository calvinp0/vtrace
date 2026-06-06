// Capsule v2 production-target recovery — REAL-PARSER tests.
//
// Unlike debugRoles.test.ts (which hand-seeds symbols + `calls` edges), these
// tests write real Python source to disk and index it with the actual tree-sitter
// pipeline (`indexProject`). That makes them faithful to production in the two
// ways that matter for this fix:
//
//   * the Python indexer here resolves NO cross-file `calls` edges, so the
//     dispatcher/helper split must be recovered from the pivot SOURCE BODY
//     (the source-body call fallback), exactly as it must on a real checkout;
//   * the candidate pool is whatever real lexical retrieval surfaces, so the
//     subsystem-boundary classification and the test-pool production backfill are
//     exercised against a real ranking, not a curated one.
//
// They lock in the two direct-product regressions: 11728 (admindocs regex helpers
// outranked by a wrapper + generic regex infra) and 11095 (a test-only pool that
// degraded to no_context instead of recovering the ModelAdmin edit site).

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
  type CapsuleV2Result,
} from "./types";

interface RealRepo {
  db: Database;
  repoRoot: string;
}

// Write `files` to a fresh temp repo and index it with the real parser pipeline.
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

const has = (items: ReadonlyArray<{ path: string; symbol: string }>, suffix: string, symbol: string): boolean =>
  items.some((item) => item.path.endsWith(suffix) && item.symbol === symbol);

// --- 11728: admindocs regex helpers -----------------------------------------

const ADMINDOCS_FILES: Record<string, string> = {
  "django/contrib/admindocs/utils.py":
    "import re\n\n" +
    "named_group_matcher = re.compile(r'\\(\\?P(<\\w+>)')\n\n\n" +
    "def replace_named_groups(pattern):\n" +
    '    """Replace named groups, including trailing named groups, with their pattern."""\n' +
    "    for match in named_group_matcher.finditer(pattern):\n" +
    "        pattern = pattern[:match.start()] + match.group(1) + pattern[match.end():]\n" +
    "    return pattern\n\n\n" +
    "def replace_unnamed_groups(pattern):\n" +
    '    """Replace unnamed groups, including trailing unnamed groups, with their pattern."""\n' +
    "    return pattern\n",
  "django/contrib/admindocs/views.py":
    "from django.contrib.admindocs.utils import replace_named_groups, replace_unnamed_groups\n\n\n" +
    "def simplify_regex(pattern):\n" +
    '    """Clean up urlpattern regexes into readable form, simplifying named groups."""\n' +
    "    pattern = replace_named_groups(pattern)\n" +
    "    pattern = replace_unnamed_groups(pattern)\n" +
    "    return pattern\n",
  "django/utils/regex_helper.py":
    "class Group(list):\n" +
    '    """Represent a capturing group in the regex pattern string."""\n\n\n' +
    "class NonCapture(list):\n" +
    '    """Represent a non-capturing group in the regex pattern string."""\n\n\n' +
    "def normalize(pattern):\n" +
    '    """Normalize a regular expression pattern into a list of forms."""\n' +
    "    return pattern\n\n\n" +
    "def walk_to_end(ch, input_iter):\n" +
    '    """Walk to the end of the current regex group."""\n' +
    "    return ch\n",
  "tests/admin_docs/test_views.py":
    "class AdminDocViewTests:\n" +
    "    def test_simplify_regex(self):\n" +
    "        return None\n",
};

const ADMINDOCS_TASK = "fix simplify_regexp trailing named groups in admindocs regex helpers";
const ADMINDOCS_UTILS = "django/contrib/admindocs/utils.py";
const ADMINDOCS_VIEWS = "django/contrib/admindocs/views.py";
const REGEX_HELPER = "django/utils/regex_helper.py";

async function admindocsCapsule(maxTokens = 8_000): Promise<CapsuleV2Result> {
  const { db, repoRoot } = await indexRepo("vtrace-real-admindocs-", ADMINDOCS_FILES);
  try {
    return buildCapsuleV2({ db, repoRoot, task: ADMINDOCS_TASK, intent: CapsuleIntent.Debug, maxTokens });
  } finally {
    db.close();
  }
}

test("real-parser 11728: replace_named_groups is a pivot", async () => {
  const r = await admindocsCapsule();
  assert.notEqual(r.actual_mode, CapsuleV2Mode.NoContext);
  assert.ok(has(r.pivots, ADMINDOCS_UTILS, "replace_named_groups"), "replace_named_groups must be a pivot");
  // The static parser resolved no calls edges, so the dispatcher split came from
  // scanning the wrapper's source body.
  assert.equal(r.diagnostics.source_body_call_fallback_used, true);
  assert.equal(r.diagnostics.subsystem_root, "django/contrib/admindocs");
});

test("real-parser 11728: replace_unnamed_groups is a pivot or top support", async () => {
  const r = await admindocsCapsule();
  const recovered =
    has(r.pivots, ADMINDOCS_UTILS, "replace_unnamed_groups")
    || has(r.support, ADMINDOCS_UTILS, "replace_unnamed_groups");
  assert.ok(recovered, "replace_unnamed_groups must be recovered as pivot or support");
});

test("real-parser 11728: simplify_regex is an entry-point support, not a pivot", async () => {
  const r = await admindocsCapsule();
  assert.ok(!has(r.pivots, ADMINDOCS_VIEWS, "simplify_regex"), "the wrapper must not be a pivot");
  assert.ok(has(r.support, ADMINDOCS_VIEWS, "simplify_regex"), "the wrapper should be support");
  const item = r.support.find((s) => s.symbol === "simplify_regex")!;
  assert.equal(item.is_entry_point, true);
});

test("real-parser 11728: generic regex infra (Group) is support-only or discarded", async () => {
  const r = await admindocsCapsule();
  assert.ok(!has(r.pivots, REGEX_HELPER, "Group"), "regex_helper.Group must not be a pivot");
  const group = [...r.support, ...r.discarded].find((s) => s.path === REGEX_HELPER && s.symbol === "Group");
  assert.ok(group, "Group should be retained as support/discarded, not silently dropped");
  assert.equal(group!.is_generic_infrastructure, true);
});

// --- 11095: admin inline production backfill ---------------------------------

const ADMIN_INLINE_FILES: Record<string, string> = (() => {
  const files: Record<string, string> = {
    "django/contrib/admin/options.py":
      "class ModelAdmin:\n" +
      '    """Encapsulate all admin options and functionality for a given model."""\n\n' +
      "    inlines = []\n\n" +
      "    def get_inline_instances(self, request, obj=None):\n" +
      "        inline_instances = []\n" +
      "        for inline_class in self.inlines:\n" +
      "            inline = inline_class(self.model, self.admin_site)\n" +
      "            inline_instances.append(inline)\n" +
      "        return inline_instances\n\n" +
      "    def get_formsets_with_inlines(self, request, obj=None):\n" +
      "        for inline in self.get_inline_instances(request, obj):\n" +
      "            yield inline.get_formset(request, obj), inline\n\n" +
      "    def get_inline_formsets(self, request, formsets, inline_instances, obj=None):\n" +
      "        return []\n\n" +
      "    def get_fieldsets(self, request, obj=None):\n" +
      "        return []\n",
  };
  // A pile of test fixtures that lexically dominate the issue prose, so the first
  // retrieval pass returns an (almost) test-only pool — the backfill trigger.
  for (let index = 0; index < 6; index += 1) {
    files[`tests/generic_inline_admin/tests${index}.py`] =
      `class GenericInlineModelAdminTest${index}:\n` +
      `    def test_get_inline_instances_${index}(self):\n` +
      "        return None\n\n" +
      `    def test_get_formsets_with_inlines_${index}(self):\n` +
      "        return None\n";
    files[`tests/generic_inline_admin/admin${index}.py`] =
      `class GenericInlineModelAdmin${index}:\n` +
      "    model = None\n" +
      "    inlines = []\n";
  }
  return files;
})();

const ADMIN_INLINE_TASK = "fix ModelAdmin.get_inlines hook for generic inline admin failing test";
const ADMIN_OPTIONS = "django/contrib/admin/options.py";

async function adminInlineCapsule(maxTokens = 8_000): Promise<CapsuleV2Result> {
  const { db, repoRoot } = await indexRepo("vtrace-real-admininline-", ADMIN_INLINE_FILES);
  try {
    return buildCapsuleV2({ db, repoRoot, task: ADMIN_INLINE_TASK, intent: CapsuleIntent.Debug, maxTokens });
  } finally {
    db.close();
  }
}

test("real-parser 11095: a test-only pool triggers the production backfill", async () => {
  const r = await adminInlineCapsule();
  assert.equal(r.diagnostics.production_backfill_used, true, "the test-only pool must trigger a backfill");
  assert.equal(r.diagnostics.class_method_expansion_used, true, "ModelAdmin.get_inlines must expand to nearby methods");
});

test("real-parser 11095: the ModelAdmin edit site is recovered (no no_context)", async () => {
  const r = await adminInlineCapsule();
  assert.notEqual(r.actual_mode, CapsuleV2Mode.NoContext, "the production target must be recovered");
  assert.equal(r.diagnostics.subsystem_root, "django/contrib/admin");

  // get_inline_instances must be a pivot or top support.
  const recovered =
    has(r.pivots, ADMIN_OPTIONS, "get_inline_instances")
    || has(r.support, ADMIN_OPTIONS, "get_inline_instances");
  assert.ok(recovered, "get_inline_instances must be recovered as pivot or support");

  // The implementation file must appear in the capsule.
  const appears = [...r.pivots, ...r.support].some((item) => item.path === ADMIN_OPTIONS);
  assert.ok(appears, "django/contrib/admin/options.py must appear in the capsule");
});

test("real-parser 11095: test symbols are discarded, never selected", async () => {
  const r = await adminInlineCapsule();
  const selected = [...r.pivots, ...r.support];
  assert.ok(
    selected.every((item) => !item.path.includes("/tests/") && !item.path.startsWith("tests/")),
    "no test symbol may be selected as pivot/support",
  );
  assert.ok(
    r.discarded.some((d) => d.symbol.startsWith("test_")),
    "the test methods must be reported as discarded",
  );
});

test("real-parser production recovery is deterministic", async () => {
  assert.deepEqual(await admindocsCapsule(), await admindocsCapsule());
  assert.deepEqual(await adminInlineCapsule(), await adminInlineCapsule());
});
