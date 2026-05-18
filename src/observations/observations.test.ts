import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  countObservations,
  getObservationById,
  listObservations,
  persistObservation,
} from "../db/repositories/observationsRepository";
import {
  countSessions,
  getSessionById,
  upsertSession,
} from "../db/repositories/sessionsRepository";
import {
  getLatestIndexRun,
  listFileDiffsForRun,
  listSymbolDiffsForRun,
} from "../db/repositories/indexRunsRepository";
import { listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { routeQuery } from "../intent/routeQuery";
import { FileChangeType, StaleStateStatus } from "../memory/types";
import { CapsuleBudgetModel, type Capsule } from "../capsule/types";
import { captureVisibleCapsuleObservationBestEffort } from "./autoCapture";
import { getSessionContext } from "./getSessionContext";
import {
  listInspectableSessions,
  readInspectableSession,
} from "./sessionInspection";
import { searchMemory } from "./searchMemory";
import { getObservationStaleness } from "./staleness";
import {
  ObservationKind,
  ObservationSource,
  ObservationStaleReasonKind,
  SessionStatus,
} from "./types";

test("observations persist deterministically with explicit kinds and structural links", async () => {
  await withObservationFixture(async ({ repoRoot, db }) => {
    await indexProject({ repoRoot, db });
    const readUser = listSymbolsForFile(db, "src/service.ts").find((symbol) => symbol.localName === "readUser");

    assert.notEqual(readUser, undefined);

    const observation = persistObservation(db, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Prefer loading the session model through the service layer",
      body: "The service layer keeps storage coupling out of callers.",
      queryText: "how is session loading handled",
      intent: "explain",
      toolName: "save_observation",
      sourceRunId: getLatestIndexRun(db)?.id,
      createdAtMs: 100,
      linkedFilePaths: ["src/service.ts"],
      linkedSymbolIds: [readUser!.id],
      linkedFqNames: ["src/service.ts::readUser"],
    });

    assert.deepEqual(getObservationById(db, observation.id), observation);
    assert.equal(observation.kind, ObservationKind.Decision);
    assert.equal(observation.linkedFilePaths[0], "src/service.ts");
    assert.deepEqual(
      observation.linkedSymbols.map((link) => [link.symbolId, link.fqName, link.symbolKind]),
      [[readUser!.id, readUser!.fqName, readUser!.kind]],
    );
    assert.deepEqual(observation.linkedFqNames, ["src/service.ts::readUser"]);
    assert.equal(countObservations(db), 1);
    assert.equal(countSessions(db), 1);
    assert.deepEqual(getSessionById(db, "session-a"), {
      sessionId: "session-a",
      repoRoot,
      startedAtMs: 100,
      lastActivityAtMs: 100,
      status: SessionStatus.Active,
    });
    assert.deepEqual(listObservations(db), [observation]);
  });
});

test("observation identity is content-stable and createdAtMs remains metadata only", async () => {
  await withObservationFixture(async ({ repoRoot, db }) => {
    await indexProject({ repoRoot, db });

    const first = persistObservation(db, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Prefer loading the session model through the service layer",
      body: "The service layer keeps storage coupling out of callers.",
      queryText: "how is session loading handled",
      intent: "explain",
      toolName: "save_observation",
      createdAtMs: 100,
      linkedFilePaths: ["src/service.ts"],
      linkedFqNames: ["src/service.ts::readUser"],
    });
    const second = persistObservation(db, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Prefer loading the session model through the service layer",
      body: "The service layer keeps storage coupling out of callers.",
      queryText: "how is session loading handled",
      intent: "explain",
      toolName: "save_observation",
      createdAtMs: 200,
      linkedFilePaths: ["src/service.ts"],
      linkedFqNames: ["src/service.ts::readUser"],
    });

    assert.equal(second.id, first.id);
    assert.equal(second.createdAtMs, 100);
    assert.equal(countObservations(db), 1);
  });
});

test("session-linked observations update explicit session activity without changing observation truth", async () => {
  await withObservationFixture(async ({ repoRoot, db }) => {
    const first = persistObservation(db, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Use adapter entrypoint",
      body: "The adapter owns session orchestration.",
      createdAtMs: 100,
    });
    const second = persistObservation(db, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Use adapter entrypoint",
      body: "The adapter owns session orchestration.",
      createdAtMs: 300,
    });

    assert.equal(first.id, second.id);
    assert.equal(countObservations(db), 1);
    assert.deepEqual(getSessionById(db, "session-a"), {
      sessionId: "session-a",
      repoRoot,
      startedAtMs: 100,
      lastActivityAtMs: 300,
      status: SessionStatus.Active,
    });
  });
});

