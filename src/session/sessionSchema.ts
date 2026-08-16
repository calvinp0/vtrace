// The mutable half of vtrace's persistence, and the DDL that owns it.
//
// WHY THIS FILE IS NOT IN `src/db`
// --------------------------------
// `src/db` is, by definition, index-deriving source: `INDEXER_SOURCE_DIRS` in
// `src/indexer/indexMeta.ts` content-hashes the whole directory into
// `indexer_fingerprint`, and `src/db/schema.ts` is hashed again into
// `schema_version`. Both are rebuild reasons (M146-A). While observations,
// manifests and deferred refs lived in `src/db`, every change to how vtrace
// remembers a tool call invalidated every stored index in existence and forced a
// full re-derivation of symbols, edges and mechanism facts that the change could
// not possibly have affected.
//
// Session state is not derived from the repository, so it must not be able to
// invalidate what is. Keeping this schema outside `src/db` is what makes that
// true structurally rather than by promise.
//
// WHAT CHANGED FROM THE MIXED LAYOUT
// ----------------------------------
// These are the same eleven tables M151 measured as the only ones a product read
// may move, with the same columns and the same primary keys, so migrated rows
// keep their identifiers and their content (§26, §67). Two differences are
// deliberate:
//
//   1. No FOREIGN KEY to `index_runs`. It is in the other file now, and SQLite
//      cannot enforce a constraint across files. `source_run_id` survives as
//      what it always really was — a provenance value naming the index run the
//      record was derived under (§29, §85).
//
//   2. `session_meta` is new: the session store's own schema version and the
//      record of which legacy index it was migrated from (§31, §81).
//
// The FK loss is not a silently dropped invariant. It changed two behaviours
// that `sessionStore.ts` and the staleness path now handle explicitly:
// `capsule_manifests` used to CASCADE-delete when its source run was deleted,
// and the three nullable references used to be SET NULL. A dangling
// `source_run_id` is now a normal, expected state that means "the index this was
// derived from no longer holds that run" — which is a staleness answer, not a
// reason to destroy the record (§15, §145).

import type { Database } from "bun:sqlite";

/**
 * Bumped when the session table shapes change. Independent of the index's
 * `INIT_STATE_SCHEMA_VERSION` / `schema_version` on purpose: the two stores have
 * separate lifecycles, and reusing the index's version would re-couple them
 * through the back door (§31, §32).
 */
export const SESSION_SCHEMA_VERSION = 1 as const;

/** Rows in `session_meta`. Small, fixed keys — this is not a settings bag. */
export const SessionMetaKey = Object.freeze({
  /** `SESSION_SCHEMA_VERSION` this file was last initialised at. */
  SchemaVersion: "schema_version",
  /** Repository root the store belongs to. Identity, checked on open (§13). */
  RepoRoot: "repo_root",
  /** Set once a legacy mixed index has been drained into this store (§81). */
  LegacyMigrationCompletedAtMs: "legacy_migration_completed_at_ms",
  /** Which legacy index was drained, so a second one cannot claim the marker. */
  LegacyMigrationSourceIndexPath: "legacy_migration_source_index_path",
});

export type SessionMetaKey = (typeof SessionMetaKey)[keyof typeof SessionMetaKey];

