import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  countObservations,
  getObservationById,
  listObservations,
  listObservationsForSession,
  persistObservation,
} from "../session/repositories/observationsRepository";
import {
  countSessions,
  getSessionById,
  listSessionCleanupCandidates,
  upsertSession,
} from "../session/repositories/sessionsRepository";
import {
  getLatestIndexRun,
  listFileDiffsForRun,
  listSymbolDiffsForRun,
} from "../db/repositories/indexRunsRepository";
import { listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { createTestProductStores } from "../testing/productStores";
import { indexProject } from "../indexer/indexProject";
import { routeQuery } from "../intent/routeQuery";
import { FileChangeType, StaleStateStatus } from "../memory/types";
import { CapsuleBudgetModel, type Capsule } from "../capsule/types";
import { captureVisibleCapsuleObservationBestEffort } from "./autoCapture";
import {
  PASSIVE_CONSOLIDATION_TOOL_NAME,
  buildPassiveConsolidationGroups,
  computePassiveObservationSignature,
  consolidatePassiveObservationsForSession,
} from "./consolidation";
import { getSessionContext } from "./getSessionContext";
import {
  DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS,
  DEFAULT_SESSION_RETENTION_AFTER_MS,
  compressInactiveSessions,
  getSessionCompressionEligibility,
} from "./sessionLifecycle";
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
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    await indexProject({ repoRoot, db });
    const readUser = listSymbolsForFile(db, "src/service.ts").find((symbol) => symbol.localName === "readUser");

    assert.notEqual(readUser, undefined);

    const observation = persistObservation(stores, {
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

    assert.deepEqual(getObservationById(stores.session, observation.id), observation);
    assert.equal(observation.kind, ObservationKind.Decision);
    assert.equal(observation.linkedFilePaths[0], "src/service.ts");
    assert.deepEqual(
      observation.linkedSymbols.map((link) => [link.symbolId, link.fqName, link.symbolKind]),
      [[readUser!.id, readUser!.fqName, readUser!.kind]],
    );
    assert.deepEqual(observation.linkedFqNames, ["src/service.ts::readUser"]);
    assert.equal(countObservations(stores.session), 1);
    assert.equal(countSessions(stores.session), 1);
    assert.deepEqual(getSessionById(stores.session, "session-a"), {
      sessionId: "session-a",
      repoRoot,
      startedAtMs: 100,
      lastActivityAtMs: 100,
      status: SessionStatus.Active,
    });
    assert.deepEqual(listObservations(stores.session), [observation]);
  });
});

test("observation identity is content-stable and createdAtMs remains metadata only", async () => {
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    await indexProject({ repoRoot, db });

    const first = persistObservation(stores, {
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
    const second = persistObservation(stores, {
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
    assert.equal(countObservations(stores.session), 1);
  });
});

test("session-linked observations update explicit session activity without changing observation truth", async () => {
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    const first = persistObservation(stores, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Use adapter entrypoint",
      body: "The adapter owns session orchestration.",
      createdAtMs: 100,
    });
    const second = persistObservation(stores, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Use adapter entrypoint",
      body: "The adapter owns session orchestration.",
      createdAtMs: 300,
    });

    assert.equal(first.id, second.id);
    assert.equal(countObservations(stores.session), 1);
    assert.deepEqual(getSessionById(stores.session, "session-a"), {
      sessionId: "session-a",
      repoRoot,
      startedAtMs: 100,
      lastActivityAtMs: 300,
      status: SessionStatus.Active,
    });
  });
});

