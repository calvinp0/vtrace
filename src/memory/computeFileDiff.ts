import {
  FileChangeType,
  type FileChangeCounts,
  type FileRunDiff,
  type FileRunState,
  type FileRunStateSummary,
} from "./types";

export interface ComputeFileDiffInput {
  runId: number;
  previousRunId?: number;
  currentStates: readonly FileRunState[];
  previousStates?: readonly FileRunState[];
}

export function computeFileDiff(input: ComputeFileDiffInput): FileRunDiff[] {
  if (input.previousRunId === undefined) {
    return [];
  }

  const currentByPath = mapStatesByPath(input.currentStates);
  const previousByPath = mapStatesByPath(input.previousStates ?? []);
  const allPaths = [...new Set([
    ...currentByPath.keys(),
    ...previousByPath.keys(),
  ])].sort((left, right) => left.localeCompare(right));
  const diffs: FileRunDiff[] = [];

  for (const filePath of allPaths) {
    const currentState = currentByPath.get(filePath);
    const previousState = previousByPath.get(filePath);

    if (currentState === undefined) {
      diffs.push({
        runId: input.runId,
        previousRunId: input.previousRunId,
        filePath,
        changeType: FileChangeType.Removed,
        previousState: toFileRunStateSummary(previousState!),
      });
      continue;
    }

    if (previousState === undefined) {
      diffs.push({
        runId: input.runId,
        previousRunId: input.previousRunId,
        filePath,
        changeType: FileChangeType.Added,
        currentState: toFileRunStateSummary(currentState),
      });
      continue;
    }

    diffs.push({
      runId: input.runId,
      previousRunId: input.previousRunId,
      filePath,
      changeType: isEquivalentFileRunState(previousState, currentState)
        ? FileChangeType.Unchanged
        : FileChangeType.Modified,
      previousState: toFileRunStateSummary(previousState),
      currentState: toFileRunStateSummary(currentState),
    });
  }

  return diffs;
}

export function summarizeFileDiffs(diffs: readonly FileRunDiff[]): FileChangeCounts {
  const counts: FileChangeCounts = {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 0,
  };

  for (const diff of diffs) {
    switch (diff.changeType) {
      case FileChangeType.Added:
        counts.added += 1;
        break;
      case FileChangeType.Removed:
        counts.removed += 1;
        break;
      case FileChangeType.Modified:
        counts.modified += 1;
        break;
      case FileChangeType.Unchanged:
        counts.unchanged += 1;
        break;
    }
  }

  return counts;
}

function mapStatesByPath(states: readonly FileRunState[]): ReadonlyMap<string, FileRunState> {
  return new Map(states.map((state) => [state.path, state]));
}

function isEquivalentFileRunState(
  previousState: FileRunState,
  currentState: FileRunState,
): boolean {
  return (
    previousState.fileId === currentState.fileId
    && previousState.language === currentState.language
    && previousState.contentHash === currentState.contentHash
    && previousState.sizeBytes === currentState.sizeBytes
  );
}

function toFileRunStateSummary(state: FileRunState): FileRunStateSummary {
  return {
    fileId: state.fileId,
    path: state.path,
    language: state.language,
    contentHash: state.contentHash,
    sizeBytes: state.sizeBytes,
  };
}
