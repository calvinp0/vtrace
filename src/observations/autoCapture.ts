import { createHash } from "node:crypto";
import type { WritableProductStores } from "../session/sessionStore";

import type { Capsule } from "../capsule/types";
import { persistObservation } from "../session/repositories/observationsRepository";
import type { ImpactGraphOutput } from "../impact/getImpactGraph";
import type { RoutedQueryResult } from "../intent/routeQuery";
import type { LogicFlowOutput } from "../logicFlow/searchLogicFlow";
import type { GetSkeletonOutput } from "../skeleton/getSkeleton";
import { ObservationKind, ObservationSource, type Observation } from "./types";
import { ObservationOrigin, ObservationScope, type CurrentObservationContext, type TechnicalObservationSummary } from "./types";
import { buildObservationProvenance } from "./provenance";

export interface CaptureVisibleCapsuleObservationInput {
  stores: WritableProductStores;
  repoRoot: string;
  sourceRunId: number | null;
  routedQuery: RoutedQueryResult;
  capsuleProfileId: string;
  capsule: Capsule;
  toolName: string;
  sessionId?: string;
  sessionAgentKind?: string;
  currentContext?: CurrentObservationContext;
}

export function captureVisibleCapsuleObservation(
  input: CaptureVisibleCapsuleObservationInput,
): Observation {
  const linkedItems = [...input.capsule.pivots, ...input.capsule.supportingItems].slice(0, 6);
  const linkedSymbolIds = linkedItems.map((item) => item.symbolId);
  const linkedFilePaths = [...new Set(linkedItems.map((item) => item.filePath))];
  const linkedFqNames = [...new Set(linkedItems.map((item) => item.fqName))];
  const topPivots = input.capsule.pivots
    .slice(0, 3)
    .map((item) => item.fqName);
  const pivotCount = input.capsule.pivots.length;
  const supportCount = input.capsule.supportingItems.length;
  const body = [
    `tool=${input.toolName}`,
    `query=${input.routedQuery.query}`,
    `intent=${input.routedQuery.intent}`,
    `routing_profile=${input.routedQuery.profile.id}`,
    `capsule_profile=${input.capsuleProfileId}`,
    `pivot_count=${pivotCount}`,
    `support_count=${supportCount}`,
    `top_pivots=${topPivots.join(", ")}`,
  ].join("\n");

  return persistObservation(input.stores, {
    repoRoot: input.repoRoot,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.sessionAgentKind === undefined ? {} : { sessionAgentKind: input.sessionAgentKind }),
    kind: ObservationKind.ToolCall,
    source: ObservationSource.McpAuto,
    toolName: input.toolName,
    queryText: input.routedQuery.query,
    intent: input.routedQuery.intent,
    summary: `Built context capsule for query with ${pivotCount} pivots and ${supportCount} supports.`,
    body,
    sourceRunId: input.sourceRunId ?? undefined,
    ...(input.currentContext === undefined ? {} : {
      scope: ObservationScope.IndexState,
      origin: ObservationOrigin.AutomaticCapture,
      provenance: buildObservationProvenance({
        context: input.currentContext,
        toolName: input.toolName,
        queryText: input.routedQuery.query,
        semanticOptions: {
          intent: input.routedQuery.intent,
          routingProfile: input.routedQuery.profile.id,
          capsuleProfile: input.capsuleProfileId,
        },
        resultValue: {
          pivots: input.capsule.pivots.map((item) => item.symbolId),
          supports: input.capsule.supportingItems.map((item) => item.symbolId),
        },
      }),
    }),
    dedupeKey: computeVisibleCapsuleObservationDedupeKey({
      sourceRunId: input.sourceRunId,
      sessionId: input.sessionId,
      routedQuery: input.routedQuery,
      capsuleProfileId: input.capsuleProfileId,
      capsule: input.capsule,
    }),
    linkedFilePaths,
    linkedSymbolIds,
    linkedFqNames,
  });
}

