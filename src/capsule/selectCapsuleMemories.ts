import type { Database } from "bun:sqlite";

import { listObservations } from "../db/repositories/observationsRepository";
import { StaleStateStatus } from "../memory/types";
import { getObservationStaleness } from "../observations/staleness";
import type {
  Observation,
  ObservationStaleness,
} from "../observations/types";
import { computeCapsuleMemoryItemCost, wouldExceedBudget } from "./budget";
import {
  CapsuleMemoryInclusionReasonKind,
  type CapsuleBudget,
  type CapsuleItem,
  type CapsuleMemoryInclusionReason,
  type CapsuleMemoryItem,
} from "./types";

const CAPSULE_MEMORY_SCORE_WEIGHTS = Object.freeze({
  linkedSymbolOverlap: 100,
  linkedFileOverlap: 40,
  queryTermOverlapPerHit: 8,
  queryTermOverlapMax: 24,
  intentMatch: 12,
  stalePenalty: 60,
});

export const CAPSULE_MEMORY_MAX_COUNT = 3;
const CAPSULE_MEMORY_MIN_QUERY_TERM_MATCHES_WITHOUT_STRUCTURE = 3;

export interface SelectCapsuleMemoriesInput {
  readonly db: Database;
  readonly query: string;
  readonly intent?: string;
  readonly pivots: readonly CapsuleItem[];
  readonly supportingItems: readonly CapsuleItem[];
  readonly budget: CapsuleBudget;
  readonly currentCost: number;
  readonly maxCount?: number;
  readonly excludeObservation?: ((observation: Observation) => boolean) | undefined;
}

interface RankedObservationCandidate {
  readonly observation: Observation;
  readonly staleness: ObservationStaleness;
  readonly score: number;
  readonly linkedSymbolMatches: readonly string[];
  readonly linkedFileMatches: readonly string[];
  readonly queryTermMatches: readonly string[];
  readonly intentMatch: boolean;
}

export function selectCapsuleMemories(
  input: SelectCapsuleMemoriesInput,
): CapsuleMemoryItem[] {
  const queryTerms = collectTerms(input.query);

  if (queryTerms.length === 0) {
    return [];
  }

  const anchoredItems = [...input.pivots, ...input.supportingItems];
  const linkedSymbolIds = new Set(anchoredItems.map((item) => item.symbolId));
  const linkedFilePaths = new Set(anchoredItems.map((item) => normalizePath(item.filePath)));
  const maxCount = normalizeMaxCount(input.maxCount ?? CAPSULE_MEMORY_MAX_COUNT);
  const rankedCandidates = listObservations(input.db)
    .filter((observation) => input.excludeObservation?.(observation) !== true)
    .map((observation) => scoreObservation({
      db: input.db,
      observation,
      queryTerms,
      intent: input.intent,
      linkedFilePaths,
      linkedSymbolIds,
    }))
    .filter((candidate): candidate is RankedObservationCandidate => candidate !== undefined)
    .sort(compareRankedObservationCandidates);

  const surfaced: CapsuleMemoryItem[] = [];
  let currentCost = input.currentCost;

  for (const candidate of rankedCandidates) {
    if (surfaced.length >= maxCount) {
      break;
    }

    const memory = buildCapsuleMemoryItem(candidate);
    const memoryCost = computeCapsuleMemoryItemCost(memory);

    if (wouldExceedBudget(currentCost, memoryCost, input.budget)) {
      continue;
    }

    surfaced.push(memory);
    currentCost += memoryCost;
  }

  return surfaced;
}

function scoreObservation(input: {
  readonly db: Database;
  readonly observation: Observation;
  readonly queryTerms: readonly string[];
  readonly intent?: string;
  readonly linkedFilePaths: ReadonlySet<string>;
  readonly linkedSymbolIds: ReadonlySet<string>;
}): RankedObservationCandidate | undefined {
  const observationTerms = collectObservationTerms(input.observation);
  const linkedSymbolMatches = [...new Set(
    input.observation.linkedSymbols
      .filter((link) => input.linkedSymbolIds.has(link.symbolId))
      .map((link) => link.symbolId),
  )].sort((left, right) => left.localeCompare(right));
  const linkedFileMatches = [...new Set(
    input.observation.linkedFilePaths
      .map((filePath) => normalizePath(filePath))
      .filter((filePath) => input.linkedFilePaths.has(filePath)),
  )].sort((left, right) => left.localeCompare(right));
  const queryTermMatches = input.queryTerms.filter((term) => observationTerms.includes(term));
  const intentMatch = input.intent !== undefined
    && input.observation.intent === input.intent;
  const staleness = getObservationStaleness(input.db, input.observation);
  const score = (
    linkedSymbolMatches.length * CAPSULE_MEMORY_SCORE_WEIGHTS.linkedSymbolOverlap
    + linkedFileMatches.length * CAPSULE_MEMORY_SCORE_WEIGHTS.linkedFileOverlap
    + Math.min(
      queryTermMatches.length * CAPSULE_MEMORY_SCORE_WEIGHTS.queryTermOverlapPerHit,
      CAPSULE_MEMORY_SCORE_WEIGHTS.queryTermOverlapMax,
    )
    + (intentMatch ? CAPSULE_MEMORY_SCORE_WEIGHTS.intentMatch : 0)
    - (staleness.status === StaleStateStatus.Stale ? CAPSULE_MEMORY_SCORE_WEIGHTS.stalePenalty : 0)
  );

  if (!isEligibleForSurfacing({
    linkedSymbolMatches,
    linkedFileMatches,
    queryTermMatches,
    intentMatch,
    staleness,
    score,
  })) {
    return undefined;
  }

  return {
    observation: input.observation,
    staleness,
    score,
    linkedSymbolMatches,
    linkedFileMatches,
    queryTermMatches,
    intentMatch,
  };
}

