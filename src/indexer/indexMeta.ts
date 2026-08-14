import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readGitHead } from "../fs/git";
import { resolveWorktreeIdentity, type ResolvedWorktreeIdentity } from "./worktreeIdentity";
import {
  INIT_STATE_SCHEMA_VERSION,
  REPO_LOCAL_DB_FILENAME,
  REPO_LOCAL_STATE_DIRNAME,
} from "../setup/types";

/**
 * Bump when the SHAPE of index.meta.json changes (fields added/removed/renamed).
 * Distinct from the fingerprints below, which track the indexed CONTENT logic.
 */
export const INDEX_FORMAT_VERSION = 5 as const;

export const INDEX_META_FILENAME = "index.meta.json" as const;

// vtrace source root, resolved relative to this module (…/src/indexer/indexMeta.ts).
// Fingerprints hash files under here, so they change with the indexer's own code.
const VTRACE_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Source that, when changed, can change what gets indexed or how. These are
// hashed into the fingerprints below. Query-time surfaces (src/capsule*,
// src/capsuleV2, src/mcp, src/retrieval) are intentionally absent: a Capsule v2
// policy or rendering change must NOT invalidate an otherwise-valid index.
const PARSER_SOURCE_DIRS = ["src/parsers"] as const;
const INDEXER_SOURCE_DIRS = ["src/indexer", "src/db"] as const;
const SCHEMA_SOURCE_FILES = ["src/db/schema.ts"] as const;
const CONFIG_SOURCE_FILES = [
  "src/fs/scanRepo.ts",
  "src/fs/worktreeExclusions.ts",
  "src/fs/ignoreRules.ts",
  "src/fs/languageDetection.ts",
  "src/documents/documentPolicy.ts",
  "src/documents/documentChunks.ts",
] as const;

/**
 * The vtrace-side descriptor of an index: everything that should match for a
 * stored index to be considered valid, EXCLUDING the indexed repo's own head.
 */
export interface IndexFingerprint {
  index_format_version: number;
  schema_version: string;
  vtrace_commit: string | null;
  indexer_fingerprint: string;
  parser_fingerprint: string;
  config_hash: string;
}

/** The full freshness expectation: vtrace fingerprints + the indexed repo head. */
export interface ExpectedIndexMeta extends IndexFingerprint {
  repo_head: string | null;
}

/** The on-disk index.meta.json contents. */
export interface IndexMeta extends ExpectedIndexMeta {
  created_at: string;
  manifest: WorktreeIndexManifest;
}

export interface WorktreeIndexManifest {
  schemaVersion: number;
  repository: {
    gitCommonDir: string | null;
    repositoryId: string;
    isGitRepository: boolean;
    /** M145 instance evidence. Optional: indexes written before M145 have none. */
    instanceFingerprint?: string | null;
  };
  worktree: {
    root: string;
    gitDir: string | null;
    worktreeId: string;
    isGitWorktree: boolean;
    instanceFingerprint?: string | null;
  };
  snapshot: {
    headCommit: string | null;
    branch: string | null;
    detached: boolean;
    dirty: boolean;
    dirtyFingerprint: string | null;
  };
  index: {
    runId: number | string | null;
    indexedAt: string;
    parserVersion: string;
    indexSchemaVersion: number;
    configFingerprint: string;
  };
  files?: import("./incrementalIndex").IndexedFileSnapshotSet;
  performance?: import("./incrementalIndex").IndexPerformanceDiagnostics;
}

export type WorktreeIndexFreshnessStatus = "fresh" | "stale" | "missing" | "blocked";
export type WorktreeIndexFreshnessReason =
  | "fresh"
  | "missing_index"
  | "worktree_mismatch"
  | "repository_mismatch"
  | "head_mismatch"
  | "working_tree_changed"
  | "index_schema_changed"
  | "configuration_changed"
  | "manifest_invalid"
  | "index_in_progress"
  | "unknown";
export type WorktreeIndexFreshnessAction = "none" | "call_index_repo" | "retry" | "choose_worktree" | "rebuild_index";

