import type { Database } from "bun:sqlite";

import { listObservations } from "../db/repositories/observationsRepository";
import { StaleStateStatus } from "../memory/types";
import { getObservationStaleness } from "./staleness";
import {
  ObservationSearchSignalKind,
  type Observation,
  type ObservationSearchResult,
  type ObservationSearchSignal,
} from "./types";

export interface SearchMemoryInput {
  query: string;
  maxResults?: number;
  sessionId?: string;
  linkedFilePaths?: readonly string[];
  linkedSymbolIds?: readonly string[];
}

const OBSERVATION_SEARCH_SCORE_WEIGHTS = Object.freeze({
  summaryExact: 80,
  summarySubstring: 32,
  bodySubstring: 16,
  queryTextSubstring: 20,
  queryTermOverlapPerHit: 6,
  queryTermOverlapMax: 24,
  linkedFileOverlap: 18,
  linkedSymbolOverlap: 24,
  linkedFQNameOverlapPerHit: 8,
  linkedFQNameOverlapMax: 16,
  sessionMatch: 12,
  stalePenalty: 30,
});

export function searchMemory(
  db: Database,
  input: SearchMemoryInput,
): ObservationSearchResult[] {
  const normalizedQuery = normalizeObservationText(input.query);

  if (normalizedQuery.length === 0) {
    return [];
  }

  const maxResults = normalizeMaxResults(input.maxResults ?? 8);
  const queryTerms = collectObservationTerms(input.query);
  const linkedFilePaths = normalizeLinkedPaths(input.linkedFilePaths ?? []);
  const linkedSymbolIds = new Set(input.linkedSymbolIds ?? []);

  return listObservations(db)
    .map((observation) => scoreObservation(
      db,
      observation,
      normalizedQuery,
      queryTerms,
      input.sessionId,
      linkedFilePaths,
      linkedSymbolIds,
    ))
    .filter((result): result is ObservationSearchResult => result !== undefined)
    .sort(compareObservationSearchResults)
    .slice(0, maxResults);
}

function scoreObservation(
  db: Database,
  observation: Observation,
  normalizedQuery: string,
  queryTerms: readonly string[],
  requestedSessionId: string | undefined,
  linkedFilePaths: readonly string[],
  linkedSymbolIds: ReadonlySet<string>,
): ObservationSearchResult | undefined {
  const signals: ObservationSearchSignal[] = [];

  addExactAndSubstringSignals(signals, normalizedQuery, observation.summary, "summary", {
    exact: OBSERVATION_SEARCH_SCORE_WEIGHTS.summaryExact,
    substring: OBSERVATION_SEARCH_SCORE_WEIGHTS.summarySubstring,
    exactKind: ObservationSearchSignalKind.SummaryExact,
    substringKind: ObservationSearchSignalKind.SummarySubstring,
  });
  addSubstringSignal(
    signals,
    ObservationSearchSignalKind.BodySubstring,
    normalizedQuery,
    observation.body,
    "body",
    OBSERVATION_SEARCH_SCORE_WEIGHTS.bodySubstring,
  );
  addSubstringSignal(
    signals,
    ObservationSearchSignalKind.QueryTextSubstring,
    normalizedQuery,
    observation.queryText ?? "",
    "query_text",
    OBSERVATION_SEARCH_SCORE_WEIGHTS.queryTextSubstring,
  );

  const queryTermMatches = collectMatchedQueryTerms(queryTerms, [
    observation.summary,
    observation.body,
    observation.queryText ?? "",
    ...observation.linkedFqNames,
    ...observation.linkedFilePaths,
  ]);

  if (queryTermMatches.length > 0) {
    signals.push({
      kind: ObservationSearchSignalKind.QueryTermOverlap,
      field: "summary",
      scoreContribution: Math.min(
        queryTermMatches.length * OBSERVATION_SEARCH_SCORE_WEIGHTS.queryTermOverlapPerHit,
        OBSERVATION_SEARCH_SCORE_WEIGHTS.queryTermOverlapMax,
      ),
      matchedValues: queryTermMatches,
    });
  }

  const matchingFiles = linkedFilePaths.filter((filePath) => observation.linkedFilePaths.includes(filePath));

  if (matchingFiles.length > 0) {
    signals.push({
      kind: ObservationSearchSignalKind.LinkedFileOverlap,
      field: "linked_file_paths",
      scoreContribution: matchingFiles.length * OBSERVATION_SEARCH_SCORE_WEIGHTS.linkedFileOverlap,
      matchedValues: matchingFiles,
    });
  }

  const matchingSymbols = observation.linkedSymbols
    .filter((link) => linkedSymbolIds.has(link.symbolId))
    .map((link) => link.symbolId);

  if (matchingSymbols.length > 0) {
    signals.push({
      kind: ObservationSearchSignalKind.LinkedSymbolOverlap,
      field: "linked_symbols",
      scoreContribution: matchingSymbols.length * OBSERVATION_SEARCH_SCORE_WEIGHTS.linkedSymbolOverlap,
      matchedValues: matchingSymbols,
    });
  }

  const matchingFqNames = observation.linkedFqNames.filter((fqName) => {
    const normalizedFqName = normalizeObservationText(fqName);

    return normalizedFqName.includes(normalizedQuery)
      || queryTerms.some((term) => normalizedFqName.includes(term));
  });

  if (matchingFqNames.length > 0) {
    signals.push({
      kind: ObservationSearchSignalKind.LinkedFQNameOverlap,
      field: "linked_fq_names",
      scoreContribution: Math.min(
        matchingFqNames.length * OBSERVATION_SEARCH_SCORE_WEIGHTS.linkedFQNameOverlapPerHit,
        OBSERVATION_SEARCH_SCORE_WEIGHTS.linkedFQNameOverlapMax,
      ),
      matchedValues: matchingFqNames,
    });
  }

  if (requestedSessionId !== undefined && observation.sessionId === requestedSessionId) {
    signals.push({
      kind: ObservationSearchSignalKind.SessionMatch,
      field: "session_id",
      scoreContribution: OBSERVATION_SEARCH_SCORE_WEIGHTS.sessionMatch,
      matchedValues: [requestedSessionId],
    });
  }

  const staleness = getObservationStaleness(db, observation);

  if (staleness.status === StaleStateStatus.Stale) {
    signals.push({
      kind: ObservationSearchSignalKind.StalePenalty,
      scoreContribution: -OBSERVATION_SEARCH_SCORE_WEIGHTS.stalePenalty,
      matchedValues: staleness.reasons.map((reason) => reason.kind),
    });
  }

  const score = signals.reduce((total, signal) => total + signal.scoreContribution, 0);

  if (score <= 0) {
    return undefined;
  }

  return {
    observation,
    staleness,
    score,
    signals: signals.sort(compareSignals),
  };
}

