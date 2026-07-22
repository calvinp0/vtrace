import { stat } from "node:fs/promises";
import path from "node:path";

import { normalizeFilePath, type FileRecord } from "../domain/types";
import { isRecognizedRepoSourcePath, scanRepo } from "../fs/scanRepo";
import {
  detectFileThrashingAntiPatterns,
  trimObservedFileChangeEvents,
} from "../observations/antiPatterns";
import {
  readRepoLocalState,
  resolveRepoLocalPaths,
  writeRepoLocalState,
} from "../setup/repoState";
import { openIndexerDatabase } from "../db/sqlite";
import type {
  ObservedFileChangeEvent,
  ObservedFileChangeState,
  RepoFileWatcherState,
  RepoLocalState,
} from "../setup/types";
import { reindexRepoAndRefreshState } from "./reindexRepo";

export const DEFAULT_FILE_WATCH_DEBOUNCE_MS = 500;
export const DEFAULT_FILE_WATCH_POLL_INTERVAL_MS = 1_000;
export const MAX_OBSERVED_CHANGED_FILES = 20;

export const FileWatchChangeType = Object.freeze({
  Created: "created",
  Modified: "modified",
  Deleted: "deleted",
});

export type FileWatchChangeType =
  (typeof FileWatchChangeType)[keyof typeof FileWatchChangeType];

export interface SourceFileChange {
  filePath: string;
  changeType: FileWatchChangeType;
}

export interface RecordObservedFileChangesInput {
  repoRoot: string;
  statePath?: string;
  changedFilePaths: readonly string[];
  nowMs: number;
  debounceMs?: number;
  autoReindexEnabled?: boolean;
}

export interface RecordObservedFileChangesResult {
  state: RepoLocalState;
  observedFileChanges: ObservedFileChangeState | null;
}

export interface RepoFileWatcher {
  repoRoot: string;
  stop(): void;
}

