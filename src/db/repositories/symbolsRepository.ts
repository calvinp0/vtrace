import type { Database } from "bun:sqlite";

import {
  normalizeFilePath,
  type FilePath,
  type FileRecord,
  type SymbolRecord,
} from "../../domain/types";

interface SymbolRow {
  id: string;
  file_path: string;
  fq_name: string;
  local_name: string;
  kind: string;
  signature: string;
  start_line: number;
  end_line: number;
  start_byte: number;
  end_byte: number;
  parent_symbol_id: string | null;
  exported: number;
  docstring: string | null;
  decorators: string | null;
}

export function deleteSymbolsForFile(db: Database, fileId: string): void {
  db.run("DELETE FROM symbols WHERE file_id = ?", [fileId]);
}

export function insertSymbolsForFile(
  db: Database,
  file: FileRecord,
  symbols: readonly SymbolRecord[],
): void {
  const normalizedPath = normalizeFilePath(file.path);

  for (const symbol of symbols) {
    if (normalizeFilePath(symbol.filePath) !== normalizedPath) {
      throw new Error(`Symbol ${symbol.id} does not belong to file ${normalizedPath}`);
    }

    db.run(
      `
        INSERT INTO symbols (
          id,
          file_id,
          fq_name,
          local_name,
          kind,
          signature,
          start_line,
          end_line,
          start_byte,
          end_byte,
          parent_symbol_id,
          exported,
          docstring,
          decorators
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        symbol.id,
        file.id,
        symbol.fqName,
        symbol.localName,
        symbol.kind,
        symbol.signature,
        symbol.startLine,
        symbol.endLine,
        symbol.startByte,
        symbol.endByte,
        symbol.parentSymbolId ?? null,
        symbol.exported ? 1 : 0,
        symbol.docstring ?? null,
        symbol.decorators === undefined ? null : JSON.stringify(symbol.decorators),
      ],
    );
  }
}

export function listSymbolsForFile(
  db: Database,
  filePath: FilePath,
): SymbolRecord[] {
  const rows = db.query(`
    SELECT
      symbols.id,
      files.path AS file_path,
      symbols.fq_name,
      symbols.local_name,
      symbols.kind,
      symbols.signature,
      symbols.start_line,
      symbols.end_line,
      symbols.start_byte,
      symbols.end_byte,
      symbols.parent_symbol_id,
      symbols.exported,
      symbols.docstring,
      symbols.decorators
    FROM symbols
    INNER JOIN files ON files.id = symbols.file_id
    WHERE files.path = ?
    ORDER BY symbols.start_byte ASC, symbols.id ASC
  `).all(normalizeFilePath(filePath)) as SymbolRow[];

  return rows.map(symbolRowToRecord);
}

export function listAllSymbols(db: Database): SymbolRecord[] {
  const rows = db.query(`
    SELECT
      symbols.id,
      files.path AS file_path,
      symbols.fq_name,
      symbols.local_name,
      symbols.kind,
      symbols.signature,
      symbols.start_line,
      symbols.end_line,
      symbols.start_byte,
      symbols.end_byte,
      symbols.parent_symbol_id,
      symbols.exported,
      symbols.docstring,
      symbols.decorators
    FROM symbols
    INNER JOIN files ON files.id = symbols.file_id
    ORDER BY files.path ASC, symbols.fq_name ASC, symbols.kind ASC, symbols.start_byte ASC, symbols.end_byte ASC, symbols.id ASC
  `).all() as SymbolRow[];

  return rows.map(symbolRowToRecord);
}

// Symbols whose file lives directly under `directory` (same package/module
// folder), e.g. directory "django/db/models" returns aggregates.py + query.py
// symbols but NOT django/db/models/sql/compiler.py symbols. A trailing slash is
// normalised on; an empty directory matches repo-root files. Used by graph
// expansion to surface same-module neighbours that no edge connects.
export function listSymbolsUnderDirectory(
  db: Database,
  directory: string,
): SymbolRecord[] {
  const normalized = directory.replace(/\/+$/, "");
  const prefix = normalized.length === 0 ? "" : `${normalized}/`;
  const rows = db.query(`
    SELECT
      symbols.id,
      files.path AS file_path,
      symbols.fq_name,
      symbols.local_name,
      symbols.kind,
      symbols.signature,
      symbols.start_line,
      symbols.end_line,
      symbols.start_byte,
      symbols.end_byte,
      symbols.parent_symbol_id,
      symbols.exported,
      symbols.docstring,
      symbols.decorators
    FROM symbols
    INNER JOIN files ON files.id = symbols.file_id
    WHERE files.path LIKE ? ESCAPE '\\'
      AND instr(substr(files.path, ?), '/') = 0
    ORDER BY files.path ASC, symbols.start_byte ASC, symbols.id ASC
  `).all(`${escapeLike(prefix)}%`, prefix.length + 1) as SymbolRow[];

  return rows.map(symbolRowToRecord);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function getSymbolById(
  db: Database,
  symbolId: string,
): SymbolRecord | undefined {
  const row = db.query(`
    SELECT
      symbols.id,
      files.path AS file_path,
      symbols.fq_name,
      symbols.local_name,
      symbols.kind,
      symbols.signature,
      symbols.start_line,
      symbols.end_line,
      symbols.start_byte,
      symbols.end_byte,
      symbols.parent_symbol_id,
      symbols.exported,
      symbols.docstring,
      symbols.decorators
    FROM symbols
    INNER JOIN files ON files.id = symbols.file_id
    WHERE symbols.id = ?
  `).get(symbolId) as SymbolRow | null;

  return row === null ? undefined : symbolRowToRecord(row);
}

export function listSymbolsByFqName(
  db: Database,
  fqName: string,
): SymbolRecord[] {
  const rows = db.query(`
    SELECT
      symbols.id,
      files.path AS file_path,
      symbols.fq_name,
      symbols.local_name,
      symbols.kind,
      symbols.signature,
      symbols.start_line,
      symbols.end_line,
      symbols.start_byte,
      symbols.end_byte,
      symbols.parent_symbol_id,
      symbols.exported,
      symbols.docstring,
      symbols.decorators
    FROM symbols
    INNER JOIN files ON files.id = symbols.file_id
    WHERE symbols.fq_name = ?
    ORDER BY files.path ASC, symbols.kind ASC, symbols.start_byte ASC, symbols.end_byte ASC, symbols.id ASC
  `).all(fqName) as SymbolRow[];

  return rows.map(symbolRowToRecord);
}

function symbolRowToRecord(row: SymbolRow): SymbolRecord {
  return {
    id: row.id,
    filePath: row.file_path,
    fqName: row.fq_name,
    localName: row.local_name,
    kind: row.kind as SymbolRecord["kind"],
    signature: row.signature,
    startLine: row.start_line,
    endLine: row.end_line,
    startByte: row.start_byte,
    endByte: row.end_byte,
    ...(row.parent_symbol_id === null ? {} : { parentSymbolId: row.parent_symbol_id }),
    exported: row.exported === 1,
    ...(row.docstring === null ? {} : { docstring: row.docstring }),
    ...(row.decorators === null ? {} : { decorators: parseDecorators(row.decorators) }),
  };
}

function parseDecorators(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Invalid decorators payload stored in symbols table");
  }

  return parsed;
}
