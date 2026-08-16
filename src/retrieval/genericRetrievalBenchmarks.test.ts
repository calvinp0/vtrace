import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { persistParseResult } from "../db/persistParseResult";
import { persistObservation } from "../session/repositories/observationsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { createTestProductStores } from "../testing/productStores";
import { SymbolKind } from "../domain/types";
import { getImpactGraph } from "../impact/getImpactGraph";
import { indexProject } from "../indexer/indexProject";
import { ObservationKind, ObservationSource } from "../observations/types";
import {
  createActiveProjectRule,
  generateProjectRuleCandidates,
  selectRelevantProjectRules,
} from "../projectRules/projectRules";
import { searchMemory } from "../observations/searchMemory";
import { withMixedPyCythonRepo } from "../testing/mixedPyCythonFixture";
import { routeQuery } from "../intent/routeQuery";
import { searchSymbolsGraph } from "./searchSymbolsGraph";
import { makeSearchParseResult, type SeedFileSpec } from "./testUtils";
import type { GraphSearchResult } from "./types";

type BenchmarkCategory =
  | "exact_symbol"
  | "broad_workflow"
  | "concept_lookup"
  | "file_module_discovery"
  | "python_cython_boundary"
  | "ambiguous_stress"
  | "impact_graph"
  | "memory_rule";

type FailureClassification =
  | "parser_frontend_gap"
  | "retrieval_reranking_gap"
  | "capsule_shaping_gap"
  | "memory_rule_gap"
  | "accepted_static_limitation"
  | "fixture_gap";

interface RetrievalBenchmarkCase {
  readonly name: string;
  readonly category: BenchmarkCategory;
  readonly query: string;
  readonly fixture: string;
  readonly mustIncludeSymbols?: readonly string[];
  readonly nearTopSymbols?: readonly string[];
  readonly mustIncludeFiles?: readonly string[];
  readonly acceptedLimitations: readonly FailureClassification[];
}

const RETRIEVAL_BENCHMARK_CASES: readonly RetrievalBenchmarkCase[] = [
  {
    name: "exact module constant lookup",
    category: "exact_symbol",
    query: "DEFAULT_BACKEND",
    fixture: "generic-product-fixture",
    mustIncludeSymbols: ["src/config/settings.py::DEFAULT_BACKEND"],
    nearTopSymbols: ["src/config/settings.py::DEFAULT_BACKEND"],
    acceptedLimitations: [],
  },
  {
    name: "exact class member lookup",
    category: "exact_symbol",
    query: "Job.build",
    fixture: "generic-product-fixture",
    mustIncludeSymbols: ["src/jobs/factory.py::Job.build"],
    nearTopSymbols: ["src/jobs/factory.py::Job.build"],
    acceptedLimitations: [],
  },
  {
    name: "broad pipeline workflow tracing",
    category: "broad_workflow",
    query: "how does the pipeline assemble context",
    fixture: "generic-product-fixture",
    mustIncludeSymbols: ["src/pipeline/orchestrator.ts::assemblePipelineContext"],
    acceptedLimitations: [],
  },
  {
    name: "concept lookup for stored payload expansion",
    category: "concept_lookup",
    query: "persistent stored payload expansion",
    fixture: "generic-product-fixture",
    mustIncludeSymbols: ["src/runPipeline/deferredVexpStore.ts::persistVrefRecord"],
    acceptedLimitations: [],
  },
  {
    name: "concept lookup for auto reindex failure",
    category: "concept_lookup",
    query: "auto reindex failure state",
    fixture: "generic-product-fixture",
    mustIncludeSymbols: ["src/runtime/fileWatcher.ts::recordAutoReindexFailure"],
    acceptedLimitations: [],
  },
  {
    name: "file discovery for Python references",
    category: "file_module_discovery",
    query: "where Python references extracted",
    fixture: "generic-product-fixture",
    mustIncludeFiles: ["src/parsers/pythonParser.ts"],
    acceptedLimitations: [],
  },
  {
    name: "ambiguous status query remains deterministic",
    category: "ambiguous_stress",
    query: "status",
    fixture: "generic-product-fixture",
    acceptedLimitations: ["accepted_static_limitation"],
  },
];

