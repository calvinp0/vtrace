import { getLatestIndexRun, getIndexRunSummary } from "../db/repositories/indexRunsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { readGitHead } from "../fs/git";
import { indexProject } from "../indexer/indexProject";
import { detectSymbolAddedThenRemovedAntiPatterns } from "../observations/antiPatterns";
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

export interface ReindexRepoResult {
  readonly indexResult: IndexProjectResult;
  readonly state: RepoLocalState | null;
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
    };
  } finally {
    db.close();
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

async function safeReadRepoLocalState(
  statePath: string,
): Promise<RepoLocalState | undefined> {
  try {
    return await readRepoLocalState(statePath);
  } catch {
    return undefined;
  }
}
