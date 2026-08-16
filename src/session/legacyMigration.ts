// Draining a pre-M152 mixed index into its session store.
//
// Every repository indexed before this milestone has observations, manifests and
// deferred references sitting inside `index.sqlite`. Writing new state to
// `session.sqlite` and leaving those rows behind would be the worst outcome
// available: two authorities for the same feature, a `search_memory` that
// silently forgets everything older than the upgrade, and a physical invariant
// that is true only for repositories with no history (§20, §80).
//
// WHERE IT RUNS
// -------------
// At the `index_repo` lifecycle seam and nowhere else (§21, §23 Model A, §167).
// That seam already holds the worktree index lock, already owns the only
// writable index handle in the system, and is already the one operation a user
// invokes knowing the index will change. A product READ never migrates: it is
// exactly the read-path index mutation this milestone exists to abolish, and two
// concurrent reads racing to rewrite the index is the failure §166 names.
//
// Choosing that seam costs nothing in reachability, because removing the session
// DDL from `src/db/schema.ts` moves `schema_version`, which makes every
// pre-M152 index `schema_incompatible`. Such an index must be reindexed before
// it can answer anything at all — so the migration runs on precisely the
// invocation the upgrade already required (§79, §161).
//
// FAILURE MODEL
// -------------
// Copy, then mark, then drop — each step idempotent, in that order.
//
//   crash during copy   -> the session transaction rolls back; the legacy tables
//                          are still authoritative; a retry starts clean.
//   crash after copy    -> rows are in the session store, the marker is not set,
//                          the legacy tables still exist. A retry re-copies with
//                          INSERT OR IGNORE keyed on the real primary keys, so
//                          it adds nothing, then marks and drops (§24, §27, §164).
//   crash after marking -> the session store is authoritative and the legacy
//                          tables are ignored; a retry only drops them (§25).
//
// No step can leave half the links in one file and half in the other with
// ambiguous authority, because the marker — not the presence of either table set
// — is what decides which store answers (§81).

import type { Database } from "bun:sqlite";

import {
  PRODUCT_SESSION_TABLES,
  SESSION_MIGRATION_ORDER,
} from "../db/indexTableFamilies";
import {
  readSessionMeta,
  SessionMetaKey,
  writeSessionMeta,
} from "./sessionSchema";
import type { WritableSessionDatabase } from "./sessionStore";

export interface LegacyFamilyMigrationResult {
  readonly table: string;
  readonly rowsInLegacy: number;
  readonly rowsCopied: number;
  readonly rowsAlreadyPresent: number;
  readonly rowsAfter: number;
}

export const LegacyMigrationOutcome = Object.freeze({
  /** The index never held session tables. Nothing to do. */
  NotLegacy: "not_legacy",
  /** Already drained by an earlier run; only leftover table drops remained. */
  AlreadyMigrated: "already_migrated",
  Migrated: "migrated",
});

export type LegacyMigrationOutcome =
  (typeof LegacyMigrationOutcome)[keyof typeof LegacyMigrationOutcome];

export interface LegacyMigrationResult {
  readonly outcome: LegacyMigrationOutcome;
  readonly families: readonly LegacyFamilyMigrationResult[];
  readonly totalRowsCopied: number;
  readonly legacyTablesDropped: readonly string[];
  readonly durationMs: number;
}

/** Session-owned tables physically present in an index file. */
export function listLegacySessionTables(indexDb: Database): string[] {
  const rows = indexDb.query(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  ).all() as Array<{ name: string }>;
  return rows
    .map((row) => row.name)
    .filter((name) => PRODUCT_SESSION_TABLES.has(name))
    .sort();
}

/** Whether an index still holds product/session rows that have not been drained. */
export function requiresLegacyMigration(
  indexDb: Database,
  sessionDb: WritableSessionDatabase,
  indexDbPath: string,
): boolean {
  if (isMigrationRecorded(sessionDb, indexDbPath)) {
    return false;
  }
  return listLegacySessionTables(indexDb).some((table) => countRows(indexDb, table) > 0);
}

/**
 * Move every product/session row out of `indexDb` into `sessionDb`, then remove
 * the legacy tables from the index.
 *
 * `indexDb` must be a writable index handle held by the index lifecycle. This
 * function is the ONLY thing in the codebase that writes a session table through
 * an index connection's file — and it writes none: it reads them and drops them.
 */
