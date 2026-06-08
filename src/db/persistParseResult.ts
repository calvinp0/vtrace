import type { Database } from "bun:sqlite";

import {
  normalizeFilePath,
  type ParseResult,
} from "../domain/types";
import {
  replaceBodyLiteralsForFile,
  type SymbolBodyLiterals,
} from "./repositories/bodyLiteralsRepository";
import { insertEdges } from "./repositories/edgesRepository";
import { replaceFile } from "./repositories/filesRepository";
import { replaceSymbolSearchIndexForFile } from "./repositories/symbolSearchFtsRepository";
import { insertSymbolsForFile } from "./repositories/symbolsRepository";

export interface PersistParseResultOptions {
  /**
   * Pre-extracted distinctive body literals (diagnostic codes / messages) for the
   * file's symbols, built at index time from the raw file content (which a
   * `ParseResult` does not carry). When provided, the file's body-literal index is
   * replaced; when omitted, it is left untouched — legacy/test callers that do not
   * index bodies are unaffected.
   */
  readonly bodyLiterals?: readonly SymbolBodyLiterals[];
}

export function persistParseResult(
  db: Database,
  parseResult: ParseResult,
  options: PersistParseResultOptions = {},
): void {
  const normalizedPath = normalizeFilePath(parseResult.file.path);
  const file = {
    ...parseResult.file,
    path: normalizedPath,
  };
  const transaction = db.transaction(() => {
    replaceFile(db, file);
    insertSymbolsForFile(db, file, parseResult.symbols);
    replaceSymbolSearchIndexForFile(db, file, parseResult.symbols);
    if (options.bodyLiterals !== undefined) {
      replaceBodyLiteralsForFile(db, file, options.bodyLiterals);
    }
    insertEdges(db, parseResult.edges);
  });

  transaction();
}
