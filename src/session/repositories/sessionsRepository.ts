import type { SessionDatabase, WritableSessionDatabase } from "../sessionStore";

import {
  SessionStatus,
  type SessionCleanupCandidate,
  type SessionCompressionSummary,
  type SessionListItem,
  type SessionRecord,
} from "../../observations/types";

interface SessionRow {
  session_id: string;
  repo_root: string;
  agent_kind: string | null;
  started_at_ms: number;
  last_activity_at_ms: number;
  status: string;
  compressed_at_ms: number | null;
  summary_id: string | null;
}

interface SessionWithObservationCountRow extends SessionRow {
  observation_count: number;
}

interface SessionCompressionSummaryRow {
  id: string;
  session_id: string;
  repo_root: string;
  created_at_ms: number;
  first_activity_at_ms: number;
  last_activity_at_ms: number;
  compressed_at_ms: number;
  observation_counts_json: string;
  tool_call_counts_json: string;
  file_paths_json: string;
  symbol_ids_json: string;
  fq_names_json: string;
  key_terms_json: string;
  preserved_durable_observation_count: number;
  pruned_tool_call_observation_count: number;
  summary_observation_id: string;
}

export interface UpsertSessionInput {
  sessionId: string;
  repoRoot: string;
  activityAtMs: number;
  agentKind?: string;
  status?: SessionRecord["status"];
}

