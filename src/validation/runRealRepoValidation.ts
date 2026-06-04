// @ts-nocheck
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { buildCapsule, createSourceBackedCapsuleBuilder } from "../capsule/buildCapsule";
import { createCharacterBudget } from "../capsule/budget";
import {
  CapsuleInclusionReasonKind,
  type CapsuleInclusionReason,
  type CapsuleSupportingCandidate,
} from "../capsule/types";
import { prepareCapsuleAssembly } from "../capsuleProfiles/orchestrator";
import {
  getCapsuleStaleness,
  persistCapsuleManifest,
} from "../db/repositories/capsuleManifestsRepository";
import { listAllEdges } from "../db/repositories/edgesRepository";
import { getImpactGraph } from "../impact/getImpactGraph";
import { searchLogicFlow } from "../logicFlow/searchLogicFlow";
import {
  getIndexRunSummary,
  getLatestIndexRun,
  listFileDiffsForRun,
  listSymbolDiffsForRun,
} from "../db/repositories/indexRunsRepository";
import { listAllSymbols, listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { EdgeType, Language, type EdgeRecord, type SymbolRecord } from "../domain/types";
import { detectLanguage } from "../fs/languageDetection";
import { buildHandoffPayload, deterministicHandoffBuilder } from "../handoff/buildHandoff";
import type { IntentAwareCapsulePipelineResult } from "../handoff/types";
import { indexProject } from "../indexer/indexProject";
import { routeQuery } from "../intent/routeQuery";
import {
  FileChangeType,
  type CapsuleStalenessResult,
  type FileRunDiff,
  type IndexRunSummary,
  type SymbolRunDiff,
} from "../memory/types";
import {
  SymbolSearchMatchField,
  SymbolSearchMatchType,
  type GraphSearchResult,
} from "../retrieval/types";
import {
  isLikelyTestCandidate,
  resolveBroadQueryContext,
  resolveTechnicalQueryContext,
} from "../retrieval/searchSymbolsShared";
import { classifyGaps } from "./classifyGaps";
import {
  type ControlledChangePlan,
  type ControlledChangeValidationSummary,
  type RC1ReadinessRecommendation,
  type RealRepoValidationOptions,
  type RealRepoValidationReport,
  type RealRepoValidationSummaryCounts,
  type ValidationCandidateSummary,
  ValidationFindingSeverity,
  type ValidationFinding,
  type ValidationQueryDefinition,
  ValidationQueryCategory,
  type ValidationQueryResult,
  type ValidationStatus,
  ValidationStatus as ValidationStatusEnum,
  type ValidationStructuralEvidence,
  type ValidationImpactProbe,
  type ValidationLogicFlowProbe,
  type LogicFlowProbeDefinition,
} from "./types";

const DEFAULT_QUERY_FILE_PATH = fileURLToPath(
  new URL("../../docs/rc1_real_repo_validation_queries.md", import.meta.url),
);
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MAX_BUDGET_CHARACTERS = 2_000;
const DEFAULT_CONTROLLED_CHANGE_PREFIX = "# vtrace rc1 validation controlled change\n";
const DEFAULT_SCHEMA_VERSION = "1.0.0" as const;

interface ResolvedQuerySet {
  queries: ValidationQueryDefinition[];
  querySetSource: string | null;
}

interface QueryEvaluationResult {
  result: ValidationQueryResult;
  findings: ValidationFinding[];
}

interface BuiltCapsulePipeline {
  selection: ReturnType<typeof prepareCapsuleAssembly>["selection"];
  capsule: ReturnType<typeof buildCapsule>;
}

export async function runRealRepoValidation(
  options: RealRepoValidationOptions,
): Promise<RealRepoValidationReport> {
  const repoRoot = path.resolve(options.repoRoot);
  await assertDirectoryExists(repoRoot);

  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxBudgetCharacters = options.maxBudgetCharacters ?? DEFAULT_MAX_BUDGET_CHARACTERS;
  const interestingSymbols = normalizeList(options.interestingSymbols);
  const interestingFiles = normalizePathList(options.interestingFiles);
  const querySet = await resolveValidationQueries(options);
  const validationRunId = computeValidationRunId({
    repoRoot,
    queries: querySet.queries,
    interestingSymbols,
    interestingFiles,
    maxResults,
    maxBudgetCharacters,
    controlledChange: options.enableControlledChange !== false,
  });
  const db = openIndexerDatabase();

  try {
    const firstIndex = await indexProject({ repoRoot, db });
    const firstSnapshot = snapshotValidationState(db);
    const secondIndex = await indexProject({ repoRoot, db });
    const secondSnapshot = snapshotValidationState(db);
    const latestRun = getLatestIndexRun(db);
    const latestRunSummary = latestRun === undefined ? undefined : getIndexRunSummary(db, latestRun.id);
    const allSymbols = listAllSymbols(db);
    const allEdges = listAllEdges(db);
    const indexingDeterministic = isDeepStrictEqual(firstIndex, secondIndex)
      && isDeepStrictEqual(firstSnapshot, secondSnapshot);
    const findings: ValidationFinding[] = [];

    addIndexingFindings(findings, secondIndex, allSymbols, latestRunSummary);

    const queryResults: ValidationQueryResult[] = [];

    for (const queryDefinition of querySet.queries) {
      const evaluation = evaluateQuery({
        db,
        repoRoot,
        queryDefinition,
        maxResults,
        maxBudgetCharacters,
        latestRunId: latestRun?.id ?? null,
        interestingSymbols,
        interestingFiles,
      });
      queryResults.push(evaluation.result);
      findings.push(...evaluation.findings);
    }

    addAggregatedQueryFindings(findings, queryResults, secondIndex);

    const controlledChange = options.enableControlledChange === false
      ? makeSkippedControlledChangeSummary("Controlled-change validation disabled by options.")
      : await runControlledChangeValidation({
        repoRoot,
        db,
        queryResults,
        plan: options.controlledChange,
        maxBudgetCharacters,
      });
    findings.push(...collectControlledChangeFindings(controlledChange));

    const summaryCounts = summarizeCounts({
      indexResult: secondIndex,
      symbols: allSymbols,
      edges: allEdges,
      queryResults,
    });
    const structuralEvidence = summarizeStructuralEvidence({
      db,
      symbols: allSymbols,
      edges: allEdges,
      impactProbeSymbols: normalizeList(options.impactProbeSymbols),
      logicFlowProbes: normalizeLogicFlowProbes(options.logicFlowProbes),
    });
    addStructuralFindings(findings, structuralEvidence);
    const areaResults = summarizeAreaResults({
      indexResult: secondIndex,
      summaryCounts,
      queryResults,
      indexingDeterministic,
      controlledChange,
    });
    const sortedFindings = [...findings].sort(compareValidationFindings);
    const topFindings = sortedFindings.slice(0, 10);
    const classifiedGaps = classifyGaps(sortedFindings);
    const rc1ReadinessRecommendation = recommendRc1Readiness({
      areaResults,
      findings: sortedFindings,
    });

    return {
      schemaVersion: DEFAULT_SCHEMA_VERSION,
      repoRoot,
      validationRunId,
      querySetSource: querySet.querySetSource,
      queries: querySet.queries,
      interestingSymbols,
      interestingFiles,
      summaryCounts,
      structuralEvidence,
      areaResults,
      queryResults,
      controlledChange,
      topFindings,
      classifiedGaps,
      rc1ReadinessRecommendation,
    };
  } finally {
    db.close();
  }
}

function evaluateQuery(input: {
  db: ReturnType<typeof openIndexerDatabase>;
  repoRoot: string;
  queryDefinition: ValidationQueryDefinition;
  maxResults: number;
  maxBudgetCharacters: number;
  latestRunId: number | null;
  interestingSymbols: readonly string[];
  interestingFiles: readonly string[];
}): QueryEvaluationResult {
  const routedFirst = routeQuery(input.db, input.queryDefinition.query, {
    maxResults: input.maxResults,
  });
  const routedSecond = routeQuery(input.db, input.queryDefinition.query, {
    maxResults: input.maxResults,
  });
  const baselineBoundaryRoute = input.queryDefinition.category === ValidationQueryCategory.PythonCythonBoundary
    ? routeQuery(input.db, input.queryDefinition.query, {
      maxResults: input.maxResults,
      enableBoundaryBoosts: false,
    })
    : undefined;
  const baselineBroadRoute = shouldBenchmarkBroadQuery(input.queryDefinition.category)
    ? routeQuery(input.db, input.queryDefinition.query, {
      maxResults: input.maxResults,
      enableBroadQueryBoosts: false,
    })
    : undefined;
  const baselineTestAwareRoute = isBroadBenchmarkCategory(input.queryDefinition.category)
    ? routeQuery(input.db, input.queryDefinition.query, {
      maxResults: input.maxResults,
      enableTestAwareDownweighting: false,
    })
    : undefined;
  const baselineNarrowRoute = shouldBenchmarkNarrowQuery(input.queryDefinition)
    ? routeQuery(input.db, input.queryDefinition.query, {
      maxResults: input.maxResults,
      enableBoundaryBoosts: false,
      enableBroadQueryBoosts: false,
      enableTechnicalQueryBoosts: false,
    })
    : undefined;
  const graphOrderingDeterministic = isDeepStrictEqual(routedFirst, routedSecond);
  const firstPipeline = buildCapsulePipeline({
    db: input.db,
    repoRoot: input.repoRoot,
    query: input.queryDefinition.query,
    routedQuery: routedFirst,
    maxBudgetCharacters: input.maxBudgetCharacters,
  });
  const secondPipeline = buildCapsulePipeline({
    db: input.db,
    repoRoot: input.repoRoot,
    query: input.queryDefinition.query,
    routedQuery: routedFirst,
    maxBudgetCharacters: input.maxBudgetCharacters,
  });
  const capsuleDeterministic = isDeepStrictEqual(firstPipeline, secondPipeline);
  const handoffFirst = buildValidationHandoff({
    repoRoot: input.repoRoot,
    latestRunId: input.latestRunId,
    pipeline: {
      routedQuery: routedFirst,
      capsuleProfileSelection: firstPipeline.selection,
      capsule: firstPipeline.capsule,
    },
  });
  const handoffSecond = buildValidationHandoff({
    repoRoot: input.repoRoot,
    latestRunId: input.latestRunId,
    pipeline: {
      routedQuery: routedFirst,
      capsuleProfileSelection: firstPipeline.selection,
      capsule: firstPipeline.capsule,
    },
  });
  const handoffDeterministic = isDeepStrictEqual(handoffFirst, handoffSecond);
  const rerankedResults = routedFirst.rerankedResults.map(summarizeCandidate);
  const pythonCandidateCount = rerankedResults.filter((result) => result.language === Language.Python).length;
  const cythonCandidateCount = rerankedResults.filter((result) => result.language === Language.Cython).length;
  const surfaceReview = summarizeSurfaceReview({
    queryDefinition: input.queryDefinition,
    results: rerankedResults,
    interestingSymbols: input.interestingSymbols,
    interestingFiles: input.interestingFiles,
  });
  const baselineSurfaceReview = baselineBroadRoute === undefined
    ? undefined
    : summarizeSurfaceReview({
      queryDefinition: input.queryDefinition,
      results: baselineBroadRoute.rerankedResults.map(summarizeCandidate),
      interestingSymbols: input.interestingSymbols,
      interestingFiles: input.interestingFiles,
    });
  const baselineNarrowSurfaceReview = baselineNarrowRoute === undefined
    ? undefined
    : summarizeSurfaceReview({
      queryDefinition: input.queryDefinition,
      results: baselineNarrowRoute.rerankedResults.map(summarizeCandidate),
      interestingSymbols: input.interestingSymbols,
      interestingFiles: input.interestingFiles,
    });
  const capsuleSummary = summarizeCapsule(firstPipeline.capsule);
  const handoffSummary = summarizeHandoff(handoffFirst);
  const boundaryBenchmark = summarizeBoundaryBenchmark(
    input.queryDefinition.category,
    rerankedResults,
    baselineBoundaryRoute?.rerankedResults.map(summarizeCandidate),
  );
  const broadBenchmark = summarizeBroadBenchmark(
    input.queryDefinition.category,
    rerankedResults,
    surfaceReview,
    baselineBroadRoute?.rerankedResults.map(summarizeCandidate),
    baselineSurfaceReview,
  );
  const testAwareBenchmark = summarizeTestAwareBenchmark(
    input.queryDefinition.category,
    rerankedResults,
    baselineTestAwareRoute?.rerankedResults.map(summarizeCandidate),
  );
  const narrowBenchmark = summarizeNarrowBenchmark(
    input.queryDefinition,
    rerankedResults,
    surfaceReview,
    baselineNarrowRoute?.rerankedResults.map(summarizeCandidate),
    baselineNarrowSurfaceReview,
  );
  const findings: ValidationFinding[] = [];

  if (!graphOrderingDeterministic) {
    findings.push({
      code: "reranking.query_nondeterministic",
      severity: ValidationFindingSeverity.Error,
      summary: "Graph-aware reranking was not deterministic across repeated identical query runs.",
      query: input.queryDefinition.query,
    });
  }

  if (!capsuleDeterministic) {
    findings.push({
      code: "capsule.query_nondeterministic",
      severity: ValidationFindingSeverity.Error,
      summary: "Capsule assembly was not deterministic across repeated identical query runs.",
      query: input.queryDefinition.query,
    });
  }

  if (!handoffDeterministic) {
    findings.push({
      code: "handoff.query_nondeterministic",
      severity: ValidationFindingSeverity.Error,
      summary: "Handoff generation was not deterministic across repeated identical query runs.",
      query: input.queryDefinition.query,
    });
  }

  if (rerankedResults.length === 0) {
    findings.push({
      code: "retrieval.query_returned_no_candidates",
      severity: queryNoCandidateSeverity(input.queryDefinition.category),
      summary: "No reranked candidates were produced for a validation query.",
      query: input.queryDefinition.query,
      details: {
        category: input.queryDefinition.category,
        sectionTitle: input.queryDefinition.sectionTitle,
      },
    });
  }

  if (
    rerankedResults.length > 0
    &&
    input.queryDefinition.category === ValidationQueryCategory.ExactSymbolApiLookup
    && surfaceReview.expectedSurfaceObserved === false
  ) {
    findings.push({
      code: "retrieval.exact_query_expected_surface_missing",
      severity: ValidationFindingSeverity.Warning,
      summary: "An exact-symbol validation query did not surface the expected name or area in the top reranked results.",
      query: input.queryDefinition.query,
      details: {
        topResultLocalNames: rerankedResults.map((result) => result.localName),
      },
    });
  }

  if (
    rerankedResults.length > 0
    && capsuleSummary.pivotCount + capsuleSummary.supportCount === 0
  ) {
    findings.push({
      code: "capsule.empty_capsule_with_candidates",
      severity: ValidationFindingSeverity.Warning,
      summary: "Capsule assembly returned no items even though retrieval produced candidates.",
      query: input.queryDefinition.query,
    });
  }

  if (
    boundaryBenchmark !== undefined
    && !boundaryBenchmark.anyCythonCandidate
  ) {
    findings.push({
      code: "retrieval.boundary_query_missing_cython_candidate",
      severity: ValidationFindingSeverity.Warning,
      summary: "A Python/Cython boundary validation query did not surface a Cython candidate in the top reranked results.",
      query: input.queryDefinition.query,
      details: {
        baselineFirstCythonCandidateRank: boundaryBenchmark.baselineFirstCythonCandidateRank,
      },
    });
  }

  if (
    boundaryBenchmark !== undefined
    && boundaryBenchmark.regressedAgainstBaseline
  ) {
    findings.push({
      code: "retrieval.boundary_query_regressed_vs_baseline",
      severity: ValidationFindingSeverity.Error,
      summary: "A Python/Cython boundary validation query regressed relative to the no-boost baseline.",
      query: input.queryDefinition.query,
      details: {
        baselineFirstCythonCandidateRank: boundaryBenchmark.baselineFirstCythonCandidateRank,
        currentFirstCythonCandidateRank: boundaryBenchmark.firstCythonCandidateRank,
      },
    });
  }

  if (
    broadBenchmark !== undefined
    && broadBenchmark.regressedAgainstBaseline
  ) {
    findings.push({
      code:
        input.queryDefinition.category === ValidationQueryCategory.ExactSymbolApiLookup
          ? "retrieval.exact_query_regressed_vs_broad_baseline"
          : "retrieval.broad_query_regressed_vs_baseline",
      severity: ValidationFindingSeverity.Error,
      summary:
        input.queryDefinition.category === ValidationQueryCategory.ExactSymbolApiLookup
          ? "An exact-symbol validation query regressed relative to the pre-broad-boost baseline."
          : "A workflow or concept validation query regressed relative to the pre-broad-boost baseline.",
      query: input.queryDefinition.query,
      details: {
        baselineHasCandidates: broadBenchmark.baselineHasCandidates,
        baselineExpectedSurfaceObserved: broadBenchmark.baselineExpectedSurfaceObserved,
        currentExpectedSurfaceObserved: surfaceReview.expectedSurfaceObserved,
      },
    });
  }

  if (
    testAwareBenchmark !== undefined
    && testAwareBenchmark.currentTopCandidateLikelyTest
    && testAwareBenchmark.firstNonTestCandidateRank !== null
    && testAwareBenchmark.firstNonTestCandidateRank > 1
  ) {
    findings.push({
      code: "retrieval.broad_query_test_candidate_outranks_non_test",
      severity: ValidationFindingSeverity.Warning,
      summary: "A workflow or concept validation query still ranks likely test code ahead of a non-test candidate.",
      query: input.queryDefinition.query,
      details: {
        firstNonTestCandidateRank: testAwareBenchmark.firstNonTestCandidateRank,
        baselineTopCandidateLikelyTest: testAwareBenchmark.baselineTopCandidateLikelyTest,
      },
    });
  }

  if (
    testAwareBenchmark !== undefined
    && testAwareBenchmark.regressedAgainstBaseline
  ) {
    findings.push({
      code: "retrieval.broad_query_test_misranking_regressed_vs_baseline",
      severity: ValidationFindingSeverity.Error,
      summary: "A workflow or concept validation query regressed in test-vs-production ranking relative to the no-penalty baseline.",
      query: input.queryDefinition.query,
      details: {
        baselineFirstNonTestCandidateRank: testAwareBenchmark.baselineFirstNonTestCandidateRank,
        currentFirstNonTestCandidateRank: testAwareBenchmark.firstNonTestCandidateRank,
      },
    });
  }

  if (
    narrowBenchmark !== undefined
    && narrowBenchmark.regressedAgainstBaseline
  ) {
    findings.push({
      code: "retrieval.narrow_query_regressed_vs_baseline",
      severity: ValidationFindingSeverity.Error,
      summary: "A narrow exactish or technical validation query regressed relative to the no-specialized-boost baseline.",
      query: input.queryDefinition.query,
      details: {
        baselineHasCandidates: narrowBenchmark.baselineHasCandidates,
        baselineExpectedSurfaceObserved: narrowBenchmark.baselineExpectedSurfaceObserved,
        baselineFirstCythonCandidateRank: narrowBenchmark.baselineFirstCythonCandidateRank,
        baselineTopCandidateLikelyTest: narrowBenchmark.baselineTopCandidateLikelyTest,
        baselineTopCandidateMatchedFields: narrowBenchmark.baselineTopCandidateMatchedFields,
      },
    });
  }

  return {
    result: {
      query: input.queryDefinition.query,
      category: input.queryDefinition.category,
      sectionTitle: input.queryDefinition.sectionTitle,
      intent: routedFirst.intent,
      routingProfileId: routedFirst.profile.id,
      hasCandidates: rerankedResults.length > 0,
      pythonCandidateCount,
      cythonCandidateCount,
      rerankedResults,
      graphOrderingDeterministic,
      capsuleDeterministic,
      handoffDeterministic,
      surfaceReview,
      ...(boundaryBenchmark === undefined ? {} : { boundaryBenchmark }),
      ...(broadBenchmark === undefined ? {} : { broadBenchmark }),
      ...(testAwareBenchmark === undefined ? {} : { testAwareBenchmark }),
      ...(narrowBenchmark === undefined ? {} : { narrowBenchmark }),
      capsule: capsuleSummary,
      handoff: handoffSummary,
    },
    findings,
  };
}

function buildCapsulePipeline(input: {
  db: ReturnType<typeof openIndexerDatabase>;
  repoRoot: string;
  query: string;
  routedQuery: ReturnType<typeof routeQuery>;
  maxBudgetCharacters: number;
}): BuiltCapsulePipeline {
  const preparedAssembly = prepareCapsuleAssembly({
    classification: input.routedQuery.classification,
    builderInput: {
      query: input.query,
      rerankedCandidates: input.routedQuery.rerankedResults,
      supportingCandidates: input.routedQuery.rerankedResults.map(makeSupportingCandidateFromGraphResult),
      maxBudget: createCharacterBudget(input.maxBudgetCharacters),
    },
  });

  return {
    selection: preparedAssembly.selection,
    capsule: buildCapsule(
      createSourceBackedCapsuleBuilder({ db: input.db, repoRoot: input.repoRoot }),
      preparedAssembly.builderInput,
    ),
  };
}

function buildValidationHandoff(input: {
  repoRoot: string;
  latestRunId: number | null;
  pipeline: IntentAwareCapsulePipelineResult;
}) {
  return buildHandoffPayload(deterministicHandoffBuilder, {
    pipeline: input.pipeline,
    metadata: {
      repoRoot: input.repoRoot,
      sourceRunId: input.latestRunId,
    },
  });
}

async function runControlledChangeValidation(input: {
  repoRoot: string;
  db: ReturnType<typeof openIndexerDatabase>;
  queryResults: readonly ValidationQueryResult[];
  plan?: ControlledChangePlan;
  maxBudgetCharacters: number;
}): Promise<ControlledChangeValidationSummary> {
  const target = selectControlledChangeTarget(input.db, input.plan);

  if (target === undefined) {
    return makeSkippedControlledChangeSummary(
      "No safe Python source file with extracted symbols was available for controlled-change validation.",
    );
  }

  const originalFilePath = path.join(input.repoRoot, target.filePath);
  const originalContents = await readFile(originalFilePath, "utf8");
  const repoCopyRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-real-repo-validation-"));
  const sourceFilePaths = input.db.query(`
    SELECT path
    FROM files
    ORDER BY path ASC
  `).all() as Array<{ path: string }>;

  try {
    await copyValidationSourceTree(
      input.repoRoot,
      sourceFilePaths.map((row) => row.path),
      repoCopyRoot,
    );

    const latestRunId = getLatestIndexRun(input.db)?.id ?? null;
    const targetQuery = input.plan?.query ?? target.symbol.localName;
    const manifest = persistCapsuleManifest(input.db, {
      sourceRunId: latestRunId ?? 1,
      capsule: buildControlledChangeCapsule({
        db: input.db,
        repoRoot: input.repoRoot,
        query: targetQuery,
        symbol: target.symbol,
        maxBudgetCharacters: input.maxBudgetCharacters,
      }),
      createdAtMs: 1,
    });

    await applyControlledChange({
      repoCopyRoot,
      filePath: target.filePath,
      prefixText: input.plan?.prefixText ?? DEFAULT_CONTROLLED_CHANGE_PREFIX,
    });
    await indexProject({ repoRoot: repoCopyRoot, db: input.db });

    const comparisonRunId = getLatestIndexRun(input.db)!.id;
    const firstFileDiffs = listFileDiffsForRun(input.db, comparisonRunId) ?? [];
    const firstSymbolDiffs = listSymbolDiffsForRun(input.db, comparisonRunId) ?? [];
    const secondFileDiffs = listFileDiffsForRun(input.db, comparisonRunId) ?? [];
    const secondSymbolDiffs = listSymbolDiffsForRun(input.db, comparisonRunId) ?? [];
    const firstStaleness = getCapsuleStaleness(input.db, manifest.id, comparisonRunId);
    const secondStaleness = getCapsuleStaleness(input.db, manifest.id, comparisonRunId);
    const sourceRepoMutated = (await readFile(originalFilePath, "utf8")) !== originalContents;
    const runSummary = getIndexRunSummary(input.db, comparisonRunId)!;

    return {
      status:
        !isDeepStrictEqual(firstFileDiffs, secondFileDiffs)
          || !isDeepStrictEqual(firstSymbolDiffs, secondSymbolDiffs)
          || !isDeepStrictEqual(firstStaleness, secondStaleness)
          || sourceRepoMutated
          ? ValidationStatusEnum.Fail
          : ValidationStatusEnum.Pass,
      usedTemporaryCopy: true,
      sourceRepoMutated,
      targetFilePath: target.filePath,
      query: targetQuery,
      fileChangeCounts: runSummary.fileChangeCounts,
      symbolChangeCounts: runSummary.symbolChangeCounts,
      modifiedFilePaths: firstFileDiffs
        .filter((diff) => diff.changeType === FileChangeType.Modified)
        .map((diff) => diff.filePath),
      modifiedSymbols: firstSymbolDiffs
        .filter((diff) => diff.changeType === FileChangeType.Modified)
        .map((diff) => ({
          filePath: diff.filePath,
          fqName: diff.fqName,
          kind: diff.symbolKind,
          changeType: diff.changeType,
        })),
      ...(firstStaleness === undefined ? {} : { capsuleTrustStatus: firstStaleness.status }),
    };
  } finally {
    await rm(repoCopyRoot, { recursive: true, force: true });
  }
}

function buildControlledChangeCapsule(input: {
  db: ReturnType<typeof openIndexerDatabase>;
  repoRoot: string;
  query: string;
  symbol: SymbolRecord;
  maxBudgetCharacters: number;
}) {
  return buildCapsule(
    createSourceBackedCapsuleBuilder({ db: input.db, repoRoot: input.repoRoot }),
    {
      query: input.query,
      rerankedCandidates: [makeManualGraphSearchResult(input.symbol)],
      supportingCandidates: [],
      maxBudget: createCharacterBudget(input.maxBudgetCharacters),
    },
  );
}

function selectControlledChangeTarget(
  db: ReturnType<typeof openIndexerDatabase>,
  plan?: ControlledChangePlan,
): { filePath: string; symbol: SymbolRecord } | undefined {
  if (plan?.targetFilePath !== undefined) {
    const symbols = listSymbolsForFile(db, normalizePath(plan.targetFilePath));
    const symbol = symbols.find((candidate) => candidate.parentSymbolId === undefined) ?? symbols[0];

    return symbol === undefined
      ? undefined
      : { filePath: normalizePath(plan.targetFilePath), symbol };
  }

  const symbols = listAllSymbols(db)
    .filter((symbol) => detectLanguage(symbol.filePath) === Language.Python)
    .filter((symbol) => symbol.parentSymbolId === undefined)
    .sort((left, right) => left.filePath.localeCompare(right.filePath) || left.startByte - right.startByte);

  const symbol = symbols[0];

  return symbol === undefined ? undefined : { filePath: symbol.filePath, symbol };
}

async function copyValidationSourceTree(
  repoRoot: string,
  filePaths: readonly string[],
  destinationRoot: string,
): Promise<void> {
  for (const filePath of filePaths) {
    const sourcePath = path.join(repoRoot, filePath);
    const destinationPath = path.join(destinationRoot, filePath);

    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
}

async function applyControlledChange(input: {
  repoCopyRoot: string;
  filePath: string;
  prefixText: string;
}): Promise<void> {
  const absolutePath = path.join(input.repoCopyRoot, input.filePath);
  const originalContents = await readFile(absolutePath, "utf8");
  await writeFile(absolutePath, `${input.prefixText}${originalContents}`);
}

function collectControlledChangeFindings(
  controlledChange: ControlledChangeValidationSummary,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  if (controlledChange.status === ValidationStatusEnum.Skipped) {
    findings.push({
      code: "limitation.controlled_change_skipped",
      severity: ValidationFindingSeverity.Info,
      summary: "Controlled-change validation was skipped because no safe target file was available.",
    });
    return findings;
  }

  if (controlledChange.sourceRepoMutated) {
    findings.push({
      code: "controlled_change.source_repo_mutated",
      severity: ValidationFindingSeverity.Error,
      summary: "Controlled-change validation mutated the source repository, which must never happen.",
      details: {
        targetFilePath: controlledChange.targetFilePath,
      },
    });
  }

  if ((controlledChange.modifiedFilePaths ?? []).length === 0) {
    findings.push({
      code: "controlled_change.file_not_modified_in_diff",
      severity: ValidationFindingSeverity.Error,
      summary: "Controlled-change validation did not produce a modified file diff for the target file.",
      details: {
        targetFilePath: controlledChange.targetFilePath,
      },
    });
  }

  if ((controlledChange.modifiedSymbols ?? []).length === 0) {
    findings.push({
      code: "controlled_change.no_symbol_diffs_detected",
      severity: ValidationFindingSeverity.Warning,
      summary: "Controlled-change validation modified a file but no symbol-level diffs were detected.",
      details: {
        targetFilePath: controlledChange.targetFilePath,
      },
    });
  }

  return findings;
}

function addIndexingFindings(
  findings: ValidationFinding[],
  indexResult: Awaited<ReturnType<typeof indexProject>>,
  symbols: readonly SymbolRecord[],
  latestRunSummary?: IndexRunSummary,
): void {
  if (indexResult.totalFilesSuccessfullyIndexed === 0) {
    findings.push({
      code: "indexing.no_files_indexed",
      severity: ValidationFindingSeverity.Error,
      summary: "Indexing completed without producing any indexed files.",
    });
  }

  if (symbols.length === 0) {
    findings.push({
      code: "indexing.no_symbols_indexed",
      severity: ValidationFindingSeverity.Error,
      summary: "Indexing completed without producing any symbols.",
    });
  }

  if (indexResult.totalParseFailures > 0) {
    findings.push({
      code: "indexing.parse_failures_detected",
      severity: ValidationFindingSeverity.Warning,
      summary: "Indexing completed, but some files failed to parse.",
      details: {
        totalParseFailures: indexResult.totalParseFailures,
      },
    });
  }

  const indexedCythonFiles = indexResult.files.filter((file) => {
    return file.status === "indexed" && file.language === Language.Cython;
  });
  const cythonSymbols = symbols.filter((symbol) => detectLanguage(symbol.filePath) === Language.Cython);

  if (indexedCythonFiles.length > 0 && cythonSymbols.length === 0) {
    findings.push({
      code: "indexing.cython_files_without_symbols",
      severity: ValidationFindingSeverity.Warning,
      summary: "Cython files were indexed, but no Cython symbols were extracted.",
      details: {
        indexedCythonFileCount: indexedCythonFiles.length,
      },
    });
  }

  if (latestRunSummary !== undefined && latestRunSummary.totalFiles !== indexResult.totalFilesScanned) {
    findings.push({
      code: "indexing.run_summary_file_count_mismatch",
      severity: ValidationFindingSeverity.Warning,
      summary: "Persisted run summary file counts did not match the indexing result summary.",
      details: {
        runSummaryTotalFiles: latestRunSummary.totalFiles,
        indexingTotalFilesScanned: indexResult.totalFilesScanned,
      },
    });
  }
}

function addAggregatedQueryFindings(
  findings: ValidationFinding[],
  queryResults: readonly ValidationQueryResult[],
  indexResult: Awaited<ReturnType<typeof indexProject>>,
): void {
  const indexedCythonFiles = indexResult.files.filter((file) => {
    return file.status === "indexed" && file.language === Language.Cython;
  }).length;
  const boundaryQueries = queryResults.filter((result) => {
    return result.category === ValidationQueryCategory.PythonCythonBoundary;
  });
  const boundaryHits = boundaryQueries.filter((result) => result.cythonCandidateCount > 0).length;

  if (indexedCythonFiles > 0 && boundaryQueries.length > 0 && boundaryHits === 0) {
    findings.push({
      code: "retrieval.no_cython_boundary_candidates",
      severity: ValidationFindingSeverity.Warning,
      summary: "Python/Cython boundary queries did not surface any Cython candidates even though indexed Cython files exist.",
      details: {
        boundaryQueryCount: boundaryQueries.length,
        indexedCythonFileCount: indexedCythonFiles,
      },
    });
  } else if (indexedCythonFiles > 0 && boundaryQueries.length > 0 && boundaryHits < boundaryQueries.length) {
    findings.push({
      code: "limitation.boundary_query_without_cython_hit",
      severity: ValidationFindingSeverity.Info,
      summary: "Some Python/Cython boundary queries did not surface Cython candidates, which remains an accepted conservative limitation for RC1 review.",
      details: {
        boundaryQueryCount: boundaryQueries.length,
        boundaryQueriesWithCythonCandidates: boundaryHits,
      },
    });
  }

  if (queryResults.length > 0 && queryResults.every((result) => result.capsule.sourceBackedPivotCount === 0)) {
    findings.push({
      code: "capsule.no_source_backed_pivots",
      severity: ValidationFindingSeverity.Warning,
      summary: "No validation query produced a source-backed pivot capsule item.",
    });
  }
}

function summarizeCounts(input: {
  indexResult: Awaited<ReturnType<typeof indexProject>>;
  symbols: readonly SymbolRecord[];
  edges: readonly ReturnType<typeof listAllEdges>;
  queryResults: readonly ValidationQueryResult[];
}): RealRepoValidationSummaryCounts {
  const indexedFiles = input.indexResult.files.filter((file) => file.status === "indexed");
  const indexedPythonFileCount = indexedFiles.filter((file) => file.language === Language.Python).length;
  const indexedCythonFileCount = indexedFiles.filter((file) => file.language === Language.Cython).length;
  const indexedPythonSymbolCount = input.symbols.filter((symbol) => detectLanguage(symbol.filePath) === Language.Python).length;
  const indexedCythonSymbolCount = input.symbols.filter((symbol) => detectLanguage(symbol.filePath) === Language.Cython).length;
  const exactQueriesWithExpectedSurface = input.queryResults.filter((result) => {
    return result.category === ValidationQueryCategory.ExactSymbolApiLookup
      && result.surfaceReview.expectedSurfaceObserved === true;
  }).length;
  const exactQueriesImprovedAgainstBaseline = input.queryResults.filter((result) => {
    return result.category === ValidationQueryCategory.ExactSymbolApiLookup
      && (result.narrowBenchmark?.improvedAgainstBaseline === true
        || (result.narrowBenchmark === undefined && result.broadBenchmark?.improvedAgainstBaseline === true));
  }).length;
  const exactQueriesRegressedAgainstBaseline = input.queryResults.filter((result) => {
    return result.category === ValidationQueryCategory.ExactSymbolApiLookup
      && (result.narrowBenchmark?.regressedAgainstBaseline === true
        || (result.narrowBenchmark === undefined && result.broadBenchmark?.regressedAgainstBaseline === true));
  }).length;
  const narrowQueriesImprovedAgainstBaseline = input.queryResults.filter((result) => {
    return result.narrowBenchmark?.improvedAgainstBaseline === true;
  }).length;
  const narrowQueriesRegressedAgainstBaseline = input.queryResults.filter((result) => {
    return result.narrowBenchmark?.regressedAgainstBaseline === true;
  }).length;
  const boundaryQueriesWithCythonCandidates = input.queryResults.filter((result) => {
    return result.category === ValidationQueryCategory.PythonCythonBoundary
      && result.cythonCandidateCount > 0;
  }).length;
  const boundaryQueriesImprovedAgainstBaseline = input.queryResults.filter((result) => {
    return result.category === ValidationQueryCategory.PythonCythonBoundary
      && result.boundaryBenchmark?.improvedAgainstBaseline === true;
  }).length;
  const boundaryQueriesRegressedAgainstBaseline = input.queryResults.filter((result) => {
    return result.category === ValidationQueryCategory.PythonCythonBoundary
      && result.boundaryBenchmark?.regressedAgainstBaseline === true;
  }).length;
  const broadQueriesImprovedAgainstBaseline = input.queryResults.filter((result) => {
    return isBroadBenchmarkCategory(result.category)
      && result.broadBenchmark?.improvedAgainstBaseline === true;
  }).length;
  const broadQueriesRegressedAgainstBaseline = input.queryResults.filter((result) => {
    return isBroadBenchmarkCategory(result.category)
      && result.broadBenchmark?.regressedAgainstBaseline === true;
  }).length;
  const broadQueriesWithLikelyTestTopCandidate = input.queryResults.filter((result) => {
    return isBroadBenchmarkCategory(result.category)
      && result.testAwareBenchmark?.currentTopCandidateLikelyTest === true;
  }).length;
  const broadQueriesTestMisrankingImprovedAgainstBaseline = input.queryResults.filter((result) => {
    return isBroadBenchmarkCategory(result.category)
      && result.testAwareBenchmark?.improvedAgainstBaseline === true;
  }).length;
  const broadQueriesTestMisrankingRegressedAgainstBaseline = input.queryResults.filter((result) => {
    return isBroadBenchmarkCategory(result.category)
      && result.testAwareBenchmark?.regressedAgainstBaseline === true;
  }).length;

  return {
    indexedFileCount: indexedFiles.length,
    indexedPythonFileCount,
    indexedCythonFileCount,
    indexedSymbolCount: input.symbols.length,
    indexedPythonSymbolCount,
    indexedCythonSymbolCount,
    indexedEdgeCount: input.edges.length,
    parseFailureCount: input.indexResult.totalParseFailures,
    readFailureCount: input.indexResult.totalReadFailures,
    persistenceFailureCount: input.indexResult.totalPersistenceFailures,
    queryCount: input.queryResults.length,
    queriesWithCandidates: input.queryResults.filter((result) => result.hasCandidates).length,
    queriesWithCapsules: input.queryResults.filter((result) => {
      return result.capsule.pivotCount + result.capsule.supportCount > 0;
    }).length,
    queriesWithSourceBackedPivots: input.queryResults.filter((result) => result.capsule.sourceBackedPivotCount > 0).length,
    exactQueriesWithExpectedSurface,
    exactQueriesImprovedAgainstBaseline,
    exactQueriesRegressedAgainstBaseline,
    narrowQueriesImprovedAgainstBaseline,
    narrowQueriesRegressedAgainstBaseline,
    boundaryQueriesWithCythonCandidates,
    boundaryQueriesImprovedAgainstBaseline,
    boundaryQueriesRegressedAgainstBaseline,
    broadQueriesImprovedAgainstBaseline,
    broadQueriesRegressedAgainstBaseline,
    broadQueriesWithLikelyTestTopCandidate,
    broadQueriesTestMisrankingImprovedAgainstBaseline,
    broadQueriesTestMisrankingRegressedAgainstBaseline,
  };
}

function summarizeAreaResults(input: {
  indexResult: Awaited<ReturnType<typeof indexProject>>;
  summaryCounts: RealRepoValidationSummaryCounts;
  queryResults: readonly ValidationQueryResult[];
  indexingDeterministic: boolean;
  controlledChange: ControlledChangeValidationSummary;
}) {
  const boundaryQueries = input.queryResults.filter((result) => {
    return result.category === ValidationQueryCategory.PythonCythonBoundary;
  });
  const requiredBoundaryHits = boundaryQueries.length === 0 ? 0 : Math.ceil(boundaryQueries.length / 2);
  const representativeCythonPass = input.summaryCounts.indexedCythonFileCount === 0
    ? ValidationStatusEnum.Skipped
    : boundaryQueries.length === 0
      ? (input.queryResults.some((result) => result.cythonCandidateCount > 0)
          ? ValidationStatusEnum.Pass
          : ValidationStatusEnum.Fail)
      : (input.summaryCounts.boundaryQueriesWithCythonCandidates >= requiredBoundaryHits
          && input.summaryCounts.boundaryQueriesRegressedAgainstBaseline === 0
          ? ValidationStatusEnum.Pass
          : ValidationStatusEnum.Fail);
  const queryCapsuleFailures = input.queryResults.filter((result) => {
    return result.hasCandidates && result.capsule.pivotCount + result.capsule.supportCount === 0;
  }).length;
  const allQueryArtifactsDeterministic = input.queryResults.every((result) => {
    return result.graphOrderingDeterministic
      && result.capsuleDeterministic
      && result.handoffDeterministic;
  });

  return {
    indexingAndPersistence: makeAreaResult(
      input.indexResult.totalFilesSuccessfullyIndexed > 0
        && input.summaryCounts.indexedSymbolCount > 0
        && input.indexResult.totalReadFailures === 0
        && input.indexResult.totalPersistenceFailures === 0,
      "Indexing and persistence completed with persisted structural state.",
      "Indexing or persistence did not complete cleanly enough for RC1 validation.",
    ),
    representativePythonQueries: makeAreaResult(
      input.queryResults.some((result) => result.pythonCandidateCount > 0),
      "Representative validation queries surfaced Python candidates.",
      "Representative validation queries did not surface Python candidates.",
    ),
    representativeCythonQueries: {
      status: representativeCythonPass,
      summary: representativeCythonPass === ValidationStatusEnum.Pass
        ? "Representative boundary validation queries surfaced Cython candidates often enough without regressing the baseline."
        : representativeCythonPass === ValidationStatusEnum.Skipped
          ? "No indexed Cython files were available for representative Cython query validation."
          : "Representative Cython-oriented boundary queries did not surface Cython candidates reliably enough.",
    },
    graphAwareReranking: makeAreaResult(
      input.queryResults.every((result) => result.graphOrderingDeterministic),
      "Graph-aware reranking executed deterministically for the validation queries.",
      "Graph-aware reranking produced unstable ordering across repeated identical queries.",
    ),
    capsuleAssembly: makeAreaResult(
      queryCapsuleFailures === 0,
      "Capsule assembly succeeded for validation queries with candidates.",
      "At least one validation query produced candidates but no capsule items.",
    ),
    sourceBackedCapsuleBehavior: makeAreaResult(
      input.summaryCounts.queriesWithSourceBackedPivots > 0,
      "At least one validation query produced a safe source-backed pivot.",
      "No validation query produced a safe source-backed pivot.",
    ),
    controlledChange: {
      status: input.controlledChange.status,
      summary: input.controlledChange.status === ValidationStatusEnum.Pass
        ? "Controlled-change validation succeeded on a temporary source copy."
        : input.controlledChange.status === ValidationStatusEnum.Skipped
          ? "Controlled-change validation was skipped."
          : "Controlled-change validation produced unstable or unsafe results.",
    },
    handoffPayloadGeneration: makeAreaResult(
      input.queryResults.every((result) => result.handoff.built),
      "Handoff payload generation succeeded for the validation queries.",
      "At least one validation query failed to build a handoff payload.",
    ),
    determinism: makeAreaResult(
      input.indexingDeterministic && allQueryArtifactsDeterministic,
      "Repeated identical validation runs produced stable indexing, reranking, capsule, and handoff outputs.",
      "Repeated identical validation runs produced unstable outputs.",
    ),
  };
}

function recommendRc1Readiness(input: {
  areaResults: RealRepoValidationReport["areaResults"];
  findings: readonly ValidationFinding[];
}): RC1ReadinessRecommendation {
  const failedAreas = Object.values(input.areaResults).filter((result) => result.status === ValidationStatusEnum.Fail);
  const hasErrors = input.findings.some((finding) => finding.severity === ValidationFindingSeverity.Error);
  const hasWarnings = input.findings.some((finding) => finding.severity === ValidationFindingSeverity.Warning);

  if (failedAreas.length > 0 || hasErrors) {
    return "not ready";
  }

  if (hasWarnings || input.findings.length > 0) {
    return "ready with known limitations";
  }

  return "ready";
}

function summarizeCandidate(candidate: GraphSearchResult): ValidationCandidateSummary {
  return {
    symbolId: candidate.symbolId,
    filePath: candidate.filePath,
    fqName: candidate.fqName,
    localName: candidate.localName,
    kind: candidate.kind,
    ...(languageFromFilePath(candidate.filePath) === undefined
      ? {}
      : { language: languageFromFilePath(candidate.filePath)! }),
    likelyTestCandidate: isLikelyTestCandidate({
      filePath: candidate.filePath,
      localName: candidate.localName,
      fqName: candidate.fqName,
    }),
    lexicalScore: candidate.lexicalScore,
    graphScore: candidate.graphScore,
    finalScore: candidate.finalScore,
    matchedFields: collectUniqueInOrder(candidate.matches.map((match) => match.field)),
  };
}

function summarizeCapsule(
  capsule: ReturnType<typeof buildCapsule>,
) {
  return {
    built: true,
    pivotCount: capsule.pivots.length,
    supportCount: capsule.supportingItems.length,
    sourceBackedPivotCount: capsule.pivots.filter((item) => item.sourceBacked === true).length,
    truncated: capsule.truncated,
    compressed: capsule.compressed,
    items: [...capsule.pivots, ...capsule.supportingItems].map((item) => ({
      localName: item.localName,
      filePath: item.filePath,
      fqName: item.fqName,
      role: item.role,
      contentMode: item.content.mode,
      sourceBacked: item.sourceBacked === true,
    })),
  };
}

function summarizeHandoff(
  handoffPayload: ReturnType<typeof buildHandoffPayload>,
) {
  return {
    built: true,
    itemCount: handoffPayload.capsule.items.length,
    selectedIntent: handoffPayload.selectedIntent,
    schemaName: handoffPayload.schema.name,
    schemaVersion: handoffPayload.schema.version,
    trustStatus: handoffPayload.trust.capsuleStaleness?.status ?? null,
  };
}

function summarizeSurfaceReview(input: {
  queryDefinition: ValidationQueryDefinition;
  results: readonly ValidationCandidateSummary[];
  interestingSymbols: readonly string[];
  interestingFiles: readonly string[];
}) {
  const interestingMatches = collectInterestingMatches(
    input.results,
    input.interestingSymbols,
    input.interestingFiles,
  );

  if (input.queryDefinition.category !== ValidationQueryCategory.ExactSymbolApiLookup) {
    return {
      expectedSurfaceObserved: null,
      interestingMatches,
    };
  }

  const normalizedQuery = normalizeSearchText(input.queryDefinition.query);
  const expectedSurfaceObserved = input.results.some((result) => {
    return normalizeSearchText(result.localName) === normalizedQuery
      || normalizeSearchText(result.fqName).includes(normalizedQuery)
      || normalizeSearchText(result.filePath).includes(normalizedQuery);
  });

  return {
    expectedSurfaceObserved,
    interestingMatches,
  };
}

function summarizeBoundaryBenchmark(
  category: ValidationQueryCategory,
  results: readonly ValidationCandidateSummary[],
  baselineResults?: readonly ValidationCandidateSummary[],
) {
  if (category !== ValidationQueryCategory.PythonCythonBoundary) {
    return undefined;
  }

  const firstCythonCandidateRank = findFirstCythonCandidateRank(results);
  const baselineFirstCythonCandidateRank = findFirstCythonCandidateRank(baselineResults ?? []);

  return {
    anyCythonCandidate: firstCythonCandidateRank !== null,
    firstCythonCandidateRank,
    baselineAnyCythonCandidate: baselineFirstCythonCandidateRank !== null,
    baselineFirstCythonCandidateRank,
    improvedAgainstBaseline:
      baselineFirstCythonCandidateRank === null
        ? firstCythonCandidateRank !== null
        : firstCythonCandidateRank !== null
          && firstCythonCandidateRank < baselineFirstCythonCandidateRank,
    regressedAgainstBaseline:
      firstCythonCandidateRank === null
        ? baselineFirstCythonCandidateRank !== null
        : baselineFirstCythonCandidateRank !== null
          && firstCythonCandidateRank > baselineFirstCythonCandidateRank,
  };
}

function findFirstCythonCandidateRank(
  results: readonly ValidationCandidateSummary[],
): number | null {
  const index = results.findIndex((result) => result.language === Language.Cython);

  return index === -1 ? null : index + 1;
}

function summarizeBroadBenchmark(
  category: ValidationQueryCategory,
  results: readonly ValidationCandidateSummary[],
  surfaceReview: ReturnType<typeof summarizeSurfaceReview>,
  baselineResults?: readonly ValidationCandidateSummary[],
  baselineSurfaceReview?: ReturnType<typeof summarizeSurfaceReview>,
) {
  if (!shouldBenchmarkBroadQuery(category)) {
    return undefined;
  }

  const baselineHasCandidates = (baselineResults ?? []).length > 0;
  const baselineExpectedSurfaceObserved = baselineSurfaceReview?.expectedSurfaceObserved ?? null;
  const currentHasCandidates = results.length > 0;
  const currentExpectedSurfaceObserved = surfaceReview.expectedSurfaceObserved;
  const exactQueryImproved = category === ValidationQueryCategory.ExactSymbolApiLookup
    && baselineExpectedSurfaceObserved !== true
    && currentExpectedSurfaceObserved === true;
  const exactQueryRegressed = category === ValidationQueryCategory.ExactSymbolApiLookup
    && baselineExpectedSurfaceObserved === true
    && currentExpectedSurfaceObserved !== true;

  return {
    baselineHasCandidates,
    baselineExpectedSurfaceObserved,
    improvedAgainstBaseline: exactQueryImproved
      || (!baselineHasCandidates && currentHasCandidates),
    regressedAgainstBaseline: exactQueryRegressed
      || (baselineHasCandidates && !currentHasCandidates),
  };
}

function summarizeTestAwareBenchmark(
  category: ValidationQueryCategory,
  results: readonly ValidationCandidateSummary[],
  baselineResults?: readonly ValidationCandidateSummary[],
) {
  if (!isBroadBenchmarkCategory(category)) {
    return undefined;
  }

  const baselineFirstNonTestCandidateRank = findFirstNonTestCandidateRank(baselineResults ?? []);
  const firstNonTestCandidateRank = findFirstNonTestCandidateRank(results);

  return {
    baselineTopCandidateLikelyTest: (baselineResults?.[0]?.likelyTestCandidate ?? false),
    currentTopCandidateLikelyTest: (results[0]?.likelyTestCandidate ?? false),
    baselineFirstNonTestCandidateRank,
    firstNonTestCandidateRank,
    improvedAgainstBaseline:
      baselineFirstNonTestCandidateRank === null
        ? firstNonTestCandidateRank !== null
        : firstNonTestCandidateRank !== null
          && firstNonTestCandidateRank < baselineFirstNonTestCandidateRank,
    regressedAgainstBaseline:
      baselineFirstNonTestCandidateRank !== null
        && (firstNonTestCandidateRank === null
          || firstNonTestCandidateRank > baselineFirstNonTestCandidateRank),
  };
}

function summarizeNarrowBenchmark(
  queryDefinition: ValidationQueryDefinition,
  results: readonly ValidationCandidateSummary[],
  surfaceReview: ReturnType<typeof summarizeSurfaceReview>,
  baselineResults?: readonly ValidationCandidateSummary[],
  baselineSurfaceReview?: ReturnType<typeof summarizeSurfaceReview>,
) {
  if (!shouldBenchmarkNarrowQuery(queryDefinition)) {
    return undefined;
  }

  const baselineHasCandidates = (baselineResults ?? []).length > 0;
  const baselineExpectedSurfaceObserved = baselineSurfaceReview?.expectedSurfaceObserved ?? null;
  const baselineFirstCythonCandidateRank = findFirstCythonCandidateRank(baselineResults ?? []);
  const firstCythonCandidateRank = findFirstCythonCandidateRank(results);
  const baselineTopCandidateLikelyTest = baselineResults?.[0]?.likelyTestCandidate ?? false;
  const currentTopCandidateLikelyTest = results[0]?.likelyTestCandidate ?? false;
  const baselineTopCandidateMatchedFields = baselineResults?.[0]?.matchedFields ?? [];
  const currentTopCandidateMatchedFields = results[0]?.matchedFields ?? [];
  const currentHasCandidates = results.length > 0;
  const currentExpectedSurfaceObserved = surfaceReview.expectedSurfaceObserved;
  const currentHasTechnicalHint = currentTopCandidateMatchedFields.includes(SymbolSearchMatchField.TechnicalHint);
  const baselineHasTechnicalHint = baselineTopCandidateMatchedFields.includes(SymbolSearchMatchField.TechnicalHint);
  const currentHasBoundaryHint = currentTopCandidateMatchedFields.includes(SymbolSearchMatchField.BoundaryHint);
  const baselineHasBoundaryHint = baselineTopCandidateMatchedFields.includes(SymbolSearchMatchField.BoundaryHint);
  const improvedAgainstBaseline = (
    (!baselineHasCandidates && currentHasCandidates)
    || (baselineExpectedSurfaceObserved !== true && currentExpectedSurfaceObserved === true)
    || (baselineFirstCythonCandidateRank === null && firstCythonCandidateRank !== null)
    || (baselineFirstCythonCandidateRank !== null
      && firstCythonCandidateRank !== null
      && firstCythonCandidateRank < baselineFirstCythonCandidateRank)
    || (baselineTopCandidateLikelyTest && !currentTopCandidateLikelyTest)
    || (!baselineHasTechnicalHint && currentHasTechnicalHint)
    || (!baselineHasBoundaryHint && currentHasBoundaryHint)
  );
  const regressedAgainstBaseline = (
    (baselineHasCandidates && !currentHasCandidates)
    || (baselineExpectedSurfaceObserved === true && currentExpectedSurfaceObserved !== true)
    || (baselineFirstCythonCandidateRank !== null && firstCythonCandidateRank === null)
    || (baselineFirstCythonCandidateRank !== null
      && firstCythonCandidateRank !== null
      && firstCythonCandidateRank > baselineFirstCythonCandidateRank)
    || (!baselineTopCandidateLikelyTest && currentTopCandidateLikelyTest)
    || (baselineHasTechnicalHint && !currentHasTechnicalHint)
    || (baselineHasBoundaryHint && !currentHasBoundaryHint)
  );

  return {
    baselineHasCandidates,
    baselineExpectedSurfaceObserved,
    baselineFirstCythonCandidateRank,
    baselineTopCandidateLikelyTest,
    baselineTopCandidateMatchedFields,
    improvedAgainstBaseline,
    regressedAgainstBaseline,
  };
}

function findFirstNonTestCandidateRank(
  results: readonly ValidationCandidateSummary[],
): number | null {
  const index = results.findIndex((result) => result.likelyTestCandidate === false);

  return index === -1 ? null : index + 1;
}

async function resolveValidationQueries(
  options: RealRepoValidationOptions,
): Promise<ResolvedQuerySet> {
  if (options.queries !== undefined) {
    return {
      queries: normalizeQueryDefinitions(options.queries),
      querySetSource: null,
    };
  }

  const queryFilePath = path.resolve(options.queriesFilePath ?? DEFAULT_QUERY_FILE_PATH);
  const content = await readFile(queryFilePath, "utf8");

  return {
    queries: parseValidationQueriesMarkdown(content),
    querySetSource: queryFilePath,
  };
}

function normalizeQueryDefinitions(
  values: readonly string[] | readonly ValidationQueryDefinition[],
): ValidationQueryDefinition[] {
  if (values.every((value) => typeof value === "string")) {
    return values.map((query) => ({
      query,
      category: ValidationQueryCategory.Custom,
      sectionTitle: "Custom",
    }));
  }

  return [...values] as ValidationQueryDefinition[];
}

function parseValidationQueriesMarkdown(content: string): ValidationQueryDefinition[] {
  const lines = content.split(/\r?\n/);
  const queries: ValidationQueryDefinition[] = [];
  let insideQuerySet = false;
  let currentSectionTitle = "Custom";
  let currentCategory = ValidationQueryCategory.Custom;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === "## Query Set") {
      insideQuerySet = true;
      continue;
    }

    if (insideQuerySet && line.startsWith("## ")) {
      break;
    }

    if (!insideQuerySet) {
      continue;
    }

    if (line.startsWith("### ")) {
      currentSectionTitle = line.slice(4).trim();
      currentCategory = mapSectionTitleToCategory(currentSectionTitle);
      continue;
    }

    if (!line.startsWith("- ")) {
      continue;
    }

    const query = line.slice(2).trim();

    if (query.length === 0) {
      continue;
    }

    queries.push({
      query,
      category: currentCategory,
      sectionTitle: currentSectionTitle,
    });
  }

  return queries;
}

