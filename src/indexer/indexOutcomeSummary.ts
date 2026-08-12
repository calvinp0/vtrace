import type { IndexPerformanceDiagnostics } from "./incrementalIndex";
import type { IndexedFileStatus, IndexedFileSummary, IndexProjectResult } from "./types";

/**
 * M141 Workstream B.
 *
 * A successful `index_repo` used to return one entry per file — roughly 290 of
 * them on a normal repository, almost all saying nothing but `indexed`. That is
 * response bloat, not information: the caller needs counts, failures, and what
 * changed, and it needs them at a size that does not grow with the repository.
 *
 * This module is PURE presentation. It reads the indexing result and produces a
 * bounded view of it; it never touches the index, the manifest, or the counts
 * that indexing itself recorded.
 */

/** How many detailed outcomes a normal (non-debug) response may carry. */
export const DEFAULT_OUTCOME_DETAIL_LIMIT = 20 as const;
/** Debug mode is bounded too — "unbounded" is how the 290-entry response happened. */
export const DEBUG_OUTCOME_DETAIL_LIMIT = 500 as const;

export type IndexOutcomeDetailMode = "summary" | "debug";

const SKIP_STATUSES: readonly IndexedFileStatus[] = [
  "unregistered_language",
  "unsupported_language",
] as const;
const FAILURE_STATUSES: readonly IndexedFileStatus[] = [
  "read_failed",
  "parse_failed",
  "persistence_failed",
] as const;

export interface IndexOutcomeCounts {
  readonly filesTotal: number;
  readonly indexed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly warnings: number;
  /** Exact per-status counts. Never sampled, never bounded. */
  readonly byStatus: Readonly<Record<IndexedFileStatus, number>>;
}

export interface IndexOutcomeChangeCounts {
  readonly added: number;
  readonly modified: number;
  readonly removed: number;
  readonly renamed: number;
  readonly unchanged: number;
}

export interface IndexOutcomeDetail {
  readonly mode: IndexOutcomeDetailMode;
  readonly limit: number;
  readonly delivered: number;
  readonly omitted: number;
  /** Failures first, then warnings. Ordinary successes are never included. */
  readonly outcomes: readonly IndexedFileSummary[];
  readonly omittedByStatus: Readonly<Partial<Record<IndexedFileStatus, number>>>;
  readonly note: string;
}

export interface BoundedIndexOutcomes {
  readonly counts: IndexOutcomeCounts;
  readonly changes: IndexOutcomeChangeCounts | null;
  readonly skipReasons: Readonly<Partial<Record<IndexedFileStatus, number>>>;
  readonly detail: IndexOutcomeDetail;
}

export function summarizeIndexOutcomes(
  result: Pick<IndexProjectResult, "files"> & { readonly performance?: IndexPerformanceDiagnostics | null },
  options: { readonly mode?: IndexOutcomeDetailMode; readonly limit?: number } = {},
): BoundedIndexOutcomes {
  const files = result.files;
  const mode = options.mode ?? "summary";
  const limit = Math.max(
    0,
    options.limit ?? (mode === "debug" ? DEBUG_OUTCOME_DETAIL_LIMIT : DEFAULT_OUTCOME_DETAIL_LIMIT),
  );

  const byStatus = emptyStatusCounts();
  let warnings = 0;
  for (const file of files) {
    byStatus[file.status] += 1;
    if (file.status === "indexed" && file.diagnostics.length > 0) warnings += 1;
  }

  const failed = FAILURE_STATUSES.reduce((total, status) => total + byStatus[status], 0);
  const skipped = SKIP_STATUSES.reduce((total, status) => total + byStatus[status], 0);
  const counts: IndexOutcomeCounts = {
    filesTotal: files.length,
    indexed: byStatus.indexed,
    skipped,
    failed,
    warnings,
    byStatus,
  };

  // Failures are never dropped in favour of warnings, and both are never
  // dropped in favour of ordinary successes.
  const failures = files.filter((file) => FAILURE_STATUSES.includes(file.status));
  const warned = files.filter((file) => file.status === "indexed" && file.diagnostics.length > 0);
  const skippedInteresting = files.filter((file) => SKIP_STATUSES.includes(file.status));
  const ranked = [...failures, ...warned, ...skippedInteresting];
  const outcomes = ranked.slice(0, limit);
  const omittedByStatus: Partial<Record<IndexedFileStatus, number>> = {};
  for (const file of ranked.slice(limit)) {
    omittedByStatus[file.status] = (omittedByStatus[file.status] ?? 0) + 1;
  }

  const performance = result.performance ?? null;

  return {
    counts,
    changes: performance === null ? null : {
      added: performance.addedFiles,
      modified: performance.modifiedFiles,
      removed: performance.deletedFiles,
      renamed: performance.renamedFiles,
      unchanged: performance.unchangedFiles,
    },
    skipReasons: Object.fromEntries(
      SKIP_STATUSES.filter((status) => byStatus[status] > 0).map((status) => [status, byStatus[status]]),
    ),
    detail: {
      mode,
      limit,
      delivered: outcomes.length,
      omitted: Math.max(0, ranked.length - outcomes.length),
      outcomes,
      omittedByStatus,
      note: describeDetail(counts, ranked.length, outcomes.length, mode),
    },
  };
}

function describeDetail(
  counts: IndexOutcomeCounts,
  rankedTotal: number,
  delivered: number,
  mode: IndexOutcomeDetailMode,
): string {
  const successesWithheld = counts.filesTotal - rankedTotal;
  const parts = [
    `Counts are exact for all ${counts.filesTotal} files.`,
    successesWithheld > 0
      ? `${successesWithheld} ordinary successful outcomes are summarized, not listed.`
      : "",
    rankedTotal > delivered
      ? `${rankedTotal - delivered} notable outcomes omitted by the ${mode} detail cap; request detail "debug" for more.`
      : "",
  ];
  return parts.filter(Boolean).join(" ");
}

function emptyStatusCounts(): Record<IndexedFileStatus, number> {
  return {
    indexed: 0,
    read_failed: 0,
    parse_failed: 0,
    unregistered_language: 0,
    unsupported_language: 0,
    persistence_failed: 0,
  };
}
