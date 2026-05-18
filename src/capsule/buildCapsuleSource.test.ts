import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { persistParseResult } from "../db/persistParseResult";
import { listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import {
  buildFQName,
  computeFileId,
  computeSymbolId,
  EdgeType,
  Language,
  SymbolKind,
  type ParseResult,
  type SymbolRecord,
} from "../domain/types";
import { indexProject } from "../indexer/indexProject";
import { routeQuery } from "../intent/routeQuery";
import { prepareCapsuleAssembly } from "../capsuleProfiles/orchestrator";
import {
  SymbolSearchMatchField,
  SymbolSearchMatchType,
  type GraphSearchResult,
} from "../retrieval/types";
import { withMixedPyCythonRepo } from "../testing/mixedPyCythonFixture";
import { buildCapsule, createSourceBackedCapsuleBuilder, deterministicCapsuleBuilder } from "./buildCapsule";
import { computeCapsuleItemCost, createCharacterBudget } from "./budget";
import {
  CapsuleContentMode,
  type CapsuleInclusionReason,
  CapsuleInclusionReasonKind,
  CapsuleItemRole,
  type CapsuleSupportingCandidate,
  type PivotCapsuleItem,
} from "./types";

test("source-backed builder includes real full source for pivots and compressed content for supports", async () => {
  await withTempRepo(async (repoRoot) => {
    const filePath = "src/session.ts";
    const fileContents = `export class SessionManager {\n  createSession(accountId: string): string {\n    return accountId;\n  }\n}\n`;
    await writeRepoFile(repoRoot, filePath, fileContents);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      const symbols = listSymbolsForFile(db, filePath);
      const sessionManager = findSymbol(symbols, "SessionManager");
      const createSession = findSymbol(symbols, "createSession");
      const builder = createSourceBackedCapsuleBuilder({ db, repoRoot });
      const capsule = buildCapsule(builder, {
        query: "session",
        rerankedCandidates: [makeRerankedCandidate(sessionManager)],
        supportingCandidates: [makeSupportingCandidate(createSession, sessionManager.id)],
        maxBudget: createCharacterBudget(5_000),
      });

      assert.equal(capsule.pivots.length, 1);
      assert.equal(capsule.pivots[0]?.content.mode, CapsuleContentMode.Full);
      assert.equal(capsule.pivots[0]?.sourceBacked, true);
      assert.equal(
        capsule.pivots[0]?.content.source,
        Buffer.from(fileContents, "utf8")
          .subarray(sessionManager.startByte, sessionManager.endByte)
          .toString("utf8"),
      );
      assert.equal(capsule.supportingItems.length, 1);
      assert.equal(capsule.supportingItems[0]?.content.mode, CapsuleContentMode.Skeleton);
      assert.equal(capsule.supportingItems[0]?.sourceBacked, undefined);
      assert.equal(capsule.supportingItems[0]?.content.detail, "standard");
      assert.equal(capsule.supportingItems[0]?.content.file.filePath, filePath);
      assert.equal(capsule.supportingItems[0]?.content.file.declarations[0]?.name, "SessionManager");
      assert.equal(
        capsule.supportingItems[0]?.content.file.declarations[0]?.members[0]?.signature,
        createSession.signature,
      );
      assert.equal(capsule.truncated, false);
      assert.equal(capsule.compressed, true);
    } finally {
      db.close();
    }
  });
});

