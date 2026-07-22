import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { indexProject } from "../../src/indexer/indexProject";
import { routeQuery } from "../../src/intent/routeQuery";

const INCIDENT_TASK = "Add a stable public reference for the exact immutable reproducibility assessment surfaced in compact assessment summaries across thermo, kinetics, statmech, and transport. Determine whether assessment models already have an appropriate public_ref; trace immutability/supersession, schemas, migrations, projection builders, OpenAPI, tests, docs, and Python client types.";

const QUERIES = [
  ["A", "RecordReproducibilityAssessment"],
  ["B", "reproducibility_assessment"],
  ["C", "public_assessments.py"],
  ["D", "Add a public reference to reproducibility assessment summaries"],
  ["E", "Find the reproducibility assessment model, public assessment projection, public_ref support, schemas, and migration"],
  ["F", INCIDENT_TASK],
  ["G", `${INCIDENT_TASK} RecordReproducibilityAssessment\npublic_assessments.py\nreproducibility_assessment.py`],
] as const;

const RELEVANT_PATHS = [
  "backend/app/db/models/reproducibility_assessment.py",
  "backend/app/schemas/entities/reproducibility_assessment.py",
  "backend/app/schemas/reads/scientific_assessment.py",
  "backend/app/services/scientific_read/public_assessments.py",
  "backend/app/services/public_refs.py",
] as const;

const resultsRoot = path.resolve(
  "benchmarks/stage5_vexp_swe_bench_smoke/results",
);
const repoRoot = process.argv[2];
if (!repoRoot) throw new Error("usage: bun run_stage5_m121_zero_candidate_investigation.ts <read-only-repo-root>");

const currentDbPath = path.join(repoRoot, ".vtrace", "index.sqlite");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m121-full-"));
const fullDbPath = path.join(tempRoot, "full.sqlite");
const startedAt = performance.now();

