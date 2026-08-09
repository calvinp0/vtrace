// M132 — nested-worktree exclusion at the INDEX level, including the cleanup path
// for an index that was already contaminated before the exclusion rule existed.
//
// The exclusion is enforced during enumeration, so a nested worktree's files are
// simply absent from the current file set. Incremental refresh already diffs the
// current set against the previous snapshot, which means previously-indexed
// nested-worktree files are seen as deletions and their symbols/edges/documents/
// FTS rows are removed by the ordinary delete path. These tests pin that the
// cleanup actually happens rather than assuming it.

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { listAllEdges } from "../db/repositories/edgesRepository";
import { listAllFilePaths } from "../db/repositories/filesRepository";
import { listAllSymbols } from "../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { resolveWorktreeExclusions } from "../fs/worktreeExclusions";
import { searchSymbols } from "../retrieval/searchSymbols";
import { indexProject } from "./indexProject";

/** Every indexed path a symbol search can reach for `query`. */
function searchPaths(db: ReturnType<typeof openIndexerDatabase>, query: string): string[] {
  return [...new Set(
    searchSymbols(db, { query, maxResults: 50 }).map((result) => result.filePath),
  )].sort();
}

const execFile = promisify(execFileCallback);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, encoding: "utf8" });
}

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "vtrace-m132-idx-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function createRepo(): Promise<string> {
  const root = path.join(scratch, "parent");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(
    path.join(root, "src", "geometry.py"),
    "def get_normal(a, b):\n    return a * b\n\n\ndef helper():\n    return get_normal(1, 2)\n",
  );
  await writeFile(path.join(root, "tests", "test_geometry.py"), "def test_normal():\n    assert True\n");
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.email", "m132@example.com");
  await git(root, "config", "user.name", "M132");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return root;
}

interface IndexShape {
  readonly files: string[];
  readonly symbols: number;
  readonly edges: number;
}

function readShape(db: ReturnType<typeof openIndexerDatabase>): IndexShape {
  return {
    files: [...listAllFilePaths(db)].sort(),
    symbols: listAllSymbols(db).length,
    edges: listAllEdges(db).length,
  };
}

test("a nested worktree never enters a fresh parent index", async () => {
  const root = await createRepo();
  const db = openIndexerDatabase();
  try {
    const before = await indexProject({ repoRoot: root, db });
    const beforeShape = readShape(db);
    assert.equal(before.worktreeExclusions?.nestedWorktreesExcluded, 0);

    await git(root, "worktree", "add", "-b", "feature", path.join(root, "nested-worktree"));

    const db2 = openIndexerDatabase();
    try {
      const after = await indexProject({ repoRoot: root, db: db2 });
      assert.equal(after.worktreeExclusions?.nestedWorktreesExcluded, 1);
      assert.deepEqual(after.worktreeExclusions?.excludedRelativePaths, ["nested-worktree"]);

      const afterShape = readShape(db2);
      assert.deepEqual(afterShape.files, beforeShape.files);
      assert.equal(afterShape.symbols, beforeShape.symbols);
      assert.equal(afterShape.edges, beforeShape.edges);
      assert.equal(afterShape.files.some((file) => file.startsWith("nested-worktree/")), false);
    } finally {
      db2.close();
    }
  } finally {
    db.close();
  }
});

test("an incremental refresh after a nested worktree appears keeps it out", async () => {
  const root = await createRepo();
  const db = openIndexerDatabase();
  try {
    const first = await indexProject({ repoRoot: root, db });
    await git(root, "worktree", "add", "-b", "feature", path.join(root, "nested-worktree"));

    const second = await indexProject({
      repoRoot: root,
      db,
      previousSnapshot: first.snapshot,
    });

    assert.equal(second.worktreeExclusions?.nestedWorktreesExcluded, 1);
    const files = [...listAllFilePaths(db)];
    assert.equal(files.some((file) => file.startsWith("nested-worktree/")), false);
    // Topology bookkeeping only — no parent file was added or removed.
    assert.deepEqual(files.sort(), ["src/geometry.py", "tests/test_geometry.py"]);
  } finally {
    db.close();
  }
});

