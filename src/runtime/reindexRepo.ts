import {
  ensureIndexAccessCapability,
  type EnsureIndexAccessCapabilityOutcome,
} from "../access/indexAccessLifecycle";
import { getLatestIndexRun, getIndexRunSummary } from "../db/repositories/indexRunsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { readGitHead } from "../fs/git";
import { indexProject } from "../indexer/indexProject";
import {
  computeIndexFingerprints,
  readIndexMeta,
  recordIndexMeta,
  resolveDerivationRebuildReason,
} from "../indexer/indexMeta";
import { withWorktreeIndexLock } from "../indexer/worktreeIndexLock";
import { resolveWorktreeIdentity } from "../indexer/worktreeIdentity";
import { recordReusableSnapshot, selectReusableSnapshot } from "../indexer/sharedSnapshots";
import { scanRepo } from "../fs/scanRepo";
import { GraphValidationError } from "../indexer/normalizedGraph";
import { detectSymbolAddedThenRemovedAntiPatterns } from "../observations/antiPatterns";
import { resolveCurrentObservationContext } from "../observations/provenance";
import {
  DEFAULT_REINDEX_SESSION_COMPRESSION_LIMIT,
  compressInactiveSessions,
} from "../observations/sessionLifecycle";
import { markProjectRulesStaleForRun } from "../projectRules/projectRules";
import {
  LegacyMigrationOutcome,
  migrateLegacySessionState,
  type LegacyMigrationResult,
} from "../session/legacyMigration";
import { ProductStoreLease } from "../session/sessionStore";
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
import type { IndexRefreshMode } from "../indexer/incrementalIndex";
import { isValidSnapshotSet } from "../indexer/incrementalIndex";
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
  /**
   * M152. What the legacy session-state drain did on the way in. Null when the
   * store split is not involved at all (an index written after M152 has no
   * session tables to move). Reported rather than silent, because "your memory
   * moved files" is exactly the kind of thing a user should be able to see.
   */
  readonly legacySessionMigration: LegacyMigrationResult | null;
  /**
   * M148-A. What the physical access-path migration did on the way out of the
   * lifecycle. Reported rather than silent: the difference between `indexed`
   * and `fallback` is the difference between a keyed lookup and a symbol-table
   * scan for every workspace membership question this index answers.
   */
  readonly accessCapability: EnsureIndexAccessCapabilityOutcome;
  readonly staleLockRecovered: boolean;
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
  readonly lockWaitMs?: number;
  readonly refreshMode?: IndexRefreshMode;
}): Promise<ReindexRepoResult> {
  const locked = await withWorktreeIndexLock({
    repoRoot: input.repoRoot,
    ...(input.lockWaitMs === undefined ? {} : { waitMs: input.lockWaitMs }),
    operation: () => reindexRepoAndRefreshStateUnlocked(input),
  });
  return { ...locked.value, staleLockRecovered: locked.staleLockRecovered };
}

