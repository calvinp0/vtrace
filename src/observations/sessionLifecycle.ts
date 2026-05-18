import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import { getLatestIndexRun } from "../db/repositories/indexRunsRepository";
import {
  deleteEphemeralToolCallObservationsForSession,
  listObservationsForSession,
  persistObservation,
} from "../db/repositories/observationsRepository";
import {
  getSessionById,
  getSessionCompressionSummary,
  listSessionCleanupCandidates,
  listSessions,
  markSessionCompressed,
  persistSessionCompressionSummary,
} from "../db/repositories/sessionsRepository";
import {
  ObservationKind,
  ObservationSource,
  SessionStatus,
  type Observation,
  type SessionCleanupCandidate,
  type SessionCompressionEligibility,
  type SessionCompressionSummary,
  type SessionRecord,
} from "./types";

export const DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_SESSION_RETENTION_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

const SUMMARY_TOOL_NAME = "compress_inactive_sessions";
const MAX_SUMMARY_LINKS = 20;
const MAX_KEY_TERMS = 12;
const KEY_TERM_MIN_LENGTH = 3;
const STOP_TERMS = new Set([
  "and",
  "are",
  "but",
  "for",
  "from",
  "has",
  "into",
  "not",
  "the",
  "this",
  "that",
  "with",
]);

export interface CompressInactiveSessionsInput {
  repoRoot?: string;
  nowMs: number;
  inactiveAfterMs?: number;
  retentionAfterMs?: number;
}

export interface CompressInactiveSessionsResult {
  compressedSummaries: SessionCompressionSummary[];
  cleanupCandidates: SessionCleanupCandidate[];
}

export function getSessionCompressionEligibility(
  db: Database,
  input: {
    nowMs: number;
    inactiveAfterMs?: number;
    repoRoot?: string;
  },
): SessionCompressionEligibility[] {
  const thresholdMs = input.inactiveAfterMs ?? DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS;

  return listSessions(db)
    .filter((session) => input.repoRoot === undefined || session.repoRoot === input.repoRoot)
    .filter((session) => session.status === SessionStatus.Active)
    .map((session) => {
      const inactiveForMs = Math.max(input.nowMs - session.lastActivityAtMs, 0);

      return {
        session,
        eligible: inactiveForMs >= thresholdMs,
        inactiveForMs,
        thresholdMs,
      };
    })
    .sort((left, right) => {
      return Number(right.eligible) - Number(left.eligible)
        || right.inactiveForMs - left.inactiveForMs
        || left.session.sessionId.localeCompare(right.session.sessionId);
    });
}

export function compressInactiveSessions(
  db: Database,
  input: CompressInactiveSessionsInput,
): CompressInactiveSessionsResult {
  const compressedSummaries: SessionCompressionSummary[] = [];

  for (const eligibility of getSessionCompressionEligibility(db, input)) {
    if (!eligibility.eligible) {
      continue;
    }

    const summary = compressSession(db, {
      sessionId: eligibility.session.sessionId,
      nowMs: input.nowMs,
    });

    if (summary !== undefined) {
      compressedSummaries.push(summary);
    }
  }

  return {
    compressedSummaries,
    cleanupCandidates: listSessionCleanupCandidates(db, {
      nowMs: input.nowMs,
      retentionAfterMs: input.retentionAfterMs ?? DEFAULT_SESSION_RETENTION_AFTER_MS,
    }),
  };
}

export function compressSession(
  db: Database,
  input: {
    sessionId: string;
    nowMs: number;
  },
): SessionCompressionSummary | undefined {
  const existingSummary = getSessionCompressionSummary(db, input.sessionId);

  if (existingSummary !== undefined) {
    return existingSummary;
  }

  const session = getSessionById(db, input.sessionId);

  if (session === undefined) {
    return undefined;
  }

  if (session.status === SessionStatus.Compressed) {
    return undefined;
  }

  const observations = listObservationsForSession(db, session.sessionId);
  const draft = buildSessionCompressionSummaryDraft(session, observations, input.nowMs);
  const summaryObservation = persistObservation(db, {
    repoRoot: session.repoRoot,
    sessionId: session.sessionId,
    sessionAgentKind: session.agentKind,
    kind: ObservationKind.Insight,
    source: ObservationSource.McpAuto,
    toolName: SUMMARY_TOOL_NAME,
    queryText: draft.keyTerms.join(" "),
    summary: `Compressed session ${session.sessionId}: ${draft.prunedToolCallObservationCount} tool calls summarized, ${draft.preservedDurableObservationCount} durable observations preserved.`,
    body: formatSummaryBody(draft),
    sourceRunId: getLatestIndexRun(db)?.id,
    createdAtMs: input.nowMs,
    dedupeKey: `session_compression:${session.sessionId}`,
    linkedFilePaths: draft.filePaths,
    linkedSymbolIds: draft.symbolIds,
    linkedFqNames: draft.fqNames,
  });
  const summary: SessionCompressionSummary = {
    ...draft,
    summaryObservationId: summaryObservation.id,
  };
  const persisted = persistSessionCompressionSummary(db, { summary });

  deleteEphemeralToolCallObservationsForSession(db, session.sessionId);
  markSessionCompressed(db, {
    sessionId: session.sessionId,
    compressedAtMs: input.nowMs,
    summaryId: persisted.id,
    lastActivityAtMs: session.lastActivityAtMs,
  });

  return persisted;
}

