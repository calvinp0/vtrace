// @ts-nocheck
import { access } from "node:fs/promises";
import path from "node:path";

import { Database } from "bun:sqlite";

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
import {
  buildAuthoritativeProductRetrieval,
  capsuleIntentForPreset,
} from "../capsuleV2/authoritativeProductRetrieval";
import {
  capsuleV2ToManifestItemFields,
  toCapsuleV2ProductResponse,
  type CapsuleV2ProductResponse,
} from "../capsuleV2/productAdapter";
import { CapsuleIntent, parseCapsuleIntent } from "../capsuleV2/types";
import {
  CapsuleEngineCompatibilityError,
  resolveCapsuleCompatibility,
} from "../capsuleV2/engineSelection";
import { getRuntimeProvenance } from "../runtime/provenance";
import { buildInspectFirst, type InspectFirst } from "../runPipeline/inspectFirst";
import { projectRunPipelineOrientation } from "../runPipeline/orientationProjection";
import { projectOrientationDecline } from "../runPipeline/orientationDecline";
import {
  buildContextAccounting,
  impactGraphOutputFilePathGroups,
  logicFlowOutputFilePathGroups,
  runPipelineOutputFilePathGroups,
  skeletonOutputFilePathGroups,
  type ContextAccounting,
} from "../metrics/contextAccounting";
import {
  getCapsuleManifestById,
  getCapsuleStaleness,
  persistCapsuleManifestBestEffort,
  persistCapsuleV2ManifestBestEffort,
} from "../session/repositories/capsuleManifestsRepository";
import { hasIndexedFiles } from "../db/repositories/filesRepository";
import {
  getIndexRunById,
  getIndexRunSummary,
  getLatestIndexRun,
  listIndexRuns,
} from "../db/repositories/indexRunsRepository";
import { persistObservation } from "../session/repositories/observationsRepository";
import { getSessionById } from "../session/repositories/sessionsRepository";
import { listLegacySessionTables } from "../session/legacyMigration";
import { ProductStoreLease, SessionStore } from "../session/sessionStore";
import { openProductIndexDatabase } from "../db/sqlite";
import {
  inspectIndexAccessCapability,
  type IndexAccessCapabilityState,
} from "../access/indexAccessLifecycle";
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
import {
  compactImpactProductResponse,
  type ImpactProductResponse,
} from "../impact/impactResponseEnvelope";
import { STATIC_RELATION_KINDS, type StaticRelationKind } from "../impact/staticEvidence";
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
  RunPipelineFlowSkipReason,
  RunPipelineImpactSkipReason,
  RunPipelineIntentSource,
  RunPipelinePresetIntent,
  RunPipelineSessionSkipReason,
  type RunPipelineConcretePreset,
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
  compactProductResponse,
  agentFacingIndexFreshness,
  isMcpResponseDetail,
  McpResponseDetail,
  remeasureResponseBudget,
  type ResponseBudgetAccounting,
} from "./responseEnvelope";
import {
  DEFAULT_TRAVERSAL_EDGE_BUDGET,
  MAX_TRAVERSAL_EDGE_BUDGET,
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
} from "../observations/autoCapture";
import { searchMemory, searchMemoryDetailed } from "../observations/searchMemory";
import { buildObservationProvenance, resolveCurrentObservationContext } from "../observations/provenance";
import { getObservationStaleness } from "../observations/staleness";
import { classifyObservationCompatibility } from "../observations/compatibility";
import {
  ObservationKind,
  ObservationOrigin,
  ObservationScope,
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
  detectRepoRoot,
  readRepoLocalConfig,
  readRepoLocalState,
  resolveRepoLocalPaths,
} from "../setup/repoState";
import { initRepo } from "../setup/initRepo";
import {
  ensureGeneratedStateExcluded,
  type GeneratedStateExclusionResult,
} from "../setup/generatedStateExclusion";
import type { RepoLocalConfig, RepoLocalState } from "../setup/types";
import { buildFileWatcherStatus } from "../runtime/fileWatcher";
import { inspectIndexFreshness } from "../runtime/indexFreshness";
import { reindexRepoAndRefreshState } from "../runtime/reindexRepo";
import {
  readIndexMeta,
  resolveIndexDbPath,
  type WorktreeIndexFreshnessResult,
} from "../indexer/indexMeta";
import {
  summarizeIndexOutcomes,
  type BoundedIndexOutcomes,
} from "../indexer/indexOutcomeSummary";
import {
  evaluateIndexReadiness,
  inspectWorktreeIndexFreshness,
  summarizeIndexReadiness,
  withRuntimeSignals,
  type IndexReadiness,
  type IndexReadinessSummary,
} from "../indexer/indexReadiness";
import { WorktreeIndexLockError } from "../indexer/worktreeIndexLock";
import {
  detectIndexWorktreeMismatch,
  resolveWorktreeRouting,
  routingSourceFor,
} from "./worktreeRouting";
import { IndexingFileFailuresError, type IndexProjectResult } from "../indexer/types";
import {
  assembleProductContext,
  buildUnresolvedProductContext,
} from "../productContext/assembleProductContext";
import type { ProductContextResponse } from "../productContext/types";
import {
  resolveWorkspaceConfigPath,
  safeReadWorkspaceConfig,
  type ResolvedWorkspaceConfig,
  type ResolvedWorkspaceRepoConfig,
} from "../workspace/config";
import { compareRecordedIdentity, RegistrationStatus } from "../workspace/registry";
import {
  ProductRouteOutcome,
  resolveProductRoute,
  type ProductRoute,
  type ProductRoutingMetadata,
} from "../workspace/productRoute";
import { MAX_REPORTED_COVERAGE_EXAMPLES } from "../workspace/evidenceClaims";
import { mergeRepositoryContributions } from "../workspace/workspaceProductContext";
import { createMcpToolRegistry, type McpToolRegistry } from "./registry";
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

// Default token budget for the authoritative capsule build — matches the CLI capsule
// command's default (generous enough for a couple of pivots plus a ring of
// support). Callers can override with `capsule_budget_tokens`.
const CAPSULE_V2_PRODUCT_DEFAULT_BUDGET_TOKENS = 8_000;

interface IndexRepoInput {
  readonly force?: boolean;
  readonly repo_root?: string;
  readonly mode?: "auto" | "incremental" | "full";
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
  readonly capsule_engine?: string;
  readonly capsuleEngine?: string;
  readonly capsule_intent?: string;
  readonly capsuleIntent?: string;
  readonly capsule_budget_tokens?: number;
  readonly capsuleBudgetTokens?: number;
  readonly repo_root?: string;
  readonly auto_refresh?: "never" | "if_stale";
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
  readonly repo_root?: string;
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
  readonly scope?: string;
}

interface SearchMemoryInput {
  readonly query?: string;
  readonly maxResults?: number;
  readonly sessionId?: string;
  readonly linkedFilePaths?: readonly string[];
  readonly linkedSymbolIds?: readonly string[];
  readonly repos?: readonly string[];
  readonly includeStale?: boolean;
}

