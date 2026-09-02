/**
 * M199 — row-level write accounting for an index refresh. PURE except for the
 * temporary triggers it installs on the database handle it is given.
 *
 * The question M199 has to answer is not "is the refresh fast" but "does the
 * refresh write a bounded number of rows". Wall time cannot answer it: a faster
 * full rewrite is still a full rewrite. Row counts can, provided they are
 * collected by something the implementation under test cannot influence.
 *
 * So the counters are SQLite triggers, not product code. A trigger fires on the
 * row, after the statement that wrote it, including rows written by ON DELETE
 * CASCADE — which is exactly the amplification path that matters here, because
 * `symbols` cascades into `edges`, `symbol_mechanism_facts` and
 * `document_chunks`. An implementation that deletes ten thousand symbols cannot
 * report that it deleted twenty.
 *
 * Two things this deliberately does NOT count, and the report says so rather
 * than quietly folding them in:
 *
 *   - FTS5 virtual tables (`symbol_search_fts`, `symbol_body_literals_fts`,
 *     `document_search_fts`) take no triggers. Their churn is reported through
 *     a separate live-row delta, which is a weaker measurement, and the report
 *     labels it as such.
 *   - The trigger overhead perturbs timing. Accounting therefore runs in its own
 *     pass, never in the pass a latency number is taken from.
 */
import type { Database } from "bun:sqlite";

/** Ordinary tables the refresh writes. Virtual (FTS) tables cannot be triggered. */
export const ACCOUNTED_TABLES = [
  "files",
  "symbols",
  "edges",
  "edge_call_sites",
  "symbol_mechanism_facts",
  "document_chunks",
  "file_index_failures",
  "index_runs",
  "file_run_states",
  "symbol_run_states",
] as const;

/** FTS tables, measured by live-row delta because they cannot carry triggers. */
export const FTS_TABLES = [
  "symbol_search_fts",
  "symbol_body_literals_fts",
  "document_search_fts",
] as const;

export type AccountedTable = (typeof ACCOUNTED_TABLES)[number];

export interface TableWrites {
  readonly inserted: number;
  readonly deleted: number;
  readonly updated: number;
}

export interface RefreshWriteAccounting {
  /** Per-table row writes observed by trigger, including cascade-driven rows. */
  readonly byTable: Readonly<Record<string, TableWrites>>;
  /** Sum over the semantic graph tables: files, symbols, edges, call sites, facts, chunks. */
  readonly semanticRowsWritten: number;
  /** Sum over run-history bookkeeping: index_runs, file_run_states, symbol_run_states. */
  readonly bookkeepingRowsWritten: number;
  /** Live-row delta for each FTS table (weaker than a trigger; churn is invisible). */
  readonly ftsLiveRowDelta: Readonly<Record<string, number>>;
  /** Live row counts after the refresh, per accounted and FTS table. */
  readonly liveRowsAfter: Readonly<Record<string, number>>;
  /** `total_changes()` delta, inflated by the counter writes themselves; context only. */
  readonly totalChangesDelta: number;
}

const SEMANTIC_TABLES = new Set<string>([
  "files", "symbols", "edges", "edge_call_sites", "symbol_mechanism_facts", "document_chunks",
  "file_index_failures",
]);

const COUNTER_TABLE = "_m199_row_writes";

/**
 * Install the counters. Idempotent, and safe to call on a handle that already
 * carries them: the counter table is reset rather than recreated, so a caller
 * measuring several refreshes on one handle gets one refresh per reading.
 */
