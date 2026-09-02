import { createHash } from "node:crypto";

import {
  Language,
  type FilePath,
  type FileRecord,
  type ModuleBinding,
  type ModuleBindingSurface,
  type ParseResult,
} from "../domain/types";

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
  /**
   * M200. Modified files that publish an importable surface, and therefore carry
   * a question this planner cannot answer.
   *
   * Before M200 the presence of one of these WAS the answer: a package-surface
   * modification meant `closure_uncertain` and a full rebuild. But whether such
   * an edit changed anything importable is a fact about parsed bindings, and
   * this planner runs before parsing — it holds content hashes, and a content
   * hash cannot tell a redirected re-export from an added comment. So the
   * question is carried forward to the post-parse resolver, which has both
   * surfaces and the persisted reverse authority to answer it with.
   */
  readonly packageSurfaceCandidates: readonly string[];
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
  /**
   * M200. Present only on a refresh that had a module-binding question to
   * answer — a modified file whose importable surface may have moved.
   *
   * Published because `MAX_BINDING_CLOSURE_FRACTION` is a cost policy set at a
   * conservative 0.20 and not yet an evidence-derived crossover. These are the
   * numbers a later milestone needs to replace it with a measured one: how big
   * the closure actually was, how much work it implied, and what the rebuild it
   * displaced would have cost. Absent means no binding surface changed, which is
   * itself the answer for the frozen A3 fixture.
   */
  bindingClosure?: BindingClosureDiagnostics;
}

export interface BindingClosureDiagnostics {
  /** Modified files whose derived surface differs from the persisted one. */
  changedModules: readonly string[];
  /** Consumers the reverse walk reached, before the cap was applied. */
  closureFiles: readonly string[];
  /** Modules the walk visited, including those reached through re-export chains. */
  visitedModules: number;
  /** Files this refresh reparsed because the closure named them. */
  reparsedForClosure: number;
  /** The denominator the cap is taken against. */
  repositoryFileCount: number;
  maxClosureFraction: number;
  /** Null when the closure was derived; the refusal that forced a rebuild otherwise. */
  refusal: string | null;
  refusalDetail?: string;
  /** Wall time spent deciding, so the derivation cannot hide its own cost. */
  derivationMs: number;
  /** Files a full rebuild would have reparsed instead. The saving, when bounded. */
  filesAFullRebuildWouldParse: number;
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
    return { mode: "full_rebuild", ...empty, initiallyInvalidatedFiles: current.map((f) => f.path), affectedClosureFiles: current.map((f) => f.path), packageSurfaceCandidates: [] };
  }
  if (!input.compatible) {
    return {
      mode: "full_rebuild",
      ...empty,
      initiallyInvalidatedFiles: current.map((f) => f.path),
      affectedClosureFiles: current.map((f) => f.path),
      fullRebuildReason: input.incompatibilityReason ?? "unknown",
      packageSurfaceCandidates: [],
    };
  }
  if (previous === undefined) {
    return {
      mode: "full_rebuild",
      ...empty,
      initiallyInvalidatedFiles: current.map((f) => f.path),
      affectedClosureFiles: current.map((f) => f.path),
      fullRebuildReason: "snapshot_missing",
      packageSurfaceCandidates: [],
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
    return { mode: "noop", added: actualAdded, modified, deleted: actualDeleted, renamed: renames, unchanged, initiallyInvalidatedFiles: [], affectedClosureFiles: [], packageSurfaceCandidates: [] };
  }

  // Adds, deletes and renames can change old resolutions without a queryable
  // reverse dependency: a new file can claim a module name an existing import
  // already resolved elsewhere, and a deleted one can strand resolutions the
  // graph never recorded as edges. M200 did not make those derivable and does
  // not claim to — only the package-surface case moved, and it moved because a
  // modification leaves the file set intact, so the persisted descriptors
  // describe the same repository the new parse does.
  const uncertain = actualAdded.length > 0 || actualDeleted.length > 0 || renames.length > 0;
  const packageSurfaceCandidates = modified
    .map((change) => change.relativePath)
    .filter((relativePath) => isPackageSurfacePath(relativePath))
    .sort();
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
      packageSurfaceCandidates,
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
      packageSurfaceCandidates,
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
      packageSurfaceCandidates,
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
    packageSurfaceCandidates,
  };
}

/**
 * The binding term a context hash contributes for one file (M200).
 *
 * Three cases, and the distinction between the last two is the milestone:
 *
 *   - a parser that models bindings -> the DERIVED surface digest. Comments and
 *     formatting do not appear in it; a redirected re-export does.
 *   - a package surface from a parser that does not (TypeScript `index.ts`,
 *     Cython) -> the raw content hash, exactly as before M200. Nothing here
 *     knows what those files publish, and inventing a derivation for them would
 *     be the false-negative this module is built to avoid.
 *   - anything else -> no term.
 *
 * `overrides` substitutes a PERSISTED digest for a freshly derived one. It has
 * exactly one caller: the post-parse resolver asking "would this hash have
 * matched if the binding surfaces had not moved?", which is how it decides
 * whether a semantic difference is confined to bindings without maintaining a
 * second per-file surface ledger that could disagree with this one.
 */
