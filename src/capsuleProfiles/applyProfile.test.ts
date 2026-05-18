import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildCapsule, deterministicCapsuleBuilder, type BuildCapsuleInput } from "../capsule/buildCapsule";
import { createCharacterBudget } from "../capsule/budget";
import {
  CapsuleContentMode,
  CapsuleInclusionReasonKind,
  type Capsule,
  type CapsuleSupportingCandidate,
} from "../capsule/types";
import { EdgeType, SymbolKind } from "../domain/types";
import {
  GraphScoreSignal,
  SymbolSearchMatchField,
  SymbolSearchMatchType,
  type GraphSearchResult,
} from "../retrieval/types";
import { prepareCapsuleAssembly } from "./orchestrator";
import { CapsuleProfileId } from "./types";
import {
  IntentClassificationReasonKind,
  QueryIntent,
  type IntentClassificationResult,
} from "../intent/types";

test("profile changes affect max pivot and support counts deterministically", () => {
  const builderInput = makeBuilderInput({
    maxBudget: createCharacterBudget(20_000),
  });

  const debugCapsule = buildProfiledCapsule(QueryIntent.Debug, builderInput);
  const refactorCapsule = buildProfiledCapsule(QueryIntent.Refactor, builderInput);

  assert.equal(debugCapsule.profileSelection?.profile.id, CapsuleProfileId.DebugTight);
  assert.equal(debugCapsule.pivots.length, 2);
  assert.equal(debugCapsule.supportingItems.length, 2);
  assert.equal(refactorCapsule.profileSelection?.profile.id, CapsuleProfileId.RefactorStructural);
  assert.equal(refactorCapsule.pivots.length, 3);
  assert.equal(refactorCapsule.supportingItems.length, 5);
});

test("debug_tight produces a tighter capsule than refactor_structural on the same input", () => {
  const builderInput = makeBuilderInput({
    maxBudget: createCharacterBudget(20_000),
  });

  const debugCapsule = buildProfiledCapsule(QueryIntent.Debug, builderInput);
  const refactorCapsule = buildProfiledCapsule(QueryIntent.Refactor, builderInput);

  assert.equal(
    debugCapsule.pivots.length + debugCapsule.supportingItems.length
      < refactorCapsule.pivots.length + refactorCapsule.supportingItems.length,
    true,
  );
  assert.equal(debugCapsule.truncated, true);
  assert.equal(refactorCapsule.truncated, true);
});

test("explain_stable remains more conservative than feature_balanced on the same input", () => {
  const builderInput = makeBuilderInput({
    maxBudget: createCharacterBudget(20_000),
  });

  const explainCapsule = buildProfiledCapsule(QueryIntent.Explain, builderInput);
  const featureCapsule = buildProfiledCapsule(QueryIntent.Feature, builderInput);

  assert.equal(explainCapsule.profileSelection?.profile.id, CapsuleProfileId.ExplainStable);
  assert.equal(featureCapsule.profileSelection?.profile.id, CapsuleProfileId.FeatureBalanced);
  assert.equal(explainCapsule.supportingItems.length, 3);
  assert.equal(featureCapsule.supportingItems.length, 4);
  assert.equal(explainCapsule.supportingItems.every((item) => item.content.mode === CapsuleContentMode.Summary), true);
  assert.equal(featureCapsule.supportingItems.every((item) => item.content.mode === CapsuleContentMode.SignatureOnly), true);
});