export interface AutoReindexCoordinator {
  handleObservedChanges(result: RecordObservedFileChangesResult): void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export function buildFileWatcherStatus(
  state?: RepoLocalState,
  input: {
    running?: boolean;
    debounceMs?: number;
  } = {},
): RepoFileWatcherState {
  return {
    supported: true,
    enabled: state?.fileWatcher?.enabled ?? false,
    running: input.running ?? false,
    debounceMs: input.debounceMs ?? state?.fileWatcher?.debounceMs ?? DEFAULT_FILE_WATCH_DEBOUNCE_MS,
    lastEventAtMs: state?.fileWatcher?.lastEventAtMs ?? null,
    autoReindexEnabled: state?.fileWatcher?.autoReindexEnabled ?? false,
    reindexState: state?.fileWatcher?.reindexState ?? (state?.observedFileChanges === undefined ? "idle" : "pending_changes"),
    lastAutoReindexStartedAtMs: state?.fileWatcher?.lastAutoReindexStartedAtMs ?? null,
    lastAutoReindexFinishedAtMs: state?.fileWatcher?.lastAutoReindexFinishedAtMs ?? null,
    lastAutoReindexFailedAtMs: state?.fileWatcher?.lastAutoReindexFailedAtMs ?? null,
    lastAutoReindexError: state?.fileWatcher?.lastAutoReindexError ?? null,
    pendingChangedFileCount: state?.observedFileChanges?.changedFileCount ?? state?.fileWatcher?.pendingChangedFileCount ?? 0,
    changedFiles: state?.observedFileChanges?.changedFiles ?? state?.fileWatcher?.changedFiles ?? [],
  };
}

export async function recordObservedFileChanges(
  input: RecordObservedFileChangesInput,
): Promise<RecordObservedFileChangesResult> {
  const statePath = input.statePath ?? resolveRepoLocalPaths(input.repoRoot).statePath;
  const state = await readRepoLocalState(statePath);
  const relevantFilePaths = normalizeRelevantFilePaths(input.changedFilePaths);

  if (relevantFilePaths.length === 0) {
    return {
      state,
      observedFileChanges: state.observedFileChanges ?? null,
    };
  }

  const previous = state.observedFileChanges;
  const autoReindexEnabled = input.autoReindexEnabled ?? state.fileWatcher?.autoReindexEnabled ?? false;
  const nextEvents = trimObservedFileChangeEvents([
    ...(state.observedFileChangeEvents ?? []),
    ...relevantFilePaths.map((filePath): ObservedFileChangeEvent => ({
      filePath,
      observedAtMs: input.nowMs,
    })),
  ]);
  const allKnownFiles = [...new Set([
    ...(previous?.changedFiles ?? []),
    ...relevantFilePaths,
  ])].sort((left, right) => left.localeCompare(right));
  const previousOmittedCount = previous?.omittedChangedFileCount ?? 0;
  const observedFileChanges: ObservedFileChangeState = {
    isStale: true,
    reason: "file_changes_detected",
    firstChangedAtMs: previous?.firstChangedAtMs ?? input.nowMs,
    lastChangedAtMs: input.nowMs,
    changedFileCount: Math.max(
      previous?.changedFileCount ?? 0,
      allKnownFiles.length + previousOmittedCount,
    ),
    changedFiles: allKnownFiles.slice(0, MAX_OBSERVED_CHANGED_FILES),
    omittedChangedFileCount: Math.max(0, allKnownFiles.length + previousOmittedCount - MAX_OBSERVED_CHANGED_FILES),
  };
  const nextState: RepoLocalState = {
    ...state,
    observedFileChanges,
    observedFileChangeEvents: nextEvents,
    fileWatcher: {
      supported: true,
      enabled: true,
      running: false,
      debounceMs: input.debounceMs ?? state.fileWatcher?.debounceMs ?? DEFAULT_FILE_WATCH_DEBOUNCE_MS,
      lastEventAtMs: input.nowMs,
      autoReindexEnabled,
      reindexState: state.fileWatcher?.reindexState === "reindexing"
        ? "reindexing"
        : state.fileWatcher?.reindexState === "reindex_failed"
          ? "stale_after_failed_reindex"
          : "pending_changes",
      lastAutoReindexStartedAtMs: state.fileWatcher?.lastAutoReindexStartedAtMs ?? null,
      lastAutoReindexFinishedAtMs: state.fileWatcher?.lastAutoReindexFinishedAtMs ?? null,
      lastAutoReindexFailedAtMs: state.fileWatcher?.lastAutoReindexFailedAtMs ?? null,
      lastAutoReindexError: state.fileWatcher?.lastAutoReindexError ?? null,
      pendingChangedFileCount: observedFileChanges.changedFileCount,
      changedFiles: [...observedFileChanges.changedFiles],
    },
  };

  await writeRepoLocalState(statePath, nextState);
  detectFileThrashingBestEffort({
    repoRoot: input.repoRoot,
    dbPath: nextState.dbPath,
    events: nextEvents,
  });

  return {
    state: nextState,
    observedFileChanges,
  };
}

function detectFileThrashingBestEffort(input: {
  repoRoot: string;
  dbPath: string;
  events: readonly ObservedFileChangeEvent[];
}): void {
  try {
    const db = openIndexerDatabase(input.dbPath);

    try {
      detectFileThrashingAntiPatterns(db, {
        repoRoot: input.repoRoot,
        events: input.events,
      });
    } finally {
      db.close();
    }
  } catch {
    // Watcher stale marking must never fail because anti-pattern capture failed.
  }
}

export function diffSourceFileSnapshots(input: {
  previousFiles: readonly FileRecord[];
  currentFiles: readonly FileRecord[];
}): SourceFileChange[] {
  const previousByPath = new Map(input.previousFiles.map((file) => [file.path, file]));
  const currentByPath = new Map(input.currentFiles.map((file) => [file.path, file]));
  const changes: SourceFileChange[] = [];

  for (const [filePath, current] of [...currentByPath.entries()].sort(compareEntriesByKey)) {
    const previous = previousByPath.get(filePath);

    if (previous === undefined) {
      changes.push({ filePath, changeType: FileWatchChangeType.Created });
      continue;
    }

    if (
      previous.contentHash !== current.contentHash
      || previous.sizeBytes !== current.sizeBytes
      || previous.language !== current.language
    ) {
      changes.push({ filePath, changeType: FileWatchChangeType.Modified });
    }
  }

  for (const [filePath] of [...previousByPath.entries()].sort(compareEntriesByKey)) {
    if (!currentByPath.has(filePath)) {
      changes.push({ filePath, changeType: FileWatchChangeType.Deleted });
    }
  }

  return changes.sort((left, right) => {
    return left.filePath.localeCompare(right.filePath)
      || left.changeType.localeCompare(right.changeType);
  });
}

export async function detectSinglePathChange(input: {
  repoRoot: string;
  filePath: string;
}): Promise<SourceFileChange | null> {
  const filePath = normalizeRepoRelativePath(input.repoRoot, input.filePath);

  if (!isRecognizedRepoSourcePath(filePath)) {
    return null;
  }

  try {
    const stats = await stat(path.join(input.repoRoot, filePath));

    if (!stats.isFile()) {
      return null;
    }

    return {
      filePath,
      changeType: FileWatchChangeType.Modified,
    };
  } catch {
    return {
      filePath,
      changeType: FileWatchChangeType.Deleted,
    };
  }
}

export function createDebouncedFileChangeRecorder(input: {
  debounceMs?: number;
  nowMs?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  onFlush: (changedFilePaths: readonly string[], observedAtMs: number) => void | Promise<void>;
}): {
  observe(changedFilePaths: readonly string[]): void;
  flush(): void;
  stop(): void;
} {
  const debounceMs = input.debounceMs ?? DEFAULT_FILE_WATCH_DEBOUNCE_MS;
  const nowMs = input.nowMs ?? (() => Date.now());
  const setTimer = input.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = input.clearTimer ?? ((handle) => clearTimeout(handle));
  const pending = new Set<string>();
  let timer: TimerHandle | null = null;
  let lastObservedAtMs = 0;

  const flush = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }

    if (pending.size === 0) {
      return;
    }

    const changedFilePaths = [...pending].sort((left, right) => left.localeCompare(right));
    pending.clear();
    void input.onFlush(changedFilePaths, lastObservedAtMs);
  };

  return {
    observe(changedFilePaths) {
      const normalized = normalizeRelevantFilePaths(changedFilePaths);

      if (normalized.length === 0) {
        return;
      }

      for (const filePath of normalized) {
        pending.add(filePath);
      }

      lastObservedAtMs = nowMs();

      if (timer !== null) {
        clearTimer(timer);
      }

      timer = setTimer(flush, debounceMs);
    },
    flush,
    stop() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      pending.clear();
    },
  };
}

export async function startRepoFileWatcher(input: {
  repoRoot: string;
  statePath?: string;
  dbPath?: string;
  pollIntervalMs?: number;
  debounceMs?: number;
  autoReindex?: boolean;
  nowMs?: () => number;
  onFlush?: (result: RecordObservedFileChangesResult) => void | Promise<void>;
  onAutoReindex?: (event: AutoReindexEvent) => void | Promise<void>;
  reindex?: () => Promise<void>;
}): Promise<RepoFileWatcher> {
  const repoRoot = path.resolve(input.repoRoot);
  const statePath = input.statePath ?? resolveRepoLocalPaths(repoRoot).statePath;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_FILE_WATCH_POLL_INTERVAL_MS;
  const debounceMs = input.debounceMs ?? DEFAULT_FILE_WATCH_DEBOUNCE_MS;
  const nowMs = input.nowMs ?? (() => Date.now());
  const autoReindexEnabled = input.autoReindex ?? false;
  const coordinator = createAutoReindexCoordinator({
    repoRoot,
    statePath,
    dbPath: input.dbPath ?? resolveRepoLocalPaths(repoRoot).dbPath,
    debounceMs,
    nowMs,
    enabled: autoReindexEnabled,
    ...(input.reindex === undefined ? {} : { reindex: input.reindex }),
    ...(input.onAutoReindex === undefined ? {} : { onEvent: input.onAutoReindex }),
  });
  let previousFiles = await scanRepo(repoRoot);
  const recorder = createDebouncedFileChangeRecorder({
    debounceMs,
    nowMs,
    async onFlush(changedFilePaths, observedAtMs) {
      const result = await recordObservedFileChanges({
        repoRoot,
        statePath,
        changedFilePaths,
        nowMs: observedAtMs,
        debounceMs,
        autoReindexEnabled,
      });
      await input.onFlush?.(result);
      coordinator.handleObservedChanges(result);
    },
  });
  const interval = setInterval(() => {
    void (async () => {
      const currentFiles = await scanRepo(repoRoot);
      const changes = diffSourceFileSnapshots({
        previousFiles,
        currentFiles,
      });
      previousFiles = currentFiles;

      if (changes.length > 0) {
        recorder.observe(changes.map((change) => change.filePath));
      }
    })();
  }, pollIntervalMs);

  return {
    repoRoot,
    stop() {
      clearInterval(interval);
      recorder.stop();
    },
  };
}