test("generic retrieval benchmark case metadata stays explicit and deterministic", () => {
  const names = RETRIEVAL_BENCHMARK_CASES.map((benchmarkCase) => benchmarkCase.name);

  assert.equal(new Set(names).size, names.length);

  for (const benchmarkCase of RETRIEVAL_BENCHMARK_CASES) {
    assert.notEqual(benchmarkCase.query.trim(), "");
    assert.notEqual(benchmarkCase.fixture.trim(), "");
    assert.deepEqual(
      benchmarkCase.acceptedLimitations,
      [...benchmarkCase.acceptedLimitations].sort(),
    );
  }
});

test("generic retrieval/reranking benchmarks cover exact, broad, concept, file, and ambiguous queries", () => {
  const db = openIndexerDatabase();
  const stores = createTestProductStores(db);

  try {
    seedGenericRetrievalBenchmarkFixture(db);

    for (const benchmarkCase of RETRIEVAL_BENCHMARK_CASES) {
      const first = routeQuery(db, benchmarkCase.query, { maxResults: 8 }).rerankedResults;
      const second = routeQuery(db, benchmarkCase.query, { maxResults: 8 }).rerankedResults;

      assert.deepEqual(
        toStableResultSummary(second),
        toStableResultSummary(first),
        `${benchmarkCase.name} should be deterministic`,
      );

      assertIncludesSymbols(benchmarkCase, first);
      assertIncludesFiles(benchmarkCase, first);
      assertNearTopSymbols(benchmarkCase, first);
    }
  } finally {
    db.close();
  }
});

test("mixed Python/Cython boundary benchmark remains synthetic and deterministic", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const db = openIndexerDatabase();
    const stores = createTestProductStores(db);

    try {
      await indexProject({ repoRoot, db });

      const boundaryCase: RetrievalBenchmarkCase = {
        name: "Cython-exposed helper boundary lookup",
        category: "python_cython_boundary",
        query: "Cython-exposed helper",
        fixture: "mixed-py-cython-fixture",
        mustIncludeFiles: [
          "src/spectra_lab/kernels/diffusion_kernels.pyx",
          "src/spectra_lab/utils/grid.py",
        ],
        acceptedLimitations: ["accepted_static_limitation"],
      };
      const first = routeQuery(db, boundaryCase.query, { maxResults: 8 }).rerankedResults;
      const second = routeQuery(db, boundaryCase.query, { maxResults: 8 }).rerankedResults;

      assert.deepEqual(toStableResultSummary(second), toStableResultSummary(first));
      assertIncludesFiles(boundaryCase, first);
    } finally {
      db.close();
    }
  });
});

test("impact graph benchmark captures graph-backed dependents for Python references", async () => {
  await withPythonImpactBenchmarkFixture(async (repoRoot) => {
    const db = openIndexerDatabase();
    const stores = createTestProductStores(db);

    try {
      await indexProject({ repoRoot, db });

      const impactCase: RetrievalBenchmarkCase = {
        name: "what depends on DEFAULT_BACKEND",
        category: "impact_graph",
        query: "what depends on DEFAULT_BACKEND",
        fixture: "python-impact-fixture",
        mustIncludeSymbols: ["src/pkg/runner.py::run"],
        acceptedLimitations: [],
      };
      const result = getImpactGraph(db, {
        symbolFqn: "src/pkg/config.py::DEFAULT_BACKEND",
        depth: 2,
        format: "list",
      });

      assert.equal(result.ok, true);

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      const dependentFqNames = result.output.nodes
        .filter((node) => node.distance > 0)
        .map((node) => node.fqName);

      for (const fqName of impactCase.mustIncludeSymbols ?? []) {
        assert.ok(
          dependentFqNames.includes(fqName),
          `${impactCase.name} expected ${fqName}, got ${JSON.stringify(dependentFqNames)}`,
        );
      }
      assert.ok(result.output.coverage.observedEdgeTypes.includes("references"));
    } finally {
      db.close();
    }
  });
});

