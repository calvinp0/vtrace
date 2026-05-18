import assert from "node:assert/strict";
import { test } from "bun:test";

import { persistObservation } from "../db/repositories/observationsRepository";
import { markSessionCompressed } from "../db/repositories/sessionsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import {
  OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT,
  OBSERVATION_NUDGE_REPEAT_INTERVAL_TOOL_CALL_COUNT,
  ObservationNudgeLevel,
  ObservationNudgeReason,
  evaluateObservationNudge,
} from "./observationNudges";
import {
  ObservationKind,
  ObservationSource,
  SessionStatus,
} from "./types";

const REPO_ROOT = "/repo";

test("observation nudge appears at the first passive tool-call threshold", () => {
  const db = openIndexerDatabase();

  try {
    persistToolCalls(db, "session-nudge", OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT);

    const nudge = evaluateObservationNudge(db, {
      sessionId: "session-nudge",
      currentToolName: "run_pipeline",
    });

    assert.equal(nudge.enabled, true);
    assert.equal(nudge.level, ObservationNudgeLevel.Full);
    assert.equal(nudge.reason, ObservationNudgeReason.NoDurableObservationAfterToolActivity);
    assert.equal(nudge.toolCallCount, OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT);
    assert.equal(
      nudge.nextNudgeAfterToolCallCount,
      OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT + OBSERVATION_NUDGE_REPEAT_INTERVAL_TOOL_CALL_COUNT,
    );
    assert.deepEqual(
      evaluateObservationNudge(db, {
        sessionId: "session-nudge",
        currentToolName: "run_pipeline",
      }),
      nudge,
    );
  } finally {
    db.close();
  }
});

test("observation nudge stays quiet before threshold and between scheduled counts", () => {
  const db = openIndexerDatabase();

  try {
    persistToolCalls(db, "session-quiet", OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT - 1);

    const early = evaluateObservationNudge(db, {
      sessionId: "session-quiet",
      currentToolName: "run_pipeline",
    });
    assert.equal(early.enabled, false);
    assert.equal(early.reason, ObservationNudgeReason.BelowThreshold);
    assert.equal(early.nextNudgeAfterToolCallCount, OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT);

    persistToolCalls(db, "session-quiet", 2, OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT);

    const waiting = evaluateObservationNudge(db, {
      sessionId: "session-quiet",
      currentToolName: "run_pipeline",
    });
    assert.equal(waiting.enabled, false);
    assert.equal(waiting.reason, ObservationNudgeReason.WaitingForNextNudge);
    assert.equal(
      waiting.nextNudgeAfterToolCallCount,
      OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT + OBSERVATION_NUDGE_REPEAT_INTERVAL_TOOL_CALL_COUNT,
    );
  } finally {
    db.close();
  }
});

test("observation nudge repeats briefly on the deterministic interval", () => {
  const db = openIndexerDatabase();

  try {
    persistToolCalls(
      db,
      "session-brief",
      OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT + OBSERVATION_NUDGE_REPEAT_INTERVAL_TOOL_CALL_COUNT,
    );

    const nudge = evaluateObservationNudge(db, {
      sessionId: "session-brief",
      currentToolName: "run_pipeline",
    });

    assert.equal(nudge.enabled, true);
    assert.equal(nudge.level, ObservationNudgeLevel.Brief);
    assert.equal(nudge.reason, ObservationNudgeReason.StillNoDurableObservation);
    assert.equal(
      nudge.nextNudgeAfterToolCallCount,
      OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT + 2 * OBSERVATION_NUDGE_REPEAT_INTERVAL_TOOL_CALL_COUNT,
    );
  } finally {
    db.close();
  }
});

