import type { Database } from "bun:sqlite";

import { getSessionById } from "../db/repositories/sessionsRepository";
import {
  listObservations,
  listObservationsForSession,
} from "../db/repositories/observationsRepository";
import { buildSessionSummary } from "./buildSessionSummary";
import { searchMemory } from "./searchMemory";
import type { SessionContextResult } from "./types";

export interface GetSessionContextInput {
  sessionId?: string;
  limit?: number;
  query?: string;
}

export function getSessionContext(
  db: Database,
  input: GetSessionContextInput = {},
): SessionContextResult {
  const limit = normalizeLimit(input.limit ?? 5);
  const session = input.sessionId === undefined
    ? null
    : getSessionById(db, input.sessionId) ?? null;
  const recentObservations = input.sessionId === undefined
    ? listObservations(db).slice(0, limit)
    : listObservationsForSession(db, input.sessionId).slice(0, limit);
  const rankedObservations = input.query !== undefined && input.query.trim().length > 0
    ? searchMemory(db, {
      query: input.query,
      sessionId: input.sessionId,
      maxResults: limit,
    }).map((result) => result.observation)
    : undefined;

  return {
    sessionId: input.sessionId ?? null,
    session,
    summary: session === null
      ? null
      : buildSessionSummary(db, listObservationsForSession(db, session.sessionId)),
    observations: recentObservations,
    ...(rankedObservations === undefined ? {} : { rankedObservations }),
  };
}

function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("limit must be a non-negative integer");
  }

  return limit;
}