test("session linkage integrity rejects repo-root mismatches for persisted sessions", async () => {
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    persistObservation(stores, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Use adapter entrypoint",
      body: "The adapter owns session orchestration.",
      createdAtMs: 100,
    });

    assert.throws(() => {
      persistObservation(stores, {
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
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    upsertSession(stores.session, {
      sessionId: "session-a",
      repoRoot,
      activityAtMs: 100,
      status: SessionStatus.Inactive,
    });

    persistObservation(stores, {
      repoRoot,
      sessionId: "session-a",
      kind: ObservationKind.Warning,
      source: ObservationSource.Manual,
      summary: "Revive session through new activity",
      body: "Any new linked observation should make the session active again.",
      createdAtMs: 300,
    });

    assert.deepEqual(getSessionById(stores.session, "session-a"), {
      sessionId: "session-a",
      repoRoot,
      startedAtMs: 100,
      lastActivityAtMs: 300,
      status: SessionStatus.Active,
    });
  });
});

test("searchMemory stays deterministic and penalizes stale observations without removing them", async () => {
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    await indexProject({ repoRoot, db });
    const initialRunId = getLatestIndexRun(db)?.id;
    const readUser = listSymbolsForFile(db, "src/service.ts").find((symbol) => symbol.localName === "readUser");

    assert.notEqual(initialRunId, undefined);
    assert.notEqual(readUser, undefined);

    persistObservation(stores, {
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
    persistObservation(stores, {
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

    const first = searchMemory(stores, { query: "session loader workflow", maxResults: 4 });
    const second = searchMemory(stores, { query: "session loader workflow", maxResults: 4 });

    assert.deepEqual(second, first);
    assert.equal(first.length, 2);
    assert.equal(first[0]!.staleness.status, StaleStateStatus.Fresh);
    assert.equal(first[1]!.staleness.status, StaleStateStatus.Stale);
    assert.equal(first[1]!.signals.some((signal) => signal.kind === "stale_penalty"), true);
  });
});

test("observation staleness reasons are derived conservatively from file and symbol diffs", async () => {
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    await indexProject({ repoRoot, db });
    const initialRunId = getLatestIndexRun(db)?.id;
    const readUser = listSymbolsForFile(db, "src/service.ts").find((symbol) => symbol.localName === "readUser");

    assert.notEqual(initialRunId, undefined);
    assert.notEqual(readUser, undefined);

    const observation = persistObservation(stores, {
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
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    for (let index = 0; index < 12; index += 1) {
      persistObservation(stores, {
        repoRoot,
        sessionId: `session-${index}`,
        kind: ObservationKind.Decision,
        source: ObservationSource.Manual,
        summary: `Session ${index} note`,
        body: `Observation body ${index}`,
        createdAtMs: 100 + index,
      });
    }

    const first = listInspectableSessions(stores.session);
    const second = listInspectableSessions(stores.session);

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
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    await indexProject({ repoRoot, db });
    const sourceRunId = getLatestIndexRun(db)?.id;
    const readUser = listSymbolsForFile(db, "src/service.ts").find((symbol) => symbol.localName === "readUser");

    persistObservation(stores, {
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
    persistObservation(stores, {
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
    persistObservation(stores, {
      repoRoot,
      sessionId: "session-b",
      kind: ObservationKind.DeadEnd,
      source: ObservationSource.Manual,
      summary: "Unrelated dead end",
      body: "Not relevant to session-a context.",
      sourceRunId,
      createdAtMs: 200,
    });

    const recent = getSessionContext(stores, {
      sessionId: "session-a",
      limit: 2,
    });
    const ranked = getSessionContext(stores, {
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
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    persistObservation(stores, {
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
    persistObservation(stores, {
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
    persistObservation(stores, {
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
    persistObservation(stores, {
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

    const read = readInspectableSession(stores, "session-a");

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
    assert.equal(readInspectableSession(stores, "missing-session"), undefined);
  });
});

test("passive consolidation groups repeated auto tool calls and leaves below-threshold calls alone", async () => {
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    await indexProject({ repoRoot, db });
    const sourceRunId = getLatestIndexRun(db)?.id;
    const readUser = listSymbolsForFile(db, "src/service.ts").find((symbol) => symbol.localName === "readUser");

    assert.notEqual(readUser, undefined);

    const repeated = [100, 120, 140].map((createdAtMs, index) => {
      return persistObservation(stores, {
        repoRoot,
        sessionId: "session-consolidate",
        kind: ObservationKind.ToolCall,
        source: ObservationSource.McpAuto,
        toolName: "run_pipeline",
        summary: `Built context capsule for reader workflow ${index}`,
        body: [
          "tool=run_pipeline",
          "query=explain read user workflow",
          "intent=explain",
          "pivot_count=1",
          "support_count=2",
          `observation_ordinal=${index}`,
        ].join("\n"),
        queryText: "Explain   read user workflow",
        intent: "explain",
        sourceRunId,
        createdAtMs,
        linkedFilePaths: ["./src/service.ts"],
        linkedSymbolIds: [readUser!.id],
      });
    });
    const belowThreshold = persistObservation(stores, {
      repoRoot,
      sessionId: "session-consolidate",
      kind: ObservationKind.ToolCall,
      source: ObservationSource.McpAuto,
      toolName: "get_impact_graph",
      summary: "Computed impact graph for reader workflow",
      body: "tool=get_impact_graph\nsymbol_fqn=src/service.ts::readUser\ndepth=2",
      queryText: "src/service.ts::readUser",
      intent: "refactor",
      sourceRunId,
      createdAtMs: 160,
      linkedFilePaths: ["src/service.ts"],
      linkedSymbolIds: [readUser!.id],
    });

    assert.equal(computePassiveObservationSignature(repeated[0]!), computePassiveObservationSignature(repeated[1]!));
    assert.deepEqual(
      buildPassiveConsolidationGroups([...repeated, belowThreshold]).map((group) => group.sourceObservationCount),
      [3],
    );

    const first = consolidatePassiveObservationsForSession(stores, {
      sessionId: "session-consolidate",
      nowMs: 500,
    });
    const second = consolidatePassiveObservationsForSession(stores, {
      sessionId: "session-consolidate",
      nowMs: 700,
    });

    assert.notEqual(first, undefined);
    assert.notEqual(second, undefined);
    assert.equal(first!.prunedSourceObservationCount, 3);
    assert.equal(second!.prunedSourceObservationCount, 0);
    assert.deepEqual(second!.consolidatedObservationIds, []);

    const remaining = listObservations(stores.session).filter((observation) => observation.sessionId === "session-consolidate");
    const consolidated = remaining.find((observation) => observation.toolName === PASSIVE_CONSOLIDATION_TOOL_NAME);

    assert.notEqual(consolidated, undefined);
    assert.equal(consolidated!.kind, ObservationKind.Insight);
    assert.equal(consolidated!.source, ObservationSource.McpAuto);
    assert.equal(consolidated!.summary, "Consolidated 3 repeated run_pipeline tool calls around Explain   read user workflow.");
    assert.match(consolidated!.body, /consolidated=true/);
    assert.match(consolidated!.body, /source_kind=tool_call/);
    assert.match(consolidated!.body, /source_observation_count=3/);
    assert.match(consolidated!.body, /tools=\{"run_pipeline":3\}/);
    assert.match(consolidated!.body, /first_observed_at=1970-01-01T00:00:00.100Z/);
    assert.match(consolidated!.body, /last_observed_at=1970-01-01T00:00:00.140Z/);
    assert.match(consolidated!.body, /signature=tool_call:run_pipeline:/);
    assert.match(consolidated!.body, /session_id=session-consolidate/);
    assert.match(consolidated!.body, /semantic_similarity=false/);
    assert.deepEqual(consolidated!.linkedFilePaths, ["src/service.ts"]);
    assert.deepEqual(consolidated!.linkedSymbols.map((link) => link.symbolId), [readUser!.id]);
    assert.deepEqual(consolidated!.linkedFqNames, [readUser!.fqName]);
    assert.equal(consolidated!.sourceRunId, sourceRunId);
    assert.equal(remaining.some((observation) => repeated.some((source) => source.id === observation.id)), false);
    assert.equal(remaining.some((observation) => observation.id === belowThreshold.id), true);

    assert.equal(searchMemory(stores, { query: "run_pipeline", maxResults: 5 })[0]?.observation.id, consolidated!.id);
    assert.equal(searchMemory(stores, { query: "read user workflow", maxResults: 5 })[0]?.observation.id, consolidated!.id);
    assert.equal(searchMemory(stores, { query: "src/service.ts", maxResults: 5 })[0]?.observation.id, consolidated!.id);
    assert.equal(searchMemory(stores, { query: readUser!.fqName, maxResults: 5 })[0]?.observation.id, consolidated!.id);
  });
});

test("passive consolidation never prunes durable manual or anti-pattern observations", async () => {
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    const durableInputs = [
      {
        kind: ObservationKind.Decision,
        source: ObservationSource.Manual,
        summary: "Manual decision stays separate",
      },
      {
        kind: ObservationKind.Insight,
        source: ObservationSource.Manual,
        summary: "Manual insight stays separate",
      },
      {
        kind: ObservationKind.DeadEnd,
        source: ObservationSource.Manual,
        summary: "Manual dead end stays separate",
      },
      {
        kind: ObservationKind.DeadEnd,
        source: ObservationSource.McpAuto,
        summary: "Detected file_thrashing anti-pattern stays separate",
      },
    ] as const;

    for (const [index, input] of durableInputs.entries()) {
      persistObservation(stores, {
        repoRoot,
        sessionId: "session-durable",
        kind: input.kind,
        source: input.source,
        toolName: input.source === ObservationSource.Manual ? "save_observation" : "detect_anti_patterns",
        summary: input.summary,
        body: `durable observation ${index}`,
        queryText: "durable passive consolidation",
        createdAtMs: 100 + index,
        linkedFilePaths: ["src/service.ts"],
      });
    }

    const result = consolidatePassiveObservationsForSession(stores, {
      sessionId: "session-durable",
      nowMs: 500,
    });

    assert.notEqual(result, undefined);
    assert.deepEqual(result!.groups, []);
    assert.equal(result!.prunedSourceObservationCount, 0);
    assert.deepEqual(
      listObservations(stores.session)
        .filter((observation) => observation.sessionId === "session-durable")
        .map((observation) => observation.summary)
        .sort(),
      durableInputs.map((input) => input.summary).sort(),
    );
  });
});

test("consolidated observations remain session-visible, memory-visible, and stale-aware", async () => {
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    await indexProject({ repoRoot, db });
    const sourceRunId = getLatestIndexRun(db)?.id;
    const readUser = listSymbolsForFile(db, "src/service.ts").find((symbol) => symbol.localName === "readUser");

    assert.notEqual(readUser, undefined);

    for (const [index, createdAtMs] of [100, 120, 140].entries()) {
      persistObservation(stores, {
        repoRoot,
        sessionId: "session-stale-consolidated",
        kind: ObservationKind.ToolCall,
        source: ObservationSource.McpAuto,
        toolName: "get_impact_graph",
        summary: `Computed repeated impact graph ${index}`,
        body: `tool=get_impact_graph\nsymbol_fqn=${readUser!.fqName}\ndepth=2\ncall=${index}`,
        queryText: readUser!.fqName,
        intent: "refactor",
        sourceRunId,
        createdAtMs,
        linkedFilePaths: ["src/service.ts"],
        linkedSymbolIds: [readUser!.id],
      });
    }

    const result = consolidatePassiveObservationsForSession(stores, {
      sessionId: "session-stale-consolidated",
      nowMs: 500,
    });
    const consolidated = result?.consolidatedObservationIds[0] === undefined
      ? undefined
      : getObservationById(stores.session, result.consolidatedObservationIds[0]);

    assert.notEqual(consolidated, undefined);

    const context = getSessionContext(stores, {
      sessionId: "session-stale-consolidated",
      limit: 10,
      query: "get_impact_graph",
    });
    assert.deepEqual(context.observations.map((observation) => observation.id), [consolidated!.id]);
    assert.deepEqual(context.rankedObservations?.map((observation) => observation.id), [consolidated!.id]);

    await rewriteServiceFile(repoRoot, "loadUser");
    await indexProject({ repoRoot, db });

    const staleness = getObservationStaleness(db, consolidated!);
    assert.equal(staleness.status, StaleStateStatus.Stale);
    assert.equal(staleness.reasons.some((reason) => reason.kind === ObservationStaleReasonKind.FileModified), true);
    assert.equal(staleness.reasons.some((reason) => reason.kind === ObservationStaleReasonKind.SymbolRemoved), true);
  });
});

test("inactive sessions compress into stable searchable summaries while preserving durable observations", async () => {
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    await indexProject({ repoRoot, db });
    const sourceRunId = getLatestIndexRun(db)?.id;
    const readUser = listSymbolsForFile(db, "src/service.ts").find((symbol) => symbol.localName === "readUser");

    assert.notEqual(readUser, undefined);

    persistObservation(stores, {
      repoRoot,
      sessionId: "session-compress",
      kind: ObservationKind.ToolCall,
      source: ObservationSource.McpAuto,
      toolName: "run_pipeline",
      summary: "Built context capsule for memory pipeline 0",
      body: "tool=run_pipeline\nquery=pipeline memory impact\npivot_count=1\nsupport_count=2\ncall=0",
      queryText: "pipeline memory impact",
      intent: "explain",
      sourceRunId,
      createdAtMs: 100,
      linkedFilePaths: ["src/service.ts"],
      linkedSymbolIds: [readUser!.id],
    });
    persistObservation(stores, {
      repoRoot,
      sessionId: "session-compress",
      kind: ObservationKind.ToolCall,
      source: ObservationSource.McpAuto,
      toolName: "run_pipeline",
      summary: "Built context capsule for memory pipeline 1",
      body: "tool=run_pipeline\nquery=pipeline memory impact\npivot_count=1\nsupport_count=2\ncall=1",
      queryText: "pipeline memory impact",
      intent: "explain",
      sourceRunId,
      createdAtMs: 120,
      linkedFilePaths: ["src/service.ts"],
      linkedSymbolIds: [readUser!.id],
    });
    persistObservation(stores, {
      repoRoot,
      sessionId: "session-compress",
      kind: ObservationKind.ToolCall,
      source: ObservationSource.McpAuto,
      toolName: "run_pipeline",
      summary: "Built context capsule for memory pipeline 2",
      body: "tool=run_pipeline\nquery=pipeline memory impact\npivot_count=1\nsupport_count=2\ncall=2",
      queryText: "pipeline memory impact",
      intent: "explain",
      sourceRunId,
      createdAtMs: 130,
      linkedFilePaths: ["src/service.ts"],
      linkedSymbolIds: [readUser!.id],
    });
    persistObservation(stores, {
      repoRoot,
      sessionId: "session-compress",
      kind: ObservationKind.ToolCall,
      source: ObservationSource.McpAuto,
      toolName: "get_impact_graph",
      summary: "Computed impact graph for src/service.ts::readUser",
      body: "tool=get_impact_graph\nsymbol_fqn=src/service.ts::readUser",
      queryText: "src/service.ts::readUser",
      intent: "refactor",
      sourceRunId,
      createdAtMs: 150,
      linkedFilePaths: ["src/service.ts"],
      linkedSymbolIds: [readUser!.id],
    });
    persistObservation(stores, {
      repoRoot,
      sessionId: "session-compress",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      toolName: "save_observation",
      summary: "Keep service loader stable",
      body: "Manual decision: readUser remains the service loader boundary.",
      queryText: "service loader decision",
      createdAtMs: 200,
      linkedFilePaths: ["src/service.ts"],
      linkedSymbolIds: [readUser!.id],
    });
    persistObservation(stores, {
      repoRoot,
      sessionId: "session-compress",
      kind: ObservationKind.Insight,
      source: ObservationSource.Manual,
      toolName: "save_observation",
      summary: "Memory compression keeps durable notes",
      body: "Manual insight: durable observations survive lifecycle compression.",
      queryText: "memory compression durable",
      createdAtMs: 300,
      linkedFilePaths: ["src/models.ts"],
    });
    persistObservation(stores, {
      repoRoot,
      sessionId: "session-compress",
      kind: ObservationKind.ToolCall,
      source: ObservationSource.Manual,
      toolName: "save_observation",
      summary: "Manual tool-call shaped note",
      body: "Manual observations are durable even if their kind is tool_call.",
      queryText: "manual durable tool call",
      createdAtMs: 350,
      linkedFilePaths: ["src/service.ts"],
      linkedFqNames: ["src/service.ts::readUser"],
    });
    persistObservation(stores, {
      repoRoot,
      sessionId: "session-recent",
      kind: ObservationKind.ToolCall,
      source: ObservationSource.McpAuto,
      toolName: "get_skeleton",
      summary: "Recent skeleton call",
      body: "tool=get_skeleton",
      queryText: "src/service.ts",
      createdAtMs: 1_000,
      linkedFilePaths: ["src/service.ts"],
    });

    const beforeThreshold = getSessionCompressionEligibility(stores.session, {
      nowMs: 350 + DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS - 1,
    });
    assert.equal(
      beforeThreshold.find((entry) => entry.session.sessionId === "session-compress")?.eligible,
      false,
    );

    const atThreshold = getSessionCompressionEligibility(stores.session, {
      nowMs: 350 + DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS,
    });
    assert.equal(
      atThreshold.find((entry) => entry.session.sessionId === "session-compress")?.eligible,
      true,
    );
    assert.equal(
      atThreshold.find((entry) => entry.session.sessionId === "session-recent")?.eligible,
      false,
    );

    const compressedAtMs = 350 + DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS;
    const firstCompression = compressInactiveSessions(stores, {
      repoRoot,
      nowMs: compressedAtMs,
    });
    const secondCompression = compressInactiveSessions(stores, {
      repoRoot,
      nowMs: compressedAtMs,
    });

    assert.equal(firstCompression.compressedSummaries.length, 1);
    assert.deepEqual(secondCompression.compressedSummaries, []);

    const summary = firstCompression.compressedSummaries[0]!;
    assert.equal(summary.sessionId, "session-compress");
    assert.equal(summary.firstActivityAtMs, 100);
    assert.equal(summary.lastActivityAtMs, 350);
    assert.equal(summary.compressedAtMs, compressedAtMs);
    assert.deepEqual(summary.observationCounts, {
      decision: 1,
      insight: 1,
      tool_call: 5,
    });
    assert.deepEqual(summary.toolCallCounts, {
      get_impact_graph: 1,
      run_pipeline: 3,
    });
    assert.deepEqual(summary.filePaths, ["src/models.ts", "src/service.ts"]);
    assert.deepEqual(summary.symbolIds, [readUser!.id]);
    assert.deepEqual(summary.fqNames, ["src/service.ts::readUser"]);
    assert.equal(summary.keyTerms.includes("memory"), true);
    assert.equal(summary.preservedDurableObservationCount, 3);
    assert.equal(summary.prunedToolCallObservationCount, 3);

    const compressedSession = getSessionById(stores.session, "session-compress");
    assert.equal(compressedSession?.status, SessionStatus.Compressed);
    assert.equal(compressedSession?.compressedAtMs, compressedAtMs);
    assert.equal(compressedSession?.summaryId, summary.id);
    assert.equal(compressedSession?.lastActivityAtMs, 350);

    const remaining = listObservations(stores.session).filter((observation) => observation.sessionId === "session-compress");
    assert.equal(
      remaining.some((observation) =>
        observation.source === ObservationSource.McpAuto
        && observation.kind === ObservationKind.ToolCall
        && observation.toolName === "run_pipeline"
      ),
      false,
    );
    assert.equal(
      remaining.some((observation) =>
        observation.source === ObservationSource.McpAuto
        && observation.kind === ObservationKind.ToolCall
        && observation.toolName === "get_impact_graph"
      ),
      true,
    );
    assert.equal(
      remaining.some((observation) => observation.summary === "Keep service loader stable"),
      true,
    );
    assert.equal(
      remaining.some((observation) => observation.summary === "Manual tool-call shaped note"),
      true,
    );
    assert.equal(
      remaining.some((observation) => observation.id === summary.summaryObservationId),
      true,
    );

    const context = getSessionContext(stores, {
      sessionId: "session-compress",
      query: "impact memory",
      limit: 10,
    });
    assert.equal(context.session?.status, SessionStatus.Compressed);
    assert.deepEqual(context.compressedSummary, summary);
    assert.equal(
      context.observations.some((observation) =>
        observation.source === ObservationSource.McpAuto
        && observation.kind === ObservationKind.ToolCall
        && observation.toolName === "run_pipeline"
      ),
      false,
    );
    assert.equal(
      context.observations.some((observation) => observation.summary === "Memory compression keeps durable notes"),
      true,
    );

    const consolidated = remaining.find((observation) => observation.toolName === PASSIVE_CONSOLIDATION_TOOL_NAME);
    assert.notEqual(consolidated, undefined);
    assert.match(consolidated!.body, /source_observation_count=3/);
    assert.equal(searchMemory(stores, { query: "run_pipeline", maxResults: 3 })[0]?.observation.id, consolidated!.id);
    assert.equal(
      searchMemory(stores, { query: "get_impact_graph", maxResults: 3 }).some((result) => {
        return result.observation.id === summary.summaryObservationId
          || result.observation.toolName === "get_impact_graph";
      }),
      true,
    );
    assert.equal(
      searchMemory(stores, { query: "src/service.ts", maxResults: 3 }).some((result) => {
        return result.observation.id === summary.summaryObservationId
          || result.observation.id === consolidated!.id;
      }),
      true,
    );
    assert.equal(
      searchMemory(stores, { query: "memory", maxResults: 3 }).some((result) => {
        return result.observation.id === summary.summaryObservationId;
      }),
      true,
    );
    assert.equal(
      searchMemory(stores, { query: "src/service.ts::readUser", maxResults: 3 }).some((result) => {
        return result.observation.id === summary.summaryObservationId
          || result.observation.id === consolidated!.id
          || result.observation.toolName === "get_impact_graph";
      }),
      true,
    );

    const summaryObservation = getObservationById(stores.session, summary.summaryObservationId);
    assert.notEqual(summaryObservation, undefined);
    await rewriteServiceFile(repoRoot, "loadUser");
    await indexProject({ repoRoot, db });
    const summaryStaleness = getObservationStaleness(db, summaryObservation!);

    assert.equal(summaryStaleness.status, StaleStateStatus.Stale);
    assert.equal(
      summaryStaleness.reasons.some((reason) => reason.kind === ObservationStaleReasonKind.FileModified),
      true,
    );

    const beforeRetention = listSessionCleanupCandidates(stores.session, {
      nowMs: compressedAtMs + DEFAULT_SESSION_RETENTION_AFTER_MS - 1,
      retentionAfterMs: DEFAULT_SESSION_RETENTION_AFTER_MS,
    });
    const afterRetention = listSessionCleanupCandidates(stores.session, {
      nowMs: compressedAtMs + DEFAULT_SESSION_RETENTION_AFTER_MS,
      retentionAfterMs: DEFAULT_SESSION_RETENTION_AFTER_MS,
    });
    assert.equal(beforeRetention[0]?.eligibleForDeletion, false);
    assert.equal(afterRetention[0]?.eligibleForDeletion, true);
    assert.deepEqual(afterRetention[0]?.compressedSummary, summary);
  });
});

test("best-effort visible-capsule auto-capture never fails the primary path", () => {
  const db = openIndexerDatabase();
  const stores = createTestProductStores(db);
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

  // M152: the store that has to break for this to mean anything is the SESSION
  // store — auto-capture writes there now. Closing the index handle alone would
  // leave the write perfectly able to succeed and the test passing vacuously.
  stores.close();
  db.close();

  assert.doesNotThrow(() => {
    const captured = captureVisibleCapsuleObservationBestEffort({
      stores,
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

test("compressInactiveSessions honors a bounded limit with deterministic session selection", async () => {
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    await indexProject({ repoRoot, db });
    const sourceRunId = getLatestIndexRun(db)?.id;

    for (const [sessionId, createdAtMs] of [
      ["session-a", 100],
      ["session-b", 200],
      ["session-c", 300],
    ] as const) {
      persistObservation(stores, {
        repoRoot,
        sessionId,
        kind: ObservationKind.ToolCall,
        source: ObservationSource.McpAuto,
        toolName: "run_pipeline",
        summary: `Context capsule for ${sessionId}`,
        body: `tool=run_pipeline\nquery=session lifecycle\npivot_count=1\nsupport_count=1\ncall=${sessionId}`,
        queryText: "session lifecycle",
        intent: "explain",
        sourceRunId,
        createdAtMs,
        linkedFilePaths: ["src/service.ts"],
      });
    }

    const nowMs = 300 + DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS;

    const first = compressInactiveSessions(stores, { repoRoot, nowMs, limit: 2 });
    const firstAgainPreviewOnly = compressInactiveSessions(stores, {
      repoRoot,
      nowMs,
      limit: 2,
      dryRun: true,
    });

    // The bound is respected and selection is the two most-inactive sessions.
    assert.equal(first.eligibleSessionCount, 3);
    assert.equal(first.processedSessionCount, 2);
    assert.deepEqual(
      first.compressedSummaries.map((summary) => summary.sessionId),
      ["session-a", "session-b"],
    );
    // Selection is deterministic: a repeated bounded view picks the remaining
    // most-inactive session (only session-c is still active now).
    assert.deepEqual(
      firstAgainPreviewOnly.previews.map((preview) => preview.sessionId),
      ["session-c"],
    );
    assert.equal(getSessionById(stores.session, "session-c")?.status, SessionStatus.Active);

    // A second bounded sweep finishes the remainder.
    const second = compressInactiveSessions(stores, { repoRoot, nowMs, limit: 2 });
    assert.equal(second.eligibleSessionCount, 1);
    assert.equal(second.processedSessionCount, 1);
    assert.deepEqual(
      second.compressedSummaries.map((summary) => summary.sessionId),
      ["session-c"],
    );
    assert.equal(getSessionById(stores.session, "session-c")?.status, SessionStatus.Compressed);
  });
});

test("compressInactiveSessions dry run previews the effect without mutating observations or sessions", async () => {
  await withObservationFixture(async ({ repoRoot, db, stores }) => {
    await indexProject({ repoRoot, db });
    const sourceRunId = getLatestIndexRun(db)?.id;

    for (const [index, createdAtMs] of [100, 120, 140].entries()) {
      persistObservation(stores, {
        repoRoot,
        sessionId: "session-dry",
        kind: ObservationKind.ToolCall,
        source: ObservationSource.McpAuto,
        toolName: "run_pipeline",
        summary: `Repeated capsule ${index}`,
        body: `tool=run_pipeline\nquery=dry run preview\npivot_count=1\nsupport_count=2\ncall=${index}`,
        queryText: "dry run preview",
        intent: "explain",
        sourceRunId,
        createdAtMs,
        linkedFilePaths: ["src/service.ts"],
      });
    }
    persistObservation(stores, {
      repoRoot,
      sessionId: "session-dry",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      toolName: "save_observation",
      summary: "Durable decision must survive a real compression",
      body: "Manual decision retained across lifecycle compression.",
      queryText: "durable decision",
      createdAtMs: 160,
      linkedFilePaths: ["src/service.ts"],
    });

    const observationsBefore = listObservationsForSession(stores.session, "session-dry").length;
    assert.equal(observationsBefore, 4);

    const nowMs = 160 + DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS;
    const preview = compressInactiveSessions(stores, { repoRoot, nowMs, dryRun: true });

    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.compressedSummaries, []);
    assert.equal(preview.eligibleSessionCount, 1);
    assert.equal(preview.processedSessionCount, 1);
    assert.equal(preview.previews.length, 1);
    assert.equal(preview.previews[0]!.sessionId, "session-dry");
    assert.equal(preview.previews[0]!.observationCount, 4);
    assert.equal(preview.previews[0]!.prunedToolCallObservationCount, 3);

    // Dry run mutates nothing.
    assert.equal(listObservationsForSession(stores.session, "session-dry").length, observationsBefore);
    assert.equal(getSessionById(stores.session, "session-dry")?.status, SessionStatus.Active);

    // A real run then performs exactly what the preview promised.
    const applied = compressInactiveSessions(stores, { repoRoot, nowMs });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.compressedSummaries.length, 1);
    assert.equal(applied.compressedSummaries[0]!.prunedToolCallObservationCount, 3);
    assert.equal(getSessionById(stores.session, "session-dry")?.status, SessionStatus.Compressed);
  });
});

async function withObservationFixture(
  run: (input: {
    repoRoot: string;
    db: ReturnType<typeof openIndexerDatabase>;
    stores: ReturnType<typeof createTestProductStores>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-observations-"));
  const repoRoot = path.join(root, "repo");
  const db = openIndexerDatabase();
  const stores = createTestProductStores(db);

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeModelFile(repoRoot);
    await writeServiceFile(repoRoot, "readUser");
    await run({ repoRoot, db, stores });
  } finally {
    stores.close();
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
