import type { CapsuleProfileSelectionResult } from "../capsuleProfiles/types";
import type { GraphSearchResult } from "../retrieval/types";
import type { Capsule, CapsuleBudget, CapsuleSupportingCandidate } from "./types";

export interface BuildCapsuleInput {
  query: string;
  rerankedCandidates: readonly GraphSearchResult[];
  supportingCandidates?: readonly CapsuleSupportingCandidate[];
  maxBudget: CapsuleBudget;
  profileSelection?: CapsuleProfileSelectionResult;
}

export interface CapsuleBuilder {
  build(input: BuildCapsuleInput): Capsule;
}

export function buildCapsule(
  builder: CapsuleBuilder,
  input: BuildCapsuleInput,
): Capsule {
  return builder.build(input);
}

export {
  createSourceBackedCapsuleBuilder,
  deterministicCapsuleBuilder,
} from "./buildCapsuleImpl";
