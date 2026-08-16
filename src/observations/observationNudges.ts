import type { SessionDatabase } from "../session/sessionStore";

import { listObservationsForSession } from "../session/repositories/observationsRepository";
import { getSessionById } from "../session/repositories/sessionsRepository";
import {
  ObservationKind,
  ObservationSource,
  SessionStatus,
  type Observation,
  type SessionRecord,
} from "./types";

export const OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT = 3;
export const OBSERVATION_NUDGE_REPEAT_INTERVAL_TOOL_CALL_COUNT = 5;

export const ObservationNudgeKind = "observation_nudge" as const;

export const ObservationNudgeLevel = Object.freeze({
  Full: "full",
  Brief: "brief",
});

export type ObservationNudgeLevel =
  (typeof ObservationNudgeLevel)[keyof typeof ObservationNudgeLevel];

export const ObservationNudgeReason = Object.freeze({
  NoSession: "no_session",
  SessionNotFound: "session_not_found",
  SessionCompressed: "session_compressed",
  ExcludedTool: "excluded_tool",
  DurableObservationExists: "durable_observation_exists",
  BelowThreshold: "below_threshold",
  WaitingForNextNudge: "waiting_for_next_nudge",
  NoDurableObservationAfterToolActivity: "no_durable_observation_after_tool_activity",
  StillNoDurableObservation: "still_no_durable_observation",
});

export type ObservationNudgeReason =
  (typeof ObservationNudgeReason)[keyof typeof ObservationNudgeReason];

export interface ObservationNudgeEnabled {
  readonly enabled: true;
  readonly kind: typeof ObservationNudgeKind;
  readonly level: ObservationNudgeLevel;
  readonly message: string;
  readonly reason: ObservationNudgeReason;
  readonly sessionId: string;
  readonly toolCallCount: number;
  readonly durableObservationCount: number;
  readonly nextNudgeAfterToolCallCount: number;
}

export interface ObservationNudgeDisabled {
  readonly enabled: false;
  readonly kind: typeof ObservationNudgeKind;
  readonly reason: ObservationNudgeReason;
  readonly sessionId: string | null;
  readonly toolCallCount: number;
  readonly durableObservationCount: number;
  readonly nextNudgeAfterToolCallCount: number | null;
}

export type ObservationNudgeState =
  | ObservationNudgeEnabled
  | ObservationNudgeDisabled;

export interface EvaluateObservationNudgeInput {
  sessionId?: string | null;
  currentToolName?: string;
  preexistingSessionStatus?: SessionRecord["status"];
}

const NUDGE_EXCLUDED_TOOLS = new Set<string>([
  "index_status",
  "workspace_setup",
  "save_observation",
]);