export function initializeSessionSchema(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS session_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      agent_kind TEXT,
      started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
      last_activity_at_ms INTEGER NOT NULL CHECK (last_activity_at_ms >= 0),
      status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'compressed')),
      compressed_at_ms INTEGER CHECK (compressed_at_ms IS NULL OR compressed_at_ms >= 0),
      summary_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_last_activity
      ON sessions(last_activity_at_ms DESC, session_id ASC);

    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      session_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('decision', 'insight', 'warning', 'dead_end', 'tool_call')),
      source TEXT NOT NULL CHECK (source IN ('manual', 'mcp_auto')),
      tool_name TEXT,
      query_text TEXT,
      intent TEXT,
      summary TEXT NOT NULL,
      body TEXT NOT NULL,
      source_run_id INTEGER,
      dedupe_key TEXT UNIQUE,
      scope TEXT CHECK (scope IS NULL OR scope IN ('global', 'repository', 'worktree', 'source_state', 'index_state')),
      origin TEXT CHECK (origin IS NULL OR origin IN ('manual', 'tool_derived', 'automatic_capture', 'benchmark', 'migration')),
      provenance_json TEXT,
      semantic_key TEXT,
      result_semantic_hash TEXT,
      supersedes_observation_id TEXT,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_observations_session_created
      ON observations(session_id, created_at_ms DESC, id ASC);

    CREATE INDEX IF NOT EXISTS idx_observations_source_run_id
      ON observations(source_run_id, id);

    CREATE INDEX IF NOT EXISTS idx_observations_scope_semantic
      ON observations(scope, semantic_key, created_at_ms DESC, id ASC);

    CREATE TABLE IF NOT EXISTS session_compression_summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      repo_root TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      first_activity_at_ms INTEGER NOT NULL CHECK (first_activity_at_ms >= 0),
      last_activity_at_ms INTEGER NOT NULL CHECK (last_activity_at_ms >= 0),
      compressed_at_ms INTEGER NOT NULL CHECK (compressed_at_ms >= 0),
      observation_counts_json TEXT NOT NULL,
      tool_call_counts_json TEXT NOT NULL,
      file_paths_json TEXT NOT NULL,
      symbol_ids_json TEXT NOT NULL,
      fq_names_json TEXT NOT NULL,
      key_terms_json TEXT NOT NULL,
      preserved_durable_observation_count INTEGER NOT NULL CHECK (preserved_durable_observation_count >= 0),
      pruned_tool_call_observation_count INTEGER NOT NULL CHECK (pruned_tool_call_observation_count >= 0),
      summary_observation_id TEXT NOT NULL,
      FOREIGN KEY (summary_observation_id)
        REFERENCES observations(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX IF NOT EXISTS idx_session_compression_summaries_compressed_at
      ON session_compression_summaries(compressed_at_ms DESC, session_id ASC);

    CREATE TABLE IF NOT EXISTS observation_file_links (
      observation_id TEXT NOT NULL,
      link_ordinal INTEGER NOT NULL CHECK (link_ordinal >= 0),
      file_path TEXT NOT NULL,
      PRIMARY KEY (observation_id, link_ordinal),
      FOREIGN KEY (observation_id)
        REFERENCES observations(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX IF NOT EXISTS idx_observation_file_links_path
      ON observation_file_links(file_path, observation_id, link_ordinal);

    CREATE TABLE IF NOT EXISTS observation_symbol_links (
      observation_id TEXT NOT NULL,
      link_ordinal INTEGER NOT NULL CHECK (link_ordinal >= 0),
      symbol_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      fq_name TEXT NOT NULL,
      symbol_kind TEXT NOT NULL,
      PRIMARY KEY (observation_id, link_ordinal),
      FOREIGN KEY (observation_id)
        REFERENCES observations(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX IF NOT EXISTS idx_observation_symbol_links_identity
      ON observation_symbol_links(file_path, fq_name, symbol_kind, observation_id, link_ordinal);

    CREATE INDEX IF NOT EXISTS idx_observation_symbol_links_symbol_id
      ON observation_symbol_links(symbol_id, observation_id, link_ordinal);

    CREATE TABLE IF NOT EXISTS observation_fq_name_links (
      observation_id TEXT NOT NULL,
      link_ordinal INTEGER NOT NULL CHECK (link_ordinal >= 0),
      fq_name TEXT NOT NULL,
      PRIMARY KEY (observation_id, link_ordinal),
      FOREIGN KEY (observation_id)
        REFERENCES observations(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX IF NOT EXISTS idx_observation_fq_name_links_fq_name
      ON observation_fq_name_links(fq_name, observation_id, link_ordinal);

    CREATE TABLE IF NOT EXISTS capsule_manifests (
      id TEXT PRIMARY KEY,
      source_run_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_capsule_manifests_source_run_id
      ON capsule_manifests(source_run_id, id);

    CREATE TABLE IF NOT EXISTS capsule_manifest_items (
      capsule_id TEXT NOT NULL,
      item_ordinal INTEGER NOT NULL CHECK (item_ordinal >= 0),
      symbol_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      fq_name TEXT NOT NULL,
      symbol_kind TEXT NOT NULL,
      role TEXT NOT NULL,
      content_mode TEXT NOT NULL,
      source_backed INTEGER NOT NULL CHECK (source_backed IN (0, 1)),
      PRIMARY KEY (capsule_id, item_ordinal),
      FOREIGN KEY (capsule_id)
        REFERENCES capsule_manifests(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX IF NOT EXISTS idx_capsule_manifest_items_symbol_identity
      ON capsule_manifest_items(capsule_id, file_path, fq_name, symbol_kind, item_ordinal);

    CREATE TABLE IF NOT EXISTS project_rules (
      id TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'dismissed', 'stale', 'disabled')),
      signature TEXT NOT NULL,
      summary TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      evidence_observation_ids_json TEXT NOT NULL,
      evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
      evidence_kinds_json TEXT NOT NULL,
      confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
      source_run_id INTEGER,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      promoted_at_ms INTEGER CHECK (promoted_at_ms IS NULL OR promoted_at_ms >= 0),
      stale_metadata_json TEXT,
      UNIQUE (repo_root, signature)
    );

    CREATE INDEX IF NOT EXISTS idx_project_rules_repo_status
      ON project_rules(repo_root, status, updated_at_ms DESC, id ASC);

    CREATE TABLE IF NOT EXISTS deferred_vexp_refs (
      hash TEXT PRIMARY KEY CHECK (length(hash) = 12),
      stable_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      notes_json TEXT NOT NULL,
      repo_root TEXT NOT NULL,
      source_run_id INTEGER,
      session_id TEXT,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      last_accessed_at_ms INTEGER NOT NULL CHECK (last_accessed_at_ms >= 0),
      expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms >= 0),
      payload_hash TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_deferred_vexp_refs_retention
      ON deferred_vexp_refs(created_at_ms ASC, hash ASC);

    CREATE INDEX IF NOT EXISTS idx_deferred_vexp_refs_session
      ON deferred_vexp_refs(session_id, created_at_ms DESC, hash ASC);

    CREATE TABLE IF NOT EXISTS deferred_vexp_ref_tombstones (
      hash TEXT PRIMARY KEY CHECK (length(hash) = 12),
      repo_root TEXT NOT NULL,
      expired_at_ms INTEGER NOT NULL CHECK (expired_at_ms >= 0),
      reason TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_deferred_vexp_ref_tombstones_expired
      ON deferred_vexp_ref_tombstones(expired_at_ms ASC, hash ASC);
  `);

  db.run(
    `INSERT INTO session_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [SessionMetaKey.SchemaVersion, String(SESSION_SCHEMA_VERSION)],
  );
}

export function readSessionMeta(db: Database, key: SessionMetaKey): string | undefined {
  const row = db.query(`SELECT value FROM session_meta WHERE key = ?`).get(key) as
    | { value: string }
    | null;
  return row === null ? undefined : row.value;
}

export function writeSessionMeta(db: Database, key: SessionMetaKey, value: string): void {
  db.run(
    `INSERT INTO session_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}