function mapSectionTitleToCategory(
  sectionTitle: string,
): ValidationQueryCategory {
  switch (normalizeHeadingText(sectionTitle)) {
    case "exact symbol api lookup":
      return ValidationQueryCategory.ExactSymbolApiLookup;
    case "arc workflow tracing":
      return ValidationQueryCategory.WorkflowTracing;
    case "scientific domain concept queries":
      return ValidationQueryCategory.ScientificDomainConcept;
    case "python cython boundary queries":
      return ValidationQueryCategory.PythonCythonBoundary;
    case "file module discovery queries":
      return ValidationQueryCategory.FileModuleDiscovery;
    case "ambiguous stress queries":
      return ValidationQueryCategory.AmbiguousStress;
    default:
      return ValidationQueryCategory.Custom;
  }
}

function shouldBenchmarkBroadQuery(category: ValidationQueryCategory): boolean {
  return category === ValidationQueryCategory.ExactSymbolApiLookup
    || isBroadBenchmarkCategory(category);
}

function shouldBenchmarkNarrowQuery(
  queryDefinition: ValidationQueryDefinition,
): boolean {
  const broadContext = resolveBroadQueryContext(queryDefinition.query, true);
  const technicalContext = resolveTechnicalQueryContext(queryDefinition.query, broadContext, true);
  const normalizedQuery = normalizeSearchText(queryDefinition.query);
  const normalizedTerms = normalizedQuery.split(/[\s/]+/).filter(Boolean);
  const isExactishQuery = queryDefinition.category === ValidationQueryCategory.ExactSymbolApiLookup
    && /[_./-]/.test(queryDefinition.query);

  if (isExactishQuery) {
    return true;
  }

  if (technicalContext === undefined) {
    return false;
  }

  const shortTechnicalQuery = normalizedTerms.length <= 3;
  const ioTracingQuery = /^(where is|where are|how is|how are)\b/.test(normalizedQuery)
    && technicalContext.matchedDimensions.some((dimension) => {
      return dimension === "io" || dimension === "parser" || dimension === "serialization";
    });

  return shortTechnicalQuery || ioTracingQuery;
}

