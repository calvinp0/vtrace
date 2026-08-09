import type { Database } from "bun:sqlite";

import {
  getSessionById,
  getSessionCompressionSummary,
} from "../db/repositories/sessionsRepository";
import {
  listObservations,
  listObservationsForSession,
} from "../db/repositories/observationsRepository";
import { buildSessionSummary } from "./buildSessionSummary";
import { searchMemory } from "./searchMemory";
import { classifyObservationCompatibility } from "./compatibility";
import type { CurrentObservationContext, Observation, SessionContextResult } from "./types";

export interface GetSessionContextInput {
  sessionId?: string;
  limit?: number;
  query?: string;
  currentContext?: CurrentObservationContext;
  includeStale?: boolean;
}

export function getSessionContext(
  db: Database,
  input: GetSessionContextInput = {},
): SessionContextResult {
  const limit = normalizeLimit(input.limit ?? 5);
  const session = input.sessionId === undefined
    ? null
    : getSessionById(db, input.sessionId) ?? null;
  const allRecentObservations = input.sessionId === undefined
    ? listObservations(db)
    : listObservationsForSession(db, input.sessionId);
  const compatibilityByObservationId: Record<string, ReturnType<typeof classifyObservationCompatibility>> = {};
  const recentObservations = filterCompatible(
    allRecentObservations,
    input.currentContext,
    input.includeStale === true,
    compatibilityByObservationId,
  ).slice(0, limit);
  const rankedObservations = input.query !== undefined && input.query.trim().length > 0
    ? searchMemory(db, {
      query: input.query,
      sessionId: input.sessionId,
      maxResults: limit,
      currentContext: input.currentContext,
      includeStale: input.includeStale,
    }).map((result) => result.observation)
    : undefined;

  return {
    sessionId: input.sessionId ?? null,
    session,
    compressedSummary: session === null
      ? null
      : getSessionCompressionSummary(db, session.sessionId) ?? null,
    summary: session === null
      ? null
      : buildSessionSummary(db, listObservationsForSession(db, session.sessionId)),
    observations: recentObservations,
    ...(input.currentContext === undefined ? {} : {
      compatibilityByObservationId,
      suppressedObservationCount: allRecentObservations.length - recentObservations.length,
    }),
    ...(rankedObservations === undefined ? {} : { rankedObservations }),
  };
}

function filterCompatible(
  observations: readonly Observation[],
  currentContext: CurrentObservationContext | undefined,
  includeStale: boolean,
  compatibilityByObservationId: Record<string, ReturnType<typeof classifyObservationCompatibility>>,
): Observation[] {
  if (currentContext === undefined) return [...observations];
  return observations.filter((observation) => {
    const compatibility = classifyObservationCompatibility(observation, currentContext);
    compatibilityByObservationId[observation.id] = compatibility;
    return compatibility.currentTruthEligible || includeStale;
  });
}

function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("limit must be a non-negative integer");
  }

  return limit;
}
