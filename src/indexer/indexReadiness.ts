import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";

import {
  INDEX_FORMAT_VERSION,
  buildExpectedIndexMeta,
  resolveIndexDbPath,
  resolveIndexMetaPath,
  type ExpectedIndexMeta,
  type IndexMeta,
  type WorktreeIndexFreshnessAction,
  type WorktreeIndexFreshnessReason,
  type WorktreeIndexFreshnessResult,
  type WorktreeIndexFreshnessStatus,
  type WorktreeIndexManifest,
} from "./indexMeta";
import { resolveWorktreeIdentity, type ResolvedWorktreeIdentity } from "./worktreeIdentity";

/**
 * M141 Workstream A.
 *
 * One authoritative readiness evaluation for a stored index. Before M141 two
 * unrelated models answered "can this index be used?": the watcher-oriented
 * source-snapshot comparison behind `index_status`, and the manifest comparison
 * behind every product tool. They disagreed whenever VTRACE's own indexer or
 * parser source moved without the indexed repository changing — `index_status`
 * reported `fresh / no rebuild needed` while the very next `get_code_context`
 * refused the same index with `index_schema_changed`.
 *
 * The fix is to decompose readiness into independent dimensions and evaluate
 * every one of them, rather than short-circuiting at the first failure:
 *
 *   ready = sourceFresh
 *         AND schemaCompatible
 *         AND capabilityCompatible
 *         AND repositoryCompatible
 *         AND worktreeCompatible
 *
 * `inspectWorktreeIndexFreshness` is derived from this evaluation and keeps its
 * exact pre-M141 contract, so product behavior is unchanged while every surface
 * now shares one computation.
 */

/** Machine-readable readiness state. Never inferred from a human string. */
export type IndexReadinessState =
  | "ready"
  | "source_stale"
  | "schema_incompatible"
  | "capability_incompatible"
  | "repository_mismatch"
  | "worktree_mismatch"
  | "index_missing"
  | "index_corrupt";

/** Bounded reason codes. Only conditions the implementation actually detects. */
export type IndexReadinessReason =
  | "fresh"
  | "source_changed"
  | "dirty_fingerprint_changed"
  | "head_changed"
  | "schema_changed"
  | "schema_unsupported"
  | "capability_missing"
  | "wrong_repository"
  | "wrong_worktree"
  | "index_missing"
  | "index_unreadable";

/** Actions VTRACE actually supports. Distinct from `ready`. */
export type IndexReadinessAction =
  | "none"
  | "incremental_refresh"
  | "full_rebuild"
  | "unsupported_runtime_upgrade"
  | "inspect_index";

/**
 * Optional index capabilities that a stored index may or may not carry. Both
 * are real, cheaply probeable, and optional by existing contract: M131
 * deliberately preserved support for older indexes without `edge_call_sites`,
 * and document retrieval degrades when `document_chunks` is absent.
 *
 * M140's structural `<module>` symbols are intentionally NOT modelled here.
 * They needed no schema bump (the DB already allowed `symbols.kind = module`),
 * so there is no truthful cheap probe that distinguishes "index predates M140"
 * from "repository genuinely has no module-scope imports".
 */
export const INDEX_CAPABILITIES = ["edge_call_sites", "document_chunks"] as const;
export type IndexCapability = (typeof INDEX_CAPABILITIES)[number];

/** Index format versions this runtime can read without a rebuild. */
export const SUPPORTED_INDEX_FORMAT_VERSIONS: ReadonlySet<number> = new Set([INDEX_FORMAT_VERSION]);

export interface IndexReadiness {
  /** True only when every dimension below is satisfied. */
  readonly ready: boolean;
  readonly state: IndexReadinessState;
  readonly reason: IndexReadinessReason;
  readonly recommendedAction: IndexReadinessAction;