export interface CaptureToolCallObservationInput {
  stores: WritableProductStores;
  repoRoot: string;
  sourceRunId: number | null;
  toolName: string;
  summary: string;
  bodyLines: readonly string[];
  dedupeParts: readonly unknown[];
  sessionId?: string;
  sessionAgentKind?: string;
  queryText?: string;
  intent?: string;
  linkedFilePaths?: readonly string[];
  linkedSymbolIds?: readonly string[];
  linkedFqNames?: readonly string[];
  currentContext?: CurrentObservationContext;
  semanticOptions?: Readonly<Record<string, unknown>>;
  resultSummary?: TechnicalObservationSummary;
  resultValue?: unknown;
}

export function captureToolCallObservation(
  input: CaptureToolCallObservationInput,
): Observation {
  return persistObservation(input.stores, {
    repoRoot: input.repoRoot,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    sessionAgentKind: input.sessionAgentKind ?? "mcp",
    kind: ObservationKind.ToolCall,
    source: ObservationSource.McpAuto,
    toolName: input.toolName,
    queryText: input.queryText,
    intent: input.intent,
    summary: input.summary,
    body: input.bodyLines.join("\n"),
    sourceRunId: input.sourceRunId ?? undefined,
    ...(input.currentContext === undefined ? {} : {
      scope: ObservationScope.IndexState,
      origin: ObservationOrigin.AutomaticCapture,
      provenance: buildObservationProvenance({
        context: input.currentContext,
        toolName: input.toolName,
        queryText: input.queryText,
        semanticOptions: input.semanticOptions,
        resultSummary: input.resultSummary,
        resultValue: input.resultValue,
      }),
    }),
    dedupeKey: computeToolCallObservationDedupeKey({
      toolName: input.toolName,
      sessionId: input.sessionId,
      sourceRunId: input.sourceRunId,
      parts: input.dedupeParts,
    }),
    linkedFilePaths: input.linkedFilePaths,
    linkedSymbolIds: input.linkedSymbolIds,
    linkedFqNames: input.linkedFqNames,
  });
}

export function captureToolCallObservationBestEffort(
  input: CaptureToolCallObservationInput,
): Observation | undefined {
  try {
    return captureToolCallObservation(input);
  } catch {
    return undefined;
  }
}

export function captureImpactGraphObservationBestEffort(input: {
  stores: WritableProductStores;
  repoRoot: string;
  sourceRunId: number | null;
  output: ImpactGraphOutput;
  toolName: string;
  sessionId?: string;
  currentContext?: CurrentObservationContext;
}): Observation | undefined {
  const dependentSymbolCount = input.output.summary.dependentSymbolCount;
  const dependentFileCount = input.output.summary.dependentFileCount;
  const linkedFilePaths = [
    input.output.resolvedSymbol.filePath,
    ...input.output.dependentFiles,
  ];
  const linkedSymbolIds = input.output.nodes.map((node) => node.symbolId);
  const linkedFqNames = input.output.nodes.map((node) => node.fqName);

  return captureToolCallObservationBestEffort({
    stores: input.stores,
    repoRoot: input.repoRoot,
    sourceRunId: input.sourceRunId,
    toolName: input.toolName,
    sessionId: input.sessionId,
    queryText: input.output.requested.symbolFqn,
    summary:
      `Computed impact graph for ${input.output.requested.symbolFqn} with ${dependentSymbolCount} dependents across ${dependentFileCount} files.`,
    bodyLines: [
      `tool=${input.toolName}`,
      `symbol_fqn=${input.output.requested.symbolFqn}`,
      `depth=${input.output.requested.depth}`,
      `format=${input.output.requested.format}`,
      `dependent_symbol_count=${dependentSymbolCount}`,
      `dependent_file_count=${dependentFileCount}`,
      `resolved_symbol_id=${input.output.resolvedSymbol.symbolId}`,
    ],
    dedupeParts: [
      input.output.requested,
      input.output.summary,
      input.output.dependentFiles,
    ],
    linkedFilePaths,
    linkedSymbolIds,
    linkedFqNames,
    currentContext: input.currentContext,
    semanticOptions: {
      target: input.output.requested.symbolFqn,
      depth: input.output.requested.depth,
      crossRepo: input.output.requested.crossRepo,
      maxEdges: input.output.limits.maxEdges,
    },
    resultSummary: {
      kind: "impact_graph",
      values: {
        target: input.output.requested.symbolFqn,
        dependentCount: dependentSymbolCount,
        fileCount: dependentFileCount,
      },
    },
    resultValue: {
      target: input.output.requested.symbolFqn,
      dependentSymbolCount,
      dependentFileCount,
      dependentFiles: input.output.dependentFiles,
      edges: input.output.edges.map((edge) => [edge.edgeType, edge.fromSymbolId, edge.toSymbolId]),
    },
  });
}

