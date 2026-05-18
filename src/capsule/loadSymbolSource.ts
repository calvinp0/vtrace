import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";

import { getFileByPath } from "../db/repositories/filesRepository";
import { getSymbolById } from "../db/repositories/symbolsRepository";
import type { FileRecord, SymbolRecord } from "../domain/types";

export enum LoadSymbolSourceStatus {
  Loaded = "loaded",
  MissingSymbol = "missing_symbol",
  MissingFileRecord = "missing_file_record",
  MissingSourceFile = "missing_source_file",
  ReadFailed = "read_failed",
  FileStateMismatch = "file_state_mismatch",
}

interface LoadSymbolSourceResultBase {
  status: LoadSymbolSourceStatus;
  symbolId: string;
  symbol?: SymbolRecord;
  file?: FileRecord;
  absoluteFilePath?: string;
}

export interface LoadedSymbolSourceResult extends LoadSymbolSourceResultBase {
  status: LoadSymbolSourceStatus.Loaded;
  symbol: SymbolRecord;
  file: FileRecord;
  absoluteFilePath: string;
  fileBytes: Buffer;
}

export type LoadSymbolSourceResult =
  | LoadedSymbolSourceResult
  | LoadSymbolSourceResultBase;

export function loadSymbolSource(
  db: Database,
  repoRoot: string,
  symbolId: string,
): LoadSymbolSourceResult {
  const symbol = getSymbolById(db, symbolId);

  if (symbol === undefined) {
    return {
      status: LoadSymbolSourceStatus.MissingSymbol,
      symbolId,
    };
  }

  const file = getFileByPath(db, symbol.filePath);

  if (file === undefined) {
    return {
      status: LoadSymbolSourceStatus.MissingFileRecord,
      symbolId,
      symbol,
    };
  }

  const absoluteFilePath = path.join(path.resolve(repoRoot), file.path);
  let fileBytes: Buffer;

  try {
    fileBytes = readFileSync(absoluteFilePath);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;

    return {
      status: code === "ENOENT"
        ? LoadSymbolSourceStatus.MissingSourceFile
        : LoadSymbolSourceStatus.ReadFailed,
      symbolId,
      symbol,
      file,
      absoluteFilePath,
    };
  }

  if (
    fileBytes.length !== file.sizeBytes
    || createHash("sha256").update(fileBytes).digest("hex") !== file.contentHash
  ) {
    return {
      status: LoadSymbolSourceStatus.FileStateMismatch,
      symbolId,
      symbol,
      file,
      absoluteFilePath,
    };
  }

  return {
    status: LoadSymbolSourceStatus.Loaded,
    symbolId,
    symbol,
    file,
    absoluteFilePath,
    fileBytes,
  };
}

export function isLoadedSymbolSource(
  result: LoadSymbolSourceResult,
): result is LoadedSymbolSourceResult {
  return result.status === LoadSymbolSourceStatus.Loaded;
}
