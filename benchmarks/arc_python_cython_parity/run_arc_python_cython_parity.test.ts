import assert from "node:assert/strict";
import { test } from "bun:test";

import { renderParityMarkdown } from "./run_arc_python_cython_parity";
import type { RealRepoValidationReport } from "../../src/validation/types";

function makeReport(): RealRepoValidationReport {
  return {
    schemaVersion: "1.0.0",
    repoRoot: "/repos/example",
    validationRunId: "run-abc123",
    querySetSource: "/repos/example/queries.md",
    queries: [],
    interestingSymbols: ["Graph"],
    interestingFiles: ["arc/molecule/graph.pyx"],
    summaryCounts: {
      indexedFileCount: 212,
      indexedPythonFileCount: 196,
      indexedCythonFileCount: 16,
      indexedSymbolCount: 5153,
      indexedPythonSymbolCount: 4686,
      indexedCythonSymbolCount: 467,
      indexedEdgeCount: 10413,
      parseFailureCount: 0,
      readFailureCount: 0,
      persistenceFailureCount: 0,
      queryCount: 1,
      queriesWithCandidates: 1,
      queriesWithCapsules: 1,
      queriesWithSourceBackedPivots: 1,
      exactQueriesWithExpectedSurface: 1,
      exactQueriesImprovedAgainstBaseline: 0,
      exactQueriesRegressedAgainstBaseline: 0,
      narrowQueriesImprovedAgainstBaseline: 0,
      narrowQueriesRegressedAgainstBaseline: 0,
      boundaryQueriesWithCythonCandidates: 0,
      boundaryQueriesImprovedAgainstBaseline: 0,
      boundaryQueriesRegressedAgainstBaseline: 0,
      broadQueriesImprovedAgainstBaseline: 0,
      broadQueriesRegressedAgainstBaseline: 0,
      broadQueriesWithLikelyTestTopCandidate: 0,
      broadQueriesTestMisrankingImprovedAgainstBaseline: 0,
      broadQueriesTestMisrankingRegressedAgainstBaseline: 0,
    },
    structuralEvidence: {
      edgeCountsByType: [
        { edgeType: "contains", count: 3388 },
        { edgeType: "calls", count: 5228 },
      ],
      edgeCountsByLanguage: [
        { language: "python", edgeType: "calls", count: 5175 },
        { language: "cython", edgeType: "calls", count: 53 },
      ],
      crossLanguageEdgeCounts: [
        { srcLanguage: "cython", dstLanguage: "python", edgeType: "calls", count: 3 },
      ],
      impactProbes: [
        {
          symbolFqn: "arc/molecule/kekulize.pyx::kekulize",
          resolved: true,
          language: "cython",
          dependentSymbolCount: 4,
          dependentFileCount: 2,
          observedEdgeTypes: ["calls", "contains"],
          foundRealDependents: true,
        },
        {
          symbolFqn: "arc/molecule/missing.pyx::nope",
          resolved: false,
          language: null,
          dependentSymbolCount: 0,
          dependentFileCount: 0,
          observedEdgeTypes: [],
          foundRealDependents: false,
        },
      ],
      logicFlowProbes: [
        {
          start: "arc/molecule/vf2.pyx::VF2.find_isomorphism",
          end: "arc/molecule/vf2.pyx::VF2.match",
          startResolved: true,
          endResolved: true,
          reachable: true,
          pathCount: 1,
          callFlowEvidenceAvailable: true,
          callFlowEvidenceUsed: true,
        },
        {
          start: "arc/molecule/molecule.py::Molecule.kekulize",
          end: "arc/molecule/kekulize.pyx::kekulize",
          startResolved: true,
          endResolved: true,
          reachable: false,
          pathCount: 0,
          callFlowEvidenceAvailable: true,
          callFlowEvidenceUsed: false,
        },
      ],
    },
    areaResults: {
      indexingAndPersistence: { status: "pass", summary: "" },
      representativePythonQueries: { status: "pass", summary: "" },
      representativeCythonQueries: { status: "pass", summary: "" },
      graphAwareReranking: { status: "pass", summary: "" },
      capsuleAssembly: { status: "pass", summary: "" },
      sourceBackedCapsuleBehavior: { status: "pass", summary: "" },
      controlledChange: { status: "pass", summary: "" },
      handoffPayloadGeneration: { status: "pass", summary: "" },
      determinism: { status: "pass", summary: "" },
    },
    queryResults: [
      {
        query: "kekulize",
        category: "exact_symbol_api_lookup",
        sectionTitle: "Exact symbol / API lookup",
        intent: "symbol_lookup" as RealRepoValidationReport["queryResults"][number]["intent"],
        routingProfileId: "default",
        hasCandidates: true,
        pythonCandidateCount: 1,
        cythonCandidateCount: 2,
        rerankedResults: [
          {
            symbolId: "s1",
            filePath: "arc/molecule/molecule.py",
            fqName: "arc/molecule/molecule.py::Molecule.kekulize",
            localName: "kekulize",
            kind: "method",
            language: "python",
            likelyTestCandidate: false,
            lexicalScore: 1,
            graphScore: 1,
            finalScore: 2,
            matchedFields: [],
          },
        ],
        graphOrderingDeterministic: true,
        capsuleDeterministic: true,
        handoffDeterministic: true,
        surfaceReview: { expectedSurfaceObserved: true, interestingMatches: ["kekulize"] },
        capsule: {
          built: true,
          pivotCount: 1,
          supportCount: 1,
          sourceBackedPivotCount: 1,
          truncated: false,
          compressed: false,
          items: [],
        },
        handoff: {
          built: true,
          itemCount: 1,
          selectedIntent: "symbol_lookup" as RealRepoValidationReport["queryResults"][number]["handoff"]["selectedIntent"],
          schemaName: "vtrace.handoff" as RealRepoValidationReport["queryResults"][number]["handoff"]["schemaName"],
          schemaVersion: "1" as RealRepoValidationReport["queryResults"][number]["handoff"]["schemaVersion"],
          trustStatus: null,
        },
      },
    ],
    controlledChange: {
      status: "pass",
      usedTemporaryCopy: true,
      sourceRepoMutated: false,
      targetFilePath: "arc/parser/adapter.py",
      query: "parse_e_elect",
      fileChangeCounts: { added: 0, removed: 0, modified: 1, unchanged: 211 },
      symbolChangeCounts: { added: 0, removed: 0, modified: 1, unchanged: 5152 },
      modifiedFilePaths: ["arc/parser/adapter.py"],
      modifiedSymbols: [],
      capsuleTrustStatus: "stale" as RealRepoValidationReport["controlledChange"]["capsuleTrustStatus"],
    },
    topFindings: [],
    classifiedGaps: [
      {
        category: "accepted limitation" as RealRepoValidationReport["classifiedGaps"][number]["category"],
        findingCode: "limitation.logic_flow_probe_unreachable",
        severity: "info" as RealRepoValidationReport["classifiedGaps"][number]["severity"],
        summary: "unreachable",
        query: undefined,
        rationale: "documented",
      },
    ],
    rc1ReadinessRecommendation: "ready with known limitations",
  };
}

