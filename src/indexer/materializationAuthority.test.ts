import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { initRepo } from "../setup/initRepo";
import { resolveIndexDbPath } from "./indexMeta";
import { reindexRepoAndRefreshState } from "../runtime/reindexRepo";
import { evaluateMaterializedGraph } from "./materializationAuthority";
import {
  FILE_SNAPSHOT_SCHEMA_VERSION,
  RETRIEVAL_SCHEMA_VERSION,
  type IndexedFileSnapshot,
  type IndexedFileSnapshotSet,
} from "./incrementalIndex";

const execFile = promisify(execFileCallback);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, encoding: "utf8" });
}

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "vtrace-m184-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The predicate itself.
// ---------------------------------------------------------------------------

function snapshotOf(files: ReadonlyArray<Pick<IndexedFileSnapshot, "relativePath" | "contentHash" | "indexOutcome">>): IndexedFileSnapshotSet {
  return {
    schemaVersion: FILE_SNAPSHOT_SCHEMA_VERSION,
    files: files.map((file) => ({
      relativePath: file.relativePath,
      language: "typescript",
      contentHash: file.contentHash,
      contentKind: "git_blob",
      indexOutcome: file.indexOutcome,
      parserCapability: "supported",
      bindingContextHash: "binding",
      sizeBytes: 1,
    })) as readonly IndexedFileSnapshot[],
    fileCount: files.length,
    snapshotHash: "snapshot",
    graphSchemaVersion: 1,
    retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION,
    bindingContextHash: "binding",
    semanticContextHash: "semantic",
    parserRegistryFingerprint: "registry",
  };
}

function graphWith(rows: ReadonlyArray<readonly [string, string]>): ReturnType<typeof openIndexerDatabase> {
  const db = openIndexerDatabase(":memory:");
  for (const [filePath, contentHash] of rows) {
    db.run(
      "INSERT INTO files (id, path, language, content_hash, size_bytes) VALUES (?, ?, 'typescript', ?, 1)",
      [filePath, filePath, contentHash],
    );
  }
  return db;
}

test("a graph holding every file the snapshot calls indexed is usable", () => {
  const db = graphWith([["a.ts", "h1"], ["b.ts", "h2"]]);
  try {
    const verdict = evaluateMaterializedGraph(db, snapshotOf([
      { relativePath: "a.ts", contentHash: "h1", indexOutcome: "indexed" },
      { relativePath: "b.ts", contentHash: "h2", indexOutcome: "indexed" },
    ]));
    assert.deepEqual(verdict, { usable: true });
  } finally {
    db.close();
  }
});

test("skipped and failed files are not expected in the graph", () => {
  // The persist transaction writes rows only for successfully parsed files, so
  // requiring a row for every snapshot ENTRY (rather than every indexed entry)
  // would call a correct index broken on any repository with an unsupported or
  // unparseable file.
  const db = graphWith([["a.ts", "h1"]]);
  try {
    const verdict = evaluateMaterializedGraph(db, snapshotOf([
      { relativePath: "a.ts", contentHash: "h1", indexOutcome: "indexed" },
      { relativePath: "vendor.min.js", contentHash: "h2", indexOutcome: "skipped" },
      { relativePath: "broken.ts", contentHash: "h3", indexOutcome: "failed" },
    ]));
    assert.deepEqual(verdict, { usable: true });
  } finally {
    db.close();
  }
});

test("an empty graph does not back a snapshot that claims indexed files", () => {
  const db = graphWith([]);
  try {
    const verdict = evaluateMaterializedGraph(db, snapshotOf([
      { relativePath: "a.ts", contentHash: "h1", indexOutcome: "indexed" },
    ]));
    assert.equal(verdict.usable, false);
    assert.equal(verdict.usable === false && verdict.defect, "graph_missing_indexed_files");
    assert.equal(verdict.usable === false && verdict.expectedIndexedFiles, 1);
    assert.equal(verdict.usable === false && verdict.materializedFiles, 0);
  } finally {
    db.close();
  }
});

test("M184 §48: an empty graph DOES back a snapshot with no indexed files", () => {
  // A repository with no supported files has a legitimately empty index. A
  // `symbolCount > 0` or `fileCount > 0` validity rule would force it to rebuild
  // forever; structural coherence calls it what it is — valid.
  const db = graphWith([]);
  try {
    assert.deepEqual(evaluateMaterializedGraph(db, snapshotOf([])), { usable: true });
    assert.deepEqual(
      evaluateMaterializedGraph(db, snapshotOf([
        { relativePath: "notes.txt", contentHash: "h1", indexOutcome: "skipped" },
      ])),
      { usable: true },
    );
  } finally {
    db.close();
  }
});