export function evaluateObservationNudge(
  db: SessionDatabase,
  input: EvaluateObservationNudgeInput,
): ObservationNudgeState {
  if (input.sessionId === undefined || input.sessionId === null) {
    return disabled({
      reason: ObservationNudgeReason.NoSession,
      sessionId: null,
      toolCallCount: 0,
      durableObservationCount: 0,
      nextNudgeAfterToolCallCount: null,
    });
  }

  if (
    input.currentToolName !== undefined
    && NUDGE_EXCLUDED_TOOLS.has(input.currentToolName)
  ) {
    return disabled({
      reason: ObservationNudgeReason.ExcludedTool,
      sessionId: input.sessionId,
      toolCallCount: 0,
      durableObservationCount: 0,
      nextNudgeAfterToolCallCount: null,
    });
  }

  if (input.preexistingSessionStatus === SessionStatus.Compressed) {
    return disabled({
      reason: ObservationNudgeReason.SessionCompressed,
      sessionId: input.sessionId,
      toolCallCount: 0,
      durableObservationCount: 0,
      nextNudgeAfterToolCallCount: null,
    });
  }

  const session = getSessionById(db, input.sessionId);

  if (session === undefined) {
    return disabled({
      reason: ObservationNudgeReason.SessionNotFound,
      sessionId: input.sessionId,
      toolCallCount: 0,
      durableObservationCount: 0,
      nextNudgeAfterToolCallCount: OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT,
    });
  }

  if (session.status === SessionStatus.Compressed) {
    return disabled({
      reason: ObservationNudgeReason.SessionCompressed,
      sessionId: input.sessionId,
      toolCallCount: 0,
      durableObservationCount: 0,
      nextNudgeAfterToolCallCount: null,
    });
  }

  const observations = listObservationsForSession(db, input.sessionId);
  const toolCallCount = observations.filter(isPassiveToolCallObservation).length;
  const durableObservationCount = observations.filter(isDurableObservation).length;

  if (durableObservationCount > 0) {
    return disabled({
      reason: ObservationNudgeReason.DurableObservationExists,
      sessionId: input.sessionId,
      toolCallCount,
      durableObservationCount,
      nextNudgeAfterToolCallCount: null,
    });
  }

  if (toolCallCount < OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT) {
    return disabled({
      reason: ObservationNudgeReason.BelowThreshold,
      sessionId: input.sessionId,
      toolCallCount,
      durableObservationCount,
      nextNudgeAfterToolCallCount: OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT,
    });
  }

  if (toolCallCount === OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT) {
    return {
      enabled: true,
      kind: ObservationNudgeKind,
      level: ObservationNudgeLevel.Full,
      message: "This session has useful exploration but no durable observation yet. Save important decisions or insights with save_observation so future context can reuse them.",
      reason: ObservationNudgeReason.NoDurableObservationAfterToolActivity,
      sessionId: input.sessionId,
      toolCallCount,
      durableObservationCount,
      nextNudgeAfterToolCallCount: toolCallCount + OBSERVATION_NUDGE_REPEAT_INTERVAL_TOOL_CALL_COUNT,
    };
  }

  if (
    (toolCallCount - OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT)
      % OBSERVATION_NUDGE_REPEAT_INTERVAL_TOOL_CALL_COUNT === 0
  ) {
    return {
      enabled: true,
      kind: ObservationNudgeKind,
      level: ObservationNudgeLevel.Brief,
      message: "Consider saving any durable decision or insight with save_observation.",
      reason: ObservationNudgeReason.StillNoDurableObservation,
      sessionId: input.sessionId,
      toolCallCount,
      durableObservationCount,
      nextNudgeAfterToolCallCount: toolCallCount + OBSERVATION_NUDGE_REPEAT_INTERVAL_TOOL_CALL_COUNT,
    };
  }

  return disabled({
    reason: ObservationNudgeReason.WaitingForNextNudge,
    sessionId: input.sessionId,
    toolCallCount,
    durableObservationCount,
    nextNudgeAfterToolCallCount: nextScheduledToolCallCount(toolCallCount),
  });
}

export function isDurableObservation(observation: Observation): boolean {
  if (observation.source === ObservationSource.Manual) {
    return true;
  }

  return observation.kind === ObservationKind.Decision
    || observation.kind === ObservationKind.Insight
    || observation.kind === ObservationKind.Warning
    || observation.kind === ObservationKind.DeadEnd;
}

export function isPassiveToolCallObservation(observation: Observation): boolean {
  return observation.kind === ObservationKind.ToolCall
    && observation.source === ObservationSource.McpAuto;
}

function disabled(input: {
  reason: ObservationNudgeReason;
  sessionId: string | null;
  toolCallCount: number;
  durableObservationCount: number;
  nextNudgeAfterToolCallCount: number | null;
}): ObservationNudgeDisabled {
  return {
    enabled: false,
    kind: ObservationNudgeKind,
    reason: input.reason,
    sessionId: input.sessionId,
    toolCallCount: input.toolCallCount,
    durableObservationCount: input.durableObservationCount,
    nextNudgeAfterToolCallCount: input.nextNudgeAfterToolCallCount,
  };
}

function nextScheduledToolCallCount(toolCallCount: number): number {
  const elapsed = toolCallCount - OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT;
  const intervalsElapsed = Math.floor(
    elapsed / OBSERVATION_NUDGE_REPEAT_INTERVAL_TOOL_CALL_COUNT,
  );
  return OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT
    + (intervalsElapsed + 1) * OBSERVATION_NUDGE_REPEAT_INTERVAL_TOOL_CALL_COUNT;
}
