// @ts-nocheck
import { access } from "node:fs/promises";
import path from "node:path";

import { buildCapsule, createSourceBackedCapsuleBuilder } from "../capsule/buildCapsule";
import { createCharacterBudget } from "../capsule/budget";
import {
  CapsuleBudgetModel,
  CapsuleInclusionReasonKind,
  type Capsule,
  type CapsuleInclusionReason,
  type CapsuleItem,
  type CapsuleSupportingCandidate,
} from "../capsule/types";
import { prepareCapsuleAssembly } from "../capsuleProfiles/orchestrator";
import { buildCapsuleV2 } from "../capsuleV2/buildCapsuleV2";
import {
  capsuleV2ToManifestItemFields,
  toCapsuleV2ProductResponse,
  type CapsuleV2ProductResponse,
} from "../capsuleV2/productAdapter";
import { CapsuleIntent, parseCapsuleIntent } from "../capsuleV2/types";
import {
  getCapsuleManifestById,
  getCapsuleStaleness,
  persistCapsuleManifestBestEffort,
  persistCapsuleV2ManifestBestEffort,
} from "../db/repositories/capsuleManifestsRepository";
import { hasIndexedFiles } from "../db/repositories/filesRepository";
import {
  getIndexRunById,
  getIndexRunSummary,
  getLatestIndexRun,
  listIndexRuns,
} from "../db/repositories/indexRunsRepository";
import { persistObservation } from "../db/repositories/observationsRepository";
import { getSessionById } from "../db/repositories/sessionsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { parseSymbolKind } from "../domain/guards";
import { type SymbolKind } from "../domain/types";
import { buildHandoffPayload, deterministicHandoffBuilder } from "../handoff/buildHandoff";
import type { HandoffPayload } from "../handoff/types";
import {
  IMPACT_FORMATS,
  getImpactGraph,
  type ImpactGraphOutput,
  type ImpactFormat,
} from "../impact/getImpactGraph";
import { routeQuery } from "../intent/routeQuery";
import { normalizeIntentQuery } from "../intent/rules";
import { QueryIntent } from "../intent/types";
import {
  RUN_PIPELINE_DEFAULTS as RUN_PIPELINE_VNEXT_DEFAULTS,
  runPipelineOrchestrator,
  type RunPipelineOrchestration,
} from "../runPipeline/runPipelineOrchestrator";
import {
  compactOrchestrationHash,
  formatRunPipelineCompactContextItem,
  formatRunPipelineOrchestrationOutput,
} from "../runPipeline/formatRunPipelineOutput";
import {
  RUN_PIPELINE_CONCRETE_PRESETS,
  RUN_PIPELINE_SCHEMA_VERSION,
  RunPipelineContextSkipReason,
  RunPipelineDeferredKind,
  RunPipelineDurableMemorySkipReason,
  RunPipelineEditGoal,
  RunPipelineImpactSkipReason,
  RunPipelineIntentSource,
  RunPipelinePresetIntent,
  RunPipelineSessionSkipReason,
} from "../runPipeline/types";
import { isRunPipelinePresetIntent } from "../runPipeline/selectIntent";
import {
  DEFERRED_VEXP_HASH_PATTERN,
  DEFERRED_VEXP_SUPPORTED_CATEGORIES,
  getSharedDeferredVexpStore,
  isSupportedDeferredVexpCategory,
  isValidDeferredVexpHash,
  type DeferredVexpStore,
} from "../runPipeline/deferredVexpStore";
import { resolveDeferredVexpRef } from "../runPipeline/expandDeferredVexpRef";
import {
  searchLogicFlow,
  type LogicFlowOutput,
} from "../logicFlow/searchLogicFlow";
import { getSessionContext } from "../observations/getSessionContext";
import {
  listInspectableSessions,
  readInspectableSession,
} from "../observations/sessionInspection";
import { evaluateObservationNudge } from "../observations/observationNudges";
import {
  captureExpandVexpRefObservationBestEffort,
  captureImpactGraphObservationBestEffort,
  captureLogicFlowObservationBestEffort,
  captureSearchMemoryObservationBestEffort,
  captureSessionContextObservationBestEffort,
  captureSkeletonObservationBestEffort,
  captureVisibleCapsuleObservationBestEffort,
  computeVisibleCapsuleObservationDedupeKey,
} from "../observations/autoCapture";
import { searchMemory } from "../observations/searchMemory";
import { getObservationStaleness } from "../observations/staleness";
import {
  ObservationKind,
  ObservationSource,
  SessionStatus,
  type ObservationSearchResult,
} from "../observations/types";
import { searchSymbols } from "../retrieval/searchSymbols";
import { normalizeSearchQuery } from "../retrieval/searchSymbolsShared";
import {
  SymbolSearchBackend,
  type GraphSearchResult,
  type SymbolSearchResult,
} from "../retrieval/types";
import {
  SKELETON_DETAIL_LEVELS,
  getSkeleton,
  type SkeletonDetailLevel,
} from "../skeleton/getSkeleton";
import {
  readRepoLocalConfig,
  readRepoLocalState,
  resolveRepoLocalPaths,
} from "../setup/repoState";
import type { RepoLocalConfig, RepoLocalState } from "../setup/types";
import { buildFileWatcherStatus } from "../runtime/fileWatcher";
import { inspectIndexFreshness } from "../runtime/indexFreshness";
import { reindexRepoAndRefreshState } from "../runtime/reindexRepo";
import {
  resolveWorkspaceConfigPath,
  safeReadWorkspaceConfig,
  type ResolvedWorkspaceConfig,
  type ResolvedWorkspaceRepoConfig,
} from "../workspace/config";
import { createMcpToolRegistry } from "./registry";
import {
  McpErrorCode,
  McpToolAvailability,
  McpToolHandlerKind,
  McpToolId,
  type McpObjectSchema,
  type McpSchemaProperty,
  type McpServerContext,
  type McpToolDefinition,
  type McpToolExecutionResult,
  type McpToolHandlerInput,
  type McpToolMetadata,
} from "./types";

const MCP_PIPELINE_DEFAULTS = Object.freeze({
  maxResults: 6,
  maxBudgetCharacters: 2_000,
});

// Opt-in Capsule v2 on the product surface. `get_context_capsule` stays on the
// v1 pipeline unless the caller explicitly sets `capsule_engine` (or its camelCase
// alias `capsuleEngine`) to this value. Default behavior is unchanged.
const CAPSULE_ENGINE_V2 = "v2";

// Default token budget for an opt-in Capsule v2 build — matches the CLI capsule
// command's default (generous enough for a couple of pivots plus a ring of
// support). Callers can override with `capsule_budget_tokens`.
const CAPSULE_V2_PRODUCT_DEFAULT_BUDGET_TOKENS = 8_000;

interface IndexRepoInput {
  readonly force?: boolean;
}

interface SearchSymbolsInput {
  readonly query?: string;
  readonly maxResults?: number;
  readonly kind?: string;
  readonly backend?: string;
}

interface RouteQueryInput {
  readonly query?: string;
  readonly maxResults?: number;
}

interface BuildCapsuleInput {
  readonly query?: string;
  readonly maxResults?: number;
  readonly maxBudgetCharacters?: number;
  readonly repos?: readonly string[];
}

interface GetImpactGraphInput {
  readonly symbol_fqn?: string;
  readonly depth?: number;
  readonly cross_repo?: boolean;
  readonly format?: string;
}

interface SearchLogicFlowInput {
  readonly start?: string;
  readonly end?: string;
  readonly max_paths?: number;
  readonly cross_repo?: boolean;
}

interface RunPipelineInput extends BuildCapsuleInput {
  readonly task?: string;
  readonly preset?: string;
  readonly max_tokens?: number;
  readonly include_tests?: boolean;
  readonly include_file_content?: boolean;
  readonly observation?: string;
  readonly intent?: string;
  readonly sessionId?: string;
  readonly saveObservation?: boolean;
  readonly includeMemory?: boolean;
}

const RUN_PIPELINE_DIAGNOSTIC_REASON = Object.freeze({
  NoCandidates: "no_candidates",
  AllCandidatesOmitted: "all_candidates_omitted",
  RepoNotReady: "repo_not_ready",
  UnsupportedQueryShape: "unsupported_query_shape",
});

type RunPipelineDiagnosticReason =
  (typeof RUN_PIPELINE_DIAGNOSTIC_REASON)[keyof typeof RUN_PIPELINE_DIAGNOSTIC_REASON];

const RUN_PIPELINE_FALLBACK_MODE = Object.freeze({
  RelaxedUnprofiledAssembly: "relaxed_unprofiled_assembly",
});

type RunPipelineFallbackMode =
  (typeof RUN_PIPELINE_FALLBACK_MODE)[keyof typeof RUN_PIPELINE_FALLBACK_MODE];

interface RunPipelineDiagnostics {
  readonly initialReason: RunPipelineDiagnosticReason | null;
  readonly fallbackApplied: boolean;
  readonly fallbackMode: RunPipelineFallbackMode | null;
  readonly fallbackRecovered: boolean;
  readonly finalReason: RunPipelineDiagnosticReason | null;
  readonly initialContextItemCount: number;
  readonly finalContextItemCount: number;
  readonly pathSignalsConsidered: readonly string[];
  readonly pathSignalsMatched: readonly string[];
  readonly candidateFilesConsidered: number;
  readonly weakPathCoverage: boolean;
}

const RUN_PIPELINE_IMPACT_TRIGGER_REASON = Object.freeze({
  RefactorIntent: "refactor_intent",
  BlastRadiusPhrase: "blast_radius_phrase",
  WhatBreaksPhrase: "what_breaks_phrase",
  DependentsKeyword: "dependents_keyword",
  PublicApiChangePhrase: "public_api_change_phrase",
});

type RunPipelineImpactTriggerReason =
  (typeof RUN_PIPELINE_IMPACT_TRIGGER_REASON)[keyof typeof RUN_PIPELINE_IMPACT_TRIGGER_REASON];

const RUN_PIPELINE_IMPACT_SELECTION_SOURCE = Object.freeze({
  TopPivotTaskMention: "top_pivot_task_mention",
  RoutedTaskMention: "routed_task_mention",
});

type RunPipelineImpactSelectionSource =
  (typeof RUN_PIPELINE_IMPACT_SELECTION_SOURCE)[keyof typeof RUN_PIPELINE_IMPACT_SELECTION_SOURCE];

interface RunPipelineImpactSummary {
  readonly triggerReason: RunPipelineImpactTriggerReason;
  readonly selectionSource: RunPipelineImpactSelectionSource;
  readonly resolvedSymbol: ImpactGraphOutput["resolvedSymbol"];
  readonly summary: ImpactGraphOutput["summary"];
  readonly topDependents: readonly ImpactGraphOutput["nodes"][number][];
}

type BuildHandoffInput = BuildCapsuleInput;

interface CheckCapsuleStalenessInput {
  readonly manifestId?: string;
  readonly comparisonRunId?: number;
}

interface SaveObservationInput {
  readonly sessionId?: string;
  readonly kind?: string;
  readonly summary?: string;
  readonly body?: string;
  readonly queryText?: string;
  readonly intent?: string;
  readonly linkedFilePaths?: readonly string[];
  readonly linkedSymbolIds?: readonly string[];
  readonly linkedFqNames?: readonly string[];
  readonly toolName?: string;
}

interface SearchMemoryInput {
  readonly query?: string;
  readonly maxResults?: number;
  readonly sessionId?: string;
  readonly linkedFilePaths?: readonly string[];
  readonly linkedSymbolIds?: readonly string[];
  readonly repos?: readonly string[];
}

interface GetSessionContextInput {
  readonly sessionId?: string;
  readonly limit?: number;
  readonly query?: string;
}

interface WorkspaceSetupInput {
  readonly apply?: boolean;
  readonly startRuntime?: boolean;
}

interface GetSkeletonInput {
  readonly files?: readonly string[];
  readonly detail?: string;
}

interface IndexStatusInput {
  readonly repos?: readonly string[];
}
type ListSessionsInput = Record<string, never>;
type DeferredToolInput = Record<string, unknown>;

interface ReadSessionInput {
  readonly sessionId?: string;
}

interface ReadyRepoBinding {
  readonly repoAlias?: string;
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly configPath: string;
  readonly statePath: string;
  readonly config: RepoLocalConfig;
  readonly state: RepoLocalState;
}

interface WorkspaceRepoStatus {
  readonly repoAlias: string;
  readonly repoRoot: string;
  readonly configPath: string;
  readonly statePath: string;
  readonly dbPath: string;
  readonly enabled: boolean;
  readonly configPresent: boolean;
  readonly statePresent: boolean;
  readonly dbPresent: boolean;
  readonly initialized: boolean;
  readonly indexPresent: boolean;
  readonly latestRunId: number | null;
  readonly readiness: RepoLocalState["readiness"] | null;
  readonly freshness: unknown;
  readonly watcher: unknown;
  readonly binding?: ReadyRepoBinding;
}

interface WorkspaceRepoSelection {
  readonly isWorkspace: boolean;
  readonly workspaceConfig?: ResolvedWorkspaceConfig;
  readonly selectedAliases: readonly string[];
  readonly statuses: readonly WorkspaceRepoStatus[];
}

function stringProperty(description: string): McpSchemaProperty {
  return { type: "string", description };
}

function integerProperty(description: string): McpSchemaProperty {
  return { type: "integer", description };
}

function numberProperty(description: string): McpSchemaProperty {
  return { type: "number", description };
}

function booleanProperty(description: string): McpSchemaProperty {
  return { type: "boolean", description };
}

function objectProperty(
  description: string,
  properties: Record<string, McpSchemaProperty>,
  required: readonly string[],
): McpSchemaProperty {
  return {
    type: "object",
    description,
    properties,
    required,
    additionalProperties: false,
  };
}

function arrayProperty(description: string, items: McpSchemaProperty): McpSchemaProperty {
  return {
    type: "array",
    description,
    items,
  };
}

function objectSchema(
  description: string,
  properties: Record<string, McpSchemaProperty>,
  required: readonly string[],
): McpObjectSchema {
  return {
    type: "object",
    description,
    properties,
    required,
    additionalProperties: false,
  };
}

const SYMBOL_RESULT_SCHEMA = objectProperty(
  "A retrieved symbol candidate.",
  {
    symbolId: stringProperty("Stable persisted symbol id."),
    filePath: stringProperty("Normalized repo-relative file path."),
    fqName: stringProperty("Fully qualified symbol name."),
    localName: stringProperty("Local symbol name."),
    kind: stringProperty("Symbol kind."),
  },
  ["symbolId", "filePath", "fqName", "localName", "kind"],
);

const IMPACT_NODE_SCHEMA = objectProperty(
  "A symbol discovered in the bounded structural impact view.",
  {
    symbolId: stringProperty("Stable persisted symbol id."),
    filePath: stringProperty("Normalized repo-relative file path."),
    fqName: stringProperty("Fully qualified symbol name."),
    localName: stringProperty("Local symbol name."),
    kind: stringProperty("Symbol kind."),
    distance: integerProperty("Shortest reverse-edge distance from the resolved symbol."),
  },
  ["symbolId", "filePath", "fqName", "localName", "kind", "distance"],
);

const IMPACT_EDGE_SCHEMA = objectProperty(
  "A shortest-layer structural impact edge preserving canonical stored direction (caller -> callee, container -> contained, importer -> imported, referrer -> referenced). Reverse impact is a traversal concern and does not flip edges.",
  {
    edgeId: stringProperty("Stable persisted indexed edge id."),
    edgeType: stringProperty("Indexed structural edge type."),
    fromSymbolId: stringProperty("Canonical source symbol id of the stored edge (e.g. caller for calls edges)."),
    fromFqName: stringProperty("Canonical source fully qualified symbol name of the stored edge."),
    toSymbolId: stringProperty("Canonical target symbol id of the stored edge (e.g. callee for calls edges)."),
    toFqName: stringProperty("Canonical target fully qualified symbol name of the stored edge."),
  },
  ["edgeId", "edgeType", "fromSymbolId", "fromFqName", "toSymbolId", "toFqName"],
);

const IMPACT_REQUEST_SCHEMA = objectProperty(
  "Resolved get_impact_graph request parameters.",
  {
    symbolFqn: stringProperty("Exact fully qualified symbol name resolved by the tool."),
    depth: integerProperty("Explicit traversal depth applied to the structural graph."),
    crossRepo: booleanProperty("Whether cross-repo traversal was requested and honored."),
    format: stringProperty("Rendered output format."),
  },
  ["symbolFqn", "depth", "crossRepo", "format"],
);

const IMPACT_COVERAGE_SCHEMA = objectProperty(
  "Coverage contract for the structural impact view.",
  {
    analysisKind: stringProperty("Analysis family used by the tool."),
    resolutionMode: stringProperty("Symbol-resolution mode used by the tool."),
    crossRepo: booleanProperty("Whether traversal crossed repository boundaries."),
    supportedEdgeTypes: arrayProperty(
      "Indexed edge types the impact traversal is allowed to use.",
      stringProperty("Supported edge type."),
    ),
    observedEdgeTypes: arrayProperty(
      "Indexed edge types actually observed in the returned bounded graph.",
      stringProperty("Observed edge type."),
    ),
    notes: arrayProperty(
      "Honest scope and limitation notes for interpreting the result.",
      stringProperty("Coverage note."),
    ),
  },
  ["analysisKind", "resolutionMode", "crossRepo", "supportedEdgeTypes", "observedEdgeTypes", "notes"],
);

const IMPACT_SUMMARY_SCHEMA = objectProperty(
  "Summary counts for the bounded impact result.",
  {
    dependentSymbolCount: integerProperty("Number of discovered dependent symbols excluding the root."),
    dependentFileCount: integerProperty("Number of dependent files touched by discovered symbols."),
    maxDepth: integerProperty("Maximum depth requested for traversal."),
    maxObservedDistance: integerProperty("Largest shortest-path distance present in the result."),
  },
  ["dependentSymbolCount", "dependentFileCount", "maxDepth", "maxObservedDistance"],
);

const IMPACT_VIEW_SCHEMA = objectProperty(
  "Rendered deterministic view over the structural impact graph.",
  {
    format: stringProperty("Rendered output format."),
    lines: arrayProperty("Deterministic rendered lines for the selected format.", stringProperty("Rendered line.")),
  },
  ["format", "lines"],
);

const LOGIC_FLOW_STEP_SCHEMA = objectProperty(
  "A directed structural edge on a returned logic-flow path.",
  {
    edgeId: stringProperty("Stable persisted indexed edge id."),
    edgeType: stringProperty("Indexed structural edge type."),
    fromSymbolId: stringProperty("Source symbol id for this step."),
    fromFqName: stringProperty("Source fully qualified symbol name for this step."),
    toSymbolId: stringProperty("Destination symbol id for this step."),
    toFqName: stringProperty("Destination fully qualified symbol name for this step."),
  },
  ["edgeId", "edgeType", "fromSymbolId", "fromFqName", "toSymbolId", "toFqName"],
);

const LOGIC_FLOW_PATH_SCHEMA = objectProperty(
  "A deterministically ordered shortest structural path between the resolved symbols.",
  {
    pathIndex: integerProperty("1-based deterministic path index."),
    edgeCount: integerProperty("Number of structural edges in the path."),
    nodeCount: integerProperty("Number of symbols in the path."),
    nodes: arrayProperty("Ordered symbols on the path.", SYMBOL_RESULT_SCHEMA),
    steps: arrayProperty("Ordered structural steps between symbols on the path.", LOGIC_FLOW_STEP_SCHEMA),
  },
  ["pathIndex", "edgeCount", "nodeCount", "nodes", "steps"],
);

const LOGIC_FLOW_REQUEST_SCHEMA = objectProperty(
  "Resolved search_logic_flow request parameters.",
  {
    start: stringProperty("Exact fully qualified start symbol name resolved by the tool."),
    end: stringProperty("Exact fully qualified end symbol name resolved by the tool."),
    maxPaths: integerProperty("Maximum number of paths requested."),
    crossRepo: booleanProperty("Whether cross-repo traversal was requested and honored."),
  },
  ["start", "end", "maxPaths", "crossRepo"],
);

const LOGIC_FLOW_COVERAGE_SCHEMA = objectProperty(
  "Coverage contract for the structural logic-flow search.",
  {
    analysisKind: stringProperty("Analysis family used by the tool."),
    resolutionMode: stringProperty("Symbol-resolution mode used by the tool."),
    direction: stringProperty("Traversal direction used by the search."),
    crossRepo: booleanProperty("Whether traversal crossed repository boundaries."),
    supportedEdgeTypes: arrayProperty(
      "Indexed edge types the logic-flow traversal is allowed to use.",
      stringProperty("Supported edge type."),
    ),
    observedEdgeTypes: arrayProperty(
      "Indexed edge types actually observed in the returned paths.",
      stringProperty("Observed edge type."),
    ),
    callFlowEvidenceAvailable: booleanProperty(
      "Whether any statically resolved calls edge existed in the indexed graph for the queried repo. False means call-flow evidence was unavailable and the result is structural containment/import traversal only.",
    ),
    callFlowEvidenceUsed: booleanProperty(
      "Whether at least one returned path traverses a statically resolved calls edge.",
    ),
    notes: arrayProperty(
      "Honest scope and limitation notes for interpreting the result.",
      stringProperty("Coverage note."),
    ),
  },
  [
    "analysisKind",
    "resolutionMode",
    "direction",
    "crossRepo",
    "supportedEdgeTypes",
    "observedEdgeTypes",
    "callFlowEvidenceAvailable",
    "callFlowEvidenceUsed",
    "notes",
  ],
);

const LOGIC_FLOW_SUMMARY_SCHEMA = objectProperty(
  "Summary of the bounded structural logic-flow result.",
  {
    reachable: booleanProperty("Whether at least one structural path was found."),
    pathCount: integerProperty("Number of returned paths."),
    maxPaths: integerProperty("Maximum number of paths requested."),
    shortestPathEdgeCount: {
      type: ["integer", "null"],
      description: "Shortest directed structural path length in edges when reachable.",
    },
    truncated: booleanProperty("Whether additional shortest paths were omitted after reaching maxPaths."),
  },
  ["reachable", "pathCount", "maxPaths", "shortestPathEdgeCount", "truncated"],
);

const RUN_PIPELINE_IMPACT_SUMMARY_SCHEMA = objectProperty(
  "Compact structural impact summary included when run_pipeline safely resolves one focal symbol for a refactor-style task.",
  {
    triggerReason: stringProperty("Explicit refactor-style trigger that caused impact integration to run."),
    selectionSource: stringProperty("How the focal symbol was conservatively selected from already routed pipeline state."),
    resolvedSymbol: SYMBOL_RESULT_SCHEMA,
    summary: IMPACT_SUMMARY_SCHEMA,
    topDependents: arrayProperty(
      "Small deterministic list of the closest dependent symbols excluding the resolved root.",
      IMPACT_NODE_SCHEMA,
    ),
  },
  ["triggerReason", "selectionSource", "resolvedSymbol", "summary", "topDependents"],
);

const SEARCH_MATCH_SCHEMA = objectProperty(
  "A lexical match contribution.",
  {
    field: stringProperty("Matched field."),
    matchType: stringProperty("Match type."),
    scoreContribution: numberProperty("Score contribution from this lexical match."),
  },
  ["field", "matchType", "scoreContribution"],
);

const GRAPH_CONTRIBUTION_SCHEMA = objectProperty(
  "A graph reranking score contribution.",
  {
    signal: stringProperty("Graph score signal."),
    scoreContribution: numberProperty("Score contribution from this graph signal."),
    count: {
      type: ["integer", "null"],
      description: "Related edge or neighbor count when available.",
    },
    edgeType: {
      type: ["string", "null"],
      description: "Related edge type when available.",
    },
    relatedSymbolIds: arrayProperty(
      "Related symbol ids contributing to this graph score.",
      stringProperty("Related symbol id."),
    ),
  },
  ["signal", "scoreContribution", "count", "edgeType", "relatedSymbolIds"],
);

const SEARCH_RESULT_WITH_SCORE_SCHEMA = objectProperty(
  "A real symbol search candidate with scores.",
  {
    symbolId: stringProperty("Stable persisted symbol id."),
    filePath: stringProperty("Normalized repo-relative file path."),
    fqName: stringProperty("Fully qualified symbol name."),
    localName: stringProperty("Local symbol name."),
    kind: stringProperty("Symbol kind."),
    score: numberProperty("Final lexical search score."),
    matches: arrayProperty("Lexical match explanations.", SEARCH_MATCH_SCHEMA),
  },
  ["symbolId", "filePath", "fqName", "localName", "kind", "score", "matches"],
);

const RERANKED_RESULT_SCHEMA = objectProperty(
  "A reranked symbol candidate with lexical and graph scores.",
  {
    symbolId: stringProperty("Stable persisted symbol id."),
    filePath: stringProperty("Normalized repo-relative file path."),
    fqName: stringProperty("Fully qualified symbol name."),
    localName: stringProperty("Local symbol name."),
    kind: stringProperty("Symbol kind."),
    lexicalScore: numberProperty("Lexical score before graph reranking."),
    graphScore: numberProperty("Graph reranking score."),
    finalScore: numberProperty("Final reranked score."),
    matches: arrayProperty("Lexical match explanations.", SEARCH_MATCH_SCHEMA),
    graphContributions: arrayProperty("Graph contribution explanations.", GRAPH_CONTRIBUTION_SCHEMA),
  },
  [
    "symbolId",
    "filePath",
    "fqName",
    "localName",
    "kind",
    "lexicalScore",
    "graphScore",
    "finalScore",
    "matches",
    "graphContributions",
  ],
);

const INDEX_SUMMARY_SCHEMA = objectProperty(
  "Summary of a completed index run.",
  {
    totalFilesScanned: integerProperty("Total scanned source files."),
    totalFilesAttemptedForParse: integerProperty("Total files attempted for parse."),
    totalFilesSuccessfullyIndexed: integerProperty("Total files successfully indexed."),
    totalParseFailures: integerProperty("Total parse failures during the run."),
    totalSkippedUnregisteredLanguage: integerProperty("Files skipped because the language was unregistered."),
    totalSkippedUnsupportedLanguage: integerProperty("Files skipped because the language was unsupported."),
    totalReadFailures: integerProperty("Files that failed to read."),
    totalPersistenceFailures: integerProperty("Files that failed persistence."),
  },
  [
    "totalFilesScanned",
    "totalFilesAttemptedForParse",
    "totalFilesSuccessfullyIndexed",
    "totalParseFailures",
    "totalSkippedUnregisteredLanguage",
    "totalSkippedUnsupportedLanguage",
    "totalReadFailures",
    "totalPersistenceFailures",
  ],
);

const RUN_SUMMARY_SCHEMA = objectProperty(
  "A persisted index run summary.",
  {
    id: integerProperty("Persisted run id."),
    previousRunId: {
      type: ["integer", "null"],
      description: "Previous run id when available.",
    },
    totalFiles: integerProperty("Number of indexed files recorded for the run."),
    totalSymbols: integerProperty("Number of indexed symbols recorded for the run."),
    fileChangeCounts: objectProperty(
      "File-level diff counts for the run.",
      {
        added: integerProperty("Added files."),
        modified: integerProperty("Modified files."),
        removed: integerProperty("Removed files."),
        unchanged: integerProperty("Unchanged files."),
      },
      ["added", "modified", "removed", "unchanged"],
    ),
    symbolChangeCounts: objectProperty(
      "Symbol-level diff counts for the run.",
      {
        added: integerProperty("Added symbols."),
        modified: integerProperty("Modified symbols."),
        removed: integerProperty("Removed symbols."),
        unchanged: integerProperty("Unchanged symbols."),
      },
      ["added", "modified", "removed", "unchanged"],
    ),
  },
  ["id", "previousRunId", "totalFiles", "totalSymbols", "fileChangeCounts", "symbolChangeCounts"],
);

const RUN_HISTORY_ENTRY_SCHEMA = objectProperty(
  "A persisted index run summary with creation metadata.",
  {
    id: integerProperty("Persisted run id."),
    previousRunId: {
      type: ["integer", "null"],
      description: "Previous run id when available.",
    },
    createdAtMs: integerProperty("Creation timestamp in milliseconds."),
    totalFiles: integerProperty("Number of indexed files recorded for the run."),
    totalSymbols: integerProperty("Number of indexed symbols recorded for the run."),
    fileChangeCounts: objectProperty(
      "File-level diff counts for the run.",
      {
        added: integerProperty("Added files."),
        modified: integerProperty("Modified files."),
        removed: integerProperty("Removed files."),
        unchanged: integerProperty("Unchanged files."),
      },
      ["added", "modified", "removed", "unchanged"],
    ),
    symbolChangeCounts: objectProperty(
      "Symbol-level diff counts for the run.",
      {
        added: integerProperty("Added symbols."),
        modified: integerProperty("Modified symbols."),
        removed: integerProperty("Removed symbols."),
        unchanged: integerProperty("Unchanged symbols."),
      },
      ["added", "modified", "removed", "unchanged"],
    ),
  },
  [
    "id",
    "previousRunId",
    "createdAtMs",
    "totalFiles",
    "totalSymbols",
    "fileChangeCounts",
    "symbolChangeCounts",
  ],
);

const READINESS_CHECK_SCHEMA = objectProperty(
  "A repo readiness check.",
  {
    id: stringProperty("Readiness check id."),
    ok: booleanProperty("Whether the check passed."),
    detail: stringProperty("Human-readable deterministic detail."),
  },
  ["id", "ok", "detail"],
);

const READINESS_SCHEMA = objectProperty(
  "Repo readiness metadata.",
  {
    status: stringProperty("Overall repo readiness status."),
    summary: stringProperty("Deterministic readiness summary."),
    checks: arrayProperty("Individual readiness checks.", READINESS_CHECK_SCHEMA),
  },
  ["status", "summary", "checks"],
);

const INTENT_CANDIDATE_SCHEMA = objectProperty(
  "An intent classification candidate.",
  {
    intent: stringProperty("Candidate intent."),
    strength: numberProperty("Candidate strength."),
    matchedRuleIds: arrayProperty("Matched rule ids.", stringProperty("Rule id.")),
  },
  ["intent", "strength", "matchedRuleIds"],
);

const MATCHED_RULE_SCHEMA = objectProperty(
  "A matched intent rule summary.",
  {
    ruleId: stringProperty("Matched rule id."),
    targetIntent: stringProperty("Target intent for the rule."),
    priority: integerProperty("Rule priority."),
    strength: numberProperty("Matched rule strength."),
    explanation: stringProperty("Deterministic explanation of the rule match."),
    matchedTerms: arrayProperty("Matched rule terms.", stringProperty("Matched term.")),
  },
  ["ruleId", "targetIntent", "priority", "strength", "explanation", "matchedTerms"],
);

const CLASSIFICATION_EXPLANATION_SCHEMA = objectProperty(
  "Intent classification explanation.",
  {
    reasonKind: stringProperty("Why the intent was selected."),
    fallbackApplied: booleanProperty("Whether fallback logic was used."),
    summary: stringProperty("Deterministic classification summary."),
    matchedRules: arrayProperty("Matched rule summaries.", MATCHED_RULE_SCHEMA),
  },
  ["reasonKind", "fallbackApplied", "summary", "matchedRules"],
);

const CLASSIFICATION_SCHEMA = objectProperty(
  "Intent classification result.",
  {
    query: stringProperty("Original query text."),
    intent: stringProperty("Selected intent."),
    strength: numberProperty("Selected intent strength."),
    candidates: arrayProperty("Intent candidates.", INTENT_CANDIDATE_SCHEMA),
    explanation: CLASSIFICATION_EXPLANATION_SCHEMA,
  },
  ["query", "intent", "strength", "candidates", "explanation"],
);

const GRAPH_WEIGHTS_SCHEMA = objectProperty(
  "Graph reranking weights.",
  {
    inDegreePerEdge: numberProperty("In-degree per-edge weight."),
    inDegreeMax: numberProperty("In-degree cap."),
    outDegreePerEdge: numberProperty("Out-degree per-edge weight."),
    outDegreeMax: numberProperty("Out-degree cap."),
    containsNeighbor: numberProperty("Contains-neighbor weight."),
    containsNeighborMax: numberProperty("Contains-neighbor cap."),
    importsNeighbor: numberProperty("Imports-neighbor weight."),
    importsNeighborMax: numberProperty("Imports-neighbor cap."),
    connectedMatchedCandidate: numberProperty("Connected matched candidate weight."),
    connectedMatchedCandidateMax: numberProperty("Connected matched candidate cap."),
  },
  [
    "inDegreePerEdge",
    "inDegreeMax",
    "outDegreePerEdge",
    "outDegreeMax",
    "containsNeighbor",
    "containsNeighborMax",
    "importsNeighbor",
    "importsNeighborMax",
    "connectedMatchedCandidate",
    "connectedMatchedCandidateMax",
  ],
);

const ROUTING_PROFILE_SCHEMA = objectProperty(
  "Selected routing profile.",
  {
    id: stringProperty("Routing profile id."),
    backend: stringProperty("Selected search backend."),
    candidatePoolSize: integerProperty("Candidate pool size used for reranking."),
    graphWeights: GRAPH_WEIGHTS_SCHEMA,
    summary: stringProperty("Routing profile summary."),
  },
  ["id", "backend", "candidatePoolSize", "graphWeights", "summary"],
);

const CAPSULE_PROFILE_SCHEMA = objectProperty(
  "Selected capsule profile.",
  {
    id: stringProperty("Capsule profile id."),
    targetIntent: stringProperty("Target intent for the capsule profile."),
    description: stringProperty("Capsule profile description."),
    settingsSummary: objectProperty(
      "Capsule profile settings summary.",
      {
        maxPivotCount: integerProperty("Maximum pivot count."),
        maxSupportCount: integerProperty("Maximum support count."),
        pivotSupportBalancePolicy: stringProperty("Pivot/support balance policy."),
        supportSelectionPolicy: stringProperty("Support selection policy."),
        preferredPivotContentModes: arrayProperty("Preferred pivot content modes.", stringProperty("Content mode.")),
        preferredSupportContentModes: arrayProperty("Preferred support content modes.", stringProperty("Content mode.")),
        pivotFallbackLadder: arrayProperty("Pivot fallback ladder.", stringProperty("Content mode.")),
        supportFallbackLadder: arrayProperty("Support fallback ladder.", stringProperty("Content mode.")),
        budgetAllocationPolicy: stringProperty("Budget allocation policy."),
        budgetSplit: {
          type: ["object", "null"],
          description: "Optional pivot/support budget split.",
          properties: {
            pivotFraction: numberProperty("Pivot fraction."),
            supportFraction: numberProperty("Support fraction."),
          },
          required: ["pivotFraction", "supportFraction"],
          additionalProperties: false,
        },
      },
      [
        "maxPivotCount",
        "maxSupportCount",
        "pivotSupportBalancePolicy",
        "supportSelectionPolicy",
        "preferredPivotContentModes",
        "preferredSupportContentModes",
        "pivotFallbackLadder",
        "supportFallbackLadder",
        "budgetAllocationPolicy",
        "budgetSplit",
      ],
    ),
    explanation: objectProperty(
      "Capsule profile selection explanation.",
      {
        reasonKind: stringProperty("Why this capsule profile was selected."),
        fallbackApplied: booleanProperty("Whether a fallback profile was used."),
        summary: stringProperty("Deterministic selection summary."),
      },
      ["reasonKind", "fallbackApplied", "summary"],
    ),
  },
  ["id", "targetIntent", "description", "settingsSummary", "explanation"],
);

