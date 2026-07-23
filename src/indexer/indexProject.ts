// @ts-nocheck
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { nullProgressReporter } from "../cli/progress";
import { EdgeType, normalizeFilePath, type EdgeRecord, type ParseResult } from "../domain/types";
import { scanRepo } from "../fs/scanRepo";
import { listGitBlobShas, listGitStatusEntries } from "../fs/git";
import { insertEdges } from "../db/repositories/edgesRepository";
import { listAllEdges } from "../db/repositories/edgesRepository";
import {
  deleteFileByPath,
  listAllFilePaths,
} from "../db/repositories/filesRepository";
import { insertFileRunStates } from "../db/repositories/fileRunStatesRepository";
import { createIndexRun } from "../db/repositories/indexRunsRepository";
import { insertSymbolRunStates } from "../db/repositories/symbolRunStatesRepository";
import { deleteSymbolSearchIndexForFile } from "../db/repositories/symbolSearchFtsRepository";
import { deleteBodyLiteralsForFile } from "../db/repositories/bodyLiteralsRepository";
import { replaceDocumentChunksForFile } from "../db/repositories/documentsRepository";
import { persistParseResult } from "../db/persistParseResult";
import { listAllSymbols } from "../db/repositories/symbolsRepository";
import { buildSymbolBodyLiterals } from "./extractBodyLiterals";
import {
  ParserError,
  ParserErrorCode,
  createCythonParser,
  createPythonParser,
  createParserRegistry,
  createTypeScriptParser,
  type ParserRegistry,
} from "../parsers";
import {
  IndexingFileFailuresError,
  type IndexedFileSummary,
  type IndexProjectFileContent,
  type IndexProjectOptions,
  type IndexProjectResult,
  type IndexerFileError,
} from "./types";
import {
  FILE_SNAPSHOT_SCHEMA_VERSION,
  RETRIEVAL_SCHEMA_VERSION,
  computeBindingContextHash,
  computeSnapshotHash,
  computeSemanticContextHash,
  emptyTimings,
  planIncrementalRefresh,
  type IndexedFileSnapshot,
  type IndexedFileSnapshotSet,
  type IndexPerformanceDiagnostics,
} from "./incrementalIndex";
import {
  computeParseCacheKey,
  readParseCacheEntry,
  resolveRepositoryParseCacheRoot,
  writeParseCacheEntry,
  type ParseCacheKeyInput,
} from "./parseCache";
import { resolveWorktreeIdentity } from "./worktreeIdentity";
import { GraphValidationError, validateGraph } from "./normalizedGraph";
import { buildDocumentChunks } from "../documents/documentChunks";
import {
  DOCUMENT_INDEX_VERSION,
  documentKindForLanguage,
  isDocumentLanguage,
  isSafeDocumentContent,
} from "../documents/documentPolicy";