export type AutoReindexEvent =
  | {
    readonly event: "auto_reindex_started";
    readonly repoRoot: string;
    readonly startedAtMs: number;
    readonly changedFileCount: number;
  }
  | {
    readonly event: "auto_reindex_succeeded";
    readonly repoRoot: string;
    readonly startedAtMs: number;
    readonly finishedAtMs: number;
  }
  | {
    readonly event: "auto_reindex_failed";
    readonly repoRoot: string;
    readonly startedAtMs: number;
    readonly failedAtMs: number;
    readonly error: string;
  };

export function createAutoReindexCoordinator(input: {
  repoRoot: string;
  statePath?: string;
  dbPath?: string;
  debounceMs?: number;
  nowMs?: () => number;
  enabled?: boolean;
  reindex?: () => Promise<void>;
  onEvent?: (event: AutoReindexEvent) => void | Promise<void>;
}): AutoReindexCoordinator {
  const repoRoot = path.resolve(input.repoRoot);
  const paths = resolveRepoLocalPaths(repoRoot);
  const statePath = input.statePath ?? paths.statePath;
  const dbPath = input.dbPath ?? paths.dbPath;
  const debounceMs = input.debounceMs ?? DEFAULT_FILE_WATCH_DEBOUNCE_MS;
  const nowMs = input.nowMs ?? (() => Date.now());
  const enabled = input.enabled ?? false;
  let running = false;
  let rerunRequested = false;
  let lastResult: RecordObservedFileChangesResult | null = null;

  async function runLoop(result: RecordObservedFileChangesResult): Promise<void> {
    if (!enabled || result.observedFileChanges === null) {
      return;
    }

    lastResult = result;

    if (running) {
      rerunRequested = true;
      return;
    }

    running = true;

    try {
      do {
        rerunRequested = false;
        const effectiveResult = lastResult ?? result;
        const startedAtMs = nowMs();
        await markAutoReindexStarted({
          repoRoot,
          statePath,
          debounceMs,
          startedAtMs,
          observedFileChanges: effectiveResult.observedFileChanges,
        });
        await input.onEvent?.({
          event: "auto_reindex_started",
          repoRoot,
          startedAtMs,
          changedFileCount: effectiveResult.observedFileChanges?.changedFileCount ?? 0,
        });

        try {
          if (input.reindex === undefined) {
            await reindexRepoAndRefreshState({
              repoRoot,
              dbPath,
              statePath,
              configPresent: true,
              statePresent: true,
              usesDbPathOverride: false,
            });
          } else {
            await input.reindex();
          }

          const finishedAtMs = nowMs();
          await markAutoReindexSucceeded({
            repoRoot,
            statePath,
            debounceMs,
            startedAtMs,
            finishedAtMs,
          });
          await input.onEvent?.({
            event: "auto_reindex_succeeded",
            repoRoot,
            startedAtMs,
            finishedAtMs,
          });
        } catch (error) {
          const failedAtMs = nowMs();
          const message = formatCompactError(error);
          await markAutoReindexFailed({
            repoRoot,
            statePath,
            debounceMs,
            startedAtMs,
            failedAtMs,
            error: message,
          });
          await input.onEvent?.({
            event: "auto_reindex_failed",
            repoRoot,
            startedAtMs,
            failedAtMs,
            error: message,
          });
          rerunRequested = false;
        }
      } while (rerunRequested);
    } finally {
      running = false;
    }
  }

  return {
    handleObservedChanges(result) {
      void runLoop(result);
    },
  };
}