async function reindexRepoAndRefreshStateUnlocked(input: {
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly statePath: string;
  readonly configPresent: boolean;
  readonly statePresent: boolean;
  readonly usesDbPathOverride: boolean;
  readonly progress?: ProgressReporter | null;
  readonly preserveWatcher?: RepoFileWatcherState;
  readonly refreshMode?: IndexRefreshMode;
}): Promise<Omit<ReindexRepoResult, "staleLockRecovered">> {
  const db = openIndexerDatabase(input.dbPath);
  // M152. The ONE migration seam (§167). It runs here and not on a product read
  // because this is where the worktree lock is already held, the writable index
  // handle already exists, and the caller already expects the index to change.
  //
  // Before the indexer touches anything: a crash mid-index must not be able to
  // strand session rows in a file that is being rewritten around them.
  const lease = new ProductStoreLease(db, input.dbPath);
  const legacySessionMigration = drainLegacySessionState(db, input.dbPath, lease);

  try {
    const fingerprints = await computeIndexFingerprints();
    const identity = await resolveWorktreeIdentity(input.repoRoot);
    const localMeta = await readIndexMeta(input.repoRoot);
    const currentFiles = await scanRepo(input.repoRoot);
    const localSnapshot = localMeta?.manifest?.files;
    // Every derivation-relevant fingerprint is compared, not a hand-picked few:
    // a mismatch confined to `indexer_fingerprint` used to leave the snapshot
    // "compatible", so the planner reused content the runtime had already
    // refused and then stamped it as current.
    const localIncompatibility = localMeta === undefined || localMeta === null
      ? undefined
      : resolveDerivationRebuildReason(localMeta, fingerprints)
        ?? (localSnapshot === undefined
          ? "schema_incompatible" as const
          : !isValidSnapshotSet(localSnapshot)
            ? "snapshot_invalid" as const
            : undefined);
    const reusable = localSnapshot === undefined
      ? await selectReusableSnapshot({
        identity,
        currentFiles,
        parserVersion: fingerprints.parser_fingerprint,
        parserConfigFingerprint: fingerprints.config_hash,
      })
      : undefined;
    const indexOptions = {
      repoRoot: input.repoRoot,
      db,
      previousSnapshot: localSnapshot ?? reusable?.snapshot,
      ...(localIncompatibility === undefined ? {} : { previousSnapshotCompatible: false, incompatibilityReason: localIncompatibility }),
      parserVersion: fingerprints.parser_fingerprint,
      parserConfigFingerprint: fingerprints.config_hash,
      refreshMode: input.refreshMode ?? "auto",
      ...(reusable === undefined ? {} : { baseSnapshotWorktreeId: reusable.worktreeId, baseSnapshotHead: reusable.headCommit ?? undefined }),
      ...(input.progress === undefined || input.progress === null ? {} : { onProgress: input.progress }),
    } as const;
    let indexResult: IndexProjectResult;
    try {
      indexResult = await indexProject(indexOptions);
    } catch (error) {
      if (!(error instanceof GraphValidationError) || indexOptions.refreshMode === "full") throw error;
      indexResult = await indexProject({ ...indexOptions, refreshMode: "full" });
      if (indexResult.performance !== undefined) {
        indexResult.performance.fallbackReason = "graph_validation_failed";
      }
    }
    const latestRun = getLatestIndexRun(db);

    if (latestRun !== undefined) {
      markProjectRulesStaleForRun(lease.write, {
        repoRoot: input.repoRoot,
        runId: latestRun.id,
      });
    }

    // Persist the worktree ownership manifest next to a repo-local database.
    // A completed repo-local index without this manifest is unsafe to reuse.
    if (!input.usesDbPathOverride) {
      await recordIndexMeta(input.repoRoot, latestRun?.id ?? null, {
        files: indexResult.snapshot,
        performance: indexResult.performance,
      });
      if (indexResult.snapshot !== undefined) {
        try {
          await recordReusableSnapshot(identity, {
            parserVersion: fingerprints.parser_fingerprint,
            parserConfigFingerprint: fingerprints.config_hash,
            snapshot: indexResult.snapshot,
          });
        } catch {
          // Shared snapshot discovery is an optimization; the worktree-local
          // graph and manifest are already valid.
        }
      }
    }

    detectSymbolAddedThenRemovedAntiPatterns(lease.write, {
      repoRoot: input.repoRoot,
      ...(!input.usesDbPathOverride ? {
        currentContext: await resolveCurrentObservationContext(input.repoRoot),
      } : {}),
    });

    const sessionCompression = runBoundedSessionCompressionSweep(lease, input.repoRoot);
    reportSessionCompressionDiagnostics(input.progress, sessionCompression);

    // M148-A. The narrowest point where an authoritative index has just been
    // written, the worktree lock is held, and a writable handle is already open.
    //
    // It runs on every lifecycle invocation, not only on a rebuild, because the
    // user-important case is the index that is ALREADY compatible: `vtrace index`
    // on an unchanged repository plans a `noop` refresh — no file is parsed, no
    // symbol regenerated, no graph or FTS content rewritten — and still leaves
    // with the access path installed. That is what makes gaining the access path
    // a lifecycle operation rather than a reason to reparse a repository.
    //
    // Never fatal: a migration that cannot run leaves an index that is
    // semantically identical and merely unoptimised (`nameLookupAccess:
    // fallback`), and failing the whole index run over that would be a lie with
    // an expensive remedy.
    const accessCapability = ensureIndexAccessCapability(db);
    reportAccessCapabilityDiagnostics(input.progress, accessCapability);

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
      legacySessionMigration,
      accessCapability,
    };
  } finally {
    lease.close();
    db.close();
  }
}

/**
 * Drain a pre-M152 mixed index into its session store, if it is one.
 *
 * Never fatal, and deliberately so: a repository whose session store cannot be
 * written still has a perfectly indexable repository, and failing the whole
 * index run would make an optional product-state feature block the operation the
 * user actually asked for (§110, §169). The legacy tables are dropped only after
 * a successful copy, so a failure here leaves the old state exactly where it was
 * and the next `index_repo` retries it (§25).
 */
function drainLegacySessionState(
  indexDb: ReturnType<typeof openIndexerDatabase>,
  indexDbPath: string,
  lease: ProductStoreLease,
): LegacyMigrationResult | null {
  try {
    const result = migrateLegacySessionState({
      indexDb,
      indexDbPath,
      sessionDb: lease.write.session,
    });
    return result.outcome === LegacyMigrationOutcome.NotLegacy ? null : result;
  } catch {
    return null;
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
  lease: ProductStoreLease,
  repoRoot: string,
): ReindexSessionCompressionDiagnostics {
  const limit = DEFAULT_REINDEX_SESSION_COMPRESSION_LIMIT;

  try {
    const result = compressInactiveSessions(lease.write, {
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

/**
 * Report the access migration only when it DID something, or when it failed.
 * The common case — already installed — emits nothing, so ordinary progress and
 * `--json` output for an unchanged repository stay byte-identical.
 */
function reportAccessCapabilityDiagnostics(
  progress: ProgressReporter | null | undefined,
  outcome: EnsureIndexAccessCapabilityOutcome,
): void {
  if (progress === undefined || progress === null) return;
  if (!outcome.attempted) return;
  if (outcome.error === null && !outcome.applied) return;

  progress.report({ kind: "phase_begin", phase: "access_paths", label: "Ensuring index access paths" });
  progress.report({
    kind: "phase_end",
    phase: "access_paths",
    note: outcome.error !== null
      // Truthful about consequence: the index still answers, it just scans.
      ? `skipped (${outcome.error}); name lookups use ${outcome.state.nameLookupAccess}`
      : `${outcome.created.length} installed`,
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
