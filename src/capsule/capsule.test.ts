import assert from "node:assert/strict";
import test from "node:test";

import { buildCapsule, type BuildCapsuleInput, type CapsuleBuilder } from "./buildCapsule";
import {
  canAddCapsuleItem,
  computeCapsuleBudgetUsage,
  computeCapsuleItemCost,
  computeTotalCapsuleCost,
  createCharacterBudget,
  wouldExceedBudget,
} from "./budget";
import {
  CapsuleContentMode,
  CapsuleInclusionReasonKind,
  CapsuleItemRole,
  type Capsule,
  type CapsuleSupportingCandidate,
  type PivotCapsuleItem,
  type SupportCapsuleItem,
} from "./types";
import { EdgeType, SymbolKind } from "../domain/types";
import { GraphScoreSignal, SymbolSearchMatchField } from "../retrieval/types";

test("capsule items have expected roles and content modes", () => {
  const pivot = makePivotItem();
  const support = makeSupportItem();

  assert.equal(pivot.role, CapsuleItemRole.Pivot);
  assert.equal(pivot.content.mode, CapsuleContentMode.Full);
  assert.equal(pivot.compressed, false);
  assert.equal(support.role, CapsuleItemRole.Support);
  assert.equal(support.content.mode, CapsuleContentMode.Summary);
  assert.equal(support.compressed, true);
});

test("budget accounting is deterministic", () => {
  const pivot = makePivotItem();

  const first = computeCapsuleItemCost(pivot);
  const second = computeCapsuleItemCost(pivot);

  assert.equal(first, second);
  assert.equal(pivot.budgetCost, first);
});

test("total capsule cost is computed correctly", () => {
  const capsule = makeCapsule();

  assert.equal(
    computeTotalCapsuleCost(capsule),
    capsule.query.length + capsule.pivots[0]!.budgetCost + capsule.supportingItems[0]!.budgetCost,
  );
  assert.deepEqual(
    computeCapsuleBudgetUsage(capsule, createCharacterBudget(500)),
    {
      model: "character_count",
      maxCharacters: 500,
      usedCharacters: computeTotalCapsuleCost(capsule),
      remainingCharacters: 0,
    },
  );
});

test("over-budget checks are deterministic", () => {
  const support = makeSupportItem();
  const budget = createCharacterBudget(support.budgetCost);

  assert.equal(wouldExceedBudget(0, support.budgetCost, budget), false);
  assert.equal(wouldExceedBudget(1, support.budgetCost, budget), true);
  assert.equal(canAddCapsuleItem(0, support, budget), true);
  assert.equal(canAddCapsuleItem(1, support, budget), false);
});

test("Capsule output shape supports both pivot and support items", () => {
  const capsule = makeCapsule();

  assert.equal(capsule.pivots.length, 1);
  assert.equal(capsule.supportingItems.length, 1);
  assert.equal(capsule.pivots[0]?.localName, "SessionManager");
  assert.equal(capsule.supportingItems[0]?.localName, "createSession");
  assert.equal(capsule.truncated, false);
  assert.equal(capsule.compressed, true);
});

test("inclusion reasons are explicit and structured", () => {
  const pivot = makePivotItem();
  const support = makeSupportItem();

  assert.deepEqual(pivot.inclusionReasons[0], {
    kind: CapsuleInclusionReasonKind.LexicalMatch,
    matchedFields: [SymbolSearchMatchField.LocalName, SymbolSearchMatchField.FQName],
  });
  assert.deepEqual(pivot.inclusionReasons[1], {
    kind: CapsuleInclusionReasonKind.GraphConnection,
    graphSignals: [GraphScoreSignal.ContainsNeighborhood],
    relatedSymbolIds: ["sym-method"],
  });
  assert.deepEqual(support.inclusionReasons[0], {
    kind: CapsuleInclusionReasonKind.StructuralSupport,
    edgeType: EdgeType.Contains,
    relatedSymbolIds: ["sym-pivot"],
  });
});

test("builder contract accepts query, reranked candidates, supporting candidates, and max budget", () => {
  const expected = makeCapsule();
  let capturedInput: BuildCapsuleInput | undefined;

  const builder: CapsuleBuilder = {
    build(input) {
      capturedInput = input;
      return expected;
    },
  };

  const result = buildCapsule(builder, {
    query: "session creation",
    rerankedCandidates: [makeRerankedCandidate()],
    supportingCandidates: [makeSupportingCandidate()],
    maxBudget: createCharacterBudget(500),
  });

  assert.equal(result, expected);
  assert.equal(capturedInput?.query, "session creation");
  assert.equal(capturedInput?.rerankedCandidates[0]?.localName, "SessionManager");
  assert.equal(capturedInput?.supportingCandidates?.[0]?.localName, "createSession");
  assert.equal(capturedInput?.maxBudget.maxCharacters, 500);
});

