import assert from "node:assert/strict";
import { test } from "bun:test";

import { EdgeType, SymbolKind } from "../domain/types";
import {
  GraphScoreSignal,
  SymbolSearchMatchField,
  SymbolSearchMatchType,
  type GraphSearchResult,
} from "../retrieval/types";
import { buildCapsule, deterministicCapsuleBuilder } from "./buildCapsule";
import { computeCapsuleItemCost, computeTotalCapsuleCost, createCharacterBudget } from "./budget";
import {
  CapsuleContentMode,
  CapsuleInclusionReasonKind,
  CapsuleItemRole,
  type CapsuleSupportingCandidate,
  type PivotCapsuleItem,
  type SupportCapsuleItem,
} from "./types";

type TestRerankedCandidate = GraphSearchResult & {
  source?: string;
  signature?: string;
  summary?: string;
  docstring?: string;
  stub?: string;
};

type TestSupportingCandidate = CapsuleSupportingCandidate & {
  signature?: string;
  summary?: string;
  docstring?: string;
  stub?: string;
};

test("top reranked candidates become pivots in provided order", () => {
  const query = "session";
  const rerankedCandidates = [
    makeRerankedCandidate({
      symbolId: "sym-session-manager",
      filePath: "src/session/manager.ts",
      fqName: "src/session/manager.ts::SessionManager",
      localName: "SessionManager",
      kind: SymbolKind.Class,
      lexicalScore: 120,
      graphScore: 6,
      finalScore: 126,
      source: "export class SessionManager { create(): void {} }",
      signature: "class SessionManager",
      graphContributions: [
        {
          signal: GraphScoreSignal.ContainsNeighborhood,
          scoreContribution: 6,
          relatedSymbolIds: ["sym-create-session"],
        },
      ],
    }),
    makeRerankedCandidate({
      symbolId: "sym-session-store",
      filePath: "src/session/store.ts",
      fqName: "src/session/store.ts::SessionStore",
      localName: "SessionStore",
      kind: SymbolKind.Class,
      lexicalScore: 90,
      graphScore: 0,
      finalScore: 90,
      signature: "class SessionStore",
    }),
  ];

  const capsule = buildCapsule(deterministicCapsuleBuilder, {
    query,
    rerankedCandidates,
    maxBudget: createCharacterBudget(5_000),
  });

  assert.deepEqual(
    capsule.pivots.map((item) => item.symbolId),
    rerankedCandidates.map((candidate) => candidate.symbolId),
  );
  assert.equal(capsule.pivots.every((item) => item.role === CapsuleItemRole.Pivot), true);
  assert.equal(capsule.pivots[0]?.content.mode, CapsuleContentMode.Full);
  assert.equal(capsule.pivots[1]?.content.mode, CapsuleContentMode.SignatureOnly);
  assert.deepEqual(capsule.pivots[0]?.inclusionReasons[0], {
    kind: CapsuleInclusionReasonKind.LexicalMatch,
    matchedFields: [SymbolSearchMatchField.LocalName, SymbolSearchMatchField.FQName],
  });
  assert.deepEqual(capsule.pivots[0]?.inclusionReasons[1], {
    kind: CapsuleInclusionReasonKind.GraphConnection,
    graphSignals: [GraphScoreSignal.ContainsNeighborhood],
    relatedSymbolIds: ["sym-create-session"],
  });
});

test("support items are added only after pivots and preserve provided support order", () => {
  const query = "session";
  const rerankedCandidates = [
    makeRerankedCandidate({
      symbolId: "sym-a",
      localName: "AlphaPivot",
      fqName: "src/a.ts::AlphaPivot",
      filePath: "src/a.ts",
      source: "export class AlphaPivot {}",
      signature: "class AlphaPivot",
    }),
    makeRerankedCandidate({
      symbolId: "sym-b",
      localName: "BetaPivot",
      fqName: "src/b.ts::BetaPivot",
      filePath: "src/b.ts",
      signature: "class BetaPivot",
    }),
  ];
  const supportingCandidates = [
    makeSupportingCandidate({
      symbolId: "sym-support-second",
      localName: "LaterSupport",
      fqName: "src/support.ts::LaterSupport",
      filePath: "src/support.ts",
      finalScore: 1,
      signature: "LaterSupport(): void",
    }),
    makeSupportingCandidate({
      symbolId: "sym-support-first",
      localName: "EarlierSupport",
      fqName: "src/support.ts::EarlierSupport",
      filePath: "src/support.ts",
      finalScore: 999,
      signature: "EarlierSupport(): void",
    }),
  ];

  const capsule = buildCapsule(deterministicCapsuleBuilder, {
    query,
    rerankedCandidates,
    supportingCandidates,
    maxBudget: createCharacterBudget(5_000),
  });

  assert.deepEqual(
    capsule.pivots.map((item) => item.symbolId),
    ["sym-a", "sym-b"],
  );
  assert.deepEqual(
    capsule.supportingItems.map((item) => item.symbolId),
    ["sym-support-second", "sym-support-first"],
  );
  assert.equal(capsule.supportingItems.every((item) => item.role === CapsuleItemRole.Support), true);
  assert.equal(
    [...capsule.pivots, ...capsule.supportingItems].map((item) => item.symbolId).join(","),
    "sym-a,sym-b,sym-support-second,sym-support-first",
  );
});

