import type { Database } from "bun:sqlite";

import {
  normalizeFilePath,
  type EdgeRecord,
  type FilePath,
} from "../../domain/types";

interface EdgeRow {
  id: string;
  src_symbol_id: string;
  dst_symbol_id: string;
  edge_type: string;
  confidence: number;
}

export function deleteEdgesTouchingFileSymbols(db: Database, fileId: string): void {
  db.run(
    `
      DELETE FROM edges
      WHERE src_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)
         OR dst_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)
    `,
    [fileId, fileId],
  );
}

export function insertEdges(
  db: Database,
  edges: readonly EdgeRecord[],
): void {
  for (const edge of edges) {
    db.run(
      `
        INSERT INTO edges (
          id,
          src_symbol_id,
          dst_symbol_id,
          edge_type,
          confidence
        )
        VALUES (?, ?, ?, ?, ?)
      `,
      [
        edge.id,
        edge.srcSymbolId,
        edge.dstSymbolId,
        edge.edgeType,
        edge.confidence,
      ],
    );
  }
}

export function listEdgesForFile(
  db: Database,
  filePath: FilePath,
): EdgeRecord[] {
  const rows = db.query(`
    SELECT
      edges.id,
      edges.src_symbol_id,
      edges.dst_symbol_id,
      edges.edge_type,
      edges.confidence
    FROM edges
    INNER JOIN symbols AS src_symbols ON src_symbols.id = edges.src_symbol_id
    INNER JOIN files ON files.id = src_symbols.file_id
    WHERE files.path = ?
    ORDER BY edges.id ASC
  `).all(normalizeFilePath(filePath)) as EdgeRow[];

  return rows.map(edgeRowToRecord);
}

export function listEdgesTouchingFile(
  db: Database,
  filePath: FilePath,
): EdgeRecord[] {
  const rows = db.query(`
    SELECT DISTINCT
      edges.id,
      edges.src_symbol_id,
      edges.dst_symbol_id,
      edges.edge_type,
      edges.confidence
    FROM edges
    INNER JOIN symbols AS src_symbols ON src_symbols.id = edges.src_symbol_id
    INNER JOIN symbols AS dst_symbols ON dst_symbols.id = edges.dst_symbol_id
    INNER JOIN files AS src_files ON src_files.id = src_symbols.file_id
    INNER JOIN files AS dst_files ON dst_files.id = dst_symbols.file_id
    WHERE src_files.path = ? OR dst_files.path = ?
    ORDER BY edges.id ASC
  `).all(normalizeFilePath(filePath), normalizeFilePath(filePath)) as EdgeRow[];

  return rows.map(edgeRowToRecord);
}

export function listEdgesForSymbol(
  db: Database,
  symbolId: string,
): EdgeRecord[] {
  const rows = db.query(`
    SELECT
      id,
      src_symbol_id,
      dst_symbol_id,
      edge_type,
      confidence
    FROM edges
    WHERE src_symbol_id = ? OR dst_symbol_id = ?
    ORDER BY id ASC
  `).all(symbolId, symbolId) as EdgeRow[];

  return rows.map(edgeRowToRecord);
}

export function listEdgesForSymbols(
  db: Database,
  symbolIds: readonly string[],
): EdgeRecord[] {
  const uniqueIds = [...new Set(symbolIds)].sort();

  if (uniqueIds.length === 0) {
    return [];
  }

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = db.query(`
    SELECT
      id,
      src_symbol_id,
      dst_symbol_id,
      edge_type,
      confidence
    FROM edges
    WHERE src_symbol_id IN (${placeholders}) OR dst_symbol_id IN (${placeholders})
    ORDER BY id ASC
  `).all(...uniqueIds, ...uniqueIds) as EdgeRow[];

  return rows.map(edgeRowToRecord);
}

export function listAllEdges(db: Database): EdgeRecord[] {
  const rows = db.query(`
    SELECT id, src_symbol_id, dst_symbol_id, edge_type, confidence
    FROM edges
    ORDER BY id ASC
  `).all() as EdgeRow[];

  return rows.map(edgeRowToRecord);
}

function edgeRowToRecord(row: EdgeRow): EdgeRecord {
  return {
    id: row.id,
    srcSymbolId: row.src_symbol_id,
    dstSymbolId: row.dst_symbol_id,
    edgeType: row.edge_type as EdgeRecord["edgeType"],
    confidence: row.confidence,
  };
}
