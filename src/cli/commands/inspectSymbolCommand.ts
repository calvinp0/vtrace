import { listEdgesForSymbol } from "../../db/repositories/edgesRepository";
import { getSymbolById } from "../../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import { formatInspectSymbol } from "../formatters";
import type { CliOptions, CommandResult } from "../types";
import {
  failure,
  resolveDatabasePath,
  resolveOptions,
  success,
} from "./helpers";

export async function runInspectSymbolCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  if (args.length !== 1) {
    return failure("Usage: inspect-symbol <id>");
  }

  const resolvedOptions = resolveOptions(options);
  const symbolId = args[0] as string;
  const dbPath = resolveDatabasePath(resolvedOptions);

  try {
    const db = openIndexerDatabase(dbPath);

    try {
      const symbol = getSymbolById(db, symbolId);

      if (symbol === undefined) {
        return failure(`Symbol not found: ${symbolId}`);
      }

      return success(formatInspectSymbol({
        symbol,
        edges: listEdgesForSymbol(db, symbolId),
      }));
    } finally {
      db.close();
    }
  } catch (error) {
    return failure(formatCommandError("inspect-symbol failed", error));
  }
}

function formatCommandError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
