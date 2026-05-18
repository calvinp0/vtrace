import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { runIndexCommand } from "../cli/commands/indexCommand";
import { getLatestIndexRun } from "../db/repositories/indexRunsRepository";
import {
  countObservations,
  listObservations,
} from "../db/repositories/observationsRepository";
import { getSessionById } from "../db/repositories/sessionsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { StaleStateStatus } from "../memory/types";
import { recordObservedFileChanges } from "../runtime/fileWatcher";
import { initRepo } from "../setup/initRepo";
import { readRepoLocalState } from "../setup/repoState";
import {
  AntiPatternSeverity,
  AntiPatternType,
  DEFAULT_FILE_THRASHING_CHANGE_THRESHOLD,
  DEFAULT_FILE_THRASHING_WINDOW_MS,
  detectSymbolAddedThenRemovedAntiPatterns,
} from "./antiPatterns";
import { getSessionContext } from "./getSessionContext";
import { searchMemory } from "./searchMemory";
import {
  DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS,
  compressInactiveSessions,
} from "./sessionLifecycle";
import { getObservationStaleness } from "./staleness";
import {
  ObservationKind,
  ObservationSource,
  SessionStatus,
} from "./types";

test("file thrashing detection persists one deduped anti-pattern observation for repeated source changes", async () => {
  await withRepoFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });

    for (let index = 0; index < DEFAULT_FILE_THRASHING_CHANGE_THRESHOLD; index += 1) {
      await recordObservedFileChanges({
        repoRoot,
        statePath: initialized.paths.statePath,
        changedFilePaths: ["src/service.ts"],
        nowMs: 1_000 + index * 60_000,
      });
    }

    await recordObservedFileChanges({
      repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: ["src/service.ts"],
      nowMs: 1_000 + (DEFAULT_FILE_THRASHING_CHANGE_THRESHOLD - 1) * 60_000,
    });

    const db = openIndexerDatabase(initialized.paths.dbPath);

    try {
      const observations = listObservations(db).filter((observation) => {
        return observation.kind === ObservationKind.DeadEnd
          && observation.body.includes(`anti_pattern=${AntiPatternType.FileThrashing}`);
      });

      assert.equal(observations.length, 1);
      assert.equal(observations[0]!.source, ObservationSource.McpAuto);
      assert.equal(observations[0]!.toolName, "detect_anti_patterns");
      assert.equal(observations[0]!.body.includes(`severity=${AntiPatternSeverity.Medium}`), true);
      assert.equal(observations[0]!.body.includes("change_count=5"), true);
      assert.deepEqual(observations[0]!.linkedFilePaths, ["src/service.ts"]);
      assert.equal(countObservations(db), 1);
      assert.equal(getSessionContext(db, { limit: 3 }).observations[0]?.id, observations[0]!.id);
      assert.equal(searchMemory(db, { query: "file_thrashing src/service.ts", maxResults: 3 })[0]?.observation.id, observations[0]!.id);
    } finally {
      db.close();
    }
  });
});

test("file thrashing detection ignores below-threshold, outside-window, and ignored-path events", async () => {
  await withRepoFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });

    for (let index = 0; index < DEFAULT_FILE_THRASHING_CHANGE_THRESHOLD - 1; index += 1) {
      await recordObservedFileChanges({
        repoRoot,
        statePath: initialized.paths.statePath,
        changedFilePaths: ["src/service.ts"],
        nowMs: 10_000 + index * 60_000,
      });
    }

    for (let index = 0; index < DEFAULT_FILE_THRASHING_CHANGE_THRESHOLD; index += 1) {
      await recordObservedFileChanges({
        repoRoot,
        statePath: initialized.paths.statePath,
        changedFilePaths: ["src/models.ts"],
        nowMs: 1_000_000 + index * (DEFAULT_FILE_THRASHING_WINDOW_MS + 1),
      });
    }

    for (let index = 0; index < DEFAULT_FILE_THRASHING_CHANGE_THRESHOLD + 2; index += 1) {
      await recordObservedFileChanges({
        repoRoot,
        statePath: initialized.paths.statePath,
        changedFilePaths: [".vexb/state.ts", "node_modules/pkg/index.ts", "README.md"],
        nowMs: 2_000_000 + index,
      });
    }

    const db = openIndexerDatabase(initialized.paths.dbPath);

    try {
      assert.equal(
        listObservations(db).some((observation) => observation.body.includes("anti_pattern=")),
        false,
      );
      assert.equal((await readRepoLocalState(initialized.paths.statePath)).observedFileChangeEvents?.length, DEFAULT_FILE_THRASHING_CHANGE_THRESHOLD * 2 - 1);
    } finally {
      db.close();
    }
  });
});

