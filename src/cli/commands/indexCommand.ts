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
): { repoPath: string; json: boolean } | { error: string } {
  let repoPath: string | undefined;
  let json = false;

  for (const argument of args) {
    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument.startsWith("--")) {
      return { error: "Usage: index <repo> [--json]" };
    }

    if (repoPath !== undefined) {
      return { error: "Usage: index <repo> [--json]" };
    }

    repoPath = argument;
  }

  if (repoPath === undefined) {
    return { error: "Usage: index <repo> [--json]" };
  }

  return { repoPath, json };
}
