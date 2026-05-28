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
