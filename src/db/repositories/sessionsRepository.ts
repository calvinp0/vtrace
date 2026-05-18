import type { Database } from "bun:sqlite";

import {
  SessionStatus,
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
}

interface SessionWithObservationCountRow extends SessionRow {
  observation_count: number;
}

export interface UpsertSessionInput {
  sessionId: string;
  repoRoot: string;
  activityAtMs: number;
  agentKind?: string;
  status?: SessionRecord["status"];
}

export function upsertSession(
  db: Database,
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
          status
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        input.sessionId,
        input.repoRoot,
        input.agentKind ?? null,
        input.activityAtMs,
        input.activityAtMs,
        input.status ?? SessionStatus.Active,
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
        status = ?
      WHERE session_id = ?
    `,
    [
      input.agentKind ?? null,
      input.activityAtMs,
      input.activityAtMs,
      input.status ?? SessionStatus.Active,
      input.sessionId,
    ],
  );

  return getSessionById(db, input.sessionId)!;
}

export function getSessionById(
  db: Database,
  sessionId: string,
): SessionRecord | undefined {
  const row = db.query(`
    SELECT
      session_id,
      repo_root,
      agent_kind,
      started_at_ms,
      last_activity_at_ms,
      status
    FROM sessions
    WHERE session_id = ?
  `).get(sessionId) as SessionRow | null;

  return row === null ? undefined : sessionRowToRecord(row);
}

export function listSessions(db: Database): SessionRecord[] {
  const rows = db.query(`
    SELECT
      session_id,
      repo_root,
      agent_kind,
      started_at_ms,
      last_activity_at_ms,
      status
    FROM sessions
    ORDER BY last_activity_at_ms DESC, session_id ASC
  `).all() as SessionRow[];

  return rows.map(sessionRowToRecord);
}

export function listSessionsWithObservationCounts(
  db: Database,
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
      s.status
    ORDER BY s.last_activity_at_ms DESC, s.session_id ASC
    LIMIT ?
  `).all(limit) as SessionWithObservationCountRow[];

  return rows.map((row) => ({
    sessionId: row.session_id,
    ...(row.agent_kind === null ? {} : { agentKind: row.agent_kind }),
    status: row.status as SessionRecord["status"],
    startedAtMs: row.started_at_ms,
    lastActivityAtMs: row.last_activity_at_ms,
    observationCount: row.observation_count,
  }));
}

export function countSessions(db: Database): number {
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
  };
}
