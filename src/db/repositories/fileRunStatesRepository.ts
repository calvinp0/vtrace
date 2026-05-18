import type { Database } from "bun:sqlite";

import { normalizeFilePath, type FileRecord } from "../../domain/types";
import type { FileRunState } from "../../memory/types";

interface FileRunStateRow {
  run_id: number;
  file_id: string;
  path: string;
  language: string;
  content_hash: string;
  size_bytes: number;
}

export function insertFileRunStates(
  db: Database,
  runId: number,
  files: readonly FileRecord[],
): void {
  const sortedFiles = [...files].sort((left, right) => {
    return left.path.localeCompare(right.path) || left.id.localeCompare(right.id);
  });

  for (const file of sortedFiles) {
    db.run(
      `
        INSERT INTO file_run_states (
          run_id,
          file_id,
          path,
          language,
          content_hash,
          size_bytes
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        runId,
        file.id,
        normalizeFilePath(file.path),
        file.language,
        file.contentHash,
        file.sizeBytes,
      ],
    );
  }
}

export function listFileRunStatesForRun(
  db: Database,
  runId: number,
): FileRunState[] {
  const rows = db.query(`
    SELECT
      run_id,
      file_id,
      path,
      language,
      content_hash,
      size_bytes
    FROM file_run_states
    WHERE run_id = ?
    ORDER BY path ASC, file_id ASC
  `).all(runId) as FileRunStateRow[];

  return rows.map((row) => ({
    runId: row.run_id,
    fileId: row.file_id,
    path: row.path,
    language: row.language as FileRunState["language"],
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
  }));
}
