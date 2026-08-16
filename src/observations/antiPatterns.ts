import { createHash } from "node:crypto";
import type { WritableProductStores } from "../session/sessionStore";

import {
  getIndexRunById,
  getLatestIndexRun,
  listSymbolDiffsForRun,
} from "../db/repositories/indexRunsRepository";
import { persistObservation } from "../session/repositories/observationsRepository";
import { normalizeFilePath } from "../domain/types";
import { FileChangeType } from "../memory/types";
import type { ObservedFileChangeEvent } from "../setup/types";
import {
  ObservationOrigin,
  ObservationKind,
  ObservationScope,
  ObservationSource,
  type CurrentObservationContext,
  type Observation,
} from "./types";
import { buildObservationProvenance } from "./provenance";

export const AntiPatternType = Object.freeze({
  FileThrashing: "file_thrashing",
  SymbolAddedThenRemoved: "symbol_added_then_removed",
});

export type AntiPatternType =
  (typeof AntiPatternType)[keyof typeof AntiPatternType];

export const AntiPatternSeverity = Object.freeze({
  Low: "low",
  Medium: "medium",
  High: "high",
});

export type AntiPatternSeverity =
  (typeof AntiPatternSeverity)[keyof typeof AntiPatternSeverity];

export const ANTI_PATTERN_TOOL_NAME = "detect_anti_patterns";
export const DEFAULT_FILE_THRASHING_CHANGE_THRESHOLD = 5;
export const DEFAULT_FILE_THRASHING_WINDOW_MS = 10 * 60 * 1000;
export const MAX_OBSERVED_FILE_CHANGE_EVENTS = 200;

export interface DetectFileThrashingInput {
  repoRoot: string;
  events: readonly ObservedFileChangeEvent[];
  changeThreshold?: number;
  windowMs?: number;
  sourceRunId?: number | null;
  currentContext?: CurrentObservationContext;
}

export interface DetectSymbolAddedThenRemovedInput {
  repoRoot: string;
  runId?: number;
  sessionId?: string;
  sessionAgentKind?: string;
  currentContext?: CurrentObservationContext;
}

