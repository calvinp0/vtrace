import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import { getLatestIndexRun } from "../db/repositories/indexRunsRepository";
import {
  deleteObservationsByIds,
  listObservationsForSession,
  persistObservation,
} from "../db/repositories/observationsRepository";
import { getSessionById } from "../db/repositories/sessionsRepository";
import {
  ObservationKind,
  ObservationOrigin,
  ObservationScope,
  ObservationSource,
  type Observation,
  type ObservationProvenance,
} from "./types";

export const PASSIVE_CONSOLIDATION_TOOL_NAME = "consolidate_passive_observations";
export const DEFAULT_PASSIVE_CONSOLIDATION_THRESHOLD = 3;

const MAX_CONSOLIDATED_LINKS = 20;
const MAX_SOURCE_OBSERVATION_IDS_IN_BODY = 20;
const SIGNATURE_SELECTED_BODY_KEYS = new Set([
  "capsule_profile",
  "dependent_file_count",
  "dependent_symbol_count",
  "depth",
  "detail",
  "format",
  "indexed_file_count",
  "limit",
  "max_paths",
  "observation_count",
  "pivot_count",
  "ranked_observation_count",
  "requested_file_count",
  "resolved",
  "result_count",
  "routing_profile",
  "support_count",
]);

export interface PassiveConsolidationGroup {
  readonly signature: string;
  readonly sourceKind: ObservationKind;
  readonly sourceObservationCount: number;
  readonly toolCounts: Record<string, number>;
  readonly firstObservedAtMs: number;
  readonly lastObservedAtMs: number;
  readonly linkedFilePaths: string[];
  readonly linkedSymbolIds: string[];
  readonly linkedFqNames: string[];
  readonly sourceRunIds: number[];
  readonly sourceObservationIds: string[];
  readonly summary: string;
  readonly body: string;
  readonly queryText: string;
  readonly intent?: string;
  readonly sourceRunId?: number;
  readonly inheritedProvenance?: ObservationProvenance;
}

export interface PassiveObservationConsolidationResult {
  readonly sessionId: string;
  readonly consolidatedObservationIds: string[];
  readonly prunedSourceObservationCount: number;
  readonly groups: PassiveConsolidationGroup[];
}

export function previewPassiveObservationConsolidationForSession(
  db: Database,
  input: {
    sessionId: string;
    threshold?: number;
  },
): PassiveConsolidationGroup[] {
  return buildPassiveConsolidationGroups(
    listObservationsForSession(db, input.sessionId),
    input.threshold ?? DEFAULT_PASSIVE_CONSOLIDATION_THRESHOLD,
  );
}

export function consolidatePassiveObservationsForSession(
  db: Database,
  input: {
    sessionId: string;
    nowMs: number;
    threshold?: number;
  },
): PassiveObservationConsolidationResult | undefined {
  const session = getSessionById(db, input.sessionId);

  if (session === undefined) {
    return undefined;
  }

  const groups = previewPassiveObservationConsolidationForSession(db, {
    sessionId: input.sessionId,
    threshold: input.threshold,
  });

  if (groups.length === 0) {
    return {
      sessionId: input.sessionId,
      consolidatedObservationIds: [],
      prunedSourceObservationCount: 0,
      groups: [],
    };
  }

  const consolidatedObservationIds: string[] = [];
  const sourceObservationIdsToPrune: string[] = [];

  const transaction = db.transaction(() => {
    for (const group of groups) {
      const observation = persistObservation(db, {
        repoRoot: session.repoRoot,
        sessionId: session.sessionId,
        sessionAgentKind: session.agentKind,
        kind: ObservationKind.Insight,
        source: ObservationSource.McpAuto,
        toolName: PASSIVE_CONSOLIDATION_TOOL_NAME,
        queryText: group.queryText,
        intent: group.intent,
        summary: group.summary,
        body: group.body,
        sourceRunId: group.sourceRunId ?? getLatestIndexRun(db)?.id,
        ...(group.inheritedProvenance === undefined ? {} : {
          scope: ObservationScope.Repository,
          origin: ObservationOrigin.AutomaticCapture,
          provenance: group.inheritedProvenance,
        }),
        createdAtMs: input.nowMs,
        dedupeKey: `passive_consolidation:${session.sessionId}:${group.signature}`,
        linkedFilePaths: group.linkedFilePaths,
        linkedSymbolIds: group.linkedSymbolIds,
        linkedFqNames: group.linkedFqNames,
      });

      consolidatedObservationIds.push(observation.id);
      sourceObservationIdsToPrune.push(...group.sourceObservationIds);
    }

    deleteObservationsByIds(db, sourceObservationIdsToPrune);
  });

  transaction();

  return {
    sessionId: input.sessionId,
    consolidatedObservationIds,
    prunedSourceObservationCount: sourceObservationIdsToPrune.length,
    groups,
  };
}