export interface WorktreeIndexFreshnessResult {
  status: WorktreeIndexFreshnessStatus;
  reason: WorktreeIndexFreshnessReason;
  requestedWorktree: { root: string; headCommit: string | null };
  indexedWorktree?: { root: string; headCommit: string | null };
  action: WorktreeIndexFreshnessAction;
  current: ResolvedWorktreeIdentity;
  manifest?: WorktreeIndexManifest;
}

export interface IndexFreshness {
  fresh: boolean;
  reason: string;
  mismatches: string[];
}

// Fields whose disagreement makes a stored index STALE. vtrace_commit and
// created_at are informational only: the commit can move without any
// index-relevant logic change (already captured by the fingerprints), and the
// timestamp never affects validity.
const FRESHNESS_FIELDS = [
  "index_format_version",
  "schema_version",
  "parser_fingerprint",
  "indexer_fingerprint",
  "config_hash",
  "repo_head",
] as const;

// Human-readable reason for the FIRST mismatch, in the field-priority order above.
const MISMATCH_REASONS: Record<(typeof FRESHNESS_FIELDS)[number], string> = {
  index_format_version: "index format version changed",
  schema_version: "schema version changed",
  parser_fingerprint: "parser fingerprint changed",
  indexer_fingerprint: "indexer fingerprint changed",
  config_hash: "config hash changed",
  repo_head: "repo head changed",
};

export function resolveVtraceDir(repoPath: string): string {
  return path.join(path.resolve(repoPath), REPO_LOCAL_STATE_DIRNAME);
}

export function resolveIndexMetaPath(repoPath: string): string {
  return path.join(resolveVtraceDir(repoPath), INDEX_META_FILENAME);
}

export function resolveIndexDbPath(repoPath: string): string {
  return path.join(resolveVtraceDir(repoPath), REPO_LOCAL_DB_FILENAME);
}

/**
 * Compute the current vtrace-side fingerprints by content-hashing the parser,
 * indexer, schema, and scan-config source. Content (not mtime) is hashed so the
 * fingerprint is stable across checkouts and reflects actual logic, not file
 * metadata.
 */
export async function computeIndexFingerprints(): Promise<IndexFingerprint> {
  const [parserFingerprint, indexerFingerprint, schemaHash, configHash] = await Promise.all([
    hashSources(PARSER_SOURCE_DIRS, []),
    hashSources(INDEXER_SOURCE_DIRS, []),
    hashSources([], SCHEMA_SOURCE_FILES),
    hashSources([], CONFIG_SOURCE_FILES),
  ]);

  return {
    index_format_version: INDEX_FORMAT_VERSION,
    // The schema version pairs the declared init-state version with a hash of
    // the schema DDL, so it changes whenever the table definitions change.
    schema_version: `${INIT_STATE_SCHEMA_VERSION}+${schemaHash.slice(0, 12)}`,
    vtrace_commit: await readGitHead(VTRACE_SOURCE_ROOT) ?? null,
    indexer_fingerprint: indexerFingerprint,
    parser_fingerprint: parserFingerprint,
    config_hash: configHash,
  };
}

/** Fingerprints + the indexed repo head — the full freshness expectation. */
export async function buildExpectedIndexMeta(repoPath: string): Promise<ExpectedIndexMeta> {
  const fingerprints = await computeIndexFingerprints();
  return {
    ...fingerprints,
    repo_head: await readGitHead(path.resolve(repoPath)) ?? null,
  };
}