function buildSessionCompressionSummaryDraft(
  session: SessionRecord,
  observations: readonly Observation[],
  compressedAtMs: number,
): Omit<SessionCompressionSummary, "summaryObservationId"> {
  const observationCounts = countBy(observations, (observation) => observation.kind);
  const toolCallObservations = observations.filter(isEphemeralToolCallObservation);
  const toolCallCounts = countBy(
    toolCallObservations,
    (observation) => observation.toolName ?? "unknown",
  );
  const durableObservations = observations.filter((observation) => !isEphemeralToolCallObservation(observation));
  const filePaths = collectUniqueSorted(
    observations.flatMap((observation) => observation.linkedFilePaths),
  ).slice(0, MAX_SUMMARY_LINKS);
  const symbolIds = collectUniqueSorted(
    observations.flatMap((observation) => observation.linkedSymbols.map((link) => link.symbolId)),
  ).slice(0, MAX_SUMMARY_LINKS);
  const fqNames = collectUniqueSorted(
    observations.flatMap((observation) => [
      ...observation.linkedFqNames,
      ...observation.linkedSymbols.map((link) => link.fqName),
    ]),
  ).slice(0, MAX_SUMMARY_LINKS);
  const keyTerms = collectKeyTerms(observations);
  const firstActivityAtMs = observations.length === 0
    ? session.startedAtMs
    : Math.min(session.startedAtMs, ...observations.map((observation) => observation.createdAtMs));
  const lastActivityAtMs = observations.length === 0
    ? session.lastActivityAtMs
    : Math.max(session.lastActivityAtMs, ...observations.map((observation) => observation.createdAtMs));
  const summaryWithoutId = {
    sessionId: session.sessionId,
    repoRoot: session.repoRoot,
    createdAtMs: compressedAtMs,
    firstActivityAtMs,
    lastActivityAtMs,
    compressedAtMs,
    observationCounts,
    toolCallCounts,
    filePaths,
    symbolIds,
    fqNames,
    keyTerms,
    preservedDurableObservationCount: durableObservations.length,
    prunedToolCallObservationCount: toolCallObservations.length,
  };

  return {
    id: computeSessionSummaryId(summaryWithoutId),
    ...summaryWithoutId,
  };
}

function isEphemeralToolCallObservation(observation: Observation): boolean {
  return observation.kind === ObservationKind.ToolCall
    && observation.source === ObservationSource.McpAuto;
}

function countBy<T>(
  values: readonly T[],
  getKey: (value: T) => string,
): Record<string, number> {
  const counts = new Map<string, number>();

  for (const value of values) {
    const key = getKey(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function collectUniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function collectKeyTerms(observations: readonly Observation[]): string[] {
  const counts = new Map<string, number>();

  for (const observation of observations) {
    for (const term of collectObservationTerms(observation)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => {
      return right[1] - left[1]
        || left[0].localeCompare(right[0]);
    })
    .slice(0, MAX_KEY_TERMS)
    .map(([term]) => term);
}

function collectObservationTerms(observation: Observation): string[] {
  return [
    observation.summary,
    observation.body,
    observation.queryText ?? "",
    observation.intent ?? "",
    observation.toolName ?? "",
    ...observation.linkedFilePaths,
    ...observation.linkedFqNames,
    ...observation.linkedSymbols.map((link) => link.fqName),
  ]
    .flatMap((value) => value.toLowerCase().replace(/\\/g, "/").split(/[^a-z0-9_./:]+/u))
    .filter((term) => term.length >= KEY_TERM_MIN_LENGTH && !STOP_TERMS.has(term));
}

function formatSummaryBody(summary: Omit<SessionCompressionSummary, "summaryObservationId">): string {
  return [
    `session_id=${summary.sessionId}`,
    `state=compressed`,
    `first_activity_at_ms=${summary.firstActivityAtMs}`,
    `last_activity_at_ms=${summary.lastActivityAtMs}`,
    `compressed_at_ms=${summary.compressedAtMs}`,
    `observation_counts=${stableStringify(summary.observationCounts)}`,
    `tool_call_counts=${stableStringify(summary.toolCallCounts)}`,
    `files=${summary.filePaths.join(", ")}`,
    `symbol_ids=${summary.symbolIds.join(", ")}`,
    `symbol_fqns=${summary.fqNames.join(", ")}`,
    `key_terms=${summary.keyTerms.join(", ")}`,
    `preserved_durable_observation_count=${summary.preservedDurableObservationCount}`,
    `pruned_tool_call_observation_count=${summary.prunedToolCallObservationCount}`,
  ].join("\n");
}

function computeSessionSummaryId(summary: Omit<SessionCompressionSummary, "id" | "summaryObservationId">): string {
  const hash = createHash("sha256");

  hash.update("session_compression_summary");
  hash.update("\0");
  hash.update(stableStringify(summary));

  return hash.digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => {
    return `${JSON.stringify(key)}:${stableStringify(record[key])}`;
  }).join(",")}}`;
}
