import { createHash } from "node:crypto";

import { Language, type FileRecord, type ParseResult } from "../domain/types";

// Bumped to 5 by M156: `indexOutcome` gained `failed`, so a snapshot written
// before M156 cannot express which files the run refused. Reading one as though
// it could would silently report a degraded repository as complete.
export const FILE_SNAPSHOT_SCHEMA_VERSION = 5 as const;
export const RETRIEVAL_SCHEMA_VERSION = 2 as const;
// M118 synthetic TypeScript-100 measurements crossed at 20% (0.97x at 20%,
// 0.96x at 30%, 0.90x at 50%). Python parsing remained strongly dominant
// (12.63x for one file of 24), so the measured threshold is language-aware.
export const MEASURED_LIGHTWEIGHT_PARSER_CHANGE_RATIO = 0.20;

export type IndexRefreshMode = "auto" | "incremental" | "full";
export type SelectedIndexMode = "noop" | "incremental" | "full_rebuild";
export type FullRebuildReason =
  | "schema_incompatible"
  | "parser_incompatible"
  | "configuration_incompatible"
  /** M146-A: indexer-side derivation semantics moved; stored content is obsolete. */
  | "derivation_incompatible"
  | "snapshot_missing"
  | "snapshot_invalid"
  | "closure_uncertain"
  | "change_set_too_large"
  | "graph_validation_failed"
  /** M184: the source was unchanged but this workspace no longer holds the graph. */
  | "materialization_missing"
  | "repository_mismatch"
  | "unknown";

export interface IndexedFileSnapshot {
  readonly relativePath: string;
  readonly language: Language;
  readonly contentHash: string;
  readonly contentKind: "git_blob" | "working_tree_hash";
  readonly gitBlobSha?: string;
  /**
   * M156 adds `failed`: the file is in scope and was attempted, and semantic
   * indexing did not succeed. Kept distinct from `skipped`, which means policy
   * decided not to attempt it — §16 requires those to stay distinguishable.
   */
  readonly indexOutcome: "indexed" | "skipped" | "failed";
  readonly parserCapability: "supported" | "unregistered" | "unsupported";
  readonly parserId?: string;
  readonly parserVersion?: string;
  readonly parserConfigFingerprint?: string;
  readonly bindingContextHash: string;
  readonly parseCacheKey?: string;
  readonly sizeBytes: number;
  readonly executableOrMode?: string;
  readonly diagnostic?: {
    readonly category: "unregistered_language" | "unsupported_language";
    readonly message: string;
  };
  /**
   * Set only when `indexOutcome` is `failed`. Carries enough to re-report the
   * failure without re-reading the file, and no more (§79): a class, a bounded
   * message, and which parser was asked.
   */
  readonly failure?: {
    readonly status: "read_failed" | "parse_failed";
    readonly failureClass: string;
    readonly message: string;
    readonly attemptedParserId?: string;
  };
  readonly documentKind?: "yaml" | "toml";
  readonly documentIndexVersion?: number;
}

export interface IndexedFileSnapshotSet {
  readonly schemaVersion: typeof FILE_SNAPSHOT_SCHEMA_VERSION;
  readonly files: readonly IndexedFileSnapshot[];
  readonly fileCount: number;
  readonly snapshotHash: string;
  readonly graphSchemaVersion: number;
  readonly retrievalSchemaVersion: number;
  readonly bindingContextHash: string;
  readonly semanticContextHash: string;
  readonly parserRegistryFingerprint: string;
}

export interface FileChange {
  readonly relativePath: string;
  readonly previous?: IndexedFileSnapshot;
  readonly current?: FileRecord;
}

export interface FileRename {
  readonly from: string;
  readonly to: string;
  readonly contentHash: string;
}

export interface IncrementalRefreshPlan {
  readonly mode: SelectedIndexMode;
  readonly added: readonly FileChange[];
  readonly modified: readonly FileChange[];
  readonly deleted: readonly FileChange[];
  readonly renamed: readonly FileRename[];
  readonly unchanged: readonly IndexedFileSnapshot[];
  readonly initiallyInvalidatedFiles: readonly string[];
  readonly affectedClosureFiles: readonly string[];
  readonly fullRebuildReason?: FullRebuildReason;
}

export interface IndexTimings {
  discovery: number;
  /** M199. Reading every scanned file's bytes, which a refresh does whether or not it parses them. */
  read: number;
  planning: number;
  parsing: number;
  invalidation: number;
  linking: number;
  persistence: number;
  retrievalIndex: number;
  validation: number;
  /**
   * M199. Per-run history: the failed-file set and the file/symbol run states
   * the run-to-run diff is computed from. Repository-scale by contract — a
   * partial snapshot would make every unindexed file look removed — and, until
   * it was timed, the largest unattributed term in an incremental refresh.
   */
  bookkeeping: number;
  /**
   * M199. Writing the parse cache back. Repository-scale on every refresh,
   * because the cache key carries a binding-context hash derived from every
   * symbol in the repository: one symbol moving rekeys every file's entry, so
   * an entry that was just READ from the cache still has to be written under
   * the new key or the next refresh misses on all of them.
   */
  parseCacheWrite: number;
  /** M199. Committing the graph transaction, once its body has finished. */
  commit: number;
  total: number;
}