  /** Does the index correspond to the requested repository/worktree source state? */
  readonly sourceFresh: boolean;
  /** Can this runtime read and interpret the stored index schema? */
  readonly schemaCompatible: boolean;
  /** Does the index carry every capability the caller declared it needs? */
  readonly capabilityCompatible: boolean;
  readonly repositoryCompatible: boolean;
  readonly worktreeCompatible: boolean;

  /** Every dimension that failed, in evaluation order. Empty when ready. */
  readonly failedDimensions: readonly IndexReadinessDimension[];
  readonly capabilities: IndexCapabilityReport;
  readonly identity: ResolvedWorktreeIdentity;
  readonly requestedWorktree: { readonly root: string; readonly headCommit: string | null };
  readonly indexedWorktree: { readonly root: string; readonly headCommit: string | null } | null;
  readonly storedFormatVersion: number | null;
  readonly manifest: WorktreeIndexManifest | undefined;
  /** The pre-M141 freshness view, derived from this same evaluation. */
  readonly freshness: WorktreeIndexFreshnessResult;
}

export type IndexReadinessDimension =
  | "source"
  | "schema"
  | "capability"
  | "repository"
  | "worktree"
  | "presence"
  | "integrity";

export interface IndexCapabilityReport {
  /** null when capabilities were not probed (probe mode `manifest`). */
  readonly available: Readonly<Record<IndexCapability, boolean>> | null;
  readonly required: readonly IndexCapability[];
  readonly missing: readonly IndexCapability[];
  readonly probed: boolean;
}

export interface EvaluateIndexReadinessOptions {
  /**
   * `manifest` (default) reads only identity + manifest metadata: no DB open,
   * no content scan. `full` additionally opens the index read-only to verify it
   * is readable and to probe optional capabilities.
   */
  readonly probe?: "manifest" | "full";
  /** Capabilities the requesting operation cannot run without. */
  readonly requiredCapabilities?: readonly IndexCapability[];
  /** Reuse an already-open index handle instead of opening one. */
  readonly db?: Database;
  /** Reuse identity resolved once per request (see `buildIndexRequestContext`). */
  readonly identity?: ResolvedWorktreeIdentity;
  /** Reuse fingerprints computed once per request. */
  readonly expected?: ExpectedIndexMeta;
}

