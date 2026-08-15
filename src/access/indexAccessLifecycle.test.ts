/**
 * M148-A — the access migration as a PRODUCT lifecycle operation.
 *
 * M147 proved the migration correct in isolation. What was missing is the only
 * thing a user can act on: a way to reach it. So the controls here run the real
 * product entry points — `initRepo` (what `vtrace init`/`setup` calls) and
 * `reindexRepoAndRefreshState` (what `vtrace index` and the MCP `index_repo`
 * tool call) — and then ask the SQLite catalogue what exists, never an internal
 * flag. A boolean this module set itself would pass even if no index were ever
 * created.
 *
 * The load-bearing claim is the cheap one: an existing compatible index gains
 * the physical access path WITHOUT regenerating any source-derived state. That
 * is measured three ways at once — the refresh plan says `noop`, the parse and
 * graph counters say zero, and the derived content compares byte-identical
 * before and after. Any one of them alone could be true while a rebuild quietly
 * happened.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureIndexAccessCapability,
  inspectIndexAccessCapability,
  NameLookupAccess,
} from "./indexAccessLifecycle";
import { SYMBOL_NAME_ACCESS_PATH_INDEXES } from "./symbolNameAccessPath";
import { computeIndexFingerprints, resolveIndexDbPath } from "../indexer/indexMeta";
import { evaluateIndexReadiness } from "../indexer/indexReadiness";
import { withWorktreeIndexLock, WorktreeIndexLockError } from "../indexer/worktreeIndexLock";
import { reindexRepoAndRefreshState } from "../runtime/reindexRepo";
import { initRepo } from "../setup/initRepo";
import { resolveRepoLocalPaths } from "../setup/repoState";
import { cleanupWorkspaceFixtures, makeFixtureRepo, makeWorkspaceRoot } from "../workspace/workspaceFixture";

afterAll(cleanupWorkspaceFixtures);

const ACCESS_MODULE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "indexAccessLifecycle.ts",
);

/** A repository big enough that a rebuild could not hide in the counters. */
async function indexedRepo(prefix: string) {
  const root = await makeWorkspaceRoot(prefix);
  const files: Record<string, string> = {};
  for (let module = 0; module < 3; module += 1) {
    const lines: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      lines.push(`class Thing${module}_${index}:`);
      lines.push(`    def act_${module}_${index}(self):`);
      lines.push(`        return helper_${module}_${index}()`);
      lines.push(`def helper_${module}_${index}():`);
      lines.push(`    return ${index}`);
    }
    files[`src/mod_${module}.py`] = `${lines.join("\n")}\n`;
  }
  const repoRoot = await makeFixtureRepo(path.join(root, "repo"), { files });
  const init = await initRepo({ repoPath: repoRoot });
  const paths = resolveRepoLocalPaths(repoRoot);
  return { repoRoot, dbPath: resolveIndexDbPath(repoRoot), statePath: paths.statePath, init };
}

function reindexInput(fixture: { repoRoot: string; dbPath: string; statePath: string }) {
  return {
    repoRoot: fixture.repoRoot,
    dbPath: fixture.dbPath,
    statePath: fixture.statePath,
    configPresent: true,
    statePresent: true,
    usesDbPathOverride: false,
  } as const;
}

/** An M147-compatible index that predates the access path. */
function removeAccessPath(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    for (const name of SYMBOL_NAME_ACCESS_PATH_INDEXES) db.run(`DROP INDEX IF EXISTS ${name}`);
  } finally {
    db.close();
  }
}

function catalogueIndexes(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'symbols' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
  } finally {
    db.close();
  }
}

/** Everything an index run regenerates. A physical migration may move none of it. */
function derivedContent(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return JSON.stringify({
      files: db.query("SELECT id, path, language FROM files ORDER BY path").all(),
      symbols: db.query(
        "SELECT id, fq_name, local_name, kind, file_id, start_line, end_line FROM symbols ORDER BY id",
      ).all(),
      edges: db.query(
        "SELECT src_symbol_id, dst_symbol_id, edge_type FROM edges ORDER BY src_symbol_id, dst_symbol_id, edge_type",
      ).all(),
      fts: db.query("SELECT symbol_id, local_name, fq_name, file_path FROM symbol_search_fts ORDER BY symbol_id").all(),
      chunks: db.query("SELECT id, file_id, start_line, end_line FROM document_chunks ORDER BY id").all(),
    });
  } finally {
    db.close();
  }
}