export function captureLogicFlowObservationBestEffort(input: {
  stores: WritableProductStores;
  repoRoot: string;
  sourceRunId: number | null;
  output: LogicFlowOutput;
  toolName: string;
  sessionId?: string;
  currentContext?: CurrentObservationContext;
}): Observation | undefined {
  const pathSymbols = input.output.paths.flatMap((path) => path.nodes);
  const linkedFilePaths = [
    input.output.resolvedStart.filePath,
    input.output.resolvedEnd.filePath,
    ...pathSymbols.map((symbol) => symbol.filePath),
  ];
  const linkedSymbolIds = [
    input.output.resolvedStart.symbolId,
    input.output.resolvedEnd.symbolId,
    ...pathSymbols.map((symbol) => symbol.symbolId),
  ];
  const linkedFqNames = [
    input.output.resolvedStart.fqName,
    input.output.resolvedEnd.fqName,
    ...pathSymbols.map((symbol) => symbol.fqName),
  ];

  return captureToolCallObservationBestEffort({
    stores: input.stores,
    repoRoot: input.repoRoot,
    sourceRunId: input.sourceRunId,
    toolName: input.toolName,
    sessionId: input.sessionId,
    queryText: `${input.output.requested.start} -> ${input.output.requested.end}`,
    summary:
      `Computed logic flow from ${input.output.requested.start} to ${input.output.requested.end} with ${input.output.summary.pathCount} path(s).`,
    bodyLines: [
      `tool=${input.toolName}`,
      `start=${input.output.requested.start}`,
      `end=${input.output.requested.end}`,
      `max_paths=${input.output.requested.maxPaths}`,
      `reachable=${input.output.summary.reachable}`,
      `path_count=${input.output.summary.pathCount}`,
      `shortest_path_edge_count=${input.output.summary.shortestPathEdgeCount ?? "null"}`,
    ],
    dedupeParts: [
      input.output.requested,
      {
        pathCount: input.output.summary.pathCount,
        shortestPathEdgeCount: input.output.summary.shortestPathEdgeCount,
        truncated: input.output.summary.truncated,
      },
    ],
    linkedFilePaths,
    linkedSymbolIds,
    linkedFqNames,
    currentContext: input.currentContext,
    semanticOptions: {
      start: input.output.requested.start,
      end: input.output.requested.end,
      maxPaths: input.output.requested.maxPaths,
    },
    resultSummary: {
      kind: "logic_flow",
      values: {
        reachable: input.output.summary.reachable,
        pathCount: input.output.summary.pathCount,
      },
    },
    resultValue: {
      reachable: input.output.summary.reachable,
      paths: input.output.paths.map((path) => path.nodes.map((node) => node.symbolId)),
    },
  });
}

export function captureSkeletonObservationBestEffort(input: {
  stores: WritableProductStores;
  repoRoot: string;
  sourceRunId: number | null;
  output: GetSkeletonOutput;
  toolName: string;
  requestedFiles: readonly string[];
  sessionId?: string;
  currentContext?: CurrentObservationContext;
}): Observation | undefined {
  const indexedFiles = input.output.files.filter((file) => file.status === "ok");

  if (indexedFiles.length === 0) {
    return undefined;
  }

  return captureToolCallObservationBestEffort({
    stores: input.stores,
    repoRoot: input.repoRoot,
    sourceRunId: input.sourceRunId,
    toolName: input.toolName,
    sessionId: input.sessionId,
    queryText: input.requestedFiles.join(" "),
    summary: `Generated skeletons for ${indexedFiles.length} indexed files.`,
    bodyLines: [
      `tool=${input.toolName}`,
      `detail=${input.output.detail}`,
      `requested_file_count=${input.requestedFiles.length}`,
      `indexed_file_count=${indexedFiles.length}`,
      `files=${input.output.files.map((file) => `${file.filePath}:${file.status}`).join(", ")}`,
    ],
    dedupeParts: [
      input.output.detail,
      input.output.files.map((file) => ({
        filePath: file.filePath,
        status: file.status,
        declarationCount: file.declarations.length,
        importCount: file.imports.length,
        exportCount: file.exports.length,
      })),
    ],
    linkedFilePaths: indexedFiles.map((file) => file.filePath),
    currentContext: input.currentContext,
    semanticOptions: { detail: input.output.detail, files: [...input.requestedFiles].sort() },
    resultValue: input.output.files.map((file) => ({
      filePath: file.filePath,
      status: file.status,
      declarations: file.declarations.map((declaration) => [declaration.kind, declaration.name]),
    })),
  });
}

