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

export interface IndexProjectFileContent {
  file: FileRecord;
  content: string;
}

export interface IndexProjectOptions {
  repoRoot: string;
  db: Database;
  createParserRegistry?: (files: readonly IndexProjectFileContent[]) => ParserRegistry;
  onProgress?: ProgressReporter;
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
}