export interface IndexPerformanceDiagnostics {
  mode: SelectedIndexMode;
  baseSnapshotWorktreeId?: string;
  baseSnapshotHead?: string;
  totalCurrentFiles: number;
  addedFiles: number;
  modifiedFiles: number;
  deletedFiles: number;
  renamedFiles: number;
  unchangedFiles: number;
  parseCacheHits: number;
  parseCacheMisses: number;
  parsedFiles: number;
  reusedParseResults: number;
  initiallyInvalidatedFiles: number;
  affectedClosureFiles: number;
  graphRowsDeleted?: number;
  graphRowsInserted?: number;
  timingsMs: IndexTimings;
  fallbackReason?: FullRebuildReason;
  previousGraphSnapshotUsedForMutation: boolean;
  unsupportedFilesCarriedForward: number;
}

export function planIncrementalRefresh(input: {
  readonly requestedMode: IndexRefreshMode;
  readonly currentFiles: readonly FileRecord[];
  readonly previous?: IndexedFileSnapshotSet;
  readonly compatible: boolean;
  readonly incompatibilityReason?: FullRebuildReason;
}): IncrementalRefreshPlan {
  const current = [...input.currentFiles].sort((a, b) => a.path.localeCompare(b.path));
  const previous = input.previous?.files === undefined
    ? undefined
    : [...input.previous.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const empty = { added: [], modified: [], deleted: [], renamed: [], unchanged: [] };

  if (input.requestedMode === "full") {
    return { mode: "full_rebuild", ...empty, initiallyInvalidatedFiles: current.map((f) => f.path), affectedClosureFiles: current.map((f) => f.path) };
  }
  if (!input.compatible) {
    return {
      mode: "full_rebuild",
      ...empty,
      initiallyInvalidatedFiles: current.map((f) => f.path),
      affectedClosureFiles: current.map((f) => f.path),
      fullRebuildReason: input.incompatibilityReason ?? "unknown",
    };
  }
  if (previous === undefined) {
    return {
      mode: "full_rebuild",
      ...empty,
      initiallyInvalidatedFiles: current.map((f) => f.path),
      affectedClosureFiles: current.map((f) => f.path),
      fullRebuildReason: "snapshot_missing",
    };
  }

  const previousByPath = new Map(previous.map((file) => [file.relativePath, file]));
  const currentByPath = new Map(current.map((file) => [file.path, file]));
  const added: FileChange[] = [];
  const modified: FileChange[] = [];
  const deleted: FileChange[] = [];
  const unchanged: IndexedFileSnapshot[] = [];
  for (const file of current) {
    const old = previousByPath.get(file.path);
    if (old === undefined) added.push({ relativePath: file.path, current: file });
    else if (old.contentHash !== file.contentHash || old.language !== file.language || old.sizeBytes !== file.sizeBytes) {
      modified.push({ relativePath: file.path, previous: old, current: file });
    } else unchanged.push(old);
  }
  for (const old of previous) {
    if (!currentByPath.has(old.relativePath)) deleted.push({ relativePath: old.relativePath, previous: old });
  }

  const renames: FileRename[] = [];
  const usedAdded = new Set<string>();
  const usedDeleted = new Set<string>();
  for (const removed of deleted) {
    const match = added.find((candidate) => (
      !usedAdded.has(candidate.relativePath)
      && candidate.current?.contentHash === removed.previous?.contentHash
      && candidate.current?.language === removed.previous?.language
    ));
    if (match !== undefined) {
      renames.push({ from: removed.relativePath, to: match.relativePath, contentHash: match.current!.contentHash });
      usedAdded.add(match.relativePath);
      usedDeleted.add(removed.relativePath);
    }
  }
  const actualAdded = added.filter((change) => !usedAdded.has(change.relativePath));
  const actualDeleted = deleted.filter((change) => !usedDeleted.has(change.relativePath));
  const invalidated = [...modified.map((change) => change.relativePath), ...actualAdded.map((change) => change.relativePath), ...actualDeleted.map((change) => change.relativePath), ...renames.flatMap((rename) => [rename.from, rename.to])].sort();

  if (invalidated.length === 0) {
    return { mode: "noop", added: actualAdded, modified, deleted: actualDeleted, renamed: renames, unchanged, initiallyInvalidatedFiles: [], affectedClosureFiles: [] };
  }

  // The current graph omits unresolved descriptors. Adds/deletes/renames can
  // therefore change old resolutions without a queryable reverse dependency.
  const uncertain = actualAdded.length > 0 || actualDeleted.length > 0 || renames.length > 0
    || modified.some((change) => isPackageSurfacePath(change.relativePath));
  if (uncertain) {
    return {
      mode: "full_rebuild",
      added: actualAdded,
      modified,
      deleted: actualDeleted,
      renamed: renames,
      unchanged,
      initiallyInvalidatedFiles: invalidated,
      affectedClosureFiles: current.map((file) => file.path),
      fullRebuildReason: "closure_uncertain",
    };
  }

  // Cost model: an incremental refresh writes only the files it invalidated, so
  // both parsing and persistence scale with the change set. What does not scale
  // is the change set itself — once every file is in it there is nothing left
  // for incremental bookkeeping to save, and a clean rebuild is the simpler way
  // to arrive at the same graph.
  if (modified.length >= current.length) {
    return {
      mode: "full_rebuild",
      added: actualAdded,
      modified,
      deleted: actualDeleted,
      renamed: renames,
      unchanged,
      initiallyInvalidatedFiles: invalidated,
      affectedClosureFiles: current.map((file) => file.path),
      fullRebuildReason: "change_set_too_large",
    };
  }
  const lightweightOnly = modified.every((change) => (
    change.current?.language === Language.TypeScript || change.current?.language === Language.JavaScript
  ));
  if (lightweightOnly && current.length >= 20 && modified.length / current.length >= MEASURED_LIGHTWEIGHT_PARSER_CHANGE_RATIO) {
    return {
      mode: "full_rebuild",
      added: actualAdded,
      modified,
      deleted: actualDeleted,
      renamed: renames,
      unchanged,
      initiallyInvalidatedFiles: invalidated,
      affectedClosureFiles: current.map((file) => file.path),
      fullRebuildReason: "change_set_too_large",
    };
  }

  return {
    mode: "incremental",
    added: actualAdded,
    modified,
    deleted: actualDeleted,
    renamed: renames,
    unchanged,
    initiallyInvalidatedFiles: invalidated,
    affectedClosureFiles: invalidated,
  };
}

export function computeBindingContextHash(results: readonly ParseResult[]): string {
  const surface = results.flatMap((result) => [
    `file\0${result.file.path}\0${result.file.language}`,
    ...result.symbols.map((symbol) => [
      "symbol",
      symbol.id,
      symbol.fqName,
      symbol.kind,
      symbol.signature,
      symbol.exported ? "1" : "0",
      symbol.parentSymbolId ?? "",
    ].join("\0")),
    ...(isPackageSurfacePath(result.file.path) ? [`package\0${result.file.path}\0${result.file.contentHash}`] : []),
  ]).sort();
  return sha256(surface.join("\n"));
}

export function computeSemanticContextHash(results: readonly ParseResult[]): string {
  const surface = results.flatMap((result) => [
    `file\0${result.file.path}\0${result.file.language}`,
    ...result.symbols.map((symbol) => [
      "symbol",
      symbol.filePath,
      symbol.fqName,
      symbol.localName,
      symbol.kind,
      symbol.signature,
      symbol.exported ? "1" : "0",
    ].join("\0")),
    ...(isPackageSurfacePath(result.file.path) ? [`package\0${result.file.path}\0${result.file.contentHash}`] : []),
  ]).sort();
  return sha256(surface.join("\n"));
}

export function computeSnapshotHash(files: readonly IndexedFileSnapshot[]): string {
  return sha256([...files]
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((file) => JSON.stringify(file))
    .join("\n"));
}

export function isValidSnapshotSet(value: unknown): value is IndexedFileSnapshotSet {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Partial<IndexedFileSnapshotSet>;
  if (snapshot.schemaVersion !== FILE_SNAPSHOT_SCHEMA_VERSION || !Array.isArray(snapshot.files)) return false;
  if (snapshot.fileCount !== snapshot.files.length || typeof snapshot.snapshotHash !== "string" || typeof snapshot.semanticContextHash !== "string" || typeof snapshot.parserRegistryFingerprint !== "string") return false;
  if (snapshot.files.some((file) => (
    (file.indexOutcome !== "indexed" && file.indexOutcome !== "skipped" && file.indexOutcome !== "failed")
    || (file.parserCapability !== "supported" && file.parserCapability !== "unregistered" && file.parserCapability !== "unsupported")
    || (file.indexOutcome === "indexed" && (typeof file.parserId !== "string" || typeof file.parserVersion !== "string" || typeof file.parserConfigFingerprint !== "string" || typeof file.parseCacheKey !== "string"))
    // A `failed` entry without its failure record would be a file we know we
    // could not index and cannot say anything about — worse than not recording it.
    || (file.indexOutcome === "failed" && (typeof file.failure?.failureClass !== "string" || typeof file.failure?.message !== "string"))
  ))) return false;
  return computeSnapshotHash(snapshot.files) === snapshot.snapshotHash;
}

export function emptyTimings(): IndexTimings {
  return { discovery: 0, read: 0, planning: 0, parsing: 0, invalidation: 0, linking: 0, persistence: 0, retrievalIndex: 0, validation: 0, bookkeeping: 0, parseCacheWrite: 0, commit: 0, total: 0 };
}

function isPackageSurfacePath(filePath: string): boolean {
  return /(^|\/)(__init__\.py|index\.[cm]?[jt]sx?)$/.test(filePath);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
