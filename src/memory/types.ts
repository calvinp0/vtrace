import type {
  FileId,
  FilePath,
  FullyQualifiedName,
  Language,
  SymbolId,
  SymbolKind,
} from "../domain/types";
import type { CapsuleContentMode, CapsuleItemRole } from "../capsule/types";

export enum FileChangeType {
  Added = "added",
  Removed = "removed",
  Modified = "modified",
  Unchanged = "unchanged",
}

export interface IndexRunRecord {
  id: number;
  previousRunId?: number;
  createdAtMs: number;
}

export interface FileRunState {
  runId: number;
  fileId: FileId;
  path: FilePath;
  language: Language;
  contentHash: string;
  sizeBytes: number;
}

export interface FileRunStateSummary {
  fileId: FileId;
  path: FilePath;
  language: Language;
  contentHash: string;
  sizeBytes: number;
}

export interface FileRunDiff {
  runId: number;
  previousRunId?: number;
  filePath: FilePath;
  changeType: FileChangeType;
  previousState?: FileRunStateSummary;
  currentState?: FileRunStateSummary;
}

export interface FileChangeCounts {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
}

export interface SymbolRunIdentitySummary {
  filePath: FilePath;
  fqName: FullyQualifiedName;
  kind: SymbolKind;
}

export interface SymbolRunState {
  runId: number;
  symbolId: SymbolId;
  filePath: FilePath;
  fqName: FullyQualifiedName;
  localName: string;
  kind: SymbolKind;
  signature: string;
  exported: boolean;
  parentIdentity?: SymbolRunIdentitySummary;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
}

export interface SymbolRunStateSummary {
  symbolId: SymbolId;
  filePath: FilePath;
  fqName: FullyQualifiedName;
  localName: string;
  kind: SymbolKind;
  signature: string;
  exported: boolean;
  parentIdentity?: SymbolRunIdentitySummary;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
}

export interface SymbolRunDiff {
  runId: number;
  previousRunId?: number;
  filePath: FilePath;
  fqName: FullyQualifiedName;
  symbolKind: SymbolKind;
  changeType: FileChangeType;
  previousState?: SymbolRunStateSummary;
  currentState?: SymbolRunStateSummary;
}

export interface SymbolChangeCounts {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
}

export interface CapsuleManifestRecord {
  id: string;
  sourceRunId: number;
  query: string;
  createdAtMs: number;
}

export interface CapsuleManifestItemRecord {
  capsuleId: string;
  itemOrdinal: number;
  symbolId: SymbolId;
  filePath: FilePath;
  fqName: FullyQualifiedName;
  symbolKind: SymbolKind;
  role: CapsuleItemRole;
  contentMode: CapsuleContentMode;
  sourceBacked: boolean;
}

export interface CapsuleManifest extends CapsuleManifestRecord {
  items: CapsuleManifestItemRecord[];
}

export enum StaleStateStatus {
  Fresh = "fresh",
  Stale = "stale",
}

export enum CapsuleStaleReasonKind {
  FileRemoved = "file_removed",
  FileModifiedSourceBacked = "file_modified_source_backed",
  SymbolRemoved = "symbol_removed",
  SymbolModified = "symbol_modified",
}

interface CapsuleStaleReasonBase {
  kind: CapsuleStaleReasonKind;
  detectedInRunId: number;
}

export interface CapsuleFileRemovedReason extends CapsuleStaleReasonBase {
  kind: CapsuleStaleReasonKind.FileRemoved;
  filePath: FilePath;
}

export interface CapsuleFileModifiedSourceBackedReason extends CapsuleStaleReasonBase {
  kind: CapsuleStaleReasonKind.FileModifiedSourceBacked;
  filePath: FilePath;
}

export interface CapsuleSymbolRemovedReason extends CapsuleStaleReasonBase {
  kind: CapsuleStaleReasonKind.SymbolRemoved;
  symbol: SymbolRunIdentitySummary;
}

export interface CapsuleSymbolModifiedReason extends CapsuleStaleReasonBase {
  kind: CapsuleStaleReasonKind.SymbolModified;
  symbol: SymbolRunIdentitySummary;
}

export type CapsuleItemStaleReason =
  | CapsuleFileRemovedReason
  | CapsuleFileModifiedSourceBackedReason
  | CapsuleSymbolRemovedReason
  | CapsuleSymbolModifiedReason;

export interface CapsuleItemStaleness {
  capsuleId: string;
  itemOrdinal: number;
  role: CapsuleItemRole;
  contentMode: CapsuleContentMode;
  sourceBacked: boolean;
  filePath: FilePath;
  symbol: SymbolRunIdentitySummary;
  status: StaleStateStatus;
  reasons: CapsuleItemStaleReason[];
}

export interface CapsuleStalenessComparisonStep {
  runId: number;
  fileDiffs: FileRunDiff[];
  symbolDiffs: SymbolRunDiff[];
}

export interface CapsuleStalenessResult {
  capsuleId: string;
  sourceRunId: number;
  comparisonRunId: number;
  query: string;
  status: StaleStateStatus;
  items: CapsuleItemStaleness[];
}

export interface IndexRunSummary extends IndexRunRecord {
  totalFiles: number;
  totalSymbols: number;
  fileChangeCounts: FileChangeCounts;
  symbolChangeCounts: SymbolChangeCounts;
}
