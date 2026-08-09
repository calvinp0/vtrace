import { estimateTokens } from "../capsuleV2/tokens";
import type { ContextAccounting } from "../metrics/contextAccounting";
import type {
  ImpactEdge,
  ImpactGraphOutput,
  ImpactNode,
} from "./getImpactGraph";
import type { StaticRelationEvidence } from "./staticEvidence";

export const IMPACT_RESPONSE_ENVELOPE_VERSION = "vtrace.impact_response_envelope/1" as const;
// Empirically, the stable root/provenance/accounting schema costs ~700 tokens.
// Six ARC caller sites still fit at or below 2,000 total tokens / 8,000 chars.
export const IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS = 800;
export const IMPACT_HARD_SERIALIZED_CHARACTER_CEILING = 80_000;

export interface ImpactResponseBudget {
  readonly envelopeVersion: typeof IMPACT_RESPONSE_ENVELOPE_VERSION;
  readonly requestedMaxTokens: number;
  readonly modelVisibleEstimatedTokens: number;
  readonly metadataEstimatedTokens: number;
  readonly estimatedTotalTokens: number;
  readonly totalCeiling: number;
  readonly serializedCharacters: number;
  readonly withinEnvelope: true;
  readonly compactionApplied: boolean;
  readonly compactedFields: readonly string[];
  readonly requestedMaxEdges: number;
  readonly retainedEdges: number;
  readonly omittedEdges: number;
  readonly resultState: "complete" | "bounded_truncated" | "response_compacted";
  readonly estimateMethod: "chars_div_4";
}

export type ImpactProductResponse = ImpactGraphOutput & {
  readonly accounting?: ContextAccounting | { readonly latencyMs: number; readonly ref: string };
  readonly responseBudget: ImpactResponseBudget;
};

type MutableImpactResponse = {
  -readonly [Key in keyof ImpactGraphOutput]: ImpactGraphOutput[Key];
} & { accounting?: ContextAccounting | { latencyMs: number; ref: string }; responseBudget?: ImpactResponseBudget };

export function impactResponseTokenCeiling(requestedMaxTokens: number): number {
  const requested = Math.max(1, Math.floor(requestedMaxTokens));
  return requested + Math.max(
    IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS,
    Math.ceil(requested * 0.15),
  );
}

/**
 * Final model-facing gate for get_impact_graph. The traversal may inspect more
 * evidence, but every compatibility projection is rebuilt from one retained set
 * of persisted edge ids before the complete serialized object is measured.
 */
