import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { formatValidationReport } from "./formatReport";
import { classifyGaps } from "./classifyGaps";
import { runRealRepoValidation } from "./runRealRepoValidation";
import {
  ValidationFindingSeverity,
  ValidationGapCategory,
  ValidationQueryCategory,
  type ValidationQueryDefinition,
} from "./types";
import { withMixedPyCythonRepo } from "../testing/mixedPyCythonFixture";

const FIXTURE_QUERIES: readonly ValidationQueryDefinition[] = [
  {
    query: "CalibrationRun",
    category: ValidationQueryCategory.ExactSymbolApiLookup,
    sectionTitle: "Fixture exact lookup",
  },
  {
    query: "diffuse_profile",
    category: ValidationQueryCategory.ExactSymbolApiLookup,
    sectionTitle: "Fixture exact lookup",
  },
  {
    query: "concentration",
    category: ValidationQueryCategory.PythonCythonBoundary,
    sectionTitle: "Fixture boundary",
  },
  {
    query: "background",
    category: ValidationQueryCategory.WorkflowTracing,
    sectionTitle: "Fixture workflow",
  },
];

const BOUNDARY_FIXTURE_QUERIES: readonly ValidationQueryDefinition[] = [
  {
    query: "cython",
    category: ValidationQueryCategory.PythonCythonBoundary,
    sectionTitle: "Fixture boundary",
  },
  {
    query: "compiled helper",
    category: ValidationQueryCategory.PythonCythonBoundary,
    sectionTitle: "Fixture boundary",
  },
  {
    query: "cimport",
    category: ValidationQueryCategory.PythonCythonBoundary,
    sectionTitle: "Fixture boundary",
  },
];

const BROAD_FIXTURE_QUERIES: readonly ValidationQueryDefinition[] = [
  {
    query: "run calibrated diffusion",
    category: ValidationQueryCategory.WorkflowTracing,
    sectionTitle: "Fixture workflow",
  },
  {
    query: "detector window geometry",
    category: ValidationQueryCategory.ScientificDomainConcept,
    sectionTitle: "Fixture concept",
  },
  {
    query: "background estimation workflow",
    category: ValidationQueryCategory.WorkflowTracing,
    sectionTitle: "Fixture workflow",
  },
];

const TEST_AWARE_FIXTURE_QUERIES: readonly ValidationQueryDefinition[] = [
  {
    query: "how are transition state jobs validated",
    category: ValidationQueryCategory.WorkflowTracing,
    sectionTitle: "Fixture workflow",
  },
];

const NARROW_FIXTURE_QUERIES: readonly ValidationQueryDefinition[] = [
  {
    query: "run_app",
    category: ValidationQueryCategory.ExactSymbolApiLookup,
    sectionTitle: "Fixture exact lookup",
  },
  {
    query: "species_to_dict",
    category: ValidationQueryCategory.ExactSymbolApiLookup,
    sectionTitle: "Fixture exact lookup",
  },
  {
    query: "fast parser",
    category: ValidationQueryCategory.PythonCythonBoundary,
    sectionTitle: "Fixture boundary",
  },
  {
    query: "low level utility",
    category: ValidationQueryCategory.PythonCythonBoundary,
    sectionTitle: "Fixture boundary",
  },
  {
    query: "where is the output parsed",
    category: ValidationQueryCategory.WorkflowTracing,
    sectionTitle: "Fixture workflow",
  },
];

test("validation runner produces a structured deterministic report on controlled input", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const report = await runRealRepoValidation({
      repoRoot,
      queries: FIXTURE_QUERIES,
      interestingSymbols: ["CalibrationRun", "diffuse_profile"],
      interestingFiles: ["src/spectra_lab/analysis/background.py"],
      controlledChange: {
        targetFilePath: "src/spectra_lab/analysis/background.py",
        query: "estimate_background",
      },
    });

    assert.equal(report.schemaVersion, "1.0.0");
    assert.equal(report.repoRoot, repoRoot);
    assert.equal(report.queries.length, FIXTURE_QUERIES.length);
    assert.equal(report.summaryCounts.indexedFileCount > 0, true);
    assert.equal(report.summaryCounts.indexedSymbolCount > 0, true);
    assert.equal(report.areaResults.indexingAndPersistence.status, "pass");
    assert.equal(report.areaResults.handoffPayloadGeneration.status, "pass");
    assert.equal(report.areaResults.determinism.status, "pass");
    assert.equal(report.controlledChange.usedTemporaryCopy, true);
    assert.equal(
      report.rc1ReadinessRecommendation === "ready"
        || report.rc1ReadinessRecommendation === "ready with known limitations"
        || report.rc1ReadinessRecommendation === "not ready",
      true,
    );
    assert.deepEqual(JSON.parse(formatValidationReport(report)), report);
  });
});