/** The full meta to persist after an index completes (adds created_at). */
export async function buildIndexMeta(
  repoPath: string,
  runId: number | string | null = null,
  details: Pick<WorktreeIndexManifest, "files" | "performance"> = {},
): Promise<IndexMeta> {
  const expected = await buildExpectedIndexMeta(repoPath);
  const identity = await resolveWorktreeIdentity(repoPath);
  const indexedAt = new Date().toISOString();
  return {
    ...expected,
    created_at: indexedAt,
    manifest: {
      schemaVersion: INDEX_FORMAT_VERSION,
      repository: { ...identity.repository },
      worktree: {
        root: identity.worktree.worktreeRoot,
        gitDir: identity.worktree.worktreeGitDir,
        worktreeId: identity.worktree.worktreeId,
        isGitWorktree: identity.worktree.isGitWorktree,
        instanceFingerprint: identity.worktree.instanceFingerprint,
      },
      snapshot: { ...identity.snapshot },
      index: {
        runId,
        indexedAt,
        parserVersion: expected.parser_fingerprint,
        indexSchemaVersion: INDEX_FORMAT_VERSION,
        configFingerprint: expected.config_hash,
      },
      ...(details.files === undefined ? {} : { files: details.files }),
      ...(details.performance === undefined ? {} : { performance: details.performance }),
    },
  };
}

export async function writeIndexMeta(repoPath: string, meta: IndexMeta): Promise<void> {
  await writeFile(resolveIndexMetaPath(repoPath), `${JSON.stringify(meta, null, 2)}\n`);
}

/** Build and write fresh metadata for a just-completed index. Returns the meta. */
export async function recordIndexMeta(
  repoPath: string,
  runId: number | string | null = null,
  details: Pick<WorktreeIndexManifest, "files" | "performance"> = {},
): Promise<IndexMeta> {
  const meta = await buildIndexMeta(repoPath, runId, details);
  await writeIndexMeta(repoPath, meta);
  return meta;
}

// `inspectWorktreeIndexFreshness` moved to ./indexReadiness in M141. It is now
// derived from the one authoritative readiness evaluation so that `index_status`
// and the product tools can never disagree about whether an index is usable.

export async function readIndexMeta(repoPath: string): Promise<IndexMeta | undefined> {
  try {
    return JSON.parse(await readFile(resolveIndexMetaPath(repoPath), "utf8")) as IndexMeta;
  } catch {
    return undefined;
  }
}

/**
 * Decide whether the index stored under repoPath/.vtrace can be reused given the
 * expected fingerprints. Stale when the index database is missing, the metadata
 * file is missing/unreadable, or any freshness-relevant field disagrees.
 */
export async function checkIndexFreshness(
  repoPath: string,
  expected: ExpectedIndexMeta,
): Promise<IndexFreshness> {
  if (!(await pathExists(resolveIndexDbPath(repoPath)))) {
    return { fresh: false, reason: "index database missing", mismatches: ["index_sqlite"] };
  }

  const stored = await readIndexMeta(repoPath);
  if (stored === undefined) {
    return { fresh: false, reason: "index metadata missing", mismatches: ["index_meta_file"] };
  }

  const mismatches = FRESHNESS_FIELDS.filter((field) => stored[field] !== expected[field]);
  if (mismatches.length === 0) {
    return { fresh: true, reason: "index metadata matches", mismatches: [] };
  }

  return {
    fresh: false,
    reason: MISMATCH_REASONS[mismatches[0]!],
    mismatches: [...mismatches],
  };
}

async function hashSources(
  dirs: readonly string[],
  files: readonly string[],
): Promise<string> {
  const collected: string[] = [...files.map((file) => path.join(VTRACE_SOURCE_ROOT, file))];

  for (const dir of dirs) {
    await collectTsSources(path.join(VTRACE_SOURCE_ROOT, dir), collected);
  }

  // Hash relative paths + content in a stable order so the digest is
  // reproducible regardless of filesystem traversal order.
  const relativeSorted = collected
    .map((absolutePath) => ({
      absolutePath,
      relativePath: path.relative(VTRACE_SOURCE_ROOT, absolutePath),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const hash = createHash("sha256");
  for (const { absolutePath, relativePath } of relativeSorted) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(absolutePath));
    hash.update("\n");
  }

  return hash.digest("hex");
}

// Recursively collect non-test TypeScript sources under a directory.
async function collectTsSources(directory: string, into: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await collectTsSources(entryPath, into);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }

    if (entry.name.endsWith(".test.ts") || entry.name.includes(".test.")) {
      continue;
    }

    into.push(entryPath);
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