export async function indexProject(options: IndexProjectOptions): Promise<IndexProjectResult> {
  const totalStarted = performance.now();
  const repoRoot = path.resolve(options.repoRoot);
  const progress = options.onProgress ?? nullProgressReporter;
  const timings = emptyTimings();

  const discoveryStarted = performance.now();
  progress.report({ kind: "phase_begin", phase: "scan", label: "Scanning repo" });
  const scannedFiles = await scanRepo(repoRoot);
  const contentIdentities = await discoverContentIdentities(repoRoot, scannedFiles);
  timings.discovery = performance.now() - discoveryStarted;
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

  if (files.length > 0) {
    throw new IndexingFileFailuresError(files);
  }

  const parserVersion = options.parserVersion ?? "builtin-parser-v1";
  const parserConfigFingerprint = options.parserConfigFingerprint ?? "default-parser-config-v1";
  const registry = options.createParserRegistry === undefined
    ? createDefaultParserRegistry(readableFiles)
    : options.createParserRegistry(readableFiles);
  const parserRegistryFingerprint = computeParserRegistryFingerprint(registry);
  const registryIncompatible = options.previousSnapshot !== undefined
    && options.previousSnapshot.schemaVersion === FILE_SNAPSHOT_SCHEMA_VERSION
    && options.previousSnapshot.parserRegistryFingerprint !== parserRegistryFingerprint;
  const planningStarted = performance.now();
  let plan = planIncrementalRefresh({
    requestedMode: options.refreshMode ?? "auto",
    currentFiles: scannedFiles,
    previous: options.previousSnapshot,
    compatible: (options.previousSnapshotCompatible ?? true)
      && (options.previousSnapshot === undefined || (
        options.previousSnapshot.schemaVersion === FILE_SNAPSHOT_SCHEMA_VERSION
        && options.previousSnapshot.parserRegistryFingerprint === parserRegistryFingerprint
      )),
    ...((options.previousSnapshotCompatible === false || registryIncompatible || (options.previousSnapshot !== undefined && options.previousSnapshot.schemaVersion !== FILE_SNAPSHOT_SCHEMA_VERSION))
      ? { incompatibilityReason: options.incompatibilityReason ?? (registryIncompatible ? "parser_incompatible" : "schema_incompatible") }
      : {}),
  });
  if (plan.mode === "noop" && options.hasExistingGraph === false) {
    plan = { ...plan, mode: "incremental", affectedClosureFiles: [] };
  }
  timings.planning = performance.now() - planningStarted;

  if (plan.mode === "noop" && options.previousSnapshot !== undefined) {
    timings.total = performance.now() - totalStarted;
    const symbols = listAllSymbols(options.db);
    const edges = listAllEdges(options.db);
    // Preserve run-history semantics while leaving the live graph and both
    // retrieval indexes untouched.
    recordIndexRunState(options.db, scannedFiles, symbols);
    const noopFiles = options.previousSnapshot.files.map(summaryFromSnapshot);
    return {
      totalFilesScanned: scannedFiles.length,
      totalFilesAttemptedForParse: 0,
      totalFilesSuccessfullyIndexed: noopFiles.filter((file) => file.status === "indexed").length,
      totalParseFailures: 0,
      totalSkippedUnregisteredLanguage: noopFiles.filter((file) => file.status === "unregistered_language").length,
      totalSkippedUnsupportedLanguage: noopFiles.filter((file) => file.status === "unsupported_language").length,
      totalReadFailures: 0,
      totalPersistenceFailures: 0,
      totalSymbols: symbols.length,
      totalRelationships: edges.length,
      files: noopFiles,
      snapshot: options.previousSnapshot,
      performance: makePerformanceDiagnostics(
        plan, timings, scannedFiles.length, 0, 0, 0, options, 0, 0,
        noopFiles.filter((file) => file.status === "unregistered_language" || file.status === "unsupported_language").length,
      ),
    };
  }

  let successfulResults: ParseResult[] = [];
  const summariesByPath = new Map<string, IndexedFileSummary>();
  const identity = await resolveWorktreeIdentity(repoRoot);
  const cacheRoot = resolveRepositoryParseCacheRoot(identity);
  let parseCacheHits = 0;
  let parseCacheMisses = 0;
  let parsedFiles = 0;
  let unsupportedFilesCarriedForward = 0;
  let bindingContextHash = plan.mode === "incremental"
    ? options.previousSnapshot?.bindingContextHash ?? "unbound"
    : "unbound";
  const graphRowsDeleted = countLiveGraphRows(options.db);
  let graphRowsInserted = 0;
  const previousByPath = new Map(options.previousSnapshot?.files.map((file) => [file.relativePath, file]) ?? []);
  const fullParseCacheContextCompatible = options.previousSnapshot !== undefined
    && options.previousSnapshot.files.length === scannedFiles.length
    && scannedFiles.every((file) => {
      const previous = previousByPath.get(file.path);
      return previous !== undefined
        && previous.contentHash === file.contentHash
        && previous.language === file.language
        && previous.sizeBytes === file.sizeBytes;
    });
  const previousSymbols = listAllSymbols(options.db);
  const parseStarted = performance.now();

  progress.report({
    kind: "phase_begin",
    phase: "parse",
    label: "Parsing files",
    total: readableFiles.length,
  });
  const initialParsePaths = plan.mode === "incremental"
    ? new Set(plan.modified.map((change) => change.relativePath))
    : new Set(readableFiles
      .filter((file) => !canReuseFullParseCache(
        file,
        previousByPath.get(file.file.path),
        options,
        parserVersion,
        parserConfigFingerprint,
        parserRegistryFingerprint,
        fullParseCacheContextCompatible,
      ))
      .map((file) => file.file.path));
  parseCacheMisses += initialParsePaths.size;
  for (let index = 0; index < readableFiles.length; index += 1) {
    const fileContent = readableFiles[index]!;
    if (!initialParsePaths.has(fileContent.file.path)) {
      const previous = previousByPath.get(fileContent.file.path);
      if (plan.mode === "incremental" && previous?.indexOutcome === "skipped") {
        summariesByPath.set(fileContent.file.path, summaryFromSnapshot(previous));
        unsupportedFilesCarriedForward += 1;
        continue;
      }
      const cached = previous === undefined ? undefined : await readParseCacheEntry(cacheRoot, cacheInputFromSnapshot(previous));
      if (cached !== undefined) {
        successfulResults.push(cached);
        parseCacheHits += 1;
        summariesByPath.set(fileContent.file.path, { path: cached.file.path, language: cached.file.language, status: "indexed", diagnostics: cached.diagnostics });
        continue;
      }
      parseCacheMisses += 1;
    }
    const parsed = isDocumentLanguage(fileContent.file.language)
      ? { ok: true as const, result: emptyDocumentParseResult(fileContent) }
      : await parseFile(registry, fileContent);
    parsedFiles += 1;

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
  timings.parsing = performance.now() - parseStarted;

  if (plan.mode === "incremental") {
    const candidateSemanticHash = computeSemanticContextHash(successfulResults);
    if (candidateSemanticHash !== options.previousSnapshot?.semanticContextHash) {
      // IDs, signatures, exports, package surfaces, or path membership changed.
      // The existing graph cannot prove the complete reverse closure because
      // unresolved descriptors are not persisted, so rebuild every parse result.
      plan = { ...plan, mode: "full_rebuild", fullRebuildReason: "closure_uncertain", affectedClosureFiles: scannedFiles.map((file) => file.path) };
      successfulResults = [];
      summariesByPath.clear();
      parseCacheHits = 0;
      parseCacheMisses = readableFiles.length;
      parsedFiles = 0;
      unsupportedFilesCarriedForward = 0;
      const fallbackParseStarted = performance.now();
      for (const fileContent of readableFiles) {
        const parsed = isDocumentLanguage(fileContent.file.language)
          ? { ok: true as const, result: emptyDocumentParseResult(fileContent) }
          : await parseFile(registry, fileContent);
        parsedFiles += 1;
        if (!parsed.ok) summariesByPath.set(fileContent.file.path, summaryForParserError(fileContent, parsed.error));
        else {
          successfulResults.push(parsed.result);
          summariesByPath.set(fileContent.file.path, { path: parsed.result.file.path, language: parsed.result.file.language, status: "indexed", diagnostics: parsed.result.diagnostics });
        }
      }
      timings.parsing += performance.now() - fallbackParseStarted;
    }
  }
  if (plan.mode === "incremental") {
    successfulResults = rebindCachedEdgeTargets(successfulResults, previousSymbols);
  }
  bindingContextHash = computeBindingContextHash(successfulResults);
  const semanticContextHash = computeSemanticContextHash(successfulResults);

  const fatalFileFailures = [...summariesByPath.values()].filter(isFatalFileOutcome);
  if (fatalFileFailures.length > 0) {
    throw new IndexingFileFailuresError(fatalFileFailures);
  }

  for (const result of successfulResults) {
    const keyInput = makeCacheKeyInput(result, parserVersion, parserConfigFingerprint, bindingContextHash, contentIdentities.get(result.file.path));
    try {
      await writeParseCacheEntry(cacheRoot, keyInput, result);
    } catch {
      // Cache population is an optimization. A read-only/unavailable shared
      // cache must not prevent a correct isolated graph rebuild.
    }
  }

  const persistedResults: ParseResult[] = [];
  // Raw file content by path, so the persist loop can extract body literals
  // (symbols carry byte ranges, not text). The full content set is already held
  // in memory by `readableFiles` for the whole run.
  const contentByPath = new Map(readableFiles.map((rf) => [rf.file.path, rf.content]));

  progress.report({
    kind: "phase_begin",
    phase: "persist",
    label: "Persisting parse results",
    total: successfulResults.length,
  });
  const graphTransaction = options.db.transaction(() => {
    const invalidationStarted = performance.now();
    options.db.run("DELETE FROM symbol_search_fts");
    options.db.run("DELETE FROM symbol_body_literals_fts");
    options.db.run("DELETE FROM document_search_fts");
    options.db.run("DELETE FROM document_chunks");
    options.db.run("DELETE FROM edges");
    options.db.run("DELETE FROM symbols");
    options.db.run("DELETE FROM files");
    timings.invalidation = performance.now() - invalidationStarted;
    const persistenceStarted = performance.now();
    for (let index = 0; index < successfulResults.length; index += 1) {
      const parseResult = successfulResults[index]!;
      const fileLocalResult = { ...parseResult, edges: parseResult.edges.filter((edge) => !isDeferredEdgeType(edge.edgeType)) };
      const bodyLiterals = buildSymbolBodyLiterals(fileLocalResult.symbols, contentByPath.get(parseResult.file.path) ?? "");
      persistParseResult(options.db, fileLocalResult, { bodyLiterals });
      const documentKind = documentKindForLanguage(parseResult.file.language);
      if (documentKind !== undefined) {
        const content = contentByPath.get(parseResult.file.path) ?? "";
        replaceDocumentChunksForFile(
          options.db,
          parseResult.file.id,
          isSafeDocumentContent(content, parseResult.file.sizeBytes)
            ? buildDocumentChunks({
                fileId: parseResult.file.id,
                path: parseResult.file.path,
                kind: documentKind,
                contentHash: parseResult.file.contentHash,
                content,
              })
            : [],
        );
      }
      persistedResults.push(parseResult);
      progress.report({ kind: "phase_progress", phase: "persist", index: index + 1, total: successfulResults.length, item: parseResult.file.path });
    }
    timings.persistence = performance.now() - persistenceStarted;
    const linkingStarted = performance.now();
    persistResolvableInterFileEdges(options.db, persistedResults);
    timings.linking = performance.now() - linkingStarted;
    const validationStarted = performance.now();
    try {
      (options.validateGraph ?? validateGraph)(options.db, persistedResults.length);
    } catch (error) {
      throw new GraphValidationError(error);
    }
    timings.validation = performance.now() - validationStarted;
    recordIndexRunState(options.db, scannedFiles, persistedResults.flatMap((result) => result.symbols));
  });
  try {
    graphTransaction();
    graphRowsInserted = countLiveGraphRows(options.db);
  } catch (error) {
    for (const parseResult of successfulResults) {
      summariesByPath.set(parseResult.file.path, { path: parseResult.file.path, language: parseResult.file.language, status: "persistence_failed", diagnostics: parseResult.diagnostics, error: makeIndexerFileError("persistence_failed", error) });
    }
    throw error;
  }
  progress.report({ kind: "phase_end", phase: "persist" });

  progress.report({
    kind: "phase_begin",
    phase: "resolve_imports",
    label: "Resolving import edges",
  });
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

  const indexedSnapshotFiles: IndexedFileSnapshot[] = persistedResults.map((result) => {
    const identity = contentIdentities.get(result.file.path);
    const keyInput = makeCacheKeyInput(result, parserVersion, parserConfigFingerprint, bindingContextHash, identity);
    return {
      relativePath: result.file.path,
      language: result.file.language,
      contentHash: result.file.contentHash,
      contentKind: identity?.contentKind ?? "working_tree_hash",
      ...(identity?.gitBlobSha === undefined ? {} : { gitBlobSha: identity.gitBlobSha }),
      indexOutcome: "indexed",
      parserCapability: "supported",
      parserId: parserIdForLanguage(result.file.language),
      parserVersion,
      parserConfigFingerprint,
      bindingContextHash,
      parseCacheKey: computeParseCacheKey(keyInput),
      sizeBytes: result.file.sizeBytes,
      ...(documentKindForLanguage(result.file.language) === undefined
        ? {}
        : {
            documentKind: documentKindForLanguage(result.file.language),
            documentIndexVersion: DOCUMENT_INDEX_VERSION,
          }),
    };
  });
  const skippedSnapshotFiles: IndexedFileSnapshot[] = [...summariesByPath.values()]
    .filter((summary) => summary.status === "unregistered_language" || summary.status === "unsupported_language")
    .map((summary) => {
      const scanned = scannedFiles.find((file) => file.path === summary.path)!;
      const identity = contentIdentities.get(summary.path);
      return {
        relativePath: summary.path,
        language: summary.language,
        contentHash: scanned.contentHash,
        contentKind: identity?.contentKind ?? "working_tree_hash",
        ...(identity?.gitBlobSha === undefined ? {} : { gitBlobSha: identity.gitBlobSha }),
        indexOutcome: "skipped",
        parserCapability: summary.status === "unregistered_language" ? "unregistered" : "unsupported",
        bindingContextHash,
        sizeBytes: scanned.sizeBytes,
        diagnostic: {
          category: summary.status,
          message: summary.error?.message ?? summary.status,
        },
      };
    });
  const snapshotFiles = [...indexedSnapshotFiles, ...skippedSnapshotFiles]
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const snapshot: IndexedFileSnapshotSet = {
    schemaVersion: FILE_SNAPSHOT_SCHEMA_VERSION,
    files: snapshotFiles,
    fileCount: snapshotFiles.length,
    snapshotHash: computeSnapshotHash(snapshotFiles),
    graphSchemaVersion: FILE_SNAPSHOT_SCHEMA_VERSION,
    retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION,
    bindingContextHash,
    semanticContextHash,
    parserRegistryFingerprint,
  };
  timings.total = performance.now() - totalStarted;
  const performanceDiagnostics = makePerformanceDiagnostics(plan, timings, scannedFiles.length, parseCacheHits, parseCacheMisses, parsedFiles, options, graphRowsDeleted, graphRowsInserted, unsupportedFilesCarriedForward);
  if (options.parserVersion === undefined) {
    performanceDiagnostics.timingsMs = emptyTimings();
    performanceDiagnostics.graphRowsDeleted = 0;
    performanceDiagnostics.graphRowsInserted = 0;
  }

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
    snapshot,
    performance: performanceDiagnostics,
  };
}

