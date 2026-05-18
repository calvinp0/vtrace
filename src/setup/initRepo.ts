import path from "node:path";

import { getLatestIndexRun, getIndexRunSummary } from "../db/repositories/indexRunsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { readGitHead } from "../fs/git";
import { indexProject } from "../indexer/indexProject";
import {
  buildLastIndexSnapshot,
  buildRepoLocalState,
  buildRepoLocalConfig,
  readLastIndexedSourceFingerprint,
  detectRepoRoot,
  ensureRepoLocalStateDirectory,
  evaluateRepoReadiness,
  resolveRepoLocalPaths,
  writeRepoLocalConfig,
  writeRepoLocalState,
} from "./repoState";
import type {
  InitRepoOptions,
  InitRepoResult,
} from "./types";

export async function initRepo(options: InitRepoOptions): Promise<InitRepoResult> {
  const requestedPath = path.resolve(options.cwd ?? process.cwd(), options.repoPath);
  const detection = await detectRepoRoot(requestedPath);
  const paths = resolveRepoLocalPaths(detection.repoRoot);

  await ensureRepoLocalStateDirectory(paths);

  const db = openIndexerDatabase(paths.dbPath);

  try {
    const indexResult = await indexProject({
      repoRoot: detection.repoRoot,
      db,
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
    const latestRun = getLatestIndexRun(db);
    const latestRunSummary = latestRun === undefined ? undefined : getIndexRunSummary(db, latestRun.id);
    const lastIndexSnapshot = buildLastIndexSnapshot({
      indexResult,
      latestRunSummary,
      lastIndexedHead: await readGitHead(detection.repoRoot),
      lastIndexedSourceFingerprint: await readLastIndexedSourceFingerprint(detection.repoRoot),
    });
    const config = buildRepoLocalConfig(paths);

    await writeRepoLocalConfig(paths.configPath, config);

    const readiness = await evaluateRepoReadiness({
      repoRoot: detection.repoRoot,
      paths,
      indexResult,
      latestRunSummary,
    });
    const state = buildRepoLocalState({
      repoRoot: detection.repoRoot,
      dbPath: paths.dbPath,
      readiness,
      indexResult,
      latestRunSummary,
      lastIndexSnapshot,
    });

    await writeRepoLocalState(paths.statePath, state);

    return {
      requestedPath,
      repoRoot: detection.repoRoot,
      detectionMode: detection.mode,
      ...(detection.marker === undefined ? {} : { detectionMarker: detection.marker }),
      paths,
      config,
      state,
      indexResult,
    };
  } finally {
    db.close();
  }
}