const CAPSULE_SKELETON_IMPORT_SCHEMA = objectProperty(
  "A compact import summary entry.",
  {
    fromFilePath: stringProperty("Repo-relative file path providing the imported symbol."),
    name: stringProperty("Imported symbol name."),
    kind: stringProperty("Imported symbol kind."),
  },
  ["fromFilePath", "name", "kind"],
);

const CAPSULE_SKELETON_EXPORT_SCHEMA = objectProperty(
  "A compact export summary entry.",
  {
    name: stringProperty("Exported top-level declaration name."),
    kind: stringProperty("Exported declaration kind."),
  },
  ["name", "kind"],
);

const CAPSULE_SKELETON_MEMBER_SCHEMA = objectProperty(
  "A class member skeleton entry.",
  {
    kind: stringProperty("Structural member kind."),
    name: stringProperty("Member name."),
    signature: {
      type: ["string", "null"],
      description: "Signature-only structural text when included by the selected detail level.",
    },
    startLine: {
      type: ["integer", "null"],
      description: "1-based starting line when included by the selected detail level.",
    },
    endLine: {
      type: ["integer", "null"],
      description: "1-based ending line when included by the selected detail level.",
    },
    docstring: {
      type: ["string", "null"],
      description: "Optional indexed leading docstring/comment snippet when included.",
    },
    decorators: arrayProperty("Indexed decorator metadata when included.", stringProperty("Decorator text.")),
  },
  ["kind", "name", "signature", "startLine", "endLine", "docstring", "decorators"],
);

const CAPSULE_SKELETON_DECLARATION_SCHEMA = objectProperty(
  "A top-level declaration skeleton entry.",
  {
    kind: stringProperty("Top-level declaration kind."),
    name: stringProperty("Declaration name."),
    exported: booleanProperty("Whether the declaration is exported."),
    signature: {
      type: ["string", "null"],
      description: "Signature-only structural text when included by the selected detail level.",
    },
    startLine: {
      type: ["integer", "null"],
      description: "1-based starting line when included by the selected detail level.",
    },
    endLine: {
      type: ["integer", "null"],
      description: "1-based ending line when included by the selected detail level.",
    },
    docstring: {
      type: ["string", "null"],
      description: "Optional indexed leading docstring/comment snippet when included.",
    },
    decorators: arrayProperty("Indexed decorator metadata when included.", stringProperty("Decorator text.")),
    members: arrayProperty("Nested class member skeleton entries.", CAPSULE_SKELETON_MEMBER_SCHEMA),
  },
  ["kind", "name", "exported", "signature", "startLine", "endLine", "docstring", "decorators", "members"],
);

const CAPSULE_SKELETON_FILE_SCHEMA = objectProperty(
  "A per-file skeleton result.",
  {
    status: stringProperty("Per-file skeletonization status."),
    filePath: stringProperty("Normalized repo-relative file path."),
    language: {
      type: ["string", "null"],
      description: "Indexed file language when structural data is available.",
    },
    message: {
      type: ["string", "null"],
      description: "Explicit per-file explanation when no skeleton is available.",
    },
    imports: arrayProperty("Compact import summary.", CAPSULE_SKELETON_IMPORT_SCHEMA),
    exports: arrayProperty("Compact export summary.", CAPSULE_SKELETON_EXPORT_SCHEMA),
    declarations: arrayProperty("Ordered top-level declarations.", CAPSULE_SKELETON_DECLARATION_SCHEMA),
  },
  ["status", "filePath", "language", "message", "imports", "exports", "declarations"],
);

const CAPSULE_CONTENT_SCHEMA = objectProperty(
  "Capsule item content payload.",
  {
    mode: stringProperty("Capsule content mode."),
    source: stringProperty("Full source content when available."),
    detail: stringProperty("Skeleton detail level when structural content is used."),
    file: CAPSULE_SKELETON_FILE_SCHEMA,
    signature: stringProperty("Signature-only or summary signature content."),
    summary: stringProperty("Summary content."),
    stub: stringProperty("Stub content."),
  },
  ["mode"],
);

const CAPSULE_INCLUSION_REASON_SCHEMA = objectProperty(
  "A capsule inclusion reason.",
  {
    kind: stringProperty("Inclusion reason kind."),
    matchedFields: arrayProperty("Matched lexical fields.", stringProperty("Matched field.")),
    graphSignals: arrayProperty("Graph signals used for inclusion.", stringProperty("Graph signal.")),
    relatedSymbolIds: arrayProperty("Related symbol ids.", stringProperty("Related symbol id.")),
    edgeType: stringProperty("Related edge type."),
    note: stringProperty("Human-readable note."),
    originalMode: stringProperty("Original content mode before compression."),
    appliedMode: stringProperty("Applied content mode after compression."),
  },
  ["kind"],
);

const CAPSULE_MEMORY_INCLUSION_REASON_SCHEMA = objectProperty(
  "A surfaced memory inclusion reason.",
  {
    kind: stringProperty("Memory inclusion reason kind."),
    matchedValues: arrayProperty("Matched values for this reason.", stringProperty("Matched value.")),
  },
  ["kind", "matchedValues"],
);

const CAPSULE_MEMORY_ITEM_SCHEMA = objectProperty(
  "A compact surfaced memory item.",
  {
    repoAlias: stringProperty("Workspace repo alias when memory is surfaced from a multi-repo workspace."),
    observationId: stringProperty("Stable observation id."),
    kind: stringProperty("Observation kind."),
    headline: stringProperty("Observation summary headline."),
    createdAtMs: integerProperty("Observation creation timestamp in milliseconds."),
    isStale: booleanProperty("Whether the observation is currently stale."),
    staleReasons: arrayProperty("Observation stale reason kinds.", stringProperty("Stale reason kind.")),
    inclusionReasons: arrayProperty(
      "Why the memory was surfaced.",
      CAPSULE_MEMORY_INCLUSION_REASON_SCHEMA,
    ),
  },
  ["observationId", "kind", "headline", "createdAtMs", "isStale", "staleReasons", "inclusionReasons"],
);

const CAPSULE_ITEM_SCHEMA = objectProperty(
  "A capsule item.",
  {
    repoAlias: stringProperty("Workspace repo alias when returned from a multi-repo workspace."),
    symbolId: stringProperty("Stable persisted symbol id."),
    filePath: stringProperty("Normalized repo-relative file path."),
    fqName: stringProperty("Fully qualified symbol name."),
    localName: stringProperty("Local symbol name."),
    kind: stringProperty("Symbol kind."),
    role: stringProperty("Capsule item role."),
    contentMode: stringProperty("Flattened content mode."),
    content: CAPSULE_CONTENT_SCHEMA,
    inclusionReasons: arrayProperty("Capsule inclusion reasons.", CAPSULE_INCLUSION_REASON_SCHEMA),
    budgetCost: integerProperty("Capsule budget cost for this item."),
    compressed: booleanProperty("Whether this item was compressed."),
    sourceBacked: booleanProperty("Whether this item is source-backed."),
    lexicalScore: numberProperty("Lexical score when available."),
    graphScore: numberProperty("Graph score when available."),
    finalScore: numberProperty("Final score when available."),
  },
  [
    "symbolId",
    "filePath",
    "fqName",
    "localName",
    "kind",
    "role",
    "contentMode",
    "content",
    "inclusionReasons",
    "budgetCost",
    "compressed",
  ],
);

const MULTI_REPO_RETRIEVAL_SUMMARY_SCHEMA = objectProperty(
  "Per-repo retrieval summary for multi-repo context assembly.",
  {
    repoAlias: stringProperty("Stable workspace repo alias."),
    repoRoot: stringProperty("Repo root."),
    ready: booleanProperty("Whether retrieval was attempted against this repo."),
    skipReason: {
      type: ["string", "null"],
      description: "Why this repo was skipped, when applicable.",
    },
    candidateCount: integerProperty("Reranked candidate count from this repo."),
    pivotCount: integerProperty("Pivot capsule item count from this repo."),
    supportCount: integerProperty("Support capsule item count from this repo."),
  },
  ["repoAlias", "repoRoot", "ready", "skipReason", "candidateCount", "pivotCount", "supportCount"],
);

const MULTI_REPO_MERGE_SUMMARY_SCHEMA = objectProperty(
  "Deterministic cross-repo merge summary.",
  {
    strategy: stringProperty("Merge strategy identifier."),
    selectedRepos: arrayProperty("Selected repo aliases.", stringProperty("Repo alias.")),
    inputItemCount: integerProperty("Total items considered before global ordering."),
    outputItemCount: integerProperty("Total items emitted after global ordering."),
    tieBreakers: arrayProperty("Tie-breakers in priority order.", stringProperty("Tie-breaker.")),
  },
  ["strategy", "selectedRepos", "inputItemCount", "outputItemCount", "tieBreakers"],
);

const INDEX_FRESHNESS_SCHEMA = objectProperty(
  "Repo index freshness and optional watcher-observed stale state.",
  {
    state: stringProperty("Freshness state."),
    isStale: booleanProperty("Whether the index should be treated as stale."),
    summary: stringProperty("Human-readable freshness summary."),
    whyItMatters: stringProperty("Why stale or unknown freshness matters, when applicable."),
    recommendedAction: stringProperty("Recommended follow-up action for the current freshness state."),
    reasons: arrayProperty(
      "Freshness reasons.",
      objectProperty(
        "Freshness reason.",
        {
          code: stringProperty("Reason code."),
          count: integerProperty("Optional count associated with the reason."),
          firstChangedAtMs: integerProperty("First observed changed-file timestamp, when applicable."),
          lastChangedAtMs: integerProperty("Last observed changed-file timestamp, when applicable."),
          changedFiles: arrayProperty(
            "Bounded sorted watcher-observed changed files, when applicable.",
            stringProperty("Repo-relative changed file path."),
          ),
        },
        ["code"],
      ),
    ),
    observedFileChanges: {
      type: ["object", "null"],
      description: "Pending watcher-observed file changes, when any.",
      additionalProperties: true,
    },
    autoReindex: {
      type: "object",
      description: "Auto-reindex state surfaced from watcher metadata.",
      additionalProperties: true,
    },
    snapshot: {
      type: "object",
      description: "Last indexed snapshot metadata.",
      additionalProperties: true,
    },
    comparison: {
      type: "object",
      description: "Current source snapshot comparison.",
      additionalProperties: true,
    },
    currentHead: {
      type: ["string", "null"],
      description: "Current git HEAD when available.",
    },
  },
  ["state", "isStale", "summary", "reasons", "observedFileChanges", "autoReindex", "snapshot", "currentHead", "comparison"],
);

const FILE_WATCHER_STATUS_SCHEMA = objectProperty(
  "Optional passive file watcher status.",
  {
    supported: booleanProperty("Whether watcher support is available in this build."),
    enabled: booleanProperty("Whether watcher mode has been explicitly used for this repo."),
    running: booleanProperty("Whether a watcher is known to be running in this process."),
    debounceMs: integerProperty("Configured debounce window in milliseconds."),
    lastEventAtMs: {
      type: ["integer", "null"],
      description: "Last watcher-observed file event timestamp when known.",
    },
    autoReindexEnabled: booleanProperty("Whether the watcher should trigger debounced automatic re-indexing."),
    reindexState: stringProperty("Current auto-reindex state: idle, pending_changes, reindexing, reindex_failed, or stale_after_failed_reindex."),
    lastAutoReindexStartedAtMs: {
      type: ["integer", "null"],
      description: "Last auto-reindex start timestamp when known.",
    },
    lastAutoReindexFinishedAtMs: {
      type: ["integer", "null"],
      description: "Last successful auto-reindex completion timestamp when known.",
    },
    lastAutoReindexFailedAtMs: {
      type: ["integer", "null"],
      description: "Last failed auto-reindex timestamp when known.",
    },
    lastAutoReindexError: {
      type: ["string", "null"],
      description: "Compact last auto-reindex error when known.",
    },
    pendingChangedFileCount: integerProperty("Pending watcher-observed changed file count."),
    changedFiles: arrayProperty("Bounded sorted changed files associated with the watcher state.", stringProperty("Repo-relative changed file path.")),
  },
  [
    "supported",
    "enabled",
    "running",
    "debounceMs",
    "lastEventAtMs",
    "autoReindexEnabled",
    "reindexState",
    "lastAutoReindexStartedAtMs",
    "lastAutoReindexFinishedAtMs",
    "lastAutoReindexFailedAtMs",
    "lastAutoReindexError",
    "pendingChangedFileCount",
    "changedFiles",
  ],
);

const OBSERVATION_NUDGE_SCHEMA = objectProperty(
  "Compact progressive observation nudge state.",
  {
    enabled: booleanProperty("Whether an observation nudge should be shown."),
    kind: stringProperty("Nudge kind identifier."),
    level: {
      type: ["string", "null"],
      description: "Nudge level when enabled.",
    },
    message: {
      type: ["string", "null"],
      description: "Compact agent-facing nudge message when enabled.",
    },
    reason: stringProperty("Deterministic reason for the nudge state."),
    sessionId: {
      type: ["string", "null"],
      description: "Session id used for nudge evaluation, when available.",
    },
    toolCallCount: integerProperty("Passive tool-call count in the session."),
    durableObservationCount: integerProperty("Durable observation count in the session."),
    nextNudgeAfterToolCallCount: {
      type: ["integer", "null"],
      description: "Next passive tool-call count that can produce a nudge.",
    },
  },
  [
    "enabled",
    "kind",
    "reason",
    "sessionId",
    "toolCallCount",
    "durableObservationCount",
    "nextNudgeAfterToolCallCount",
  ],
);

const GET_CODE_CONTEXT_INDEX_FRESHNESS_DIAGNOSTIC_SCHEMA = objectProperty(
  "Front-door index freshness action taken before building code context.",
  {
    status: stringProperty("fresh, stale, unknown, refreshed, or unavailable."),
    reason: {
      type: ["string", "null"],
      description: "Reason for the status or refresh decision.",
    },
    action: stringProperty("none, auto_index_repo, or call_index_repo."),
    beforeState: {
      type: ["string", "null"],
      description: "Freshness state observed before an automatic refresh, when checked.",
    },
    afterState: {
      type: ["string", "null"],
      description: "Freshness state observed after an automatic refresh, when checked.",
    },
    latestRunId: {
      type: ["integer", "null"],
      description: "Latest index run id after refresh, when available.",
    },
  },
  ["status", "reason", "action", "beforeState", "afterState", "latestRunId"],
);

const RUN_PIPELINE_DIAGNOSTICS_SCHEMA = objectProperty(
  "Explicit run_pipeline reliability diagnostics.",
  {
    selectedRepos: arrayProperty("Selected repo aliases for a multi-repo run.", stringProperty("Repo alias.")),
    perRepo: arrayProperty("Per-repo retrieval summaries for a multi-repo run.", MULTI_REPO_RETRIEVAL_SUMMARY_SCHEMA),
    mergeSummary: {
      type: ["object", "null"],
      description: "Cross-repo merge summary for a multi-repo run.",
      properties: {
        ...(MULTI_REPO_MERGE_SUMMARY_SCHEMA.properties ?? {}),
      },
      required: MULTI_REPO_MERGE_SUMMARY_SCHEMA.required ?? [],
      additionalProperties: false,
    },
    initialReason: {
      type: ["string", "null"],
      description: "Why the first assembled pipeline result had no useful context items, when applicable.",
    },
    fallbackApplied: booleanProperty("Whether run_pipeline retried once with a broader relaxed assembly path."),
    fallbackMode: {
      type: ["string", "null"],
      description: "Fallback mode used when a retry was attempted.",
    },
    fallbackRecovered: booleanProperty("Whether the fallback recovered a non-empty useful context result."),
    finalReason: {
      type: ["string", "null"],
      description: "Final explicit reason when the pipeline still has no useful context items.",
    },
    initialContextItemCount: integerProperty("Count of pivot plus support items in the first assembled result."),
    finalContextItemCount: integerProperty("Count of pivot plus support items in the final returned result."),
    pathSignalsConsidered: arrayProperty(
      "Path-like query terms considered when looking for route/module sibling matches.",
      stringProperty("Path-like term derived from the query."),
    ),
    pathSignalsMatched: arrayProperty(
      "Subset of pathSignalsConsidered that appeared as a path segment in at least one candidate file path.",
      stringProperty("Path-like term that was matched against candidate file paths."),
    ),
    candidateFilesConsidered: integerProperty(
      "Distinct candidate file paths considered when computing path-signal coverage.",
    ),
    weakPathCoverage: booleanProperty(
      "True when at least two path-like terms were considered but fewer than half were matched in any candidate file path.",
    ),
  },
  [
    "initialReason",
    "fallbackApplied",
    "fallbackMode",
    "fallbackRecovered",
    "finalReason",
    "initialContextItemCount",
    "finalContextItemCount",
    "pathSignalsConsidered",
    "pathSignalsMatched",
    "candidateFilesConsidered",
    "weakPathCoverage",
  ],
);

const RUN_PIPELINE_COMPACT_CONTEXT_ITEM_SCHEMA = objectProperty(
  "Compact context item: identity, role, representation mode, and inclusion evidence.",
  {
    repoAlias: stringProperty("Workspace repo alias when returned from a multi-repo workspace."),
    symbolId: stringProperty("Stable persisted symbol id."),
    filePath: stringProperty("Normalized repo-relative file path."),
    fqName: stringProperty("Fully qualified symbol name."),
    localName: stringProperty("Local symbol name."),
    kind: stringProperty("Symbol kind."),
    role: stringProperty("Capsule item role: pivot or support."),
    contentMode: stringProperty("Representation mode used for this item."),
    inclusionReasons: arrayProperty("Capsule inclusion reasons.", CAPSULE_INCLUSION_REASON_SCHEMA),
    budgetCost: integerProperty("Capsule budget cost for this item."),
    compressed: booleanProperty("Whether the item was compressed to a reduced mode."),
    sourceBacked: booleanProperty("Whether this item came from source-backed content loading."),
    lexicalScore: numberProperty("Lexical score when available."),
    graphScore: numberProperty("Graph score when available."),
    finalScore: numberProperty("Final score when available."),
  },
  [
    "symbolId",
    "filePath",
    "fqName",
    "localName",
    "kind",
    "role",
    "contentMode",
    "inclusionReasons",
    "budgetCost",
    "compressed",
    "sourceBacked",
  ],
);

const RUN_PIPELINE_INTENT_DECISION_SCHEMA = objectProperty(
  "Explicit intent selection result, including preset resolution.",
  {
    requested: stringProperty("Preset requested by caller (auto, explore, debug, modify, refactor)."),
    selected: stringProperty("Concrete preset resolved by the orchestrator."),
    requestedPreset: stringProperty("Product-facing preset requested by caller."),
    selectedPreset: stringProperty("Product-facing concrete preset selected by the orchestrator."),
    selectedIntent: stringProperty("Internal intent selected for retrieval/profile mapping."),
    reason: stringProperty("Compact reason for the selected preset."),
    confidence: stringProperty("Coarse deterministic confidence: low, medium, or high."),
    source: stringProperty("How the preset was resolved (explicit, auto_phrase_trigger, auto_classifier, auto_default)."),
    rationale: stringProperty("Short human-readable rationale for the resolved preset."),
    mappedQueryIntent: stringProperty("Internal QueryIntent the preset maps to for retrieval and capsule profile selection."),
    editGoal: stringProperty("Normalized edit goal implied by the selected preset."),
    fallbackApplied: booleanProperty("Whether auto-selection required falling back because no strong signal existed."),
  },
  [
    "requested",
    "selected",
    "requestedPreset",
    "selectedPreset",
    "selectedIntent",
    "reason",
    "confidence",
    "source",
    "rationale",
    "mappedQueryIntent",
    "editGoal",
    "fallbackApplied",
  ],
);

const RUN_PIPELINE_TASK_SUMMARY_SCHEMA = objectProperty(
  "Normalized task summary.",
  {
    query: stringProperty("Original query text."),
    normalizedQuery: stringProperty("Lowercased non-alphanumeric-stripped query used by intent rules."),
    editGoal: stringProperty("Resolved edit goal for this task."),
  },
  ["query", "normalizedQuery", "editGoal"],
);

const RUN_PIPELINE_CONTEXT_SECTION_SCHEMA = objectProperty(
  "Context search result in compact form with explicit inclusion decision.",
  {
    selectedRepos: arrayProperty("Selected repo aliases for multi-repo context retrieval.", stringProperty("Repo alias.")),
    perRepo: arrayProperty("Per-repo retrieval summaries for multi-repo context retrieval.", MULTI_REPO_RETRIEVAL_SUMMARY_SCHEMA),
    mergeSummary: {
      type: ["object", "null"],
      description: "Cross-repo merge summary for multi-repo context retrieval.",
      properties: {
        ...(MULTI_REPO_MERGE_SUMMARY_SCHEMA.properties ?? {}),
      },
      required: MULTI_REPO_MERGE_SUMMARY_SCHEMA.required ?? [],
      additionalProperties: false,
    },
    included: booleanProperty("Whether compact context was included in the result."),
    skipReason: {
      type: ["string", "null"],
      description: "Why the context section was omitted, when applicable.",
    },
    pivots: arrayProperty("Compact pivot items.", RUN_PIPELINE_COMPACT_CONTEXT_ITEM_SCHEMA),
    supports: arrayProperty("Compact supporting items.", RUN_PIPELINE_COMPACT_CONTEXT_ITEM_SCHEMA),
    itemCount: integerProperty("Total number of context items surfaced (pivots + supports)."),
    compressed: booleanProperty("Whether any context item was compressed to a reduced mode."),
    truncated: booleanProperty("Whether the capsule was truncated by the budget."),
    budget: objectProperty(
      "Capsule budget usage.",
      {
        model: stringProperty("Budget model."),
        maxCharacters: integerProperty("Maximum allowed characters."),
        usedCharacters: integerProperty("Used characters."),
        remainingCharacters: integerProperty("Remaining characters."),
      },
      ["model", "maxCharacters", "usedCharacters", "remainingCharacters"],
    ),
    capsuleProfileId: stringProperty("Capsule profile id used for this context."),
    routingProfileId: stringProperty("Routing profile id used for this context."),
    capsuleRef: stringProperty("Stable deferred reference id for the expanded capsule content."),
    capsuleManifestId: {
      type: ["string", "null"],
      description: "Persisted capsule manifest id for this context capsule. Pass to check_capsule_staleness or `vtrace check-capsule` to evaluate freshness against a later run. Null for multi-repo context or when the repo has no index run yet.",
    },
  },
  [
    "included",
    "skipReason",
    "pivots",
    "supports",
    "itemCount",
    "compressed",
    "truncated",
    "budget",
    "capsuleProfileId",
    "routingProfileId",
    "capsuleRef",
  ],
);

const RUN_PIPELINE_IMPACT_SECTION_SCHEMA = objectProperty(
  "Impact integration decision and compact summary.",
  {
    included: booleanProperty("Whether a compact impact summary was included."),
    skipReason: {
      type: ["string", "null"],
      description: "Why the impact section was omitted, when applicable.",
    },
    triggerReason: {
      type: ["string", "null"],
      description: "Trigger reason recognized by the orchestrator, when evaluated.",
    },
    selectionSource: {
      type: ["string", "null"],
      description: "How the focal symbol was selected, when one was resolved.",
    },
    focalSymbol: {
      type: ["object", "null"],
      description: "Resolved focal symbol, when one was selected.",
      properties: {
        symbolId: stringProperty("Stable persisted symbol id."),
        filePath: stringProperty("Normalized repo-relative file path."),
        fqName: stringProperty("Fully qualified symbol name."),
        localName: stringProperty("Local symbol name."),
        kind: stringProperty("Symbol kind."),
      },
      required: ["symbolId", "filePath", "fqName", "localName", "kind"],
      additionalProperties: false,
    },
    summary: {
      type: ["object", "null"],
      description: "Compact structural impact summary when included.",
      properties: {
        dependentSymbolCount: integerProperty("Number of discovered dependent symbols excluding the root."),
        dependentFileCount: integerProperty("Number of dependent files touched by discovered symbols."),
        maxDepth: integerProperty("Maximum depth requested for traversal."),
        maxObservedDistance: integerProperty("Largest shortest-path distance present in the result."),
      },
      required: ["dependentSymbolCount", "dependentFileCount", "maxDepth", "maxObservedDistance"],
      additionalProperties: false,
    },
    topDependents: {
      type: ["array", "null"],
      description: "Deterministic compact list of closest dependent symbols, when included.",
      items: IMPACT_NODE_SCHEMA,
    },
    impactRef: {
      type: ["string", "null"],
      description: "Stable deferred reference id for the full impact graph, when included.",
    },
    candidatesConsidered: integerProperty("Number of conservative focal-symbol candidates considered."),
    matchedCandidates: integerProperty("Number of candidates explicitly mentioned by the task."),
  },
  [
    "included",
    "skipReason",
    "triggerReason",
    "selectionSource",
    "focalSymbol",
    "summary",
    "topDependents",
    "impactRef",
    "candidatesConsidered",
    "matchedCandidates",
  ],
);

const RUN_PIPELINE_FLOW_ENDPOINT_SCHEMA: McpSchemaProperty = {
  type: ["object", "null"],
  description: "A resolved logic-flow endpoint, when inferred.",
  properties: {
    symbolId: stringProperty("Stable persisted symbol id."),
    filePath: stringProperty("Normalized repo-relative file path."),
    fqName: stringProperty("Fully qualified symbol name."),
    localName: stringProperty("Local symbol name."),
    kind: stringProperty("Symbol kind."),
  },
  required: ["symbolId", "filePath", "fqName", "localName", "kind"],
  additionalProperties: false,
};

const RUN_PIPELINE_FLOW_PATH_SCHEMA = objectProperty(
  "A compact structural logic-flow path; full steps live in the deferred logic-flow payload.",
  {
    pathIndex: integerProperty("1-based deterministic path index."),
    edgeCount: integerProperty("Number of structural edges in the path."),
    nodeFqNames: arrayProperty(
      "Ordered fully qualified symbol names along the path.",
      stringProperty("FQ name on the path."),
    ),
  },
  ["pathIndex", "edgeCount", "nodeFqNames"],
);

const RUN_PIPELINE_FLOW_SECTION_SCHEMA = objectProperty(
  "Logic-flow integration decision and compact result when two endpoints can be inferred from the task and candidates.",
  {
    included: booleanProperty("Whether a reachable directed structural flow was included."),
    skipReason: {
      type: ["string", "null"],
      description: "Why the flow section was omitted, when applicable.",
    },
    endpointStrategy: {
      type: ["string", "null"],
      description: "How directed endpoints were resolved (directional_cue or bidirectional_probe), when evaluated.",
    },
    bothDirectionsReachable: booleanProperty(
      "Whether both directed orderings of the endpoints were reachable during bidirectional probing.",
    ),
    start: RUN_PIPELINE_FLOW_ENDPOINT_SCHEMA,
    end: RUN_PIPELINE_FLOW_ENDPOINT_SCHEMA,
    summary: {
      type: ["object", "null"],
      description: "Compact structural logic-flow summary when a flow was attempted.",
      properties: {
        reachable: booleanProperty("Whether at least one structural path was found."),
        pathCount: integerProperty("Number of returned paths."),
        maxPaths: integerProperty("Maximum number of paths requested."),
        shortestPathEdgeCount: {
          type: ["integer", "null"],
          description: "Shortest directed structural path length in edges when reachable.",
        },
        truncated: booleanProperty("Whether additional shortest paths were omitted after reaching maxPaths."),
      },
      required: ["reachable", "pathCount", "maxPaths", "shortestPathEdgeCount", "truncated"],
      additionalProperties: false,
    },
    paths: {
      type: ["array", "null"],
      description: "Compact ordered shortest paths when a flow was attempted.",
      items: RUN_PIPELINE_FLOW_PATH_SCHEMA,
    },
    flowRef: {
      type: ["string", "null"],
      description: "Stable deferred reference id for the full logic-flow output, when included.",
    },
    candidatesConsidered: integerProperty("Number of conservative endpoint candidates considered."),
    matchedCandidates: integerProperty("Number of candidates explicitly mentioned by the task."),
  },
  [
    "included",
    "skipReason",
    "endpointStrategy",
    "bothDirectionsReachable",
    "start",
    "end",
    "summary",
    "paths",
    "flowRef",
    "candidatesConsidered",
    "matchedCandidates",
  ],
);

const RUN_PIPELINE_MEMORY_OBSERVATION_SCHEMA = objectProperty(
  "Compact observation summary surfaced for memory evidence.",
  {
    repoAlias: stringProperty("Workspace repo alias when observation came from a multi-repo workspace."),
    observationId: stringProperty("Stable observation id."),
    kind: stringProperty("Observation kind."),
    summary: stringProperty("Short observation summary."),
    createdAtMs: integerProperty("Observation creation timestamp."),
    sessionId: {
      type: ["string", "null"],
      description: "Session id that produced the observation when available.",
    },
  },
  ["observationId", "kind", "summary", "createdAtMs", "sessionId"],
);

const RUN_PIPELINE_MEMORY_SECTION_SCHEMA = objectProperty(
  "Memory and session evidence that contributed to orchestration.",
  {
    session: objectProperty(
      "Recent session evidence.",
      {
        included: booleanProperty("Whether session evidence was included."),
        skipReason: {
          type: ["string", "null"],
          description: "Why session evidence was omitted, when applicable.",
        },
        sessionId: {
          type: ["string", "null"],
          description: "Session id used for session-context retrieval.",
        },
        observationCount: integerProperty("Total observations known for the session."),
        recentObservations: arrayProperty(
          "Compact preview of recent session observations.",
          RUN_PIPELINE_MEMORY_OBSERVATION_SCHEMA,
        ),
      },
      [
        "included",
        "skipReason",
        "sessionId",
        "observationCount",
        "recentObservations",
      ],
    ),
    durable: objectProperty(
      "Durable cross-session memory evidence.",
      {
        included: booleanProperty("Whether durable memory evidence was included."),
        skipReason: {
          type: ["string", "null"],
          description: "Why durable memory evidence was omitted, when applicable.",
        },
        matchedCount: integerProperty("Number of durable observations that matched the query."),
        topObservations: arrayProperty(
          "Compact top scoring durable observations.",
          RUN_PIPELINE_MEMORY_OBSERVATION_SCHEMA,
        ),
      },
      ["included", "skipReason", "matchedCount", "topObservations"],
    ),
    capsuleSurfaced: objectProperty(
      "Memories already surfaced by capsule assembly.",
      {
        included: booleanProperty("Whether the capsule surfaced relevant memory."),
        skipReason: {
          type: ["string", "null"],
          description: "Why capsule-surfaced memory was omitted, when applicable.",
        },
        matchedCount: integerProperty("Number of capsule-surfaced memory items."),
        memories: arrayProperty("Compact capsule-surfaced memory items.", CAPSULE_MEMORY_ITEM_SCHEMA),
      },
      ["included", "skipReason", "matchedCount", "memories"],
    ),
  },
  ["session", "durable", "capsuleSurfaced"],
);

const RUN_PIPELINE_RULE_SCOPE_SCHEMA = objectProperty(
  "Structural scope linked to a project rule.",
  {
    files: arrayProperty("Linked repo-relative files.", stringProperty("File path.")),
    symbolFqns: arrayProperty("Linked fully qualified symbols.", stringProperty("Fully qualified name.")),
    terms: arrayProperty("Deterministic lexical terms.", stringProperty("Term.")),
    toolNames: arrayProperty("Linked tool names.", stringProperty("Tool name.")),
    intents: arrayProperty("Linked intents or presets.", stringProperty("Intent.")),
    antiPatternTypes: arrayProperty("Linked anti-pattern types.", stringProperty("Anti-pattern type.")),
  },
  ["files", "symbolFqns", "terms", "toolNames", "intents", "antiPatternTypes"],
);

const CAPSULE_RULE_SECTION_SCHEMA = objectProperty(
  "Active project rules surfaced separately from memory observations.",
  {
    active: arrayProperty(
      "Relevant active rules.",
      objectProperty(
        "Capsule active rule.",
        {
          repoAlias: stringProperty("Workspace repo alias, when present."),
          id: stringProperty("Project rule id."),
          status: stringProperty("Rule status."),
          summary: stringProperty("Rule summary."),
          scope: objectProperty(
            "Compact rule scope.",
            {
              files: arrayProperty("Linked repo-relative files.", stringProperty("File path.")),
              symbolFqns: arrayProperty("Linked fully qualified symbols.", stringProperty("Fully qualified symbol.")),
              terms: arrayProperty("Lexical terms.", stringProperty("Term.")),
            },
            ["files", "symbolFqns", "terms"],
          ),
          reason: stringProperty("Deterministic relevance reason."),
        },
        ["id", "status", "summary", "scope", "reason"],
      ),
    ),
  },
  ["active"],
);

