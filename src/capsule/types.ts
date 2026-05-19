import type { CapsuleProfileSelectionResult } from "../capsuleProfiles/types";
import type { EdgeType, SymbolId, SymbolKind } from "../domain/types";
import type {
  ObservationKind,
  ObservationStaleReasonKind,
} from "../observations/types";
import type { GraphScoreSignal, SymbolSearchMatchField } from "../retrieval/types";
import type { SkeletonDetailLevel, SkeletonFileResult } from "../skeleton/getSkeleton";

export enum CapsuleItemRole {
  Pivot = "pivot",
  Support = "support",
}

export enum CapsuleContentMode {
  Full = "full",
  Skeleton = "skeleton",
  SignatureOnly = "signature_only",
  Summary = "summary",
  Stub = "stub",
}

export const CapsuleFileRepresentationMode = Object.freeze({
  FullSource: "full_source",
  Skeleton: "skeleton",
  Omit: "omit",
});

export type CapsuleFileRepresentationMode =
  (typeof CapsuleFileRepresentationMode)[keyof typeof CapsuleFileRepresentationMode];

export enum CapsuleBudgetModel {
  CharacterCount = "character_count",
}

export enum CapsuleInclusionReasonKind {
  LexicalMatch = "lexical_match",
  GraphConnection = "graph_connection",
  StructuralSupport = "structural_support",
  QueryCoverage = "query_coverage",
  BudgetCompression = "budget_compression",
}

export interface CapsuleBudget {
  model: CapsuleBudgetModel;
  maxCharacters: number;
}

export interface CapsuleBudgetUsage {
  model: CapsuleBudgetModel;
  maxCharacters: number;
  usedCharacters: number;
  remainingCharacters: number;
}

export interface CapsuleScoreMetadata {
  lexicalScore?: number;
  graphScore?: number;
  finalScore?: number;
}

export interface CapsuleProfileBudgetUsage {
  pivotCharactersUsed: number;
  supportCharactersUsed: number;
  pivotCharactersMax?: number;
  supportCharactersMax?: number;
}

export interface CapsuleLexicalInclusionReason {
  kind: CapsuleInclusionReasonKind.LexicalMatch;
  matchedFields: SymbolSearchMatchField[];
}

export interface CapsuleGraphInclusionReason {
  kind: CapsuleInclusionReasonKind.GraphConnection;
  graphSignals: GraphScoreSignal[];
  relatedSymbolIds?: SymbolId[];
}

export interface CapsuleStructuralSupportReason {
  kind: CapsuleInclusionReasonKind.StructuralSupport;
  edgeType: EdgeType;
  relatedSymbolIds: SymbolId[];
}

export interface CapsuleQueryCoverageReason {
  kind: CapsuleInclusionReasonKind.QueryCoverage;
  note: string;
}

export interface CapsuleBudgetCompressionReason {
  kind: CapsuleInclusionReasonKind.BudgetCompression;
  originalMode: CapsuleContentMode;
  appliedMode: CapsuleContentMode;
}

export type CapsuleInclusionReason =
  | CapsuleLexicalInclusionReason
  | CapsuleGraphInclusionReason
  | CapsuleStructuralSupportReason
  | CapsuleQueryCoverageReason
  | CapsuleBudgetCompressionReason;

export interface CapsuleFullContent {
  mode: CapsuleContentMode.Full;
  source: string;
}

export interface CapsuleSkeletonContent {
  mode: CapsuleContentMode.Skeleton;
  detail: SkeletonDetailLevel;
  file: SkeletonFileResult;
}

export interface CapsuleSignatureOnlyContent {
  mode: CapsuleContentMode.SignatureOnly;
  signature: string;
}

export interface CapsuleSummaryContent {
  mode: CapsuleContentMode.Summary;
  summary: string;
  signature?: string;
}

export interface CapsuleStubContent {
  mode: CapsuleContentMode.Stub;
  stub: string;
}

export type CapsuleItemContent =
  | CapsuleFullContent
  | CapsuleSkeletonContent
  | CapsuleSignatureOnlyContent
  | CapsuleSummaryContent
  | CapsuleStubContent;

export const CapsuleMemoryInclusionReasonKind = Object.freeze({
  LinkedSymbolOverlap: "linked_symbol_overlap",
  LinkedFileOverlap: "linked_file_overlap",
  QueryTermOverlap: "query_term_overlap",
  IntentMatch: "intent_match",
});

export type CapsuleMemoryInclusionReasonKind =
  (typeof CapsuleMemoryInclusionReasonKind)[keyof typeof CapsuleMemoryInclusionReasonKind];

export interface CapsuleMemoryInclusionReason {
  kind: CapsuleMemoryInclusionReasonKind;
  matchedValues: string[];
}

export interface CapsuleMemoryItem {
  repoAlias?: string;
  observationId: string;
  kind: ObservationKind;
  headline: string;
  createdAtMs: number;
  isStale: boolean;
  staleReasons: ObservationStaleReasonKind[];
  inclusionReasons: CapsuleMemoryInclusionReason[];
}

export interface CapsuleRuleItem {
  repoAlias?: string;
  id: string;
  status: "active";
  summary: string;
  scope: {
    files: string[];
    symbolFqns: string[];
    terms: string[];
  };
  reason: string;
}

export interface CapsuleRulesSection {
  active: CapsuleRuleItem[];
}

export interface CapsuleItemBase extends CapsuleScoreMetadata {
  repoAlias?: string;
  symbolId: SymbolId;
  filePath: string;
  fqName: string;
  localName: string;
  kind: SymbolKind;
  inclusionReasons: CapsuleInclusionReason[];
  content: CapsuleItemContent;
  budgetCost: number;
  compressed: boolean;
  sourceBacked?: boolean;
}

export interface PivotCapsuleItem extends CapsuleItemBase {
  role: CapsuleItemRole.Pivot;
}

export interface SupportCapsuleItem extends CapsuleItemBase {
  role: CapsuleItemRole.Support;
}

export type CapsuleItem = PivotCapsuleItem | SupportCapsuleItem;

export interface CapsuleSupportingCandidate extends CapsuleScoreMetadata {
  repoAlias?: string;
  symbolId: SymbolId;
  filePath: string;
  fqName: string;
  localName: string;
  kind: SymbolKind;
  inclusionReasons: CapsuleInclusionReason[];
}

export interface Capsule {
  query: string;
  pivots: PivotCapsuleItem[];
  supportingItems: SupportCapsuleItem[];
  memories?: CapsuleMemoryItem[];
  rules?: CapsuleRulesSection;
  budget: CapsuleBudgetUsage;
  truncated: boolean;
  compressed: boolean;
  profileSelection?: CapsuleProfileSelectionResult;
  profileBudgetUsage?: CapsuleProfileBudgetUsage;
}

export function isCompressedCapsuleContentMode(mode: CapsuleContentMode): boolean {
  return mode !== CapsuleContentMode.Full;
}
