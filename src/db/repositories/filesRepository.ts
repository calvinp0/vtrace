import type { Database } from "bun:sqlite";

import {
  normalizeFilePath,
  type FilePath,
  type FileRecord,
} from "../../domain/types";

interface FileRow {
  id: string;
  path: string;
  language: string;
  content_hash: string;
  size_bytes: number;
}

export function replaceFile(db: Database, file: FileRecord): void {
  deleteFile(db, file);
  insertFile(db, file);
}

export function insertFile(db: Database, file: FileRecord): void {
  const normalizedPath = normalizeFilePath(file.path);

  db.run(
    `
      INSERT INTO files (id, path, language, content_hash, size_bytes)
      VALUES (?, ?, ?, ?, ?)
    `,
    [file.id, normalizedPath, file.language, file.contentHash, file.sizeBytes],
  );
}

export function deleteFile(db: Database, file: Pick<FileRecord, "id" | "path">): void {
  db.run(
    `
      DELETE FROM files
      WHERE id = ? OR path = ?
    `,
    [file.id, normalizeFilePath(file.path)],
  );
}

export function deleteFileByPath(db: Database, filePath: FilePath): void {
  db.run(
    `
      DELETE FROM files
      WHERE path = ?
    `,
    [normalizeFilePath(filePath)],
  );
}

export function listAllFilePaths(db: Database): FilePath[] {
  const rows = db.query(`
    SELECT path
    FROM files
    ORDER BY path
  `).all() as Array<{ path: string }>;

  return rows.map((row) => row.path);
}

export function getFileByPath(
  db: Database,
  filePath: FilePath,
): FileRecord | undefined {
  const row = db.query(`
    SELECT id, path, language, content_hash, size_bytes
    FROM files
    WHERE path = ?
  `).get(normalizeFilePath(filePath)) as FileRow | null;

  return row === null ? undefined : fileRowToRecord(row);
}

export function hasIndexedFiles(db: Database): boolean {
  const row = db.query(`
    SELECT 1 AS has_file
    FROM files
    LIMIT 1
  `).get() as { has_file: number } | null;

  return row !== null;
}

function fileRowToRecord(row: FileRow): FileRecord {
  return {
    id: row.id,
    path: row.path,
    language: row.language as FileRecord["language"],
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
  };
}
