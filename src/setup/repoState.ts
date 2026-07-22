import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { IndexProjectResult } from "../indexer/types";
import type { IndexRunSummary } from "../memory/types";
import { captureRepoSourceSnapshot } from "../fs/scanRepo";
import {
  INIT_STATE_SCHEMA_VERSION,
  REPO_LOCAL_CONFIG_FILENAME,
  REPO_LOCAL_CONFIG_RELATIVE_PATH,
  REPO_LOCAL_DB_FILENAME,
  REPO_LOCAL_STATE_DIRNAME,
  REPO_LOCAL_STATE_FILENAME,
  type LastIndexSnapshot,
  type RepoLocalConfig,
  type RepoLocalPaths,
  type RepoLocalState,
  type RepoRootDetection,
  type RepoRootMarker,
  type RepoReadiness,
  type RepoReadinessCheck,
} from "./types";

export function resolveRepoLocalPaths(repoRoot: string): RepoLocalPaths {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const stateDir = path.join(resolvedRepoRoot, REPO_LOCAL_STATE_DIRNAME);

  return {
    repoRoot: resolvedRepoRoot,
    stateDir,
    configPath: path.join(stateDir, REPO_LOCAL_CONFIG_FILENAME),
    dbPath: path.join(stateDir, REPO_LOCAL_DB_FILENAME),
    statePath: path.join(stateDir, REPO_LOCAL_STATE_FILENAME),
  };
}

export async function ensureRepoLocalStateDirectory(paths: RepoLocalPaths): Promise<void> {
  await mkdir(paths.stateDir, { recursive: true });
}

export async function detectRepoRoot(repoPath: string): Promise<RepoRootDetection> {
  const requestedAbsolutePath = path.resolve(repoPath);
  const requestedPath = await realpath(requestedAbsolutePath).catch(() => requestedAbsolutePath);
  const stats = await safeStat(requestedPath);

  if (stats === undefined || !stats.isDirectory()) {
    throw new Error(`Repo not found: ${requestedPath}`);
  }

  let currentPath = requestedPath;
  const systemTempRoot = path.resolve(os.tmpdir());

  while (true) {
    if (currentPath !== requestedPath && currentPath === systemTempRoot) {
      break;
    }

    const marker = await detectRepoRootMarker(currentPath);

    if (marker !== undefined) {
      return {
        requestedPath,
        repoRoot: currentPath,
        mode: "marker",
        marker,
      };
    }

    const parentPath = path.dirname(currentPath);

    if (parentPath === currentPath) {
      break;
    }

    currentPath = parentPath;
  }

  return {
    requestedPath,
    repoRoot: requestedPath,
    mode: "provided_directory",
  };
}

export async function writeRepoLocalConfig(
  configPath: string,
  config: RepoLocalConfig,
): Promise<void> {
  await writeJsonFile(configPath, config);
}

export async function writeRepoLocalState(
  statePath: string,
  state: RepoLocalState,
): Promise<void> {
  await writeJsonFile(statePath, state);
}

export async function readRepoLocalConfig(
  configPath: string,
): Promise<RepoLocalConfig> {
  return JSON.parse(await readFile(configPath, "utf8")) as RepoLocalConfig;
}

export async function readRepoLocalState(
  statePath: string,
): Promise<RepoLocalState> {
  return JSON.parse(await readFile(statePath, "utf8")) as RepoLocalState;
}

export function buildRepoLocalConfig(paths: RepoLocalPaths): RepoLocalConfig {
  return {
    schemaVersion: INIT_STATE_SCHEMA_VERSION,
    repoRoot: paths.repoRoot,
    stateDir: paths.stateDir,
    dbPath: paths.dbPath,
    statePath: paths.statePath,
    initialized: true,
  };
}

export function buildRepoLocalState(input: {
  repoRoot: string;
  dbPath: string;
  readiness: RepoReadiness;
  indexResult: IndexProjectResult;
  latestRunSummary?: IndexRunSummary;
  lastIndexSnapshot?: LastIndexSnapshot;
}): RepoLocalState {
  return {
    repoRoot: input.repoRoot,
    dbPath: input.dbPath,
    schemaVersion: INIT_STATE_SCHEMA_VERSION,
    initialized: true,
    latestRunId: input.latestRunSummary?.id ?? null,
    readiness: input.readiness,
    ...(input.lastIndexSnapshot === undefined
      ? {}
      : { lastIndexSnapshot: input.lastIndexSnapshot }),
    indexSummary: {
      totalFilesScanned: input.indexResult.totalFilesScanned,
      totalFilesAttemptedForParse: input.indexResult.totalFilesAttemptedForParse,
      totalFilesSuccessfullyIndexed: input.indexResult.totalFilesSuccessfullyIndexed,
      totalParseFailures: input.indexResult.totalParseFailures,
      totalSkippedUnregisteredLanguage: input.indexResult.totalSkippedUnregisteredLanguage,
      totalSkippedUnsupportedLanguage: input.indexResult.totalSkippedUnsupportedLanguage,
      totalReadFailures: input.indexResult.totalReadFailures,
      totalPersistenceFailures: input.indexResult.totalPersistenceFailures,
    },
    ...(input.latestRunSummary === undefined
      ? {}
      : {
        latestRun: {
          id: input.latestRunSummary.id,
          ...(input.latestRunSummary.previousRunId === undefined
            ? {}
            : { previousRunId: input.latestRunSummary.previousRunId }),
          totalFiles: input.latestRunSummary.totalFiles,
          totalSymbols: input.latestRunSummary.totalSymbols,
          fileChangeCounts: input.latestRunSummary.fileChangeCounts,
          symbolChangeCounts: input.latestRunSummary.symbolChangeCounts,
        },
      }),
  };
}

