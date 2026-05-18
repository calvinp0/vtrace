import { getLatestIndexRun, getIndexRunSummary } from "../../db/repositories/indexRunsRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import { readGitHead } from "../../fs/git";
import { indexProject } from "../../indexer/indexProject";
import { detectSymbolAddedThenRemovedAntiPatterns } from "../../observations/antiPatterns";
import {
  buildLastIndexSnapshot,
  buildRepoLocalState,
  evaluateRepoReadiness,
  readLastIndexedSourceFingerprint,
  resolveRepoLocalPaths,
  writeRepoLocalState,
} from "../../setup/repoState";
import { formatIndexResult } from "../formatters";
import { selectProgressReporter } from "../progress";
import type { CliOptions, CommandResult } from "../types";
import {
  ensureDatabaseDirectory,
  failure,
  isExistingFile,
  resolveRepoCommandPaths,
  resolveOptions,
  success,
} from "./helpers";

export async function runIndexCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  if (args.length !== 1) {
    return failure("Usage: index <repo>");
  }

  const resolvedOptions = resolveOptions(options);

  try {
    const resolvedRepo = await resolveRepoCommandPaths(
      resolvedOptions,
      args[0] as string,
    );
    const repoRoot = resolvedRepo.repoRoot;
    const dbPath = resolvedRepo.dbPath;
    const statePresent = await isExistingFile(resolvedRepo.statePath);

    await ensureDatabaseDirectory(dbPath);
    const db = openIndexerDatabase(dbPath);

    try {
      const progress = selectProgressReporter({
        stream: process.stderr,
        env: process.env,
      });
      const result = await indexProject({ repoRoot, db, onProgress: progress });
      detectSymbolAddedThenRemovedAntiPatterns(db, { repoRoot });
      await refreshRepoLocalStateAfterIndex({
        repoRoot,
        dbPath,
        statePath: resolvedRepo.statePath,
        configPresent: resolvedRepo.configPresent,
        statePresent,
        usesDbPathOverride: resolvedRepo.usesDbPathOverride,
        indexResult: result,
        db,
      });
      return success(formatIndexResult(result));
    } finally {
      db.close();
    }
  } catch (error) {
    return failure(formatCommandError("index failed", error));
  }
}

function formatCommandError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
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
}): Promise<void> {
  if (
    input.usesDbPathOverride
    || (!input.configPresent && !input.statePresent)
  ) {
    return;
  }

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

  await writeRepoLocalState(input.statePath, state);
}