interface GetSessionContextInput {
  readonly sessionId?: string;
  readonly limit?: number;
  readonly query?: string;
  readonly includeStale?: boolean;
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
  readonly repo_root?: string;
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
  /**
   * M164. Absent on a repository that was indexed without ever being
   * initialized. Repo-local config carries a database-path override and nothing
   * else the read path consumes; repo-local state carries watcher-derived
   * freshness signals that refine, but do not establish, readiness. A binding
   * without them is a binding whose authority came from the index itself.
   */
  readonly config?: RepoLocalConfig;
  readonly state?: RepoLocalState;
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
  readonly indexReadiness: IndexReadinessSummary;
  /**
   * M145: is the repository at this registered path still the one the workspace
   * registered? Independent of `indexReadiness`, which asks whether the stored
   * INDEX belongs to the worktree — a replaced checkout can carry an index that
   * is perfectly valid for the repository it was built from.
   */
  readonly registration: RegistrationStatus;
  readonly registrationMismatches: readonly string[];
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

const SOURCE_EXCERPT_SCHEMA: McpSchemaProperty = {
  type: ["object", "null"],
  description: "Bounded inline source excerpt derived from an indexed symbol's own line span (never an exact edge/call-site line, since indexed edges carry no location). null when source could not be loaded freshly or the excerpt budget was exhausted.",
  properties: {
    filePath: stringProperty("Normalized repo-relative file path of the excerpt."),
    startLine: integerProperty("1-based first line of the excerpt."),
    endLine: integerProperty("1-based last line of the excerpt."),
    text: stringProperty("Bounded excerpt text (never a whole file). Omitted on the MCP surface; see textCharacters and read path:startLine-endLine."),
    reason: stringProperty("Why this excerpt was chosen: symbol_span (full symbol fit the budget), signature (signature-focused head window), fallback_symbol_window (generic trimmed head window), or edge_site (reserved; exact edge-site lines are not currently available)."),
    textCharacters: integerProperty("Length of the excerpt this entry refers to, when response compaction omitted the text itself."),
    truncated: booleanProperty("Whether the excerpt was trimmed by the line or per-line character budget."),
  },
  required: ["filePath", "startLine", "endLine", "reason", "truncated"],
  additionalProperties: false,
};

const IMPACT_NODE_SCHEMA = objectProperty(
  "A symbol discovered in the bounded structural impact view.",
  {
    symbolId: stringProperty("Stable persisted symbol id."),
    filePath: stringProperty("Normalized repo-relative file path."),
    fqName: stringProperty("Fully qualified symbol name."),
    localName: stringProperty("Local symbol name."),
    kind: stringProperty("Symbol kind."),
    distance: integerProperty("Shortest reverse-edge distance from the resolved symbol."),
    sourceExcerpt: SOURCE_EXCERPT_SCHEMA,
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

const STATIC_EVIDENCE_ENDPOINT_SCHEMA = objectProperty(
  "One source-grounded endpoint of a static relationship.",
  {
    nodeId: stringProperty("Stable indexed symbol id when resolved."),
    path: stringProperty("Repository-relative endpoint path when resolved."),
    symbol: stringProperty("Fully qualified endpoint symbol when resolved."),
    kind: stringProperty("Indexed symbol kind when resolved."),
    lineSpan: objectProperty(
      "1-based source span. For an edge source this is the exact lexical occurrence when available, otherwise the producing symbol span.",
      { start: integerProperty("First line."), end: integerProperty("Last line.") },
      ["start", "end"],
    ),
  },
  [],
);

const STATIC_RELATION_EVIDENCE_SCHEMA = objectProperty(
  "Typed static relationship evidence. Categorical strength is deterministic; confidence is null because persisted numeric confidence is not calibrated.",
  {
    id: stringProperty("Stable query-evidence id."),
    edgeId: { type: ["string", "null"], description: "Persisted edge id, or null for query-derived lexical/unresolved evidence." },
    kind: stringProperty("Semantic relation kind; calls, imports, references, inheritance, and other roles remain distinct."),
    persistedKind: { type: ["string", "null"], description: "Underlying persisted edge type when present." },
    source: STATIC_EVIDENCE_ENDPOINT_SCHEMA,
    target: STATIC_EVIDENCE_ENDPOINT_SCHEMA,
    direction: stringProperty("Incoming or outgoing relative to the focal symbol."),
    strength: stringProperty("Deterministic evidence category: exact, resolved, conservative, lexical, or unresolved."),
    confidence: { type: "null", description: "Always null; no probabilistic confidence is claimed." },
    evidence: {
      type: "object",
      description: "Why and where this relationship was resolved.",
      properties: {
        sourceText: stringProperty("The caller's own source line at the reported call site, trimmed and bounded. Present when the line could be read from source that still matches the index; shed under budget pressure, which is recorded in responseBudget.compactedFields."),
        importAlias: stringProperty("Source alias when recoverable."),
        referenceName: stringProperty("Name used to ground the target. A rendered sourceText contains it."),
        resolutionMethod: stringProperty("Deterministic resolver/category name."),
        locationKind: stringProperty("edge_site (a call-site span the parser persisted with the edge), caller_span_scan (a located occurrence inside the caller's span, not proof of which occurrence produced the edge), source_symbol_span (no occurrence located; the span is the symbol's), or indexed_metadata."),
        callSites: arrayProperty(
          "Parser-persisted occurrences of this edge, bounded and ordered by position. Present only for edge_site provenance.",
          objectProperty("One persisted occurrence.", {
            startLine: integerProperty("1-based first line."),
            endLine: integerProperty("1-based last line."),
            precision: stringProperty("span or line."),
          }, ["startLine", "endLine", "precision"]),
        ),
        callSiteCount: integerProperty("Total occurrences recorded, including any beyond the bounded list."),
      },
      required: ["resolutionMethod", "locationKind"],
      additionalProperties: false,
    },
    limitations: arrayProperty("Per-edge truthfulness limitations.", stringProperty("Limitation.")),
  },
  ["id", "edgeId", "kind", "persistedKind", "source", "target", "direction", "strength", "confidence", "evidence", "limitations"],
);

const STATIC_IMPACT_PATH_SCHEMA = objectProperty(
  "A deterministically ranked bounded path through static repository evidence, never a runtime execution trace.",
  {
    id: stringProperty("Stable path id."),
    direction: stringProperty("Semantic path direction."),
    nodes: arrayProperty("Ordered path symbols.", SYMBOL_RESULT_SCHEMA),
    edges: arrayProperty("Ordered typed static relations.", STATIC_RELATION_EVIDENCE_SCHEMA),
    length: integerProperty("Path edge count."),
    minimumStrength: stringProperty("Weakest evidence category on the path."),
    truncated: booleanProperty("Whether this individual path was truncated."),
    limitations: arrayProperty("Path limitations.", stringProperty("Limitation.")),
  },
  ["id", "direction", "nodes", "edges", "length", "minimumStrength", "truncated", "limitations"],
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

const IMPACT_CONSUMER_COUNTS_SCHEMA = objectProperty(
  "Direction-separated consumer accounting. Prefer these over dependentSymbolCount.",
  {
    exactCallerCount: integerProperty("Proven incoming call relations: the honest answer to 'who calls this?'."),
    exactReferenceCount: integerProperty("Proven incoming non-call references (annotations, inheritance, decorators)."),
    potentialCallerCount: integerProperty("Unproven call sites discovered that may reach the target."),
    structuralContainerCount: integerProperty("Containers of the target (its class/module). Structural, not consumers."),
    outgoingDependencyCount: integerProperty("Symbols the target itself depends on. Downstream, not consumers."),
    reverseReachableSymbolCount: integerProperty("Legacy reverse-reachable population, mixing containment with consumers."),
  },
  [
    "exactCallerCount",
    "exactReferenceCount",
    "potentialCallerCount",
    "structuralContainerCount",
    "outgoingDependencyCount",
    "reverseReachableSymbolCount",
  ],
);

const IMPACT_SUMMARY_SCHEMA = objectProperty(
  "Summary counts for the bounded impact result.",
  {
    dependentSymbolCount: integerProperty("Deprecated: reverse-reachable symbols, mixing real consumers with structural containment. Read summary.consumers."),
    dependentFileCount: integerProperty("Deprecated: files of dependentSymbolCount; same mixed-direction caveat."),
    maxDepth: integerProperty("Maximum depth requested for traversal."),
    maxObservedDistance: integerProperty("Largest shortest-path distance present in the result."),
    consumers: IMPACT_CONSUMER_COUNTS_SCHEMA,
  },
  ["dependentSymbolCount", "dependentFileCount", "maxDepth", "maxObservedDistance", "consumers"],
);

const CALLER_COVERAGE_SCHEMA = objectProperty(
  "Whether 'who consumes this?' was answered completely, and why not when it was not.",
  {
    status: stringProperty("complete | incomplete | unknown. Never read 'no exact callers' as 'no callers' unless complete."),
    exactCallerCount: integerProperty("Proven callers discovered."),
    deliveredExactCallerCount: integerProperty("Proven callers carried by this response."),
    potentialCallerCount: integerProperty("Unproven candidate call sites discovered."),
    deliveredPotentialCallerCount: integerProperty("Unproven candidate call sites carried by this response."),
    potentialCallersOmitted: integerProperty("Candidate call sites discovered but not delivered."),
    competingDefinitionCount: integerProperty("Other indexed definitions sharing this unqualified method name."),
    candidateFilesScanned: integerProperty("Files actually inspected for unresolved call sites."),
    candidateFilesAvailable: integerProperty("Files the index related to the owning class."),
    reasonCodes: arrayProperty(
      "Deterministic reasons coverage is not complete.",
      stringProperty("Coverage reason code."),
    ),
    notes: arrayProperty("Interpretation notes for the coverage state.", stringProperty("Coverage note.")),
  },
  [
    "status",
    "exactCallerCount",
    "deliveredExactCallerCount",
    "potentialCallerCount",
    "deliveredPotentialCallerCount",
    "potentialCallersOmitted",
    "competingDefinitionCount",
    "candidateFilesScanned",
    "candidateFilesAvailable",
    "reasonCodes",
    "notes",
  ],
);

const POTENTIAL_CALLER_SCHEMA = objectProperty(
  "An unproven call site that may reach the target. NOT a graph edge and never persisted.",
  {
    filePath: stringProperty("Repository-relative file holding the candidate call site."),
    line: integerProperty("1-based line of the candidate call site."),
    column: integerProperty("0-based column where the receiver expression starts."),
    receiverExpression: stringProperty("Literal receiver expression as written, e.g. 'spc_1'."),
    enclosingSymbol: stringProperty("Fully qualified symbol containing the call site, when known."),
    confidence: stringProperty("high | medium | unresolved. No level means proven."),
    evidenceKind: stringProperty("Which local evidence produced this confidence."),
    enclosingSymbolId: stringProperty("Symbol id of the enclosing symbol; shed first under budget pressure."),
    reason: stringProperty("Human-readable justification; shed first under budget pressure."),
    sourceText: stringProperty("Trimmed source line; shed first under budget pressure."),
  },
  ["filePath", "line", "column", "receiverExpression", "enclosingSymbol", "confidence", "evidenceKind"],
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
    sourceExcerpt: SOURCE_EXCERPT_SCHEMA,
    relation: STATIC_RELATION_EVIDENCE_SCHEMA,
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
    minimumStrength: stringProperty("Weakest categorical evidence strength on this path."),
    crossFileTransitions: integerProperty("Number of file-boundary transitions on this path."),
    limitations: arrayProperty("Static-path interpretation limitations.", stringProperty("Limitation.")),
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
    traversalLimitReached: booleanProperty("Whether the bounded traversal stopped before exhausting the reachable set. An unreachable result carrying this flag means 'not found within budget', never 'not connected'."),
  },
  ["reachable", "pathCount", "maxPaths", "shortestPathEdgeCount", "truncated", "traversalLimitReached"],
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

/**
 * M141: the authoritative runtime-readiness verdict. Compact by contract — a
 * readiness report must never become a manifest dump (see the M130/M133
 * whole-response boundedness lesson).
 */
const INDEX_READINESS_SCHEMA = objectProperty(
  "Authoritative runtime readiness of the stored index, shared by every product tool.",
  {
    ready: booleanProperty("True only when source, schema, capability, repository, and worktree checks all pass."),
    state: stringProperty("ready, source_stale, schema_incompatible, capability_incompatible, repository_mismatch, worktree_mismatch, index_missing, or index_corrupt."),
    reason: stringProperty("Machine-readable reason code."),
    recommendedAction: stringProperty("none, incremental_refresh, full_rebuild, unsupported_runtime_upgrade, or inspect_index."),
    sourceFresh: booleanProperty("Whether the index corresponds to the requested repository/worktree source state."),
    schemaCompatible: booleanProperty("Whether this runtime can read and interpret the stored index schema."),
    capabilityCompatible: booleanProperty("Whether the index carries every capability the request declared it needs."),
    repositoryCompatible: booleanProperty("Whether the index was built for this repository."),
    worktreeCompatible: booleanProperty("Whether the index was built for this worktree."),
    missingCapabilities: arrayProperty("Required capabilities absent from the stored index.", stringProperty("Capability id.")),
    coverageComplete: booleanProperty("M156: false when a source file in scope could not be indexed. SEPARATE from `ready` and from freshness — a usable, current index can still be semantically incomplete."),
    failedFiles: numberProperty("M156: exact count of eligible files this runtime attempted and could not index. 0 on a complete index."),
  },
  [
    "ready",
    "state",
    "reason",
    "recommendedAction",
    "sourceFresh",
    "schemaCompatible",
    "capabilityCompatible",
    "coverageComplete",
    "failedFiles",
    "repositoryCompatible",
    "worktreeCompatible",
    "missingCapabilities",
  ],
);

/** M141: bounded indexing outcome report. Counts exact, detail capped. */
const INDEX_OUTCOMES_SCHEMA = objectProperty(
  "Summary-first indexing outcomes. Counts are exact; per-file detail is bounded.",
  {
    counts: objectProperty(
      "Exact outcome counts across every scanned file.",
      {
        filesTotal: integerProperty("Files considered by this index run."),
        indexed: integerProperty("Files successfully indexed."),
        skipped: integerProperty("Files skipped by language/capability policy."),
        failed: integerProperty("Files that failed to read, parse, or persist."),
        warnings: integerProperty("Indexed files that produced parse diagnostics."),
        byStatus: { type: "object", description: "Exact count per outcome status.", additionalProperties: true },
      },
      ["filesTotal", "indexed", "skipped", "failed", "warnings", "byStatus"],
    ),
    changes: {
      type: ["object", "null"],
      description: "Added/modified/removed/renamed/unchanged counts from the incremental planner.",
      additionalProperties: true,
    },
    skipReasons: { type: "object", description: "Aggregate counts per skip reason.", additionalProperties: true },
    detail: objectProperty(
      "Bounded notable-outcome detail with a truthful omitted count.",
      {
        mode: stringProperty("summary or debug."),
        limit: integerProperty("Maximum notable outcomes this mode delivers."),
        delivered: integerProperty("Notable outcomes included in this response."),
        omitted: integerProperty("Notable outcomes withheld by the cap."),
        outcomes: arrayProperty("Delivered notable outcomes.", { type: "object", additionalProperties: true }),
        omittedByStatus: { type: "object", description: "Withheld notable outcomes per status.", additionalProperties: true },
        note: stringProperty("What the response includes and what it summarizes."),
      },
      ["mode", "limit", "delivered", "omitted", "outcomes", "omittedByStatus", "note"],
    ),
  },
  ["counts", "changes", "skipReasons", "detail"],
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
    readiness: {
      type: ["object", "null"],
      description: "Authoritative runtime-readiness verdict this freshness view was reconciled against.",
      properties: { ...(INDEX_READINESS_SCHEMA.properties ?? {}) },
      required: INDEX_READINESS_SCHEMA.required ?? [],
      additionalProperties: false,
    },
  },
  // `whyItMatters` and `recommendedAction` are declared elsewhere in this shape and
  // survive at every detail level with the state itself. The indexer's own working
  // out — observed changes, auto-reindex bookkeeping, snapshot fingerprints, head
  // comparison — is detail-conditional and returned at `detail=debug`.
  ["state", "isStale", "summary", "reasons", "readiness"],
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
    status: stringProperty("fresh, stale, missing, or blocked."),
    reason: {
      type: ["string", "null"],
      description: "Reason for the status or refresh decision.",
    },
    action: stringProperty("none, call_index_repo, retry, choose_worktree, or rebuild_index."),
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
    before: {
      type: ["object", "null"],
      description: "Precise freshness before an explicitly requested refresh.",
      properties: {
        status: stringProperty("Pre-refresh status."),
        reason: stringProperty("Pre-refresh reason."),
      },
      required: ["status", "reason"],
      additionalProperties: false,
    },
    refreshAttempted: booleanProperty("Whether explicit auto-refresh was attempted."),
    refreshMode: { type: ["string", "null"], description: "incremental or full when refresh was attempted." },
    refreshFailed: booleanProperty("Whether the requested refresh failed."),
    failureReason: { type: ["string", "null"], description: "Lock or indexing failure when refresh failed." },
    performance: { type: ["object", "null"], description: "Selected refresh mode, parse-cache, closure, fallback, and timing diagnostics.", additionalProperties: true },
    after: objectProperty(
      "Precise freshness after the request.",
      { status: stringProperty("Post-request status."), reason: stringProperty("Post-request reason.") },
      ["status", "reason"],
    ),
    worktreeRoot: stringProperty("Canonical selected worktree root."),
    requestedWorktree: objectProperty(
      "Selected worktree snapshot.",
      { root: stringProperty("Canonical root."), headCommit: { type: ["string", "null"], description: "Current HEAD." } },
      ["root", "headCommit"],
    ),
    indexedWorktree: {
      type: ["object", "null"],
      description: "Worktree recorded by the manifest, when present.",
      properties: {
        root: stringProperty("Canonical root."),
        headCommit: { type: ["string", "null"], description: "Indexed HEAD." },
      },
      required: ["root", "headCommit"],
      additionalProperties: false,
    },
    previousHead: { type: ["string", "null"], description: "Previously indexed HEAD." },
    currentHead: { type: ["string", "null"], description: "Current selected-worktree HEAD." },
    indexRunId: { type: ["integer", "string", "null"], description: "Manifest index run id." },
  },
  // Status, reason and action are the readiness truth and are always present.
  // The refresh bookkeeping around them is detail-conditional (`detail=debug`).
  ["status", "reason", "action"],
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
    search: objectProperty(
      "Source-content-free retrieval details available for successful and empty searches.",
      {
        normalizedQuery: stringProperty("Normalized query sent to routed retrieval."),
        pathSignalsConsidered: arrayProperty("Path-like terms considered.", stringProperty("Path-like term.")),
        pathSignalsMatched: arrayProperty("Path-like terms matched in candidate files.", stringProperty("Matched path-like term.")),
        candidateFilesConsidered: integerProperty("Distinct lexical candidate files."),
        weakPathCoverage: booleanProperty("Whether fewer than half of multiple path terms matched."),
        queryVariants: arrayProperty("Bounded query variants considered by retrieval.", objectProperty(
          "One deterministic query variant.",
          {
            kind: stringProperty("Variant kind: identifier, path, phrase, semantic_terms, or fallback."),
            query: stringProperty("Variant expression or term."),
          },
          ["kind", "query"],
        )),
        identifierTerms: arrayProperty("Exact identifier-like terms detected in the task.", stringProperty("Identifier term.")),
        pathTerms: arrayProperty("Path terms considered by the path lane.", stringProperty("Path term.")),
        ftsTerms: arrayProperty("Normalized terms used to construct FTS admission.", stringProperty("FTS term.")),
        laneResults: objectProperty(
          "Raw or scored hit counts by retrieval lane.",
          {
            path: integerProperty("Path-lane rows."),
            symbol: integerProperty("Symbol-field matches."),
            lexical: integerProperty("Primary plus fallback lexical rows."),
            documentation: integerProperty("Docstring matches."),
            tests: integerProperty("Test-file or test-symbol matches."),
            graph: integerProperty("Graph-seeded additions."),
          },
          ["path", "symbol", "lexical", "documentation", "tests", "graph"],
        ),
        laneCandidateFiles: objectProperty(
          "Repo-relative candidate file paths by lane; paths and symbols only, never source bodies.",
          {
            path: arrayProperty("Path-lane files.", stringProperty("Repo-relative path.")),
            symbol: arrayProperty("Exact identifier/filename-lane files.", stringProperty("Repo-relative path.")),
            lexical: arrayProperty("Lexical-lane files.", stringProperty("Repo-relative path.")),
            documentation: arrayProperty("Documentation-match files.", stringProperty("Repo-relative path.")),
            tests: arrayProperty("Test-shaped files.", stringProperty("Repo-relative path.")),
          },
          ["path", "symbol", "lexical", "documentation", "tests"],
        ),
        candidateUnionFiles: arrayProperty("De-duplicated files in the complete pre-rerank candidate union.", stringProperty("Repo-relative path.")),
        preFilterCandidates: integerProperty("Candidate union size before score filtering."),
        rejectedByThreshold: integerProperty("Candidates rejected because they produced no score evidence."),
        rejectedByScope: integerProperty("Candidates rejected by explicit scope filters."),
        graphExpansions: integerProperty("Candidates added by graph expansion."),
        fallbackAttempted: booleanProperty("Whether bounded lexical fallback ran."),
        fallbackReason: stringProperty("Reason fallback ran, when present."),
        finalReason: stringProperty("Search-level empty reason, when present."),
        timingsMs: objectProperty(
          "Retrieval-only phase timings in milliseconds.",
          {
            normalization: numberProperty("Query normalization and variant construction time."),
            laneSearch: numberProperty("Retrieval lane query time."),
            candidateMerge: numberProperty("Candidate merge, scoring, and truncation time."),
            graphExpansion: numberProperty("Graph reranking/expansion time."),
            total: numberProperty("Total routed retrieval time."),
          },
          ["normalization", "laneSearch", "candidateMerge", "graphExpansion", "total"],
        ),
      },
      [
        "normalizedQuery", "pathSignalsConsidered", "pathSignalsMatched", "candidateFilesConsidered",
        "weakPathCoverage", "queryVariants", "identifierTerms", "pathTerms", "ftsTerms",
        "laneResults", "laneCandidateFiles", "candidateUnionFiles", "preFilterCandidates", "rejectedByThreshold", "rejectedByScope",
        "graphExpansions", "fallbackAttempted", "timingsMs",
      ],
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
    "search",
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
  // Only identity, role and representation mode are guaranteed. On the MCP
  // surface this legacy section is a compatibility alias reduced to references;
  // productContext.items is the authoritative per-item record (M130).
  [
    "filePath",
    "fqName",
    "role",
    "contentMode",
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
    requestedIntent: stringProperty("Raw intent requested by the caller (preset, capsule intent, or auto), as fed to the shared normalized model."),
    resolvedIntent: stringProperty("Unified normalized intent shared with Capsule v2: debug, modify, refactor, impact, explain, or test_failure."),
    intentSource: stringProperty("How the normalized intent was decided: explicit, phrase, classifier, or default."),
    impactEligible: booleanProperty("Whether the resolved intent makes the impact section eligible (refactor or impact intent)."),
    impactSkipReason: {
      type: ["string", "null"],
      description: "Intent-level reason impact is ineligible (not_requested_by_intent), or null when eligible.",
    },
    flowEligible: booleanProperty("Whether the query shape makes the logic-flow section eligible."),
    flowSkipReason: {
      type: ["string", "null"],
      description: "Intent-level reason flow is ineligible (unsupported_query_shape), or null when eligible.",
    },
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
    "requestedIntent",
    "resolvedIntent",
    "intentSource",
    "impactEligible",
    "impactSkipReason",
    "flowEligible",
    "flowSkipReason",
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
    supersededBy: stringProperty("Field that carries the authoritative form of this section. Always `productContext` on the MCP surface."),
    note: stringProperty("Why this section is a compatibility alias rather than a second selection representation."),
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
        dependentSymbolCount: integerProperty("Deprecated: reverse-reachable symbols, mixing real consumers with structural containment. Read consumers."),
        dependentFileCount: integerProperty("Deprecated: files of dependentSymbolCount; same mixed-direction caveat."),
        maxDepth: integerProperty("Maximum depth requested for traversal."),
        maxObservedDistance: integerProperty("Largest shortest-path distance present in the result."),
        consumers: IMPACT_CONSUMER_COUNTS_SCHEMA,
      },
      required: ["dependentSymbolCount", "dependentFileCount", "maxDepth", "maxObservedDistance", "consumers"],
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
    sourceExcerpts: arrayProperty(
      "Bounded inline excerpts around each step's edge source, so the relationship can be read without a follow-up Read. Null/absent step excerpts are dropped.",
      SOURCE_EXCERPT_SCHEMA,
    ),
    sourceExcerptsOmitted: integerProperty("Step excerpts dropped by response compaction on a long path, when any."),
    stepEvidenceOmitted: integerProperty("Steps whose relation evidence was dropped by response compaction, when any."),
  },
  ["pathIndex", "edgeCount", "nodeFqNames"],
);

const RUN_PIPELINE_FLOW_SECTION_SCHEMA = objectProperty(
  "Logic-flow integration decision and compact result when two endpoints can be inferred from the task and candidates.",
  {
    included: booleanProperty("Whether a reachable directed structural flow was included."),
    skipReason: {
      type: ["string", "null"],
      description: `Why the flow section carries no path, when applicable. One of: ${Object.values(RunPipelineFlowSkipReason).join(", ")}. These describe the search, never the code: VTRACE does not claim two symbols are unconnected.`,
    },
    claimScope: {
      type: ["string", "null"],
      description: "Scope a negative result is claimed over. Always `current_index` once a search ran; VTRACE never claims semantic disconnection.",
    },
    endpointsResolved: booleanProperty(
      "Whether both endpoints resolved to exactly one indexed symbol each.",
    ),
    verificationRecommended: booleanProperty(
      "Whether the caller should confirm a negative result by reading the source before relying on it.",
    ),
    endpointDiagnostic: {
      type: ["object", "null"],
      description: "Which endpoint failed to resolve and what it matched, when endpoint resolution failed.",
      properties: {
        field: stringProperty("Which endpoint failed: start or end."),
        symbolFqn: stringProperty("The endpoint name that was resolved."),
        matchingSymbolIds: arrayProperty("Indexed symbol ids matched, when the name was ambiguous.", stringProperty("Symbol id.")),
      },
      required: ["field", "symbolFqn", "matchingSymbolIds"],
      additionalProperties: false,
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
        traversalLimitReached: booleanProperty("Whether the bounded traversal stopped before exhausting the reachable set."),
      },
      required: ["reachable", "pathCount", "maxPaths", "shortestPathEdgeCount", "truncated", "traversalLimitReached"],
      additionalProperties: false,
    },
    paths: {
      type: ["array", "null"],
      description: "Compact ordered shortest paths when a flow was attempted.",
      items: RUN_PIPELINE_FLOW_PATH_SCHEMA,
    },
    pathsOmitted: integerProperty("Enumerated paths dropped by response compaction, when any. The decision, claim scope and reason are never dropped."),
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
    "claimScope",
    "endpointsResolved",
    "verificationRecommended",
    "endpointDiagnostic",
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
    omittedForDetail: {
      type: ["string", "null"],
      description: "Present when machine-facing diagnostics were held for detail=debug; says so where the removal happened.",
    },
    sectionDecisionsOmitted: integerProperty("Present when response compaction dropped the per-section decision mirrors (impact, memory, ...); how many were dropped. Each section still publishes its own decision."),
    sectionDecisionsNote: stringProperty("Why the per-section decision mirrors are absent when `sectionDecisionsOmitted` is present."),
    intent: objectProperty(
      "Intent-selection diagnostics.",
      {
        requested: stringProperty("Preset requested by caller."),
        selected: stringProperty("Preset resolved by the orchestrator."),
        source: stringProperty("How the preset was resolved."),
        fallbackApplied: booleanProperty("Whether auto-selection fell back to a default."),
        resolvedIntent: stringProperty("Unified normalized intent shared with Capsule v2."),
        intentSource: stringProperty("How the normalized intent was decided: explicit, phrase, classifier, or default."),
        impactEligible: booleanProperty("Whether the resolved intent makes the impact section eligible."),
        flowEligible: booleanProperty("Whether the query shape makes the flow section eligible."),
      },
      ["requested", "selected", "source", "fallbackApplied", "resolvedIntent", "intentSource", "impactEligible", "flowEligible"],
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
          description: "Why the flow section carries no path, when applicable.",
        },
        claimScope: {
          type: ["string", "null"],
          description: "Scope a negative result is claimed over; always `current_index` once a search ran.",
        },
        endpointsResolved: booleanProperty("Whether both endpoints resolved to exactly one indexed symbol each."),
        verificationRecommended: booleanProperty("Whether a negative result should be verified against the source."),
        endpointStrategy: {
          type: ["string", "null"],
          description: "How directed endpoints were resolved, when evaluated.",
        },
        bothDirectionsReachable: booleanProperty("Whether both directed orderings were reachable during probing."),
        reachable: {
          type: ["boolean", "null"],
          description: "Whether the chosen directed flow was reachable, when a flow was attempted.",
        },
        traversalLimitReached: {
          type: ["boolean", "null"],
          description: "Whether the bounded traversal budget was exhausted before the search completed.",
        },
        candidatesConsidered: integerProperty("Number of conservative endpoint candidates considered."),
        matchedCandidates: integerProperty("Number of task-mentioned endpoint candidates."),
      },
      [
        "included",
        "skipReason",
        "claimScope",
        "endpointsResolved",
        "verificationRecommended",
        "endpointStrategy",
        "bothDirectionsReachable",
        "reachable",
        "traversalLimitReached",
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
  // Detail-conditional. These members answer how the answer was computed and are
  // returned at `detail=debug`; at compact and standard the response carries only
  // the freshness and readiness diagnostics an agent can act on, because M166
  // measured the rest as model-visible, billed on every call, and consumed by no
  // product code. A schema that declared them required would describe a response
  // shape the tool no longer returns by default.
  [],
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
    omittedItemCount: integerProperty("Deferred items dropped by response compaction, when any."),
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
    scope: {
      type: ["string", "null"],
      description: "Typed observation scope, or null for a legacy record.",
    },
    origin: {
      type: ["string", "null"],
      description: "Observation origin, or null for a legacy record.",
    },
    provenance: {
      type: ["object", "null"],
      description: "Detailed stored provenance for historical/debug inspection.",
      additionalProperties: true,
    },
    semanticKey: {
      type: ["string", "null"],
      description: "Stable tool/query/context semantic identity.",
    },
    resultSemanticHash: {
      type: ["string", "null"],
      description: "Stable semantic result hash when structured result evidence exists.",
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
    "scope",
    "origin",
    "provenance",
    "semanticKey",
    "resultSemanticHash",
    "createdAtMs",
    "linkedFilePaths",
    "linkedSymbols",
    "linkedFqNames",
  ],
);

const OBSERVATION_COMPATIBILITY_SCHEMA = objectProperty(
  "Current-request compatibility classification.",
  {
    state: stringProperty("Deterministic compatibility state."),
    currentTruthEligible: booleanProperty("Whether this evidence is safe for current-truth injection."),
    reasons: arrayProperty("Deterministic compatibility reason codes.", stringProperty("Reason code.")),
    repoMatch: { type: ["boolean", "null"], description: "Repository identity match when applicable." },
    worktreeMatch: { type: ["boolean", "null"], description: "Worktree identity match when applicable." },
    sourceStateMatch: { type: ["boolean", "null"], description: "HEAD and dirty-state match when applicable." },
    indexMatch: { type: ["boolean", "null"], description: "Index identity/capability match when applicable." },
    implementationCompatible: { type: ["boolean", "null"], description: "Producing implementation compatibility when applicable." },
  },
  ["state", "currentTruthEligible", "reasons", "repoMatch", "worktreeMatch", "sourceStateMatch", "indexMatch", "implementationCompatible"],
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
    compatibility: OBSERVATION_COMPATIBILITY_SCHEMA,
    score: numberProperty("Final deterministic search score."),
    signals: arrayProperty("Ranking signals.", OBSERVATION_SEARCH_SIGNAL_SCHEMA),
  },
  ["observation", "staleness", "compatibility", "score", "signals"],
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
    indexReadiness: INDEX_READINESS_SCHEMA,
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
    "indexReadiness",
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
        selectedRepos: arrayProperty("Bounded sample of selected repo aliases. `selectedReposTotal` carries the real count.", stringProperty("Repo alias.")),
        selectedReposTotal: integerProperty("Selected repo aliases in total."),
        configuredRepos: arrayProperty("Bounded sample of configured repo aliases. `configuredReposTotal` carries the real count.", stringProperty("Repo alias.")),
        configuredReposTotal: integerProperty("Configured repo aliases in total."),
      },
      required: ["name", "primaryRepoAlias", "selectedRepos", "configuredRepos"],
      additionalProperties: false,
    },
    coverage: objectProperty(
      "M151 workspace census, computed over every selected member. Verdicts come from these totals, never from the bounded `repos` sample. Not a readiness verdict: repository readiness stays per repository.",
      {
        registeredMembers: integerProperty("Members the workspace registers."),
        enabledMembers: integerProperty("Registered members that are enabled."),
        readyMembers: integerProperty("Members whose index can currently answer."),
        refusedMembers: integerProperty("Enabled members whose index cannot currently answer."),
        unsettledMembers: integerProperty("Members whose state could not be established at all."),
        coverageComplete: booleanProperty("True when every selected member returned a readiness answer. Independent of `omittedByBound`."),
        omittedByBound: integerProperty("Member DETAIL RECORDS not serialized. A display bound, never an evidence gap."),
        examplesEmitted: integerProperty("Member detail records actually serialized."),
      },
      ["registeredMembers", "enabledMembers", "readyMembers", "refusedMembers", "coverageComplete", "omittedByBound"],
    ),
    repos: arrayProperty("Bounded sample of per-repo status entries when a multi-repo workspace config is active. `coverage` carries the authoritative totals.", WORKSPACE_REPO_STATUS_SCHEMA),
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
    indexReadiness: INDEX_READINESS_SCHEMA,
    freshness: INDEX_FRESHNESS_SCHEMA,
    watcher: FILE_WATCHER_STATUS_SCHEMA,
    performance: { type: ["object", "null"], description: "Diagnostics from the most recent index operation.", additionalProperties: true },
    accessCapability: {
      type: ["object", "null"],
      description:
        "M148-A physical access capability, read from the SQLite catalogue. `nameLookupAccess` is "
        + "`indexed` when exact-name membership is a keyed lookup and `fallback` when it scans the "
        + "symbol table — a performance mode, NOT a readiness or compatibility verdict.",
      properties: {
        version: { type: "integer", description: "Access-path version this runtime declares." },
        nameLookupAccess: {
          type: "string",
          enum: ["indexed", "fallback", "unknown"],
          description: "How exact-name membership is answered. `unknown` only when the index could not be read.",
        },
        present: { type: "array", items: { type: "string" }, description: "Installed access-path indexes." },
        missing: { type: "array", items: { type: "string" }, description: "Access-path indexes not yet installed." },
      },
      required: ["version", "nameLookupAccess", "present", "missing"],
      additionalProperties: false,
    },
    runtime: {
      type: "object",
      description: "Runtime/build provenance for stale-process diagnosis.",
      additionalProperties: true,
    },
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
    "indexReadiness",
    "freshness",
    "watcher",
    "performance",
    "runtime",
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
  toolId: McpToolId = McpToolId.RunPipeline,
): string | McpToolExecutionResult<never> {
  const task = parseOptionalStringField(toolId, input, "task");

  if (task !== undefined && typeof task !== "string") {
    return task;
  }

  if (typeof task === "string") {
    return task;
  }

  return parseRequiredStringField(toolId, input, "query");
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

function parseOptionalStringFieldAlias(
  toolId: McpToolId,
  input: Record<string, unknown>,
  preferredField: string,
  legacyField: string,
): string | undefined | McpToolExecutionResult<never> {
  const preferred = parseOptionalStringField(toolId, input, preferredField);

  if (preferred !== undefined) {
    return preferred;
  }

  return parseOptionalStringField(toolId, input, legacyField);
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

/**
 * The single repository-root parameter every product tool accepts. One term
 * (`repo_root`), one meaning: the Git worktree the caller is working in.
 */
const REPO_ROOT_PROPERTY = stringProperty(
  "Optional worktree root to query. Pass the linked worktree you are working in; defaults to the server-bound root, which is reported as routingSource=process_default.",
);

// Thin wrapper: the routing decision, precedence and diagnostics live in the
// typed module. This only translates a routing failure into an MCP error result.
async function resolveRequestedRepoRoot(
  context: McpServerContext,
  toolId: McpToolId,
  requestedRoot?: string,
): Promise<string | McpToolExecutionResult<never>> {
  const routed = await routeRequestedWorktree(context, toolId, requestedRoot);
  return routed.ok ? routed.decision.repoRoot : routed.result;
}

async function routeRequestedWorktree(
  context: McpServerContext,
  toolId: McpToolId,
  requestedRoot?: string,
): Promise<
  | { ok: true; decision: import("./worktreeRouting").WorktreeRoutingDecision }
  | { ok: false; result: McpToolExecutionResult<never> }
> {
  const routing = await resolveWorktreeRouting({
    requestedRoot,
    clientContextRoot: context.clientContextRoot ?? null,
    boundRoot: context.repoRoot,
  });

  if (routing.ok) {
    return { ok: true, decision: routing.decision };
  }

  return {
    ok: false,
    result: invalidRequest(toolId, routing.message, {
      reason: routing.reason,
      action: routing.action,
      ...(routing.requestedWorktree === undefined
        ? {}
        : { requestedWorktree: routing.requestedWorktree }),
      ...(routing.activeIndex === undefined ? {} : { activeIndex: routing.activeIndex }),
    }),
  };
}

function rebindMcpContext(context: McpServerContext, repoRoot: string): McpServerContext {
  if (context.repoRoot === repoRoot) {
    return context;
  }
  const paths = resolveRepoLocalPaths(repoRoot);
  return {
    ...context,
    repoRoot,
    dbPath: paths.dbPath,
    configPath: paths.configPath,
    statePath: paths.statePath,
    initialized: false,
    config: null,
    state: null,
  };
}

async function resolveReadyRepoBinding(
  context: McpServerContext,
  toolId: McpToolId,
  requestedRoot?: string,
): Promise<
  | { ok: true; binding: ReadyRepoBinding }
  | { ok: false; result: McpToolExecutionResult<never> }
> {
  const resolvedRoot = await resolveRequestedRepoRoot(context, toolId, requestedRoot);
  if (typeof resolvedRoot !== "string") {
    return { ok: false, result: resolvedRoot };
  }
  const repoRoot = resolvedRoot;

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
  const usesBoundContext = repoRoot === context.repoRoot;
  const configPath = (usesBoundContext ? context.configPath : null) ?? paths.configPath;
  const statePath = (usesBoundContext ? context.statePath : null) ?? paths.statePath;
  const config = (await safeReadConfig(configPath)) ?? (usesBoundContext ? context.config : null) ?? undefined;
  const state = (await safeReadState(statePath)) ?? (usesBoundContext ? context.state : null) ?? undefined;
  const dbPath = (usesBoundContext ? context.dbPath : null) ?? config?.dbPath ?? state?.dbPath ?? paths.dbPath;

  // M164. Two ways a repository can hold read authority, and only one of them
  // involves `vtrace init`.
  //
  // A repository that WAS initialized keeps its pre-M164 gate exactly: the
  // lifecycle files exist, so the state they persist is the thing to check, and
  // an initialized-but-not-ready workspace is still refused on its own record.
  //
  // A repository that was only ever INDEXED has no such record to consult, and
  // before M164 that absence was read as "not ready" — a false statement about a
  // valid index, and one the CLI never made about the same evidence. Its
  // authority is the index itself, evaluated live by the same M141 evaluator
  // every other surface already uses: repository identity, worktree identity,
  // schema/derivation compatibility, required capabilities, and source freshness.
  // That verdict is strictly more current than a stored one, and it is what makes
  // the negative states (stale, wrong revision, wrong worktree, incompatible
  // schema, corrupt, missing) keep refusing here. Coverage stays out of it, so an
  // M156 degraded-but-usable index remains usable.
  const lifecycleRecorded = config !== undefined || state !== undefined;

  if (lifecycleRecorded) {
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
  } else {
    // The evaluator's verdict is about the repo-local index. If some other
    // database was routed here, that verdict does not describe the file this
    // binding would open, so the pre-M164 refusal stands rather than a readiness
    // claim borrowed from a different index.
    if (dbPath !== paths.dbPath) {
      return {
        ok: false,
        result: repoNotReady(
          toolId,
          `Repository is not initialized for MCP use: ${repoRoot}`,
          {
            repoRoot,
            configPath,
            statePath,
            dbPath,
            repoLocalDbPath: paths.dbPath,
            reason: "db_path_override_without_init",
          },
        ),
      };
    }

    const indexReadiness = await evaluateIndexReadiness(repoRoot);
    // A repository with neither a lifecycle record nor an index has nothing for
    // index authority to speak about, and "not initialized" remains the accurate
    // and actionable thing to say about it. M164 changes what happens to
    // repositories that DO carry an index, and only those.
    if (indexReadiness.state === "index_missing") {
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
    if (!indexReadiness.ready) {
      return {
        ok: false,
        result: repoNotReady(
          toolId,
          `Repository index is not ready for MCP use: ${repoRoot}`,
          {
            repoRoot,
            readiness: summarizeIndexReadiness(indexReadiness),
            state: indexReadiness.state,
            reason: indexReadiness.reason,
            recommendedAction: indexReadiness.recommendedAction,
            failedDimensions: indexReadiness.failedDimensions,
          },
        ),
      };
    }
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

  // Hard fail-closed rule (M132 §49): an index that records a DIFFERENT worktree
  // root than the one this request routed to never answers the request. Silently
  // serving it is how a PR-worktree question gets answered with main's source.
  const mismatch = detectIndexWorktreeMismatch({
    routedRoot: repoRoot,
    indexedWorktreeRoot: (await readIndexMeta(repoRoot))?.manifest?.worktree?.root,
  });
  if (mismatch !== undefined) {
    return {
      ok: false,
      result: invalidRequest(toolId, mismatch.message, {
        reason: mismatch.reason,
        action: mismatch.action,
        requestedWorktree: mismatch.requestedWorktree,
        indexedWorktree: mismatch.activeIndex?.root ?? null,
      }),
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

/**
 * M152. Every MCP tool's access to storage, and the point where the two stores
 * are bound with different authority.
 *
 * `index.sqlite` opens READ-ONLY. No product tool has any business writing
 * repository evidence, and after the store split none of them needs to — so the
 * invariant §57 states is now enforced by the connection rather than asserted
 * about it. The session store is leased alongside and opened lazily: a tool that
 * persists nothing creates no file (§35).
 */
async function withReadyRepoDb<TOutput>(
  context: McpServerContext,
  toolId: McpToolId,
  execute: (
    binding: ReadyRepoBinding,
    db: ReturnType<typeof openProductIndexDatabase>,
    stores: ProductStoreLease,
  ) => Promise<McpToolExecutionResult<TOutput>> | McpToolExecutionResult<TOutput>,
  requestedRoot?: string,
): Promise<McpToolExecutionResult<TOutput>> {
  const resolved = await resolveReadyRepoBinding(context, toolId, requestedRoot);

  if (!resolved.ok) {
    return resolved.result;
  }

  let db: ReturnType<typeof openProductIndexDatabase>;
  try {
    db = openProductIndexDatabase(resolved.binding.dbPath);
  } catch (error) {
    return repoNotReady(
      toolId,
      `Repository index could not be opened for reading: ${resolved.binding.repoRoot}`,
      {
        repoRoot: resolved.binding.repoRoot,
        dbPath: resolved.binding.dbPath,
        detail: error instanceof Error ? error.message : String(error),
      },
    );
  }

  const lease = new ProductStoreLease(db, resolved.binding.dbPath);

  try {
    // A pre-M152 index still holds product/session tables. Reading it is safe;
    // treating it as authoritative is not, because new writes go to the session
    // store and the two would diverge. Refuse with the command that fixes it
    // rather than silently running a split-brain (§79, §159, §160).
    const legacyTables = listLegacySessionTables(db);
    if (legacyTables.length > 0) {
      return repoNotReady(
        toolId,
        "Product/session state uses the pre-M152 mixed storage layout. "
        + "Run `vtrace index <repo>` to move it into session.sqlite; "
        + "no state is discarded.",
        {
          repoRoot: resolved.binding.repoRoot,
          dbPath: resolved.binding.dbPath,
          reason: "session_store_migration_required",
          action: "call_index_repo",
          legacyTableCount: legacyTables.length,
        },
      );
    }

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

    return await execute(resolved.binding, db, lease);
  } finally {
    lease.close();
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
  const registration = await inspectRegistrationStatus(spec);
  const ready = initialized
    && state?.readiness.status === "ready"
    && registration.status !== RegistrationStatus.Mismatch
    && registration.status !== RegistrationStatus.Unavailable;
  const indexReadiness = summarizeIndexReadiness(withRuntimeSignals(
    await evaluateIndexReadiness(spec.rootPath, { probe: "full" }),
    {
      observedSourceChanges: state?.observedFileChanges !== undefined,
      indexHasNoFiles: !indexPresent,
    },
  ));
  const freshness = await inspectIndexFreshness({
    repoRoot: spec.rootPath,
    lastIndexSnapshot: state?.lastIndexSnapshot,
    observedFileChanges: state?.observedFileChanges,
    fileWatcher: state?.fileWatcher,
    readiness: indexReadiness,
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
    indexReadiness,
    registration: registration.status,
    registrationMismatches: registration.mismatches,
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

/**
 * Compare the identity a workspace entry recorded at registration against the
 * repository at that path now. An entry that recorded nothing is `unrecorded`
 * and vouches for nothing — it must not be reported as verified, and it must not
 * be treated as a mismatch either.
 */
async function inspectRegistrationStatus(
  spec: ResolvedWorkspaceRepoConfig,
): Promise<{ status: RegistrationStatus; mismatches: readonly string[] }> {
  try {
    const identity = await resolveWorktreeIdentity(spec.rootPath);
    const mismatches = compareRecordedIdentity(spec, identity);

    return mismatches === null
      ? { status: RegistrationStatus.Unrecorded, mismatches: [] }
      : mismatches.length === 0
        ? { status: RegistrationStatus.Verified, mismatches: [] }
        : { status: RegistrationStatus.Mismatch, mismatches };
  } catch {
    return { status: RegistrationStatus.Unavailable, mismatches: ["root_unresolvable"] };
  }
}

function hasMultiRepoRequest(
  selection: WorkspaceRepoSelection,
  requestedAliases?: readonly string[],
): boolean {
  return selection.isWorkspace || (requestedAliases !== undefined && requestedAliases.length > 0);
}

/**
 * M151: choose the repository a product request concerns, before anything opens
 * an index.
 *
 * This replaces a gate that refused every workspace outright. The refusal tested
 * whether a workspace EXISTED rather than what the request asked for, so it fired
 * with no `repos` argument and with exactly one alias alike, and the remediation
 * it advised ("omit repos or select exactly one") could not be performed.
 *
 * The route it returns is bound to a member's own root, and the caller rebinds to
 * that root before `withReadyRepoDb`. Everything downstream — orchestration,
 * product assembly, freshness, observations — then runs unchanged against one
 * repository, which is what keeps a single response from describing two.
 */
async function resolveProductRouteForRequest(
  context: McpServerContext,
  toolId: McpToolId,
  request: {
    readonly query: string;
    readonly requestedRoot?: string | undefined;
    readonly repos?: readonly string[] | undefined;
    readonly includeSupporting?: boolean | undefined;
  },
): Promise<
  | { ok: true; route: ProductRoute }
  | { ok: false; result: McpToolExecutionResult<never> }
> {
  if (context.repoRoot === null) {
    return {
      ok: false,
      result: repoNotReady(toolId, `MCP tool ${toolId} requires a repo-bound server context.`),
    };
  }

  const repos = request.repos ?? [];
  if (repos.length > 1) {
    return {
      ok: false,
      result: invalidRequest(
        toolId,
        "Selecting several repositories explicitly is not supported. Name one repository, "
        + "or omit `repos` and pass include_supporting_repos to let routing compose bounded support.",
        { requestedRepos: [...repos] },
      ),
    };
  }

  const route = await resolveProductRoute({
    boundRepoRoot: context.repoRoot,
    ...(request.requestedRoot === undefined ? {} : { requestedRoot: request.requestedRoot }),
    ...(repos.length === 0 ? {} : { requestedAliases: repos }),
    query: request.query,
    ...(request.includeSupporting === undefined
      ? {}
      : { includeSupporting: request.includeSupporting }),
  });

  if (route.lead !== null) {
    return { ok: true, route };
  }

  // No lead. The two failures are different facts and are reported as such: a
  // request that under-specifies which member it concerns is answerable once it
  // says, while a workspace whose members are all refused is not answerable at
  // all until an index is repaired. Neither is phrased as an absence of the
  // target from source code (§82).
  const failure = route.explicitSelectionFailure;
  const details = {
    workspaceRouting: formatProductRoutingMetadata(route.routing),
    // An explicit selection that did not resolve keeps naming the alias it did
    // not recognise and the ones it knows. That contract predates M151 and
    // callers depend on it.
    ...(failure === null
      ? { availableRepos: route.registry.repositories.map((repo) => repo.alias).slice(0, 8) }
      : {
        requestedRepos: [...repos],
        unknownRepos: [...failure.unknownRepos],
        availableRepos: [...failure.availableRepos],
        routeReason: failure.reason,
      }),
  };

  return {
    ok: false,
    result: route.outcome === ProductRouteOutcome.NoUsableMember
      ? repoNotReady(toolId, route.routing.reason, details)
      : invalidRequest(toolId, route.routing.reason, details),
  };
}

/**
 * Add bounded context from repositories routing nominated as SUPPORTING.
 *
 * The lead's response arrives already assembled by the ordinary pipeline and is
 * returned unchanged when nothing supports it — which is every default request,
 * because supporters are only ever discovered when the caller opted in. That is
 * what makes "another member exists" unable to alter the lead's answer.
 *
 * Supporters are opened READ-ONLY and merged by the workspace layer's own
 * allocator, so there is one cross-repository budget and one provenance rule
 * rather than a second copy of either here (§43, §55).
 */
async function composeSupportingRepositories(input: {
  readonly route: ProductRoute;
  readonly leadContext: ProductContextResponse;
  readonly task: string;
  readonly intent: CapsuleIntent;
  readonly budgetTokens: number;
}): Promise<{
  readonly context: ProductContextResponse;
  readonly perRepository: readonly {
    alias: string;
    itemsSelected: number;
    tokens: number;
    itemsOmitted: number;
  }[];
}> {
  if (input.route.supporting.length === 0) {
    return { context: input.leadContext, perRepository: [] };
  }

  const contributions = [{ alias: input.route.lead!.alias, response: input.leadContext }];
  const handles: Database[] = [];
  const supporterLeases: ProductStoreLease[] = [];

  try {
    for (const supporter of input.route.supporting) {
      let db: Database;
      try {
        // READ-ONLY: a supporting repository is not the request's target and a
        // read path may not write to its index (§21, §90).
        db = new Database(resolveIndexDbPath(supporter.rootPath), { readonly: true });
      } catch {
        continue;
      }
      handles.push(db);
      // The supporter's OWN session store, read-only. Composing a supporter's
      // context surfaces the memory that supporter recorded, exactly as it did
      // when both halves shared one file — but `read` creates nothing, so being
      // nominated as a supporter never brings a session store into existence
      // (§35, §52, §89).
      const supporterStores = new ProductStoreLease(db, resolveIndexDbPath(supporter.rootPath));
      supporterLeases.push(supporterStores);
      contributions.push({
        alias: supporter.alias,
        response: await assembleProductContext({
          stores: supporterStores.read,
          repoRoot: supporter.rootPath,
          task: input.task,
          intent: input.intent,
          budgetTokens: input.budgetTokens,
        }),
      });
    }

    if (contributions.length === 1) {
      return { context: input.leadContext, perRepository: [] };
    }

    // ONE envelope across every contributing repository, never one per repo.
    const merged = mergeRepositoryContributions(contributions, input.leadContext, input.budgetTokens);

    return { context: merged.context, perRepository: merged.perRepository };
  } finally {
    for (const lease of supporterLeases) {
      lease.close();
    }
    for (const handle of handles) {
      try {
        handle.close();
      } catch {
        // A supporting handle that cannot close must not fail the request.
      }
    }
  }
}

/**
 * The model-visible routing record. Counts and bounded examples only: M149
 * removed member-by-member growth from the product layer, and serialising the
 * router's own state here would put it straight back (§15, §62).
 */
function formatProductRoutingMetadata(routing: ProductRoutingMetadata) {
  return {
    isWorkspace: routing.isWorkspace,
    outcome: routing.outcome,
    routeSource: routing.routeSource,
    reason: routing.reason,
    decidingTier: routing.decidingTier,
    leadRepository: routing.leadRepository,
    supportingRepositories: [...routing.supportingRepositories].slice(0, MAX_REPORTED_COVERAGE_EXAMPLES),
    supportersInspected: routing.supportersInspected,
    uniquenessProven: routing.uniquenessProven,
    coverage: {
      repositoriesRegistered: routing.repositoriesRegistered,
      repositoriesEnabled: routing.repositoriesEnabled,
      repositoriesReady: routing.repositoriesReady,
      repositoriesDeepProbed: routing.repositoriesDeepProbed,
      excludedNotReadyTotal: routing.excludedNotReadyTotal,
      excludedNotReadyOmitted: routing.excludedNotReadyOmitted,
      excludedNotReady: [...routing.excludedNotReady].slice(0, MAX_REPORTED_COVERAGE_EXAMPLES),
      candidates: [...routing.candidates].slice(0, MAX_REPORTED_COVERAGE_EXAMPLES),
      evidence: routing.coverage.map((entry) => ({
        capability: entry.capability,
        purpose: entry.purpose,
        scope: entry.scope,
        considered: entry.considered,
        answered: entry.answered,
        refusedWithoutEvidence: entry.refusedWithoutEvidence,
        omittedByBound: entry.omittedByBound,
        unknownOther: entry.unknownOther,
        complete: entry.complete,
        examples: [...entry.examples],
        examplesOmitted: entry.examplesOmitted,
      })),
    },
  };
}

function formatWorkspaceMetadata(selection: WorkspaceRepoSelection) {
  const configuredAliases = selection.workspaceConfig?.repos.map((repo) => repo.alias)
    ?? selection.statuses.map((repo) => repo.repoAlias);

  // M151: these were whole-workspace alias lists, so the block still grew with
  // member count even after the status records were bounded. The counts carry
  // the totals and the lists became bounded samples of them (§121).
  return {
    name: selection.workspaceConfig?.name ?? null,
    primaryRepoAlias: selection.workspaceConfig?.primaryRepoAlias ?? selection.selectedAliases[0] ?? "repo",
    selectedRepos: [...selection.selectedAliases].slice(0, MAX_REPORTED_COVERAGE_EXAMPLES),
    selectedReposTotal: selection.selectedAliases.length,
    configuredRepos: [...configuredAliases].slice(0, MAX_REPORTED_COVERAGE_EXAMPLES),
    configuredReposTotal: configuredAliases.length,
  };
}

/**
 * M151: the workspace census `index_status` reports, computed over every selected
 * member.
 *
 * Two things are deliberately kept apart.
 *
 * `omittedByBound` counts member DETAIL RECORDS that were not serialised. It is a
 * display bound and says nothing about how much of the workspace was accounted
 * for — `coverageComplete: true` alongside `omittedByBound: 996` is the normal
 * shape for a large healthy workspace, because all 1000 members were counted and
 * four were shown.
 *
 * `coverageComplete` is the epistemic claim: every selected member returned a
 * readiness answer. It goes false when a member's state could not be established
 * at all, never because the list was truncated.
 *
 * And neither one is a readiness verdict. Repository readiness stays per
 * repository, exactly as M141/M148 left it (§18, §81).
 */
function summarizeWorkspaceCoverage(statuses: readonly WorkspaceRepoStatus[]) {
  const enabled = statuses.filter((status) => status.enabled);
  const ready = statuses.filter((status) => status.readiness?.status === "ready" && status.initialized);
  const refused = enabled.filter((status) => status.readiness?.status !== "ready" || !status.initialized);
  // A member whose config/state could not be read at all never answered the
  // readiness question, so the census cannot claim to have covered it.
  const unsettled = statuses.filter((status) => status.readiness === null && !status.configPresent);

  return {
    registeredMembers: statuses.length,
    enabledMembers: enabled.length,
    readyMembers: ready.length,
    refusedMembers: refused.length,
    unsettledMembers: unsettled.length,
    coverageComplete: unsettled.length === 0,
    // Detail records not serialised. A serialization bound, not an evidence gap.
    omittedByBound: Math.max(0, statuses.length - MAX_REPORTED_COVERAGE_EXAMPLES),
    examplesEmitted: Math.min(statuses.length, MAX_REPORTED_COVERAGE_EXAMPLES),
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
    indexReadiness: status.indexReadiness,
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
  scope?: string;
  origin?: string;
  provenance?: unknown;
  semanticKey?: string;
  resultSemanticHash?: string;
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
    scope: observation.scope ?? null,
    origin: observation.origin ?? null,
    provenance: observation.provenance === undefined ? null : structuredClone(observation.provenance),
    semanticKey: observation.semanticKey ?? null,
    resultSemanticHash: observation.resultSemanticHash ?? null,
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
    compatibility: result.compatibility ?? {
      state: "provenance_incomplete",
      currentTruthEligible: false,
      reasons: ["legacy_provenance_missing"],
      repoMatch: null,
      worktreeMatch: null,
      sourceStateMatch: null,
      indexMatch: null,
      implementationCompatible: null,
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
  db: ReturnType<typeof openProductIndexDatabase>,
  repoRoot: string,
  input: BuildCapsuleInput,
) {
  const routedQuery = routeQuery(db, input.query!, {
    maxResults: input.maxResults ?? MCP_PIPELINE_DEFAULTS.maxResults,
  });
  const builderInput = makePipelineBuilderInput(routedQuery, input);
  const preparedAssembly = prepareCapsuleAssembly({
    classification: routedQuery.classification,
    builderInput,
  });
  const capsule = buildAuthoritativeProductRetrieval(db, repoRoot, {
    query: input.query!,
    preset: productPresetForQueryIntent(routedQuery.intent),
    maxBudgetCharacters: input.maxBudgetCharacters ?? MCP_PIPELINE_DEFAULTS.maxBudgetCharacters,
  }).capsule;

  return {
    routedQuery,
    preparedAssembly,
    capsule,
  };
}

function productPresetForQueryIntent(intent: QueryIntent) {
  switch (intent) {
    case QueryIntent.Debug:
      return RunPipelinePresetIntent.Debug;
    case QueryIntent.Refactor:
      return RunPipelinePresetIntent.Refactor;
    case QueryIntent.Modify:
      return RunPipelinePresetIntent.Modify;
    default:
      return RunPipelinePresetIntent.Explore;
  }
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
  db: ReturnType<typeof openProductIndexDatabase>,
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
  db: ReturnType<typeof openProductIndexDatabase>,
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

  const finalPipeline = primaryPipeline;
  const finalContextItemCount = countUsefulContextItems(finalPipeline.capsule);

  return {
    pipeline: finalPipeline,
    diagnostics: {
      initialReason,
      fallbackApplied: false,
      fallbackMode: null,
      fallbackRecovered: false,
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

// Best-effort wrapper: accounting is additive and must never fail the tool
// response, so any error collapses to `undefined` (the field is then omitted).
async function buildContextAccountingBestEffort(
  input: Parameters<typeof buildContextAccounting>[0],
): Promise<ContextAccounting | undefined> {
  try {
    return await buildContextAccounting(input);
  } catch {
    return undefined;
  }
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

    const db = openProductIndexDatabase(status.binding.dbPath);

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
      stores.close();
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

    // Read-only, exactly like the single-repository path: an explicitly selected
    // member is queried, not reindexed. Each member gets its OWN session store,
    // so state derived from repository A can never land in repository B (§51, §88).
    const db = openProductIndexDatabase(status.binding.dbPath);
    const stores = new ProductStoreLease(db, status.binding.dbPath);

    try {
      if (!hasIndexedFiles(db)) {
        perRepo.push(makeSkippedRetrievalSummary(status, "index_empty"));
        continue;
      }

      const orchestration = runPipelineOrchestrator(stores.write, status.binding.repoRoot, {
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
      stores.close();
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
      skipReason: "not_requested_by_intent",
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
  // Ordered ahead of readiness on purpose: when a different repository occupies
  // the registered path, "not ready" would be a true statement about the wrong
  // question. The index may well be pristine — for the repository that left.
  if (status.registration === RegistrationStatus.Unavailable) {
    return "repo_path_unavailable";
  }
  if (status.registration === RegistrationStatus.Mismatch) {
    return "repo_identity_mismatch";
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

/**
 * The installed physical access capability, read from the database catalogue.
 *
 * Opened read-only and closed immediately: `index_status` is a read surface, and
 * a status call that silently installed an index would make the migration
 * implicit exactly where M146-A made the lifecycle explicit. An index that
 * cannot be opened reports `unknown` rather than guessing `fallback`.
 */
function readIndexAccessCapability(dbPath: string): IndexAccessCapabilityState | null {
  let db: ReturnType<typeof openProductIndexDatabase> | null = null;
  try {
    db = openProductIndexDatabase(dbPath);
    return inspectIndexAccessCapability(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
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
  indexReadiness: IndexReadinessSummary;
  freshness: unknown;
  watcher: unknown;
  performance: import("../indexer/incrementalIndex").IndexPerformanceDiagnostics | null;
  accessCapability: IndexAccessCapabilityState | null;
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
  // The same evaluation `get_code_context` uses. `index_status` must never
  // report a usable index that the next product request would refuse.
  const indexReadiness = summarizeIndexReadiness(withRuntimeSignals(
    await evaluateIndexReadiness(context.repoRoot, { probe: "full" }),
    {
      observedSourceChanges: state?.observedFileChanges !== undefined,
      indexHasNoFiles: !indexPresent,
    },
  ));
  const freshness = await inspectIndexFreshness({
    repoRoot: context.repoRoot,
    lastIndexSnapshot: state?.lastIndexSnapshot,
    observedFileChanges: state?.observedFileChanges,
    fileWatcher: state?.fileWatcher,
    readiness: indexReadiness,
  });
  const indexMeta = await readIndexMeta(context.repoRoot);

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
    indexReadiness,
    freshness,
    watcher: buildFileWatcherStatus(state),
    performance: indexMeta?.manifest?.performance ?? null,
    // M148-A. A PERFORMANCE capability, reported beside readiness rather than
    // inside it: `fallback` answers the same membership questions with the same
    // rows, so folding it into `ready` would refuse a correct index over a query
    // plan. Read from the catalogue, read-only — `index_status` never migrates.
    accessCapability: dbPresent ? readIndexAccessCapability(dbPath) : null,
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
      // Resolving a persisted ref updates its last-accessed timestamp: a
      // session write, never an index one, so the index is not opened here at
      // all. A repository that has never persisted a ref has no store to
      // consult, and asking is not a reason to create one (§35, §76).
      const persistentStore = resolvedBinding.ok
        ? SessionStore.forIndexDb(resolvedBinding.binding.dbPath)
        : undefined;
      const persistentDb = persistentStore?.exists === true
        ? persistentStore.writeSession()
        : undefined;
      const resolution = (() => {
        try {
          return resolveDeferredVexpRef({
            hash: rawHash,
            store,
            ...(persistentDb === undefined ? {} : { db: persistentDb }),
          });
        } finally {
          persistentStore?.close();
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

  const db = openProductIndexDatabase(resolved.binding.dbPath);
  const lease = new ProductStoreLease(db, resolved.binding.dbPath);

  try {
    if (!hasIndexedFiles(db)) {
      return;
    }

    const currentContext = await resolveCurrentObservationContext(resolved.binding.repoRoot);
    captureExpandVexpRefObservationBestEffort({
      stores: lease.write,
      repoRoot: resolved.binding.repoRoot,
      sourceRunId: getLatestIndexRun(db)?.id ?? null,
      toolName: McpToolId.ExpandVexpRef,
      requestedHash: output.requestedHash,
      resolved: output.resolved,
      stableId: output.stableId,
      category: output.category,
      currentContext,
    });
  } finally {
    lease.close();
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
    lock: { status: "released"; staleLockRecovered: boolean };
    performance: import("../indexer/incrementalIndex").IndexPerformanceDiagnostics | null;
    indexReadiness: IndexReadinessSummary;
    outcomes: BoundedIndexOutcomes;
    fileOutcomes: IndexProjectResult["files"];
    generatedStateExclusion: GeneratedStateExclusionResult;
  }>({
    metadata: {
      toolId: McpToolId.IndexRepo,
      displayName: "Index Repo",
      description:
        "Refresh the Vtrace repo index. Use this when get_code_context or another Vtrace tool reports stale_index, missing_index, or repo_not_ready.",
      inputSchema: objectSchema(
        "Optional controls for indexing a concrete Git worktree.",
        {
          force: booleanProperty("Accepted for future compatibility; currently re-indexing always runs."),
          repo_root: REPO_ROOT_PROPERTY,
          mode: stringProperty("Refresh mode: auto (default), incremental, or full."),
          detail: stringProperty("Outcome detail: summary (default, bounded) or debug (larger bounded sample)."),
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
          lock: objectProperty(
            "Worktree-specific indexing lock outcome.",
            {
              status: stringProperty("released after a completed index operation."),
              staleLockRecovered: booleanProperty("Whether a dead process lock was recovered."),
            },
            ["status", "staleLockRecovered"],
          ),
          performance: { type: ["object", "null"], description: "Incremental planning, cache, closure, fallback, and timing diagnostics.", additionalProperties: true },
          indexReadiness: INDEX_READINESS_SCHEMA,
          outcomes: INDEX_OUTCOMES_SCHEMA,
          fileOutcomes: arrayProperty("Bounded notable file outcomes (failures, warnings, meaningful skips). Ordinary successes are summarized in `outcomes.counts`, never listed. See `outcomes.detail` for exact omitted counts.", {
            type: "object",
            properties: {
              path: stringProperty("Normalized repo-relative path."),
              language: stringProperty("Detected source language."),
              status: stringProperty("Indexed, skipped capability, or failure status."),
              diagnostics: { type: "array", items: { type: "object", additionalProperties: true } },
              error: { type: "object", additionalProperties: true },
            },
            required: ["path", "language", "status", "diagnostics"],
            additionalProperties: false,
          }),
          generatedStateExclusion: objectProperty(
            "What indexing did about vtrace's own generated state being stageable by `git add -A`. Local and untracked: no tracked project file and no global Git configuration is ever modified.",
            {
              status: stringProperty("established | already_ignored | not_a_git_repository | tracked_paths_present | unavailable."),
              pattern: { type: ["string", "null"], description: "Root-anchored ignore pattern that applies, or null." },
              excludeFilePath: { type: ["string", "null"], description: "Local exclude file consulted or written. In a linked worktree this is the SHARED common-dir file, the only one Git reads." },
              wroteFile: booleanProperty("True only when this call wrote bytes. False on every repeat."),
              ignoredBy: { type: ["string", "null"], description: "Pre-existing rule already covering the directory, when one does." },
              trackedPaths: arrayProperty("Tracked paths under .vtrace/, bounded. Non-empty only when vtrace refused.", stringProperty("Repo-relative path.")),
              remediation: { type: ["string", "null"], description: "Set whenever generated state is still stageable. Surface it." },
            },
            ["status", "pattern", "excludeFilePath", "wroteFile", "ignoredBy", "trackedPaths", "remediation"],
          ),
        },
        ["repoRoot", "latestRunId", "readiness", "indexSummary", "latestRun", "lock", "performance", "indexReadiness", "outcomes", "fileOutcomes", "generatedStateExclusion"],
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
      const mode = parseOptionalStringField(McpToolId.IndexRepo, input, "mode") ?? "auto";
      if (typeof mode !== "string") return mode;
      if (mode !== "auto" && mode !== "incremental" && mode !== "full") {
        return invalidRequest(McpToolId.IndexRepo, "mode must be `auto`, `incremental`, or `full`.", { field: "mode", value: mode });
      }
      const detail = parseOptionalStringField(McpToolId.IndexRepo, input, "detail") ?? "summary";
      if (typeof detail !== "string") return detail;
      if (detail !== "summary" && detail !== "debug") {
        return invalidRequest(McpToolId.IndexRepo, "detail must be `summary` or `debug`.", { field: "detail", value: detail });
      }
      const requestedRoot = parseOptionalStringField(McpToolId.IndexRepo, input, "repo_root");
      if (requestedRoot !== undefined && typeof requestedRoot !== "string") {
        return requestedRoot;
      }
      const repoRoot = await resolveRequestedRepoRoot(context, McpToolId.IndexRepo, requestedRoot);
      if (typeof repoRoot !== "string") {
        return repoRoot;
      }
      const paths = resolveRepoLocalPaths(repoRoot);
      const config = await safeReadConfig(paths.configPath);
      const stateBefore = await safeReadState(paths.statePath);
      let state: RepoLocalState | null;
      let staleLockRecovered = false;
      let performance: import("../indexer/incrementalIndex").IndexPerformanceDiagnostics | null = null;
      let indexResult: IndexProjectResult;
      try {
        if (config === undefined || stateBefore === undefined) {
          const initialized = await initRepo({ repoPath: repoRoot });
          state = initialized.state;
          indexResult = initialized.indexResult;
          performance = indexResult.performance ?? null;
        } else {
          const indexed = await reindexRepoAndRefreshState({
            repoRoot,
            dbPath: config.dbPath ?? stateBefore.dbPath ?? paths.dbPath,
            statePath: paths.statePath,
            configPresent: true,
            statePresent: true,
            usesDbPathOverride: false,
            refreshMode: mode,
          });
          state = indexed.state;
          indexResult = indexed.indexResult;
          staleLockRecovered = indexed.staleLockRecovered;
          performance = indexed.indexResult.performance ?? null;
        }
      } catch (error) {
        if (error instanceof IndexingFileFailuresError) {
          return failure(McpErrorCode.HandlerFailed, error.message, {
            reason: "file_index_failed",
            repoRoot,
            failures: error.failures,
          });
        }
        if (error instanceof WorktreeIndexLockError) {
          // Bounded by construction (§68): acquisition returns rather than
          // waits, and the response names the claim that blocked it so the
          // caller can tell "someone is indexing this" from "a stale artifact".
          return failure(McpErrorCode.HandlerFailed, error.message, {
            reason: error.code,
            action: "retry",
            repoRoot,
            lockOwner: { pid: error.owner.pid, worktreeId: error.owner.worktreeId },
            waitedMs: error.waitedMs,
          });
        }
        throw error;
      }

      if (state === null) {
        return repoNotReady(McpToolId.IndexRepo, `Index state was not persisted for ${repoRoot}.`);
      }

      // Post-index status comes from the SAME readiness evaluator every other
      // surface uses. index_repo must never construct an independent optimistic
      // success verdict for the index it just wrote.
      const indexReadiness = summarizeIndexReadiness(withRuntimeSignals(
        await evaluateIndexReadiness(repoRoot, { probe: "full" }),
        { indexHasNoFiles: state.latestRunId === null },
      ));
      const outcomes = summarizeIndexOutcomes(
        { files: indexResult.files, performance },
        { mode: detail === "debug" ? "debug" : "summary" },
      );

      // M154-B. `initRepo` establishes this on a first index, but a repository
      // initialized before the exclusion existed reaches this handler through
      // the reindex branch and would never gain it. Re-asserting is idempotent
      // and writes nothing when a rule already covers the directory.
      const generatedStateExclusion = await ensureGeneratedStateExcluded(repoRoot);

      return {
        ok: true,
        output: {
          repoRoot,
          generatedStateExclusion,
          latestRunId: state.latestRunId,
          readiness: state.readiness,
          indexSummary: state.indexSummary,
          latestRun: state.latestRun ?? null,
          lock: { status: "released", staleLockRecovered },
          performance,
          indexReadiness,
          outcomes,
          // Bounded by policy: notable outcomes only. The complete per-file
          // record stays in the index; the response does not carry it.
          fileOutcomes: [...outcomes.detail.outcomes],
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
        async (_binding, db, stores) => {
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
        async (binding, db, stores) => {
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
        async (binding, db, stores) => {
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
        async (_binding, db, stores) => {
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
        async (_binding, db, stores) => {
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
          repo_root: REPO_ROOT_PROPERTY,
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
      const requestedRoot = parseOptionalStringField(McpToolId.CheckCapsuleStaleness, input, "repo_root");

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
      if (requestedRoot !== undefined && typeof requestedRoot !== "string") {
        return requestedRoot;
      }

      return withReadyRepoDb(
        context,
        McpToolId.CheckCapsuleStaleness,
        async (_binding, db, stores) => {
          const manifest = getCapsuleManifestById(stores.read.session, manifestId);

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
            const staleness = getCapsuleStaleness(stores.read, manifestId, comparisonRunId)!;

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
        requestedRoot,
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
          scope: stringProperty("Observation scope: global, repository, worktree, source_state, or index_state."),
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
      const scope = parseOptionalStringField(McpToolId.SaveObservation, input, "scope");
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
      if (scope !== undefined && (typeof scope !== "string" || !Object.values(ObservationScope).includes(scope))) {
        return invalidRequest(McpToolId.SaveObservation, `scope must be one of: ${Object.values(ObservationScope).join(", ")}`);
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
        async (binding, db, stores) => {
          try {
            const currentContext = await resolveCurrentObservationContext(binding.repoRoot);
            const resolvedScope = scope ?? (
              toolName !== undefined || (linkedFilePaths?.length ?? 0) > 0
                || (linkedSymbolIds?.length ?? 0) > 0 || (linkedFqNames?.length ?? 0) > 0
                ? ObservationScope.IndexState
                : ObservationScope.Repository
            );
            const provenance = buildObservationProvenance({
              context: currentContext,
              toolName,
              queryText,
              semanticOptions: intent === undefined ? {} : { intent },
            });
            const observation = persistObservation(stores.write, {
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
              scope: resolvedScope,
              origin: ObservationOrigin.Manual,
              provenance,
              linkedFilePaths,
              linkedSymbolIds,
              linkedFqNames,
            });
            const formattedSearchResult = formatObservationSearchResult({
              observation,
              staleness: getObservationStaleness(db, observation),
              compatibility: classifyObservationCompatibility(observation, currentContext),
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
      description: "Search current-compatible observation memory using deterministic lexical, structural, and provenance signals.",
      inputSchema: objectSchema(
        "Observation memory search input.",
        {
          query: stringProperty("Search query text."),
          maxResults: integerProperty("Maximum number of results to return."),
          sessionId: stringProperty("Optional session filter."),
          linkedFilePaths: arrayProperty("Optional linked repo-relative file paths.", stringProperty("File path.")),
          linkedSymbolIds: arrayProperty("Optional linked persisted symbol ids.", stringProperty("Symbol id.")),
          repos: arrayProperty("Optional workspace repo aliases to search.", stringProperty("Repo alias.")),
          includeStale: booleanProperty("Include stale, foreign, and provenance-incomplete historical evidence with labels."),
        },
        ["query"],
      ),
      outputSchema: objectSchema(
        "Observation memory search results.",
        {
          query: stringProperty("Original search query."),
          selectedRepos: arrayProperty("Selected repo aliases for a multi-repo memory search.", stringProperty("Repo alias.")),
          results: arrayProperty("Ranked observation results.", OBSERVATION_SEARCH_RESULT_SCHEMA),
          accounting: {
            type: "object",
            description: "Compact freshness filtering accounting.",
            additionalProperties: true,
          },
          conflicts: arrayProperty("Conflicting supposedly-current structured observations.", {
            type: "object",
            additionalProperties: true,
          }),
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
      const includeStale = parseOptionalBoolean(McpToolId.SearchMemory, input, "includeStale");

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
      if (includeStale !== undefined && typeof includeStale !== "boolean") {
        return includeStale;
      }

      const selection = await resolveWorkspaceRepoSelection(context, McpToolId.SearchMemory, repos);

      if (!selection.ok) {
        return selection.result;
      }

      if (hasMultiRepoRequest(selection.selection, repos)) {
        const results: Array<ReturnType<typeof formatObservationSearchResult>> = [];
        const accounting = { matchedCurrent: 0, suppressedStale: 0, suppressedForeign: 0, provenanceIncomplete: 0 };
        const conflicts: unknown[] = [];

        for (const status of selection.selection.statuses) {
          if (status.binding === undefined) {
            continue;
          }

          const db = openProductIndexDatabase(status.binding.dbPath);
          // Each member answers from its OWN session store. Memory has never
          // been shared across repositories and physical separation is what
          // enforced that; the split preserves it exactly (§88, §93).
          const memberStores = new ProductStoreLease(db, status.binding.dbPath);

          try {
            if (!hasIndexedFiles(db)) {
              continue;
            }

            const currentContext = await resolveCurrentObservationContext(status.binding.repoRoot);
            const searched = searchMemoryDetailed(memberStores.read, {
                query,
                maxResults,
                sessionId,
                linkedFilePaths,
                linkedSymbolIds,
                currentContext,
                includeStale,
              });
            results.push(...searched.results.map((result) => formatObservationSearchResult(result, status.repoAlias)));
            for (const key of Object.keys(accounting)) accounting[key] += searched.accounting[key];
            conflicts.push(...searched.conflicts);
          } finally {
            memberStores.close();
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
            accounting,
            conflicts,
          },
        };
      }

      return withReadyRepoDb(
        context,
        McpToolId.SearchMemory,
        async (binding, db, stores) => {
          const currentContext = await resolveCurrentObservationContext(binding.repoRoot);
          const searched = searchMemoryDetailed(stores.read, {
            query,
            maxResults,
            sessionId,
            linkedFilePaths,
            linkedSymbolIds,
            currentContext,
            includeStale,
          });
          const results = [...searched.results];

          captureSearchMemoryObservationBestEffort({
            stores: stores.write,
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
            currentContext,
          });

          return {
            ok: true,
            output: {
              query,
              results: results.map(formatObservationSearchResult),
              accounting: searched.accounting,
              conflicts: searched.conflicts,
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
          includeStale: booleanProperty("Include stale and provenance-incomplete observations with compatibility labels."),
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
          observationCompatibility: {
            type: "object",
            description: "Compatibility classification keyed by returned observation id.",
            additionalProperties: true,
          },
          suppressedObservationCount: integerProperty("Matching recent observations suppressed by current-context safety."),
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
      const includeStale = parseOptionalBoolean(McpToolId.GetSessionContext, input, "includeStale");

      if (sessionId !== undefined && typeof sessionId !== "string") {
        return sessionId;
      }
      if (limit !== undefined && typeof limit !== "number") {
        return limit;
      }
      if (query !== undefined && typeof query !== "string") {
        return query;
      }
      if (includeStale !== undefined && typeof includeStale !== "boolean") {
        return includeStale;
      }

      return withReadyRepoDb(
        context,
        McpToolId.GetSessionContext,
        async (binding, db, stores) => {
          const currentContext = await resolveCurrentObservationContext(binding.repoRoot);
          const contextResult = getSessionContext(stores.read, {
            sessionId,
            limit,
            query,
            includeStale,
            currentContext,
          });
          const linkedObservations = [
            ...contextResult.observations,
            ...(contextResult.rankedObservations ?? []),
          ];

          captureSessionContextObservationBestEffort({
            stores: stores.write,
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
            currentContext,
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
              observationCompatibility: contextResult.compatibilityByObservationId ?? {},
              suppressedObservationCount: contextResult.suppressedObservationCount ?? 0,
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
        async (_binding, db, stores) => ({
          ok: true,
          output: {
            sessions: listInspectableSessions(stores.read.session).map(formatSessionListItem),
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
        async (_binding, db, stores) => {
          const sessionResult = readInspectableSession(stores.read, sessionId);

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

// Capsule v2 product item (pivot or support) as the MCP surface reports it.
// Declared here (above RUN_PIPELINE_TOOL_DEFINITION) so the opt-in v2 sections of
// both run_pipeline/get_code_context and get_context_capsule share one schema.

// Deterministic product-path accounting. Additive and optional: present when the
// best-effort accounting succeeds, omitted on the rare failure or on multi-repo
// paths. Every figure is an estimate (chars/4), never a tokenizer count. Shared
// by run_pipeline/get_code_context and get_context_capsule (v1 and v2).
const CONTEXT_ACCOUNTING_SCHEMA = objectProperty(
  "Deterministic, estimated (chars/4) token + latency accounting for the emitted context. Not exact tokenizer truth.",
  {
    latencyMs: numberProperty("Wall-clock latency of the measured tool/orchestrator path, in milliseconds."),
    estimatedOutputTokens: integerProperty("Estimated token cost (chars/4) of the actual emitted product response."),
    estimatedNaiveFullFileTokens: integerProperty("Estimated token cost (chars/4) of reading the full contents of every unique file the emitted context represents."),
    estimatedTokensSavedVsNaiveFullFile: integerProperty("Naive full-file estimate minus emitted estimate, clamped at 0."),
    estimatedSavingsPercentVsNaiveFullFile: {
      type: ["number", "null"],
      description: "Percent reduction vs. the naive full-file baseline; null when no files were counted.",
    },
    uniqueFilesCounted: integerProperty("Count of unique files actually read for the naive baseline."),
    method: stringProperty("Estimation method. Always `chars_div_4` — an approximation, not a tokenizer."),
    baseline: stringProperty("Explicit wording of the naive comparison baseline."),
    ref: stringProperty("Field carrying the authoritative accounting, when this block was reduced to a reference."),
    skippedFiles: arrayProperty(
      "Files that could not be counted (missing/unreadable/outside repo), when any.",
      objectProperty(
        "A file skipped while computing the naive baseline.",
        {
          path: stringProperty("Repo-relative file path."),
          reason: stringProperty("Why the file was skipped."),
        },
        ["path", "reason"],
      ),
    ),
  },
  // Only latency is guaranteed. Response compaction may reduce this block to
  // `{latencyMs, ref}` when productContext.accounting already carries the same
  // figures and the total-response budget is tight (M130).
  ["latencyMs"],
);

// M130 complete-response budgeting. `max_tokens` bounds the model-visible context;
// this block reports the SECOND, distinct measurement — the whole serialized
// result — and what deterministic compaction was applied to keep it in the
// documented envelope.
const RESPONSE_BUDGET_SCHEMA = objectProperty(
  "Complete-response budget accounting. Model-visible context and total serialized response are measured separately; both figures are chars/4 estimates, never tokenizer counts.",
  {
    envelopeVersion: stringProperty("Response-envelope contract version."),
    requested_context_tokens: integerProperty("The caller's max_tokens context budget."),
    estimated_model_visible_tokens: integerProperty("Estimated tokens of productContext.modelVisibleContext — the only source-bearing field."),
    estimated_metadata_tokens: integerProperty("Estimated tokens of everything else in the response."),
    estimated_total_response_tokens: integerProperty("Estimated tokens of the complete serialized result."),
    total_response_token_ceiling: integerProperty("Documented ceiling: requested tokens plus a metadata allowance of max(1000, 15%)."),
    serialized_response_characters: integerProperty("Exact character length of the complete serialized result."),
    within_envelope: booleanProperty("Whether the complete response fits the documented ceiling."),
    compaction_applied: booleanProperty("Whether deterministic compaction ran because the bounded default shape still exceeded the ceiling."),
    compacted_fields: arrayProperty("Fields reduced to references or counts, in deterministic order.", stringProperty("Field path.")),
    omitted_detail_counts: { type: "object", description: "What was omitted and how much of it.", additionalProperties: true },
    expansion_available: { type: "object", description: "Where omitted detail can be obtained instead.", additionalProperties: true },
    diagnostics_detail: stringProperty("Applied detail level: compact, standard, or debug."),
    estimate_method: stringProperty("Always `chars_div_4` — an approximation, not a tokenizer."),
    notes: arrayProperty("Boundary statements about these figures.", stringProperty("Note.")),
  },
  [
    "envelopeVersion",
    "requested_context_tokens",
    "estimated_model_visible_tokens",
    "estimated_metadata_tokens",
    "estimated_total_response_tokens",
    "total_response_token_ceiling",
    "serialized_response_characters",
    "within_envelope",
    "compaction_applied",
    "compacted_fields",
    "diagnostics_detail",
    "estimate_method",
  ],
);

/**
 * M151: which repository answered, and how much of the workspace that rests on.
 *
 * Additive and optional — a consumer that ignores it reads `productContext` and
 * the capsule exactly as before (§41, §86). Everything here is a count or a
 * bounded example list, so the block's size does not grow with the workspace
 * (§15, §51, §62).
 */
const WORKSPACE_EVIDENCE_COVERAGE_SCHEMA: McpSchemaProperty = objectProperty(
  "What one routing lane actually covered. Verdicts come from the full totals; `examples` is a bounded sample.",
  {
    capability: stringProperty("Evidence capability this scan used."),
    purpose: stringProperty("`deciding` when the lane could choose a repository, `support` when it only gathered context."),
    scope: stringProperty("The population the scan claims to cover."),
    considered: integerProperty("Members in that population."),
    answered: integerProperty("Members that returned a trustworthy answer."),
    refusedWithoutEvidence: integerProperty("Members whose index this runtime refused. Repair the index."),
    omittedByBound: integerProperty("Members the scan bound never reached. Raise the bound."),
    unknownOther: integerProperty("Ready, but unanswerable for another reason."),
    complete: booleanProperty("True only when every considered member answered."),
    examples: arrayProperty(
      "Bounded examples. Never the population, and never the basis of a verdict.",
      objectProperty("One named member and why it is listed.", {
        alias: stringProperty("Workspace member alias."),
        reason: stringProperty("Why this member is an example."),
      }, ["alias", "reason"]),
    ),
    examplesOmitted: integerProperty("Members matching this example set that were not named."),
  },
  ["capability", "purpose", "scope", "considered", "answered", "complete"],
);

const WORKSPACE_ROUTING_SCHEMA: McpSchemaProperty = objectProperty(
  "M151 workspace routing provenance: which repository answered and what the routing scan covered. Absent for a request that resolved without a workspace.",
  {
    isWorkspace: booleanProperty("Whether a workspace config governed this request."),
    outcome: stringProperty("single_repository | explicit_member | routed | configured_member | abstained | no_usable_member."),
    routeSource: {
      type: ["string", "null"],
      description: "Which authority or evidence tier selected the lead repository.",
    },
    reason: stringProperty("Why routing reached this outcome. Never a claim about whether a target exists in source."),
    decidingTier: {
      type: ["string", "null"],
      description: "The evidence tier that decided, when evidence decided.",
    },
    leadRepository: {
      type: ["string", "null"],
      description: "Alias of the repository whose retrieval produced this response.",
    },
    supportingRepositories: arrayProperty(
      "Repositories contributing bounded supporting context. Empty unless the request opted in; an empty list is never a claim that no repository could support it — read `supportersInspected`.",
      stringProperty("Workspace member alias."),
    ),
    supportersInspected: booleanProperty("Whether supporting repositories were looked for at all."),
    uniquenessProven: booleanProperty("Whether the deciding lane proved no other member could hold the target. False when a member could not be checked; never an absence claim either way."),
    perRepository: arrayProperty(
      "Token accounting per contributing repository, present only when more than one contributed.",
      objectProperty("One repository's share of the single shared envelope.", {
        alias: stringProperty("Workspace member alias."),
        itemsSelected: integerProperty("Items this repository contributed."),
        tokens: integerProperty("Tokens this repository's items consumed."),
        itemsOmitted: integerProperty("Items this repository offered that the shared budget omitted."),
      }, ["alias", "itemsSelected", "tokens", "itemsOmitted"]),
    ),
    coverage: objectProperty(
      "Bounded workspace census for this request. Counts are authoritative; named lists are bounded samples.",
      {
        repositoriesRegistered: integerProperty("Members registered in the workspace."),
        repositoriesEnabled: integerProperty("Registered members that are enabled."),
        repositoriesReady: integerProperty("Enabled members whose index can currently answer."),
        repositoriesDeepProbed: integerProperty("Members whose index was opened read-only to prove a route."),
        excludedNotReadyTotal: integerProperty("Enabled members excluded because their index cannot answer."),
        excludedNotReadyOmitted: integerProperty("Excluded members not named in `excludedNotReady`."),
        excludedNotReady: arrayProperty(
          "Bounded examples of excluded members. A safety exclusion, never a relevance judgement.",
          objectProperty("One excluded member.", {
            alias: stringProperty("Workspace member alias."),
            reason: stringProperty("Why its index cannot answer."),
          }, ["alias", "reason"]),
        ),
        candidates: arrayProperty(
          "Bounded plausible set when routing could not decide.",
          stringProperty("Workspace member alias."),
        ),
        evidence: arrayProperty(
          "Per-lane coverage. At most one entry per lane that ran.",
          WORKSPACE_EVIDENCE_COVERAGE_SCHEMA,
        ),
      },
      ["repositoriesRegistered", "repositoriesEnabled", "repositoriesReady", "repositoriesDeepProbed"],
    ),
  },
  ["isWorkspace", "outcome", "reason", "leadRepository", "supportersInspected", "uniquenessProven", "coverage"],
);

const PRODUCT_CONTEXT_RESPONSE_SCHEMA: McpSchemaProperty = {
  type: "object",
  description: "Versioned M119 role-aware product context shared by get_code_context, get_context_capsule, and run_pipeline. It includes repository/freshness identity, deduplicated items, final model-visible text, approximate token accounting, and monotonic latency accounting.",
  properties: {
    responseVersion: integerProperty("Product response contract version; M119 emits 2."),
    resolved: booleanProperty("Whether fresh, usable model-visible context was delivered."),
    coverage: objectProperty(
      "What this answer settles. Bounded task-ranked selection, so an omitted symbol or file is UNSEARCHED, not absent: this lane cannot prove absence, and `resolved: false` means retrieval found nothing to deliver, never that no implementation exists. Use exact path/symbol lookup when you need that proof, and ordinary text search when you need enumeration.",
      {
        mode: stringProperty("Always `selective_task_retrieval`."),
        absenceClaim: stringProperty("Always `not_observed` — the weakest rung of the shared evidence scale (not_observed | bounded_absence | authoritative_absence)."),
        enumerationComplete: booleanProperty("Always false. Completeness is a property of the exact lanes, not of ranked retrieval."),
      },
      ["mode", "absenceClaim", "enumerationComplete"],
    ),
    resultState: stringProperty("Delivery-aware result: resolved, no_result, or delivery_failure."),
    retrievalFound: booleanProperty("Whether retrieval selected relevant evidence before budget delivery."),
    deliveryFailed: booleanProperty("True only when retrieval succeeded but no truthful representation fit."),
    topMatchReference: stringProperty("Compact top-match identity retained when full delivery fails, when available."),
    delivery: { type: "object", description: "Selected-versus-delivered counts and deterministic context-compaction stages.", additionalProperties: true },
    task: stringProperty("Normalized task text used by the shared assembler."),
    taskHash: stringProperty("Deterministic hash of the normalized task."),
    intent: stringProperty("Resolved capsule intent."),
    capsuleMode: stringProperty("Capsule mode shared by all three product paths."),
    leadPivot: { type: ["string", "null"], description: "Repository-relative lead-pivot path, or null." },
    selectedFileHash: stringProperty("Deterministic hash of unique selected source-file identities."),
    repository: { type: "object", description: "Repository, worktree, HEAD, branch, index-run, and index-mode identity.", additionalProperties: true },
    freshness: { type: "object", description: "M114 freshness status/reason plus M118 refresh diagnostics when applicable.", additionalProperties: true },
    accounting: { type: "object", description: "Final-render accounting and the unique-selected-full-file baseline. Character-ratio estimates are approximate.", additionalProperties: true },
    timing: { type: "object", description: "Nonnegative monotonic wall-clock stage timings in milliseconds.", additionalProperties: true },
    roleCounts: { type: "object", description: "Counts for pivot, required, support, skeleton, impact, memory, rule, and documentation roles.", additionalProperties: true },
    items: {
      type: "array",
      description: "Deterministically ordered, role-aware, source-body-deduplicated context items.",
      items: {
        type: "object",
        properties: {
          id: stringProperty("Compact deterministic display id such as P1 or S1."),
          stableId: stringProperty("Content-stable item identity for an identical task and index."),
          path: stringProperty("Repository-relative path when applicable."),
          symbol: stringProperty("Symbol or section identity when available."),
          roles: arrayProperty("One or more product-context roles.", stringProperty("Product-context role.")),
          contentMode: stringProperty("Focused/full source, excerpt, structural skeleton, signature, or summary."),
          selectionReasons: arrayProperty("Evidence-backed selection reasons.", stringProperty("Selection reason.")),
          estimatedTokens: integerProperty("Approximate chars/4 estimate for the emitted item."),
          content: stringProperty("Model-visible body when this item owns a unique emitted body."),
          metadata: { type: "object", description: "Role-specific bounded evidence and fallback metadata.", additionalProperties: true },
        },
        required: ["id", "stableId", "roles", "contentMode", "estimatedTokens"],
        additionalProperties: true,
      },
    },
    modelVisibleContext: stringProperty("Final deduplicated text measured by accounting and suitable for model injection. max_tokens bounds this field; lower-priority support may be compacted to preserve answer-bearing evidence."),
    omittedItemCount: integerProperty("Per-item metadata rows dropped by response compaction, when the selection itself outgrew the metadata allowance. The rendered context is unaffected."),
    diagnostics: { type: "object", description: "Limitations, caps, duplicate-suppression counts, and fallback diagnostics.", additionalProperties: true },
  },
  required: [
    "responseVersion", "resolved", "coverage", "task", "taskHash", "intent", "capsuleMode",
    "repository", "freshness", "accounting", "timing", "roleCounts", "items",
    "modelVisibleContext", "diagnostics",
  ],
  additionalProperties: true,
};

const CAPSULE_V2_PRODUCT_ITEM_SCHEMA = objectProperty(
  "A capsule pivot or support item.",
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
    evidence: arrayProperty("Ordered evidence: why this item was selected. Empty on the MCP surface: the same lines are productContext.items[].selectionReasons.", stringProperty("Evidence line.")),
    estimatedTokens: integerProperty("Estimated token cost of the rendered block."),
    isNonSourceExample: booleanProperty("True when the item is a docs/examples/fixture file."),
    contextItemId: {
      type: ["string", "null"],
      description: "Reference into productContext.items for this same selection, when resolvable. On the MCP surface `source`/`signature` are always null: the body is rendered once, in productContext.modelVisibleContext.",
    },
  },
  // Only identity, role and sizing are guaranteed. Response compaction may reduce
  // these rows to pure manifest references (M130); the authoritative per-item
  // record is productContext.items.
  [
    "role",
    "path",
    "fqName",
    "contentMode",
    "estimatedTokens",
  ],
);

// The bounded, deterministic product capsule response.
const CAPSULE_V2_PRODUCT_RESPONSE_SCHEMA = objectProperty(
  "Authoritative product capsule response.",
  {
    query: stringProperty("The task/query the capsule was built for (empty string when not supplied)."),
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
    summary: objectProperty(
      "Role/section counts for the VEXP-shaped first-call summary. impact/memory/rule counts present only when those sections are routed in (never fabricated).",
      {
        pivotCount: integerProperty("Number of pivot items."),
        supportCount: integerProperty("Number of support items."),
        skeletonCount: integerProperty("Items rendered without full source (signature/skeleton scaffolding)."),
        impactCount: integerProperty("Impact dependents, when an impact summary was routed in."),
        memoryCount: integerProperty("Session + durable memory entries, when a memory summary was routed in."),
        ruleCount: integerProperty("Active project rules, when a rules summary was routed in."),
      },
      ["pivotCount", "supportCount", "skeletonCount"],
    ),
    pivots: arrayProperty("Pivot items (focused edit targets).", CAPSULE_V2_PRODUCT_ITEM_SCHEMA),
    support: arrayProperty("Support items (compact context).", CAPSULE_V2_PRODUCT_ITEM_SCHEMA),
    warnings: arrayProperty(
      "Honest unavailable-data / bounded-content markers (e.g. no_pivot_recovered, pivot_source_bounded_to_signatures, impact_snippets_unavailable). Never fabricated; empty when nothing notable.",
      stringProperty("A warning marker."),
    ),
    supersededBy: stringProperty("Field carrying the authoritative per-item record, when response compaction reduced this manifest to counts and budget."),
    digest: stringProperty("Compact, deterministic agent-facing render using role glyphs (● pivot, ○ skel, → impact, ◎ memory, ◇ rule) with per-item why lines and a closing budget line. Carries no latency/clock data."),
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
        ref: stringProperty("Field carrying the equivalent diagnostics, when this block was reduced to a reference."),
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
      // Nothing is guaranteed: response compaction may reduce this block to
      // `{ref: "diagnostics.retrieval"}` under a tight total-response budget (M130).
      [],
    ),
    actionabilityHints: arrayProperty(
      "Bounded, evidence-backed reminders that a selected source file likely has a paired generated/co-edit artifact (e.g. a PLY parser table) the agent must regenerate or update alongside its edit. Advisory only; never derived from retrieval scoring or gold patches.",
      objectProperty(
        "A generated/co-edit artifact actionability hint.",
        {
          kind: stringProperty("`generated_artifact`, `co_edit_dependency`, or `multi_file_coedit`."),
          sourceFile: stringProperty("The selected source / lead-pivot file the agent is likely to edit."),
          relatedFile: stringProperty("The paired artifact that may also need regenerating/updating (the first co-edit candidate for `multi_file_coedit`)."),
          relatedFiles: arrayProperty(
            "The full co-edit candidate set (present for `multi_file_coedit`); each should be inspected and either edited or ruled out.",
            stringProperty("A co-edit candidate file path."),
          ),
          confidence: stringProperty("low/medium/high."),
          evidence: arrayProperty("Up to 2 short evidence bullets.", stringProperty("Evidence line.")),
          hint: stringProperty("The compact call to action (regenerate the artifact, or coordinate the multi-file edit)."),
          patchObligation: objectProperty(
            "Follow-through obligation: for generated-artifact hints, ensure the regenerated/updated artifact reaches the submitted diff; for multi-file co-edit hints, inspect every candidate and include all required edits in the final diff.",
            {
              kind: stringProperty("`ensure_related_artifact_in_final_diff` or `consider_coedit_files_in_final_diff`."),
              text: stringProperty("The compact final-diff reminder."),
            },
            ["kind", "text"],
          ),
        },
        ["kind", "sourceFile", "relatedFile", "confidence", "evidence", "hint"],
      ),
    ),
  },
  [
    "query",
    "intent",
    "actualMode",
    "reason",
    "budget",
    "summary",
    "pivots",
    "support",
    "warnings",
    "digest",
    "discarded",
    "discardedTotal",
    "diagnostics",
    "actionabilityHints",
  ],
);

const PIVOT_NEIGHBORHOOD_EXCERPT_SCHEMA = objectProperty(
  "A bounded symbol-window excerpt of a neighbor of a Capsule v2 pivot. The excerpt is the neighbor symbol's own indexed line span, never an exact call/reference line (indexed edges carry no call-site location).",
  {
    filePath: stringProperty("Normalized repo-relative file path of the neighbor."),
    symbol: { type: ["string", "null"], description: "Local symbol name of the neighbor, when known." },
    fqName: { type: ["string", "null"], description: "Fully qualified name of the neighbor, when known." },
    startLine: integerProperty("1-based first line of the excerpt."),
    endLine: integerProperty("1-based last line of the excerpt."),
    text: stringProperty("Bounded excerpt text (never a whole file)."),
    reason: stringProperty("Structural relationship the neighbor was reached through: caller, callee, importer, imported, reference, support, sibling, or fallback_symbol_window (same-file neighbor reached through no edge). The relationship names the edge; the snippet is still a symbol-window, not an exact edge site."),
    textCharacters: integerProperty("Length of the excerpt this entry refers to, when the text itself was omitted."),
    truncated: booleanProperty("Whether the excerpt was trimmed by the line or per-line character budget."),
  },
  // `text` is not guaranteed: on the MCP surface this section carries identity and
  // relation, and the source is read from path:startLine-endLine (M130).
  ["filePath", "symbol", "fqName", "startLine", "endLine", "reason"],
);

/**
 * Mark a section schema as droppable by response compaction: same shape, but the
 * value may be null when the total-response budget forced it out.
 */
function optionalSection(schema: McpSchemaProperty): McpSchemaProperty {
  return { ...schema, type: ["object", "null"] };
}

const PIVOT_NEIGHBORHOOD_SCHEMA: McpSchemaProperty = {
  type: "array",
  description: "Bounded nearby relationship source around the top capsule pivots; may be empty when no pivot symbol identity resolved.",
  items: objectProperty(
    "The bounded neighborhood of one capsule pivot.",
    {
      pivot: objectProperty(
        "The anchoring pivot.",
        {
          path: stringProperty("Repo-relative file path of the pivot."),
          symbol: { type: ["string", "null"], description: "Local symbol name of the pivot, when known." },
          fqName: { type: ["string", "null"], description: "Fully qualified name of the pivot, when known." },
        },
        ["path", "symbol", "fqName"],
      ),
      excerpts: arrayProperty("Bounded neighbor excerpts in deterministic relationship-priority order.", PIVOT_NEIGHBORHOOD_EXCERPT_SCHEMA),
      skipped: arrayProperty(
        "Neighbors that could not be excerpted (unresolved symbol identity or unavailable/stale source).",
        objectProperty(
          "A skipped neighbor target.",
          {
            target: stringProperty("The neighbor identity (fqName or path) that was skipped."),
            reason: stringProperty("Why it was skipped."),
          },
          ["target", "reason"],
        ),
      ),
    },
    ["pivot", "excerpts"],
  ),
};

const INSPECT_FIRST_ITEM_SCHEMA = objectProperty(
  "One named inspection target with a short, deterministic explanation.",
  {
    path: stringProperty("Repo-relative file path."),
    symbol: { type: ["string", "null"], description: "Local symbol name, when known." },
    why: stringProperty("Short deterministic reason this target is worth inspecting first."),
    isSurface: booleanProperty("True when this is the traceback/error surface rather than the likely edit site."),
  },
  ["path", "symbol", "why", "isSurface"],
);

// Compact inspect-first guidance (guidance, not enforcement) projected from the
// Capsule v2 pivots. Same shared projection the Stage 5 injected path consumes.
const INSPECT_FIRST_SCHEMA: McpSchemaProperty = {
  type: ["object", "null"],
  description: "Compact inspect-first guidance projected from capsule pivots; null when there is no actionable pivot.",
  properties: {
    confidence: stringProperty("How specific the lead signal is: high | medium | low."),
    likelyFirst: INSPECT_FIRST_ITEM_SCHEMA,
    related: arrayProperty("At most two related-context items.", INSPECT_FIRST_ITEM_SCHEMA),
    avoidFirst: { type: ["string", "null"], description: "At most one avoid-first hint, or null." },
  },
  required: ["confidence", "likelyFirst", "related", "avoidFirst"],
  additionalProperties: false,
};

type RunPipelineMcpOutput = ReturnType<typeof formatRunPipelineOrchestrationOutput> & {
  productContext: ProductContextResponse;
  savedObservation: {
    observation: ReturnType<typeof formatObservation>;
    staleness: ReturnType<typeof formatObservationSearchResult>["staleness"];
  } | null;
  // M130: every context-producing MCP response reports how large it actually is.
  responseBudget: ResponseBudgetAccounting;
};

const RUN_PIPELINE_TOOL_DEFINITION = createEngineDelegateToolDefinition<RunPipelineInput, RunPipelineMcpOutput>({
  metadata: {
    toolId: McpToolId.RunPipeline,
    displayName: "Run Pipeline",
    description:
      "Default Vtrace repo-context pipeline. get_code_context is the agent-friendly alias for this tool and carries the same selective-retrieval contract: bounded task-relevant evidence, never an exhaustive repository enumeration.",
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
          max_tokens: integerProperty("Budget for the MODEL-VISIBLE context, in estimated tokens. The complete serialized response is bounded separately at max_tokens plus a documented metadata allowance; see the responseBudget block."),
          maxBudgetCharacters: integerProperty("Legacy capsule character budget."),
          include_tests: booleanProperty("Product-facing test-inclusion preference. Defaults true for debug preset, false otherwise."),
          include_file_content: booleanProperty("Product-facing file-content preference. The compact run_pipeline result still returns representation metadata, not full files."),
          sessionId: stringProperty("Optional session id used for session-context memory recall and observation save."),
          includeMemory: booleanProperty("When true, force durable memory inclusion even for presets that de-emphasize it."),
          saveObservation: booleanProperty("When true, persist a compact tool-call observation for this pipeline run."),
          observation: stringProperty("Optional durable observation text to save after the pipeline completes."),
          repos: arrayProperty("Optional workspace repo aliases to query. Defaults to all enabled repos when a workspace config is present.", stringProperty("Repo alias.")),
          capsule_intent: stringProperty("Optional capsule intent: auto|debug|refactor|modify|explain|impact|test-failure. Defaults to auto."),
          capsuleIntent: stringProperty("Alias of `capsule_intent` (camelCase)."),
          capsule_budget_tokens: integerProperty("Optional capsule token budget. Defaults to max_tokens, then 8000."),
          capsuleBudgetTokens: integerProperty("Alias of `capsule_budget_tokens` (camelCase)."),
          detail: stringProperty("Response detail level: compact | standard | debug. Defaults to standard. Bounds how much diagnostic evidence the response carries; every level obeys the same hard total-response ceiling."),
          include_item_content: booleanProperty("When true, productContext.items[] also carry their own body. Off by default: every body is already rendered once in productContext.modelVisibleContext."),
          repo_root: REPO_ROOT_PROPERTY,
        },
        [],
      ),
      outputSchema: objectSchema(
        "run_pipeline output, in one of two shapes selected by `detail`. By DEFAULT the tool returns a bounded orientation — `schemaVersion: run_pipeline.orientation/1`, with `focus`, `related` (each item carrying its own `tokens` cost), `boundary` and optional `notes` — projected from the full authoritative result, which stays server-side. `detail=debug` returns that authoritative orchestration result instead, whose properties are the remainder of this schema. Failure and not-ready states are never projected: they keep their full envelope, reason and nextTool at every detail level.",
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
          capsule: objectProperty(
            "Authoritative capsule implementation diagnostics.",
            {
              implementation: stringProperty("Capsule implementation id."),
              retrievalVersion: stringProperty("Retrieval implementation id."),
              selectionAuthority: stringProperty("Selection authority."),
              rescueAttempted: booleanProperty("Whether bounded routed rescue ran."),
              compatibilityWarnings: arrayProperty("Deprecated input warnings.", stringProperty("Warning.")),
            },
            ["implementation", "retrievalVersion", "selectionAuthority", "rescueAttempted", "compatibilityWarnings"],
          ),
          runtime: objectProperty(
            "Runtime/build provenance for stale-process diagnosis.",
            {
              packageVersion: stringProperty("VTRACE package version."),
              commit: { type: ["string", "null"], description: "Source/build commit when available." },
              executablePath: stringProperty("Configured checkout launcher path."),
              sourceRoot: stringProperty("Checkout or package root."),
              capsuleImplementation: stringProperty("Capsule implementation id."),
              retrievalImplementation: stringProperty("Retrieval implementation id."),
              retrievalRankingVersion: stringProperty("Retrieval ranking version."),
              indexSchemaVersion: integerProperty("Index schema version."),
              manifestVersion: integerProperty("Manifest format version."),
            },
            ["packageVersion", "commit", "executablePath", "sourceRoot", "capsuleImplementation", "retrievalImplementation", "retrievalRankingVersion", "indexSchemaVersion", "manifestVersion"],
          ),
          inspectFirst: INSPECT_FIRST_SCHEMA,
          accounting: CONTEXT_ACCOUNTING_SCHEMA,
          responseBudget: RESPONSE_BUDGET_SCHEMA,
          productContext: PRODUCT_CONTEXT_RESPONSE_SCHEMA,
          workspaceRouting: WORKSPACE_ROUTING_SCHEMA,
          capsuleResult: CAPSULE_V2_PRODUCT_RESPONSE_SCHEMA,
          authoritativeCapsuleManifestId: {
            type: ["string", "null"],
            description: "Persisted authoritative capsule manifest id. Pass to check_capsule_staleness or `vtrace check-capsule`; null when no manifest could be persisted.",
          },
          pivotNeighborhood: PIVOT_NEIGHBORHOOD_SCHEMA,
          intent: RUN_PIPELINE_INTENT_DECISION_SCHEMA,
          // Optional sections. Response compaction may null these out under a tight
          // total-response budget; `responseBudget.compacted_fields` names any that
          // were dropped. The authoritative context is never among them (M130).
          taskSummary: optionalSection(RUN_PIPELINE_TASK_SUMMARY_SCHEMA),
          context: optionalSection(RUN_PIPELINE_CONTEXT_SECTION_SCHEMA),
          impact: optionalSection(RUN_PIPELINE_IMPACT_SECTION_SCHEMA),
          flow: RUN_PIPELINE_FLOW_SECTION_SCHEMA,
          memory: optionalSection(RUN_PIPELINE_MEMORY_SECTION_SCHEMA),
          rules: optionalSection(RUN_PIPELINE_RULE_SECTION_SCHEMA),
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
          // ---- the default disclosure ----------------------------------
          // Everything above documents the AUTHORITATIVE orchestration result,
          // which is what `detail=debug` returns. The four properties below are
          // what a default call returns instead: a bounded orientation
          // projected from that same result. Both are documented here because
          // one tool returns both, selected by `detail`.
          focus: {
            type: ["object", "null"],
            description: "The single location the orientation is about. Present on a projected orientation.",
            properties: {
              at: stringProperty("Canonical `path::Symbol` identity, exactly as the index spells it."),
              file: stringProperty("Repo-relative path."),
              lines: { type: ["string", "null"], description: "`start-end` line span, or null when the item has none." },
              form: { type: ["string", "null"], description: "What `code` is — full body, signature-only skeleton, and so on. A skeleton read as an implementation is a misreading this field prevents." },
              why: { type: ["string", "null"], description: "The authoritative selection reason, verbatim." },
              code: { type: ["string", "null"], description: "Source for the focus, head-bounded on a line boundary." },
              codeTruncated: booleanProperty("True when `code` is a prefix of a longer span."),
              tokens: integerProperty("This item's own serialized cost in the packet, under the packet's token rule, including this field."),
            },
            required: ["at", "file", "lines", "form", "why", "code", "codeTruncated", "tokens"],
            additionalProperties: false,
          },
          related: arrayProperty(
            "Task-relevant locations in the authoritative order the pipeline ranked them, each carrying the relationship the index actually records. Never re-ranked and never strengthened: a potential caller is not rendered as a caller, and a symbol reached by no edge says so.",
            objectProperty(
              "A related location and the claim made about it.",
              {
                at: stringProperty("Canonical `path::Symbol` identity."),
                file: stringProperty("Repo-relative path."),
                lines: { type: ["string", "null"], description: "`start-end` line span, or null." },
                how: stringProperty("The authoritative relationship or role, verbatim or from the frozen relationship phrase table."),
                form: stringProperty("Present only when `code` is: what `code` is — the upstream content mode verbatim (focused_source, skeleton, signature, excerpt, document_excerpt). A skeleton read as an implementation is a misreading this field prevents."),
                code: stringProperty("Present only when the entry carries source-backed text in the caller's budget: that form's body, head-bounded on a line boundary. Absent, the entry is relationship-only."),
                codeTruncated: booleanProperty("Present with `code`: true when `code` is a prefix of a longer span."),
                tokens: integerProperty("This item's own serialized cost in the packet, including this field."),
              },
              ["at", "file", "lines", "how", "tokens"],
            ),
          ),
          boundary: stringProperty(
            "The claim boundary, present on every projected orientation without exception. It states that the packet is a selection rather than an enumeration, which is what makes every omission above a non-claim: items not shown are not thereby absent.",
          ),
          notes: arrayProperty(
            "Interpretation-critical qualifications only — a non-fresh index, a multi-repository routing outcome, a truncated excerpt. Absent when there is nothing that changes how the packet reads.",
            stringProperty("One qualification."),
          ),
        },
        // Only `schemaVersion` is common to both shapes, so it is the only
        // property this tool guarantees unconditionally. Which shape arrives is
        // determined by `detail` and declared by the version string itself:
        // `run_pipeline.orientation/1` for the default projection, the
        // orchestration version for `detail=debug`.
        [
          "schemaVersion",
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
      const maxTokens = parseOptionalInteger(McpToolId.RunPipeline, input, "max_tokens");
      const legacyMaxBudgetCharacters = parseOptionalInteger(
        McpToolId.RunPipeline,
        input,
        "maxBudgetCharacters",
      );
      const maxBudgetCharacters = typeof maxTokens === "number"
        ? maxTokens * 4
        : legacyMaxBudgetCharacters;
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
      // M151: opt in to bounded supporting-repository context. Off by default so
      // an ordinary workspace request costs one retrieval, and so another member
      // merely EXISTING can never change what the lead returns.
      const includeSupportingRepos = parseOptionalBoolean(
        McpToolId.RunPipeline,
        input,
        "include_supporting_repos",
      );

      // Hidden migration aliases; compatibility validation never changes routing.
      const engineSnake = parseOptionalStringField(McpToolId.RunPipeline, input, "capsule_engine");
      const engineCamel = parseOptionalStringField(McpToolId.RunPipeline, input, "capsuleEngine");
      const capsuleIntentRaw = parseOptionalStringFieldAlias(
        McpToolId.RunPipeline,
        input,
        "capsule_intent",
        "capsuleIntent",
      );
      const capsuleBudgetTokens = parseOptionalIntegerAlias(
        McpToolId.RunPipeline,
        input,
        "capsule_budget_tokens",
        "capsuleBudgetTokens",
      );
      const detailRequested = parseOptionalStringField(McpToolId.RunPipeline, input, "detail");
      const includeItemContent = parseOptionalBoolean(McpToolId.RunPipeline, input, "include_item_content");
      const requestedRoot = parseOptionalStringField(McpToolId.RunPipeline, input, "repo_root");
      if (requestedRoot !== undefined && typeof requestedRoot !== "string") {
        return requestedRoot;
      }

      if (typeof query !== "string") {
        return query;
      }
      if (maxResults !== undefined && typeof maxResults !== "number") {
        return maxResults;
      }
      if (maxBudgetCharacters !== undefined && typeof maxBudgetCharacters !== "number") {
        return maxBudgetCharacters;
      }
      if (maxTokens !== undefined && typeof maxTokens !== "number") {
        return maxTokens;
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
      if (includeItemContent !== undefined && typeof includeItemContent !== "boolean") {
        return includeItemContent;
      }
      if (detailRequested !== undefined && typeof detailRequested !== "string") {
        return detailRequested;
      }
      if (detailRequested !== undefined && !isMcpResponseDetail(detailRequested)) {
        return invalidRequest(
          McpToolId.RunPipeline,
          `MCP tool run_pipeline detail must be one of: ${Object.values(McpResponseDetail).join(", ")}.`,
          { field: "detail", value: detailRequested },
        );
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
      if (includeSupportingRepos !== undefined && typeof includeSupportingRepos !== "boolean") {
        return includeSupportingRepos;
      }
      if (engineSnake !== undefined && typeof engineSnake !== "string") {
        return engineSnake;
      }
      if (engineCamel !== undefined && typeof engineCamel !== "string") {
        return engineCamel;
      }
      if (capsuleIntentRaw !== undefined && typeof capsuleIntentRaw !== "string") {
        return capsuleIntentRaw;
      }
      if (capsuleBudgetTokens !== undefined && typeof capsuleBudgetTokens !== "number") {
        return capsuleBudgetTokens;
      }

      let capsuleCompatibility;
      try {
        capsuleCompatibility = resolveCapsuleCompatibility(engineSnake ?? engineCamel);
      } catch (error) {
        const compatibilityError = error as CapsuleEngineCompatibilityError;
        return invalidRequest(
          McpToolId.RunPipeline,
          compatibilityError.message,
          { error: compatibilityError.code },
        );
      }

      let capsuleV2Intent: CapsuleIntent | undefined;
      if (capsuleIntentRaw !== undefined) {
        const parsedIntent = parseCapsuleIntent(capsuleIntentRaw);
        if (parsedIntent === undefined) {
          return invalidRequest(
            McpToolId.RunPipeline,
            "MCP tool run_pipeline requires capsule_intent to be one of auto|debug|refactor|modify|explain|impact|test-failure.",
            { capsule_intent: capsuleIntentRaw },
          );
        }
        capsuleV2Intent = parsedIntent;
      }
      if (capsuleBudgetTokens !== undefined && capsuleBudgetTokens <= 0) {
        return invalidRequest(
          McpToolId.RunPipeline,
          "MCP tool run_pipeline requires capsule_budget_tokens to be a positive integer.",
          { capsule_budget_tokens: capsuleBudgetTokens },
        );
      }

      if (intentRequested !== undefined && !isRunPipelinePresetIntent(intentRequested)) {
        return invalidRequest(
          McpToolId.RunPipeline,
          `MCP tool run_pipeline preset/intent must be one of: ${[RunPipelinePresetIntent.Auto, ...RUN_PIPELINE_CONCRETE_PRESETS].join(", ")}.`,
          { field: "intent", value: intentRequested },
        );
      }

      const routed = await resolveProductRouteForRequest(context, McpToolId.RunPipeline, {
        query,
        ...(requestedRoot === undefined ? {} : { requestedRoot }),
        ...(repos === undefined ? {} : { repos }),
        ...(includeSupportingRepos === undefined
          ? {}
          : { includeSupporting: includeSupportingRepos }),
      });

      if (!routed.ok) {
        return routed.result;
      }

      const productRoute = routed.route;

      // Bind to the member routing chose. `requestedRoot` still overrides, so an
      // explicit root keeps M132's precedence exactly as it was.
      return withReadyRepoDb(
        rebindMcpContext(context, productRoute.lead!.rootPath),
        McpToolId.RunPipeline,
        async (binding, db, stores) => {
          const currentObservationContext = await resolveCurrentObservationContext(binding.repoRoot);
          const preexistingSessionStatus = sessionId === undefined
            ? undefined
            : getSessionById(stores.read.session, sessionId)?.status;
          const accountingStartedAt = performance.now();
          const orchestration = runPipelineOrchestrator(stores.write, binding.repoRoot, {
            query,
            maxResults,
            maxBudgetCharacters,
            intent: intentRequested,
            sessionId,
            includeMemory,
            includeTests,
            includeFileContent,
            currentObservationContext,
            // Pass hidden migration aliases to the shared compatibility validator.
            ...((engineSnake ?? engineCamel) === undefined
              ? {}
              : { capsuleEngine: engineSnake ?? engineCamel }),
            ...(capsuleV2Intent === undefined ? {} : { capsuleIntent: capsuleV2Intent }),
            ...(capsuleBudgetTokens === undefined ? {} : { capsuleBudgetTokens }),
            // M207 instrumentation: construction-time only, never from the request.
            ...(context.retrievalInstrumentation?.candidatePoolSize === undefined
              ? {}
              : { candidatePoolSize: context.retrievalInstrumentation.candidatePoolSize }),
          });

          // Auto-capture is a best-effort post-success side effect shared with
          // get_context_capsule. Deduped by (sourceRunId, query, intent,
          // routingProfile, capsuleProfile, topPivots) so repeated silent calls
          // do not spam the observation store.
          if (orchestration.context.included) {
            captureVisibleCapsuleObservationBestEffort({
              stores: stores.write,
              repoRoot: binding.repoRoot,
              sourceRunId: getLatestIndexRun(db)?.id ?? null,
              routedQuery: orchestration.context.routedQuery,
              capsuleProfileId: orchestration.context.preparedAssembly.selection.profile.id,
              capsule: orchestration.context.capsule,
              toolName: McpToolId.RunPipeline,
              ...(sessionId === undefined ? {} : { sessionId, sessionAgentKind: "mcp" }),
              currentContext: currentObservationContext,
            });
          }

          let savedObservation: {
            observation: ReturnType<typeof formatObservation>;
            staleness: ReturnType<typeof formatObservationSearchResult>["staleness"];
          } | null = null;

          if (saveObservation === true || observationText !== undefined) {
            const capsule = orchestration.context.capsule;
            const linkedItems = [...capsule.pivots, ...capsule.supportingItems].slice(0, 6);
            const observation = persistObservation(stores.write, {
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
              scope: ObservationScope.IndexState,
              origin: observationText === undefined
                ? ObservationOrigin.AutomaticCapture
                : ObservationOrigin.Manual,
              provenance: buildObservationProvenance({
                context: currentObservationContext,
                toolName: McpToolId.RunPipeline,
                queryText: orchestration.request.query,
                semanticOptions: { intent: orchestration.intentDecision.selected },
                resultValue: {
                  pivots: capsule.pivots.map((item) => item.symbolId),
                  supports: capsule.supportingItems.map((item) => item.symbolId),
                },
              }),
              linkedFilePaths: linkedItems.map((item) => item.filePath),
              linkedSymbolIds: linkedItems.map((item) => item.symbolId),
              linkedFqNames: linkedItems.map((item) => item.fqName),
            });
            const formattedSearchResult = formatObservationSearchResult({
              observation,
              staleness: getObservationStaleness(db, observation),
              compatibility: classifyObservationCompatibility(observation, currentObservationContext),
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
            // M164. Watcher-derived signals REFINE freshness; they never
            // establish it. An index-only binding has none, and absent is the
            // truthful reading — no watcher observed anything — not unknown.
            ...(binding.state?.lastIndexSnapshot === undefined ? {} : { lastIndexSnapshot: binding.state.lastIndexSnapshot }),
            ...(binding.state?.observedFileChanges === undefined ? {} : { observedFileChanges: binding.state.observedFileChanges }),
            ...(binding.state?.fileWatcher === undefined ? {} : { fileWatcher: binding.state.fileWatcher }),
            readiness: summarizeIndexReadiness(withRuntimeSignals(
              await evaluateIndexReadiness(binding.repoRoot, { db }),
              { observedSourceChanges: binding.state?.observedFileChanges !== undefined },
            )),
          });
          const nudge = evaluateObservationNudge(stores.read.session, {
            sessionId,
            currentToolName: McpToolId.RunPipeline,
            ...(preexistingSessionStatus === SessionStatus.Compressed
              ? { preexistingSessionStatus }
              : {}),
          });

          const productContext = await assembleProductContext({
            stores: stores.read,
            repoRoot: binding.repoRoot,
            task: query,
            intent: capsuleV2Intent ?? capsuleIntentForPreset(orchestration.intentDecision.selected),
            // max_tokens is the caller's MODEL-VISIBLE context budget; before M130 it
            // reached the v1 capsule but never the authoritative product context,
            // which silently defaulted to 8000.
            budgetTokens: capsuleBudgetTokens ?? maxTokens ?? CAPSULE_V2_PRODUCT_DEFAULT_BUDGET_TOKENS,
            authoritativeRetrieval: orchestration.context.authoritativeRetrieval,
            ...(sessionId === undefined ? {} : { sessionId }),
          });

          // M151: bounded supporting-repository context, only when the request
          // asked for it. `productContext` above is the lead's own response and
          // is what a default request returns untouched, so the mere existence
          // of another member cannot change the answer.
          const composition = await composeSupportingRepositories({
            route: productRoute,
            leadContext: productContext,
            task: query,
            intent: capsuleV2Intent ?? capsuleIntentForPreset(orchestration.intentDecision.selected),
            budgetTokens: capsuleBudgetTokens ?? maxTokens ?? CAPSULE_V2_PRODUCT_DEFAULT_BUDGET_TOKENS,
          });

          // One compact provenance stamp per response: which worktree answered and
          // why it was chosen. Request-level, never repeated per selected item.
          const routedProductContext = {
            ...composition.context,
            repository: {
              ...composition.context.repository,
              routingSource: routingSourceFor({
                requestedRoot,
                clientContextRoot: context.clientContextRoot ?? null,
                boundRoot: context.repoRoot,
              }),
            },
          };

          const assembledOutput = {
            ...output,
            productContext: routedProductContext,
            workspaceRouting: {
              ...formatProductRoutingMetadata(productRoute.routing),
              ...(composition.perRepository.length === 0
                ? {}
                : { perRepository: composition.perRepository }),
            },
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
          };

          // Deterministic, best-effort accounting over the emitted response.
          // Counts the unique files the v1 context (and any v2 section) touched.
          const accounting = await buildContextAccountingBestEffort({
            repoRoot: binding.repoRoot,
            emittedValue: assembledOutput,
            filePathGroups: runPipelineOutputFilePathGroups(assembledOutput),
            latencyMs: performance.now() - accountingStartedAt,
          });

          // The last thing that happens to a context response: bound the complete
          // serialized result, not just the model-visible context inside it.
          const authoritativeResult = compactProductResponse(
            accounting === undefined ? assembledOutput : { ...assembledOutput, accounting },
            {
              requestedContextTokens: capsuleBudgetTokens
                ?? maxTokens
                ?? CAPSULE_V2_PRODUCT_DEFAULT_BUDGET_TOKENS,
              ...(detailRequested === undefined ? {} : { detail: detailRequested }),
              ...(includeItemContent === undefined ? {} : { includeItemContent }),
            },
          );

          // The authoritative result above is complete and stays that way; what
          // follows decides only how much of it the model is handed by default.
          //
          // Serialising all of it cost $0.0985 a task to displace $0.0026 of the
          // investigation it was meant to replace (M169). The evidence was never
          // the problem — the response carries 895 characters of code inside
          // 21,318 characters of response — so the default became a projection
          // rather than a dump: a median of ~610 model-visible tokens against
          // ~6,800, with gold file and gold symbol delivery unchanged to the
          // percentage point on two disjoint hundred-task corpora.
          //
          // `detail=debug` returns the authoritative result whole. The projector
          // also DECLINES on any state it is not defined over — unready, stale,
          // empty, delivery-failed — so failure envelopes keep their reason and
          // their nextTool at full fidelity. A compact success output does not
          // license a vague failure output.
          const orientation = detailRequested === McpResponseDetail.Debug
            ? null
            : projectRunPipelineOrientation(authoritativeResult);

          // When the projector declines, the model used to receive the whole
          // authoritative result. M174-A measured that path at 26,227 characters
          // and 6,482 model-visible tokens to deliver one 186-character sentence,
          // 81.6% of it the agent's own question echoed back twice. A decline is
          // not a failure envelope — the staleness envelopes with `reason` and
          // `nextTool` are returned before assembly and never reach here — so
          // there was nothing in that payload the terse form omits.
          //
          // The decline projector compacts only states it can positively identify
          // and returns null on any other shape, so an unrecognised output keeps
          // full fidelity rather than being summarised into a guess.
          const decline = orientation === null && detailRequested !== McpResponseDetail.Debug
            ? projectOrientationDecline(authoritativeResult)
            : null;

          return {
            ok: true,
            output: orientation ?? decline ?? authoritativeResult,
          };
        },
        requestedRoot,
      );
    },
  });

type GetCodeContextStaleReason = WorktreeIndexFreshnessResult["reason"] | "repo_not_ready" | "ambiguous_worktree" | "refresh_failed";

interface GetCodeContextStaleEnvelope {
  readonly productContext?: ProductContextResponse;
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

function attachUnresolvedProductContext(
  output: GetCodeContextStaleEnvelope,
  task: string,
  freshness: WorktreeIndexFreshnessResult,
  startedAt: number,
): GetCodeContextStaleEnvelope {
  const current = freshness.current;
  const productContext = buildUnresolvedProductContext({
    task,
    repoRoot: current.worktree.worktreeRoot,
    repositoryId: current.repository.repositoryId,
    worktreeId: current.worktree.worktreeId,
    headCommit: current.snapshot.headCommit,
    branch: current.snapshot.branch,
    detached: current.snapshot.detached,
    freshnessStatus: freshness.status,
    freshnessReason: freshness.reason,
    freshnessAction: freshness.action,
    refreshDiagnostics: output.diagnostics.indexFreshness,
    totalMs: Math.max(0, performance.now() - startedAt),
  });
  return { ...output, productContext };
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
  const productStartedAt = performance.now();
  const input = parseObjectInput(McpToolId.GetCodeContext, request.input);
  if ("ok" in input && input.ok === false) {
    return input;
  }
  const productTask = parseRequiredRunPipelineTask(input, McpToolId.GetCodeContext);
  if (typeof productTask !== "string") {
    return productTask;
  }
  const requestedRoot = parseOptionalStringField(McpToolId.GetCodeContext, input, "repo_root");
  if (requestedRoot !== undefined && typeof requestedRoot !== "string") {
    return requestedRoot;
  }
  const autoRefresh = parseOptionalStringField(McpToolId.GetCodeContext, input, "auto_refresh") ?? "never";
  if (typeof autoRefresh !== "string") {
    return autoRefresh;
  }
  if (autoRefresh !== "never" && autoRefresh !== "if_stale") {
    return invalidRequest(McpToolId.GetCodeContext, "auto_refresh must be `never` or `if_stale`.", {
      field: "auto_refresh",
      value: autoRefresh,
    });
  }
  const repoRoot = await resolveRequestedRepoRoot(context, McpToolId.GetCodeContext, requestedRoot);
  if (typeof repoRoot !== "string") {
    return repoRoot;
  }
  const reboundContext = rebindMcpContext(context, repoRoot);
  let check = await checkIndexForGetCodeContext(reboundContext, repoRoot);

  if (check.kind === "stale_response" && autoRefresh === "if_stale" && check.autoRefreshAllowed) {
    const before = check.freshness;
    try {
      const paths = resolveRepoLocalPaths(repoRoot);
      const config = await safeReadConfig(paths.configPath);
      const state = await safeReadState(paths.statePath);
      const refreshMode = config === undefined || state === undefined ? "full" : "incremental";
      let refreshPerformance: import("../indexer/incrementalIndex").IndexPerformanceDiagnostics | null = null;
      if (refreshMode === "full") {
        const initialized = await initRepo({ repoPath: repoRoot });
        refreshPerformance = initialized.indexResult.performance ?? null;
      } else {
        const refreshed = await reindexRepoAndRefreshState({
          repoRoot,
          dbPath: config.dbPath ?? state.dbPath ?? paths.dbPath,
          statePath: paths.statePath,
          configPresent: true,
          statePresent: true,
          usesDbPathOverride: false,
        });
        refreshPerformance = refreshed.indexResult.performance ?? null;
      }
      check = await checkIndexForGetCodeContext(reboundContext, repoRoot);
      if (check.kind === "stale_response") {
        return {
          ok: true,
          output: attachUnresolvedProductContext(buildStaleEnvelope({
            reason: "refresh_failed",
            message: `Vtrace refreshed ${repoRoot}, but the requested worktree index is still not fresh.`,
            indexFreshness: formatPreciseIndexFreshnessDiagnostic(check.freshness, {
              before,
              refreshAttempted: true,
              refreshMode,
              refreshFailed: true,
            }),
          }), productTask, check.freshness, productStartedAt),
        };
      }
      check = {
        ...check,
        indexFreshness: formatPreciseIndexFreshnessDiagnostic(check.freshness, {
          before,
          refreshAttempted: true,
          refreshMode,
          performance: refreshPerformance,
        }),
      };
    } catch (error) {
      const lockReason = error instanceof WorktreeIndexLockError ? error.code : null;
      return {
        ok: true,
        output: attachUnresolvedProductContext(buildStaleEnvelope({
          reason: "refresh_failed",
          message: `Vtrace could not refresh ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`,
          indexFreshness: formatPreciseIndexFreshnessDiagnostic(before, {
            before,
            refreshAttempted: true,
            refreshMode: "incremental",
            refreshFailed: true,
            failureReason: lockReason ?? (error instanceof Error ? error.message : String(error)),
          }),
        }), productTask, before, productStartedAt),
      };
    }
  }

  if (check.kind === "stale_response") {
    return {
      ok: true,
      output: attachUnresolvedProductContext(check.output, productTask, check.freshness, productStartedAt),
    };
  }

  const result = await RUN_PIPELINE_TOOL_DEFINITION.handler({
    context: reboundContext,
    request: {
      ...request,
      toolId: McpToolId.RunPipeline,
    },
  });

  if (!result.ok) {
    return result;
  }

  // When the inner pass projected an orientation there is no authoritative
  // `productContext` here to overwrite, and nothing this wrapper could add to
  // it: the freshness qualification the model needs is already inside the
  // packet as an interpretation-critical note, and the timing and index-mode
  // records the overwrite below exists to correct are not disclosed by default
  // at all. Reaching into the projection to write them would put back exactly
  // the machine-facing detail the projection was made to hold back.
  if ((result.output as { productContext?: unknown } | undefined)?.productContext === undefined) {
    return result;
  }

  // run_pipeline already applied the bounded shape; this tool only overwrites
  // freshness/timing afterwards, so re-measure rather than re-compact (which would
  // under-report what the inner pass removed).
  //
  // The overwrite must land in the SAME shape the inner pass settled on. Writing the
  // raw index-freshness record here used to restore, after compaction, the detail the
  // envelope had just held back — and twice over, since it appears both as
  // `refreshDiagnostics` and as `diagnostics.indexFreshness`. That is why M165
  // measured this wrapper as more expensive than the tool it wraps.
  const detailRequested = parseOptionalStringField(McpToolId.GetCodeContext, input, "detail");
  const responseDetail = typeof detailRequested === "string" && isMcpResponseDetail(detailRequested)
    ? detailRequested
    : McpResponseDetail.Standard;
  const indexFreshnessForResponse = responseDetail === McpResponseDetail.Debug
    ? check.indexFreshness
    : agentFacingIndexFreshness(check.indexFreshness);
  return {
    ok: true,
    output: remeasureResponseBudget({
      ...result.output,
      productContext: {
        ...result.output.productContext,
        repository: {
          ...result.output.productContext.repository,
          indexMode: check.indexFreshness.performance?.mode
            ?? result.output.productContext.repository.indexMode,
        },
        freshness: {
          status: check.indexFreshness.status,
          reason: check.indexFreshness.reason,
          action: check.indexFreshness.action,
          // The precise record is `diagnostics.indexFreshness`; repeating it here
          // is the duplication M166-B measured, and the envelope already replaces
          // it with a reference.
          refreshDiagnostics: result.output.productContext.freshness?.refreshDiagnostics
            ?? { ref: "diagnostics.indexFreshness" },
        },
        timing: {
          ...result.output.productContext.timing,
          totalMs: Math.max(
            result.output.productContext.timing.totalMs,
            performance.now() - productStartedAt,
          ),
          ...(check.indexFreshness.performance?.timingsMs?.total === undefined
            ? {}
            : { indexRefreshMs: check.indexFreshness.performance.timingsMs.total }),
        },
      },
      diagnostics: {
        ...result.output.diagnostics,
        indexFreshness: indexFreshnessForResponse,
      },
    }),
  };
}

async function checkIndexForGetCodeContext(
  context: McpServerContext,
  repoRoot: string,
): Promise<
  | { kind: "fresh"; freshness: WorktreeIndexFreshnessResult; indexFreshness: ReturnType<typeof formatIndexFreshnessDiagnostic> }
  | { kind: "stale_response"; freshness: WorktreeIndexFreshnessResult; autoRefreshAllowed: boolean; output: GetCodeContextStaleEnvelope }
> {
  // The one authoritative evaluation. `index_status` runs the same call with
  // the same runtime signals, which is what removes the pre-M141 contradiction.
  let readiness = await evaluateIndexReadiness(repoRoot);
  let precise = readiness.freshness;
  const resolved = await resolveReadyRepoBinding(context, McpToolId.GetCodeContext, repoRoot);

  if (!resolved.ok) {
    const reason = precise.reason === "missing_index" ? "missing_index" : "repo_not_ready";
    return {
      kind: "stale_response",
      freshness: precise,
      autoRefreshAllowed: precise.reason === "missing_index" || precise.reason === "manifest_invalid",
      output: buildStaleEnvelope({
        reason,
        message: reason === "missing_index" ? MISSING_INDEX_MESSAGE : REPO_NOT_READY_MESSAGE,
        indexFreshness: formatPreciseIndexFreshnessDiagnostic(precise, { readiness }),
      }),
    };
  }
  const db = openProductIndexDatabase(resolved.binding.dbPath);
  const indexMissing = !hasIndexedFiles(db);
  db.close();
  readiness = withRuntimeSignals(readiness, {
    indexHasNoFiles: indexMissing,
    observedSourceChanges: resolved.binding.state?.observedFileChanges !== undefined,
  });
  precise = readiness.freshness;

  if (precise.status === "fresh") {
    return {
      kind: "fresh",
      freshness: precise,
      indexFreshness: formatPreciseIndexFreshnessDiagnostic(precise, { readiness }),
    };
  }
  const autoRefreshAllowed = [
    "missing_index",
    "head_mismatch",
    "working_tree_changed",
    "configuration_changed",
    "manifest_invalid",
  ].includes(precise.reason);

  return {
    kind: "stale_response",
    freshness: precise,
    autoRefreshAllowed,
    output: buildStaleEnvelope({
      reason: precise.reason,
      message: precise.reason === "missing_index" ? MISSING_INDEX_MESSAGE : STALE_INDEX_MESSAGE,
      indexFreshness: formatPreciseIndexFreshnessDiagnostic(precise, { readiness }),
    }),
  };
}

function formatPreciseIndexFreshnessDiagnostic(
  freshness: WorktreeIndexFreshnessResult,
  refresh: {
    before?: WorktreeIndexFreshnessResult;
    refreshAttempted?: boolean;
    refreshMode?: "incremental" | "full";
    refreshFailed?: boolean;
    failureReason?: string | null;
    performance?: import("../indexer/incrementalIndex").IndexPerformanceDiagnostics | null;
    readiness?: IndexReadiness;
  } = {},
) {
  const latestRunId = freshness.manifest?.index.runId ?? null;
  return {
    status: freshness.status,
    reason: freshness.reason,
    action: freshness.action,
    // M141: the decomposed verdict behind status/reason/action, so a caller can
    // see WHICH dimension refused the index rather than inferring it.
    readiness: refresh.readiness === undefined ? null : summarizeIndexReadiness(refresh.readiness),
    beforeState: refresh.before?.status ?? freshness.status,
    afterState: freshness.status,
    latestRunId,
    before: refresh.before === undefined ? null : {
      status: refresh.before.status,
      reason: refresh.before.reason,
    },
    refreshAttempted: refresh.refreshAttempted ?? false,
    refreshMode: refresh.refreshMode ?? null,
    refreshFailed: refresh.refreshFailed ?? false,
    failureReason: refresh.failureReason ?? null,
    performance: refresh.performance ?? null,
    after: { status: freshness.status, reason: freshness.reason },
    worktreeRoot: freshness.requestedWorktree.root,
    requestedWorktree: freshness.requestedWorktree,
    indexedWorktree: freshness.indexedWorktree ?? null,
    previousHead: refresh.before?.indexedWorktree?.headCommit ?? freshness.indexedWorktree?.headCommit ?? null,
    currentHead: freshness.requestedWorktree.headCommit,
    indexRunId: latestRunId,
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
      input: {
        repo_root: input.indexFreshness.worktreeRoot,
      },
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
      "Initial repository orientation for coding, debugging, refactor, and code-understanding tasks: give it a task description and it returns the implementation sites and supporting evidence most likely to matter. It returns BOUNDED TASK-RELEVANT evidence ranked for the request — it is selective, not an enumeration of the repository, so anything it does not return is unsearched rather than absent (see `coverage`). Do not read a miss as proof that something does not exist: for that, look the exact path or symbol up, or run ordinary text search. It answers about ONE indexed worktree at its current source state, never about another branch or revision; use Git for cross-revision questions. max_tokens bounds model-visible context; lower-priority support is compacted before answer-bearing evidence. resultState=no_result means retrieval missed, while delivery_failure means relevant evidence was found but could not fit. It is fail-closed on stale or missing indexes by default. Pass auto_refresh=if_stale only to explicitly refresh the selected repo_root worktree. Each returned item carries `fqName`, the canonical indexed symbol identity (e.g. `pkg/core.py::PriceEngine.apply_discount`); a non-null `fqName` is directly usable as get_impact_graph's symbol_fqn. The bare `symbol` field is a local name and does NOT resolve for methods or other nested symbols.",
    inputSchema: objectSchema(
      "Code-context request with optional explicit worktree selection and opt-in refresh.",
      {
        ...(RUN_PIPELINE_TOOL_DEFINITION.metadata.inputSchema.properties ?? {}),
        repo_root: REPO_ROOT_PROPERTY,
        auto_refresh: stringProperty("Refresh policy: `never` (default) or `if_stale`."),
      },
      RUN_PIPELINE_TOOL_DEFINITION.metadata.inputSchema.required,
    ),
    outputSchema: GET_CODE_CONTEXT_OUTPUT_SCHEMA,
  }),
  handler: handleGetCodeContextRequest,
}) satisfies McpToolDefinition<RunPipelineInput, GetCodeContextOutput>;

// CAPSULE_V2_PRODUCT_ITEM_SCHEMA and CAPSULE_V2_PRODUCT_RESPONSE_SCHEMA are
// declared above RUN_PIPELINE_TOOL_DEFINITION so both run_pipeline/get_code_context
// and get_context_capsule can reference the same shared v2 product schema.

// The direct capsule response, projected from the same authoritative result.
interface CapsuleToolOutput {
  query: string;
  intent: string;
  capsule: {
    implementation: "hybrid";
    retrievalVersion: "product-retrieval-v2";
    selectionAuthority: "hybrid";
    rescueAttempted: boolean;
    compatibilityWarnings: readonly string[];
  };
  runtime: ReturnType<typeof getRuntimeProvenance>;
  inspectFirst: InspectFirst | null;
  capsuleManifestId: string | null;
  capsuleResult: CapsuleV2ProductResponse;
  accounting?: ContextAccounting;
  productContext?: ProductContextResponse;
  responseBudget?: ResponseBudgetAccounting;
}

const RESERVED_MCP_TOOL_DEFINITIONS_UNFROZEN = [
  GET_CODE_CONTEXT_TOOL_DEFINITION,
  RUN_PIPELINE_TOOL_DEFINITION,
  getRequiredToolDefinition(LEGACY_MCP_TOOL_DEFINITIONS_UNFROZEN, McpToolId.IndexRepo),
  getRequiredToolDefinition(LEGACY_MCP_TOOL_DEFINITIONS_UNFROZEN, McpToolId.CheckCapsuleStaleness),
  createEngineDelegateToolDefinition<BuildCapsuleInput, CapsuleToolOutput>({
    metadata: {
      toolId: McpToolId.GetContextCapsule,
      displayName: "Get Context Capsule",
      description: "Build a context capsule using the existing routing and capsule pipeline.",
      inputSchema: objectSchema(
        "Context-capsule build request.",
        {
          task: stringProperty("Preferred task text. `query` remains a backward-compatible alias."),
          query: stringProperty("User query text."),
          preset: stringProperty("Product-facing preset: auto|explore|debug|modify|refactor. Defaults to modify on this direct capsule surface."),
          maxResults: integerProperty("Optional reranked candidate count."),
          maxBudgetCharacters: integerProperty("Optional capsule character budget."),
          repos: arrayProperty("Optional workspace repo aliases to query. Defaults to all enabled repos when a workspace config is present.", stringProperty("Repo alias.")),
          capsule_intent: stringProperty("Optional capsule intent: auto|debug|refactor|modify|explain|impact|test-failure. Defaults to auto."),
          capsule_budget_tokens: integerProperty("Optional capsule token budget. Defaults to max_tokens, then 8000."),
          detail: stringProperty("Response detail level: compact | standard | debug. Defaults to standard. Bounds how much diagnostic evidence the response carries; every level obeys the same hard total-response ceiling."),
          include_item_content: booleanProperty("When true, productContext.items[] also carry their own body. Off by default: every body is already rendered once in productContext.modelVisibleContext."),
          repo_root: REPO_ROOT_PROPERTY,
        },
        [],
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
          capsule: RUN_PIPELINE_TOOL_DEFINITION.metadata.outputSchema.properties?.capsule ?? stringProperty("Capsule diagnostics."),
          runtime: RUN_PIPELINE_TOOL_DEFINITION.metadata.outputSchema.properties?.runtime ?? stringProperty("Runtime provenance."),
          inspectFirst: INSPECT_FIRST_SCHEMA,
          accounting: CONTEXT_ACCOUNTING_SCHEMA,
          productContext: PRODUCT_CONTEXT_RESPONSE_SCHEMA,
          workspaceRouting: WORKSPACE_ROUTING_SCHEMA,
          classification: CLASSIFICATION_SCHEMA,
          routingProfile: ROUTING_PROFILE_SCHEMA,
          capsuleProfile: CAPSULE_PROFILE_SCHEMA,
          capsuleManifestId: {
            type: ["string", "null"],
            description: "Persisted capsule manifest id for this capsule. Pass to check_capsule_staleness or `vtrace check-capsule` to evaluate freshness against a later run. Null for multi-repo capsules or when the repo has no index run yet.",
          },
          capsuleResult: CAPSULE_V2_PRODUCT_RESPONSE_SCHEMA,
          responseBudget: RESPONSE_BUDGET_SCHEMA,
        },
        ["query", "intent"],
      ),
    },
    async handler({ context, request }) {
      const input = parseObjectInput(McpToolId.GetContextCapsule, request.input);

      if ("ok" in input && input.ok === false) {
        return input;
      }

      const query = parseRequiredRunPipelineTask(input, McpToolId.GetContextCapsule);
      const maxResults = parseOptionalInteger(McpToolId.GetContextCapsule, input, "maxResults");
      const legacyMaxBudgetCharacters = parseOptionalInteger(
        McpToolId.GetContextCapsule,
        input,
        "maxBudgetCharacters",
      );
      const maxTokens = parseOptionalInteger(McpToolId.GetContextCapsule, input, "max_tokens");
      const maxBudgetCharacters = typeof maxTokens === "number"
        ? maxTokens * 4
        : legacyMaxBudgetCharacters;
      const repos = parseOptionalStringArrayField(McpToolId.GetContextCapsule, input, "repos");
      const presetRequested = parseOptionalStringField(McpToolId.GetContextCapsule, input, "preset");

      if (typeof query !== "string") {
        return query;
      }
      if (maxResults !== undefined && typeof maxResults !== "number") {
        return maxResults;
      }
      if (maxBudgetCharacters !== undefined && typeof maxBudgetCharacters !== "number") {
        return maxBudgetCharacters;
      }
      if (maxTokens !== undefined && typeof maxTokens !== "number") {
        return maxTokens;
      }
      if (repos !== undefined && !Array.isArray(repos)) {
        return repos;
      }
      if (presetRequested !== undefined && typeof presetRequested !== "string") {
        return presetRequested;
      }
      if (presetRequested !== undefined && !isRunPipelinePresetIntent(presetRequested)) {
        return invalidRequest(
          McpToolId.GetContextCapsule,
          `MCP tool get_context_capsule preset must be one of: ${[RunPipelinePresetIntent.Auto, ...RUN_PIPELINE_CONCRETE_PRESETS].join(", ")}.`,
          { field: "preset", value: presetRequested },
        );
      }
      const capsulePreset = (
        presetRequested === undefined || presetRequested === RunPipelinePresetIntent.Auto
          ? RunPipelinePresetIntent.Modify
          : presetRequested
      ) as RunPipelineConcretePreset;

      // Hidden migration aliases; compatibility validation never changes routing.
      const engineSnake = parseOptionalStringField(McpToolId.GetContextCapsule, input, "capsule_engine");
      if (engineSnake !== undefined && typeof engineSnake !== "string") {
        return engineSnake;
      }
      const engineCamel = parseOptionalStringField(McpToolId.GetContextCapsule, input, "capsuleEngine");
      if (engineCamel !== undefined && typeof engineCamel !== "string") {
        return engineCamel;
      }
      // Validate compatibility before opening the index or running retrieval.
      let capsuleCompatibility;
      try {
        capsuleCompatibility = resolveCapsuleCompatibility(engineSnake ?? engineCamel);
      } catch (error) {
        const compatibilityError = error as CapsuleEngineCompatibilityError;
        return invalidRequest(
          McpToolId.GetContextCapsule,
          compatibilityError.message,
          { error: compatibilityError.code },
        );
      }

      const capsuleIntentRaw = parseOptionalStringField(McpToolId.GetContextCapsule, input, "capsule_intent");
      if (capsuleIntentRaw !== undefined && typeof capsuleIntentRaw !== "string") {
        return capsuleIntentRaw;
      }
      const capsuleBudgetTokens = parseOptionalInteger(McpToolId.GetContextCapsule, input, "capsule_budget_tokens");
      if (capsuleBudgetTokens !== undefined && typeof capsuleBudgetTokens !== "number") {
        return capsuleBudgetTokens;
      }
      const detailRequested = parseOptionalStringField(McpToolId.GetContextCapsule, input, "detail");
      if (detailRequested !== undefined && typeof detailRequested !== "string") {
        return detailRequested;
      }
      if (detailRequested !== undefined && !isMcpResponseDetail(detailRequested)) {
        return invalidRequest(
          McpToolId.GetContextCapsule,
          `MCP tool get_context_capsule detail must be one of: ${Object.values(McpResponseDetail).join(", ")}.`,
          { field: "detail", value: detailRequested },
        );
      }
      const includeItemContent = parseOptionalBoolean(McpToolId.GetContextCapsule, input, "include_item_content");
      const requestedRoot = parseOptionalStringField(McpToolId.GetContextCapsule, input, "repo_root");
      if (requestedRoot !== undefined && typeof requestedRoot !== "string") {
        return requestedRoot;
      }
      if (includeItemContent !== undefined && typeof includeItemContent !== "boolean") {
        return includeItemContent;
      }

      let capsuleV2Intent: CapsuleIntent | undefined;
      if (capsuleIntentRaw !== undefined) {
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
      if (capsuleBudgetTokens !== undefined && capsuleBudgetTokens <= 0) {
        return invalidRequest(
          McpToolId.GetContextCapsule,
          "MCP tool get_context_capsule requires capsule_budget_tokens to be a positive integer.",
          { capsule_budget_tokens: capsuleBudgetTokens },
        );
      }

      // M151: the same resolver `run_pipeline` uses, so both surfaces agree on
      // which repository answered rather than one routing and the other not (§42).
      const routed = await resolveProductRouteForRequest(context, McpToolId.GetContextCapsule, {
        query,
        ...(requestedRoot === undefined ? {} : { requestedRoot }),
        ...(repos === undefined ? {} : { repos }),
      });

      if (!routed.ok) {
        return routed.result;
      }

      const productRoute = routed.route;

      return withReadyRepoDb(
        rebindMcpContext(context, productRoute.lead!.rootPath),
        McpToolId.GetContextCapsule,
        async (binding, db, stores) => {
          const sourceRunId = getLatestIndexRun(db)?.id ?? null;
          const accountingStartedAt = performance.now();
          const productBudgetTokens = capsuleBudgetTokens
            ?? maxTokens
            ?? (legacyMaxBudgetCharacters === undefined
              ? CAPSULE_V2_PRODUCT_DEFAULT_BUDGET_TOKENS
              : Math.max(1, Math.floor(legacyMaxBudgetCharacters / 4)));
          const authoritativeRetrieval = buildAuthoritativeProductRetrieval(
            db,
            binding.repoRoot,
            {
              query,
              preset: capsulePreset,
              maxBudgetCharacters: productBudgetTokens * 4,
              ...(capsuleV2Intent === undefined ? {} : { capsuleIntent: capsuleV2Intent }),
            },
          );
          const productContext = await assembleProductContext({
            stores: stores.read,
            repoRoot: binding.repoRoot,
            task: query,
            intent: capsuleV2Intent ?? capsuleIntentForPreset(capsulePreset),
            budgetTokens: productBudgetTokens,
            authoritativeRetrieval,
          });

          const result = authoritativeRetrieval.result;
          const capsuleResult = toCapsuleV2ProductResponse(result, { query });
          const capsuleManifestId = persistCapsuleManifestBestEffort(
            stores.write,
            authoritativeRetrieval.capsule,
            sourceRunId,
          );
          const inspectFirst = buildInspectFirst(capsuleResult);
          const output: CapsuleToolOutput = {
            query,
            intent: capsuleResult.intent,
            capsule: {
              implementation: "hybrid",
              retrievalVersion: authoritativeRetrieval.version,
              selectionAuthority: "hybrid",
              rescueAttempted: result.diagnostics.routed_rescue?.attempted === true,
              compatibilityWarnings: capsuleCompatibility.warnings,
            },
            runtime: getRuntimeProvenance(),
            inspectFirst,
            capsuleManifestId,
            capsuleResult,
            productContext,
            workspaceRouting: formatProductRoutingMetadata(productRoute.routing),
          };
          const accounting = await buildContextAccountingBestEffort({
            repoRoot: binding.repoRoot,
            emittedValue: output,
            filePathGroups: [capsuleResult.pivots, capsuleResult.support],
            latencyMs: performance.now() - accountingStartedAt,
          });
          if (accounting !== undefined) output.accounting = accounting;
          return {
            ok: true,
            output: compactProductResponse(output, {
              requestedContextTokens: productBudgetTokens,
              ...(detailRequested === undefined ? {} : { detail: detailRequested }),
              ...(includeItemContent === undefined ? {} : { includeItemContent }),
            }),
          };
        },
        requestedRoot,
      );
    },
  }),
  createEngineDelegateToolDefinition<GetImpactGraphInput, ImpactProductResponse>({
    metadata: {
      toolId: McpToolId.GetImpactGraph,
      displayName: "Get Impact Graph",
      description: "Return bounded, worktree-specific static impact evidence for one exact indexed symbol FQN. symbol_fqn uses the canonical indexed grammar `<repo-relative-path>::<Symbol>[.<member>]` — `pkg/api.py::checkout` (module-level function), `pkg/core.py::PriceEngine` (class), `pkg/core.py::PriceEngine.apply_discount` (method). A local name alone does not resolve, and a non-null get_code_context items[].fqName can be passed here verbatim. max_edges bounds the canonical delivered edge set; nodes, paths, directRelations, and view are projections of that set. max_tokens bounds model-facing impact content, with an 800-token minimum metadata allowance for the complete serialized response. depth/max_paths bound retained path evidence and cannot expose additional graph data through compatibility fields.",
      inputSchema: objectSchema(
        "Bounded structural impact-graph request.",
        {
          symbol_fqn: stringProperty("Exact fully qualified symbol name to resolve."),
          depth: integerProperty("Optional bounded traversal depth. Defaults to 5."),
          cross_repo: booleanProperty("Optional cross-repo traversal flag. The current repo-bound implementation only supports false."),
          format: stringProperty(`Optional output format: ${IMPACT_FORMATS.join(", ")}.`),
          direction: stringProperty("Optional rich-impact traversal direction: upstream, downstream, or both. Legacy nodes/edges remain reverse-impact compatible."),
          relations: arrayProperty(`Optional semantic relation filter. Supported values: ${STATIC_RELATION_KINDS.join(", ")}.`, stringProperty("Relation kind.")),
          max_paths: integerProperty("Maximum number of ranked paths projected from the canonical retained graph. Defaults to 3."),
          max_edges: integerProperty("Maximum number of unique canonical impact edges delivered across all response projections. Traversal may examine more. Defaults to 64."),
          max_tokens: integerProperty("Approximate chars/4 budget for model-facing impact content. The complete response adds max(800, 15%) metadata tokens and is checked after all fields are attached. Defaults to 1200."),
          include_lexical: booleanProperty("Include explicitly lexical evidence. Lexical evidence is never counted as an exact call."),
          include_unresolved: booleanProperty("Include recognized unresolved evidence when available; targets are never fabricated."),
          include_evidence: booleanProperty("Include bounded source grounding and resolution methods. Defaults to true."),
          repo_root: REPO_ROOT_PROPERTY,
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
          directRelations: arrayProperty("Typed incoming and outgoing direct relationships.", STATIC_RELATION_EVIDENCE_SCHEMA),
          paths: arrayProperty("Bounded strongest static dependency paths.", STATIC_IMPACT_PATH_SCHEMA),
          affectedFiles: arrayProperty("Static review guidance grouped by affected file.", { type: "object", description: "Affected-file summary.", additionalProperties: true }),
          entrypoints: arrayProperty("Entrypoint-like exported symbols reached by upstream paths, with evidence and limitations.", { type: "object", description: "Classified entrypoint-like symbol.", additionalProperties: true }),
          tests: arrayProperty("Test symbols reached by upstream paths, with evidence and limitations.", { type: "object", description: "Classified test symbol.", additionalProperties: true }),
          richSummary: { type: "object", description: "Separate direct/transitive, incoming/outgoing, relation/strength, and truncation counts.", additionalProperties: true },
          limits: { type: "object", description: "Applied depth/path/edge/token bounds.", additionalProperties: true },
          timing: { type: "object", description: "Target-resolution, neighbor-query, path-traversal, render, and total impact timings in milliseconds.", additionalProperties: true },
          diagnostics: { type: "object", description: "Static-only boundary, traversal counters, and limitations.", additionalProperties: true },
          callerCoverage: CALLER_COVERAGE_SCHEMA,
          potentialCallers: arrayProperty(
            "Bounded unproven call sites that may reach the target. Separate from edges on purpose: these are not proven relations.",
            POTENTIAL_CALLER_SCHEMA,
          ),
          accounting: CONTEXT_ACCOUNTING_SCHEMA,
          responseBudget: { type: "object", description: "Final complete-response and canonical-edge accounting; withinEnvelope is always true on success.", additionalProperties: true },
        },
        ["requested", "resolvedSymbol", "coverage", "summary", "dependentFiles", "nodes", "edges", "view", "responseBudget", "callerCoverage", "potentialCallers"],
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
      const direction = parseOptionalStringField(McpToolId.GetImpactGraph, input, "direction");
      const relations = parseOptionalStringArrayField(McpToolId.GetImpactGraph, input, "relations");
      const maxPaths = parseOptionalInteger(McpToolId.GetImpactGraph, input, "max_paths");
      const maxEdges = parseOptionalInteger(McpToolId.GetImpactGraph, input, "max_edges");
      const maxTokens = parseOptionalInteger(McpToolId.GetImpactGraph, input, "max_tokens");
      const includeLexical = parseOptionalBoolean(McpToolId.GetImpactGraph, input, "include_lexical");
      const includeUnresolved = parseOptionalBoolean(McpToolId.GetImpactGraph, input, "include_unresolved");
      const includeEvidence = parseOptionalBoolean(McpToolId.GetImpactGraph, input, "include_evidence");
      const requestedRoot = parseOptionalStringField(McpToolId.GetImpactGraph, input, "repo_root");

      if (requestedRoot !== undefined && typeof requestedRoot !== "string") {
        return requestedRoot;
      }
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
      for (const parsed of [direction, relations, maxPaths, maxEdges, maxTokens, includeLexical, includeUnresolved, includeEvidence]) {
        if (parsed !== undefined && !Array.isArray(parsed) && typeof parsed === "object") return parsed;
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
      if (direction !== undefined && !["upstream", "downstream", "both"].includes(direction)) {
        return invalidRequest(McpToolId.GetImpactGraph, "MCP tool get_impact_graph requires direction to be upstream, downstream, or both.", { direction });
      }
      if (relations !== undefined && relations.some((relation) => !STATIC_RELATION_KINDS.includes(relation as StaticRelationKind))) {
        return invalidRequest(McpToolId.GetImpactGraph, "MCP tool get_impact_graph received an unsupported relation kind.", { relations });
      }
      if ([maxPaths, maxEdges, maxTokens].some((value) => typeof value === "number" && value <= 0)) {
        return invalidRequest(McpToolId.GetImpactGraph, "MCP tool get_impact_graph bounds must be positive integers.", { max_paths: maxPaths, max_edges: maxEdges, max_tokens: maxTokens });
      }
      if ((depth ?? 5) > 8 || (maxPaths ?? 3) > 16 || (maxEdges ?? 64) > 2_000 || (maxTokens ?? 1_200) > 20_000) {
        return invalidRequest(McpToolId.GetImpactGraph, "MCP tool get_impact_graph exceeds a hard bound (depth<=8, max_paths<=16, max_edges<=2000, max_tokens<=20000).", { depth, max_paths: maxPaths, max_edges: maxEdges, max_tokens: maxTokens });
      }

      return withReadyRepoDb(
        context,
        McpToolId.GetImpactGraph,
        async (binding, db, stores) => {
          const accountingStartedAt = performance.now();
          const result = getImpactGraph(db, {
            symbolFqn,
            depth: depth ?? 5,
            format: resolvedFormat as ImpactFormat,
            ...(direction === undefined ? {} : { direction: direction as "upstream" | "downstream" | "both" }),
            ...(relations === undefined ? {} : { relations: relations as StaticRelationKind[] }),
            ...(typeof maxPaths !== "number" ? {} : { maxPaths }),
            ...(typeof maxEdges !== "number" ? {} : { maxEdges }),
            ...(typeof maxTokens !== "number" ? {} : { maxTokens }),
            ...(typeof includeLexical !== "boolean" ? {} : { includeLexical }),
            ...(typeof includeUnresolved !== "boolean" ? {} : { includeUnresolved }),
            ...(typeof includeEvidence !== "boolean" ? {} : { includeEvidence }),
          }, {
            repoRoot: binding.repoRoot,
            measureTiming: true,
          });

          if (!result.ok) {
            return invalidRequest(McpToolId.GetImpactGraph, result.error.message, result.error.details);
          }

          // Deterministic, best-effort accounting over the emitted impact view.
          // The naive baseline reads every file the nodes (root + dependents) and
          // any inline dependent excerpts represent.
          const accounting = await buildContextAccountingBestEffort({
            repoRoot: binding.repoRoot,
            emittedValue: result.output,
            filePathGroups: impactGraphOutputFilePathGroups(result.output),
            latencyMs: performance.now() - accountingStartedAt,
          });

          const outputWithAccounting = accounting === undefined
            ? result.output
            : { ...result.output, accounting };
          const compactedOutput = compactImpactProductResponse(outputWithAccounting);
          const currentContext = await resolveCurrentObservationContext(binding.repoRoot);
          // Capture the exact bounded product result delivered to the caller,
          // never the larger pre-envelope working graph. Before M138 this seam
          // produced the real ARC 10/7 memory claim while the tool returned 3/3.
          captureImpactGraphObservationBestEffort({
            stores: stores.write,
            repoRoot: binding.repoRoot,
            sourceRunId: getLatestIndexRun(db)?.id ?? null,
            output: compactedOutput,
            toolName: McpToolId.GetImpactGraph,
            currentContext,
          });
          return {
            ok: true,
            output: compactedOutput,
          };
        },
        requestedRoot,
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
          max_depth: integerProperty("Optional maximum path depth. Defaults to 8."),
          max_edges: integerProperty("Optional traversal budget: the maximum number of edges the bounded search may relax. It bounds work, not which edges exist in the graph. Defaults to 20000; summary.traversalLimitReached reports when it bit."),
          max_tokens: integerProperty("Optional approximate token cap for returned path evidence. Defaults to 20000 for compatibility."),
          relations: arrayProperty(`Optional semantic relation filter. Supported values: ${STATIC_RELATION_KINDS.join(", ")}.`, stringProperty("Relation kind.")),
          include_lexical: booleanProperty("Include explicitly lexical relationships. They remain labeled lexical and never become confirmed calls."),
          cross_repo: booleanProperty("Optional cross-repo traversal flag. The current repo-bound implementation only supports false."),
          repo_root: REPO_ROOT_PROPERTY,
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
          limits: { type: "object", description: "Applied depth/path/edge/token bounds.", additionalProperties: true },
          timing: { type: "object", description: "Target-resolution, traversal, render, and total flow timings in milliseconds.", additionalProperties: true },
          diagnostics: { type: "object", description: "Static-only boundary, traversal counters, omissions, and limitations.", additionalProperties: true },
          accounting: CONTEXT_ACCOUNTING_SCHEMA,
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
      const maxDepth = parseOptionalInteger(McpToolId.SearchLogicFlow, input, "max_depth");
      const maxEdges = parseOptionalInteger(McpToolId.SearchLogicFlow, input, "max_edges");
      const maxTokens = parseOptionalInteger(McpToolId.SearchLogicFlow, input, "max_tokens");
      const relations = parseOptionalStringArrayField(McpToolId.SearchLogicFlow, input, "relations");
      const includeLexical = parseOptionalBoolean(McpToolId.SearchLogicFlow, input, "include_lexical");
      const requestedRoot = parseOptionalStringField(McpToolId.SearchLogicFlow, input, "repo_root");

      if (requestedRoot !== undefined && typeof requestedRoot !== "string") {
        return requestedRoot;
      }
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
      for (const parsed of [maxDepth, maxEdges, maxTokens, relations, includeLexical]) {
        if (parsed !== undefined && !Array.isArray(parsed) && typeof parsed === "object") return parsed;
      }

      if ((maxPaths ?? 3) <= 0) {
        return invalidRequest(
          McpToolId.SearchLogicFlow,
          "MCP tool search_logic_flow requires max_paths to be a positive integer when provided.",
          { field: "max_paths", value: maxPaths },
        );
      }
      if ([maxDepth, maxEdges, maxTokens].some((value) => typeof value === "number" && value <= 0)) {
        return invalidRequest(McpToolId.SearchLogicFlow, "MCP tool search_logic_flow bounds must be positive integers.", { max_depth: maxDepth, max_edges: maxEdges, max_tokens: maxTokens });
      }
      if (
        (maxPaths ?? 3) > 16
        || (maxDepth ?? 8) > 12
        || (maxEdges ?? DEFAULT_TRAVERSAL_EDGE_BUDGET) > MAX_TRAVERSAL_EDGE_BUDGET
        || (maxTokens ?? 20_000) > 20_000
      ) {
        return invalidRequest(McpToolId.SearchLogicFlow, `MCP tool search_logic_flow exceeds a hard bound (max_paths<=16, max_depth<=12, max_edges<=${MAX_TRAVERSAL_EDGE_BUDGET}, max_tokens<=20000).`, { max_paths: maxPaths, max_depth: maxDepth, max_edges: maxEdges, max_tokens: maxTokens });
      }
      if (relations !== undefined && relations.some((relation) => !STATIC_RELATION_KINDS.includes(relation as StaticRelationKind))) {
        return invalidRequest(McpToolId.SearchLogicFlow, "MCP tool search_logic_flow received an unsupported relation kind.", { relations });
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
        async (binding, db, stores) => {
          const accountingStartedAt = performance.now();
          const result = searchLogicFlow(db, {
            start,
            end,
            maxPaths: maxPaths ?? 3,
            ...(typeof maxDepth !== "number" ? {} : { maxDepth }),
            ...(typeof maxEdges !== "number" ? {} : { maxEdges }),
            ...(typeof maxTokens !== "number" ? {} : { maxTokens }),
            ...(relations === undefined ? {} : { relations: relations as StaticRelationKind[] }),
            ...(typeof includeLexical !== "boolean" ? {} : { includeLexical }),
          }, {
            repoRoot: binding.repoRoot,
            measureTiming: true,
          });

          if (!result.ok) {
            return invalidRequest(McpToolId.SearchLogicFlow, result.error.message, result.error.details);
          }

          const currentContext = await resolveCurrentObservationContext(binding.repoRoot);
          captureLogicFlowObservationBestEffort({
            stores: stores.write,
            repoRoot: binding.repoRoot,
            sourceRunId: getLatestIndexRun(db)?.id ?? null,
            output: result.output,
            toolName: McpToolId.SearchLogicFlow,
            currentContext,
          });

          // Deterministic, best-effort accounting over the emitted flow output.
          // The naive baseline reads the start/end files plus every file the
          // returned path nodes and per-step excerpts represent.
          const accounting = await buildContextAccountingBestEffort({
            repoRoot: binding.repoRoot,
            emittedValue: result.output,
            filePathGroups: logicFlowOutputFilePathGroups(result.output),
            latencyMs: performance.now() - accountingStartedAt,
          });

          return {
            ok: true,
            output: accounting === undefined
              ? result.output
              : { ...result.output, accounting },
          };
        },
        requestedRoot,
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
          repo_root: REPO_ROOT_PROPERTY,
        },
        ["files"],
      ),
      outputSchema: objectSchema(
        "Deterministic structural file skeletons.",
        {
          detail: GET_SKELETON_OUTPUT_SCHEMA.properties.detail!,
          files: GET_SKELETON_OUTPUT_SCHEMA.properties.files!,
          accounting: CONTEXT_ACCOUNTING_SCHEMA,
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
      const requestedRoot = parseOptionalStringField(McpToolId.GetSkeleton, input, "repo_root");

      if (!Array.isArray(files)) {
        return files;
      }
      if (detail !== undefined && typeof detail !== "string") {
        return detail;
      }
      if (requestedRoot !== undefined && typeof requestedRoot !== "string") {
        return requestedRoot;
      }

      return withReadyRepoDb(
        context,
        McpToolId.GetSkeleton,
        async (binding, db, stores) => {
          const accountingStartedAt = performance.now();
          const output = await getSkeleton(db, {
            repoRoot: binding.repoRoot,
            files,
            detail: detail ?? "standard",
          });

          const currentContext = await resolveCurrentObservationContext(binding.repoRoot);
          captureSkeletonObservationBestEffort({
            stores: stores.write,
            repoRoot: binding.repoRoot,
            sourceRunId: getLatestIndexRun(db)?.id ?? null,
            output,
            toolName: McpToolId.GetSkeleton,
            requestedFiles: files,
            currentContext,
          });

          // Deterministic, best-effort accounting over the emitted skeletons. The
          // naive baseline reads the full contents of each skeletonized file;
          // files missing on disk are skipped, not counted.
          const accounting = await buildContextAccountingBestEffort({
            repoRoot: binding.repoRoot,
            emittedValue: output,
            filePathGroups: skeletonOutputFilePathGroups(output),
            latencyMs: performance.now() - accountingStartedAt,
          });

          return {
            ok: true,
            output: accounting === undefined
              ? output
              : { ...output, accounting },
          };
        },
        requestedRoot,
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
          repo_root: REPO_ROOT_PROPERTY,
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
      const requestedRoot = parseOptionalStringField(McpToolId.IndexStatus, input, "repo_root");

      if (repos !== undefined && !Array.isArray(repos)) {
        return repos;
      }
      if (requestedRoot !== undefined && typeof requestedRoot !== "string") {
        return requestedRoot;
      }
      if (requestedRoot !== undefined && repos !== undefined) {
        return invalidRequest(McpToolId.IndexStatus, "index_status cannot combine repo_root with workspace repos.");
      }
      const repoRoot = await resolveRequestedRepoRoot(context, McpToolId.IndexStatus, requestedRoot);
      if (typeof repoRoot !== "string") {
        return repoRoot;
      }
      const effectiveContext = rebindMcpContext(context, repoRoot);

      const selection = await resolveWorkspaceRepoSelection(effectiveContext, McpToolId.IndexStatus, repos, {
        includeDisabledByDefault: true,
        allowDisabledSelection: true,
      });

      if (!selection.ok) {
        return selection.result;
      }

      if (hasMultiRepoRequest(selection.selection, repos)) {
        // M151: one full status record per member had no bound, so a 1000-member
        // workspace serialised 1000 of them. The census below is computed over
        // EVERY selected member and the record list is a bounded sample of it —
        // truth from the totals, never from what happened to be displayed (§39).
        const statuses = selection.selection.statuses;

        return {
          ok: true,
          output: {
            workspace: formatWorkspaceMetadata(selection.selection),
            coverage: summarizeWorkspaceCoverage(statuses),
            // Deterministic: `statuses` follows the config's own member order,
            // so the sample does not depend on filesystem or SQLite ordering.
            repos: statuses.slice(0, MAX_REPORTED_COVERAGE_EXAMPLES).map(formatWorkspaceRepoStatus),
            runtime: getRuntimeProvenance(),
          },
        };
      }

      try {
        return {
          ok: true,
          output: {
            ...await inspectIndexStatus(effectiveContext),
            runtime: getRuntimeProvenance(),
          },
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

/**
 * Every registered tool definition, deduplicated by tool id.
 *
 * RESERVED wins over LEGACY where both define an id: that is the same
 * precedence `defaultMcpToolRegistry` encodes by filtering the five promoted
 * ids out of its hidden list, expressed once so a restricted registry cannot
 * drift from it.
 */
function allMcpToolDefinitions(): readonly McpToolDefinition[] {
  const byId = new Map<McpToolId, McpToolDefinition>();
  for (const tool of [...RESERVED_MCP_TOOL_DEFINITIONS, ...LEGACY_MCP_TOOL_DEFINITIONS]) {
    if (!byId.has(tool.metadata.toolId)) byId.set(tool.metadata.toolId, tool);
  }
  return [...byId.values()];
}

/**
 * A registry whose MODEL-VISIBLE surface is exactly `visibleToolIds`.
 *
 * Restricting visibility is a real capability, not a benchmark affordance: a
 * tool's name, description, and input schema sit in the agent's prompt prefix
 * and are re-read every turn, so the full surface costs thousands of tokens
 * whether or not the agent ever calls any of it. A caller that wants two tools
 * should pay for two.
 *
 * Unlisted tools become HIDDEN rather than unregistered, which is the same
 * state `search_symbols` already occupies: absent from `tools/list`, still
 * resolvable by exact id. Nothing is removed from the product.
 *
 * Throws on an unknown id rather than silently serving a smaller surface than
 * the caller asked for — a typo here would otherwise look like a tool the model
 * simply chose not to use.
 */
export function createRestrictedMcpToolRegistry(
  visibleToolIds: readonly McpToolId[],
): McpToolRegistry {
  const all = allMcpToolDefinitions();
  const byId = new Map(all.map((tool) => [tool.metadata.toolId, tool] as const));

  const visible: McpToolDefinition[] = [];
  const seen = new Set<McpToolId>();
  for (const toolId of visibleToolIds) {
    const tool = byId.get(toolId);
    if (tool === undefined) {
      throw new Error(
        `Unknown MCP tool id in visible tool set: ${toolId}. `
        + `Known ids: ${all.map((candidate) => candidate.metadata.toolId).sort().join(", ")}`,
      );
    }
    if (seen.has(toolId)) continue;
    seen.add(toolId);
    visible.push(tool);
  }

  return createMcpToolRegistry({
    tools: visible,
    hiddenTools: all.filter((tool) => !seen.has(tool.metadata.toolId)),
  });
}

export const defaultMcpToolRegistry = createMcpToolRegistry({
  tools: RESERVED_MCP_TOOL_DEFINITIONS,
  hiddenTools: LEGACY_MCP_TOOL_DEFINITIONS.filter((tool) => (
    tool.metadata.toolId !== McpToolId.SaveObservation
    && tool.metadata.toolId !== McpToolId.SearchMemory
    && tool.metadata.toolId !== McpToolId.GetSessionContext
    && tool.metadata.toolId !== McpToolId.IndexRepo
    && tool.metadata.toolId !== McpToolId.CheckCapsuleStaleness
  )),
});
