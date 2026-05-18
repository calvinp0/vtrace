import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  buildCapsule,
  createSourceBackedCapsuleBuilder,
  deterministicCapsuleBuilder,
} from "../capsule/buildCapsule";
import { createCharacterBudget } from "../capsule/budget";
import {
  type CapsuleInclusionReason,
  CapsuleInclusionReasonKind,
  CapsuleItemRole,
  type CapsuleSupportingCandidate,
} from "../capsule/types";
import { prepareCapsuleAssembly } from "../capsuleProfiles/orchestrator";
import {
  getCapsuleManifestById,
  getCapsuleStaleness,
  persistCapsuleManifest,
} from "../db/repositories/capsuleManifestsRepository";
import { listIndexRuns } from "../db/repositories/indexRunsRepository";
import { listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { EdgeType, SymbolKind, type SymbolRecord } from "../domain/types";
import { indexProject } from "../indexer/indexProject";
import { routeQuery } from "../intent/routeQuery";
import {
  CapsuleStaleReasonKind,
  StaleStateStatus,
} from "./types";
import {
  SymbolSearchMatchField,
  SymbolSearchMatchType,
  type GraphSearchResult,
} from "../retrieval/types";
import {
  applyMixedPyCythonControlledChange,
  MIXED_PY_CYTHON_BACKGROUND_FILE_PATH,
  MIXED_PY_CYTHON_CONTROLLED_CHANGE_SYMBOL_FQ_NAME,
  withMixedPyCythonRepo,
} from "../testing/mixedPyCythonFixture";

test("a persisted source-backed capsule manifest remains fresh across an unchanged later run", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeCapsuleTrustRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const sourceRunId = latestRunId(db);
      const manifest = persistCapsuleManifest(db, {
        sourceRunId,
        capsule: buildSourceBackedCapsule(db, repoRoot),
        createdAtMs: 1,
      });

      assert.deepEqual(
        manifest.items.map((item) => ({
          itemOrdinal: item.itemOrdinal,
          role: item.role,
          contentMode: item.contentMode,
          sourceBacked: item.sourceBacked,
          filePath: item.filePath,
          fqName: item.fqName,
        })),
        [
          {
            itemOrdinal: 0,
            role: CapsuleItemRole.Pivot,
            contentMode: "full",
            sourceBacked: true,
            filePath: "src/service.ts",
            fqName: "src/service.ts::readUser",
          },
          {
            itemOrdinal: 1,
            role: CapsuleItemRole.Support,
            contentMode: "skeleton",
            sourceBacked: false,
            filePath: "src/models.ts",
            fqName: "src/models.ts::User",
          },
        ],
      );
      assert.deepEqual(getCapsuleManifestById(db, manifest.id), manifest);

      await indexProject({ repoRoot, db });
      const comparisonRunId = latestRunId(db);
      const staleness = getCapsuleStaleness(db, manifest.id, comparisonRunId);

      assert.equal(staleness?.status, StaleStateStatus.Fresh);
      assert.deepEqual(
        staleness?.items.map((item) => [item.itemOrdinal, item.status, item.reasons]),
        [
          [0, StaleStateStatus.Fresh, []],
          [1, StaleStateStatus.Fresh, []],
        ],
      );
    } finally {
      db.close();
    }
  });
});

test("file removal marks affected capsule items stale", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeCapsuleTrustRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const manifest = persistCapsuleManifest(db, {
        sourceRunId: latestRunId(db),
        capsule: buildSourceBackedCapsule(db, repoRoot),
        createdAtMs: 1,
      });

      await rm(path.join(repoRoot, "src", "service.ts"));
      await indexProject({ repoRoot, db });

      const staleness = getCapsuleStaleness(db, manifest.id, latestRunId(db));

      assert.equal(staleness?.status, StaleStateStatus.Stale);
      assert.deepEqual(
        staleness?.items.map((item) => [item.itemOrdinal, item.status]),
        [
          [0, StaleStateStatus.Stale],
          [1, StaleStateStatus.Fresh],
        ],
      );
      assert.deepEqual(
        staleness?.items[0]?.reasons.map((reason) => reason.kind),
        [
          CapsuleStaleReasonKind.FileRemoved,
          CapsuleStaleReasonKind.SymbolRemoved,
        ],
      );
    } finally {
      db.close();
    }
  });
});