function makeCacheKeyInput(
  result: ParseResult,
  parserVersion: string,
  parserConfigFingerprint: string,
  bindingContextHash: string,
  identity?: { contentKind: "git_blob" | "working_tree_hash"; gitBlobSha?: string },
): ParseCacheKeyInput {
  return {
    contentHash: result.file.contentHash,
    contentKind: identity?.contentKind ?? "working_tree_hash",
    ...(identity?.gitBlobSha === undefined ? {} : { gitBlobSha: identity.gitBlobSha }),
    parserId: parserIdForLanguage(result.file.language),
    parserVersion,
    parserConfigFingerprint,
    language: result.file.language,
    relativePath: result.file.path,
    bindingContextHash,
  };
}

function cacheInputFromSnapshot(snapshot: IndexedFileSnapshot): ParseCacheKeyInput {
  return {
    contentHash: snapshot.contentHash,
    contentKind: snapshot.contentKind,
    ...(snapshot.gitBlobSha === undefined ? {} : { gitBlobSha: snapshot.gitBlobSha }),
    parserId: snapshot.parserId,
    parserVersion: snapshot.parserVersion,
    parserConfigFingerprint: snapshot.parserConfigFingerprint,
    language: snapshot.language,
    relativePath: snapshot.relativePath,
    bindingContextHash: snapshot.bindingContextHash,
  };
}

