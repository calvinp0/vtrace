import type { Database } from "bun:sqlite";

import {
  normalizeFilePath,
  type FileRecord,
  type SymbolId,
} from "../../domain/types";
import type {
  MechanismFact,
  MechanismFactKind,
  SymbolMechanismFacts,
} from "../../indexer/extractMechanismFacts";

/** A stored mechanism fact joined to the definition that owns it. */
export interface MechanismFactRow {
  readonly symbol_id: SymbolId;
  readonly kind: MechanismFactKind;
  readonly subject: string;
  readonly line_offset: number;
  readonly evidence: string;
  readonly provenance: string;
  readonly result_bearing: number;
}

export function deleteMechanismFactsForFile(
  db: Database,
  file: Pick<FileRecord, "path">,
): void {
  db.run(
    `DELETE FROM symbol_mechanism_facts WHERE file_path_raw = ?`,
    [normalizeFilePath(file.path)],
  );
}

/**
 * Replace every mechanism-fact row for a file. Symbols whose bodies carry no
 * mechanism are simply absent — the table is sparse by design, so an ordinary
 * repository stores facts for a small minority of its definitions.
 */
export function replaceMechanismFactsForFile(
  db: Database,
  file: Pick<FileRecord, "path">,
  entries: readonly SymbolMechanismFacts[],
): void {
  const normalizedPath = normalizeFilePath(file.path);
  deleteMechanismFactsForFile(db, { path: normalizedPath });

  for (const entry of entries) {
    entry.facts.forEach((fact, ordinal) => {
      db.run(
        `
          INSERT INTO symbol_mechanism_facts (
            symbol_id, file_path_raw, ordinal, kind, subject, line_offset, evidence, provenance, result_bearing
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [entry.symbolId, normalizedPath, ordinal, fact.kind, fact.subject, fact.lineOffset, fact.evidence,
          fact.provenance, fact.resultBearing ? 1 : 0],
      );
    });
  }
}

/**
 * Every mechanism fact carried by the given symbols, keyed by symbol id.
 *
 * The caller supplies the symbol ids — always an already-bounded candidate pool —
 * so this can never become a repository-wide body scan (§94). One statement, one
 * index seek per id, no source read.
 */
export function loadMechanismFactsFor(
  db: Database,
  symbolIds: readonly SymbolId[],
): Map<SymbolId, MechanismFact[]> {
  const out = new Map<SymbolId, MechanismFact[]>();
  if (symbolIds.length === 0) return out;
  // An index written before M150 has no mechanism table at all. That is a
  // MISSING CAPABILITY, not a broken index (§51): every pre-M150 lane still
  // works on it, so retrieval degrades to exactly its pre-M150 behaviour rather
  // than failing. Probed once per request, not per chunk.
  if (!hasMechanismTable(db)) return out;
  // Chunked so a large pool cannot exceed SQLite's variable limit.
  const CHUNK = 400;
  for (let start = 0; start < symbolIds.length; start += CHUNK) {
    const chunk = symbolIds.slice(start, start + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .query(
        `
          SELECT symbol_id, kind, subject, line_offset, evidence, provenance, result_bearing
          FROM symbol_mechanism_facts
          WHERE symbol_id IN (${placeholders})
          ORDER BY symbol_id ASC, ordinal ASC
        `,
      )
      .all(...chunk) as MechanismFactRow[];
    for (const row of rows) {
      const facts = out.get(row.symbol_id) ?? [];
      facts.push({
        kind: row.kind,
        subject: row.subject,
        lineOffset: row.line_offset,
        evidence: row.evidence,
        provenance: row.provenance ?? "",
        resultBearing: row.result_bearing === 1,
      });
      out.set(row.symbol_id, facts);
    }
  }
  return out;
}

/** Does the stored index carry the mechanism table? Structural, not row-level. */
function hasMechanismTable(db: Database): boolean {
  const row = db
    .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbol_mechanism_facts'`)
    .get() as { name: string } | undefined;
  return row !== undefined;
}

/** Whether this index carries mechanism evidence at all (M141 capability probe). */
export function hasMechanismFacts(db: Database): boolean {
  if (!hasMechanismTable(db)) return false;
  const row = db
    .query(`SELECT 1 AS present FROM symbol_mechanism_facts LIMIT 1`)
    .get() as { present: number } | undefined;
  return row !== undefined;
}

/** Total stored facts. Reported by the scale artifact; never used in ranking. */
export function countMechanismFacts(db: Database): number {
  if (!hasMechanismTable(db)) return 0;
  const row = db
    .query(`SELECT COUNT(*) AS total FROM symbol_mechanism_facts`)
    .get() as { total: number };
  return row.total;
}