export function buildLastIndexSnapshot(input: {
  indexResult: IndexProjectResult;
  latestRunSummary?: IndexRunSummary;
  lastIndexedHead?: string | null;
  lastIndexedSourceFingerprint?: string;
}): LastIndexSnapshot | undefined {
  if (input.latestRunSummary === undefined) {
    return undefined;
  }

  return {
    lastIndexedAtMs: input.latestRunSummary.createdAtMs,
    lastIndexedHead: input.lastIndexedHead ?? null,
    lastIndexedSourceFileCount: input.indexResult.totalFilesScanned,
    ...(input.lastIndexedSourceFingerprint === undefined
      ? {}
      : { lastIndexedSourceFingerprint: input.lastIndexedSourceFingerprint }),
  };
}

export async function readLastIndexedSourceFingerprint(
  repoRoot: string,
): Promise<string | undefined> {
  try {
    return (await captureRepoSourceSnapshot(repoRoot)).fingerprint;
  } catch {
    return undefined;
  }
}

export async function evaluateRepoReadiness(input: {
  repoRoot: string;
  paths: RepoLocalPaths;
  indexResult: IndexProjectResult;
  latestRunSummary?: IndexRunSummary;
}): Promise<RepoReadiness> {
  const checks: RepoReadinessCheck[] = [
    {
      id: "repo_root_exists",
      ok: await isExistingDirectory(input.repoRoot),
      detail: input.repoRoot,
    },
    {
      id: "state_directory_exists",
      ok: await isExistingDirectory(input.paths.stateDir),
      detail: input.paths.stateDir,
    },
    {
      id: "config_exists",
      ok: await pathExists(input.paths.configPath),
      detail: input.paths.configPath,
    },
    {
      id: "database_exists",
      ok: await pathExists(input.paths.dbPath),
      detail: input.paths.dbPath,
    },
    {
      id: "latest_run_present",
      ok: input.latestRunSummary !== undefined,
      detail: input.latestRunSummary === undefined
        ? "No persisted index run was available."
        : `run:${input.latestRunSummary.id}`,
    },
    {
      id: "indexed_files_present",
      ok: input.indexResult.totalFilesSuccessfullyIndexed > 0,
      detail: `indexed_files:${input.indexResult.totalFilesSuccessfullyIndexed}`,
    },
    {
      id: "indexed_symbols_present",
      ok: (input.latestRunSummary?.totalSymbols ?? 0) > 0,
      detail: `indexed_symbols:${input.latestRunSummary?.totalSymbols ?? 0}`,
    },
    {
      id: "index_failures_absent",
      ok: input.indexResult.totalParseFailures === 0
        && input.indexResult.totalReadFailures === 0
        && input.indexResult.totalPersistenceFailures === 0,
      detail: [
        `parse:${input.indexResult.totalParseFailures}`,
        `read:${input.indexResult.totalReadFailures}`,
        `persist:${input.indexResult.totalPersistenceFailures}`,
      ].join(" "),
    },
  ];
  const ready = checks.every((check) => check.ok);

  return {
    status: ready ? "ready" : "not_ready",
    summary: ready
      ? "Repo init completed and readiness checks passed."
      : "Repo init completed, but readiness checks failed.",
    checks,
  };
}

async function detectRepoRootMarker(
  repoRoot: string,
): Promise<RepoRootMarker | undefined> {
  if (await pathExists(path.join(repoRoot, ".git"))) {
    return ".git";
  }

  if (await pathExists(path.join(repoRoot, REPO_LOCAL_CONFIG_RELATIVE_PATH))) {
    return REPO_LOCAL_CONFIG_RELATIVE_PATH;
  }

  return undefined;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function safeStat(targetPath: string) {
  try {
    return await stat(targetPath);
  } catch {
    return undefined;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  return (await safeStat(targetPath)) !== undefined;
}

async function isExistingDirectory(targetPath: string): Promise<boolean> {
  const stats = await safeStat(targetPath);
  return stats?.isDirectory() === true;
}