function bindingTermFor(
  result: ParseResult,
  digestOf: (surface: NonNullable<ParseResult["bindingSurface"]>) => string,
  overrides?: ReadonlyMap<string, string>,
): string[] {
  if (result.bindingSurface !== undefined) {
    const digest = overrides?.get(result.file.path) ?? digestOf(result.bindingSurface);
    return [`binding\0${result.file.path}\0${digest}`];
  }
  if (isPackageSurfacePath(result.file.path)) {
    return [`package\0${result.file.path}\0${result.file.contentHash}`];
  }
  return [];
}

export function computeBindingContextHash(
  results: readonly ParseResult[],
  overrides?: ReadonlyMap<string, string>,
): string {
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
    ...bindingTermFor(result, bindingSurfaceDigest, overrides),
  ]).sort();
  return sha256(surface.join("\n"));
}

export function computeSemanticContextHash(
  results: readonly ParseResult[],
  overrides?: ReadonlyMap<string, string>,
): string {
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
    ...bindingTermFor(result, bindingSurfaceDigest, overrides),
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

/**
 * A file that publishes an importable surface for a whole directory: a Python
 * package `__init__.py`, or a JS/TS `index` module. Shared with the indexer so
 * the planner and the post-parse resolver cannot disagree about which files
 * carry a package question.
 */
export function isPackageSurfacePath(filePath: string): boolean {
  return /(^|\/)(__init__\.py|index\.[cm]?[jt]sx?)$/.test(filePath);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// M200 — deriving which files a module-binding change can reach.
//
// The problem this solves is stated most clearly by what it replaced. Before
// M200, a modification to a package `__init__.py` was `closure_uncertain`: the
// planner could not name the files whose import resolutions would change, so it
// invalidated all of them. That was correct and, on the frozen C-LARGE k=3
// fixture, cost a whole rebuild for an appended comment.
//
// Two things had to become derivable for that to stop being the only safe
// answer. First, whether a package's importable surface changed AT ALL, which is
// a question about parsed bindings and not about bytes (`ModuleBindingSurface`).
// Second, when it did change, which files resolve through it — which is a
// reverse query the graph could not answer, because an `imports` edge exists
// only when both ends resolve to a symbol, and the interesting consumers are
// exactly the ones whose resolution is about to move.
//
// The closure over-approximates on purpose. §13: a false positive costs a
// reparse, a false negative leaves a stale edge pointing at a symbol that no
// longer answers for the name. Every refusal below returns `full_rebuild`
// rather than a smaller closure.
// ---------------------------------------------------------------------------


/** Why a bounded closure could not be derived, and a rebuild is the answer. */
export type ClosureRefusal =
  /** A changed module publishes names through `from x import *`. */
  | "wildcard_surface"
  /** A consumer reaches a changed module through `from x import *`. */
  | "wildcard_consumer"
  /** A file changed that no parser models bindings for (TypeScript, Cython, documents). */
  | "surface_not_derivable"
  /** The index predates persisted descriptors, or holds none for a file it should. */
  | "descriptors_unavailable"
  /** The closure reached the size at which a rebuild is the cheaper way to the same graph. */
  | "closure_too_large";

export type BindingClosure =
  | { readonly ok: true; readonly files: readonly FilePath[]; readonly visitedModules: readonly FilePath[] }
  | { readonly ok: false; readonly refusal: ClosureRefusal; readonly detail: string };

/**
 * The serialization a surface is compared by.
 *
 * Deliberately total over the type: a field added to `ModuleBinding` that is not
 * hashed here would be a semantic difference the comparison cannot see, so the
 * bindings are written out field by field rather than through `JSON.stringify`,
 * whose output would silently follow a shape change without anyone deciding it
 * should.
 */
export function bindingSurfaceDigest(surface: ModuleBindingSurface): string {
  const lines = [
    `path\0${surface.filePath}`,
    `package\0${surface.isPackageSurface ? "1" : "0"}`,
    // A surface with unenumerable names is never equal to one without, even if
    // the names it CAN enumerate match.
    `unbounded\0${surface.unboundedNames ? "1" : "0"}`,
    ...surface.bindings.map((binding: ModuleBinding) => [
      "bind", binding.localName, binding.kind, binding.importedName ?? "", binding.targetPath ?? "",
    ].join("\0")),
  ];
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * The reverse half of the authority, as the closure needs to consult it.
 *
 * An interface rather than a concrete query so the closure can be exercised
 * against an in-memory authority in tests and against SQLite in production,
 * without the derivation itself knowing which it has.
 */
export interface ReverseBindingAuthority {
  /**
   * Files holding at least one import descriptor that resolved to `target`.
   * Must include module-form importers (`import pkg`), whose descriptors name no
   * member and can therefore reach any name the target publishes.
   */
  importersOf(target: FilePath): readonly FilePath[];
  /**
   * Files that reach `target` through a wildcard import. These are the consumers
   * whose bound names cannot be enumerated, so their dependence on a particular
   * name of `target` cannot be decided.
   */
  wildcardImportersOf(target: FilePath): readonly FilePath[];
  /**
   * True when `file` republishes any name that resolves into `target`, which
   * makes `file`'s own surface change when `target`'s does, and so extends the
   * walk to `file`'s importers (§11).
   */
  reExportsThrough(file: FilePath, target: FilePath): boolean;
  /** False when this index holds no descriptor authority at all. */
  isAvailable(): boolean;
}

/**
 * The fraction of the repository a binding closure may reach before a full
 * rebuild is taken instead.
 *
 * This is a COST boundary, not a correctness one. Everything below the cap and
 * everything above it produce the same graph; the cap only decides which way of
 * arriving there is cheaper, exactly as `MEASURED_LIGHTWEIGHT_PARSER_CHANGE_RATIO`
 * does for the parser-cost rule it is deliberately set equal to. A closure that
 * exceeds it is refused truthfully as `closure_too_large` — never silently
 * trimmed, which would be the one failure mode this whole module exists to
 * prevent.
 *
 * 0.20 is a conservative initial policy and not yet an evidence-derived
 * crossover. `IndexPerformanceDiagnostics.bindingClosure` publishes the closure
 * size and the work it implied on every refresh that computes one, so the
 * threshold can later be justified or replaced by a measured crossover rather
 * than re-argued. It was NOT chosen to make any frozen claim pass: the frozen
 * C-LARGE k=3 fixture changes no binding surface, so no closure is derived for
 * it and the cap is never consulted.
 */
export const MAX_BINDING_CLOSURE_FRACTION = 0.20;

export interface BindingClosureInput {
  /** Modules whose binding surface differs from the persisted one. */
  readonly changedModules: readonly FilePath[];
  /** Changed files no parser could produce a surface for. */
  readonly surfaceless: readonly FilePath[];
  /** Changed modules whose new or old surface carries `unboundedNames`. */
  readonly unboundedModules: readonly FilePath[];
  readonly authority: ReverseBindingAuthority;
  /** Files the repository holds, the cap is taken against. */
  readonly repositoryFileCount: number;
  readonly maxClosureFraction: number;
}

/**
 * Walk consumers outward from the changed modules.
 *
 * The walk is transitive because a re-export chain is: a consumer of `pkg` whose
 * name resolves through `pkg/__init__.py` into `pkg/a.py` and on into
 * `pkg/b.py` depends on every step, and only the first step is a direct
 * importer. The `visited` set makes a cyclic chain terminate (§11) rather than
 * being detected and refused — a cycle is a real Python shape, and refusing it
 * would rebuild the repository for an ordinary edit.
 */
export function deriveBindingClosure(input: BindingClosureInput): BindingClosure {
  if (!input.authority.isAvailable()) {
    return { ok: false, refusal: "descriptors_unavailable", detail: "no persisted import descriptors" };
  }
  if (input.surfaceless.length > 0) {
    return {
      ok: false, refusal: "surface_not_derivable",
      detail: `${input.surfaceless.length} changed file(s) have no binding surface: `
        + `${[...input.surfaceless].sort().slice(0, 5).join(", ")}`,
    };
  }
  if (input.unboundedModules.length > 0) {
    return {
      ok: false, refusal: "wildcard_surface",
      detail: `${[...input.unboundedModules].sort().slice(0, 5).join(", ")}`,
    };
  }

  const files = new Set<FilePath>();
  const visited = new Set<FilePath>();
  const queue = [...input.changedModules].sort();
  const cap = Math.max(1, Math.floor(input.repositoryFileCount * input.maxClosureFraction));

  while (queue.length > 0) {
    const target = queue.shift()!;
    if (visited.has(target)) continue;
    visited.add(target);

    const wildcardConsumers = input.authority.wildcardImportersOf(target);
    if (wildcardConsumers.length > 0) {
      return {
        ok: false, refusal: "wildcard_consumer",
        detail: `${[...wildcardConsumers].sort().slice(0, 5).join(", ")} reach ${target} by wildcard`,
      };
    }

    for (const importer of input.authority.importersOf(target)) {
      if (!files.has(importer)) {
        files.add(importer);
        if (files.size > cap) {
          return {
            ok: false, refusal: "closure_too_large",
            detail: `${files.size} files exceeds the cap of ${cap} `
              + `(${input.maxClosureFraction} of ${input.repositoryFileCount})`,
          };
        }
      }
      // Only a republisher's own consumers can be reached further out. A file
      // that merely USES a name from the changed module ends the walk there.
      if (!visited.has(importer) && input.authority.reExportsThrough(importer, target)) {
        queue.push(importer);
      }
    }
  }

  return { ok: true, files: [...files].sort(), visitedModules: [...visited].sort() };
}
