import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import type { Capsule } from "../capsule/types";
import { persistObservation } from "../db/repositories/observationsRepository";
import type { RoutedQueryResult } from "../intent/routeQuery";
import { ObservationKind, ObservationSource, type Observation } from "./types";

export interface CaptureVisibleCapsuleObservationInput {
  db: Database;
  repoRoot: string;
  sourceRunId: number | null;
  routedQuery: RoutedQueryResult;
  capsuleProfileId: string;
  capsule: Capsule;
  toolName: string;
  sessionId?: string;
  sessionAgentKind?: string;
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
  const body = [
    `intent=${input.routedQuery.intent}`,
    `routing_profile=${input.routedQuery.profile.id}`,
    `capsule_profile=${input.capsuleProfileId}`,
    `top_pivots=${topPivots.join(", ")}`,
  ].join("\n");

  return persistObservation(input.db, {
    repoRoot: input.repoRoot,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.sessionAgentKind === undefined ? {} : { sessionAgentKind: input.sessionAgentKind }),
    kind: ObservationKind.ToolCall,
    source: ObservationSource.McpAuto,
    toolName: input.toolName,
    queryText: input.routedQuery.query,
    intent: input.routedQuery.intent,
    summary: `${input.toolName}: ${input.routedQuery.query}`,
    body,
    sourceRunId: input.sourceRunId ?? undefined,
    dedupeKey: computeVisibleCapsuleObservationDedupeKey({
      sourceRunId: input.sourceRunId,
      routedQuery: input.routedQuery,
      capsuleProfileId: input.capsuleProfileId,
      capsule: input.capsule,
    }),
    linkedFilePaths,
    linkedSymbolIds,
    linkedFqNames,
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
  routedQuery: RoutedQueryResult;
  capsuleProfileId: string;
  capsule: Pick<Capsule, "pivots">;
}): string {
  return computeVisibleCapsuleDedupeKey({
    sourceRunId: input.sourceRunId,
    query: input.routedQuery.query,
    intent: input.routedQuery.intent,
    routingProfileId: input.routedQuery.profile.id,
    capsuleProfileId: input.capsuleProfileId,
    topPivots: input.capsule.pivots.slice(0, 3).map((item) => item.fqName),
  });
}

function computeVisibleCapsuleDedupeKey(input: {
  sourceRunId: number | null;
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
