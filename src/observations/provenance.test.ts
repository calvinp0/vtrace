import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { test } from "bun:test";

import { persistObservation, listObservations } from "../session/repositories/observationsRepository";
import { initializeSchema } from "../db/schema";
import { openIndexerDatabase } from "../db/sqlite";
import { createTestProductStores, createTestSessionDatabase } from "../testing/productStores";
import { ProductStoreLease } from "../session/sessionStore";
import {
  LegacyMigrationOutcome,
  migrateLegacySessionState,
} from "../session/legacyMigration";
import { initRepo } from "../setup/initRepo";
import { runPipelineOrchestrator } from "../runPipeline/runPipelineOrchestrator";
import { classifyObservationCompatibility } from "./compatibility";
import { getSessionContext } from "./getSessionContext";
import { buildObservationProvenance } from "./provenance";
import { searchMemoryDetailed } from "./searchMemory";
import {
  MEMORY_CAPABILITY_FINGERPRINT,
  TOOL_CAPABILITY_FINGERPRINTS,
} from "./provenance";
import {
  OBSERVATION_PROVENANCE_SCHEMA_VERSION,
  ObservationCompatibilityState,
  ObservationKind,
  ObservationOrigin,
  ObservationScope,
  ObservationSource,
  type CurrentObservationContext,
  type Observation,
} from "./types";

const BASE_CONTEXT: CurrentObservationContext = {
  repository: {
    repositoryId: "repo-a",
    worktreeId: "worktree-a",
    worktreeRoot: "/moved/paths/do/not/matter",
    headCommit: "head-a",
    branch: "main",
    detached: false,
    dirtyFingerprint: null,
  },
  index: {
    identity: "index-a",
    runId: 7,
    worktreeId: "worktree-a",
    headCommit: "head-a",
    dirtyFingerprint: null,
    formatVersion: 5,
    schemaVersion: "schema-a",
    indexerFingerprint: "indexer-a",
    parserFingerprint: "parser-a",
    configFingerprint: "config-a",
  },
  implementation: {
    commit: "vtrace-a",
    tree: "tree-a",
    dirtyFingerprint: null,
    memoryCapabilityFingerprint: MEMORY_CAPABILITY_FINGERPRINT,
  },
  toolCapabilityFingerprints: TOOL_CAPABILITY_FINGERPRINTS,
};

test("M138 compatibility matrix is deterministic across repo, worktree, HEAD, dirty, index, and implementation changes", () => {
  const observation = technicalObservation(BASE_CONTEXT);
  assertState(observation, BASE_CONTEXT, ObservationCompatibilityState.Current, true);
  assertState(observation, withContext({ headCommit: "head-b" }), ObservationCompatibilityState.StaleRepoState, false);
  assertState(observation, withContext({ dirtyFingerprint: "dirty-b" }), ObservationCompatibilityState.StaleDirtyState, false);
  assertState(observation, withContext({ worktreeId: "worktree-b" }), ObservationCompatibilityState.StaleWorktree, false);
  assertState(observation, withContext({ repositoryId: "repo-b" }), ObservationCompatibilityState.ForeignRepository, false);
  assertState(observation, withContext({}, { identity: "index-b" }), ObservationCompatibilityState.StaleIndex, false);
  assertState(
    observation,
    withContext({}, { indexerFingerprint: "corrected-indexer" }),
    ObservationCompatibilityState.StaleIndex,
    false,
  );

  const olderCompatible = withContext({}, {}, { commit: "vtrace-older", tree: "tree-older" });
  assertState(observation, olderCompatible, ObservationCompatibilityState.CurrentCompatible, true);
  assertState(
    observation,
    { ...BASE_CONTEXT, toolCapabilityFingerprints: { ...TOOL_CAPABILITY_FINGERPRINTS, get_impact_graph: "corrected-impact" } },
    ObservationCompatibilityState.SupersededImplementation,
    false,
  );
  const dirtyImplementation = withContext({}, {}, { dirtyFingerprint: "uncommitted-tool-change" });
  assertState(observation, dirtyImplementation, ObservationCompatibilityState.SupersededImplementation, false);

  const restored = withContext({ dirtyFingerprint: "dirty-b" });
  assertState(observation, restored, ObservationCompatibilityState.StaleDirtyState, false);
  assertState(observation, BASE_CONTEXT, ObservationCompatibilityState.Current, true);
  assertState(
    observation,
    withContext({ worktreeRoot: "/repository/moved", branch: "renamed", detached: true }),
    ObservationCompatibilityState.Current,
    true,
  );
});