test("a graph materialized from different content does not back the snapshot", () => {
  const db = graphWith([["a.ts", "OTHER"]]);
  try {
    const verdict = evaluateMaterializedGraph(db, snapshotOf([
      { relativePath: "a.ts", contentHash: "h1", indexOutcome: "indexed" },
    ]));
    assert.equal(verdict.usable === false && verdict.defect, "graph_content_mismatch");
    assert.equal(verdict.usable === false && verdict.examplePath, "a.ts");
  } finally {
    db.close();
  }
});

test("a caller that already knows the graph is absent is believed without a query", () => {
  const db = graphWith([["a.ts", "h1"]]);
  try {
    const verdict = evaluateMaterializedGraph(
      db,
      snapshotOf([{ relativePath: "a.ts", contentHash: "h1", indexOutcome: "indexed" }]),
      false,
    );
    assert.equal(verdict.usable === false && verdict.defect, "graph_declared_absent");
  } finally {
    db.close();
  }
});

test("an unreadable graph is not authoritative", () => {
  const db = openIndexerDatabase(":memory:");
  try {
    db.run("DROP TABLE files");
    const verdict = evaluateMaterializedGraph(db, snapshotOf([
      { relativePath: "a.ts", contentHash: "h1", indexOutcome: "indexed" },
    ]));
    assert.equal(verdict.usable === false && verdict.defect, "graph_unreadable");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// The lifecycle the predicate governs.
// ---------------------------------------------------------------------------

interface Fixture {
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly statePath: string;
}

async function createIndexedRepo(files: Record<string, string>): Promise<Fixture> {
  const repoRoot = path.join(scratch, "repo");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repoRoot, relativePath)), { recursive: true });
    await writeFile(path.join(repoRoot, relativePath), content);
  }
  await git(repoRoot, "init", "--initial-branch=main");
  await git(repoRoot, "config", "user.email", "m184@example.com");
  await git(repoRoot, "config", "user.name", "M184");
  await git(repoRoot, "add", ".");
  await git(repoRoot, "commit", "-m", "initial");
  const initialized = await initRepo({ repoPath: repoRoot });
  return {
    repoRoot: initialized.repoRoot,
    dbPath: initialized.paths.dbPath,
    statePath: initialized.paths.statePath,
  };
}

function reindexInput(fixture: Fixture) {
  return {
    repoRoot: fixture.repoRoot,
    dbPath: fixture.dbPath,
    statePath: fixture.statePath,
    configPresent: true,
    statePresent: true,
    usesDbPathOverride: false,
  } as const;
}

function graphShape(dbPath: string): { files: number; symbols: number } {
  const db = openIndexerDatabase(dbPath);
  try {
    return {
      files: (db.query("SELECT COUNT(*) AS count FROM files").get() as { count: number }).count,
      symbols: (db.query("SELECT COUNT(*) AS count FROM symbols").get() as { count: number }).count,
    };
  } finally {
    db.close();
  }
}

const SAMPLE_FILES = {
  "src/models.ts": "export interface User { id: string }\n",
  "src/service.ts": "import { User } from \"./models\";\nexport function readUser(): User { return { id: \"fixture\" }; }\n",
};

test("valid registry + valid materialization + unchanged source is a legitimate no-op", async () => {
  const fixture = await createIndexedRepo(SAMPLE_FILES);
  const before = graphShape(fixture.dbPath);
  assert.ok(before.symbols > 0, "fixture must start from a materialized index");

  const result = await reindexRepoAndRefreshState(reindexInput(fixture));

  assert.equal(result.indexResult.performance?.mode, "noop");
  assert.equal(result.indexResult.performance?.parsedFiles, 0);
  assert.deepEqual(graphShape(fixture.dbPath), before);
});

test("valid registry + deleted materialization is not a no-op and restores a usable index", async () => {
  // The M184 headline: the durable registry under <gitCommonDir>/vtrace survives
  // `rm -rf .vtrace`, so the planner still proves the SOURCE is unchanged. That
  // must no longer be mistaken for proof that the graph is still there.
  const fixture = await createIndexedRepo(SAMPLE_FILES);
  const before = graphShape(fixture.dbPath);
  await rm(path.join(fixture.repoRoot, ".vtrace"), { recursive: true, force: true });

  const result = await reindexRepoAndRefreshState(reindexInput(fixture));

  assert.notEqual(result.indexResult.performance?.mode, "noop");
  assert.equal(result.indexResult.performance?.fallbackReason, "materialization_missing");
  assert.deepEqual(graphShape(fixture.dbPath), before);
});