function addExactAndSubstringSignals(
  signals: ObservationSearchSignal[],
  normalizedQuery: string,
  fieldValue: string,
  field: ObservationSearchSignal["field"],
  weights: {
    exact: number;
    substring: number;
    exactKind: ObservationSearchSignalKind;
    substringKind: ObservationSearchSignalKind;
  },
): void {
  const normalizedValue = normalizeObservationText(fieldValue);

  if (normalizedValue.length === 0) {
    return;
  }

  if (normalizedValue === normalizedQuery) {
    signals.push({
      kind: weights.exactKind,
      field,
      scoreContribution: weights.exact,
      matchedValues: [fieldValue],
    });
    return;
  }

  if (normalizedValue.includes(normalizedQuery)) {
    signals.push({
      kind: weights.substringKind,
      field,
      scoreContribution: weights.substring,
      matchedValues: [fieldValue],
    });
  }
}

function addSubstringSignal(
  signals: ObservationSearchSignal[],
  kind: ObservationSearchSignalKind,
  normalizedQuery: string,
  fieldValue: string,
  field: ObservationSearchSignal["field"],
  scoreContribution: number,
): void {
  const normalizedValue = normalizeObservationText(fieldValue);

  if (normalizedValue.length === 0 || !normalizedValue.includes(normalizedQuery)) {
    return;
  }

  signals.push({
    kind,
    field,
    scoreContribution,
    matchedValues: [fieldValue],
  });
}

function normalizeObservationText(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase();
}

function collectObservationTerms(value: string): string[] {
  return [...new Set(
    normalizeObservationText(value)
      .split(/[^a-z0-9_./:]+/u)
      .filter((term) => term.length > 1),
  )];
}

function collectMatchedQueryTerms(
  queryTerms: readonly string[],
  haystacks: readonly string[],
): string[] {
  const matches = new Set<string>();
  const normalizedHaystacks = haystacks.map((value) => normalizeObservationText(value));

  for (const term of queryTerms) {
    if (normalizedHaystacks.some((value) => value.includes(term))) {
      matches.add(term);
    }
  }

  return [...matches].sort((left, right) => left.localeCompare(right));
}

function normalizeLinkedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((pathValue) => pathValue.replace(/\\/g, "/").replace(/^\.\//u, "")))];
}

function normalizeMaxResults(maxResults: number): number {
  if (!Number.isInteger(maxResults) || maxResults < 0) {
    throw new Error("maxResults must be a non-negative integer");
  }

  return maxResults;
}

function compareSignals(
  left: ObservationSearchSignal,
  right: ObservationSearchSignal,
): number {
  return right.scoreContribution - left.scoreContribution
    || left.kind.localeCompare(right.kind)
    || (left.field ?? "").localeCompare(right.field ?? "")
    || left.matchedValues.join("\0").localeCompare(right.matchedValues.join("\0"));
}

function compareObservationSearchResults(
  left: ObservationSearchResult,
  right: ObservationSearchResult,
): number {
  return right.score - left.score
    || right.observation.createdAtMs - left.observation.createdAtMs
    || left.observation.id.localeCompare(right.observation.id);
}