test("M138 search suppresses legacy/stale evidence, labels historical results, prioritizes current, and surfaces conflicts", () => {
  const stores = memoryStores();
  const db = stores.index;
  try {
    const staleContext = withContext({ headCommit: "old-head" }, { headCommit: "old-head", identity: "old-index" });
    persistImpact(stores, staleContext, 1327, 95, 100);
    persistImpact(stores, staleContext, 10, 7, 200);
    const currentA = persistImpact(stores, BASE_CONTEXT, 3, 3, 300);
    const currentConflict = persistImpact(stores, BASE_CONTEXT, 4, 4, 301);
    persistObservation(stores, {
      repoRoot: "/legacy/arc",
      kind: ObservationKind.Insight,
      source: ObservationSource.Manual,
      summary: "Legacy get_dihedral had 999 dependents",
      createdAtMs: 50,
    });

    const normal = searchMemoryDetailed(stores, {
      query: "get_dihedral dependents",
      maxResults: 10,
      currentContext: BASE_CONTEXT,
    });
    assert.deepEqual(normal.results.map((result) => result.observation.id).sort(), [currentA.id, currentConflict.id].sort());
    assert.equal(normal.accounting.suppressedStale, 2);
    assert.equal(normal.accounting.provenanceIncomplete, 1);
    assert.equal(normal.conflicts.length, 1);
    assert.deepEqual(normal.conflicts[0]?.observationIds, [currentA.id, currentConflict.id].sort());

    const historical = searchMemoryDetailed(stores, {
      query: "get_dihedral dependents",
      maxResults: 10,
      currentContext: BASE_CONTEXT,
      includeStale: true,
    });
    assert.equal(historical.results.length, 5);
    assert.equal(historical.results[0]?.compatibility?.currentTruthEligible, true);
    assert.equal(historical.results.some((result) => (
      result.observation.summary.includes("1327")
      && result.compatibility?.state === ObservationCompatibilityState.StaleRepoState
    )), true);
    assert.equal(historical.results.some((result) => (
      result.observation.summary.includes("999")
      && result.compatibility?.state === ObservationCompatibilityState.ProvenanceIncomplete
    )), true);
  } finally {
    stores.close();
  }
});

test("M138 global and repository workflow notes remain applicable while missing provenance fails closed", () => {
  const global = bareObservation({ scope: ObservationScope.Global });
  assertState(global, withContext({ headCommit: "head-z" }), ObservationCompatibilityState.Applicable, true);

  const repositoryNote = bareObservation({
    scope: ObservationScope.Repository,
    provenance: buildObservationProvenance({ context: BASE_CONTEXT }),
  });
  assertState(repositoryNote, withContext({ headCommit: "head-z" }), ObservationCompatibilityState.Current, true);

  const legacy = bareObservation({});
  assertState(legacy, BASE_CONTEXT, ObservationCompatibilityState.ProvenanceIncomplete, false);
});