export function detectFileThrashingAntiPatterns(
  stores: WritableProductStores,
  input: DetectFileThrashingInput,
): Observation[] {
  const changeThreshold = input.changeThreshold ?? DEFAULT_FILE_THRASHING_CHANGE_THRESHOLD;
  const windowMs = input.windowMs ?? DEFAULT_FILE_THRASHING_WINDOW_MS;

  if (changeThreshold <= 1 || windowMs <= 0) {
    return [];
  }

  const persisted: Observation[] = [];
  const eventsByFile = groupEventsByFile(input.events);

  for (const [filePath, events] of [...eventsByFile.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const times = events
      .map((event) => event.observedAtMs)
      .filter((observedAtMs) => Number.isFinite(observedAtMs) && observedAtMs >= 0)
      .sort((left, right) => left - right);

    for (let startIndex = 0; startIndex < times.length; startIndex += 1) {
      const firstEventAtMs = times[startIndex]!;
      const windowEndMs = firstEventAtMs + windowMs;
      const eventsInWindow = times.filter((observedAtMs) => {
        return observedAtMs >= firstEventAtMs && observedAtMs <= windowEndMs;
      });

      if (eventsInWindow.length < changeThreshold) {
        continue;
      }

      const lastEventAtMs = eventsInWindow[eventsInWindow.length - 1]!;
      const windowBucketStartMs = Math.floor(firstEventAtMs / windowMs) * windowMs;

      persisted.push(persistObservation(stores, {
        repoRoot: input.repoRoot,
        kind: ObservationKind.DeadEnd,
        source: ObservationSource.McpAuto,
        toolName: ANTI_PATTERN_TOOL_NAME,
        queryText: `${AntiPatternType.FileThrashing} ${filePath}`,
        intent: "diagnostic",
        summary: `Possible file thrashing: ${filePath} changed ${eventsInWindow.length} times within ${formatMinutes(windowMs)} minutes.`,
        body: [
          `type=anti_pattern`,
          `anti_pattern=${AntiPatternType.FileThrashing}`,
          `severity=${AntiPatternSeverity.Medium}`,
          `file=${filePath}`,
          `change_count=${eventsInWindow.length}`,
          `threshold=${changeThreshold}`,
          `window_ms=${windowMs}`,
          `first_event_at_ms=${firstEventAtMs}`,
          `last_event_at_ms=${lastEventAtMs}`,
          `summary=Possible repeated edits to the same indexed source file in a short window.`,
        ].join("\n"),
        sourceRunId: input.sourceRunId ?? getLatestIndexRun(stores.index)?.id,
        ...antiPatternProvenance(input.currentContext, {
          queryText: `${AntiPatternType.FileThrashing} ${filePath}`,
          semanticOptions: { changeThreshold, windowMs, filePath },
          resultValue: { changeCount: eventsInWindow.length, filePath },
        }),
        createdAtMs: lastEventAtMs,
        dedupeKey: [
          "anti",
          AntiPatternType.FileThrashing,
          repoKey(input.repoRoot),
          filePath,
          windowBucketStartMs,
          changeThreshold,
          windowMs,
        ].join(":"),
        linkedFilePaths: [filePath],
      }));
      break;
    }
  }

  return persisted;
}

export function detectSymbolAddedThenRemovedAntiPatterns(
  stores: WritableProductStores,
  input: DetectSymbolAddedThenRemovedInput,
): Observation[] {
  const run = input.runId === undefined
    ? getLatestIndexRun(stores.index)
    : getIndexRunById(stores.index, input.runId);

  if (run === undefined || run.previousRunId === undefined) {
    return [];
  }

  const currentDiffs = listSymbolDiffsForRun(stores.index, run.id) ?? [];
  const previousDiffs = listSymbolDiffsForRun(stores.index, run.previousRunId) ?? [];
  const previousAddedKeys = new Set(
    previousDiffs
      .filter((diff) => diff.changeType === FileChangeType.Added)
      .map(symbolDiffKey),
  );
  const removedAfterAdded = currentDiffs
    .filter((diff) => diff.changeType === FileChangeType.Removed)
    .filter((diff) => previousAddedKeys.has(symbolDiffKey(diff)))
    .sort((left, right) => {
      return left.filePath.localeCompare(right.filePath)
        || left.fqName.localeCompare(right.fqName)
        || left.symbolKind.localeCompare(right.symbolKind);
    });

  return removedAfterAdded.map((diff) => {
    const symbolFqn = diff.fqName;
    const filePath = diff.filePath;

    return persistObservation(stores, {
      repoRoot: input.repoRoot,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.sessionAgentKind === undefined ? {} : { sessionAgentKind: input.sessionAgentKind }),
      kind: ObservationKind.DeadEnd,
      source: ObservationSource.McpAuto,
      toolName: ANTI_PATTERN_TOOL_NAME,
      queryText: `${AntiPatternType.SymbolAddedThenRemoved} ${symbolFqn}`,
      intent: "diagnostic",
      summary: `Possible dead-end exploration: ${symbolFqn} was added and then removed in adjacent index runs.`,
      body: [
        `type=anti_pattern`,
        `anti_pattern=${AntiPatternType.SymbolAddedThenRemoved}`,
        `severity=${AntiPatternSeverity.Medium}`,
        `file=${filePath}`,
        `symbol_fqn=${symbolFqn}`,
        `symbol_kind=${diff.symbolKind}`,
        `added_in_run_id=${run.previousRunId}`,
        `removed_in_run_id=${run.id}`,
        `summary=Symbol appeared in one indexed snapshot and disappeared in the next.`,
      ].join("\n"),
      sourceRunId: run.id,
      ...antiPatternProvenance(input.currentContext, {
        queryText: `${AntiPatternType.SymbolAddedThenRemoved} ${symbolFqn}`,
        semanticOptions: { antiPattern: AntiPatternType.SymbolAddedThenRemoved },
        resultValue: { filePath, symbolFqn, symbolKind: diff.symbolKind },
      }),
      createdAtMs: run.createdAtMs,
      dedupeKey: [
        "anti",
        AntiPatternType.SymbolAddedThenRemoved,
        repoKey(input.repoRoot),
        filePath,
        symbolFqn,
        diff.symbolKind,
        run.previousRunId,
        run.id,
      ].join(":"),
      linkedFilePaths: [filePath],
      linkedFqNames: [symbolFqn],
    });
  });
}

function antiPatternProvenance(
  context: CurrentObservationContext | undefined,
  input: {
    queryText: string;
    semanticOptions: Readonly<Record<string, unknown>>;
    resultValue: unknown;
  },
): Record<string, unknown> {
  if (context === undefined) return {};
  return {
    scope: ObservationScope.IndexState,
    origin: ObservationOrigin.AutomaticCapture,
    provenance: buildObservationProvenance({
      context,
      toolName: ANTI_PATTERN_TOOL_NAME,
      queryText: input.queryText,
      semanticOptions: input.semanticOptions,
      resultValue: input.resultValue,
    }),
  };
}

export function trimObservedFileChangeEvents(
  events: readonly ObservedFileChangeEvent[],
): ObservedFileChangeEvent[] {
  return [...events]
    .sort((left, right) => {
      return left.observedAtMs - right.observedAtMs
        || left.filePath.localeCompare(right.filePath);
    })
    .slice(-MAX_OBSERVED_FILE_CHANGE_EVENTS);
}

function groupEventsByFile(
  events: readonly ObservedFileChangeEvent[],
): Map<string, ObservedFileChangeEvent[]> {
  const grouped = new Map<string, ObservedFileChangeEvent[]>();

  for (const event of events) {
    const filePath = normalizeFilePath(event.filePath);
    const existing = grouped.get(filePath);

    if (existing === undefined) {
      grouped.set(filePath, [event]);
      continue;
    }

    existing.push(event);
  }

  return grouped;
}

function symbolDiffKey(input: {
  filePath: string;
  fqName: string;
  symbolKind: string;
}): string {
  return [input.filePath, input.fqName, input.symbolKind].join("\0");
}

function repoKey(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
}

function formatMinutes(windowMs: number): string {
  const minutes = windowMs / 60_000;
  return Number.isInteger(minutes) ? minutes.toString(10) : minutes.toFixed(1);
}
