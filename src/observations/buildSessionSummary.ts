import type { Database } from "bun:sqlite";

import { StaleStateStatus } from "../memory/types";
import { getObservationStaleness } from "./staleness";
import {
  ObservationKind,
  type Observation,
  type SessionObservationKindCounts,
  type SessionSummary,
  type SessionSummaryQueryTermCount,
} from "./types";

const SESSION_SUMMARY_MAX_LINKS = 5;
const SESSION_SUMMARY_MAX_QUERY_TERMS = 5;

/**
 * Summarise a session's observations. Takes the INDEX handle, not the session
 * one: the observations arrive as values, and what this reads from a database is
 * the run history each observation's staleness is judged against (§17).
 */
export function buildSessionSummary(
  indexDb: Database,
  observations: readonly Observation[],
): SessionSummary {
  const kindCounts = createEmptyKindCounts();
  const recentFilePaths = collectRecentUniqueValues(
    observations.flatMap((observation) => observation.linkedFilePaths),
    SESSION_SUMMARY_MAX_LINKS,
  );
  const recentSymbolIds = collectRecentUniqueValues(
    observations.flatMap((observation) => observation.linkedSymbols.map((link) => link.symbolId)),
    SESSION_SUMMARY_MAX_LINKS,
  );
  const recentFqNames = collectRecentUniqueValues(
    observations.flatMap((observation) => [
      ...observation.linkedSymbols.map((link) => link.fqName),
      ...observation.linkedFqNames,
    ]),
    SESSION_SUMMARY_MAX_LINKS,
  );
  const queryTermCounts = new Map<string, number>();
  let freshObservationCount = 0;
  let staleObservationCount = 0;

  for (const observation of observations) {
    incrementKindCount(kindCounts, observation.kind);

    const staleness = getObservationStaleness(indexDb, observation);

    if (staleness.status === StaleStateStatus.Stale) {
      staleObservationCount += 1;
    } else {
      freshObservationCount += 1;
    }

    for (const term of collectQueryTerms(observation.queryText)) {
      queryTermCounts.set(term, (queryTermCounts.get(term) ?? 0) + 1);
    }
  }

  return {
    observationCount: observations.length,
    lastObservationAtMs: observations[0]?.createdAtMs ?? null,
    freshObservationCount,
    staleObservationCount,
    kindCounts,
    recentFilePaths,
    recentSymbolIds,
    recentFqNames,
    repeatedQueryTerms: [...queryTermCounts.entries()]
      .filter(([, count]) => count > 1)
      .sort(compareRepeatedQueryTerms)
      .slice(0, SESSION_SUMMARY_MAX_QUERY_TERMS)
      .map(([term, count]): SessionSummaryQueryTermCount => ({ term, count })),
  };
}

function createEmptyKindCounts(): SessionObservationKindCounts {
  return {
    decision: 0,
    insight: 0,
    warning: 0,
    deadEnd: 0,
    toolCall: 0,
  };
}

function incrementKindCount(
  counts: SessionObservationKindCounts,
  kind: Observation["kind"],
): void {
  switch (kind) {
    case ObservationKind.Decision:
      counts.decision += 1;
      return;
    case ObservationKind.Insight:
      counts.insight += 1;
      return;
    case ObservationKind.Warning:
      counts.warning += 1;
      return;
    case ObservationKind.DeadEnd:
      counts.deadEnd += 1;
      return;
    case ObservationKind.ToolCall:
      counts.toolCall += 1;
      return;
  }
}

function collectRecentUniqueValues(
  values: readonly string[],
  limit: number,
): string[] {
  const uniqueValues: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    uniqueValues.push(value);

    if (uniqueValues.length >= limit) {
      break;
    }
  }

  return uniqueValues;
}

function collectQueryTerms(queryText: string | undefined): string[] {
  if (queryText === undefined) {
    return [];
  }

  return [...new Set(
    normalizeQueryText(queryText)
      .split(/[^a-z0-9_./:]+/u)
      .filter((term) => term.length > 1),
  )];
}

function normalizeQueryText(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase();
}

function compareRepeatedQueryTerms(
  left: [string, number],
  right: [string, number],
): number {
  return right[1] - left[1]
    || left[0].localeCompare(right[0]);
}
