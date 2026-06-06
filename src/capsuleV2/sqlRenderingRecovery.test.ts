// Capsule v2 SQL-rendering recovery — REAL-PARSER tests.
//
// These write real Python to disk and index it with the actual tree-sitter
// pipeline (`indexProject`), so the capsule is recovered from a real lexical
// ranking — not a curated pool. They lock in the direct-product regression 11490:
// a composed-query SQL-output bug whose lexical pool is dominated by the public
// query-builder API (`QuerySet.values`/`values_list`), so the gold edit site —
// `SQLCompiler.get_combinator_sql` (the SQL renderer) — never enters the pool and
// the capsule pivots on the entry-point API instead of the renderer.
//
// No instance id and no exact Django fixture path is hardcoded in production
// logic; the recovery is driven entirely by general path/symbol signals (a
// `*/compiler.py` path, a `get_*_sql` method, a `*combinator*` method).

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

const rankOf = (items: ReadonlyArray<{ path: string; symbol: string }>, suffix: string, symbol: string): number =>
  items.findIndex((item) => item.path.endsWith(suffix) && item.symbol === symbol);

// --- 11490: composed-query SQL renderer --------------------------------------
//
// A Django-like structure: the public query-builder API lives in query.py and
// sql/query.py; the SQL renderer lives in sql/compiler.py. The issue prose
// matches `values`/`values_list` far more strongly than the renderer.

const SQL_RENDERING_FILES: Record<string, string> = {
  "django/db/models/query.py":
    "class QuerySet:\n" +
    '    """Represent a lazy database lookup for a set of objects."""\n\n' +
    "    def values(self, *fields, **expressions):\n" +
    "        clone = self._values(*fields, **expressions)\n" +
    "        clone._iterable_class = ValuesIterable\n" +
    "        return clone\n\n" +
    "    def values_list(self, *fields, flat=False, named=False):\n" +
    "        clone = self._values(*fields)\n" +
    "        clone._iterable_class = ValuesListIterable\n" +
    "        return clone\n\n" +
    "    def _combinator_query(self, combinator, *other_qs, all=False):\n" +
    "        clone = self._chain()\n" +
    "        clone.query.combinator = combinator\n" +
    "        return clone\n\n\n" +
    "class ValuesIterable:\n" +
    '    """Iterable returned by QuerySet.values()."""\n\n\n' +
    "class ValuesListIterable:\n" +
    '    """Iterable returned by QuerySet.values_list()."""\n',
  "django/db/models/sql/query.py":
    "class Query:\n" +
    '    """A single SQL query."""\n\n' +
    "    def combine(self, rhs, connector):\n" +
    "        self.combinator = connector\n" +
    "        return self\n\n" +
    "    def set_values(self, fields):\n" +
    "        self.values_select = fields\n" +
    "        self.select = fields\n" +
    "        return fields\n\n" +
    "    def clear_select_fields(self):\n" +
    "        self.select = []\n" +
    "        return None\n",
  "django/db/models/sql/compiler.py":
    "class SQLCompiler:\n" +
    '    """Compile a Query into SQL."""\n\n' +
    "    def get_combinator_sql(self, combinator, all):\n" +
    "        features = self.connection.features\n" +
    "        compilers = [query.get_compiler(self.using) for query in self.query.combined_queries]\n" +
    "        parts = []\n" +
    "        for compiler in compilers:\n" +
    "            parts.append(compiler.as_sql())\n" +
    "        return parts\n\n" +
    "    def as_sql(self, with_limits=True, with_col_aliases=False):\n" +
    "        self.pre_sql_setup()\n" +
    "        combinator = self.query.combinator\n" +
    "        if combinator:\n" +
    "            result = self.get_combinator_sql(combinator, self.query.combinator_all)\n" +
    "        return result\n\n" +
    "    def execute_sql(self, result_type):\n" +
    "        sql, params = self.as_sql()\n" +
    "        return sql\n",
  "tests/queries/test_qs_combinators.py":
    "class QuerySetSetOperationTests:\n" +
    "    def test_union_with_values_list(self):\n" +
    "        return None\n\n" +
    "    def test_union_with_two_annotated_values_list(self):\n" +
    "        return None\n",
};

const SQL_RENDERING_TASK =
  "fix composed queries where a second values() or values_list() call cannot change "
  + "the selected column list in the combined query sql";

