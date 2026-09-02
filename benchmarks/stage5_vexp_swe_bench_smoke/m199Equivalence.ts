/**
 * M199 — full semantic projection of an index, and how two of them are compared. PURE.
 *
 * `normalizeGraph` is the product's own equivalence surface and is used as-is,
 * but it stops at symbols, edges and the two symbol FTS tables. A bounded
 * refresh can be wrong in three places it does not look — parser-observed call
 * sites, document chunks and per-file failures — so the projection here EXTENDS
 * it. Nothing is removed: dropping a field to make equality pass is the failure
 * mode this file exists to prevent (§19).
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { normalizeGraph, normalizedGraphHash } from "../../src/indexer/normalizedGraph";

export interface FullProjection {
  readonly sections: Readonly<Record<string, readonly unknown[]>>;
  readonly normalizedGraphHash: string;
}

export function fullSemanticProjection(db: Database): FullProjection {
  const graph = normalizeGraph(db);
  return {
    sections: {
      files: graph.files,
      symbols: graph.symbols,
      edges: graph.edges,
      symbolSearch: graph.symbolSearch,
      bodyLiterals: graph.bodyLiterals,
      mechanismFacts: graph.mechanismFacts,
      edgeCallSites: db.query(`
        SELECT edge_id, ordinal, start_line, start_column, end_line, end_column, precision
        FROM edge_call_sites ORDER BY edge_id, ordinal`).all(),
      documentChunks: db.query(`
        SELECT id, file_id, kind, content_hash, document_index_version,
               start_line, end_line, key_path, text, truncated
        FROM document_chunks ORDER BY file_id, id`).all(),
      documentSearch: db.query(`
        SELECT chunk_id, file_id, file_path_raw, kind, key_path, text, file_path
        FROM document_search_fts ORDER BY file_id, chunk_id`).all(),
      fileFailures: db.query(`
        SELECT path, language, status, failure_class, message, content_hash, size_bytes
        FROM file_index_failures ORDER BY path`).all(),
    },
    normalizedGraphHash: normalizedGraphHash(db),
  };
}

export interface SectionComparison {
  readonly section: string;
  readonly equal: boolean;
  readonly leftRows: number;
  readonly rightRows: number;
  /** First differing row, rendered, so a failure names the row and not just the table. */
  readonly firstDifference?: { readonly index: number; readonly left: unknown; readonly right: unknown };
}

export interface ProjectionComparison {
  readonly equal: boolean;
  readonly normalizedGraphHashEqual: boolean;
  readonly sections: readonly SectionComparison[];
}

export function compareProjections(left: FullProjection, right: FullProjection): ProjectionComparison {
  const sections: SectionComparison[] = Object.keys(left.sections).map((section) => {
    const l = left.sections[section] ?? [];
    const r = right.sections[section] ?? [];
    let firstDifference: SectionComparison["firstDifference"];
    for (let i = 0; i < Math.max(l.length, r.length); i += 1) {
      if (JSON.stringify(l[i] ?? null) !== JSON.stringify(r[i] ?? null)) {
        firstDifference = { index: i, left: l[i] ?? null, right: r[i] ?? null };
        break;
      }
    }
    return {
      section, equal: firstDifference === undefined && l.length === r.length,
      leftRows: l.length, rightRows: r.length,
      ...(firstDifference === undefined ? {} : { firstDifference }),
    };
  });
  return {
    equal: sections.every((s) => s.equal) && left.normalizedGraphHash === right.normalizedGraphHash,
    normalizedGraphHashEqual: left.normalizedGraphHash === right.normalizedGraphHash,
    sections,
  };
}

export function projectionHash(projection: FullProjection): string {
  return createHash("sha256").update(JSON.stringify(projection.sections)).digest("hex");
}

/** Rows a comparison should report without dumping a whole corpus into a JSON file. */
export function summarizeComparison(comparison: ProjectionComparison) {
  return {
    equal: comparison.equal,
    normalizedGraphHashEqual: comparison.normalizedGraphHashEqual,
    rowCounts: Object.fromEntries(comparison.sections.map((s) => [s.section, s.leftRows])),
    differingSections: comparison.sections.filter((s) => !s.equal).map((s) => ({
      section: s.section, leftRows: s.leftRows, rightRows: s.rightRows,
      firstDifference: s.firstDifference === undefined ? null : {
        index: s.firstDifference.index,
        left: JSON.stringify(s.firstDifference.left).slice(0, 400),
        right: JSON.stringify(s.firstDifference.right).slice(0, 400),
      },
    })),
  };
}