export function buildPassiveConsolidationGroups(
  observations: readonly Observation[],
  threshold: number = DEFAULT_PASSIVE_CONSOLIDATION_THRESHOLD,
): PassiveConsolidationGroup[] {
  if (!Number.isInteger(threshold) || threshold < 2) {
    throw new Error("threshold must be an integer greater than or equal to 2");
  }

  const grouped = new Map<string, Observation[]>();

  for (const observation of observations) {
    if (!isConsolidationEligiblePassiveObservation(observation)) {
      continue;
    }

    const signature = computePassiveObservationSignature(observation);
    const existing = grouped.get(signature) ?? [];
    existing.push(observation);
    grouped.set(signature, existing);
  }

  return [...grouped.entries()]
    .filter(([, groupObservations]) => groupObservations.length >= threshold)
    .map(([signature, groupObservations]) => buildConsolidationGroup(signature, groupObservations))
    .sort(comparePassiveConsolidationGroups);
}

export function isConsolidationEligiblePassiveObservation(
  observation: Observation,
): boolean {
  return observation.kind === ObservationKind.ToolCall
    && observation.source === ObservationSource.McpAuto
    && observation.toolName !== PASSIVE_CONSOLIDATION_TOOL_NAME;
}

export function computePassiveObservationSignature(
  observation: Observation,
): string {
  const components = [
    "tool_call",
    normalizeSignatureText(observation.toolName ?? "unknown"),
    normalizeSignatureText(observation.queryText ?? ""),
    normalizeSignatureText(observation.intent ?? ""),
    hashStrings(collectSortedFilePaths(observation)),
    hashStrings(collectSortedFqNames(observation)),
    hashRecord(extractSelectedBodyShape(observation.body)),
  ];

  return `tool_call:${observation.toolName ?? "unknown"}:${hashStrings(components)}`;
}

function buildConsolidationGroup(
  signature: string,
  observations: readonly Observation[],
): PassiveConsolidationGroup {
  const sortedObservations = [...observations].sort(compareObservationsAscending);
  const sourceObservationCount = sortedObservations.length;
  const toolCounts = countBy(sortedObservations, (observation) => observation.toolName ?? "unknown");
  const firstObservedAtMs = sortedObservations[0]!.createdAtMs;
  const lastObservedAtMs = sortedObservations.at(-1)!.createdAtMs;
  const tools = Object.keys(toolCounts);
  const linkedFilePaths = collectUniqueSorted(
    sortedObservations.flatMap(collectSortedFilePaths),
  ).slice(0, MAX_CONSOLIDATED_LINKS);
  const linkedSymbolIds = collectUniqueSorted(
    sortedObservations.flatMap((observation) => {
      return observation.linkedSymbols.map((link) => link.symbolId);
    }),
  ).slice(0, MAX_CONSOLIDATED_LINKS);
  const linkedFqNames = collectUniqueSorted(
    sortedObservations.flatMap(collectSortedFqNames),
  ).slice(0, MAX_CONSOLIDATED_LINKS);
  const sourceRunIds = collectUniqueSortedNumbers(
    sortedObservations
      .map((observation) => observation.sourceRunId)
      .filter((sourceRunId): sourceRunId is number => sourceRunId !== undefined),
  );
  const queryTexts = collectUniqueSorted(
    sortedObservations
      .map((observation) => observation.queryText?.trim() ?? "")
      .filter((queryText) => queryText.length > 0),
  );
  const intents = collectUniqueSorted(
    sortedObservations
      .map((observation) => observation.intent?.trim() ?? "")
      .filter((intent) => intent.length > 0),
  );
  const firstTool = tools[0] ?? "unknown";
  const queryText = [
    ...tools,
    ...queryTexts,
    ...linkedFilePaths,
    ...linkedFqNames,
  ].join(" ");
  const sourceRunId = sourceRunIds[0];
  const inheritedProvenance = commonContextProvenance(sortedObservations);

  return {
    signature,
    sourceKind: ObservationKind.ToolCall,
    sourceObservationCount,
    toolCounts,
    firstObservedAtMs,
    lastObservedAtMs,
    linkedFilePaths,
    linkedSymbolIds,
    linkedFqNames,
    sourceRunIds,
    sourceObservationIds: sortedObservations.map((observation) => observation.id),
    summary: formatConsolidatedSummary({
      count: sourceObservationCount,
      toolName: firstTool,
      queryTexts,
    }),
    body: formatConsolidatedBody({
      signature,
      sessionId: sortedObservations[0]!.sessionId ?? "",
      sourceObservationCount,
      toolCounts,
      firstObservedAtMs,
      lastObservedAtMs,
      linkedFilePaths,
      linkedSymbolIds,
      linkedFqNames,
      sourceRunIds,
      sourceObservationIds: sortedObservations.map((observation) => observation.id),
      queryTexts,
      intents,
    }),
    queryText,
    ...(intents.length === 1 ? { intent: intents[0] } : {}),
    ...(sourceRunId === undefined ? {} : { sourceRunId }),
    ...(inheritedProvenance === undefined ? {} : { inheritedProvenance }),
  };
}

