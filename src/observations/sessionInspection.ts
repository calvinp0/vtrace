import type { Database } from "bun:sqlite";

import {
  getSessionById,
  listSessionsWithObservationCounts,
} from "../db/repositories/sessionsRepository";
import { listObservationsForSession } from "../db/repositories/observationsRepository";
import { buildSessionSummary } from "./buildSessionSummary";
import type {
  Observation,
  ReadSessionResult,
  SessionListItem,
  SessionObservationPreview,
} from "./types";

const LIST_SESSIONS_MAX_COUNT = 10;
const READ_SESSION_PREVIEW_MAX_COUNT = 3;

export function listInspectableSessions(db: Database): SessionListItem[] {
  return listSessionsWithObservationCounts(db, LIST_SESSIONS_MAX_COUNT);
}

export function readInspectableSession(
  db: Database,
  sessionId: string,
): ReadSessionResult | undefined {
  const session = getSessionById(db, sessionId);

  if (session === undefined) {
    return undefined;
  }

  const observations = listObservationsForSession(db, sessionId);

  return {
    session,
    summary: buildSessionSummary(db, observations),
    recentObservations: observations
      .slice(0, READ_SESSION_PREVIEW_MAX_COUNT)
      .map(toObservationPreview),
  };
}

function toObservationPreview(
  observation: Observation,
): SessionObservationPreview {
  return {
    observationId: observation.id,
    kind: observation.kind,
    summary: observation.summary,
    createdAtMs: observation.createdAtMs,
  };
}
