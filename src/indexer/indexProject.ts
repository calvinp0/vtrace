// @ts-nocheck
import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { nullProgressReporter } from "../cli/progress";
import { EdgeType, normalizeFilePath, type EdgeRecord, type ParseResult } from "../domain/types";
import { scanRepo } from "../fs/scanRepo";
import { insertEdges } from "../db/repositories/edgesRepository";
import {
  deleteFileByPath,
  listAllFilePaths,
} from "../db/repositories/filesRepository";
import { insertFileRunStates } from "../db/repositories/fileRunStatesRepository";
import { createIndexRun } from "../db/repositories/indexRunsRepository";
import { insertSymbolRunStates } from "../db/repositories/symbolRunStatesRepository";
import { deleteSymbolSearchIndexForFile } from "../db/repositories/symbolSearchFtsRepository";
import { persistParseResult } from "../db/persistParseResult";
import {
  ParserError,
  ParserErrorCode,
  createCythonParser,
  createPythonParser,
  createParserRegistry,
  createTypeScriptParser,
  type ParserRegistry,
} from "../parsers";
import type {
  IndexedFileSummary,
  IndexProjectFileContent,
  IndexProjectOptions,
  IndexProjectResult,
  IndexerFileError,
} from "./types";

export async function indexProject(options: IndexProjectOptions): Promise<IndexProjectResult> {
  const repoRoot = path.resolve(options.repoRoot);
  const progress = options.onProgress ?? nullProgressReporter;

  progress.report({ kind: "phase_begin", phase: "scan", label: "Scanning repo" });
  const scannedFiles = await scanRepo(repoRoot);
  progress.report({
    kind: "phase_end",
    phase: "scan",
    note: `${scannedFiles.length} files`,
  });

  const files: IndexedFileSummary[] = [];
  const readableFiles: IndexProjectFileContent[] = [];

  progress.report({
    kind: "phase_begin",
    phase: "read",
    label: "Reading files",
    total: scannedFiles.length,
  });
  for (let index = 0; index < scannedFiles.length; index += 1) {
    const file = scannedFiles[index]!;
    const normalizedPath = normalizeFilePath(file.path);

    try {
      readableFiles.push({
        file: { ...file, path: normalizedPath },
        content: await readFile(path.join(repoRoot, normalizedPath), "utf8"),
      });
    } catch (error) {
      files.push({
        path: normalizedPath,
        language: file.language,
        status: "read_failed",
        diagnostics: [],
        error: makeIndexerFileError("read_failed", error),
      });
    }

    progress.report({
      kind: "phase_progress",
      phase: "read",
      index: index + 1,
      total: scannedFiles.length,
      item: normalizedPath,
    });
  }
  progress.report({ kind: "phase_end", phase: "read" });

  const registry = options.createParserRegistry === undefined
    ? createDefaultParserRegistry(readableFiles)
    : options.createParserRegistry(readableFiles);
  const successfulResults: ParseResult[] = [];
  const summariesByPath = new Map<string, IndexedFileSummary>();

  progress.report({
    kind: "phase_begin",
    phase: "parse",
    label: "Parsing files",
    total: readableFiles.length,
  });
  for (let index = 0; index < readableFiles.length; index += 1) {
    const fileContent = readableFiles[index]!;
    const parsed = await parseFile(registry, fileContent);

    if (!parsed.ok) {
      const summary = summaryForParserError(fileContent, parsed.error);
      summariesByPath.set(fileContent.file.path, summary);
    } else {
      successfulResults.push(parsed.result);
      summariesByPath.set(fileContent.file.path, {
        path: parsed.result.file.path,
        language: parsed.result.file.language,
        status: "indexed",
        diagnostics: parsed.result.diagnostics,
      });
    }

    progress.report({
      kind: "phase_progress",
      phase: "parse",
      index: index + 1,
      total: readableFiles.length,
      item: fileContent.file.path,
    });
  }
  progress.report({ kind: "phase_end", phase: "parse" });

  const persistedResults: ParseResult[] = [];

  progress.report({
    kind: "phase_begin",
    phase: "persist",
    label: "Persisting parse results",
    total: successfulResults.length,
  });
  for (let index = 0; index < successfulResults.length; index += 1) {
    const parseResult = successfulResults[index]!;
    const fileLocalResult = {
      ...parseResult,
      edges: parseResult.edges.filter((edge) => !isDeferredEdgeType(edge.edgeType)),
    };

    try {
      persistParseResult(options.db, fileLocalResult);
      persistedResults.push(parseResult);
    } catch (error) {
      summariesByPath.set(parseResult.file.path, {
        path: parseResult.file.path,
        language: parseResult.file.language,
        status: "persistence_failed",
        diagnostics: parseResult.diagnostics,
        error: makeIndexerFileError("persistence_failed", error),
      });
    }

    progress.report({
      kind: "phase_progress",
      phase: "persist",
      index: index + 1,
      total: successfulResults.length,
      item: parseResult.file.path,
    });
  }
  progress.report({ kind: "phase_end", phase: "persist" });

  pruneRemovedFiles(options.db, scannedFiles);

  progress.report({
    kind: "phase_begin",
    phase: "resolve_imports",
    label: "Resolving import edges",
  });
  persistResolvableInterFileEdges(options.db, persistedResults);
  recordIndexRunState(
    options.db,
    scannedFiles,
    persistedResults.flatMap((result) => result.symbols),
  );
  progress.report({ kind: "phase_end", phase: "resolve_imports" });

  const parsedSummaries = [...summariesByPath.values()];
  const allFiles = [...files, ...parsedSummaries]
    .sort((left, right) => left.path.localeCompare(right.path));
  const totalSymbols = persistedResults.reduce(
    (sum, result) => sum + result.symbols.length,
    0,
  );
  const totalRelationships = persistedResults.reduce(
    (sum, result) => sum + result.edges.length,
    0,
  );

  return {
    totalFilesScanned: scannedFiles.length,
    totalFilesAttemptedForParse: readableFiles.length,
    totalFilesSuccessfullyIndexed: allFiles.filter((file) => file.status === "indexed").length,
    totalParseFailures: allFiles.filter((file) => file.status === "parse_failed").length,
    totalSkippedUnregisteredLanguage: allFiles.filter((file) => {
      return file.status === "unregistered_language";
    }).length,
    totalSkippedUnsupportedLanguage: allFiles.filter((file) => {
      return file.status === "unsupported_language";
    }).length,
    totalReadFailures: allFiles.filter((file) => file.status === "read_failed").length,
    totalPersistenceFailures: allFiles.filter((file) => {
      return file.status === "persistence_failed";
    }).length,
    totalSymbols,
    totalRelationships,
    files: allFiles,
  };
}

