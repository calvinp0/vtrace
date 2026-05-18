import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildStableMcpLauncher,
  type LauncherCommand,
} from "./launcher";

const CODEX_CONFIG_DIRNAME = ".codex" as const;
const CODEX_CONFIG_FILENAME = "config.toml" as const;
const CODEX_SERVER_NAME = "vexb" as const;
const CODEX_SERVER_TABLE = `[mcp_servers.${CODEX_SERVER_NAME}]` as const;

interface CodexMcpServerConfig {
  command: string;
  args: string[];
  cwd?: string;
}

export interface CodexConfigStatus {
  repoRoot: string;
  configPath: string;
  serverName: typeof CODEX_SERVER_NAME;
  launcher: LauncherCommand;
  installed: boolean;
  matchesExpected: boolean;
  error?: string;
}

export interface CodexConfigInstallResult extends CodexConfigStatus {
  action: "created" | "updated" | "unchanged";
  dryRun: boolean;
  config: string;
}

export function resolveCodexConfigPath(repoRoot: string): string {
  return path.join(
    path.resolve(repoRoot),
    CODEX_CONFIG_DIRNAME,
    CODEX_CONFIG_FILENAME,
  );
}

export async function getCodexConfigStatus(
  repoRoot: string,
): Promise<CodexConfigStatus> {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const configPath = resolveCodexConfigPath(resolvedRepoRoot);
  const launcher = buildStableMcpLauncher(resolvedRepoRoot);

  try {
    await assertCodexConfigLocationAvailable(resolvedRepoRoot);
    const config = await readCodexConfig(configPath);
    const installedConfig = extractInstalledServerConfig(config);
    const expectedConfig = buildCodexMcpServerConfig(resolvedRepoRoot);

    return {
      repoRoot: resolvedRepoRoot,
      configPath,
      serverName: CODEX_SERVER_NAME,
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
        serverName: CODEX_SERVER_NAME,
        launcher,
        installed: false,
        matchesExpected: false,
      };
    }

    return {
      repoRoot: resolvedRepoRoot,
      configPath,
      serverName: CODEX_SERVER_NAME,
      launcher,
      installed: false,
      matchesExpected: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function writeCodexConfig(
  repoRoot: string,
  options: {
    dryRun?: boolean;
  } = {},
): Promise<CodexConfigInstallResult> {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const configPath = resolveCodexConfigPath(resolvedRepoRoot);
  const launcher = buildStableMcpLauncher(resolvedRepoRoot);
  const expectedServerConfig = buildCodexMcpServerConfig(resolvedRepoRoot);
  const dryRun = options.dryRun ?? false;

  await assertCodexConfigLocationAvailable(resolvedRepoRoot);
  const existingConfig = await readCodexConfigOrEmpty(configPath);
  const installedConfig = extractInstalledServerConfig(existingConfig);
  const nextConfig = upsertCodexServerConfig(existingConfig, expectedServerConfig);

  const action = installedConfig === undefined
    ? "created"
    : areServerConfigsEqual(installedConfig, expectedServerConfig)
      ? "unchanged"
      : "updated";

  if (!dryRun && action !== "unchanged") {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, nextConfig);
  }

  return {
    repoRoot: resolvedRepoRoot,
    configPath,
    serverName: CODEX_SERVER_NAME,
    launcher,
    installed: true,
    matchesExpected: true,
    action,
    dryRun,
    config: nextConfig,
  };
}

function buildCodexMcpServerConfig(
  repoRoot: string,
): CodexMcpServerConfig {
  const launcher = buildStableMcpLauncher(repoRoot);

  return {
    command: launcher.command,
    args: [...launcher.args],
    cwd: path.resolve(repoRoot),
  };
}

async function assertCodexConfigLocationAvailable(
  repoRoot: string,
): Promise<void> {
  const configDirPath = path.join(path.resolve(repoRoot), CODEX_CONFIG_DIRNAME);
  const configPath = resolveCodexConfigPath(repoRoot);

  const configDirStats = await statOrUndefined(configDirPath);

  if (configDirStats !== undefined && !configDirStats.isDirectory()) {
    throw new Error(
      `Codex project config directory is blocked by a file: ${configDirPath}. Remove or rename it so vexb can write .codex/config.toml.`,
    );
  }

  const configPathStats = await statOrUndefined(configPath);

  if (configPathStats !== undefined && configPathStats.isDirectory()) {
    throw new Error(
      `Codex project config path is a directory, not a file: ${configPath}. Remove or rename it so vexb can write .codex/config.toml.`,
    );
  }
}

async function readCodexConfigOrEmpty(
  configPath: string,
): Promise<string> {
  try {
    return await readCodexConfig(configPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return "";
    }

    throw error;
  }
}

async function readCodexConfig(
  configPath: string,
): Promise<string> {
  return readFile(configPath, "utf8");
}

function extractInstalledServerConfig(
  config: string,
): CodexMcpServerConfig | undefined {
  const table = findTomlTable(config, CODEX_SERVER_TABLE);

  if (table === undefined) {
    return undefined;
  }

  const command = readTomlStringProperty(table.body, "command");
  const args = readTomlStringArrayProperty(table.body, "args");

  if (command === undefined || args === undefined) {
    return undefined;
  }

  const cwd = readTomlStringProperty(table.body, "cwd");

  return {
    command,
    args,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

function upsertCodexServerConfig(
  config: string,
  serverConfig: CodexMcpServerConfig,
): string {
  const nextBlock = formatCodexServerTable(serverConfig);
  const table = findTomlTable(config, CODEX_SERVER_TABLE);

  if (table === undefined) {
    const trimmedConfig = config.trimEnd();
    return trimmedConfig.length === 0
      ? `${nextBlock}\n`
      : `${trimmedConfig}\n\n${nextBlock}\n`;
  }

  const prefix = config.slice(0, table.start).trimEnd();
  const suffix = config.slice(table.end).trimStart();

  if (prefix.length === 0 && suffix.length === 0) {
    return `${nextBlock}\n`;
  }

  if (prefix.length === 0) {
    return `${nextBlock}\n\n${suffix}\n`;
  }

  if (suffix.length === 0) {
    return `${prefix}\n\n${nextBlock}\n`;
  }

  return `${prefix}\n\n${nextBlock}\n\n${suffix}\n`;
}

function formatCodexServerTable(
  serverConfig: CodexMcpServerConfig,
): string {
  return [
    CODEX_SERVER_TABLE,
    `command = ${formatTomlString(serverConfig.command)}`,
    `args = ${formatTomlStringArray(serverConfig.args)}`,
    ...(serverConfig.cwd === undefined ? [] : [`cwd = ${formatTomlString(serverConfig.cwd)}`]),
  ].join("\n");
}

function findTomlTable(
  config: string,
  tableHeader: string,
): {
  start: number;
  end: number;
  body: string;
} | undefined {
  const escapedHeader = escapeRegExp(tableHeader);
  const headerMatch = new RegExp(`^[ \\t]*${escapedHeader}[ \\t]*$`, "m").exec(config);

  if (headerMatch === null || headerMatch.index === undefined) {
    return undefined;
  }

  const start = headerMatch.index;
  const lineEnd = config.indexOf("\n", start);
  const bodyStart = lineEnd === -1 ? config.length : lineEnd + 1;
  const remaining = config.slice(bodyStart);
  const nextTableMatch = /^[ \t]*\[[^\n]+\][ \t]*$/m.exec(remaining);
  const end = nextTableMatch === null || nextTableMatch.index === undefined
    ? config.length
    : bodyStart + nextTableMatch.index;

  return {
    start,
    end,
    body: config.slice(bodyStart, end),
  };
}

function readTomlStringProperty(
  block: string,
  key: string,
): string | undefined {
  const rawValue = readTomlProperty(block, key);

  if (rawValue === undefined) {
    return undefined;
  }

  return parseTomlBasicString(rawValue);
}

function readTomlStringArrayProperty(
  block: string,
  key: string,
): string[] | undefined {
  const rawValue = readTomlProperty(block, key);

  if (rawValue === undefined) {
    return undefined;
  }

  return parseTomlStringArray(rawValue);
}

function readTomlProperty(
  block: string,
  key: string,
): string | undefined {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+)\\s*$`, "m").exec(block);

  return match === null ? undefined : match[1].trim();
}

function parseTomlBasicString(
  input: string,
): string | undefined {
  const trimmed = input.trim();

  if (!trimmed.startsWith("\"") || !trimmed.endsWith("\"")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return undefined;
  }
}

function parseTomlStringArray(
  input: string,
): string[] | undefined {
  const trimmed = input.trim();

  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return undefined;
  }

  const body = trimmed.slice(1, -1);
  const values: string[] = [];
  let index = 0;

  while (index < body.length) {
    index = skipWhitespace(body, index);

    if (index >= body.length) {
      break;
    }

    if (body[index] !== "\"") {
      return undefined;
    }

    const endIndex = findClosingQuote(body, index);

    if (endIndex === -1) {
      return undefined;
    }

    const value = parseTomlBasicString(body.slice(index, endIndex + 1));

    if (value === undefined) {
      return undefined;
    }

    values.push(value);
    index = skipWhitespace(body, endIndex + 1);

    if (index >= body.length) {
      break;
    }

    if (body[index] !== ",") {
      return undefined;
    }

    index += 1;
  }

  return values;
}

function findClosingQuote(
  input: string,
  startIndex: number,
): number {
  let escaped = false;

  for (let index = startIndex + 1; index < input.length; index += 1) {
    const character = input[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === "\"") {
      return index;
    }
  }

  return -1;
}

function skipWhitespace(
  input: string,
  index: number,
): number {
  let nextIndex = index;

  while (nextIndex < input.length && /\s/.test(input[nextIndex])) {
    nextIndex += 1;
  }

  return nextIndex;
}

function areServerConfigsEqual(
  left: CodexMcpServerConfig,
  right: CodexMcpServerConfig,
): boolean {
  return left.command === right.command
    && left.args.length === right.args.length
    && left.args.every((value, index) => value === right.args[index])
    && normalizeOptionalString(left.cwd) === normalizeOptionalString(right.cwd);
}

function normalizeOptionalString(value: string | undefined): string {
  return value ?? "";
}

function formatTomlString(
  value: string,
): string {
  return JSON.stringify(value);
}

function formatTomlStringArray(
  values: readonly string[],
): string {
  return `[${values.map((value) => formatTomlString(value)).join(", ")}]`;
}

function escapeRegExp(
  value: string,
): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

async function statOrUndefined(
  targetPath: string,
) {
  try {
    return await stat(targetPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}