export function captureSearchMemoryObservationBestEffort(input: {
  stores: WritableProductStores;
  repoRoot: string;
  sourceRunId: number | null;
  toolName: string;
  query: string;
  maxResults?: number;
  sessionId?: string;
  resultCount: number;
  topObservationIds: readonly string[];
  linkedFilePaths?: readonly string[];
  linkedSymbolIds?: readonly string[];
  currentContext?: CurrentObservationContext;
}): Observation | undefined {
  if (input.resultCount === 0) {
    return undefined;
  }

  return captureToolCallObservationBestEffort({
    stores: input.stores,
    repoRoot: input.repoRoot,
    sourceRunId: input.sourceRunId,
    toolName: input.toolName,
    sessionId: input.sessionId,
    queryText: input.query,
    summary: `Searched memory for "${input.query}" and returned ${input.resultCount} observations.`,
    bodyLines: [
      `tool=${input.toolName}`,
      `query=${input.query}`,
      `max_results=${input.maxResults ?? "default"}`,
      `result_count=${input.resultCount}`,
      `top_observation_ids=${input.topObservationIds.slice(0, 5).join(", ")}`,
    ],
    dedupeParts: [
      input.query,
      input.maxResults ?? null,
      input.sessionId ?? null,
      input.linkedFilePaths ?? [],
      input.linkedSymbolIds ?? [],
    ],
    linkedFilePaths: input.linkedFilePaths,
    linkedSymbolIds: input.linkedSymbolIds,
    currentContext: input.currentContext,
    semanticOptions: {
      sessionId: input.sessionId ?? null,
      linkedFilePaths: input.linkedFilePaths ?? [],
      linkedSymbolIds: input.linkedSymbolIds ?? [],
    },
    resultValue: { observationIds: input.topObservationIds },
  });
}

export function captureSessionContextObservationBestEffort(input: {
  stores: WritableProductStores;
  repoRoot: string;
  sourceRunId: number | null;
  toolName: string;
  sessionId?: string;
  query?: string;
  limit?: number;
  observationCount: number;
  rankedObservationCount?: number;
  observationIds: readonly string[];
  linkedFilePaths: readonly string[];
  linkedSymbolIds: readonly string[];
  linkedFqNames: readonly string[];
  currentContext?: CurrentObservationContext;
}): Observation | undefined {
  if (input.observationCount === 0) {
    return undefined;
  }

  const scope = input.sessionId === undefined ? "recent repo context" : `session ${input.sessionId}`;

  return captureToolCallObservationBestEffort({
    stores: input.stores,
    repoRoot: input.repoRoot,
    sourceRunId: input.sourceRunId,
    toolName: input.toolName,
    sessionId: input.sessionId,
    queryText: input.query,
    summary: `Retrieved ${scope} with ${input.observationCount} observations.`,
    bodyLines: [
      `tool=${input.toolName}`,
      `session_id=${input.sessionId ?? "null"}`,
      `query=${input.query ?? ""}`,
      `limit=${input.limit ?? "default"}`,
      `observation_count=${input.observationCount}`,
      `ranked_observation_count=${input.rankedObservationCount ?? 0}`,
      `observation_ids=${input.observationIds.slice(0, 5).join(", ")}`,
    ],
    dedupeParts: [
      input.sessionId ?? null,
      input.query ?? null,
      input.limit ?? null,
    ],
    linkedFilePaths: input.linkedFilePaths,
    linkedSymbolIds: input.linkedSymbolIds,
    linkedFqNames: input.linkedFqNames,
    currentContext: input.currentContext,
    semanticOptions: { sessionId: input.sessionId ?? null },
    resultValue: { observationIds: input.observationIds },
  });
}