test("repeated identical validation input produces identical report structure", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const options = {
      repoRoot,
      queries: FIXTURE_QUERIES,
      controlledChange: {
        targetFilePath: "src/spectra_lab/analysis/background.py",
        query: "estimate_background",
      },
    } as const;

    const first = await runRealRepoValidation(options);
    const second = await runRealRepoValidation(options);

    assert.deepEqual(second, first);
  });
}, 15_000);

test("gap classification is explicit and deterministic", () => {
  const first = classifyGaps([
    {
      code: "indexing.parse_failures_detected",
      severity: ValidationFindingSeverity.Warning,
      summary: "parse failures",
    },
    {
      code: "retrieval.exact_query_expected_surface_missing",
      severity: ValidationFindingSeverity.Warning,
      summary: "missing surface",
      query: "ARCSpecies",
    },
    {
      code: "retrieval.broad_query_test_candidate_outranks_non_test",
      severity: ValidationFindingSeverity.Warning,
      summary: "test outranks production",
      query: "how are transition state jobs validated",
    },
    {
      code: "capsule.no_source_backed_pivots",
      severity: ValidationFindingSeverity.Warning,
      summary: "no source backed pivots",
    },
    {
      code: "limitation.controlled_change_skipped",
      severity: ValidationFindingSeverity.Info,
      summary: "skipped",
    },
  ]);
  const second = classifyGaps([
    {
      code: "indexing.parse_failures_detected",
      severity: ValidationFindingSeverity.Warning,
      summary: "parse failures",
    },
    {
      code: "retrieval.exact_query_expected_surface_missing",
      severity: ValidationFindingSeverity.Warning,
      summary: "missing surface",
      query: "ARCSpecies",
    },
    {
      code: "retrieval.broad_query_test_candidate_outranks_non_test",
      severity: ValidationFindingSeverity.Warning,
      summary: "test outranks production",
      query: "how are transition state jobs validated",
    },
    {
      code: "capsule.no_source_backed_pivots",
      severity: ValidationFindingSeverity.Warning,
      summary: "no source backed pivots",
    },
    {
      code: "limitation.controlled_change_skipped",
      severity: ValidationFindingSeverity.Info,
      summary: "skipped",
    },
  ]);

  assert.deepEqual(second, first);
  assert.deepEqual(
    first.map((gap) => [gap.findingCode, gap.category]),
    [
      ["limitation.controlled_change_skipped", ValidationGapCategory.AcceptedLimitation],
      ["capsule.no_source_backed_pivots", ValidationGapCategory.CapsuleShapingGap],
      ["indexing.parse_failures_detected", ValidationGapCategory.ParserFrontendGap],
      ["retrieval.broad_query_test_candidate_outranks_non_test", ValidationGapCategory.RetrievalRerankingGap],
      ["retrieval.exact_query_expected_surface_missing", ValidationGapCategory.RetrievalRerankingGap],
    ],
  );
});

test("controlled-change validation uses a temporary copy and does not mutate the source repo", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const targetFilePath = path.join(repoRoot, "src/spectra_lab/analysis/background.py");
    const before = await readFile(targetFilePath, "utf8");
    const report = await runRealRepoValidation({
      repoRoot,
      queries: FIXTURE_QUERIES,
      controlledChange: {
        targetFilePath: "src/spectra_lab/analysis/background.py",
        query: "estimate_background",
      },
    });
    const after = await readFile(targetFilePath, "utf8");

    assert.equal(report.controlledChange.usedTemporaryCopy, true);
    assert.equal(report.controlledChange.sourceRepoMutated, false);
    assert.equal(after, before);
  });
});