function canReuseFullParseCache(
  current: IndexProjectFileContent,
  previous: IndexedFileSnapshot | undefined,
  options: IndexProjectOptions,
  parserVersion: string,
  parserConfigFingerprint: string,
  parserRegistryFingerprint: string,
  bindingContextCompatible: boolean,
): boolean {
  return bindingContextCompatible
    && previous?.indexOutcome === "indexed"
    && options.previousSnapshotCompatible !== false
    && options.previousSnapshot?.schemaVersion === FILE_SNAPSHOT_SCHEMA_VERSION
    && options.previousSnapshot.parserRegistryFingerprint === parserRegistryFingerprint
    && previous.contentHash === current.file.contentHash
    && previous.language === current.file.language
    && previous.sizeBytes === current.file.sizeBytes
    && previous.parserVersion === parserVersion
    && previous.parserConfigFingerprint === parserConfigFingerprint;
}

async function discoverContentIdentities(
  repoRoot: string,
  files: readonly IndexProjectFileContent["file"][],
): Promise<Map<string, { contentKind: "git_blob" | "working_tree_hash"; gitBlobSha?: string }>> {
  const [blobs, status] = await Promise.all([listGitBlobShas(repoRoot), listGitStatusEntries(repoRoot)]);
  const dirty = new Set((status ?? []).flatMap((entry) => [entry.path, ...(entry.originalPath === undefined ? [] : [entry.originalPath])]));
  return new Map(files.map((file) => {
    const blob = blobs?.get(file.path);
    return [file.path, blob !== undefined && !dirty.has(file.path)
      ? { contentKind: "git_blob" as const, gitBlobSha: blob }
      : { contentKind: "working_tree_hash" as const }];
  }));
}