test("session linkage integrity rejects repo-root mismatches for persisted sessions", async () => {
  await withObservationFixture(async ({ repoRoot, db }) => {
    persistObservation(db, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Use adapter entrypoint",
      body: "The adapter owns session orchestration.",
      createdAtMs: 100,
    });

    assert.throws(() => {
      persistObservation(db, {
        repoRoot: "/other/repo",
        sessionId: "session-a",
        kind: ObservationKind.Warning,
        source: ObservationSource.Manual,
        summary: "Conflicting session repo",
        body: "This should fail.",
        createdAtMs: 200,
      });
    }, /already bound to repoRoot/);
  });
});

test("session-linked activity reactivates inactive sessions deterministically", async () => {
  await withObservationFixture(async ({ repoRoot, db }) => {
    upsertSession(db, {
      sessionId: "session-a",
      repoRoot,
      activityAtMs: 100,
      status: SessionStatus.Inactive,
    });

    persistObservation(db, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Warning,
      source: ObservationSource.Manual,
      summary: "Revive session through new activity",
      body: "Any new linked observation should make the session active again.",
      createdAtMs: 300,
    });

    assert.deepEqual(getSessionById(db, "session-a"), {
      sessionId: "session-a",
      repoRoot,
      startedAtMs: 100,
      lastActivityAtMs: 300,
      status: SessionStatus.Active,
    });
  });
});

test("searchMemory stays deterministic and penalizes stale observations without removing them", async () => {
  await withObservationFixture(async ({ repoRoot, db }) => {
    await indexProject({ repoRoot, db });
    const initialRunId = getLatestIndexRun(db)?.id;
    const readUser = listSymbolsForFile(db, "src/service.ts").find((symbol) => symbol.localName === "readUser");

    assert.notEqual(initialRunId, undefined);
    assert.notEqual(readUser, undefined);

    persistObservation(db, {
      repoRoot,
      kind: ObservationKind.Warning,
      source: ObservationSource.Manual,
      summary: "Session loader workflow note",
      body: "The current session loader path is brittle under refactors.",
      sourceRunId: initialRunId,
      createdAtMs: 100,
      linkedFilePaths: ["src/service.ts"],
      linkedSymbolIds: [readUser!.id],
    });
    persistObservation(db, {
      repoRoot,
      kind: ObservationKind.Insight,
      source: ObservationSource.Manual,
      summary: "Session loader workflow note",
      body: "The shared session model contract should remain stable.",
      sourceRunId: initialRunId,
      createdAtMs: 200,
      linkedFilePaths: ["src/models.ts"],
    });

    await rewriteServiceFile(repoRoot, "loadUser");
    await indexProject({ repoRoot, db });

    const first = searchMemory(db, { query: "session loader workflow", maxResults: 4 });
    const second = searchMemory(db, { query: "session loader workflow", maxResults: 4 });

    assert.deepEqual(second, first);
    assert.equal(first.length, 2);
    assert.equal(first[0]!.staleness.status, StaleStateStatus.Fresh);
    assert.equal(first[1]!.staleness.status, StaleStateStatus.Stale);
    assert.equal(first[1]!.signals.some((signal) => signal.kind === "stale_penalty"), true);
  });
});

test("observation staleness reasons are derived conservatively from file and symbol diffs", async () => {
  await withObservationFixture(async ({ repoRoot, db }) => {
    await indexProject({ repoRoot, db });
    const initialRunId = getLatestIndexRun(db)?.id;
    const readUser = listSymbolsForFile(db, "src/service.ts").find((symbol) => symbol.localName === "readUser");

    assert.notEqual(initialRunId, undefined);
    assert.notEqual(readUser, undefined);

    const observation = persistObservation(db, {
      repoRoot,
      kind: ObservationKind.Insight,
      source: ObservationSource.Manual,
      summary: "Session service refactor risk",
      body: "Renaming the main loader will invalidate dependent notes.",
      sourceRunId: initialRunId,
      createdAtMs: 100,
      linkedFilePaths: ["src/service.ts"],
      linkedSymbolIds: [readUser!.id],
    });

    await rewriteServiceFile(repoRoot, "loadUser");
    await indexProject({ repoRoot, db });

    const comparisonRunId = getLatestIndexRun(db)?.id;
    const fileDiffs = comparisonRunId === undefined ? [] : listFileDiffsForRun(db, comparisonRunId) ?? [];
    const symbolDiffs = comparisonRunId === undefined ? [] : listSymbolDiffsForRun(db, comparisonRunId) ?? [];
    const staleness = getObservationStaleness(db, observation);
    const fileDiff = fileDiffs.find((diff) => diff.filePath === "src/service.ts");
    const symbolDiff = symbolDiffs.find((diff) =>
      diff.filePath === readUser!.filePath
      && diff.fqName === readUser!.fqName
      && diff.symbolKind === readUser!.kind
    );

    assert.equal(staleness.status, StaleStateStatus.Stale);
    assert.equal(fileDiff?.changeType, FileChangeType.Modified);
    assert.equal(symbolDiff?.changeType, FileChangeType.Removed);
    assert.deepEqual(
      staleness.reasons,
      [
        {
          kind: ObservationStaleReasonKind.SymbolRemoved,
          detectedInRunId: comparisonRunId!,
          symbol: {
            filePath: readUser!.filePath,
            fqName: readUser!.fqName,
            kind: readUser!.kind,
          },
        },
        {
          kind: ObservationStaleReasonKind.FileModified,
          detectedInRunId: comparisonRunId!,
          filePath: "src/service.ts",
        },
      ],
    );
  });
});

