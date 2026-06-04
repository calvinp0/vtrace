import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { listIndexRuns } from "../db/repositories/indexRunsRepository";
import {
  listObservationsForSession,
  persistObservation,
} from "../db/repositories/observationsRepository";
import { getSessionById } from "../db/repositories/sessionsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { ObservationKind, ObservationSource, SessionStatus } from "../observations/types";
import { initRepo } from "../setup/initRepo";
import {
  reindexRepoAndRefreshState,
  runBoundedSessionCompressionSweep,
} from "./reindexRepo";

interface ReindexFixture {
  repoRoot: string;
  dbPath: string;
  statePath: string;
}

async function withReindexFixture(
  run: (fixture: ReindexFixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-reindex-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "models.ts"),
      "export interface User { id: string }\n",
    );
    await writeFile(
      path.join(repoRoot, "src", "service.ts"),
      "import { User } from \"./models\";\nexport function readUser(): User { return { id: \"fixture\" }; }\n",
    );

    const initialized = await initRepo({ repoPath: repoRoot });

    await run({
      repoRoot: initialized.repoRoot,
      dbPath: initialized.paths.dbPath,
      statePath: initialized.paths.statePath,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function reindexInput(fixture: ReindexFixture) {
  return {
    repoRoot: fixture.repoRoot,
    dbPath: fixture.dbPath,
    statePath: fixture.statePath,
    configPresent: true,
    statePresent: true,
    usesDbPathOverride: false,
  } as const;
}

function seedAncientPassiveSession(
  dbPath: string,
  repoRoot: string,
  sessionId: string,
): void {
  const db = openIndexerDatabase(dbPath);
  try {
    const sourceRunId = listIndexRuns(db).at(-1)?.id;
    for (const [index, createdAtMs] of [100, 120, 140].entries()) {
      persistObservation(db, {
        repoRoot,
        sessionId,
        kind: ObservationKind.ToolCall,
        source: ObservationSource.McpAuto,
        toolName: "run_pipeline",
        summary: `Repeated capsule ${index}`,
        body: `tool=run_pipeline\nquery=reindex sweep\npivot_count=1\nsupport_count=2\ncall=${index}`,
        queryText: "reindex sweep",
        intent: "explain",
        sourceRunId,
        createdAtMs,
        linkedFilePaths: ["src/service.ts"],
      });
    }
    persistObservation(db, {
      repoRoot,
      sessionId,
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      toolName: "save_observation",
      summary: "Durable decision kept",
      body: "Manual decision retained across the reindex sweep.",
      queryText: "durable decision",
      createdAtMs: 160,
      linkedFilePaths: ["src/service.ts"],
    });
  } finally {
    db.close();
  }
}

test("reindex runs a bounded session compression sweep that compresses inactive sessions and surfaces diagnostics", async () => {
  await withReindexFixture(async (fixture) => {
    // An ancient (1970-epoch) session is always inactive past the threshold.
    seedAncientPassiveSession(fixture.dbPath, fixture.repoRoot, "session-old");

    const result = await reindexRepoAndRefreshState(reindexInput(fixture));

    assert.equal(result.sessionCompression.attempted, true);
    assert.equal(result.sessionCompression.error, null);
    assert.equal(result.sessionCompression.limit, 20);
    assert.equal(result.sessionCompression.eligibleSessionCount, 1);
    assert.equal(result.sessionCompression.processedSessionCount, 1);
    assert.equal(result.sessionCompression.compressedSessionCount, 1);
    assert.equal(result.sessionCompression.prunedToolCallObservationCount, 3);

    const db = openIndexerDatabase(fixture.dbPath);
    try {
      assert.equal(getSessionById(db, "session-old")?.status, SessionStatus.Compressed);
      const observations = listObservationsForSession(db, "session-old");
      assert.equal(
        observations.filter((observation) => observation.summary.startsWith("Repeated capsule")).length,
        0,
      );
      assert.equal(
        observations.some((observation) => observation.summary === "Durable decision kept"),
        true,
      );
    } finally {
      db.close();
    }
  });
});

test("reindex sweep is idempotent across repeated reindexes", async () => {
  await withReindexFixture(async (fixture) => {
    seedAncientPassiveSession(fixture.dbPath, fixture.repoRoot, "session-old");

    const first = await reindexRepoAndRefreshState(reindexInput(fixture));
    assert.equal(first.sessionCompression.compressedSessionCount, 1);

    const second = await reindexRepoAndRefreshState(reindexInput(fixture));
    assert.equal(second.sessionCompression.attempted, true);
    assert.equal(second.sessionCompression.error, null);
    assert.equal(second.sessionCompression.eligibleSessionCount, 0);
    assert.equal(second.sessionCompression.compressedSessionCount, 0);
  });
});

test("reindex sweep skips recent active sessions", async () => {
  await withReindexFixture(async (fixture) => {
    const db = openIndexerDatabase(fixture.dbPath);
    try {
      persistObservation(db, {
        repoRoot: fixture.repoRoot,
        sessionId: "session-recent",
        kind: ObservationKind.ToolCall,
        source: ObservationSource.McpAuto,
        toolName: "run_pipeline",
        summary: "Recent capsule call",
        body: "tool=run_pipeline\nquery=recent\npivot_count=1\nsupport_count=1\ncall=0",
        queryText: "recent",
        intent: "explain",
        sourceRunId: listIndexRuns(db).at(-1)?.id,
        createdAtMs: Date.now(),
        linkedFilePaths: ["src/service.ts"],
      });
    } finally {
      db.close();
    }

    const result = await reindexRepoAndRefreshState(reindexInput(fixture));
    assert.equal(result.sessionCompression.eligibleSessionCount, 0);
    assert.equal(result.sessionCompression.compressedSessionCount, 0);

    const after = openIndexerDatabase(fixture.dbPath);
    try {
      assert.equal(getSessionById(after, "session-recent")?.status, SessionStatus.Active);
    } finally {
      after.close();
    }
  });
});

test("session compression sweep failure is isolated and never throws", async () => {
  await withReindexFixture(async (fixture) => {
    const db = openIndexerDatabase(fixture.dbPath);
    try {
      // Force the sweep to fail by removing a table it depends on. The sweep
      // must capture the error as a diagnostic, not throw — so a reindex that
      // calls it can never fail because of compression.
      db.run("DROP TABLE sessions");
      const diagnostics = runBoundedSessionCompressionSweep(db, fixture.repoRoot);

      assert.equal(diagnostics.attempted, true);
      assert.equal(diagnostics.compressedSessionCount, 0);
      assert.notEqual(diagnostics.error, null);
    } finally {
      db.close();
    }
  });
});