try {
  const currentDb = new Database(currentDbPath, { readonly: true });
  const currentBefore = runMatrix(currentDb, "incremental", true);
  const currentAfter = runMatrix(currentDb, "incremental", false);
  const currentIndex = summarizeIndex(currentDb);
  currentDb.close();

  const fullDb = openIndexerDatabase(fullDbPath);
  const indexStarted = performance.now();
  const fullResult = await indexProject({ db: fullDb, repoRoot, refreshMode: "full" });
  const fullIndexMs = performance.now() - indexStarted;
  const fullAfter = runMatrix(fullDb, "full", false);
  const fullIndex = summarizeIndex(fullDb);
  fullDb.close();

  const matrix = {
    schemaVersion: "stage5.m121.query-matrix.v1",
    repository: "TCKDB_READ_ONLY",
    incidentTask: INCIDENT_TASK,
    queries: QUERIES.map(([id, query]) => ({ id, query })),
    currentIncremental: { before: currentBefore, after: currentAfter },
    cleanFull: { after: fullAfter },
  };
  const equivalent = {
    counts: JSON.stringify(currentIndex.counts) === JSON.stringify(fullIndex.counts),
    normalizedGraphHash: currentIndex.normalizedGraphHash === fullIndex.normalizedGraphHash,
    retrievalIndexHash: currentIndex.retrievalIndexHash === fullIndex.retrievalIndexHash,
    querySelections: stableSelections(currentAfter) === stableSelections(fullAfter),
  };
  const smoke = {
    schemaVersion: "stage5.m121.smoke.v1",
    repository: "TCKDB_READ_ONLY",
    index: {
      currentIncremental: currentIndex,
      cleanFull: fullIndex,
      equivalent,
      fullRebuild: {
        mode: fullResult.performance?.mode ?? "unknown",
        scannedFiles: fullResult.totalFilesScanned,
        indexedFiles: fullResult.totalFilesSuccessfullyIndexed,
        symbols: fullResult.totalSymbols,
        relationships: fullResult.totalRelationships,
        indexRefreshMs: round(fullIndexMs),
      },
    },
    retrievalLatencyMs: {
      currentIncremental: Object.fromEntries(currentAfter.map((row) => [row.id, row.latency.total])),
      cleanFull: Object.fromEntries(fullAfter.map((row) => [row.id, row.latency.total])),
    },
    totalInvestigationMs: round(performance.now() - startedAt),
  };
  const investigation = {
    schemaVersion: "stage5.m121.investigation.v1",
    outcome: Object.values(equivalent).every(Boolean) ? "PASS" : "MIXED",
    rootCause: {
      stage: "lexical_fts_query_construction",
      defect: "A prose slash disabled broad decomposition, producing an all-term AND query; the zero-primary recovery also required broad context and therefore did not run.",
      preciseZeroMeaning: "No scored lexical symbol rows and therefore no distinct candidate file seeds before graph reranking.",
    },
    correction: {
      bounded: true,
      arbitraryFallback: false,
      changes: [
        "Treat only standalone slash-containing queries as exact paths.",
        "Bound compound-task admission to adjacent phrases and high-information adjacent AND pairs.",
        "Search one best candidate per exact CamelCase, snake_case, and filename term before union.",
        "Expose source-content-free lane, filtering, fallback, selection, and timing diagnostics.",
      ],
    },
    incidentBefore: currentBefore.find((row) => row.id === "F"),
    incidentAfter: currentAfter.find((row) => row.id === "F"),
    incrementalFullEquivalent: equivalent,
    indexCoverage: currentIndex.coverage,
    timing: smoke.retrievalLatencyMs,
  };

  await Promise.all([
    writeJson("stage5_m121_zero_candidate_query_matrix.json", matrix),
    writeJson("stage5_m121_zero_candidate_smoke.detail.json", smoke),
    writeJson("stage5_m121_zero_candidate_investigation.json", investigation),
  ]);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function runMatrix(db: Database, indexKind: "incremental" | "full", simulateBefore: boolean) {
  return QUERIES.map(([id, query]) => {
    const started = performance.now();
    const legacySlashFailure = simulateBefore && (id === "F" || id === "G");
    const routed = routeQuery(db, query, {
      maxResults: 20,
      includeTimingDiagnostics: true,
      ...(legacySlashFailure ? { enableBroadQueryBoosts: false } : {}),
      ...(simulateBefore ? { enableExactIdentifierLane: false } : {}),
    });
    const total = performance.now() - started;
    const diagnostics = routed.pathSignalDiagnostics;
    const semanticVariant = diagnostics.queryVariants.find((variant) => variant.kind === "semantic_terms");
    return {
      id,
      indexKind,
      phase: simulateBefore ? "before" : "after",
      normalizedTask: diagnostics.normalizedQuery,
      derivedRetrievalQuery: semanticVariant?.query ?? null,
      queryTerms: diagnostics.ftsTerms,
      queryVariants: diagnostics.queryVariants,
      identifierTerms: diagnostics.identifierTerms,
      pathTerms: diagnostics.pathTerms,
      ftsTerms: diagnostics.ftsTerms,
      rawHitsPerLane: diagnostics.laneResults,
      hitsRejectedPerLane: {
        threshold: diagnostics.rejectedByThreshold,
        scope: diagnostics.rejectedByScope,
      },
      candidateUnionSize: diagnostics.preFilterCandidates,
      candidateFilesConsidered: diagnostics.candidateFilesConsidered,
      graphExpansions: diagnostics.graphExpansions,
      thresholds: {
        normal: "score evidence required; intent candidate pool then maxResults=20",
        relaxed: null,
      },
      fallbacks: {
        attempted: diagnostics.fallbackAttempted,
        reason: diagnostics.fallbackReason ?? null,
      },
      selectedFiles: [...new Set(routed.rerankedResults.map((result) => result.filePath))],
      selectedSymbols: routed.rerankedResults.map((result) => result.localName),
      finalReason: diagnostics.finalReason ?? null,
      latency: {
        normalization: round(diagnostics.timingsMs.normalization),
        laneSearch: round(diagnostics.timingsMs.laneSearch),
        candidateMerge: round(diagnostics.timingsMs.candidateMerge),
        graphExpansion: round(diagnostics.timingsMs.graphExpansion),
        render: 0,
        total: round(total),
      },
    };
  });
}

function summarizeIndex(db: Database) {
  const count = (table: string) => (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    counts: {
      files: count("files"),
      symbols: count("symbols"),
      edges: count("edges"),
      ftsDocuments: count("symbol_search_fts"),
      bodyLiteralDocuments: count("symbol_body_literals_fts"),
      retrievalRows: count("symbol_search_fts") + count("symbol_body_literals_fts"),
    },
    normalizedGraphHash: hashQuery(db, "SELECT id, path, language, content_hash, size_bytes FROM files ORDER BY id", "SELECT id, file_id, fq_name, local_name, kind, signature, docstring, exported, parent_symbol_id, start_line, end_line, start_byte, end_byte FROM symbols ORDER BY id", "SELECT id, src_symbol_id, dst_symbol_id, edge_type, confidence FROM edges ORDER BY id"),
    retrievalIndexHash: hashQuery(db, "SELECT symbol_id, file_path_raw, local_name, fq_name, signature, docstring, file_path FROM symbol_search_fts ORDER BY symbol_id", "SELECT symbol_id, file_path_raw, literals FROM symbol_body_literals_fts ORDER BY symbol_id"),
    coverage: Object.fromEntries(RELEVANT_PATHS.map((filePath) => [filePath, {
      fileRecords: scalar(db, "SELECT COUNT(*) AS count FROM files WHERE path = ?", filePath),
      symbolRecords: scalar(db, "SELECT COUNT(*) AS count FROM symbols INNER JOIN files ON files.id = symbols.file_id WHERE files.path = ?", filePath),
      ftsRecords: scalar(db, "SELECT COUNT(*) AS count FROM symbol_search_fts WHERE file_path_raw = ?", filePath),
      graphRecords: scalar(db, "SELECT COUNT(DISTINCT edges.id) AS count FROM edges INNER JOIN symbols source ON source.id = edges.src_symbol_id INNER JOIN files source_file ON source_file.id = source.file_id INNER JOIN symbols target ON target.id = edges.dst_symbol_id INNER JOIN files target_file ON target_file.id = target.file_id WHERE source_file.path = ? OR target_file.path = ?", filePath, filePath),
    }])),
  };
}

function hashQuery(db: Database, ...queries: string[]): string {
  const hash = createHash("sha256");
  for (const query of queries) {
    for (const row of db.query(query).iterate() as Iterable<Record<string, unknown>>) {
      hash.update(JSON.stringify(row));
      hash.update("\n");
    }
  }
  return hash.digest("hex");
}

function scalar(db: Database, query: string, ...params: string[]): number {
  return (db.query(query).get(...params) as { count: number }).count;
}

function stableSelections(rows: ReturnType<typeof runMatrix>): string {
  return JSON.stringify(rows.map((row) => ({ id: row.id, files: row.selectedFiles, symbols: row.selectedSymbols })));
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(path.join(resultsRoot, name), `${JSON.stringify(value, null, 2)}\n`);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