test("session inspection listing stays compact, bounded, and newest-first", async () => {
  await withObservationFixture(async ({ repoRoot, db }) => {
    for (let index = 0; index < 12; index += 1) {
      persistObservation(db, {
        repoRoot,
        sessionId: `session-${index}`,
        kind: ObservationKind.Decision,
        source: ObservationSource.Manual,
        summary: `Session ${index} note`,
        body: `Observation body ${index}`,
        createdAtMs: 100 + index,
      });
    }

    const first = listInspectableSessions(db);
    const second = listInspectableSessions(db);

    assert.deepEqual(second, first);
    assert.equal(first.length, 10);
    assert.deepEqual(
      first.map((session) => session.sessionId),
      [
        "session-11",
        "session-10",
        "session-9",
        "session-8",
        "session-7",
        "session-6",
        "session-5",
        "session-4",
        "session-3",
        "session-2",
      ],
    );
    assert.deepEqual(first[0], {
      sessionId: "session-11",
      status: SessionStatus.Active,
      startedAtMs: 111,
      lastActivityAtMs: 111,
      observationCount: 1,
    });
  });
});

test("getSessionContext returns recent observations, deterministic session summaries, and optional ranked session-local context", async () => {
  await withObservationFixture(async ({ repoRoot, db }) => {
    await indexProject({ repoRoot, db });
    const sourceRunId = getLatestIndexRun(db)?.id;
    const readUser = listSymbolsForFile(db, "src/service.ts").find((symbol) => symbol.localName === "readUser");

    persistObservation(db, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Use adapter entrypoint",
      body: "The adapter owns session orchestration.",
      queryText: "adapter entrypoint session",
      sourceRunId,
      createdAtMs: 100,
      linkedFilePaths: ["src/service.ts"],
      linkedSymbolIds: readUser === undefined ? [] : [readUser.id],
    });
    persistObservation(db, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Warning,
      source: ObservationSource.Manual,
      summary: "Parser warning for session import",
      body: "The parser path remains a known sharp edge.",
      queryText: "parser warning session",
      sourceRunId,
      createdAtMs: 300,
      linkedFilePaths: ["src/service.ts"],
      linkedSymbolIds: readUser === undefined ? [] : [readUser.id],
    });
    persistObservation(db, {
      repoRoot,
      sessionId: "session-b",
      kind: ObservationKind.DeadEnd,
      source: ObservationSource.Manual,
      summary: "Unrelated dead end",
      body: "Not relevant to session-a context.",
      sourceRunId,
      createdAtMs: 200,
    });

    const recent = getSessionContext(db, {
      sessionId: "session-a",
      limit: 2,
    });
    const ranked = getSessionContext(db, {
      sessionId: "session-a",
      limit: 1,
      query: "parser warning",
    });

    assert.deepEqual(
      recent.observations.map((observation) => [observation.sessionId, observation.summary]),
      [
        ["session-a", "Parser warning for session import"],
        ["session-a", "Use adapter entrypoint"],
      ],
    );
    assert.deepEqual(recent.session, {
      sessionId: "session-a",
      repoRoot,
      startedAtMs: 100,
      lastActivityAtMs: 300,
      status: SessionStatus.Active,
    });
    assert.deepEqual(recent.summary, {
      observationCount: 2,
      lastObservationAtMs: 300,
      freshObservationCount: 2,
      staleObservationCount: 0,
      kindCounts: {
        decision: 1,
        insight: 0,
        warning: 1,
        deadEnd: 0,
        toolCall: 0,
      },
      recentFilePaths: ["src/service.ts"],
      recentSymbolIds: readUser === undefined ? [] : [readUser.id],
      recentFqNames: readUser === undefined ? [] : [readUser.fqName],
      repeatedQueryTerms: [{ term: "session", count: 2 }],
    });
    assert.deepEqual(
      ranked.observations.map((observation) => observation.summary),
      [
        "Parser warning for session import",
      ],
    );
    assert.deepEqual(
      ranked.rankedObservations?.map((observation) => observation.summary),
      ["Parser warning for session import"],
    );
  });
});

