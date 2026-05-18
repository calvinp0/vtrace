import type { HandoffMetadataInput, ResolvedHandoffMetadata } from "./metadata";
import { resolveHandoffMetadata } from "./metadata";
import type {
  HandoffCapsulePayload,
  HandoffPayload,
  IntentAwareCapsulePipelineResult,
} from "./types";

export interface BuildHandoffInput {
  readonly pipeline: IntentAwareCapsulePipelineResult;
  readonly metadata?: HandoffMetadataInput;
}

export interface ResolvedBuildHandoffInput {
  readonly pipeline: IntentAwareCapsulePipelineResult;
  readonly metadata: ResolvedHandoffMetadata;
}

export interface HandoffBuilder {
  build(input: ResolvedBuildHandoffInput): HandoffPayload;
}

export enum HandoffBuilderDelegateTarget {
  DeterministicPackager = "deterministic_packager",
}

export interface HandoffBuilderDelegationPlan {
  readonly target: HandoffBuilderDelegateTarget;
  readonly summary: string;
}

export interface PreparedHandoffBuild {
  readonly builderInput: ResolvedBuildHandoffInput;
  readonly delegate: HandoffBuilderDelegationPlan;
}

export interface HandoffOrchestrator {
  prepare(input: BuildHandoffInput): PreparedHandoffBuild;
}

export const DEFAULT_HANDOFF_BUILDER_DELEGATION = Object.freeze({
  target: HandoffBuilderDelegateTarget.DeterministicPackager,
  summary:
    "Handoff metadata normalized; delegate the existing intent-aware capsule pipeline result to the deterministic handoff packager.",
}) satisfies HandoffBuilderDelegationPlan;

export const deterministicHandoffBuilder = createDeterministicHandoffBuilder();
export const defaultHandoffOrchestrator = createHandoffOrchestrator();

export function createHandoffOrchestrator(): HandoffOrchestrator {
  return {
    prepare(input) {
      return prepareHandoffBuild(input);
    },
  };
}

export function prepareHandoffBuild(input: BuildHandoffInput): PreparedHandoffBuild {
  return {
    builderInput: {
      pipeline: input.pipeline,
      metadata: resolveHandoffMetadata(input.metadata),
    },
    delegate: DEFAULT_HANDOFF_BUILDER_DELEGATION,
  };
}

export function buildHandoffPayload(
  builder: HandoffBuilder,
  input: BuildHandoffInput,
): HandoffPayload {
  const prepared = prepareHandoffBuild(input);

  return builder.build(prepared.builderInput);
}

export function createDeterministicHandoffBuilder(): HandoffBuilder {
  return {
    build(input) {
      return makeHandoffPayload(input);
    },
  };
}

function makeHandoffPayload(input: ResolvedBuildHandoffInput): HandoffPayload {
  const { pipeline, metadata } = input;
  const capsuleProfileSelection = pipeline.capsuleProfileSelection;

  return {
    schema: metadata.schema,
    query: pipeline.routedQuery.query,
    selectedIntent: pipeline.routedQuery.intent,
    classification: structuredClone(pipeline.routedQuery.classification),
    routingProfile: makeHandoffRoutingProfile(pipeline),
    capsuleProfile: makeHandoffCapsuleProfile(capsuleProfileSelection),
    capsule: makeHandoffCapsule(pipeline.capsule),
    provenance: {
      ...metadata.provenance,
      generation: structuredClone(metadata.provenance.generation),
    },
    trust: {
      capsuleStaleness:
        metadata.trust.capsuleStaleness === null
          ? null
          : structuredClone(metadata.trust.capsuleStaleness),
    },
  };
}

function makeHandoffRoutingProfile(
  pipeline: IntentAwareCapsulePipelineResult,
): HandoffPayload["routingProfile"] {
  return {
    id: pipeline.routedQuery.profile.id,
    backend: pipeline.routedQuery.profile.backend,
    candidatePoolSize: pipeline.routedQuery.profile.candidatePoolSize,
    graphWeights: structuredClone(pipeline.routedQuery.profile.graphWeights),
    summary: pipeline.routedQuery.profile.summary,
  };
}

function makeHandoffCapsuleProfile(
  selection: IntentAwareCapsulePipelineResult["capsuleProfileSelection"],
): HandoffPayload["capsuleProfile"] {
  return {
    id: selection.profile.id,
    targetIntent: selection.profile.targetIntent,
    description: selection.profile.description,
    settingsSummary: structuredClone(selection.settingsSummary),
    explanation: structuredClone(selection.explanation),
  };
}

function makeHandoffCapsule(
  capsule: IntentAwareCapsulePipelineResult["capsule"],
): HandoffCapsulePayload {
  return {
    query: capsule.query,
    items: structuredClone([...capsule.pivots, ...capsule.supportingItems]),
    ...(capsule.memories === undefined ? {} : { memories: structuredClone(capsule.memories) }),
    budget: structuredClone(capsule.budget),
    profileBudgetUsage:
      capsule.profileBudgetUsage === undefined
        ? null
        : structuredClone(capsule.profileBudgetUsage),
    truncated: capsule.truncated,
    compressed: capsule.compressed,
  };
}
