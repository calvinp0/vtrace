import type { Database } from "bun:sqlite";

import type { ProgressReporter } from "../cli/progress";
import type {
  FileRecord,
  Language,
  ParseDiagnostic,
} from "../domain/types";
import type {
  ParserRegistry,
  SerializedParserError,
} from "../parsers";
import type {
  FullRebuildReason,
  IndexedFileSnapshotSet,
  IndexPerformanceDiagnostics,
  IndexRefreshMode,
} from "./incrementalIndex";

export interface IndexProjectFileContent {
  file: FileRecord;
  content: string;
}

export interface IndexProjectOptions {
  repoRoot: string;
  db: Database;
  createParserRegistry?: (files: readonly IndexProjectFileContent[]) => ParserRegistry;
  onProgress?: ProgressReporter;
  refreshMode?: IndexRefreshMode;
  previousSnapshot?: IndexedFileSnapshotSet;
  parserVersion?: string;
  parserConfigFingerprint?: string;
  baseSnapshotWorktreeId?: string;
  baseSnapshotHead?: string;
  hasExistingGraph?: boolean;
  previousSnapshotCompatible?: boolean;
  incompatibilityReason?: FullRebuildReason;
  validateGraph?: (db: Database, expectedFileCount: number) => void;
  /**
   * Enumeration overrides. Supply `worktreeExclusions` when the caller already
   * resolved the nested-worktree set for this root (saving a `git worktree list`),
   * or to enumerate under a deliberately different exclusion policy — which is
   * how the M132 acceptance harness reproduces the pre-exclusion index for a
   * before/after comparison without re-checking out old source.
   */
  scanOptions?: import("../fs/scanRepo").RepoScanOptions;
}

export type IndexedFileStatus =
  | "indexed"
  | "read_failed"
  | "parse_failed"
  | "unregistered_language"
  | "unsupported_language"
  | "persistence_failed";

export interface IndexedFileSummary {
  path: string;
  language: Language;
  status: IndexedFileStatus;
  diagnostics: ParseDiagnostic[];
  error?: SerializedParserError | IndexerFileError;
}

export interface IndexerFileError {
  code: string;
  message: string;
}

export class IndexingFileFailuresError extends Error {
  readonly failures: readonly IndexedFileSummary[];

  constructor(failures: readonly IndexedFileSummary[]) {
    const first = failures[0];
    super(first === undefined
      ? "Indexing failed for one or more source files"
      : `Indexing failed for ${failures.length} source file${failures.length === 1 ? "" : "s"}; first failure: ${first.path} (${first.status})${first.error?.message === undefined ? "" : `: ${first.error.message}`}`);
    this.name = "IndexingFileFailuresError";
    this.failures = failures;
  }
}

/**
 * M156: how much of the repository this index actually covers.
 *
 * Separate from freshness on purpose (§18). An index can correspond exactly to
 * the current source revision and still be semantically incomplete, because a
 * file in scope could not be parsed. Overloading `fresh` to mean `complete` is
 * how "we indexed the repository" becomes a claim nobody checked.
 *
 * The arithmetic is an invariant, not a convenience (§76, §77):
 *
 *   filesEligible = filesIndexed + filesFailed + filesSkipped
 */
export interface IndexCoverageSummary {
  /** Files enumeration considered after exclusion rules. */
  readonly filesEligible: number;
  readonly filesIndexed: number;
  readonly filesFailed: number;
  readonly filesSkipped: number;
  /** False as soon as one eligible file failed. Derived, never asserted. */
  readonly complete: boolean;
  /** Distinct languages among failed files, so relevance can be judged (§24). */
  readonly failedLanguages: readonly string[];
}

export interface IndexProjectResult {
  totalFilesScanned: number;
  totalFilesAttemptedForParse: number;
  totalFilesSuccessfullyIndexed: number;
  totalParseFailures: number;
  totalSkippedUnregisteredLanguage: number;
  totalSkippedUnsupportedLanguage: number;
  totalReadFailures: number;
  totalPersistenceFailures: number;
  totalSymbols: number;
  totalRelationships: number;
  files: IndexedFileSummary[];
  coverage: IndexCoverageSummary;
  snapshot?: IndexedFileSnapshotSet;
  performance?: IndexPerformanceDiagnostics;
  /**
   * Nested linked worktrees found beneath this root and skipped. Repo-relative
   * paths only, so the value is comparable across checkouts and machines.
   */
  worktreeExclusions?: import("../fs/worktreeExclusions").WorktreeExclusionDiagnostics;
}