/** The one membership statement M147 defined, asked of both access modes. */
const MEMBERSHIP_SQL = "SELECT 1 AS hit FROM symbols WHERE local_name = ? OR fq_name = ? LIMIT 1";

function membershipAnswers(dbPath: string, names: readonly string[]): Record<string, boolean> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const answers: Record<string, boolean> = {};
    for (const name of names) {
      answers[name] = db.query(MEMBERSHIP_SQL).get(name, name) !== null;
    }
    return answers;
  } finally {
    db.close();
  }
}

function membershipQueryPlan(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query(`EXPLAIN QUERY PLAN ${MEMBERSHIP_SQL}`).all() as Array<{ detail: string }>)
      .map((row) => row.detail)
      .join(" | ");
  } finally {
    db.close();
  }
}

const PROBE_NAMES = ["helper_0_0", "Thing2_7", "act_1_3", "NoSuchSymbolAnywhere", "helper_9_9"] as const;

// ---------------------------------------------------------------------------
// §19 — a fresh index leaves the lifecycle optimized
// ---------------------------------------------------------------------------

describe("M148-A fresh index lifecycle (§19)", () => {
  test("`vtrace init` leaves the access path installed, per the catalogue", async () => {
    const fixture = await indexedRepo("m148a-fresh-init-");

    // The catalogue, not the outcome object: an internal flag can be true while
    // nothing was created.
    for (const name of SYMBOL_NAME_ACCESS_PATH_INDEXES) {
      expect(catalogueIndexes(fixture.dbPath)).toContain(name);
    }
    expect(fixture.init.accessCapability.attempted).toBe(true);
    expect(fixture.init.accessCapability.error).toBeNull();
    expect(fixture.init.accessCapability.state.nameLookupAccess).toBe(NameLookupAccess.Indexed);
  }, 60_000);

  test("a reindex through the product path also ensures it", async () => {
    const fixture = await indexedRepo("m148a-fresh-reindex-");
    removeAccessPath(fixture.dbPath);
    expect(catalogueIndexes(fixture.dbPath)).not.toContain(SYMBOL_NAME_ACCESS_PATH_INDEXES[0]);

    const result = await reindexRepoAndRefreshState({ ...reindexInput(fixture), refreshMode: "full" });

    expect(result.accessCapability.applied).toBe(true);
    expect(result.accessCapability.state.nameLookupAccess).toBe(NameLookupAccess.Indexed);
    for (const name of SYMBOL_NAME_ACCESS_PATH_INDEXES) {
      expect(catalogueIndexes(fixture.dbPath)).toContain(name);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// §20 — an existing compatible index migrates without a semantic rebuild
// ---------------------------------------------------------------------------

describe("M148-A existing-index migration (§20)", () => {
  test("normal index maintenance installs the access path and regenerates nothing", async () => {
    const fixture = await indexedRepo("m148a-existing-");
    removeAccessPath(fixture.dbPath);

    const before = {
      content: derivedContent(fixture.dbPath),
      membership: membershipAnswers(fixture.dbPath, PROBE_NAMES),
      plan: membershipQueryPlan(fixture.dbPath),
    };
    expect(inspectIndexAccessCapability(new Database(fixture.dbPath, { readonly: true })).nameLookupAccess)
      .toBe(NameLookupAccess.Fallback);
    // Truthful before the migration too: SQLite must be scanning.
    expect(before.plan).toContain("SCAN symbols");

    const result = await reindexRepoAndRefreshState(reindexInput(fixture));

    // The refresh planner, the parse counters and the graph counters must all
    // agree that no source-derived state was regenerated.
    expect(result.indexResult.performance?.mode).toBe("noop");
    expect(result.indexResult.performance?.parsedFiles).toBe(0);
    expect(result.indexResult.performance?.addedFiles).toBe(0);
    expect(result.indexResult.performance?.modifiedFiles).toBe(0);
    expect(result.indexResult.performance?.graphRowsInserted ?? 0).toBe(0);
    expect(result.indexResult.performance?.graphRowsDeleted ?? 0).toBe(0);

    expect(result.accessCapability.applied).toBe(true);
    expect(result.accessCapability.created.length).toBe(SYMBOL_NAME_ACCESS_PATH_INDEXES.length);
    expect(result.accessCapability.state.nameLookupAccess).toBe(NameLookupAccess.Indexed);

    // Same rows, same answers, better plan.
    expect(derivedContent(fixture.dbPath)).toBe(before.content);
    expect(membershipAnswers(fixture.dbPath, PROBE_NAMES)).toEqual(before.membership);
    const after = membershipQueryPlan(fixture.dbPath);
    expect(after).not.toContain("SCAN symbols");
    expect(after).toContain("idx_symbols_local_name");
    expect(after).toContain("idx_symbols_fq_name");
  }, 60_000);

  test("semantic readiness and derivation fingerprints are unmoved by the migration", async () => {
    const fixture = await indexedRepo("m148a-readiness-");
    removeAccessPath(fixture.dbPath);

    const fingerprintsBefore = await computeIndexFingerprints();
    const readinessBefore = await evaluateIndexReadiness(fixture.repoRoot, { probe: "full" });

    const db = new Database(fixture.dbPath);
    try {
      expect(ensureIndexAccessCapability(db).applied).toBe(true);
    } finally {
      db.close();
    }

    const readinessAfter = await evaluateIndexReadiness(fixture.repoRoot, { probe: "full" });
    expect(await computeIndexFingerprints()).toEqual(fingerprintsBefore);
    expect(readinessAfter.ready).toBe(readinessBefore.ready);
    expect(readinessAfter.ready).toBe(true);
    expect(readinessAfter.reason).toBe(readinessBefore.reason);
  }, 60_000);

  test("an unmigrated index stays semantically usable — fallback is a speed, not a verdict", async () => {
    const fixture = await indexedRepo("m148a-unmigrated-");
    removeAccessPath(fixture.dbPath);

    const readiness = await evaluateIndexReadiness(fixture.repoRoot, { probe: "full" });

    expect(readiness.ready).toBe(true);
    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(inspectIndexAccessCapability(db).nameLookupAccess).toBe(NameLookupAccess.Fallback);
    } finally {
      db.close();
    }
    // And it answers the same membership question correctly while unoptimized.
    expect(membershipAnswers(fixture.dbPath, PROBE_NAMES)).toEqual({
      helper_0_0: true,
      Thing2_7: true,
      act_1_3: true,
      NoSuchSymbolAnywhere: false,
      helper_9_9: false,
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// §21-§24 — idempotency, atomicity, concurrency, ownership
// ---------------------------------------------------------------------------

describe("M148-A migration properties (§21-§24)", () => {
  test("a second ensure creates nothing and changes no state", async () => {
    const fixture = await indexedRepo("m148a-idempotent-");
    removeAccessPath(fixture.dbPath);

    const first = await reindexRepoAndRefreshState(reindexInput(fixture));
    const catalogueAfterFirst = catalogueIndexes(fixture.dbPath);
    const contentAfterFirst = derivedContent(fixture.dbPath);

    const second = await reindexRepoAndRefreshState(reindexInput(fixture));

    expect(first.accessCapability.applied).toBe(true);
    expect(second.accessCapability.applied).toBe(false);
    expect(second.accessCapability.created).toEqual([]);
    expect(second.accessCapability.error).toBeNull();
    expect(second.accessCapability.state.nameLookupAccess).toBe(NameLookupAccess.Indexed);
    // No duplicate indexes, no content movement.
    expect(catalogueIndexes(fixture.dbPath)).toEqual(catalogueAfterFirst);
    expect(derivedContent(fixture.dbPath)).toBe(contentAfterFirst);
  }, 60_000);

  test("a failure part-way leaves no half-installed access path", async () => {
    const fixture = await indexedRepo("m148a-atomic-");
    removeAccessPath(fixture.dbPath);

    // Occupy the SECOND index's name with a different object, so the migration
    // fails after the first CREATE INDEX has already run inside the transaction.
    const blocker = new Database(fixture.dbPath);
    try {
      blocker.run(`CREATE TABLE ${SYMBOL_NAME_ACCESS_PATH_INDEXES[1]} (x INTEGER)`);
    } finally {
      blocker.close();
    }

    const contentBefore = derivedContent(fixture.dbPath);
    const db = new Database(fixture.dbPath);
    let outcome;
    try {
      outcome = ensureIndexAccessCapability(db);
    } finally {
      db.close();
    }

    // Reported, not thrown, and the first statement was rolled back with it.
    expect(outcome.error).not.toBeNull();
    expect(outcome.applied).toBe(false);
    expect(catalogueIndexes(fixture.dbPath)).not.toContain(SYMBOL_NAME_ACCESS_PATH_INDEXES[0]);
    expect(outcome.state.nameLookupAccess).toBe(NameLookupAccess.Fallback);
    // The catalogue tells the truth about what exists rather than claiming a
    // migration that did not survive.
    expect(derivedContent(fixture.dbPath)).toBe(contentBefore);
  }, 60_000);

  test("two writers racing the same migration leave one correct access path", async () => {
    const fixture = await indexedRepo("m148a-concurrent-");
    removeAccessPath(fixture.dbPath);
    const contentBefore = derivedContent(fixture.dbPath);

    const left = new Database(fixture.dbPath);
    const right = new Database(fixture.dbPath);
    let outcomes;
    try {
      // Same file, two handles, no coordination beyond SQLite's own locking.
      outcomes = [ensureIndexAccessCapability(left), ensureIndexAccessCapability(right)];
    } finally {
      left.close();
      right.close();
    }

    // Whatever the interleaving: no corruption, no duplicates, no exception.
    expect(outcomes.every((outcome) => outcome.attempted)).toBe(true);
    expect(outcomes.filter((outcome) => outcome.applied).length).toBe(1);
    const catalogue = catalogueIndexes(fixture.dbPath);
    for (const name of SYMBOL_NAME_ACCESS_PATH_INDEXES) {
      expect(catalogue.filter((entry) => entry === name).length).toBe(1);
    }
    expect(derivedContent(fixture.dbPath)).toBe(contentBefore);
  }, 60_000);

  test("the migration cannot bypass worktree index ownership, and the wait is bounded", async () => {
    const fixture = await indexedRepo("m148a-busy-");
    removeAccessPath(fixture.dbPath);

    // Hold the worktree index lock, exactly as a running index would.
    const started = performance.now();
    let error: unknown = null;
    await withWorktreeIndexLock({
      repoRoot: fixture.repoRoot,
      operation: async () => {
        try {
          await reindexRepoAndRefreshState({ ...reindexInput(fixture), lockWaitMs: 200 });
        } catch (caught) {
          error = caught;
        }
      },
    });
    const elapsed = performance.now() - started;

    expect(error).toBeInstanceOf(WorktreeIndexLockError);
    // Bounded, and no migration happened behind the owner's back.
    expect(elapsed).toBeLessThan(10_000);
    expect(catalogueIndexes(fixture.dbPath)).not.toContain(SYMBOL_NAME_ACCESS_PATH_INDEXES[0]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// §17/§27 — read paths do not mutate; access code is not derivation
// ---------------------------------------------------------------------------

describe("M148-A boundaries (§17, §27)", () => {
  test("inspecting the capability never installs it", async () => {
    const fixture = await indexedRepo("m148a-readonly-");
    removeAccessPath(fixture.dbPath);

    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      // Read-only handle: an implementation that repaired the DB here would
      // throw rather than silently succeed, and either way the catalogue must
      // be unchanged afterwards.
      expect(inspectIndexAccessCapability(db).nameLookupAccess).toBe(NameLookupAccess.Fallback);
      expect(inspectIndexAccessCapability(db).missing.length).toBe(SYMBOL_NAME_ACCESS_PATH_INDEXES.length);
    } finally {
      db.close();
    }
    expect(catalogueIndexes(fixture.dbPath)).not.toContain(SYMBOL_NAME_ACCESS_PATH_INDEXES[0]);
  }, 60_000);

  test("changing the access lifecycle module moves no derivation fingerprint", async () => {
    // The behavioural control M146-A demands of every unfingerprinted module:
    // if this were derivation, editing it would invalidate stored indexes.
    const original = await readFile(ACCESS_MODULE, "utf8");
    const before = await computeIndexFingerprints();
    try {
      await appendFile(ACCESS_MODULE, "\n// M148-A behavioural control.\n");
      const after = await computeIndexFingerprints();
      expect(after.indexer_fingerprint).toBe(before.indexer_fingerprint);
      expect(after.parser_fingerprint).toBe(before.parser_fingerprint);
      expect(after.schema_version).toBe(before.schema_version);
      expect(after.config_hash).toBe(before.config_hash);
    } finally {
      await writeFile(ACCESS_MODULE, original);
    }
  }, 60_000);
});