function isBroadBenchmarkCategory(category: ValidationQueryCategory): boolean {
  return category === ValidationQueryCategory.WorkflowTracing
    || category === ValidationQueryCategory.ScientificDomainConcept;
}

function snapshotValidationState(
  db: ReturnType<typeof openIndexerDatabase>,
) {
  return {
    symbols: listAllSymbols(db),
    edges: listAllEdges(db),
  };
}

function makeSupportingCandidateFromGraphResult(
  result: GraphSearchResult,
): CapsuleSupportingCandidate {
  return {
    symbolId: result.symbolId,
    filePath: result.filePath,
    fqName: result.fqName,
    localName: result.localName,
    kind: result.kind,
    lexicalScore: result.lexicalScore,
    graphScore: result.graphScore,
    finalScore: result.finalScore,
    inclusionReasons: buildInclusionReasonsFromGraphResult(result),
  };
}

function buildInclusionReasonsFromGraphResult(
  result: GraphSearchResult,
): CapsuleInclusionReason[] {
  const reasons: CapsuleInclusionReason[] = [
    {
      kind: CapsuleInclusionReasonKind.LexicalMatch,
      matchedFields: collectUniqueInOrder(result.matches.map((match) => match.field)),
    },
  ];
  const graphSignals = collectUniqueInOrder(result.graphContributions.map((contribution) => contribution.signal));
  const relatedSymbolIds = collectSortedUnique(
    result.graphContributions.flatMap((contribution) => contribution.relatedSymbolIds ?? []),
  );

  if (graphSignals.length > 0) {
    reasons.push({
      kind: CapsuleInclusionReasonKind.GraphConnection,
      graphSignals,
      ...(relatedSymbolIds.length === 0 ? {} : { relatedSymbolIds }),
    });
  }

  return reasons;
}