test("memory and rule benchmark keeps active guidance distinct from candidates", () => {
  const db = openIndexerDatabase();
  const stores = createTestProductStores(db);
  const repoRoot = "/synthetic/retrieval-benchmark";

  try {
    const observation = persistObservation(stores, {
      repoRoot,
      sessionId: "benchmark-session",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Decision: V-REF persistence stores payload truth",
      body: "Persistent V-REF expansion must return stored payloads, not recomputed disk contents.",
      queryText: "what previous decision mentioned V-REF persistence",
      createdAtMs: 100,
      linkedFilePaths: ["src/runPipeline/deferredVexpStore.ts"],
      linkedFqNames: ["src/runPipeline/deferredVexpStore.ts::persistVrefRecord"],
    });
    createActiveProjectRule(stores.session, {
      repoRoot,
      summary: "Keep watcher behavior explicit and stale state visible.",
      files: ["src/runtime/fileWatcher.ts"],
      terms: ["watcher", "behavior", "stale", "visible"],
      nowMs: 200,
    });

    for (const createdAtMs of [300, 400, 500]) {
      persistObservation(stores, {
        repoRoot,
        kind: ObservationKind.Insight,
        source: ObservationSource.Manual,
        summary: `Docs tests convention ${createdAtMs}`,
        body: `Repeated evidence links docs and tests updates, ordinal ${createdAtMs}.`,
        queryText: "docs tests convention",
        createdAtMs,
        linkedFilePaths: ["docs/testing.md"],
      });
    }

    const generated = generateProjectRuleCandidates(stores.session, { repoRoot, nowMs: 600 });
    const memoryResults = searchMemory(stores, {
      query: "what previous decision mentioned V-REF persistence",
      maxResults: 4,
    });
    const selectedRules = selectRelevantProjectRules(stores.session, {
      repoRoot,
      query: "show project convention about watcher behavior",
      maxActive: 4,
      maxCandidates: 4,
    });
    const selectedCandidateRules = selectRelevantProjectRules(stores.session, {
      repoRoot,
      query: "docs tests convention",
      maxActive: 4,
      maxCandidates: 4,
    });

    assert.equal(memoryResults[0]?.observation.id, observation.id);
    assert.equal(selectedRules.active[0]?.rule.summary, "Keep watcher behavior explicit and stale state visible.");
    assert.equal(generated.created.length, 1);
    assert.equal(selectedCandidateRules.active.length, 0);
    assert.equal(selectedCandidateRules.candidates[0]?.rule.id, generated.created[0]?.id);
  } finally {
    db.close();
  }
});

test("route-oriented broad prose surfaces sibling files without fabricating path signals", () => {
  const db = openIndexerDatabase();
  const stores = createTestProductStores(db);

  try {
    for (const file of SCIENTIFIC_ROUTES_FIXTURE) {
      persistParseResult(db, makeSearchParseResult(file));
    }

    const query = "Refactor TCKDB scientific read responses to add shared helper for"
      + " omitting trust unless include-trust across calculation kinetics thermo statmech transport"
      + " detail routes. Need find duplicated include-trust model_dump exclude trust response"
      + " boundary logic.";
    const routed = routeQuery(db, query, { maxResults: 10 });
    const filePaths = new Set(routed.rerankedResults.map((result) => result.filePath));
    const expectedSiblings = [
      "backend/app/api/routes/scientific/kinetics.py",
      "backend/app/api/routes/scientific/thermo.py",
      "backend/app/api/routes/scientific/calculations.py",
      "backend/app/api/routes/scientific/statmech.py",
      "backend/app/api/routes/scientific/transport.py",
    ];
    const siblingHits = expectedSiblings.filter((path) => filePaths.has(path));

    assert.ok(
      siblingHits.length >= 3,
      `expected at least 3 scientific route siblings, got ${JSON.stringify([...filePaths].sort())}`,
    );

    const baseline = routeQuery(db, query, {
      maxResults: 10,
      enablePathSignalBoosts: false,
    });
    const baselineFilePaths = new Set(baseline.rerankedResults.map((result) => result.filePath));
    const baselineSiblingHits = expectedSiblings.filter((path) => baselineFilePaths.has(path));

    assert.ok(
      siblingHits.length >= baselineSiblingHits.length,
      "path-signal boosts should not regress sibling coverage versus the no-boost baseline",
    );

    assert.deepEqual(routed.pathSignalDiagnostics.pathSignalsConsidered, []);
    assert.deepEqual(routed.pathSignalDiagnostics.pathSignalsMatched, []);
    assert.equal(typeof routed.pathSignalDiagnostics.weakPathCoverage, "boolean");
    assert.ok(routed.pathSignalDiagnostics.candidateFilesConsidered > 0);
  } finally {
    db.close();
  }
});