export function captureExpandVexpRefObservationBestEffort(input: {
  stores: WritableProductStores;
  repoRoot: string;
  sourceRunId: number | null;
  toolName: string;
  requestedHash: string;
  resolved: boolean;
  stableId?: string;
  category?: string;
  reason?: string;
  currentContext?: CurrentObservationContext;
}): Observation | undefined {
  if (!input.resolved) {
    return undefined;
  }

  return captureToolCallObservationBestEffort({
    stores: input.stores,
    repoRoot: input.repoRoot,
    sourceRunId: input.sourceRunId,
    toolName: input.toolName,
    queryText: input.requestedHash,
    summary: `Expanded V-REF ${input.requestedHash} for ${input.category ?? "unknown"} content.`,
    bodyLines: [
      `tool=${input.toolName}`,
      `hash=${input.requestedHash}`,
      `resolved=${input.resolved}`,
      `stable_id=${input.stableId ?? ""}`,
      `category=${input.category ?? ""}`,
    ],
    dedupeParts: [
      input.requestedHash,
      input.stableId ?? null,
      input.category ?? null,
    ],
    currentContext: input.currentContext,
    semanticOptions: { hash: input.requestedHash },
    resultValue: { stableId: input.stableId ?? null, category: input.category ?? null },
  });
}

// Auto-capture stays outside the capsule engine and remains a tightly bounded
// MCP-side effect. A persistence failure must never fail the primary tool
// response.
export function captureVisibleCapsuleObservationBestEffort(
  input: CaptureVisibleCapsuleObservationInput,
): Observation | undefined {
  try {
    return captureVisibleCapsuleObservation(input);
  } catch {
    return undefined;
  }
}

export function computeVisibleCapsuleObservationDedupeKey(input: {
  sourceRunId: number | null;
  sessionId?: string;
  routedQuery: RoutedQueryResult;
  capsuleProfileId: string;
  capsule: Pick<Capsule, "pivots">;
}): string {
  return computeVisibleCapsuleDedupeKey({
    sourceRunId: input.sourceRunId,
    sessionId: input.sessionId,
    query: input.routedQuery.query,
    intent: input.routedQuery.intent,
    routingProfileId: input.routedQuery.profile.id,
    capsuleProfileId: input.capsuleProfileId,
    topPivots: input.capsule.pivots.slice(0, 3).map((item) => item.fqName),
  });
}

function computeVisibleCapsuleDedupeKey(input: {
  sourceRunId: number | null;
  sessionId?: string;
  query: string;
  intent: string;
  routingProfileId: string;
  capsuleProfileId: string;
  topPivots: readonly string[];
}): string {
  const hash = createHash("sha256");

  // Neutral namespace — shared across every visible capsule-building tool
  // (get_context_capsule, run_pipeline, and the hidden legacy build_capsule)
  // so identical capsule inputs produce identical dedupe keys regardless of
  // which tool the caller invoked.
  hash.update("mcp_auto");
  hash.update("\0");
  hash.update("visible_capsule_observation");
  hash.update("\0");
  hash.update((input.sourceRunId ?? -1).toString(10));
  hash.update("\0");
  hash.update(input.sessionId ?? "");
  hash.update("\0");
  hash.update(input.query);
  hash.update("\0");
  hash.update(input.intent);
  hash.update("\0");
  hash.update(input.routingProfileId);
  hash.update("\0");
  hash.update(input.capsuleProfileId);

  for (const fqName of input.topPivots) {
    hash.update("\0");
    hash.update(fqName);
  }

  return hash.digest("hex");
}

function computeToolCallObservationDedupeKey(input: {
  toolName: string;
  sessionId?: string;
  sourceRunId: number | null;
  parts: readonly unknown[];
}): string {
  const hash = createHash("sha256");

  hash.update("mcp_auto");
  hash.update("\0");
  hash.update("tool_call_observation");
  hash.update("\0");
  hash.update(input.toolName);
  hash.update("\0");
  hash.update(input.sessionId ?? "");
  hash.update("\0");
  hash.update((input.sourceRunId ?? -1).toString(10));

  for (const part of input.parts) {
    hash.update("\0");
    hash.update(stableStringify(part));
  }

  return hash.digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => {
    return `${JSON.stringify(key)}:${stableStringify(record[key])}`;
  }).join(",")}}`;
}