test("budget enforcement downgrades pivots deterministically and skips later items when necessary", () => {
  const query = "session creation";
  const rerankedCandidates = [
    makeRerankedCandidate({
      symbolId: "sym-manager",
      localName: "SessionManager",
      fqName: "src/session/service.ts::SessionManager",
      filePath: "src/session/service.ts",
      source: "export class SessionManager { createSession(accountId: string): Session { return createStoredSession(accountId); } }",
      signature: "class SessionManager",
      docstring: "Coordinates session creation and persistence.",
      graphContributions: [
        {
          signal: GraphScoreSignal.ContainsNeighborhood,
          scoreContribution: 8,
          relatedSymbolIds: ["sym-create-session"],
        },
      ],
    }),
    makeRerankedCandidate({
      symbolId: "sym-store",
      localName: "SessionStore",
      fqName: "src/session/store.ts::SessionStore",
      filePath: "src/session/store.ts",
      source: "export class SessionStore { save(): void {} }",
      signature: "class SessionStore",
    }),
  ];
  const supportingCandidates = [
    makeSupportingCandidate({
      symbolId: "sym-create-session",
      localName: "createSession",
      fqName: "src/session/service.ts::SessionManager.createSession",
      filePath: "src/session/service.ts",
      signature: "createSession(accountId: string): Session",
      inclusionReasons: [
        {
          kind: CapsuleInclusionReasonKind.StructuralSupport,
          edgeType: EdgeType.Contains,
          relatedSymbolIds: ["sym-manager"],
        },
      ],
    }),
  ];
  const downgradedPivotCost = computeExpectedDowngradedPivotCost(rerankedCandidates[0]!);

  const capsule = buildCapsule(deterministicCapsuleBuilder, {
    query,
    rerankedCandidates,
    supportingCandidates,
    maxBudget: createCharacterBudget(query.length + downgradedPivotCost),
  });

  assert.equal(capsule.pivots.length, 1);
  assert.equal(capsule.supportingItems.length, 0);
  assert.equal(capsule.pivots[0]?.symbolId, "sym-manager");
  assert.equal(capsule.pivots[0]?.content.mode, CapsuleContentMode.Summary);
  assert.equal(capsule.pivots[0]?.compressed, true);
  assert.deepEqual(capsule.pivots[0]?.inclusionReasons.at(-1), {
    kind: CapsuleInclusionReasonKind.BudgetCompression,
    originalMode: CapsuleContentMode.Full,
    appliedMode: CapsuleContentMode.Summary,
  });
  assert.equal(capsule.truncated, true);
  assert.equal(capsule.compressed, true);
  assert.equal(capsule.budget.usedCharacters, capsule.budget.maxCharacters);
  assert.equal(computeTotalCapsuleCost(capsule), capsule.budget.usedCharacters);
});

test("support items downgrade from signature-only to stub when only the stub fits", () => {
  const query = "support";
  const supportingCandidate = makeSupportingCandidate({
    symbolId: "sym-support",
    localName: "SupportHook",
    fqName: "src/support/hook.ts::SupportHook",
    filePath: "src/support/hook.ts",
    signature: "SupportHook(input: SupportRequest, context: SupportContext): Promise<SupportResult>",
    inclusionReasons: [
      {
        kind: CapsuleInclusionReasonKind.StructuralSupport,
        edgeType: EdgeType.Imports,
        relatedSymbolIds: ["sym-pivot"],
      },
    ],
  });
  const stubCost = computeExpectedStubSupportCost(supportingCandidate);

  const capsule = buildCapsule(deterministicCapsuleBuilder, {
    query,
    rerankedCandidates: [],
    supportingCandidates: [supportingCandidate],
    maxBudget: createCharacterBudget(query.length + stubCost),
  });

  assert.equal(capsule.supportingItems.length, 1);
  assert.equal(capsule.supportingItems[0]?.content.mode, CapsuleContentMode.Stub);
  assert.deepEqual(capsule.supportingItems[0]?.inclusionReasons.at(-1), {
    kind: CapsuleInclusionReasonKind.BudgetCompression,
    originalMode: CapsuleContentMode.SignatureOnly,
    appliedMode: CapsuleContentMode.Stub,
  });
});

test("repeated runs with identical input produce identical capsules", () => {
  const input = {
    query: "session",
    rerankedCandidates: [
      makeRerankedCandidate({
        symbolId: "sym-repeat-a",
        localName: "RepeatAlpha",
        fqName: "src/repeat/a.ts::RepeatAlpha",
        filePath: "src/repeat/a.ts",
        source: "export class RepeatAlpha {}",
        signature: "class RepeatAlpha",
      }),
      makeRerankedCandidate({
        symbolId: "sym-repeat-b",
        localName: "RepeatBeta",
        fqName: "src/repeat/b.ts::RepeatBeta",
        filePath: "src/repeat/b.ts",
        signature: "class RepeatBeta",
      }),
    ],
    supportingCandidates: [
      makeSupportingCandidate({
        symbolId: "sym-repeat-support",
        localName: "RepeatSupport",
        fqName: "src/repeat/support.ts::RepeatSupport",
        filePath: "src/repeat/support.ts",
        signature: "RepeatSupport(): void",
      }),
    ],
    maxBudget: createCharacterBudget(5_000),
  } as const;

  const first = buildCapsule(deterministicCapsuleBuilder, input);
  const second = buildCapsule(deterministicCapsuleBuilder, input);

  assert.deepEqual(second, first);
});