export function migrateLegacySessionState(input: {
  readonly indexDb: Database;
  readonly indexDbPath: string;
  readonly sessionDb: WritableSessionDatabase;
  readonly nowMs?: number;
}): LegacyMigrationResult {
  const startedAtMs = Date.now();
  const legacyTables = listLegacySessionTables(input.indexDb);

  if (legacyTables.length === 0) {
    return {
      outcome: LegacyMigrationOutcome.NotLegacy,
      families: [],
      totalRowsCopied: 0,
      legacyTablesDropped: [],
      durationMs: Date.now() - startedAtMs,
    };
  }

  const alreadyMigrated = isMigrationRecorded(input.sessionDb, input.indexDbPath);
  const families: LegacyFamilyMigrationResult[] = [];

  if (!alreadyMigrated) {
    // Parents before children: `observations` before its link tables,
    // `capsule_manifests` before its items. The session schema's foreign keys
    // are DEFERRABLE, but ordering makes the copy correct without relying on it.
    const ordered = SESSION_MIGRATION_ORDER.filter((table) => legacyTables.includes(table));

    const copy = input.sessionDb.transaction(() => {
      for (const table of ordered) {
        families.push(copyTable(input.indexDb, input.sessionDb, table));
      }
    });
    copy();

    writeSessionMeta(
      input.sessionDb,
      SessionMetaKey.LegacyMigrationCompletedAtMs,
      String(input.nowMs ?? Date.now()),
    );
    writeSessionMeta(
      input.sessionDb,
      SessionMetaKey.LegacyMigrationSourceIndexPath,
      input.indexDbPath,
    );
  }

  // Physically remove them rather than leaving empty compatibility tables: an
  // empty writable session table inside the index is a place a future bug can
  // write to, which is exactly the invariant this milestone is buying (§134).
  // Dropping tables reclaims pages lazily; no VACUUM is forced, because a
  // smaller file was never the acceptance criterion (§132).
  const dropped: string[] = [];
  const drop = input.indexDb.transaction(() => {
    for (const table of [...legacyTables].reverse()) {
      input.indexDb.run(`DROP TABLE IF EXISTS ${table}`);
      dropped.push(table);
    }
  });
  drop();

  return {
    outcome: alreadyMigrated
      ? LegacyMigrationOutcome.AlreadyMigrated
      : LegacyMigrationOutcome.Migrated,
    families,
    totalRowsCopied: families.reduce((total, family) => total + family.rowsCopied, 0),
    legacyTablesDropped: dropped.sort(),
    durationMs: Date.now() - startedAtMs,
  };
}

/**
 * Copy one table across connections.
 *
 * Row-by-row through the application rather than `ATTACH` + `INSERT ... SELECT`:
 * attaching a writable index handle to the session store is precisely the write
 * escape §50 asks to be impossible, and the volumes here are session history,
 * not repository evidence.
 *
 * `INSERT OR IGNORE` against the declared primary key is what makes a retry
 * after partial success add nothing. Row order is never relied upon (§27).
 */
function copyTable(
  indexDb: Database,
  sessionDb: WritableSessionDatabase,
  table: string,
): LegacyFamilyMigrationResult {
  const columns = (indexDb.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
  const sessionColumns = new Set(
    (sessionDb.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  // A legacy index may predate a column the session schema now declares, or
  // carry one it has since dropped. Copy the intersection; a column the session
  // schema requires and the legacy row cannot supply keeps its default.
  const shared = columns.filter((column) => sessionColumns.has(column));
  const rowsBefore = countRows(sessionDb, table);
  const rows = indexDb.query(
    `SELECT ${shared.map(quoteIdent).join(", ")} FROM ${table}`,
  ).all() as Array<Record<string, unknown>>;

  const insert = sessionDb.prepare(
    `INSERT OR IGNORE INTO ${table} (${shared.map(quoteIdent).join(", ")})
     VALUES (${shared.map(() => "?").join(", ")})`,
  );
  for (const row of rows) {
    insert.run(...shared.map((column) => row[column] as never));
  }
  const rowsAfter = countRows(sessionDb, table);

  return {
    table,
    rowsInLegacy: rows.length,
    rowsCopied: rowsAfter - rowsBefore,
    rowsAlreadyPresent: rows.length - (rowsAfter - rowsBefore),
    rowsAfter,
  };
}

function isMigrationRecorded(sessionDb: WritableSessionDatabase, indexDbPath: string): boolean {
  const completedAt = readSessionMeta(sessionDb, SessionMetaKey.LegacyMigrationCompletedAtMs);
  if (completedAt === undefined) {
    return false;
  }
  const source = readSessionMeta(sessionDb, SessionMetaKey.LegacyMigrationSourceIndexPath);
  // A marker left by a DIFFERENT index must not suppress this one's migration:
  // "some legacy state was drained once" is not "this index was drained" (§81).
  return source === undefined || source === indexDbPath;
}

function countRows(db: Database, table: string): number {
  try {
    const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  } catch {
    return 0;
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
