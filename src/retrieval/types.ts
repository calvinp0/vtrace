import type { EdgeType, SymbolId, SymbolKind } from "../domain/types";

export enum SymbolSearchBackend {
  PlainSql = "plain_sql",
  Fts = "fts",
}

export interface SearchSymbolsOptions {
  query: string;
  maxResults: number;
  kind?: SymbolKind;
  backend?: SymbolSearchBackend;
  enableBoundaryBoosts?: boolean;
  enableBroadQueryBoosts?: boolean;
  enableTestAwareDownweighting?: boolean;
  enableTechnicalQueryBoosts?: boolean;
  enablePathSignalBoosts?: boolean;
  /** Routed product mode: bounded compound decomposition and explicit path extraction. */
  enableCompoundTaskDecomposition?: boolean;
  /** Internal comparison switch; product retrieval keeps this enabled by default. */
  enableExactIdentifierLane?: boolean;
}

export enum SymbolSearchMatchField {
  LocalName = "local_name",
  FQName = "fq_name",
  Signature = "signature",
  Docstring = "docstring",
  FilePath = "file_path",
  QueryCoverage = "query_coverage",
  BoundaryHint = "boundary_hint",
  LikelyTestPenalty = "likely_test_penalty",
  TechnicalHint = "technical_hint",
  PathSegmentSignal = "path_segment_signal",
}

export interface RetrievalPathSignalDiagnostics {
  readonly pathSignalsConsidered: readonly string[];
  readonly pathSignalsMatched: readonly string[];
  readonly candidateFilesConsidered: number;
  readonly weakPathCoverage: boolean;
  readonly normalizedQuery: string;
  readonly queryVariants: readonly RetrievalQueryVariant[];
  readonly identifierTerms: readonly string[];
  readonly pathTerms: readonly string[];
  readonly ftsTerms: readonly string[];
  readonly laneResults: RetrievalLaneResults;
  /** Source-body-free repo-relative file paths observed in each retrieval lane. */
  readonly laneCandidateFiles: Readonly<Record<keyof Omit<RetrievalLaneResults, "graph">, readonly string[]>>;
  /** De-duplicated file membership of the complete pre-rerank candidate union. */
  readonly candidateUnionFiles: readonly string[];
  readonly preFilterCandidates: number;
  readonly rejectedByThreshold: number;
  readonly rejectedByScope: number;
  readonly graphExpansions: number;
  readonly fallbackAttempted: boolean;
  readonly fallbackReason?: string;
  readonly finalReason?: string;
  readonly timingsMs: RetrievalTimingDiagnostics;
}

export type RetrievalQueryVariantKind =
  | "identifier"
  | "path"
  | "phrase"
  | "semantic_terms"
  | "fallback";

export interface RetrievalQueryVariant {
  readonly kind: RetrievalQueryVariantKind;
  readonly query: string;
}

export interface RetrievalLaneResults {
  readonly path: number;
  readonly symbol: number;
  readonly lexical: number;
  readonly documentation: number;
  readonly tests: number;
  readonly graph: number;
}

export interface RetrievalTimingDiagnostics {
  readonly normalization: number;
  readonly laneSearch: number;
  readonly candidateMerge: number;
  readonly graphExpansion: number;
  readonly total: number;
}

export enum SymbolSearchMatchType {
  Exact = "exact",
  Prefix = "prefix",
  Substring = "substring",
}

export interface SymbolSearchMatch {
  field: SymbolSearchMatchField;
  matchType: SymbolSearchMatchType;
  scoreContribution: number;
}

export interface SymbolSearchResult {
  repoAlias?: string;
  symbolId: SymbolId;
  filePath: string;
  fqName: string;
  localName: string;
  kind: SymbolKind;
  score: number;
  matches: SymbolSearchMatch[];
}

export interface SearchSymbolsGraphOptions extends SearchSymbolsOptions {
  candidatePoolSize?: number;
}

export interface GraphRerankScoreWeights {
  readonly inDegreePerEdge: number;
  readonly inDegreeMax: number;
  readonly outDegreePerEdge: number;
  readonly outDegreeMax: number;
  readonly containsNeighbor: number;
  readonly containsNeighborMax: number;
  readonly importsNeighbor: number;
  readonly importsNeighborMax: number;
  readonly connectedMatchedCandidate: number;
  readonly connectedMatchedCandidateMax: number;
}

export enum GraphScoreSignal {
  InDegree = "in_degree",
  OutDegree = "out_degree",
  ContainsNeighborhood = "contains_neighborhood",
  ImportsNeighborhood = "imports_neighborhood",
  ConnectedMatchedCandidates = "connected_matched_candidates",
}

export interface GraphScoreContribution {
  signal: GraphScoreSignal;
  scoreContribution: number;
  count?: number;
  edgeType?: EdgeType;
  relatedSymbolIds?: SymbolId[];
}

export interface GraphSearchResult {
  repoAlias?: string;
  symbolId: SymbolId;
  filePath: string;
  fqName: string;
  localName: string;
  kind: SymbolKind;
  matches: SymbolSearchMatch[];
  lexicalScore: number;
  graphScore: number;
  finalScore: number;
  graphContributions: GraphScoreContribution[];
}
