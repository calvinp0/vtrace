import assert from "node:assert/strict";
import { test } from "bun:test";

import { openIndexerDatabase } from "../sqlite";
import { SessionStatus } from "../../observations/types";
import {
  countSessions,
  getSessionById,
  listSessions,
  upsertSession,
} from "./sessionsRepository";

test("sessions persist explicitly and repeated activity updates remain predictable", () => {
  const db = openIndexerDatabase();

  try {
    const created = upsertSession(db, {
      sessionId: "session-a",
      repoRoot: "/repo/demo",
      activityAtMs: 200,
      agentKind: "mcp",
    });
    const updated = upsertSession(db, {
      sessionId: "session-a",
      repoRoot: "/repo/demo",
      activityAtMs: 500,
    });

    assert.deepEqual(created, {
      sessionId: "session-a",
      repoRoot: "/repo/demo",
      agentKind: "mcp",
      startedAtMs: 200,
      lastActivityAtMs: 200,
      status: SessionStatus.Active,
    });
    assert.deepEqual(updated, {
      sessionId: "session-a",
      repoRoot: "/repo/demo",
      agentKind: "mcp",
      startedAtMs: 200,
      lastActivityAtMs: 500,
      status: SessionStatus.Active,
    });
    assert.deepEqual(getSessionById(db, "session-a"), updated);
    assert.deepEqual(listSessions(db), [updated]);
    assert.equal(countSessions(db), 1);
  } finally {
    db.close();
  }
});

test("sessions reject repo-root mismatches for the same session id", () => {
  const db = openIndexerDatabase();

  try {
    upsertSession(db, {
      sessionId: "session-a",
      repoRoot: "/repo/demo",
      activityAtMs: 100,
    });

    assert.throws(() => {
      upsertSession(db, {
        sessionId: "session-a",
        repoRoot: "/repo/other",
        activityAtMs: 200,
      });
    }, /already bound to repoRoot/);
  } finally {
    db.close();
  }
});