const COMPILER = "django/db/models/sql/compiler.py";
const QUERY = "django/db/models/query.py";

async function sqlRenderingCapsule(maxTokens = 8_000): Promise<CapsuleV2Result> {
  const { db, repoRoot } = await indexRepo("vtrace-real-sqlrender-", SQL_RENDERING_FILES);
  try {
    return buildCapsuleV2({ db, repoRoot, task: SQL_RENDERING_TASK, intent: CapsuleIntent.Debug, maxTokens });
  } finally {
    db.close();
  }
}

test("real-parser 11490: get_combinator_sql is surfaced (no no_context)", async () => {
  const r = await sqlRenderingCapsule();
  assert.notEqual(r.actual_mode, CapsuleV2Mode.NoContext, "the SQL renderer must be recovered");
  assert.equal(r.diagnostics.sql_rendering_backfill_used, true, "the composed-query SQL bug must trigger the backfill");
  const surfaced =
    has(r.pivots, COMPILER, "get_combinator_sql") || has(r.support, COMPILER, "get_combinator_sql");
  assert.ok(surfaced, "compiler.py::get_combinator_sql must be surfaced as pivot or support");
});

test("real-parser 11490: get_combinator_sql is a pivot (the SQL rendering edit site)", async () => {
  const r = await sqlRenderingCapsule();
  assert.ok(has(r.pivots, COMPILER, "get_combinator_sql"), "get_combinator_sql must be a pivot");
  const item = r.pivots.find((p) => p.symbol === "get_combinator_sql" && p.path.endsWith(COMPILER))!;
  assert.equal(item.is_sql_rendering_implementation, true);
  assert.equal(item.role_reason, "SQL rendering implementation for combined-query output bug");
});

test("real-parser 11490: the query-builder API is support, not a pivot", async () => {
  const r = await sqlRenderingCapsule();
  // values_list is the entry point, never the pivot for a SQL-output bug.
  assert.ok(!has(r.pivots, QUERY, "values_list"), "values_list must not be a pivot");
  assert.ok(!has(r.pivots, QUERY, "values"), "values must not be a pivot");

  // It is support (or at least never out-ranks the compiler renderer): the
  // expected file must out-rank the query-builder file in the file ranking.
  const ranked = [...r.pivots, ...r.support];
  const compilerRank = rankOf(ranked, COMPILER, "get_combinator_sql");
  const valuesListRank = rankOf(ranked, QUERY, "values_list");
  assert.ok(compilerRank >= 0, "the compiler renderer must be in the capsule");
  if (valuesListRank >= 0) {
    assert.ok(
      compilerRank < valuesListRank,
      "the compiler renderer must out-rank the query-builder API",
    );
    const valuesListItem = ranked.find((p) => p.symbol === "values_list" && p.path.endsWith(QUERY))!;
    assert.equal(valuesListItem.role, "support");
    assert.equal(valuesListItem.is_query_builder_entrypoint, true);
  }
});

test("real-parser 11490: the renderer file out-ranks the query-builder file (top-1)", async () => {
  const r = await sqlRenderingCapsule();
  // The top pivot's file must be the compiler, not query.py.
  assert.ok(r.pivots[0]!.path.endsWith(COMPILER), "the lead pivot must be in the SQL compiler");
  assert.equal(r.pivots[0]!.symbol, "get_combinator_sql", "the lead pivot must be the on-topic renderer");
});

test("real-parser 11490: recovery is deterministic", async () => {
  assert.deepEqual(await sqlRenderingCapsule(), await sqlRenderingCapsule());
});

// A non-composition SQL task must NOT trigger the rendering backfill (the trigger
// requires BOTH a composition term and a rendering term), so the rule stays
// scoped and does not perturb ordinary debug tasks.
test("real-parser: a non-composition task does not trigger the SQL-rendering backfill", async () => {
  const { db, repoRoot } = await indexRepo("vtrace-real-noncomp-", SQL_RENDERING_FILES);
  try {
    const r = buildCapsuleV2({
      db,
      repoRoot,
      task: "fix values_list returning the wrong field order",
      intent: CapsuleIntent.Debug,
      maxTokens: 8_000,
    });
    assert.equal(r.diagnostics.sql_rendering_backfill_used, false);
  } finally {
    db.close();
  }
});