export function installWriteCounters(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS ${COUNTER_TABLE} (
    table_name TEXT NOT NULL, op TEXT NOT NULL, n INTEGER NOT NULL,
    PRIMARY KEY (table_name, op))`);
  for (const table of ACCOUNTED_TABLES) {
    for (const [op, timing, alias] of [
      ["insert", "INSERT", "NEW"], ["delete", "DELETE", "OLD"], ["update", "UPDATE", "NEW"],
    ] as const) {
      void alias;
      db.run(`CREATE TRIGGER IF NOT EXISTS _m199_${table}_${op}
        AFTER ${timing} ON ${table} BEGIN
          INSERT INTO ${COUNTER_TABLE} (table_name, op, n) VALUES ('${table}', '${op}', 1)
            ON CONFLICT(table_name, op) DO UPDATE SET n = n + 1;
        END`);
    }
  }
}

export function removeWriteCounters(db: Database): void {
  for (const table of ACCOUNTED_TABLES) {
    for (const op of ["insert", "delete", "update"]) {
      db.run(`DROP TRIGGER IF EXISTS _m199_${table}_${op}`);
    }
  }
  db.run(`DROP TABLE IF EXISTS ${COUNTER_TABLE}`);
}

function liveRows(db: Database, tables: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of tables) {
    try {
      out[table] = (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    } catch { out[table] = -1; }
  }
  return out;
}

const totalChanges = (db: Database) =>
  (db.query("SELECT total_changes() AS c").get() as { c: number }).c;

/**
 * Run `body` with the counters zeroed and report what it wrote.
 *
 * The counters must be installed already: installing them inside would make the
 * first measured refresh pay for schema changes the later ones do not.
 */
export async function accountRefresh<T>(
  db: Database, body: () => Promise<T>,
): Promise<{ readonly value: T; readonly accounting: RefreshWriteAccounting }> {
  db.run(`DELETE FROM ${COUNTER_TABLE}`);
  const ftsBefore = liveRows(db, FTS_TABLES);
  const changesBefore = totalChanges(db);

  const value = await body();

  const rows = db.query(`SELECT table_name, op, n FROM ${COUNTER_TABLE}`)
    .all() as { table_name: string; op: string; n: number }[];
  const byTable: Record<string, TableWrites> = {};
  for (const table of ACCOUNTED_TABLES) byTable[table] = { inserted: 0, deleted: 0, updated: 0 };
  for (const row of rows) {
    const current = byTable[row.table_name] ?? { inserted: 0, deleted: 0, updated: 0 };
    byTable[row.table_name] = {
      inserted: current.inserted + (row.op === "insert" ? row.n : 0),
      deleted: current.deleted + (row.op === "delete" ? row.n : 0),
      updated: current.updated + (row.op === "update" ? row.n : 0),
    };
  }

  const sum = (t: TableWrites) => t.inserted + t.deleted + t.updated;
  let semanticRowsWritten = 0;
  let bookkeepingRowsWritten = 0;
  for (const [table, writes] of Object.entries(byTable)) {
    if (SEMANTIC_TABLES.has(table)) semanticRowsWritten += sum(writes);
    else bookkeepingRowsWritten += sum(writes);
  }

  const ftsAfter = liveRows(db, FTS_TABLES);
  const ftsLiveRowDelta: Record<string, number> = {};
  for (const table of FTS_TABLES) ftsLiveRowDelta[table] = (ftsAfter[table] ?? 0) - (ftsBefore[table] ?? 0);

  return {
    value,
    accounting: {
      byTable, semanticRowsWritten, bookkeepingRowsWritten, ftsLiveRowDelta,
      liveRowsAfter: { ...liveRows(db, ACCOUNTED_TABLES), ...ftsAfter },
      totalChangesDelta: totalChanges(db) - changesBefore,
    },
  };
}

/**
 * The semantic rows the given files OWN, counted against the graph as it stands
 * before a refresh touches them.
 *
 * Ownership here is the schema's own: a file owns its `files` row, its symbols
 * and its document chunks; a symbol owns its mechanism facts; and an edge is
 * owned by BOTH endpoints, because a refresh of either end has to rewrite it.
 * Counting an inbound cross-file edge as affected is what makes the denominator
 * honest — excluding it would let an implementation that rewrites every inbound
 * edge in the repository still look bounded.
 *
 * FTS rows are excluded on both sides of the ratio, because they cannot be
 * counted by trigger and mixing a triggered numerator with an untriggered
 * denominator would produce a number that means nothing.
 */
export function affectedSemanticRows(
  db: Database, paths: readonly string[],
): { readonly total: number; readonly byTable: Readonly<Record<string, number>> } {
  if (paths.length === 0) return { total: 0, byTable: {} };
  const placeholders = paths.map(() => "?").join(",");
  const fileIds = `SELECT id FROM files WHERE path IN (${placeholders})`;
  const symbolIds = `SELECT id FROM symbols WHERE file_id IN (${fileIds})`;
  const count = (sql: string, params: readonly string[]) =>
    (db.query(sql).get(...(params as string[])) as { c: number }).c;

  const byTable: Record<string, number> = {
    files: count(`SELECT COUNT(*) AS c FROM files WHERE path IN (${placeholders})`, paths),
    symbols: count(`SELECT COUNT(*) AS c FROM symbols WHERE file_id IN (${fileIds})`, paths),
    edges: count(`SELECT COUNT(*) AS c FROM edges
      WHERE src_symbol_id IN (${symbolIds}) OR dst_symbol_id IN (${symbolIds})`, [...paths, ...paths]),
    edge_call_sites: count(`SELECT COUNT(*) AS c FROM edge_call_sites WHERE edge_id IN (
      SELECT id FROM edges WHERE src_symbol_id IN (${symbolIds}) OR dst_symbol_id IN (${symbolIds}))`,
      [...paths, ...paths]),
    symbol_mechanism_facts: count(
      `SELECT COUNT(*) AS c FROM symbol_mechanism_facts WHERE symbol_id IN (${symbolIds})`, paths),
    document_chunks: count(
      `SELECT COUNT(*) AS c FROM document_chunks WHERE file_id IN (${fileIds})`, paths),
  };
  return { total: Object.values(byTable).reduce((a, b) => a + b, 0), byTable };
}

/**
 * F1's boundedness rule, stated once so both the gate and the report read it
 * from the same place.
 *
 * The bound is an AMPLIFICATION — rows written divided by rows the changed files
 * own — and not a fraction of the repository, because a fraction cannot separate
 * the two things that matter. A refresh of a large file legitimately writes a
 * large fraction of a small graph; a refresh of a small file must never write a
 * large fraction of any graph. Only the ratio against the affected closure says
 * that, and it is the ratio §7 asks for.
 *
 * The ceiling is DERIVED, not fitted. A correct rewrite of an affected row costs
 * exactly two writes: one delete and one insert. Anything above 2.0 is work the
 * architecture does not require and has to be explained. The gate is set at 3.0
 * to leave one row of headroom per affected row for edges whose endpoints move
 * between files and are therefore written from both sides — and no more, so an
 * implementation that reverts to rewriting the graph (measured at ~1000x on
 * C-LARGE, F8) fails it by three orders of magnitude rather than narrowly.
 */
export const BOUNDED_WRITE_AMPLIFICATION = 3.0;

export function semanticWritesAreBounded(
  semanticRowsWritten: number, affectedSemanticRowsBefore: number,
): { readonly bounded: boolean; readonly amplification: number | null; readonly bound: number } {
  if (affectedSemanticRowsBefore === 0) {
    // Nothing was affected, so nothing may be written. A refresh that writes
    // rows against an empty affected set is unbounded by definition.
    return { bounded: semanticRowsWritten === 0, amplification: null, bound: BOUNDED_WRITE_AMPLIFICATION };
  }
  const amplification = semanticRowsWritten / affectedSemanticRowsBefore;
  return {
    bounded: amplification <= BOUNDED_WRITE_AMPLIFICATION,
    amplification: +amplification.toFixed(3),
    bound: BOUNDED_WRITE_AMPLIFICATION,
  };
}
