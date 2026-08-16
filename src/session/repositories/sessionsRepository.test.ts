import assert from "node:assert/strict";
import { test } from "bun:test";

import { openIndexerDatabase } from "../../db/sqlite";
import { createTestProductStores } from "../../testing/productStores";
import { SessionStatus } from "../../observations/types";
import {
  countSessions,
  getSessionById,
  listSessions,
  upsertSession,
} from "./sessionsRepository";

test("sessions persist explicitly and repeated activity updates remain predictable", () => {
  const db = openIndexerDatabase();
  const stores = createTestProductStores(db);

  try {
    const created = upsertSession(stores.session, {
      sessionId: "session-a",
      repoRoot: "/repo/demo",
      activityAtMs: 200,
      agentKind: "mcp",
    });
    const updated = upsertSession(stores.session, {
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
    assert.deepEqual(getSessionById(stores.session, "session-a"), updated);
    assert.deepEqual(listSessions(stores.session), [updated]);
    assert.equal(countSessions(stores.session), 1);
  } finally {
    db.close();
  }
});

test("sessions reject repo-root mismatches for the same session id", () => {
  const db = openIndexerDatabase();
  const stores = createTestProductStores(db);

  try {
    upsertSession(stores.session, {
      sessionId: "session-a",
      repoRoot: "/repo/demo",
      activityAtMs: 100,
    });

    assert.throws(() => {
      upsertSession(stores.session, {
        sessionId: "session-a",
        repoRoot: "/repo/other",
        activityAtMs: 200,
      });
    }, /already bound to repoRoot/);
  } finally {
    db.close();
  }
});
