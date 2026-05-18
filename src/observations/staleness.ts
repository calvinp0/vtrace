import type { Database } from "bun:sqlite";

import {
  getIndexRunById,
  getLatestIndexRun,
  listFileDiffsForRun,
  listSymbolDiffsForRun,
} from "../db/repositories/indexRunsRepository";
import {
  FileChangeType,
  StaleStateStatus,
  type CapsuleStalenessComparisonStep,
  type SymbolRunIdentitySummary,
} from "../memory/types";
import {
  ObservationStaleReasonKind,
  type Observation,
  type ObservationStaleReason,
  type ObservationStaleness,
} from "./types";

export function getObservationStaleness(
  db: Database,
  observation: Observation,
  comparisonRunId = getLatestIndexRun(db)?.id ?? null,
): ObservationStaleness {
  const sourceRunId = observation.sourceRunId ?? null;

  if (sourceRunId === null || comparisonRunId === null) {
    return {
      observationId: observation.id,
      sourceRunId,
      comparisonRunId,
      status: StaleStateStatus.Fresh,
      reasons: [],
    };
  }

  if (comparisonRunId < sourceRunId) {
    throw new Error("comparisonRunId must be greater than or equal to sourceRunId");
  }

  const reasonsByKey = new Map<string, ObservationStaleReason>();

  for (const step of listComparisonSteps(db, sourceRunId, comparisonRunId)) {
    for (const filePath of observation.linkedFilePaths) {
      const fileDiff = step.fileDiffs.find((diff) => diff.filePath === filePath);

      if (fileDiff?.changeType === FileChangeType.Removed) {
        setReason(reasonsByKey, {
          kind: ObservationStaleReasonKind.FileRemoved,
          detectedInRunId: step.runId,
          filePath,
        });
      }

      if (fileDiff?.changeType === FileChangeType.Modified) {
        setReason(reasonsByKey, {
          kind: ObservationStaleReasonKind.FileModified,
          detectedInRunId: step.runId,
          filePath,
        });
      }
    }

    for (const link of observation.linkedSymbols) {
      const matchingSymbolDiffs = step.symbolDiffs.filter((diff) => {
        return diff.filePath === link.filePath
          && diff.fqName === link.fqName
          && diff.symbolKind === link.symbolKind;
      });

      if (matchingSymbolDiffs.some((diff) => diff.changeType === FileChangeType.Removed)) {
        setReason(reasonsByKey, {
          kind: ObservationStaleReasonKind.SymbolRemoved,
          detectedInRunId: step.runId,
          symbol: symbolIdentity(link.filePath, link.fqName, link.symbolKind),
        });
      }

      if (matchingSymbolDiffs.some((diff) => diff.changeType === FileChangeType.Modified)) {
        setReason(reasonsByKey, {
          kind: ObservationStaleReasonKind.SymbolModified,
          detectedInRunId: step.runId,
          symbol: symbolIdentity(link.filePath, link.fqName, link.symbolKind),
        });
      }
    }
  }

  const reasons = [...reasonsByKey.values()].sort(compareObservationReasons);

  return {
    observationId: observation.id,
    sourceRunId,
    comparisonRunId,
    status: reasons.length === 0 ? StaleStateStatus.Fresh : StaleStateStatus.Stale,
    reasons,
  };
}

function listComparisonSteps(
  db: Database,
  sourceRunId: number,
  comparisonRunId: number,
): CapsuleStalenessComparisonStep[] {
  if (sourceRunId === comparisonRunId) {
    return [];
  }

  const runIds: number[] = [];
  let currentRun = getIndexRunById(db, comparisonRunId);

  while (currentRun !== undefined && currentRun.id !== sourceRunId) {
    runIds.push(currentRun.id);

    if (currentRun.previousRunId === undefined) {
      throw new Error(`Run ${comparisonRunId} is not descended from source run ${sourceRunId}`);
    }

    currentRun = getIndexRunById(db, currentRun.previousRunId);
  }

  if (currentRun?.id !== sourceRunId) {
    throw new Error(`Run ${comparisonRunId} is not descended from source run ${sourceRunId}`);
  }

  return runIds.reverse().map((runId) => ({
    runId,
    fileDiffs: listFileDiffsForRun(db, runId) ?? [],
    symbolDiffs: listSymbolDiffsForRun(db, runId) ?? [],
  }));
}

function symbolIdentity(
  filePath: string,
  fqName: string,
  kind: string,
): SymbolRunIdentitySummary {
  return {
    filePath,
    fqName,
    kind: kind as SymbolRunIdentitySummary["kind"],
  };
}

function setReason(
  reasonsByKey: Map<string, ObservationStaleReason>,
  reason: ObservationStaleReason,
): void {
  const key = reason.kind === ObservationStaleReasonKind.FileRemoved
    || reason.kind === ObservationStaleReasonKind.FileModified
    ? `${reason.kind}:${reason.filePath}`
    : `${reason.kind}:${reason.symbol.filePath}:${reason.symbol.fqName}:${reason.symbol.kind}`;

  if (!reasonsByKey.has(key)) {
    reasonsByKey.set(key, reason);
  }
}

function compareObservationReasons(
  left: ObservationStaleReason,
  right: ObservationStaleReason,
): number {
  return left.detectedInRunId - right.detectedInRunId
    || staleReasonPriority(left.kind) - staleReasonPriority(right.kind);
}

function staleReasonPriority(kind: ObservationStaleReason["kind"]): number {
  switch (kind) {
    case ObservationStaleReasonKind.FileRemoved:
      return 0;
    case ObservationStaleReasonKind.SymbolRemoved:
      return 1;
    case ObservationStaleReasonKind.SymbolModified:
      return 2;
    case ObservationStaleReasonKind.FileModified:
      return 3;
  }
}