test("content-mode preferences and fallback ladders are applied deterministically", () => {
  const ampleBudgetInput = makeBuilderInput({
    query: "session",
    rerankedCandidates: [],
    supportingCandidates: [
      makeSupportingCandidate({
        symbolId: "sym-fallback-support",
        localName: "FallbackSupport",
        fqName: "src/support/fallback.ts::FallbackSupport",
        filePath: "src/support/fallback.ts",
        signature: "FallbackSupport(sessionId: string): Promise<void>",
        summary: "FallbackSupport documents the broader session recovery flow in detail for explain-oriented capsules.",
      }),
    ],
    maxBudget: createCharacterBudget(5_000),
  });

  const explainAmple = buildProfiledCapsule(QueryIntent.Explain, ampleBudgetInput);
  const featureAmple = buildProfiledCapsule(QueryIntent.Feature, ampleBudgetInput);
  const explainSummaryCost = explainAmple.supportingItems[0]!.budgetCost;
  const featureSignatureCost = featureAmple.supportingItems[0]!.budgetCost;
  const constrainedBudget = findFirstExplainSignatureBudget(ampleBudgetInput);

  const explainConstrained = buildProfiledCapsule(QueryIntent.Explain, {
    ...ampleBudgetInput,
    maxBudget: constrainedBudget,
  });
  const featureConstrained = buildProfiledCapsule(QueryIntent.Feature, {
    ...ampleBudgetInput,
    maxBudget: constrainedBudget,
  });
  const explainSupportBudgetMax = explainConstrained.profileBudgetUsage?.supportCharactersMax;

  assert.notEqual(explainSupportBudgetMax, undefined);
  assert.equal(explainSummaryCost > explainSupportBudgetMax!, true);
  assert.equal(featureSignatureCost <= featureConstrained.profileBudgetUsage!.supportCharactersMax!, true);
  assert.equal(explainConstrained.supportingItems[0]?.content.mode, CapsuleContentMode.SignatureOnly);
  assert.deepEqual(explainConstrained.supportingItems[0]?.inclusionReasons.at(-1), {
    kind: CapsuleInclusionReasonKind.BudgetCompression,
    originalMode: CapsuleContentMode.Summary,
    appliedMode: CapsuleContentMode.SignatureOnly,
  });
  assert.equal(featureConstrained.supportingItems[0]?.content.mode, CapsuleContentMode.SignatureOnly);
  assert.notDeepEqual(
    featureConstrained.supportingItems[0]?.inclusionReasons.at(-1),
    {
      kind: CapsuleInclusionReasonKind.BudgetCompression,
      originalMode: CapsuleContentMode.Summary,
      appliedMode: CapsuleContentMode.SignatureOnly,
    },
  );
});

test("support-item inclusion order follows the selected profile policy deterministically", () => {
  const builderInput = makeBuilderInput({
    rerankedCandidates: [],
    supportingCandidates: [
      makeSupportingCandidate({
        symbolId: "sym-direct-best",
        localName: "DirectBest",
        fqName: "src/support/direct.ts::DirectBest",
        filePath: "src/support/direct.ts",
        finalScore: 100,
        graphScore: 1,
        inclusionReasons: [
          {
            kind: CapsuleInclusionReasonKind.StructuralSupport,
            edgeType: EdgeType.Contains,
            relatedSymbolIds: ["sym-pivot-a"],
          },
        ],
      }),
      makeSupportingCandidate({
        symbolId: "sym-structural-best",
        localName: "StructuralBest",
        fqName: "src/support/structural.ts::StructuralBest",
        filePath: "src/support/structural.ts",
        finalScore: 40,
        graphScore: 8,
        inclusionReasons: [
          {
            kind: CapsuleInclusionReasonKind.StructuralSupport,
            edgeType: EdgeType.Contains,
            relatedSymbolIds: ["sym-pivot-a", "sym-pivot-b", "sym-pivot-c"],
          },
        ],
      }),
    ],
    maxBudget: createCharacterBudget(5_000),
  });

  const debugCapsule = buildProfiledCapsule(QueryIntent.Debug, builderInput);
  const refactorCapsule = buildProfiledCapsule(QueryIntent.Refactor, builderInput);

  assert.equal(debugCapsule.supportingItems[0]?.localName, "DirectBest");
  assert.equal(refactorCapsule.supportingItems[0]?.localName, "StructuralBest");
});

test("repeated identical input produces identical profile-aware capsules", () => {
  const builderInput = makeBuilderInput({
    maxBudget: createCharacterBudget(5_000),
  });

  const first = buildProfiledCapsule(QueryIntent.Feature, builderInput);
  const second = buildProfiledCapsule(QueryIntent.Feature, builderInput);

  assert.deepEqual(second, first);
});

