import { defaultCapsuleProfileSelector } from "./selectProfile";
import {
  CapsuleBuilderDelegateTarget,
  type CapsuleAssemblyOrchestrator,
  type CapsuleBuilderDelegationPlan,
  type CapsuleProfileSelector,
  type PreparedCapsuleAssembly,
  type PrepareCapsuleAssemblyInput,
} from "./types";

export interface CapsuleAssemblyOrchestratorOptions {
  selector?: CapsuleProfileSelector;
}

export const DEFAULT_CAPSULE_BUILDER_DELEGATION = Object.freeze({
  target: CapsuleBuilderDelegateTarget.ExistingCapsuleBuilder,
  summary: "Profile selection complete; delegate the profile-shaped builder input to the existing capsule builder.",
}) satisfies CapsuleBuilderDelegationPlan;

export const defaultCapsuleAssemblyOrchestrator = createCapsuleAssemblyOrchestrator();

export function createCapsuleAssemblyOrchestrator(
  options: CapsuleAssemblyOrchestratorOptions = {},
): CapsuleAssemblyOrchestrator {
  const selector = options.selector ?? defaultCapsuleProfileSelector;

  return {
    prepare(input) {
      return prepareCapsuleAssembly(input, selector);
    },
  };
}

export function prepareCapsuleAssembly(
  input: PrepareCapsuleAssemblyInput,
  selector: CapsuleProfileSelector = defaultCapsuleProfileSelector,
): PreparedCapsuleAssembly {
  const selection = selector.select({
    classification: input.classification,
  });

  return {
    query: input.builderInput.query,
    selection,
    builderInput: {
      ...input.builderInput,
      profileSelection: selection,
    },
    delegate: DEFAULT_CAPSULE_BUILDER_DELEGATION,
  };
}