function isEligibleForSurfacing(input: {
  readonly linkedSymbolMatches: readonly string[];
  readonly linkedFileMatches: readonly string[];
  readonly queryTermMatches: readonly string[];
  readonly intentMatch: boolean;
  readonly staleness: ObservationStaleness;
  readonly score: number;
}): boolean {
  if (input.score <= 0) {
    return false;
  }

  if (input.linkedSymbolMatches.length > 0 || input.linkedFileMatches.length > 0) {
    return true;
  }

  return input.staleness.status !== StaleStateStatus.Stale
    && input.intentMatch
    && input.queryTermMatches.length >= CAPSULE_MEMORY_MIN_QUERY_TERM_MATCHES_WITHOUT_STRUCTURE;
}

function buildCapsuleMemoryItem(
  candidate: RankedObservationCandidate,
): CapsuleMemoryItem {
  const inclusionReasons: CapsuleMemoryInclusionReason[] = [];

  if (candidate.linkedSymbolMatches.length > 0) {
    inclusionReasons.push({
      kind: CapsuleMemoryInclusionReasonKind.LinkedSymbolOverlap,
      matchedValues: [...candidate.linkedSymbolMatches],
    });
  }

  if (candidate.linkedFileMatches.length > 0) {
    inclusionReasons.push({
      kind: CapsuleMemoryInclusionReasonKind.LinkedFileOverlap,
      matchedValues: [...candidate.linkedFileMatches],
    });
  }

  if (candidate.queryTermMatches.length > 0) {
    inclusionReasons.push({
      kind: CapsuleMemoryInclusionReasonKind.QueryTermOverlap,
      matchedValues: [...candidate.queryTermMatches],
    });
  }

  if (candidate.intentMatch && candidate.observation.intent !== undefined) {
    inclusionReasons.push({
      kind: CapsuleMemoryInclusionReasonKind.IntentMatch,
      matchedValues: [candidate.observation.intent],
    });
  }

  return {
    observationId: candidate.observation.id,
    kind: candidate.observation.kind,
    headline: candidate.observation.summary,
    createdAtMs: candidate.observation.createdAtMs,
    isStale: candidate.staleness.status === StaleStateStatus.Stale,
    staleReasons: candidate.staleness.reasons.map((reason) => reason.kind),
    inclusionReasons,
  };
}

function compareRankedObservationCandidates(
  left: RankedObservationCandidate,
  right: RankedObservationCandidate,
): number {
  return right.score - left.score
    || right.linkedSymbolMatches.length - left.linkedSymbolMatches.length
    || right.linkedFileMatches.length - left.linkedFileMatches.length
    || right.queryTermMatches.length - left.queryTermMatches.length
    || Number(right.intentMatch) - Number(left.intentMatch)
    || right.observation.createdAtMs - left.observation.createdAtMs
    || left.observation.id.localeCompare(right.observation.id);
}

function collectObservationTerms(observation: Observation): string[] {
  return [...new Set([
    ...collectTerms(observation.summary),
    ...collectTerms(observation.body),
    ...collectTerms(observation.queryText ?? ""),
  ])].sort((left, right) => left.localeCompare(right));
}

function collectTerms(value: string): string[] {
  return [...new Set(
    normalizeText(value)
      .split(/[^a-z0-9_./:]+/u)
      .filter((term) => term.length > 1),
  )].sort((left, right) => left.localeCompare(right));
}

function normalizeText(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase();
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//u, "");
}

function normalizeMaxCount(maxCount: number): number {
  if (!Number.isInteger(maxCount) || maxCount < 0) {
    throw new Error("maxCount must be a non-negative integer");
  }

  return maxCount;
}
