import { CapsuleContentMode } from "../capsule/types";
import { QueryIntent } from "../intent/types";
import {
  CapsuleBudgetAllocationPolicy,
  CapsulePivotSupportBalancePolicy,
  CapsuleProfileId,
  CapsuleSupportSelectionPolicyId,
  type CapsuleBudgetSplitSettings,
  type CapsuleProfile,
} from "./types";

export const DEFAULT_CAPSULE_PROFILE_INTENT = QueryIntent.Explain;
export const DEFAULT_CAPSULE_PROFILE_ID = CapsuleProfileId.ExplainStable;

export const CAPSULE_PROFILES = Object.freeze({
  [QueryIntent.Debug]: makeCapsuleProfile({
    id: CapsuleProfileId.DebugTight,
    targetIntent: QueryIntent.Debug,
    maxPivotCount: 2,
    maxSupportCount: 2,
    pivotSupportBalancePolicy: CapsulePivotSupportBalancePolicy.PivotFirst,
    supportSelectionPolicy: CapsuleSupportSelectionPolicyId.ConservativeDirect,
    preferredPivotContentModes: freezeModes([
      CapsuleContentMode.Full,
      CapsuleContentMode.Summary,
      CapsuleContentMode.SignatureOnly,
    ]),
    preferredSupportContentModes: freezeModes([
      CapsuleContentMode.SignatureOnly,
      CapsuleContentMode.Stub,
    ]),
    pivotFallbackLadder: freezeModes([
      CapsuleContentMode.Full,
      CapsuleContentMode.Summary,
      CapsuleContentMode.SignatureOnly,
      CapsuleContentMode.Stub,
    ]),
    supportFallbackLadder: freezeModes([
      CapsuleContentMode.SignatureOnly,
      CapsuleContentMode.Stub,
    ]),
    budgetAllocationPolicy: CapsuleBudgetAllocationPolicy.PivotWeighted,
    budgetSplit: makeBudgetSplit({ pivotFraction: 0.75, supportFraction: 0.25 }),
    description: "Tight bug-fixing capsule with few pivots and conservative support expansion.",
  }),
  [QueryIntent.Refactor]: makeCapsuleProfile({
    id: CapsuleProfileId.RefactorStructural,
    targetIntent: QueryIntent.Refactor,
    maxPivotCount: 3,
    maxSupportCount: 5,
    pivotSupportBalancePolicy: CapsulePivotSupportBalancePolicy.SupportExpanded,
    supportSelectionPolicy: CapsuleSupportSelectionPolicyId.StructuralBroad,
    preferredPivotContentModes: freezeModes([
      CapsuleContentMode.Full,
      CapsuleContentMode.Summary,
    ]),
    preferredSupportContentModes: freezeModes([
      CapsuleContentMode.Summary,
      CapsuleContentMode.SignatureOnly,
      CapsuleContentMode.Stub,
    ]),
    pivotFallbackLadder: freezeModes([
      CapsuleContentMode.Full,
      CapsuleContentMode.Summary,
      CapsuleContentMode.SignatureOnly,
      CapsuleContentMode.Stub,
    ]),
    supportFallbackLadder: freezeModes([
      CapsuleContentMode.Summary,
      CapsuleContentMode.SignatureOnly,
      CapsuleContentMode.Stub,
    ]),
    budgetAllocationPolicy: CapsuleBudgetAllocationPolicy.SupportWeighted,
    budgetSplit: makeBudgetSplit({ pivotFraction: 0.45, supportFraction: 0.55 }),
    description: "Structural refactor capsule with broader surrounding-context support.",
  }),
  [QueryIntent.Explain]: makeCapsuleProfile({
    id: CapsuleProfileId.ExplainStable,
    targetIntent: QueryIntent.Explain,
    maxPivotCount: 2,
    maxSupportCount: 3,
    pivotSupportBalancePolicy: CapsulePivotSupportBalancePolicy.Balanced,
    supportSelectionPolicy: CapsuleSupportSelectionPolicyId.LowNoiseStable,
    preferredPivotContentModes: freezeModes([
      CapsuleContentMode.Full,
      CapsuleContentMode.Summary,
    ]),
    preferredSupportContentModes: freezeModes([
      CapsuleContentMode.Summary,
      CapsuleContentMode.SignatureOnly,
      CapsuleContentMode.Stub,
    ]),
    pivotFallbackLadder: freezeModes([
      CapsuleContentMode.Full,
      CapsuleContentMode.Summary,
      CapsuleContentMode.SignatureOnly,
      CapsuleContentMode.Stub,
    ]),
    supportFallbackLadder: freezeModes([
      CapsuleContentMode.Summary,
      CapsuleContentMode.SignatureOnly,
      CapsuleContentMode.Stub,
    ]),
    budgetAllocationPolicy: CapsuleBudgetAllocationPolicy.BalancedSplit,
    budgetSplit: makeBudgetSplit({ pivotFraction: 0.6, supportFraction: 0.4 }),
    description: "Low-noise explanation capsule optimized for stable understanding context.",
  }),
  [QueryIntent.Feature]: makeCapsuleProfile({
    id: CapsuleProfileId.FeatureBalanced,
    targetIntent: QueryIntent.Feature,
    maxPivotCount: 3,
    maxSupportCount: 4,
    pivotSupportBalancePolicy: CapsulePivotSupportBalancePolicy.Balanced,
    supportSelectionPolicy: CapsuleSupportSelectionPolicyId.ExtensionBalanced,
    preferredPivotContentModes: freezeModes([
      CapsuleContentMode.Full,
      CapsuleContentMode.Summary,
    ]),
    preferredSupportContentModes: freezeModes([
      CapsuleContentMode.SignatureOnly,
      CapsuleContentMode.Summary,
      CapsuleContentMode.Stub,
    ]),
    pivotFallbackLadder: freezeModes([
      CapsuleContentMode.Full,
      CapsuleContentMode.Summary,
      CapsuleContentMode.SignatureOnly,
      CapsuleContentMode.Stub,
    ]),
    supportFallbackLadder: freezeModes([
      CapsuleContentMode.SignatureOnly,
      CapsuleContentMode.Summary,
      CapsuleContentMode.Stub,
    ]),
    budgetAllocationPolicy: CapsuleBudgetAllocationPolicy.BalancedSplit,
    budgetSplit: makeBudgetSplit({ pivotFraction: 0.55, supportFraction: 0.45 }),
    description: "Balanced feature capsule with broader extension-oriented support context.",
  }),
}) satisfies Record<QueryIntent, CapsuleProfile>;