test("parity markdown renders the required report sections deterministically", () => {
  const report = makeReport();
  const first = renderParityMarkdown(report);
  const second = renderParityMarkdown(report);

  assert.equal(first, second);
  assert.match(first, /# ARC Python\/Cython parity validation report/);
  assert.match(first, /Repo path: `\/repos\/example`/);
  assert.match(first, /Source fingerprint \(validation run id\): `run-abc123`/);
  assert.match(first, /Files indexed: 212 \(python 196, cython 16\)/);
  assert.match(first, /Edges indexed: 10413/);
});

test("parity markdown includes structural, impact, and logic-flow evidence", () => {
  const md = renderParityMarkdown(makeReport());

  // Edges-by-type and by-language tables.
  assert.match(md, /\| calls \| 5228 \|/);
  assert.match(md, /\| python \| calls \| 5175 \|/);
  // Cross-language edge row.
  assert.match(md, /\| cython \| python \| calls \| 3 \|/);
  // Impact probe: resolved with dependents, plus the unresolved probe.
  assert.match(md, /arc\/molecule\/kekulize\.pyx::kekulize \| yes \| cython \| 4 \| 2 \| calls, contains \| yes \|/);
  assert.match(md, /arc\/molecule\/missing\.pyx::nope \| no \| n\/a \| 0 \| 0 \| \(none\) \| no \|/);
  // Reachable logic-flow probe uses call evidence; wrapper->kernel does not.
  assert.match(md, /VF2\.find_isomorphism \| arc\/molecule\/vf2\.pyx::VF2\.match \| yes \| 1 \| yes \| yes \|/);
  assert.match(md, /Molecule\.kekulize \| arc\/molecule\/kekulize\.pyx::kekulize \| no \| 0 \| yes \| no \|/);
  // Classified gap surfaced.
  assert.match(md, /limitation\.logic_flow_probe_unreachable/);
});

test("parity markdown reports the first non-test rank for queries", () => {
  const md = renderParityMarkdown(makeReport());

  // kekulize query: top candidate is non-test, so first non-test rank is 1.
  assert.match(md, /\| kekulize \| exact_symbol_api_lookup \| 1 \| 2 \| yes \| 1 \|/);
});
