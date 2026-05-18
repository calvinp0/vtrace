import { hasIndexedFiles } from "../../db/repositories/filesRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import { routeQuery } from "../../intent/routeQuery";
import { formatIntentRouting } from "../formatters";
import type { CliOptions, CommandResult } from "../types";
import {
  failure,
  resolveRepoCommandPaths,
  resolveOptions,
  success,
} from "./helpers";

export async function runIntentCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  if (args.length < 2) {
    return failure("Usage: intent <repo> <query>");
  }

  const resolvedOptions = resolveOptions(options);
  const query = args.slice(1).join(" ").trim();

  if (query.length === 0) {
    return failure("Usage: intent <repo> <query>");
  }

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
      if (!hasIndexedFiles(db)) {
        return failure(`Repo not indexed: ${repoRoot}`);
      }

      return success(formatIntentRouting(routeQuery(db, query)));
    } finally {
      db.close();
    }
  } catch (error) {
    return failure(formatCommandError("intent failed", error));
  }
}

function formatCommandError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