const RUN_PIPELINE_RULE_SECTION_SCHEMA = objectProperty(
  "Relevant active project rules and candidate previews.",
  {
    included: booleanProperty("Whether any relevant rule or candidate preview was surfaced."),
    active: arrayProperty(
      "Relevant active rules. These are promoted rules only.",
      objectProperty(
        "Active project rule injection.",
        {
          id: stringProperty("Project rule id."),
          status: stringProperty("Rule status."),
          summary: stringProperty("Rule summary."),
          scope: RUN_PIPELINE_RULE_SCOPE_SCHEMA,
          evidenceCount: integerProperty("Number of linked evidence observations."),
          evidenceObservationIds: arrayProperty("Evidence observation ids.", stringProperty("Observation id.")),
          evidenceKinds: arrayProperty("Evidence kinds.", stringProperty("Evidence kind.")),
          confidence: stringProperty("Rule confidence."),
          createdAtMs: integerProperty("Creation timestamp."),
          updatedAtMs: integerProperty("Update timestamp."),
          promotedAtMs: {
            type: ["integer", "null"],
            description: "Promotion timestamp.",
          },
          sourceRunId: {
            type: ["integer", "null"],
            description: "Latest source index run linked to evidence.",
          },
          staleMetadata: {
            type: ["object", "null"],
            description: "Stale metadata when present.",
            additionalProperties: true,
          },
          reason: stringProperty("Deterministic relevance reason."),
          score: integerProperty("Deterministic relevance score."),
        },
        [
          "id",
          "status",
          "summary",
          "scope",
          "evidenceCount",
          "evidenceObservationIds",
          "evidenceKinds",
          "confidence",
          "createdAtMs",
          "updatedAtMs",
          "promotedAtMs",
          "sourceRunId",
          "staleMetadata",
          "reason",
          "score",
        ],
      ),
    ),
    candidates: arrayProperty(
      "Relevant candidate previews. Candidates are not active instructions.",
      objectProperty(
        "Candidate project rule preview.",
        {
          id: stringProperty("Project rule id."),
          status: stringProperty("Rule status."),
          summary: stringProperty("Rule summary."),
          evidenceCount: integerProperty("Number of linked evidence observations."),
          confidence: stringProperty("Rule confidence."),
          reason: stringProperty("Deterministic relevance reason."),
          score: integerProperty("Deterministic relevance score."),
        },
        ["id", "status", "summary", "evidenceCount", "confidence", "reason", "score"],
      ),
    ),
    activeCount: integerProperty("Total active rules in this repo before relevance limiting."),
    candidateCount: integerProperty("Total candidate rules in this repo before relevance limiting."),
    omitted: objectProperty(
      "Rules omitted from active injection.",
      {
        irrelevantActiveRuleCount: integerProperty("Active rules that did not fit this task or exceeded the cap."),
        candidateRuleCount: integerProperty("Candidate rules not injected as active guidance."),
        staleRuleCount: integerProperty("Stale rules not injected as active guidance."),
        disabledRuleCount: integerProperty("Disabled rules not injected."),
        dismissedRuleCount: integerProperty("Dismissed rules not injected."),
      },
      ["irrelevantActiveRuleCount", "candidateRuleCount", "staleRuleCount", "disabledRuleCount", "dismissedRuleCount"],
    ),
    notes: arrayProperty("Rule behavior notes.", stringProperty("Note.")),
  },
  ["included", "active", "candidates", "activeCount", "candidateCount", "omitted", "notes"],
);

const RUN_PIPELINE_ORCHESTRATION_DIAGNOSTICS_SCHEMA = objectProperty(
  "Explicit orchestration diagnostics combining intent, retrieval, impact, and memory decisions.",
  {
    intent: objectProperty(
      "Intent-selection diagnostics.",
      {
        requested: stringProperty("Preset requested by caller."),
        selected: stringProperty("Preset resolved by the orchestrator."),
        source: stringProperty("How the preset was resolved."),
        fallbackApplied: booleanProperty("Whether auto-selection fell back to a default."),
      },
      ["requested", "selected", "source", "fallbackApplied"],
    ),
    retrieval: RUN_PIPELINE_DIAGNOSTICS_SCHEMA,
    impact: objectProperty(
      "Impact decision diagnostics.",
      {
        included: booleanProperty("Whether the impact section was included."),
        skipReason: {
          type: ["string", "null"],
          description: "Why the impact section was omitted, when applicable.",
        },
        triggerReason: {
          type: ["string", "null"],
          description: "Trigger reason recognized by the orchestrator, when evaluated.",
        },
        candidatesConsidered: integerProperty("Number of conservative focal-symbol candidates considered."),
        matchedCandidates: integerProperty("Number of task-mentioned focal-symbol candidates."),
      },
      ["included", "skipReason", "triggerReason", "candidatesConsidered", "matchedCandidates"],
    ),
    flow: objectProperty(
      "Logic-flow decision diagnostics.",
      {
        included: booleanProperty("Whether a reachable structural flow was included."),
        skipReason: {
          type: ["string", "null"],
          description: "Why the flow section was omitted, when applicable.",
        },
        endpointStrategy: {
          type: ["string", "null"],
          description: "How directed endpoints were resolved, when evaluated.",
        },
        bothDirectionsReachable: booleanProperty("Whether both directed orderings were reachable during probing."),
        reachable: {
          type: ["boolean", "null"],
          description: "Whether the chosen directed flow was reachable, when a flow was attempted.",
        },
        candidatesConsidered: integerProperty("Number of conservative endpoint candidates considered."),
        matchedCandidates: integerProperty("Number of task-mentioned endpoint candidates."),
      },
      [
        "included",
        "skipReason",
        "endpointStrategy",
        "bothDirectionsReachable",
        "reachable",
        "candidatesConsidered",
        "matchedCandidates",
      ],
    ),
    memory: objectProperty(
      "Memory decision diagnostics.",
      {
        sessionIncluded: booleanProperty("Whether session evidence was included."),
        sessionSkipReason: {
          type: ["string", "null"],
          description: "Why session evidence was omitted, when applicable.",
        },
        durableIncluded: booleanProperty("Whether durable memory evidence was included."),
        durableSkipReason: {
          type: ["string", "null"],
          description: "Why durable memory evidence was omitted, when applicable.",
        },
        capsuleSurfacedIncluded: booleanProperty("Whether capsule assembly surfaced memory."),
        capsuleSurfacedSkipReason: {
          type: ["string", "null"],
          description: "Why capsule-surfaced memory was omitted, when applicable.",
        },
      },
      [
        "sessionIncluded",
        "sessionSkipReason",
        "durableIncluded",
        "durableSkipReason",
        "capsuleSurfacedIncluded",
        "capsuleSurfacedSkipReason",
      ],
    ),
    rules: objectProperty(
      "Project-rule relevance diagnostics.",
      {
        included: booleanProperty("Whether any relevant rule or candidate preview was surfaced."),
        activeIncluded: booleanProperty("Whether active rules were injected."),
        activeMatchedCount: integerProperty("Number of active rules injected after relevance limiting."),
        activeTotalCount: integerProperty("Total active rules in the repo."),
        candidatePreviewCount: integerProperty("Number of candidate previews surfaced."),
        candidateTotalCount: integerProperty("Total candidate rules in the repo."),
        staleTotalCount: integerProperty("Total stale rules in the repo."),
        disabledTotalCount: integerProperty("Total disabled rules in the repo."),
        dismissedTotalCount: integerProperty("Total dismissed rules in the repo."),
      },
      [
        "included",
        "activeIncluded",
        "activeMatchedCount",
        "activeTotalCount",
        "candidatePreviewCount",
        "candidateTotalCount",
        "staleTotalCount",
        "disabledTotalCount",
        "dismissedTotalCount",
      ],
    ),
    budget: objectProperty(
      "Budget and truncation diagnostics.",
      {
        model: stringProperty("Budget model."),
        maxCharacters: integerProperty("Maximum allowed characters."),
        usedCharacters: integerProperty("Used characters."),
        remainingCharacters: integerProperty("Remaining characters."),
        contextTruncated: booleanProperty("Whether context was truncated."),
        contextCompressed: booleanProperty("Whether context was compressed."),
      },
      [
        "model",
        "maxCharacters",
        "usedCharacters",
        "remainingCharacters",
        "contextTruncated",
        "contextCompressed",
      ],
    ),
    freshness: INDEX_FRESHNESS_SCHEMA,
    indexFreshness: GET_CODE_CONTEXT_INDEX_FRESHNESS_DIAGNOSTIC_SCHEMA,
    nudge: OBSERVATION_NUDGE_SCHEMA,
    deferredCount: integerProperty("Number of deferred expandable placeholders emitted."),
    omittedSectionCount: integerProperty("Number of top-level sections (context, impact, flow, session, durable) omitted."),
  },
  ["intent", "retrieval", "impact", "flow", "memory", "rules", "budget", "deferredCount", "omittedSectionCount"],
);

const RUN_PIPELINE_DEFERRED_ITEM_SCHEMA = objectProperty(
  "A stable deferred placeholder.",
  {
    id: stringProperty("Stable internal reference id."),
    hash: stringProperty("Public 12-hex V-REF hash accepted by expand_vexp_ref when expandable=true."),
    kind: stringProperty("Kind of deferred content (context_capsule, impact_graph, logic_flow, session_context, durable_memory)."),
    summary: stringProperty("Human-readable description of what would be expanded."),
    expandable: booleanProperty("Whether this item has a real expansion path."),
    expansionTool: stringProperty("Expansion tool when expandable."),
    suggestedTool: stringProperty("MCP tool that currently exposes this expansion."),
    suggestedInput: objectProperty(
      "Suggested input to pass to the expansion tool.",
      {
        query: { type: ["string", "null"], description: "Query when applicable." },
        maxBudgetCharacters: { type: ["integer", "null"], description: "Budget when applicable." },
        symbol_fqn: { type: ["string", "null"], description: "Symbol fqn when applicable." },
        depth: { type: ["integer", "null"], description: "Depth when applicable." },
        sessionId: { type: ["string", "null"], description: "Session id when applicable." },
        start: { type: ["string", "null"], description: "Logic-flow start fqn when applicable." },
        end: { type: ["string", "null"], description: "Logic-flow end fqn when applicable." },
        max_paths: { type: ["integer", "null"], description: "Logic-flow max paths when applicable." },
      },
      [],
    ),
  },
  ["id", "hash", "kind", "summary", "expandable", "expansionTool", "suggestedTool", "suggestedInput"],
);

const RUN_PIPELINE_DEFERRED_SECTION_SCHEMA = objectProperty(
  "Deferred expansion metadata.",
  {
    items: arrayProperty("Deferred items emitted by this pipeline run.", RUN_PIPELINE_DEFERRED_ITEM_SCHEMA),
    expandable: booleanProperty("Whether at least one deferred item is expandable."),
    expansionTool: {
      type: ["string", "null"],
      description: "Expansion tool to use when expandable.",
    },
    notes: arrayProperty("Honest notes about deferred expansion support.", stringProperty("Deferred note.")),
  },
  ["items", "expandable", "expansionTool", "notes"],
);

const RAW_CAPSULE_ITEM_SCHEMA = objectProperty(
  "A raw capsule item as emitted in the canonical handoff payload.",
  {
    symbolId: stringProperty("Stable persisted symbol id."),
    filePath: stringProperty("Normalized repo-relative file path."),
    fqName: stringProperty("Fully qualified symbol name."),
    localName: stringProperty("Local symbol name."),
    kind: stringProperty("Symbol kind."),
    role: stringProperty("Capsule item role."),
    content: CAPSULE_CONTENT_SCHEMA,
    inclusionReasons: arrayProperty("Capsule inclusion reasons.", CAPSULE_INCLUSION_REASON_SCHEMA),
    budgetCost: integerProperty("Capsule budget cost for this item."),
    compressed: booleanProperty("Whether this item was compressed."),
    sourceBacked: booleanProperty("Whether this item is source-backed."),
    lexicalScore: numberProperty("Lexical score when available."),
    graphScore: numberProperty("Graph score when available."),
    finalScore: numberProperty("Final score when available."),
  },
  [
    "symbolId",
    "filePath",
    "fqName",
    "localName",
    "kind",
    "role",
    "content",
    "inclusionReasons",
    "budgetCost",
    "compressed",
  ],
);

const CAPSULE_BUDGET_SCHEMA = objectProperty(
  "Capsule budget usage.",
  {
    model: stringProperty("Budget model."),
    maxCharacters: integerProperty("Maximum allowed characters."),
    usedCharacters: integerProperty("Used characters."),
    remainingCharacters: integerProperty("Remaining characters."),
  },
  ["model", "maxCharacters", "usedCharacters", "remainingCharacters"],
);

const CAPSULE_PROFILE_BUDGET_USAGE_SCHEMA = objectProperty(
  "Capsule profile budget usage.",
  {
    pivotCharactersUsed: integerProperty("Characters used by pivots."),
    supportCharactersUsed: integerProperty("Characters used by supporting items."),
    pivotCharactersMax: {
      type: ["integer", "null"],
      description: "Pivot character limit when profile-budgeted.",
    },
    supportCharactersMax: {
      type: ["integer", "null"],
      description: "Support character limit when profile-budgeted.",
    },
  },
  ["pivotCharactersUsed", "supportCharactersUsed", "pivotCharactersMax", "supportCharactersMax"],
);

const HANDOFF_PROVENANCE_GENERATION_SCHEMA = objectProperty(
  "Handoff generation metadata.",
  {
    sourceKind: stringProperty("Source kind used to produce the payload."),
    builderKind: stringProperty("Builder kind used to produce the payload."),
    generatedAtMs: {
      type: ["integer", "null"],
      description: "Generation timestamp when available.",
    },
  },
  ["sourceKind", "builderKind", "generatedAtMs"],
);

const HANDOFF_PROVENANCE_SCHEMA = objectProperty(
  "Handoff provenance metadata.",
  {
    repoRoot: {
      type: ["string", "null"],
      description: "Repo root when available.",
    },
    repoId: {
      type: ["string", "null"],
      description: "Repo id when available.",
    },
    sourceRunId: {
      type: ["integer", "null"],
      description: "Source run id when available.",
    },
    manifestId: {
      type: ["string", "null"],
      description: "Capsule manifest id when available.",
    },
    payloadSchemaVersion: stringProperty("Payload schema version."),
    generation: HANDOFF_PROVENANCE_GENERATION_SCHEMA,
  },
  ["repoRoot", "repoId", "sourceRunId", "manifestId", "payloadSchemaVersion", "generation"],
);

const HANDOFF_TRUST_SCHEMA = objectProperty(
  "Handoff trust metadata.",
  {
    capsuleStaleness: {
      type: ["object", "null"],
      description: "Capsule staleness metadata when available.",
      properties: {
        capsuleId: stringProperty("Capsule manifest id."),
        sourceRunId: integerProperty("Source run id."),
        comparisonRunId: integerProperty("Comparison run id."),
        query: stringProperty("Capsule query."),
        status: stringProperty("Overall staleness status."),
        items: arrayProperty(
          "Item-level capsule staleness details.",
          objectProperty(
            "A staleness item.",
            {
              capsuleId: stringProperty("Capsule manifest id."),
              itemOrdinal: integerProperty("Capsule item ordinal."),
              role: stringProperty("Capsule item role."),
              contentMode: stringProperty("Capsule content mode."),
              sourceBacked: booleanProperty("Whether the capsule item is source-backed."),
              filePath: stringProperty("Repo-relative file path."),
              symbol: objectProperty(
                "Symbol identity summary.",
                {
                  filePath: stringProperty("Repo-relative file path."),
                  fqName: stringProperty("Fully qualified symbol name."),
                  kind: stringProperty("Symbol kind."),
                },
                ["filePath", "fqName", "kind"],
              ),
              status: stringProperty("Item staleness status."),
              reasons: arrayProperty(
                "Staleness reasons.",
                objectProperty(
                  "A capsule staleness reason.",
                  {
                    kind: stringProperty("Reason kind."),
                    detectedInRunId: integerProperty("Run id that detected the reason."),
                    filePath: stringProperty("Affected file path."),
                    symbol: objectProperty(
                      "Affected symbol identity summary.",
                      {
                        filePath: stringProperty("Repo-relative file path."),
                        fqName: stringProperty("Fully qualified symbol name."),
                        kind: stringProperty("Symbol kind."),
                      },
                      ["filePath", "fqName", "kind"],
                    ),
                  },
                  ["kind", "detectedInRunId"],
                ),
              ),
            },
            [
              "capsuleId",
              "itemOrdinal",
              "role",
              "contentMode",
              "sourceBacked",
              "filePath",
              "symbol",
              "status",
              "reasons",
            ],
          ),
        ),
      },
      required: [
        "capsuleId",
        "sourceRunId",
        "comparisonRunId",
        "query",
        "status",
        "items",
      ],
      additionalProperties: false,
    },
  },
  ["capsuleStaleness"],
);

const CAPSULE_STALE_REASON_SCHEMA = objectProperty(
  "A capsule staleness reason.",
  {
    kind: stringProperty("Reason kind."),
    detectedInRunId: integerProperty("Run id that detected the reason."),
    filePath: stringProperty("Affected file path."),
    symbol: objectProperty(
      "Affected symbol identity summary.",
      {
        filePath: stringProperty("Repo-relative file path."),
        fqName: stringProperty("Fully qualified symbol name."),
        kind: stringProperty("Symbol kind."),
      },
      ["filePath", "fqName", "kind"],
    ),
  },
  ["kind", "detectedInRunId"],
);

const CAPSULE_STALENESS_ITEM_SCHEMA = objectProperty(
  "A capsule staleness item.",
  {
    capsuleId: stringProperty("Capsule manifest id."),
    itemOrdinal: integerProperty("Capsule item ordinal."),
    role: stringProperty("Capsule item role."),
    contentMode: stringProperty("Capsule content mode."),
    sourceBacked: booleanProperty("Whether the item is source-backed."),
    filePath: stringProperty("Repo-relative file path."),
    symbol: objectProperty(
      "Symbol identity summary.",
      {
        filePath: stringProperty("Repo-relative file path."),
        fqName: stringProperty("Fully qualified symbol name."),
        kind: stringProperty("Symbol kind."),
      },
      ["filePath", "fqName", "kind"],
    ),
    status: stringProperty("Item staleness status."),
    reasons: arrayProperty("Staleness reasons.", CAPSULE_STALE_REASON_SCHEMA),
  },
  [
    "capsuleId",
    "itemOrdinal",
    "role",
    "contentMode",
    "sourceBacked",
    "filePath",
    "symbol",
    "status",
    "reasons",
  ],
);

const CAPSULE_STALENESS_SCHEMA = objectProperty(
  "Capsule staleness result.",
  {
    capsuleId: stringProperty("Persisted capsule manifest id."),
    sourceRunId: integerProperty("Source run id used to build the capsule."),
    comparisonRunId: integerProperty("Run id used for comparison."),
    query: stringProperty("Original capsule query."),
    status: stringProperty("Overall staleness status."),
    items: arrayProperty("Per-item staleness results.", CAPSULE_STALENESS_ITEM_SCHEMA),
  },
  ["capsuleId", "sourceRunId", "comparisonRunId", "query", "status", "items"],
);

const OBSERVATION_SYMBOL_LINK_SCHEMA = objectProperty(
  "A symbol link attached to an observation.",
  {
    observationId: stringProperty("Observation id."),
    linkOrdinal: integerProperty("Stable symbol-link ordinal."),
    symbolId: stringProperty("Persisted symbol id captured at observation time."),
    filePath: stringProperty("Repo-relative file path."),
    fqName: stringProperty("Fully qualified symbol name."),
    symbolKind: stringProperty("Symbol kind."),
  },
  ["observationId", "linkOrdinal", "symbolId", "filePath", "fqName", "symbolKind"],
);

const OBSERVATION_STALE_REASON_SCHEMA = objectProperty(
  "An observation staleness reason.",
  {
    kind: stringProperty("Reason kind."),
    detectedInRunId: integerProperty("Run id that detected the reason."),
    filePath: stringProperty("Affected file path when the reason is file-scoped."),
    symbol: objectProperty(
      "Affected symbol identity summary when the reason is symbol-scoped.",
      {
        filePath: stringProperty("Repo-relative file path."),
        fqName: stringProperty("Fully qualified symbol name."),
        kind: stringProperty("Symbol kind."),
      },
      ["filePath", "fqName", "kind"],
    ),
  },
  ["kind", "detectedInRunId"],
);

const OBSERVATION_STALENESS_SCHEMA = objectProperty(
  "Observation staleness result.",
  {
    observationId: stringProperty("Observation id."),
    sourceRunId: {
      type: ["integer", "null"],
      description: "Run id captured when the observation was created, when available.",
    },
    comparisonRunId: {
      type: ["integer", "null"],
      description: "Run id used for comparison, when available.",
    },
    status: stringProperty("Overall staleness status."),
    reasons: arrayProperty("Observation staleness reasons.", OBSERVATION_STALE_REASON_SCHEMA),
  },
  ["observationId", "sourceRunId", "comparisonRunId", "status", "reasons"],
);

const OBSERVATION_SCHEMA = objectProperty(
  "A persisted observation.",
  {
    repoAlias: stringProperty("Workspace repo alias when observation came from a multi-repo workspace."),
    id: stringProperty("Deterministic observation id."),
    repoRoot: stringProperty("Bound repo root."),
    sessionId: {
      type: ["string", "null"],
      description: "Session id when the observation is session-linked.",
    },
    kind: stringProperty("Observation kind."),
    source: stringProperty("Observation source."),
    toolName: {
      type: ["string", "null"],
      description: "Originating tool name when available.",
    },
    queryText: {
      type: ["string", "null"],
      description: "Related query text when available.",
    },
    intent: {
      type: ["string", "null"],
      description: "Related selected intent when available.",
    },
    summary: stringProperty("Short observation summary."),
    body: stringProperty("Observation body text."),
    sourceRunId: {
      type: ["integer", "null"],
      description: "Source run id captured when the observation was created.",
    },
    createdAtMs: integerProperty("Observation creation timestamp in milliseconds."),
    linkedFilePaths: arrayProperty("Linked repo-relative file paths.", stringProperty("File path.")),
    linkedSymbols: arrayProperty("Linked persisted symbol identities.", OBSERVATION_SYMBOL_LINK_SCHEMA),
    linkedFqNames: arrayProperty("Linked fully qualified names.", stringProperty("Fully qualified name.")),
  },
  [
    "id",
    "repoRoot",
    "sessionId",
    "kind",
    "source",
    "toolName",
    "queryText",
    "intent",
    "summary",
    "body",
    "sourceRunId",
    "createdAtMs",
    "linkedFilePaths",
    "linkedSymbols",
    "linkedFqNames",
  ],
);

const SESSION_SCHEMA = objectProperty(
  "A persisted session entity.",
  {
    sessionId: stringProperty("Explicit persisted session id."),
    repoRoot: stringProperty("Bound repo root."),
    agentKind: {
      type: ["string", "null"],
      description: "Lightweight agent-kind tag when available.",
    },
    startedAtMs: integerProperty("Session creation timestamp in milliseconds."),
    lastActivityAtMs: integerProperty("Last observed session activity timestamp in milliseconds."),
    status: stringProperty("Explicit session status."),
    compressedAtMs: {
      type: ["integer", "null"],
      description: "Compression timestamp when the session has been compressed.",
    },
    summaryId: {
      type: ["string", "null"],
      description: "Compression summary id when the session has been compressed.",
    },
  },
  ["sessionId", "repoRoot", "agentKind", "startedAtMs", "lastActivityAtMs", "status", "compressedAtMs", "summaryId"],
);

const SESSION_KIND_COUNTS_SCHEMA = objectProperty(
  "Observation kind counts within a session summary.",
  {
    decision: integerProperty("Decision observation count."),
    insight: integerProperty("Insight observation count."),
    warning: integerProperty("Warning observation count."),
    deadEnd: integerProperty("Dead-end observation count."),
    toolCall: integerProperty("Tool-call observation count."),
  },
  ["decision", "insight", "warning", "deadEnd", "toolCall"],
);

const SESSION_QUERY_TERM_COUNT_SCHEMA = objectProperty(
  "A repeated exact query term count.",
  {
    term: stringProperty("Normalized query term."),
    count: integerProperty("Number of observations whose query text included the term."),
  },
  ["term", "count"],
);

const SESSION_SUMMARY_SCHEMA = objectProperty(
  "A compact deterministic summary derived from session observations.",
  {
    observationCount: integerProperty("Total observation count."),
    lastObservationAtMs: {
      type: ["integer", "null"],
      description: "Newest observation timestamp when available.",
    },
    freshObservationCount: integerProperty("Fresh observation count."),
    staleObservationCount: integerProperty("Stale observation count."),
    kindCounts: SESSION_KIND_COUNTS_SCHEMA,
    recentFilePaths: arrayProperty("Recent linked file paths.", stringProperty("Repo-relative file path.")),
    recentSymbolIds: arrayProperty("Recent linked symbol ids.", stringProperty("Persisted symbol id.")),
    recentFqNames: arrayProperty("Recent linked fully qualified names.", stringProperty("Fully qualified name.")),
    repeatedQueryTerms: arrayProperty("Repeated exact query terms.", SESSION_QUERY_TERM_COUNT_SCHEMA),
  },
  [
    "observationCount",
    "lastObservationAtMs",
    "freshObservationCount",
    "staleObservationCount",
    "kindCounts",
    "recentFilePaths",
    "recentSymbolIds",
    "recentFqNames",
    "repeatedQueryTerms",
  ],
);

const SESSION_LIST_ITEM_SCHEMA = objectProperty(
  "A compact session listing row.",
  {
    sessionId: stringProperty("Explicit persisted session id."),
    agentKind: {
      type: ["string", "null"],
      description: "Lightweight agent-kind tag when available.",
    },
    status: stringProperty("Explicit session status."),
    startedAtMs: integerProperty("Session creation timestamp in milliseconds."),
    lastActivityAtMs: integerProperty("Last observed session activity timestamp in milliseconds."),
    compressedAtMs: {
      type: ["integer", "null"],
      description: "Compression timestamp when the session has been compressed.",
    },
    summaryId: {
      type: ["string", "null"],
      description: "Compression summary id when the session has been compressed.",
    },
    observationCount: integerProperty("Number of observations linked to the session."),
  },
  ["sessionId", "agentKind", "status", "startedAtMs", "lastActivityAtMs", "compressedAtMs", "summaryId", "observationCount"],
);

const SESSION_TOOL_CALL_COUNT_SCHEMA = objectProperty(
  "A per-tool tool-call count in a compressed session summary.",
  {
    tool: stringProperty("MCP tool name."),
    count: integerProperty("Number of captured tool-call observations for that tool."),
  },
  ["tool", "count"],
);

const SESSION_COMPRESSION_SUMMARY_SCHEMA = objectProperty(
  "A deterministic structural summary for a compressed session.",
  {
    id: stringProperty("Deterministic compression summary id."),
    sessionId: stringProperty("Compressed session id."),
    repoRoot: stringProperty("Bound repo root."),
    createdAtMs: integerProperty("Summary creation timestamp in milliseconds."),
    firstActivityAtMs: integerProperty("First session activity timestamp in milliseconds."),
    lastActivityAtMs: integerProperty("Last session activity timestamp in milliseconds."),
    compressedAtMs: integerProperty("Compression timestamp in milliseconds."),
    observationCounts: SESSION_KIND_COUNTS_SCHEMA,
    toolCallCounts: arrayProperty("Tool-call counts by tool.", SESSION_TOOL_CALL_COUNT_SCHEMA),
    filePaths: arrayProperty("Unique linked file paths summarized from the session.", stringProperty("Repo-relative file path.")),
    symbolIds: arrayProperty("Unique linked symbol ids summarized from the session.", stringProperty("Persisted symbol id.")),
    fqNames: arrayProperty("Unique linked symbol FQNs summarized from the session.", stringProperty("Fully qualified symbol name.")),
    keyTerms: arrayProperty("Deterministic lexical key terms from the session.", stringProperty("Key term.")),
    preservedDurableObservationCount: integerProperty("Non-ephemeral observations preserved after compression."),
    prunedToolCallObservationCount: integerProperty("Repeated ephemeral MCP auto tool-call observations pruned through passive consolidation during compression."),
    summaryObservationId: stringProperty("Searchable summary observation id."),
  },
  [
    "id",
    "sessionId",
    "repoRoot",
    "createdAtMs",
    "firstActivityAtMs",
    "lastActivityAtMs",
    "compressedAtMs",
    "observationCounts",
    "toolCallCounts",
    "filePaths",
    "symbolIds",
    "fqNames",
    "keyTerms",
    "preservedDurableObservationCount",
    "prunedToolCallObservationCount",
    "summaryObservationId",
  ],
);

const SESSION_OBSERVATION_PREVIEW_SCHEMA = objectProperty(
  "A compact recent observation preview.",
  {
    observationId: stringProperty("Stable observation id."),
    kind: stringProperty("Observation kind."),
    summary: stringProperty("Short observation summary."),
    createdAtMs: integerProperty("Observation creation timestamp in milliseconds."),
  },
  ["observationId", "kind", "summary", "createdAtMs"],
);

const OBSERVATION_SEARCH_SIGNAL_SCHEMA = objectProperty(
  "A deterministic observation ranking contribution.",
  {
    kind: stringProperty("Ranking signal kind."),
    field: {
      type: ["string", "null"],
      description: "Field affected by the ranking signal when available.",
    },
    scoreContribution: numberProperty("Score contribution from this signal."),
    matchedValues: arrayProperty("Matched values for this signal.", stringProperty("Matched value.")),
  },
  ["kind", "field", "scoreContribution", "matchedValues"],
);

const OBSERVATION_SEARCH_RESULT_SCHEMA = objectProperty(
  "A ranked observation memory result.",
  {
    observation: {
      type: "object",
      description: "Persisted observation.",
      properties: {
        ...(OBSERVATION_SCHEMA.properties ?? {}),
      },
      required: OBSERVATION_SCHEMA.required ?? [],
      additionalProperties: false,
    },
    staleness: OBSERVATION_STALENESS_SCHEMA,
    score: numberProperty("Final deterministic search score."),
    signals: arrayProperty("Ranking signals.", OBSERVATION_SEARCH_SIGNAL_SCHEMA),
  },
  ["observation", "staleness", "score", "signals"],
);

const LAUNCHER_COMMAND_SCHEMA = objectProperty(
  "A stable local launcher command.",
  {
    command: stringProperty("Launcher executable."),
    args: arrayProperty("Launcher arguments.", stringProperty("Launcher argument.")),
  },
  ["command", "args"],
);

const SKELETON_IMPORT_SCHEMA = objectProperty(
  "A compact import summary entry.",
  {
    fromFilePath: stringProperty("Repo-relative file path providing the imported symbol."),
    name: stringProperty("Imported symbol name."),
    kind: stringProperty("Imported symbol kind."),
  },
  ["fromFilePath", "name", "kind"],
);

const SKELETON_EXPORT_SCHEMA = objectProperty(
  "A compact export summary entry.",
  {
    name: stringProperty("Exported top-level declaration name."),
    kind: stringProperty("Exported declaration kind."),
  },
  ["name", "kind"],
);

const SKELETON_MEMBER_SCHEMA = objectProperty(
  "A class member skeleton entry.",
  {
    kind: stringProperty("Structural member kind."),
    name: stringProperty("Member name."),
    signature: {
      type: ["string", "null"],
      description: "Signature-only structural text when included by the selected detail level.",
    },
    startLine: {
      type: ["integer", "null"],
      description: "1-based starting line when included by the selected detail level.",
    },
    endLine: {
      type: ["integer", "null"],
      description: "1-based ending line when included by the selected detail level.",
    },
    docstring: {
      type: ["string", "null"],
      description: "Optional indexed leading docstring/comment snippet when included.",
    },
    decorators: arrayProperty("Indexed decorator metadata when included.", stringProperty("Decorator text.")),
  },
  ["kind", "name", "signature", "startLine", "endLine", "docstring", "decorators"],
);

const SKELETON_DECLARATION_SCHEMA = objectProperty(
  "A top-level declaration skeleton entry.",
  {
    kind: stringProperty("Top-level declaration kind."),
    name: stringProperty("Declaration name."),
    exported: booleanProperty("Whether the declaration is exported."),
    signature: {
      type: ["string", "null"],
      description: "Signature-only structural text when included by the selected detail level.",
    },
    startLine: {
      type: ["integer", "null"],
      description: "1-based starting line when included by the selected detail level.",
    },
    endLine: {
      type: ["integer", "null"],
      description: "1-based ending line when included by the selected detail level.",
    },
    docstring: {
      type: ["string", "null"],
      description: "Optional indexed leading docstring/comment snippet when included.",
    },
    decorators: arrayProperty("Indexed decorator metadata when included.", stringProperty("Decorator text.")),
    members: arrayProperty("Nested class member skeleton entries.", SKELETON_MEMBER_SCHEMA),
  },
  ["kind", "name", "exported", "signature", "startLine", "endLine", "docstring", "decorators", "members"],
);

const SKELETON_FILE_RESULT_SCHEMA = objectProperty(
  "A per-file skeleton result.",
  {
    status: stringProperty("Per-file skeletonization status."),
    filePath: stringProperty("Normalized repo-relative file path."),
    language: {
      type: ["string", "null"],
      description: "Indexed file language when structural data is available.",
    },
    message: {
      type: ["string", "null"],
      description: "Explicit per-file explanation when no skeleton is available.",
    },
    imports: arrayProperty("Compact import summary.", SKELETON_IMPORT_SCHEMA),
    exports: arrayProperty("Compact export summary.", SKELETON_EXPORT_SCHEMA),
    declarations: arrayProperty("Ordered top-level declarations.", SKELETON_DECLARATION_SCHEMA),
  },
  ["status", "filePath", "language", "message", "imports", "exports", "declarations"],
);

const GET_SKELETON_OUTPUT_SCHEMA = objectProperty(
  "Deterministic structural file skeletons.",
  {
    detail: stringProperty("Applied skeleton detail level."),
    files: arrayProperty("Per-file skeleton results in requested order.", SKELETON_FILE_RESULT_SCHEMA),
  },
  ["detail", "files"],
);

const WORKSPACE_REPO_STATUS_SCHEMA = objectProperty(
  "Per-repo index status inside a multi-repo workspace.",
  {
    repoAlias: stringProperty("Stable workspace repo alias."),
    repoRoot: stringProperty("Repo root."),
    configPath: stringProperty("Repo-local config path."),
    statePath: stringProperty("Repo-local state path."),
    dbPath: stringProperty("Repo-local database path."),
    enabled: booleanProperty("Whether this repo is enabled in the workspace config."),
    configPresent: booleanProperty("Whether repo-local config exists."),
    statePresent: booleanProperty("Whether repo-local state exists."),
    dbPresent: booleanProperty("Whether repo-local database exists."),
    initialized: booleanProperty("Whether repo-local init state is complete."),
    indexPresent: booleanProperty("Whether a latest persisted run is present."),
    latestRunId: {
      type: ["integer", "null"],
      description: "Latest persisted run id when available.",
    },
    readiness: {
      type: ["object", "null"],
      description: "Repo readiness when repo-local state exists.",
      properties: {
        ...(READINESS_SCHEMA.properties ?? {}),
      },
      required: READINESS_SCHEMA.required ?? [],
      additionalProperties: false,
    },
    freshness: INDEX_FRESHNESS_SCHEMA,
    watcher: FILE_WATCHER_STATUS_SCHEMA,
  },
  [
    "repoAlias",
    "repoRoot",
    "configPath",
    "statePath",
    "dbPath",
    "enabled",
    "configPresent",
    "statePresent",
    "dbPresent",
    "initialized",
    "indexPresent",
    "latestRunId",
    "readiness",
    "freshness",
    "watcher",
  ],
);