test("observation nudge self-disables after durable observations including anti-patterns", () => {
  const db = openIndexerDatabase();

  try {
    persistToolCalls(db, "session-durable", OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT);
    persistObservation(db, {
      repoRoot: REPO_ROOT,
      sessionId: "session-durable",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      toolName: "save_observation",
      summary: "Keep the session auth boundary unchanged.",
      body: "durable manual note",
      createdAtMs: 10_000,
    });

    const afterManual = evaluateObservationNudge(db, {
      sessionId: "session-durable",
      currentToolName: "run_pipeline",
    });
    assert.equal(afterManual.enabled, false);
    assert.equal(afterManual.reason, ObservationNudgeReason.DurableObservationExists);
    assert.equal(afterManual.durableObservationCount, 1);

    persistToolCalls(db, "session-anti", OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT);
    persistObservation(db, {
      repoRoot: REPO_ROOT,
      sessionId: "session-anti",
      kind: ObservationKind.DeadEnd,
      source: ObservationSource.McpAuto,
      toolName: "detect_anti_patterns",
      summary: "Possible file thrashing: src/foo.ts changed repeatedly.",
      body: "type=anti_pattern\nanti_pattern=file_thrashing",
      createdAtMs: 20_000,
    });

    const afterAntiPattern = evaluateObservationNudge(db, {
      sessionId: "session-anti",
      currentToolName: "run_pipeline",
    });
    assert.equal(afterAntiPattern.enabled, false);
    assert.equal(afterAntiPattern.reason, ObservationNudgeReason.DurableObservationExists);
    assert.equal(afterAntiPattern.durableObservationCount, 1);
  } finally {
    db.close();
  }
});

test("observation nudge excluded tools no-session and compressed sessions are deterministic", () => {
  const db = openIndexerDatabase();

  try {
    assert.deepEqual(evaluateObservationNudge(db, {
      currentToolName: "run_pipeline",
    }), {
      enabled: false,
      kind: "observation_nudge",
      reason: ObservationNudgeReason.NoSession,
      sessionId: null,
      toolCallCount: 0,
      durableObservationCount: 0,
      nextNudgeAfterToolCallCount: null,
    });

    persistToolCalls(db, "session-excluded", OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT);
    const excluded = evaluateObservationNudge(db, {
      sessionId: "session-excluded",
      currentToolName: "save_observation",
    });
    assert.equal(excluded.enabled, false);
    assert.equal(excluded.reason, ObservationNudgeReason.ExcludedTool);

    persistToolCalls(db, "session-compressed", OBSERVATION_NUDGE_FIRST_TOOL_CALL_COUNT);
    markSessionCompressed(db, {
      sessionId: "session-compressed",
      compressedAtMs: 30_000,
      summaryId: "summary-compressed",
    });
    const compressed = evaluateObservationNudge(db, {
      sessionId: "session-compressed",
      currentToolName: "run_pipeline",
    });
    assert.equal(compressed.enabled, false);
    assert.equal(compressed.reason, ObservationNudgeReason.SessionCompressed);

    const preexistingCompressed = evaluateObservationNudge(db, {
      sessionId: "session-excluded",
      currentToolName: "run_pipeline",
      preexistingSessionStatus: SessionStatus.Compressed,
    });
    assert.equal(preexistingCompressed.enabled, false);
    assert.equal(preexistingCompressed.reason, ObservationNudgeReason.SessionCompressed);
  } finally {
    db.close();
  }
});

function persistToolCalls(
  db: ReturnType<typeof openIndexerDatabase>,
  sessionId: string,
  count: number,
  startIndex = 0,
): void {
  for (let index = 0; index < count; index += 1) {
    const ordinal = startIndex + index;
    persistObservation(db, {
      repoRoot: REPO_ROOT,
      sessionId,
      sessionAgentKind: "mcp",
      kind: ObservationKind.ToolCall,
      source: ObservationSource.McpAuto,
      toolName: "run_pipeline",
      queryText: `query ${ordinal}`,
      intent: "explore",
      summary: `run_pipeline call ${ordinal}`,
      body: `tool=run_pipeline\nquery=query ${ordinal}`,
      createdAtMs: 1_000 + ordinal,
      dedupeKey: `tool-call:${sessionId}:${ordinal}`,
    });
  }
}