export async function evaluateIndexReadiness(
  repoRoot: string,
  options: EvaluateIndexReadinessOptions = {},
): Promise<IndexReadiness> {
  const identity = options.identity ?? await resolveWorktreeIdentity(repoRoot);
  const worktreeRoot = identity.worktree.worktreeRoot;
  const requestedWorktree = { root: worktreeRoot, headCommit: identity.snapshot.headCommit };
  const required = normalizeRequiredCapabilities(options.requiredCapabilities);

  if (!(await pathExists(resolveIndexDbPath(worktreeRoot)))) {
    return absent({
      identity,
      requestedWorktree,
      required,
      state: "index_missing",
      reason: "index_missing",
      recommendedAction: "full_rebuild",
      dimension: "presence",
      legacy: { status: "missing", reason: "missing_index", action: "call_index_repo" },
    });
  }

  const stored = await readIndexMetaSafely(worktreeRoot);
  if (!isWorktreeAwareIndexMeta(stored)) {
    return absent({
      identity,
      requestedWorktree,
      required,
      state: "index_corrupt",
      reason: "index_unreadable",
      recommendedAction: "full_rebuild",
      dimension: "integrity",
      legacy: { status: "stale", reason: "manifest_invalid", action: "rebuild_index" },
    });
  }

  const manifest = stored.manifest;
  const indexedWorktree = { root: manifest.worktree.root, headCommit: manifest.snapshot.headCommit };
  const expected = options.expected ?? await buildExpectedIndexMeta(worktreeRoot);

  // Every dimension is evaluated; none short-circuits. That is what makes
  // `sourceFresh=true, schemaCompatible=false` expressible at all.
  const repositoryCompatible = manifest.repository.repositoryId === identity.repository.repositoryId
    && manifest.repository.gitCommonDir === identity.repository.gitCommonDir;
  const worktreeCompatible = manifest.worktree.worktreeId === identity.worktree.worktreeId
    && manifest.worktree.root === worktreeRoot
    && manifest.worktree.gitDir === identity.worktree.worktreeGitDir;

  const formatMismatch = manifest.schemaVersion !== INDEX_FORMAT_VERSION
    || manifest.index.indexSchemaVersion !== INDEX_FORMAT_VERSION
    || stored.index_format_version !== expected.index_format_version;
  const runtimeMismatch = stored.schema_version !== expected.schema_version
    || stored.indexer_fingerprint !== expected.indexer_fingerprint
    || stored.parser_fingerprint !== expected.parser_fingerprint
    || manifest.index.parserVersion !== expected.parser_fingerprint;
  const schemaCompatible = !formatMismatch && !runtimeMismatch;
  // A stored index newer than anything this runtime knows cannot be rebuilt
  // into compatibility by re-indexing with an older binary.
  const storedFormatVersion = maxStoredFormatVersion(stored, manifest);
  const schemaUnsupported = !schemaCompatible
    && storedFormatVersion !== null
    && !SUPPORTED_INDEX_FORMAT_VERSIONS.has(storedFormatVersion)
    && storedFormatVersion > INDEX_FORMAT_VERSION;

  // The config hash governs WHICH files are in scope for indexing, so a change
  // means the indexed set may no longer correspond to the requested source
  // state. That is a source-correspondence question, not a schema-read one.
  const configurationChanged = stored.config_hash !== expected.config_hash
    || manifest.index.configFingerprint !== expected.config_hash;
  const headChanged = manifest.snapshot.headCommit !== identity.snapshot.headCommit;
  const dirtyChanged = manifest.snapshot.dirty !== identity.snapshot.dirty
    || manifest.snapshot.dirtyFingerprint !== identity.snapshot.dirtyFingerprint;
  const sourceFresh = !configurationChanged && !headChanged && !dirtyChanged;

  const integrity = await probeIndexIntegrityAndCapabilities(worktreeRoot, options);
  if (integrity.readable === false) {
    return absent({
      identity,
      requestedWorktree,
      indexedWorktree,
      manifest,
      storedFormatVersion,
      required,
      state: "index_corrupt",
      reason: "index_unreadable",
      recommendedAction: "full_rebuild",
      dimension: "integrity",
      legacy: { status: "stale", reason: "manifest_invalid", action: "rebuild_index" },
    });
  }

  const missing = integrity.capabilities === null
    ? []
    : required.filter((capability) => integrity.capabilities![capability] !== true);
  const capabilityCompatible = missing.length === 0;
  const capabilities: IndexCapabilityReport = {
    available: integrity.capabilities,
    required,
    missing,
    probed: integrity.capabilities !== null,
  };

  const failedDimensions: IndexReadinessDimension[] = [];
  if (!repositoryCompatible) failedDimensions.push("repository");
  if (!worktreeCompatible) failedDimensions.push("worktree");
  if (!schemaCompatible) failedDimensions.push("schema");
  if (!capabilityCompatible) failedDimensions.push("capability");
  if (!sourceFresh) failedDimensions.push("source");

  const ready = failedDimensions.length === 0;
  const { state, reason, recommendedAction } = classify({
    ready,
    repositoryCompatible,
    worktreeCompatible,
    schemaCompatible,
    schemaUnsupported,
    capabilityCompatible,
    configurationChanged,
    headChanged,
    dirtyChanged,
  });

  const legacy = deriveLegacyFreshness({
    repositoryCompatible,
    worktreeCompatible,
    formatMismatch,
    runtimeMismatch,
    configurationChanged,
    headChanged,
    dirtyChanged,
  });

  return {
    ready,
    state,
    reason,
    recommendedAction,
    sourceFresh,
    schemaCompatible,
    capabilityCompatible,
    repositoryCompatible,
    worktreeCompatible,
    failedDimensions,
    capabilities,
    identity,
    requestedWorktree,
    indexedWorktree,
    storedFormatVersion,
    manifest,
    freshness: {
      status: legacy.status,
      reason: legacy.reason,
      requestedWorktree,
      indexedWorktree,
      action: legacy.action,
      current: identity,
      manifest,
    },
  };
}

