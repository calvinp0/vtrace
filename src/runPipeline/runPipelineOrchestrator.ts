import type { Database } from "bun:sqlite";

import { buildCapsule } from "../capsule/buildCapsule";
import {
  CapsuleInclusionReasonKind,
  type Capsule,
  type CapsuleInclusionReason,
  type CapsuleItem,
  type CapsuleSupportingCandidate,
} from "../capsule/types";
import { prepareCapsuleAssembly } from "../capsuleProfiles/orchestrator";
import type { PreparedCapsuleAssembly } from "../capsuleProfiles/types";
import { buildCapsuleV2 } from "../capsuleV2/buildCapsuleV2";
import {
  capsuleV2ToManifestItemFields,
  toCapsuleV2ProductResponse,
  type CapsuleV2DigestImpactSeam,
  type CapsuleV2DigestMemoryItem,
  type CapsuleV2DigestMemorySeam,
  type CapsuleV2DigestRuleItem,
  type CapsuleV2DigestRulesSeam,
  type CapsuleV2ProductResponse,
} from "../capsuleV2/productAdapter";
import { CapsuleIntent } from "../capsuleV2/types";
import {
  parseRequestedCapsuleEngine,
  requestWantsCapsuleV2,
  v1EngineSelection,
  v2EngineSelection,
  type CapsuleEngineSelection,
} from "../capsuleV2/engineSelection";
import {
  buildPivotNeighborhoods,
  type PivotNeighborhoodContext,
} from "./pivotNeighborhood";
import { buildInspectFirst, type InspectFirst } from "./inspectFirst";
import { getImpactGraph, type ImpactGraphOutput } from "../impact/getImpactGraph";
import { impactGraphToDigestSeam } from "../impact/impactDigestSeam";
import {
  searchLogicFlow,
  type LogicFlowOutput,
} from "../logicFlow/searchLogicFlow";
import {
  defaultIntentClassifier,
  type IntentClassifier,
} from "../intent/classifier";
import { routeQuery, type RoutedQueryResult } from "../intent/routeQuery";
import { normalizeIntentQuery } from "../intent/rules";
import { QueryIntent } from "../intent/types";
import { StaleStateStatus } from "../memory/types";
import { getSessionContext } from "../observations/getSessionContext";
import { searchMemory } from "../observations/searchMemory";
import type {
  Observation,
  ObservationSearchResult,
  SessionContextResult,
} from "../observations/types";
import { normalizeSearchQuery } from "../retrieval/searchSymbolsShared";
import type { GraphSearchResult, SymbolSearchResult } from "../retrieval/types";
import type { SymbolKind } from "../domain/types";
import { createCharacterBudget } from "../capsule/budget";
import { createSourceBackedCapsuleBuilder } from "../capsule/buildCapsule";
import { computeVisibleCapsuleObservationDedupeKey } from "../observations/autoCapture";
import { getLatestIndexRun } from "../db/repositories/indexRunsRepository";
import {
  persistCapsuleManifestBestEffort,
  persistCapsuleV2ManifestBestEffort,
} from "../db/repositories/capsuleManifestsRepository";
import { persistDeferredVexpRef } from "../db/repositories/deferredVexpRefsRepository";
import {
  selectRelevantProjectRules,
} from "../projectRules/projectRules";
import type { SelectedProjectRule } from "../projectRules/types";
import {
  isRunPipelinePresetIntent,
  mapPresetToQueryIntent,
  selectRunPipelineIntent,
} from "./selectIntent";
import { resolveNormalizedIntent } from "./resolveNormalizedIntent";
import {
  NormalizedIntent,
  NormalizedIntentSource,
  type NormalizedIntentDecision,
} from "../intent/normalizedIntent";
import {
  RUN_PIPELINE_SCHEMA_VERSION,
  RunPipelineContextSkipReason,
  RunPipelineDeferredKind,
  RunPipelineDurableMemorySkipReason,
  RunPipelineFlowEndpointStrategy,
  RunPipelineFlowSkipReason,
  RunPipelineImpactSkipReason,
  RunPipelineIntentSource,
  RunPipelinePresetIntent,
  RunPipelineSessionSkipReason,
  type RunPipelineConcretePreset,
  type RunPipelineDeferredPlaceholder,
  type RunPipelineIntentDecision,
} from "./types";
import {
  DeferredVexpCategory,
  getSharedDeferredVexpStore,
  type DeferredVexpStore,
} from "./deferredVexpStore";

export interface RunPipelineOrchestratorInput {
  readonly query: string;
  readonly maxResults?: number;
  readonly maxBudgetCharacters?: number;
  readonly intent?: string;
  readonly sessionId?: string;
  readonly includeMemory?: boolean;
  readonly includeTests?: boolean;
  readonly includeFileContent?: boolean;
  /**
   * Opt-in context engine. When set to `v2` (case-insensitive) the orchestration
   * additionally builds a bounded Capsule v2 product section alongside the
   * unchanged v1 sections. Any other value (or omission) keeps the v1-only path.
   */
  readonly capsuleEngine?: string;
  /** Capsule v2 token budget. Only used when `capsuleEngine=v2`. */
  readonly capsuleBudgetTokens?: number;
  /** Capsule v2 intent. Only used when `capsuleEngine=v2`. Defaults to auto. */
  readonly capsuleIntent?: CapsuleIntent;
}

// The opt-in discriminator value for the Capsule v2 context engine. The default
// (unset) path stays byte-identical to the v1-only orchestration.
export const RUN_PIPELINE_CAPSULE_ENGINE_V2 = "v2";

export const RUN_PIPELINE_DEFAULTS = Object.freeze({
  maxResults: 6,
  maxBudgetCharacters: 2_000,
  sessionRecentObservationLimit: 4,
  durableMemoryMaxResults: 3,
  impactDepth: 2,
  impactMaxTopDependents: 4,
  flowMaxPaths: 3,
  // Capsule v2 token budget when the caller opts in without an explicit budget.
  // Matches the get_context_capsule v2 default so both product paths size the
  // same first-call context.
  capsuleV2BudgetTokens: 8_000,
});

export interface OrchestrationRetrievalDiagnostics {
  readonly fallbackApplied: boolean;
  readonly fallbackMode: string | null;
  readonly fallbackRecovered: boolean;
  readonly initialReason: RunPipelineContextSkipReason | null;
  readonly finalReason: RunPipelineContextSkipReason | null;
  readonly initialContextItemCount: number;
  readonly finalContextItemCount: number;
  readonly pathSignalsConsidered: readonly string[];
  readonly pathSignalsMatched: readonly string[];
  readonly candidateFilesConsidered: number;
  readonly weakPathCoverage: boolean;
}

export interface OrchestrationContextSection {
  readonly included: boolean;
  readonly skipReason: RunPipelineContextSkipReason | null;
  readonly capsule: Capsule;
  readonly routedQuery: RoutedQueryResult;
  readonly preparedAssembly: PreparedCapsuleAssembly;
  readonly retrievalDiagnostics: OrchestrationRetrievalDiagnostics;
}

export interface OrchestrationImpactFocalSymbol {
  readonly symbolId: string;
  readonly filePath: string;
  readonly fqName: string;
  readonly localName: string;
  readonly kind: SymbolKind;
}

