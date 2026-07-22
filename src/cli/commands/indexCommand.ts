import { reindexRepoAndRefreshState } from "../../runtime/reindexRepo";
import { formatIndexResult, formatIndexResultHuman } from "../formatters";
import { selectProgressReporter } from "../progress";
import type { CliOptions, CommandResult } from "../types";
import {
  ensureDatabaseDirectory,
  failure,
  formatUserFacingFailure,
  isExistingFile,
  resolveRepoCommandPaths,
  resolveOptions,
  success,
} from "./helpers";

export async function runIndexCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  const parsed = parseIndexArgs(args);

  if ("error" in parsed) {
    return failure(parsed.error);
  }

  const resolvedOptions = resolveOptions(options);

  try {
    const progress = selectProgressReporter({
      stream: process.stderr,
      env: process.env,
      isJsonOutput: parsed.json,
      quiet: parsed.quiet,
    });
    progress.report({ kind: "phase_begin", phase: "detect_repo", label: "Detecting repo root" });
    const resolvedRepo = await resolveRepoCommandPaths(
      resolvedOptions,
      parsed.repoPath,
    );
    const repoRoot = resolvedRepo.repoRoot;
    const dbPath = resolvedRepo.dbPath;
    progress.report({ kind: "phase_end", phase: "detect_repo", note: repoRoot });
    const statePresent = await isExistingFile(resolvedRepo.statePath);

    await ensureDatabaseDirectory(dbPath);
    const result = await reindexRepoAndRefreshState({
      repoRoot,
      dbPath,
      statePath: resolvedRepo.statePath,
      configPresent: resolvedRepo.configPresent,
      statePresent,
      usesDbPathOverride: resolvedRepo.usesDbPathOverride,
      progress,
      refreshMode: parsed.mode,
    });

    progress.report({ kind: "done", summary: "index complete" });

    if (parsed.json) {
      return success(formatIndexResult(result.indexResult));
    }

    return success(formatIndexResultHuman({
      repoRoot,
      dbPath,
      indexResult: result.indexResult,
      readinessStatus: result.state?.readiness.status,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(formatUserFacingFailure(
      "Indexing could not finish.",
      message,
      "Run `vtrace index <repo>` from inside the repo, or pass the repo path explicitly.",
    ));
  }
}

function parseIndexArgs(
  args: readonly string[],
): { repoPath: string; json: boolean; quiet: boolean; mode: "auto" | "incremental" | "full" } | { error: string } {
  const usage = "Usage: index <repo> [--repo-root <worktree>] [--json] [--mode auto|incremental|full] [--quiet|--no-progress]";
  let repoPath: string | undefined;
  let json = false;
  let quiet = false;
  let mode: "auto" | "incremental" | "full" = "auto";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument === "--quiet" || argument === "--no-progress") {
      quiet = true;
      continue;
    }

    if (argument === "--mode") {
      const value = args[index + 1];
      if (value !== "auto" && value !== "incremental" && value !== "full") return { error: usage };
      mode = value;
      index += 1;
      continue;
    }

    if (argument === "--repo-root") {
      const value = args[index + 1];
      if (typeof value !== "string" || value.startsWith("--") || repoPath !== undefined) {
        return { error: usage };
      }
      repoPath = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--repo-root=")) {
      const value = argument.slice("--repo-root=".length);
      if (value.length === 0 || repoPath !== undefined) {
        return { error: usage };
      }
      repoPath = value;
      continue;
    }

    if (argument.startsWith("--")) {
      return { error: usage };
    }

    if (repoPath !== undefined) {
      return { error: usage };
    }

    repoPath = argument;
  }

  if (repoPath === undefined) {
    return { error: usage };
  }

  return { repoPath, json, quiet, mode };
}