export function upsertSession(
  db: WritableSessionDatabase,
  input: UpsertSessionInput,
): SessionRecord {
  const existing = getSessionById(db, input.sessionId);

  if (existing === undefined) {
    db.run(
      `
        INSERT INTO sessions (
          session_id,
          repo_root,
          agent_kind,
        started_at_ms,
        last_activity_at_ms,
        status,
        compressed_at_ms,
        summary_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        input.sessionId,
        input.repoRoot,
        input.agentKind ?? null,
        input.activityAtMs,
        input.activityAtMs,
        input.status ?? SessionStatus.Active,
        null,
        null,
      ],
    );

    return getSessionById(db, input.sessionId)!;
  }

  if (existing.repoRoot !== input.repoRoot) {
    throw new Error(
      `Session ${input.sessionId} is already bound to repoRoot ${existing.repoRoot}`,
    );
  }

  db.run(
    `
      UPDATE sessions
      SET
        agent_kind = COALESCE(agent_kind, ?),
        started_at_ms = MIN(started_at_ms, ?),
        last_activity_at_ms = MAX(last_activity_at_ms, ?),
        status = ?,
        compressed_at_ms = CASE WHEN ? = ? THEN NULL ELSE compressed_at_ms END,
        summary_id = CASE WHEN ? = ? THEN NULL ELSE summary_id END
      WHERE session_id = ?
    `,
    [
      input.agentKind ?? null,
      input.activityAtMs,
      input.activityAtMs,
      input.status ?? SessionStatus.Active,
      input.status ?? SessionStatus.Active,
      SessionStatus.Active,
      input.status ?? SessionStatus.Active,
      SessionStatus.Active,
      input.sessionId,
    ],
  );

  return getSessionById(db, input.sessionId)!;
}

export function getSessionById(
  db: SessionDatabase,
  sessionId: string,
): SessionRecord | undefined {
  const row = db.query(`
    SELECT
      session_id,
      repo_root,
      agent_kind,
      started_at_ms,
      last_activity_at_ms,
      status,
      compressed_at_ms,
      summary_id
    FROM sessions
    WHERE session_id = ?
  `).get(sessionId) as SessionRow | null;

  return row === null ? undefined : sessionRowToRecord(row);
}

export function listSessions(db: SessionDatabase): SessionRecord[] {
  const rows = db.query(`
    SELECT
      session_id,
      repo_root,
      agent_kind,
      started_at_ms,
      last_activity_at_ms,
      status,
      compressed_at_ms,
      summary_id
    FROM sessions
    ORDER BY last_activity_at_ms DESC, session_id ASC
  `).all() as SessionRow[];

  return rows.map(sessionRowToRecord);
}

export function listSessionsWithObservationCounts(
  db: SessionDatabase,
  limit: number,
): SessionListItem[] {
  const rows = db.query(`
    SELECT
      s.session_id,
      s.repo_root,
      s.agent_kind,
      s.started_at_ms,
      s.last_activity_at_ms,
      s.status,
      s.compressed_at_ms,
      s.summary_id,
      COUNT(o.id) AS observation_count
    FROM sessions s
    LEFT JOIN observations o
      ON o.session_id = s.session_id
    GROUP BY
      s.session_id,
      s.repo_root,
      s.agent_kind,
      s.started_at_ms,
      s.last_activity_at_ms,
      s.status,
      s.compressed_at_ms,
      s.summary_id
    ORDER BY s.last_activity_at_ms DESC, s.session_id ASC
    LIMIT ?
  `).all(limit) as SessionWithObservationCountRow[];

  return rows.map((row) => ({
    sessionId: row.session_id,
    ...(row.agent_kind === null ? {} : { agentKind: row.agent_kind }),
    status: row.status as SessionRecord["status"],
    startedAtMs: row.started_at_ms,
    lastActivityAtMs: row.last_activity_at_ms,
    ...(row.compressed_at_ms === null ? {} : { compressedAtMs: row.compressed_at_ms }),
    ...(row.summary_id === null ? {} : { summaryId: row.summary_id }),
    observationCount: row.observation_count,
  }));
}

export interface PersistSessionCompressionSummaryInput {
  summary: SessionCompressionSummary;
}

export function persistSessionCompressionSummary(
  db: WritableSessionDatabase,
  input: PersistSessionCompressionSummaryInput,
): SessionCompressionSummary {
  const existing = getSessionCompressionSummary(db, input.summary.sessionId);

  if (existing !== undefined) {
    return existing;
  }

  db.run(
    `
      INSERT INTO session_compression_summaries (
        id,
        session_id,
        repo_root,
        created_at_ms,
        first_activity_at_ms,
        last_activity_at_ms,
        compressed_at_ms,
        observation_counts_json,
        tool_call_counts_json,
        file_paths_json,
        symbol_ids_json,
        fq_names_json,
        key_terms_json,
        preserved_durable_observation_count,
        pruned_tool_call_observation_count,
        summary_observation_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.summary.id,
      input.summary.sessionId,
      input.summary.repoRoot,
      input.summary.createdAtMs,
      input.summary.firstActivityAtMs,
      input.summary.lastActivityAtMs,
      input.summary.compressedAtMs,
      JSON.stringify(input.summary.observationCounts),
      JSON.stringify(input.summary.toolCallCounts),
      JSON.stringify(input.summary.filePaths),
      JSON.stringify(input.summary.symbolIds),
      JSON.stringify(input.summary.fqNames),
      JSON.stringify(input.summary.keyTerms),
      input.summary.preservedDurableObservationCount,
      input.summary.prunedToolCallObservationCount,
      input.summary.summaryObservationId,
    ],
  );

  return getSessionCompressionSummary(db, input.summary.sessionId)!;
}

export function markSessionCompressed(
  db: WritableSessionDatabase,
  input: {
    sessionId: string;
    compressedAtMs: number;
    summaryId: string;
    lastActivityAtMs?: number;
  },
): SessionRecord | undefined {
  db.run(
    `
      UPDATE sessions
      SET
        status = ?,
        compressed_at_ms = ?,
        summary_id = ?,
        last_activity_at_ms = COALESCE(?, last_activity_at_ms)
      WHERE session_id = ?
    `,
    [
      SessionStatus.Compressed,
      input.compressedAtMs,
      input.summaryId,
      input.lastActivityAtMs ?? null,
      input.sessionId,
    ],
  );

  return getSessionById(db, input.sessionId);
}

export function getSessionCompressionSummary(
  db: SessionDatabase,
  sessionId: string,
): SessionCompressionSummary | undefined {
  const row = db.query(`
    SELECT
      id,
      session_id,
      repo_root,
      created_at_ms,
      first_activity_at_ms,
      last_activity_at_ms,
      compressed_at_ms,
      observation_counts_json,
      tool_call_counts_json,
      file_paths_json,
      symbol_ids_json,
      fq_names_json,
      key_terms_json,
      preserved_durable_observation_count,
      pruned_tool_call_observation_count,
      summary_observation_id
    FROM session_compression_summaries
    WHERE session_id = ?
  `).get(sessionId) as SessionCompressionSummaryRow | null;

  return row === null ? undefined : sessionCompressionSummaryRowToRecord(row);
}

export function listSessionCleanupCandidates(
  db: SessionDatabase,
  input: {
    nowMs: number;
    retentionAfterMs: number;
  },
): SessionCleanupCandidate[] {
  return listSessions()
    .filter((session) => session.status === SessionStatus.Compressed)
    .map((session) => {
      const compressedAtMs = session.compressedAtMs ?? session.lastActivityAtMs;
      const compressedForMs = Math.max(input.nowMs - compressedAtMs, 0);

      return {
        session,
        compressedSummary: getSessionCompressionSummary(db, session.sessionId) ?? null,
        eligibleForDeletion: compressedForMs >= input.retentionAfterMs,
        compressedForMs,
        retentionMs: input.retentionAfterMs,
      };
    })
    .sort((left, right) => {
      return Number(right.eligibleForDeletion) - Number(left.eligibleForDeletion)
        || (right.session.compressedAtMs ?? 0) - (left.session.compressedAtMs ?? 0)
        || left.session.sessionId.localeCompare(right.session.sessionId);
    });

  function listSessions(): SessionRecord[] {
    const rows = db.query(`
      SELECT
        session_id,
        repo_root,
        agent_kind,
        started_at_ms,
        last_activity_at_ms,
        status,
        compressed_at_ms,
        summary_id
      FROM sessions
      WHERE status = ?
      ORDER BY compressed_at_ms DESC, session_id ASC
    `).all(SessionStatus.Compressed) as SessionRow[];

    return rows.map(sessionRowToRecord);
  }
}

export function countSessions(db: SessionDatabase): number {
  const row = db.query("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
  return row.count;
}

function sessionRowToRecord(row: SessionRow): SessionRecord {
  return {
    sessionId: row.session_id,
    repoRoot: row.repo_root,
    ...(row.agent_kind === null ? {} : { agentKind: row.agent_kind }),
    startedAtMs: row.started_at_ms,
    lastActivityAtMs: row.last_activity_at_ms,
    status: row.status as SessionRecord["status"],
    ...(row.compressed_at_ms === null ? {} : { compressedAtMs: row.compressed_at_ms }),
    ...(row.summary_id === null ? {} : { summaryId: row.summary_id }),
  };
}

function sessionCompressionSummaryRowToRecord(
  row: SessionCompressionSummaryRow,
): SessionCompressionSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    repoRoot: row.repo_root,
    createdAtMs: row.created_at_ms,
    firstActivityAtMs: row.first_activity_at_ms,
    lastActivityAtMs: row.last_activity_at_ms,
    compressedAtMs: row.compressed_at_ms,
    observationCounts: parseJsonRecord(row.observation_counts_json),
    toolCallCounts: parseJsonRecord(row.tool_call_counts_json),
    filePaths: parseJsonStringArray(row.file_paths_json),
    symbolIds: parseJsonStringArray(row.symbol_ids_json),
    fqNames: parseJsonStringArray(row.fq_names_json),
    keyTerms: parseJsonStringArray(row.key_terms_json),
    preservedDurableObservationCount: row.preserved_durable_observation_count,
    prunedToolCallObservationCount: row.pruned_tool_call_observation_count,
    summaryObservationId: row.summary_observation_id,
  };
}

function parseJsonRecord(value: string): Record<string, number> {
  const parsed = JSON.parse(value) as Record<string, number>;
  return Object.fromEntries(
    Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parseJsonStringArray(value: string): string[] {
  return (JSON.parse(value) as string[]).slice();
}
