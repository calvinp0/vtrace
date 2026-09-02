// @ts-nocheck
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { nullProgressReporter } from "../cli/progress";
import { EdgeType, normalizeFilePath, type EdgeRecord, type ParseResult } from "../domain/types";
import { scanRepo } from "../fs/scanRepo";
import { resolveWorktreeExclusions, summarizeWorktreeExclusions } from "../fs/worktreeExclusions";
import { listGitBlobShas, listGitStatusEntries } from "../fs/git";
import { deleteEdgesTouchingFileSymbols, insertEdges } from "../db/repositories/edgesRepository";
import { listAllEdges } from "../db/repositories/edgesRepository";
import {
  deleteFileByPath,
  listAllFilePaths,
} from "../db/repositories/filesRepository";
import { insertFileRunStates } from "../db/repositories/fileRunStatesRepository";
import { createIndexRun } from "../db/repositories/indexRunsRepository";
import { insertSymbolRunStates } from "../db/repositories/symbolRunStatesRepository";
import { deleteSymbolSearchIndexForFile } from "../db/repositories/symbolSearchFtsRepository";
import {
  countPersistedSurfaces,
  deleteModuleBindingsForFile,
  importersOfTarget,
  readPersistedSurfaces,
  reExportsThrough,
  wildcardImportersOfTarget,
} from "../db/persistParseResult";
import { deleteBodyLiteralsForFile } from "../db/repositories/bodyLiteralsRepository";
import { deleteMechanismFactsForFile } from "../db/repositories/mechanismFactsRepository";
import { replaceDocumentChunksForFile } from "../db/repositories/documentsRepository";
import { persistParseResult } from "../db/persistParseResult";
import { deleteSymbolsForFile, listAllSymbols } from "../db/repositories/symbolsRepository";
import { evaluateMaterializedGraph } from "./materializationAuthority";
import { buildSymbolBodyLiterals } from "./extractBodyLiterals";
import { buildSymbolMechanismFacts } from "./extractMechanismFacts";
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
  boundFailureMessage,
  classifyFileFailure,
  isRecoverableFileFailure,
  isRepositoryFatalFileFailure,
} from "./fileFailureClassification";
import { replaceFileIndexFailures, type FileIndexFailureRecord } from "../db/repositories/fileIndexFailuresRepository";
import {
  IndexingFileFailuresError,
  type IndexCoverageSummary,
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
  isPackageSurfacePath,
  planIncrementalRefresh,
  MAX_BINDING_CLOSURE_FRACTION,
  bindingSurfaceDigest,
  deriveBindingClosure,
  type BindingClosureDiagnostics,
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
  // Resolve nested linked worktrees ONCE per index run and reuse the set for
  // every enumeration below: a registered worktree beneath this root is a
  // duplicate checkout of this repository, not part of it.
  const worktreeExclusions = options.scanOptions?.worktreeExclusions
    ?? await resolveWorktreeExclusions(repoRoot);
  const worktreeExclusionDiagnostics = summarizeWorktreeExclusions(worktreeExclusions);
  const scannedFiles = await scanRepo(repoRoot, { worktreeExclusions });
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
  const readStarted = performance.now();
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
  timings.read = performance.now() - readStarted;

  // M156: a file whose bytes could not be read is a fact about that file. The
  // per-file bookkeeping above already recorded it; throwing here would discard
  // that and take the other N-1 files down with it.
  const parserVersion = options.parserVersion ?? "builtin-parser-v1";
  const parserConfigFingerprint = options.parserConfigFingerprint ?? "default-parser-config-v1";
  // M200. Set once the parse plan exists; read by the Python parser when it
  // decides whether a whole-repository AST warm is the cheaper way to serve this
  // run. Undefined until then, which is the pre-M200 behaviour.
  let plannedParseCount: number | undefined;
  const registry = options.createParserRegistry === undefined
    ? createDefaultParserRegistry(readableFiles, () => plannedParseCount)
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
  // M184. `plan.mode === "noop"` is the only path that never enters the persist
  // transaction below, so no-op eligibility is the whole attack surface for a
  // silently empty index. The planner proved the SOURCE has not changed; it
  // cannot prove this workspace still HOLDS the graph that snapshot describes.
  // Ask the database directly, and degrade to the incremental path when it does
  // not — that path reuses the parse cache, so recovery costs a
  // re-materialization rather than a full reparse.
  //
  // It is also the one incremental plan that must still write the WHOLE graph:
  // an incremental plan normally rewrites only the files it invalidated, and
  // here nothing was invalidated while everything is missing. `resolvePersistenceScope`
  // reads `fullRebuildReason` for exactly this case, so the recovery keeps
  // working after persistence stopped being wholesale.
  const materialization = plan.mode === "noop"
    ? evaluateMaterializedGraph(options.db, options.previousSnapshot, options.hasExistingGraph)
    : undefined;
  if (materialization !== undefined && !materialization.usable) {
    plan = {
      ...plan,
      mode: "incremental",
      affectedClosureFiles: [],
      fullRebuildReason: "materialization_missing",
    };
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
      coverage: summarizeCoverage(noopFiles),
      worktreeExclusions: worktreeExclusionDiagnostics,
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
  plannedParseCount = initialParsePaths.size;
  for (let index = 0; index < readableFiles.length; index += 1) {
    const fileContent = readableFiles[index]!;
    if (!initialParsePaths.has(fileContent.file.path)) {
      const previous = previousByPath.get(fileContent.file.path);
      if (plan.mode === "incremental" && previous?.indexOutcome === "skipped") {
        summariesByPath.set(fileContent.file.path, summaryFromSnapshot(previous));
        unsupportedFilesCarriedForward += 1;
        continue;
      }
      // M156: an unchanged file that failed last time fails again. Carrying the
      // record forward is safe precisely because an incremental plan is only
      // compatible when the parser registry and version are unchanged — and a
      // REPAIRED file has different content, so it is `modified` and re-parsed
      // rather than reaching this branch (§37).
      if (plan.mode === "incremental" && previous?.indexOutcome === "failed") {
        summariesByPath.set(fileContent.file.path, summaryFromSnapshot(previous));
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

  let bindingClosureDiagnostics: BindingClosureDiagnostics | undefined;
  if (plan.mode === "incremental") {
    const candidateSemanticHash = computeSemanticContextHash(successfulResults);
    if (candidateSemanticHash !== options.previousSnapshot?.semanticContextHash) {
      // M200. Something in the repository's semantic surface moved. Before
      // asking for a rebuild, find out whether the movement is confined to
      // module BINDINGS — what files publish and where those names resolve —
      // because that is the one kind of movement whose reverse consumers this
      // index can now name.
      const binding = resolveBindingSurfaceChange({
        db: options.db,
        plan,
        results: successfulResults,
        previousSemanticContextHash: options.previousSnapshot?.semanticContextHash,
        repositoryFileCount: scannedFiles.length,
      });
      bindingClosureDiagnostics = binding.diagnostics;

      if (binding.kind === "bounded") {
        // Consumers whose resolutions may have moved were NOT in the parse plan,
        // so their results are the ones the cache just handed back — computed
        // against the old surface, with edges pointing at the old target. They
        // have to be parsed again; reusing them is precisely the stale-binding
        // failure the closure exists to prevent.
        const reparseStarted = performance.now();
        const closurePaths = new Set(binding.closureFiles);
        plannedParseCount = (plannedParseCount ?? 0) + closurePaths.size;
        const byPath = new Map(successfulResults.map((result) => [result.file.path, result]));
        for (const fileContent of readableFiles) {
          if (!closurePaths.has(fileContent.file.path)) continue;
          if (plan.modified.some((change) => change.relativePath === fileContent.file.path)) continue;
          const parsed = isDocumentLanguage(fileContent.file.language)
            ? { ok: true as const, result: emptyDocumentParseResult(fileContent) }
            : await parseFile(registry, fileContent);
          parsedFiles += 1;
          parseCacheHits = Math.max(0, parseCacheHits - (byPath.has(fileContent.file.path) ? 1 : 0));
          parseCacheMisses += 1;
          if (!parsed.ok) {
            byPath.delete(fileContent.file.path);
            summariesByPath.set(fileContent.file.path, summaryForParserError(fileContent, parsed.error));
            continue;
          }
          byPath.set(fileContent.file.path, parsed.result);
          summariesByPath.set(fileContent.file.path, {
            path: parsed.result.file.path, language: parsed.result.file.language,
            status: "indexed", diagnostics: parsed.result.diagnostics,
          });
        }
        successfulResults = [...byPath.values()];
        const closure = [...new Set([...plan.affectedClosureFiles, ...binding.closureFiles])].sort();
        plan = { ...plan, affectedClosureFiles: closure };
        timings.parsing += performance.now() - reparseStarted;
      } else {
        // IDs, signatures, exports, or path membership changed, or the binding
        // movement could not be bounded. Rebuild every parse result.
        plan = { ...plan, mode: "full_rebuild", fullRebuildReason: "closure_uncertain", affectedClosureFiles: scannedFiles.map((file) => file.path) };
        successfulResults = [];
        summariesByPath.clear();
        parseCacheHits = 0;
        parseCacheMisses = readableFiles.length;
        // This run turned out to be a whole-repository parse after all.
        plannedParseCount = readableFiles.length;
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
  }
  if (plan.mode === "incremental") {
    successfulResults = rebindCachedEdgeTargets(successfulResults, previousSymbols);
  }
  bindingContextHash = computeBindingContextHash(successfulResults);
  const semanticContextHash = computeSemanticContextHash(successfulResults);

  // M156 §7. This is the seam M155 measured: every read/parse failure used to be
  // thrown here, so one unparseable file made an otherwise indexable repository
  // unavailable. Recoverable failures are now carried as evidence about those
  // files; only outcomes that indict the INDEX itself still end the run (§30).
  const allFileOutcomes = [...files, ...summariesByPath.values()];
  const repositoryFatal = allFileOutcomes.filter((summary) => isRepositoryFatalFileFailure(summary.status));
  if (repositoryFatal.length > 0) {
    throw new IndexingFileFailuresError(repositoryFatal);
  }
  const containedFailures = allFileOutcomes.filter((summary) => isRecoverableFileFailure(summary.status));

  const parseCacheWriteStarted = performance.now();
  for (const result of successfulResults) {
    const keyInput = makeCacheKeyInput(result, parserVersion, parserConfigFingerprint, bindingContextHash, contentIdentities.get(result.file.path));
    try {
      await writeParseCacheEntry(cacheRoot, keyInput, result);
    } catch {
      // Cache population is an optimization. A read-only/unavailable shared
      // cache must not prevent a correct isolated graph rebuild.
    }
  }
  timings.parseCacheWrite = performance.now() - parseCacheWriteStarted;

  const scannedByPath = new Map(scannedFiles.map((file) => [normalizeFilePath(file.path), file]));
  const failureRecords: FileIndexFailureRecord[] = containedFailures.map((summary) => {
    const scanned = scannedByPath.get(summary.path);
    return {
      path: summary.path,
      language: summary.language,
      status: summary.status as FileIndexFailureRecord["status"],
      failureClass: classifyFileFailure(summary.status, summary.error),
      message: boundFailureMessage(summary.error?.message ?? summary.status),
      contentHash: scanned?.contentHash ?? "",
      sizeBytes: scanned?.sizeBytes ?? 0,
    };
  });

  // Every successful result describes the graph after this run, whether or not
  // this run is the one that wrote it: the snapshot, the symbol totals and the
  // file-count validation are all statements about the whole repository, and a
  // bounded refresh does not make them statements about the changed files.
  const persistedResults: ParseResult[] = [...successfulResults];
  const persistenceScope = resolvePersistenceScope(plan, successfulResults);
  const resultsToPersist = persistenceScope.kind === "whole_repository"
    ? successfulResults
    : successfulResults.filter((result) => persistenceScope.paths.has(normalizeFilePath(result.file.path)));
  // Raw file content by path, so the persist loop can extract body literals
  // (symbols carry byte ranges, not text). The full content set is already held
  // in memory by `readableFiles` for the whole run.
  const contentByPath = new Map(readableFiles.map((rf) => [rf.file.path, rf.content]));

  progress.report({
    kind: "phase_begin",
    phase: "persist",
    label: "Persisting parse results",
    total: resultsToPersist.length,
  });
  const graphTransaction = options.db.transaction(() => {
    const invalidationStarted = performance.now();
    if (persistenceScope.kind === "whole_repository") {
      options.db.run("DELETE FROM symbol_search_fts");
      options.db.run("DELETE FROM symbol_body_literals_fts");
      options.db.run("DELETE FROM symbol_mechanism_facts");
      options.db.run("DELETE FROM document_search_fts");
      options.db.run("DELETE FROM document_chunks");
      options.db.run("DELETE FROM edges");
      options.db.run("DELETE FROM symbols");
      options.db.run("DELETE FROM files");
      // M200. Cleared with the rest of the graph: a wholesale rebuild rewrites
      // the binding authority from source too, and a surviving row would make a
      // path look like it still publishes a name the repository no longer has.
      options.db.run("DELETE FROM module_bindings");
      options.db.run("DELETE FROM module_binding_surfaces");
      options.db.run("DELETE FROM import_descriptors");
    } else {
      // Driven by the INVALIDATED paths, not by the results about to be written.
      // The two agree today only because a file that stops parsing also changes
      // the repository's semantic surface and sends the whole run to a full
      // rebuild — a coincidence of another guard, not a property of this one.
      // Invalidating what the plan invalidated is what makes the scope correct
      // on its own terms.
      for (const filePath of persistenceScope.paths) {
        invalidatePersistedFile(options.db, filePath);
      }
    }
    timings.invalidation = performance.now() - invalidationStarted;
    const persistenceStarted = performance.now();
    for (let index = 0; index < resultsToPersist.length; index += 1) {
      const parseResult = resultsToPersist[index]!;
      const fileLocalResult = { ...parseResult, edges: parseResult.edges.filter((edge) => !isDeferredEdgeType(edge.edgeType)) };
      const fileContent = contentByPath.get(parseResult.file.path) ?? "";
      const bodyLiterals = buildSymbolBodyLiterals(fileLocalResult.symbols, fileContent);
      const mechanismFacts = buildSymbolMechanismFacts(fileLocalResult.symbols, fileContent);
      persistParseResult(options.db, fileLocalResult, { bodyLiterals, mechanismFacts });
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
      progress.report({ kind: "phase_progress", phase: "persist", index: index + 1, total: resultsToPersist.length, item: parseResult.file.path });
    }
    timings.persistence = performance.now() - persistenceStarted;
    const linkingStarted = performance.now();
    persistResolvableInterFileEdges(
      options.db,
      persistedResults,
      persistenceScope.kind === "whole_repository" ? undefined : persistenceScope.rewrittenSymbolIds,
    );
    timings.linking = performance.now() - linkingStarted;
    const validationStarted = performance.now();
    try {
      (options.validateGraph ?? validateGraph)(options.db, persistedResults.length);
    } catch (error) {
      throw new GraphValidationError(error);
    }
    timings.validation = performance.now() - validationStarted;
    const bookkeepingStarted = performance.now();
    // Written INSIDE the graph transaction, after validation, so the failed set
    // and the successful set are committed together or not at all. A failed file
    // contributes no symbols, edges, facts, chunks or FTS rows — invalidation
    // already removed anything a previous run had for it (§14, §36).
    replaceFileIndexFailures(options.db, failureRecords);
    recordIndexRunState(options.db, scannedFiles, persistedResults.flatMap((result) => result.symbols));
    timings.bookkeeping = performance.now() - bookkeepingStarted;
  });
  const transactionStarted = performance.now();
  try {
    graphTransaction();
    // What the transaction cost beyond the work it was timed doing: the commit
    // itself. Derived rather than measured because the commit happens as the
    // transaction function returns, where no statement can be wrapped.
    timings.commit = Math.max(0, (performance.now() - transactionStarted) - (
      timings.invalidation + timings.persistence + timings.linking
      + timings.validation + timings.bookkeeping));
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
  // A failed file stays IN the snapshot. Dropping it would make the next run
  // treat it as newly added, and — worse — would let the snapshot describe a
  // repository that never contained it (§15, §35).
  const failedSnapshotFiles: IndexedFileSnapshot[] = failureRecords.map((failure) => {
    const scanned = scannedByPath.get(failure.path);
    const identity = contentIdentities.get(failure.path);
    return {
      relativePath: failure.path,
      language: (scanned?.language ?? failure.language) as IndexedFileSnapshot["language"],
      contentHash: failure.contentHash,
      contentKind: identity?.contentKind ?? "working_tree_hash",
      ...(identity?.gitBlobSha === undefined ? {} : { gitBlobSha: identity.gitBlobSha }),
      indexOutcome: "failed",
      // The parser was registered and supported; it is the CONTENT that failed.
      // Reporting `unsupported` here would blame the wrong thing (§16).
      parserCapability: "supported",
      parserId: parserIdForLanguage((scanned?.language ?? failure.language) as ParseResult["file"]["language"]),
      parserVersion,
      parserConfigFingerprint,
      bindingContextHash,
      sizeBytes: failure.sizeBytes,
      failure: {
        status: failure.status,
        failureClass: failure.failureClass,
        message: failure.message,
        attemptedParserId: parserIdForLanguage((scanned?.language ?? failure.language) as ParseResult["file"]["language"]),
      },
    };
  });
  const snapshotFiles = [...indexedSnapshotFiles, ...skippedSnapshotFiles, ...failedSnapshotFiles]
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
  const performanceDiagnostics = makePerformanceDiagnostics(plan, timings, scannedFiles.length, parseCacheHits, parseCacheMisses, parsedFiles, options, graphRowsDeleted, graphRowsInserted, unsupportedFilesCarriedForward, bindingClosureDiagnostics);
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
    coverage: summarizeCoverage(allFiles),
    worktreeExclusions: worktreeExclusionDiagnostics,
    snapshot,
    performance: performanceDiagnostics,
  };
}

/**
 * Coverage derived from the per-file outcomes the run actually produced.
 *
 * `complete` is computed, never passed in — the same discipline `composeCoverage`
 * applies in the workspace layer, and for the same reason: a caller that merely
 * hopes it indexed everything must not be able to say so.
 */
function summarizeCoverage(files: readonly IndexedFileSummary[]): IndexCoverageSummary {
  const indexed = files.filter((file) => file.status === "indexed");
  const failed = files.filter((file) => isRecoverableFileFailure(file.status));
  const skipped = files.filter((file) => (
    file.status === "unregistered_language" || file.status === "unsupported_language"
  ));
  return {
    filesEligible: files.length,
    filesIndexed: indexed.length,
    filesFailed: failed.length,
    filesSkipped: skipped.length,
    complete: failed.length === 0,
    failedLanguages: [...new Set(failed.map((file) => String(file.language)))].sort(),
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
  bindingClosure: BindingClosureDiagnostics | undefined = undefined,
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
    ...(bindingClosure === undefined ? {} : { bindingClosure }),
  };
}

function countLiveGraphRows(db: Database): number {
  return ["files", "symbols", "edges", "symbol_search_fts", "symbol_body_literals_fts", "symbol_mechanism_facts"]
    .reduce((total, table) => total + ((db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count), 0);
}

/**
 * Repoint cached edges at the symbol ids of the current parse.
 *
 * A cached parse result carries the ids that were current when the entry was
 * written. A symbol that keeps its semantic identity but MOVES within its file
 * gets a new content-derived id, so every cached edge naming the old one has to
 * be repointed or it would dangle.
 *
 * The mapping is keyed by semantic identity, so it can only be applied where
 * that identity is unique. Both Python and TypeScript let one class define the
 * same method twice; ARC does it thirty times. Resolving such a key merged two
 * distinct definitions into one, which dropped one definition's containment edge
 * and made `Class contains method` collide with itself on the primary key —
 * aborting the whole refresh on `UNIQUE constraint failed: edges.id`, and, where
 * it did not abort, leaving an incremental graph that a cold build would not
 * produce. An ambiguous key identifies nothing, so it now maps nothing.
 */
function rebindCachedEdgeTargets(results: readonly ParseResult[], previousSymbols: readonly ParseResult["symbols"][number][]): ParseResult[] {
  const currentByKey = uniqueBySemanticKey(results.flatMap((result) => result.symbols));
  const previousByKey = uniqueBySemanticKey(previousSymbols);
  const reboundIds = new Map<string, string>();
  for (const [key, previous] of previousByKey) {
    const current = currentByKey.get(key);
    if (current !== undefined && current.id !== previous.id) reboundIds.set(previous.id, current.id);
  }

  if (reboundIds.size === 0) {
    return [...results];
  }

  return results.map((result) => ({
    ...result,
    edges: mergeEdgesSharingAnId(result.edges.map((edge) => {
      const srcSymbolId = reboundIds.get(edge.srcSymbolId) ?? edge.srcSymbolId;
      const dstSymbolId = reboundIds.get(edge.dstSymbolId) ?? edge.dstSymbolId;

      if (srcSymbolId === edge.srcSymbolId && dstSymbolId === edge.dstSymbolId) {
        return edge;
      }

      return {
        ...edge,
        id: createHash("sha256").update([srcSymbolId, dstSymbolId, edge.edgeType].join("\0")).digest("hex"),
        srcSymbolId,
        dstSymbolId,
      };
    })),
  }));
}

/**
 * Semantic key to symbol, for keys naming exactly one symbol. A key naming two
 * is DELETED rather than resolved to either: which one it would resolve to is
 * map-insertion order, and insertion order is not an identity.
 */
function uniqueBySemanticKey(
  symbols: readonly ParseResult["symbols"][number][],
): Map<string, ParseResult["symbols"][number]> {
  const byKey = new Map<string, ParseResult["symbols"][number]>();
  const ambiguous = new Set<string>();

  for (const symbol of symbols) {
    const key = semanticSymbolKey(symbol);
    if (byKey.has(key)) ambiguous.add(key);
    else byKey.set(key, symbol);
  }

  for (const key of ambiguous) byKey.delete(key);

  return byKey;
}

/**
 * Rebinding can legitimately land two edges on one identity — a cached result
 * naming an old id and a freshly parsed one naming the current id describe the
 * same relation. The id is a hash of exactly `(src, dst, type)`, so edges
 * sharing an id are provably the same edge and are MERGED rather than ignored on
 * insert: `INSERT OR IGNORE` would silently discard occurrences the parser
 * really observed, and would equally have hidden the ambiguity repaired above.
 */
function mergeEdgesSharingAnId(edges: readonly EdgeRecord[]): EdgeRecord[] {
  const byId = new Map<string, EdgeRecord>();
  let merged = false;

  for (const edge of edges) {
    const existing = byId.get(edge.id);

    if (existing === undefined) {
      byId.set(edge.id, edge);
      continue;
    }

    merged = true;
    byId.set(edge.id, {
      ...existing,
      confidence: Math.max(existing.confidence, edge.confidence),
      ...(existing.callSites === undefined && edge.callSites === undefined
        ? {}
        : { callSites: unionCallSites(existing.callSites ?? [], edge.callSites ?? []) }),
    });
  }

  return merged ? [...byId.values()] : [...edges];
}

function unionCallSites(
  left: readonly NonNullable<EdgeRecord["callSites"]>[number][],
  right: readonly NonNullable<EdgeRecord["callSites"]>[number][],
): NonNullable<EdgeRecord["callSites"]> {
  const byPosition = new Map<string, (typeof left)[number]>();

  for (const site of [...left, ...right]) {
    byPosition.set(
      [site.startLine, site.startColumn, site.endLine, site.endColumn, site.precision].join("\0"),
      site,
    );
  }

  return [...byPosition.values()].sort((a, b) => (
    a.startLine - b.startLine
    || a.startColumn - b.startColumn
    || a.endLine - b.endLine
    || a.endColumn - b.endColumn
  ));
}

function semanticSymbolKey(symbol: ParseResult["symbols"][number]): string {
  return [symbol.filePath, symbol.fqName, symbol.localName, symbol.kind, symbol.signature, symbol.exported ? "1" : "0"].join("\0");
}

export function createDefaultParserRegistry(
  files: readonly IndexProjectFileContent[],
  /**
   * M200. How many files this run will parse, once it knows. Read lazily
   * because the registry is built before the plan that decides the answer.
   */
  plannedParseCount?: () => number | undefined,
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
      ...(plannedParseCount === undefined ? {} : { plannedParseCount }),
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
  if (snapshot.indexOutcome === "failed") {
    return {
      path: snapshot.relativePath,
      language: snapshot.language,
      status: snapshot.failure?.status ?? "parse_failed",
      diagnostics: [],
      error: {
        code: snapshot.failure?.failureClass ?? "UNKNOWN",
        message: snapshot.failure?.message ?? "Semantic indexing failed for this file",
      },
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

/**
 * Which files' persisted rows a run rewrites.
 *
 * An incremental plan has already proved two things the wholesale path could
 * not: no file was added, deleted or renamed, and the repository's semantic
 * surface — every symbol's path, name, kind, signature and export status, plus
 * every package surface's content — is unchanged (`semanticContextHash`). What
 * is left to write is therefore confined to the files that changed and to the
 * edges that touch their symbols, because nothing else in the graph can differ.
 *
 * The one incremental plan that is NOT confined is M184's materialization
 * recovery: it keeps the incremental parse plan while the graph itself is
 * missing, so it invalidated nothing and must write everything. It is
 * recognisable by carrying a `fullRebuildReason` on an incremental mode, and
 * any future plan that does the same is treated the same way — the test is
 * "does this plan claim something a changed-file closure cannot describe",
 * which fails safe towards writing more.
 */
type PersistenceScope =
  | { readonly kind: "whole_repository" }
  | {
      readonly kind: "affected_files";
      readonly paths: ReadonlySet<string>;
      /** Symbols the run rewrites; the edges that may be written are those touching one. */
      readonly rewrittenSymbolIds: ReadonlySet<string>;
    };

/**
 * Decide whether a semantic difference is confined to module bindings, and if so
 * which files it can reach (M200 §12, §13).
 *
 * The confinement test is the part worth reading. Rather than maintaining a
 * second per-file surface ledger — which could disagree with the hash it is
 * meant to explain — it re-asks the SAME hash function one question: would the
 * repository's semantic hash have matched if the changed binding surfaces had
 * stayed where they were? If yes, bindings are the only thing that moved. If no,
 * something this milestone does not model changed too, and the answer is a
 * rebuild.
 */
function resolveBindingSurfaceChange(input: {
  db: Database;
  plan: { readonly modified: readonly { readonly relativePath: string }[] };
  results: readonly ParseResult[];
  previousSemanticContextHash: string | undefined;
  repositoryFileCount: number;
}):
  | { kind: "bounded"; closureFiles: readonly string[]; diagnostics: BindingClosureDiagnostics }
  | { kind: "unbounded"; diagnostics: BindingClosureDiagnostics } {
  const started = performance.now();
  const modified = new Set(input.plan.modified.map((change) => normalizeFilePath(change.relativePath)));
  const persisted = readPersistedSurfaces(input.db);
  const resultsByPath = new Map(input.results.map((result) => [normalizeFilePath(result.file.path), result]));

  const refuse = (
    refusal: string,
    detail: string,
    changedModules: readonly string[] = [],
  ): { kind: "unbounded"; diagnostics: BindingClosureDiagnostics } => ({
    kind: "unbounded",
    diagnostics: {
      changedModules, closureFiles: [], visitedModules: 0, reparsedForClosure: 0,
      repositoryFileCount: input.repositoryFileCount,
      maxClosureFraction: MAX_BINDING_CLOSURE_FRACTION,
      refusal, refusalDetail: detail,
      derivationMs: +(performance.now() - started).toFixed(2),
      filesAFullRebuildWouldParse: input.repositoryFileCount,
    },
  });

  // An index written before this authority existed holds no surfaces, and one
  // holding fewer than the parsers produced is a partial write we cannot reason
  // from. Both are "cannot say", never "nothing changed".
  const derivable = input.results.filter((result) => result.bindingSurface !== undefined);
  if (derivable.length > 0 && persisted.size === 0) {
    return refuse("descriptors_unavailable", "index holds no persisted binding surfaces");
  }

  const changedModules: string[] = [];
  const surfaceless: string[] = [];
  const unboundedModules: string[] = [];
  const overrides = new Map<string, string>();

  for (const filePath of [...modified].sort()) {
    const result = resultsByPath.get(filePath);
    const previousSurface = persisted.get(filePath);
    if (result === undefined) continue;
    if (result.bindingSurface === undefined) {
      // A modified file this index models no bindings for. It only blocks the
      // closure if it actually contributes a binding term — a package surface
      // whose raw content moved — which is the TypeScript `index.ts` case.
      if (isPackageSurfacePath(filePath)) surfaceless.push(filePath);
      continue;
    }
    const digest = bindingSurfaceDigest(result.bindingSurface);
    if (previousSurface === undefined) {
      surfaceless.push(filePath);
      continue;
    }
    if (previousSurface.surfaceDigest === digest) continue;
    changedModules.push(filePath);
    overrides.set(result.file.path, previousSurface.surfaceDigest);
    if (result.bindingSurface.unboundedNames || previousSurface.unboundedNames) {
      unboundedModules.push(filePath);
    }
  }

  // The confinement test.
  if (computeSemanticContextHash(input.results, overrides) !== input.previousSemanticContextHash) {
    return refuse("semantic_change_outside_bindings",
      `${changedModules.length} binding surface(s) changed, and something else did too`,
      changedModules);
  }

  const closure = deriveBindingClosure({
    changedModules, surfaceless, unboundedModules,
    repositoryFileCount: input.repositoryFileCount,
    maxClosureFraction: MAX_BINDING_CLOSURE_FRACTION,
    authority: {
      isAvailable: () => countPersistedSurfaces(input.db) > 0,
      importersOf: (target) => importersOfTarget(input.db, target),
      wildcardImportersOf: (target) => wildcardImportersOfTarget(input.db, target),
      reExportsThrough: (file, target) => reExportsThrough(input.db, file, target),
    },
  });

  if (!closure.ok) {
    return refuse(closure.refusal, closure.detail, changedModules);
  }

  const reparsed = closure.files.filter((filePath) => !modified.has(filePath));
  return {
    kind: "bounded",
    closureFiles: closure.files,
    diagnostics: {
      changedModules, closureFiles: closure.files,
      visitedModules: closure.visitedModules.length,
      reparsedForClosure: reparsed.length,
      repositoryFileCount: input.repositoryFileCount,
      maxClosureFraction: MAX_BINDING_CLOSURE_FRACTION,
      refusal: null,
      derivationMs: +(performance.now() - started).toFixed(2),
      filesAFullRebuildWouldParse: input.repositoryFileCount,
    },
  };
}

function resolvePersistenceScope(
  plan: { readonly mode: string; readonly affectedClosureFiles: readonly string[]; readonly fullRebuildReason?: string },
  successfulResults: readonly ParseResult[],
): PersistenceScope {
  if (plan.mode !== "incremental" || plan.fullRebuildReason !== undefined) {
    return { kind: "whole_repository" };
  }

  const paths = new Set(plan.affectedClosureFiles.map((filePath) => normalizeFilePath(filePath)));
  const rewrittenSymbolIds = new Set<string>();

  for (const result of successfulResults) {
    if (!paths.has(normalizeFilePath(result.file.path))) continue;
    for (const symbol of result.symbols) rewrittenSymbolIds.add(symbol.id);
  }

  return { kind: "affected_files", paths, rewrittenSymbolIds };
}

/**
 * Remove everything the graph holds for one file.
 *
 * Edges are found through the symbols they touch, so they go first; and they are
 * removed from BOTH directions, because an edge whose target lives in this file
 * is owned by the file at its other end and would otherwise be left pointing at
 * a symbol id this refresh is about to replace. Restoring those inbound edges is
 * `persistResolvableInterFileEdges`'s job, and it is given the same symbol set
 * this function deleted against.
 *
 * The file id is read from the row rather than recomputed, so this cannot
 * silently miss rows written under a different id derivation.
 */
function invalidatePersistedFile(db: Database, filePath: string): void {
  const normalizedPath = normalizeFilePath(filePath);
  const row = db.query("SELECT id FROM files WHERE path = ?").get(normalizedPath) as { id: string } | null;

  if (row !== null) {
    deleteEdgesTouchingFileSymbols(db, row.id);
    db.run("DELETE FROM document_search_fts WHERE file_id = ?", [row.id]);
    db.run("DELETE FROM document_chunks WHERE file_id = ?", [row.id]);
  }

  // Keyed by path, not by file id: these three carry the raw path and no foreign
  // key, so they survive a file row that was never written.
  deleteMechanismFactsForFile(db, { path: normalizedPath });
  deleteBodyLiteralsForFile(db, { path: normalizedPath });
  deleteSymbolSearchIndexForFile(db, { path: normalizedPath });
  // M200: keyed by path for the same reason as the three above.
  deleteModuleBindingsForFile(db, normalizedPath);

  if (row !== null) deleteSymbolsForFile(db, row.id);
  deleteFileByPath(db, normalizedPath);
}

/**
 * @param rewrittenSymbolIds When present, the run rewrote only part of the graph
 * and only edges touching one of these symbols were invalidated. Every other
 * resolvable edge is already persisted and unchanged, so writing it again would
 * collide on the edge primary key rather than record anything new.
 */
function persistResolvableInterFileEdges(
  db: Database,
  parseResults: readonly ParseResult[],
  rewrittenSymbolIds?: ReadonlySet<string>,
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
        && (
          rewrittenSymbolIds === undefined
          || rewrittenSymbolIds.has(edge.srcSymbolId)
          || rewrittenSymbolIds.has(edge.dstSymbolId)
        )
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
      deleteMechanismFactsForFile(db, { path: filePath });
      deleteModuleBindingsForFile(db, filePath);
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