test("symbol removal marks compressed capsule items stale without source-backed file reasons", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeCapsuleTrustRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const manifest = persistCapsuleManifest(db, {
        sourceRunId: latestRunId(db),
        capsule: buildCompressedCapsule(db),
        createdAtMs: 1,
      });

      await writeFile(
        path.join(repoRoot, "src", "service.ts"),
        [
          'import { User } from "./models";',
          'export function lookupUser(): User { return { id: "1" }; }',
          "",
        ].join("\n"),
      );
      await indexProject({ repoRoot, db });

      const staleness = getCapsuleStaleness(db, manifest.id, latestRunId(db));

      assert.equal(staleness?.items[0]?.status, StaleStateStatus.Stale);
      assert.deepEqual(
        staleness?.items[0]?.reasons.map((reason) => reason.kind),
        [CapsuleStaleReasonKind.SymbolRemoved],
      );
    } finally {
      db.close();
    }
  });
});

test("symbol modification marks compressed capsule items stale", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeCapsuleTrustRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const manifest = persistCapsuleManifest(db, {
        sourceRunId: latestRunId(db),
        capsule: buildCompressedCapsule(db),
        createdAtMs: 1,
      });

      await writeFile(
        path.join(repoRoot, "src", "service.ts"),
        [
          'import { User } from "./models";',
          'export function readUser(userId: string): User { return { id: userId }; }',
          "",
        ].join("\n"),
      );
      await indexProject({ repoRoot, db });

      const staleness = getCapsuleStaleness(db, manifest.id, latestRunId(db));

      assert.equal(staleness?.items[0]?.status, StaleStateStatus.Stale);
      assert.deepEqual(
        staleness?.items[0]?.reasons.map((reason) => reason.kind),
        [CapsuleStaleReasonKind.SymbolModified],
      );
    } finally {
      db.close();
    }
  });
});

test("source-backed file modification marks affected items stale even when the referenced symbol is unchanged", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeCapsuleTrustRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const manifest = persistCapsuleManifest(db, {
        sourceRunId: latestRunId(db),
        capsule: buildSourceBackedCapsule(db, repoRoot),
        createdAtMs: 1,
      });

      await writeFile(
        path.join(repoRoot, "src", "service.ts"),
        [
          'import { User } from "./models";',
          'export function readUser(): User { return { id: "1" }; }',
          'export function writeUser(): User { return { id: "2" }; }',
          "",
        ].join("\n"),
      );
      await indexProject({ repoRoot, db });

      const staleness = getCapsuleStaleness(db, manifest.id, latestRunId(db));

      assert.equal(staleness?.items[0]?.status, StaleStateStatus.Stale);
      assert.deepEqual(
        staleness?.items[0]?.reasons.map((reason) => reason.kind),
        [CapsuleStaleReasonKind.FileModifiedSourceBacked],
      );
      assert.equal(staleness?.items[1]?.status, StaleStateStatus.Fresh);
    } finally {
      db.close();
    }
  });
});

test("unrelated later changes do not falsely mark capsule items stale", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeCapsuleTrustRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const manifest = persistCapsuleManifest(db, {
        sourceRunId: latestRunId(db),
        capsule: buildSourceBackedCapsule(db, repoRoot),
        createdAtMs: 1,
      });

      await writeFile(path.join(repoRoot, "src", "extra.ts"), "export const extra = 1;\n");
      await indexProject({ repoRoot, db });

      const staleness = getCapsuleStaleness(db, manifest.id, latestRunId(db));

      assert.equal(staleness?.status, StaleStateStatus.Fresh);
      assert.equal(staleness?.items.every((item) => item.status === StaleStateStatus.Fresh), true);
    } finally {
      db.close();
    }
  });
});

