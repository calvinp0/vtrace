import type { Database } from "bun:sqlite";

import type { FileFailureClass } from "../../indexer/fileFailureClassification";

/**
 * M156: the per-file failures recorded by the last successful index run.
 *
 * Written only inside `indexProject`'s single graph transaction, alongside the
 * symbols and edges of the files that DID succeed, so the failed set and the
 * successful set can never disagree about which run produced them.
 */
export interface FileIndexFailureRecord {
  readonly path: string;
  readonly language: string;
  readonly status: "read_failed" | "parse_failed";
  readonly failureClass: FileFailureClass;
  readonly message: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
}

interface FileIndexFailureRow {
  readonly path: string;
  readonly language: string;
  readonly status: "read_failed" | "parse_failed";
  readonly failure_class: FileFailureClass;
  readonly message: string;
  readonly content_hash: string;
  readonly size_bytes: number;
}

/**
 * Replace the failed-file set wholesale.
 *
 * Wholesale rather than incremental on purpose: the graph transaction already
 * rebuilds `files`/`symbols`/`edges` from every parse result it holds, so the
 * failure table must be rebuilt from the same authority in the same transaction.
 * Anything else would let a file that has since been REPAIRED keep a stale
 * failure row (§37).
 */
export function replaceFileIndexFailures(
  db: Database,
  failures: readonly FileIndexFailureRecord[],
): void {
  db.run("DELETE FROM file_index_failures");
  if (failures.length === 0) return;

  const insert = db.prepare(`
    INSERT INTO file_index_failures (path, language, status, failure_class, message, content_hash, size_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  // Deterministic write order (§71): the same repository at the same revision
  // must produce the same rows in the same order on every machine.
  for (const failure of [...failures].sort((a, b) => a.path.localeCompare(b.path))) {
    insert.run(
      failure.path,
      failure.language,
      failure.status,
      failure.failureClass,
      failure.message,
      failure.contentHash,
      failure.sizeBytes,
    );
  }
}

/** Every failure, ordered by path. Callers that report must bound the result. */
export function listFileIndexFailures(db: Database): FileIndexFailureRecord[] {
  return (db.query(
    "SELECT path, language, status, failure_class, message, content_hash, size_bytes "
    + "FROM file_index_failures ORDER BY path",
  ).all() as FileIndexFailureRow[]).map(fromRow);
}

/** Exact count. Never sampled — it is the denominator every coverage claim uses. */
export function countFileIndexFailures(db: Database): number {
  try {
    return (db.query("SELECT COUNT(*) AS count FROM file_index_failures").get() as { count: number }).count;
  } catch {
    // An index written before M156 has no such table. Absent evidence of
    // failures is not evidence of none, but such an index is `schema_incompatible`
    // under the derivation fingerprint and will be rebuilt before it is served.
    return 0;
  }
}

/** Bounded read for product responses (§20, §68). */
export function listFileIndexFailuresBounded(
  db: Database,
  limit: number,
): { readonly failures: FileIndexFailureRecord[]; readonly total: number } {
  const total = countFileIndexFailures(db);
  if (limit <= 0) return { failures: [], total };
  const rows = db.query(
    "SELECT path, language, status, failure_class, message, content_hash, size_bytes "
    + "FROM file_index_failures ORDER BY path LIMIT ?",
  ).all(limit) as FileIndexFailureRow[];
  return { failures: rows.map(fromRow), total };
}

/**
 * Whether a specific path failed semantic indexing.
 *
 * This is what makes a path-scoped question about a failed file answerable
 * (§23): without it, `foo.py` that failed to parse and `foo.py` that does not
 * exist are the same empty answer.
 */
export function findFileIndexFailure(
  db: Database,
  filePath: string,
): FileIndexFailureRecord | undefined {
  try {
    const row = db.query(
      "SELECT path, language, status, failure_class, message, content_hash, size_bytes "
      + "FROM file_index_failures WHERE path = ?",
    ).get(filePath) as FileIndexFailureRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  } catch {
    return undefined;
  }
}

/** Distinct languages among failed files. Used to decide relevance (§24). */
export function listFailedFileLanguages(db: Database): string[] {
  try {
    return (db.query(
      "SELECT DISTINCT language FROM file_index_failures ORDER BY language",
    ).all() as Array<{ language: string }>).map((row) => row.language);
  } catch {
    return [];
  }
}

function fromRow(row: FileIndexFailureRow): FileIndexFailureRecord {
  return {
    path: row.path,
    language: row.language,
    status: row.status,
    failureClass: row.failure_class,
    message: row.message,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
  };
}