export function compactImpactProductResponse(
  output: ImpactGraphOutput & { readonly accounting?: ContextAccounting },
): ImpactProductResponse {
  const draft = structuredClone(output) as MutableImpactResponse;
  const compacted = new Set<string>();
  const requestedMaxEdges = Math.max(1, draft.limits.maxEdges);
  const requestedMaxTokens = Math.max(1, draft.limits.maxTokens);
  const totalCeiling = Math.min(
    impactResponseTokenCeiling(requestedMaxTokens),
    Math.floor(IMPACT_HARD_SERIALIZED_CHARACTER_CEILING / 4),
  );
  const originalUniqueEdges = uniqueDeliveredEdgeCount(draft);

  // Canonical selection: direct evidence first (already evidence-ranked), then
  // legacy reverse edges as compatibility projections. No DB/iteration order is
  // consulted here.
  const selectedIds = new Set<string>();
  const selectedSyntheticIds = new Set<string>();
  const selectedRelations: StaticRelationEvidence[] = [];
  for (const relation of draft.directRelations) {
    if (selectedIds.size + selectedSyntheticIds.size >= requestedMaxEdges) break;
    const key = relation.edgeId ?? relation.id;
    const target = relation.edgeId === null ? selectedSyntheticIds : selectedIds;
    if (target.has(key)) continue;
    target.add(key);
    selectedRelations.push(compactRelation(relation));
  }
  const selectedEdges: ImpactEdge[] = [];
  for (const edge of draft.edges) {
    if (!selectedIds.has(edge.edgeId) && selectedIds.size + selectedSyntheticIds.size >= requestedMaxEdges) continue;
    selectedIds.add(edge.edgeId);
    selectedEdges.push(edge);
  }
  const projectedIds = new Set(selectedEdges.map((edge) => edge.edgeId));
  for (const relation of selectedRelations) {
    if (relation.edgeId === null
      || relation.persistedKind === null
      || projectedIds.has(relation.edgeId)
      || relation.source.nodeId === undefined
      || relation.target.nodeId === undefined
      || relation.source.symbol === undefined
      || relation.target.symbol === undefined) continue;
    selectedEdges.push({
      edgeId: relation.edgeId,
      edgeType: relation.persistedKind,
      fromSymbolId: relation.source.nodeId,
      fromFqName: relation.source.symbol,
      toSymbolId: relation.target.nodeId,
      toFqName: relation.target.symbol,
    });
    projectedIds.add(relation.edgeId);
  }
  draft.directRelations = selectedRelations;
  draft.edges = selectedEdges.filter((edge) => selectedIds.has(edge.edgeId));
  compacted.add("directRelations[].evidence");

  rebuildCanonicalNodeAndViewProjections(draft, compacted);

  // Paths repeat complete edge and node objects. Keep only paths wholly backed
  // by the retained graph, then remove them first if the response is tight.
  const boundedPaths = draft.paths
    .filter((path) => path.length <= draft.limits.maxDepth)
    .filter((path) => path.edges.every((edge) => {
      const key = edge.edgeId ?? edge.id;
      return edge.edgeId === null ? selectedSyntheticIds.has(key) : selectedIds.has(key);
    }))
    .slice(0, draft.limits.maxPaths);
  if (boundedPaths.length < draft.paths.length) compacted.add("paths");
  draft.paths = boundedPaths;

  // Static coverage prose is declared by the tool schema and need not consume
  // the small per-call envelope repeatedly.
  if (draft.coverage.notes.length > 2) {
    draft.coverage = { ...draft.coverage, notes: draft.coverage.notes.slice(0, 2) };
    compacted.add("coverage.notes");
  }
  if (draft.accounting !== undefined
    && "estimatedOutputTokens" in draft.accounting
    && draft.accounting.skippedFiles !== undefined
    && draft.accounting.skippedFiles.length > 3) {
    draft.accounting = { ...draft.accounting, skippedFiles: draft.accounting.skippedFiles.slice(0, 3) };
    compacted.add("accounting.skippedFiles");
  }

  const fits = (): boolean => {
    const accounting = buildBudget(draft, {
      requestedMaxTokens,
      totalCeiling,
      requestedMaxEdges,
      originalUniqueEdges,
      compacted,
    });
    return accounting.estimatedTotalTokens <= totalCeiling
      && accounting.serializedCharacters <= IMPACT_HARD_SERIALIZED_CHARACTER_CEILING
      && accounting.modelVisibleEstimatedTokens <= requestedMaxTokens;
  };

  if (!fits() && draft.paths.length > 0) {
    draft.paths = [];
    compacted.add("paths");
  }
  if (!fits() && (draft.affectedFiles.length + draft.entrypoints.length + draft.tests.length) > 0) {
    draft.affectedFiles = [];
    draft.entrypoints = [];
    draft.tests = [];
    compacted.add("affectedFiles/entrypoints/tests");
  }
  if (!fits() && draft.diagnostics.limitations.length > 1) {
    draft.diagnostics = { ...draft.diagnostics, limitations: draft.diagnostics.limitations.slice(0, 1) };
    compacted.add("diagnostics.limitations");
  }
  if (!fits() && draft.coverage.notes.length > 1) {
    draft.coverage = { ...draft.coverage, notes: draft.coverage.notes.slice(0, 1) };
    compacted.add("coverage.notes");
  }
  if (!fits() && draft.accounting !== undefined && "estimatedOutputTokens" in draft.accounting) {
    draft.accounting = {
      latencyMs: draft.accounting.latencyMs,
      ref: "responseBudget",
    };
    compacted.add("accounting");
  }

  // Prefer compact direct caller/reference evidence over lower-value transitive
  // compatibility edges. This is what keeps all known ARC call sites visible
  // under max_edges:10 without spending the envelope on unrelated depth-2 rows.
  if (!fits() && draft.directRelations.length > 0) {
    const directEdgeIds = new Set(
      draft.directRelations.flatMap((relation) => relation.edgeId === null ? [] : [relation.edgeId]),
    );
    const directEdges = draft.edges.filter((edge) => directEdgeIds.has(edge.edgeId));
    if (directEdges.length < draft.edges.length) {
      draft.edges = directEdges;
      rebuildCanonicalNodeAndViewProjections(draft, compacted);
      compacted.add("transitiveCompatibilityEdges");
    }
  }
  if (!fits() && draft.directRelations.length > 0) {
    draft.directRelations = draft.directRelations.map(minimalRelation);
    rebuildCanonicalNodeAndViewProjections(draft, compacted);
    compacted.add("directRelations[].compactProjection");
  }

  // A very small token request can require fewer retained relations. Remove the
  // lowest-ranked detailed evidence tail. The compact legacy edge projection is
  // retained independently so graph semantics do not disappear merely because
  // one verbose compatibility representation was compacted.
  while (!fits() && draft.directRelations.length > 1) {
    draft.directRelations = draft.directRelations.slice(0, -1);
    rebuildCanonicalNodeAndViewProjections(draft, compacted);
    compacted.add("directRelations");
  }
  if (!fits() && draft.paths.length > 0) {
    draft.paths = [];
    compacted.add("paths");
  }

  // The mandatory root and one compact relation are designed to fit even the
  // 400-token supported minimum. This is a valid structured degradation, never
  // substring truncation or invalid JSON.
  if (!fits()) {
    draft.directRelations = draft.directRelations.slice(0, 1).map(minimalRelation);
    draft.paths = [];
    draft.affectedFiles = [];
    draft.entrypoints = [];
    draft.tests = [];
    draft.dependentFiles = [];
    draft.coverage = { ...draft.coverage, notes: [] };
    draft.diagnostics = { ...draft.diagnostics, limitations: [] };
    delete draft.accounting;
    rebuildCanonicalNodeAndViewProjections(draft, compacted);
    compacted.add("bounded_degradation");
  }

  while (!fits() && draft.edges.length > 1) {
    draft.edges = draft.edges.slice(0, -1);
    rebuildCanonicalNodeAndViewProjections(draft, compacted);
    compacted.add("canonicalEdges");
  }

  const responseBudget = buildBudget(draft, {
    requestedMaxTokens,
    totalCeiling,
    requestedMaxEdges,
    originalUniqueEdges,
    compacted,
  });
  if (responseBudget.estimatedTotalTokens > totalCeiling
    || responseBudget.serializedCharacters > IMPACT_HARD_SERIALIZED_CHARACTER_CEILING) {
    throw new Error("impact_response_envelope_unreachable");
  }
  draft.responseBudget = responseBudget;
  return draft as ImpactProductResponse;
}

