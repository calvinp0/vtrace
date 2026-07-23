import { createHash } from "node:crypto";

import {
  DOCUMENT_INDEX_VERSION,
  MAX_DOCUMENT_CHARS_PER_CHUNK,
  MAX_DOCUMENT_CHUNKS,
  type DocumentKind,
} from "./documentPolicy";

export interface IndexedDocumentChunk {
  id: string;
  fileId: string;
  path: string;
  kind: DocumentKind;
  contentHash: string;
  documentIndexVersion: number;
  startLine: number;
  endLine: number;
  text: string;
  keyPath?: string;
  truncated: boolean;
}

export function buildDocumentChunks(input: {
  fileId: string;
  path: string;
  kind: DocumentKind;
  contentHash: string;
  content: string;
}): IndexedDocumentChunk[] {
  const lines = input.content.replace(/\r\n?/g, "\n").split("\n");
  const boundaries = logicalBoundaries(lines, input.kind);
  const chunks: IndexedDocumentChunk[] = [];
  for (let boundaryIndex = 0; boundaryIndex < boundaries.length && chunks.length < MAX_DOCUMENT_CHUNKS; boundaryIndex += 1) {
    const boundary = boundaries[boundaryIndex]!;
    let cursor = boundary.start;
    while (cursor < boundary.end && chunks.length < MAX_DOCUMENT_CHUNKS) {
      let end = cursor;
      let characters = 0;
      while (end < boundary.end) {
        const next = lines[end] ?? "";
        if (end > cursor && characters + next.length + 1 > MAX_DOCUMENT_CHARS_PER_CHUNK) break;
        characters += next.length + 1;
        end += 1;
      }
      if (end === cursor) end += 1;
      const text = lines.slice(cursor, end).join("\n").trimEnd();
      if (text.trim().length > 0) {
        const startLine = cursor + 1;
        const endLine = end;
        chunks.push({
          id: stableId(input.fileId, startLine, endLine, boundary.keyPath),
          fileId: input.fileId,
          path: input.path,
          kind: input.kind,
          contentHash: input.contentHash,
          documentIndexVersion: DOCUMENT_INDEX_VERSION,
          startLine,
          endLine,
          text,
          ...(boundary.keyPath === undefined ? {} : { keyPath: boundary.keyPath }),
          truncated: end < boundary.end || (chunks.length + 1 >= MAX_DOCUMENT_CHUNKS && boundaryIndex + 1 < boundaries.length),
        });
      }
      cursor = end;
    }
  }
  return chunks;
}

function logicalBoundaries(lines: readonly string[], kind: DocumentKind): Array<{ start: number; end: number; keyPath?: string }> {
  const starts: Array<{ line: number; keyPath?: string }> = [{ line: 0 }];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const keyPath = kind === "toml"
      ? /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line)?.[1]
      : /^([A-Za-z0-9_.-]+):(?:\s|$)/u.exec(line)?.[1];
    if (keyPath !== undefined && index !== 0) starts.push({ line: index, keyPath });
    else if (keyPath !== undefined) starts[0] = { line: 0, keyPath };
  }
  return starts.map((start, index) => ({
    start: start.line,
    end: starts[index + 1]?.line ?? lines.length,
    ...(start.keyPath === undefined ? {} : { keyPath: start.keyPath }),
  }));
}

function stableId(fileId: string, startLine: number, endLine: number, keyPath?: string): string {
  return createHash("sha256")
    .update(`${fileId}\0${startLine}\0${endLine}\0${keyPath ?? ""}`)
    .digest("hex");
}