export interface OrchestrationImpactSection {
  readonly included: boolean;
  readonly skipReason: RunPipelineImpactSkipReason | null;
  readonly triggerReason: string | null;
  readonly selectionSource: string | null;
  readonly focalSymbol: OrchestrationImpactFocalSymbol | null;
  readonly graph: ImpactGraphOutput | null;
  readonly candidatesConsidered: number;
  readonly matchedCandidates: number;
}

export interface OrchestrationFlowEndpoint {
  readonly symbolId: string;
  readonly filePath: string;
  readonly fqName: string;
  readonly localName: string;
  readonly kind: SymbolKind;
  readonly mentionIndex: number;
}

export interface OrchestrationFlowSection {
  readonly included: boolean;
  readonly skipReason: RunPipelineFlowSkipReason | null;
  readonly endpointStrategy: RunPipelineFlowEndpointStrategy | null;
  readonly bothDirectionsReachable: boolean;
  readonly start: OrchestrationFlowEndpoint | null;
  readonly end: OrchestrationFlowEndpoint | null;
  readonly output: LogicFlowOutput | null;
  readonly candidatesConsidered: number;
  readonly matchedCandidates: number;
}

export interface OrchestrationSessionSection {
  readonly included: boolean;
  readonly skipReason: RunPipelineSessionSkipReason | null;
  readonly sessionId: string | null;
  readonly observationCount: number;
  readonly recentObservations: readonly Observation[];
}

export interface OrchestrationDurableMemorySection {
  readonly included: boolean;
  readonly skipReason: RunPipelineDurableMemorySkipReason | null;
  readonly matchedCount: number;
  readonly topObservations: readonly ObservationSearchResult[];
}

export interface OrchestrationMemorySection {
  readonly session: OrchestrationSessionSection;
  readonly durable: OrchestrationDurableMemorySection;
}

export interface OrchestrationRulesSection {
  readonly included: boolean;
  readonly active: readonly SelectedProjectRule[];
  readonly candidates: readonly SelectedProjectRule[];
  readonly activeCount: number;
  readonly candidateCount: number;
  readonly staleCount: number;
  readonly disabledCount: number;
  readonly dismissedCount: number;
}

export interface RunPipelineOrchestration {
  readonly schemaVersion: typeof RUN_PIPELINE_SCHEMA_VERSION;
  readonly request: {
    readonly query: string;
    readonly maxResults: number;
    readonly maxBudgetCharacters: number;
    readonly intentRequested: string;
    readonly sessionId: string | null;
    readonly includeTests: boolean;
    readonly includeFileContent: boolean;
  };
  readonly intentDecision: RunPipelineIntentDecision;
  /**
   * The unified, normalized intent decision shared with Capsule v2. Reconciles
   * the preset decision, any explicit `capsuleIntent`, and explicit impact
   * phrasing into one model, and is what drives impact-section eligibility.
   */
  readonly normalizedIntent: NormalizedIntentDecision;
  readonly context: OrchestrationContextSection;
  readonly impact: OrchestrationImpactSection;
  readonly flow: OrchestrationFlowSection;
  readonly memory: OrchestrationMemorySection;
  readonly rules: OrchestrationRulesSection;
  readonly deferred: readonly RunPipelineDeferredPlaceholder[];
  /**
   * Persisted capsule manifest id for the context capsule, or null when no
   * manifest could be persisted (no index run, empty capsule). Lets a caller
   * feed the id straight into check_capsule_staleness / `vtrace check-capsule`.
   */
  readonly capsuleManifestId: string | null;
  /**
   * Bounded Capsule v2 product section, or null on the default v1-only path.
   * Built through the shared `toCapsuleV2ProductResponse` adapter so the
   * projection logic is never duplicated. Present only when the caller opts in
   * with `capsuleEngine=v2`.
   */
  readonly capsuleV2: CapsuleV2ProductResponse | null;
  /**
   * Persisted Capsule v2 manifest id, or null when v2 was not requested or no
   * manifest could be persisted. Resolves through check_capsule_staleness the
   * same way the v1 `capsuleManifestId` does.
   */
  readonly capsuleV2ManifestId: string | null;
  /**
   * Bounded pivot-neighborhood excerpts derived from the Capsule v2 pivots, or
   * null on the default v1-only path. Gives normal debug/modify queries useful
   * nearby relationship source without an explicit flow/impact trigger. Additive
   * and best-effort: never fails the run, may be an empty array when no pivot
   * symbol identity resolves.
   */
  readonly pivotNeighborhood: PivotNeighborhoodContext[] | null;
  /**
   * Resolved capsule-engine selection: what the caller requested, which engine
   * actually produced the context, and (only on a genuine v2 query/render
   * failure) the fallback reason. Always present so every run records its engine,
   * ending the split-brain where one surface saw v1 and another v2 with no audit
   * trail. The default/v1/legacy path reports `effective=v1`, `fallbackReason=null`.
   */
  readonly capsuleEngine: CapsuleEngineSelection;
  /**
   * Compact inspect-first guidance projected from the Capsule v2 pivots, or null
   * on the v1/default path (and when the v2 result has no actionable pivot). Pure,
   * bounded guidance — changes no retrieval, ranking, or scoring. This is the same
   * shared `buildInspectFirst` projection the Stage 5 injected path consumes.
   */
  readonly inspectFirst: InspectFirst | null;
}

interface ImpactCandidate {
  readonly symbolId: string;
  readonly filePath: string;
  readonly fqName: string;
  readonly localName: string;
  readonly kind: SymbolKind;
  readonly isTopPivot: boolean;
}

