import { stat } from "node:fs/promises";

import {
  readRepoLocalConfig,
  readRepoLocalState,
} from "../setup/repoState";
import type {
  RepoLocalConfig,
  RepoLocalState,
} from "../setup/types";
import type { ResolvedWorkspaceRepoConfig } from "./config";

export interface WorkspaceRepoStatus {
  readonly repoAlias: string;
  readonly repoRoot: string;
  readonly configPath: string;
  readonly statePath: string;
  readonly dbPath: string;
  readonly enabled: boolean;
  readonly configPresent: boolean;
  readonly statePresent: boolean;
  readonly dbPresent: boolean;
  readonly initialized: boolean;
  readonly indexPresent: boolean;
  readonly latestRunId: number | null;
  readonly readiness: RepoLocalState["readiness"] | null;
  readonly notReadyReason: string | null;
  readonly config?: RepoLocalConfig;
  readonly state?: RepoLocalState;
}

export async function inspectWorkspaceRepoStatus(
  spec: ResolvedWorkspaceRepoConfig,
): Promise<WorkspaceRepoStatus> {
  const repoRootPresent = await pathExists(spec.rootPath);
  const config = await safeReadConfig(spec.configPath);
  const state = await safeReadState(spec.statePath);
  const dbPath = config?.dbPath ?? state?.dbPath ?? spec.dbPath;
  const configPresent = config !== undefined;
  const statePresent = state !== undefined;
  const dbPresent = await pathExists(dbPath);
  const initialized = config?.initialized === true && state?.initialized === true && dbPresent;
  const latestRunId = state?.latestRunId ?? null;
  const indexPresent = latestRunId !== null && dbPresent;
  const readiness = state?.readiness ?? null;

  return {
    repoAlias: spec.alias,
    repoRoot: spec.rootPath,
    configPath: spec.configPath,
    statePath: spec.statePath,
    dbPath,
    enabled: spec.enabled,
    configPresent,
    statePresent,
    dbPresent,
    initialized,
    indexPresent,
    latestRunId,
    readiness,
    notReadyReason: buildNotReadyReason({
      enabled: spec.enabled,
      repoRootPresent,
      configPresent,
      statePresent,
      dbPresent,
      initialized,
      indexPresent,
      readiness,
      repoRoot: spec.rootPath,
    }),
    ...(config === undefined ? {} : { config }),
    ...(state === undefined ? {} : { state }),
  };
}

function buildNotReadyReason(input: {
  enabled: boolean;
  repoRootPresent: boolean;
  configPresent: boolean;
  statePresent: boolean;
  dbPresent: boolean;
  initialized: boolean;
  indexPresent: boolean;
  readiness: RepoLocalState["readiness"] | null;
  repoRoot: string;
}): string | null {
  if (!input.enabled) {
    return "Repo is disabled in workspace config.";
  }

  if (!input.repoRootPresent) {
    return `Repo root does not exist: ${input.repoRoot}`;
  }

  if (!input.configPresent) {
    return `Repo-local config is missing. Run \`vtrace init ${input.repoRoot}\` or \`vtrace setup ${input.repoRoot}\`.`;
  }

  if (!input.statePresent) {
    return `Repo-local state is missing. Run \`vtrace init ${input.repoRoot}\` or \`vtrace setup ${input.repoRoot}\`.`;
  }

  if (!input.dbPresent) {
    return `Repo-local index database is missing. Run \`vtrace init ${input.repoRoot}\` or \`vtrace setup ${input.repoRoot}\`.`;
  }

  if (!input.initialized) {
    return `Repo-local init state is incomplete. Run \`vtrace init ${input.repoRoot}\` or \`vtrace setup ${input.repoRoot}\`.`;
  }

  if (!input.indexPresent) {
    return `No indexed run is present. Run \`vtrace init ${input.repoRoot}\` or \`vtrace index ${input.repoRoot}\`.`;
  }

  if (input.readiness?.status !== "ready") {
    return input.readiness?.summary ?? "Repo readiness is not ready.";
  }

  return null;
}

async function safeReadConfig(
  configPath: string,
): Promise<RepoLocalConfig | undefined> {
  try {
    return await readRepoLocalConfig(configPath);
  } catch {
    return undefined;
  }
}

async function safeReadState(
  statePath: string,
): Promise<RepoLocalState | undefined> {
  try {
    return await readRepoLocalState(statePath);
  } catch {
    return undefined;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
