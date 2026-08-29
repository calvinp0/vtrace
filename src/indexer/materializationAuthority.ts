import type { Database } from "bun:sqlite";

import type { IndexedFileSnapshotSet } from "./incrementalIndex";

/**
 * M184.
 *
 * Cached source-state equivalence does not prove materialized index
 * availability. Those are two different authorities:
 *
 * - the durable registry under `<gitCommonDir>/vtrace/repositories/<id>` and the
 *   workspace manifest at `.vtrace/index.meta.json` prove what repository
 *   content was observed and whether prior derivation work is reusable;
 * - the workspace database at `.vtrace/index.sqlite` is the only thing that
 *   proves the graph a query will actually read exists.
 *
 * Before M184 the planner conflated them. `planIncrementalRefresh` compares a
 * snapshot's per-file content hashes against the current scan; when nothing
 * changed it returns `noop`, and `indexProject` returned early without ever
 * entering the persist transaction. Nothing in that chain asked whether the
 * database still held the graph the snapshot describes. Deleting `.vtrace`
 * therefore produced a no-op against a database `openIndexerDatabase` had just
 * re-created empty: exit 0, a manifest whose every file said
 * `indexOutcome: "indexed"`, and an index containing nothing.
 *
 * This module supplies the missing predicate. A no-op is eligible only when the
 * materialized graph actually backs the snapshot being declared current.
 */

/** Why a materialized graph cannot be treated as authoritative for a snapshot. */
export type MaterializationDefect =
  /** The caller already knows this database holds no graph (fresh `vtrace init`). */
  | "graph_declared_absent"
  /** `files` could not be read: absent, truncated, or a foreign schema. */
  | "graph_unreadable"
  /** The snapshot claims files as indexed that have no row in the graph. */
  | "graph_missing_indexed_files"
  /** A file is present but materialized from different content than the snapshot records. */
  | "graph_content_mismatch";

export type MaterializationVerdict =
  | { readonly usable: true }
  | {
      readonly usable: false;
      readonly defect: MaterializationDefect;
      /** Bounded evidence for diagnostics; never the whole file set. */
      readonly examplePath?: string;
      readonly expectedIndexedFiles: number;
      readonly materializedFiles: number;
    };

interface MaterializedFileRow {
  readonly path: string;
  readonly contentHash: string;
}

/**
 * Does the graph in `db` materialize the files `snapshot` claims are indexed?
 *
 * The predicate is deliberately structural. It compares the snapshot's indexed
 * set against the `files` table by path and content hash, and asks nothing about
 * how much the repository contains: a repository with no supported definitions
 * — or no supported files at all — has an empty indexed set, matches an empty
 * graph, and is legitimately usable. `symbolCount > 0` would have called that
 * valid index broken, which is why it is not the test (M184 §48, §50).
 *
 * Both surfaces derive from the same `FileRecord` produced by `scanRepo` on the
 * run that wrote them, so a hash disagreement means the graph was materialized
 * from a different repository state than the snapshot records — the graph is
 * attached to the wrong source state and must not certify a no-op (§23).
 */
export function evaluateMaterializedGraph(
  db: Database,
  snapshot: IndexedFileSnapshotSet | undefined,
  hasExistingGraph?: boolean,
): MaterializationVerdict {
  const expected = new Map<string, string>();
  for (const file of snapshot?.files ?? []) {
    if (file.indexOutcome === "indexed") expected.set(file.relativePath, file.contentHash);
  }

  if (hasExistingGraph === false) {
    return {
      usable: false,
      defect: "graph_declared_absent",
      expectedIndexedFiles: expected.size,
      materializedFiles: 0,
    };
  }

  let rows: readonly MaterializedFileRow[];
  try {
    rows = db
      .query("SELECT path AS path, content_hash AS contentHash FROM files")
      .all() as readonly MaterializedFileRow[];
  } catch {
    return {
      usable: false,
      defect: "graph_unreadable",
      expectedIndexedFiles: expected.size,
      materializedFiles: 0,
    };
  }

  const materialized = new Map(rows.map((row) => [row.path, row.contentHash]));
  for (const [relativePath, contentHash] of expected) {
    const actual = materialized.get(relativePath);
    if (actual === undefined) {
      return {
        usable: false,
        defect: "graph_missing_indexed_files",
        examplePath: relativePath,
        expectedIndexedFiles: expected.size,
        materializedFiles: materialized.size,
      };
    }
    if (actual !== contentHash) {
      return {
        usable: false,
        defect: "graph_content_mismatch",
        examplePath: relativePath,
        expectedIndexedFiles: expected.size,
        materializedFiles: materialized.size,
      };
    }
  }

  return { usable: true };
}