function createDefaultParserRegistry(
  files: readonly IndexProjectFileContent[],
): ParserRegistry {
  return createParserRegistry([
    createTypeScriptParser({
      knownFiles: files.map((file) => ({
        path: file.file.path,
        content: file.content,
      })),
    }),
    createPythonParser({
      knownFiles: files.map((file) => ({
        path: file.file.path,
        content: file.content,
      })),
    }),
    createCythonParser({
      knownFiles: files.map((file) => ({
        path: file.file.path,
        content: file.content,
      })),
    }),
  ]);
}

async function parseFile(
  registry: ParserRegistry,
  fileContent: IndexProjectFileContent,
) {
  try {
    return await registry.parse({
      path: fileContent.file.path,
      content: fileContent.content,
      language: fileContent.file.language,
    });
  } catch (error) {
    return {
      ok: false as const,
      error: ParserError.parserFailed(
        fileContent.file.path,
        fileContent.file.language,
        error,
      ),
    };
  }
}

function summaryForParserError(
  fileContent: IndexProjectFileContent,
  error: ParserError,
): IndexedFileSummary {
  return {
    path: fileContent.file.path,
    language: fileContent.file.language,
    status: statusForParserError(error),
    diagnostics: [],
    error: error.toJSON(),
  };
}

function statusForParserError(error: ParserError): IndexedFileSummary["status"] {
  if (error.code === ParserErrorCode.UnregisteredLanguage) {
    return "unregistered_language";
  }

  if (error.code === ParserErrorCode.UnsupportedLanguage) {
    return "unsupported_language";
  }

  return "parse_failed";
}

function isDeferredEdgeType(edgeType: EdgeType): boolean {
  return edgeType === EdgeType.Imports
    || edgeType === EdgeType.Calls
    || edgeType === EdgeType.References;
}

function persistResolvableInterFileEdges(
  db: Database,
  parseResults: readonly ParseResult[],
): void {
  const persistedSymbolIds = new Set<string>();

  for (const parseResult of parseResults) {
    for (const symbol of parseResult.symbols) {
      persistedSymbolIds.add(symbol.id);
    }
  }

  const deferredEdgesById = new Map<string, EdgeRecord>();

  for (const parseResult of parseResults) {
    for (const edge of parseResult.edges) {
      if (
        isDeferredEdgeType(edge.edgeType)
        && persistedSymbolIds.has(edge.srcSymbolId)
        && persistedSymbolIds.has(edge.dstSymbolId)
      ) {
        deferredEdgesById.set(edge.id, edge);
      }
    }
  }

  const importEdges = [...deferredEdgesById.values()]
    .sort((left, right) => left.id.localeCompare(right.id));

  if (importEdges.length === 0) {
    return;
  }

  const transaction = db.transaction(() => {
    insertEdges(db, importEdges);
  });

  transaction();
}

// Removes live graph rows for files that are no longer scanned (deleted on disk
// or newly ignored), so the active files/symbols/edges tables represent the
// current repo state only. Symbols and edges cascade via ON DELETE CASCADE; the
// FTS index has no foreign key and is pruned explicitly. Run-history snapshots
// are computed from separate per-run tables and are left untouched.
function pruneRemovedFiles(
  db: Database,
  scannedFiles: readonly IndexProjectFileContent["file"][],
): void {
  const scannedPaths = new Set(scannedFiles.map((file) => normalizeFilePath(file.path)));
  const removedPaths = listAllFilePaths(db).filter((filePath) => !scannedPaths.has(filePath));

  if (removedPaths.length === 0) {
    return;
  }

  const transaction = db.transaction(() => {
    for (const filePath of removedPaths) {
      deleteSymbolSearchIndexForFile(db, { path: filePath });
      deleteFileByPath(db, filePath);
    }
  });

  transaction();
}

function recordIndexRunState(
  db: Database,
  scannedFiles: readonly IndexProjectFileContent["file"][],
  symbols: readonly ParseResult["symbols"][number][],
): void {
  const transaction = db.transaction(() => {
    const run = createIndexRun(db);
    insertFileRunStates(db, run.id, scannedFiles);
    insertSymbolRunStates(db, run.id, symbols);
  });

  transaction();
}

function makeIndexerFileError(code: string, error: unknown): IndexerFileError {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}