function parserIdForLanguage(language: ParseResult["file"]["language"]): string {
  return `vtrace-${language}`;
}

function emptyDocumentParseResult(fileContent: IndexProjectFileContent): ParseResult {
  return {
    file: fileContent.file,
    symbols: [],
    edges: [],
    diagnostics: [],
  };
}

function computeParserRegistryFingerprint(registry: ParserRegistry): string {
  return createHash("sha256")
    .update(JSON.stringify(registry.registeredLanguages()))
    .digest("hex");
}

function makePerformanceDiagnostics(
  plan: ReturnType<typeof planIncrementalRefresh>,
  timings: ReturnType<typeof emptyTimings>,
  totalFiles: number,
  hits: number,
  misses: number,
  parsed: number,
  options: IndexProjectOptions,
  graphRowsDeleted = 0,
  graphRowsInserted = 0,
  unsupportedFilesCarriedForward = 0,
): IndexPerformanceDiagnostics {
  return {
    mode: plan.mode,
    ...(options.baseSnapshotWorktreeId === undefined ? {} : { baseSnapshotWorktreeId: options.baseSnapshotWorktreeId }),
    ...(options.baseSnapshotHead === undefined ? {} : { baseSnapshotHead: options.baseSnapshotHead }),
    totalCurrentFiles: totalFiles,
    addedFiles: plan.added.length,
    modifiedFiles: plan.modified.length,
    deletedFiles: plan.deleted.length,
    renamedFiles: plan.renamed.length,
    unchangedFiles: plan.unchanged.length,
    parseCacheHits: hits,
    parseCacheMisses: misses,
    parsedFiles: parsed,
    reusedParseResults: hits,
    initiallyInvalidatedFiles: plan.initiallyInvalidatedFiles.length,
    affectedClosureFiles: plan.affectedClosureFiles.length,
    graphRowsDeleted,
    graphRowsInserted,
    timingsMs: timings,
    ...(plan.fullRebuildReason === undefined ? {} : { fallbackReason: plan.fullRebuildReason }),
    previousGraphSnapshotUsedForMutation: plan.mode === "incremental",
    unsupportedFilesCarriedForward,
  };
}