function makeManualGraphSearchResult(
  symbol: SymbolRecord,
): GraphSearchResult {
  return {
    symbolId: symbol.id,
    filePath: symbol.filePath,
    fqName: symbol.fqName,
    localName: symbol.localName,
    kind: symbol.kind,
    matches: [
      {
        field: SymbolSearchMatchField.LocalName,
        matchType: SymbolSearchMatchType.Exact,
        scoreContribution: 100,
      },
      {
        field: SymbolSearchMatchField.FQName,
        matchType: SymbolSearchMatchType.Substring,
        scoreContribution: 20,
      },
    ],
    lexicalScore: 100,
    graphScore: 0,
    finalScore: 100,
    graphContributions: [],
  };
}

function makeAreaResult(
  passed: boolean,
  passSummary: string,
  failSummary: string,
) {
  return {
    status: passed ? ValidationStatusEnum.Pass : ValidationStatusEnum.Fail,
    summary: passed ? passSummary : failSummary,
  };
}

function normalizeList(values: readonly string[] | undefined): string[] {
  return values === undefined ? [] : [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizePathList(values: readonly string[] | undefined): string[] {
  return values === undefined ? [] : [...new Set(values.map(normalizePath).filter(Boolean))];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeLogicFlowProbes(
  probes: readonly LogicFlowProbeDefinition[] | undefined,
): LogicFlowProbeDefinition[] {
  if (probes === undefined) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: LogicFlowProbeDefinition[] = [];

  for (const probe of probes) {
    const start = probe.start.trim();
    const end = probe.end.trim();

    if (start.length === 0 || end.length === 0) {
      continue;
    }

    const key = `${start} ${end}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push({ start, end });
  }

  return normalized;
}

const STRUCTURAL_EDGE_TYPES: readonly EdgeType[] = [
  EdgeType.Contains,
  EdgeType.Imports,
  EdgeType.Calls,
  EdgeType.References,
];

const STRUCTURAL_LANGUAGES: readonly Language[] = [
  Language.TypeScript,
  Language.JavaScript,
  Language.Python,
  Language.Cython,
  Language.Go,
  Language.Rust,
];

function summarizeStructuralEvidence(input: {
  db: ReturnType<typeof openIndexerDatabase>;
  symbols: readonly SymbolRecord[];
  edges: readonly EdgeRecord[];
  impactProbeSymbols: readonly string[];
  logicFlowProbes: readonly LogicFlowProbeDefinition[];
}): ValidationStructuralEvidence {
  const languageBySymbolId = new Map<string, Language>();

  for (const symbol of input.symbols) {
    const language = detectLanguage(symbol.filePath);

    if (language !== undefined) {
      languageBySymbolId.set(symbol.id, language);
    }
  }

  const byType = new Map<EdgeType, number>();
  const byLanguage = new Map<string, number>();
  const byCrossLanguage = new Map<string, number>();

  for (const edge of input.edges) {
    byType.set(edge.edgeType, (byType.get(edge.edgeType) ?? 0) + 1);

    const srcLanguage = languageBySymbolId.get(edge.srcSymbolId);
    const dstLanguage = languageBySymbolId.get(edge.dstSymbolId);

    if (srcLanguage !== undefined) {
      const key = `${srcLanguage} ${edge.edgeType}`;
      byLanguage.set(key, (byLanguage.get(key) ?? 0) + 1);
    }

    if (srcLanguage !== undefined && dstLanguage !== undefined && srcLanguage !== dstLanguage) {
      const key = `${srcLanguage} ${dstLanguage} ${edge.edgeType}`;
      byCrossLanguage.set(key, (byCrossLanguage.get(key) ?? 0) + 1);
    }
  }

  const edgeCountsByType = STRUCTURAL_EDGE_TYPES
    .filter((edgeType) => byType.has(edgeType))
    .map((edgeType) => ({ edgeType, count: byType.get(edgeType) ?? 0 }));

  const edgeCountsByLanguage = STRUCTURAL_LANGUAGES.flatMap((language) =>
    STRUCTURAL_EDGE_TYPES
      .map((edgeType) => ({ language, edgeType, key: `${language} ${edgeType}` }))
      .filter((entry) => byLanguage.has(entry.key))
      .map((entry) => ({ language: entry.language, edgeType: entry.edgeType, count: byLanguage.get(entry.key) ?? 0 })),
  );

  const crossLanguageEdgeCounts = [...byCrossLanguage.entries()]
    .map(([key, count]) => {
      const [srcLanguage, dstLanguage, edgeType] = key.split(" ");
      return {
        srcLanguage: srcLanguage as Language,
        dstLanguage: dstLanguage as Language,
        edgeType: edgeType as EdgeType,
        count,
      };
    })
    .sort((left, right) =>
      left.srcLanguage.localeCompare(right.srcLanguage)
      || left.dstLanguage.localeCompare(right.dstLanguage)
      || left.edgeType.localeCompare(right.edgeType));

  const impactProbes = [...input.impactProbeSymbols]
    .sort((left, right) => left.localeCompare(right))
    .map((symbolFqn) => probeImpact(input.db, symbolFqn));

  const logicFlowProbes = input.logicFlowProbes
    .map((probe) => probeLogicFlow(input.db, probe))
    .sort((left, right) =>
      left.start.localeCompare(right.start) || left.end.localeCompare(right.end));

  return {
    edgeCountsByType,
    edgeCountsByLanguage,
    crossLanguageEdgeCounts,
    impactProbes,
    logicFlowProbes,
  };
}

function probeImpact(
  db: ReturnType<typeof openIndexerDatabase>,
  symbolFqn: string,
): ValidationImpactProbe {
  const result = getImpactGraph(db, { symbolFqn, depth: 2, format: "list" });

  if (!result.ok) {
    return {
      symbolFqn,
      resolved: false,
      language: null,
      dependentSymbolCount: 0,
      dependentFileCount: 0,
      observedEdgeTypes: [],
      foundRealDependents: false,
    };
  }

  return {
    symbolFqn,
    resolved: true,
    language: languageFromFilePath(result.output.resolvedSymbol.filePath) ?? null,
    dependentSymbolCount: result.output.summary.dependentSymbolCount,
    dependentFileCount: result.output.summary.dependentFileCount,
    observedEdgeTypes: result.output.coverage.observedEdgeTypes,
    foundRealDependents: result.output.summary.dependentSymbolCount > 0,
  };
}

function probeLogicFlow(
  db: ReturnType<typeof openIndexerDatabase>,
  probe: LogicFlowProbeDefinition,
): ValidationLogicFlowProbe {
  const result = searchLogicFlow(db, { start: probe.start, end: probe.end, maxPaths: 8 });

  if (!result.ok) {
    const startResolved = result.error.code !== "unknown_start" && result.error.code !== "ambiguous_start";

    return {
      start: probe.start,
      end: probe.end,
      startResolved,
      endResolved: startResolved && result.error.code !== "unknown_end" && result.error.code !== "ambiguous_end",
      reachable: false,
      pathCount: 0,
      callFlowEvidenceAvailable: false,
      callFlowEvidenceUsed: false,
    };
  }

  return {
    start: probe.start,
    end: probe.end,
    startResolved: true,
    endResolved: true,
    reachable: result.output.summary.reachable,
    pathCount: result.output.summary.pathCount,
    callFlowEvidenceAvailable: result.output.coverage.callFlowEvidenceAvailable,
    callFlowEvidenceUsed: result.output.coverage.callFlowEvidenceUsed,
  };
}

function addStructuralFindings(
  findings: ValidationFinding[],
  structuralEvidence: ValidationStructuralEvidence,
): void {
  for (const probe of structuralEvidence.logicFlowProbes) {
    if (probe.startResolved && probe.endResolved && !probe.reachable) {
      findings.push({
        code: "limitation.logic_flow_probe_unreachable",
        severity: ValidationFindingSeverity.Info,
        summary:
          "A requested logic-flow probe resolved both endpoints but found no connecting path; cross-module call resolution may be conservative for this pair.",
        details: { start: probe.start, end: probe.end },
      });
    }
  }
}

function normalizeSearchText(value: string): string {
  return normalizePath(value).trim().toLowerCase();
}

function normalizeHeadingText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function languageFromFilePath(filePath: string): Language | undefined {
  return detectLanguage(filePath);
}

function collectInterestingMatches(
  results: readonly ValidationCandidateSummary[],
  interestingSymbols: readonly string[],
  interestingFiles: readonly string[],
): string[] {
  const matches: string[] = [];

  for (const interestingSymbol of interestingSymbols) {
    const normalized = normalizeSearchText(interestingSymbol);

    if (results.some((result) => {
      return normalizeSearchText(result.localName) === normalized
        || normalizeSearchText(result.fqName).includes(normalized);
    })) {
      matches.push(`symbol:${interestingSymbol}`);
    }
  }

  for (const interestingFile of interestingFiles) {
    const normalized = normalizeSearchText(interestingFile);

    if (results.some((result) => normalizeSearchText(result.filePath).includes(normalized))) {
      matches.push(`file:${interestingFile}`);
    }
  }

  return matches;
}

function collectUniqueInOrder<T>(values: readonly T[]): T[] {
  const uniqueValues: T[] = [];
  const seen = new Set<T>();

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    uniqueValues.push(value);
  }

  return uniqueValues;
}

function collectSortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function compareValidationFindings(
  left: ValidationFinding,
  right: ValidationFinding,
): number {
  return severityRank(left.severity) - severityRank(right.severity)
    || left.code.localeCompare(right.code)
    || (left.query ?? "").localeCompare(right.query ?? "");
}

function severityRank(severity: ValidationFindingSeverity): number {
  switch (severity) {
    case ValidationFindingSeverity.Error:
      return 0;
    case ValidationFindingSeverity.Warning:
      return 1;
    case ValidationFindingSeverity.Info:
      return 2;
  }
}

function queryNoCandidateSeverity(
  category: ValidationQueryCategory,
): ValidationFindingSeverity {
  switch (category) {
    case ValidationQueryCategory.ExactSymbolApiLookup:
    case ValidationQueryCategory.WorkflowTracing:
    case ValidationQueryCategory.ScientificDomainConcept:
    case ValidationQueryCategory.PythonCythonBoundary:
      return ValidationFindingSeverity.Warning;
    case ValidationQueryCategory.FileModuleDiscovery:
    case ValidationQueryCategory.AmbiguousStress:
    case ValidationQueryCategory.Custom:
      return ValidationFindingSeverity.Info;
  }
}

function makeSkippedControlledChangeSummary(
  _reason: string,
): ControlledChangeValidationSummary {
  return {
    status: ValidationStatusEnum.Skipped,
    usedTemporaryCopy: false,
    sourceRepoMutated: false,
  };
}

function computeValidationRunId(input: {
  repoRoot: string;
  queries: readonly ValidationQueryDefinition[];
  interestingSymbols: readonly string[];
  interestingFiles: readonly string[];
  maxResults: number;
  maxBudgetCharacters: number;
  controlledChange: boolean;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      repoRoot: input.repoRoot,
      queries: input.queries,
      interestingSymbols: input.interestingSymbols,
      interestingFiles: input.interestingFiles,
      maxResults: input.maxResults,
      maxBudgetCharacters: input.maxBudgetCharacters,
      controlledChange: input.controlledChange,
    }))
    .digest("hex");
}

async function assertDirectoryExists(targetPath: string): Promise<void> {
  const targetStats = await stat(targetPath);

  if (!targetStats.isDirectory()) {
    throw new Error(`Repo not found: ${targetPath}`);
  }
}
