import type { Database } from "bun:sqlite";

import {
  normalizeFilePath,
  type FileRecord,
  type SymbolRecord,
} from "../../domain/types";
import { buildFtsSearchText } from "../../retrieval/searchSymbolsShared";

export function replaceSymbolSearchIndexForFile(
  db: Database,
  file: Pick<FileRecord, "path">,
  symbols: readonly SymbolRecord[],
): void {
  const normalizedPath = normalizeFilePath(file.path);

  db.run(
    `
      DELETE FROM symbol_search_fts
      WHERE file_path_raw = ?
    `,
    [normalizedPath],
  );

  for (const symbol of symbols) {
    if (normalizeFilePath(symbol.filePath) !== normalizedPath) {
      throw new Error(`Symbol ${symbol.id} does not belong to file ${normalizedPath}`);
    }

    db.run(
      `
        INSERT INTO symbol_search_fts (
          symbol_id,
          file_path_raw,
          local_name,
          fq_name,
          signature,
          docstring,
          file_path
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        symbol.id,
        normalizedPath,
        buildFtsSearchText(symbol.localName),
        buildFtsSearchText(symbol.fqName),
        buildFtsSearchText(symbol.signature),
        buildFtsSearchText(symbol.docstring ?? ""),
        buildFtsSearchText(normalizedPath),
      ],
    );
  }
}
