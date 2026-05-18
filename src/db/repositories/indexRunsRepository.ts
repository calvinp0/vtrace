import type { Database } from "bun:sqlite";

import { computeFileDiff, summarizeFileDiffs } from "../../memory/computeFileDiff";
import { computeSymbolDiff, summarizeSymbolDiffs } from "../../memory/computeSymbolDiff";
import type {
  FileRunDiff,
  IndexRunRecord,
  IndexRunSummary,
  SymbolRunDiff,
} from "../../memory/types";
import { listFileRunStatesForRun } from "./fileRunStatesRepository";
import { listSymbolRunStatesForRun } from "./symbolRunStatesRepository";

interface IndexRunRow {
  id: number;
  previous_run_id: number | null;
  created_at_ms: number;
}

export function createIndexRun(
  db: Database,
  createdAtMs = Date.now(),
): IndexRunRecord {
  const previousRunId = getLatestIndexRun(db)?.id;

  db.run(
    `
      INSERT INTO index_runs (
        previous_run_id,
        created_at_ms
      )
      VALUES (?, ?)
    `,
    [previousRunId ?? null, createdAtMs],
  );

  return getLatestIndexRun(db)!;
}

export function getIndexRunById(
  db: Database,
  runId: number,
): IndexRunRecord | undefined {
  const row = db.query(`
    SELECT
      id,
      previous_run_id,
      created_at_ms
    FROM index_runs
    WHERE id = ?
  `).get(runId) as IndexRunRow | null;

  return row === null ? undefined : indexRunRowToRecord(row);
}

export function getLatestIndexRun(db: Database): IndexRunRecord | undefined {
  const row = db.query(`
    SELECT
      id,
      previous_run_id,
      created_at_ms
    FROM index_runs
    ORDER BY id DESC
    LIMIT 1
  `).get() as IndexRunRow | null;

  return row === null ? undefined : indexRunRowToRecord(row);
}

export function listIndexRuns(db: Database): IndexRunRecord[] {
  const rows = db.query(`
    SELECT
      id,
      previous_run_id,
      created_at_ms
    FROM index_runs
    ORDER BY id ASC
  `).all() as IndexRunRow[];

  return rows.map(indexRunRowToRecord);
}

export function listFileDiffsForRun(
  db: Database,
  runId: number,
): FileRunDiff[] | undefined {
  const run = getIndexRunById(db, runId);

  if (run === undefined) {
    return undefined;
  }

  return computeFileDiff({
    runId: run.id,
    previousRunId: run.previousRunId,
    currentStates: listFileRunStatesForRun(db, run.id),
    previousStates: run.previousRunId === undefined
      ? []
      : listFileRunStatesForRun(db, run.previousRunId),
  });
}

export function listSymbolDiffsForRun(
  db: Database,
  runId: number,
): SymbolRunDiff[] | undefined {
  const run = getIndexRunById(db, runId);

  if (run === undefined) {
    return undefined;
  }

  return computeSymbolDiff({
    runId: run.id,
    previousRunId: run.previousRunId,
    currentStates: listSymbolRunStatesForRun(db, run.id),
    previousStates: run.previousRunId === undefined
      ? []
      : listSymbolRunStatesForRun(db, run.previousRunId),
  });
}

export function getIndexRunSummary(
  db: Database,
  runId: number,
): IndexRunSummary | undefined {
  const run = getIndexRunById(db, runId);

  if (run === undefined) {
    return undefined;
  }

  const currentStates = listFileRunStatesForRun(db, run.id);
  const currentSymbolStates = listSymbolRunStatesForRun(db, run.id);
  const diffs = listFileDiffsForRun(db, run.id) ?? [];
  const symbolDiffs = listSymbolDiffsForRun(db, run.id) ?? [];

  return {
    ...run,
    totalFiles: currentStates.length,
    totalSymbols: currentSymbolStates.length,
    fileChangeCounts: summarizeFileDiffs(diffs),
    symbolChangeCounts: summarizeSymbolDiffs(symbolDiffs),
  };
}

function indexRunRowToRecord(row: IndexRunRow): IndexRunRecord {
  return {
    id: row.id,
    ...(row.previous_run_id === null ? {} : { previousRunId: row.previous_run_id }),
    createdAtMs: row.created_at_ms,
  };
}
