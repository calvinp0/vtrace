import {
  getIndexRunSummary,
  listIndexRuns,
} from "../../db/repositories/indexRunsRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import { formatRuns } from "../formatters";
import type { CliOptions, CommandResult } from "../types";
import {
  failure,
  resolveRepoCommandPaths,
  resolveOptions,
  success,
} from "./helpers";

export async function runRunsCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  if (args.length !== 1) {
    return failure("Usage: runs <repo>");
  }

  const resolvedOptions = resolveOptions(options);

  let resolvedRepo;

  try {
    resolvedRepo = await resolveRepoCommandPaths(
      resolvedOptions,
      args[0] as string,
    );
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  const repoRoot = resolvedRepo.repoRoot;

  if (!resolvedRepo.dbExists) {
    return failure(`Repo not indexed: ${repoRoot}`);
  }

  try {
    const db = openIndexerDatabase(resolvedRepo.dbPath);

    try {
      const runs = listIndexRuns(db);

      if (runs.length === 0) {
        return failure(`Repo not indexed: ${repoRoot}`);
      }

      return success(formatRuns(
        runs.map((run) => getIndexRunSummary(db, run.id)!),
      ));
    } finally {
      db.close();
    }
  } catch (error) {
    return failure(formatCommandError("runs failed", error));
  }
}

function formatCommandError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
