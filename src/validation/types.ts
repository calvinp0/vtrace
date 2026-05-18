import type { CapsuleContentMode, CapsuleItemRole } from "../capsule/types";
import type { Language, SymbolKind } from "../domain/types";
import type { HandoffPayload } from "../handoff/types";
import type { QueryIntent } from "../intent/types";
import type { StaleStateStatus, FileChangeType } from "../memory/types";
import type { SymbolSearchMatchField } from "../retrieval/types";

export enum ValidationStatus {
  Pass = "pass",
  Fail = "fail",
  Skipped = "skipped",
}

export enum ValidationFindingSeverity {
  Error = "error",
  Warning = "warning",
  Info = "info",
}

export enum ValidationGapCategory {
  ParserFrontendGap = "parser/frontend gap",
  RetrievalRerankingGap = "retrieval/reranking gap",
  CapsuleShapingGap = "capsule shaping gap",
  AcceptedLimitation = "accepted limitation",
}

export enum ValidationQueryCategory {
  ExactSymbolApiLookup = "exact_symbol_api_lookup",
  WorkflowTracing = "workflow_tracing",
  ScientificDomainConcept = "scientific_domain_concept",
  PythonCythonBoundary = "python_cython_boundary",
  FileModuleDiscovery = "file_module_discovery",
  AmbiguousStress = "ambiguous_stress",
  Custom = "custom",
}

export type RC1ReadinessRecommendation =
  | "ready"
  | "ready with known limitations"
  | "not ready";

export interface ValidationQueryDefinition {
  readonly query: string;
  readonly category: ValidationQueryCategory;
  readonly sectionTitle: string;
}

export interface RealRepoValidationOptions {
  readonly repoRoot: string;
  readonly queries?: readonly string[] | readonly ValidationQueryDefinition[];
  readonly queriesFilePath?: string;
  readonly interestingSymbols?: readonly string[];
  readonly interestingFiles?: readonly string[];
  readonly maxResults?: number;
  readonly maxBudgetCharacters?: number;
  readonly enableControlledChange?: boolean;
  readonly controlledChange?: ControlledChangePlan;
}

export interface ControlledChangePlan {
  readonly targetFilePath?: string;
  readonly query?: string;
  readonly prefixText?: string;
}

export interface ValidationAreaResult {
  readonly status: ValidationStatus;
  readonly summary: string;
}

export interface ValidationCandidateSummary {
  readonly symbolId: string;
  readonly filePath: string;
  readonly fqName: string;
  readonly localName: string;
  readonly kind: SymbolKind;
  readonly language?: Language;
  readonly likelyTestCandidate: boolean;
  readonly lexicalScore: number;
  readonly graphScore: number;
  readonly finalScore: number;
  readonly matchedFields: readonly SymbolSearchMatchField[];
}

export interface ValidationCapsuleItemSummary {
  readonly localName: string;
  readonly filePath: string;
  readonly fqName: string;
  readonly role: CapsuleItemRole;
  readonly contentMode: CapsuleContentMode;
  readonly sourceBacked: boolean;
}

export interface ValidationCapsuleSummary {
  readonly built: boolean;
  readonly pivotCount: number;
  readonly supportCount: number;
  readonly sourceBackedPivotCount: number;
  readonly truncated: boolean;
  readonly compressed: boolean;
  readonly items: readonly ValidationCapsuleItemSummary[];
}

export interface ValidationHandoffSummary {
  readonly built: boolean;
  readonly itemCount: number;
  readonly selectedIntent: QueryIntent;
  readonly schemaName: HandoffPayload["schema"]["name"];
  readonly schemaVersion: HandoffPayload["schema"]["version"];
  readonly trustStatus: StaleStateStatus | null;
}

export interface ValidationSurfaceReview {
  readonly expectedSurfaceObserved: boolean | null;
  readonly interestingMatches: readonly string[];
}

export interface ValidationBoundaryBenchmark {
  readonly anyCythonCandidate: boolean;
  readonly firstCythonCandidateRank: number | null;
  readonly baselineAnyCythonCandidate: boolean;
  readonly baselineFirstCythonCandidateRank: number | null;
  readonly improvedAgainstBaseline: boolean;
  readonly regressedAgainstBaseline: boolean;
}

export interface ValidationBroadBenchmark {
  readonly baselineHasCandidates: boolean;
  readonly baselineExpectedSurfaceObserved: boolean | null;
  readonly improvedAgainstBaseline: boolean;
  readonly regressedAgainstBaseline: boolean;
}

export interface ValidationTestAwareBenchmark {
  readonly baselineTopCandidateLikelyTest: boolean;
  readonly currentTopCandidateLikelyTest: boolean;
  readonly baselineFirstNonTestCandidateRank: number | null;
  readonly firstNonTestCandidateRank: number | null;
  readonly improvedAgainstBaseline: boolean;
  readonly regressedAgainstBaseline: boolean;
}

export interface ValidationNarrowBenchmark {
  readonly baselineHasCandidates: boolean;
  readonly baselineExpectedSurfaceObserved: boolean | null;
  readonly baselineFirstCythonCandidateRank: number | null;
  readonly baselineTopCandidateLikelyTest: boolean;
  readonly baselineTopCandidateMatchedFields: readonly SymbolSearchMatchField[];
  readonly improvedAgainstBaseline: boolean;
  readonly regressedAgainstBaseline: boolean;
}

