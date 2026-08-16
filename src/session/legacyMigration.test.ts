// M152-B — draining a pre-M152 mixed index into its session store.
//
// The properties that matter are not "rows appeared somewhere". They are the
// ones a user would notice if they were wrong: nothing lost, nothing duplicated
// when the migration is retried, identifiers still resolvable afterwards, and
// the index no longer carrying a second authority for the same state.

import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  PRODUCT_SESSION_TABLES,
  SESSION_MIGRATION_ORDER,
  classifyIndexTable,
} from "../db/indexTableFamilies";
import { initializeSchema } from "../db/schema";
import { listObservations } from "./repositories/observationsRepository";
import { getCapsuleManifestById } from "./repositories/capsuleManifestsRepository";
import { resolvePersistentDeferredVexpRef } from "./repositories/deferredVexpRefsRepository";
import {
  LegacyMigrationOutcome,
  listLegacySessionTables,
  migrateLegacySessionState,
  requiresLegacyMigration,
} from "./legacyMigration";
import { initializeSessionSchema } from "./sessionSchema";
import { createEphemeralSessionDatabase, type WritableSessionDatabase } from "./sessionStore";

const LEGACY_INDEX_PATH = "/fixture/repo/.vtrace/index.sqlite";

/**
 * An index in the pre-M152 mixed layout: repository evidence AND the session
 * tables, populated, exactly as every repository indexed before this milestone
 * looks on disk.
 */
function createLegacyMixedIndex(): Database {
  const db = new Database(":memory:");
  initializeSchema(db);
  // The session half, as `src/db/schema.ts` used to declare it — including the
  // foreign keys to `index_runs` that could not survive the file split.
  initializeSessionSchema(db as WritableSessionDatabase);
  db.run("DROP TABLE session_meta");

  db.run("INSERT INTO index_runs (id, previous_run_id, created_at_ms) VALUES (1, NULL, 100)");
  db.run(
    `INSERT INTO sessions (session_id, repo_root, agent_kind, started_at_ms, last_activity_at_ms, status)
     VALUES ('session-legacy', '/fixture/repo', 'mcp', 100, 200, 'active')`,
  );
  for (const [id, summary, createdAt] of [
    ["obs-1", "Legacy insight one", 101],
    ["obs-2", "Legacy insight two", 102],
    ["obs-3", "Legacy insight three", 103],
  ] as const) {
    db.run(
      `INSERT INTO observations
         (id, repo_root, session_id, kind, source, summary, body, source_run_id, dedupe_key, created_at_ms)
       VALUES (?, '/fixture/repo', 'session-legacy', 'insight', 'manual', ?, 'body', 1, ?, ?)`,
      [id, summary, `dedupe:${id}`, createdAt],
    );
    db.run(
      `INSERT INTO observation_file_links (observation_id, link_ordinal, file_path)
       VALUES (?, 0, 'src/engine.py')`,
      [id],
    );
    db.run(
      `INSERT INTO observation_fq_name_links (observation_id, link_ordinal, fq_name)
       VALUES (?, 0, 'engine.pick_winner')`,
      [id],
    );
  }
  db.run(
    `INSERT INTO capsule_manifests (id, source_run_id, query, created_at_ms)
     VALUES ('manifest-legacy', 1, 'pick_winner', 300)`,
  );
  db.run(
    `INSERT INTO capsule_manifest_items
       (capsule_id, item_ordinal, symbol_id, file_path, fq_name, symbol_kind, role, content_mode, source_backed)
     VALUES ('manifest-legacy', 0, 'sym-1', 'src/engine.py', 'engine.pick_winner', 'function', 'pivot', 'full', 1)`,
  );
  db.run(
    `INSERT INTO deferred_vexp_refs
       (hash, stable_id, category, content_json, metadata_json, notes_json, repo_root,
        source_run_id, session_id, created_at_ms, last_accessed_at_ms, expires_at_ms, payload_hash)
     VALUES ('abcdef012345', 'vexp:capsule:x', 'context_capsule', '{"kind":"json","value":1}',
             '{}', '[]', '/fixture/repo', 1, 'session-legacy', 400, 400, NULL, 'payload-hash')`,
  );
  db.run(
    `INSERT INTO deferred_vexp_ref_tombstones (hash, repo_root, expired_at_ms, reason)
     VALUES ('fedcba543210', '/fixture/repo', 500, 'evicted')`,
  );
  db.run(
    `INSERT INTO project_rules
       (id, repo_root, status, signature, summary, scope_json, evidence_observation_ids_json,
        evidence_count, evidence_kinds_json, confidence, source_run_id, created_at_ms, updated_at_ms)
     VALUES ('rule-legacy', '/fixture/repo', 'active', 'sig', 'Legacy rule', '{}', '[]', 0, '[]',
             'medium', 1, 600, 600)`,
  );
  return db;
}