/**
 * The one readiness-derived answer product tools have always consumed. Kept
 * byte-identical to its pre-M141 contract: the precedence below reproduces the
 * original sequence of early returns exactly.
 */
function deriveLegacyFreshness(input: {
  repositoryCompatible: boolean;
  worktreeCompatible: boolean;
  formatMismatch: boolean;
  runtimeMismatch: boolean;
  configurationChanged: boolean;
  headChanged: boolean;
  dirtyChanged: boolean;
}): {
  status: WorktreeIndexFreshnessStatus;
  reason: WorktreeIndexFreshnessReason;
  action: WorktreeIndexFreshnessAction;
} {
  if (!input.repositoryCompatible) {
    return { status: "blocked", reason: "repository_mismatch", action: "choose_worktree" };
  }
  if (!input.worktreeCompatible) {
    return { status: "blocked", reason: "worktree_mismatch", action: "choose_worktree" };
  }
  if (input.formatMismatch || input.runtimeMismatch) {
    return { status: "stale", reason: "index_schema_changed", action: "rebuild_index" };
  }
  if (input.configurationChanged) {
    return { status: "stale", reason: "configuration_changed", action: "call_index_repo" };
  }
  if (input.headChanged) {
    return { status: "stale", reason: "head_mismatch", action: "call_index_repo" };
  }
  if (input.dirtyChanged) {
    return { status: "stale", reason: "working_tree_changed", action: "call_index_repo" };
  }
  return { status: "fresh", reason: "fresh", action: "none" };
}

function classify(input: {
  ready: boolean;
  repositoryCompatible: boolean;
  worktreeCompatible: boolean;
  schemaCompatible: boolean;
  schemaUnsupported: boolean;
  capabilityCompatible: boolean;
  configurationChanged: boolean;
  headChanged: boolean;
  dirtyChanged: boolean;
}): { state: IndexReadinessState; reason: IndexReadinessReason; recommendedAction: IndexReadinessAction } {
  if (input.ready) {
    return { state: "ready", reason: "fresh", recommendedAction: "none" };
  }
  if (!input.repositoryCompatible) {
    return { state: "repository_mismatch", reason: "wrong_repository", recommendedAction: "inspect_index" };
  }
  if (!input.worktreeCompatible) {
    return { state: "worktree_mismatch", reason: "wrong_worktree", recommendedAction: "inspect_index" };
  }
  if (!input.schemaCompatible) {
    return input.schemaUnsupported
      ? { state: "schema_incompatible", reason: "schema_unsupported", recommendedAction: "unsupported_runtime_upgrade" }
      : { state: "schema_incompatible", reason: "schema_changed", recommendedAction: "full_rebuild" };
  }
  if (!input.capabilityCompatible) {
    return { state: "capability_incompatible", reason: "capability_missing", recommendedAction: "full_rebuild" };
  }
  // Source staleness is the one class an incremental planner can resolve, so it
  // must never be reported as needing a full rebuild.
  const reason: IndexReadinessReason = input.headChanged
    ? "head_changed"
    : input.dirtyChanged
      ? "dirty_fingerprint_changed"
      : "source_changed";
  return { state: "source_stale", reason, recommendedAction: "incremental_refresh" };
}

