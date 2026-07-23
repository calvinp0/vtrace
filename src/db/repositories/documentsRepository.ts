import type { Database } from "bun:sqlite";

import type { IndexedDocumentChunk } from "../../documents/documentChunks";

export function replaceDocumentChunksForFile(
  db: Database,
  fileId: string,
  chunks: readonly IndexedDocumentChunk[],
): void {
  db.run("DELETE FROM document_search_fts WHERE file_id = ?", [fileId]);
  db.run("DELETE FROM document_chunks WHERE file_id = ?", [fileId]);
  const insertChunk = db.prepare(`
    INSERT INTO document_chunks
      (id, file_id, kind, content_hash, document_index_version, start_line, end_line, key_path, text, truncated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO document_search_fts
      (chunk_id, file_id, file_path_raw, kind, key_path, text, file_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const chunk of chunks) {
    insertChunk.run(
      chunk.id, chunk.fileId, chunk.kind, chunk.contentHash,
      chunk.documentIndexVersion, chunk.startLine, chunk.endLine,
      chunk.keyPath ?? "", chunk.text, chunk.truncated ? 1 : 0,
    );
    insertFts.run(
      chunk.id, chunk.fileId, chunk.path, chunk.kind,
      chunk.keyPath ?? "", chunk.text, chunk.path.replace(/[./_-]+/g, " "),
    );
  }
}

export function listDocumentChunks(db: Database): IndexedDocumentChunk[] {
  return db.query(`
    SELECT d.id, d.file_id, f.path, d.kind, d.content_hash, d.document_index_version,
           d.start_line, d.end_line, d.text, d.key_path, d.truncated
    FROM document_chunks d JOIN files f ON f.id = d.file_id
    ORDER BY f.path, d.start_line, d.id
  `).all().map(rowToChunk);
}

export function getDocumentChunk(db: Database, chunkId: string): IndexedDocumentChunk | undefined {
  const row = db.query(`
    SELECT d.id, d.file_id, f.path, d.kind, d.content_hash, d.document_index_version,
           d.start_line, d.end_line, d.text, d.key_path, d.truncated
    FROM document_chunks d JOIN files f ON f.id = d.file_id WHERE d.id = ?
  `).get(chunkId);
  return row === null ? undefined : rowToChunk(row);
}

function rowToChunk(value: unknown): IndexedDocumentChunk {
  const row = value as Record<string, string | number>;
  return {
    id: String(row.id),
    fileId: String(row.file_id),
    path: String(row.path),
    kind: String(row.kind) as IndexedDocumentChunk["kind"],
    contentHash: String(row.content_hash),
    documentIndexVersion: Number(row.document_index_version),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    text: String(row.text),
    ...(String(row.key_path).length === 0 ? {} : { keyPath: String(row.key_path) }),
    truncated: Number(row.truncated) === 1,
  };
}
