import { stat } from "node:fs/promises";
import path from "node:path";

import { detectRepoRoot } from "../../setup/repoState";
import {
  defaultWorkspaceRepoAlias,
  formatWorkspaceConfigForWrite,
  normalizeWorkspaceAlias,
  readWorkspaceConfig,
  resolveWorkspaceConfigPath,
  WORKSPACE_CONFIG_SCHEMA_VERSION,
  writeWorkspaceConfig,
  type ResolvedWorkspaceConfig,
  type WorkspaceConfig,
} from "../../workspace/config";
import { evaluateWorkspaceReadiness } from "../../workspace/readiness";
import { captureRepoIdentityRecord, resolveWorkspaceRegistry } from "../../workspace/registry";
import { inspectWorkspaceRepoStatus } from "../../workspace/status";
import { formatJson } from "../formatters";
import type { CliOptions, CommandResult, ResolvedCliOptions } from "../types";
import { failure, resolveOptions, success } from "./helpers";

const WORKSPACE_USAGE = [
  "Usage:",
  "  vtrace workspace init [repo] [--alias <alias>]",
  "  vtrace workspace add <alias> <path> [--repo <workspace-repo>]",
  "  vtrace workspace list [repo]",
  "  vtrace workspace status [repo]",
].join("\n");

export async function runWorkspaceCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  const [subcommand, ...subcommandArgs] = args;
  const resolvedOptions = resolveOptions(options);

  try {
    switch (subcommand) {
      case "init":
        return success(formatJson(await initWorkspace(subcommandArgs, resolvedOptions)));
      case "add":
        return success(formatJson(await addWorkspaceRepo(subcommandArgs, resolvedOptions)));
      case "list":
        return success(formatJson(await listWorkspaceRepos(subcommandArgs, resolvedOptions)));
      case "status":
        return success(formatJson(await statusWorkspaceRepos(subcommandArgs, resolvedOptions)));
      default:
        return failure(WORKSPACE_USAGE);
    }
  } catch (error) {
    return failure(formatCommandError("workspace failed", error));
  }
}

async function initWorkspace(
  args: readonly string[],
  options: ResolvedCliOptions,
) {
  const parsed = parseWorkspaceInitArgs(args);

  if ("error" in parsed) {
    throw new Error(parsed.error);
  }

  const detection = await detectRepoRoot(path.resolve(options.cwd, parsed.repoPath));
  const repoRoot = detection.repoRoot;
  const configPath = resolveWorkspaceConfigPath(repoRoot);
  const alias = normalizeWorkspaceAlias(
    parsed.alias ?? defaultWorkspaceRepoAlias(repoRoot),
    "Workspace primary repo alias",
  );

  if (await isExistingFile(configPath)) {
    const existing = await readWorkspaceConfig(configPath);

    return {
      action: "unchanged",
      workspace: formatWorkspaceSummary(existing),
      primaryRepo: formatWorkspaceRepoSummary(
        existing.repos.find((repo) => repo.alias === existing.primaryRepoAlias) ?? existing.repos[0]!,
      ),
    };
  }

  const config: WorkspaceConfig = {
    schemaVersion: WORKSPACE_CONFIG_SCHEMA_VERSION,
    primaryRepoAlias: alias,
    repos: [
      {
        alias,
        rootPath: repoRoot,
        enabled: true,
        ...(await captureRepoIdentityRecord(repoRoot)),
      },
    ],
  };
  const written = await writeWorkspaceConfig(configPath, config);

  return {
    action: "created",
    workspace: formatWorkspaceSummary(written),
    primaryRepo: formatWorkspaceRepoSummary(written.repos[0]!),
  };
}

async function addWorkspaceRepo(
  args: readonly string[],
  options: ResolvedCliOptions,
) {
  const parsed = parseWorkspaceAddArgs(args);

  if ("error" in parsed) {
    throw new Error(parsed.error);
  }

  const alias = normalizeWorkspaceAlias(parsed.alias, "Workspace repo alias");
  const workspace = await readWorkspaceConfigForCommand(parsed.workspaceRepoPath, options);
  const targetPath = path.resolve(options.cwd, parsed.repoPath);

  if (!await isExistingDirectory(targetPath)) {
    throw new Error(`Repo path does not exist or is not a directory: ${targetPath}`);
  }

  const detection = await detectRepoRoot(targetPath);
  const repoRoot = detection.repoRoot;

  if (workspace.repos.some((repo) => repo.alias === alias)) {
    throw new Error(`Workspace repo alias already exists: ${alias}`);
  }

  if (workspace.repos.some((repo) => path.resolve(repo.rootPath) === repoRoot)) {
    throw new Error(`Workspace repo rootPath already exists: ${repoRoot}`);
  }

  // Two spellings of one worktree — a symlink, or a path that canonicalises onto
  // an existing member — are one member, not two (§44). Registering it twice
  // would give the same authoritative index two aliases and two lock claims.
  const identityRecord = await captureRepoIdentityRecord(repoRoot);
  const registry = await resolveWorkspaceRegistry({ config: workspace });
  const duplicate = registry.repositories.find((repo) => repo.worktreeId === identityRecord.worktreeId);

  if (duplicate !== undefined) {
    throw new Error(
      `Workspace repo ${duplicate.alias} is already the same worktree (${duplicate.rootPath}).`,
    );
  }

  const serializableWorkspace = formatWorkspaceConfigForWrite(workspace);
  const updated = await writeWorkspaceConfig(workspace.configPath, {
    ...serializableWorkspace,
    repos: [
      ...serializableWorkspace.repos,
      {
        alias,
        rootPath: repoRoot,
        enabled: true,
        ...identityRecord,
      },
    ],
  });

  return {
    action: "added",
    workspace: formatWorkspaceSummary(updated),
    addedRepo: formatWorkspaceRepoSummary(updated.repos.find((repo) => repo.alias === alias)!),
  };
}