test("M138 legacy observations migrate into the session store without inventing provenance", () => {
  // Before M152 this asserted that `initializeSchema` upgraded a legacy
  // `observations` table IN PLACE inside the index. That upgrade path is gone
  // with the table: observations live in `session.sqlite` now, and the way a
  // pre-provenance row reaches the current schema is the legacy drain.
  //
  // The property under test is unchanged and is the one that matters (§99): a
  // row that never recorded provenance must arrive WITHOUT provenance, and be
  // classified `ProvenanceIncomplete`, rather than being handed the current
  // context's identity on the way across.
  const indexDb = new Database(":memory:");
  const sessionDb = createTestSessionDatabase();
  try {
    initializeSchema(indexDb);
    indexDb.exec(`
      CREATE TABLE observations (
        id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, session_id TEXT,
        kind TEXT NOT NULL, source TEXT NOT NULL, tool_name TEXT, query_text TEXT,
        intent TEXT, summary TEXT NOT NULL, body TEXT NOT NULL, source_run_id INTEGER,
        dedupe_key TEXT UNIQUE, created_at_ms INTEGER NOT NULL
      );
      INSERT INTO observations VALUES (
        'legacy-id', '/legacy/repo', NULL, 'insight', 'manual', NULL, NULL, NULL,
        'Legacy technical claim', '', NULL, NULL, 1
      );
    `);

    const result = migrateLegacySessionState({
      indexDb,
      indexDbPath: "/legacy/repo/.vtrace/index.sqlite",
      sessionDb,
      nowMs: 1,
    });
    assert.equal(result.outcome, LegacyMigrationOutcome.Migrated);
    assert.equal(result.totalRowsCopied, 1);

    const observation = listObservations(sessionDb)[0]!;
    assert.equal(observation.id, "legacy-id");
    assert.equal(observation.provenance, undefined);
    assert.equal(observation.scope, undefined);
    assertState(observation, BASE_CONTEXT, ObservationCompatibilityState.ProvenanceIncomplete, false);

    // The current provenance columns exist on the migrated row's table, and the
    // legacy table is gone from the index entirely (§134, §136).
    const columns = sessionDb.query("PRAGMA table_info(observations)").all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "provenance_json"), true);
    assert.equal(
      indexDb.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'observations'",
      ).all().length,
      0,
    );
  } finally {
    sessionDb.close();
    indexDb.close();
  }
});

test("M138 provenance-complete observation round-trips and session context uses the shared gate", () => {
  const stores = memoryStores();
  const db = stores.index;
  try {
    const current = persistImpact(stores, BASE_CONTEXT, 3, 3, 100, "session-a");
    persistImpact(stores, withContext({ headCommit: "old" }, { headCommit: "old", identity: "old" }), 10, 7, 200, "session-a");
    const reloaded = listObservations(stores.session).find((observation) => observation.id === current.id)!;
    assert.equal(reloaded.provenance?.schemaVersion, OBSERVATION_PROVENANCE_SCHEMA_VERSION);
    const normal = getSessionContext(stores, { sessionId: "session-a", limit: 10, currentContext: BASE_CONTEXT });
    assert.deepEqual(normal.observations.map((observation) => observation.id), [current.id]);
    assert.equal(normal.suppressedObservationCount, 1);
    const historical = getSessionContext(stores, {
      sessionId: "session-a",
      limit: 10,
      currentContext: BASE_CONTEXT,
      includeStale: true,
    });
    assert.equal(historical.observations.length, 2);
    assert.equal(Object.values(historical.compatibilityByObservationId ?? {}).some((compatibility) => (
      compatibility.state === ObservationCompatibilityState.StaleRepoState
    )), true);
  } finally {
    stores.close();
  }
});

test("M138 many stale matches stay bounded before serialization", () => {
  const stores = memoryStores();
  const db = stores.index;
  try {
    const stale = withContext({ headCommit: "old" }, { headCommit: "old", identity: "old" });
    for (let index = 0; index < 250; index += 1) {
      persistImpact(stores, stale, 1000 + index, 90, index);
    }
    const normal = searchMemoryDetailed(stores, {
      query: "get_dihedral dependents",
      maxResults: 5,
      currentContext: BASE_CONTEXT,
    });
    assert.equal(normal.results.length, 0);
    assert.equal(normal.accounting.suppressedStale, 250);
    const historical = searchMemoryDetailed(stores, {
      query: "get_dihedral dependents",
      maxResults: 5,
      currentContext: BASE_CONTEXT,
      includeStale: true,
    });
    assert.equal(historical.results.length, 5);
  } finally {
    stores.close();
  }
});

