/**
 * M147: the symbol-name access path, and the additive migration that installs it
 * into an index that already exists.
 *
 * WHY THIS IS NOT A SCHEMA CHANGE
 * -------------------------------
 * `SELECT 1 FROM symbols WHERE local_name = ? OR fq_name = ? LIMIT 1` is how
 * workspace routing asks whether a repository defines a name. Without a name
 * index SQLite answers it with `SCAN symbols`, so proving a name is ABSENT costs
 * a full pass over the symbol table — measured at 1.1 ms for ARC and 5.0 ms for
 * TCKDB, and degrading superlinearly once a workspace holds more indexes than
 * fit in page cache: 100 ARC-sized ready members cost 11.9 s under the router's
 * own access pattern, against 66 ms with the access path present.
 *
 * That is why M146 had to bound the probe at 8 members, and bounding it is what
 * made global uniqueness unprovable. The access path is the difference between a
 * negative that costs a table scan and one that costs a b-tree miss.
 *
 * It adds no rows, no columns and no derived content. `files`, `symbols`,
 * `edges`, the FTS contents and the graph are byte-for-byte what they were; only
 * SQLite's choice of plan changes. So it must NOT invalidate an index:
 *
 *   THE SAME DERIVED CONTENT, WITH A NEW PHYSICAL ACCESS CAPABILITY.
 *
 * Which is exactly why this module lives outside `src/indexer` and `src/db`.
 * Those directories are content-hashed into the derivation fingerprints, and
 * putting `CREATE INDEX` in `src/db/schema.ts` would move `schema_version`,
 * refuse every stored index as `schema_incompatible`, and force a full reparse
 * of every repository to gain an access path that changes nothing it would
 * regenerate. The anti-drift closure guard permits this placement precisely
 * because its behavioural control can prove the claim: mutate this file, rebuild,
 * and the persisted rows are identical.
 *
 * VERSIONING
 * ----------
 * The installed version is not recorded in a counter. It is read from the
 * database catalogue, because the catalogue IS the fact — a stored version
 * column could disagree with what the database actually has (someone drops an
 * index; the counter still claims v1), and this milestone is about not claiming
 * things that were never checked. A future version declares different index
 * names and is detected the same way.
 */
import type { Database } from "bun:sqlite";

/** Bumped when this module declares a different set of access paths. */
export const SYMBOL_NAME_ACCESS_PATH_VERSION = 1 as const;

/**
 * Both indexes are required together. The membership query is an `OR` across
 * two columns, and SQLite's MULTI-INDEX OR plan needs an access path for each
 * side; with only one it falls back to scanning. Half an access path is not an
 * access path, which is why `installed` is all-or-nothing.
 */
export const SYMBOL_NAME_ACCESS_PATH_INDEXES = Object.freeze([
  "idx_symbols_local_name",
  "idx_symbols_fq_name",
]);

const ACCESS_PATH_DDL: Readonly<Record<string, string>> = Object.freeze({
  idx_symbols_local_name: "CREATE INDEX IF NOT EXISTS idx_symbols_local_name ON symbols(local_name)",
  idx_symbols_fq_name: "CREATE INDEX IF NOT EXISTS idx_symbols_fq_name ON symbols(fq_name)",
});

export interface SymbolNameAccessPathState {
  readonly version: number;
  readonly installed: boolean;
  readonly present: readonly string[];
  readonly missing: readonly string[];
}

/** Read what the database HAS, from its own catalogue. Never from configuration. */
export function inspectSymbolNameAccessPath(db: Database): SymbolNameAccessPathState {
  const existing = new Set(
    (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'symbols'")
      .all() as Array<{ name: string }>).map((row) => row.name),
  );
  const present = SYMBOL_NAME_ACCESS_PATH_INDEXES.filter((name) => existing.has(name));
  const missing = SYMBOL_NAME_ACCESS_PATH_INDEXES.filter((name) => !existing.has(name));
  return {
    version: SYMBOL_NAME_ACCESS_PATH_VERSION,
    installed: missing.length === 0,
    present,
    missing,
  };
}

export interface SymbolNameAccessPathMigration {
  readonly version: number;
  /** True when this call created something. False when it was already installed. */
  readonly applied: boolean;
  readonly created: readonly string[];
  readonly alreadyPresent: readonly string[];
  readonly installed: boolean;
  readonly durationMs: number;
}

/**
 * Install the access path into an existing index, additively.
 *
 * Explicit: nothing calls this during a query. A router that mutated an index
 * to make its own next question cheaper would be writing during read-only
 * routing and would make cost depend on who asked first.
 *
 * Atomic: both statements run in one transaction, so a failure part-way leaves
 * the database in the state it started in rather than with half an access path
 * that reports `fallback` forever.
 *
 * Idempotent: running it on an installed index creates nothing and reports so.
 *
 * Requires a WRITABLE handle. Content is untouched — no row is inserted,
 * updated or deleted — so this is safe to run against a `ready` index without
 * reindexing anything.
 */
export function applySymbolNameAccessPath(db: Database): SymbolNameAccessPathMigration {
  const started = performance.now();
  const before = inspectSymbolNameAccessPath(db);
  if (before.installed) {
    return {
      version: SYMBOL_NAME_ACCESS_PATH_VERSION,
      applied: false,
      created: [],
      alreadyPresent: before.present,
      installed: true,
      durationMs: +(performance.now() - started).toFixed(3),
    };
  }

  db.transaction(() => {
    for (const name of before.missing) db.run(ACCESS_PATH_DDL[name]!);
  })();

  const after = inspectSymbolNameAccessPath(db);
  return {
    version: SYMBOL_NAME_ACCESS_PATH_VERSION,
    applied: after.present.length > before.present.length,
    created: before.missing,
    alreadyPresent: before.present,
    installed: after.installed,
    durationMs: +(performance.now() - started).toFixed(3),
  };
}
