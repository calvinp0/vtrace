import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { persistParseResult } from "../db/persistParseResult";
import { listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import {
  buildFQName,
  computeFileId,
  computeSymbolId,
  Language,
  SymbolKind,
  type ParseResult,
  type SymbolRecord,
} from "../domain/types";
import { indexProject } from "../indexer/indexProject";
import {
  extractFullSymbolSource,
  ExtractSymbolSourceStatus,
} from "./extractSymbolContent";
import { loadSymbolSource, LoadSymbolSourceStatus } from "./loadSymbolSource";

test("loadSymbolSource loads persisted symbol source and extracts the exact stored span", async () => {
  await withTempRepo(async (repoRoot) => {
    const filePath = "src/session.ts";
    const fileContents = `export class SessionManager {\n  createSession(accountId: string): string {\n    return accountId;\n  }\n}\n`;
    await writeRepoFile(repoRoot, filePath, fileContents);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      const symbol = findSymbol(listSymbolsForFile(db, filePath), "SessionManager");
      const result = loadSymbolSource(db, repoRoot, symbol.id);
      const extracted = extractFullSymbolSource(result);

      assert.equal(result.status, LoadSymbolSourceStatus.Loaded);
      assert.equal(result.absoluteFilePath, path.join(repoRoot, filePath));
      assert.equal(extracted.status, ExtractSymbolSourceStatus.Extracted);
      assert.equal(
        extracted.source,
        Buffer.from(fileContents, "utf8").subarray(symbol.startByte, symbol.endByte).toString("utf8"),
      );
    } finally {
      db.close();
    }
  });
});

test("loadSymbolSource reports missing_source_file deterministically when indexed source is gone", async () => {
  await withTempRepo(async (repoRoot) => {
    const filePath = "src/session.ts";
    await writeRepoFile(repoRoot, filePath, "export class SessionManager {}\n");
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const symbol = findSymbol(listSymbolsForFile(db, filePath), "SessionManager");
      await unlink(path.join(repoRoot, filePath));

      const result = loadSymbolSource(db, repoRoot, symbol.id);

      assert.equal(result.status, LoadSymbolSourceStatus.MissingSourceFile);
      assert.equal(result.symbol?.id, symbol.id);
      assert.equal(result.file?.path, filePath);
    } finally {
      db.close();
    }
  });
});

test("loadSymbolSource reports file_state_mismatch when repo contents no longer match indexed state", async () => {
  await withTempRepo(async (repoRoot) => {
    const filePath = "src/session.ts";
    await writeRepoFile(repoRoot, filePath, "export class SessionManager {}\n");
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const symbol = findSymbol(listSymbolsForFile(db, filePath), "SessionManager");
      await writeRepoFile(repoRoot, filePath, "export class SessionManager { create(): void {} }\n");

      const result = loadSymbolSource(db, repoRoot, symbol.id);

      assert.equal(result.status, LoadSymbolSourceStatus.FileStateMismatch);
      assert.equal(result.symbol?.id, symbol.id);
      assert.equal(result.file?.path, filePath);
    } finally {
      db.close();
    }
  });
});

test("extractFullSymbolSource reports invalid_span instead of crashing on mismatched stored spans", async () => {
  await withTempRepo(async (repoRoot) => {
    const filePath = "src/invalid.ts";
    const fileContents = "export const value = 1;\n";
    await writeRepoFile(repoRoot, filePath, fileContents);
    const db = openIndexerDatabase();

    try {
      persistParseResult(db, makeManualParseResult({
        filePath,
        fileContents,
        symbols: [
          {
            localName: "value",
            kind: SymbolKind.Function,
            signature: "function value(): number",
            startByte: 0,
            endByte: Buffer.byteLength(fileContents, "utf8") + 12,
          },
        ],
      }));

      const symbol = findSymbol(listSymbolsForFile(db, filePath), "value");
      const result = loadSymbolSource(db, repoRoot, symbol.id);
      const extracted = extractFullSymbolSource(result);

      assert.equal(result.status, LoadSymbolSourceStatus.Loaded);
      assert.equal(extracted.status, ExtractSymbolSourceStatus.InvalidSpan);
    } finally {
      db.close();
    }
  });
});

async function withTempRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vexb-capsule-source-"));

  try {
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function writeRepoFile(repoRoot: string, filePath: string, contents: string): Promise<void> {
  const absolutePath = path.join(repoRoot, filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
}

function findSymbol(symbols: readonly SymbolRecord[], localName: string): SymbolRecord {
  const symbol = symbols.find((candidate) => candidate.localName === localName);

  assert.notEqual(symbol, undefined);
  return symbol!;
}

function makeManualParseResult(input: {
  filePath: string;
  fileContents: string;
  symbols: Array<{
    localName: string;
    kind: SymbolKind;
    signature: string;
    startByte: number;
    endByte: number;
    docstring?: string;
  }>;
}): ParseResult {
  const fileBytes = Buffer.from(input.fileContents, "utf8");

  return {
    file: {
      id: computeFileId(input.filePath),
      path: input.filePath,
      language: Language.TypeScript,
      contentHash: createHash("sha256").update(fileBytes).digest("hex"),
      sizeBytes: fileBytes.length,
    },
    symbols: input.symbols.map((symbol) => {
      const fqName = buildFQName({
        filePath: input.filePath,
        symbolPath: [symbol.localName],
      });

      return {
        id: computeSymbolId({
          filePath: input.filePath,
          fqName,
          kind: symbol.kind,
          startByte: symbol.startByte,
          endByte: symbol.endByte,
        }),
        filePath: input.filePath,
        fqName,
        localName: symbol.localName,
        kind: symbol.kind,
        signature: symbol.signature,
        startLine: 1,
        endLine: 1,
        startByte: symbol.startByte,
        endByte: symbol.endByte,
        exported: true,
        ...(symbol.docstring === undefined ? {} : { docstring: symbol.docstring }),
      };
    }),
    edges: [],
    diagnostics: [],
  };
}