export function runPipelineOrchestrator(
  db: Database,
  repoRoot: string,
  rawInput: RunPipelineOrchestratorInput,
  options: {
    classifier?: IntentClassifier;
    deferredStore?: DeferredVexpStore;
    /**
     * Test-only seam to drive the Capsule v2 build. Defaults to the real
     * `buildCapsuleV2`. Lets a test force a genuine v2 query/render failure to
     * verify the v2 -> v1 fallback without touching workspace/index preparation.
     */
    capsuleV2Builder?: typeof buildCapsuleV2;
  } = {},
): RunPipelineOrchestration {
  const classifier = options.classifier ?? defaultIntentClassifier;
  const deferredStore = options.deferredStore ?? getSharedDeferredVexpStore();
  const query = rawInput.query;
  const maxResults = rawInput.maxResults ?? RUN_PIPELINE_DEFAULTS.maxResults;
  const maxBudgetCharacters =
    rawInput.maxBudgetCharacters ?? RUN_PIPELINE_DEFAULTS.maxBudgetCharacters;
  const intentRequestedRaw = rawInput.intent ?? RunPipelinePresetIntent.Auto;
  const intentRequested = isRunPipelinePresetIntent(intentRequestedRaw)
    ? intentRequestedRaw
    : RunPipelinePresetIntent.Auto;

  const classification = classifier.classify(query);
  const intentDecision = selectRunPipelineIntent({
    requested: intentRequested,
    classification,
    query,
  });
  // The single shared intent decision: reconcile the preset (retrieval routing)
  // with any explicit Capsule v2 intent and explicit impact phrasing. This is the
  // bridge between src/intent and capsuleV2 intent — impact eligibility reads from
  // it, so run_pipeline and Capsule v2 can no longer disagree about impact.
  const normalizedIntent = resolveNormalizedIntent({
    presetDecision: intentDecision,
    capsuleIntentRequested: rawInput.capsuleIntent,
    query,
    flowSupported:
      normalizeSearchQuery(query).length > 0 && hasSupportedQueryShape(query),
  });

  const context = runReliableContextRetrieval(db, repoRoot, {
    query,
    maxResults,
    maxBudgetCharacters,
    preset: intentDecision.selected,
  });
  // Persist a deterministic capsule manifest so the emitted manifest id
  // resolves against a real store in check_capsule_staleness / check-capsule.
  const capsuleManifestId = persistCapsuleManifestBestEffort(
    db,
    context.capsule,
    getLatestIndexRun(db)?.id ?? null,
  );

  // The impact / memory / rules sections are computed BEFORE the Capsule v2 build
  // so their bounded summaries can be folded into the v2 product digest (M56).
  // None of these mutate retrieval/scoring; they read the already-assembled
  // context + the index. Order change is digest-only — the returned sections are
  // identical to before.
  const impact = runImpactSection(db, repoRoot, context, normalizedIntent);
  const flow = runFlowSection(db, repoRoot, context);
  const memory = runMemorySection(db, {
    query,
    sessionId: rawInput.sessionId ?? null,
    intentDecision,
    includeMemory: rawInput.includeMemory,
  });
  const rules = runRulesSection(db, repoRoot, {
    query,
    intent: intentDecision.selected,
    context,
  });

  // Opt-in Capsule v2 section. The default (no `capsuleEngine`) path leaves both
  // fields null and the v1 sections untouched, so existing output is byte
  // identical. When opted in we build the bounded, intent-aware v2 capsule,
  // project it through the shared product adapter (with the impact/memory/rules
  // seams derived above folded into the digest), and persist a manifest the same
  // way the v1 path does (resolvable by check_capsule_staleness).
  const capsuleV2Build = buildCapsuleV2Section(db, repoRoot, query, rawInput, {
    builder: options.capsuleV2Builder ?? buildCapsuleV2,
    digestEnrichments: {
      impact: deriveImpactDigestSeam(impact),
      memory: deriveMemoryDigestSeam(memory),
      rules: deriveRulesDigestSeam(rules),
    },
  });

  const deferred = buildDeferredPlaceholders({
    db,
    context,
    impact,
    flow,
    memory,
    repoRoot,
    store: deferredStore,
    sourceRunId: getLatestIndexRun(db)?.id ?? null,
    request: {
      query,
      maxBudgetCharacters,
      sessionId: rawInput.sessionId ?? null,
    },
  });

  return {
    schemaVersion: RUN_PIPELINE_SCHEMA_VERSION,
    request: {
      query,
      maxResults,
      maxBudgetCharacters,
      intentRequested,
      sessionId: rawInput.sessionId ?? null,
      includeTests: rawInput.includeTests ?? intentDecision.selected === RunPipelinePresetIntent.Debug,
      includeFileContent: rawInput.includeFileContent ?? true,
    },
    intentDecision,
    normalizedIntent,
    context,
    impact,
    flow,
    memory,
    rules,
    deferred,
    capsuleManifestId,
    capsuleV2: capsuleV2Build.capsuleV2,
    capsuleV2ManifestId: capsuleV2Build.capsuleV2ManifestId,
    pivotNeighborhood: capsuleV2Build.pivotNeighborhood,
    capsuleEngine: capsuleV2Build.capsuleEngine,
    inspectFirst: capsuleV2Build.inspectFirst,
  };
}

interface CapsuleV2SectionResult {
  readonly capsuleV2: CapsuleV2ProductResponse | null;
  readonly capsuleV2ManifestId: string | null;
  readonly pivotNeighborhood: PivotNeighborhoodContext[] | null;
  readonly capsuleEngine: CapsuleEngineSelection;
  readonly inspectFirst: InspectFirst | null;
}

// Build the opt-in Capsule v2 product section and resolve the engine selection.
// The default/v1/legacy path returns the v2 fields as null and reports
// `effective=v1`. When the caller opts into v2 the bounded, intent-aware v2
// capsule is built, projected through the shared product adapter, persisted as a
// manifest (resolvable by check_capsule_staleness exactly like the
// get_context_capsule v2 path), enriched with pivot-neighborhood excerpts, and
// projected into compact inspect-first guidance.
//
// Requirement: a genuine v2 query/render failure (the build throwing) falls back
// to the v1 sections — which have already been assembled above — and records the
// reason. Workspace/index preparation runs entirely outside this function (the DB
// is already open and indexed before the orchestrator is called), so such failures
// are never caught here and never masquerade as a capsule-engine fallback.
interface DigestEnrichments {
  readonly impact: CapsuleV2DigestImpactSeam | null;
  readonly memory: CapsuleV2DigestMemorySeam | null;
  readonly rules: CapsuleV2DigestRulesSeam | null;
}

// How many representative rows each enriched digest section spells out. The
// header counts still report the true totals; these caps only bound the inline
// preview the adapter folds into the digest. (Impact's representative cap lives in
// the shared impactGraphToDigestSeam mapper.)
const MAX_DIGEST_MEMORY_REPRESENTATIVE = 3;
const MAX_DIGEST_RULE_REPRESENTATIVE = 3;

/**
 * Project the run_pipeline impact section onto the bounded digest seam, or null
 * when impact is not a meaningful part of this query (not requested by intent, no
 * focal symbol, no dependents). The representative rows carry REAL graph dependent
 * identities; a per-caller `snippet` is attached only when the impact graph already
 * loaded a source excerpt (run_pipeline does not request excerpts today), so
 * `snippetsAvailable` is honest and `snippetUnavailableReason` records the gap.
 * Pure: derives only from the already-built section.
 */
export function deriveImpactDigestSeam(
  impact: OrchestrationImpactSection,
): CapsuleV2DigestImpactSeam | null {
  if (!impact.included || impact.graph === null) {
    return null;
  }
  // Shared projection (see impactGraphToDigestSeam) so the MCP run_pipeline digest
  // and the Stage 5 live-injection digest render impact identically.
  return impactGraphToDigestSeam(impact.graph);
}

/**
 * Project the run_pipeline memory section onto the bounded digest seam, or null
 * when nothing relevant was surfaced (so an ordinary edit query's digest carries
 * no empty `◎ memory` line). Uses only the already-selected session/durable
 * observations — no new ranking. Pure.
 */
