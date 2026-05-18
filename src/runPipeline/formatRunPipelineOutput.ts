import { normalizeIntentQuery } from "../intent/rules";
import type { CapsuleItem } from "../capsule/types";
import {
  RUN_PIPELINE_DEFAULTS,
  type RunPipelineOrchestration,
} from "./runPipelineOrchestrator";

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
  };

  const omittedSectionCount = [
    !contextSection.included,
    !impactSection.included,
    !memorySection.session.included,
    !memorySection.durable.included,
  ].filter(Boolean).length;

  return {
    schemaVersion: orchestration.schemaVersion,
    request: { ...orchestration.request },
    intent: {
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
      },
      memory: {
        sessionIncluded: memory.session.included,
        sessionSkipReason: memory.session.skipReason,
        durableIncluded: memory.durable.included,
        durableSkipReason: memory.durable.skipReason,
      },
      deferredCount: orchestration.deferred.length,
      omittedSectionCount,
    },
    deferred: orchestration.deferred.map((placeholder) => ({
      id: placeholder.id,
      hash: placeholder.hash,
      kind: placeholder.kind,
      summary: placeholder.summary,
      suggestedTool: placeholder.suggestedTool,
      suggestedInput: structuredClone(placeholder.suggestedInput),
    })),
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
    compressed: item.compressed,
  };
}

export function compactOrchestrationHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