test("source-backed support items are omitted only after the skeleton representation no longer fits", async () => {
  await withTempRepo(async (repoRoot) => {
    const filePath = "src/session.ts";
    const fileContents = `export class SessionManager {\n  createSession(accountId: string): string {\n    return accountId;\n  }\n}\n`;
    await writeRepoFile(repoRoot, filePath, fileContents);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      const symbols = listSymbolsForFile(db, filePath);
      const sessionManager = findSymbol(symbols, "SessionManager");
      const createSession = findSymbol(symbols, "createSession");
      const builder = createSourceBackedCapsuleBuilder({ db, repoRoot });
      const roomy = buildCapsule(builder, {
        query: "session",
        rerankedCandidates: [makeRerankedCandidate(sessionManager)],
        supportingCandidates: [makeSupportingCandidate(createSession, sessionManager.id)],
        maxBudget: createCharacterBudget(5_000),
      });
      const supportCost = roomy.supportingItems[0]!.budgetCost;
      const pivotCost = roomy.pivots[0]!.budgetCost;

      const justFits = buildCapsule(builder, {
        query: "session",
        rerankedCandidates: [makeRerankedCandidate(sessionManager)],
        supportingCandidates: [makeSupportingCandidate(createSession, sessionManager.id)],
        maxBudget: createCharacterBudget("session".length + pivotCost + supportCost),
      });
      const tooTight = buildCapsule(builder, {
        query: "session",
        rerankedCandidates: [makeRerankedCandidate(sessionManager)],
        supportingCandidates: [makeSupportingCandidate(createSession, sessionManager.id)],
        maxBudget: createCharacterBudget("session".length + pivotCost + supportCost - 1),
      });

      assert.equal(justFits.pivots[0]?.content.mode, CapsuleContentMode.Full);
      assert.equal(justFits.supportingItems[0]?.content.mode, CapsuleContentMode.Skeleton);
      assert.equal(tooTight.pivots[0]?.content.mode, CapsuleContentMode.Full);
      assert.equal(tooTight.supportingItems.length, 0);
      assert.equal(tooTight.truncated, true);
    } finally {
      db.close();
    }
  });
});

test("source-backed skeleton integration does not change the selected symbol set when budget is ample", async () => {
  await withTempRepo(async (repoRoot) => {
    const filePath = "src/session.ts";
    const fileContents = `export class SessionManager {\n  createSession(accountId: string): string {\n    return accountId;\n  }\n}\n`;
    await writeRepoFile(repoRoot, filePath, fileContents);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      const symbols = listSymbolsForFile(db, filePath);
      const sessionManager = findSymbol(symbols, "SessionManager");
      const createSession = findSymbol(symbols, "createSession");
      const rerankedCandidates = [makeRerankedCandidate(sessionManager)];
      const supportingCandidates = [makeSupportingCandidate(createSession, sessionManager.id)];
      const sourceBacked = buildCapsule(
        createSourceBackedCapsuleBuilder({ db, repoRoot }),
        {
          query: "session",
          rerankedCandidates,
          supportingCandidates,
          maxBudget: createCharacterBudget(5_000),
        },
      );
      const plain = buildCapsule(
        deterministicCapsuleBuilder,
        {
          query: "session",
          rerankedCandidates,
          supportingCandidates,
          maxBudget: createCharacterBudget(5_000),
        },
      );

      assert.deepEqual(
        sourceBacked.pivots.map((item) => item.symbolId),
        plain.pivots.map((item) => item.symbolId),
      );
      assert.deepEqual(
        sourceBacked.supportingItems.map((item) => item.symbolId),
        plain.supportingItems.map((item) => item.symbolId),
      );
      assert.equal(sourceBacked.supportingItems[0]?.content.mode, CapsuleContentMode.Skeleton);
    } finally {
      db.close();
    }
  });
});

test("source-backed builder falls back cleanly when source files are missing", async () => {
  await withTempRepo(async (repoRoot) => {
    const filePath = "src/session.ts";
    await writeRepoFile(repoRoot, filePath, "export class SessionManager {}\n");
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      const sessionManager = findSymbol(listSymbolsForFile(db, filePath), "SessionManager");
      await unlink(path.join(repoRoot, filePath));
      const builder = createSourceBackedCapsuleBuilder({ db, repoRoot });
      const capsule = buildCapsule(builder, {
        query: "session",
        rerankedCandidates: [makeRerankedCandidate(sessionManager)],
        maxBudget: createCharacterBudget(5_000),
      });

      assert.equal(capsule.pivots.length, 1);
      assert.equal(capsule.pivots[0]?.content.mode, CapsuleContentMode.SignatureOnly);
      assert.equal(capsule.pivots[0]?.sourceBacked, undefined);
      assert.equal(capsule.pivots[0]?.content.signature, sessionManager.signature);
      assert.equal(capsule.truncated, false);
      assert.equal(capsule.compressed, true);
    } finally {
      db.close();
    }
  });
});

