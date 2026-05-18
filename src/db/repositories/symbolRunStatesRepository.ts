import type { Database } from "bun:sqlite";

import { normalizeFilePath, type SymbolRecord } from "../../domain/types";
import type { SymbolRunIdentitySummary, SymbolRunState } from "../../memory/types";

interface SymbolRunStateRow {
  run_id: number;
  symbol_id: string;
  file_path: string;
  fq_name: string;
  local_name: string;
  kind: string;
  signature: string;
  exported: number;
  parent_file_path: string | null;
  parent_fq_name: string | null;
  parent_kind: string | null;
  start_line: number;
  end_line: number;
  start_byte: number;
  end_byte: number;
}

export function insertSymbolRunStates(
  db: Database,
  runId: number,
  symbols: readonly SymbolRecord[],
): void {
  const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const sortedSymbols = [...symbols].sort(compareSymbolRecords);

  for (const symbol of sortedSymbols) {
    const parentIdentity = toParentIdentity(symbol.parentSymbolId, symbolsById);

    db.run(
      `
        INSERT INTO symbol_run_states (
          run_id,
          symbol_id,
          file_path,
          fq_name,
          local_name,
          kind,
          signature,
          exported,
          parent_file_path,
          parent_fq_name,
          parent_kind,
          start_line,
          end_line,
          start_byte,
          end_byte
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        runId,
        symbol.id,
        normalizeFilePath(symbol.filePath),
        symbol.fqName,
        symbol.localName,
        symbol.kind,
        symbol.signature,
        symbol.exported ? 1 : 0,
        parentIdentity?.filePath ?? null,
        parentIdentity?.fqName ?? null,
        parentIdentity?.kind ?? null,
        symbol.startLine,
        symbol.endLine,
        symbol.startByte,
        symbol.endByte,
      ],
    );
  }
}

export function listSymbolRunStatesForRun(
  db: Database,
  runId: number,
): SymbolRunState[] {
  const rows = db.query(`
    SELECT
      run_id,
      symbol_id,
      file_path,
      fq_name,
      local_name,
      kind,
      signature,
      exported,
      parent_file_path,
      parent_fq_name,
      parent_kind,
      start_line,
      end_line,
      start_byte,
      end_byte
    FROM symbol_run_states
    WHERE run_id = ?
    ORDER BY file_path ASC, fq_name ASC, kind ASC, start_byte ASC, end_byte ASC, symbol_id ASC
  `).all(runId) as SymbolRunStateRow[];

  return rows.map((row) => ({
    runId: row.run_id,
    symbolId: row.symbol_id,
    filePath: row.file_path,
    fqName: row.fq_name,
    localName: row.local_name,
    kind: row.kind as SymbolRunState["kind"],
    signature: row.signature,
    exported: row.exported === 1,
    ...(row.parent_file_path === null
      ? {}
      : {
        parentIdentity: {
          filePath: row.parent_file_path,
          fqName: row.parent_fq_name!,
          kind: row.parent_kind as SymbolRunIdentitySummary["kind"],
        },
      }),
    startLine: row.start_line,
    endLine: row.end_line,
    startByte: row.start_byte,
    endByte: row.end_byte,
  }));
}

function compareSymbolRecords(left: SymbolRecord, right: SymbolRecord): number {
  return normalizeFilePath(left.filePath).localeCompare(normalizeFilePath(right.filePath))
    || left.fqName.localeCompare(right.fqName)
    || left.kind.localeCompare(right.kind)
    || left.startByte - right.startByte
    || left.endByte - right.endByte
    || left.id.localeCompare(right.id);
}

function toParentIdentity(
  parentSymbolId: SymbolRecord["parentSymbolId"],
  symbolsById: ReadonlyMap<string, SymbolRecord>,
): SymbolRunIdentitySummary | undefined {
  if (parentSymbolId === undefined) {
    return undefined;
  }

  const parent = symbolsById.get(parentSymbolId);

  if (parent === undefined) {
    return undefined;
  }

  return {
    filePath: normalizeFilePath(parent.filePath),
    fqName: parent.fqName,
    kind: parent.kind,
  };
}
