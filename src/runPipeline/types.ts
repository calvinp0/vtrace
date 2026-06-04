import { QueryIntent } from "../intent/types";

export const RUN_PIPELINE_SCHEMA_VERSION = "run_pipeline.vnext/1" as const;

export const RunPipelinePresetIntent = Object.freeze({
  Auto: "auto",
  Explore: "explore",
  Debug: "debug",
  Modify: "modify",
  Refactor: "refactor",
});

export type RunPipelinePresetIntent =
  (typeof RunPipelinePresetIntent)[keyof typeof RunPipelinePresetIntent];

export const RUN_PIPELINE_CONCRETE_PRESETS = Object.freeze([
  RunPipelinePresetIntent.Explore,
  RunPipelinePresetIntent.Debug,
  RunPipelinePresetIntent.Modify,
  RunPipelinePresetIntent.Refactor,
] as const);

export type RunPipelineConcretePreset =
  (typeof RUN_PIPELINE_CONCRETE_PRESETS)[number];

export const RunPipelineIntentSource = Object.freeze({
  Explicit: "explicit",
  AutoPhraseTrigger: "auto_phrase_trigger",
  AutoClassifier: "auto_classifier",
  AutoDefault: "auto_default",
});

export type RunPipelineIntentSource =
  (typeof RunPipelineIntentSource)[keyof typeof RunPipelineIntentSource];

export const RunPipelineEditGoal = Object.freeze({
  ExploreCodebase: "explore_codebase",
  InvestigateFailure: "investigate_failure",
  ModifyFeature: "modify_feature",
  RefactorApi: "refactor_api",
});

export type RunPipelineEditGoal =
  (typeof RunPipelineEditGoal)[keyof typeof RunPipelineEditGoal];

export interface RunPipelineIntentDecision {
  readonly requested: RunPipelinePresetIntent;
  readonly selected: RunPipelineConcretePreset;
  readonly source: RunPipelineIntentSource;
  readonly rationale: string;
  readonly mappedQueryIntent: QueryIntent;
  readonly editGoal: RunPipelineEditGoal;
  readonly fallbackApplied: boolean;
}

export const RunPipelineContextSkipReason = Object.freeze({
  NoCandidates: "no_candidates",
  AllCandidatesOmitted: "all_candidates_omitted",
  UnsupportedQueryShape: "unsupported_query_shape",
});

export type RunPipelineContextSkipReason =
  (typeof RunPipelineContextSkipReason)[keyof typeof RunPipelineContextSkipReason];

export const RunPipelineImpactSkipReason = Object.freeze({
  NotRefactorLike: "not_refactor_like",
  NoFocalSymbol: "no_focal_symbol",
  MultipleFocalSymbols: "multiple_focal_symbols",
  NoDependents: "no_dependents",
  ImpactError: "impact_error",
  CrossRepoImpactUnsupported: "cross_repo_impact_unsupported",
});

export type RunPipelineImpactSkipReason =
  (typeof RunPipelineImpactSkipReason)[keyof typeof RunPipelineImpactSkipReason];

export const RunPipelineFlowSkipReason = Object.freeze({
  UnsupportedQueryShape: "unsupported_query_shape",
  NotEnoughEndpoints: "not_enough_endpoints",
  AmbiguousEndpoints: "ambiguous_endpoints",
  EndpointsNotConnected: "endpoints_not_connected",
  FlowError: "flow_error",
});

export type RunPipelineFlowSkipReason =
  (typeof RunPipelineFlowSkipReason)[keyof typeof RunPipelineFlowSkipReason];

export const RunPipelineFlowEndpointStrategy = Object.freeze({
  DirectionalCue: "directional_cue",
  BidirectionalProbe: "bidirectional_probe",
});

export type RunPipelineFlowEndpointStrategy =
  (typeof RunPipelineFlowEndpointStrategy)[keyof typeof RunPipelineFlowEndpointStrategy];

export const RunPipelineSessionSkipReason = Object.freeze({
  NoSessionRequested: "no_session_requested",
  SessionEmpty: "session_empty",
});

export type RunPipelineSessionSkipReason =
  (typeof RunPipelineSessionSkipReason)[keyof typeof RunPipelineSessionSkipReason];

export const RunPipelineDurableMemorySkipReason = Object.freeze({
  QueryUnsupported: "query_unsupported",
  NoMatches: "no_matches",
  IntentDeemphasized: "intent_deemphasized",
});

export type RunPipelineDurableMemorySkipReason =
  (typeof RunPipelineDurableMemorySkipReason)[keyof typeof RunPipelineDurableMemorySkipReason];

export const RunPipelineDeferredKind = Object.freeze({
  ContextCapsule: "context_capsule",
  ImpactGraph: "impact_graph",
  LogicFlow: "logic_flow",
  SessionContext: "session_context",
  DurableMemory: "durable_memory",
});

export type RunPipelineDeferredKind =
  (typeof RunPipelineDeferredKind)[keyof typeof RunPipelineDeferredKind];

export interface RunPipelineDeferredPlaceholder {
  readonly id: string;
  readonly hash: string;
  readonly kind: RunPipelineDeferredKind;
  readonly summary: string;
  readonly suggestedTool: string;
  readonly suggestedInput: Readonly<Record<string, unknown>>;
}