test("file thrashing observations participate in existing diff-based staleness", async () => {
  await withRepoFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });

    for (let index = 0; index < DEFAULT_FILE_THRASHING_CHANGE_THRESHOLD; index += 1) {
      await recordObservedFileChanges({
        repoRoot,
        statePath: initialized.paths.statePath,
        changedFilePaths: ["src/service.ts"],
        nowMs: 3_000 + index,
      });
    }

    const db = openIndexerDatabase(initialized.paths.dbPath);

    try {
      const observation = searchMemory(db, { query: "file_thrashing service", maxResults: 1 })[0]?.observation;
      assert.notEqual(observation, undefined);

      await writeServiceFile(repoRoot, "readUserChanged");
      await indexProject({ repoRoot, db });

      const staleness = getObservationStaleness(db, observation!);
      assert.equal(staleness.status, StaleStateStatus.Stale);
      assert.equal(staleness.reasons.some((reason) => reason.kind === "file_modified"), true);
    } finally {
      db.close();
    }
  });
});

test("symbol added then removed detection persists a possible dead-end anti-pattern after explicit reindex", async () => {
  await withRepoFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });

    await writeServiceFile(repoRoot, "temporaryDeadEnd");
    assert.equal((await runIndexCommand([repoRoot], { cwd: repoRoot })).exitCode, 0);
    await writeServiceFile(repoRoot, "readUser");
    assert.equal((await runIndexCommand([repoRoot], { cwd: repoRoot })).exitCode, 0);

    const db = openIndexerDatabase(initialized.paths.dbPath);

    try {
      const observations = listObservations(db).filter((observation) => {
        return observation.body.includes(`anti_pattern=${AntiPatternType.SymbolAddedThenRemoved}`);
      });

      assert.equal(observations.length, 1);
      assert.equal(observations[0]!.kind, ObservationKind.DeadEnd);
      assert.equal(observations[0]!.summary.includes("Possible dead-end exploration"), true);
      assert.equal(observations[0]!.body.includes(`severity=${AntiPatternSeverity.Medium}`), true);
      assert.equal(observations[0]!.body.includes("symbol_fqn=src/service.ts::temporaryDeadEnd"), true);
      assert.deepEqual(observations[0]!.linkedFilePaths, ["src/service.ts"]);
      assert.deepEqual(observations[0]!.linkedFqNames, ["src/service.ts::temporaryDeadEnd"]);

      detectSymbolAddedThenRemovedAntiPatterns(db, {
        repoRoot,
        runId: getLatestIndexRun(db)!.id,
      });
      assert.equal(
        listObservations(db).filter((observation) => observation.body.includes(`anti_pattern=${AntiPatternType.SymbolAddedThenRemoved}`)).length,
        1,
      );
    } finally {
      db.close();
    }
  });
});

test("session-bound anti-pattern observations survive compression and remain searchable", async () => {
  await withRepoFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      await writeServiceFile(repoRoot, "temporaryDeadEnd");
      await indexProject({ repoRoot, db });
      await writeServiceFile(repoRoot, "readUser");
      await indexProject({ repoRoot, db });

      const detected = detectSymbolAddedThenRemovedAntiPatterns(db, {
        repoRoot,
        runId: getLatestIndexRun(db)!.id,
        sessionId: "anti-session",
        sessionAgentKind: "mcp",
      });
      assert.equal(detected.length, 1);
      assert.equal(detected[0]!.sessionId, "anti-session");

      const compressed = compressInactiveSessions(db, {
        repoRoot,
        nowMs: detected[0]!.createdAtMs + DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS,
      });
      const session = getSessionById(db, "anti-session");
      const context = getSessionContext(db, { sessionId: "anti-session", query: "dead-end temporary", limit: 5 });

      assert.equal(session?.status, SessionStatus.Compressed);
      assert.equal(compressed.compressedSummaries[0]?.observationCounts.dead_end, 1);
      assert.equal(compressed.compressedSummaries[0]?.preservedDurableObservationCount, 1);
      assert.equal(compressed.compressedSummaries[0]?.prunedToolCallObservationCount, 0);
      assert.equal(context.observations.some((observation) => observation.id === detected[0]!.id), true);
      assert.equal(
        searchMemory(db, { query: "symbol_added_then_removed", maxResults: 5 }).some((result) => result.observation.id === detected[0]!.id),
        true,
      );
    } finally {
      db.close();
    }
  });
});

async function withRepoFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vexb-anti-patterns-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(repoRoot, { recursive: true });
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(path.join(repoRoot, "src", "models.ts"), "export interface User { id: string }\n");
  await writeServiceFile(repoRoot, "readUser");
}

async function writeServiceFile(repoRoot: string, functionName: string): Promise<void> {
  await writeFile(
    path.join(repoRoot, "src", "service.ts"),
    [
      "import type { User } from \"./models\";",
      "",
      `export function ${functionName}(id: string): User {`,
      "  return { id };",
      "}",
      "",
    ].join("\n"),
  );
}
