import { listEdgesTouchingFile } from "../../db/repositories/edgesRepository";
import { getFileByPath } from "../../db/repositories/filesRepository";
import { listSymbolsForFile } from "../../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import { normalizeFilePath } from "../../domain/types";
import { formatInspectFile } from "../formatters";
import type { CliOptions, CommandResult } from "../types";
import {
  failure,
  resolveDatabasePath,
  resolveOptions,
  success,
} from "./helpers";

export async function runInspectFileCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  if (args.length !== 1) {
    return failure("Usage: inspect-file <path>");
  }

  const resolvedOptions = resolveOptions(options);
  const filePath = normalizeFilePath(args[0] as string);
  const dbPath = resolveDatabasePath(resolvedOptions);

  try {
    const db = openIndexerDatabase(dbPath);

    try {
      const file = getFileByPath(db, filePath);

      if (file === undefined) {
        return failure(`File not found: ${filePath}`);
      }

      return success(formatInspectFile({
        file,
        symbols: listSymbolsForFile(db, filePath),
        edges: listEdgesTouchingFile(db, filePath),
      }));
    } finally {
      db.close();
    }
  } catch (error) {
    return failure(formatCommandError("inspect-file failed", error));
  }
}

function formatCommandError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
