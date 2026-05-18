import { getCapsuleManifestById, getCapsuleStaleness } from "../../db/repositories/capsuleManifestsRepository";
import {
  getIndexRunById,
  listIndexRuns,
} from "../../db/repositories/indexRunsRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import { formatCapsuleStaleness } from "../formatters";
import type { CliOptions, CommandResult } from "../types";
import {
  failure,
  resolveRepoCommandPaths,
  resolveOptions,
  success,
} from "./helpers";

export async function runCheckCapsuleCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  if (args.length !== 3) {
    return failure("Usage: check-capsule <repo> <manifest-id> <comparison-run-id>");
  }

  const resolvedOptions = resolveOptions(options);
  const manifestId = args[1] as string;
  const comparisonRunId = parseRunId(args[2] as string);

  if (comparisonRunId === undefined) {
    return failure(`Invalid comparison run id: ${args[2]}`);
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
      if (listIndexRuns(db).length === 0) {
        return failure(`Repo not indexed: ${repoRoot}`);
      }

      if (getCapsuleManifestById(db, manifestId) === undefined) {
        return failure(`Capsule manifest not found: ${manifestId}`);
      }

      if (getIndexRunById(db, comparisonRunId) === undefined) {
        return failure(`Index run not found: ${comparisonRunId}`);
      }

      return success(formatCapsuleStaleness(
        getCapsuleStaleness(db, manifestId, comparisonRunId)!,
      ));
    } finally {
      db.close();
    }
  } catch (error) {
    return failure(formatCommandError("check-capsule failed", error));
  }
}

function parseRunId(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }

  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function formatCommandError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
