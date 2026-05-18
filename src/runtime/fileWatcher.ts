import { stat } from "node:fs/promises";
import path from "node:path";

import { normalizeFilePath, type FileRecord } from "../domain/types";
import { isIndexableRepoSourcePath, scanRepo } from "../fs/scanRepo";
import {
  readRepoLocalState,
  resolveRepoLocalPaths,
  writeRepoLocalState,
} from "../setup/repoState";
import type {
  ObservedFileChangeState,
  RepoFileWatcherState,
  RepoLocalState,
} from "../setup/types";

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
}

export interface RecordObservedFileChangesResult {
  state: RepoLocalState;
  observedFileChanges: ObservedFileChangeState | null;
}

export interface RepoFileWatcher {
  repoRoot: string;
  stop(): void;
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
    fileWatcher: {
      supported: true,
      enabled: true,
      running: false,
      debounceMs: input.debounceMs ?? state.fileWatcher?.debounceMs ?? DEFAULT_FILE_WATCH_DEBOUNCE_MS,
      lastEventAtMs: input.nowMs,
    },
  };

  await writeRepoLocalState(statePath, nextState);

  return {
    state: nextState,
    observedFileChanges,
  };
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

  if (!isIndexableRepoSourcePath(filePath)) {
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
  pollIntervalMs?: number;
  debounceMs?: number;
  nowMs?: () => number;
  onFlush?: (result: RecordObservedFileChangesResult) => void | Promise<void>;
}): Promise<RepoFileWatcher> {
  const repoRoot = path.resolve(input.repoRoot);
  const statePath = input.statePath ?? resolveRepoLocalPaths(repoRoot).statePath;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_FILE_WATCH_POLL_INTERVAL_MS;
  const debounceMs = input.debounceMs ?? DEFAULT_FILE_WATCH_DEBOUNCE_MS;
  const nowMs = input.nowMs ?? (() => Date.now());
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
      });
      await input.onFlush?.(result);
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

function normalizeRelevantFilePaths(filePaths: readonly string[]): string[] {
  return [...new Set(
    filePaths
      .map((filePath) => normalizeFilePath(filePath))
      .filter((filePath) => isIndexableRepoSourcePath(filePath)),
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
