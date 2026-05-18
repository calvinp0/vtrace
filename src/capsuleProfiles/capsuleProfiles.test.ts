import assert from "node:assert/strict";
import { test } from "bun:test";

import { CapsuleBudgetModel, CapsuleContentMode } from "../capsule/types";
import {
  IntentClassificationReasonKind,
  QueryIntent,
  type IntentClassificationResult,
} from "../intent/types";
import {
  createCapsuleAssemblyOrchestrator,
  DEFAULT_CAPSULE_BUILDER_DELEGATION,
  prepareCapsuleAssembly,
} from "./orchestrator";
import {
  CAPSULE_PROFILES,
  DEFAULT_CAPSULE_PROFILE_ID,
  DEFAULT_CAPSULE_PROFILE_INTENT,
} from "./profiles";
import {
  createCapsuleProfileSelector,
  DEFAULT_CAPSULE_PROFILE_SELECTION_POLICY,
  selectCapsuleProfile,
} from "./selectProfile";
import {
  CapsuleBudgetAllocationPolicy,
  CapsuleBuilderDelegateTarget,
  CapsulePivotSupportBalancePolicy,
  CapsuleProfileId,
  CapsuleProfileSelectionReasonKind,
  CapsuleSupportSelectionPolicyId,
} from "./types";

test("each intent maps to the expected capsule profile", () => {
  assert.deepEqual(
    [
      QueryIntent.Debug,
      QueryIntent.Refactor,
      QueryIntent.Explain,
      QueryIntent.Feature,
    ].map((intent) => {
      const result = selectCapsuleProfile({
        classification: makeClassification(intent),
      });

      return {
        intent: result.intent,
        profileId: result.profile.id,
        maxPivotCount: result.profile.maxPivotCount,
        maxSupportCount: result.profile.maxSupportCount,
      };
    }),
    [
      {
        intent: QueryIntent.Debug,
        profileId: CapsuleProfileId.DebugTight,
        maxPivotCount: 2,
        maxSupportCount: 2,
      },
      {
        intent: QueryIntent.Refactor,
        profileId: CapsuleProfileId.RefactorStructural,
        maxPivotCount: 3,
        maxSupportCount: 5,
      },
      {
        intent: QueryIntent.Explain,
        profileId: CapsuleProfileId.ExplainStable,
        maxPivotCount: 2,
        maxSupportCount: 3,
      },
      {
        intent: QueryIntent.Feature,
        profileId: CapsuleProfileId.FeatureBalanced,
        maxPivotCount: 3,
        maxSupportCount: 4,
      },
    ],
  );
});

test("capsule profile definitions are explicit and stable", () => {
  assert.equal(DEFAULT_CAPSULE_PROFILE_INTENT, QueryIntent.Explain);
  assert.equal(DEFAULT_CAPSULE_PROFILE_ID, CapsuleProfileId.ExplainStable);
  assert.deepEqual(
    Object.values(CAPSULE_PROFILES).map((profile) => ({
      id: profile.id,
      targetIntent: profile.targetIntent,
      balance: profile.pivotSupportBalancePolicy,
      supportPolicy: profile.supportSelectionPolicy,
      budgetPolicy: profile.budgetAllocationPolicy,
      preferredPivotContentModes: profile.preferredPivotContentModes,
      preferredSupportContentModes: profile.preferredSupportContentModes,
    })),
    [
      {
        id: CapsuleProfileId.DebugTight,
        targetIntent: QueryIntent.Debug,
        balance: CapsulePivotSupportBalancePolicy.PivotFirst,
        supportPolicy: CapsuleSupportSelectionPolicyId.ConservativeDirect,
        budgetPolicy: CapsuleBudgetAllocationPolicy.PivotWeighted,
        preferredPivotContentModes: [
          CapsuleContentMode.Full,
          CapsuleContentMode.Summary,
          CapsuleContentMode.SignatureOnly,
        ],
        preferredSupportContentModes: [
          CapsuleContentMode.SignatureOnly,
          CapsuleContentMode.Stub,
        ],
      },
      {
        id: CapsuleProfileId.RefactorStructural,
        targetIntent: QueryIntent.Refactor,
        balance: CapsulePivotSupportBalancePolicy.SupportExpanded,
        supportPolicy: CapsuleSupportSelectionPolicyId.StructuralBroad,
        budgetPolicy: CapsuleBudgetAllocationPolicy.SupportWeighted,
        preferredPivotContentModes: [
          CapsuleContentMode.Full,
          CapsuleContentMode.Summary,
        ],
        preferredSupportContentModes: [
          CapsuleContentMode.Summary,
          CapsuleContentMode.SignatureOnly,
          CapsuleContentMode.Stub,
        ],
      },
      {
        id: CapsuleProfileId.ExplainStable,
        targetIntent: QueryIntent.Explain,
        balance: CapsulePivotSupportBalancePolicy.Balanced,
        supportPolicy: CapsuleSupportSelectionPolicyId.LowNoiseStable,
        budgetPolicy: CapsuleBudgetAllocationPolicy.BalancedSplit,
        preferredPivotContentModes: [
          CapsuleContentMode.Full,
          CapsuleContentMode.Summary,
        ],
        preferredSupportContentModes: [
          CapsuleContentMode.Summary,
          CapsuleContentMode.SignatureOnly,
          CapsuleContentMode.Stub,
        ],
      },
      {
        id: CapsuleProfileId.FeatureBalanced,
        targetIntent: QueryIntent.Feature,
        balance: CapsulePivotSupportBalancePolicy.Balanced,
        supportPolicy: CapsuleSupportSelectionPolicyId.ExtensionBalanced,
        budgetPolicy: CapsuleBudgetAllocationPolicy.BalancedSplit,
        preferredPivotContentModes: [
          CapsuleContentMode.Full,
          CapsuleContentMode.Summary,
        ],
        preferredSupportContentModes: [
          CapsuleContentMode.SignatureOnly,
          CapsuleContentMode.Summary,
          CapsuleContentMode.Stub,
        ],
      },
    ],
  );
});