function rebuildCanonicalNodeAndViewProjections(
  draft: MutableImpactResponse,
  compacted: Set<string>,
): void {
  const previousLinesByNodeId = new Map(
    draft.nodes.map((node, index) => [node.symbolId, draft.view.lines[index]]),
  );
  const nodeIds = new Set<string>([draft.resolvedSymbol.symbolId]);
  for (const edge of draft.edges) {
    nodeIds.add(edge.fromSymbolId);
    nodeIds.add(edge.toSymbolId);
  }
  for (const relation of draft.directRelations) {
    if (relation.source.nodeId !== undefined) nodeIds.add(relation.source.nodeId);
    if (relation.target.nodeId !== undefined) nodeIds.add(relation.target.nodeId);
  }
  const existingNodes = new Map(draft.nodes.map((node) => [node.symbolId, node]));
  for (const relation of draft.directRelations) {
    for (const endpoint of [relation.source, relation.target]) {
      if (endpoint.nodeId === undefined || existingNodes.has(endpoint.nodeId)) continue;
      const fqName = endpoint.symbol ?? endpoint.nodeId;
      existingNodes.set(endpoint.nodeId, {
        symbolId: endpoint.nodeId,
        filePath: endpoint.path ?? "",
        fqName,
        localName: fqName.split("::").at(-1)?.split(".").at(-1) ?? fqName,
        kind: endpoint.kind ?? draft.resolvedSymbol.kind,
        distance: 1,
      });
    }
  }
  draft.nodes = [...existingNodes.values()]
    .filter((node) => nodeIds.has(node.symbolId))
    .map(({ sourceExcerpt: _sourceExcerpt, ...node }) => node);
  const nodeById = new Map(draft.nodes.map((node) => [node.symbolId, node]));
  draft.dependentFiles = [...new Set(
    draft.nodes.filter((node) => node.distance > 0).map((node) => node.filePath),
  )].sort();
  draft.view = {
    format: draft.view.format,
    lines: draft.view.format === "mermaid"
      ? draft.nodes.map((node) => compactViewLine(node, draft.edges, nodeById))
      : draft.nodes.map((node) => previousLinesByNodeId.get(node.symbolId)
        ?? compactViewLine(node, draft.edges, nodeById)),
  };
  draft.summary = {
    ...draft.summary,
    dependentSymbolCount: Math.max(0, draft.nodes.length - 1),
    dependentFileCount: draft.dependentFiles.length,
    maxObservedDistance: Math.max(0, ...draft.nodes.map((node) => node.distance)),
  };
  draft.diagnostics = {
    ...draft.diagnostics,
    canonicalEdgesRetained: uniqueDeliveredEdgeCount(draft),
    canonicalNodesRetained: draft.nodes.length,
    deliveryTruncated: draft.diagnostics.deliveryTruncated
      || uniqueDeliveredEdgeCount(draft) < draft.limits.maxEdges,
  };
  compacted.add("nodes[].sourceExcerpt");
  compacted.add("view");
}

