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
  snapshot?: IndexedFileSnapshotSet;
  performance?: IndexPerformanceDiagnostics;
}
