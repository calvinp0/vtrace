/**
 * M147 — the additive access-path migration.
 *
 * The claim that justifies not treating this as a schema change is narrow and
 * checkable: applying it leaves every derived row exactly as it was. If that
 * were false, the migration would be smuggling a content change past the
 * derivation compatibility contract, and an index would report `ready` while
 * holding content this runtime never agreed to.
 *
 * So the central control reads the derived content out, migrates, reads it back
 * and compares — the same shape M146-A uses to justify its fingerprint
 * exemptions, for the same reason.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";

import {
  applySymbolNameAccessPath,
  inspectSymbolNameAccessPath,
  SYMBOL_NAME_ACCESS_PATH_INDEXES,
  SYMBOL_NAME_ACCESS_PATH_VERSION,
} from "./symbolNameAccessPath";
import { computeIndexFingerprints, resolveIndexDbPath } from "../indexer/indexMeta";
import { initRepo } from "../setup/initRepo";
import { cleanupWorkspaceFixtures, makeFixtureRepo, makeWorkspaceRoot } from "../workspace/workspaceFixture";

afterAll(cleanupWorkspaceFixtures);

async function indexedRepo(prefix: string): Promise<string> {
  const root = await makeWorkspaceRoot(prefix);
  const files: Record<string, string> = {};
  for (let module = 0; module < 3; module += 1) {
    const lines: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      lines.push(`class Thing${module}_${index}:`);
      lines.push(`    def act_${module}_${index}(self):`);
      lines.push(`        return helper_${module}_${index}()`);
      lines.push(`def helper_${module}_${index}():`);
      lines.push(`    return ${index}`);
    }
    files[`src/mod_${module}.py`] = `${lines.join("\n")}\n`;
  }
  const repoRoot = await makeFixtureRepo(path.join(root, "repo"), { files });
  await initRepo({ repoPath: repoRoot });
  return repoRoot;
}

/** Everything an index run regenerates. The migration may not move any of it. */
function derivedContent(db: Database): string {
  return JSON.stringify({
    files: db.query("SELECT id, path, language FROM files ORDER BY path").all(),
    symbols: db.query("SELECT id, fq_name, local_name, kind, file_id, start_line, end_line FROM symbols ORDER BY id").all(),
    edges: db.query("SELECT src_symbol_id, dst_symbol_id, edge_type FROM edges ORDER BY src_symbol_id, dst_symbol_id, edge_type").all(),
    fts: db.query("SELECT symbol_id, local_name, fq_name, file_path FROM symbol_search_fts ORDER BY symbol_id").all(),
    chunks: db.query("SELECT id, file_id, start_line, end_line FROM document_chunks ORDER BY id").all(),
  });
}

