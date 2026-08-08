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
  // The intent did not request impact (distinct from "a focal symbol could not be
  // resolved" and "too many focal symbols matched"). Driven by the resolved
  // normalized intent, not by the presence/absence of magic phrasing.
  NotRequestedByIntent: "not_requested_by_intent",
  NoFocalSymbol: "no_focal_symbol",
  MultipleFocalSymbols: "multiple_focal_symbols",
  NoDependents: "no_dependents",
  ImpactError: "impact_error",
  CrossRepoImpactUnsupported: "cross_repo_impact_unsupported",
});

export type RunPipelineImpactSkipReason =
  (typeof RunPipelineImpactSkipReason)[keyof typeof RunPipelineImpactSkipReason];

/**
 * Why a flow section carries no path.
 *
 * M130 removed `endpoints_not_connected`. Static analysis over one index cannot
 * prove two symbols are semantically unconnected — dynamic dispatch, reflection,
 * unindexed languages and stale snapshots all hide real relationships — so the
 * product no longer makes that claim. Every reason below states a fact about the
 * *search*, not about the code.
 */
export const RunPipelineFlowSkipReason = Object.freeze({
  /** The query shape never requested a flow between two symbols. */
  UnsupportedQueryShape: "unsupported_query_shape",
  /** Fewer than two indexed candidate symbols were named in the query. */
  NotEnoughEndpoints: "not_enough_endpoints",
  /** More than two indexed candidate symbols were named; the pair is undetermined. */
  AmbiguousEndpoints: "ambiguous_endpoints",
  /** The start endpoint name matched no indexed symbol. */
  StartEndpointNotFound: "start_endpoint_not_found",
  /** The end endpoint name matched no indexed symbol. */
  EndEndpointNotFound: "end_endpoint_not_found",
  /** An endpoint name matched several indexed symbols; no arbitrary pick is made. */
  EndpointAmbiguous: "endpoint_ambiguous",
  /** The index is not fresh, so absence of a path carries no information. */
  IndexStale: "index_stale",
  /** An endpoint lives in a language with no call-edge extraction in this build. */
  UnsupportedLanguage: "unsupported_language",
  /** Both endpoints resolved; the current index contains no path between them. */
  NoIndexedPathFound: "no_indexed_path_found",
  /** The bounded traversal budget was exhausted before the search completed. */
  TraversalLimitReached: "traversal_limit_reached",
  /** The flow engine itself failed. */
  FlowError: "flow_error",
});

export type RunPipelineFlowSkipReason =
  (typeof RunPipelineFlowSkipReason)[keyof typeof RunPipelineFlowSkipReason];

/**
 * The scope a negative flow result is claimed over. `current_index` is the only
 * scope the engine can support: it says "not found here, now", never "not connected".
 */
export const RunPipelineFlowClaimScope = Object.freeze({
  CurrentIndex: "current_index",
});

export type RunPipelineFlowClaimScope =
  (typeof RunPipelineFlowClaimScope)[keyof typeof RunPipelineFlowClaimScope];

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