function rowCount(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("M152 legacy session-state migration", () => {
  test("the migration order covers every product/session table", () => {
    // A table added to one list and forgotten in the other would silently skip
    // migration, so the two are checked against each other rather than by eye.
    assert.deepEqual([...SESSION_MIGRATION_ORDER].sort(), [...PRODUCT_SESSION_TABLES].sort());
  });

  test("a legacy mixed index is detected and drained, and the tables are removed", () => {
    const indexDb = createLegacyMixedIndex();
    const sessionDb = createEphemeralSessionDatabase();
    try {
      assert.equal(listLegacySessionTables(indexDb).length, PRODUCT_SESSION_TABLES.size);
      assert.equal(requiresLegacyMigration(indexDb, sessionDb, LEGACY_INDEX_PATH), true);

      const result = migrateLegacySessionState({
        indexDb,
        indexDbPath: LEGACY_INDEX_PATH,
        sessionDb,
        nowMs: 1_000,
      });

      assert.equal(result.outcome, LegacyMigrationOutcome.Migrated);
      assert.equal(rowCount(sessionDb, "observations"), 3);
      assert.equal(rowCount(sessionDb, "observation_file_links"), 3);
      assert.equal(rowCount(sessionDb, "observation_fq_name_links"), 3);
      assert.equal(rowCount(sessionDb, "sessions"), 1);
      assert.equal(rowCount(sessionDb, "capsule_manifests"), 1);
      assert.equal(rowCount(sessionDb, "capsule_manifest_items"), 1);
      assert.equal(rowCount(sessionDb, "deferred_vexp_refs"), 1);
      assert.equal(rowCount(sessionDb, "deferred_vexp_ref_tombstones"), 1);
      assert.equal(rowCount(sessionDb, "project_rules"), 1);

      // §134: removed, not left as empty writable compatibility tables.
      assert.deepEqual(listLegacySessionTables(indexDb), []);
      // §136: and the index still owns all of its own evidence.
      assert.equal(rowCount(indexDb, "index_runs"), 1);
    } finally {
      sessionDb.close();
      indexDb.close();
    }
  });

  test("identifiers survive the move and stay resolvable", () => {
    // §26: an outstanding capsuleManifestId or deferred-ref hash must not be
    // invalidated just because the storage moved underneath it.
    const indexDb = createLegacyMixedIndex();
    const sessionDb = createEphemeralSessionDatabase();
    try {
      migrateLegacySessionState({ indexDb, indexDbPath: LEGACY_INDEX_PATH, sessionDb, nowMs: 1_000 });

      const manifest = getCapsuleManifestById(sessionDb, "manifest-legacy");
      assert.notEqual(manifest, undefined);
      assert.equal(manifest!.sourceRunId, 1);
      assert.equal(manifest!.items.length, 1);
      assert.equal(manifest!.items[0]!.fqName, "engine.pick_winner");

      const ref = resolvePersistentDeferredVexpRef(sessionDb, "abcdef012345");
      assert.notEqual(ref, null);
      assert.equal(ref!.stableId, "vexp:capsule:x");

      assert.deepEqual(
        listObservations(sessionDb).map((observation) => observation.id).sort(),
        ["obs-1", "obs-2", "obs-3"],
      );
      // Links travelled with their parent, not just the parent rows.
      assert.deepEqual(
        listObservations(sessionDb).find((o) => o.id === "obs-1")!.linkedFilePaths,
        ["src/engine.py"],
      );
    } finally {
      sessionDb.close();
      indexDb.close();
    }
  });

  test("running the migration three times produces the same final state", () => {
    // §24. Idempotence is checked on CONTENT, not on a row count that could be
    // right for the wrong reason.
    const indexDb = createLegacyMixedIndex();
    const sessionDb = createEphemeralSessionDatabase();
    try {
      const digest = (): string => JSON.stringify(
        [...PRODUCT_SESSION_TABLES].sort().map((table) => [
          table,
          sessionDb.query(`SELECT * FROM ${table}`).all(),
        ]),
      );

      migrateLegacySessionState({ indexDb, indexDbPath: LEGACY_INDEX_PATH, sessionDb, nowMs: 1 });
      const afterFirst = digest();
      const second = migrateLegacySessionState({ indexDb, indexDbPath: LEGACY_INDEX_PATH, sessionDb, nowMs: 2 });
      const third = migrateLegacySessionState({ indexDb, indexDbPath: LEGACY_INDEX_PATH, sessionDb, nowMs: 3 });

      assert.equal(second.outcome, LegacyMigrationOutcome.NotLegacy);
      assert.equal(third.outcome, LegacyMigrationOutcome.NotLegacy);
      assert.equal(digest(), afterFirst);
    } finally {
      sessionDb.close();
      indexDb.close();
    }
  });

  test("a retry after a partial copy adds nothing and loses nothing", () => {
    // §164. Simulates the crash window: rows already copied, the completion
    // marker never written, the legacy tables still present.
    const indexDb = createLegacyMixedIndex();
    const sessionDb = createEphemeralSessionDatabase();
    try {
      // Partial success: two of the three observations and their parent session
      // made it across before the process died.
      sessionDb.run(
        `INSERT INTO sessions (session_id, repo_root, agent_kind, started_at_ms, last_activity_at_ms, status)
         VALUES ('session-legacy', '/fixture/repo', 'mcp', 100, 200, 'active')`,
      );
      for (const id of ["obs-1", "obs-2"]) {
        sessionDb.run(
          `INSERT INTO observations
             (id, repo_root, session_id, kind, source, summary, body, source_run_id, dedupe_key, created_at_ms)
           VALUES (?, '/fixture/repo', 'session-legacy', 'insight', 'manual', 'partial', 'body', 1, ?, 1)`,
          [id, `dedupe:${id}`],
        );
      }

      const result = migrateLegacySessionState({
        indexDb,
        indexDbPath: LEGACY_INDEX_PATH,
        sessionDb,
        nowMs: 1_000,
      });

      assert.equal(result.outcome, LegacyMigrationOutcome.Migrated);
      assert.equal(rowCount(sessionDb, "observations"), 3, "no duplicate observations");
      assert.equal(rowCount(sessionDb, "sessions"), 1, "no duplicate session");
      const observations = result.families.find((family) => family.table === "observations")!;
      assert.equal(observations.rowsAlreadyPresent, 2);
      assert.equal(observations.rowsCopied, 1);
    } finally {
      sessionDb.close();
      indexDb.close();
    }
  });

  test("a completion marker from a different index does not suppress this one", () => {
    // §81. "Some legacy state was drained once" is not "this index was drained".
    const indexDb = createLegacyMixedIndex();
    const sessionDb = createEphemeralSessionDatabase();
    try {
      migrateLegacySessionState({
        indexDb,
        indexDbPath: "/some/other/repo/.vtrace/index.sqlite",
        sessionDb,
        nowMs: 1,
      });
      assert.equal(rowCount(sessionDb, "observations"), 3);

      const other = createLegacyMixedIndex();
      try {
        assert.equal(requiresLegacyMigration(other, sessionDb, LEGACY_INDEX_PATH), true);
      } finally {
        other.close();
      }
    } finally {
      sessionDb.close();
      indexDb.close();
    }
  });

  test("an index with no session tables is not treated as legacy", () => {
    const indexDb = new Database(":memory:");
    const sessionDb = createEphemeralSessionDatabase();
    try {
      initializeSchema(indexDb);
      assert.deepEqual(listLegacySessionTables(indexDb), []);
      assert.equal(requiresLegacyMigration(indexDb, sessionDb, LEGACY_INDEX_PATH), false);
      const result = migrateLegacySessionState({
        indexDb,
        indexDbPath: LEGACY_INDEX_PATH,
        sessionDb,
        nowMs: 1,
      });
      assert.equal(result.outcome, LegacyMigrationOutcome.NotLegacy);
      assert.equal(result.totalRowsCopied, 0);
    } finally {
      sessionDb.close();
      indexDb.close();
    }
  });

  test("a legacy row missing a column the current schema declares keeps the default", () => {
    // A pre-M138 observation has no provenance columns. It must arrive without
    // provenance rather than being handed the migrating runtime's identity.
    const indexDb = new Database(":memory:");
    const sessionDb = createEphemeralSessionDatabase();
    try {
      initializeSchema(indexDb);
      indexDb.exec(`
        CREATE TABLE observations (
          id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, session_id TEXT,
          kind TEXT NOT NULL, source TEXT NOT NULL, summary TEXT NOT NULL,
          body TEXT NOT NULL, created_at_ms INTEGER NOT NULL
        );
        INSERT INTO observations VALUES
          ('old', '/fixture/repo', NULL, 'insight', 'manual', 'Older than provenance', '', 1);
      `);

      migrateLegacySessionState({ indexDb, indexDbPath: LEGACY_INDEX_PATH, sessionDb, nowMs: 1 });

      const observation = listObservations(sessionDb)[0]!;
      assert.equal(observation.id, "old");
      assert.equal(observation.provenance, undefined);
      assert.equal(observation.scope, undefined);
    } finally {
      sessionDb.close();
      indexDb.close();
    }
  });

  test("no repository-derived table is ever copied into the session store", () => {
    // §136. The drain moves product state out; it must not pull evidence in.
    const indexDb = createLegacyMixedIndex();
    const sessionDb = createEphemeralSessionDatabase();
    try {
      migrateLegacySessionState({ indexDb, indexDbPath: LEGACY_INDEX_PATH, sessionDb, nowMs: 1 });
      const names = (sessionDb.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      ).all() as { name: string }[]).map((row) => row.name);
      const derived = names.filter((name) => classifyIndexTable(name) === "repository_derived");
      expect(derived).toEqual([]);
    } finally {
      sessionDb.close();
      indexDb.close();
    }
  });
});
