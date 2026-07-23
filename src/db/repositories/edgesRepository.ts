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

/**
 * One cross-file edge endpoint as seen from an ANCHOR file: the other file, the
 * edge type, the symbol name on the anchor side, and the id/name/kind of the
 * symbol on the OTHER side. Powers file-level co-edit neighbour mining without
 * per-symbol round trips.
 */
export interface CrossFileEdgeEndpoint {
  otherPath: string;
  edgeType: EdgeRecord["edgeType"];
  anchorSymbolName: string;
  otherSymbolId: string;
  otherSymbolName: string;
  otherSymbolKind: string;
}

interface CrossFileEdgeRow {
  other_path: string;
  edge_type: string;
  anchor_name: string;
  other_symbol_id: string;
  other_name: string;
  other_kind: string;
}

/** Every edge with exactly one endpoint inside `filePath`, both directions. */
export function listCrossFileEdgeEndpointsForFile(
  db: Database,
  filePath: FilePath,
): CrossFileEdgeEndpoint[] {
  const normalized = normalizeFilePath(filePath);
  const rows = db.query(`
    SELECT other_path, edge_type, anchor_name, other_symbol_id, other_name, other_kind
    FROM (
      SELECT
        edges.id AS edge_id,
        other_files.path AS other_path,
        edges.edge_type AS edge_type,
        anchor_symbols.local_name AS anchor_name,
        other_symbols.id AS other_symbol_id,
        other_symbols.local_name AS other_name,
        other_symbols.kind AS other_kind
      FROM files AS anchor_files
      INNER JOIN symbols AS anchor_symbols ON anchor_symbols.file_id = anchor_files.id
      INNER JOIN edges ON edges.src_symbol_id = anchor_symbols.id
      INNER JOIN symbols AS other_symbols ON other_symbols.id = edges.dst_symbol_id
      INNER JOIN files AS other_files ON other_files.id = other_symbols.file_id
      WHERE anchor_files.path = ?1 AND other_files.path != ?1

      UNION ALL

      SELECT
        edges.id AS edge_id,
        other_files.path AS other_path,
        edges.edge_type AS edge_type,
        anchor_symbols.local_name AS anchor_name,
        other_symbols.id AS other_symbol_id,
        other_symbols.local_name AS other_name,
        other_symbols.kind AS other_kind
      FROM files AS anchor_files
      INNER JOIN symbols AS anchor_symbols ON anchor_symbols.file_id = anchor_files.id
      INNER JOIN edges ON edges.dst_symbol_id = anchor_symbols.id
      INNER JOIN symbols AS other_symbols ON other_symbols.id = edges.src_symbol_id
      INNER JOIN files AS other_files ON other_files.id = other_symbols.file_id
      WHERE anchor_files.path = ?1 AND other_files.path != ?1
    )
    ORDER BY edge_id ASC
  `).all(normalized) as CrossFileEdgeRow[];

  return rows.map((row) => ({
    otherPath: row.other_path,
    edgeType: row.edge_type as EdgeRecord["edgeType"],
    anchorSymbolName: row.anchor_name,
    otherSymbolId: row.other_symbol_id,
    otherSymbolName: row.other_name,
    otherSymbolKind: row.other_kind,
  }));
}

/**
 * How many DISTINCT other files `filePath` shares at least one edge with (either
 * direction). A cheap file-level fan-in/fan-out measure: a repo-wide utility
 * (`_api/__init__.py`) touches hundreds of files, a genuine co-edit sibling a
 * handful.
 */
export function countCrossFileNeighborFiles(db: Database, filePath: FilePath): number {
  const normalized = normalizeFilePath(filePath);
  const row = db.query(`
    SELECT COUNT(DISTINCT other_path) AS n
    FROM (
      SELECT other_files.path AS other_path
      FROM files AS anchor_files
      INNER JOIN symbols AS anchor_symbols ON anchor_symbols.file_id = anchor_files.id
      INNER JOIN edges ON edges.src_symbol_id = anchor_symbols.id
      INNER JOIN symbols AS other_symbols ON other_symbols.id = edges.dst_symbol_id
      INNER JOIN files AS other_files ON other_files.id = other_symbols.file_id
      WHERE anchor_files.path = ?1 AND other_files.path != ?1

      UNION ALL

      SELECT other_files.path AS other_path
      FROM files AS anchor_files
      INNER JOIN symbols AS anchor_symbols ON anchor_symbols.file_id = anchor_files.id
      INNER JOIN edges ON edges.dst_symbol_id = anchor_symbols.id
      INNER JOIN symbols AS other_symbols ON other_symbols.id = edges.src_symbol_id
      INNER JOIN files AS other_files ON other_files.id = other_symbols.file_id
      WHERE anchor_files.path = ?1 AND other_files.path != ?1
    )
  `).get(normalized) as { n: number } | undefined;
  return row?.n ?? 0;
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
