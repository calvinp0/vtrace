import type { Database } from "bun:sqlite";

export function initializeSchema(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      language TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0)
    );

    CREATE TABLE IF NOT EXISTS index_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      previous_run_id INTEGER,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      FOREIGN KEY (previous_run_id)
        REFERENCES index_runs(id)
        ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX IF NOT EXISTS idx_index_runs_previous_run_id
      ON index_runs(previous_run_id, id);

    CREATE TABLE IF NOT EXISTS file_run_states (
      run_id INTEGER NOT NULL,
      file_id TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      PRIMARY KEY (run_id, path),
      FOREIGN KEY (run_id)
        REFERENCES index_runs(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX IF NOT EXISTS idx_file_run_states_path
      ON file_run_states(path, run_id);

    CREATE TABLE IF NOT EXISTS symbol_run_states (
      run_id INTEGER NOT NULL,
      symbol_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      fq_name TEXT NOT NULL,
      local_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      signature TEXT NOT NULL,
      exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
      parent_file_path TEXT,
      parent_fq_name TEXT,
      parent_kind TEXT,
      start_line INTEGER NOT NULL CHECK (start_line >= 1),
      end_line INTEGER NOT NULL CHECK (end_line >= start_line),
      start_byte INTEGER NOT NULL CHECK (start_byte >= 0),
      end_byte INTEGER NOT NULL CHECK (end_byte >= start_byte),
      PRIMARY KEY (run_id, symbol_id),
      FOREIGN KEY (run_id)
        REFERENCES index_runs(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX IF NOT EXISTS idx_symbol_run_states_identity
      ON symbol_run_states(run_id, file_path, fq_name, kind, start_byte, end_byte, symbol_id);

    CREATE TABLE IF NOT EXISTS capsule_manifests (
      id TEXT PRIMARY KEY,
      source_run_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      FOREIGN KEY (source_run_id)
        REFERENCES index_runs(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
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
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      FOREIGN KEY (source_run_id)
        REFERENCES index_runs(id)
        ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX IF NOT EXISTS idx_observations_session_created
      ON observations(session_id, created_at_ms DESC, id ASC);

    CREATE INDEX IF NOT EXISTS idx_observations_source_run_id
      ON observations(source_run_id, id);

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
      UNIQUE (repo_root, signature),
      FOREIGN KEY (source_run_id)
        REFERENCES index_runs(id)
        ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX IF NOT EXISTS idx_project_rules_repo_status
      ON project_rules(repo_root, status, updated_at_ms DESC, id ASC);

    CREATE TABLE IF NOT EXISTS symbols (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      fq_name TEXT NOT NULL,
      local_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      signature TEXT NOT NULL,
      start_line INTEGER NOT NULL CHECK (start_line >= 1),
      end_line INTEGER NOT NULL CHECK (end_line >= start_line),
      start_byte INTEGER NOT NULL CHECK (start_byte >= 0),
      end_byte INTEGER NOT NULL CHECK (end_byte >= start_byte),
      parent_symbol_id TEXT,
      exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
      docstring TEXT,
      decorators TEXT,
      FOREIGN KEY (file_id)
        REFERENCES files(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (parent_symbol_id)
        REFERENCES symbols(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX IF NOT EXISTS idx_symbols_file_id_start_byte
      ON symbols(file_id, start_byte, id);

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      src_symbol_id TEXT NOT NULL,
      dst_symbol_id TEXT NOT NULL,
      edge_type TEXT NOT NULL CHECK (edge_type IN ('contains', 'imports', 'calls', 'references')),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      FOREIGN KEY (src_symbol_id)
        REFERENCES symbols(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (dst_symbol_id)
        REFERENCES symbols(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX IF NOT EXISTS idx_edges_src_symbol_id
      ON edges(src_symbol_id, id);

    CREATE INDEX IF NOT EXISTS idx_edges_dst_symbol_id
      ON edges(dst_symbol_id, id);

    CREATE VIRTUAL TABLE IF NOT EXISTS symbol_search_fts USING fts5(
      symbol_id UNINDEXED,
      file_path_raw UNINDEXED,
      local_name,
      fq_name,
      signature,
      docstring,
      file_path,
      tokenize = 'unicode61'
    );
  `);

  ensureColumnExists(db, "symbols", "decorators", "TEXT");
  ensureEdgeCheckSupportsCallsReferences(db);
  ensureSessionLifecycleSchema(db);
}

function ensureSessionLifecycleSchema(db: Database): void {
  const row = db.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`).get() as
    | { sql: string }
    | undefined;

  if (row === undefined || row.sql === null) {
    return;
  }

  if (
    row.sql.includes("'compressed'")
    && tableHasColumn(db, "sessions", "compressed_at_ms")
    && tableHasColumn(db, "sessions", "summary_id")
  ) {
    return;
  }

  db.exec(`
    PRAGMA foreign_keys = OFF;

    ALTER TABLE sessions RENAME TO sessions__old_lifecycle;

    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      agent_kind TEXT,
      started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
      last_activity_at_ms INTEGER NOT NULL CHECK (last_activity_at_ms >= 0),
      status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'compressed')),
      compressed_at_ms INTEGER CHECK (compressed_at_ms IS NULL OR compressed_at_ms >= 0),
      summary_id TEXT
    );

    INSERT INTO sessions (
      session_id,
      repo_root,
      agent_kind,
      started_at_ms,
      last_activity_at_ms,
      status,
      compressed_at_ms,
      summary_id
    )
    SELECT
      session_id,
      repo_root,
      agent_kind,
      started_at_ms,
      last_activity_at_ms,
      CASE
        WHEN status IN ('active', 'inactive') THEN status
        ELSE 'active'
      END,
      NULL,
      NULL
    FROM sessions__old_lifecycle;

    DROP TABLE sessions__old_lifecycle;

    CREATE INDEX IF NOT EXISTS idx_sessions_last_activity
      ON sessions(last_activity_at_ms DESC, session_id ASC);

    PRAGMA foreign_keys = ON;
  `);
}

function ensureEdgeCheckSupportsCallsReferences(db: Database): void {
  const row = db.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'edges'`).get() as
    | { sql: string }
    | undefined;

  if (row === undefined || row.sql === null) {
    return;
  }

  if (row.sql.includes("'calls'") && row.sql.includes("'references'")) {
    return;
  }

  db.exec(`
    PRAGMA foreign_keys = OFF;

    CREATE TABLE IF NOT EXISTS edges__new (
      id TEXT PRIMARY KEY,
      src_symbol_id TEXT NOT NULL,
      dst_symbol_id TEXT NOT NULL,
      edge_type TEXT NOT NULL CHECK (edge_type IN ('contains', 'imports', 'calls', 'references')),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      FOREIGN KEY (src_symbol_id)
        REFERENCES symbols(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (dst_symbol_id)
        REFERENCES symbols(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

    INSERT INTO edges__new (id, src_symbol_id, dst_symbol_id, edge_type, confidence)
      SELECT id, src_symbol_id, dst_symbol_id, edge_type, confidence FROM edges;

    DROP TABLE edges;

    ALTER TABLE edges__new RENAME TO edges;

    CREATE INDEX IF NOT EXISTS idx_edges_src_symbol_id
      ON edges(src_symbol_id, id);

    CREATE INDEX IF NOT EXISTS idx_edges_dst_symbol_id
      ON edges(dst_symbol_id, id);

    PRAGMA foreign_keys = ON;
  `);
}

function ensureColumnExists(
  db: Database,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): void {
  if (tableHasColumn(db, tableName, columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

function tableHasColumn(
  db: Database,
  tableName: string,
  columnName: string,
): boolean {
  const columns = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}