test("graph reranking benchmark output is stable for connected generic symbols", () => {
  const db = openIndexerDatabase();
  const stores = createTestProductStores(db);

  try {
    seedGenericRetrievalBenchmarkFixture(db);

    const first = searchSymbolsGraph(db, {
      query: "persistent stored payload expansion",
      maxResults: 6,
    });
    const second = searchSymbolsGraph(db, {
      query: "persistent stored payload expansion",
      maxResults: 6,
    });

    assert.deepEqual(toStableResultSummary(second), toStableResultSummary(first));
    assert.equal(first[0]?.fqName, "src/runPipeline/deferredVexpStore.ts::persistVrefRecord");
  } finally {
    db.close();
  }
});

function seedGenericRetrievalBenchmarkFixture(db: ReturnType<typeof openIndexerDatabase>): void {
  for (const file of GENERIC_RETRIEVAL_FIXTURE) {
    persistParseResult(db, makeSearchParseResult(file));
  }
}

const GENERIC_RETRIEVAL_FIXTURE: readonly SeedFileSpec[] = [
  {
    path: "src/config/settings.py",
    symbols: [
      {
        localName: "DEFAULT_BACKEND",
        kind: SymbolKind.ModuleConstant,
        startByte: 0,
        endByte: 24,
        signature: "DEFAULT_BACKEND = ...",
        docstring: "Default backend constant used by job and pipeline configuration.",
        exported: true,
      },
    ],
  },
  {
    path: "src/jobs/factory.py",
    symbols: [
      {
        localName: "Job",
        kind: SymbolKind.Class,
        startByte: 0,
        endByte: 28,
        signature: "class Job",
        docstring: "Job factory for backend-specific work.",
        exported: true,
      },
      {
        localName: "build",
        kind: SymbolKind.Method,
        startByte: 29,
        endByte: 70,
        signature: "Job.build(config: JobConfig) -> Job",
        docstring: "Build a Job instance from persistent configuration.",
        parentLocalName: "Job",
        exported: true,
      },
    ],
  },
  {
    path: "src/pipeline/orchestrator.ts",
    symbols: [
      {
        localName: "assemblePipelineContext",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 70,
        signature: "function assemblePipelineContext(query: string): PipelineContext",
        docstring: "Explain how does the pipeline assemble context from source-backed pivots and ranked symbols.",
        exported: true,
      },
    ],
  },
  {
    path: "src/runPipeline/deferredVexpStore.ts",
    symbols: [
      {
        localName: "persistVrefRecord",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 64,
        signature: "function persistVrefRecord(record: DeferredVrefRecord): void",
        docstring: "Implement persistent stored payload expansion and show where V-REF records persisted in repo-local SQLite.",
        exported: true,
      },
    ],
  },
  {
    path: "src/runtime/fileWatcher.ts",
    symbols: [
      {
        localName: "recordAutoReindexFailure",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 60,
        signature: "function recordAutoReindexFailure(error: Error): void",
        docstring: "Record auto reindex failure state while keeping watcher stale status visible.",
        exported: true,
      },
      {
        localName: "readWatcherStatus",
        kind: SymbolKind.Function,
        startByte: 61,
        endByte: 120,
        signature: "function readWatcherStatus(): WatcherStatus",
        docstring: "Read watcher status from repo-local state.",
      },
    ],
  },
  {
    path: "src/projectRules/projectRules.ts",
    symbols: [
      {
        localName: "promoteProjectRuleCandidate",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 66,
        signature: "function promoteProjectRuleCandidate(ruleId: string): ProjectRule",
        docstring: "Handle project rule candidate promotion after repeated durable observations.",
        exported: true,
      },
    ],
  },
  {
    path: "src/parsers/pythonParser.ts",
    symbols: [
      {
        localName: "extractPythonReferences",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 62,
        signature: "function extractPythonReferences(tree: PythonAst): EdgeRecord[]",
        docstring: "Document where Python references extracted for static calls and references edges.",
        exported: true,
      },
    ],
  },
  {
    path: "src/status/indexStatus.ts",
    symbols: [
      {
        localName: "readIndexStatus",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 48,
        signature: "function readIndexStatus(): IndexStatus",
        docstring: "Read index status for CLI and MCP surfaces.",
      },
    ],
  },
];