test("capsule stale output is deterministic and preserves manifest item order", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeCapsuleTrustRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const manifest = persistCapsuleManifest(db, {
        sourceRunId: latestRunId(db),
        capsule: buildSourceBackedCapsule(db, repoRoot),
        createdAtMs: 1,
      });

      await writeFile(
        path.join(repoRoot, "src", "service.ts"),
        [
          'import { User } from "./models";',
          'export function readUser(): User { return { id: "1" }; }',
          'export function writeUser(): User { return { id: "2" }; }',
          "",
        ].join("\n"),
      );
      await indexProject({ repoRoot, db });
      const comparisonRunId = latestRunId(db);

      const first = getCapsuleStaleness(db, manifest.id, comparisonRunId);
      const second = getCapsuleStaleness(db, manifest.id, comparisonRunId);

      assert.deepEqual(second, first);
      assert.deepEqual(
        first?.items.map((item) => [item.itemOrdinal, item.role, item.filePath, item.symbol.fqName]),
        [
          [0, CapsuleItemRole.Pivot, "src/service.ts", "src/service.ts::readUser"],
          [1, CapsuleItemRole.Support, "src/models.ts", "src/models.ts::User"],
        ],
      );
    } finally {
      db.close();
    }
  });
});

test("mixed Python/Cython capsule trust stays deterministic after a controlled fixture change", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const manifest = persistCapsuleManifest(db, {
        sourceRunId: latestRunId(db),
        capsule: buildMixedFixtureCapsule(db, repoRoot, "background offsets"),
        createdAtMs: 1,
      });

      await applyMixedPyCythonControlledChange(repoRoot);
      await indexProject({ repoRoot, db });

      const comparisonRunId = latestRunId(db);
      const first = getCapsuleStaleness(db, manifest.id, comparisonRunId);
      const second = getCapsuleStaleness(db, manifest.id, comparisonRunId);
      const changedItem = first?.items.find((item) => {
        return item.filePath === MIXED_PY_CYTHON_BACKGROUND_FILE_PATH
          && item.symbol.fqName === MIXED_PY_CYTHON_CONTROLLED_CHANGE_SYMBOL_FQ_NAME;
      });

      assert.deepEqual(second, first);
      assert.equal(first?.status, StaleStateStatus.Stale);
      assert.notEqual(changedItem, undefined);
      assert.equal(changedItem?.status, StaleStateStatus.Stale);
      assert.deepEqual(
        changedItem?.reasons.map((reason) => reason.kind),
        [
          CapsuleStaleReasonKind.SymbolModified,
          CapsuleStaleReasonKind.FileModifiedSourceBacked,
        ],
      );
      assert.equal(
        first?.items
          .filter((item) => item.symbol.fqName !== MIXED_PY_CYTHON_CONTROLLED_CHANGE_SYMBOL_FQ_NAME)
          .every((item) => item.status === StaleStateStatus.Fresh),
        true,
      );
    } finally {
      db.close();
    }
  });
});

async function withTempRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vexb-capsule-stale-"));

  try {
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function writeCapsuleTrustRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "models.ts"),
    "export interface User { id: string }\n",
  );
  await writeFile(
    path.join(repoRoot, "src", "service.ts"),
    [
      'import { User } from "./models";',
      'export function readUser(): User { return { id: "1" }; }',
      "",
    ].join("\n"),
  );
  await writeFile(path.join(repoRoot, "src", "extra.ts"), "export const extra = 0;\n");
}

function latestRunId(db: Parameters<typeof listIndexRuns>[0]): number {
  return listIndexRuns(db).at(-1)!.id;
}