test("the same shared builder supports both unprofiled and profiled assembly", () => {
  const builderInput = makeBuilderInput({
    query: "session",
    rerankedCandidates: [],
    supportingCandidates: [
      makeSupportingCandidate({
        symbolId: "sym-shared-builder",
        localName: "SharedBuilderSupport",
        fqName: "src/support/shared.ts::SharedBuilderSupport",
        filePath: "src/support/shared.ts",
        signature: "SharedBuilderSupport(sessionId: string): Promise<void>",
        summary: "SharedBuilderSupport explains the full session extension flow for profile-aware capsules.",
      }),
    ],
    maxBudget: createCharacterBudget(5_000),
  });

  const unprofiled = buildCapsule(deterministicCapsuleBuilder, builderInput);
  const explainProfiled = buildProfiledCapsule(QueryIntent.Explain, builderInput);

  assert.equal(unprofiled.profileSelection, undefined);
  assert.equal(unprofiled.supportingItems[0]?.content.mode, CapsuleContentMode.SignatureOnly);
  assert.equal(explainProfiled.profileSelection?.profile.id, CapsuleProfileId.ExplainStable);
  assert.equal(explainProfiled.supportingItems[0]?.content.mode, CapsuleContentMode.Summary);
});

function buildProfiledCapsule(
  intent: QueryIntent,
  builderInput: BuildCapsuleInput,
): Capsule {
  const prepared = prepareCapsuleAssembly({
    classification: makeClassification(intent, builderInput.query),
    builderInput,
  });

  return buildCapsule(deterministicCapsuleBuilder, prepared.builderInput);
}

function makeBuilderInput(
  overrides: Partial<BuildCapsuleInput> = {},
): BuildCapsuleInput {
  return {
    query: "session",
    rerankedCandidates: [
      makeRerankedCandidate({
        symbolId: "sym-pivot-a",
        localName: "SessionManager",
        fqName: "src/session/manager.ts::SessionManager",
        filePath: "src/session/manager.ts",
        source: "export class SessionManager { createSession(): void {} }",
        signature: "class SessionManager",
      }),
      makeRerankedCandidate({
        symbolId: "sym-pivot-b",
        localName: "SessionStore",
        fqName: "src/session/store.ts::SessionStore",
        filePath: "src/session/store.ts",
        source: "export class SessionStore { saveSession(): void {} }",
        signature: "class SessionStore",
      }),
      makeRerankedCandidate({
        symbolId: "sym-pivot-c",
        localName: "SessionController",
        fqName: "src/session/controller.ts::SessionController",
        filePath: "src/session/controller.ts",
        source: "export class SessionController { constructor(): void {} }",
        signature: "class SessionController",
      }),
      makeRerankedCandidate({
        symbolId: "sym-pivot-d",
        localName: "SessionView",
        fqName: "src/session/view.ts::SessionView",
        filePath: "src/session/view.ts",
        source: "export class SessionView { render(): void {} }",
        signature: "class SessionView",
      }),
    ],
    supportingCandidates: [
      makeSupportingCandidate({
        symbolId: "sym-support-a",
        localName: "SessionTypes",
        fqName: "src/session/types.ts::SessionTypes",
        filePath: "src/session/types.ts",
        signature: "SessionTypes(sessionId: string): Promise<void>",
        summary: "SessionTypes documents the shared session model and its validation flow for architecture questions.",
        finalScore: 50,
      }),
      makeSupportingCandidate({
        symbolId: "sym-support-b",
        localName: "SessionAudit",
        fqName: "src/session/audit.ts::SessionAudit",
        filePath: "src/session/audit.ts",
        signature: "SessionAudit(sessionId: string): Promise<void>",
        summary: "SessionAudit documents the audit trail and failure-handling hooks around session lifecycle management.",
        finalScore: 45,
      }),
      makeSupportingCandidate({
        symbolId: "sym-support-c",
        localName: "SessionFormatter",
        fqName: "src/session/formatter.ts::SessionFormatter",
        filePath: "src/session/formatter.ts",
        signature: "SessionFormatter(sessionId: string): Promise<void>",
        summary: "SessionFormatter documents the output formatting path and the extension points used by callers.",
        finalScore: 40,
      }),
      makeSupportingCandidate({
        symbolId: "sym-support-d",
        localName: "SessionHooks",
        fqName: "src/session/hooks.ts::SessionHooks",
        filePath: "src/session/hooks.ts",
        signature: "SessionHooks(sessionId: string): Promise<void>",
        summary: "SessionHooks documents the hook registration path and the nearby extension points for feature work.",
        finalScore: 35,
      }),
      makeSupportingCandidate({
        symbolId: "sym-support-e",
        localName: "SessionMetrics",
        fqName: "src/session/metrics.ts::SessionMetrics",
        filePath: "src/session/metrics.ts",
        signature: "SessionMetrics(sessionId: string): Promise<void>",
        summary: "SessionMetrics documents the metrics pipeline and the reporting context around session behavior.",
        finalScore: 30,
      }),
    ],
    maxBudget: createCharacterBudget(5_000),
    ...overrides,
  };
}