test("source-backed builder handles invalid spans without crashing and falls back to compressed modes", async () => {
  await withTempRepo(async (repoRoot) => {
    const filePath = "src/invalid.ts";
    const fileContents = "export const value = 1;\n";
    await writeRepoFile(repoRoot, filePath, fileContents);
    const db = openIndexerDatabase();

    try {
      persistParseResult(db, makeManualParseResult({
        filePath,
        fileContents,
        symbols: [
          {
            localName: "value",
            kind: SymbolKind.Function,
            signature: "function value(): number",
            startByte: 0,
            endByte: Buffer.byteLength(fileContents, "utf8") + 8,
          },
        ],
      }));

      const valueSymbol = findSymbol(listSymbolsForFile(db, filePath), "value");
      const builder = createSourceBackedCapsuleBuilder({ db, repoRoot });
      const capsule = buildCapsule(builder, {
        query: "value",
        rerankedCandidates: [makeRerankedCandidate(valueSymbol)],
        maxBudget: createCharacterBudget(5_000),
      });

      assert.equal(capsule.pivots.length, 1);
      assert.equal(capsule.pivots[0]?.content.mode, CapsuleContentMode.SignatureOnly);
      assert.equal(capsule.pivots[0]?.content.signature, valueSymbol.signature);
      assert.equal(capsule.truncated, false);
    } finally {
      db.close();
    }
  });
});

test("source-backed builder remains deterministic and enforces budgets after loading real source", async () => {
  await withTempRepo(async (repoRoot) => {
    const filePath = "src/session.ts";
    const fileContents = `export class SessionManager {\n  createSession(accountId: string): string {\n    return accountId.repeat(2);\n  }\n}\n`;
    await writeRepoFile(repoRoot, filePath, fileContents);
    const db = openIndexerDatabase();

    try {
      persistParseResult(db, makeManualParseResult({
        filePath,
        fileContents,
        symbols: [
          {
            localName: "SessionManager",
            kind: SymbolKind.Class,
            signature: "class SessionManager",
            startByte: 0,
            endByte: Buffer.byteLength(fileContents, "utf8") - 1,
            docstring: "Coordinates session creation and persistence.",
          },
        ],
      }));

      const sessionManager = findSymbol(listSymbolsForFile(db, filePath), "SessionManager");
      const candidate = makeRerankedCandidate(sessionManager);
      const builder = createSourceBackedCapsuleBuilder({ db, repoRoot });
      const maxBudget = createCharacterBudget(
        "session".length + computeExpectedSummaryPivotCost(candidate, sessionManager.docstring!),
      );

      const first = buildCapsule(builder, {
        query: "session",
        rerankedCandidates: [candidate],
        maxBudget,
      });
      const second = buildCapsule(builder, {
        query: "session",
        rerankedCandidates: [candidate],
        maxBudget,
      });

      assert.deepEqual(second, first);
      assert.equal(first.pivots.length, 1);
      assert.equal(first.pivots[0]?.content.mode, CapsuleContentMode.Summary);
      assert.equal(first.pivots[0]?.sourceBacked, undefined);
      assert.deepEqual(first.pivots[0]?.inclusionReasons.at(-1), {
        kind: CapsuleInclusionReasonKind.BudgetCompression,
        originalMode: CapsuleContentMode.Full,
        appliedMode: CapsuleContentMode.Summary,
      });
      assert.equal(first.budget.usedCharacters, first.budget.maxCharacters);
      assert.equal(first.compressed, true);
      assert.equal(first.truncated, false);
    } finally {
      db.close();
    }
  });
});

