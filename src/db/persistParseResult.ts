import type { Database } from "bun:sqlite";

import {
  normalizeFilePath,
  type ParseResult,
} from "../domain/types";
import { insertEdges } from "./repositories/edgesRepository";
import { replaceFile } from "./repositories/filesRepository";
import { replaceSymbolSearchIndexForFile } from "./repositories/symbolSearchFtsRepository";
import { insertSymbolsForFile } from "./repositories/symbolsRepository";

export function persistParseResult(db: Database, parseResult: ParseResult): void {
  const normalizedPath = normalizeFilePath(parseResult.file.path);
  const file = {
    ...parseResult.file,
    path: normalizedPath,
  };
  const transaction = db.transaction(() => {
    replaceFile(db, file);
    insertSymbolsForFile(db, file, parseResult.symbols);
    replaceSymbolSearchIndexForFile(db, file, parseResult.symbols);
    insertEdges(db, parseResult.edges);
  });

  transaction();
}