const INDEX_STATUS_SCHEMA = objectProperty(
  "Compact repo index status.",
  {
    workspace: {
      type: ["object", "null"],
      description: "Workspace metadata when a multi-repo workspace config is active.",
      properties: {
        name: {
          type: ["string", "null"],
          description: "Workspace name when configured.",
        },
        primaryRepoAlias: stringProperty("Primary repo alias."),
        selectedRepos: arrayProperty("Selected repo aliases.", stringProperty("Repo alias.")),
        configuredRepos: arrayProperty("All configured repo aliases.", stringProperty("Repo alias.")),
      },
      required: ["name", "primaryRepoAlias", "selectedRepos", "configuredRepos"],
      additionalProperties: false,
    },
    repos: arrayProperty("Per-repo status entries when a multi-repo workspace config is active.", WORKSPACE_REPO_STATUS_SCHEMA),
    repoRoot: stringProperty("Bound repo root."),
    configPath: stringProperty("Repo-local config path."),
    statePath: stringProperty("Repo-local state path."),
    dbPath: stringProperty("Repo-local database path."),
    configPresent: booleanProperty("Whether repo-local config exists."),
    statePresent: booleanProperty("Whether repo-local state exists."),
    dbPresent: booleanProperty("Whether repo-local database exists."),
    initialized: booleanProperty("Whether repo-local init state is complete."),
    indexPresent: booleanProperty("Whether a latest persisted run is present."),
    latestRunId: {
      type: ["integer", "null"],
      description: "Latest persisted run id when available.",
    },
    readiness: {
      type: ["object", "null"],
      description: "Repo readiness when repo-local state exists.",
      properties: {
        ...(READINESS_SCHEMA.properties ?? {}),
      },
      required: READINESS_SCHEMA.required ?? [],
      additionalProperties: false,
    },
    freshness: INDEX_FRESHNESS_SCHEMA,
    watcher: FILE_WATCHER_STATUS_SCHEMA,
  },
  [
    "repoRoot",
    "configPath",
    "statePath",
    "dbPath",
    "configPresent",
    "statePresent",
    "dbPresent",
    "initialized",
    "indexPresent",
    "latestRunId",
    "readiness",
    "freshness",
    "watcher",
  ],
);

const WORKSPACE_SETUP_STATUS_SCHEMA = objectProperty(
  "Workspace setup and readiness status.",
  {
    repoRoot: stringProperty("Bound repo root."),
    initialized: booleanProperty("Whether repo-local init state is complete."),
    indexPresent: booleanProperty("Whether a latest persisted run is present."),
    latestRunId: {
      type: ["integer", "null"],
      description: "Latest persisted run id when available.",
    },
    readiness: {
      type: ["object", "null"],
      description: "Repo readiness when available.",
      properties: {
        ...(READINESS_SCHEMA.properties ?? {}),
      },
      required: READINESS_SCHEMA.required ?? [],
      additionalProperties: false,
    },
    claudeCode: objectProperty(
      "Compatibility field for generated local-agent config status.",
      {
        configPath: stringProperty("Generated agent config path."),
        installed: booleanProperty("Whether the agent config contains the vtrace server entry."),
        matchesExpected: booleanProperty("Whether the configured launcher matches the expected stable launcher."),
        launcher: LAUNCHER_COMMAND_SCHEMA,
        error: {
          type: ["string", "null"],
          description: "Config parse or validation error when present.",
        },
      },
      ["configPath", "installed", "matchesExpected", "launcher", "error"],
    ),
    runtime: objectProperty(
      "Local runtime daemon status.",
      {
        running: booleanProperty("Whether the local runtime daemon is running."),
        status: stringProperty("Explicit runtime status."),
        statePath: stringProperty("Runtime state file path."),
        logPath: stringProperty("Runtime log path."),
        launcher: LAUNCHER_COMMAND_SCHEMA,
        staleStatePresent: booleanProperty("Whether stale daemon state metadata is present."),
      },
      ["running", "status", "statePath", "logPath", "launcher", "staleStatePresent"],
    ),
    workspace: {
      type: "object",
      description: "Workspace config inspection when .vtrace/workspace.json exists.",
      properties: {
        configPath: stringProperty("Workspace config path."),
        name: {
          type: ["string", "null"],
          description: "Workspace name when configured.",
        },
        primaryRepoAlias: stringProperty("Primary repo alias."),
        repos: arrayProperty("Configured workspace repos.", WORKSPACE_REPO_STATUS_SCHEMA),
      },
      required: ["configPath", "name", "primaryRepoAlias", "repos"],
      additionalProperties: false,
    },
    nextSteps: arrayProperty("Concrete next-step guidance.", stringProperty("Next step.")),
  },
  [
    "repoRoot",
    "initialized",
    "indexPresent",
    "latestRunId",
    "readiness",
    "claudeCode",
    "runtime",
    "nextSteps",
  ],
);

const WORKSPACE_SETUP_OUTPUT_SCHEMA = objectProperty(
  "Workspace setup inspection or apply result.",
  {
    mode: stringProperty("Whether this call only inspected status or applied setup."),
    status: WORKSPACE_SETUP_STATUS_SCHEMA,
    initAction: {
      type: ["string", "null"],
      description: "Setup init action when apply=true.",
    },
    claudeCodeAction: {
      type: ["string", "null"],
      description: "Compatibility field for generated local-agent config write action when apply=true.",
    },
    runtimeAction: {
      type: ["string", "null"],
      description: "Runtime action when apply=true and runtime start was requested.",
    },
  },
  ["mode", "status", "initAction", "claudeCodeAction", "runtimeAction"],
);

const DEFERRED_TOOL_OUTPUT_SCHEMA = objectProperty(
  "Explicit deferred-capability response.",
  {
    status: stringProperty("Capability status."),
    toolId: stringProperty("Requested tool id."),
    message: stringProperty("Deterministic explanation."),
    reason: stringProperty("Why the capability is deferred."),
    suggestedToolIds: arrayProperty("Available related tool ids.", stringProperty("Suggested tool id.")),
  },
  ["status", "toolId", "message", "reason", "suggestedToolIds"],
);

function placeholderRegistration(): McpToolMetadata["registration"] {
  return {
    registered: true,
    reserved: true,
    availability: McpToolAvailability.Placeholder,
    handlerKind: McpToolHandlerKind.Placeholder,
  };
}

function wiredRegistration(): McpToolMetadata["registration"] {
  return {
    registered: true,
    reserved: true,
    availability: McpToolAvailability.Wired,
    handlerKind: McpToolHandlerKind.EngineDelegate,
  };
}

function createPlaceholderToolDefinition(
  metadata: Omit<McpToolMetadata, "registration">,
): McpToolDefinition {
  return {
    metadata: {
      ...metadata,
      registration: placeholderRegistration(),
    },
    handler(input) {
      return {
        ok: false,
        error: {
          code: McpErrorCode.ToolUnavailable,
          message: `MCP tool ${metadata.toolId} is registered as a placeholder and is not wired yet.`,
          details: {
            toolId: metadata.toolId,
            availability: McpToolAvailability.Placeholder,
            handlerKind: McpToolHandlerKind.Placeholder,
            requestId: input.request.requestId,
          },
        },
      };
    },
  };
}

function createEngineDelegateToolDefinition<TInput, TOutput>(input: {
  metadata: Omit<McpToolMetadata, "registration">;
  handler: McpToolDefinition<TInput, TOutput>["handler"];
}): McpToolDefinition<TInput, TOutput> {
  return {
    metadata: {
      ...input.metadata,
      registration: wiredRegistration(),
    },
    handler: input.handler,
  };
}

function failure(
  code: McpErrorCode,
  message: string,
  details?: Record<string, unknown>,
): McpToolExecutionResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function invalidRequest(
  toolId: McpToolId,
  message: string,
  details?: Record<string, unknown>,
): McpToolExecutionResult<never> {
  return failure(McpErrorCode.InvalidRequest, message, {
    toolId,
    ...(details ?? {}),
  });
}