test("M138 automatic run-pipeline memory injection excludes strong legacy evidence", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m138-injection-"));
  try {
    await writeFile(path.join(repoRoot, "service.ts"), "export function createSession() { return 1; }\n");
    const initialized = await initRepo({ repoPath: repoRoot });
    const db = openIndexerDatabase(initialized.paths.dbPath);
    const lease = new ProductStoreLease(db, initialized.paths.dbPath);
    const stores = lease.write;
    try {
      persistObservation(stores, {
        repoRoot,
        kind: ObservationKind.Warning,
        source: ObservationSource.McpAuto,
        toolName: "get_impact_graph",
        queryText: "rename createSession legacy danger",
        summary: "rename createSession legacy danger must use obsolete path",
        body: "legacy danger legacy danger legacy danger",
        createdAtMs: 1,
      });
      const context = await import("./provenance").then(({ resolveCurrentObservationContext }) => (
        resolveCurrentObservationContext(repoRoot)
      ));
      const output = runPipelineOrchestrator(stores, repoRoot, {
        query: "rename createSession legacy danger",
        includeMemory: true,
        currentObservationContext: context,
      });
      assert.equal(output.memory.durable.topObservations.some((result) => (
        result.observation.summary.includes("obsolete path")
      )), false);
    } finally {
      db.close();
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

/** An in-memory index paired with an in-memory session store. */
function memoryStores(): ReturnType<typeof createTestProductStores> {
  const db = new Database(":memory:");
  initializeSchema(db);
  return createTestProductStores(db);
}

function persistImpact(
  stores: ReturnType<typeof createTestProductStores>,
  context: CurrentObservationContext,
  dependentCount: number,
  fileCount: number,
  createdAtMs: number,
  sessionId?: string,
) {
  const queryText = "arc/species/vectors.py::get_dihedral";
  const resultValue = { target: queryText, dependentCount, fileCount };
  return persistObservation(stores, {
    repoRoot: context.repository.worktreeRoot,
    sessionId,
    kind: ObservationKind.ToolCall,
    source: ObservationSource.McpAuto,
    toolName: "get_impact_graph",
    queryText,
    summary: `Computed get_dihedral impact with ${dependentCount} dependents across ${fileCount} files.`,
    body: `dependent_symbol_count=${dependentCount}\ndependent_file_count=${fileCount}`,
    createdAtMs,
    scope: ObservationScope.IndexState,
    origin: ObservationOrigin.ToolDerived,
    provenance: buildObservationProvenance({
      context,
      toolName: "get_impact_graph",
      queryText,
      semanticOptions: { target: queryText, depth: 5, maxEdges: 10 },
      resultSummary: {
        kind: "impact_graph",
        values: { target: queryText, dependentCount, fileCount },
      },
      resultValue,
    }),
  });
}

function technicalObservation(context: CurrentObservationContext): Observation {
  const provenance = buildObservationProvenance({
    context,
    toolName: "get_impact_graph",
    queryText: "get_dihedral",
    semanticOptions: { depth: 5 },
    resultValue: { dependentCount: 3 },
  });
  return bareObservation({ scope: ObservationScope.IndexState, provenance, toolName: "get_impact_graph" });
}

function bareObservation(overrides: Partial<Observation>): Observation {
  return {
    id: "observation",
    repoRoot: "/repo",
    kind: ObservationKind.Insight,
    source: ObservationSource.Manual,
    summary: "Run impact analysis before consolidating helpers.",
    body: "",
    createdAtMs: 1,
    linkedFilePaths: [],
    linkedSymbols: [],
    linkedFqNames: [],
    ...overrides,
  };
}

function withContext(
  repository: Partial<CurrentObservationContext["repository"]> = {},
  index: Partial<NonNullable<CurrentObservationContext["index"]>> = {},
  implementation: Partial<CurrentObservationContext["implementation"]> = {},
): CurrentObservationContext {
  const worktreeId = repository.worktreeId ?? BASE_CONTEXT.repository.worktreeId;
  const headCommit = repository.headCommit ?? BASE_CONTEXT.repository.headCommit;
  const dirtyFingerprint = repository.dirtyFingerprint === undefined
    ? BASE_CONTEXT.repository.dirtyFingerprint
    : repository.dirtyFingerprint;
  return {
    repository: { ...BASE_CONTEXT.repository, ...repository },
    index: BASE_CONTEXT.index === null ? null : {
      ...BASE_CONTEXT.index,
      worktreeId,
      headCommit,
      dirtyFingerprint,
      ...index,
    },
    implementation: { ...BASE_CONTEXT.implementation, ...implementation },
    toolCapabilityFingerprints: BASE_CONTEXT.toolCapabilityFingerprints,
  };
}

function assertState(
  observation: Observation,
  context: CurrentObservationContext,
  state: string,
  eligible: boolean,
): void {
  const actual = classifyObservationCompatibility(observation, context);
  assert.equal(actual.state, state);
  assert.equal(actual.currentTruthEligible, eligible);
  assert.deepEqual(
    classifyObservationCompatibility(observation, context),
    actual,
    "classification must be deterministic",
  );
}
