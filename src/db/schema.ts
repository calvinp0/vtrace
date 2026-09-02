// The repository-derived half of vtrace's persistence: what `index_repo` writes
// from source, and nothing else.
//
// Before M152 this file also declared observations, sessions, capsule manifests,
// deferred VEXP references and project rules. They are gone — not suppressed, but
// moved to `src/session/sessionSchema.ts` and `session.sqlite`. What is left is
// derived from the repository, so `index.sqlite` may now be hashed as a whole and
// the answer means one thing (§7, §57).
//
// Removing them moves `schema_version`, because this file's content is hashed
// into it. That is deliberate and is the one index-layout change M152 makes: an
// index written before the split is `schema_incompatible` and must be reindexed,
// which is also the lifecycle step that drains its session rows into the new
// store (§82, §107, §174).

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

    -- M156 per-file indexing failures. One row per eligible file whose content
    -- could not be turned into semantic evidence, so the index can say "this
    -- file exists and we failed on it" instead of behaving as though it were
    -- absent (§15).
    --
    -- Deliberately NOT a row in "files", and deliberately no foreign key to it.
    -- "files" is the authority M148 reads for path membership through its UNIQUE
    -- covering index, and a failed file listed there would claim we index a path
    -- we hold no evidence for. It is also what symbols.file_id joins against, so
    -- a failed file with a "files" row would be indistinguishable from a file
    -- that genuinely defines nothing.
    --
    -- failure_class is bounded by FileFailureClass; message is truncated at
    -- write time (see §79) so this table cannot grow with source contents.
    CREATE TABLE IF NOT EXISTS file_index_failures (
      path TEXT PRIMARY KEY,
      language TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('read_failed', 'parse_failed')),
      failure_class TEXT NOT NULL,
      message TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_file_index_failures_class
      ON file_index_failures(failure_class, path);

    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('yaml', 'toml')),
      content_hash TEXT NOT NULL,
      document_index_version INTEGER NOT NULL CHECK (document_index_version >= 1),
      start_line INTEGER NOT NULL CHECK (start_line >= 1),
      end_line INTEGER NOT NULL CHECK (end_line >= start_line),
      key_path TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX IF NOT EXISTS idx_document_chunks_file_line
      ON document_chunks(file_id, start_line, end_line, id);

    CREATE VIRTUAL TABLE IF NOT EXISTS document_search_fts USING fts5(
      chunk_id UNINDEXED,
      file_id UNINDEXED,
      file_path_raw UNINDEXED,
      kind,
      key_path,
      text,
      file_path,
      tokenize = 'unicode61'
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

    /*
     * The self-referencing parent FK, indexed on its REFERENCING side.
     *
     * SQLite enforces a foreign key by looking for rows that still point at the
     * one being deleted, and without an index on the referencing column that
     * lookup is a full table scan PER DELETED ROW. Deleting the 10,309 symbols
     * of the ARC corpus therefore cost ~106 million row visits: measured at
     * 19,522 ms, against 105 ms with this index and 12 ms to build it.
     *
     * That single statement was 18 of the 26 seconds an incremental refresh
     * spent on a ONE-file change, because invalidation drops the whole graph
     * before rewriting it. The hazard generalises: any table referencing
     * symbols.id that is not already empty when symbols are deleted will pay
     * the same scan.
     */
    CREATE INDEX IF NOT EXISTS idx_symbols_parent_symbol_id
      ON symbols(parent_symbol_id);

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

    -- Parser-observed occurrences of an edge. Purely additive: an index written
    -- before M131 simply has no rows here, and consumers report provenance as
    -- unavailable rather than inventing it. The primary key is also the lookup
    -- index, so no separate index is needed.
    CREATE TABLE IF NOT EXISTS edge_call_sites (
      edge_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      start_line INTEGER NOT NULL CHECK (start_line >= 1),
      start_column INTEGER NOT NULL CHECK (start_column >= 0),
      end_line INTEGER NOT NULL CHECK (end_line >= start_line),
      end_column INTEGER NOT NULL CHECK (end_column >= 0),
      precision TEXT NOT NULL CHECK (precision IN ('span', 'line')),
      PRIMARY KEY (edge_id, ordinal),
      FOREIGN KEY (edge_id)
        REFERENCES edges(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

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

    CREATE VIRTUAL TABLE IF NOT EXISTS symbol_body_literals_fts USING fts5(
      symbol_id UNINDEXED,
      file_path_raw UNINDEXED,
      literals,
      tokenize = 'unicode61'
    );

    -- M150 decision-bearing mechanism facts: what a definition's body DOES
    -- (takes the first item, establishes an order, falls back, consults a cache)
    -- as opposed to what it is NAMED. Purely additive, exactly like
    -- edge_call_sites: an index written before M150 simply has no rows here, and
    -- readiness reports behavioral_mechanism_evidence as a missing CAPABILITY
    -- rather than calling the whole schema incompatible.
    --
    -- Location is a line OFFSET within the owning definition, never an absolute
    -- line: an edit anywhere above the symbol moves every absolute line in the
    -- file and would churn every fact in it. The primary key doubles as the
    -- per-symbol lookup index.
    CREATE TABLE IF NOT EXISTS symbol_mechanism_facts (
      symbol_id TEXT NOT NULL,
      file_path_raw TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      line_offset INTEGER NOT NULL CHECK (line_offset >= 0),
      evidence TEXT NOT NULL,
      provenance TEXT NOT NULL DEFAULT '',
      result_bearing INTEGER NOT NULL CHECK (result_bearing IN (0, 1)),
      PRIMARY KEY (symbol_id, ordinal),
      FOREIGN KEY (symbol_id)
        REFERENCES symbols(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX IF NOT EXISTS idx_symbol_mechanism_facts_kind
      ON symbol_mechanism_facts(kind, symbol_id);

    CREATE INDEX IF NOT EXISTS idx_symbol_mechanism_facts_path
      ON symbol_mechanism_facts(file_path_raw);
  `);

  ensureColumnExists(db, "symbols", "decorators", "TEXT");
  ensureColumnExists(db, "symbol_mechanism_facts", "provenance", "TEXT NOT NULL DEFAULT ''");
  ensureEdgeCheckSupportsCallsReferences(db);
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