test("mixed Python/Cython capsule assembly stays deterministic and source-backs safe pivots", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      const first = buildMixedFixtureCapsule(db, repoRoot, "concentration");
      const second = buildMixedFixtureCapsule(db, repoRoot, "concentration");

      assert.deepEqual(second, first);
      assert.deepEqual(
        first.pivots.map((item) => [item.localName, item.filePath, item.content.mode, item.sourceBacked]),
        [
          ["diffuse_profile", "src/spectra_lab/kernels/diffusion_kernels.pyx", CapsuleContentMode.Full, true],
          ["declared_step", "src/spectra_lab/kernels/diffusion.pxd", CapsuleContentMode.Full, true],
        ],
      );
      assert.equal(first.supportingItems.length, 1);
      assert.equal(first.supportingItems.every((item) => item.content.mode !== CapsuleContentMode.Full), true);
      assert.equal(first.supportingItems[0]?.localName, "stencil_smooth");
      assert.equal(first.supportingItems[0]?.content.mode, CapsuleContentMode.Skeleton);
      assert.equal(first.compressed, true);
      assert.equal(first.truncated, true);
    } finally {
      db.close();
    }
  });
});

async function withTempRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vexb-capsule-builder-"));

  try {
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function writeRepoFile(repoRoot: string, filePath: string, contents: string): Promise<void> {
  const absolutePath = path.join(repoRoot, filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
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
        edgeType: EdgeType.Contains,
        relatedSymbolIds: [relatedSymbolId],
      },
      {
        kind: CapsuleInclusionReasonKind.QueryCoverage,
        note: "Supports the primary session path.",
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

function computeExpectedSummaryPivotCost(
  candidate: GraphSearchResult,
  summary: string,
): number {
  const item: PivotCapsuleItem = {
    symbolId: candidate.symbolId,
    filePath: candidate.filePath,
    fqName: candidate.fqName,
    localName: candidate.localName,
    kind: candidate.kind,
    role: CapsuleItemRole.Pivot,
    inclusionReasons: [
      {
        kind: CapsuleInclusionReasonKind.LexicalMatch,
        matchedFields: [SymbolSearchMatchField.LocalName, SymbolSearchMatchField.FQName],
      },
      {
        kind: CapsuleInclusionReasonKind.BudgetCompression,
        originalMode: CapsuleContentMode.Full,
        appliedMode: CapsuleContentMode.Summary,
      },
    ],
    content: {
      mode: CapsuleContentMode.Summary,
      summary,
      signature: "class SessionManager",
    },
    budgetCost: 0,
    compressed: true,
    lexicalScore: candidate.lexicalScore,
    graphScore: candidate.graphScore,
    finalScore: candidate.finalScore,
  };

  item.budgetCost = computeCapsuleItemCost(item);
  return item.budgetCost;
}

function makeManualParseResult(input: {
  filePath: string;
  fileContents: string;
  symbols: Array<{
    localName: string;
    kind: SymbolKind;
    signature: string;
    startByte: number;
    endByte: number;
    docstring?: string;
  }>;
}): ParseResult {
  const fileBytes = Buffer.from(input.fileContents, "utf8");

  return {
    file: {
      id: computeFileId(input.filePath),
      path: input.filePath,
      language: Language.TypeScript,
      contentHash: createHash("sha256").update(fileBytes).digest("hex"),
      sizeBytes: fileBytes.length,
    },
    symbols: input.symbols.map((symbol) => {
      const fqName = buildFQName({
        filePath: input.filePath,
        symbolPath: [symbol.localName],
      });

      return {
        id: computeSymbolId({
          filePath: input.filePath,
          fqName,
          kind: symbol.kind,
          startByte: symbol.startByte,
          endByte: symbol.endByte,
        }),
        filePath: input.filePath,
        fqName,
        localName: symbol.localName,
        kind: symbol.kind,
        signature: symbol.signature,
        startLine: 1,
        endLine: 1,
        startByte: symbol.startByte,
        endByte: symbol.endByte,
        exported: true,
        ...(symbol.docstring === undefined ? {} : { docstring: symbol.docstring }),
      };
    }),
    edges: [],
    diagnostics: [],
  };
}
