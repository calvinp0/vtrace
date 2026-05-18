import {
  FileChangeType,
  type SymbolChangeCounts,
  type SymbolRunDiff,
  type SymbolRunIdentitySummary,
  type SymbolRunState,
  type SymbolRunStateSummary,
} from "./types";

export interface ComputeSymbolDiffInput {
  runId: number;
  previousRunId?: number;
  currentStates: readonly SymbolRunState[];
  previousStates?: readonly SymbolRunState[];
}

export function computeSymbolDiff(input: ComputeSymbolDiffInput): SymbolRunDiff[] {
  if (input.previousRunId === undefined) {
    return [];
  }

  const currentGroups = groupStatesByIdentity(input.currentStates);
  const previousGroups = groupStatesByIdentity(input.previousStates ?? []);
  const allIdentityKeys = [...new Set([
    ...currentGroups.keys(),
    ...previousGroups.keys(),
  ])].sort(compareIdentityKeys);
  const diffs: SymbolRunDiff[] = [];

  for (const identityKey of allIdentityKeys) {
    const currentStates = currentGroups.get(identityKey) ?? [];
    const previousStates = previousGroups.get(identityKey) ?? [];
    const maxStateCount = Math.max(currentStates.length, previousStates.length);

    for (let index = 0; index < maxStateCount; index += 1) {
      const currentState = currentStates[index];
      const previousState = previousStates[index];
      const referenceState = currentState ?? previousState!;

      if (currentState === undefined) {
        diffs.push({
          runId: input.runId,
          previousRunId: input.previousRunId,
          filePath: referenceState.filePath,
          fqName: referenceState.fqName,
          symbolKind: referenceState.kind,
          changeType: FileChangeType.Removed,
          previousState: toSymbolRunStateSummary(previousState!),
        });
        continue;
      }

      if (previousState === undefined) {
        diffs.push({
          runId: input.runId,
          previousRunId: input.previousRunId,
          filePath: referenceState.filePath,
          fqName: referenceState.fqName,
          symbolKind: referenceState.kind,
          changeType: FileChangeType.Added,
          currentState: toSymbolRunStateSummary(currentState),
        });
        continue;
      }

      diffs.push({
        runId: input.runId,
        previousRunId: input.previousRunId,
        filePath: referenceState.filePath,
        fqName: referenceState.fqName,
        symbolKind: referenceState.kind,
        changeType: isEquivalentSymbolRunState(previousState, currentState)
          ? FileChangeType.Unchanged
          : FileChangeType.Modified,
        previousState: toSymbolRunStateSummary(previousState),
        currentState: toSymbolRunStateSummary(currentState),
      });
    }
  }

  return diffs;
}

export function summarizeSymbolDiffs(diffs: readonly SymbolRunDiff[]): SymbolChangeCounts {
  const counts: SymbolChangeCounts = {
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

function groupStatesByIdentity(
  states: readonly SymbolRunState[],
): ReadonlyMap<string, SymbolRunState[]> {
  const groups = new Map<string, SymbolRunState[]>();

  for (const state of [...states].sort(compareSymbolRunStates)) {
    const key = comparisonIdentityKey(state);
    const group = groups.get(key);

    if (group === undefined) {
      groups.set(key, [state]);
      continue;
    }

    group.push(state);
  }

  return groups;
}

function comparisonIdentityKey(state: SymbolRunState): string {
  return [
    state.filePath,
    state.fqName,
    state.kind,
  ].join("\0");
}

function compareIdentityKeys(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareSymbolRunStates(left: SymbolRunState, right: SymbolRunState): number {
  return left.filePath.localeCompare(right.filePath)
    || left.fqName.localeCompare(right.fqName)
    || left.kind.localeCompare(right.kind)
    || left.startByte - right.startByte
    || left.endByte - right.endByte
    || left.symbolId.localeCompare(right.symbolId);
}

function isEquivalentSymbolRunState(
  previousState: SymbolRunState,
  currentState: SymbolRunState,
): boolean {
  return previousState.filePath === currentState.filePath
    && previousState.fqName === currentState.fqName
    && previousState.localName === currentState.localName
    && previousState.kind === currentState.kind
    && previousState.signature === currentState.signature
    && previousState.exported === currentState.exported
    && isEquivalentParentIdentity(previousState.parentIdentity, currentState.parentIdentity)
    && previousState.startLine === currentState.startLine
    && previousState.endLine === currentState.endLine
    && previousState.startByte === currentState.startByte
    && previousState.endByte === currentState.endByte;
}

function isEquivalentParentIdentity(
  previousParent: SymbolRunIdentitySummary | undefined,
  currentParent: SymbolRunIdentitySummary | undefined,
): boolean {
  if (previousParent === undefined || currentParent === undefined) {
    return previousParent === currentParent;
  }

  return previousParent.filePath === currentParent.filePath
    && previousParent.fqName === currentParent.fqName
    && previousParent.kind === currentParent.kind;
}

function toSymbolRunStateSummary(state: SymbolRunState): SymbolRunStateSummary {
  return {
    symbolId: state.symbolId,
    filePath: state.filePath,
    fqName: state.fqName,
    localName: state.localName,
    kind: state.kind,
    signature: state.signature,
    exported: state.exported,
    ...(state.parentIdentity === undefined ? {} : { parentIdentity: state.parentIdentity }),
    startLine: state.startLine,
    endLine: state.endLine,
    startByte: state.startByte,
    endByte: state.endByte,
  };
}
