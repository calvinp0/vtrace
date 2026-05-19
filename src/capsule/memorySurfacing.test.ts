import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { prepareCapsuleAssembly } from "../capsuleProfiles/orchestrator";
import { persistObservation } from "../db/repositories/observationsRepository";
import { listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { EdgeType, type SymbolRecord } from "../domain/types";
import { indexProject } from "../indexer/indexProject";
import { routeQuery } from "../intent/routeQuery";
import { getLatestIndexRun } from "../db/repositories/indexRunsRepository";
import {
  createActiveProjectRule,
  disableProjectRule,
} from "../projectRules/projectRules";
import {
  ObservationKind,
  ObservationSource,
  ObservationStaleReasonKind,
} from "../observations/types";
import {
  SymbolSearchMatchField,
  SymbolSearchMatchType,
  type GraphSearchResult,
} from "../retrieval/types";
import { buildCapsule, createSourceBackedCapsuleBuilder } from "./buildCapsule";
import { createCharacterBudget, computeTotalCapsuleCost } from "./budget";
import {
  CapsuleInclusionReasonKind,
  type CapsuleSupportingCandidate,
} from "./types";

test("memory surfacing is deterministic and preserves stable ordering", async () => {
  await withMemoryFixture(async ({ repoRoot, db, readUser, normalizeUser }) => {
    const newer = persistObservation(db, {
      repoRoot,
      kind: ObservationKind.Warning,
      source: ObservationSource.Manual,
      summary: "Explain user service guardrail",
      body: "Explain user service flow through the primary module.",
      queryText: "explain user service",
      intent: "explain",
      sourceRunId: getLatestIndexRun(db)?.id,
      createdAtMs: 300,
      linkedFilePaths: ["src/service.ts"],
    });
    const older = persistObservation(db, {
      repoRoot,
      kind: ObservationKind.Insight,
      source: ObservationSource.Manual,
      summary: "Explain user service invariant",
      body: "Explain user service behavior in the same module.",
      queryText: "explain user service",
      intent: "explain",
      sourceRunId: getLatestIndexRun(db)?.id,
      createdAtMs: 200,
      linkedFilePaths: ["src/service.ts"],
    });

    const first = buildExplainCapsule(db, repoRoot, "explain user service", readUser, normalizeUser);
    const second = buildExplainCapsule(db, repoRoot, "explain user service", readUser, normalizeUser);

    assert.deepEqual(second, first);
    assert.deepEqual(
      first.memories?.map((memory) => memory.observationId),
      [newer.id, older.id],
    );
    assert.equal(first.budget.usedCharacters, computeTotalCapsuleCost(first));
  });
});

test("stale memories are penalized but can still surface when structurally relevant", async () => {
  await withMemoryFixture(async ({ repoRoot, db, normalizeUser }) => {
    const initialRunId = getLatestIndexRun(db)?.id;

    assert.notEqual(initialRunId, undefined);

    const staleObservation = persistObservation(db, {
      repoRoot,
      kind: ObservationKind.Warning,
      source: ObservationSource.Manual,
      summary: "Explain user service flow",
      body: "Explain user service behavior before the rename.",
      queryText: "explain user service",
      intent: "explain",
      sourceRunId: initialRunId,
      createdAtMs: 100,
      linkedFilePaths: ["src/service.ts"],
      linkedSymbolIds: [findSymbol(db, "src/service.ts", "readUser").id],
    });

    await writeServiceFile(repoRoot, "loadUser");
    await indexProject({ repoRoot, db });

    const freshObservation = persistObservation(db, {
      repoRoot,
      kind: ObservationKind.Insight,
      source: ObservationSource.Manual,
      summary: "Explain user service flow",
      body: "Explain user service behavior after the rename.",
      queryText: "explain user service",
      intent: "explain",
      sourceRunId: getLatestIndexRun(db)?.id,
      createdAtMs: 200,
      linkedFilePaths: ["src/service.ts"],
    });

    const capsule = buildExplainCapsule(
      db,
      repoRoot,
      "explain user service",
      findSymbol(db, "src/service.ts", "loadUser"),
      normalizeUser,
    );

    assert.deepEqual(
      capsule.memories?.map((memory) => memory.observationId),
      [freshObservation.id, staleObservation.id],
    );
    assert.equal(capsule.memories?.[0]?.isStale, false);
    assert.equal(capsule.memories?.[1]?.isStale, true);
    assert.equal(
      capsule.memories?.[1]?.staleReasons.includes(ObservationStaleReasonKind.FileModified),
      true,
    );
  });
});

test("structurally linked memories outrank weak text-only matches", async () => {
  await withMemoryFixture(async ({ repoRoot, db, readUser, normalizeUser }) => {
    const structural = persistObservation(db, {
      repoRoot,
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Keep the reader path narrow",
      body: "This note stays attached to the readUser symbol.",
      queryText: "explain read user service",
      intent: "explain",
      sourceRunId: getLatestIndexRun(db)?.id,
      createdAtMs: 200,
      linkedSymbolIds: [readUser.id],
    });
    persistObservation(db, {
      repoRoot,
      kind: ObservationKind.Insight,
      source: ObservationSource.Manual,
      summary: "Read user note",
      body: "Read user details.",
      queryText: "read user",
      intent: "explain",
      sourceRunId: getLatestIndexRun(db)?.id,
      createdAtMs: 300,
    });

    const capsule = buildExplainCapsule(db, repoRoot, "explain read user service", readUser, normalizeUser);

    assert.deepEqual(
      capsule.memories?.map((memory) => memory.observationId),
      [structural.id],
    );
    assert.deepEqual(
      capsule.memories?.[0]?.inclusionReasons.map((reason) => reason.kind),
      ["linked_symbol_overlap", "query_term_overlap", "intent_match"],
    );
  });
});

test("manual observations can surface when strongly relevant", async () => {
  await withMemoryFixture(async ({ repoRoot, db, readUser, normalizeUser }) => {
    const observation = persistObservation(db, {
      repoRoot,
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Manual note on readUser",
      body: "Manual note anchored to the readUser symbol.",
      queryText: "explain read user service",
      intent: "explain",
      sourceRunId: getLatestIndexRun(db)?.id,
      createdAtMs: 100,
      linkedSymbolIds: [readUser.id],
    });

    const capsule = buildExplainCapsule(db, repoRoot, "explain read user service", readUser, normalizeUser);

    assert.deepEqual(
      capsule.memories?.map((memory) => memory.observationId),
      [observation.id],
    );
  });
});

test("auto-captured observations can surface when strongly relevant", async () => {
  await withMemoryFixture(async ({ repoRoot, db, readUser, normalizeUser }) => {
    const observation = persistObservation(db, {
      repoRoot,
      kind: ObservationKind.ToolCall,
      source: ObservationSource.McpAuto,
      toolName: "build_capsule",
      summary: "build_capsule: explain read user service",
      body: "intent=explain\nrouting_profile=explain\ncapsule_profile=explain_stable",
      queryText: "read user service",
      intent: "explain",
      sourceRunId: getLatestIndexRun(db)?.id,
      createdAtMs: 100,
      linkedFilePaths: ["src/service.ts"],
      linkedSymbolIds: [readUser.id],
    });

    const capsule = buildExplainCapsule(db, repoRoot, "explain reader service", readUser, normalizeUser);

    assert.deepEqual(
      capsule.memories?.map((memory) => memory.observationId),
      [observation.id],
    );
  });
});

test("capsules omit the memories section when nothing is relevant and keep normal behavior", async () => {
  await withMemoryFixture(async ({ repoRoot, db, readUser, normalizeUser }) => {
    persistObservation(db, {
      repoRoot,
      kind: ObservationKind.Warning,
      source: ObservationSource.Manual,
      summary: "Kernel rewrite note",
      body: "Only relevant to a different file and query.",
      queryText: "kernel rewrite",
      intent: "refactor",
      sourceRunId: getLatestIndexRun(db)?.id,
      createdAtMs: 100,
      linkedFilePaths: ["src/models.ts"],
    });

    const capsule = buildExplainCapsule(db, repoRoot, "explain read user service", readUser, normalizeUser);

    assert.equal(capsule.memories, undefined);
    assert.equal(capsule.pivots[0]?.symbolId, readUser.id);
    assert.equal(capsule.supportingItems[0]?.symbolId, normalizeUser.id);
    assert.equal(capsule.budget.usedCharacters, computeTotalCapsuleCost(capsule));
  });
});

test("source-backed builder surfaces memories without a parallel builder input path", async () => {
  await withMemoryFixture(async ({ repoRoot, db, readUser, normalizeUser }) => {
    persistObservation(db, {
      repoRoot,
      kind: ObservationKind.Insight,
      source: ObservationSource.Manual,
      summary: "Reader path observation",
      body: "Bound to the readUser symbol for explain queries.",
      queryText: "explain read user service",
      intent: "explain",
      sourceRunId: getLatestIndexRun(db)?.id,
      createdAtMs: 100,
      linkedSymbolIds: [readUser.id],
    });

    const prepared = prepareCapsuleAssembly({
      classification: routeQuery(db, "explain read user service").classification,
      builderInput: {
        query: "explain read user service",
        rerankedCandidates: [makeRerankedCandidate(readUser)],
        supportingCandidates: [makeSupportingCandidate(normalizeUser, readUser.id)],
        maxBudget: createCharacterBudget(2_000),
      },
    });

    assert.equal(
      Object.prototype.hasOwnProperty.call(prepared.builderInput, "memories"),
      false,
    );

    const capsule = buildCapsule(
      createSourceBackedCapsuleBuilder({ db, repoRoot }),
      prepared.builderInput,
    );

    assert.equal(capsule.memories?.length, 1);
  });
});

test("source-backed capsules surface relevant active rules separately from memories", async () => {
  await withMemoryFixture(async ({ repoRoot, db, readUser, normalizeUser }) => {
    const relevant = createActiveProjectRule(db, {
      repoRoot,
      summary: "When changing the reader service, update normalization tests.",
      files: ["src/service.ts"],
      terms: ["reader", "service", "normalization"],
      nowMs: 100,
    });
    createActiveProjectRule(db, {
      repoRoot,
      summary: "Kernel rules belong elsewhere.",
      files: ["src/kernel.ts"],
      terms: ["kernel"],
      nowMs: 200,
    });
    const disabled = createActiveProjectRule(db, {
      repoRoot,
      summary: "Disabled reader service guidance.",
      files: ["src/service.ts"],
      terms: ["reader", "service"],
      nowMs: 300,
    });
    disableProjectRule(db, disabled.id, 400);

    const capsule = buildExplainCapsule(db, repoRoot, "explain reader service", readUser, normalizeUser);

    assert.deepEqual(capsule.memories, undefined);
    assert.deepEqual(capsule.rules?.active.map((rule) => rule.id), [relevant.id]);
    assert.equal(capsule.rules?.active[0]?.status, "active");
    assert.equal(capsule.rules?.active[0]?.scope.files.includes("src/service.ts"), true);
    assert.match(capsule.rules?.active[0]?.reason ?? "", /matched/);
    assert.equal(capsule.budget.usedCharacters, computeTotalCapsuleCost(capsule));
  });
});

async function withMemoryFixture(
  run: (input: {
    repoRoot: string;
    db: ReturnType<typeof openIndexerDatabase>;
    readUser: SymbolRecord;
    normalizeUser: SymbolRecord;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-layer9-memory-"));
  const repoRoot = path.join(root, "repo");
  const db = openIndexerDatabase();

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeModelFile(repoRoot);
    await writeServiceFile(repoRoot, "readUser");
    await indexProject({ repoRoot, db });

    await run({
      repoRoot,
      db,
      readUser: findSymbol(db, "src/service.ts", "readUser"),
      normalizeUser: findSymbol(db, "src/service.ts", "normalizeUser"),
    });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

function buildExplainCapsule(
  db: ReturnType<typeof openIndexerDatabase>,
  repoRoot: string,
  query: string,
  pivot: SymbolRecord,
  support: SymbolRecord,
) {
  const prepared = prepareCapsuleAssembly({
    classification: routeQuery(db, query).classification,
    builderInput: {
      query,
      rerankedCandidates: [makeRerankedCandidate(pivot)],
      supportingCandidates: [makeSupportingCandidate(support, pivot.id)],
      maxBudget: createCharacterBudget(5_000),
    },
  });

  return buildCapsule(
    createSourceBackedCapsuleBuilder({ db, repoRoot }),
    prepared.builderInput,
  );
}

function findSymbol(
  db: ReturnType<typeof openIndexerDatabase>,
  filePath: string,
  localName: string,
): SymbolRecord {
  const symbol = listSymbolsForFile(db, filePath).find((candidate) => candidate.localName === localName);

  assert.notEqual(symbol, undefined);
  return symbol!;
}

function makeRerankedCandidate(symbol: SymbolRecord): GraphSearchResult {
  return {
    symbolId: symbol.id,
    filePath: symbol.filePath,
    fqName: symbol.fqName,
    localName: symbol.localName,
    kind: symbol.kind,
    matches: [
      {
        field: SymbolSearchMatchField.LocalName,
        matchType: SymbolSearchMatchType.Exact,
        scoreContribution: 100,
      },
      {
        field: SymbolSearchMatchField.FQName,
        matchType: SymbolSearchMatchType.Substring,
        scoreContribution: 20,
      },
    ],
    lexicalScore: 100,
    graphScore: 0,
    finalScore: 100,
    graphContributions: [],
  };
}

function makeSupportingCandidate(
  symbol: SymbolRecord,
  relatedSymbolId: string,
): CapsuleSupportingCandidate {
  return {
    symbolId: symbol.id,
    filePath: symbol.filePath,
    fqName: symbol.fqName,
    localName: symbol.localName,
    kind: symbol.kind,
    lexicalScore: 40,
    graphScore: 4,
    finalScore: 44,
    inclusionReasons: [
      {
        kind: CapsuleInclusionReasonKind.StructuralSupport,
        edgeType: EdgeType.Contains,
        relatedSymbolIds: [relatedSymbolId],
      },
    ],
  };
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

async function writeServiceFile(repoRoot: string, primaryFunctionName: string): Promise<void> {
  await writeFile(
    path.join(repoRoot, "src", "service.ts"),
    [
      "import type { User } from \"./models\";",
      "",
      `export function ${primaryFunctionName}(id: string): User {`,
      "  return { id };",
      "}",
      "",
      "export function normalizeUser(id: string): string {",
      "  return id.trim();",
      "}",
      "",
    ].join("\n"),
  );
}
