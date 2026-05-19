import { reindexRepoAndRefreshState } from "../../runtime/reindexRepo";
import { formatIndexResult } from "../formatters";
import { selectProgressReporter } from "../progress";
import type { CliOptions, CommandResult } from "../types";
import {
  ensureDatabaseDirectory,
  failure,
  isExistingFile,
  resolveRepoCommandPaths,
  resolveOptions,
  success,
} from "./helpers";

export async function runIndexCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  if (args.length !== 1) {
    return failure("Usage: index <repo>");
  }

  const resolvedOptions = resolveOptions(options);

  try {
    const resolvedRepo = await resolveRepoCommandPaths(
      resolvedOptions,
      args[0] as string,
    );
    const repoRoot = resolvedRepo.repoRoot;
    const dbPath = resolvedRepo.dbPath;
    const statePresent = await isExistingFile(resolvedRepo.statePath);

    await ensureDatabaseDirectory(dbPath);
    const progress = selectProgressReporter({
      stream: process.stderr,
      env: process.env,
    });
    const result = await reindexRepoAndRefreshState({
      repoRoot,
      dbPath,
      statePath: resolvedRepo.statePath,
      configPresent: resolvedRepo.configPresent,
      statePresent,
      usesDbPathOverride: resolvedRepo.usesDbPathOverride,
      progress,
    });
    return success(formatIndexResult(result.indexResult));
  } catch (error) {
    return failure(formatCommandError("index failed", error));
  }
}

function formatCommandError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