test("fallback default profile behavior is deterministic", () => {
  const selector = createCapsuleProfileSelector({
    profiles: {
      [QueryIntent.Debug]: CAPSULE_PROFILES[QueryIntent.Debug],
    },
  });
  const result = selector.select({
    classification: makeClassification(QueryIntent.Feature, "add support"),
  });

  assert.equal(DEFAULT_CAPSULE_PROFILE_SELECTION_POLICY.defaultProfileId, CapsuleProfileId.ExplainStable);
  assert.equal(result.intent, QueryIntent.Feature);
  assert.equal(result.profile.id, CapsuleProfileId.ExplainStable);
  assert.equal(result.explanation.reasonKind, CapsuleProfileSelectionReasonKind.MissingProfileFallback);
  assert.equal(result.explanation.fallbackApplied, true);
  assert.equal(
    result.explanation.summary,
    "No capsule profile was configured for intent feature; defaulting to explain_stable.",
  );
});

test("repeated identical input produces identical profile selection output", () => {
  const input = {
    classification: makeClassification(QueryIntent.Refactor, "refactor session manager"),
  };
  const first = selectCapsuleProfile(input);
  const second = selectCapsuleProfile(input);

  assert.deepEqual(second, first);
});

test("profile selection explanations are structured and inspectable", () => {
  const result = selectCapsuleProfile({
    classification: makeClassification(QueryIntent.Debug, "fix auth redirect bug"),
  });

  assert.deepEqual(result, {
    classification: makeClassification(QueryIntent.Debug, "fix auth redirect bug"),
    intent: QueryIntent.Debug,
    profile: CAPSULE_PROFILES[QueryIntent.Debug],
    settingsSummary: {
      maxPivotCount: 2,
      maxSupportCount: 2,
      pivotSupportBalancePolicy: CapsulePivotSupportBalancePolicy.PivotFirst,
      supportSelectionPolicy: CapsuleSupportSelectionPolicyId.ConservativeDirect,
      preferredPivotContentModes: [
        CapsuleContentMode.Full,
        CapsuleContentMode.Summary,
        CapsuleContentMode.SignatureOnly,
      ],
      preferredSupportContentModes: [
        CapsuleContentMode.SignatureOnly,
        CapsuleContentMode.Stub,
      ],
      pivotFallbackLadder: [
        CapsuleContentMode.Full,
        CapsuleContentMode.Summary,
        CapsuleContentMode.SignatureOnly,
        CapsuleContentMode.Stub,
      ],
      supportFallbackLadder: [
        CapsuleContentMode.SignatureOnly,
        CapsuleContentMode.Stub,
      ],
      budgetAllocationPolicy: CapsuleBudgetAllocationPolicy.PivotWeighted,
      budgetSplit: {
        pivotFraction: 0.75,
        supportFraction: 0.25,
      },
    },
    explanation: {
      reasonKind: CapsuleProfileSelectionReasonKind.IntentProfileMatch,
      fallbackApplied: false,
      summary: "Selected capsule profile debug_tight for intent debug.",
    },
  });
});

test("orchestration contract prepares future builder delegation without redesign", () => {
  const builderInput = {
    query: "explain indexing flow",
    rerankedCandidates: [],
    supportingCandidates: [],
    maxBudget: {
      model: CapsuleBudgetModel.CharacterCount,
      maxCharacters: 2_000,
    },
  };
  const orchestrator = createCapsuleAssemblyOrchestrator();
  const prepared = orchestrator.prepare({
    classification: makeClassification(QueryIntent.Explain, builderInput.query),
    builderInput,
  });

  assert.deepEqual(prepared, prepareCapsuleAssembly({
    classification: makeClassification(QueryIntent.Explain, builderInput.query),
    builderInput,
  }));
  assert.equal(prepared.query, builderInput.query);
  assert.equal(prepared.selection.profile.id, CapsuleProfileId.ExplainStable);
  assert.deepEqual(prepared.builderInput, {
    ...builderInput,
    profileSelection: prepared.selection,
  });
  assert.equal(prepared.delegate.target, CapsuleBuilderDelegateTarget.ExistingCapsuleBuilder);
  assert.deepEqual(prepared.delegate, DEFAULT_CAPSULE_BUILDER_DELEGATION);
});

function makeClassification(
  intent: QueryIntent,
  query = `${intent} query`,
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
