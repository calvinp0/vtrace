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

export const OBSERVATION_PROVENANCE_SCHEMA_VERSION = 1 as const;

export const ObservationScope = Object.freeze({
  Global: "global",
  Repository: "repository",
  Worktree: "worktree",
  SourceState: "source_state",
  IndexState: "index_state",
});

export type ObservationScope =
  (typeof ObservationScope)[keyof typeof ObservationScope];

export const ObservationOrigin = Object.freeze({
  Manual: "manual",
  ToolDerived: "tool_derived",
  AutomaticCapture: "automatic_capture",
  Benchmark: "benchmark",
  Migration: "migration",
});

export type ObservationOrigin =
  (typeof ObservationOrigin)[keyof typeof ObservationOrigin];

export interface ObservationRepositoryProvenance {
  readonly repositoryId: string;
  readonly worktreeId: string;
  readonly worktreeRoot: string;
  readonly headCommit: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly dirtyFingerprint: string | null;
}

export interface ObservationIndexProvenance {
  readonly identity: string;
  readonly runId: number | string | null;
  readonly worktreeId: string;
  readonly headCommit: string | null;
  readonly dirtyFingerprint: string | null;
  readonly formatVersion: number;
  readonly schemaVersion: string;
  readonly indexerFingerprint: string;
  readonly parserFingerprint: string;
  readonly configFingerprint: string;
}

export interface ObservationImplementationProvenance {
  readonly commit: string | null;
  readonly tree: string | null;
  readonly dirtyFingerprint: string | null;
  readonly memoryCapabilityFingerprint: string;
}

export interface ObservationToolProvenance {
  readonly name: string;
  readonly normalizedQuery: string | null;
  readonly semanticOptions: Readonly<Record<string, unknown>>;
  readonly capabilityFingerprint: string;
}

export interface TechnicalObservationSummary {
  readonly kind: string;
  readonly values: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ObservationProvenance {
  readonly schemaVersion: typeof OBSERVATION_PROVENANCE_SCHEMA_VERSION;
  readonly repository: ObservationRepositoryProvenance;
  readonly index: ObservationIndexProvenance | null;
  readonly implementation: ObservationImplementationProvenance;
  readonly tool: ObservationToolProvenance | null;
  readonly resultSemanticHash: string | null;
  readonly resultSummary: TechnicalObservationSummary | null;
}

export const ObservationCompatibilityState = Object.freeze({
  Applicable: "applicable",
  Current: "current",
  CurrentCompatible: "current_compatible",
  StaleRepoState: "stale_repo_state",
  StaleDirtyState: "stale_dirty_state",
  StaleWorktree: "stale_worktree",
  StaleIndex: "stale_index",
  SupersededImplementation: "superseded_implementation",
  ForeignRepository: "foreign_repository",
  ForeignContext: "foreign_context",
  Historical: "historical",
  ProvenanceIncomplete: "provenance_incomplete",
});

export type ObservationCompatibilityState =
  (typeof ObservationCompatibilityState)[keyof typeof ObservationCompatibilityState];

export const ObservationFreshnessReason = Object.freeze({
  Current: "current",
  GlobalScope: "global_scope",
  RepoMismatch: "repo_mismatch",
  WorktreeMismatch: "worktree_mismatch",
  HeadMismatch: "head_mismatch",
  DirtyFingerprintMismatch: "dirty_fingerprint_mismatch",
  IndexIdentityMismatch: "index_identity_mismatch",
  IndexCapabilityMismatch: "index_capability_mismatch",
  ImplementationChangedCompatible: "implementation_changed_compatible",
  ImplementationSemanticsMismatch: "implementation_semantics_mismatch",
  ToolSemanticsMismatch: "tool_semantics_mismatch",
  LegacyProvenanceMissing: "legacy_provenance_missing",
  UnsupportedProvenanceSchema: "unsupported_provenance_schema",
  ExplicitHistorical: "explicit_historical",
});

export type ObservationFreshnessReason =
  (typeof ObservationFreshnessReason)[keyof typeof ObservationFreshnessReason];

export interface ObservationCompatibility {
  readonly state: ObservationCompatibilityState;
  readonly currentTruthEligible: boolean;
  readonly reasons: readonly ObservationFreshnessReason[];
  readonly repoMatch: boolean | null;
  readonly worktreeMatch: boolean | null;
  readonly sourceStateMatch: boolean | null;
  readonly indexMatch: boolean | null;
  readonly implementationCompatible: boolean | null;
}

export interface CurrentObservationContext {
  readonly repository: ObservationRepositoryProvenance;
  readonly index: ObservationIndexProvenance | null;
  readonly implementation: ObservationImplementationProvenance;
  readonly toolCapabilityFingerprints: Readonly<Record<string, string>>;
}

export const SessionStatus = Object.freeze({
  Active: "active",
  Inactive: "inactive",
  Compressed: "compressed",
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
  compressedAtMs?: number;
  summaryId?: string;
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
  scope?: ObservationScope;
  origin?: ObservationOrigin;
  provenance?: ObservationProvenance;
  semanticKey?: string;
  resultSemanticHash?: string;
  supersedesObservationId?: string;
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
  compatibility?: ObservationCompatibility;
  score: number;
  signals: ObservationSearchSignal[];
}

export interface ObservationSearchAccounting {
  readonly matchedCurrent: number;
  readonly suppressedStale: number;
  readonly suppressedForeign: number;
  readonly provenanceIncomplete: number;
}

export interface ObservationConflict {
  readonly semanticKey: string;
  readonly observationIds: readonly string[];
  readonly resultSemanticHashes: readonly string[];
}

export interface ObservationSearchResponse {
  readonly results: readonly ObservationSearchResult[];
  readonly accounting: ObservationSearchAccounting;
  readonly conflicts: readonly ObservationConflict[];
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
  compressedAtMs?: number;
  summaryId?: string;
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
  compressedSummary: SessionCompressionSummary | null;
  recentObservations: SessionObservationPreview[];
}

export interface SessionContextResult {
  sessionId: string | null;
  session: SessionRecord | null;
  summary: SessionSummary | null;
  compressedSummary: SessionCompressionSummary | null;
  observations: Observation[];
  rankedObservations?: Observation[];
  compatibilityByObservationId?: Readonly<Record<string, ObservationCompatibility>>;
  suppressedObservationCount?: number;
}

export interface SessionCompressionSummary {
  id: string;
  sessionId: string;
  repoRoot: string;
  createdAtMs: number;
  firstActivityAtMs: number;
  lastActivityAtMs: number;
  compressedAtMs: number;
  observationCounts: Record<string, number>;
  toolCallCounts: Record<string, number>;
  filePaths: string[];
  symbolIds: string[];
  fqNames: string[];
  keyTerms: string[];
  preservedDurableObservationCount: number;
  prunedToolCallObservationCount: number;
  summaryObservationId: string;
}

export interface SessionCompressionEligibility {
  session: SessionRecord;
  eligible: boolean;
  inactiveForMs: number;
  thresholdMs: number;
}

export interface SessionCleanupCandidate {
  session: SessionRecord;
  compressedSummary: SessionCompressionSummary | null;
  eligibleForDeletion: boolean;
  compressedForMs: number;
  retentionMs: number;
}