test("readInspectableSession returns explicit session state, derived summary, and a tiny preview", async () => {
  await withObservationFixture(async ({ repoRoot, db }) => {
    persistObservation(db, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Oldest session note",
      body: "Oldest body",
      queryText: "adapter session flow",
      createdAtMs: 100,
      linkedFilePaths: ["src/service.ts"],
    });
    persistObservation(db, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Warning,
      source: ObservationSource.Manual,
      summary: "Middle session note",
      body: "Middle body",
      queryText: "adapter session warning",
      createdAtMs: 200,
      linkedFilePaths: ["src/models.ts"],
    });
    persistObservation(db, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Insight,
      source: ObservationSource.Manual,
      summary: "Newer session note",
      body: "Newer body",
      queryText: "adapter session flow",
      createdAtMs: 300,
      linkedFilePaths: ["src/session.ts"],
    });
    persistObservation(db, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.ToolCall,
      source: ObservationSource.McpAuto,
      summary: "Newest session note",
      body: "Newest body",
      queryText: "adapter session flow",
      createdAtMs: 400,
      linkedFilePaths: ["src/service.ts"],
    });

    const read = readInspectableSession(db, "session-a");

    assert.notEqual(read, undefined);
    assert.deepEqual(read!.session, {
      sessionId: "session-a",
      repoRoot,
      startedAtMs: 100,
      lastActivityAtMs: 400,
      status: SessionStatus.Active,
    });
    assert.deepEqual(read!.summary, {
      observationCount: 4,
      lastObservationAtMs: 400,
      freshObservationCount: 4,
      staleObservationCount: 0,
      kindCounts: {
        decision: 1,
        insight: 1,
        warning: 1,
        deadEnd: 0,
        toolCall: 1,
      },
      recentFilePaths: ["src/service.ts", "src/session.ts", "src/models.ts"],
      recentSymbolIds: [],
      recentFqNames: [],
      repeatedQueryTerms: [
        { term: "adapter", count: 4 },
        { term: "flow", count: 3 },
        { term: "session", count: 4 },
      ].sort((left, right) => right.count - left.count || left.term.localeCompare(right.term)),
    });
    assert.deepEqual(read!.recentObservations, [
      {
        observationId: read!.recentObservations[0]!.observationId,
        kind: ObservationKind.ToolCall,
        summary: "Newest session note",
        createdAtMs: 400,
      },
      {
        observationId: read!.recentObservations[1]!.observationId,
        kind: ObservationKind.Insight,
        summary: "Newer session note",
        createdAtMs: 300,
      },
      {
        observationId: read!.recentObservations[2]!.observationId,
        kind: ObservationKind.Warning,
        summary: "Middle session note",
        createdAtMs: 200,
      },
    ]);
    assert.equal(read!.recentObservations.length, 3);
    assert.equal(readInspectableSession(db, "missing-session"), undefined);
  });
});

test("best-effort visible-capsule auto-capture never fails the primary path", () => {
  const db = openIndexerDatabase();
  const routedQuery = routeQuery(db, "session loader");
  const capsule = {
    query: "session loader",
    pivots: [],
    supportingItems: [],
    budget: {
      model: CapsuleBudgetModel.CharacterCount,
      maxCharacters: 200,
      usedCharacters: 0,
      remainingCharacters: 200,
    },
    truncated: false,
    compressed: false,
  } satisfies Capsule;

  db.close();

  assert.doesNotThrow(() => {
    const captured = captureVisibleCapsuleObservationBestEffort({
      db,
      repoRoot: "/tmp/repo",
      sourceRunId: null,
      routedQuery,
      capsuleProfileId: "explain_default",
      capsule,
      toolName: "get_context_capsule",
    });

    assert.equal(captured, undefined);
  });
});

async function withObservationFixture(
  run: (input: { repoRoot: string; db: ReturnType<typeof openIndexerDatabase> }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vexb-observations-"));
  const repoRoot = path.join(root, "repo");
  const db = openIndexerDatabase();

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeModelFile(repoRoot);
    await writeServiceFile(repoRoot, "readUser");
    await run({ repoRoot, db });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function writeModelFile(repoRoot: string): Promise<void> {
  await writeFile(
    path.join(repoRoot, "src", "models.ts"),
    [
      "export interface User {",
      "  id: string;",
      "}",
      "",
    ].join("\n"),
  );
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

async function rewriteServiceFile(repoRoot: string, functionName: string): Promise<void> {
  await writeServiceFile(repoRoot, functionName);
}