function buildSourceBackedCapsule(
  db: Parameters<typeof listSymbolsForFile>[0],
  repoRoot: string,
) {
  const readUser = findSymbol(listSymbolsForFile(db, "src/service.ts"), "readUser");
  const user = findSymbol(listSymbolsForFile(db, "src/models.ts"), "User");
  const builder = createSourceBackedCapsuleBuilder({ db, repoRoot });

  return buildCapsule(builder, {
    query: "read user",
    rerankedCandidates: [makeRerankedCandidate(readUser)],
    supportingCandidates: [makeSupportingCandidate(user, readUser.id)],
    maxBudget: createCharacterBudget(5_000),
  });
}

function buildCompressedCapsule(
  db: Parameters<typeof listSymbolsForFile>[0],
) {
  const readUser = findSymbol(listSymbolsForFile(db, "src/service.ts"), "readUser");
  const user = findSymbol(listSymbolsForFile(db, "src/models.ts"), "User");

  return buildCapsule(deterministicCapsuleBuilder, {
    query: "read user",
    rerankedCandidates: [
      {
        ...makeRerankedCandidate(readUser),
        signature: readUser.signature,
      },
    ],
    supportingCandidates: [
      {
        ...makeSupportingCandidate(user, readUser.id),
        signature: user.signature,
      },
    ],
    maxBudget: createCharacterBudget(5_000),
  });
}

function findSymbol(symbols: readonly SymbolRecord[], localName: string): SymbolRecord {
  const symbol = symbols.find((candidate) => candidate.localName === localName);

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
        edgeType: EdgeType.Imports,
        relatedSymbolIds: [relatedSymbolId],
      },
    ],
  };
}

function buildMixedFixtureCapsule(
  db: Parameters<typeof listSymbolsForFile>[0],
  repoRoot: string,
  query: string,
) {
  const routedQuery = routeQuery(db, query, { maxResults: 6 });
  const preparedAssembly = prepareCapsuleAssembly({
    classification: routedQuery.classification,
    builderInput: {
      query,
      rerankedCandidates: routedQuery.rerankedResults,
      supportingCandidates: routedQuery.rerankedResults.map(makeSupportingCandidateFromGraphResult),
      maxBudget: createCharacterBudget(5_000),
    },
  });

  return buildCapsule(
    createSourceBackedCapsuleBuilder({ db, repoRoot }),
    preparedAssembly.builderInput,
  );
}

function makeSupportingCandidateFromGraphResult(
  result: GraphSearchResult,
): CapsuleSupportingCandidate {
  return {
    symbolId: result.symbolId,
    filePath: result.filePath,
    fqName: result.fqName,
    localName: result.localName,
    kind: result.kind,
    lexicalScore: result.lexicalScore,
    graphScore: result.graphScore,
    finalScore: result.finalScore,
    inclusionReasons: buildInclusionReasonsFromGraphResult(result),
  };
}

function buildInclusionReasonsFromGraphResult(
  result: GraphSearchResult,
): CapsuleInclusionReason[] {
  const reasons: CapsuleInclusionReason[] = [
    {
      kind: CapsuleInclusionReasonKind.LexicalMatch,
      matchedFields: collectUniqueInOrder(result.matches.map((match) => match.field)),
    },
  ];
  const graphSignals = collectUniqueInOrder(result.graphContributions.map((contribution) => contribution.signal));
  const relatedSymbolIds = collectSortedUnique(
    result.graphContributions.flatMap((contribution) => contribution.relatedSymbolIds ?? []),
  );

  if (graphSignals.length > 0) {
    reasons.push({
      kind: CapsuleInclusionReasonKind.GraphConnection,
      graphSignals,
      ...(relatedSymbolIds.length === 0 ? {} : { relatedSymbolIds }),
    });
  }

  return reasons;
}

function collectUniqueInOrder<T>(values: readonly T[]): T[] {
  const uniqueValues: T[] = [];
  const seen = new Set<T>();

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    uniqueValues.push(value);
  }

  return uniqueValues;
}

function collectSortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