export function deriveMemoryDigestSeam(
  memory: OrchestrationMemorySection,
): CapsuleV2DigestMemorySeam | null {
  const session = memory.session;
  const durable = memory.durable;
  const sessionCount = session.included ? session.observationCount : 0;
  const durableCount = durable.included ? durable.matchedCount : 0;
  const items: CapsuleV2DigestMemoryItem[] = [];
  for (const observation of session.recentObservations) {
    if (items.length >= MAX_DIGEST_MEMORY_REPRESENTATIVE) break;
    items.push({ source: "session", text: observation.summary });
  }
  let staleCount = 0;
  for (const result of durable.topObservations) {
    const stale = result.staleness.status === StaleStateStatus.Stale;
    if (stale) staleCount += 1;
    if (items.length < MAX_DIGEST_MEMORY_REPRESENTATIVE) {
      items.push({ source: "durable", text: result.observation.summary, stale });
    }
  }
  if (sessionCount === 0 && durableCount === 0 && items.length === 0) {
    return null;
  }
  return {
    sessionCount,
    durableCount,
    ...(staleCount > 0 ? { staleCount } : {}),
    available: true,
    items,
  };
}

/**
 * Project the run_pipeline rules section onto the bounded digest seam, or null
 * when no active rules were injected. Uses only the already-selected active rules
 * (promoted, relevance-limited) — no new ranking. Pure.
 */
export function deriveRulesDigestSeam(
  rules: OrchestrationRulesSection,
): CapsuleV2DigestRulesSeam | null {
  if (!rules.included || rules.activeCount === 0) {
    return null;
  }
  const items: CapsuleV2DigestRuleItem[] = rules.active
    .slice(0, MAX_DIGEST_RULE_REPRESENTATIVE)
    .map((selected) => ({
      text: selected.rule.summary,
      ...(typeof selected.reason === "string" && selected.reason.length > 0
        ? { why: selected.reason }
        : {}),
    }));
  return {
    activeCount: rules.activeCount,
    available: true,
    items,
  };
}

function buildCapsuleV2Section(
  db: Database,
  repoRoot: string,
  query: string,
  rawInput: RunPipelineOrchestratorInput,
  deps: {
    builder: typeof buildCapsuleV2;
    digestEnrichments?: DigestEnrichments;
  },
): CapsuleV2SectionResult {
  const requested = parseRequestedCapsuleEngine(rawInput.capsuleEngine);
  const v1Section = {
    capsuleV2: null,
    capsuleV2ManifestId: null,
    pivotNeighborhood: null,
    inspectFirst: null,
  } as const;

  if (!requestWantsCapsuleV2(requested)) {
    return { ...v1Section, capsuleEngine: v1EngineSelection(requested) };
  }

  try {
    const result = deps.builder({
      db,
      repoRoot,
      task: query,
      intent: rawInput.capsuleIntent ?? CapsuleIntent.Auto,
      maxTokens: rawInput.capsuleBudgetTokens ?? RUN_PIPELINE_DEFAULTS.capsuleV2BudgetTokens,
    });
    const capsuleV2 = toCapsuleV2ProductResponse(result, {
      query,
      impact: deps.digestEnrichments?.impact ?? null,
      memory: deps.digestEnrichments?.memory ?? null,
      rules: deps.digestEnrichments?.rules ?? null,
    });
    const capsuleV2ManifestId = persistCapsuleV2ManifestBestEffort(
      db,
      query,
      capsuleV2ToManifestItemFields(result),
      getLatestIndexRun(db)?.id ?? null,
    );
    // Additive debug-oriented enrichment: bounded source excerpts from the
    // neighborhood of the top pivot(s). Best-effort and never fails the run.
    const pivotNeighborhood = buildPivotNeighborhoods(db, repoRoot, capsuleV2);
    // Compact, deterministic inspect-first guidance — the same shared projection
    // the Stage 5 injected path uses. Null when the v2 result has no actionable
    // pivot (e.g. a no_context capsule); that is not a failure.
    const inspectFirst = buildInspectFirst(capsuleV2, pivotNeighborhood);
    return {
      capsuleV2,
      capsuleV2ManifestId,
      pivotNeighborhood,
      inspectFirst,
      capsuleEngine: v2EngineSelection(requested, inspectFirst !== null),
    };
  } catch (error) {
    // Genuine v2 query/render failure: fall back to the already-assembled v1
    // sections and record why. no_context never reaches here (it is a normal
    // return value, not a throw), so the no_context policy is unchanged.
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...v1Section,
      capsuleEngine: v1EngineSelection(requested, `v2_build_failed: ${reason}`),
    };
  }
}

function runReliableContextRetrieval(
  db: Database,
  repoRoot: string,
  input: {
    query: string;
    maxResults: number;
    maxBudgetCharacters: number;
    preset: RunPipelineConcretePreset;
  },
): OrchestrationContextSection {
  const routedQuery = routeQuery(db, input.query, {
    maxResults: input.maxResults,
  });
  // Force capsule-profile classification to the preset's mapped QueryIntent so
  // intent presets materially affect which capsule profile is used.
  const overridden = overrideClassificationIntent(
    routedQuery,
    mapPresetToQueryIntent(input.preset),
  );
  const sourceRunId = getLatestIndexRun(db)?.id ?? null;
  const supportingCandidates = overridden.rerankedResults
    .map(makeSupportingCandidateFromGraphResult);
  const builderInput = {
    query: input.query,
    rerankedCandidates: overridden.rerankedResults,
    supportingCandidates,
    maxBudget: createCharacterBudget(input.maxBudgetCharacters),
  };
  const preparedAssembly = prepareCapsuleAssembly({
    classification: overridden.classification,
    builderInput,
  });
  const capsuleProfileId = preparedAssembly.selection.profile.id;
  const capsuleBuilder = createSourceBackedCapsuleBuilder({
    db,
    repoRoot,
    excludeMemoryObservation: ({ observation, query: innerQuery, pivots }) => {
      return observation.dedupeKey === computeVisibleCapsuleObservationDedupeKey({
        sourceRunId,
        routedQuery: {
          ...overridden,
          query: innerQuery,
        },
        capsuleProfileId,
        capsule: { pivots: [...pivots] },
      });
    },
  });
  const primaryCapsule = buildCapsule(capsuleBuilder, preparedAssembly.builderInput);
  const initialContextItemCount = countUsefulContextItems(primaryCapsule);
  const initialReason = resolveContextSkipReason(input.query, overridden, primaryCapsule);

  if (initialReason === null) {
    return {
      included: initialContextItemCount > 0,
      skipReason: null,
      capsule: primaryCapsule,
      routedQuery: overridden,
      preparedAssembly,
      retrievalDiagnostics: {
        fallbackApplied: false,
        fallbackMode: null,
        fallbackRecovered: false,
        initialReason: null,
        finalReason: null,
        initialContextItemCount,
        finalContextItemCount: initialContextItemCount,
        pathSignalsConsidered: overridden.pathSignalDiagnostics.pathSignalsConsidered,
        pathSignalsMatched: overridden.pathSignalDiagnostics.pathSignalsMatched,
        candidateFilesConsidered: overridden.pathSignalDiagnostics.candidateFilesConsidered,
        weakPathCoverage: overridden.pathSignalDiagnostics.weakPathCoverage,
      },
    };
  }

  if (initialReason === RunPipelineContextSkipReason.AllCandidatesOmitted) {
    const relaxedCapsule = buildCapsule(capsuleBuilder, {
      query: preparedAssembly.builderInput.query,
      rerankedCandidates: preparedAssembly.builderInput.rerankedCandidates,
      supportingCandidates: preparedAssembly.builderInput.supportingCandidates,
      maxBudget: preparedAssembly.builderInput.maxBudget,
    });
    const finalContextItemCount = countUsefulContextItems(relaxedCapsule);
    const fallbackRecovered = finalContextItemCount > 0;
    const finalReason = fallbackRecovered
      ? null
      : resolveContextSkipReason(input.query, overridden, relaxedCapsule);
    return {
      included: fallbackRecovered,
      skipReason: finalReason,
      capsule: relaxedCapsule,
      routedQuery: overridden,
      preparedAssembly,
      retrievalDiagnostics: {
        fallbackApplied: true,
        fallbackMode: "relaxed_unprofiled_assembly",
        fallbackRecovered,
        initialReason,
        finalReason,
        initialContextItemCount,
        finalContextItemCount,
        pathSignalsConsidered: overridden.pathSignalDiagnostics.pathSignalsConsidered,
        pathSignalsMatched: overridden.pathSignalDiagnostics.pathSignalsMatched,
        candidateFilesConsidered: overridden.pathSignalDiagnostics.candidateFilesConsidered,
        weakPathCoverage: overridden.pathSignalDiagnostics.weakPathCoverage,
      },
    };
  }

  return {
    included: false,
    skipReason: initialReason,
    capsule: primaryCapsule,
    routedQuery: overridden,
    preparedAssembly,
    retrievalDiagnostics: {
      fallbackApplied: false,
      fallbackMode: null,
      fallbackRecovered: false,
      initialReason,
      finalReason: initialReason,
      initialContextItemCount,
      finalContextItemCount: initialContextItemCount,
      pathSignalsConsidered: overridden.pathSignalDiagnostics.pathSignalsConsidered,
      pathSignalsMatched: overridden.pathSignalDiagnostics.pathSignalsMatched,
      candidateFilesConsidered: overridden.pathSignalDiagnostics.candidateFilesConsidered,
      weakPathCoverage: overridden.pathSignalDiagnostics.weakPathCoverage,
    },
  };
}

