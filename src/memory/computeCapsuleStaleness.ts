import {
  CapsuleStaleReasonKind,
  FileChangeType,
  StaleStateStatus,
  type CapsuleItemStaleReason,
  type CapsuleItemStaleness,
  type CapsuleManifest,
  type CapsuleManifestItemRecord,
  type CapsuleStalenessComparisonStep,
  type CapsuleStalenessResult,
  type SymbolRunIdentitySummary,
} from "./types";

export interface ComputeCapsuleStalenessInput {
  manifest: CapsuleManifest;
  comparisonRunId: number;
  steps: readonly CapsuleStalenessComparisonStep[];
}

export function computeCapsuleStaleness(
  input: ComputeCapsuleStalenessInput,
): CapsuleStalenessResult {
  const steps = [...input.steps].sort((left, right) => left.runId - right.runId);
  const items = [...input.manifest.items]
    .sort((left, right) => left.itemOrdinal - right.itemOrdinal)
    .map((item) => computeCapsuleItemStaleness(item, steps));

  return {
    capsuleId: input.manifest.id,
    sourceRunId: input.manifest.sourceRunId,
    comparisonRunId: input.comparisonRunId,
    query: input.manifest.query,
    status: items.some((item) => item.status === StaleStateStatus.Stale)
      ? StaleStateStatus.Stale
      : StaleStateStatus.Fresh,
    items,
  };
}

function computeCapsuleItemStaleness(
  item: CapsuleManifestItemRecord,
  steps: readonly CapsuleStalenessComparisonStep[],
): CapsuleItemStaleness {
  const reasonsByKind = new Map<CapsuleStaleReasonKind, CapsuleItemStaleReason>();
  const symbol = manifestItemToSymbolIdentity(item);

  for (const step of steps) {
    const fileDiff = step.fileDiffs.find((diff) => diff.filePath === item.filePath);
    const matchingSymbolDiffs = step.symbolDiffs.filter((diff) => {
      return diff.filePath === item.filePath
        && diff.fqName === item.fqName
        && diff.symbolKind === item.symbolKind;
    });

    if (
      fileDiff?.changeType === FileChangeType.Removed
      && !reasonsByKind.has(CapsuleStaleReasonKind.FileRemoved)
    ) {
      reasonsByKind.set(CapsuleStaleReasonKind.FileRemoved, {
        kind: CapsuleStaleReasonKind.FileRemoved,
        detectedInRunId: step.runId,
        filePath: item.filePath,
      });
    }

    if (
      item.sourceBacked
      && fileDiff?.changeType === FileChangeType.Modified
      && !reasonsByKind.has(CapsuleStaleReasonKind.FileModifiedSourceBacked)
    ) {
      reasonsByKind.set(CapsuleStaleReasonKind.FileModifiedSourceBacked, {
        kind: CapsuleStaleReasonKind.FileModifiedSourceBacked,
        detectedInRunId: step.runId,
        filePath: item.filePath,
      });
    }

    if (
      matchingSymbolDiffs.some((diff) => diff.changeType === FileChangeType.Removed)
      && !reasonsByKind.has(CapsuleStaleReasonKind.SymbolRemoved)
    ) {
      reasonsByKind.set(CapsuleStaleReasonKind.SymbolRemoved, {
        kind: CapsuleStaleReasonKind.SymbolRemoved,
        detectedInRunId: step.runId,
        symbol,
      });
    }

    if (
      matchingSymbolDiffs.some((diff) => diff.changeType === FileChangeType.Modified)
      && !reasonsByKind.has(CapsuleStaleReasonKind.SymbolModified)
    ) {
      reasonsByKind.set(CapsuleStaleReasonKind.SymbolModified, {
        kind: CapsuleStaleReasonKind.SymbolModified,
        detectedInRunId: step.runId,
        symbol,
      });
    }
  }

  const reasons = [...reasonsByKind.values()].sort(compareCapsuleItemStaleReasons);

  return {
    capsuleId: item.capsuleId,
    itemOrdinal: item.itemOrdinal,
    role: item.role,
    contentMode: item.contentMode,
    sourceBacked: item.sourceBacked,
    filePath: item.filePath,
    symbol,
    status: reasons.length === 0 ? StaleStateStatus.Fresh : StaleStateStatus.Stale,
    reasons,
  };
}

function manifestItemToSymbolIdentity(
  item: CapsuleManifestItemRecord,
): SymbolRunIdentitySummary {
  return {
    filePath: item.filePath,
    fqName: item.fqName,
    kind: item.symbolKind,
  };
}

function compareCapsuleItemStaleReasons(
  left: CapsuleItemStaleReason,
  right: CapsuleItemStaleReason,
): number {
  return left.detectedInRunId - right.detectedInRunId
    || staleReasonPriority(left.kind) - staleReasonPriority(right.kind);
}

function staleReasonPriority(kind: CapsuleStaleReasonKind): number {
  switch (kind) {
    case CapsuleStaleReasonKind.FileRemoved:
      return 0;
    case CapsuleStaleReasonKind.SymbolRemoved:
      return 1;
    case CapsuleStaleReasonKind.SymbolModified:
      return 2;
    case CapsuleStaleReasonKind.FileModifiedSourceBacked:
      return 3;
  }
}
