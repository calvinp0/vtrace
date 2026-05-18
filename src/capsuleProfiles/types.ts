import type { BuildCapsuleInput } from "../capsule/buildCapsule";
import { CapsuleContentMode } from "../capsule/types";
import type { IntentClassificationResult, QueryIntent } from "../intent/types";

export enum CapsuleProfileId {
  DebugTight = "debug_tight",
  RefactorStructural = "refactor_structural",
  ExplainStable = "explain_stable",
  FeatureBalanced = "feature_balanced",
}

export enum CapsulePivotSupportBalancePolicy {
  PivotFirst = "pivot_first",
  Balanced = "balanced",
  SupportExpanded = "support_expanded",
}

export enum CapsuleSupportSelectionPolicyId {
  ConservativeDirect = "conservative_direct",
  StructuralBroad = "structural_broad",
  LowNoiseStable = "low_noise_stable",
  ExtensionBalanced = "extension_balanced",
}

export enum CapsuleBudgetAllocationPolicy {
  PivotWeighted = "pivot_weighted",
  BalancedSplit = "balanced_split",
  SupportWeighted = "support_weighted",
}

export interface CapsuleBudgetSplitSettings {
  readonly pivotFraction: number;
  readonly supportFraction: number;
}

export interface CapsuleProfile {
  readonly id: CapsuleProfileId;
  readonly targetIntent: QueryIntent;
  readonly maxPivotCount: number;
  readonly maxSupportCount: number;
  readonly pivotSupportBalancePolicy: CapsulePivotSupportBalancePolicy;
  readonly supportSelectionPolicy: CapsuleSupportSelectionPolicyId;
  readonly preferredPivotContentModes: readonly CapsuleContentMode[];
  readonly preferredSupportContentModes: readonly CapsuleContentMode[];
  readonly pivotFallbackLadder: readonly CapsuleContentMode[];
  readonly supportFallbackLadder: readonly CapsuleContentMode[];
  readonly budgetAllocationPolicy: CapsuleBudgetAllocationPolicy;
  readonly budgetSplit?: CapsuleBudgetSplitSettings;
  readonly description: string;
}

export interface CapsuleProfileSettingsSummary {
  readonly maxPivotCount: number;
  readonly maxSupportCount: number;
  readonly pivotSupportBalancePolicy: CapsulePivotSupportBalancePolicy;
  readonly supportSelectionPolicy: CapsuleSupportSelectionPolicyId;
  readonly preferredPivotContentModes: readonly CapsuleContentMode[];
  readonly preferredSupportContentModes: readonly CapsuleContentMode[];
  readonly pivotFallbackLadder: readonly CapsuleContentMode[];
  readonly supportFallbackLadder: readonly CapsuleContentMode[];
  readonly budgetAllocationPolicy: CapsuleBudgetAllocationPolicy;
  readonly budgetSplit?: CapsuleBudgetSplitSettings;
}

export enum CapsuleProfileSelectionReasonKind {
  IntentProfileMatch = "intent_profile_match",
  MissingProfileFallback = "missing_profile_fallback",
}

export interface CapsuleProfileSelectionExplanation {
  readonly reasonKind: CapsuleProfileSelectionReasonKind;
  readonly fallbackApplied: boolean;
  readonly summary: string;
}

export interface CapsuleProfileSelectionResult {
  readonly classification: IntentClassificationResult;
  readonly intent: QueryIntent;
  readonly profile: CapsuleProfile;
  readonly settingsSummary: CapsuleProfileSettingsSummary;
  readonly explanation: CapsuleProfileSelectionExplanation;
}

export interface SelectCapsuleProfileInput {
  readonly classification: IntentClassificationResult;
}

export interface CapsuleProfileSelector {
  select(input: SelectCapsuleProfileInput): CapsuleProfileSelectionResult;
}

export enum CapsuleBuilderDelegateTarget {
  ExistingCapsuleBuilder = "existing_capsule_builder",
}

export interface CapsuleBuilderDelegationPlan {
  readonly target: CapsuleBuilderDelegateTarget;
  readonly summary: string;
}

export interface PrepareCapsuleAssemblyInput {
  readonly classification: IntentClassificationResult;
  readonly builderInput: BuildCapsuleInput;
}

export interface PreparedCapsuleAssembly {
  readonly query: string;
  readonly selection: CapsuleProfileSelectionResult;
  readonly builderInput: BuildCapsuleInput;
  readonly delegate: CapsuleBuilderDelegationPlan;
}

export interface CapsuleAssemblyOrchestrator {
  prepare(input: PrepareCapsuleAssemblyInput): PreparedCapsuleAssembly;
}