describe("M147 symbol-name access path", () => {
  test("a freshly built index does not carry it, and says so", async () => {
    // The starting state every existing installation is in. Reported honestly
    // rather than assumed either way.
    const repoRoot = await indexedRepo("m147-access-fresh-");
    const db = new Database(resolveIndexDbPath(repoRoot), { readonly: true });

    const state = inspectSymbolNameAccessPath(db);

    expect(state.installed).toBe(false);
    expect(state.present).toEqual([]);
    expect(state.missing).toEqual([...SYMBOL_NAME_ACCESS_PATH_INDEXES]);
    expect(state.version).toBe(SYMBOL_NAME_ACCESS_PATH_VERSION);
    db.close();
  }, 60_000);

  test("applying it changes no derived content whatsoever", async () => {
    // The claim the whole placement rests on: this is an access path, not a
    // schema change, so it may be applied to a `ready` index without a rebuild.
    const repoRoot = await indexedRepo("m147-access-content-");
    const db = new Database(resolveIndexDbPath(repoRoot));
    const before = derivedContent(db);

    const migration = applySymbolNameAccessPath(db);

    expect(migration.applied).toBe(true);
    expect(migration.installed).toBe(true);
    expect(migration.created).toEqual([...SYMBOL_NAME_ACCESS_PATH_INDEXES]);
    expect(derivedContent(db)).toBe(before);
    db.close();
  }, 60_000);

  test("applying it does not move any derivation fingerprint", async () => {
    // A migration that moved a fingerprint would refuse every index in the
    // field — the full rebuild this exists to avoid.
    const repoRoot = await indexedRepo("m147-access-fingerprint-");
    const before = await computeIndexFingerprints();
    const db = new Database(resolveIndexDbPath(repoRoot));

    applySymbolNameAccessPath(db);
    const after = await computeIndexFingerprints();

    expect(after.indexer_fingerprint).toBe(before.indexer_fingerprint);
    expect(after.parser_fingerprint).toBe(before.parser_fingerprint);
    expect(after.schema_version).toBe(before.schema_version);
    expect(after.config_hash).toBe(before.config_hash);
    db.close();
  }, 60_000);

  test("it is idempotent, and reports the second run as a no-op", async () => {
    const repoRoot = await indexedRepo("m147-access-idempotent-");
    const db = new Database(resolveIndexDbPath(repoRoot));

    const first = applySymbolNameAccessPath(db);
    const second = applySymbolNameAccessPath(db);

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.created).toEqual([]);
    expect(second.alreadyPresent).toEqual([...SYMBOL_NAME_ACCESS_PATH_INDEXES]);
    expect(second.installed).toBe(true);
    db.close();
  }, 60_000);

  test("a half-installed index is completed, not reported as already done", async () => {
    // Half an access path is not an access path: the membership query is an OR
    // over two columns and needs a keyed lookup on each side.
    const repoRoot = await indexedRepo("m147-access-partial-");
    const db = new Database(resolveIndexDbPath(repoRoot));
    db.run("CREATE INDEX idx_symbols_local_name ON symbols(local_name)");

    expect(inspectSymbolNameAccessPath(db).installed).toBe(false);
    const migration = applySymbolNameAccessPath(db);

    expect(migration.created).toEqual(["idx_symbols_fq_name"]);
    expect(migration.alreadyPresent).toEqual(["idx_symbols_local_name"]);
    expect(migration.installed).toBe(true);
    db.close();
  }, 60_000);

  test("the membership query actually changes plan, and not its answer", async () => {
    // Both halves of the point in one test: the migration is worth doing, and
    // it is safe to do.
    const repoRoot = await indexedRepo("m147-access-plan-");
    const db = new Database(resolveIndexDbPath(repoRoot));
    const membership = "SELECT 1 AS hit FROM symbols WHERE local_name = ? OR fq_name = ? LIMIT 1";
    const names = (db.query("SELECT local_name AS n FROM symbols UNION SELECT fq_name FROM symbols").all() as Array<{ n: string }>)
      .map((row) => row.n);
    const questions = [...names, ...names.slice(0, 20).map((name) => `${name}_absent`), "ZzNever"];

    const planBefore = JSON.stringify(db.query(`EXPLAIN QUERY PLAN ${membership}`).all("x", "x"));
    const answersBefore = questions.map((name) => db.query(membership).get(name, name) !== null);

    applySymbolNameAccessPath(db);

    const planAfter = JSON.stringify(db.query(`EXPLAIN QUERY PLAN ${membership}`).all("x", "x"));
    const answersAfter = questions.map((name) => db.query(membership).get(name, name) !== null);

    expect(planBefore).toContain("SCAN symbols");
    expect(planAfter).toContain("idx_symbols_local_name");
    expect(planAfter).not.toContain("SCAN symbols");
    expect(answersAfter).toEqual(answersBefore);
    expect(answersBefore.filter(Boolean).length).toBe(names.length);
    db.close();
  }, 60_000);

  test("it leaves the index openable and readiness unchanged", async () => {
    // A migrated index must still be the same index: reopening it through the
    // ordinary path must not now report a mismatch.
    const { evaluateIndexReadiness } = await import("../indexer/indexReadiness");
    const repoRoot = await indexedRepo("m147-access-readiness-");
    const before = await evaluateIndexReadiness(repoRoot);

    const db = new Database(resolveIndexDbPath(repoRoot));
    applySymbolNameAccessPath(db);
    db.close();

    const after = await evaluateIndexReadiness(repoRoot);
    expect(before.ready).toBe(true);
    expect(after.ready).toBe(true);
    expect(after.state).toBe(before.state);
    expect(after.reason).toBe(before.reason);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// §34/§48 — the access path must stay truthful across the index lifecycle
// ---------------------------------------------------------------------------

describe("M147 access path across incremental refresh", () => {
  /** Membership exactly as workspace routing asks it. */
  function defines(db: Database, name: string): boolean {
    return db.query("SELECT 1 FROM symbols WHERE local_name = ? OR fq_name = ? LIMIT 1").get(name, name) !== null;
  }

  test("added, removed and renamed symbols update presence truth", async () => {
    // A stale ABSENT is a false uniqueness claim and a stale PRESENT sends a
    // query to a repository that no longer holds the name. SQLite maintains the
    // access path transactionally with the rows, so this asserts the property
    // rather than a mechanism — if the migration ever became a snapshot instead
    // of an index, this is where it would fail.
    const { indexProject } = await import("../indexer/indexProject");
    const { openIndexerDatabase } = await import("../db/sqlite");
    const { writeFile, rm } = await import("node:fs/promises");

    const root = await makeWorkspaceRoot("m147-access-incremental-");
    const repoRoot = await makeFixtureRepo(path.join(root, "repo"), {
      files: {
        "src/keep.py": "def stable_helper():\n    return 1\n",
        "src/going.py": "def doomed_helper():\n    return 2\n",
        "src/rename.py": "def old_name_helper():\n    return 3\n",
      },
    });

    const db = openIndexerDatabase();
    try {
      const first = await indexProject({ repoRoot, db, refreshMode: "full" });
      const migration = applySymbolNameAccessPath(db);
      expect(migration.installed).toBe(true);

      expect(defines(db, "stable_helper")).toBe(true);
      expect(defines(db, "doomed_helper")).toBe(true);
      expect(defines(db, "old_name_helper")).toBe(true);
      expect(defines(db, "new_name_helper")).toBe(false);
      expect(defines(db, "added_helper")).toBe(false);

      await writeFile(path.join(repoRoot, "src/added.py"), "def added_helper():\n    return 4\n");
      await rm(path.join(repoRoot, "src/going.py"));
      await writeFile(path.join(repoRoot, "src/rename.py"), "def new_name_helper():\n    return 3\n");

      const second = await indexProject({ repoRoot, db, previousSnapshot: first.snapshot, refreshMode: "incremental" });
      expect(second.snapshot).not.toBeNull();

      // The access path is still installed, and every answer moved with the source.
      expect(inspectSymbolNameAccessPath(db).installed).toBe(true);
      expect(defines(db, "stable_helper")).toBe(true);
      expect(defines(db, "added_helper")).toBe(true);
      // No stale PRESENT.
      expect(defines(db, "doomed_helper")).toBe(false);
      expect(defines(db, "old_name_helper")).toBe(false);
      // No stale ABSENT — the failure mode that would become false uniqueness.
      expect(defines(db, "new_name_helper")).toBe(true);
    } finally {
      db.close();
    }
  }, 120_000);

  test("migrating before or after indexing yields the same membership answers", async () => {
    // §48: the access path is a property of the final state, not of the order it
    // was installed in. If these disagreed, presence truth would depend on when
    // an installation happened to migrate.
    const { indexProject } = await import("../indexer/indexProject");
    const { openIndexerDatabase } = await import("../db/sqlite");

    const root = await makeWorkspaceRoot("m147-access-order-");
    const repoRoot = await makeFixtureRepo(path.join(root, "repo"), {
      files: {
        "src/a.py": "class Alpha:\n    def act(self):\n        return 1\n",
        "src/b.py": "def beta_helper():\n    return 2\n",
      },
    });

    const early = openIndexerDatabase();
    const late = openIndexerDatabase();
    try {
      // Installed on an empty index, then filled.
      applySymbolNameAccessPath(early);
      await indexProject({ repoRoot, db: early, refreshMode: "full" });

      // Filled first, then migrated — the real upgrade path.
      await indexProject({ repoRoot, db: late, refreshMode: "full" });
      applySymbolNameAccessPath(late);

      const names = (late.query("SELECT local_name AS n FROM symbols UNION SELECT fq_name FROM symbols").all() as Array<{ n: string }>)
        .map((row) => row.n);
      const questions = [...names, "ZzAbsent", "Alpha_absent"];

      expect(questions.map((name) => defines(early, name))).toEqual(questions.map((name) => defines(late, name)));
      expect(inspectSymbolNameAccessPath(early).installed).toBe(true);
      expect(inspectSymbolNameAccessPath(late).installed).toBe(true);
    } finally {
      early.close();
      late.close();
    }
  }, 120_000);
});
