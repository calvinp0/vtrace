import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveRepoLocalPaths } from "../setup/repoState";

export const WORKSPACE_CONFIG_FILENAME = "workspace.json" as const;
export const WORKSPACE_CONFIG_SCHEMA_VERSION = "1.0.0" as const;

/**
 * M145 identity fields are OPTIONAL and additive, and `schemaVersion` stays at
 * 1.0.0 on purpose. A reader that predates them ignores unknown keys, so a
 * config carrying identity is still readable by older code, while bumping the
 * version would have made every existing workspace file fail the strict equality
 * check below for no correctness gain. §111: decide the bump, do not reflex it.
 */
export interface WorkspaceRepoIdentityRecord {
  /** Path-derived id. Records WHICH LOCATION was registered. */
  readonly repositoryId?: string;
  readonly worktreeId?: string;
  /** Instance evidence. Records WHICH REPOSITORY was there when registered. */
  readonly repositoryInstance?: string | null;
  readonly worktreeInstance?: string | null;
}

export interface WorkspaceRepoConfig extends WorkspaceRepoIdentityRecord {
  readonly alias: string;
  readonly rootPath: string;
  readonly statePath?: string;
  readonly dbPath?: string;
  readonly enabled?: boolean;
}

export interface WorkspaceConfig {
  readonly schemaVersion: typeof WORKSPACE_CONFIG_SCHEMA_VERSION;
  readonly name?: string;
  readonly primaryRepoAlias: string;
  readonly repos: readonly WorkspaceRepoConfig[];
}

export interface ResolvedWorkspaceRepoConfig extends WorkspaceRepoIdentityRecord {
  readonly alias: string;
  readonly rootPath: string;
  readonly configPath: string;
  readonly statePath: string;
  readonly dbPath: string;
  readonly enabled: boolean;
}

export interface ResolvedWorkspaceConfig {
  readonly configPath: string;
  readonly name?: string;
  readonly primaryRepoAlias: string;
  /**
   * Did the FILE name a primary, or did normalization fall back to the first
   * entry? Routing may only default to an explicitly named one (§75), so the
   * two cases cannot be allowed to look alike downstream.
   */
  readonly primaryRepoAliasExplicit: boolean;
  readonly repos: readonly ResolvedWorkspaceRepoConfig[];
}

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function resolveWorkspaceConfigPath(repoRoot: string): string {
  return path.join(resolveRepoLocalPaths(repoRoot).stateDir, WORKSPACE_CONFIG_FILENAME);
}

export async function readWorkspaceConfig(
  configPath: string,
): Promise<ResolvedWorkspaceConfig> {
  const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;

  return normalizeWorkspaceConfig(raw, configPath);
}

