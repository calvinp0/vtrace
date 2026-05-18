import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import type { CommandResult, ResolvedCliOptions } from "../types";
import {
  detectRepoRoot,
  readRepoLocalConfig,
  resolveRepoLocalPaths,
} from "../../setup/repoState";

export interface ResolvedRepoCommandPaths {
  requestedPath: string;
  repoRoot: string;
  dbPath: string;
  configPath: string;
  statePath: string;
  configPresent: boolean;
  usesDbPathOverride: boolean;
  dbExists: boolean;
}

export function resolveOptions(options: {
  cwd?: string;
  dbPath?: string;
} = {}): ResolvedCliOptions {
  return {
    cwd: path.resolve(options.cwd ?? process.cwd()),
    dbPath: options.dbPath,
  };
}

export function resolveDatabasePath(
  options: ResolvedCliOptions,
  repoRoot?: string,
): string {
  if (options.dbPath !== undefined) {
    return path.resolve(options.cwd, options.dbPath);
  }

  const basePath = repoRoot === undefined ? options.cwd : repoRoot;
  return resolveRepoLocalPaths(basePath).dbPath;
}

export async function resolveRepoCommandPaths(
  options: ResolvedCliOptions,
  repoPath: string,
): Promise<ResolvedRepoCommandPaths> {
  const requestedPath = path.resolve(options.cwd, repoPath);
  const detection = await detectRepoRoot(requestedPath);
  const repoLocalPaths = resolveRepoLocalPaths(detection.repoRoot);

  if (options.dbPath !== undefined) {
    const dbPath = resolveDatabasePath(options, detection.repoRoot);

    return {
      requestedPath,
      repoRoot: detection.repoRoot,
      dbPath,
      configPath: repoLocalPaths.configPath,
      statePath: repoLocalPaths.statePath,
      configPresent: await isExistingFile(repoLocalPaths.configPath),
      usesDbPathOverride: true,
      dbExists: await isExistingFile(dbPath),
    };
  }

  try {
    const config = await readRepoLocalConfig(repoLocalPaths.configPath);

    return {
      requestedPath,
      repoRoot: config.repoRoot,
      dbPath: config.dbPath,
      configPath: repoLocalPaths.configPath,
      statePath: repoLocalPaths.statePath,
      configPresent: true,
      usesDbPathOverride: false,
      dbExists: await isExistingFile(config.dbPath),
    };
  } catch {
    return {
      requestedPath,
      repoRoot: detection.repoRoot,
      dbPath: repoLocalPaths.dbPath,
      configPath: repoLocalPaths.configPath,
      statePath: repoLocalPaths.statePath,
      configPresent: false,
      usesDbPathOverride: false,
      dbExists: await isExistingFile(repoLocalPaths.dbPath),
    };
  }
}

export async function ensureDatabaseDirectory(dbPath: string): Promise<void> {
  if (dbPath === ":memory:") {
    return;
  }

  await mkdir(path.dirname(dbPath), { recursive: true });
}

export async function isExistingDirectory(targetPath: string): Promise<boolean> {
  try {
    const stats = await stat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export async function isExistingFile(targetPath: string): Promise<boolean> {
  try {
    const stats = await stat(targetPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

export function success(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

export function successJson(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

export function failure(message: string): CommandResult {
  return { exitCode: 1, stdout: "", stderr: `${message}\n` };
}

export function failureJson(stdout: string): CommandResult {
  return { exitCode: 1, stdout, stderr: "" };
}

export function formatUserFacingFailure(
  title: string,
  reason: string,
  nextStep: string,
): string {
  return [
    title,
    `Reason: ${reason}`,
    `Next: ${nextStep}`,
  ].join("\n");
}
