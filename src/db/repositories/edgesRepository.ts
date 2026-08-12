import type { Database } from "bun:sqlite";

import {
  normalizeFilePath,
  type EdgeCallSite,
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
  // Sites are deleted explicitly rather than relying on the cascade:
  // `PRAGMA foreign_keys` is per-connection, so an incremental refresh on a
  // connection that never ran it would otherwise strand occurrence rows.
  db.run(
    `
      DELETE FROM edge_call_sites
      WHERE edge_id IN (
        SELECT id FROM edges
        WHERE src_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)
           OR dst_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)
      )
    `,
    [fileId, fileId],
  );
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

    for (const [ordinal, site] of (edge.callSites ?? []).entries()) {
      db.run(
        `
          INSERT INTO edge_call_sites (
            edge_id,
            ordinal,
            start_line,
            start_column,
            end_line,
            end_column,
            precision
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [edge.id, ordinal, site.startLine, site.startColumn, site.endLine, site.endColumn, site.precision],
      );
    }
  }
}

/** Probed once per connection: the answer cannot change while it is open. */
const EDGE_CALL_SITES_PRESENT = new WeakMap<Database, boolean>();

function hasEdgeCallSitesTable(db: Database): boolean {
  const cached = EDGE_CALL_SITES_PRESENT.get(db);

  if (cached !== undefined) {
    return cached;
  }

  const row = db.query(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'edge_call_sites' LIMIT 1",
  ).get() as { present: number } | null;
  const present = row !== null;
  EDGE_CALL_SITES_PRESENT.set(db, present);
  return present;
}

interface EdgeCallSiteRow {
  edge_id: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  precision: string;
}

/**
 * Parser-observed occurrences for the given edges, keyed by edge id and ordered
 * by position. Kept off the edge-row queries on purpose: frontier expansion
 * fetches thousands of edges and needs none of this, while path rendering needs
 * it for a handful.
 */
export function listCallSitesForEdges(
  db: Database,
  edgeIds: readonly string[],
): Map<string, EdgeCallSite[]> {
  const uniqueIds = [...new Set(edgeIds)].sort();
  const sitesByEdgeId = new Map<string, EdgeCallSite[]>();

  // An index written before occurrence capture has no table here, and a
  // read-only consumer cannot migrate one into existence. Absent provenance is
  // a supported state — consumers report `caller_span_scan` — so this must
  // degrade rather than throw.
  if (uniqueIds.length === 0 || !hasEdgeCallSitesTable(db)) {
    return sitesByEdgeId;
  }

  for (const chunk of chunked(uniqueIds, EDGE_ADJACENCY_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.query(`
      SELECT edge_id, start_line, start_column, end_line, end_column, precision
      FROM edge_call_sites
      WHERE edge_id IN (${placeholders})
      ORDER BY edge_id ASC, ordinal ASC
    `).all(...chunk) as EdgeCallSiteRow[];

    for (const row of rows) {
      const site: EdgeCallSite = {
        startLine: row.start_line,
        startColumn: row.start_column,
        endLine: row.end_line,
        endColumn: row.end_column,
        precision: row.precision === "line" ? "line" : "span",
      };
      const bucket = sitesByEdgeId.get(row.edge_id);

      if (bucket === undefined) {
        sitesByEdgeId.set(row.edge_id, [site]);
      } else {
        bucket.push(site);
      }
    }
  }

  return sitesByEdgeId;
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

/**
 * Largest number of bound parameters used in a single generated `IN (...)`
 * clause. SQLite's own ceiling is far higher, but a fixed modest chunk keeps
 * one prepared-statement shape reusable across frontier levels and keeps the
 * query planner on `idx_edges_src_symbol_id` / `idx_edges_dst_symbol_id`.
 */
export const EDGE_ADJACENCY_CHUNK_SIZE = 500;

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/**
 * Edges LEAVING any of `symbolIds`, fetched one batch per chunk rather than one
 * query per node. This is the outgoing half of indexed frontier expansion: the
 * cost tracks the frontier, not the size of the edge table (M131).
 */
export function listOutgoingEdgesForSymbols(
  db: Database,
  symbolIds: readonly string[],
): EdgeRecord[] {
  return listDirectedEdgesForSymbols(db, symbolIds, "src_symbol_id");
}

/** Edges ENTERING any of `symbolIds`. The incoming half of frontier expansion. */
export function listIncomingEdgesForSymbols(
  db: Database,
  symbolIds: readonly string[],
): EdgeRecord[] {
  return listDirectedEdgesForSymbols(db, symbolIds, "dst_symbol_id");
}

/**
 * Edges of ONE type entering any of `symbolIds`, with a per-target cap applied
 * **inside SQLite** rather than after the rows arrive.
 *
 * Upstream rescue (M140-B) expands incoming callers of a strong retrieval hit,
 * and a popular helper can have hundreds of them. Reading them all and slicing
 * afterwards would make the cost of a bounded question track the fan-in of the
 * most popular node it touched — the exact anti-pattern M130/M131 removed from
 * flow search. `ROW_NUMBER() OVER (PARTITION BY dst_symbol_id ...)` keeps the
 * bound where the data is, so a 1,000-caller helper costs the same as a
 * 10-caller one.
 *
 * Ordering by `id` makes the retained subset deterministic; when the cap bites,
 * callers must report it (the kept prefix is arbitrary with respect to
 * relevance, not a "most relevant" selection).
 */
export function listIncomingEdgesOfTypeForSymbols(
  db: Database,
  symbolIds: readonly string[],
  edgeType: string,
  perTargetLimit: number,
): EdgeRecord[] {
  const uniqueIds = [...new Set(symbolIds)].sort();
  const limit = Math.max(0, Math.floor(perTargetLimit));

  if (uniqueIds.length === 0 || limit === 0) {
    return [];
  }

  const records: EdgeRecord[] = [];

  for (const chunk of chunked(uniqueIds, EDGE_ADJACENCY_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.query(`
      WITH ranked AS (
        SELECT
          id,
          src_symbol_id,
          dst_symbol_id,
          edge_type,
          confidence,
          ROW_NUMBER() OVER (PARTITION BY dst_symbol_id ORDER BY id ASC) AS rn
        FROM edges
        WHERE dst_symbol_id IN (${placeholders}) AND edge_type = ?
      )
      SELECT id, src_symbol_id, dst_symbol_id, edge_type, confidence
      FROM ranked
      WHERE rn <= ?
      ORDER BY id ASC
    `).all(...chunk, edgeType, limit) as EdgeRow[];

    for (const row of rows) {
      records.push(edgeRowToRecord(row));
    }
  }

  return records;
}

/**
 * Incoming edges of one type per target, counted WITHOUT materialising them.
 * Lets a caller report true fan-in ("62 callers, 3 admitted") even when the
 * per-target cap kept it from reading them all.
 */
export function countIncomingEdgesOfTypeForSymbols(
  db: Database,
  symbolIds: readonly string[],
  edgeType: string,
): Map<string, number> {
  const uniqueIds = [...new Set(symbolIds)].sort();
  const counts = new Map<string, number>();
  for (const id of uniqueIds) {
    counts.set(id, 0);
  }
  if (uniqueIds.length === 0) {
    return counts;
  }

  for (const chunk of chunked(uniqueIds, EDGE_ADJACENCY_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.query(`
      SELECT dst_symbol_id, COUNT(*) AS n
      FROM edges
      WHERE dst_symbol_id IN (${placeholders}) AND edge_type = ?
      GROUP BY dst_symbol_id
    `).all(...chunk, edgeType) as Array<{ dst_symbol_id: string; n: number }>;

    for (const row of rows) {
      counts.set(row.dst_symbol_id, row.n);
    }
  }

  return counts;
}

function listDirectedEdgesForSymbols(
  db: Database,
  symbolIds: readonly string[],
  column: "src_symbol_id" | "dst_symbol_id",
): EdgeRecord[] {
  const uniqueIds = [...new Set(symbolIds)].sort();

  if (uniqueIds.length === 0) {
    return [];
  }

  const records: EdgeRecord[] = [];

  for (const chunk of chunked(uniqueIds, EDGE_ADJACENCY_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.query(`
      SELECT
        id,
        src_symbol_id,
        dst_symbol_id,
        edge_type,
        confidence
      FROM edges
      WHERE ${column} IN (${placeholders})
      ORDER BY id ASC
    `).all(...chunk) as EdgeRow[];

    for (const row of rows) {
      records.push(edgeRowToRecord(row));
    }
  }

  return records;
}

/**
 * How many edges the index holds. A COUNT so callers can report the size of the
 * searchable graph without materialising it.
 */
export function countEdges(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS n FROM edges").get() as { n: number } | null;
  return row === null ? 0 : row.n;
}

/**
 * Whether the index holds at least one edge of `edgeType` whose endpoints both
 * resolve to indexed symbols. Answers "is call-flow evidence available at all"
 * without loading the graph; `LIMIT 1` stops at the first hit.
 */
export function hasResolvableEdgeOfType(db: Database, edgeType: string): boolean {
  const row = db.query(`
    SELECT 1 AS present
    FROM edges
    INNER JOIN symbols AS src_symbols ON src_symbols.id = edges.src_symbol_id
    INNER JOIN symbols AS dst_symbols ON dst_symbols.id = edges.dst_symbol_id
    WHERE edges.edge_type = ?
    LIMIT 1
  `).get(edgeType) as { present: number } | null;
  // `.get()` yields null (not undefined) for an empty result set.
  return row !== null;
}

/**
 * Distinct files holding at least one symbol with an edge pointing at
 * `symbolId`. M139 uses this to narrow the unresolved-call-site search to files
 * the index already relates to the target's owning class, instead of scanning
 * the repository. The narrowing is deliberately relation-agnostic (a constructor
 * `calls` or a type `references` edge is as good a locality signal as an
 * `imports` edge), and it is lossy by construction: a file that reaches the
 * class only through a `TYPE_CHECKING`-guarded import has no indexed edge and is
 * therefore invisible here. Callers must report that as incomplete coverage
 * rather than as proof of absence.
 */
export function listFilePathsWithEdgeToSymbol(
  db: Database,
  symbolId: string,
): string[] {
  const rows = db.query(`
    SELECT DISTINCT files.path AS path
    FROM edges
    INNER JOIN symbols ON symbols.id = edges.src_symbol_id
    INNER JOIN files ON files.id = symbols.file_id
    WHERE edges.dst_symbol_id = ?
    ORDER BY files.path ASC
  `).all(symbolId) as Array<{ path: string }>;

  return rows.map((row) => row.path);
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
