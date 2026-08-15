import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import { listAllEdges } from "../db/repositories/edgesRepository";
import { listAllSymbols } from "../db/repositories/symbolsRepository";

export interface NormalizedGraph {
  readonly files: readonly unknown[];
  readonly symbols: readonly unknown[];
  readonly edges: readonly unknown[];
  readonly symbolSearch: readonly unknown[];
  readonly bodyLiterals: readonly unknown[];
  /** M150 mechanism facts. Part of the graph identity: full and incremental
   * indexing must derive byte-identical facts or the equivalence gate fails. */
  readonly mechanismFacts: readonly unknown[];
}

export class GraphValidationError extends Error {
  constructor(cause: unknown) {
    super(`Graph validation failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "GraphValidationError";
  }
}

export function normalizeGraph(db: Database): NormalizedGraph {
  const files = db.query("SELECT path, language, content_hash, size_bytes FROM files ORDER BY path").all();
  const symbols = listAllSymbols(db).map((symbol) => ({
    filePath: symbol.filePath,
    fqName: symbol.fqName,
    localName: symbol.localName,
    kind: symbol.kind,
    signature: symbol.signature,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    startByte: symbol.startByte,
    endByte: symbol.endByte,
    parentSymbolId: symbol.parentSymbolId ?? null,
    exported: symbol.exported,
    docstring: symbol.docstring ?? null,
    decorators: symbol.decorators ?? [],
  }));
  const edges = listAllEdges(db).map((edge) => ({
    srcSymbolId: edge.srcSymbolId,
    dstSymbolId: edge.dstSymbolId,
    edgeType: edge.edgeType,
    confidence: edge.confidence,
  }));
  const symbolSearch = db.query(`
    SELECT symbol_id, file_path_raw, local_name, fq_name, signature, docstring, file_path
    FROM symbol_search_fts ORDER BY file_path_raw, symbol_id
  `).all();
  const bodyLiterals = db.query(`
    SELECT symbol_id, file_path_raw, literals
    FROM symbol_body_literals_fts ORDER BY file_path_raw, symbol_id
  `).all();
  const mechanismFacts = db.query(`
    SELECT symbol_id, file_path_raw, ordinal, kind, subject, line_offset, evidence, result_bearing
    FROM symbol_mechanism_facts ORDER BY file_path_raw, symbol_id, ordinal
  `).all();
  return { files, symbols, edges, symbolSearch, bodyLiterals, mechanismFacts };
}

export function normalizedGraphHash(db: Database): string {
  return createHash("sha256").update(JSON.stringify(normalizeGraph(db))).digest("hex");
}

export function validateGraph(db: Database, expectedFileCount: number): void {
  const fileCount = (db.query("SELECT COUNT(*) AS count FROM files").get() as { count: number }).count;
  if (fileCount !== expectedFileCount) throw new Error(`Graph file count ${fileCount} does not match snapshot ${expectedFileCount}`);
  const danglingEdges = (db.query(`
    SELECT COUNT(*) AS count FROM edges
    LEFT JOIN symbols src ON src.id = edges.src_symbol_id
    LEFT JOIN symbols dst ON dst.id = edges.dst_symbol_id
    WHERE src.id IS NULL OR dst.id IS NULL
  `).get() as { count: number }).count;
  if (danglingEdges !== 0) throw new Error(`Graph has ${danglingEdges} dangling edge(s)`);
  const danglingSearch = (db.query(`
    SELECT COUNT(*) AS count FROM symbol_search_fts
    LEFT JOIN symbols ON symbols.id = symbol_search_fts.symbol_id
    WHERE symbols.id IS NULL
  `).get() as { count: number }).count;
  if (danglingSearch !== 0) throw new Error(`Retrieval index has ${danglingSearch} dangling record(s)`);
}
