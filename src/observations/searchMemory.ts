import type { Database } from "bun:sqlite";

import type { ProductStores } from "../session/sessionStore";

import { getLatestIndexRun } from "../db/repositories/indexRunsRepository";
import { listObservations } from "../session/repositories/observationsRepository";
import { StaleStateStatus } from "../memory/types";
import {
  createObservationStalenessCache,
  getObservationStaleness,
  type ObservationStalenessCache,
} from "./staleness";
import { classifyObservationCompatibility } from "./compatibility";
import {
  ObservationCompatibilityState,
  ObservationSearchSignalKind,
  type CurrentObservationContext,
  type Observation,
  type ObservationCompatibility,
  type ObservationConflict,
  type ObservationSearchResponse,
  type ObservationSearchResult,
  type ObservationSearchSignal,
} from "./types";

export interface SearchMemoryInput {
  query: string;
  maxResults?: number;
  sessionId?: string;
  linkedFilePaths?: readonly string[];
  linkedSymbolIds?: readonly string[];
  currentContext?: CurrentObservationContext;
  includeStale?: boolean;
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
  stores: ProductStores,
  input: SearchMemoryInput,
): ObservationSearchResult[] {
  return [...searchMemoryDetailed(stores, input).results];
}

/**
 * Reads BOTH stores and writes neither. Observations come from
 * `session.sqlite`; the index run they are compared against comes from
 * `index.sqlite`, which is what keeps a memory from an older repository state
 * being served as if it were current (§17, §99).
 */
export function searchMemoryDetailed(
  stores: ProductStores,
  input: SearchMemoryInput,
): ObservationSearchResponse {
  const db = stores.session;
  const normalizedQuery = normalizeObservationText(input.query);

  if (normalizedQuery.length === 0) {
    return emptyResponse();
  }

  const maxResults = normalizeMaxResults(input.maxResults ?? 8);
  const queryTerms = collectObservationTerms(input.query);
  const linkedFilePaths = normalizeLinkedPaths(input.linkedFilePaths ?? []);
  const linkedSymbolIds = new Set(input.linkedSymbolIds ?? []);

  // Expensive index-run discovery happens once per request, not once per
  // observation: the comparison head and the per-run diffs behind it are
  // identical for every observation being scored.
  const comparisonRunId = getLatestIndexRun(stores.index)?.id ?? null;
  const stalenessCache = createObservationStalenessCache();
  const scored = listObservations(db)
    .map((observation) => scoreObservation(
      stores.index,
      observation,
      normalizedQuery,
      queryTerms,
      input.sessionId,
      linkedFilePaths,
      linkedSymbolIds,
      input.currentContext,
      comparisonRunId,
      stalenessCache,
    ))
    .filter((result): result is ObservationSearchResult => result !== undefined)
    .sort(compareObservationSearchResults);
  const accounting = {
    matchedCurrent: 0,
    suppressedStale: 0,
    suppressedForeign: 0,
    provenanceIncomplete: 0,
  };
  const eligible: ObservationSearchResult[] = [];
  for (const result of scored) {
    const compatibility = result.compatibility;
    if (compatibility === undefined || compatibility.currentTruthEligible || input.includeStale === true) {
      eligible.push(result);
      if (compatibility?.currentTruthEligible === true) accounting.matchedCurrent += 1;
      continue;
    }
    if (compatibility.state === ObservationCompatibilityState.ForeignRepository
      || compatibility.state === ObservationCompatibilityState.ForeignContext
      || compatibility.state === ObservationCompatibilityState.StaleWorktree) {
      accounting.suppressedForeign += 1;
    } else if (compatibility.state === ObservationCompatibilityState.ProvenanceIncomplete) {
      accounting.provenanceIncomplete += 1;
    } else {
      accounting.suppressedStale += 1;
    }
  }
  const deduped = deduplicateEquivalentResults(eligible);
  const conflicts = detectObservationConflicts(deduped);
  return {
    results: deduped.slice(0, maxResults),
    accounting,
    conflicts,
  };
}

function scoreObservation(
  indexDb: Database,
  observation: Observation,
  normalizedQuery: string,
  queryTerms: readonly string[],
  requestedSessionId: string | undefined,
  linkedFilePaths: readonly string[],
  linkedSymbolIds: ReadonlySet<string>,
  currentContext: CurrentObservationContext | undefined,
  comparisonRunId: number | null,
  stalenessCache: ObservationStalenessCache,
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

  // Every signal above contributes a non-negative score and the only remaining
  // signal (the stale penalty) subtracts, so an observation with no positive
  // signal cannot survive the `score <= 0` filter below however stale it is.
  // Resolving its staleness first would be pure work for a discarded result.
  const matchedScore = signals.reduce((total, signal) => total + signal.scoreContribution, 0);

  if (matchedScore <= 0) {
    return undefined;
  }

  const staleness = getObservationStaleness(indexDb, observation, comparisonRunId, stalenessCache);
  const compatibility = currentContext === undefined
    ? undefined
    : classifyObservationCompatibility(observation, currentContext);

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
    ...(compatibility === undefined ? {} : { compatibility }),
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
  return compatibilityPriority(right.compatibility) - compatibilityPriority(left.compatibility)
    || right.score - left.score
    || right.observation.createdAtMs - left.observation.createdAtMs
    || left.observation.id.localeCompare(right.observation.id);
}

function compatibilityPriority(compatibility: ObservationCompatibility | undefined): number {
  if (compatibility === undefined) return 0;
  switch (compatibility.state) {
    case ObservationCompatibilityState.Current:
      return 4;
    case ObservationCompatibilityState.CurrentCompatible:
    case ObservationCompatibilityState.Applicable:
      return 3;
    case ObservationCompatibilityState.Historical:
      return 2;
    case ObservationCompatibilityState.ProvenanceIncomplete:
      return 0;
    default:
      return 1;
  }
}

function deduplicateEquivalentResults(
  results: readonly ObservationSearchResult[],
): ObservationSearchResult[] {
  const seen = new Set<string>();
  const deduped: ObservationSearchResult[] = [];
  for (const result of results) {
    const observation = result.observation;
    const key = observation.semanticKey !== undefined && observation.resultSemanticHash !== undefined
      ? `${observation.semanticKey}\0${observation.resultSemanticHash}`
      : observation.id;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

function detectObservationConflicts(
  results: readonly ObservationSearchResult[],
): ObservationConflict[] {
  const grouped = new Map<string, ObservationSearchResult[]>();
  for (const result of results) {
    if (result.compatibility?.currentTruthEligible !== true
      || result.observation.semanticKey === undefined
      || result.observation.resultSemanticHash === undefined) continue;
    const group = grouped.get(result.observation.semanticKey) ?? [];
    group.push(result);
    grouped.set(result.observation.semanticKey, group);
  }
  const conflicts: ObservationConflict[] = [];
  for (const [semanticKey, group] of grouped) {
    const hashes = [...new Set(group.map((item) => item.observation.resultSemanticHash!))].sort();
    if (hashes.length < 2) continue;
    conflicts.push({
      semanticKey,
      observationIds: group.map((item) => item.observation.id).sort(),
      resultSemanticHashes: hashes,
    });
  }
  return conflicts.sort((left, right) => left.semanticKey.localeCompare(right.semanticKey));
}

function emptyResponse(): ObservationSearchResponse {
  return {
    results: [],
    accounting: {
      matchedCurrent: 0,
      suppressedStale: 0,
      suppressedForeign: 0,
      provenanceIncomplete: 0,
    },
    conflicts: [],
  };
}
