import type { FullyQualifiedName, SymbolId, SymbolKind } from "../domain/types";
import { StaleStateStatus, type SymbolRunIdentitySummary } from "../memory/types";

export const ObservationKind = Object.freeze({
  Decision: "decision",
  Insight: "insight",
  Warning: "warning",
  DeadEnd: "dead_end",
  ToolCall: "tool_call",
});

export type ObservationKind =
  (typeof ObservationKind)[keyof typeof ObservationKind];

export const ObservationSource = Object.freeze({
  Manual: "manual",
  McpAuto: "mcp_auto",
});

export type ObservationSource =
  (typeof ObservationSource)[keyof typeof ObservationSource];

export const SessionStatus = Object.freeze({
  Active: "active",
  Inactive: "inactive",
});

export type SessionStatus =
  (typeof SessionStatus)[keyof typeof SessionStatus];

export interface SessionRecord {
  sessionId: string;
  repoRoot: string;
  agentKind?: string;
  startedAtMs: number;
  lastActivityAtMs: number;
  status: SessionStatus;
}

export const ObservationStaleReasonKind = Object.freeze({
  FileRemoved: "file_removed",
  FileModified: "file_modified",
  SymbolRemoved: "symbol_removed",
  SymbolModified: "symbol_modified",
});

export type ObservationStaleReasonKind =
  (typeof ObservationStaleReasonKind)[keyof typeof ObservationStaleReasonKind];

export interface ObservationRecord {
  // Observation ids are content-stable within a repo. Equivalent payloads map
  // to the same id even when createdAtMs differs.
  id: string;
  repoRoot: string;
  sessionId?: string;
  kind: ObservationKind;
  source: ObservationSource;
  toolName?: string;
  queryText?: string;
  intent?: string;
  summary: string;
  body: string;
  sourceRunId?: number;
  dedupeKey?: string;
  // Metadata for recency ordering and display; not part of observation identity.
  createdAtMs: number;
}

export interface ObservationFileLinkRecord {
  observationId: string;
  linkOrdinal: number;
  filePath: string;
}

export interface ObservationSymbolLinkRecord {
  observationId: string;
  linkOrdinal: number;
  symbolId: SymbolId;
  filePath: string;
  fqName: FullyQualifiedName;
  symbolKind: SymbolKind;
}

export interface ObservationFQNameLinkRecord {
  observationId: string;
  linkOrdinal: number;
  fqName: FullyQualifiedName;
}

export interface Observation extends ObservationRecord {
  linkedFilePaths: string[];
  linkedSymbols: ObservationSymbolLinkRecord[];
  linkedFqNames: FullyQualifiedName[];
}

interface ObservationStaleReasonBase {
  kind: ObservationStaleReasonKind;
  detectedInRunId: number;
}

export interface ObservationFileRemovedReason extends ObservationStaleReasonBase {
  kind: typeof ObservationStaleReasonKind.FileRemoved;
  filePath: string;
}

export interface ObservationFileModifiedReason extends ObservationStaleReasonBase {
  kind: typeof ObservationStaleReasonKind.FileModified;
  filePath: string;
}

export interface ObservationSymbolRemovedReason extends ObservationStaleReasonBase {
  kind: typeof ObservationStaleReasonKind.SymbolRemoved;
  symbol: SymbolRunIdentitySummary;
}

export interface ObservationSymbolModifiedReason extends ObservationStaleReasonBase {
  kind: typeof ObservationStaleReasonKind.SymbolModified;
  symbol: SymbolRunIdentitySummary;
}

export type ObservationStaleReason =
  | ObservationFileRemovedReason
  | ObservationFileModifiedReason
  | ObservationSymbolRemovedReason
  | ObservationSymbolModifiedReason;

export interface ObservationStaleness {
  observationId: string;
  sourceRunId: number | null;
  comparisonRunId: number | null;
  status: StaleStateStatus;
  reasons: ObservationStaleReason[];
}

export const ObservationSearchSignalKind = Object.freeze({
  SummaryExact: "summary_exact",
  SummarySubstring: "summary_substring",
  BodySubstring: "body_substring",
  QueryTextSubstring: "query_text_substring",
  QueryTermOverlap: "query_term_overlap",
  LinkedFileOverlap: "linked_file_overlap",
  LinkedSymbolOverlap: "linked_symbol_overlap",
  LinkedFQNameOverlap: "linked_fq_name_overlap",
  SessionMatch: "session_match",
  StalePenalty: "stale_penalty",
});

export type ObservationSearchSignalKind =
  (typeof ObservationSearchSignalKind)[keyof typeof ObservationSearchSignalKind];

export interface ObservationSearchSignal {
  kind: ObservationSearchSignalKind;
  scoreContribution: number;
  field?: "summary" | "body" | "query_text" | "linked_file_paths" | "linked_symbols" | "linked_fq_names" | "session_id";
  matchedValues: string[];
}

export interface ObservationSearchResult {
  observation: Observation;
  staleness: ObservationStaleness;
  score: number;
  signals: ObservationSearchSignal[];
}

export interface SessionObservationKindCounts {
  decision: number;
  insight: number;
  warning: number;
  deadEnd: number;
  toolCall: number;
}

export interface SessionSummaryQueryTermCount {
  term: string;
  count: number;
}

export interface SessionSummary {
  observationCount: number;
  lastObservationAtMs: number | null;
  freshObservationCount: number;
  staleObservationCount: number;
  kindCounts: SessionObservationKindCounts;
  recentFilePaths: string[];
  recentSymbolIds: string[];
  recentFqNames: string[];
  repeatedQueryTerms: SessionSummaryQueryTermCount[];
}

export interface SessionListItem {
  sessionId: string;
  agentKind?: string;
  status: SessionStatus;
  startedAtMs: number;
  lastActivityAtMs: number;
  observationCount: number;
}

export interface SessionObservationPreview {
  observationId: string;
  kind: ObservationKind;
  summary: string;
  createdAtMs: number;
}

export interface ReadSessionResult {
  session: SessionRecord;
  summary: SessionSummary;
  recentObservations: SessionObservationPreview[];
}

export interface SessionContextResult {
  sessionId: string | null;
  session: SessionRecord | null;
  summary: SessionSummary | null;
  observations: Observation[];
  rankedObservations?: Observation[];
}
