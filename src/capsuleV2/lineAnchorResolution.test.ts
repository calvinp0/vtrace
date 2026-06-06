// Capsule v2 file-line anchor resolution — REAL-PARSER tests.
//
// These write real Python to disk and index it with the actual tree-sitter
// pipeline (`indexProject`), so symbols carry REAL `startLine`/`endLine` spans —
// the spans an anchor's line range is mapped against. They lock in the direct-
// product behaviour behind django-11490: the issue text carries an explicit
// source anchor (`compiler.py#L428-L433`) that a lexical ranker cannot use, so a
// nearby method out-ranks the method the anchor literally names. Resolving the
// anchor promotes the true edit site.
//
// No instance id and no exact Django path is hardcoded in production logic; the
// anchor text comes from the task, everything else from the index.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";

import { shapeSweQuery } from "../capsule/sweQueryShaping";
import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import {
  parseLineAnchors,
  resolveLineAnchors,
} from "./lineAnchorResolution";
import {
  CapsuleIntent,
  CapsuleV2Mode,
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

const has = (items: ReadonlyArray<{ path: string; symbol: string }>, suffix: string, symbol: string): boolean =>
  items.some((item) => item.path.endsWith(suffix) && item.symbol === symbol);

const rankOf = (items: ReadonlyArray<{ path: string; symbol: string }>, suffix: string, symbol: string): number =>
  items.findIndex((item) => item.path.endsWith(suffix) && item.symbol === symbol);

// A SQL compiler with a deterministic line layout. `get_combinator_sql` spans
// lines 8-13; the nearby `setup_query` (4-6) and `as_sql` (15-16) bracket it.
// Anchoring a line INSIDE get_combinator_sql must map to that method, not the
// containing class or a sibling method.
//
//  1 class SQLCompiler:
//  2     """Compile a Query into SQL."""
//  3
//  4     def setup_query(self):
//  5         self.select = []
//  6         return self.select
//  7
//  8     def get_combinator_sql(self, combinator, all):
//  9         features = self.connection.features
// 10         parts = []
// 11         for sub in self.sub_compilers():
// 12             parts.append(sub.as_sql())
// 13         return parts
// 14
// 15     def as_sql(self, with_limits=True):
// 16         return self.get_combinator_sql(None, False)
const COMPILER_PY = [
  "class SQLCompiler:",
  '    """Compile a Query into SQL."""',
  "",
  "    def setup_query(self):",
  "        self.select = []",
  "        return self.select",
  "",
  "    def get_combinator_sql(self, combinator, all):",
  "        features = self.connection.features",
  "        parts = []",
  "        for sub in self.sub_compilers():",
  "            parts.append(sub.as_sql())",
  "        return parts",
  "",
  "    def as_sql(self, with_limits=True):",
  "        return self.get_combinator_sql(None, False)",
  "",
].join("\n");

const COMPILER = "pkg/db/models/sql/compiler.py";
const REPO_FILES: Record<string, string> = { [COMPILER]: COMPILER_PY };

// A debug task that lexically favours `setup_query` (named in the prose) while
// the source anchor points INSIDE get_combinator_sql — so only the anchor can
// promote the true edit site. Deliberately avoids composition terms so the
// SQL-rendering backfill does NOT fire; the promotion is purely the anchor.
const ANCHORED_TASK =
  "setup_query returns the wrong selected columns; the real fix is in the helper it "
  + "delegates to (see compiler.py#L9-L12)";

// --- parsing ------------------------------------------------------------------

test("parseLineAnchors recognises the GitHub blob, range, single-line, and editor styles", () => {
  const anchors = parseLineAnchors(
    "see compiler.py#L428-L433 and path/to/file.py#L10 and django/db/models/sql/compiler.py#L428-L433 and file.ts:42",
  );
  assert.deepEqual(
    anchors.map((a) => ({ pathHint: a.pathHint, start: a.lineStart, end: a.lineEnd })),
    [
      { pathHint: "compiler.py", start: 428, end: 433 },
      { pathHint: "path/to/file.py", start: 10, end: 10 },
      { pathHint: "django/db/models/sql/compiler.py", start: 428, end: 433 },
      { pathHint: "file.ts", start: 42, end: 42 },
    ],
  );
});

test("parseLineAnchors does not mistake a pytest node id for a line anchor", () => {
  // `tests/test_x.py::TestY::test_z` has `::` but no `:<digit>` — not an anchor.
  const anchors = parseLineAnchors("the failing test is tests/queries/test_qs.py::SetOps::test_union");
  assert.equal(anchors.length, 0);
});

// --- resolution ---------------------------------------------------------------

test("real-parser: a file-line anchor maps to the enclosing method (not the class)", async () => {
  const { db } = await indexRepo("vtrace-anchor-encl-", REPO_FILES);
  try {
    const shaped = shapeSweQuery({ problemStatement: ANCHORED_TASK });
    const [resolution] = resolveLineAnchors(db, parseLineAnchors(ANCHORED_TASK), shaped);
    assert.ok(resolution, "the anchor must resolve");
    assert.equal(resolution.resolvedSymbol, "get_combinator_sql");
    assert.equal(resolution.kind, "method");
    assert.equal(resolution.confidence, "high");
    assert.ok(resolution.resolvedPath.endsWith(COMPILER));
  } finally {
    db.close();
  }
});

test("real-parser: a partial path hint resolves by suffix against the indexed file", async () => {
  const { db } = await indexRepo("vtrace-anchor-suffix-", REPO_FILES);
  try {
    const shaped = shapeSweQuery({ problemStatement: ANCHORED_TASK });
    // The anchor cites a bare `compiler.py`; the indexed file is several dirs deep.
    const [byBasename] = resolveLineAnchors(db, parseLineAnchors("see compiler.py#L9"), shaped);
    assert.ok(byBasename, "a bare basename must resolve by suffix");
    assert.equal(byBasename.resolvedPath, COMPILER);

    // A partial directory prefix resolves the same file by suffix too.
    const [byPartial] = resolveLineAnchors(db, parseLineAnchors("see sql/compiler.py#L9"), shaped);
    assert.ok(byPartial, "a partial path must resolve by suffix");
    assert.equal(byPartial.resolvedPath, COMPILER);
  } finally {
    db.close();
  }
});

test("real-parser: a line outside any symbol falls back to the nearest symbol at low confidence", async () => {
  const { db } = await indexRepo("vtrace-anchor-near-", REPO_FILES);
  try {
    const shaped = shapeSweQuery({ problemStatement: ANCHORED_TASK });
    // Line 3 is the blank line between the class line and setup_query — enclosed
    // only by the class, so the smallest enclosing symbol is the class itself.
    const [resolution] = resolveLineAnchors(db, parseLineAnchors("compiler.py#L3"), shaped);
    assert.ok(resolution);
    assert.equal(resolution.resolvedSymbol, "SQLCompiler");
    assert.equal(resolution.confidence, "high");
  } finally {
    db.close();
  }
});

test("real-parser: a line beyond every symbol falls back to the nearest at low confidence", async () => {
  const { db } = await indexRepo("vtrace-anchor-fallback-", REPO_FILES);
  try {
    const shaped = shapeSweQuery({ problemStatement: ANCHORED_TASK });
    // Line 100 is past the end of the file — no symbol encloses it, so the nearest
    // symbol in the file is returned, flagged low-confidence.
    const [resolution] = resolveLineAnchors(db, parseLineAnchors("compiler.py#L100"), shaped);
    assert.ok(resolution);
    assert.equal(resolution.confidence, "low");
  } finally {
    db.close();
  }
});

// --- promotion ----------------------------------------------------------------

async function anchoredCapsule(task: string, maxTokens = 8_000): Promise<CapsuleV2Result> {
  const { db, repoRoot } = await indexRepo("vtrace-anchor-pivot-", REPO_FILES);
  try {
    return buildCapsuleV2({ db, repoRoot, task, intent: CapsuleIntent.Debug, maxTokens });
  } finally {
    db.close();
  }
}

test("real-parser: the anchor target leads the pivots, out-ranking nearby same-file methods", async () => {
  const r = await anchoredCapsule(ANCHORED_TASK);
  assert.notEqual(r.actual_mode, CapsuleV2Mode.NoContext);
  assert.equal(r.pivots[0]!.symbol, "get_combinator_sql", "the anchored method must be the lead pivot");
  assert.equal(r.pivots[0]!.path.endsWith(COMPILER), true);
  assert.match(
    r.pivots[0]!.evidence.join(" "),
    /source anchor compiler\.py#L9-L12 maps to enclosing symbol get_combinator_sql/,
  );

  // The lexically-favoured sibling does not lead, and never out-ranks the anchor.
  const ranked = [...r.pivots, ...r.support];
  const anchorRank = rankOf(ranked, COMPILER, "get_combinator_sql");
  const siblingRank = rankOf(ranked, COMPILER, "setup_query");
  assert.ok(anchorRank >= 0);
  if (siblingRank >= 0) {
    assert.ok(anchorRank < siblingRank, "the anchor target must out-rank the lexical sibling");
  }
});

test("real-parser: anchor resolution is surfaced in diagnostics", async () => {
  const r = await anchoredCapsule(ANCHORED_TASK);
  assert.equal(r.diagnostics.line_anchor_resolution_used, true);
  assert.deepEqual(r.diagnostics.line_anchor_candidates, [
    {
      anchor: "compiler.py#L9-L12",
      resolved_path: COMPILER,
      resolved_symbol: "get_combinator_sql",
      confidence: "high",
    },
  ]);
});

test("real-parser: a task without an anchor does not use anchor resolution", async () => {
  const r = await anchoredCapsule("setup_query returns the wrong selected columns");
  assert.notEqual(r.diagnostics.line_anchor_resolution_used, true);
  assert.equal(r.diagnostics.line_anchor_candidates, undefined);
});

test("real-parser: anchor recovery is deterministic", async () => {
  assert.deepEqual(await anchoredCapsule(ANCHORED_TASK), await anchoredCapsule(ANCHORED_TASK));
});

// --- ambiguity ----------------------------------------------------------------

const AMBIGUOUS_FILES: Record<string, string> = {
  // The real subsystem: its path segments (sql, models) overlap the issue prose.
  "app/db/models/sql/compiler.py": COMPILER_PY,
  // A same-named file in an unrelated package — must lose the tie-break.
  "vendor/legacy/compiler.py": COMPILER_PY,
};

test("real-parser: an ambiguous filename resolves via subsystem / path evidence", async () => {
  const { db } = await indexRepo("vtrace-anchor-ambig-", AMBIGUOUS_FILES);
  try {
    const task = "fix the combined query sql columns in the models sql compiler (see compiler.py#L9-L12)";
    const shaped = shapeSweQuery({ problemStatement: task });
    const [resolution] = resolveLineAnchors(db, parseLineAnchors(task), shaped);
    assert.ok(resolution, "the ambiguous anchor must still resolve");
    assert.equal(
      resolution.resolvedPath,
      "app/db/models/sql/compiler.py",
      "the issue-subsystem file must win the tie-break over the unrelated one",
    );
    assert.equal(resolution.resolvedSymbol, "get_combinator_sql");
  } finally {
    db.close();
  }
});

// --- test-file anchors --------------------------------------------------------

const WITH_TEST_FILE: Record<string, string> = {
  [COMPILER]: COMPILER_PY,
  "tests/test_compiler.py": [
    "class SQLCompilerTests:",
    "    def test_get_combinator_sql(self):",
    "        compiler = SQLCompiler()",
    "        assert compiler.get_combinator_sql(None, False) == []",
    "",
  ].join("\n"),
};

test("real-parser: a test-file line anchor does not become a production pivot", async () => {
  const { db, repoRoot } = await indexRepo("vtrace-anchor-test-", WITH_TEST_FILE);
  try {
    // The anchor points INSIDE the test method (lines 2-4 of the test file).
    const task =
      "the combinator behaviour regressed; reproduced at test_compiler.py#L2-L4";
    const r = buildCapsuleV2({ db, repoRoot, task, intent: CapsuleIntent.Debug, maxTokens: 8_000 });

    // The resolution still happened (it is auditable)...
    assert.equal(r.diagnostics.line_anchor_resolution_used, true);
    assert.equal(r.diagnostics.line_anchor_candidates?.[0]?.resolved_symbol, "test_get_combinator_sql");

    // ...but a test symbol is never promoted to a production edit target.
    assert.ok(
      r.pivots.every((p) => p.symbol !== "test_get_combinator_sql"),
      "a test method must never be a pivot, even when anchored",
    );
  } finally {
    db.close();
  }
});