function overrideClassificationIntent(
  routed: RoutedQueryResult,
  forcedIntent: QueryIntent,
): RoutedQueryResult {
  if (routed.classification.intent === forcedIntent) {
    return routed;
  }
  return {
    ...routed,
    intent: forcedIntent,
    classification: {
      ...routed.classification,
      intent: forcedIntent,
    },
  };
}

function makeSupportingCandidateFromGraphResult(
  result: GraphSearchResult,
): CapsuleSupportingCandidate {
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

  return {
    symbolId: result.symbolId,
    filePath: result.filePath,
    fqName: result.fqName,
    localName: result.localName,
    kind: result.kind,
    lexicalScore: result.lexicalScore,
    graphScore: result.graphScore,
    finalScore: result.finalScore,
    inclusionReasons: reasons,
  };
}

function countUsefulContextItems(capsule: Capsule): number {
  return capsule.pivots.length + capsule.supportingItems.length;
}

function hasSupportedQueryShape(query: string): boolean {
  return /[A-Za-z0-9_]/u.test(query);
}

function resolveContextSkipReason(
  query: string,
  routed: RoutedQueryResult,
  capsule: Capsule,
): RunPipelineContextSkipReason | null {
  if (countUsefulContextItems(capsule) > 0) {
    return null;
  }
  if (normalizeSearchQuery(query).length === 0 || !hasSupportedQueryShape(query)) {
    return RunPipelineContextSkipReason.UnsupportedQueryShape;
  }
  if (routed.rerankedResults.length === 0) {
    return RunPipelineContextSkipReason.NoCandidates;
  }
  return RunPipelineContextSkipReason.AllCandidatesOmitted;
}

function runImpactSection(
  db: Database,
  repoRoot: string,
  context: OrchestrationContextSection,
  normalizedIntent: NormalizedIntentDecision,
): OrchestrationImpactSection {
  const triggerReason = resolveImpactTriggerReason(
    context.routedQuery.query,
    normalizedIntent,
  );

  if (triggerReason === null) {
    return {
      included: false,
      // Intent-level skip: the resolved intent did not request impact. Distinct
      // from no_focal_symbol / multiple_focal_symbols below, which mean the intent
      // DID request impact but a single focal symbol could not be pinned down.
      skipReason: normalizedIntent.impactSkipReason
        ?? RunPipelineImpactSkipReason.NotRequestedByIntent,
      triggerReason: null,
      selectionSource: null,
      focalSymbol: null,
      graph: null,
      candidatesConsidered: 0,
      matchedCandidates: 0,
    };
  }

  const focalSelection = selectImpactFocalSymbol(context);

  if (focalSelection.focal === null) {
    return {
      included: false,
      skipReason: focalSelection.matchedCandidates > 1
        ? RunPipelineImpactSkipReason.MultipleFocalSymbols
        : RunPipelineImpactSkipReason.NoFocalSymbol,
      triggerReason,
      selectionSource: null,
      focalSymbol: null,
      graph: null,
      candidatesConsidered: focalSelection.candidatesConsidered,
      matchedCandidates: focalSelection.matchedCandidates,
    };
  }

  const focal = focalSelection.focal;
  const graph = getImpactGraph(db, {
    symbolFqn: focal.fqName,
    depth: RUN_PIPELINE_DEFAULTS.impactDepth,
    format: "list",
  }, {
    repoRoot,
  });

  if (!graph.ok) {
    return {
      included: false,
      skipReason: RunPipelineImpactSkipReason.ImpactError,
      triggerReason,
      selectionSource: focal.isTopPivot ? "top_pivot_task_mention" : "routed_task_mention",
      focalSymbol: {
        symbolId: focal.symbolId,
        filePath: focal.filePath,
        fqName: focal.fqName,
        localName: focal.localName,
        kind: focal.kind,
      },
      graph: null,
      candidatesConsidered: focalSelection.candidatesConsidered,
      matchedCandidates: focalSelection.matchedCandidates,
    };
  }

  if (graph.output.summary.dependentSymbolCount === 0) {
    return {
      included: false,
      skipReason: RunPipelineImpactSkipReason.NoDependents,
      triggerReason,
      selectionSource: focal.isTopPivot ? "top_pivot_task_mention" : "routed_task_mention",
      focalSymbol: {
        symbolId: focal.symbolId,
        filePath: focal.filePath,
        fqName: focal.fqName,
        localName: focal.localName,
        kind: focal.kind,
      },
      graph: graph.output,
      candidatesConsidered: focalSelection.candidatesConsidered,
      matchedCandidates: focalSelection.matchedCandidates,
    };
  }

  return {
    included: true,
    skipReason: null,
    triggerReason,
    selectionSource: focal.isTopPivot ? "top_pivot_task_mention" : "routed_task_mention",
    focalSymbol: {
      symbolId: focal.symbolId,
      filePath: focal.filePath,
      fqName: focal.fqName,
      localName: focal.localName,
      kind: focal.kind,
    },
    graph: graph.output,
    candidatesConsidered: focalSelection.candidatesConsidered,
    matchedCandidates: focalSelection.matchedCandidates,
  };
}