function compactViewLine(
  node: ImpactNode,
  edges: readonly ImpactEdge[],
  nodeById: ReadonlyMap<string, ImpactNode>,
): string {
  const edge = edges.find((candidate) => candidate.fromSymbolId === node.symbolId);
  const target = edge === undefined ? undefined : nodeById.get(edge.toSymbolId);
  return edge === undefined
    ? `d${node.distance} ${node.fqName}`
    : `d${node.distance} ${node.fqName} ${edge.edgeType} ${target?.fqName ?? edge.toFqName}`;
}

function compactRelation(relation: StaticRelationEvidence): StaticRelationEvidence {
  return {
    ...relation,
    evidence: {
      resolutionMethod: relation.evidence.resolutionMethod,
      locationKind: relation.evidence.locationKind,
      ...(relation.evidence.callSites === undefined ? {} : { callSites: relation.evidence.callSites }),
      ...(relation.evidence.callSiteCount === undefined ? {} : { callSiteCount: relation.evidence.callSiteCount }),
    },
    limitations: [],
  };
}

function minimalRelation(relation: StaticRelationEvidence): StaticRelationEvidence {
  return {
    ...relation,
    source: { nodeId: relation.source.nodeId, path: relation.source.path, symbol: relation.source.symbol, lineSpan: relation.source.lineSpan },
    target: { nodeId: relation.target.nodeId, path: relation.target.path, symbol: relation.target.symbol },
    evidence: {
      resolutionMethod: relation.evidence.resolutionMethod,
      locationKind: relation.evidence.locationKind,
      ...(relation.evidence.callSites === undefined ? {} : { callSites: relation.evidence.callSites }),
      ...(relation.evidence.callSiteCount === undefined ? {} : { callSiteCount: relation.evidence.callSiteCount }),
    },
    limitations: [],
  };
}

function uniqueDeliveredEdgeCount(output: Pick<ImpactGraphOutput, "edges" | "directRelations">): number {
  return new Set([
    ...output.edges.map((edge) => edge.edgeId),
    ...output.directRelations.map((relation) => relation.edgeId ?? relation.id),
  ]).size;
}

function modelVisibleValue(draft: MutableImpactResponse): unknown {
  return {
    edges: draft.edges,
    nodes: draft.nodes,
    view: draft.view,
    directRelations: draft.directRelations,
    paths: draft.paths,
  };
}

function buildBudget(
  draft: MutableImpactResponse,
  input: {
    requestedMaxTokens: number;
    totalCeiling: number;
    requestedMaxEdges: number;
    originalUniqueEdges: number;
    compacted: ReadonlySet<string>;
  },
): ImpactResponseBudget {
  const modelVisibleEstimatedTokens = estimateTokens(JSON.stringify(modelVisibleValue(draft)));
  const retainedEdges = uniqueDeliveredEdgeCount(draft);
  const omittedEdges = Math.max(
    draft.richSummary.omittedEdges,
    input.originalUniqueEdges - retainedEdges,
  );
  let serializedCharacters = 0;
  let accounting: ImpactResponseBudget;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const estimatedTotalTokens = estimateTokens("x".repeat(serializedCharacters));
    accounting = {
      envelopeVersion: IMPACT_RESPONSE_ENVELOPE_VERSION,
      requestedMaxTokens: input.requestedMaxTokens,
      modelVisibleEstimatedTokens,
      metadataEstimatedTokens: Math.max(0, estimatedTotalTokens - modelVisibleEstimatedTokens),
      estimatedTotalTokens,
      totalCeiling: input.totalCeiling,
      serializedCharacters,
      withinEnvelope: true,
      compactionApplied: input.compacted.size > 0,
      compactedFields: [...input.compacted].sort().slice(0, 8),
      requestedMaxEdges: input.requestedMaxEdges,
      retainedEdges,
      omittedEdges,
      resultState: omittedEdges > 0
        ? "bounded_truncated"
        : input.compacted.size > 0 ? "response_compacted" : "complete",
      estimateMethod: "chars_div_4",
    };
    const measured = JSON.stringify({ ...draft, responseBudget: accounting }).length;
    if (measured === serializedCharacters) return accounting;
    serializedCharacters = measured;
  }
  return accounting!;
}