test("validation report includes a structured RC1 readiness recommendation", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const report = await runRealRepoValidation({
      repoRoot,
      queries: FIXTURE_QUERIES,
    });

    assert.equal(typeof report.rc1ReadinessRecommendation, "string");
    assert.equal(
      ["ready", "ready with known limitations", "not ready"].includes(
        report.rc1ReadinessRecommendation,
      ),
      true,
    );
  });
});

test("markdown query files preserve validation categories deterministically", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vtrace-validation-queries-"));
    const queryFilePath = path.join(tempDir, "queries.md");

    try {
      await writeFile(
        queryFilePath,
        [
          "# Queries",
          "",
          "## Query Set",
          "",
          "### Exact symbol / API lookup",
          "- CalibrationRun",
          "",
          "### Python/Cython boundary queries",
          "- concentration",
          "",
          "## Optional expected hotspots",
          "- ignored",
          "",
        ].join("\n"),
      );

      const report = await runRealRepoValidation({
        repoRoot,
        queriesFilePath: queryFilePath,
      });

      assert.deepEqual(
        report.queries.map((query) => [query.query, query.category]),
        [
          ["CalibrationRun", ValidationQueryCategory.ExactSymbolApiLookup],
          ["concentration", ValidationQueryCategory.PythonCythonBoundary],
        ],
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

test("validation report records deterministic boundary benchmark improvement details", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const report = await runRealRepoValidation({
      repoRoot,
      queries: BOUNDARY_FIXTURE_QUERIES,
      enableControlledChange: false,
    });

    assert.equal(report.areaResults.representativeCythonQueries.status, "pass");
    assert.equal(report.summaryCounts.boundaryQueriesImprovedAgainstBaseline > 0, true);
    assert.equal(report.summaryCounts.boundaryQueriesRegressedAgainstBaseline, 0);

    for (const result of report.queryResults) {
      assert.notEqual(result.boundaryBenchmark, undefined);
      assert.equal(result.boundaryBenchmark!.anyCythonCandidate, true);
      assert.equal(result.boundaryBenchmark!.firstCythonCandidateRank !== null, true);
      assert.equal(result.boundaryBenchmark!.improvedAgainstBaseline, true);
      assert.equal(result.boundaryBenchmark!.regressedAgainstBaseline, false);
    }
  });
});

test("validation report records deterministic broad-query benchmark improvement details", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const report = await runRealRepoValidation({
      repoRoot,
      queries: BROAD_FIXTURE_QUERIES,
      enableControlledChange: false,
    });

    assert.equal(report.summaryCounts.broadQueriesImprovedAgainstBaseline > 0, true);
    assert.equal(report.summaryCounts.broadQueriesRegressedAgainstBaseline, 0);

    for (const result of report.queryResults) {
      assert.notEqual(result.broadBenchmark, undefined);
      assert.equal(result.hasCandidates, true);
      assert.equal(result.broadBenchmark!.regressedAgainstBaseline, false);
    }

    const improvedQueries = report.queryResults
      .filter((result) => result.broadBenchmark?.improvedAgainstBaseline === true)
      .map((result) => result.query)
      .sort();

    assert.deepEqual(improvedQueries, [
      "background estimation workflow",
      "detector window geometry",
    ]);
  });
});