function resolveImpactTriggerReason(
  query: string,
  normalizedIntent: NormalizedIntentDecision,
): string | null {
  // Impact eligibility is INTENT-DRIVEN. A refactor or impact intent ungates the
  // impact section, full stop — no magic phrase required. The trigger reason
  // records which intent and how it resolved, for debuggability.
  if (normalizedIntent.resolvedIntent === NormalizedIntent.Impact) {
    return normalizedIntent.intentSource === NormalizedIntentSource.Explicit
      ? "impact_intent"
      : "impact_phrase";
  }
  if (normalizedIntent.resolvedIntent === NormalizedIntent.Refactor) {
    // Historical reason name kept for refactor-resolved impact (explicit preset,
    // refactor phrase trigger, or classifier all resolve to refactor intent).
    return "refactor_preset";
  }
  // Debug deliberately avoids impact UNLESS the query explicitly asks what a
  // failing symbol affects — a narrow, query-level opt-in so blast-radius work
  // labelled debug is still served, without making impact the noisy default for
  // ordinary edit-site debugging. (`impactEligible` stays false; this is a query
  // override beyond the intent gate, recorded by the trigger reason.)
  if (normalizedIntent.resolvedIntent === NormalizedIntent.Debug) {
    const terms = new Set(
      normalizeIntentQuery(query).split(/\s+/).filter((term) => term.length > 0),
    );
    if (terms.has("affects") || terms.has("affect") || terms.has("breaks") || terms.has("break")) {
      return "debug_affect_phrase";
    }
  }
  return null;
}

function selectImpactFocalSymbol(
  context: OrchestrationContextSection,
): {
  readonly focal: ImpactCandidate | null;
  readonly candidatesConsidered: number;
  readonly matchedCandidates: number;
} {
  const candidates = collectImpactCandidates(context);
  const mentioned = candidates.filter((candidate) => isCandidateMentioned(
    context.routedQuery.query,
    candidate,
  ));
  return {
    focal: mentioned.length === 1 ? mentioned[0]! : null,
    candidatesConsidered: candidates.length,
    matchedCandidates: mentioned.length,
  };
}