test("a contaminated index is cleaned by the ordinary refresh path", async () => {
  const root = await createRepo();
  const nested = path.join(root, "nested-worktree");

  const db = openIndexerDatabase();
  try {
    // A pre-M132 index really did contain the duplicate copy. Reproduce that state
    // honestly: index while the directory is an ordinary child (no worktree
    // registration yet), so the duplicate sources are genuinely persisted.
    await mkdir(path.join(nested, "src"), { recursive: true });
    await writeFile(
      path.join(nested, "src", "geometry.py"),
      "def get_normal(a, b):\n    return a * b\n\n\ndef helper():\n    return get_normal(1, 2)\n",
    );
    const contaminated = await indexProject({ repoRoot: root, db });

    assert.equal(
      [...listAllFilePaths(db)].includes("nested-worktree/src/geometry.py"),
      true,
      "fixture must actually be contaminated before the cleanup is meaningful",
    );
    assert.equal(
      listAllSymbols(db).some((symbol) => symbol.filePath.startsWith("nested-worktree/")),
      true,
    );
    assert.deepEqual(searchPaths(db, "get_normal"), [
      "nested-worktree/src/geometry.py",
      "src/geometry.py",
    ]);

    // Register the directory as a real linked worktree, then take the supported
    // refresh path: an ordinary incremental refresh.
    await rm(nested, { recursive: true, force: true });
    await git(root, "worktree", "add", "-b", "feature", nested);
    const cleaned = await indexProject({
      repoRoot: root,
      db,
      previousSnapshot: contaminated.snapshot,
    });

    assert.equal(cleaned.worktreeExclusions?.nestedWorktreesExcluded, 1);
    assert.equal(
      [...listAllFilePaths(db)].some((file) => file.startsWith("nested-worktree/")),
      false,
      "zero stale nested-worktree files",
    );
    assert.equal(
      listAllSymbols(db).some((symbol) => symbol.filePath.startsWith("nested-worktree/")),
      false,
      "zero stale nested-worktree symbols",
    );
    assert.equal(
      listAllEdges(db).some((edge) => edge.srcSymbolId.includes("nested-worktree")
        || edge.dstSymbolId.includes("nested-worktree")),
      false,
      "zero stale nested-worktree edges",
    );
    assert.deepEqual(
      searchPaths(db, "get_normal"),
      ["src/geometry.py"],
      "zero stale nested-worktree search hits",
    );
  } finally {
    db.close();
  }
});

test("removing a nested worktree leaves no stale rows on the next refresh", async () => {
  const root = await createRepo();
  const nested = path.join(root, "nested-worktree");
  await git(root, "worktree", "add", "-b", "feature", nested);

  const db = openIndexerDatabase();
  try {
    const first = await indexProject({ repoRoot: root, db });
    await git(root, "worktree", "remove", "--force", nested);

    const second = await indexProject({ repoRoot: root, db, previousSnapshot: first.snapshot });
    assert.equal(second.worktreeExclusions?.nestedWorktreesExcluded, 0);
    assert.deepEqual([...listAllFilePaths(db)].sort(), ["src/geometry.py", "tests/test_geometry.py"]);
  } finally {
    db.close();
  }
});

test("nested-worktree duplication cannot produce a cross-file retrieval pool", async () => {
  const root = await createRepo();
  await git(root, "worktree", "add", "-b", "feature", path.join(root, "nested-worktree"));

  const db = openIndexerDatabase();
  try {
    await indexProject({ repoRoot: root, db });
    // A single logical symbol, a single path. The M132 incident was two, and the
    // second one is what "a fix that crosses file boundaries" was inferred from.
    assert.deepEqual(searchPaths(db, "get_normal"), ["src/geometry.py"]);
    expect([...new Set(listAllSymbols(db).map((symbol) => symbol.filePath))].sort())
      .toEqual(["src/geometry.py", "tests/test_geometry.py"]);
  } finally {
    db.close();
  }
});

test("exclusion resolution runs once per index, not per directory", async () => {
  const root = await createRepo();
  // Five nested worktrees, each a full checkout: resolution stays a single Git call.
  for (let index = 0; index < 5; index += 1) {
    await git(root, "worktree", "add", "-b", `wt-${index}`, path.join(root, "nested", `wt-${index}`));
  }
  const started = performance.now();
  const exclusions = await resolveWorktreeExclusions(root);
  const elapsed = performance.now() - started;

  assert.equal(exclusions.excludedRelativeDirs.size, 5);
  // Generous ceiling: the point is that cost does not scale with directory count.
  assert.equal(elapsed < 2000, true, `worktree discovery took ${elapsed}ms`);
});