async function listWorkspaceRepos(
  args: readonly string[],
  options: ResolvedCliOptions,
) {
  const parsed = parseWorkspaceRepoLocatorArgs(args, "workspace list [repo]");

  if ("error" in parsed) {
    throw new Error(parsed.error);
  }

  const workspace = await readWorkspaceConfigForCommand(parsed.repoPath, options);

  return {
    workspace: formatWorkspaceSummary(workspace),
    repos: workspace.repos.map(formatWorkspaceRepoSummary),
  };
}

async function statusWorkspaceRepos(
  args: readonly string[],
  options: ResolvedCliOptions,
) {
  const parsed = parseWorkspaceRepoLocatorArgs(args, "workspace status [repo]");

  if ("error" in parsed) {
    throw new Error(parsed.error);
  }

  const workspace = await readWorkspaceConfigForCommand(parsed.repoPath, options);
  const statuses = await Promise.all(workspace.repos.map((repo) => inspectWorkspaceRepoStatus(repo)));
  const registry = await resolveWorkspaceRegistry({ config: workspace });
  const readiness = await evaluateWorkspaceReadiness(registry);
  const byAlias = new Map(readiness.repos.map((repo) => [repo.alias, repo]));

  return {
    workspace: {
      ...formatWorkspaceSummary(workspace),
      workspaceId: registry.workspaceId,
      // A count, never a single boolean: one stale member must stay visible.
      summary: {
        total: readiness.total,
        ready: readiness.ready,
        stale: readiness.stale,
        missing: readiness.missing,
        mismatched: readiness.mismatched,
        unavailable: readiness.unavailable,
      },
    },
    repos: statuses.map((status) => {
      const resolved = byAlias.get(status.repoAlias);

      return {
        alias: status.repoAlias,
        rootPath: status.repoRoot,
        enabled: status.enabled,
        configExists: status.configPresent,
        stateExists: status.statePresent,
        indexExists: status.indexPresent,
        readiness: status.readiness,
        reason: status.notReadyReason,
        identity: resolved === undefined ? null : {
          repositoryId: resolved.repositoryId,
          worktreeId: resolved.worktreeId,
          registration: resolved.registration,
          ready: resolved.ready,
          indexState: resolved.index?.state ?? null,
        },
      };
    }),
  };
}

async function readWorkspaceConfigForCommand(
  repoPath: string,
  options: ResolvedCliOptions,
): Promise<ResolvedWorkspaceConfig> {
  const detection = await detectRepoRoot(path.resolve(options.cwd, repoPath));
  const configPath = resolveWorkspaceConfigPath(detection.repoRoot);

  if (!await isExistingFile(configPath)) {
    throw new Error(`Workspace config not found: ${configPath}. Run \`vtrace workspace init ${detection.repoRoot}\` first.`);
  }

  return await readWorkspaceConfig(configPath);
}

function parseWorkspaceInitArgs(
  args: readonly string[],
): { repoPath: string; alias?: string } | { error: string } {
  let repoPath = ".";
  let alias: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--alias") {
      alias = args[index + 1];

      if (alias === undefined || alias.startsWith("--")) {
        return { error: "Usage: workspace init [repo] [--alias <alias>]" };
      }

      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      return { error: "Usage: workspace init [repo] [--alias <alias>]" };
    }

    if (repoPath !== ".") {
      return { error: "Usage: workspace init [repo] [--alias <alias>]" };
    }

    repoPath = argument;
  }

  return {
    repoPath,
    ...(alias === undefined ? {} : { alias }),
  };
}

function parseWorkspaceAddArgs(
  args: readonly string[],
): { alias: string; repoPath: string; workspaceRepoPath: string } | { error: string } {
  let workspaceRepoPath = ".";
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--repo") {
      const value = args[index + 1];

      if (value === undefined || value.startsWith("--")) {
        return { error: "Usage: workspace add <alias> <path> [--repo <workspace-repo>]" };
      }

      workspaceRepoPath = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      return { error: "Usage: workspace add <alias> <path> [--repo <workspace-repo>]" };
    }

    positional.push(argument);
  }

  if (positional.length !== 2) {
    return { error: "Usage: workspace add <alias> <path> [--repo <workspace-repo>]" };
  }

  return {
    alias: positional[0]!,
    repoPath: positional[1]!,
    workspaceRepoPath,
  };
}

function parseWorkspaceRepoLocatorArgs(
  args: readonly string[],
  usage: string,
): { repoPath: string } | { error: string } {
  if (args.length > 1 || args.some((argument) => argument.startsWith("--"))) {
    return { error: `Usage: ${usage}` };
  }

  return {
    repoPath: args[0] ?? ".",
  };
}

async function isExistingFile(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

function formatWorkspaceSummary(workspace: ResolvedWorkspaceConfig) {
  return {
    configPath: workspace.configPath,
    name: workspace.name ?? null,
    primaryRepoAlias: workspace.primaryRepoAlias,
    repoCount: workspace.repos.length,
  };
}

function formatWorkspaceRepoSummary(repo: ResolvedWorkspaceConfig["repos"][number]) {
  return {
    alias: repo.alias,
    rootPath: repo.rootPath,
    enabled: repo.enabled,
  };
}

async function isExistingDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

function formatCommandError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
