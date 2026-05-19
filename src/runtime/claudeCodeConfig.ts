import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildStableMcpLauncher,
  type LauncherCommand,
} from "./launcher";

const CLAUDE_CODE_CONFIG_FILENAME = ".claude.json" as const;
const CLAUDE_CODE_SERVER_NAME = "vtrace" as const;
const CLAUDE_CODE_CONFIG_PATH_ENV = "VTRACE_CLAUDE_CODE_CONFIG_PATH" as const;

interface ClaudeCodeMcpServerConfig {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ClaudeCodeConfigStatus {
  repoRoot: string;
  configPath: string;
  serverName: typeof CLAUDE_CODE_SERVER_NAME;
  launcher: LauncherCommand;
  installed: boolean;
  matchesExpected: boolean;
  error?: string;
}

export interface ClaudeCodeConfigInstallResult extends ClaudeCodeConfigStatus {
  action: "created" | "updated" | "unchanged";
  dryRun: boolean;
  config: Record<string, unknown>;
}

export function resolveClaudeCodeConfigPath(_repoRoot: string): string {
  const override = process.env[CLAUDE_CODE_CONFIG_PATH_ENV];

  if (typeof override === "string" && override.length > 0) {
    return path.resolve(override);
  }

  return path.join(os.homedir(), CLAUDE_CODE_CONFIG_FILENAME);
}

export async function getClaudeCodeConfigStatus(
  repoRoot: string,
): Promise<ClaudeCodeConfigStatus> {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const configPath = resolveClaudeCodeConfigPath(resolvedRepoRoot);
  const launcher = buildStableMcpLauncher(resolvedRepoRoot);

  try {
    const config = await readClaudeCodeConfig(configPath);
    const installedConfig = extractInstalledServerConfig(config, resolvedRepoRoot);
    const expectedConfig = buildClaudeCodeMcpServerConfig(resolvedRepoRoot);

    return {
      repoRoot: resolvedRepoRoot,
      configPath,
      serverName: CLAUDE_CODE_SERVER_NAME,
      launcher,
      installed: installedConfig !== undefined,
      matchesExpected: installedConfig !== undefined
        && areServerConfigsEqual(installedConfig, expectedConfig),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        repoRoot: resolvedRepoRoot,
        configPath,
        serverName: CLAUDE_CODE_SERVER_NAME,
        launcher,
        installed: false,
        matchesExpected: false,
      };
    }

    return {
      repoRoot: resolvedRepoRoot,
      configPath,
      serverName: CLAUDE_CODE_SERVER_NAME,
      launcher,
      installed: false,
      matchesExpected: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function writeClaudeCodeConfig(
  repoRoot: string,
  options: {
    dryRun?: boolean;
  } = {},
): Promise<ClaudeCodeConfigInstallResult> {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const configPath = resolveClaudeCodeConfigPath(resolvedRepoRoot);
  const launcher = buildStableMcpLauncher(resolvedRepoRoot);
  const expectedServerConfig = buildClaudeCodeMcpServerConfig(resolvedRepoRoot);
  const dryRun = options.dryRun ?? false;

  const existingConfig = await readClaudeCodeConfigOrEmpty(configPath);
  const installedConfig = extractInstalledServerConfig(existingConfig, resolvedRepoRoot);
  const projects = readOptionalObject(existingConfig.projects, "Claude Code projects");
  const existingProjectConfig = readOptionalObject(
    projects[resolvedRepoRoot],
    "Claude Code project entry",
  );
  const nextConfig = {
    ...existingConfig,
    projects: {
      ...projects,
      [resolvedRepoRoot]: {
        ...existingProjectConfig,
        mcpServers: {
          ...readOptionalObject(
            existingProjectConfig.mcpServers,
            "Claude Code project mcpServers",
          ),
          [CLAUDE_CODE_SERVER_NAME]: expectedServerConfig,
        },
      },
    },
  };

  const action = installedConfig === undefined
    ? "created"
    : areServerConfigsEqual(installedConfig, expectedServerConfig)
      ? "unchanged"
      : "updated";

  if (!dryRun && action !== "unchanged") {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  }

  return {
    repoRoot: resolvedRepoRoot,
    configPath,
    serverName: CLAUDE_CODE_SERVER_NAME,
    launcher,
    installed: true,
    matchesExpected: true,
    action,
    dryRun,
    config: nextConfig,
  };
}

function buildClaudeCodeMcpServerConfig(
  repoRoot: string,
): ClaudeCodeMcpServerConfig {
  const launcher = buildStableMcpLauncher(repoRoot);

  return {
    command: launcher.command,
    args: [...launcher.args],
    env: {},
    type: "stdio",
  };
}

async function readClaudeCodeConfigOrEmpty(
  configPath: string,
): Promise<Record<string, unknown>> {
  try {
    return await readClaudeCodeConfig(configPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }

    throw error;
  }
}

async function readClaudeCodeConfig(
  configPath: string,
): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;

  if (!isRecord(parsed)) {
    throw new Error(`Claude Code config must be a JSON object: ${configPath}`);
  }

  return parsed;
}

function extractInstalledServerConfig(
  config: Record<string, unknown>,
  repoRoot: string,
): ClaudeCodeMcpServerConfig | undefined {
  const projects = readOptionalObject(config.projects, "Claude Code projects");
  const projectConfig = readOptionalObject(
    projects[path.resolve(repoRoot)],
    "Claude Code project entry",
  );
  const mcpServers = readOptionalObject(
    projectConfig.mcpServers,
    "Claude Code project mcpServers",
  );
  const installed = mcpServers[CLAUDE_CODE_SERVER_NAME];

  if (!isRecord(installed)) {
    return undefined;
  }

  if (installed.type !== undefined && installed.type !== "stdio") {
    return undefined;
  }

  if (typeof installed.command !== "string" || !Array.isArray(installed.args)) {
    return undefined;
  }

  if (installed.args.some((value) => typeof value !== "string")) {
    return undefined;
  }

  const env = readOptionalStringRecord(installed.env, "Claude Code vtrace env");

  return {
    command: installed.command,
    args: [...installed.args] as string[],
    env,
    type: "stdio",
  };
}

function readOptionalObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object when present.`);
  }

  return value;
}

function readOptionalStringRecord(
  value: unknown,
  label: string,
): Record<string, string> {
  const object = readOptionalObject(value, label);

  for (const [key, entry] of Object.entries(object)) {
    if (typeof entry !== "string") {
      throw new Error(`${label}.${key} must be a string when present.`);
    }
  }

  return object as Record<string, string>;
}

function areServerConfigsEqual(
  left: ClaudeCodeMcpServerConfig,
  right: ClaudeCodeMcpServerConfig,
): boolean {
  return left.type === right.type
    && left.command === right.command
    && left.args.length === right.args.length
    && left.args.every((value, index) => value === right.args[index])
    && areStringRecordsEqual(left.env, right.env);
}

function areStringRecordsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);

  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value]) => right[key] === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