function absent(input: {
  identity: ResolvedWorktreeIdentity;
  requestedWorktree: { root: string; headCommit: string | null };
  indexedWorktree?: { root: string; headCommit: string | null };
  manifest?: WorktreeIndexManifest;
  storedFormatVersion?: number | null;
  required: readonly IndexCapability[];
  state: IndexReadinessState;
  reason: IndexReadinessReason;
  recommendedAction: IndexReadinessAction;
  dimension: IndexReadinessDimension;
  legacy: {
    status: WorktreeIndexFreshnessStatus;
    reason: WorktreeIndexFreshnessReason;
    action: WorktreeIndexFreshnessAction;
  };
}): IndexReadiness {
  return {
    ready: false,
    state: input.state,
    reason: input.reason,
    recommendedAction: input.recommendedAction,
    sourceFresh: false,
    schemaCompatible: false,
    capabilityCompatible: false,
    repositoryCompatible: false,
    worktreeCompatible: false,
    failedDimensions: [input.dimension],
    capabilities: { available: null, required: input.required, missing: [...input.required], probed: false },
    identity: input.identity,
    requestedWorktree: input.requestedWorktree,
    indexedWorktree: input.indexedWorktree ?? null,
    storedFormatVersion: input.storedFormatVersion ?? null,
    manifest: input.manifest,
    freshness: {
      status: input.legacy.status,
      reason: input.legacy.reason,
      requestedWorktree: input.requestedWorktree,
      ...(input.indexedWorktree === undefined ? {} : { indexedWorktree: input.indexedWorktree }),
      action: input.legacy.action,
      current: input.identity,
      ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
    },
  };
}

async function probeIndexIntegrityAndCapabilities(
  worktreeRoot: string,
  options: EvaluateIndexReadinessOptions,
): Promise<{ readable: boolean | null; capabilities: Record<IndexCapability, boolean> | null }> {
  if (options.db !== undefined) {
    return { readable: true, capabilities: readCapabilities(options.db) };
  }
  if ((options.probe ?? "manifest") !== "full") {
    return { readable: null, capabilities: null };
  }

  let db: Database | undefined;
  try {
    db = new Database(resolveIndexDbPath(worktreeRoot), { readonly: true });
    // Forces SQLite to parse the header and schema; a truncated or non-SQLite
    // file fails here rather than at the first product query.
    db.query("SELECT count(*) AS tables FROM sqlite_master").get();
    return { readable: true, capabilities: readCapabilities(db) };
  } catch {
    return { readable: false, capabilities: null };
  } finally {
    db?.close();
  }
}

function readCapabilities(db: Database): Record<IndexCapability, boolean> | null {
  try {
    const rows = db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('edge_call_sites', 'document_chunks')",
    ).all() as Array<{ name: string }>;
    const present = new Set(rows.map((row) => row.name));
    return {
      edge_call_sites: present.has("edge_call_sites"),
      document_chunks: present.has("document_chunks"),
    };
  } catch {
    return null;
  }
}

function normalizeRequiredCapabilities(
  requested: readonly IndexCapability[] | undefined,
): readonly IndexCapability[] {
  if (requested === undefined || requested.length === 0) return [];
  return INDEX_CAPABILITIES.filter((capability) => requested.includes(capability));
}

function maxStoredFormatVersion(stored: IndexMeta, manifest: WorktreeIndexManifest): number | null {
  const candidates = [stored.index_format_version, manifest.schemaVersion, manifest.index.indexSchemaVersion]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return candidates.length === 0 ? null : Math.max(...candidates);
}

async function readIndexMetaSafely(repoPath: string): Promise<IndexMeta | undefined> {
  try {
    return JSON.parse(await readFile(resolveIndexMetaPath(repoPath), "utf8")) as IndexMeta;
  } catch {
    return undefined;
  }
}