function countLiveGraphRows(db: Database): number {
  return ["files", "symbols", "edges", "symbol_search_fts", "symbol_body_literals_fts"]
    .reduce((total, table) => total + ((db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count), 0);
}

function rebindCachedEdgeTargets(results: readonly ParseResult[], previousSymbols: readonly ParseResult["symbols"][number][]): ParseResult[] {
  const currentSymbols = results.flatMap((result) => result.symbols);
  const currentBySemanticKey = new Map(currentSymbols.map((symbol) => [semanticSymbolKey(symbol), symbol]));
  const reboundIds = new Map<string, string>();
  for (const oldSymbol of previousSymbols) {
    const current = currentBySemanticKey.get(semanticSymbolKey(oldSymbol));
    if (current !== undefined) reboundIds.set(oldSymbol.id, current.id);
  }
  return results.map((result) => ({
    ...result,
    edges: result.edges.map((edge) => {
      const srcSymbolId = reboundIds.get(edge.srcSymbolId) ?? edge.srcSymbolId;
      const dstSymbolId = reboundIds.get(edge.dstSymbolId) ?? edge.dstSymbolId;
      return {
        ...edge,
        id: createHash("sha256").update([srcSymbolId, dstSymbolId, edge.edgeType].join("\0")).digest("hex"),
        srcSymbolId,
        dstSymbolId,
      };
    }),
  }));
}

function semanticSymbolKey(symbol: ParseResult["symbols"][number]): string {
  return [symbol.filePath, symbol.fqName, symbol.localName, symbol.kind, symbol.signature, symbol.exported ? "1" : "0"].join("\0");
}

export function createDefaultParserRegistry(
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

function summaryFromSnapshot(snapshot: IndexedFileSnapshot): IndexedFileSummary {
  if (snapshot.indexOutcome === "indexed") {
    return {
      path: snapshot.relativePath,
      language: snapshot.language,
      status: "indexed",
      diagnostics: [],
    };
  }
  const status = snapshot.diagnostic?.category
    ?? (snapshot.parserCapability === "unsupported" ? "unsupported_language" : "unregistered_language");
  return {
    path: snapshot.relativePath,
    language: snapshot.language,
    status,
    diagnostics: [],
    error: {
      code: status,
      message: snapshot.diagnostic?.message ?? `No parser registered for language: ${snapshot.language}`,
      filePath: snapshot.relativePath,
      language: snapshot.language,
    },
  };
}

function isFatalFileOutcome(summary: IndexedFileSummary): boolean {
  return summary.status === "read_failed" || summary.status === "parse_failed";
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
      deleteBodyLiteralsForFile(db, { path: filePath });
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
