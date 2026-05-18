import { normalizeIntentQuery } from "../intent/rules";
import type { CapsuleItem } from "../capsule/types";
import {
  RUN_PIPELINE_DEFAULTS,
  type RunPipelineOrchestration,
} from "./runPipelineOrchestrator";
import { formatProjectRuleForOutput } from "../projectRules/projectRules";

/**
 * Stable JSON shape returned by both the MCP `run_pipeline` tool and the
 * `vexb run-pipeline` CLI command. The VS Code result panel renders this
 * shape directly; do not change field names without updating the panel.
 */
export type FormattedRunPipelineOutput = ReturnType<typeof formatRunPipelineOrchestrationOutput>;

export function formatRunPipelineOrchestrationOutput(
  orchestration: RunPipelineOrchestration,
) {
  const context = orchestration.context;
  const impact = orchestration.impact;
  const memory = orchestration.memory;
  const rules = orchestration.rules;
  const itemCount = context.capsule.pivots.length + context.capsule.supportingItems.length;
  const contextSection = {
    included: context.included,
    skipReason: context.skipReason,
    pivots: context.capsule.pivots.map(formatRunPipelineCompactContextItem),
    supports: context.capsule.supportingItems.map(formatRunPipelineCompactContextItem),
    itemCount,
    compressed: context.capsule.compressed,
    truncated: context.capsule.truncated,
    budget: structuredClone(context.capsule.budget),
    capsuleProfileId: context.preparedAssembly.selection.profile.id,
    routingProfileId: context.routedQuery.profile.id,
    capsuleRef: `vexp:capsule:${compactOrchestrationHash(orchestration.request.query)}`,
  };
  const capsuleSurfacedMemories = context.capsule.memories ?? [];

  const impactSection = {
    included: impact.included,
    skipReason: impact.skipReason,
    triggerReason: impact.triggerReason,
    selectionSource: impact.selectionSource,
    focalSymbol: impact.focalSymbol === null
      ? null
      : {
        symbolId: impact.focalSymbol.symbolId,
        filePath: impact.focalSymbol.filePath,
        fqName: impact.focalSymbol.fqName,
        localName: impact.focalSymbol.localName,
        kind: impact.focalSymbol.kind,
      },
    summary: impact.graph === null
      ? null
      : structuredClone(impact.graph.summary),
    topDependents: impact.graph === null
      ? null
      : impact.graph.nodes
        .filter((node) => node.distance > 0)
        .slice(0, RUN_PIPELINE_DEFAULTS.impactMaxTopDependents)
        .map((node) => structuredClone(node)),
    impactRef: impact.focalSymbol === null
      ? null
      : `vexp:impact:${impact.focalSymbol.fqName}`,
    candidatesConsidered: impact.candidatesConsidered,
    matchedCandidates: impact.matchedCandidates,
  };

  const memorySection = {
    session: {
      included: memory.session.included,
      skipReason: memory.session.skipReason,
      sessionId: memory.session.sessionId,
      observationCount: memory.session.observationCount,
      recentObservations: memory.session.recentObservations.map((observation) => ({
        observationId: observation.id,
        kind: observation.kind,
        summary: observation.summary,
        createdAtMs: observation.createdAtMs,
        sessionId: observation.sessionId ?? null,
      })),
    },
    durable: {
      included: memory.durable.included,
      skipReason: memory.durable.skipReason,
      matchedCount: memory.durable.matchedCount,
      topObservations: memory.durable.topObservations.map((result) => ({
        observationId: result.observation.id,
        kind: result.observation.kind,
        summary: result.observation.summary,
        createdAtMs: result.observation.createdAtMs,
        sessionId: result.observation.sessionId ?? null,
      })),
    },
    capsuleSurfaced: {
      included: capsuleSurfacedMemories.length > 0,
      skipReason: capsuleSurfacedMemories.length > 0 ? null : "no_relevant_memory",
      matchedCount: capsuleSurfacedMemories.length,
      memories: capsuleSurfacedMemories.map((memory) => structuredClone(memory)),
    },
  };
  const rulesSection = {
    included: rules.included,
    active: rules.active.map((selection) => ({
      ...formatProjectRuleForOutput(selection.rule),
      reason: selection.reason,
      score: selection.score,
    })),
    candidates: rules.candidates.map((selection) => ({
      id: selection.rule.id,
      status: selection.rule.status,
      summary: selection.rule.summary,
      evidenceCount: selection.rule.evidenceCount,
      confidence: selection.rule.confidence,
      reason: selection.reason,
      score: selection.score,
    })),
    activeCount: rules.activeCount,
    candidateCount: rules.candidateCount,
    notes: [
      "Active rules are injected only when structurally or lexically relevant.",
      "Candidate rules are previews only and are not active instructions.",
    ],
  };

  const omittedSectionCount = [
    !contextSection.included,
    !impactSection.included,
    !memorySection.session.included,
    !memorySection.durable.included,
    !memorySection.capsuleSurfaced.included,
    !rulesSection.included,
  ].filter(Boolean).length;
  const deferredItems = orchestration.deferred.map((placeholder) => ({
    id: placeholder.id,
    hash: placeholder.hash,
    kind: placeholder.kind,
    summary: placeholder.summary,
    expandable: true,
    expansionTool: "expand_vexp_ref",
    suggestedTool: placeholder.suggestedTool,
    suggestedInput: structuredClone(placeholder.suggestedInput),
  }));

  return {
    schemaVersion: orchestration.schemaVersion,
    request: {
      ...orchestration.request,
      task: orchestration.request.query,
      presetRequested: orchestration.request.intentRequested,
    },
    intent: {
      requestedPreset: orchestration.intentDecision.requested,
      selectedPreset: orchestration.intentDecision.selected,
      selectedIntent: orchestration.intentDecision.mappedQueryIntent,
      reason: orchestration.intentDecision.rationale,
      confidence: resolveIntentConfidence(orchestration.intentDecision.source),
      requested: orchestration.intentDecision.requested,
      selected: orchestration.intentDecision.selected,
      source: orchestration.intentDecision.source,
      rationale: orchestration.intentDecision.rationale,
      mappedQueryIntent: orchestration.intentDecision.mappedQueryIntent,
      editGoal: orchestration.intentDecision.editGoal,
      fallbackApplied: orchestration.intentDecision.fallbackApplied,
    },
    taskSummary: {
      query: orchestration.request.query,
      normalizedQuery: normalizeIntentQuery(orchestration.request.query),
      editGoal: orchestration.intentDecision.editGoal,
    },
    context: contextSection,
    impact: impactSection,
    memory: memorySection,
    rules: rulesSection,
    diagnostics: {
      intent: {
        requested: orchestration.intentDecision.requested,
        selected: orchestration.intentDecision.selected,
        source: orchestration.intentDecision.source,
        fallbackApplied: orchestration.intentDecision.fallbackApplied,
      },
      retrieval: {
        initialReason: context.retrievalDiagnostics.initialReason,
        fallbackApplied: context.retrievalDiagnostics.fallbackApplied,
        fallbackMode: context.retrievalDiagnostics.fallbackMode,
        fallbackRecovered: context.retrievalDiagnostics.fallbackRecovered,
        finalReason: context.retrievalDiagnostics.finalReason,
        initialContextItemCount: context.retrievalDiagnostics.initialContextItemCount,
        finalContextItemCount: context.retrievalDiagnostics.finalContextItemCount,
      },
      impact: {
        included: impact.included,
        skipReason: impact.skipReason,
        triggerReason: impact.triggerReason,
        candidatesConsidered: impact.candidatesConsidered,
        matchedCandidates: impact.matchedCandidates,
      },
      memory: {
        sessionIncluded: memory.session.included,
        sessionSkipReason: memory.session.skipReason,
        durableIncluded: memory.durable.included,
        durableSkipReason: memory.durable.skipReason,
        capsuleSurfacedIncluded: memorySection.capsuleSurfaced.included,
        capsuleSurfacedSkipReason: memorySection.capsuleSurfaced.skipReason,
      },
      rules: {
        included: rulesSection.included,
        activeIncluded: rulesSection.active.length > 0,
        activeMatchedCount: rulesSection.active.length,
        activeTotalCount: rulesSection.activeCount,
        candidatePreviewCount: rulesSection.candidates.length,
        candidateTotalCount: rulesSection.candidateCount,
      },
      budget: {
        ...structuredClone(context.capsule.budget),
        contextTruncated: context.capsule.truncated,
        contextCompressed: context.capsule.compressed,
      },
      deferredCount: deferredItems.length,
      omittedSectionCount,
    },
    deferred: {
      items: deferredItems,
      expandable: deferredItems.length > 0,
      expansionTool: deferredItems.length > 0 ? "expand_vexp_ref" : null,
      notes: deferredItems.length > 0
        ? [
          "Deferred items are expandable only through expand_vexp_ref in this MCP server process.",
          "No V-REF token-savings or special compressed format is claimed.",
        ]
        : [
          "No deferred items were emitted for this run.",
        ],
    },
  };
}

export function formatRunPipelineCompactContextItem(item: CapsuleItem) {
  return {
    ...(item.repoAlias === undefined ? {} : { repoAlias: item.repoAlias }),
    symbolId: item.symbolId,
    filePath: item.filePath,
    fqName: item.fqName,
    localName: item.localName,
    kind: item.kind,
    role: item.role,
    contentMode: item.content.mode,
    inclusionReasons: item.inclusionReasons.map((reason) => structuredClone(reason)),
    budgetCost: item.budgetCost,
    compressed: item.compressed,
    sourceBacked: item.sourceBacked ?? false,
    ...(item.lexicalScore === undefined ? {} : { lexicalScore: item.lexicalScore }),
    ...(item.graphScore === undefined ? {} : { graphScore: item.graphScore }),
    ...(item.finalScore === undefined ? {} : { finalScore: item.finalScore }),
  };
}

export function compactOrchestrationHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function resolveIntentConfidence(source: RunPipelineOrchestration["intentDecision"]["source"]): "low" | "medium" | "high" {
  switch (source) {
    case "explicit":
    case "auto_phrase_trigger":
      return "high";
    case "auto_classifier":
      return "medium";
    case "auto_default":
    default:
      return "low";
  }
}
