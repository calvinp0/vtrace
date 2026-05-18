import { QueryIntent } from "../intent/types";
import {
  CAPSULE_PROFILES,
  DEFAULT_CAPSULE_PROFILE_ID,
  getDefaultCapsuleProfile,
} from "./profiles";
import {
  CapsuleProfileSelectionReasonKind,
  type CapsuleProfile,
  type CapsuleProfileSelectionResult,
  type CapsuleProfileSelector,
  type CapsuleProfileSettingsSummary,
  type SelectCapsuleProfileInput,
} from "./types";

export interface CapsuleProfileSelectorOptions {
  profiles?: Partial<Record<QueryIntent, CapsuleProfile>>;
  defaultProfile?: CapsuleProfile;
}

// Missing profile mappings stay conservative by falling back to the explain capsule profile.
export const DEFAULT_CAPSULE_PROFILE_SELECTION_POLICY = Object.freeze({
  defaultProfileId: DEFAULT_CAPSULE_PROFILE_ID,
  summary: `No capsule profile was configured for the classified intent; defaulting to ${DEFAULT_CAPSULE_PROFILE_ID}.`,
});

export const defaultCapsuleProfileSelector = createCapsuleProfileSelector();

export function createCapsuleProfileSelector(
  options: CapsuleProfileSelectorOptions = {},
): CapsuleProfileSelector {
  const profiles = options.profiles ?? CAPSULE_PROFILES;
  const defaultProfile = options.defaultProfile ?? getDefaultCapsuleProfile();

  return {
    select(input) {
      return selectCapsuleProfile(input, { profiles, defaultProfile });
    },
  };
}

export function selectCapsuleProfile(
  input: SelectCapsuleProfileInput,
  options: CapsuleProfileSelectorOptions = {},
): CapsuleProfileSelectionResult {
  const profiles = options.profiles ?? CAPSULE_PROFILES;
  const defaultProfile = options.defaultProfile ?? getDefaultCapsuleProfile();
  const matchedProfile = profiles[input.classification.intent];
  const profile = matchedProfile ?? defaultProfile;
  const fallbackApplied = matchedProfile === undefined;

  return {
    classification: input.classification,
    intent: input.classification.intent,
    profile,
    settingsSummary: summarizeCapsuleProfile(profile),
    explanation: {
      reasonKind: fallbackApplied
        ? CapsuleProfileSelectionReasonKind.MissingProfileFallback
        : CapsuleProfileSelectionReasonKind.IntentProfileMatch,
      fallbackApplied,
      summary: fallbackApplied
        ? `No capsule profile was configured for intent ${input.classification.intent}; defaulting to ${defaultProfile.id}.`
        : `Selected capsule profile ${profile.id} for intent ${input.classification.intent}.`,
    },
  };
}

export function summarizeCapsuleProfile(profile: CapsuleProfile): CapsuleProfileSettingsSummary {
  return {
    maxPivotCount: profile.maxPivotCount,
    maxSupportCount: profile.maxSupportCount,
    pivotSupportBalancePolicy: profile.pivotSupportBalancePolicy,
    supportSelectionPolicy: profile.supportSelectionPolicy,
    preferredPivotContentModes: Object.freeze([...profile.preferredPivotContentModes]),
    preferredSupportContentModes: Object.freeze([...profile.preferredSupportContentModes]),
    pivotFallbackLadder: Object.freeze([...profile.pivotFallbackLadder]),
    supportFallbackLadder: Object.freeze([...profile.supportFallbackLadder]),
    budgetAllocationPolicy: profile.budgetAllocationPolicy,
    ...(profile.budgetSplit === undefined
      ? {}
      : {
        budgetSplit: Object.freeze({
          pivotFraction: profile.budgetSplit.pivotFraction,
          supportFraction: profile.budgetSplit.supportFraction,
        }),
      }),
  };
}