const SCIENTIFIC_ROUTES_FIXTURE: readonly SeedFileSpec[] = [
  {
    path: "backend/app/api/routes/scientific/kinetics.py",
    symbols: [
      {
        localName: "read_kinetics",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 64,
        signature: "def read_kinetics(kinetics_id: int, include_trust: bool = False)",
        docstring: "Detail route returning kinetics response. Uses model_dump and excludes trust unless include-trust.",
        exported: true,
      },
    ],
  },
  {
    path: "backend/app/api/routes/scientific/thermo.py",
    symbols: [
      {
        localName: "read_thermo",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 64,
        signature: "def read_thermo(thermo_id: int, include_trust: bool = False)",
        docstring: "Detail route returning thermo response. Uses model_dump and excludes trust unless include-trust.",
        exported: true,
      },
    ],
  },
  {
    path: "backend/app/api/routes/scientific/calculations.py",
    symbols: [
      {
        localName: "read_calculation",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 64,
        signature: "def read_calculation(calculation_id: int, include_trust: bool = False)",
        docstring: "Detail route returning calculation response. Uses model_dump and excludes trust unless include-trust.",
        exported: true,
      },
    ],
  },
  {
    path: "backend/app/api/routes/scientific/statmech.py",
    symbols: [
      {
        localName: "read_statmech",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 64,
        signature: "def read_statmech(statmech_id: int, include_trust: bool = False)",
        docstring: "Detail route returning statmech response. Uses model_dump and excludes trust unless include-trust.",
        exported: true,
      },
    ],
  },
  {
    path: "backend/app/api/routes/scientific/transport.py",
    symbols: [
      {
        localName: "read_transport",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 64,
        signature: "def read_transport(transport_id: int, include_trust: bool = False)",
        docstring: "Detail route returning transport response. Uses model_dump and excludes trust unless include-trust.",
        exported: true,
      },
    ],
  },
  {
    path: "backend/app/api/routes/admin/users.py",
    symbols: [
      {
        localName: "read_user",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 56,
        signature: "def read_user(user_id: int)",
        docstring: "Admin detail route returning user response.",
        exported: true,
      },
    ],
  },
  {
    path: "backend/app/api/routes/admin/audit.py",
    symbols: [
      {
        localName: "read_audit_entry",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 56,
        signature: "def read_audit_entry(audit_id: int)",
        docstring: "Admin detail route returning audit entry response.",
        exported: true,
      },
    ],
  },
];

async function withPythonImpactBenchmarkFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-retrieval-impact-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src", "pkg"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "pkg", "__init__.py"), "");
    await writeFile(
      path.join(repoRoot, "src", "pkg", "config.py"),
      "DEFAULT_BACKEND = 'orca'\n",
    );
    await writeFile(
      path.join(repoRoot, "src", "pkg", "runner.py"),
      [
        "from .config import DEFAULT_BACKEND",
        "",
        "def run():",
        "    return DEFAULT_BACKEND",
        "",
      ].join("\n"),
    );
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertIncludesSymbols(
  benchmarkCase: RetrievalBenchmarkCase,
  results: readonly GraphSearchResult[],
): void {
  const fqNames = results.map((result) => result.fqName);

  for (const expected of benchmarkCase.mustIncludeSymbols ?? []) {
    assert.ok(
      fqNames.includes(expected),
      `${benchmarkCase.name} expected ${expected}, got ${JSON.stringify(fqNames)}`,
    );
  }
}

function assertIncludesFiles(
  benchmarkCase: RetrievalBenchmarkCase,
  results: readonly GraphSearchResult[],
): void {
  const filePaths = new Set(results.map((result) => result.filePath));

  for (const expected of benchmarkCase.mustIncludeFiles ?? []) {
    assert.ok(
      filePaths.has(expected),
      `${benchmarkCase.name} expected file ${expected}, got ${JSON.stringify([...filePaths].sort())}`,
    );
  }
}

function assertNearTopSymbols(
  benchmarkCase: RetrievalBenchmarkCase,
  results: readonly GraphSearchResult[],
): void {
  const nearTop = results.slice(0, 3).map((result) => result.fqName);

  for (const expected of benchmarkCase.nearTopSymbols ?? []) {
    assert.ok(
      nearTop.includes(expected),
      `${benchmarkCase.name} expected ${expected} near top, got ${JSON.stringify(nearTop)}`,
    );
  }
}

function toStableResultSummary(results: readonly GraphSearchResult[]): unknown[] {
  return results.map((result) => ({
    fqName: result.fqName,
    filePath: result.filePath,
    localName: result.localName,
    kind: result.kind,
    lexicalScore: result.lexicalScore,
    graphScore: result.graphScore,
    finalScore: result.finalScore,
    matches: result.matches,
    graphContributions: result.graphContributions,
  }));
}