test("validation report records deterministic test-aware benchmark improvement details", async () => {
  await withTestAwareValidationRepo(async (repoRoot) => {
    const report = await runRealRepoValidation({
      repoRoot,
      queries: TEST_AWARE_FIXTURE_QUERIES,
      maxResults: 1,
      enableControlledChange: false,
    });

    assert.equal(report.summaryCounts.broadQueriesWithLikelyTestTopCandidate, 0);
    assert.equal(report.summaryCounts.broadQueriesTestMisrankingImprovedAgainstBaseline, 1);
    assert.equal(report.summaryCounts.broadQueriesTestMisrankingRegressedAgainstBaseline, 0);
    assert.equal(report.topFindings.some((finding) => finding.code === "retrieval.broad_query_test_candidate_outranks_non_test"), false);

    const result = report.queryResults[0];

    assert.notEqual(result, undefined);
    assert.notEqual(result!.testAwareBenchmark, undefined);
    assert.equal(result!.rerankedResults[0]?.likelyTestCandidate, false);
    assert.equal(result!.testAwareBenchmark!.baselineTopCandidateLikelyTest, true);
    assert.equal(result!.testAwareBenchmark!.currentTopCandidateLikelyTest, false);
    assert.equal(result!.testAwareBenchmark!.baselineFirstNonTestCandidateRank, null);
    assert.equal(result!.testAwareBenchmark!.firstNonTestCandidateRank, 1);
    assert.equal(result!.testAwareBenchmark!.improvedAgainstBaseline, true);
    assert.equal(result!.testAwareBenchmark!.regressedAgainstBaseline, false);
  });
});

test("validation report records deterministic narrow-query benchmark improvement details", async () => {
  await withNarrowValidationRepo(async (repoRoot) => {
    const report = await runRealRepoValidation({
      repoRoot,
      queries: NARROW_FIXTURE_QUERIES,
      maxResults: 6,
      enableControlledChange: false,
    });

    assert.equal(report.summaryCounts.narrowQueriesImprovedAgainstBaseline > 0, true);
    assert.equal(report.summaryCounts.narrowQueriesRegressedAgainstBaseline, 0);

    const byQuery = new Map(report.queryResults.map((result) => [result.query, result]));
    const runApp = byQuery.get("run_app");
    const speciesToDict = byQuery.get("species_to_dict");
    const fastParser = byQuery.get("fast parser");
    const lowLevelUtility = byQuery.get("low level utility");
    const outputParsed = byQuery.get("where is the output parsed");

    assert.notEqual(runApp, undefined);
    assert.notEqual(speciesToDict, undefined);
    assert.notEqual(fastParser, undefined);
    assert.notEqual(lowLevelUtility, undefined);
    assert.notEqual(outputParsed, undefined);

    assert.equal(runApp!.narrowBenchmark?.improvedAgainstBaseline, true);
    assert.equal(runApp!.narrowBenchmark?.regressedAgainstBaseline, false);
    assert.equal(speciesToDict!.rerankedResults[0]?.localName, "as_dict");
    assert.equal(speciesToDict!.narrowBenchmark?.improvedAgainstBaseline, true);
    assert.equal(fastParser!.cythonCandidateCount > 0, true);
    assert.equal(fastParser!.narrowBenchmark?.improvedAgainstBaseline, true);
    assert.equal(lowLevelUtility!.cythonCandidateCount > 0, true);
    assert.equal(lowLevelUtility!.narrowBenchmark?.improvedAgainstBaseline, true);
    assert.equal(outputParsed!.hasCandidates, true);
    assert.equal(outputParsed!.rerankedResults[0]?.localName, "parse_output_file");
    assert.equal(outputParsed!.rerankedResults[0]?.likelyTestCandidate, false);
    assert.equal(outputParsed!.narrowBenchmark?.improvedAgainstBaseline, true);
  });
});