function commonContextProvenance(
  observations: readonly Observation[],
): ObservationProvenance | undefined {
  const first = observations[0]?.provenance;
  if (first === undefined) return undefined;
  const contextKey = provenanceContextKey(first);
  if (!observations.every((observation) => observation.provenance !== undefined
    && provenanceContextKey(observation.provenance) === contextKey)) return undefined;
  return {
    ...first,
    tool: null,
    resultSemanticHash: null,
    resultSummary: null,
  };
}

function provenanceContextKey(provenance: ObservationProvenance): string {
  return JSON.stringify({
    schemaVersion: provenance.schemaVersion,
    repository: provenance.repository,
    index: provenance.index,
    implementation: provenance.implementation,
  });
}

function formatConsolidatedSummary(input: {
  count: number;
  toolName: string;
  queryTexts: readonly string[];
}): string {
  const querySuffix = input.queryTexts.length === 0
    ? ""
    : ` around ${input.queryTexts.slice(0, 2).join(" / ")}`;

  return `Consolidated ${input.count} repeated ${input.toolName} tool calls${querySuffix}.`;
}

function formatConsolidatedBody(input: {
  signature: string;
  sessionId: string;
  sourceObservationCount: number;
  toolCounts: Record<string, number>;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  linkedFilePaths: readonly string[];
  linkedSymbolIds: readonly string[];
  linkedFqNames: readonly string[];
  sourceRunIds: readonly number[];
  sourceObservationIds: readonly string[];
  queryTexts: readonly string[];
  intents: readonly string[];
}): string {
  return [
    "consolidated=true",
    "strategy=deterministic_lexical_structural",
    "source_kind=tool_call",
    `source_observation_count=${input.sourceObservationCount}`,
    `tools=${stableStringify(input.toolCounts)}`,
    `first_observed_at=${new Date(input.firstObservedAtMs).toISOString()}`,
    `last_observed_at=${new Date(input.lastObservedAtMs).toISOString()}`,
    `first_observed_at_ms=${input.firstObservedAtMs}`,
    `last_observed_at_ms=${input.lastObservedAtMs}`,
    `signature=${input.signature}`,
    `session_id=${input.sessionId}`,
    `source_run_ids=${input.sourceRunIds.join(", ")}`,
    `source_observation_ids=${input.sourceObservationIds.slice(0, MAX_SOURCE_OBSERVATION_IDS_IN_BODY).join(", ")}`,
    `queries=${input.queryTexts.join(" | ")}`,
    `intents=${input.intents.join(", ")}`,
    `files=${input.linkedFilePaths.join(", ")}`,
    `symbol_ids=${input.linkedSymbolIds.join(", ")}`,
    `symbol_fqns=${input.linkedFqNames.join(", ")}`,
    "semantic_similarity=false",
    "embeddings=false",
    "project_rules=false",
  ].join("\n");
}

function extractSelectedBodyShape(body: string): Record<string, string> {
  const shape = new Map<string, string>();

  for (const rawLine of body.split(/\r?\n/u)) {
    const separatorIndex = rawLine.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = rawLine.slice(0, separatorIndex).trim().toLowerCase();
    const value = rawLine.slice(separatorIndex + 1);

    if (!SIGNATURE_SELECTED_BODY_KEYS.has(key)) {
      continue;
    }

    shape.set(key, normalizeSignatureText(value));
  }

  return Object.fromEntries([...shape.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function collectSortedFilePaths(observation: Observation): string[] {
  return collectUniqueSorted(observation.linkedFilePaths.map(normalizePath));
}

function collectSortedFqNames(observation: Observation): string[] {
  return collectUniqueSorted([
    ...observation.linkedFqNames,
    ...observation.linkedSymbols.map((link) => link.fqName),
  ]);
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//u, "");
}

function normalizeSignatureText(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\s+/gu, " ").toLowerCase();
}

function countBy<T>(
  values: readonly T[],
  getKey: (value: T) => string,
): Record<string, number> {
  const counts = new Map<string, number>();

  for (const value of values) {
    const key = getKey(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function collectUniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function collectUniqueSortedNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function hashRecord(value: Record<string, string>): string {
  return hashStrings([stableStringify(value)]);
}

function hashStrings(values: readonly string[]): string {
  const hash = createHash("sha256");

  for (const value of values) {
    hash.update(value);
    hash.update("\0");
  }

  return hash.digest("hex").slice(0, 16);
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

function compareObservationsAscending(
  left: Observation,
  right: Observation,
): number {
  return left.createdAtMs - right.createdAtMs
    || left.id.localeCompare(right.id);
}

function comparePassiveConsolidationGroups(
  left: PassiveConsolidationGroup,
  right: PassiveConsolidationGroup,
): number {
  return right.sourceObservationCount - left.sourceObservationCount
    || left.signature.localeCompare(right.signature);
}