async function markAutoReindexStarted(input: {
  repoRoot: string;
  statePath: string;
  debounceMs: number;
  startedAtMs: number;
  observedFileChanges: ObservedFileChangeState | null;
}): Promise<void> {
  await updateWatcherState(input.statePath, (state) => ({
    ...state,
    fileWatcher: {
      ...buildFileWatcherStatus(state, { debounceMs: input.debounceMs }),
      enabled: true,
      autoReindexEnabled: true,
      reindexState: "reindexing",
      lastAutoReindexStartedAtMs: input.startedAtMs,
      lastAutoReindexFinishedAtMs: state.fileWatcher?.lastAutoReindexFinishedAtMs ?? null,
      lastAutoReindexFailedAtMs: state.fileWatcher?.lastAutoReindexFailedAtMs ?? null,
      lastAutoReindexError: null,
      pendingChangedFileCount: input.observedFileChanges?.changedFileCount ?? 0,
      changedFiles: input.observedFileChanges?.changedFiles ?? [],
    },
  }));
}

async function markAutoReindexSucceeded(input: {
  repoRoot: string;
  statePath: string;
  debounceMs: number;
  startedAtMs: number;
  finishedAtMs: number;
}): Promise<void> {
  await updateWatcherState(input.statePath, (state) => ({
    ...state,
    observedFileChanges: undefined,
    observedFileChangeEvents: undefined,
    fileWatcher: {
      ...buildFileWatcherStatus(state, { debounceMs: input.debounceMs }),
      enabled: true,
      autoReindexEnabled: true,
      reindexState: "idle",
      lastAutoReindexStartedAtMs: input.startedAtMs,
      lastAutoReindexFinishedAtMs: input.finishedAtMs,
      lastAutoReindexFailedAtMs: state.fileWatcher?.lastAutoReindexFailedAtMs ?? null,
      lastAutoReindexError: null,
      pendingChangedFileCount: 0,
      changedFiles: [],
    },
  }));
}

async function markAutoReindexFailed(input: {
  repoRoot: string;
  statePath: string;
  debounceMs: number;
  startedAtMs: number;
  failedAtMs: number;
  error: string;
}): Promise<void> {
  await updateWatcherState(input.statePath, (state) => ({
    ...state,
    fileWatcher: {
      ...buildFileWatcherStatus(state, { debounceMs: input.debounceMs }),
      enabled: true,
      autoReindexEnabled: true,
      reindexState: "stale_after_failed_reindex",
      lastAutoReindexStartedAtMs: input.startedAtMs,
      lastAutoReindexFinishedAtMs: state.fileWatcher?.lastAutoReindexFinishedAtMs ?? null,
      lastAutoReindexFailedAtMs: input.failedAtMs,
      lastAutoReindexError: input.error,
      pendingChangedFileCount: state.observedFileChanges?.changedFileCount ?? 0,
      changedFiles: state.observedFileChanges?.changedFiles ?? [],
    },
  }));
}

async function updateWatcherState(
  statePath: string,
  update: (state: RepoLocalState) => RepoLocalState,
): Promise<void> {
  const state = await readRepoLocalState(statePath);
  await writeRepoLocalState(statePath, update(state));
}

function formatCompactError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/gu, " ").trim().slice(0, 240) || "unknown error";
}

function normalizeRelevantFilePaths(filePaths: readonly string[]): string[] {
  return [...new Set(
    filePaths
      .map((filePath) => normalizeFilePath(filePath))
      .filter((filePath) => isRecognizedRepoSourcePath(filePath)),
  )].sort((left, right) => left.localeCompare(right));
}

function normalizeRepoRelativePath(repoRoot: string, filePath: string): string {
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(repoRoot, filePath);

  return normalizeFilePath(path.relative(path.resolve(repoRoot), resolved));
}

function compareEntriesByKey<T>(
  left: readonly [string, T],
  right: readonly [string, T],
): number {
  return left[0].localeCompare(right[0]);
}
