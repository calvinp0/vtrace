import type { Database } from "bun:sqlite";

import {
  normalizeFilePath,
  type FileRecord,
  type SymbolId,
} from "../../domain/types";

// One symbol's distinctive body literals, already extracted and joined into the
// searchable text stored in `symbol_body_literals_fts.literals`.
export interface SymbolBodyLiterals {
  readonly symbolId: SymbolId;
  readonly literalsText: string;
}

// A symbol recovered by a body-literal search.
export interface BodyLiteralSearchRow {
  readonly symbol_id: SymbolId;
  readonly file_path: string;
  readonly fq_name: string;
  readonly local_name: string;
}

export function deleteBodyLiteralsForFile(
  db: Database,
  file: Pick<FileRecord, "path">,
): void {
  db.run(
    `
      DELETE FROM symbol_body_literals_fts
      WHERE file_path_raw = ?
    `,
    [normalizeFilePath(file.path)],
  );
}

// Replace all body-literal rows for a file. `entries` carries only the symbols
// that actually had distinctive literals — symbols with none are simply absent.
export function replaceBodyLiteralsForFile(
  db: Database,
  file: Pick<FileRecord, "path">,
  entries: readonly SymbolBodyLiterals[],
): void {
  const normalizedPath = normalizeFilePath(file.path);
  deleteBodyLiteralsForFile(db, { path: normalizedPath });

  for (const entry of entries) {
    if (entry.literalsText.trim().length === 0) {
      continue;
    }
    db.run(
      `
        INSERT INTO symbol_body_literals_fts (
          symbol_id,
          file_path_raw,
          literals
        )
        VALUES (?, ?, ?)
      `,
      [entry.symbolId, normalizedPath, entry.literalsText],
    );
  }
}

// Search symbol bodies for a literal, via an FTS5 MATCH expression. Returns the
// emitting symbols joined to their file path. Deterministic ordering.
export function searchBodyLiterals(
  db: Database,
  matchExpr: string,
  maxResults: number,
): BodyLiteralSearchRow[] {
  if (matchExpr.trim().length === 0 || maxResults <= 0) {
    return [];
  }
  return db
    .query(
      `
        SELECT
          symbols.id AS symbol_id,
          files.path AS file_path,
          symbols.fq_name AS fq_name,
          symbols.local_name AS local_name
        FROM symbol_body_literals_fts
        INNER JOIN symbols ON symbols.id = symbol_body_literals_fts.symbol_id
        INNER JOIN files ON files.id = symbols.file_id
        WHERE symbol_body_literals_fts MATCH ?
        ORDER BY symbols.fq_name ASC, symbols.id ASC
        LIMIT ?
      `,
    )
    .all(matchExpr, maxResults) as BodyLiteralSearchRow[];
}
