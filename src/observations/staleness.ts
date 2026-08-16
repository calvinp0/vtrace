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

/**
 * M141 Workstream C: request-local memo for run-chain diffs.
 *
 * Every observation compared against the same index head walks the same chain
 * of index runs, and each step materializes that run's complete file and symbol
 * run-state tables twice. Recomputing it per observation made memory-rule
 * evaluation O(observations x runs x symbols) — the dominant cost of a real ARC
 * request. The diffs depend only on the run id, never on the observation, so
 * one memo per request is exact.
 *
 * Deliberately request-local and caller-owned: a process-global cache would
 * outlive the index it describes and break M114/M138 freshness.
 */
export interface ObservationStalenessCache {
  readonly runDiffs: Map<number, IndexedComparisonStep>;
  readonly chains: Map<string, IndexedComparisonStep[]>;
}

export function createObservationStalenessCache(): ObservationStalenessCache {
  return { runDiffs: new Map(), chains: new Map() };
}

/**
 * A run's diffs plus lookups keyed the way observation links are matched. A run
 * carries thousands of symbol diffs and an observation carries dozens of links;
 * scanning the former per link was the second-largest cost after recomputing
 * the diffs themselves. The maps preserve exact matching semantics: the file
 * map keeps the FIRST diff for a path (what `find` returned), and the symbol
 * map keeps the set of change types seen for an identity (what `some` tested).
 */
interface IndexedComparisonStep extends CapsuleStalenessComparisonStep {
  readonly fileDiffByPath: Map<string, CapsuleStalenessComparisonStep["fileDiffs"][number]>;
  readonly symbolChangeTypes: Map<string, Set<FileChangeType>>;
}

function symbolLinkKey(filePath: string, fqName: string, kind: string): string {
  return `${filePath}\0${fqName}\0${kind}`;
}

export function getObservationStaleness(
  db: Database,
  observation: Observation,
  comparisonRunId = getLatestIndexRun(db)?.id ?? null,
  cache?: ObservationStalenessCache,
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

  // M152. An observation can now outlive the index run it was derived under:
  // the two stores have independent lifecycles, so deleting and rebuilding
  // `index.sqlite` restarts run ids at 1 while `session.sqlite` keeps rows
  // recording run 11. Before the split this was impossible — the observations
  // lived in the file that was deleted.
  //
  // Throwing here would turn that into a failed `search_memory` for the whole
  // repository. The truthful answer is that the observation was derived from
  // index state this index no longer contains, which is exactly what stale
  // means; the run chain simply cannot be walked to say WHY (§15, §29, §145).
  if (comparisonRunId < sourceRunId || getIndexRunById(db, sourceRunId) === undefined) {
    return {
      observationId: observation.id,
      sourceRunId,
      comparisonRunId,
      status: StaleStateStatus.Stale,
      reasons: [{
        kind: ObservationStaleReasonKind.SourceRunUnavailable,
        detectedInRunId: comparisonRunId,
      }],
    };
  }

  const reasonsByKey = new Map<string, ObservationStaleReason>();

  for (const step of listComparisonSteps(db, sourceRunId, comparisonRunId, cache)) {
    for (const filePath of observation.linkedFilePaths) {
      const fileDiff = step.fileDiffByPath.get(filePath);

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
      const matchingSymbolDiffs = step.symbolChangeTypes.get(
        symbolLinkKey(link.filePath, link.fqName, link.symbolKind),
      ) ?? EMPTY_CHANGE_TYPES;

      if (matchingSymbolDiffs.has(FileChangeType.Removed)) {
        setReason(reasonsByKey, {
          kind: ObservationStaleReasonKind.SymbolRemoved,
          detectedInRunId: step.runId,
          symbol: symbolIdentity(link.filePath, link.fqName, link.symbolKind),
        });
      }

      if (matchingSymbolDiffs.has(FileChangeType.Modified)) {
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
  cache?: ObservationStalenessCache,
): IndexedComparisonStep[] {
  if (sourceRunId === comparisonRunId) {
    return [];
  }

  const chainKey = `${sourceRunId}\0${comparisonRunId}`;
  const cachedChain = cache?.chains.get(chainKey);
  if (cachedChain !== undefined) {
    return cachedChain;
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

  const steps = runIds.reverse().map((runId) => diffsForRun(db, runId, cache));
  cache?.chains.set(chainKey, steps);
  return steps;
}

const EMPTY_CHANGE_TYPES: ReadonlySet<FileChangeType> = new Set();

function diffsForRun(
  db: Database,
  runId: number,
  cache?: ObservationStalenessCache,
): IndexedComparisonStep {
  const cached = cache?.runDiffs.get(runId);
  if (cached !== undefined) {
    return cached;
  }

  const fileDiffs = listFileDiffsForRun(db, runId) ?? [];
  const symbolDiffs = listSymbolDiffsForRun(db, runId) ?? [];
  const fileDiffByPath = new Map<string, (typeof fileDiffs)[number]>();
  for (const diff of fileDiffs) {
    if (!fileDiffByPath.has(diff.filePath)) fileDiffByPath.set(diff.filePath, diff);
  }
  const symbolChangeTypes = new Map<string, Set<FileChangeType>>();
  for (const diff of symbolDiffs) {
    const key = symbolLinkKey(diff.filePath, diff.fqName, diff.symbolKind);
    const seen = symbolChangeTypes.get(key);
    if (seen === undefined) symbolChangeTypes.set(key, new Set([diff.changeType]));
    else seen.add(diff.changeType);
  }

  const step: IndexedComparisonStep = { runId, fileDiffs, symbolDiffs, fileDiffByPath, symbolChangeTypes };
  cache?.runDiffs.set(runId, step);
  return step;
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
  // `source_run_unavailable` names no file or symbol — the whole point is that
  // the comparison could not be made — so it keys on its kind alone.
  const key = reason.kind === ObservationStaleReasonKind.SourceRunUnavailable
    ? reason.kind
    : reason.kind === ObservationStaleReasonKind.FileRemoved
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