function collectImpactCandidates(context: OrchestrationContextSection): ImpactCandidate[] {
  const candidatesBySymbolId = new Map<string, ImpactCandidate>();
  const topPivotSymbolId = context.capsule.pivots[0]?.symbolId;

  for (const pivot of context.capsule.pivots) {
    candidatesBySymbolId.set(pivot.symbolId, {
      symbolId: pivot.symbolId,
      filePath: pivot.filePath,
      fqName: pivot.fqName,
      localName: pivot.localName,
      kind: pivot.kind,
      isTopPivot: pivot.symbolId === topPivotSymbolId,
    });
  }

  for (const result of context.routedQuery.rerankedResults) {
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

function isCandidateMentioned(query: string, candidate: ImpactCandidate): boolean {
  if (candidate.fqName.length > 0 && query.includes(candidate.fqName)) {
    return true;
  }
  if (candidate.localName.length === 0) {
    return false;
  }
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_])${escapeRegExp(candidate.localName)}($|[^\\p{L}\\p{N}_])`,
    "u",
  ).test(query);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Directional cues that force a single attempted direction. A cue between the
// two mentioned endpoints is authoritative: when present we never probe the
// reverse direction. Position order is used only to label which endpoint is
// "earlier" so a forward cue reads earlier -> later.
const FLOW_FORWARD_CUES = Object.freeze([
  "->",
  "=>",
  "→", // →
  " to ",
  " into ",
  " reach",
  " calls",
  " call ",
  " invokes",
  " invoke ",
  " leads to",
  " flows to",
  " flow to",
  " down to",
  " through to",
  " path to",
]);

const FLOW_REVERSE_CUES = Object.freeze([
  "<-",
  "←", // ←
  " from ",
  " called by",
  " invoked by",
  " comes from",
  " reached from",
]);

const EMPTY_FLOW_RESULT = Object.freeze({
  endpointStrategy: null,
  bothDirectionsReachable: false,
  start: null,
  end: null,
  output: null,
});

function runFlowSection(
  db: Database,
  repoRoot: string,
  context: OrchestrationContextSection,
): OrchestrationFlowSection {
  const query = context.routedQuery.query;

  if (normalizeSearchQuery(query).length === 0 || !hasSupportedQueryShape(query)) {
    return {
      included: false,
      skipReason: RunPipelineFlowSkipReason.UnsupportedQueryShape,
      ...EMPTY_FLOW_RESULT,
      candidatesConsidered: 0,
      matchedCandidates: 0,
    };
  }

  const candidates = collectImpactCandidates(context);
  const mentioned: OrchestrationFlowEndpoint[] = [];
  for (const candidate of candidates) {
    const mentionIndex = findCandidateMentionIndex(query, candidate);
    if (mentionIndex !== null) {
      mentioned.push({
        symbolId: candidate.symbolId,
        filePath: candidate.filePath,
        fqName: candidate.fqName,
        localName: candidate.localName,
        kind: candidate.kind,
        mentionIndex,
      });
    }
  }

  const candidatesConsidered = candidates.length;
  const matchedCandidates = mentioned.length;

  if (mentioned.length < 2) {
    return {
      included: false,
      skipReason: RunPipelineFlowSkipReason.NotEnoughEndpoints,
      ...EMPTY_FLOW_RESULT,
      candidatesConsidered,
      matchedCandidates,
    };
  }

  if (mentioned.length > 2) {
    return {
      included: false,
      skipReason: RunPipelineFlowSkipReason.AmbiguousEndpoints,
      ...EMPTY_FLOW_RESULT,
      candidatesConsidered,
      matchedCandidates,
    };
  }

  // Position order labels the endpoints; it never decides direction on its own,
  // only which direction is attempted first when probing.
  const ordered = [...mentioned].sort(
    (a, b) => a.mentionIndex - b.mentionIndex || a.fqName.localeCompare(b.fqName),
  );
  const earlier = ordered[0]!;
  const later = ordered[1]!;
  const cue = detectFlowDirectionalCue(query, earlier, later);

  const probe = (start: OrchestrationFlowEndpoint, end: OrchestrationFlowEndpoint) =>
    searchLogicFlow(db, {
      start: start.fqName,
      end: end.fqName,
      maxPaths: RUN_PIPELINE_DEFAULTS.flowMaxPaths,
    }, {
      repoRoot,
    });

  const finalize = (
    section: Omit<OrchestrationFlowSection, "candidatesConsidered" | "matchedCandidates">,
  ): OrchestrationFlowSection => ({
    ...section,
    candidatesConsidered,
    matchedCandidates,
  });

  // Directional cue is authoritative: attempt exactly that direction, no probe.
  if (cue === "forward" || cue === "reverse") {
    const start = cue === "forward" ? earlier : later;
    const end = cue === "forward" ? later : earlier;
    const result = probe(start, end);
    if (!result.ok) {
      return finalize({
        included: false,
        skipReason: RunPipelineFlowSkipReason.FlowError,
        endpointStrategy: RunPipelineFlowEndpointStrategy.DirectionalCue,
        bothDirectionsReachable: false,
        start,
        end,
        output: null,
      });
    }
    return finalize({
      included: result.output.summary.reachable,
      skipReason: result.output.summary.reachable
        ? null
        : RunPipelineFlowSkipReason.EndpointsNotConnected,
      endpointStrategy: RunPipelineFlowEndpointStrategy.DirectionalCue,
      bothDirectionsReachable: false,
      start,
      end,
      output: result.output,
    });
  }

  // No cue: probe both directions, position order attempted first.
  const forward = probe(earlier, later);
  const reverse = probe(later, earlier);

  if (!forward.ok && !reverse.ok) {
    return finalize({
      included: false,
      skipReason: RunPipelineFlowSkipReason.FlowError,
      endpointStrategy: RunPipelineFlowEndpointStrategy.BidirectionalProbe,
      bothDirectionsReachable: false,
      start: earlier,
      end: later,
      output: null,
    });
  }

  const forwardReachable = forward.ok && forward.output.summary.reachable;
  const reverseReachable = reverse.ok && reverse.output.summary.reachable;
  const bothDirectionsReachable = forwardReachable && reverseReachable;

  // Tie-break in favor of position order when both directions connect.
  if (forwardReachable) {
    return finalize({
      included: true,
      skipReason: null,
      endpointStrategy: RunPipelineFlowEndpointStrategy.BidirectionalProbe,
      bothDirectionsReachable,
      start: earlier,
      end: later,
      output: (forward as { output: LogicFlowOutput }).output,
    });
  }

  if (reverseReachable) {
    return finalize({
      included: true,
      skipReason: null,
      endpointStrategy: RunPipelineFlowEndpointStrategy.BidirectionalProbe,
      bothDirectionsReachable: false,
      start: later,
      end: earlier,
      output: (reverse as { output: LogicFlowOutput }).output,
    });
  }

  // Neither direction connects: keep the position-order attempt as evidence.
  const representative = forward.ok ? forward.output : reverse.ok ? reverse.output : null;
  return finalize({
    included: false,
    skipReason: RunPipelineFlowSkipReason.EndpointsNotConnected,
    endpointStrategy: RunPipelineFlowEndpointStrategy.BidirectionalProbe,
    bothDirectionsReachable: false,
    start: earlier,
    end: later,
    output: representative,
  });
}

function findCandidateMentionIndex(
  query: string,
  candidate: ImpactCandidate,
): number | null {
  if (candidate.fqName.length > 0) {
    const fqIndex = query.indexOf(candidate.fqName);
    if (fqIndex >= 0) {
      return fqIndex;
    }
  }
  if (candidate.localName.length === 0) {
    return null;
  }
  const match = new RegExp(
    `(^|[^\\p{L}\\p{N}_])(${escapeRegExp(candidate.localName)})($|[^\\p{L}\\p{N}_])`,
    "u",
  ).exec(query);
  if (match === null) {
    return null;
  }
  // Offset past the leading boundary group so ordering reflects the name itself.
  return match.index + (match[1]?.length ?? 0);
}

function detectFlowDirectionalCue(
  query: string,
  earlier: OrchestrationFlowEndpoint,
  later: OrchestrationFlowEndpoint,
): "forward" | "reverse" | null {
  const between = query.slice(earlier.mentionIndex, later.mentionIndex).toLowerCase();
  const forward = FLOW_FORWARD_CUES.some((cue) => between.includes(cue));
  const reverse = FLOW_REVERSE_CUES.some((cue) => between.includes(cue));
  if (forward && !reverse) {
    return "forward";
  }
  if (reverse && !forward) {
    return "reverse";
  }
  return null;
}

function runMemorySection(
  db: Database,
  input: {
    query: string;
    sessionId: string | null;
    intentDecision: RunPipelineIntentDecision;
    includeMemory: boolean | undefined;
  },
): OrchestrationMemorySection {
  const session = runSessionMemorySection(db, input);
  const durable = runDurableMemorySection(db, input);
  return { session, durable };
}

function runRulesSection(
  db: Database,
  repoRoot: string,
  input: {
    query: string;
    intent: string;
    context: OrchestrationContextSection;
  },
): OrchestrationRulesSection {
  const contextItems = [
    ...input.context.capsule.pivots,
    ...input.context.capsule.supportingItems,
  ];
  const selected = selectRelevantProjectRules(db, {
    repoRoot,
    query: input.query,
    intent: input.intent,
    linkedFilePaths: collectSortedUnique(contextItems.map((item) => item.filePath)),
    linkedFqNames: collectSortedUnique(contextItems.map((item) => item.fqName)),
  });

  return {
    included: selected.active.length > 0 || selected.candidates.length > 0,
    active: selected.active,
    candidates: selected.candidates,
    activeCount: selected.activeTotal,
    candidateCount: selected.candidateTotal,
    staleCount: selected.staleTotal,
    disabledCount: selected.disabledTotal,
    dismissedCount: selected.dismissedTotal,
  };
}

function runSessionMemorySection(
  db: Database,
  input: {
    sessionId: string | null;
  },
): OrchestrationSessionSection {
  if (input.sessionId === null) {
    return {
      included: false,
      skipReason: RunPipelineSessionSkipReason.NoSessionRequested,
      sessionId: null,
      observationCount: 0,
      recentObservations: [],
    };
  }

  const context: SessionContextResult = getSessionContext(db, {
    sessionId: input.sessionId,
    limit: RUN_PIPELINE_DEFAULTS.sessionRecentObservationLimit,
  });
  const recent = context.observations;

  if (recent.length === 0) {
    return {
      included: false,
      skipReason: RunPipelineSessionSkipReason.SessionEmpty,
      sessionId: input.sessionId,
      observationCount: 0,
      recentObservations: [],
    };
  }

  return {
    included: true,
    skipReason: null,
    sessionId: input.sessionId,
    observationCount: context.summary?.observationCount ?? recent.length,
    recentObservations: recent,
  };
}

function runDurableMemorySection(
  db: Database,
  input: {
    query: string;
    intentDecision: RunPipelineIntentDecision;
    includeMemory: boolean | undefined;
  },
): OrchestrationDurableMemorySection {
  // Explore intent de-emphasizes durable memory so the output stays compact
  // for pure orientation tasks unless the caller explicitly opts in.
  if (
    input.includeMemory !== true
    && input.intentDecision.selected === RunPipelinePresetIntent.Explore
  ) {
    return {
      included: false,
      skipReason: RunPipelineDurableMemorySkipReason.IntentDeemphasized,
      matchedCount: 0,
      topObservations: [],
    };
  }

  if (normalizeSearchQuery(input.query).length === 0) {
    return {
      included: false,
      skipReason: RunPipelineDurableMemorySkipReason.QueryUnsupported,
      matchedCount: 0,
      topObservations: [],
    };
  }

  const results = searchMemory(db, {
    query: input.query,
    maxResults: RUN_PIPELINE_DEFAULTS.durableMemoryMaxResults,
  });

  if (results.length === 0) {
    return {
      included: false,
      skipReason: RunPipelineDurableMemorySkipReason.NoMatches,
      matchedCount: 0,
      topObservations: [],
    };
  }

  return {
    included: true,
    skipReason: null,
    matchedCount: results.length,
    topObservations: results,
  };
}

function buildDeferredPlaceholders(input: {
  db: Database;
  context: OrchestrationContextSection;
  impact: OrchestrationImpactSection;
  flow: OrchestrationFlowSection;
  memory: OrchestrationMemorySection;
  repoRoot: string;
  store: DeferredVexpStore;
  sourceRunId: number | null;
  request: {
    query: string;
    maxBudgetCharacters: number;
    sessionId: string | null;
  };
}): RunPipelineDeferredPlaceholder[] {
  const deferred: RunPipelineDeferredPlaceholder[] = [];

  if (input.context.included) {
    const stableId = `vexp:capsule:${compactHash(input.request.query)}`;
    const entry = input.store.publish({
      stableId,
      category: DeferredVexpCategory.ContextCapsule,
      content: {
        kind: "json",
        value: structuredClone(input.context.capsule),
      },
      metadata: {
        repoRoot: input.repoRoot,
        query: input.request.query,
        capsuleProfileId: input.context.preparedAssembly.selection.profile.id,
        routingProfileId: input.context.routedQuery.profile.id,
        origin: "run_pipeline",
      },
    });
    persistDeferredVexpRef(input.db, {
      entry,
      repoRoot: input.repoRoot,
      sourceRunId: input.sourceRunId,
      sessionId: input.request.sessionId,
      notes: [
        "Stored by run_pipeline; expansion returns this payload without disk recomputation.",
      ],
    });
    deferred.push({
      id: stableId,
      hash: entry.hash,
      kind: RunPipelineDeferredKind.ContextCapsule,
      summary:
        "Full context capsule (pivots and supporting items in non-compact form) is available on demand.",
      suggestedTool: "get_context_capsule",
      suggestedInput: {
        query: input.request.query,
        maxBudgetCharacters: input.request.maxBudgetCharacters,
      },
    });
  }

  if (input.impact.included && input.impact.focalSymbol !== null && input.impact.graph !== null) {
    const stableId = `vexp:impact:${input.impact.focalSymbol.fqName}`;
    const entry = input.store.publish({
      stableId,
      category: DeferredVexpCategory.ImpactGraph,
      content: {
        kind: "json",
        value: structuredClone(input.impact.graph),
      },
      metadata: {
        repoRoot: input.repoRoot,
        focalSymbolFqName: input.impact.focalSymbol.fqName,
        depth: RUN_PIPELINE_DEFAULTS.impactDepth,
        origin: "run_pipeline",
      },
    });
    persistDeferredVexpRef(input.db, {
      entry,
      repoRoot: input.repoRoot,
      sourceRunId: input.sourceRunId,
      sessionId: input.request.sessionId,
      notes: [
        "Stored by run_pipeline; expansion returns this payload without disk recomputation.",
      ],
    });
    deferred.push({
      id: stableId,
      hash: entry.hash,
      kind: RunPipelineDeferredKind.ImpactGraph,
      summary: "Full structural impact graph for the focal symbol (nodes, edges, view).",
      suggestedTool: "get_impact_graph",
      suggestedInput: {
        symbol_fqn: input.impact.focalSymbol.fqName,
        depth: RUN_PIPELINE_DEFAULTS.impactDepth,
      },
    });
  }

  if (
    input.flow.included
    && input.flow.start !== null
    && input.flow.end !== null
    && input.flow.output !== null
  ) {
    const stableId = `vexp:flow:${input.flow.start.fqName}->${input.flow.end.fqName}`;
    const entry = input.store.publish({
      stableId,
      category: DeferredVexpCategory.LogicFlow,
      content: {
        kind: "json",
        value: structuredClone(input.flow.output),
      },
      metadata: {
        repoRoot: input.repoRoot,
        startFqName: input.flow.start.fqName,
        endFqName: input.flow.end.fqName,
        maxPaths: RUN_PIPELINE_DEFAULTS.flowMaxPaths,
        origin: "run_pipeline",
      },
    });
    persistDeferredVexpRef(input.db, {
      entry,
      repoRoot: input.repoRoot,
      sourceRunId: input.sourceRunId,
      sessionId: input.request.sessionId,
      notes: [
        "Stored by run_pipeline; expansion returns this payload without disk recomputation.",
      ],
    });
    deferred.push({
      id: stableId,
      hash: entry.hash,
      kind: RunPipelineDeferredKind.LogicFlow,
      summary: "Full structural logic-flow output (resolved endpoints, coverage, and all returned paths).",
      suggestedTool: "search_logic_flow",
      suggestedInput: {
        start: input.flow.start.fqName,
        end: input.flow.end.fqName,
        max_paths: RUN_PIPELINE_DEFAULTS.flowMaxPaths,
      },
    });
  }

  if (input.memory.session.included && input.memory.session.sessionId !== null) {
    const stableId = `vexp:session:${input.memory.session.sessionId}`;
    const entry = input.store.publish({
      stableId,
      category: DeferredVexpCategory.SessionContext,
      content: {
        kind: "json",
        value: {
          sessionId: input.memory.session.sessionId,
          observationCount: input.memory.session.observationCount,
          recentObservations: structuredClone(input.memory.session.recentObservations),
        },
      },
      metadata: {
        repoRoot: input.repoRoot,
        sessionId: input.memory.session.sessionId,
        origin: "run_pipeline",
      },
    });
    persistDeferredVexpRef(input.db, {
      entry,
      repoRoot: input.repoRoot,
      sourceRunId: input.sourceRunId,
      sessionId: input.memory.session.sessionId,
      notes: [
        "Stored by run_pipeline; expansion returns this payload without disk recomputation.",
      ],
    });
    deferred.push({
      id: stableId,
      hash: entry.hash,
      kind: RunPipelineDeferredKind.SessionContext,
      summary: "Full session context: session record, summary, and observation list.",
      suggestedTool: "get_session_context",
      suggestedInput: {
        sessionId: input.memory.session.sessionId,
      },
    });
  }

  if (input.memory.durable.included) {
    const stableId = `vexp:memory:${compactHash(input.request.query)}`;
    const entry = input.store.publish({
      stableId,
      category: DeferredVexpCategory.DurableMemory,
      content: {
        kind: "json",
        value: {
          query: input.request.query,
          matchedCount: input.memory.durable.matchedCount,
          topObservations: structuredClone(input.memory.durable.topObservations),
        },
      },
      metadata: {
        repoRoot: input.repoRoot,
        query: input.request.query,
        origin: "run_pipeline",
      },
    });
    persistDeferredVexpRef(input.db, {
      entry,
      repoRoot: input.repoRoot,
      sourceRunId: input.sourceRunId,
      sessionId: input.request.sessionId,
      notes: [
        "Stored by run_pipeline; expansion returns this payload without disk recomputation.",
      ],
    });
    deferred.push({
      id: stableId,
      hash: entry.hash,
      kind: RunPipelineDeferredKind.DurableMemory,
      summary: "Broader durable memory search results for this query.",
      suggestedTool: "search_memory",
      suggestedInput: {
        query: input.request.query,
      },
    });
  }

  return deferred;
}

function compactHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function collectUniqueInOrder<T>(values: readonly T[]): T[] {
  const uniqueValues: T[] = [];
  const seen = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    uniqueValues.push(value);
  }
  return uniqueValues;
}

function collectSortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export type { Capsule, CapsuleItem, RoutedQueryResult, SymbolSearchResult };