function repoNotReady(
  toolId: McpToolId,
  message: string,
  details?: Record<string, unknown>,
): McpToolExecutionResult<never> {
  return failure(McpErrorCode.RepoNotReady, message, {
    diagnosticReason: RUN_PIPELINE_DIAGNOSTIC_REASON.RepoNotReady,
    toolId,
    ...(details ?? {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObjectInput(
  toolId: McpToolId,
  input: unknown,
): Record<string, unknown> | McpToolExecutionResult<never> {
  if (!isRecord(input)) {
    return invalidRequest(toolId, `MCP tool ${toolId} requires an object input.`, {
      receivedType: Array.isArray(input) ? "array" : typeof input,
    });
  }

  return input;
}

function parseRequiredQuery(
  toolId: McpToolId,
  input: Record<string, unknown>,
): string | McpToolExecutionResult<never> {
  return parseRequiredStringField(toolId, input, "query");
}

function parseRequiredRunPipelineTask(
  input: Record<string, unknown>,
): string | McpToolExecutionResult<never> {
  const task = parseOptionalStringField(McpToolId.RunPipeline, input, "task");

  if (task !== undefined && typeof task !== "string") {
    return task;
  }

  if (typeof task === "string") {
    return task;
  }

  return parseRequiredStringField(McpToolId.RunPipeline, input, "query");
}

function parseOptionalIntegerAlias(
  toolId: McpToolId,
  input: Record<string, unknown>,
  preferredField: string,
  legacyField: string,
): number | undefined | McpToolExecutionResult<never> {
  const preferred = parseOptionalInteger(toolId, input, preferredField);

  if (preferred !== undefined) {
    return preferred;
  }

  return parseOptionalInteger(toolId, input, legacyField);
}

function parseRequiredStringField(
  toolId: McpToolId,
  input: Record<string, unknown>,
  field: string,
): string | McpToolExecutionResult<never> {
  const value = input[field];

  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidRequest(
      toolId,
      `MCP tool ${toolId} requires a non-empty string ${field}.`,
      { field },
    );
  }

  return value.trim();
}

function parseOptionalInteger(
  toolId: McpToolId,
  input: Record<string, unknown>,
  field: string,
): number | undefined | McpToolExecutionResult<never> {
  const value = input[field];

  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 0) {
    return invalidRequest(
      toolId,
      `MCP tool ${toolId} requires ${field} to be a non-negative integer when provided.`,
      { field, value },
    );
  }

  return value as number;
}

function parseOptionalBoolean(
  toolId: McpToolId,
  input: Record<string, unknown>,
  field: string,
): boolean | undefined | McpToolExecutionResult<never> {
  const value = input[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    return invalidRequest(
      toolId,
      `MCP tool ${toolId} requires ${field} to be a boolean when provided.`,
      { field, value },
    );
  }

  return value;
}

function parseOptionalStringField(
  toolId: McpToolId,
  input: Record<string, unknown>,
  field: string,
): string | undefined | McpToolExecutionResult<never> {
  const value = input[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    return invalidRequest(
      toolId,
      `MCP tool ${toolId} requires ${field} to be a string when provided.`,
      { field, value },
    );
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseOptionalStringArrayField(
  toolId: McpToolId,
  input: Record<string, unknown>,
  field: string,
): string[] | undefined | McpToolExecutionResult<never> {
  const value = input[field];

  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return invalidRequest(
      toolId,
      `MCP tool ${toolId} requires ${field} to be an array of strings when provided.`,
      { field, value },
    );
  }

  return value
    .map((item) => item.trim())
    .filter((item, index, values) => item.length > 0 && values.indexOf(item) === index);
}

function parseRequiredStringArrayField(
  toolId: McpToolId,
  input: Record<string, unknown>,
  field: string,
): string[] | McpToolExecutionResult<never> {
  const value = parseOptionalStringArrayField(toolId, input, field);

  if (!Array.isArray(value) || value.length === 0) {
    return invalidRequest(
      toolId,
      `MCP tool ${toolId} requires ${field} to be a non-empty array of strings.`,
      { field },
    );
  }

  return value;
}

function parseOptionalSkeletonDetail(
  toolId: McpToolId,
  input: Record<string, unknown>,
): SkeletonDetailLevel | undefined | McpToolExecutionResult<never> {
  const detail = parseOptionalStringField(toolId, input, "detail");

  if (detail === undefined) {
    return undefined;
  }

  if (typeof detail !== "string") {
    return detail;
  }

  if ((SKELETON_DETAIL_LEVELS as readonly string[]).includes(detail)) {
    return detail as SkeletonDetailLevel;
  }

  return invalidRequest(
    toolId,
    `MCP tool ${toolId} requires detail to be one of: ${SKELETON_DETAIL_LEVELS.join(", ")}.`,
    { field: "detail", value: detail },
  );
}

function parseObservationKindInput(
  toolId: McpToolId,
  input: Record<string, unknown>,
): ObservationKind | McpToolExecutionResult<never> {
  const value = input.kind;

  if (
    value === ObservationKind.Decision
    || value === ObservationKind.Insight
    || value === ObservationKind.Warning
    || value === ObservationKind.DeadEnd
    || value === ObservationKind.ToolCall
  ) {
    return value;
  }

  return invalidRequest(
    toolId,
    `MCP tool ${toolId} received an invalid observation kind.`,
    { field: "kind", value },
  );
}

function parseOptionalSymbolKind(
  toolId: McpToolId,
  input: Record<string, unknown>,
): SymbolKind | undefined | McpToolExecutionResult<never> {
  const value = input.kind;

  if (value === undefined) {
    return undefined;
  }

  try {
    return parseSymbolKind(value);
  } catch (error) {
    return invalidRequest(
      toolId,
      `MCP tool ${toolId} received an invalid symbol kind.`,
      {
        field: "kind",
        value,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function parseOptionalSearchBackend(
  toolId: McpToolId,
  input: Record<string, unknown>,
): SymbolSearchBackend | undefined | McpToolExecutionResult<never> {
  const value = input.backend;

  if (value === undefined) {
    return undefined;
  }

  if (
    value === SymbolSearchBackend.PlainSql
    || value === SymbolSearchBackend.Fts
  ) {
    return value;
  }

  return invalidRequest(
    toolId,
    `MCP tool ${toolId} received an invalid search backend.`,
    { field: "backend", value },
  );
}

async function safeReadConfig(configPath: string): Promise<RepoLocalConfig | undefined> {
  try {
    return await readRepoLocalConfig(configPath);
  } catch {
    return undefined;
  }
}

async function safeReadState(statePath: string): Promise<RepoLocalState | undefined> {
  try {
    return await readRepoLocalState(statePath);
  } catch {
    return undefined;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveReadyRepoBinding(
  context: McpServerContext,
  toolId: McpToolId,
): Promise<
  | { ok: true; binding: ReadyRepoBinding }
  | { ok: false; result: McpToolExecutionResult<never> }
> {
  const repoRoot = context.repoRoot;

  if (repoRoot === null) {
    return {
      ok: false,
      result: repoNotReady(
        toolId,
        `MCP tool ${toolId} requires a repo-bound server context.`,
      ),
    };
  }

  const paths = resolveRepoLocalPaths(repoRoot);
  const configPath = context.configPath ?? paths.configPath;
  const statePath = context.statePath ?? paths.statePath;
  const config = (await safeReadConfig(configPath)) ?? context.config ?? undefined;
  const state = (await safeReadState(statePath)) ?? context.state ?? undefined;
  const dbPath = context.dbPath ?? config?.dbPath ?? state?.dbPath ?? paths.dbPath;

  if (config === undefined || state === undefined) {
    return {
      ok: false,
      result: repoNotReady(
        toolId,
        `Repository is not initialized for MCP use: ${repoRoot}`,
        {
          repoRoot,
          configPath,
          statePath,
          configPresent: config !== undefined,
          statePresent: state !== undefined,
        },
      ),
    };
  }

  if (config.initialized !== true || state.initialized !== true) {
    return {
      ok: false,
      result: repoNotReady(
        toolId,
        `Repository is not initialized for MCP use: ${repoRoot}`,
        {
          repoRoot,
          configPath,
          statePath,
          configInitialized: config.initialized,
          stateInitialized: state.initialized,
        },
      ),
    };
  }

  if (state.readiness.status !== "ready") {
    return {
      ok: false,
      result: repoNotReady(
        toolId,
        `Repository is not ready for MCP use: ${repoRoot}`,
        {
          repoRoot,
          readiness: state.readiness,
          latestRunId: state.latestRunId,
        },
      ),
    };
  }

  if (!await pathExists(dbPath)) {
    return {
      ok: false,
      result: repoNotReady(
        toolId,
        `Repository database is missing for MCP use: ${repoRoot}`,
        {
          repoRoot,
          dbPath,
        },
      ),
    };
  }

  return {
    ok: true,
    binding: {
      repoRoot,
      dbPath,
      configPath,
      statePath,
      config,
      state,
    },
  };
}

async function withReadyRepoDb<TOutput>(
  context: McpServerContext,
  toolId: McpToolId,
  execute: (binding: ReadyRepoBinding, db: ReturnType<typeof openIndexerDatabase>) => Promise<McpToolExecutionResult<TOutput>> | McpToolExecutionResult<TOutput>,
): Promise<McpToolExecutionResult<TOutput>> {
  const resolved = await resolveReadyRepoBinding(context, toolId);

  if (!resolved.ok) {
    return resolved.result;
  }

  const db = openIndexerDatabase(resolved.binding.dbPath);

  try {
    if (!hasIndexedFiles(db)) {
      return repoNotReady(
        toolId,
        `Repository index is empty for MCP use: ${resolved.binding.repoRoot}`,
        {
          repoRoot: resolved.binding.repoRoot,
          dbPath: resolved.binding.dbPath,
        },
      );
    }

    return await execute(resolved.binding, db);
  } finally {
    db.close();
  }
}

async function resolveWorkspaceRepoSelection(
  context: McpServerContext,
  toolId: McpToolId,
  requestedAliases?: readonly string[],
  options: {
    readonly includeDisabledByDefault?: boolean;
    readonly allowDisabledSelection?: boolean;
  } = {},
): Promise<
  | { ok: true; selection: WorkspaceRepoSelection }
  | { ok: false; result: McpToolExecutionResult<never> }
> {
  if (context.repoRoot === null) {
    return {
      ok: false,
      result: repoNotReady(
        toolId,
        `MCP tool ${toolId} requires a repo-bound server context.`,
      ),
    };
  }

  const workspaceConfigPath = resolveWorkspaceConfigPath(context.repoRoot);
  const workspaceConfig = await safeReadWorkspaceConfig(workspaceConfigPath);
  const specs = workspaceConfig?.repos ?? [buildSingleRepoWorkspaceSpec(context.repoRoot)];
  const enabledAliases = specs
    .filter((spec) => spec.enabled)
    .map((spec) => spec.alias);
  const knownAliases = specs.map((spec) => spec.alias);
  const selectedAliases = requestedAliases === undefined || requestedAliases.length === 0
    ? options.includeDisabledByDefault === true ? knownAliases : enabledAliases
    : [...requestedAliases];
  const missingAliases = selectedAliases.filter((alias) => !knownAliases.includes(alias));

  if (missingAliases.length > 0) {
    return {
      ok: false,
      result: invalidRequest(
        toolId,
        `Unknown workspace repo alias: ${missingAliases.join(", ")}`,
        {
          requestedRepos: selectedAliases,
          unknownRepos: missingAliases,
          availableRepos: knownAliases,
        },
      ),
    };
  }

  const disabledAliases = selectedAliases.filter((alias) => {
    return specs.find((spec) => spec.alias === alias)?.enabled === false;
  });

  if (disabledAliases.length > 0 && options.allowDisabledSelection !== true) {
    return {
      ok: false,
      result: invalidRequest(
        toolId,
        `Workspace repo alias is disabled: ${disabledAliases.join(", ")}`,
        {
          requestedRepos: selectedAliases,
          disabledRepos: disabledAliases,
          availableRepos: enabledAliases,
        },
      ),
    };
  }

  const statuses = await Promise.all(
    specs
      .filter((spec) => selectedAliases.includes(spec.alias))
      .map((spec) => inspectWorkspaceRepoStatus(spec)),
  );

  return {
    ok: true,
    selection: {
      isWorkspace: workspaceConfig !== undefined,
      ...(workspaceConfig === undefined ? {} : { workspaceConfig }),
      selectedAliases,
      statuses,
    },
  };
}

function buildSingleRepoWorkspaceSpec(repoRoot: string): ResolvedWorkspaceRepoConfig {
  const paths = resolveRepoLocalPaths(repoRoot);

  return {
    alias: defaultRepoAlias(repoRoot),
    rootPath: paths.repoRoot,
    configPath: paths.configPath,
    statePath: paths.statePath,
    dbPath: paths.dbPath,
    enabled: true,
  };
}

function defaultRepoAlias(repoRoot: string): string {
  const baseName = path.basename(path.resolve(repoRoot)).trim();
  const normalized = baseName.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");

  return normalized.length === 0 ? "repo" : normalized;
}

async function inspectWorkspaceRepoStatus(
  spec: ResolvedWorkspaceRepoConfig,
): Promise<WorkspaceRepoStatus> {
  const config = await safeReadConfig(spec.configPath);
  const state = await safeReadState(spec.statePath);
  const dbPath = config?.dbPath ?? state?.dbPath ?? spec.dbPath;
  const configPresent = config !== undefined;
  const statePresent = state !== undefined;
  const dbPresent = await pathExists(dbPath);
  const initialized = config?.initialized === true && state?.initialized === true && dbPresent;
  const latestRunId = state?.latestRunId ?? null;
  const indexPresent = latestRunId !== null && dbPresent;
  const ready = initialized && state?.readiness.status === "ready";
  const freshness = await inspectIndexFreshness({
    repoRoot: spec.rootPath,
    lastIndexSnapshot: state?.lastIndexSnapshot,
    observedFileChanges: state?.observedFileChanges,
    fileWatcher: state?.fileWatcher,
  });

  return {
    repoAlias: spec.alias,
    repoRoot: spec.rootPath,
    configPath: spec.configPath,
    statePath: spec.statePath,
    dbPath,
    enabled: spec.enabled,
    configPresent,
    statePresent,
    dbPresent,
    initialized,
    indexPresent,
    latestRunId,
    readiness: state?.readiness ?? null,
    freshness,
    watcher: buildFileWatcherStatus(state),
    ...(ready && config !== undefined && state !== undefined
      ? {
        binding: {
          repoAlias: spec.alias,
          repoRoot: spec.rootPath,
          dbPath,
          configPath: spec.configPath,
          statePath: spec.statePath,
          config,
          state,
        },
      }
      : {}),
  };
}

function hasMultiRepoRequest(
  selection: WorkspaceRepoSelection,
  requestedAliases?: readonly string[],
): boolean {
  return selection.isWorkspace || (requestedAliases !== undefined && requestedAliases.length > 0);
}

function formatWorkspaceMetadata(selection: WorkspaceRepoSelection) {
  const configuredAliases = selection.workspaceConfig?.repos.map((repo) => repo.alias)
    ?? selection.statuses.map((repo) => repo.repoAlias);

  return {
    name: selection.workspaceConfig?.name ?? null,
    primaryRepoAlias: selection.workspaceConfig?.primaryRepoAlias ?? selection.selectedAliases[0] ?? "repo",
    selectedRepos: [...selection.selectedAliases],
    configuredRepos: [...configuredAliases],
  };
}

function formatWorkspaceRepoStatus(status: WorkspaceRepoStatus) {
  return {
    repoAlias: status.repoAlias,
    repoRoot: status.repoRoot,
    configPath: status.configPath,
    statePath: status.statePath,
    dbPath: status.dbPath,
    enabled: status.enabled,
    configPresent: status.configPresent,
    statePresent: status.statePresent,
    dbPresent: status.dbPresent,
    initialized: status.initialized,
    indexPresent: status.indexPresent,
    latestRunId: status.latestRunId,
    readiness: status.readiness,
    freshness: status.freshness,
    watcher: status.watcher,
  };
}

async function inspectWorkspaceSetupStatus(
  repoRoot: string,
): Promise<{
  configPath: string;
  name: string | null;
  primaryRepoAlias: string;
  repos: ReturnType<typeof formatWorkspaceRepoStatus>[];
} | undefined> {
  const workspaceConfig = await safeReadWorkspaceConfig(resolveWorkspaceConfigPath(repoRoot));

  if (workspaceConfig === undefined) {
    return undefined;
  }

  const statuses = await Promise.all(
    workspaceConfig.repos.map((repo) => inspectWorkspaceRepoStatus(repo)),
  );

  return {
    configPath: workspaceConfig.configPath,
    name: workspaceConfig.name ?? null,
    primaryRepoAlias: workspaceConfig.primaryRepoAlias,
    repos: statuses.map(formatWorkspaceRepoStatus),
  };
}

function collectUniqueInOrder<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const unique: T[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    unique.push(value);
  }

  return unique;
}

function collectSortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function buildInclusionReasonsFromGraphResult(
  result: GraphSearchResult,
): CapsuleInclusionReason[] {
  const reasons: CapsuleInclusionReason[] = [
    {
      kind: CapsuleInclusionReasonKind.LexicalMatch,
      matchedFields: collectUniqueInOrder(result.matches.map((match) => match.field)),
    },
  ];
  const graphSignals = collectUniqueInOrder(
    result.graphContributions.map((contribution) => contribution.signal),
  );
  const relatedSymbolIds = collectSortedUnique(
    result.graphContributions.flatMap((contribution) => contribution.relatedSymbolIds ?? []),
  );

  if (graphSignals.length > 0) {
    reasons.push({
      kind: CapsuleInclusionReasonKind.GraphConnection,
      graphSignals,
      ...(relatedSymbolIds.length === 0 ? {} : { relatedSymbolIds }),
    });
  }

  return reasons;
}

function makeSupportingCandidateFromGraphResult(
  result: GraphSearchResult,
): CapsuleSupportingCandidate {
  return {
    symbolId: result.symbolId,
    filePath: result.filePath,
    fqName: result.fqName,
    localName: result.localName,
    kind: result.kind,
    lexicalScore: result.lexicalScore,
    graphScore: result.graphScore,
    finalScore: result.finalScore,
    inclusionReasons: buildInclusionReasonsFromGraphResult(result),
  };
}

function makePipelineBuilderInput(
  routedQuery: ReturnType<typeof routeQuery>,
  input: BuildCapsuleInput,
) {
  return {
    query: input.query!,
    rerankedCandidates: routedQuery.rerankedResults,
    supportingCandidates: routedQuery.rerankedResults.map(makeSupportingCandidateFromGraphResult),
    maxBudget: createCharacterBudget(
      input.maxBudgetCharacters ?? MCP_PIPELINE_DEFAULTS.maxBudgetCharacters,
    ),
  };
}

function createPipelineCapsuleBuilder(
  db: ReturnType<typeof openIndexerDatabase>,
  repoRoot: string,
  routedQuery: ReturnType<typeof routeQuery>,
  capsuleProfileId: string,
  sourceRunId: number | null,
) {
  return createSourceBackedCapsuleBuilder({
    db,
    repoRoot,
    excludeMemoryObservation: ({
      observation,
      query,
      pivots,
    }) => {
      return observation.dedupeKey === computeVisibleCapsuleObservationDedupeKey({
        sourceRunId,
        routedQuery: {
          ...routedQuery,
          query,
        },
        capsuleProfileId,
        capsule: { pivots: [...pivots] },
      });
    },
  });
}

function formatCapsuleItem(item: CapsuleItem) {
  return {
    ...(item.repoAlias === undefined ? {} : { repoAlias: item.repoAlias }),
    symbolId: item.symbolId,
    filePath: item.filePath,
    fqName: item.fqName,
    localName: item.localName,
    kind: item.kind,
    role: item.role,
    contentMode: item.content.mode,
    content: structuredClone(item.content),
    inclusionReasons: structuredClone(item.inclusionReasons),
    budgetCost: item.budgetCost,
    compressed: item.compressed,
    ...(item.sourceBacked === true ? { sourceBacked: true } : {}),
    ...(item.lexicalScore === undefined ? {} : { lexicalScore: item.lexicalScore }),
    ...(item.graphScore === undefined ? {} : { graphScore: item.graphScore }),
    ...(item.finalScore === undefined ? {} : { finalScore: item.finalScore }),
  };
}

function formatCapsuleOutput(capsule: Capsule) {
  return {
    query: capsule.query,
    pivots: capsule.pivots.map(formatCapsuleItem),
    supportingItems: capsule.supportingItems.map(formatCapsuleItem),
    ...(capsule.memories === undefined ? {} : { memories: structuredClone(capsule.memories) }),
    ...(capsule.rules === undefined ? {} : { rules: structuredClone(capsule.rules) }),
    budget: structuredClone(capsule.budget),
    truncated: capsule.truncated,
    compressed: capsule.compressed,
    ...(capsule.profileBudgetUsage === undefined
      ? {}
      : {
        profileBudgetUsage: {
          pivotCharactersUsed: capsule.profileBudgetUsage.pivotCharactersUsed,
          supportCharactersUsed: capsule.profileBudgetUsage.supportCharactersUsed,
          pivotCharactersMax: capsule.profileBudgetUsage.pivotCharactersMax ?? null,
          supportCharactersMax: capsule.profileBudgetUsage.supportCharactersMax ?? null,
        },
      }),
  };
}

function formatSearchCandidate(result: SymbolSearchResult) {
  return {
    symbolId: result.symbolId,
    filePath: result.filePath,
    fqName: result.fqName,
    localName: result.localName,
    kind: result.kind,
    score: result.score,
    matches: structuredClone(result.matches),
  };
}

function formatGraphSearchCandidate(result: GraphSearchResult) {
  return {
    symbolId: result.symbolId,
    filePath: result.filePath,
    fqName: result.fqName,
    localName: result.localName,
    kind: result.kind,
    lexicalScore: result.lexicalScore,
    graphScore: result.graphScore,
    finalScore: result.finalScore,
    matches: structuredClone(result.matches),
    graphContributions: result.graphContributions.map((contribution) => ({
      signal: contribution.signal,
      scoreContribution: contribution.scoreContribution,
      count: contribution.count ?? null,
      edgeType: contribution.edgeType ?? null,
      relatedSymbolIds: structuredClone(contribution.relatedSymbolIds ?? []),
    })),
  };
}

function formatIndexRunSummary(summary: NonNullable<ReturnType<typeof getIndexRunSummary>>) {
  return {
    id: summary.id,
    previousRunId: summary.previousRunId ?? null,
    createdAtMs: summary.createdAtMs,
    totalFiles: summary.totalFiles,
    totalSymbols: summary.totalSymbols,
    fileChangeCounts: structuredClone(summary.fileChangeCounts),
    symbolChangeCounts: structuredClone(summary.symbolChangeCounts),
  };
}

function formatObservation(observation: {
  repoAlias?: string;
  id: string;
  repoRoot: string;
  sessionId?: string;
  kind: string;
  source: string;
  toolName?: string;
  queryText?: string;
  intent?: string;
  summary: string;
  body: string;
  sourceRunId?: number;
  createdAtMs: number;
  linkedFilePaths: readonly string[];
  linkedSymbols: readonly {
    observationId: string;
    linkOrdinal: number;
    symbolId: string;
    filePath: string;
    fqName: string;
    symbolKind: string;
  }[];
  linkedFqNames: readonly string[];
}) {
  return {
    ...(observation.repoAlias === undefined ? {} : { repoAlias: observation.repoAlias }),
    id: observation.id,
    repoRoot: observation.repoRoot,
    sessionId: observation.sessionId ?? null,
    kind: observation.kind,
    source: observation.source,
    toolName: observation.toolName ?? null,
    queryText: observation.queryText ?? null,
    intent: observation.intent ?? null,
    summary: observation.summary,
    body: observation.body,
    sourceRunId: observation.sourceRunId ?? null,
    createdAtMs: observation.createdAtMs,
    linkedFilePaths: structuredClone([...observation.linkedFilePaths]),
    linkedSymbols: observation.linkedSymbols.map((link) => ({
      observationId: link.observationId,
      linkOrdinal: link.linkOrdinal,
      symbolId: link.symbolId,
      filePath: link.filePath,
      fqName: link.fqName,
      symbolKind: link.symbolKind,
    })),
    linkedFqNames: structuredClone([...observation.linkedFqNames]),
  };
}

function formatSession(session: {
  sessionId: string;
  repoRoot: string;
  agentKind?: string;
  startedAtMs: number;
  lastActivityAtMs: number;
  status: string;
  compressedAtMs?: number;
  summaryId?: string;
}) {
  return {
    sessionId: session.sessionId,
    repoRoot: session.repoRoot,
    agentKind: session.agentKind ?? null,
    startedAtMs: session.startedAtMs,
    lastActivityAtMs: session.lastActivityAtMs,
    status: session.status,
    compressedAtMs: session.compressedAtMs ?? null,
    summaryId: session.summaryId ?? null,
  };
}

function formatSessionSummary(summary: {
  observationCount: number;
  lastObservationAtMs: number | null;
  freshObservationCount: number;
  staleObservationCount: number;
  kindCounts: {
    decision: number;
    insight: number;
    warning: number;
    deadEnd: number;
    toolCall: number;
  };
  recentFilePaths: readonly string[];
  recentSymbolIds: readonly string[];
  recentFqNames: readonly string[];
  repeatedQueryTerms: readonly {
    term: string;
    count: number;
  }[];
}) {
  return {
    observationCount: summary.observationCount,
    lastObservationAtMs: summary.lastObservationAtMs,
    freshObservationCount: summary.freshObservationCount,
    staleObservationCount: summary.staleObservationCount,
    kindCounts: structuredClone(summary.kindCounts),
    recentFilePaths: structuredClone([...summary.recentFilePaths]),
    recentSymbolIds: structuredClone([...summary.recentSymbolIds]),
    recentFqNames: structuredClone([...summary.recentFqNames]),
    repeatedQueryTerms: summary.repeatedQueryTerms.map((termCount) => ({
      term: termCount.term,
      count: termCount.count,
    })),
  };
}

function formatSessionListItem(session: {
  sessionId: string;
  agentKind?: string;
  status: string;
  startedAtMs: number;
  lastActivityAtMs: number;
  compressedAtMs?: number;
  summaryId?: string;
  observationCount: number;
}) {
  return {
    sessionId: session.sessionId,
    agentKind: session.agentKind ?? null,
    status: session.status,
    startedAtMs: session.startedAtMs,
    lastActivityAtMs: session.lastActivityAtMs,
    compressedAtMs: session.compressedAtMs ?? null,
    summaryId: session.summaryId ?? null,
    observationCount: session.observationCount,
  };
}

function formatSessionCompressionSummary(summary: {
  id: string;
  sessionId: string;
  repoRoot: string;
  createdAtMs: number;
  firstActivityAtMs: number;
  lastActivityAtMs: number;
  compressedAtMs: number;
  observationCounts: Record<string, number>;
  toolCallCounts: Record<string, number>;
  filePaths: readonly string[];
  symbolIds: readonly string[];
  fqNames: readonly string[];
  keyTerms: readonly string[];
  preservedDurableObservationCount: number;
  prunedToolCallObservationCount: number;
  summaryObservationId: string;
}) {
  return {
    id: summary.id,
    sessionId: summary.sessionId,
    repoRoot: summary.repoRoot,
    createdAtMs: summary.createdAtMs,
    firstActivityAtMs: summary.firstActivityAtMs,
    lastActivityAtMs: summary.lastActivityAtMs,
    compressedAtMs: summary.compressedAtMs,
    observationCounts: {
      decision: summary.observationCounts.decision ?? 0,
      insight: summary.observationCounts.insight ?? 0,
      warning: summary.observationCounts.warning ?? 0,
      deadEnd: summary.observationCounts.dead_end ?? summary.observationCounts.deadEnd ?? 0,
      toolCall: summary.observationCounts.tool_call ?? summary.observationCounts.toolCall ?? 0,
    },
    toolCallCounts: Object.entries(summary.toolCallCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tool, count]) => ({ tool, count })),
    filePaths: structuredClone([...summary.filePaths]),
    symbolIds: structuredClone([...summary.symbolIds]),
    fqNames: structuredClone([...summary.fqNames]),
    keyTerms: structuredClone([...summary.keyTerms]),
    preservedDurableObservationCount: summary.preservedDurableObservationCount,
    prunedToolCallObservationCount: summary.prunedToolCallObservationCount,
    summaryObservationId: summary.summaryObservationId,
  };
}

function formatSessionObservationPreview(preview: {
  observationId: string;
  kind: string;
  summary: string;
  createdAtMs: number;
}) {
  return {
    observationId: preview.observationId,
    kind: preview.kind,
    summary: preview.summary,
    createdAtMs: preview.createdAtMs,
  };
}

function formatObservationSearchResult(result: ObservationSearchResult, repoAlias?: string) {
  return {
    observation: formatObservation({
      ...result.observation,
      ...(repoAlias === undefined ? {} : { repoAlias }),
    }),
    staleness: {
      observationId: result.staleness.observationId,
      sourceRunId: result.staleness.sourceRunId,
      comparisonRunId: result.staleness.comparisonRunId,
      status: result.staleness.status,
      reasons: result.staleness.reasons.map((reason) => ({
        kind: reason.kind,
        detectedInRunId: reason.detectedInRunId,
        ...( "filePath" in reason ? { filePath: reason.filePath } : {} ),
        ...( "symbol" in reason ? { symbol: structuredClone(reason.symbol) } : {} ),
      })),
    },
    score: result.score,
    signals: result.signals.map((signal) => ({
      kind: signal.kind,
      field: signal.field ?? null,
      scoreContribution: signal.scoreContribution,
      matchedValues: structuredClone(signal.matchedValues),
    })),
  };
}

function runIntentAwareCapsulePipeline(
  db: ReturnType<typeof openIndexerDatabase>,
  repoRoot: string,
  input: BuildCapsuleInput,
) {
  const routedQuery = routeQuery(db, input.query!, {
    maxResults: input.maxResults ?? MCP_PIPELINE_DEFAULTS.maxResults,
  });
  const sourceRunId = getLatestIndexRun(db)?.id ?? null;
  const builderInput = makePipelineBuilderInput(routedQuery, input);
  const preparedAssembly = prepareCapsuleAssembly({
    classification: routedQuery.classification,
    builderInput,
  });
  const capsuleBuilder = createPipelineCapsuleBuilder(
    db,
    repoRoot,
    routedQuery,
    preparedAssembly.selection.profile.id,
    sourceRunId,
  );
  const capsule = buildCapsule(
    capsuleBuilder,
    preparedAssembly.builderInput,
  );

  return {
    routedQuery,
    preparedAssembly,
    capsule,
    capsuleBuilder,
  };
}

function countUsefulContextItems(capsule: Capsule): number {
  return capsule.pivots.length + capsule.supportingItems.length;
}

function hasSupportedRunPipelineQueryShape(query: string): boolean {
  return /[A-Za-z0-9_]/u.test(query);
}

function resolveRunPipelineEmptyReason(
  query: string,
  pipeline: ReturnType<typeof runIntentAwareCapsulePipeline>,
): RunPipelineDiagnosticReason | null {
  if (countUsefulContextItems(pipeline.capsule) > 0) {
    return null;
  }

  if (normalizeSearchQuery(query).length === 0 || !hasSupportedRunPipelineQueryShape(query)) {
    return RUN_PIPELINE_DIAGNOSTIC_REASON.UnsupportedQueryShape;
  }

  if (pipeline.routedQuery.rerankedResults.length === 0) {
    return RUN_PIPELINE_DIAGNOSTIC_REASON.NoCandidates;
  }

  return RUN_PIPELINE_DIAGNOSTIC_REASON.AllCandidatesOmitted;
}

function formatRunPipelineDiagnostics(diagnostics: RunPipelineDiagnostics) {
  return {
    initialReason: diagnostics.initialReason,
    fallbackApplied: diagnostics.fallbackApplied,
    fallbackMode: diagnostics.fallbackMode,
    fallbackRecovered: diagnostics.fallbackRecovered,
    finalReason: diagnostics.finalReason,
    initialContextItemCount: diagnostics.initialContextItemCount,
    finalContextItemCount: diagnostics.finalContextItemCount,
    pathSignalsConsidered: [...diagnostics.pathSignalsConsidered],
    pathSignalsMatched: [...diagnostics.pathSignalsMatched],
    candidateFilesConsidered: diagnostics.candidateFilesConsidered,
    weakPathCoverage: diagnostics.weakPathCoverage,
  };
}

function formatIndexFreshnessDiagnostic(input: {
  freshness?: {
    state?: string;
    isStale?: boolean;
    reasons?: readonly { code?: string }[];
  };
  action?: "none" | "auto_index_repo" | "call_index_repo";
  status?: string;
  reason?: string | null;
  beforeState?: string | null;
  afterState?: string | null;
  latestRunId?: number | null;
}) {
  const state = input.freshness?.state;
  const status = input.status
    ?? (state === "fresh"
      ? "fresh"
      : state === "possibly_stale"
        ? "stale"
        : state === "unknown"
          ? "unknown"
          : "unavailable");
  const reason = input.reason
    ?? (input.freshness?.isStale === true
      ? "stale_index"
      : input.freshness?.reasons?.[0]?.code ?? null);

  return {
    status,
    reason,
    action: input.action ?? "none",
    beforeState: input.beforeState ?? null,
    afterState: input.afterState ?? state ?? null,
    latestRunId: input.latestRunId ?? null,
  };
}

const RUN_PIPELINE_IMPACT_DEFAULTS = Object.freeze({
  depth: 2,
  maxTopDependents: 4,
});

interface RunPipelineImpactCandidate {
  readonly symbolId: string;
  readonly filePath: string;
  readonly fqName: string;
  readonly localName: string;
  readonly kind: SymbolKind;
  readonly isTopPivot: boolean;
}

function maybeBuildRunPipelineImpactSummary(
  db: ReturnType<typeof openIndexerDatabase>,
  pipeline: ReturnType<typeof runIntentAwareCapsulePipeline>,
): RunPipelineImpactSummary | null {
  const triggerReason = resolveRunPipelineImpactTriggerReason(
    pipeline.routedQuery.query,
    pipeline.routedQuery.intent,
  );

  if (triggerReason === null) {
    return null;
  }

  const focalSymbol = selectRunPipelineImpactFocalSymbol(
    pipeline.routedQuery.query,
    pipeline,
  );

  if (focalSymbol === null) {
    return null;
  }

  const impact = getImpactGraph(db, {
    symbolFqn: focalSymbol.fqName,
    depth: RUN_PIPELINE_IMPACT_DEFAULTS.depth,
    format: "list",
  });

  if (!impact.ok) {
    return null;
  }

  return {
    triggerReason,
    selectionSource: focalSymbol.isTopPivot
      ? RUN_PIPELINE_IMPACT_SELECTION_SOURCE.TopPivotTaskMention
      : RUN_PIPELINE_IMPACT_SELECTION_SOURCE.RoutedTaskMention,
    resolvedSymbol: structuredClone(impact.output.resolvedSymbol),
    summary: structuredClone(impact.output.summary),
    topDependents: impact.output.nodes
      .filter((node) => node.distance > 0)
      .slice(0, RUN_PIPELINE_IMPACT_DEFAULTS.maxTopDependents)
      .map((node) => structuredClone(node)),
  };
}

function resolveRunPipelineImpactTriggerReason(
  query: string,
  intent: QueryIntent,
): RunPipelineImpactTriggerReason | null {
  const normalizedQuery = normalizeIntentQuery(query);
  const queryTerms = new Set(normalizedQuery.split(/\s+/).filter((term) => term.length > 0));

  if (intent === QueryIntent.Refactor) {
    return RUN_PIPELINE_IMPACT_TRIGGER_REASON.RefactorIntent;
  }
  if (normalizedQuery.includes("blast radius")) {
    return RUN_PIPELINE_IMPACT_TRIGGER_REASON.BlastRadiusPhrase;
  }
  if (normalizedQuery.includes("what breaks")) {
    return RUN_PIPELINE_IMPACT_TRIGGER_REASON.WhatBreaksPhrase;
  }
  if (queryTerms.has("dependent") || queryTerms.has("dependents")) {
    return RUN_PIPELINE_IMPACT_TRIGGER_REASON.DependentsKeyword;
  }
  if (
    normalizedQuery.includes("public api")
    && (
      queryTerms.has("change")
      || queryTerms.has("changes")
      || queryTerms.has("rename")
      || queryTerms.has("refactor")
      || queryTerms.has("break")
      || queryTerms.has("breaks")
    )
  ) {
    return RUN_PIPELINE_IMPACT_TRIGGER_REASON.PublicApiChangePhrase;
  }

  return null;
}

function selectRunPipelineImpactFocalSymbol(
  query: string,
  pipeline: ReturnType<typeof runIntentAwareCapsulePipeline>,
): RunPipelineImpactCandidate | null {
  const matchedCandidates = collectRunPipelineImpactCandidates(pipeline)
    .filter((candidate) => isRunPipelineImpactCandidateMentioned(query, candidate));

  return matchedCandidates.length === 1 ? matchedCandidates[0]! : null;
}

function collectRunPipelineImpactCandidates(
  pipeline: ReturnType<typeof runIntentAwareCapsulePipeline>,
): RunPipelineImpactCandidate[] {
  const candidatesBySymbolId = new Map<string, RunPipelineImpactCandidate>();
  const topPivotSymbolId = pipeline.capsule.pivots[0]?.symbolId;

  for (const pivot of pipeline.capsule.pivots) {
    candidatesBySymbolId.set(pivot.symbolId, {
      symbolId: pivot.symbolId,
      filePath: pivot.filePath,
      fqName: pivot.fqName,
      localName: pivot.localName,
      kind: pivot.kind,
      isTopPivot: pivot.symbolId === topPivotSymbolId,
    });
  }

  for (const result of pipeline.routedQuery.rerankedResults) {
    const existing = candidatesBySymbolId.get(result.symbolId);

    if (existing !== undefined) {
      if (existing.isTopPivot) {
        continue;
      }

      candidatesBySymbolId.set(result.symbolId, {
        ...existing,
        isTopPivot: result.symbolId === topPivotSymbolId,
      });
      continue;
    }

    candidatesBySymbolId.set(result.symbolId, {
      symbolId: result.symbolId,
      filePath: result.filePath,
      fqName: result.fqName,
      localName: result.localName,
      kind: result.kind,
      isTopPivot: result.symbolId === topPivotSymbolId,
    });
  }

  return [...candidatesBySymbolId.values()];
}

function isRunPipelineImpactCandidateMentioned(
  query: string,
  candidate: RunPipelineImpactCandidate,
): boolean {
  if (candidate.fqName.length > 0 && query.includes(candidate.fqName)) {
    return true;
  }

  if (candidate.localName.length === 0) {
    return false;
  }

  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(candidate.localName)}($|[^\\p{L}\\p{N}_])`, "u")
    .test(query);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runReliablePipeline(
  db: ReturnType<typeof openIndexerDatabase>,
  repoRoot: string,
  input: BuildCapsuleInput,
): {
  pipeline: ReturnType<typeof runIntentAwareCapsulePipeline>;
  diagnostics: RunPipelineDiagnostics;
} {
  const primaryPipeline = runIntentAwareCapsulePipeline(db, repoRoot, input);
  const initialContextItemCount = countUsefulContextItems(primaryPipeline.capsule);
  const initialReason = resolveRunPipelineEmptyReason(input.query!, primaryPipeline);

  if (initialReason === null) {
    return {
      pipeline: primaryPipeline,
      diagnostics: {
        initialReason: null,
        fallbackApplied: false,
        fallbackMode: null,
        fallbackRecovered: false,
        finalReason: null,
        initialContextItemCount,
        finalContextItemCount: initialContextItemCount,
        pathSignalsConsidered: primaryPipeline.routedQuery.pathSignalDiagnostics.pathSignalsConsidered,
        pathSignalsMatched: primaryPipeline.routedQuery.pathSignalDiagnostics.pathSignalsMatched,
        candidateFilesConsidered: primaryPipeline.routedQuery.pathSignalDiagnostics.candidateFilesConsidered,
        weakPathCoverage: primaryPipeline.routedQuery.pathSignalDiagnostics.weakPathCoverage,
      },
    };
  }

  let finalPipeline = primaryPipeline;
  let fallbackApplied = false;
  let fallbackRecovered = false;
  let fallbackMode: RunPipelineFallbackMode | null = null;

  if (initialReason === RUN_PIPELINE_DIAGNOSTIC_REASON.AllCandidatesOmitted) {
    fallbackApplied = true;
    fallbackMode = RUN_PIPELINE_FALLBACK_MODE.RelaxedUnprofiledAssembly;

    finalPipeline = {
      ...primaryPipeline,
      capsule: buildCapsule(primaryPipeline.capsuleBuilder, {
        query: primaryPipeline.preparedAssembly.builderInput.query,
        rerankedCandidates: primaryPipeline.preparedAssembly.builderInput.rerankedCandidates,
        supportingCandidates: primaryPipeline.preparedAssembly.builderInput.supportingCandidates,
        maxBudget: primaryPipeline.preparedAssembly.builderInput.maxBudget,
      }),
    };
    fallbackRecovered = countUsefulContextItems(finalPipeline.capsule) > 0;
  }

  const finalContextItemCount = countUsefulContextItems(finalPipeline.capsule);

  return {
    pipeline: finalPipeline,
    diagnostics: {
      initialReason,
      fallbackApplied,
      fallbackMode,
      fallbackRecovered,
      finalReason: finalContextItemCount > 0 ? null : resolveRunPipelineEmptyReason(input.query!, finalPipeline),
      initialContextItemCount,
      finalContextItemCount,
      pathSignalsConsidered: finalPipeline.routedQuery.pathSignalDiagnostics.pathSignalsConsidered,
      pathSignalsMatched: finalPipeline.routedQuery.pathSignalDiagnostics.pathSignalsMatched,
      candidateFilesConsidered: finalPipeline.routedQuery.pathSignalDiagnostics.candidateFilesConsidered,
      weakPathCoverage: finalPipeline.routedQuery.pathSignalDiagnostics.weakPathCoverage,
    },
  };
}

function formatRoutingProfileOutput(profile: ReturnType<typeof routeQuery>["profile"]) {
  return {
    id: profile.id,
    backend: profile.backend,
    candidatePoolSize: profile.candidatePoolSize,
    graphWeights: structuredClone(profile.graphWeights),
    summary: profile.summary,
  };
}

function formatCapsuleProfileOutput(
  selection: ReturnType<typeof prepareCapsuleAssembly>["selection"],
) {
  return {
    id: selection.profile.id,
    targetIntent: selection.profile.targetIntent,
    description: selection.profile.description,
    settingsSummary: structuredClone(selection.settingsSummary),
    explanation: structuredClone(selection.explanation),
  };
}

function formatContextCapsulePipelineOutput(
  pipeline: ReturnType<typeof runIntentAwareCapsulePipeline>,
  capsuleManifestId: string | null = null,
) {
  return {
    query: pipeline.routedQuery.query,
    intent: pipeline.routedQuery.intent,
    classification: structuredClone(pipeline.routedQuery.classification),
    routingProfile: formatRoutingProfileOutput(pipeline.routedQuery.profile),
    capsuleProfile: formatCapsuleProfileOutput(pipeline.preparedAssembly.selection),
    capsuleManifestId,
    capsule: {
      ...formatCapsuleOutput(pipeline.capsule),
      profileBudgetUsage: pipeline.capsule.profileBudgetUsage === undefined
        ? null
        : {
          pivotCharactersUsed: pipeline.capsule.profileBudgetUsage.pivotCharactersUsed,
          supportCharactersUsed: pipeline.capsule.profileBudgetUsage.supportCharactersUsed,
          pivotCharactersMax: pipeline.capsule.profileBudgetUsage.pivotCharactersMax ?? null,
          supportCharactersMax: pipeline.capsule.profileBudgetUsage.supportCharactersMax ?? null,
        },
    },
  };
}

interface MultiRepoRetrievalSummary {
  readonly repoAlias: string;
  readonly repoRoot: string;
  readonly ready: boolean;
  readonly skipReason: string | null;
  readonly candidateCount: number;
  readonly pivotCount: number;
  readonly supportCount: number;
}

interface MultiRepoMergeSummary {
  readonly strategy: "per_repo_then_deterministic_global_merge";
  readonly selectedRepos: readonly string[];
  readonly inputItemCount: number;
  readonly outputItemCount: number;
  readonly tieBreakers: readonly string[];
}

interface MultiRepoCapsuleEntry {
  readonly repoAlias: string;
  readonly repoRoot: string;
  readonly pipeline: ReturnType<typeof runIntentAwareCapsulePipeline>;
}

interface MultiRepoRunPipelineEntry {
  readonly repoAlias: string;
  readonly repoRoot: string;
  readonly orchestration: RunPipelineOrchestration;
}

const MULTI_REPO_MERGE_TIE_BREAKERS = Object.freeze([
  "finalScore desc",
  "lexicalScore desc",
  "repoAlias asc",
  "filePath asc",
  "fqName asc",
  "symbolId asc",
]);

async function runMultiRepoContextCapsulePipeline(
  selection: WorkspaceRepoSelection,
  input: {
    query: string;
    maxResults?: number;
    maxBudgetCharacters?: number;
  },
): Promise<
  | {
    ok: true;
    output: ReturnType<typeof formatMultiRepoContextCapsuleOutput>;
  }
  | { ok: false; result: McpToolExecutionResult<never> }
> {
  const maxBudgetCharacters = input.maxBudgetCharacters ?? MCP_PIPELINE_DEFAULTS.maxBudgetCharacters;
  const readyCount = Math.max(1, selection.statuses.filter((status) => status.binding !== undefined).length);
  const perRepoBudget = selection.selectedAliases.length > 1
    ? Math.max(input.query.length + 128, Math.floor(maxBudgetCharacters / readyCount))
    : maxBudgetCharacters;
  const entries: MultiRepoCapsuleEntry[] = [];
  const perRepo: MultiRepoRetrievalSummary[] = [];

  for (const status of selection.statuses) {
    if (status.binding === undefined) {
      perRepo.push(makeSkippedRetrievalSummary(status, resolveWorkspaceRepoSkipReason(status)));
      continue;
    }

    const db = openIndexerDatabase(status.binding.dbPath);

    try {
      if (!hasIndexedFiles(db)) {
        perRepo.push(makeSkippedRetrievalSummary(status, "index_empty"));
        continue;
      }

      const pipeline = runIntentAwareCapsulePipeline(db, status.binding.repoRoot, {
        query: input.query,
        maxResults: input.maxResults,
        maxBudgetCharacters: perRepoBudget,
      });
      const taggedPipeline = {
        ...pipeline,
        capsule: tagCapsuleWithRepoAlias(pipeline.capsule, status.repoAlias),
      };

      entries.push({
        repoAlias: status.repoAlias,
        repoRoot: status.repoRoot,
        pipeline: taggedPipeline,
      });
      perRepo.push({
        repoAlias: status.repoAlias,
        repoRoot: status.repoRoot,
        ready: true,
        skipReason: null,
        candidateCount: pipeline.routedQuery.rerankedResults.length,
        pivotCount: pipeline.capsule.pivots.length,
        supportCount: pipeline.capsule.supportingItems.length,
      });
    } finally {
      db.close();
    }
  }

  if (entries.length === 0) {
    return {
      ok: false,
      result: repoNotReady(
        McpToolId.GetContextCapsule,
        "No selected workspace repos are ready for context retrieval.",
        {
          selectedRepos: selection.selectedAliases,
          perRepo,
        },
      ),
    };
  }

  return {
    ok: true,
    output: formatMultiRepoContextCapsuleOutput({
      selection,
      entries,
      perRepo,
      query: input.query,
      maxResults: input.maxResults ?? MCP_PIPELINE_DEFAULTS.maxResults,
      maxBudgetCharacters,
    }),
  };
}

async function runMultiRepoPipelineOrchestration(
  selection: WorkspaceRepoSelection,
  input: {
    query: string;
    maxResults?: number;
    maxBudgetCharacters?: number;
    intent?: string;
    sessionId?: string;
    includeMemory?: boolean;
    includeTests?: boolean;
    includeFileContent?: boolean;
  },
): Promise<
  | {
    ok: true;
    output: ReturnType<typeof formatMultiRepoRunPipelineOutput>;
  }
  | { ok: false; result: McpToolExecutionResult<never> }
> {
  const maxBudgetCharacters = input.maxBudgetCharacters ?? RUN_PIPELINE_VNEXT_DEFAULTS.maxBudgetCharacters;
  const readyCount = Math.max(1, selection.statuses.filter((status) => status.binding !== undefined).length);
  const perRepoBudget = selection.selectedAliases.length > 1
    ? Math.max(input.query.length + 128, Math.floor(maxBudgetCharacters / readyCount))
    : maxBudgetCharacters;
  const entries: MultiRepoRunPipelineEntry[] = [];
  const perRepo: MultiRepoRetrievalSummary[] = [];

  for (const status of selection.statuses) {
    if (status.binding === undefined) {
      perRepo.push(makeSkippedRetrievalSummary(status, resolveWorkspaceRepoSkipReason(status)));
      continue;
    }

    const db = openIndexerDatabase(status.binding.dbPath);

    try {
      if (!hasIndexedFiles(db)) {
        perRepo.push(makeSkippedRetrievalSummary(status, "index_empty"));
        continue;
      }

      const orchestration = runPipelineOrchestrator(db, status.binding.repoRoot, {
        query: input.query,
        maxResults: input.maxResults,
        maxBudgetCharacters: perRepoBudget,
        intent: input.intent,
        sessionId: input.sessionId,
        includeMemory: input.includeMemory,
        includeTests: input.includeTests,
        includeFileContent: input.includeFileContent,
      });
      const taggedOrchestration: RunPipelineOrchestration = {
        ...orchestration,
        context: {
          ...orchestration.context,
          capsule: tagCapsuleWithRepoAlias(orchestration.context.capsule, status.repoAlias),
        },
      };

      entries.push({
        repoAlias: status.repoAlias,
        repoRoot: status.repoRoot,
        orchestration: taggedOrchestration,
      });
      perRepo.push({
        repoAlias: status.repoAlias,
        repoRoot: status.repoRoot,
        ready: true,
        skipReason: null,
        candidateCount: orchestration.context.routedQuery.rerankedResults.length,
        pivotCount: orchestration.context.capsule.pivots.length,
        supportCount: orchestration.context.capsule.supportingItems.length,
      });
    } finally {
      db.close();
    }
  }

  if (entries.length === 0) {
    return {
      ok: false,
      result: repoNotReady(
        McpToolId.RunPipeline,
        "No selected workspace repos are ready for pipeline retrieval.",
        {
          selectedRepos: selection.selectedAliases,
          perRepo,
        },
      ),
    };
  }

  return {
    ok: true,
    output: formatMultiRepoRunPipelineOutput({
      selection,
      entries,
      perRepo,
      query: input.query,
      maxResults: input.maxResults ?? RUN_PIPELINE_VNEXT_DEFAULTS.maxResults,
      maxBudgetCharacters,
    }),
  };
}

function formatMultiRepoContextCapsuleOutput(input: {
  selection: WorkspaceRepoSelection;
  entries: readonly MultiRepoCapsuleEntry[];
  perRepo: readonly MultiRepoRetrievalSummary[];
  query: string;
  maxResults: number;
  maxBudgetCharacters: number;
}) {
  const representative = input.entries[0]!.pipeline;
  const merged = mergeTaggedCapsules({
    query: input.query,
    entries: input.entries.map((entry) => entry.pipeline.capsule),
    selectedAliases: input.selection.selectedAliases,
    maxResults: input.maxResults,
    maxBudgetCharacters: input.maxBudgetCharacters,
  });

  return {
    workspace: formatWorkspaceMetadata(input.selection),
    retrieval: {
      selectedRepos: [...input.selection.selectedAliases],
      perRepo: input.perRepo.map(formatMultiRepoRetrievalSummary),
      mergeSummary: merged.mergeSummary,
    },
    query: representative.routedQuery.query,
    intent: representative.routedQuery.intent,
    classification: structuredClone(representative.routedQuery.classification),
    routingProfile: formatRoutingProfileOutput(representative.routedQuery.profile),
    capsuleProfile: formatCapsuleProfileOutput(representative.preparedAssembly.selection),
    capsule: {
      ...formatCapsuleOutput(merged.capsule),
      profileBudgetUsage: null,
    },
  };
}

function formatMultiRepoRunPipelineOutput(input: {
  selection: WorkspaceRepoSelection;
  entries: readonly MultiRepoRunPipelineEntry[];
  perRepo: readonly MultiRepoRetrievalSummary[];
  query: string;
  maxResults: number;
  maxBudgetCharacters: number;
}) {
  const representative = input.entries[0]!.orchestration;
  const base = formatRunPipelineOrchestrationOutput(representative);
  const merged = mergeTaggedCapsules({
    query: input.query,
    entries: input.entries.map((entry) => entry.orchestration.context.capsule),
    selectedAliases: input.selection.selectedAliases,
    maxResults: input.maxResults,
    maxBudgetCharacters: input.maxBudgetCharacters,
  });
  const retrieval = {
    selectedRepos: [...input.selection.selectedAliases],
    perRepo: input.perRepo.map(formatMultiRepoRetrievalSummary),
    mergeSummary: merged.mergeSummary,
    initialReason: base.diagnostics.retrieval.initialReason,
    fallbackApplied: base.diagnostics.retrieval.fallbackApplied,
    fallbackMode: base.diagnostics.retrieval.fallbackMode,
    fallbackRecovered: base.diagnostics.retrieval.fallbackRecovered,
    finalReason: merged.capsule.pivots.length + merged.capsule.supportingItems.length > 0
      ? null
      : base.diagnostics.retrieval.finalReason,
    initialContextItemCount: input.perRepo.reduce(
      (sum, repo) => sum + repo.pivotCount + repo.supportCount,
      0,
    ),
    finalContextItemCount: merged.capsule.pivots.length + merged.capsule.supportingItems.length,
    pathSignalsConsidered: [...base.diagnostics.retrieval.pathSignalsConsidered],
    pathSignalsMatched: [...base.diagnostics.retrieval.pathSignalsMatched],
    candidateFilesConsidered: base.diagnostics.retrieval.candidateFilesConsidered,
    weakPathCoverage: base.diagnostics.retrieval.weakPathCoverage,
  };
  const impact = resolveMultiRepoImpactOutput(input.entries, base.impact);

  return {
    ...base,
    workspace: formatWorkspaceMetadata(input.selection),
    request: {
      ...base.request,
      maxResults: input.maxResults,
      maxBudgetCharacters: input.maxBudgetCharacters,
      selectedRepos: [...input.selection.selectedAliases],
    },
    context: {
      ...base.context,
      selectedRepos: [...input.selection.selectedAliases],
      perRepo: input.perRepo.map(formatMultiRepoRetrievalSummary),
      mergeSummary: merged.mergeSummary,
      included: merged.capsule.pivots.length + merged.capsule.supportingItems.length > 0,
      skipReason: merged.capsule.pivots.length + merged.capsule.supportingItems.length > 0
        ? null
        : base.context.skipReason,
      pivots: merged.capsule.pivots.map(formatRunPipelineCompactContextItem),
      supports: merged.capsule.supportingItems.map(formatRunPipelineCompactContextItem),
      itemCount: merged.capsule.pivots.length + merged.capsule.supportingItems.length,
      compressed: merged.capsule.compressed,
      truncated: merged.capsule.truncated,
      budget: structuredClone(merged.capsule.budget),
      capsuleRef: `vexp:capsule:${compactOrchestrationHash(input.query)}:multi`,
    },
    impact,
    diagnostics: {
      ...base.diagnostics,
      retrieval,
      impact: {
        included: impact.included,
        skipReason: impact.skipReason,
        triggerReason: impact.triggerReason,
        candidatesConsidered: impact.candidatesConsidered,
        matchedCandidates: impact.matchedCandidates,
      },
      deferredCount: 0,
    },
    deferred: {
      items: [],
      expandable: false,
      expansionTool: null,
      notes: [
        "Multi-repo run_pipeline does not emit deferred expansion items in this build.",
      ],
    },
    savedObservation: null,
  };
}

function resolveMultiRepoImpactOutput(
  entries: readonly MultiRepoRunPipelineEntry[],
  baseImpact: ReturnType<typeof formatRunPipelineOrchestrationOutput>["impact"],
) {
  if (entries.length <= 1) {
    return baseImpact;
  }

  const triggerReason = entries
    .map((entry) => entry.orchestration.impact.triggerReason)
    .find((reason): reason is string => reason !== null) ?? baseImpact.triggerReason;

  if (triggerReason === null) {
    return {
      ...baseImpact,
      included: false,
      skipReason: "not_refactor_like",
      selectionSource: null,
      focalSymbol: null,
      summary: null,
      topDependents: null,
      impactRef: null,
      candidatesConsidered: baseImpact.candidatesConsidered,
      matchedCandidates: baseImpact.matchedCandidates,
    };
  }

  return {
    included: false,
    skipReason: "cross_repo_impact_unsupported",
    triggerReason,
    selectionSource: null,
    focalSymbol: null,
    summary: null,
    topDependents: null,
    impactRef: null,
    candidatesConsidered: entries.reduce(
      (sum, entry) => sum + entry.orchestration.impact.candidatesConsidered,
      0,
    ),
    matchedCandidates: entries.reduce(
      (sum, entry) => sum + entry.orchestration.impact.matchedCandidates,
      0,
    ),
  };
}

function tagCapsuleWithRepoAlias(capsule: Capsule, repoAlias: string): Capsule {
  return {
    ...capsule,
    pivots: capsule.pivots.map((item) => ({ ...item, repoAlias })),
    supportingItems: capsule.supportingItems.map((item) => ({ ...item, repoAlias })),
    ...(capsule.memories === undefined
      ? {}
      : { memories: capsule.memories.map((item) => ({ ...item, repoAlias })) }),
    ...(capsule.rules === undefined
      ? {}
      : { rules: { active: capsule.rules.active.map((item) => ({ ...item, repoAlias })) } }),
  };
}

function mergeTaggedCapsules(input: {
  query: string;
  entries: readonly Capsule[];
  selectedAliases: readonly string[];
  maxResults: number;
  maxBudgetCharacters: number;
}): {
  capsule: Capsule;
  mergeSummary: MultiRepoMergeSummary;
} {
  const pivotLimit = Math.max(input.maxResults, input.selectedAliases.length);
  const supportLimit = Math.max(input.maxResults, input.selectedAliases.length);
  const pivots = mergeCapsuleItems(
    input.entries.flatMap((capsule) => capsule.pivots),
    input.selectedAliases,
    pivotLimit,
  );
  const supportingItems = mergeCapsuleItems(
    input.entries.flatMap((capsule) => capsule.supportingItems),
    input.selectedAliases,
    supportLimit,
  );
  const memories = mergeCapsuleMemories(input.entries, input.selectedAliases);
  const rules = mergeCapsuleRules(input.entries, input.selectedAliases);
  const usedCharacters = input.query.length
    + pivots.reduce((sum, item) => sum + item.budgetCost, 0)
    + supportingItems.reduce((sum, item) => sum + item.budgetCost, 0);
  const inputItemCount = input.entries.reduce((sum, capsule) => {
    return sum + capsule.pivots.length + capsule.supportingItems.length;
  }, 0);
  const outputItemCount = pivots.length + supportingItems.length;
  const capsule: Capsule = {
    query: input.query,
    pivots,
    supportingItems,
    ...(memories.length === 0 ? {} : { memories }),
    ...(rules.length === 0 ? {} : { rules: { active: rules } }),
    budget: {
      model: CapsuleBudgetModel.CharacterCount,
      maxCharacters: input.maxBudgetCharacters,
      usedCharacters,
      remainingCharacters: Math.max(0, input.maxBudgetCharacters - usedCharacters),
    },
    truncated: input.entries.some((capsule) => capsule.truncated) || outputItemCount < inputItemCount,
    compressed: [...pivots, ...supportingItems].some((item) => item.compressed),
  };

  return {
    capsule,
    mergeSummary: {
      strategy: "per_repo_then_deterministic_global_merge",
      selectedRepos: [...input.selectedAliases],
      inputItemCount,
      outputItemCount,
      tieBreakers: [...MULTI_REPO_MERGE_TIE_BREAKERS],
    },
  };
}

function mergeCapsuleItems<T extends CapsuleItem>(
  items: readonly T[],
  selectedAliases: readonly string[],
  limit: number,
): T[] {
  const sorted = [...items].sort(compareCapsuleItems);
  const selected = new Map<string, T>();

  if (selectedAliases.length > 1) {
    for (const alias of selectedAliases) {
      const item = sorted.find((candidate) => candidate.repoAlias === alias);

      if (item !== undefined && selected.size < limit) {
        selected.set(capsuleItemMergeKey(item), item);
      }
    }
  }

  for (const item of sorted) {
    if (selected.size >= limit) {
      break;
    }

    selected.set(capsuleItemMergeKey(item), item);
  }

  return [...selected.values()].sort(compareCapsuleItems);
}

function mergeCapsuleMemories(
  entries: readonly Capsule[],
  selectedAliases: readonly string[],
) {
  return entries
    .flatMap((capsule) => capsule.memories ?? [])
    .sort((left, right) => {
      return right.createdAtMs - left.createdAtMs
        || compareString(left.repoAlias ?? "", right.repoAlias ?? "")
        || compareString(left.observationId, right.observationId);
    })
    .filter((memory, index, values) => {
      return values.findIndex((candidate) => {
        return candidate.observationId === memory.observationId
          && candidate.repoAlias === memory.repoAlias;
      }) === index;
    })
    .slice(0, Math.max(3, selectedAliases.length));
}

function mergeCapsuleRules(
  entries: readonly Capsule[],
  selectedAliases: readonly string[],
) {
  const aliasRank = new Map(selectedAliases.map((alias, index) => [alias, index]));
  return entries
    .flatMap((capsule) => capsule.rules?.active ?? [])
    .sort((left, right) => {
      return (aliasRank.get(left.repoAlias ?? "") ?? Number.MAX_SAFE_INTEGER)
        - (aliasRank.get(right.repoAlias ?? "") ?? Number.MAX_SAFE_INTEGER)
        || compareString(left.summary, right.summary)
        || compareString(left.id, right.id);
    })
    .filter((rule, index, values) => {
      return values.findIndex((candidate) => {
        return candidate.id === rule.id && candidate.repoAlias === rule.repoAlias;
      }) === index;
    })
    .slice(0, Math.max(3, selectedAliases.length));
}

function capsuleItemMergeKey(item: CapsuleItem): string {
  return `${item.repoAlias ?? ""}\0${item.symbolId}`;
}

function compareCapsuleItems(left: CapsuleItem, right: CapsuleItem): number {
  return compareOptionalNumberDescendingForMerge(left.finalScore, right.finalScore)
    || compareOptionalNumberDescendingForMerge(left.lexicalScore, right.lexicalScore)
    || compareString(left.repoAlias ?? "", right.repoAlias ?? "")
    || compareString(left.filePath, right.filePath)
    || compareString(left.fqName, right.fqName)
    || compareString(left.symbolId, right.symbolId);
}

function compareOptionalNumberDescendingForMerge(
  left: number | undefined,
  right: number | undefined,
): number {
  const normalizedLeft = left ?? Number.NEGATIVE_INFINITY;
  const normalizedRight = right ?? Number.NEGATIVE_INFINITY;

  return normalizedRight - normalizedLeft;
}

function compareString(left: string, right: string): number {
  return left.localeCompare(right);
}

function makeSkippedRetrievalSummary(
  status: WorkspaceRepoStatus,
  skipReason: string,
): MultiRepoRetrievalSummary {
  return {
    repoAlias: status.repoAlias,
    repoRoot: status.repoRoot,
    ready: false,
    skipReason,
    candidateCount: 0,
    pivotCount: 0,
    supportCount: 0,
  };
}

function resolveWorkspaceRepoSkipReason(status: WorkspaceRepoStatus): string {
  if (!status.enabled) {
    return "repo_disabled";
  }
  if (!status.configPresent || !status.statePresent) {
    return "repo_not_initialized";
  }
  if (!status.dbPresent) {
    return "database_missing";
  }
  if (status.readiness?.status !== "ready") {
    return "repo_not_ready";
  }
  return "repo_not_ready";
}

function formatMultiRepoRetrievalSummary(summary: MultiRepoRetrievalSummary) {
  return {
    repoAlias: summary.repoAlias,
    repoRoot: summary.repoRoot,
    ready: summary.ready,
    skipReason: summary.skipReason,
    candidateCount: summary.candidateCount,
    pivotCount: summary.pivotCount,
    supportCount: summary.supportCount,
  };
}

async function inspectIndexStatus(
  context: McpServerContext,
): Promise<{
  repoRoot: string;
  configPath: string;
  statePath: string;
  dbPath: string;
  configPresent: boolean;
  statePresent: boolean;
  dbPresent: boolean;
  initialized: boolean;
  indexPresent: boolean;
  latestRunId: number | null;
  readiness: RepoLocalState["readiness"] | null;
  freshness: unknown;
  watcher: unknown;
}> {
  if (context.repoRoot === null) {
    throw new Error("MCP tool requires a repo-bound server context.");
  }

  const paths = resolveRepoLocalPaths(context.repoRoot);
  const configPath = context.configPath ?? paths.configPath;
  const statePath = context.statePath ?? paths.statePath;
  const config = (await safeReadConfig(configPath)) ?? context.config ?? undefined;
  const state = (await safeReadState(statePath)) ?? context.state ?? undefined;
  const dbPath = context.dbPath ?? config?.dbPath ?? state?.dbPath ?? paths.dbPath;
  const configPresent = config !== undefined;
  const statePresent = state !== undefined;
  const dbPresent = await pathExists(dbPath);
  const initialized = config?.initialized === true && state?.initialized === true && dbPresent;
  const latestRunId = state?.latestRunId ?? null;
  const indexPresent = latestRunId !== null && dbPresent;
  const freshness = await inspectIndexFreshness({
    repoRoot: context.repoRoot,
    lastIndexSnapshot: state?.lastIndexSnapshot,
    observedFileChanges: state?.observedFileChanges,
    fileWatcher: state?.fileWatcher,
  });

  return {
    repoRoot: context.repoRoot,
    configPath,
    statePath,
    dbPath,
    configPresent,
    statePresent,
    dbPresent,
    initialized,
    indexPresent,
    latestRunId,
    readiness: state?.readiness ?? null,
    freshness,
    watcher: buildFileWatcherStatus(state),
  };
}

function formatDeferredToolOutput(toolId: McpToolId, reason: string, suggestedToolIds: readonly string[]) {
  return {
    status: "deferred" as const,
    toolId,
    message: `MCP tool ${toolId} is registered, but the underlying capability is not implemented in the current engine.`,
    reason,
    suggestedToolIds: [...suggestedToolIds],
  };
}

function createDeferredToolDefinition(
  metadata: Omit<McpToolMetadata, "registration" | "outputSchema"> & {
    outputSchema?: McpObjectSchema;
  },
  reason: string,
  suggestedToolIds: readonly string[],
): McpToolDefinition<DeferredToolInput, ReturnType<typeof formatDeferredToolOutput>> {
  return createEngineDelegateToolDefinition({
    metadata: {
      ...metadata,
      outputSchema: metadata.outputSchema ?? objectSchema(
        "Explicit deferred-capability output.",
        {
          status: DEFERRED_TOOL_OUTPUT_SCHEMA.properties.status!,
          toolId: DEFERRED_TOOL_OUTPUT_SCHEMA.properties.toolId!,
          message: DEFERRED_TOOL_OUTPUT_SCHEMA.properties.message!,
          reason: DEFERRED_TOOL_OUTPUT_SCHEMA.properties.reason!,
          suggestedToolIds: DEFERRED_TOOL_OUTPUT_SCHEMA.properties.suggestedToolIds!,
        },
        DEFERRED_TOOL_OUTPUT_SCHEMA.required ?? [],
      ),
    },
    handler({ request }) {
      const input = parseObjectInput(metadata.toolId, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      return {
        ok: true,
        output: formatDeferredToolOutput(metadata.toolId, reason, suggestedToolIds),
      };
    },
  });
}

interface ExpandVexpRefInput {
  readonly hash?: unknown;
}

type ExpandVexpRefFailureReason =
  | "malformed_hash"
  | "unknown_hash"
  | "expired"
  | "unsupported_category";

interface ExpandVexpRefSuccessOutput {
  readonly requestedHash: string;
  readonly resolved: true;
  readonly stableId: string;
  readonly category: string;
  readonly content: {
    readonly kind: string;
    readonly mimeType?: string;
    readonly text?: string;
    readonly value?: unknown;
  };
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly notes: readonly string[];
}

interface ExpandVexpRefFailureOutput {
  readonly requestedHash: string;
  readonly resolved: false;
  readonly reason: ExpandVexpRefFailureReason;
  readonly message: string;
  readonly notes: readonly string[];
}

type ExpandVexpRefOutput = ExpandVexpRefSuccessOutput | ExpandVexpRefFailureOutput;

const EXPAND_VEXP_REF_OUTPUT_SCHEMA: McpObjectSchema = objectSchema(
  "Explicit expand_vexp_ref output. Either a resolved expansion or an honest failure.",
  {
    requestedHash: stringProperty("The hash exactly as requested by the caller."),
    resolved: { type: "boolean", description: "Whether a stored deferred record was resolved." },
    stableId: { type: ["string", "null"], description: "Underlying stable deferred id when resolved." },
    category: { type: ["string", "null"], description: "Deferred category when resolved." },
    content: {
      type: ["object", "null"],
      description: "Full stored deferred content when resolved.",
      properties: {
        kind: stringProperty("Content kind tag (e.g., json, text)."),
        mimeType: { type: ["string", "null"], description: "Mime type for text content." },
        text: { type: ["string", "null"], description: "Text payload for text content." },
        value: { type: ["object", "array", "string", "number", "boolean", "null"], description: "JSON payload for json content." },
      },
      required: ["kind"],
      additionalProperties: true,
    },
    metadata: {
      type: ["object", "null"],
      description: "Basic metadata describing the source of the deferred record.",
      properties: {},
      required: [],
      additionalProperties: true,
    },
    reason: { type: ["string", "null"], description: "Machine failure reason when not resolved (malformed_hash, unknown_hash, expired, unsupported_category)." },
    message: { type: ["string", "null"], description: "Human-readable failure explanation when not resolved." },
    notes: arrayProperty("Notes about the expansion result.", stringProperty("Explanatory note.")),
  },
  ["requestedHash", "resolved", "notes"],
);

function createExpandVexpRefToolDefinition(
  options: { readonly store?: DeferredVexpStore } = {},
): McpToolDefinition<ExpandVexpRefInput, ExpandVexpRefOutput> {
  return createEngineDelegateToolDefinition<ExpandVexpRefInput, ExpandVexpRefOutput>({
    metadata: {
      toolId: McpToolId.ExpandVexpRef,
      displayName: "Expand V-REF",
      description:
        "Expand a deferred V-REF hash emitted by run_pipeline into the full underlying stored payload. Exact hash lookup only; no fuzzy matching; no recomputation.",
      inputSchema: objectSchema(
        "V-REF expansion request.",
        {
          hash: stringProperty("Public 12 lowercase hex character V-REF hash to expand."),
        },
        ["hash"],
      ),
      outputSchema: EXPAND_VEXP_REF_OUTPUT_SCHEMA,
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.ExpandVexpRef, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const rawHash = input.hash;

      if (typeof rawHash !== "string" || !isValidDeferredVexpHash(rawHash)) {
        return {
          ok: true,
          output: {
            requestedHash: typeof rawHash === "string" ? rawHash : "",
            resolved: false,
            reason: "malformed_hash",
            message:
              `expand_vexp_ref requires hash to be exactly 12 lowercase hex characters (pattern ${DEFERRED_VEXP_HASH_PATTERN}).`,
            notes: [
              "Exact hash lookup only; fuzzy matching is intentionally not supported.",
            ],
          },
        };
      }

      const store = options.store ?? getSharedDeferredVexpStore();
      const resolvedBinding = await resolveReadyRepoBinding(context, McpToolId.ExpandVexpRef);
      const persistentDb = resolvedBinding.ok
        ? openIndexerDatabase(resolvedBinding.binding.dbPath)
        : undefined;
      const resolution = (() => {
        try {
          return resolveDeferredVexpRef({
            hash: rawHash,
            store,
            ...(persistentDb === undefined ? {} : { db: persistentDb }),
          });
        } finally {
          persistentDb?.close();
        }
      })();

      if (!resolution.resolved) {
        if (resolution.reason === "expired") {
          return {
            ok: true,
            output: {
              requestedHash: rawHash,
              resolved: false,
              reason: "expired",
              message:
                "The deferred V-REF was previously known but is no longer available. Re-run run_pipeline to produce a fresh expandable V-REF.",
              notes: [
                "No hidden recomputation: vtrace intentionally refuses to fabricate expansions for evicted records.",
              ],
            },
          };
        }
        return {
          ok: true,
          output: {
            requestedHash: rawHash,
            resolved: false,
            reason: "unknown_hash",
            message:
              "No retained deferred V-REF is registered under this hash. Use run_pipeline to emit and persist expandable refs; expand_vexp_ref only resolves exact hashes it has seen emitted and retained.",
            notes: [
              "Exact hash lookup only; vtrace does not guess or approximate.",
              resolvedBinding.ok
                ? "Persistent repo-local storage was checked before returning this miss."
                : "Persistent repo-local storage was unavailable in this server context; no global lookup was attempted.",
            ],
          },
        };
      }

      const { entry } = resolution;
      if (!isSupportedDeferredVexpCategory(entry.category)) {
        return {
          ok: true,
          output: {
            requestedHash: rawHash,
            resolved: false,
            reason: "unsupported_category",
            message:
              `Deferred category '${entry.category}' is not supported by this expand_vexp_ref build. Supported: ${DEFERRED_VEXP_SUPPORTED_CATEGORIES.join(", ")}.`,
            notes: [
              "The store holds a record, but this engine build cannot interpret its category.",
            ],
          },
        };
      }

      const content = entry.content;
      const shapedContent = content.kind === "text"
        ? { kind: content.kind, mimeType: content.mimeType, text: content.text }
        : { kind: content.kind, value: structuredClone(content.value) };
      const output = {
        requestedHash: rawHash,
        resolved: true,
        stableId: entry.stableId,
        category: entry.category,
        content: shapedContent,
        metadata: {
          ...structuredClone(entry.metadata) as Readonly<Record<string, unknown>>,
          createdAtMs: entry.createdAtMs,
        },
        notes: [
          "Stored deferred payload expanded deterministically; no recomputation.",
          resolution.source === "persistent"
            ? "Resolved from repo-local persistent V-REF storage."
            : "Resolved from the process-local V-REF hot cache.",
        ],
      } as const;

      await captureExpandVexpRefObservationFromContext(context, output);

      return {
        ok: true,
        output,
      };
    },
  });
}

async function captureExpandVexpRefObservationFromContext(
  context: McpServerContext,
  output: ExpandVexpRefSuccessOutput,
): Promise<void> {
  const resolved = await resolveReadyRepoBinding(context, McpToolId.ExpandVexpRef);

  if (!resolved.ok) {
    return;
  }

  const db = openIndexerDatabase(resolved.binding.dbPath);

  try {
    if (!hasIndexedFiles(db)) {
      return;
    }

    captureExpandVexpRefObservationBestEffort({
      db,
      repoRoot: resolved.binding.repoRoot,
      sourceRunId: getLatestIndexRun(db)?.id ?? null,
      toolName: McpToolId.ExpandVexpRef,
      requestedHash: output.requestedHash,
      resolved: output.resolved,
      stableId: output.stableId,
      category: output.category,
    });
  } finally {
    db.close();
  }
}

function getRequiredToolDefinition(
  tools: readonly McpToolDefinition[],
  toolId: McpToolId,
): McpToolDefinition {
  const tool = tools.find((candidate) => candidate.metadata.toolId === toolId);

  if (tool === undefined) {
    throw new Error(`Missing required MCP tool definition: ${toolId}`);
  }

  return tool;
}

const LEGACY_MCP_TOOL_DEFINITIONS_UNFROZEN = [
  createEngineDelegateToolDefinition<IndexRepoInput, {
    repoRoot: string;
    latestRunId: number | null;
    readiness: RepoLocalState["readiness"];
    indexSummary: RepoLocalState["indexSummary"];
    latestRun: NonNullable<RepoLocalState["latestRun"]> | null;
  }>({
    metadata: {
      toolId: McpToolId.IndexRepo,
      displayName: "Index Repo",
      description:
        "Refresh the Vtrace repo index. Use this when get_code_context or another Vtrace tool reports stale_index, missing_index, or repo_not_ready.",
      inputSchema: objectSchema(
        "Optional controls for re-indexing the currently initialized repository.",
        {
          force: booleanProperty("Accepted for future compatibility; currently re-indexing always runs."),
        },
        [],
      ),
      outputSchema: objectSchema(
        "Structured output for a completed repo index run.",
        {
          repoRoot: stringProperty("Bound repo root."),
          latestRunId: {
            type: ["integer", "null"],
            description: "Latest persisted run id after re-indexing.",
          },
          readiness: READINESS_SCHEMA,
          indexSummary: INDEX_SUMMARY_SCHEMA,
          latestRun: {
            type: ["object", "null"],
            description: "Latest persisted run summary when available.",
            properties: {
              ...(RUN_SUMMARY_SCHEMA.properties ?? {}),
            },
            required: RUN_SUMMARY_SCHEMA.required ?? [],
            additionalProperties: false,
          },
        },
        ["repoRoot", "latestRunId", "readiness", "indexSummary", "latestRun"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.IndexRepo, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const force = parseOptionalBoolean(McpToolId.IndexRepo, input, "force");

      if (force !== undefined && typeof force !== "boolean") {
        return force;
      }
      void force;

      const resolved = await resolveReadyRepoBinding(context, McpToolId.IndexRepo);

      if (!resolved.ok) {
        return resolved.result;
      }

      const result = await reindexRepoAndRefreshState({
        repoRoot: resolved.binding.repoRoot,
        dbPath: resolved.binding.dbPath,
        statePath: resolved.binding.statePath,
        configPresent: true,
        statePresent: true,
        usesDbPathOverride: false,
      });
      const state = result.state;

      return {
        ok: true,
        output: {
          repoRoot: resolved.binding.repoRoot,
          latestRunId: state.latestRunId,
          readiness: state.readiness,
          indexSummary: state.indexSummary,
          latestRun: state.latestRun ?? null,
        },
      };
    },
  }),
  createEngineDelegateToolDefinition<SearchSymbolsInput, {
    query: string;
    candidates: ReturnType<typeof formatSearchCandidate>[];
  }>({
    metadata: {
      toolId: McpToolId.SearchSymbols,
      displayName: "Search Symbols",
      description: "Search indexed symbols in the initialized repository.",
      inputSchema: objectSchema(
        "Search parameters for lexical symbol retrieval.",
        {
          query: stringProperty("User query text."),
          maxResults: integerProperty("Maximum number of results to return."),
          kind: stringProperty("Optional symbol kind filter."),
          backend: stringProperty("Optional backend override."),
        },
        ["query"],
      ),
      outputSchema: objectSchema(
        "Lexical search results with stable candidate ordering.",
        {
          query: stringProperty("Original query text."),
          candidates: arrayProperty(
            "Ordered retrieved symbol candidates.",
            SEARCH_RESULT_WITH_SCORE_SCHEMA,
          ),
        },
        ["query", "candidates"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.SearchSymbols, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const query = parseRequiredQuery(McpToolId.SearchSymbols, input);
      const maxResults = parseOptionalInteger(McpToolId.SearchSymbols, input, "maxResults");
      const kind = parseOptionalSymbolKind(McpToolId.SearchSymbols, input);
      const backend = parseOptionalSearchBackend(McpToolId.SearchSymbols, input);

      if (typeof query !== "string") {
        return query;
      }
      if (maxResults !== undefined && typeof maxResults !== "number") {
        return maxResults;
      }
      if (kind !== undefined && typeof kind !== "string") {
        return kind;
      }
      if (backend !== undefined && typeof backend !== "string") {
        return backend;
      }

      return withReadyRepoDb(
        context,
        McpToolId.SearchSymbols,
        async (_binding, db) => {
          const results = searchSymbols(db, {
            query,
            maxResults: maxResults ?? MCP_PIPELINE_DEFAULTS.maxResults,
            ...(kind === undefined ? {} : { kind }),
            ...(backend === undefined ? {} : { backend }),
          });

          return {
            ok: true,
            output: {
              query,
              candidates: results.map(formatSearchCandidate),
            },
          };
        },
      );
    },
  }),
  createEngineDelegateToolDefinition<BuildCapsuleInput, {
    query: string;
    intent: string;
    classification: ReturnType<typeof routeQuery>["classification"];
    routingProfile: {
      id: string;
      backend: string;
      candidatePoolSize: number;
      graphWeights: ReturnType<typeof routeQuery>["profile"]["graphWeights"];
      summary: string;
    };
    capsuleProfile: {
      id: string;
      targetIntent: string;
      description: string;
      settingsSummary: Record<string, unknown>;
      explanation: {
        reasonKind: string;
        fallbackApplied: boolean;
        summary: string;
      };
    };
    capsule: ReturnType<typeof formatCapsuleOutput>;
  }>({
    metadata: {
      toolId: McpToolId.BuildCapsule,
      displayName: "Build Capsule",
      description: "Build a capsule for a query using the existing retrieval and capsule pipeline.",
      inputSchema: objectSchema(
        "Capsule build request.",
        {
          query: stringProperty("User query text."),
          maxResults: integerProperty("Optional reranked candidate count."),
          maxBudgetCharacters: integerProperty("Optional capsule character budget."),
        },
        ["query"],
      ),
      outputSchema: objectSchema(
        "Capsule build result.",
        {
          query: stringProperty("Original query text."),
          intent: stringProperty("Selected intent."),
          classification: CLASSIFICATION_SCHEMA,
          routingProfile: ROUTING_PROFILE_SCHEMA,
          capsuleProfile: CAPSULE_PROFILE_SCHEMA,
          capsule: objectProperty(
            "Capsule output.",
            {
              query: stringProperty("Original query text."),
              pivots: arrayProperty("Pivot capsule items.", CAPSULE_ITEM_SCHEMA),
              supportingItems: arrayProperty("Supporting capsule items.", CAPSULE_ITEM_SCHEMA),
              memories: arrayProperty("Optional surfaced memories.", CAPSULE_MEMORY_ITEM_SCHEMA),
              rules: CAPSULE_RULE_SECTION_SCHEMA,
              budget: CAPSULE_BUDGET_SCHEMA,
              truncated: booleanProperty("Whether the capsule was truncated."),
              compressed: booleanProperty("Whether any capsule item was compressed."),
              profileBudgetUsage: {
                type: ["object", "null"],
                description: "Profile-specific budget usage when available.",
                properties: {
                  ...(CAPSULE_PROFILE_BUDGET_USAGE_SCHEMA.properties ?? {}),
                },
                required: CAPSULE_PROFILE_BUDGET_USAGE_SCHEMA.required ?? [],
                additionalProperties: false,
              },
            },
            [
              "query",
              "pivots",
              "supportingItems",
              "budget",
              "truncated",
              "compressed",
              "profileBudgetUsage",
            ],
          ),
        },
        ["query", "intent", "classification", "routingProfile", "capsuleProfile", "capsule"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.BuildCapsule, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const query = parseRequiredQuery(McpToolId.BuildCapsule, input);
      const maxResults = parseOptionalInteger(McpToolId.BuildCapsule, input, "maxResults");
      const maxBudgetCharacters = parseOptionalInteger(
        McpToolId.BuildCapsule,
        input,
        "maxBudgetCharacters",
      );

      if (typeof query !== "string") {
        return query;
      }
      if (maxResults !== undefined && typeof maxResults !== "number") {
        return maxResults;
      }
      if (maxBudgetCharacters !== undefined && typeof maxBudgetCharacters !== "number") {
        return maxBudgetCharacters;
      }

      return withReadyRepoDb(
        context,
        McpToolId.BuildCapsule,
        async (binding, db) => {
          const pipeline = runIntentAwareCapsulePipeline(db, binding.repoRoot, {
            query,
            maxResults,
            maxBudgetCharacters,
          });

          return {
            ok: true,
            output: {
              query: pipeline.routedQuery.query,
              intent: pipeline.routedQuery.intent,
              classification: structuredClone(pipeline.routedQuery.classification),
              routingProfile: {
                id: pipeline.routedQuery.profile.id,
                backend: pipeline.routedQuery.profile.backend,
                candidatePoolSize: pipeline.routedQuery.profile.candidatePoolSize,
                graphWeights: structuredClone(pipeline.routedQuery.profile.graphWeights),
                summary: pipeline.routedQuery.profile.summary,
              },
              capsuleProfile: {
                id: pipeline.preparedAssembly.selection.profile.id,
                targetIntent: pipeline.preparedAssembly.selection.profile.targetIntent,
                description: pipeline.preparedAssembly.selection.profile.description,
                settingsSummary: structuredClone(pipeline.preparedAssembly.selection.settingsSummary),
                explanation: structuredClone(pipeline.preparedAssembly.selection.explanation),
              },
              capsule: {
                ...formatCapsuleOutput(pipeline.capsule),
                profileBudgetUsage: pipeline.capsule.profileBudgetUsage === undefined
                  ? null
                  : {
                    pivotCharactersUsed: pipeline.capsule.profileBudgetUsage.pivotCharactersUsed,
                    supportCharactersUsed: pipeline.capsule.profileBudgetUsage.supportCharactersUsed,
                    pivotCharactersMax: pipeline.capsule.profileBudgetUsage.pivotCharactersMax ?? null,
                    supportCharactersMax: pipeline.capsule.profileBudgetUsage.supportCharactersMax ?? null,
                  },
              },
            },
          };
        },
      );
    },
  }),
  createEngineDelegateToolDefinition<BuildHandoffInput, HandoffPayload>({
    metadata: {
      toolId: McpToolId.BuildHandoff,
      displayName: "Build Handoff",
      description: "Build a handoff payload for a query using the existing Layer 6 pipeline.",
      inputSchema: objectSchema(
        "Handoff build request.",
        {
          query: stringProperty("User query text."),
          maxResults: integerProperty("Optional reranked candidate count."),
          maxBudgetCharacters: integerProperty("Optional capsule character budget."),
        },
        ["query"],
      ),
      outputSchema: objectSchema(
        "Canonical handoff payload output.",
        {
          schema: objectProperty(
            "Handoff payload schema descriptor.",
            {
              name: stringProperty("Payload schema name."),
              version: stringProperty("Payload schema version."),
            },
            ["name", "version"],
          ),
          query: stringProperty("Original query text."),
          selectedIntent: stringProperty("Selected intent."),
          classification: CLASSIFICATION_SCHEMA,
          routingProfile: ROUTING_PROFILE_SCHEMA,
          capsuleProfile: CAPSULE_PROFILE_SCHEMA,
          capsule: objectProperty(
            "Handoff capsule payload.",
            {
              query: stringProperty("Original query text."),
              items: arrayProperty("Capsule items.", RAW_CAPSULE_ITEM_SCHEMA),
              memories: arrayProperty("Optional surfaced memories.", CAPSULE_MEMORY_ITEM_SCHEMA),
              budget: CAPSULE_BUDGET_SCHEMA,
              profileBudgetUsage: {
                type: ["object", "null"],
                description: "Profile-specific budget usage when available.",
                properties: {
                  ...(CAPSULE_PROFILE_BUDGET_USAGE_SCHEMA.properties ?? {}),
                },
                required: CAPSULE_PROFILE_BUDGET_USAGE_SCHEMA.required ?? [],
                additionalProperties: false,
              },
              truncated: booleanProperty("Whether the capsule was truncated."),
              compressed: booleanProperty("Whether the capsule was compressed."),
            },
            ["query", "items", "budget", "profileBudgetUsage", "truncated", "compressed"],
          ),
          provenance: HANDOFF_PROVENANCE_SCHEMA,
          trust: HANDOFF_TRUST_SCHEMA,
        },
        ["schema", "query", "selectedIntent", "classification", "routingProfile", "capsuleProfile", "capsule", "provenance", "trust"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.BuildHandoff, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const query = parseRequiredQuery(McpToolId.BuildHandoff, input);
      const maxResults = parseOptionalInteger(McpToolId.BuildHandoff, input, "maxResults");
      const maxBudgetCharacters = parseOptionalInteger(
        McpToolId.BuildHandoff,
        input,
        "maxBudgetCharacters",
      );

      if (typeof query !== "string") {
        return query;
      }
      if (maxResults !== undefined && typeof maxResults !== "number") {
        return maxResults;
      }
      if (maxBudgetCharacters !== undefined && typeof maxBudgetCharacters !== "number") {
        return maxBudgetCharacters;
      }

      return withReadyRepoDb(
        context,
        McpToolId.BuildHandoff,
        async (binding, db) => {
          const pipeline = runIntentAwareCapsulePipeline(db, binding.repoRoot, {
            query,
            maxResults,
            maxBudgetCharacters,
          });
          const payload = buildHandoffPayload(deterministicHandoffBuilder, {
            pipeline: {
              routedQuery: pipeline.routedQuery,
              capsuleProfileSelection: pipeline.preparedAssembly.selection,
              capsule: pipeline.capsule,
            },
            metadata: {
              repoRoot: binding.repoRoot,
              sourceRunId: getLatestIndexRun(db)?.id ?? null,
            },
          });

          return {
            ok: true,
            output: payload,
          };
        },
      );
    },
  }),
  createEngineDelegateToolDefinition<RouteQueryInput, {
    query: string;
    intent: string;
    classification: ReturnType<typeof routeQuery>["classification"];
    profile: {
      id: string;
      backend: string;
      candidatePoolSize: number;
      graphWeights: ReturnType<typeof routeQuery>["profile"]["graphWeights"];
      summary: string;
    };
    rerankedResults: ReturnType<typeof formatGraphSearchCandidate>[];
  }>({
    metadata: {
      toolId: McpToolId.RouteQuery,
      displayName: "Route Query",
      description: "Classify a query, select a retrieval profile, and return reranked candidates.",
      inputSchema: objectSchema(
        "Query routing input.",
        {
          query: stringProperty("User query text."),
          maxResults: integerProperty("Maximum number of reranked results to return."),
        },
        ["query"],
      ),
      outputSchema: objectSchema(
        "Routed query output with intent, classification, selected profile, and reranked candidates.",
        {
          query: stringProperty("Original query text."),
          intent: stringProperty("Selected intent."),
          classification: CLASSIFICATION_SCHEMA,
          profile: ROUTING_PROFILE_SCHEMA,
          rerankedResults: arrayProperty(
            "Ordered reranked symbol candidates.",
            RERANKED_RESULT_SCHEMA,
          ),
        },
        ["query", "intent", "classification", "profile", "rerankedResults"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.RouteQuery, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const query = parseRequiredQuery(McpToolId.RouteQuery, input);
      const maxResults = parseOptionalInteger(McpToolId.RouteQuery, input, "maxResults");

      if (typeof query !== "string") {
        return query;
      }
      if (maxResults !== undefined && typeof maxResults !== "number") {
        return maxResults;
      }

      return withReadyRepoDb(
        context,
        McpToolId.RouteQuery,
        async (_binding, db) => {
          const routed = routeQuery(db, query, {
            maxResults: maxResults ?? MCP_PIPELINE_DEFAULTS.maxResults,
          });

          return {
            ok: true,
            output: {
              query: routed.query,
              intent: routed.intent,
              classification: structuredClone(routed.classification),
              profile: {
                id: routed.profile.id,
                backend: routed.profile.backend,
                candidatePoolSize: routed.profile.candidatePoolSize,
                graphWeights: structuredClone(routed.profile.graphWeights),
                summary: routed.profile.summary,
              },
              rerankedResults: routed.rerankedResults.map(formatGraphSearchCandidate),
            },
          };
        },
      );
    },
  }),
  createEngineDelegateToolDefinition<Record<string, never>, {
    runs: ReturnType<typeof formatIndexRunSummary>[];
  }>({
    metadata: {
      toolId: McpToolId.ListRuns,
      displayName: "List Runs",
      description: "List persisted index runs for the initialized repository.",
      inputSchema: objectSchema(
        "Run listing options for the initialized repository.",
        {},
        [],
      ),
      outputSchema: objectSchema(
        "Persisted run summaries.",
        {
          runs: arrayProperty("Ordered run summaries.", RUN_HISTORY_ENTRY_SCHEMA),
        },
        ["runs"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.ListRuns, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      return withReadyRepoDb(
        context,
        McpToolId.ListRuns,
        async (_binding, db) => {
          const runs = listIndexRuns(db);

          if (runs.length === 0) {
            return repoNotReady(
              McpToolId.ListRuns,
              "Repository has no persisted index runs.",
            );
          }

          return {
            ok: true,
            output: {
              runs: runs.map((run) => formatIndexRunSummary(getIndexRunSummary(db, run.id)!)),
            },
          };
        },
      );
    },
  }),
  createEngineDelegateToolDefinition<CheckCapsuleStalenessInput, {
    capsuleId: string;
    sourceRunId: number;
    comparisonRunId: number;
    query: string;
    status: string;
    items: ReturnType<typeof getCapsuleStaleness> extends infer _T ? unknown[] : never;
  }>({
    metadata: {
      toolId: McpToolId.CheckCapsuleStaleness,
      displayName: "Check Capsule Staleness",
      description: "Evaluate persisted capsule trust and staleness for a later comparison run.",
      inputSchema: objectSchema(
        "Capsule staleness check request.",
        {
          manifestId: stringProperty("Persisted capsule manifest id."),
          comparisonRunId: integerProperty("Run id to compare against."),
        },
        ["manifestId", "comparisonRunId"],
      ),
      outputSchema: CAPSULE_STALENESS_SCHEMA,
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.CheckCapsuleStaleness, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const manifestId = parseRequiredStringField(
        McpToolId.CheckCapsuleStaleness,
        input,
        "manifestId",
      );
      const comparisonRunId = parseOptionalInteger(
        McpToolId.CheckCapsuleStaleness,
        input,
        "comparisonRunId",
      );

      if (typeof manifestId !== "string") {
        return manifestId;
      }
      if (comparisonRunId === undefined) {
        return invalidRequest(
          McpToolId.CheckCapsuleStaleness,
          "MCP tool check_capsule_staleness requires a non-negative integer comparisonRunId.",
          { field: "comparisonRunId" },
        );
      }
      if (typeof comparisonRunId !== "number") {
        return comparisonRunId;
      }

      return withReadyRepoDb(
        context,
        McpToolId.CheckCapsuleStaleness,
        async (_binding, db) => {
          const manifest = getCapsuleManifestById(db, manifestId);

          if (manifest === undefined) {
            return invalidRequest(
              McpToolId.CheckCapsuleStaleness,
              `Capsule manifest not found: ${manifestId}`,
              { manifestId },
            );
          }

          const comparisonRun = getIndexRunById(db, comparisonRunId);

          if (comparisonRun === undefined) {
            return invalidRequest(
              McpToolId.CheckCapsuleStaleness,
              `Index run not found: ${comparisonRunId}`,
              { comparisonRunId },
            );
          }

          if (comparisonRunId < manifest.sourceRunId) {
            return invalidRequest(
              McpToolId.CheckCapsuleStaleness,
              "comparisonRunId must be greater than or equal to sourceRunId",
              {
                comparisonRunId,
                sourceRunId: manifest.sourceRunId,
              },
            );
          }

          try {
            const staleness = getCapsuleStaleness(db, manifestId, comparisonRunId)!;

            return {
              ok: true,
              output: structuredClone(staleness),
            };
          } catch (error) {
            return invalidRequest(
              McpToolId.CheckCapsuleStaleness,
              error instanceof Error ? error.message : String(error),
              {
                manifestId,
                comparisonRunId,
              },
            );
          }
        },
      );
    },
  }),
  createEngineDelegateToolDefinition<SaveObservationInput, {
    observation: ReturnType<typeof formatObservation>;
    staleness: ReturnType<typeof formatObservationSearchResult>["staleness"];
  }>({
    metadata: {
      toolId: McpToolId.SaveObservation,
      displayName: "Save Observation",
      description: "Persist a manual observation anchored to the initialized repository state.",
      inputSchema: objectSchema(
        "Manual observation input.",
        {
          sessionId: stringProperty("Optional session id."),
          kind: stringProperty("Observation kind."),
          summary: stringProperty("Short observation summary."),
          body: stringProperty("Optional observation body text."),
          queryText: stringProperty("Optional related query text."),
          intent: stringProperty("Optional selected intent."),
          linkedFilePaths: arrayProperty("Optional linked repo-relative file paths.", stringProperty("File path.")),
          linkedSymbolIds: arrayProperty("Optional linked persisted symbol ids.", stringProperty("Symbol id.")),
          linkedFqNames: arrayProperty("Optional linked fully qualified names.", stringProperty("Fully qualified name.")),
          toolName: stringProperty("Optional originating tool name."),
        },
        ["kind", "summary"],
      ),
      outputSchema: objectSchema(
        "Persisted observation output.",
        {
          observation: OBSERVATION_SCHEMA,
          staleness: OBSERVATION_STALENESS_SCHEMA,
        },
        ["observation", "staleness"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.SaveObservation, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const kind = parseObservationKindInput(McpToolId.SaveObservation, input);
      const summary = parseRequiredStringField(McpToolId.SaveObservation, input, "summary");
      const sessionId = parseOptionalStringField(McpToolId.SaveObservation, input, "sessionId");
      const body = parseOptionalStringField(McpToolId.SaveObservation, input, "body");
      const queryText = parseOptionalStringField(McpToolId.SaveObservation, input, "queryText");
      const intent = parseOptionalStringField(McpToolId.SaveObservation, input, "intent");
      const toolName = parseOptionalStringField(McpToolId.SaveObservation, input, "toolName");
      const linkedFilePaths = parseOptionalStringArrayField(McpToolId.SaveObservation, input, "linkedFilePaths");
      const linkedSymbolIds = parseOptionalStringArrayField(McpToolId.SaveObservation, input, "linkedSymbolIds");
      const linkedFqNames = parseOptionalStringArrayField(McpToolId.SaveObservation, input, "linkedFqNames");

      if (typeof kind !== "string") {
        return kind;
      }
      if (typeof summary !== "string") {
        return summary;
      }
      if (sessionId !== undefined && typeof sessionId !== "string") {
        return sessionId;
      }
      if (body !== undefined && typeof body !== "string") {
        return body;
      }
      if (queryText !== undefined && typeof queryText !== "string") {
        return queryText;
      }
      if (intent !== undefined && typeof intent !== "string") {
        return intent;
      }
      if (toolName !== undefined && typeof toolName !== "string") {
        return toolName;
      }
      if (linkedFilePaths !== undefined && !Array.isArray(linkedFilePaths)) {
        return linkedFilePaths;
      }
      if (linkedSymbolIds !== undefined && !Array.isArray(linkedSymbolIds)) {
        return linkedSymbolIds;
      }
      if (linkedFqNames !== undefined && !Array.isArray(linkedFqNames)) {
        return linkedFqNames;
      }

      return withReadyRepoDb(
        context,
        McpToolId.SaveObservation,
        async (binding, db) => {
          try {
            const observation = persistObservation(db, {
              repoRoot: binding.repoRoot,
              sessionId,
              sessionAgentKind: "mcp",
              kind,
              source: ObservationSource.Manual,
              toolName,
              queryText,
              intent,
              summary,
              body,
              sourceRunId: getLatestIndexRun(db)?.id,
              linkedFilePaths,
              linkedSymbolIds,
              linkedFqNames,
            });
            const formattedSearchResult = formatObservationSearchResult({
              observation,
              staleness: getObservationStaleness(db, observation),
              score: 0,
              signals: [],
            });

            return {
              ok: true,
              output: {
                observation: formattedSearchResult.observation,
                staleness: formattedSearchResult.staleness,
              },
            };
          } catch (error) {
            return invalidRequest(
              McpToolId.SaveObservation,
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      );
    },
  }),
  createEngineDelegateToolDefinition<SearchMemoryInput, {
    query: string;
    results: ReturnType<typeof formatObservationSearchResult>[];
  }>({
    metadata: {
      toolId: McpToolId.SearchMemory,
      displayName: "Search Memory",
      description: "Search persisted observation memory using deterministic lexical and structural signals.",
      inputSchema: objectSchema(
        "Observation memory search input.",
        {
          query: stringProperty("Search query text."),
          maxResults: integerProperty("Maximum number of results to return."),
          sessionId: stringProperty("Optional session filter."),
          linkedFilePaths: arrayProperty("Optional linked repo-relative file paths.", stringProperty("File path.")),
          linkedSymbolIds: arrayProperty("Optional linked persisted symbol ids.", stringProperty("Symbol id.")),
          repos: arrayProperty("Optional workspace repo aliases to search.", stringProperty("Repo alias.")),
        },
        ["query"],
      ),
      outputSchema: objectSchema(
        "Observation memory search results.",
        {
          query: stringProperty("Original search query."),
          selectedRepos: arrayProperty("Selected repo aliases for a multi-repo memory search.", stringProperty("Repo alias.")),
          results: arrayProperty("Ranked observation results.", OBSERVATION_SEARCH_RESULT_SCHEMA),
        },
        ["query", "results"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.SearchMemory, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const query = parseRequiredQuery(McpToolId.SearchMemory, input);
      const maxResults = parseOptionalInteger(McpToolId.SearchMemory, input, "maxResults");
      const sessionId = parseOptionalStringField(McpToolId.SearchMemory, input, "sessionId");
      const linkedFilePaths = parseOptionalStringArrayField(McpToolId.SearchMemory, input, "linkedFilePaths");
      const linkedSymbolIds = parseOptionalStringArrayField(McpToolId.SearchMemory, input, "linkedSymbolIds");
      const repos = parseOptionalStringArrayField(McpToolId.SearchMemory, input, "repos");

      if (typeof query !== "string") {
        return query;
      }
      if (maxResults !== undefined && typeof maxResults !== "number") {
        return maxResults;
      }
      if (sessionId !== undefined && typeof sessionId !== "string") {
        return sessionId;
      }
      if (linkedFilePaths !== undefined && !Array.isArray(linkedFilePaths)) {
        return linkedFilePaths;
      }
      if (linkedSymbolIds !== undefined && !Array.isArray(linkedSymbolIds)) {
        return linkedSymbolIds;
      }
      if (repos !== undefined && !Array.isArray(repos)) {
        return repos;
      }

      const selection = await resolveWorkspaceRepoSelection(context, McpToolId.SearchMemory, repos);

      if (!selection.ok) {
        return selection.result;
      }

      if (hasMultiRepoRequest(selection.selection, repos)) {
        const results: Array<ReturnType<typeof formatObservationSearchResult>> = [];

        for (const status of selection.selection.statuses) {
          if (status.binding === undefined) {
            continue;
          }

          const db = openIndexerDatabase(status.binding.dbPath);

          try {
            if (!hasIndexedFiles(db)) {
              continue;
            }

            results.push(
              ...searchMemory(db, {
                query,
                maxResults,
                sessionId,
                linkedFilePaths,
                linkedSymbolIds,
              }).map((result) => formatObservationSearchResult(result, status.repoAlias)),
            );
          } finally {
            db.close();
          }
        }

        results.sort((left, right) => {
          return right.score - left.score
            || compareString(left.observation.repoAlias ?? "", right.observation.repoAlias ?? "")
            || compareString(left.observation.id, right.observation.id);
        });

        return {
          ok: true,
          output: {
            query,
            selectedRepos: [...selection.selection.selectedAliases],
            results: results.slice(0, maxResults ?? MCP_PIPELINE_DEFAULTS.maxResults),
          },
        };
      }

      return withReadyRepoDb(
        context,
        McpToolId.SearchMemory,
        async (binding, db) => {
          const results = searchMemory(db, {
            query,
            maxResults,
            sessionId,
            linkedFilePaths,
            linkedSymbolIds,
          });

          captureSearchMemoryObservationBestEffort({
            db,
            repoRoot: binding.repoRoot,
            sourceRunId: getLatestIndexRun(db)?.id ?? null,
            toolName: McpToolId.SearchMemory,
            query,
            maxResults,
            sessionId,
            resultCount: results.length,
            topObservationIds: results.map((result) => result.observation.id),
            linkedFilePaths,
            linkedSymbolIds,
          });

          return {
            ok: true,
            output: {
              query,
              results: results.map(formatObservationSearchResult),
            },
          };
        },
      );
    },
  }),
  createEngineDelegateToolDefinition<GetSessionContextInput, {
    sessionId: string | null;
    session: ReturnType<typeof formatSession> | null;
    summary: ReturnType<typeof formatSessionSummary> | null;
    compressedSummary: ReturnType<typeof formatSessionCompressionSummary> | null;
    observations: ReturnType<typeof formatObservation>[];
    rankedObservations?: ReturnType<typeof formatObservation>[];
  }>({
    metadata: {
      toolId: McpToolId.GetSessionContext,
      displayName: "Get Session Context",
      description: "Return task-oriented recent observation context for a requested session, or the latest repo observations when no session is provided.",
      inputSchema: objectSchema(
        "Session-context lookup input.",
        {
          sessionId: stringProperty("Optional session id."),
          limit: integerProperty("Maximum observations to return."),
          query: stringProperty("Optional query used to rank observations within the selected session."),
        },
        [],
      ),
      outputSchema: objectSchema(
        "Recent observation context for a session.",
        {
          sessionId: {
            type: ["string", "null"],
            description: "Requested session id, or null when global recent context was requested.",
          },
          session: {
            type: ["object", "null"],
            description: "Persisted session entity when the requested session exists.",
            properties: {
              ...(SESSION_SCHEMA.properties ?? {}),
            },
            required: SESSION_SCHEMA.required ?? [],
            additionalProperties: false,
          },
          summary: {
            type: ["object", "null"],
            description: "Deterministic derived summary for the requested session when available.",
            properties: {
              ...(SESSION_SUMMARY_SCHEMA.properties ?? {}),
            },
            required: SESSION_SUMMARY_SCHEMA.required ?? [],
            additionalProperties: false,
          },
          compressedSummary: {
            type: ["object", "null"],
            description: "Deterministic compression summary when the requested session has been compressed.",
            properties: {
              ...(SESSION_COMPRESSION_SUMMARY_SCHEMA.properties ?? {}),
            },
            required: SESSION_COMPRESSION_SUMMARY_SCHEMA.required ?? [],
            additionalProperties: false,
          },
          observations: arrayProperty("Ordered recent observations.", OBSERVATION_SCHEMA),
          rankedObservations: arrayProperty(
            "Optional query-ranked observations for the requested session or repo scope.",
            OBSERVATION_SCHEMA,
          ),
        },
        ["sessionId", "session", "summary", "compressedSummary", "observations"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.GetSessionContext, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const sessionId = parseOptionalStringField(McpToolId.GetSessionContext, input, "sessionId");
      const limit = parseOptionalInteger(McpToolId.GetSessionContext, input, "limit");
      const query = parseOptionalStringField(McpToolId.GetSessionContext, input, "query");

      if (sessionId !== undefined && typeof sessionId !== "string") {
        return sessionId;
      }
      if (limit !== undefined && typeof limit !== "number") {
        return limit;
      }
      if (query !== undefined && typeof query !== "string") {
        return query;
      }

      return withReadyRepoDb(
        context,
        McpToolId.GetSessionContext,
        async (binding, db) => {
          const contextResult = getSessionContext(db, {
            sessionId,
            limit,
            query,
          });
          const linkedObservations = [
            ...contextResult.observations,
            ...(contextResult.rankedObservations ?? []),
          ];

          captureSessionContextObservationBestEffort({
            db,
            repoRoot: binding.repoRoot,
            sourceRunId: getLatestIndexRun(db)?.id ?? null,
            toolName: McpToolId.GetSessionContext,
            sessionId,
            query,
            limit,
            observationCount: contextResult.observations.length,
            rankedObservationCount: contextResult.rankedObservations?.length,
            observationIds: contextResult.observations.map((observation) => observation.id),
            linkedFilePaths: linkedObservations.flatMap((observation) => observation.linkedFilePaths),
            linkedSymbolIds: linkedObservations.flatMap((observation) => {
              return observation.linkedSymbols.map((link) => link.symbolId);
            }),
            linkedFqNames: linkedObservations.flatMap((observation) => [
              ...observation.linkedFqNames,
              ...observation.linkedSymbols.map((link) => link.fqName),
            ]),
          });

          return {
            ok: true,
            output: {
              sessionId: contextResult.sessionId,
              session: contextResult.session === null
                ? null
                : formatSession(contextResult.session),
              summary: contextResult.summary === null
                ? null
                : formatSessionSummary(contextResult.summary),
              compressedSummary: contextResult.compressedSummary === null
                ? null
                : formatSessionCompressionSummary(contextResult.compressedSummary),
              observations: contextResult.observations.map(formatObservation),
              ...(contextResult.rankedObservations === undefined
                ? {}
                : {
                  rankedObservations: contextResult.rankedObservations.map(formatObservation),
                }),
            },
          };
        },
      );
    },
  }),
  createEngineDelegateToolDefinition<ListSessionsInput, {
    sessions: ReturnType<typeof formatSessionListItem>[];
  }>({
    metadata: {
      toolId: McpToolId.ListSessions,
      displayName: "List Sessions",
      description: "Browse recent sessions for the repo in compact newest-activity-first order.",
      inputSchema: objectSchema(
        "Session-listing input.",
        {},
        [],
      ),
      outputSchema: objectSchema(
        "Compact bounded session listing output.",
        {
          sessions: arrayProperty("Compact session rows.", SESSION_LIST_ITEM_SCHEMA),
        },
        ["sessions"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.ListSessions, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      return withReadyRepoDb(
        context,
        McpToolId.ListSessions,
        async (_binding, db) => ({
          ok: true,
          output: {
            sessions: listInspectableSessions(db).map(formatSessionListItem),
          },
        }),
      );
    },
  }),
  createEngineDelegateToolDefinition<ReadSessionInput, {
    session: ReturnType<typeof formatSession>;
    summary: ReturnType<typeof formatSessionSummary>;
    compressedSummary: ReturnType<typeof formatSessionCompressionSummary> | null;
    recentObservations: ReturnType<typeof formatSessionObservationPreview>[];
  }>({
    metadata: {
      toolId: McpToolId.ReadSession,
      displayName: "Read Session",
      description: "Inspect one explicit session with its persisted record, derived summary, and a tiny recent-observation preview.",
      inputSchema: objectSchema(
        "Single-session inspection input.",
        {
          sessionId: stringProperty("Explicit session id to inspect."),
        },
        ["sessionId"],
      ),
      outputSchema: objectSchema(
        "One explicit session inspection view.",
        {
          session: {
            type: "object",
            description: "Persisted session entity.",
            properties: {
              ...(SESSION_SCHEMA.properties ?? {}),
            },
            required: SESSION_SCHEMA.required ?? [],
            additionalProperties: false,
          },
          summary: {
            type: "object",
            description: "Deterministic derived summary for the session.",
            properties: {
              ...(SESSION_SUMMARY_SCHEMA.properties ?? {}),
            },
            required: SESSION_SUMMARY_SCHEMA.required ?? [],
            additionalProperties: false,
          },
          compressedSummary: {
            type: ["object", "null"],
            description: "Deterministic compression summary when the session has been compressed.",
            properties: {
              ...(SESSION_COMPRESSION_SUMMARY_SCHEMA.properties ?? {}),
            },
            required: SESSION_COMPRESSION_SUMMARY_SCHEMA.required ?? [],
            additionalProperties: false,
          },
          recentObservations: arrayProperty(
            "Tiny bounded preview of recent observations for the session.",
            SESSION_OBSERVATION_PREVIEW_SCHEMA,
          ),
        },
        ["session", "summary", "compressedSummary", "recentObservations"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.ReadSession, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const sessionId = parseOptionalStringField(McpToolId.ReadSession, input, "sessionId");

      if (sessionId !== undefined && typeof sessionId !== "string") {
        return sessionId;
      }
      if (sessionId === undefined) {
        return invalidRequest(
          McpToolId.ReadSession,
          `MCP tool ${McpToolId.ReadSession} requires sessionId to be a non-empty string.`,
          { field: "sessionId" },
        );
      }

      return withReadyRepoDb(
        context,
        McpToolId.ReadSession,
        async (_binding, db) => {
          const sessionResult = readInspectableSession(db, sessionId);

          if (sessionResult === undefined) {
            return invalidRequest(
              McpToolId.ReadSession,
              `Unknown session: ${sessionId}`,
              { sessionId },
            );
          }

          return {
            ok: true,
            output: {
              session: formatSession(sessionResult.session),
              summary: formatSessionSummary(sessionResult.summary),
              compressedSummary: sessionResult.compressedSummary === null
                ? null
                : formatSessionCompressionSummary(sessionResult.compressedSummary),
              recentObservations: sessionResult.recentObservations.map(formatSessionObservationPreview),
            },
          };
        },
      );
    },
  }),
] satisfies McpToolDefinition[];

type RunPipelineMcpOutput = ReturnType<typeof formatRunPipelineOrchestrationOutput> & {
  savedObservation: {
    observation: ReturnType<typeof formatObservation>;
    staleness: ReturnType<typeof formatObservationSearchResult>["staleness"];
  } | null;
};

const RUN_PIPELINE_TOOL_DEFINITION = createEngineDelegateToolDefinition<RunPipelineInput, RunPipelineMcpOutput>({
  metadata: {
    toolId: McpToolId.RunPipeline,
    displayName: "Run Pipeline",
    description:
      "Default Vtrace repo-context pipeline. get_code_context is the agent-friendly alias for this tool.",
    inputSchema: objectSchema(
        "Pipeline orchestration request.",
        {
          task: stringProperty("Product-facing task description. Preferred over legacy query when both are provided."),
          query: stringProperty("Legacy task query text; preserved for backward compatibility."),
          preset: stringProperty(
            `Product-facing preset. One of: ${[RunPipelinePresetIntent.Auto, ...RUN_PIPELINE_CONCRETE_PRESETS].join(", ")}. Defaults to auto.`,
          ),
          intent: stringProperty(
            "Legacy alias for preset.",
          ),
          maxResults: integerProperty("Optional reranked candidate count."),
          max_tokens: integerProperty("Product-facing total output budget. Currently mapped to vtrace's character-budgeted capsule engine."),
          maxBudgetCharacters: integerProperty("Legacy capsule character budget."),
          include_tests: booleanProperty("Product-facing test-inclusion preference. Defaults true for debug preset, false otherwise."),
          include_file_content: booleanProperty("Product-facing file-content preference. The compact run_pipeline result still returns representation metadata, not full files."),
          sessionId: stringProperty("Optional session id used for session-context memory recall and observation save."),
          includeMemory: booleanProperty("When true, force durable memory inclusion even for presets that de-emphasize it."),
          saveObservation: booleanProperty("When true, persist a compact tool-call observation for this pipeline run."),
          observation: stringProperty("Optional durable observation text to save after the pipeline completes."),
          repos: arrayProperty("Optional workspace repo aliases to query. Defaults to all enabled repos when a workspace config is present.", stringProperty("Repo alias.")),
        },
        [],
      ),
      outputSchema: objectSchema(
        "Explicit run_pipeline orchestration output.",
        {
          schemaVersion: stringProperty("Orchestration result schema version."),
          workspace: {
            type: ["object", "null"],
            description: "Workspace metadata when a multi-repo workspace config is active.",
            properties: {
              name: {
                type: ["string", "null"],
                description: "Workspace name when configured.",
              },
              primaryRepoAlias: stringProperty("Primary repo alias."),
              selectedRepos: arrayProperty("Selected repo aliases.", stringProperty("Repo alias.")),
              configuredRepos: arrayProperty("All configured repo aliases.", stringProperty("Repo alias.")),
            },
            required: ["name", "primaryRepoAlias", "selectedRepos", "configuredRepos"],
            additionalProperties: false,
          },
          request: objectProperty(
            "Resolved request parameters.",
            {
              task: stringProperty("Product-facing task text."),
              query: stringProperty("Original query text."),
              maxResults: integerProperty("Resolved reranked candidate count."),
              maxBudgetCharacters: integerProperty("Resolved capsule character budget."),
              includeTests: booleanProperty("Resolved test-inclusion preference."),
              includeFileContent: booleanProperty("Resolved file-content preference."),
              presetRequested: stringProperty("Product-facing preset requested by caller."),
              intentRequested: stringProperty("Intent preset requested by caller (default auto)."),
              sessionId: {
                type: ["string", "null"],
                description: "Session id used for session-context retrieval when provided.",
              },
              selectedRepos: arrayProperty("Selected repo aliases for a multi-repo run.", stringProperty("Repo alias.")),
            },
            [
              "task",
              "query",
              "maxResults",
              "maxBudgetCharacters",
              "includeTests",
              "includeFileContent",
              "presetRequested",
              "intentRequested",
              "sessionId",
            ],
          ),
          intent: RUN_PIPELINE_INTENT_DECISION_SCHEMA,
          taskSummary: RUN_PIPELINE_TASK_SUMMARY_SCHEMA,
          context: RUN_PIPELINE_CONTEXT_SECTION_SCHEMA,
          impact: RUN_PIPELINE_IMPACT_SECTION_SCHEMA,
          flow: RUN_PIPELINE_FLOW_SECTION_SCHEMA,
          memory: RUN_PIPELINE_MEMORY_SECTION_SCHEMA,
          rules: RUN_PIPELINE_RULE_SECTION_SCHEMA,
          diagnostics: RUN_PIPELINE_ORCHESTRATION_DIAGNOSTICS_SCHEMA,
          deferred: RUN_PIPELINE_DEFERRED_SECTION_SCHEMA,
          savedObservation: {
            type: ["object", "null"],
            description: "Persisted observation when saveObservation=true.",
            properties: {
              observation: OBSERVATION_SCHEMA,
              staleness: OBSERVATION_STALENESS_SCHEMA,
            },
            required: ["observation", "staleness"],
            additionalProperties: false,
          },
        },
        [
          "schemaVersion",
          "request",
          "intent",
          "taskSummary",
          "context",
          "impact",
          "flow",
          "memory",
          "rules",
          "diagnostics",
          "deferred",
          "savedObservation",
        ],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.RunPipeline, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const query = parseRequiredRunPipelineTask(input);
      const maxResults = parseOptionalInteger(McpToolId.RunPipeline, input, "maxResults");
      const maxBudgetCharacters = parseOptionalIntegerAlias(
        McpToolId.RunPipeline,
        input,
        "max_tokens",
        "maxBudgetCharacters",
      );
      const sessionId = parseOptionalStringField(McpToolId.RunPipeline, input, "sessionId");
      const saveObservation = parseOptionalBoolean(McpToolId.RunPipeline, input, "saveObservation");
      const includeMemory = parseOptionalBoolean(McpToolId.RunPipeline, input, "includeMemory");
      const includeTests = parseOptionalBoolean(McpToolId.RunPipeline, input, "include_tests");
      const includeFileContent = parseOptionalBoolean(McpToolId.RunPipeline, input, "include_file_content");
      const observationText = parseOptionalStringField(McpToolId.RunPipeline, input, "observation");
      const presetRequested = parseOptionalStringField(McpToolId.RunPipeline, input, "preset");
      const legacyIntentRequested = parseOptionalStringField(McpToolId.RunPipeline, input, "intent");
      const intentRequested = presetRequested ?? legacyIntentRequested;
      const repos = parseOptionalStringArrayField(McpToolId.RunPipeline, input, "repos");

      if (typeof query !== "string") {
        return query;
      }
      if (maxResults !== undefined && typeof maxResults !== "number") {
        return maxResults;
      }
      if (maxBudgetCharacters !== undefined && typeof maxBudgetCharacters !== "number") {
        return maxBudgetCharacters;
      }
      if (sessionId !== undefined && typeof sessionId !== "string") {
        return sessionId;
      }
      if (saveObservation !== undefined && typeof saveObservation !== "boolean") {
        return saveObservation;
      }
      if (includeMemory !== undefined && typeof includeMemory !== "boolean") {
        return includeMemory;
      }
      if (includeTests !== undefined && typeof includeTests !== "boolean") {
        return includeTests;
      }
      if (includeFileContent !== undefined && typeof includeFileContent !== "boolean") {
        return includeFileContent;
      }
      if (observationText !== undefined && typeof observationText !== "string") {
        return observationText;
      }
      if (presetRequested !== undefined && typeof presetRequested !== "string") {
        return presetRequested;
      }
      if (legacyIntentRequested !== undefined && typeof legacyIntentRequested !== "string") {
        return legacyIntentRequested;
      }
      if (intentRequested !== undefined && typeof intentRequested !== "string") {
        return intentRequested;
      }
      if (repos !== undefined && !Array.isArray(repos)) {
        return repos;
      }

      if (intentRequested !== undefined && !isRunPipelinePresetIntent(intentRequested)) {
        return invalidRequest(
          McpToolId.RunPipeline,
          `MCP tool run_pipeline preset/intent must be one of: ${[RunPipelinePresetIntent.Auto, ...RUN_PIPELINE_CONCRETE_PRESETS].join(", ")}.`,
          { field: "intent", value: intentRequested },
        );
      }

      const selection = await resolveWorkspaceRepoSelection(context, McpToolId.RunPipeline, repos);

      if (!selection.ok) {
        return selection.result;
      }

      if (hasMultiRepoRequest(selection.selection, repos)) {
        const multi = await runMultiRepoPipelineOrchestration(selection.selection, {
          query,
          maxResults,
          maxBudgetCharacters,
          intent: intentRequested,
          sessionId,
          includeMemory,
          includeTests,
          includeFileContent,
        });

        return multi.ok
          ? { ok: true, output: multi.output }
          : multi.result;
      }

      return withReadyRepoDb(
        context,
        McpToolId.RunPipeline,
        async (binding, db) => {
          const preexistingSessionStatus = sessionId === undefined
            ? undefined
            : getSessionById(db, sessionId)?.status;
          const orchestration = runPipelineOrchestrator(db, binding.repoRoot, {
            query,
            maxResults,
            maxBudgetCharacters,
            intent: intentRequested,
            sessionId,
            includeMemory,
            includeTests,
            includeFileContent,
          });

          // Auto-capture is a best-effort post-success side effect shared with
          // get_context_capsule. Deduped by (sourceRunId, query, intent,
          // routingProfile, capsuleProfile, topPivots) so repeated silent calls
          // do not spam the observation store.
          if (orchestration.context.included) {
            captureVisibleCapsuleObservationBestEffort({
              db,
              repoRoot: binding.repoRoot,
              sourceRunId: getLatestIndexRun(db)?.id ?? null,
              routedQuery: orchestration.context.routedQuery,
              capsuleProfileId: orchestration.context.preparedAssembly.selection.profile.id,
              capsule: orchestration.context.capsule,
              toolName: McpToolId.RunPipeline,
              ...(sessionId === undefined ? {} : { sessionId, sessionAgentKind: "mcp" }),
            });
          }

          let savedObservation: {
            observation: ReturnType<typeof formatObservation>;
            staleness: ReturnType<typeof formatObservationSearchResult>["staleness"];
          } | null = null;

          if (saveObservation === true || observationText !== undefined) {
            const capsule = orchestration.context.capsule;
            const linkedItems = [...capsule.pivots, ...capsule.supportingItems].slice(0, 6);
            const observation = persistObservation(db, {
              repoRoot: binding.repoRoot,
              sessionId,
              sessionAgentKind: "mcp",
              kind: observationText === undefined ? ObservationKind.ToolCall : ObservationKind.Insight,
              source: observationText === undefined ? ObservationSource.McpAuto : ObservationSource.Manual,
              toolName: McpToolId.RunPipeline,
              queryText: orchestration.request.query,
              intent: orchestration.intentDecision.selected,
              summary: observationText ?? `run_pipeline: ${orchestration.request.query}`,
              body: [
                `preset=${orchestration.intentDecision.selected}`,
                `intent_source=${orchestration.intentDecision.source}`,
                `routing_profile=${orchestration.context.routedQuery.profile.id}`,
                `capsule_profile=${orchestration.context.preparedAssembly.selection.profile.id}`,
                `impact_included=${orchestration.impact.included}`,
                `session_included=${orchestration.memory.session.included}`,
                `durable_included=${orchestration.memory.durable.included}`,
                `top_pivots=${capsule.pivots.slice(0, 3).map((item) => item.fqName).join(", ")}`,
              ].join("\n"),
              sourceRunId: getLatestIndexRun(db)?.id,
              linkedFilePaths: linkedItems.map((item) => item.filePath),
              linkedSymbolIds: linkedItems.map((item) => item.symbolId),
              linkedFqNames: linkedItems.map((item) => item.fqName),
            });
            const formattedSearchResult = formatObservationSearchResult({
              observation,
              staleness: getObservationStaleness(db, observation),
              score: 0,
              signals: [],
            });
            savedObservation = {
              observation: formattedSearchResult.observation,
              staleness: formattedSearchResult.staleness,
            };
          }

          const output = formatRunPipelineOrchestrationOutput(orchestration);
          const freshness = await inspectIndexFreshness({
            repoRoot: binding.repoRoot,
            lastIndexSnapshot: binding.state.lastIndexSnapshot,
            observedFileChanges: binding.state.observedFileChanges,
            fileWatcher: binding.state.fileWatcher,
          });
          const nudge = evaluateObservationNudge(db, {
            sessionId,
            currentToolName: McpToolId.RunPipeline,
            ...(preexistingSessionStatus === SessionStatus.Compressed
              ? { preexistingSessionStatus }
              : {}),
          });

          return {
            ok: true,
            output: {
              ...output,
              diagnostics: {
                ...output.diagnostics,
                freshness,
                indexFreshness: formatIndexFreshnessDiagnostic({
                  freshness,
                  latestRunId: getLatestIndexRun(db)?.id ?? null,
                }),
                nudge,
              },
              savedObservation,
            },
          };
        },
      );
    },
  });

type GetCodeContextStaleReason = "stale_index" | "missing_index" | "repo_not_ready";

interface GetCodeContextStaleEnvelope {
  readonly resolved: false;
  readonly reason: GetCodeContextStaleReason;
  readonly message: string;
  readonly nextTool: {
    readonly name: string;
    readonly input: Record<string, unknown>;
  };
  readonly diagnostics: {
    readonly indexFreshness: ReturnType<typeof formatIndexFreshnessDiagnostic>;
  };
}

type GetCodeContextOutput = GetCodeContextStaleEnvelope | RunPipelineMcpOutput;

const STALE_INDEX_MESSAGE =
  "Vtrace index is stale or missing. Call index_repo, then retry get_code_context.";
const MISSING_INDEX_MESSAGE =
  "Vtrace index is missing. Call index_repo, then retry get_code_context.";
const REPO_NOT_READY_MESSAGE =
  "Vtrace repository is not ready. Call index_repo, then retry get_code_context.";

async function handleGetCodeContextRequest({
  context,
  request,
}: McpToolHandlerInput<RunPipelineInput>): Promise<McpToolExecutionResult<GetCodeContextOutput>> {
  const check = await checkIndexForGetCodeContext(context);

  if (check.kind === "stale_response") {
    return { ok: true, output: check.output };
  }

  const result = await RUN_PIPELINE_TOOL_DEFINITION.handler({
    context,
    request: {
      ...request,
      toolId: McpToolId.RunPipeline,
    },
  });

  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    output: {
      ...result.output,
      diagnostics: {
        ...result.output.diagnostics,
        indexFreshness: check.indexFreshness,
      },
    },
  };
}

async function checkIndexForGetCodeContext(
  context: McpServerContext,
): Promise<
  | { kind: "fresh"; indexFreshness: ReturnType<typeof formatIndexFreshnessDiagnostic> }
  | { kind: "stale_response"; output: GetCodeContextStaleEnvelope }
> {
  const resolved = await resolveReadyRepoBinding(context, McpToolId.GetCodeContext);

  if (!resolved.ok) {
    return {
      kind: "stale_response",
      output: buildStaleEnvelope({
        reason: "repo_not_ready",
        message: REPO_NOT_READY_MESSAGE,
        indexFreshness: formatIndexFreshnessDiagnostic({
          status: "unavailable",
          reason: "repo_not_ready",
          action: "call_index_repo",
          beforeState: null,
          afterState: null,
          latestRunId: null,
        }),
      }),
    };
  }

  const beforeFreshness = await inspectIndexFreshness({
    repoRoot: resolved.binding.repoRoot,
    lastIndexSnapshot: resolved.binding.state.lastIndexSnapshot,
    observedFileChanges: resolved.binding.state.observedFileChanges,
    fileWatcher: resolved.binding.state.fileWatcher,
  });
  const db = openIndexerDatabase(resolved.binding.dbPath);
  const indexMissing = !hasIndexedFiles(db);
  db.close();
  const latestRunId = resolved.binding.state.latestRunId ?? null;

  if (!indexMissing && beforeFreshness.state === "fresh") {
    return {
      kind: "fresh",
      indexFreshness: formatIndexFreshnessDiagnostic({
        freshness: beforeFreshness,
        latestRunId,
      }),
    };
  }

  const reason: GetCodeContextStaleReason = indexMissing ? "missing_index" : "stale_index";
  const message = indexMissing ? MISSING_INDEX_MESSAGE : STALE_INDEX_MESSAGE;

  return {
    kind: "stale_response",
    output: buildStaleEnvelope({
      reason,
      message,
      indexFreshness: formatIndexFreshnessDiagnostic({
        status: indexMissing ? "unavailable" : "stale",
        reason,
        action: "call_index_repo",
        beforeState: beforeFreshness.state,
        afterState: beforeFreshness.state,
        latestRunId,
      }),
    }),
  };
}

function buildStaleEnvelope(input: {
  reason: GetCodeContextStaleReason;
  message: string;
  indexFreshness: ReturnType<typeof formatIndexFreshnessDiagnostic>;
}): GetCodeContextStaleEnvelope {
  return {
    resolved: false,
    reason: input.reason,
    message: input.message,
    nextTool: {
      name: McpToolId.IndexRepo,
      input: {},
    },
    diagnostics: {
      indexFreshness: input.indexFreshness,
    },
  };
}

const GET_CODE_CONTEXT_STALE_ENVELOPE_SCHEMA_PROPERTIES = Object.freeze({
  resolved: {
    type: "boolean",
    description: "False when the index was stale, missing, or the repo was not ready. Absent or true when the pipeline ran.",
  },
  reason: {
    type: ["string", "null"],
    description: "stale_index, missing_index, or repo_not_ready when resolved=false; otherwise absent or null.",
  },
  message: {
    type: ["string", "null"],
    description: "Human-readable explanation when resolved=false.",
  },
  nextTool: {
    type: ["object", "null"],
    description: "Suggested next tool to call when resolved=false. Always points at index_repo.",
    properties: {
      name: stringProperty("Next tool id (always index_repo)."),
      input: {
        type: "object",
        description: "Suggested input object for the next tool.",
        properties: {},
        required: [],
        additionalProperties: true,
      },
    },
    required: ["name", "input"],
    additionalProperties: false,
  },
}) satisfies Record<string, McpSchemaProperty>;

const GET_CODE_CONTEXT_OUTPUT_SCHEMA: McpObjectSchema = {
  type: "object",
  description:
    "get_code_context output. Either the full run_pipeline orchestration result, or a fast stale-index envelope that tells the caller to call index_repo and retry.",
  properties: {
    ...RUN_PIPELINE_TOOL_DEFINITION.metadata.outputSchema.properties,
    ...GET_CODE_CONTEXT_STALE_ENVELOPE_SCHEMA_PROPERTIES,
    diagnostics: {
      type: ["object", "null"],
      description:
        "Pipeline diagnostics when resolved; on stale, a minimal diagnostics object carrying indexFreshness.",
      properties: {},
      required: [],
      additionalProperties: true,
    },
  },
  required: [],
  additionalProperties: false,
};

const GET_CODE_CONTEXT_TOOL_DEFINITION = Object.freeze({
  metadata: Object.freeze({
    ...RUN_PIPELINE_TOOL_DEFINITION.metadata,
    toolId: McpToolId.GetCodeContext,
    displayName: "Get Code Context",
    description:
      "Vtrace default first-pass repo-context tool. Use this before manual repo exploration for broad coding, debugging, refactor, and code-understanding tasks. It analyzes the task, routes retrieval, builds compact code context, surfaces relevant memory when available, and returns diagnostics. If the index is stale, missing, or the repo is not ready, get_code_context returns a fast envelope with resolved=false and reason in {stale_index, missing_index, repo_not_ready} and nextTool=index_repo. Call index_repo, then retry get_code_context. For exact known-symbol impact questions, use get_impact_graph directly or after this tool.",
    outputSchema: GET_CODE_CONTEXT_OUTPUT_SCHEMA,
  }),
  handler: handleGetCodeContextRequest,
}) satisfies McpToolDefinition<RunPipelineInput, GetCodeContextOutput>;

// Capsule v2 product item (pivot or support) as the MCP surface reports it.
const CAPSULE_V2_PRODUCT_ITEM_SCHEMA = objectProperty(
  "A Capsule v2 pivot or support item.",
  {
    role: stringProperty("`pivot` or `support`."),
    path: stringProperty("Repo-relative file path."),
    symbol: stringProperty("Local symbol name."),
    fqName: stringProperty("Fully qualified symbol name."),
    kind: stringProperty("Symbol kind."),
    roleReason: stringProperty("Decisive reason this item landed in its role."),
    contentMode: stringProperty("`full`, `signature`, or `skeleton`."),
    source: { type: ["string", "null"], description: "Focused source body — present only in `full` content mode." },
    signature: { type: ["string", "null"], description: "Signature / class line when available." },
    evidence: arrayProperty("Ordered evidence: why this item was selected.", stringProperty("Evidence line.")),
    estimatedTokens: integerProperty("Estimated token cost of the rendered block."),
    isNonSourceExample: booleanProperty("True when the item is a docs/examples/fixture file."),
  },
  [
    "role",
    "path",
    "symbol",
    "fqName",
    "kind",
    "roleReason",
    "contentMode",
    "source",
    "signature",
    "evidence",
    "estimatedTokens",
    "isNonSourceExample",
  ],
);

// The Capsule v2 product response surfaced under `capsuleV2` when a caller opts
// into the v2 engine. Bounded and deterministic (see productAdapter.ts).
const CAPSULE_V2_PRODUCT_RESPONSE_SCHEMA = objectProperty(
  "Capsule v2 product response (experimental, opt-in). Present only when capsule_engine=v2.",
  {
    engine: stringProperty("Always `v2` here."),
    experimental: booleanProperty("Capsule v2 is opt-in/experimental on the product surface."),
    intent: stringProperty("The resolved intent the capsule was built for."),
    actualMode: stringProperty("Realised sizing tier, or `no_context` when no pivot was found."),
    reason: { type: ["string", "null"], description: "Human-readable reason — present only on the no_context path." },
    budget: objectProperty(
      "Token-budget accounting.",
      {
        maxTokens: integerProperty("Requested token budget."),
        estimatedTokens: integerProperty("Estimated tokens used by the assembled capsule."),
        usedPercent: numberProperty("Percent of the budget used."),
      },
      ["maxTokens", "estimatedTokens", "usedPercent"],
    ),
    pivots: arrayProperty("Pivot items (focused edit targets).", CAPSULE_V2_PRODUCT_ITEM_SCHEMA),
    support: arrayProperty("Support items (compact context).", CAPSULE_V2_PRODUCT_ITEM_SCHEMA),
    discarded: arrayProperty(
      "Bounded near-miss list (see discardedTotal for the true count).",
      objectProperty(
        "A candidate that did not make the capsule.",
        {
          path: stringProperty("Repo-relative file path."),
          symbol: stringProperty("Local symbol name."),
          kind: stringProperty("Symbol kind."),
          discardReason: stringProperty("Why this candidate was dropped."),
        },
        ["path", "symbol", "kind", "discardReason"],
      ),
    ),
    discardedTotal: integerProperty("Total discarded candidates the engine produced (before the product cap)."),
    diagnostics: objectProperty(
      "Bounded diagnostics summary — the auditable why without the full internals.",
      {
        intentReason: arrayProperty("Ordered signals behind the intent decision.", stringProperty("Reason line.")),
        intentConfidence: stringProperty("Planner confidence: high/medium/low."),
        rolePolicy: stringProperty("The role-assignment policy the strategy selected."),
        candidateCount: integerProperty("Candidates the role gate ran over."),
        pivotCount: integerProperty("Pivot count."),
        supportCount: integerProperty("Support count."),
        discardedCount: integerProperty("Discarded count."),
        tier: stringProperty("Allocator tier (micro/standard/full/no_context)."),
        likelyFiles: arrayProperty("Shaped likely files.", stringProperty("Repo-relative file path.")),
        likelySymbols: arrayProperty("Shaped likely symbols.", stringProperty("Symbol name.")),
        failingTests: arrayProperty("Shaped failing tests.", stringProperty("Test id.")),
        editRiskDirectives: arrayProperty(
          "Deterministic patch-planning hints derived from the selected pivots.",
          objectProperty(
            "An edit-risk / patch-planning hint.",
            {
              kind: stringProperty("Edit-risk kind."),
              confidence: stringProperty("high/medium/low."),
              directive: stringProperty("The human-readable hint."),
            },
            ["kind", "confidence", "directive"],
          ),
        ),
      },
      [
        "intentReason",
        "intentConfidence",
        "rolePolicy",
        "candidateCount",
        "pivotCount",
        "supportCount",
        "discardedCount",
        "tier",
        "likelyFiles",
        "likelySymbols",
        "failingTests",
        "editRiskDirectives",
      ],
    ),
  },
  [
    "engine",
    "experimental",
    "intent",
    "actualMode",
    "reason",
    "budget",
    "pivots",
    "support",
    "discarded",
    "discardedTotal",
    "diagnostics",
  ],
);

// The opt-in Capsule v2 envelope `get_context_capsule` returns instead of the v1
// shape when `capsule_engine=v2`. Self-contained: it carries the persisted
// manifest id (consistent with the v1 path) and the full v2 product response.
interface CapsuleV2ToolOutput {
  query: string;
  intent: string;
  engine: typeof CAPSULE_ENGINE_V2;
  capsuleManifestId: string | null;
  capsuleV2: CapsuleV2ProductResponse;
}

const RESERVED_MCP_TOOL_DEFINITIONS_UNFROZEN = [
  GET_CODE_CONTEXT_TOOL_DEFINITION,
  RUN_PIPELINE_TOOL_DEFINITION,
  createEngineDelegateToolDefinition<BuildCapsuleInput, ReturnType<typeof formatContextCapsulePipelineOutput> | CapsuleV2ToolOutput>({
    metadata: {
      toolId: McpToolId.GetContextCapsule,
      displayName: "Get Context Capsule",
      description: "Build a context capsule using the existing routing and capsule pipeline.",
      inputSchema: objectSchema(
        "Context-capsule build request.",
        {
          query: stringProperty("User query text."),
          maxResults: integerProperty("Optional reranked candidate count."),
          maxBudgetCharacters: integerProperty("Optional capsule character budget."),
          repos: arrayProperty("Optional workspace repo aliases to query. Defaults to all enabled repos when a workspace config is present.", stringProperty("Repo alias.")),
          capsule_engine: stringProperty("Optional capsule engine. Set to `v2` to use the experimental, opt-in Capsule v2 engine (bounded, intent-aware, evidence-scored). Omit (or any other value) keeps the default v1 pipeline. Single-repo only."),
          capsuleEngine: stringProperty("Alias of `capsule_engine` (camelCase)."),
          capsule_intent: stringProperty("Optional Capsule v2 intent: auto|debug|refactor|modify|explain|impact|test-failure. Only used when capsule_engine=v2. Defaults to auto."),
          capsule_budget_tokens: integerProperty("Optional Capsule v2 token budget. Only used when capsule_engine=v2. Defaults to 8000."),
        },
        ["query"],
      ),
      outputSchema: objectSchema(
        "Context capsule output.",
        {
          workspace: {
            type: ["object", "null"],
            description: "Workspace metadata when a multi-repo workspace config is active.",
            properties: {
              name: {
                type: ["string", "null"],
                description: "Workspace name when configured.",
              },
              primaryRepoAlias: stringProperty("Primary repo alias."),
              selectedRepos: arrayProperty("Selected repo aliases.", stringProperty("Repo alias.")),
              configuredRepos: arrayProperty("All configured repo aliases.", stringProperty("Repo alias.")),
            },
            required: ["name", "primaryRepoAlias", "selectedRepos", "configuredRepos"],
            additionalProperties: false,
          },
          retrieval: objectProperty(
            "Multi-repo retrieval diagnostics when a workspace is active.",
            {
              selectedRepos: arrayProperty("Selected repo aliases.", stringProperty("Repo alias.")),
              perRepo: arrayProperty("Per-repo retrieval summaries.", MULTI_REPO_RETRIEVAL_SUMMARY_SCHEMA),
              mergeSummary: MULTI_REPO_MERGE_SUMMARY_SCHEMA,
            },
            ["selectedRepos", "perRepo", "mergeSummary"],
          ),
          query: stringProperty("Original query text."),
          intent: stringProperty("Selected intent."),
          engine: stringProperty("Capsule engine for this response. `v2` only when the caller opted into Capsule v2; absent on the default v1 path."),
          classification: CLASSIFICATION_SCHEMA,
          routingProfile: ROUTING_PROFILE_SCHEMA,
          capsuleProfile: CAPSULE_PROFILE_SCHEMA,
          capsuleManifestId: {
            type: ["string", "null"],
            description: "Persisted capsule manifest id for this capsule. Pass to check_capsule_staleness or `vtrace check-capsule` to evaluate freshness against a later run. Null for multi-repo capsules or when the repo has no index run yet.",
          },
          capsuleV2: CAPSULE_V2_PRODUCT_RESPONSE_SCHEMA,
          capsule: objectProperty(
            "Capsule output.",
            {
              query: stringProperty("Original query text."),
              pivots: arrayProperty("Pivot capsule items.", CAPSULE_ITEM_SCHEMA),
              supportingItems: arrayProperty("Supporting capsule items.", CAPSULE_ITEM_SCHEMA),
              memories: arrayProperty("Optional surfaced memories.", CAPSULE_MEMORY_ITEM_SCHEMA),
              rules: CAPSULE_RULE_SECTION_SCHEMA,
              budget: CAPSULE_BUDGET_SCHEMA,
              truncated: booleanProperty("Whether the capsule was truncated."),
              compressed: booleanProperty("Whether any capsule item was compressed."),
              profileBudgetUsage: {
                type: ["object", "null"],
                description: "Profile-specific budget usage when available.",
                properties: {
                  ...(CAPSULE_PROFILE_BUDGET_USAGE_SCHEMA.properties ?? {}),
                },
                required: CAPSULE_PROFILE_BUDGET_USAGE_SCHEMA.required ?? [],
                additionalProperties: false,
              },
            },
            [
              "query",
              "pivots",
              "supportingItems",
              "budget",
              "truncated",
              "compressed",
              "profileBudgetUsage",
            ],
          ),
        },
        // `query` + `intent` are emitted by both the v1 and the opt-in v2 paths;
        // the v1-only sections (classification/routingProfile/capsuleProfile/
        // capsule) and the v2-only sections (engine/capsuleV2) are each optional so
        // one schema describes both shapes. The default v1 response is unchanged.
        ["query", "intent"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.GetContextCapsule, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const query = parseRequiredQuery(McpToolId.GetContextCapsule, input);
      const maxResults = parseOptionalInteger(McpToolId.GetContextCapsule, input, "maxResults");
      const maxBudgetCharacters = parseOptionalInteger(
        McpToolId.GetContextCapsule,
        input,
        "maxBudgetCharacters",
      );
      const repos = parseOptionalStringArrayField(McpToolId.GetContextCapsule, input, "repos");

      if (typeof query !== "string") {
        return query;
      }
      if (maxResults !== undefined && typeof maxResults !== "number") {
        return maxResults;
      }
      if (maxBudgetCharacters !== undefined && typeof maxBudgetCharacters !== "number") {
        return maxBudgetCharacters;
      }
      if (repos !== undefined && !Array.isArray(repos)) {
        return repos;
      }

      // Capsule v2 opt-in. The default (no `capsule_engine`) path stays on v1 and
      // is byte-identical to before. Accept both `capsule_engine` and its
      // camelCase alias `capsuleEngine`.
      const engineSnake = parseOptionalStringField(McpToolId.GetContextCapsule, input, "capsule_engine");
      if (engineSnake !== undefined && typeof engineSnake !== "string") {
        return engineSnake;
      }
      const engineCamel = parseOptionalStringField(McpToolId.GetContextCapsule, input, "capsuleEngine");
      if (engineCamel !== undefined && typeof engineCamel !== "string") {
        return engineCamel;
      }
      const useCapsuleV2 = (engineSnake ?? engineCamel)?.toLowerCase() === CAPSULE_ENGINE_V2;

      const capsuleIntentRaw = parseOptionalStringField(McpToolId.GetContextCapsule, input, "capsule_intent");
      if (capsuleIntentRaw !== undefined && typeof capsuleIntentRaw !== "string") {
        return capsuleIntentRaw;
      }
      const capsuleBudgetTokens = parseOptionalInteger(McpToolId.GetContextCapsule, input, "capsule_budget_tokens");
      if (capsuleBudgetTokens !== undefined && typeof capsuleBudgetTokens !== "number") {
        return capsuleBudgetTokens;
      }

      let capsuleV2Intent = CapsuleIntent.Auto;
      if (useCapsuleV2 && capsuleIntentRaw !== undefined) {
        const parsedIntent = parseCapsuleIntent(capsuleIntentRaw);
        if (parsedIntent === undefined) {
          return invalidRequest(
            McpToolId.GetContextCapsule,
            "MCP tool get_context_capsule requires capsule_intent to be one of auto|debug|refactor|modify|explain|impact|test-failure.",
            { capsule_intent: capsuleIntentRaw },
          );
        }
        capsuleV2Intent = parsedIntent;
      }
      if (useCapsuleV2 && capsuleBudgetTokens !== undefined && capsuleBudgetTokens <= 0) {
        return invalidRequest(
          McpToolId.GetContextCapsule,
          "MCP tool get_context_capsule requires capsule_budget_tokens to be a positive integer.",
          { capsule_budget_tokens: capsuleBudgetTokens },
        );
      }

      const selection = await resolveWorkspaceRepoSelection(context, McpToolId.GetContextCapsule, repos);

      if (!selection.ok) {
        return selection.result;
      }

      // Capsule v2 is single-repo only in this milestone; a multi-repo workspace
      // request with the v2 opt-in is rejected rather than silently downgraded.
      if (useCapsuleV2 && hasMultiRepoRequest(selection.selection, repos)) {
        return invalidRequest(
          McpToolId.GetContextCapsule,
          "MCP tool get_context_capsule capsule_engine=v2 is single-repo only; omit repos or select exactly one.",
          {},
        );
      }

      if (hasMultiRepoRequest(selection.selection, repos)) {
        const multi = await runMultiRepoContextCapsulePipeline(selection.selection, {
          query,
          maxResults,
          maxBudgetCharacters,
        });

        return multi.ok
          ? { ok: true, output: multi.output }
          : multi.result;
      }

      return withReadyRepoDb(
        context,
        McpToolId.GetContextCapsule,
        async (binding, db) => {
          const sourceRunId = getLatestIndexRun(db)?.id ?? null;

          // Opt-in Capsule v2 path: build the bounded, intent-aware v2 capsule,
          // project it to the stable product response, and persist a manifest the
          // same way the v1 path does (so check_capsule_staleness still resolves).
          // Auto-capture is intentionally deferred for v2 — the observation capture
          // is keyed on the v1 capsule structure; see docs/mcp_tools.md.
          if (useCapsuleV2) {
            const result = buildCapsuleV2({
              db,
              repoRoot: binding.repoRoot,
              task: query,
              intent: capsuleV2Intent,
              maxTokens: capsuleBudgetTokens ?? CAPSULE_V2_PRODUCT_DEFAULT_BUDGET_TOKENS,
            });
            const capsuleV2 = toCapsuleV2ProductResponse(result);
            const capsuleManifestId = persistCapsuleV2ManifestBestEffort(
              db,
              query,
              capsuleV2ToManifestItemFields(result),
              sourceRunId,
            );
            const output: CapsuleV2ToolOutput = {
              query,
              intent: capsuleV2.intent,
              engine: CAPSULE_ENGINE_V2,
              capsuleManifestId,
              capsuleV2,
            };
            return { ok: true, output };
          }

          const pipeline = runIntentAwareCapsulePipeline(db, binding.repoRoot, {
            query,
            maxResults,
            maxBudgetCharacters,
          });
          // Auto-capture is a best-effort post-success side effect for every
          // visible capsule-building tool. Dedupe key is shared across tools so
          // repeated calls with the same inputs collapse to a single
          // observation regardless of which visible tool was used.
          if (pipeline.capsule.pivots.length + pipeline.capsule.supportingItems.length > 0) {
            captureVisibleCapsuleObservationBestEffort({
              db,
              repoRoot: binding.repoRoot,
              sourceRunId,
              routedQuery: pipeline.routedQuery,
              capsuleProfileId: pipeline.preparedAssembly.selection.profile.id,
              capsule: pipeline.capsule,
              toolName: McpToolId.GetContextCapsule,
            });
          }
          // Persist a deterministic capsule manifest so a follow-up
          // check_capsule_staleness / `vtrace check-capsule` call on the
          // returned id resolves against a real store instead of "not found".
          const capsuleManifestId = persistCapsuleManifestBestEffort(
            db,
            pipeline.capsule,
            sourceRunId,
          );
          return {
            ok: true,
            output: formatContextCapsulePipelineOutput(pipeline, capsuleManifestId),
          };
        },
      );
    },
  }),
  createEngineDelegateToolDefinition<GetImpactGraphInput, ImpactGraphOutput>({
    metadata: {
      toolId: McpToolId.GetImpactGraph,
      displayName: "Get Impact Graph",
      description: "Return a bounded structural reverse-impact view for one exact indexed symbol FQN.",
      inputSchema: objectSchema(
        "Bounded structural impact-graph request.",
        {
          symbol_fqn: stringProperty("Exact fully qualified symbol name to resolve."),
          depth: integerProperty("Optional bounded traversal depth. Defaults to 5."),
          cross_repo: booleanProperty("Optional cross-repo traversal flag. The current repo-bound implementation only supports false."),
          format: stringProperty(`Optional output format: ${IMPACT_FORMATS.join(", ")}.`),
        },
        ["symbol_fqn"],
      ),
      outputSchema: objectSchema(
        "Bounded structural reverse-impact graph output.",
        {
          requested: IMPACT_REQUEST_SCHEMA,
          resolvedSymbol: SYMBOL_RESULT_SCHEMA,
          coverage: IMPACT_COVERAGE_SCHEMA,
          summary: IMPACT_SUMMARY_SCHEMA,
          dependentFiles: arrayProperty(
            "Deterministically ordered dependent file paths excluding the root symbol file unless reached by a dependent.",
            stringProperty("Repo-relative file path."),
          ),
          nodes: arrayProperty("Discovered impact nodes including the resolved root node.", IMPACT_NODE_SCHEMA),
          edges: arrayProperty("Shortest-layer outward impact edges retained from indexed structural data.", IMPACT_EDGE_SCHEMA),
          view: IMPACT_VIEW_SCHEMA,
        },
        ["requested", "resolvedSymbol", "coverage", "summary", "dependentFiles", "nodes", "edges", "view"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.GetImpactGraph, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const symbolFqn = parseRequiredStringField(McpToolId.GetImpactGraph, input, "symbol_fqn");
      const depth = parseOptionalInteger(McpToolId.GetImpactGraph, input, "depth");
      const crossRepo = parseOptionalBoolean(McpToolId.GetImpactGraph, input, "cross_repo");
      const format = parseOptionalStringField(McpToolId.GetImpactGraph, input, "format");

      if (typeof symbolFqn !== "string") {
        return symbolFqn;
      }
      if (depth !== undefined && typeof depth !== "number") {
        return depth;
      }
      if (crossRepo !== undefined && typeof crossRepo !== "boolean") {
        return crossRepo;
      }
      if (format !== undefined && typeof format !== "string") {
        return format;
      }

      if (crossRepo === true) {
        return invalidRequest(
          McpToolId.GetImpactGraph,
          "MCP tool get_impact_graph does not support cross_repo=true in the current repo-bound index.",
          { cross_repo: true },
        );
      }

      const resolvedFormat = format ?? "tree";

      if (!IMPACT_FORMATS.includes(resolvedFormat as ImpactFormat)) {
        return invalidRequest(
          McpToolId.GetImpactGraph,
          `MCP tool get_impact_graph requires format to be one of: ${IMPACT_FORMATS.join(", ")}.`,
          { format: resolvedFormat },
        );
      }

      return withReadyRepoDb(
        context,
        McpToolId.GetImpactGraph,
        async (binding, db) => {
          const result = getImpactGraph(db, {
            symbolFqn,
            depth: depth ?? 5,
            format: resolvedFormat as ImpactFormat,
          });

          if (!result.ok) {
            return invalidRequest(McpToolId.GetImpactGraph, result.error.message, result.error.details);
          }

          captureImpactGraphObservationBestEffort({
            db,
            repoRoot: binding.repoRoot,
            sourceRunId: getLatestIndexRun(db)?.id ?? null,
            output: result.output,
            toolName: McpToolId.GetImpactGraph,
          });

          return {
            ok: true,
            output: result.output,
          };
        },
      );
    },
  }),
  createEngineDelegateToolDefinition<SearchLogicFlowInput, LogicFlowOutput>({
    metadata: {
      toolId: McpToolId.SearchLogicFlow,
      displayName: "Search Logic Flow",
      description: "Return bounded directed paths between two exact indexed symbol FQNs over indexed contains, imports, and statically resolved calls edges. Static structural evidence only — calls edges are conservative (Python, TypeScript, and Cython in this milestone) and this is not runtime execution flow; coverage reports whether call-flow evidence was available.",
      inputSchema: objectSchema(
        "Logic-flow request.",
        {
          start: stringProperty("Exact fully qualified start symbol name to resolve."),
          end: stringProperty("Exact fully qualified end symbol name to resolve."),
          max_paths: integerProperty("Optional maximum number of shortest structural paths to return. Defaults to 3."),
          cross_repo: booleanProperty("Optional cross-repo traversal flag. The current repo-bound implementation only supports false."),
        },
        ["start", "end"],
      ),
      outputSchema: objectSchema(
        "Bounded directed structural logic-flow output.",
        {
          requested: LOGIC_FLOW_REQUEST_SCHEMA,
          resolvedStart: SYMBOL_RESULT_SCHEMA,
          resolvedEnd: SYMBOL_RESULT_SCHEMA,
          coverage: LOGIC_FLOW_COVERAGE_SCHEMA,
          summary: LOGIC_FLOW_SUMMARY_SCHEMA,
          paths: arrayProperty("Deterministically ordered returned shortest structural paths.", LOGIC_FLOW_PATH_SCHEMA),
        },
        ["requested", "resolvedStart", "resolvedEnd", "coverage", "summary", "paths"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.SearchLogicFlow, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const start = parseRequiredStringField(McpToolId.SearchLogicFlow, input, "start");
      const end = parseRequiredStringField(McpToolId.SearchLogicFlow, input, "end");
      const maxPaths = parseOptionalInteger(McpToolId.SearchLogicFlow, input, "max_paths");
      const crossRepo = parseOptionalBoolean(McpToolId.SearchLogicFlow, input, "cross_repo");

      if (typeof start !== "string") {
        return start;
      }
      if (typeof end !== "string") {
        return end;
      }
      if (maxPaths !== undefined && typeof maxPaths !== "number") {
        return maxPaths;
      }
      if (crossRepo !== undefined && typeof crossRepo !== "boolean") {
        return crossRepo;
      }

      if ((maxPaths ?? 3) <= 0) {
        return invalidRequest(
          McpToolId.SearchLogicFlow,
          "MCP tool search_logic_flow requires max_paths to be a positive integer when provided.",
          { field: "max_paths", value: maxPaths },
        );
      }

      if (crossRepo === true) {
        return invalidRequest(
          McpToolId.SearchLogicFlow,
          "MCP tool search_logic_flow does not support cross_repo=true in the current repo-bound index.",
          { cross_repo: true },
        );
      }

      return withReadyRepoDb(
        context,
        McpToolId.SearchLogicFlow,
        async (binding, db) => {
          const result = searchLogicFlow(db, {
            start,
            end,
            maxPaths: maxPaths ?? 3,
          });

          if (!result.ok) {
            return invalidRequest(McpToolId.SearchLogicFlow, result.error.message, result.error.details);
          }

          captureLogicFlowObservationBestEffort({
            db,
            repoRoot: binding.repoRoot,
            sourceRunId: getLatestIndexRun(db)?.id ?? null,
            output: result.output,
            toolName: McpToolId.SearchLogicFlow,
          });

          return {
            ok: true,
            output: result.output,
          };
        },
      );
    },
  }),
  createEngineDelegateToolDefinition<GetSkeletonInput, Awaited<ReturnType<typeof getSkeleton>>>({
    metadata: {
      toolId: McpToolId.GetSkeleton,
      displayName: "Get Skeleton",
      description: "Return token-efficient structural skeletons for one or more indexed files.",
      inputSchema: objectSchema(
        "Skeleton request.",
        {
          files: arrayProperty(
            "Repo-relative file paths to skeletonize in requested order.",
            stringProperty("Repo-relative file path."),
          ),
          detail: stringProperty("Optional skeleton detail level: minimal, standard, or detailed."),
        },
        ["files"],
      ),
      outputSchema: objectSchema(
        "Deterministic structural file skeletons.",
        {
          detail: GET_SKELETON_OUTPUT_SCHEMA.properties.detail!,
          files: GET_SKELETON_OUTPUT_SCHEMA.properties.files!,
        },
        GET_SKELETON_OUTPUT_SCHEMA.required ?? [],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.GetSkeleton, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const files = parseRequiredStringArrayField(McpToolId.GetSkeleton, input, "files");
      const detail = parseOptionalSkeletonDetail(McpToolId.GetSkeleton, input);

      if (!Array.isArray(files)) {
        return files;
      }
      if (detail !== undefined && typeof detail !== "string") {
        return detail;
      }

      return withReadyRepoDb(
        context,
        McpToolId.GetSkeleton,
        async (binding, db) => {
          const output = await getSkeleton(db, {
            repoRoot: binding.repoRoot,
            files,
            detail: detail ?? "standard",
          });

          captureSkeletonObservationBestEffort({
            db,
            repoRoot: binding.repoRoot,
            sourceRunId: getLatestIndexRun(db)?.id ?? null,
            output,
            toolName: McpToolId.GetSkeleton,
            requestedFiles: files,
          });

          return {
            ok: true,
            output,
          };
        },
      );
    },
  }),
  createEngineDelegateToolDefinition<IndexStatusInput, unknown>({
    metadata: {
      toolId: McpToolId.IndexStatus,
      displayName: "Index Status",
      description: "Inspect repo-local init and index readiness without mutating state.",
      inputSchema: objectSchema(
        "Index-status request.",
        {
          repos: arrayProperty("Optional workspace repo aliases to inspect. Defaults to all enabled repos when a workspace config is present.", stringProperty("Repo alias.")),
        },
        [],
      ),
      outputSchema: INDEX_STATUS_SCHEMA,
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.IndexStatus, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const repos = parseOptionalStringArrayField(McpToolId.IndexStatus, input, "repos");

      if (repos !== undefined && !Array.isArray(repos)) {
        return repos;
      }

      const selection = await resolveWorkspaceRepoSelection(context, McpToolId.IndexStatus, repos, {
        includeDisabledByDefault: true,
        allowDisabledSelection: true,
      });

      if (!selection.ok) {
        return selection.result;
      }

      if (hasMultiRepoRequest(selection.selection, repos)) {
        return {
          ok: true,
          output: {
            workspace: formatWorkspaceMetadata(selection.selection),
            repos: selection.selection.statuses.map(formatWorkspaceRepoStatus),
          },
        };
      }

      try {
        return {
          ok: true,
          output: await inspectIndexStatus(context),
        };
      } catch (error) {
        return repoNotReady(
          McpToolId.IndexStatus,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  }),
  createEngineDelegateToolDefinition<WorkspaceSetupInput, {
    mode: "inspect" | "apply";
    status: {
      repoRoot: string;
      initialized: boolean;
      indexPresent: boolean;
      latestRunId: number | null;
      readiness: RepoLocalState["readiness"] | null;
      claudeCode: {
        configPath: string;
        installed: boolean;
        matchesExpected: boolean;
        launcher: {
          command: string;
          args: string[];
        };
        error: string | null;
      };
      runtime: {
        running: boolean;
        status: string;
        statePath: string;
        logPath: string;
        launcher: {
          command: string;
          args: string[];
        };
        staleStatePresent: boolean;
      };
      workspace?: Awaited<ReturnType<typeof inspectWorkspaceSetupStatus>>;
      nextSteps: string[];
    };
    initAction: string | null;
    claudeCodeAction: string | null;
    runtimeAction: string | null;
  }>({
    metadata: {
      toolId: McpToolId.WorkspaceSetup,
      displayName: "Workspace Setup",
      description: "Inspect or apply the repo setup shell without redesigning engine internals.",
      inputSchema: objectSchema(
        "Workspace setup request.",
        {
          apply: booleanProperty("When true, run the setup flow; otherwise return status only."),
          startRuntime: booleanProperty("When apply=true, optionally start the local runtime daemon."),
        },
        [],
      ),
      outputSchema: WORKSPACE_SETUP_OUTPUT_SCHEMA,
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.WorkspaceSetup, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const apply = parseOptionalBoolean(McpToolId.WorkspaceSetup, input, "apply");
      const startRuntime = parseOptionalBoolean(McpToolId.WorkspaceSetup, input, "startRuntime");

      if (apply !== undefined && typeof apply !== "boolean") {
        return apply;
      }
      if (startRuntime !== undefined && typeof startRuntime !== "boolean") {
        return startRuntime;
      }
      if (context.repoRoot === null) {
        return repoNotReady(
          McpToolId.WorkspaceSetup,
          `MCP tool ${McpToolId.WorkspaceSetup} requires a repo-bound server context.`,
        );
      }
      if (apply !== true && startRuntime === true) {
        return invalidRequest(
          McpToolId.WorkspaceSetup,
          "workspace_setup only accepts startRuntime when apply=true.",
          { field: "startRuntime" },
        );
      }

      const { inspectProductShellStatus } = await import("../runtime/status");
      const shellStatus = apply === true
        ? undefined
        : await inspectProductShellStatus({ repoPath: context.repoRoot });
      const setupResult = apply === true
        ? await (await import("../runtime/setupFlow")).runSetupFlow({
          repoPath: context.repoRoot,
          startRuntime,
        })
        : undefined;
      const effectiveStatus = shellStatus ?? await inspectProductShellStatus({
        repoPath: context.repoRoot,
      });
      const workspace = await inspectWorkspaceSetupStatus(context.repoRoot);

      return {
        ok: true,
        output: {
          mode: apply === true ? "apply" : "inspect",
          status: {
            repoRoot: effectiveStatus.repoRoot,
            initialized: effectiveStatus.repoLocal.initialized,
            indexPresent: effectiveStatus.indexPresent,
            latestRunId: effectiveStatus.latestRunId,
            readiness: effectiveStatus.readiness,
            claudeCode: {
              configPath: effectiveStatus.agentConfig.configPath,
              installed: effectiveStatus.agentConfig.installed,
              matchesExpected: effectiveStatus.agentConfig.matchesExpected,
              launcher: structuredClone(effectiveStatus.agentConfig.launcher),
              error: effectiveStatus.agentConfig.error ?? null,
            },
            runtime: {
              running: effectiveStatus.runtime.running,
              status: effectiveStatus.runtime.status,
              statePath: effectiveStatus.runtime.statePath,
              logPath: effectiveStatus.runtime.logPath,
              launcher: structuredClone(effectiveStatus.runtime.launcher),
              staleStatePresent: effectiveStatus.runtime.staleStatePresent,
            },
            ...(workspace === undefined ? {} : { workspace }),
            nextSteps: [...effectiveStatus.nextSteps],
          },
          initAction: setupResult?.initAction ?? null,
          claudeCodeAction: setupResult?.agentConfig.action ?? null,
          runtimeAction: setupResult?.runtime.action ?? null,
        },
      };
    },
  }),
  getRequiredToolDefinition(LEGACY_MCP_TOOL_DEFINITIONS_UNFROZEN, McpToolId.GetSessionContext),
  getRequiredToolDefinition(LEGACY_MCP_TOOL_DEFINITIONS_UNFROZEN, McpToolId.SearchMemory),
  getRequiredToolDefinition(LEGACY_MCP_TOOL_DEFINITIONS_UNFROZEN, McpToolId.SaveObservation),
  createExpandVexpRefToolDefinition(),
] satisfies McpToolDefinition[];

export const LEGACY_MCP_TOOL_DEFINITIONS = Object.freeze(
  LEGACY_MCP_TOOL_DEFINITIONS_UNFROZEN,
);

export const RESERVED_MCP_TOOL_DEFINITIONS = Object.freeze(
  RESERVED_MCP_TOOL_DEFINITIONS_UNFROZEN,
);

export const RESERVED_MCP_TOOL_METADATA = Object.freeze(
  RESERVED_MCP_TOOL_DEFINITIONS.map((tool) => tool.metadata),
);

export const defaultMcpToolRegistry = createMcpToolRegistry({
  tools: RESERVED_MCP_TOOL_DEFINITIONS,
  hiddenTools: LEGACY_MCP_TOOL_DEFINITIONS.filter((tool) => (
    tool.metadata.toolId !== McpToolId.SaveObservation
    && tool.metadata.toolId !== McpToolId.SearchMemory
    && tool.metadata.toolId !== McpToolId.GetSessionContext
  )),
});
