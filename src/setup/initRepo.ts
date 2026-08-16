import path from "node:path";

import {
  ensureIndexAccessCapability,
  type EnsureIndexAccessCapabilityOutcome,
} from "../access/indexAccessLifecycle";
import { getLatestIndexRun, getIndexRunSummary } from "../db/repositories/indexRunsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { readGitHead } from "../fs/git";
import { ensureGeneratedStateExcluded } from "./generatedStateExclusion";
import { recordIndexMeta } from "../indexer/indexMeta";
import { withWorktreeIndexLock } from "../indexer/worktreeIndexLock";
import { indexProject } from "../indexer/indexProject";
import { computeIndexFingerprints } from "../indexer/indexMeta";
import { resolveWorktreeIdentity } from "../indexer/worktreeIdentity";
import { recordReusableSnapshot, selectReusableSnapshot } from "../indexer/sharedSnapshots";
import { scanRepo } from "../fs/scanRepo";
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
  const locked = await withWorktreeIndexLock({
    repoRoot: detection.repoRoot,
    operation: () => initRepoUnlocked(options, requestedPath, detection),
  });
  return locked.value;
}

async function initRepoUnlocked(
  options: InitRepoOptions,
  requestedPath: string,
  detection: Awaited<ReturnType<typeof detectRepoRoot>>,
): Promise<InitRepoResult> {
  const paths = resolveRepoLocalPaths(detection.repoRoot);

  // Before the first byte of generated state exists, not after: the window in
  // which `.vtrace/` is untracked-and-unignored is the window in which `git add -A`
  // sweeps it into a commit, and initialization is the only lifecycle point that
  // reliably precedes it.
  const generatedStateExclusion = await ensureGeneratedStateExcluded(detection.repoRoot);

  await ensureRepoLocalStateDirectory(paths);

  const db = openIndexerDatabase(paths.dbPath);

  try {
    const fingerprints = await computeIndexFingerprints();
    const identity = await resolveWorktreeIdentity(detection.repoRoot);
    const reusable = await selectReusableSnapshot({
      identity,
      currentFiles: await scanRepo(detection.repoRoot),
      parserVersion: fingerprints.parser_fingerprint,
      parserConfigFingerprint: fingerprints.config_hash,
    });
    const indexResult = await indexProject({
      repoRoot: detection.repoRoot,
      db,
      previousSnapshot: reusable?.snapshot,
      parserVersion: fingerprints.parser_fingerprint,
      parserConfigFingerprint: fingerprints.config_hash,
      hasExistingGraph: false,
      ...(reusable === undefined ? {} : { baseSnapshotWorktreeId: reusable.worktreeId, baseSnapshotHead: reusable.headCommit ?? undefined }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
    // M148-A. The other fresh-index lifecycle path: `vtrace init`/`setup` builds
    // the FIRST index, and it must leave optimized for the same reason a
    // reindex does. Same seam, same lock, same writable handle, and the same
    // non-fatal contract — a repository that could not gain the access path is
    // fully initialized, just unoptimized.
    const accessCapability = ensureIndexAccessCapability(db);
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

    // Persisted worktree ownership is part of a successful repo-local index.
    await recordIndexMeta(detection.repoRoot, latestRun?.id ?? null, {
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
        // Shared snapshot discovery is optional once the isolated index is valid.
      }
    }

    return {
      requestedPath,
      repoRoot: detection.repoRoot,
      detectionMode: detection.mode,
      ...(detection.marker === undefined ? {} : { detectionMarker: detection.marker }),
      paths,
      config,
      state,
      indexResult,
      accessCapability,
      generatedStateExclusion,
    };
  } finally {
    db.close();
  }
}