function makeCapsule(): Capsule {
  const pivots = [makePivotItem()];
  const supportingItems = [makeSupportItem()];

  return {
    query: "session creation",
    pivots,
    supportingItems,
    budget: computeCapsuleBudgetUsage(
      { query: "session creation", pivots, supportingItems },
      createCharacterBudget(500),
    ),
    truncated: false,
    compressed: true,
  };
}

function makePivotItem(): PivotCapsuleItem {
  const item: PivotCapsuleItem = {
    symbolId: "sym-pivot",
    filePath: "src/session/service.ts",
    fqName: "src/session/service.ts::SessionManager",
    localName: "SessionManager",
    kind: SymbolKind.Class,
    role: CapsuleItemRole.Pivot,
    inclusionReasons: [
      {
        kind: CapsuleInclusionReasonKind.LexicalMatch,
        matchedFields: [SymbolSearchMatchField.LocalName, SymbolSearchMatchField.FQName],
      },
      {
        kind: CapsuleInclusionReasonKind.GraphConnection,
        graphSignals: [GraphScoreSignal.ContainsNeighborhood],
        relatedSymbolIds: ["sym-method"],
      },
    ],
    content: {
      mode: CapsuleContentMode.Full,
      source: "export class SessionManager { createSession(): void {} }",
    },
    budgetCost: 0,
    compressed: false,
    lexicalScore: 100,
    graphScore: 8,
    finalScore: 108,
  };
  item.budgetCost = computeCapsuleItemCost(item);
  return item;
}

function makeSupportItem(): SupportCapsuleItem {
  const item: SupportCapsuleItem = {
    symbolId: "sym-method",
    filePath: "src/session/service.ts",
    fqName: "src/session/service.ts::SessionManager.createSession",
    localName: "createSession",
    kind: SymbolKind.Method,
    role: CapsuleItemRole.Support,
    inclusionReasons: [
      {
        kind: CapsuleInclusionReasonKind.StructuralSupport,
        edgeType: EdgeType.Contains,
        relatedSymbolIds: ["sym-pivot"],
      },
      {
        kind: CapsuleInclusionReasonKind.BudgetCompression,
        originalMode: CapsuleContentMode.Full,
        appliedMode: CapsuleContentMode.Summary,
      },
      {
        kind: CapsuleInclusionReasonKind.QueryCoverage,
        note: "Implements the session creation path",
      },
    ],
    content: {
      mode: CapsuleContentMode.Summary,
      summary: "Method that creates and persists a session.",
      signature: "createSession(): void",
    },
    budgetCost: 0,
    compressed: true,
    lexicalScore: 40,
    graphScore: 14,
    finalScore: 54,
  };
  item.budgetCost = computeCapsuleItemCost(item);
  return item;
}

function makeSupportingCandidate(): CapsuleSupportingCandidate {
  return {
    symbolId: "sym-method",
    filePath: "src/session/service.ts",
    fqName: "src/session/service.ts::SessionManager.createSession",
    localName: "createSession",
    kind: SymbolKind.Method,
    lexicalScore: 40,
    graphScore: 14,
    finalScore: 54,
    inclusionReasons: [
      {
        kind: CapsuleInclusionReasonKind.StructuralSupport,
        edgeType: EdgeType.Contains,
        relatedSymbolIds: ["sym-pivot"],
      },
    ],
  };
}

function makeRerankedCandidate() {
  return {
    symbolId: "sym-pivot",
    filePath: "src/session/service.ts",
    fqName: "src/session/service.ts::SessionManager",
    localName: "SessionManager",
    kind: SymbolKind.Class,
    matches: [
      {
        field: SymbolSearchMatchField.LocalName,
        matchType: "exact" as const,
        scoreContribution: 100,
      },
    ],
    lexicalScore: 100,
    graphScore: 8,
    finalScore: 108,
    graphContributions: [
      {
        signal: GraphScoreSignal.ContainsNeighborhood,
        scoreContribution: 8,
        count: 1,
        edgeType: EdgeType.Contains,
        relatedSymbolIds: ["sym-method"],
      },
    ],
  };
}
