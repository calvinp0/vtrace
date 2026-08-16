import type { EnsureIndexAccessCapabilityOutcome } from "../access/indexAccessLifecycle";
import type { ProgressReporter } from "../cli/progress";
import type { IndexProjectResult } from "../indexer/types";
import type { IndexRunSummary } from "../memory/types";
// Type-only: the runtime edge runs the other way (generatedStateExclusion reads
// REPO_LOCAL_STATE_DIRNAME from here), so this import is erased at compile time.
import type { GeneratedStateExclusionResult } from "./generatedStateExclusion";

export const INIT_STATE_SCHEMA_VERSION = "1.0.0" as const;
export const REPO_LOCAL_STATE_DIRNAME = ".vtrace" as const;
export const REPO_LOCAL_CONFIG_FILENAME = "config.json" as const;
export const REPO_LOCAL_STATE_FILENAME = "state.json" as const;
export const REPO_LOCAL_DB_FILENAME = "index.sqlite" as const;
export const REPO_LOCAL_CONFIG_RELATIVE_PATH =
  `${REPO_LOCAL_STATE_DIRNAME}/${REPO_LOCAL_CONFIG_FILENAME}` as const;

export type RepoRootDetectionMode = "marker" | "provided_directory";
export type RepoRootMarker = ".git" | typeof REPO_LOCAL_CONFIG_RELATIVE_PATH;
export type RepoReadinessStatus = "ready" | "not_ready";

export interface RepoLocalPaths {
  repoRoot: string;
  stateDir: string;
  configPath: string;
  dbPath: string;
  statePath: string;
}

export interface RepoRootDetection {
  requestedPath: string;
  repoRoot: string;
  mode: RepoRootDetectionMode;
  marker?: RepoRootMarker;
}

export interface RepoReadinessCheck {
  id:
    | "repo_root_exists"
    | "state_directory_exists"
    | "config_exists"
    | "database_exists"
    | "latest_run_present"
    | "indexed_files_present"
    | "indexed_symbols_present"
    | "index_failures_absent";
  ok: boolean;
  detail: string;
}

export interface RepoReadiness {
  status: RepoReadinessStatus;
  summary: string;
  checks: readonly RepoReadinessCheck[];
}

export interface RepoLocalConfig {
  schemaVersion: typeof INIT_STATE_SCHEMA_VERSION;
  repoRoot: string;
  stateDir: string;
  dbPath: string;
  statePath: string;
  initialized: boolean;
}

export interface LastIndexSnapshot {
  lastIndexedAtMs: number;
  lastIndexedHead: string | null;
  lastIndexedSourceFileCount?: number;
  lastIndexedSourceFingerprint?: string;
}

export interface ObservedFileChangeState {
  isStale: true;
  reason: "file_changes_detected";
  firstChangedAtMs: number;
  lastChangedAtMs: number;
  changedFileCount: number;
  changedFiles: string[];
  omittedChangedFileCount: number;
}

export interface ObservedFileChangeEvent {
  filePath: string;
  observedAtMs: number;
}

export interface RepoFileWatcherState {
  supported: true;
  enabled: boolean;
  running: boolean;
  debounceMs: number;
  lastEventAtMs: number | null;
  autoReindexEnabled?: boolean;
  reindexState?: "idle" | "pending_changes" | "reindexing" | "reindex_failed" | "stale_after_failed_reindex";
  lastAutoReindexStartedAtMs?: number | null;
  lastAutoReindexFinishedAtMs?: number | null;
  lastAutoReindexFailedAtMs?: number | null;
  lastAutoReindexError?: string | null;
  pendingChangedFileCount?: number;
  changedFiles?: string[];
}

export interface RepoLocalState {
  schemaVersion: typeof INIT_STATE_SCHEMA_VERSION;
  repoRoot: string;
  dbPath: string;
  initialized: boolean;
  latestRunId: number | null;
  readiness: RepoReadiness;
  lastIndexSnapshot?: LastIndexSnapshot;
  observedFileChanges?: ObservedFileChangeState;
  observedFileChangeEvents?: ObservedFileChangeEvent[];
  fileWatcher?: RepoFileWatcherState;
  indexSummary: {
    totalFilesScanned: number;
    totalFilesAttemptedForParse: number;
    totalFilesSuccessfullyIndexed: number;
    totalParseFailures: number;
    totalSkippedUnregisteredLanguage: number;
    totalSkippedUnsupportedLanguage: number;
    totalReadFailures: number;
    totalPersistenceFailures: number;
  };
  latestRun?: {
    id: number;
    previousRunId?: number;
    totalFiles: number;
    totalSymbols: number;
    fileChangeCounts: IndexRunSummary["fileChangeCounts"];
    symbolChangeCounts: IndexRunSummary["symbolChangeCounts"];
  };
}

export interface InitRepoOptions {
  repoPath: string;
  cwd?: string;
  onProgress?: ProgressReporter;
}

export interface InitRepoResult {
  requestedPath: string;
  repoRoot: string;
  detectionMode: RepoRootDetectionMode;
  detectionMarker?: RepoRootMarker;
  paths: RepoLocalPaths;
  config: RepoLocalConfig;
  state: RepoLocalState;
  indexResult: IndexProjectResult;
  /**
   * M148-A. What the additive access-path migration did for this fresh index.
   * A physical capability, never a readiness verdict: a repository whose
   * migration failed is initialized and usable, only unoptimized.
   */
  accessCapability: EnsureIndexAccessCapabilityOutcome;
  /**
   * M154-B. What initialization did about `.vtrace/` being stageable. Like
   * `accessCapability`, a physical outcome rather than a readiness verdict: a
   * repository that could not gain the exclusion is fully initialized, it just
   * stages unsafely — which is exactly why the result carries a `remediation`
   * string the caller is expected to surface.
   */
  generatedStateExclusion: GeneratedStateExclusionResult;
}