test("a deleted index database with the manifest still present is not a no-op", async () => {
  // A distinct branch: `.vtrace/index.meta.json` supplies the snapshot directly,
  // so the shared registry is never consulted and the manifest alone would have
  // certified an empty database as current.
  const fixture = await createIndexedRepo(SAMPLE_FILES);
  const before = graphShape(fixture.dbPath);
  await rm(fixture.dbPath, { force: true });

  const result = await reindexRepoAndRefreshState(reindexInput(fixture));

  assert.notEqual(result.indexResult.performance?.mode, "noop");
  assert.deepEqual(graphShape(fixture.dbPath), before);
});

test("an emptied index database is not a no-op", async () => {
  const fixture = await createIndexedRepo(SAMPLE_FILES);
  const before = graphShape(fixture.dbPath);
  const db = openIndexerDatabase(fixture.dbPath);
  try {
    db.run("DELETE FROM edges");
    db.run("DELETE FROM symbols");
    db.run("DELETE FROM files");
  } finally {
    db.close();
  }

  const result = await reindexRepoAndRefreshState(reindexInput(fixture));

  assert.notEqual(result.indexResult.performance?.mode, "noop");
  assert.deepEqual(graphShape(fixture.dbPath), before);
});

test("repeated delete-and-reindex cycles reconstruct an equivalent index", async () => {
  const fixture = await createIndexedRepo(SAMPLE_FILES);
  const before = graphShape(fixture.dbPath);

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await rm(path.join(fixture.repoRoot, ".vtrace"), { recursive: true, force: true });
    const rebuilt = await reindexRepoAndRefreshState(reindexInput(fixture));
    assert.notEqual(rebuilt.indexResult.performance?.mode, "noop");
    assert.deepEqual(graphShape(fixture.dbPath), before, `cycle ${cycle} diverged`);

    const settled = await reindexRepoAndRefreshState(reindexInput(fixture));
    assert.equal(settled.indexResult.performance?.mode, "noop", `cycle ${cycle} did not settle`);
  }
});

test("a repository with no indexable content still no-ops after its materialization is deleted", async () => {
  // §48 as a lifecycle property, not just a predicate one: nothing about an
  // empty index is broken, so re-materializing it forever would be wrong.
  const fixture = await createIndexedRepo({ "NOTES.txt": "no supported files here\n" });
  assert.deepEqual(graphShape(fixture.dbPath), { files: 0, symbols: 0 });

  await rm(path.join(fixture.repoRoot, ".vtrace"), { recursive: true, force: true });
  const result = await reindexRepoAndRefreshState(reindexInput(fixture));

  assert.equal(result.indexResult.performance?.mode, "noop");
  assert.deepEqual(graphShape(fixture.dbPath), { files: 0, symbols: 0 });
});

test("a worktree that has never been indexed does not inherit a sibling's materialization", async () => {
  // The registry is keyed by repositoryId, which every worktree of a repository
  // shares. `vtrace init` was already safe here — it declares `hasExistingGraph:
  // false` — but `vtrace index` never did, so a second worktree's FIRST index
  // selected the first worktree's snapshot, planned a no-op against the database
  // it had just created, and left the user with an empty index.
  const main = await createIndexedRepo(SAMPLE_FILES);
  const expected = graphShape(main.dbPath);

  const secondRoot = path.join(scratch, "worktree-2");
  await git(main.repoRoot, "worktree", "add", secondRoot, "HEAD");
  const secondDbPath = resolveIndexDbPath(secondRoot);
  await mkdir(path.dirname(secondDbPath), { recursive: true });

  const result = await reindexRepoAndRefreshState({
    repoRoot: secondRoot,
    dbPath: secondDbPath,
    statePath: path.join(path.dirname(secondDbPath), "state.json"),
    configPresent: false,
    statePresent: false,
    usesDbPathOverride: false,
  });

  assert.notEqual(result.indexResult.performance?.mode, "noop");
  assert.deepEqual(
    graphShape(secondDbPath),
    expected,
    "a never-indexed worktree must materialize its own graph",
  );
});