export interface ValidationQueryResult {
  readonly query: string;
  readonly category: ValidationQueryCategory;
  readonly sectionTitle: string;
  readonly intent: QueryIntent;
  readonly routingProfileId: string;
  readonly hasCandidates: boolean;
  readonly pythonCandidateCount: number;
  readonly cythonCandidateCount: number;
  readonly rerankedResults: readonly ValidationCandidateSummary[];
  readonly graphOrderingDeterministic: boolean;
  readonly capsuleDeterministic: boolean;
  readonly handoffDeterministic: boolean;
  readonly surfaceReview: ValidationSurfaceReview;
  readonly boundaryBenchmark?: ValidationBoundaryBenchmark;
  readonly broadBenchmark?: ValidationBroadBenchmark;
  readonly testAwareBenchmark?: ValidationTestAwareBenchmark;
  readonly narrowBenchmark?: ValidationNarrowBenchmark;
  readonly capsule: ValidationCapsuleSummary;
  readonly handoff: ValidationHandoffSummary;
}

export interface ValidationFinding {
  readonly code: string;
  readonly severity: ValidationFindingSeverity;
  readonly summary: string;
  readonly query?: string;
  readonly details?: Record<string, unknown>;
}

export interface ClassifiedValidationGap {
  readonly category: ValidationGapCategory;
  readonly findingCode: string;
  readonly severity: ValidationFindingSeverity;
  readonly summary: string;
  readonly query?: string;
  readonly rationale: string;
  readonly details?: Record<string, unknown>;
}

export interface ControlledChangeValidationSummary {
  readonly status: ValidationStatus;
  readonly usedTemporaryCopy: boolean;
  readonly sourceRepoMutated: boolean;
  readonly targetFilePath?: string;
  readonly query?: string;
  readonly fileChangeCounts?: {
    readonly added: number;
    readonly removed: number;
    readonly modified: number;
    readonly unchanged: number;
  };
  readonly symbolChangeCounts?: {
    readonly added: number;
    readonly removed: number;
    readonly modified: number;
    readonly unchanged: number;
  };
  readonly modifiedFilePaths?: readonly string[];
  readonly modifiedSymbols?: readonly Array<{
    readonly filePath: string;
    readonly fqName: string;
    readonly kind: SymbolKind;
    readonly changeType: FileChangeType;
  }>;
  readonly capsuleTrustStatus?: StaleStateStatus;
}

export interface RealRepoValidationSummaryCounts {
  readonly indexedFileCount: number;
  readonly indexedPythonFileCount: number;
  readonly indexedCythonFileCount: number;
  readonly indexedSymbolCount: number;
  readonly indexedPythonSymbolCount: number;
  readonly indexedCythonSymbolCount: number;
  readonly indexedEdgeCount: number;
  readonly parseFailureCount: number;
  readonly readFailureCount: number;
  readonly persistenceFailureCount: number;
  readonly queryCount: number;
  readonly queriesWithCandidates: number;
  readonly queriesWithCapsules: number;
  readonly queriesWithSourceBackedPivots: number;
  readonly exactQueriesWithExpectedSurface: number;
  readonly exactQueriesImprovedAgainstBaseline: number;
  readonly exactQueriesRegressedAgainstBaseline: number;
  readonly narrowQueriesImprovedAgainstBaseline: number;
  readonly narrowQueriesRegressedAgainstBaseline: number;
  readonly boundaryQueriesWithCythonCandidates: number;
  readonly boundaryQueriesImprovedAgainstBaseline: number;
  readonly boundaryQueriesRegressedAgainstBaseline: number;
  readonly broadQueriesImprovedAgainstBaseline: number;
  readonly broadQueriesRegressedAgainstBaseline: number;
  readonly broadQueriesWithLikelyTestTopCandidate: number;
  readonly broadQueriesTestMisrankingImprovedAgainstBaseline: number;
  readonly broadQueriesTestMisrankingRegressedAgainstBaseline: number;
}

export interface RealRepoValidationReport {
  readonly schemaVersion: "1.0.0";
  readonly repoRoot: string;
  readonly validationRunId: string;
  readonly querySetSource: string | null;
  readonly queries: readonly ValidationQueryDefinition[];
  readonly interestingSymbols: readonly string[];
  readonly interestingFiles: readonly string[];
  readonly summaryCounts: RealRepoValidationSummaryCounts;
  readonly areaResults: {
    readonly indexingAndPersistence: ValidationAreaResult;
    readonly representativePythonQueries: ValidationAreaResult;
    readonly representativeCythonQueries: ValidationAreaResult;
    readonly graphAwareReranking: ValidationAreaResult;
    readonly capsuleAssembly: ValidationAreaResult;
    readonly sourceBackedCapsuleBehavior: ValidationAreaResult;
    readonly controlledChange: ValidationAreaResult;
    readonly handoffPayloadGeneration: ValidationAreaResult;
    readonly determinism: ValidationAreaResult;
  };
  readonly queryResults: readonly ValidationQueryResult[];
  readonly controlledChange: ControlledChangeValidationSummary;
  readonly topFindings: readonly ValidationFinding[];
  readonly classifiedGaps: readonly ClassifiedValidationGap[];
  readonly rc1ReadinessRecommendation: RC1ReadinessRecommendation;
}