function isWorktreeAwareIndexMeta(value: IndexMeta | undefined): value is IndexMeta {
  if (value === undefined) {
    return false;
  }
  const manifest = (value as Partial<IndexMeta>).manifest;
  return typeof manifest?.schemaVersion === "number"
    && (typeof manifest.repository?.gitCommonDir === "string" || manifest.repository?.gitCommonDir === null)
    && typeof manifest.repository?.repositoryId === "string"
    && typeof manifest.repository?.isGitRepository === "boolean"
    && typeof manifest.worktree?.root === "string"
    && (typeof manifest.worktree?.gitDir === "string" || manifest.worktree?.gitDir === null)
    && typeof manifest.worktree?.worktreeId === "string"
    && typeof manifest.worktree?.isGitWorktree === "boolean"
    && typeof manifest.snapshot?.detached === "boolean"
    && typeof manifest.snapshot?.dirty === "boolean"
    && typeof manifest.index?.indexSchemaVersion === "number"
    && typeof manifest.index?.configFingerprint === "string";
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** Compact, bounded readiness view for product responses. Never a manifest dump. */
export interface IndexReadinessSummary {
  readonly ready: boolean;
  readonly state: IndexReadinessState;
  readonly reason: IndexReadinessReason;
  readonly recommendedAction: IndexReadinessAction;
  readonly sourceFresh: boolean;
  readonly schemaCompatible: boolean;
  readonly capabilityCompatible: boolean;
  readonly repositoryCompatible: boolean;
  readonly worktreeCompatible: boolean;
  readonly missingCapabilities: readonly IndexCapability[];
}

export function summarizeIndexReadiness(readiness: IndexReadiness): IndexReadinessSummary {
  return {
    ready: readiness.ready,
    state: readiness.state,
    reason: readiness.reason,
    recommendedAction: readiness.recommendedAction,
    sourceFresh: readiness.sourceFresh,
    schemaCompatible: readiness.schemaCompatible,
    capabilityCompatible: readiness.capabilityCompatible,
    repositoryCompatible: readiness.repositoryCompatible,
    worktreeCompatible: readiness.worktreeCompatible,
    missingCapabilities: readiness.capabilities.missing,
  };
}

/**
 * Fold request-time runtime signals that live outside the manifest into the
 * authoritative readiness. Both `index_status` and `get_code_context` apply
 * this, which is what makes their verdicts agree: before M141 the watcher-drift
 * and empty-index downgrades existed only inside the `get_code_context` path.
 */
export function withRuntimeSignals(
  readiness: IndexReadiness,
  signals: { readonly observedSourceChanges?: boolean; readonly indexHasNoFiles?: boolean },
): IndexReadiness {
  if (signals.indexHasNoFiles === true) {
    return {
      ...readiness,
      ready: false,
      state: "index_missing",
      reason: "index_missing",
      recommendedAction: "full_rebuild",
      sourceFresh: false,
      failedDimensions: dedupeDimensions([...readiness.failedDimensions, "presence"]),
      freshness: {
        ...readiness.freshness,
        status: "missing",
        reason: "missing_index",
        action: "call_index_repo",
      },
    };
  }
  if (signals.observedSourceChanges === true && readiness.ready) {
    return {
      ...readiness,
      ready: false,
      state: "source_stale",
      reason: "source_changed",
      recommendedAction: "incremental_refresh",
      sourceFresh: false,
      failedDimensions: dedupeDimensions([...readiness.failedDimensions, "source"]),
      freshness: {
        ...readiness.freshness,
        status: "stale",
        reason: "working_tree_changed",
        action: "call_index_repo",
      },
    };
  }
  return readiness;
}

function dedupeDimensions(values: readonly IndexReadinessDimension[]): IndexReadinessDimension[] {
  return [...new Set(values)];
}

/**
 * The pre-M141 freshness contract every product tool already consumes, now a
 * projection of `evaluateIndexReadiness`. Status, reason, and action are
 * unchanged for every input, so no product behavior moves; the difference is
 * that `index_status` is answered by the same computation.
 */
export async function inspectWorktreeIndexFreshness(
  repoPath: string,
  options: Pick<EvaluateIndexReadinessOptions, "identity" | "expected"> = {},
): Promise<WorktreeIndexFreshnessResult> {
  return (await evaluateIndexReadiness(repoPath, options)).freshness;
}