test("builder preserves provided order instead of performing new reranking or traversal", () => {
  const query = "order";
  const rerankedCandidates = [
    makeRerankedCandidate({
      symbolId: "sym-low-score-first",
      localName: "LowScoreFirst",
      fqName: "src/order/first.ts::LowScoreFirst",
      filePath: "src/order/first.ts",
      signature: "class LowScoreFirst",
      lexicalScore: 10,
      graphScore: 0,
      finalScore: 10,
    }),
    makeRerankedCandidate({
      symbolId: "sym-high-score-second",
      localName: "HighScoreSecond",
      fqName: "src/order/second.ts::HighScoreSecond",
      filePath: "src/order/second.ts",
      signature: "class HighScoreSecond",
      lexicalScore: 200,
      graphScore: 50,
      finalScore: 250,
      graphContributions: [
        {
          signal: GraphScoreSignal.ConnectedMatchedCandidates,
          scoreContribution: 50,
          relatedSymbolIds: ["sym-low-score-first"],
        },
      ],
    }),
  ];
  const supportingCandidates = [
    makeSupportingCandidate({
      symbolId: "sym-support-low",
      localName: "SupportLow",
      fqName: "src/order/support.ts::SupportLow",
      filePath: "src/order/support.ts",
      finalScore: 0,
      signature: "SupportLow(): void",
    }),
    makeSupportingCandidate({
      symbolId: "sym-support-high",
      localName: "SupportHigh",
      fqName: "src/order/support.ts::SupportHigh",
      filePath: "src/order/support.ts",
      finalScore: 999,
      signature: "SupportHigh(): void",
    }),
  ];

  const capsule = buildCapsule(deterministicCapsuleBuilder, {
    query,
    rerankedCandidates,
    supportingCandidates,
    maxBudget: createCharacterBudget(5_000),
  });

  assert.deepEqual(
    capsule.pivots.map((item) => item.symbolId),
    ["sym-low-score-first", "sym-high-score-second"],
  );
  assert.deepEqual(
    capsule.supportingItems.map((item) => item.symbolId),
    ["sym-support-low", "sym-support-high"],
  );
});

function computeExpectedDowngradedPivotCost(candidate: TestRerankedCandidate): number {
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
        kind: CapsuleInclusionReasonKind.GraphConnection,
        graphSignals: [GraphScoreSignal.ContainsNeighborhood],
        relatedSymbolIds: ["sym-create-session"],
      },
      {
        kind: CapsuleInclusionReasonKind.BudgetCompression,
        originalMode: CapsuleContentMode.Full,
        appliedMode: CapsuleContentMode.Summary,
      },
    ],
    content: {
      mode: CapsuleContentMode.Summary,
      summary: candidate.docstring!,
      signature: candidate.signature,
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

function computeExpectedStubSupportCost(candidate: TestSupportingCandidate): number {
  const item: SupportCapsuleItem = {
    symbolId: candidate.symbolId,
    filePath: candidate.filePath,
    fqName: candidate.fqName,
    localName: candidate.localName,
    kind: candidate.kind,
    role: CapsuleItemRole.Support,
    inclusionReasons: [
      ...candidate.inclusionReasons,
      {
        kind: CapsuleInclusionReasonKind.BudgetCompression,
        originalMode: CapsuleContentMode.SignatureOnly,
        appliedMode: CapsuleContentMode.Stub,
      },
    ],
    content: {
      mode: CapsuleContentMode.Stub,
      stub: candidate.localName,
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

function makeRerankedCandidate(overrides: Partial<TestRerankedCandidate> = {}): TestRerankedCandidate {
  return {
    symbolId: "sym-default",
    filePath: "src/default.ts",
    fqName: "src/default.ts::DefaultSymbol",
    localName: "DefaultSymbol",
    kind: SymbolKind.Class,
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
    ...overrides,
  };
}

function makeSupportingCandidate(
  overrides: Partial<TestSupportingCandidate> = {},
): TestSupportingCandidate {
  return {
    symbolId: "sym-support-default",
    filePath: "src/support.ts",
    fqName: "src/support.ts::SupportDefault",
    localName: "SupportDefault",
    kind: SymbolKind.Function,
    lexicalScore: 20,
    graphScore: 4,
    finalScore: 24,
    inclusionReasons: [
      {
        kind: CapsuleInclusionReasonKind.StructuralSupport,
        edgeType: EdgeType.Contains,
        relatedSymbolIds: ["sym-default"],
      },
    ],
    ...overrides,
  };
}