test("validation report records deterministic structural edge, impact, and logic-flow evidence", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const options = {
      repoRoot,
      queries: FIXTURE_QUERIES,
      enableControlledChange: false,
      impactProbeSymbols: [
        "src/spectra_lab/utils/grid.py::clamp_window",
        "src/spectra_lab/utils/grid.py::does_not_exist",
      ],
      logicFlowProbes: [
        {
          start: "src/spectra_lab/analysis/background.py::estimate_background",
          end: "src/spectra_lab/utils/grid.py::clamp_window",
        },
      ],
    } as const;

    const report = await runRealRepoValidation(options);
    const evidence = report.structuralEvidence;

    const callEdges = evidence.edgeCountsByType.find((entry) => entry.edgeType === "calls");
    const containsEdges = evidence.edgeCountsByType.find((entry) => entry.edgeType === "contains");
    assert.equal((callEdges?.count ?? 0) > 0, true);
    assert.equal((containsEdges?.count ?? 0) > 0, true);

    const pythonCallEdges = evidence.edgeCountsByLanguage.find(
      (entry) => entry.language === "python" && entry.edgeType === "calls",
    );
    assert.equal((pythonCallEdges?.count ?? 0) > 0, true);

    const clampProbe = evidence.impactProbes.find(
      (probe) => probe.symbolFqn === "src/spectra_lab/utils/grid.py::clamp_window",
    );
    assert.notEqual(clampProbe, undefined);
    assert.equal(clampProbe!.resolved, true);
    assert.equal(clampProbe!.language, "python");
    assert.equal(clampProbe!.foundRealDependents, true);

    const missingProbe = evidence.impactProbes.find(
      (probe) => probe.symbolFqn === "src/spectra_lab/utils/grid.py::does_not_exist",
    );
    assert.notEqual(missingProbe, undefined);
    assert.equal(missingProbe!.resolved, false);
    assert.equal(missingProbe!.foundRealDependents, false);

    const flowProbe = evidence.logicFlowProbes[0];
    assert.notEqual(flowProbe, undefined);
    assert.equal(flowProbe!.startResolved, true);
    assert.equal(flowProbe!.endResolved, true);
    assert.equal(flowProbe!.reachable, true);
    assert.equal(flowProbe!.callFlowEvidenceAvailable, true);
    assert.equal(flowProbe!.callFlowEvidenceUsed, true);

    const second = await runRealRepoValidation(options);
    assert.deepEqual(second.structuralEvidence, evidence);
  });
}, 20_000);

async function withTestAwareValidationRepo(
  fn: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vtrace-validation-test-aware-"));

  try {
    const repoRoot = path.join(tempDir, "repo");
    await mkdir(path.join(repoRoot, "src/workflows"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src/workflows/transitionStateValidation.ts"),
      [
        "export function checkTransitionStateJobs(jobBatch: string[]): string {",
        "  return jobBatch.join(\",\");",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repoRoot, "src/workflows/transitionStateValidation.test.ts"),
      [
        "import { checkTransitionStateJobs } from \"./transitionStateValidation\";",
        "",
        "export class TestTransitionStateValidation {",
        "  testValidateTransitionStateJobs(): string {",
        "    return checkTransitionStateJobs([\"ok\"]);",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    await fn(repoRoot);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function withNarrowValidationRepo(
  fn: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vtrace-validation-narrow-"));

  try {
    const repoRoot = path.join(tempDir, "repo");
    await mkdir(path.join(repoRoot, "src/app"), { recursive: true });
    await mkdir(path.join(repoRoot, "src/species"), { recursive: true });
    await mkdir(path.join(repoRoot, "src/parser"), { recursive: true });
    await mkdir(path.join(repoRoot, "src/core"), { recursive: true });

    await writeFile(
      path.join(repoRoot, "src/app/main.py"),
      [
        "class AppRuntime:",
        "    \"\"\"Main runtime entrypoint.\"\"\"",
        "",
        "    def execute(self) -> str:",
        "        return execute()",
        "",
        "",
        "def execute() -> str:",
        "    return \"ok\"",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repoRoot, "src/species/species.py"),
      [
        "def as_dict(species: dict[str, str]) -> dict[str, str]:",
        "    return dict(species)",
        "",
        "",
        "def from_dict(payload: dict[str, str]) -> dict[str, str]:",
        "    return dict(payload)",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repoRoot, "src/parser/adapter.py"),
      [
        "def parse_output_file(contents: str) -> list[str]:",
        "    \"\"\"Parse output records into normalized lines.\"\"\"",
        "    return [line.strip() for line in contents.splitlines() if line.strip()]",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repoRoot, "src/parser/output_test.py"),
      [
        "from .adapter import parse_output_file",
        "",
        "",
        "class TestParseOutput:",
        "    def test_parse_output_file(self) -> list[str]:",
        "        return parse_output_file(\"value\")",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repoRoot, "src/core/parser_kernel.pyx"),
      [
        "def parse_buffer(char* buffer):",
        "    return buffer",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repoRoot, "src/core/utility_core.pyx"),
      [
        "def fast_lookup(object value):",
        "    return value",
        "",
      ].join("\n"),
    );

    await fn(repoRoot);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
