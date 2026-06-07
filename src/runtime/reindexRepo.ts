import { getLatestIndexRun, getIndexRunSummary } from "../db/repositories/indexRunsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { readGitHead } from "../fs/git";
import { indexProject } from "../indexer/indexProject";
import { recordIndexMeta } from "../indexer/indexMeta";
import { detectSymbolAddedThenRemovedAntiPatterns } from "../observations/antiPatterns";
import {
  DEFAULT_REINDEX_SESSION_COMPRESSION_LIMIT,
  compressInactiveSessions,
} from "../observations/sessionLifecycle";
import { markProjectRulesStaleForRun } from "../projectRules/projectRules";
import {
  buildLastIndexSnapshot,
  buildRepoLocalState,
  evaluateRepoReadiness,
  readLastIndexedSourceFingerprint,
  readRepoLocalState,
  resolveRepoLocalPaths,
  writeRepoLocalState,
} from "../setup/repoState";
import type {
  RepoFileWatcherState,
  RepoLocalState,
} from "../setup/types";
import type { IndexProjectResult } from "../indexer/types";
import type { ProgressReporter } from "../cli/progress";

export interface ReindexSessionCompressionDiagnostics {
  /** Whether the sweep ran at all (false only if disabled or an early guard). */
  readonly attempted: boolean;
  /** Sessions eligible for compression before the per-sweep bound. */
  readonly eligibleSessionCount: number;
  /** Sessions visited this sweep (≤ limit). */
  readonly processedSessionCount: number;
  /** Sessions actually compressed this sweep. */
  readonly compressedSessionCount: number;
  /** Repeated passive tool-call observations consolidated/pruned this sweep. */
  readonly prunedToolCallObservationCount: number;
  /** Per-sweep upper bound applied to compression. */
  readonly limit: number;
  /** Error message when the sweep failed; null on success. Never fails reindex. */
  readonly error: string | null;
}

export interface ReindexRepoResult {
  readonly indexResult: IndexProjectResult;
  readonly state: RepoLocalState | null;
  readonly sessionCompression: ReindexSessionCompressionDiagnostics;
}

export async function reindexRepoAndRefreshState(input: {
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly statePath: string;
  readonly configPresent: boolean;
  readonly statePresent: boolean;
  readonly usesDbPathOverride: boolean;
  readonly progress?: ProgressReporter | null;
  readonly preserveWatcher?: RepoFileWatcherState;
}): Promise<ReindexRepoResult> {
  const db = openIndexerDatabase(input.dbPath);

  try {
    const indexResult = await indexProject({
      repoRoot: input.repoRoot,
      db,
      ...(input.progress === undefined || input.progress === null ? {} : { onProgress: input.progress }),
    });
    detectSymbolAddedThenRemovedAntiPatterns(db, { repoRoot: input.repoRoot });
    const latestRun = getLatestIndexRun(db);

    if (latestRun !== undefined) {
      markProjectRulesStaleForRun(db, {
        repoRoot: input.repoRoot,
        runId: latestRun.id,
      });
    }

    // Stamp versioned index metadata next to the repo-local database so a later
    // run can decide whether to reuse this index. Skipped only when the database
    // lives at a custom path (the metadata's `.vtrace/index.meta.json` location
    // would not describe it). Never fails the reindex.
    if (!input.usesDbPathOverride) {
      try {
        await recordIndexMeta(input.repoRoot);
      } catch {
        // Metadata is an optimisation; a failure to write it is non-fatal.
      }
    }

    const sessionCompression = runBoundedSessionCompressionSweep(db, input.repoRoot);
    reportSessionCompressionDiagnostics(input.progress, sessionCompression);

    const state = await refreshRepoLocalStateAfterIndex({
      repoRoot: input.repoRoot,
      dbPath: input.dbPath,
      statePath: input.statePath,
      configPresent: input.configPresent,
      statePresent: input.statePresent,
      usesDbPathOverride: input.usesDbPathOverride,
      indexResult,
      db,
      preserveWatcher: input.preserveWatcher,
    });

    return {
      indexResult,
      state,
      sessionCompression,
    };
  } finally {
    db.close();
  }
}

/**
 * Bounded, deterministic post-index maintenance: compress sessions that have
 * been inactive past the default threshold and consolidate their repeated
 * passive tool-call observations. Capped at a small number of sessions per
 * sweep so reindex stays cheap. Idempotent (already-compressed sessions are
 * skipped) and isolated — any failure is captured as a diagnostic and never
 * fails the reindex.
 */