export async function writeWorkspaceConfig(
  configPath: string,
  config: WorkspaceConfig,
): Promise<ResolvedWorkspaceConfig> {
  const normalized = normalizeWorkspaceConfig(config, configPath);

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(formatWorkspaceConfigForWrite(normalized), null, 2)}\n`);

  return normalized;
}

export async function safeReadWorkspaceConfig(
  configPath: string,
): Promise<ResolvedWorkspaceConfig | undefined> {
  try {
    return await readWorkspaceConfig(configPath);
  } catch {
    return undefined;
  }
}

export function normalizeWorkspaceConfig(
  raw: unknown,
  configPath: string,
): ResolvedWorkspaceConfig {
  if (!isRecord(raw)) {
    throw new Error("Workspace config must be an object.");
  }

  const schemaVersion = raw.schemaVersion;

  if (schemaVersion !== WORKSPACE_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `Workspace config schemaVersion must be ${WORKSPACE_CONFIG_SCHEMA_VERSION}.`,
    );
  }

  const repos = raw.repos;

  if (!Array.isArray(repos) || repos.length === 0) {
    throw new Error("Workspace config requires a non-empty repos array.");
  }

  const baseDir = path.dirname(path.dirname(configPath));
  const normalizedRepos = repos.map((repo, index) => normalizeRepoConfig(repo, index, baseDir));
  const aliases = normalizedRepos.map((repo) => repo.alias);
  const duplicateAlias = aliases.find((alias, index) => aliases.indexOf(alias) !== index);

  if (duplicateAlias !== undefined) {
    throw new Error(`Workspace config contains duplicate repo alias: ${duplicateAlias}`);
  }

  const rootPaths = normalizedRepos.map((repo) => repo.rootPath);
  const duplicateRootPath = rootPaths.find((rootPath, index) => rootPaths.indexOf(rootPath) !== index);

  if (duplicateRootPath !== undefined) {
    throw new Error(`Workspace config contains duplicate repo rootPath: ${duplicateRootPath}`);
  }

  const primaryRepoAliasExplicit = typeof raw.primaryRepoAlias === "string"
    && raw.primaryRepoAlias.trim().length > 0;
  const primaryRepoAlias = primaryRepoAliasExplicit
    ? (raw.primaryRepoAlias as string).trim()
    : normalizedRepos[0]!.alias;

  if (!aliases.includes(primaryRepoAlias)) {
    throw new Error(`Workspace primaryRepoAlias is not configured: ${primaryRepoAlias}`);
  }

  return {
    configPath,
    ...(typeof raw.name === "string" && raw.name.trim().length > 0
      ? { name: raw.name.trim() }
      : {}),
    primaryRepoAlias,
    primaryRepoAliasExplicit,
    repos: normalizedRepos,
  };
}

export function normalizeWorkspaceAlias(value: string, context = "Workspace repo alias"): string {
  const alias = value.trim();

  if (!ALIAS_PATTERN.test(alias)) {
    throw new Error(`${context} is invalid. Use letters, numbers, dots, dashes, or underscores.`);
  }

  return alias;
}

export function defaultWorkspaceRepoAlias(repoRoot: string): string {
  const baseName = path.basename(path.resolve(repoRoot)).trim();
  const normalized = baseName.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");

  return normalized.length === 0 ? "repo" : normalized;
}

export function formatWorkspaceConfigForWrite(
  config: ResolvedWorkspaceConfig | WorkspaceConfig,
): WorkspaceConfig {
  return {
    schemaVersion: WORKSPACE_CONFIG_SCHEMA_VERSION,
    ...(typeof config.name === "string" && config.name.trim().length > 0
      ? { name: config.name.trim() }
      : {}),
    primaryRepoAlias: config.primaryRepoAlias,
    repos: config.repos.map((repo) => {
      const rootPath = path.resolve(repo.rootPath);
      const localPaths = resolveRepoLocalPaths(rootPath);
      const statePath = repo.statePath === undefined ? undefined : path.resolve(repo.statePath);
      const dbPath = repo.dbPath === undefined ? undefined : path.resolve(repo.dbPath);

      return {
        alias: repo.alias,
        rootPath,
        ...(statePath === undefined || statePath === localPaths.statePath ? {} : { statePath }),
        ...(dbPath === undefined || dbPath === localPaths.dbPath ? {} : { dbPath }),
        enabled: repo.enabled !== false,
        // Round-tripped, not recomputed: rewriting the file for an unrelated
        // reason must not quietly re-bless a registration.
        ...(repo.repositoryId === undefined ? {} : { repositoryId: repo.repositoryId }),
        ...(repo.worktreeId === undefined ? {} : { worktreeId: repo.worktreeId }),
        ...(repo.repositoryInstance === undefined ? {} : { repositoryInstance: repo.repositoryInstance }),
        ...(repo.worktreeInstance === undefined ? {} : { worktreeInstance: repo.worktreeInstance }),
      };
    }),
  };
}

function normalizeRepoConfig(
  raw: unknown,
  index: number,
  baseDir: string,
): ResolvedWorkspaceRepoConfig {
  if (!isRecord(raw)) {
    throw new Error(`Workspace repo entry ${index} must be an object.`);
  }

  const alias = typeof raw.alias === "string" ? raw.alias.trim() : "";

  if (!ALIAS_PATTERN.test(alias)) {
    throw new Error(
      `Workspace repo entry ${index} has invalid alias. Use letters, numbers, dots, dashes, or underscores.`,
    );
  }

  const rootPathRaw = typeof raw.rootPath === "string" ? raw.rootPath.trim() : "";

  if (rootPathRaw.length === 0) {
    throw new Error(`Workspace repo entry ${alias} requires rootPath.`);
  }

  const rootPath = resolveConfigPath(baseDir, rootPathRaw);
  const localPaths = resolveRepoLocalPaths(rootPath);
  const statePath = typeof raw.statePath === "string" && raw.statePath.trim().length > 0
    ? resolveConfigPath(baseDir, raw.statePath.trim())
    : localPaths.statePath;
  const dbPath = typeof raw.dbPath === "string" && raw.dbPath.trim().length > 0
    ? resolveConfigPath(baseDir, raw.dbPath.trim())
    : localPaths.dbPath;

  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error(`Workspace repo entry ${alias} has non-boolean enabled.`);
  }

  return {
    alias,
    rootPath,
    configPath: localPaths.configPath,
    statePath,
    dbPath,
    enabled: raw.enabled !== false,
    ...readIdentityRecord(raw),
  };
}

/**
 * Identity is read back verbatim and never repaired. A registration that records
 * a repository which is no longer there must stay readable so the registry can
 * REPORT the mismatch; silently refreshing it here would delete the evidence
 * §109 exists to catch.
 */
function readIdentityRecord(raw: Record<string, unknown>): WorkspaceRepoIdentityRecord {
  return {
    ...(typeof raw.repositoryId === "string" && raw.repositoryId.length > 0
      ? { repositoryId: raw.repositoryId }
      : {}),
    ...(typeof raw.worktreeId === "string" && raw.worktreeId.length > 0
      ? { worktreeId: raw.worktreeId }
      : {}),
    ...(typeof raw.repositoryInstance === "string" || raw.repositoryInstance === null
      ? { repositoryInstance: raw.repositoryInstance as string | null }
      : {}),
    ...(typeof raw.worktreeInstance === "string" || raw.worktreeInstance === null
      ? { worktreeInstance: raw.worktreeInstance as string | null }
      : {}),
  };
}

function resolveConfigPath(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseDir, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