function makeClassification(
  intent: QueryIntent,
  query: string,
): IntentClassificationResult {
  return {
    query,
    intent,
    strength: 3,
    candidates: [
      {
        intent,
        strength: 3,
        matchedRuleIds: [`${intent}-rule`],
      },
    ],
    explanation: {
      reasonKind: IntentClassificationReasonKind.RuleMatch,
      fallbackApplied: false,
      summary: `Selected intent ${intent} from matched rule evidence.`,
      matchedRules: [
        {
          ruleId: `${intent}-rule`,
          targetIntent: intent,
          priority: 1,
          strength: 3,
          explanation: `${intent} rule matched.`,
          matchedTerms: [intent],
        },
      ],
    },
  };
}

function findFirstExplainSignatureBudget(input: BuildCapsuleInput) {
  for (
    let maxCharacters = input.query.length;
    maxCharacters <= input.maxBudget.maxCharacters;
    maxCharacters += 1
  ) {
    const capsule = buildProfiledCapsule(QueryIntent.Explain, {
      ...input,
      maxBudget: createCharacterBudget(maxCharacters),
    });

    if (capsule.supportingItems[0]?.content.mode === CapsuleContentMode.SignatureOnly) {
      return createCharacterBudget(maxCharacters);
    }
  }

  throw new Error("Expected to find a budget where explain_stable falls back to signature_only.");
}

function makeRerankedCandidate(
  overrides: Partial<GraphSearchResult & {
    source?: string;
    signature?: string;
    summary?: string;
    docstring?: string;
    stub?: string;
  }> = {},
): GraphSearchResult & {
  source?: string;
  signature?: string;
  summary?: string;
  docstring?: string;
  stub?: string;
} {
  return {
    symbolId: "sym-default-pivot",
    filePath: "src/default.ts",
    fqName: "src/default.ts::DefaultPivot",
    localName: "DefaultPivot",
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
    graphScore: 8,
    finalScore: 108,
    graphContributions: [
      {
        signal: GraphScoreSignal.ContainsNeighborhood,
        scoreContribution: 8,
        relatedSymbolIds: ["sym-support-a"],
      },
    ],
    ...overrides,
  };
}

function makeSupportingCandidate(
  overrides: Partial<CapsuleSupportingCandidate & {
    signature?: string;
    summary?: string;
    docstring?: string;
    stub?: string;
  }> = {},
): CapsuleSupportingCandidate & {
  signature?: string;
  summary?: string;
  docstring?: string;
  stub?: string;
} {
  return {
    symbolId: "sym-default-support",
    filePath: "src/support.ts",
    fqName: "src/support.ts::DefaultSupport",
    localName: "DefaultSupport",
    kind: SymbolKind.Function,
    lexicalScore: 20,
    graphScore: 4,
    finalScore: 24,
    inclusionReasons: [
      {
        kind: CapsuleInclusionReasonKind.StructuralSupport,
        edgeType: EdgeType.Contains,
        relatedSymbolIds: ["sym-pivot-a"],
      },
    ],
    ...overrides,
  };
}