export function runBoundedSessionCompressionSweep(
  db: ReturnType<typeof openIndexerDatabase>,
  repoRoot: string,
): ReindexSessionCompressionDiagnostics {
  const limit = DEFAULT_REINDEX_SESSION_COMPRESSION_LIMIT;

  try {
    const result = compressInactiveSessions(db, {
      repoRoot,
      nowMs: Date.now(),
      limit,
    });

    return {
      attempted: true,
      eligibleSessionCount: result.eligibleSessionCount,
      processedSessionCount: result.processedSessionCount,
      compressedSessionCount: result.compressedSummaries.length,
      prunedToolCallObservationCount: result.compressedSummaries.reduce(
        (total, summary) => total + summary.prunedToolCallObservationCount,
        0,
      ),
      limit,
      error: null,
    };
  } catch (error) {
    return {
      attempted: true,
      eligibleSessionCount: 0,
      processedSessionCount: 0,
      compressedSessionCount: 0,
      prunedToolCallObservationCount: 0,
      limit,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function refreshRepoLocalStateAfterIndex(input: {
  repoRoot: string;
  dbPath: string;
  statePath: string;
  configPresent: boolean;
  statePresent: boolean;
  usesDbPathOverride: boolean;
  indexResult: Awaited<ReturnType<typeof indexProject>>;
  db: ReturnType<typeof openIndexerDatabase>;
  preserveWatcher?: RepoFileWatcherState;
}): Promise<RepoLocalState | null> {
  if (
    input.usesDbPathOverride
    || (!input.configPresent && !input.statePresent)
  ) {
    return null;
  }

  const previousState = await safeReadRepoLocalState(input.statePath);
  const latestRun = getLatestIndexRun(input.db);
  const latestRunSummary = latestRun === undefined
    ? undefined
    : getIndexRunSummary(input.db, latestRun.id);
  const repoLocalPaths = resolveRepoLocalPaths(input.repoRoot);
  const readiness = await evaluateRepoReadiness({
    repoRoot: input.repoRoot,
    paths: {
      ...repoLocalPaths,
      dbPath: input.dbPath,
      statePath: input.statePath,
    },
    indexResult: input.indexResult,
    latestRunSummary,
  });
  const preservedWatcher = input.preserveWatcher ?? previousState?.fileWatcher;
  const state = buildRepoLocalState({
    repoRoot: input.repoRoot,
    dbPath: input.dbPath,
    readiness,
    indexResult: input.indexResult,
    latestRunSummary,
    lastIndexSnapshot: buildLastIndexSnapshot({
      indexResult: input.indexResult,
      latestRunSummary,
      lastIndexedHead: await readGitHead(input.repoRoot),
      lastIndexedSourceFingerprint: await readLastIndexedSourceFingerprint(input.repoRoot),
    }),
  });
  const nextState: RepoLocalState = preservedWatcher === undefined
    ? state
    : {
      ...state,
      fileWatcher: {
        ...preservedWatcher,
        reindexState: "idle",
        lastAutoReindexError: null,
        pendingChangedFileCount: 0,
        changedFiles: [],
      },
    };

  await writeRepoLocalState(input.statePath, nextState);
  return nextState;
}

/**
 * Surface compression diagnostics on the progress stream, but only when the
 * sweep actually did something. A no-op sweep (the common case) emits nothing,
 * so existing progress/JSON output is byte-identical. Structured diagnostics
 * are always available on `ReindexRepoResult.sessionCompression`.
 */
function reportSessionCompressionDiagnostics(
  progress: ProgressReporter | null | undefined,
  diagnostics: ReindexSessionCompressionDiagnostics,
): void {
  if (progress === undefined || progress === null) {
    return;
  }

  if (diagnostics.error !== null) {
    progress.report({ kind: "phase_begin", phase: "compress_sessions", label: "Compressing inactive sessions" });
    progress.report({
      kind: "phase_end",
      phase: "compress_sessions",
      note: `skipped (${diagnostics.error})`,
    });
    return;
  }

  if (diagnostics.compressedSessionCount === 0) {
    return;
  }

  progress.report({ kind: "phase_begin", phase: "compress_sessions", label: "Compressing inactive sessions" });
  progress.report({
    kind: "phase_end",
    phase: "compress_sessions",
    note: `${diagnostics.compressedSessionCount} compressed, ${diagnostics.prunedToolCallObservationCount} observations consolidated`,
  });
}

async function safeReadRepoLocalState(
  statePath: string,
): Promise<RepoLocalState | undefined> {
  try {
    return await readRepoLocalState(statePath);
  } catch {
    return undefined;
  }
}