export function getCapsuleProfile(intent: QueryIntent): CapsuleProfile | undefined {
  return CAPSULE_PROFILES[intent];
}

export function getDefaultCapsuleProfile(): CapsuleProfile {
  return CAPSULE_PROFILES[DEFAULT_CAPSULE_PROFILE_INTENT];
}

function makeCapsuleProfile(profile: CapsuleProfile): CapsuleProfile {
  return Object.freeze({
    ...profile,
    preferredPivotContentModes: freezeModes(profile.preferredPivotContentModes),
    preferredSupportContentModes: freezeModes(profile.preferredSupportContentModes),
    pivotFallbackLadder: freezeModes(profile.pivotFallbackLadder),
    supportFallbackLadder: freezeModes(profile.supportFallbackLadder),
    ...(profile.budgetSplit === undefined
      ? {}
      : { budgetSplit: makeBudgetSplit(profile.budgetSplit) }),
  });
}

function freezeModes(modes: readonly CapsuleContentMode[]): readonly CapsuleContentMode[] {
  return Object.freeze([...modes]);
}

function makeBudgetSplit(split: CapsuleBudgetSplitSettings): CapsuleBudgetSplitSettings {
  return Object.freeze({
    pivotFraction: split.pivotFraction,
    supportFraction: split.supportFraction,
  });
}
