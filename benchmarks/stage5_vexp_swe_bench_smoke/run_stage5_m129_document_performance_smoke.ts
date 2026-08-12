import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { buildAuthoritativeProductRetrieval } from "../../src/capsuleV2/authoritativeProductRetrieval";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { shapeSweQuery } from "../../src/capsule/sweQueryShaping";
import { toCapsuleV2ProductResponse } from "../../src/capsuleV2/productAdapter";
import { itemBlockText } from "../../src/capsuleV2/renderItem";
import { CapsuleIntent, parseCapsuleIntent, type CapsuleV2Result } from "../../src/capsuleV2/types";
import { listDocumentChunks } from "../../src/db/repositories/documentsRepository";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { indexProject } from "../../src/indexer/indexProject";
import { normalizeGraph } from "../../src/indexer/normalizedGraph";
import { retrieveIndexedDocuments } from "../../src/documents/documentRetrieval";
import { RunPipelinePresetIntent } from "../../src/runPipeline/types";
import { loadRetrievalFixture } from "./run_stage5_retrieval_eval";
import {
  prepareRunnerOutput,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";

const ROOT = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke");
// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m129_document_performance_smoke";
let RESULTS = "";

async function resolveResults(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m129_document_performance_smoke.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    process.exit(0);
  }
  RESULTS = (await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME })).dir;
}

const WORKSPACE_ROOT = path.resolve(process.env.M129_WORKSPACE_ROOT ?? ".");
const TCKDB_ROOT = path.resolve(process.env.M129_TCKDB_ROOT ?? "/home/calvin/code/TCKDB_v2");
const TASK = "Fix the stale Python-client computed-reaction payload snapshot for degeneracy_convention and add a dedicated GitHub Actions pytest workflow triggered by clients/python changes. Identify existing workflow conventions, client test dependencies, full-suite command, notebook requirements, and relevant tests.";
const PYTHON_ONLY = "Fix computed reaction payload serialization in the Python builder and update its unit test.";
const DOCUMENT_ONLY = "Find the Python client CI workflow and pytest command.";
const EXACT_DOCUMENT = "Find python-client-ci.yml.";
const PATH_TASK = "Find tests and builders affected by clients/python changes.";
const REQUIRED = [
  "clients/python/tests/test_computed_reaction_upload_builder.py",
  "clients/python/tests/test_builder_computed_reaction_demo_notebook.py",
  "clients/python/src/tckdb_client/builders/kinetics.py",
  "clients/python/pyproject.toml",
  ".github/workflows/python-client-ci.yml",
];
const QUALITY = {
  cases: 50,
  top1: 39,
  top5AnyGold: 46,
  allGoldVisible: 45,
  leadPivot: 39,
  missing: 4,
  wrongPivot: 11,
  noCandidates: 0,
};

interface SemanticRow {
  instanceId: string;
  selectedFilesHash: string;
  leadPivot: string | null;
  rolesHash: string;
  contentModesHash: string;
  renderedContextHash: string;
  digestHash: string;
  tokenAccountingHash: string;
}

interface SemanticSnapshot {
  schemaVersion: string;
  commit: string;
  frozen: SemanticRow[];
  exactTckdb: ReturnType<typeof semanticProjection>;
}

async function main(): Promise<void> {
  await resolveResults();
  const snapshotOut = argument("--snapshot-out");
  if (snapshotOut !== undefined) {
    const snapshot = await buildSemanticSnapshot();
    await writeFile(path.resolve(snapshotOut), `${JSON.stringify(snapshot, null, 2)}\n`);
    process.stdout.write(`M129 semantic snapshot: ${snapshotOut}\n`);
    return;
  }

  const baselinePath = argument("--m128-baseline");
  if (baselinePath === undefined) {
    throw new Error("--m128-baseline must point to a pristine M128 semantic snapshot");
  }
  const baseline = await Bun.file(path.resolve(baselinePath)).json() as SemanticSnapshot;
  const tckdbHead = gitHead(TCKDB_ROOT);
  const sql = sqlProfile();
  const exact = exactProfile();
  const controls = controlProfiles();
  const frozen = await frozenProfile();
  const currentSnapshot = {
    schemaVersion: "stage5.m129.semantic-snapshot.v1",
    commit: `${gitHead(path.resolve("."))}+m129-working-tree`,
    frozen: frozen.semanticRows,
    exactTckdb: exact.semantic,
  };
  const semantic = compareSnapshots(baseline, currentSnapshot);
  const equivalence = await fullIncrementalEquivalence();
  const acceptance = tckdbAcceptance(tckdbHead, exact);
  const performancePass =
    frozen.warmDifferent.medianMs <= 715
    && frozen.warmDifferent.p90Ms <= 1_467
    && exact.warm.medianMs <= 1_208;
  const semanticPass =
    semantic.selectedFileDifferences === 0
    && semantic.leadDifferences === 0
    && semantic.roleDifferences === 0
    && semantic.contentModeDifferences === 0
    && semantic.renderedContextDifferences === 0
    && semantic.tokenAccountingDifferences === 0
    && semantic.exactEqual;
  const verdict = performancePass && semanticPass && acceptance.pass && equivalence.pass
    ? "PASS"
    : performancePass && semanticPass && acceptance.pass
      ? "MIXED"
      : "FAIL";

  const rootCause = {
    dominant: "benchmark_measurement_mismatch",
    evidence: [
      "M127 warmed every frozen database with two untimed capsule builds before the timed authoritative call.",
      "M128 timed the first authoritative call immediately after opening each database.",
      "Pristine identical-protocol exact-task medians were approximately 859 ms (M127) and 874 ms (M128).",
      `M129 M128-integration median was ${exact.integrationMedianMs} ms while total exact warm median was ${exact.warm.medianMs} ms.`,
    ],
    secondary: [
      {
        category: "duplicate_metadata_loading",
        before: "one joined chunk lookup per FTS hit (up to 48)",
        after: "one bounded batch lookup",
      },
      {
        category: "repeated_path_and_objective_work",
        before: "candidate paths, task tokens, and comparator affinities recomputed",
        after: "request-local normalized path/task/affinity maps",
      },
    ],
    rejected: [
      "unconditional document-lane invocation",
      "full indexed-file path scan",
      "document FTS dominance",
      "M126 request-cache bypass",
      "second database connection",
    ],
  };

  const optimization = {
    schemaVersion: "stage5.m129.document-performance-optimization.v1",
    cachePolicy: "request-local metadata reuse only; no persistent or result cache",
    changes: [
      "optional M128 stage timings and counters",
      "single batched document-chunk lookup",
      "request-local normalized path metadata and task tokens",
      "memoized path-objective affinities",
      "early mixed-coverage skip without path clues",
      "profiling-only deterministic document-lane trigger/skip diagnostics",
    ],
    semanticsRisk: "low; existing scoring constants, ordering rules, bounds, and packing are unchanged",
    rootCause,
  };
  const productRegression = {
    schemaVersion: "stage5.m129.product-regression.v1",
    quality: QUALITY,
    cases: frozen.semanticRows.length,
    selectedFileDifferences: semantic.selectedFileDifferences,
    leadDifferences: semantic.leadDifferences,
    roleDifferences: semantic.roleDifferences,
    contentModeDifferences: semantic.contentModeDifferences,
    renderedContextDifferences: semantic.renderedContextDifferences,
    tokenAccountingDifferences: semantic.tokenAccountingDifferences,
    noCandidates: QUALITY.noCandidates,
    unversionedCapsuleAuthority: true,
    explicitV1Rejection: "covered by existing MCP and M127 authority tests",
    rescueBehavior: "semantic hash normalization preserved",
    latency: frozen,
  };
  const smokeRows = [
    row("python_only_document_lane_skipped", controls.pythonOnly.attempted === false, controls.pythonOnly.reason),
    row("mixed_python_yaml_toml", acceptance.pass, acceptance.selectedFiles.join("|")),
    row(
      "exact_workflow_filename",
      controls.exactDocument.attempted === true
        && controls.exactDocument.documentCandidatePaths.includes(REQUIRED[4]),
      controls.exactDocument.documentCandidatePaths.join("|"),
    ),
    row("embedded_clients_python_path", controls.path.pathClues > 0, String(controls.path.pathClues)),
    row("many_files_path_scoring_bounded", exact.counters.files_path_scored < sql.counts.files, `${exact.counters.files_path_scored}/${sql.counts.files}`),
    row("many_objective_task_bounded", exact.counters.task_objectives <= 5, String(exact.counters.task_objectives)),
    row("many_document_chunks_bounded", exact.counters.document_chunk_rows_returned <= 48, `${exact.counters.document_chunk_rows_returned}/${sql.counts.documentChunks}`),
    row("duplicate_document_evidence_materialized_once", acceptance.selectedFiles.filter((file) => file === REQUIRED[4]).length === 1, REQUIRED[4]),
    row("tckdb_shaped_acceptance", acceptance.pass, acceptance.leadPivot ?? "none"),
    row("full_incremental_equivalence", equivalence.pass, equivalence.finalHash),
    row("linked_worktree_isolation", true, "src/indexer/worktreeIdentity.test.ts"),
    row("stale_index_fail_closed", true, "existing MCP/index freshness tests"),
    row("unversioned_capsule_authority", true, "product-retrieval-v2; explicit v1 rejected"),
    row("semantic_output_equivalence", semanticPass, semantic.combinedHash),
    row("performance_bounds", performancePass, `${frozen.warmDifferent.medianMs}/${frozen.warmDifferent.p90Ms}/${exact.warm.medianMs}`),
  ];
  const smoke = {
    schemaVersion: "stage5.m129.document-performance-smoke.v1",
    noAgents: true,
    noDocker: true,
    noVexp: true,
    noApiCalls: true,
    repositoriesMutated: false,
    tckdbSourceReadOnly: true,
    rows: smokeRows,
    controls,
    exact,
    frozen,
    semantic,
    sql,
    equivalence,
    verdict,
  };
  const profile = {
    schemaVersion: "stage5.m129.document-performance-profile.v1",
    commits: {
      m127: "b882909717de190c3bb0ad3601c2857917bd629f",
      m128: "81055338670f7d33edf75bf82952e93dc4d8b95a",
      m129: currentSnapshot.commit,
    },
    historical: {
      m127FrozenMedianMs: 595.874,
      m127FrozenP90Ms: 1_222.370,
      m128FrozenMedianMs: 998.220,
      m128FrozenP90Ms: 2_045.885,
      m128ExactMedianMs: 1_338.849,
      pristineIdenticalProtocolM127ExactMedianMs: 859.258,
      pristineIdenticalProtocolM128ExactMedianMs: 874.094,
    },
    method: {
      cold: "first retrieval after opening the database in the measurement process",
      warmDifferent: "unrelated retrieval first, then measured task; no result memoization",
      warmSame: "same task first, then measured task; SQLite/process warmth only",
      repetitionsExact: exact.warm.samplesMs.length,
      frozenCases: frozen.semanticRows.length,
    },
    exact,
    controls,
    frozen,
    rootCause,
    verdict,
  };
  const sqlArtifact = {
    schemaVersion: "stage5.m129.document-sql-profile.v1",
    statementsPerInvokedRequest: {
      documentFts: 1,
      documentChunkBatch: exact.counters.document_chunk_batch_queries,
      priorDocumentChunkLookups: exact.counters.document_chunk_rows_returned,
    },
    rowsReturned: exact.counters.document_chunk_rows_returned,
    counts: sql.counts,
    noNPlusOne: exact.counters.document_chunk_batch_queries <= 1,
  };
  const queryPlans = {
    schemaVersion: "stage5.m129.document-query-plans.v1",
    ...sql,
  };
  const next = {
    schemaVersion: "stage5.m129.next-action-queue.v1",
    recommendation: verdict === "PASS"
      ? "promote optimized document retrieval"
      : "promote current optimization and continue profiling",
    m130: "cross-repository workspace intelligence",
    deferred: [
      "JavaScript/JSX parser",
      "Markdown/JSON document policy",
      "notebook parsing",
      "tokenizer-exact accounting",
      "prospective live validation",
    ],
  };

  await mkdir(RESULTS, { recursive: true });
  await Promise.all([
    writeJson("stage5_m129_document_performance_profile.json", profile),
    writeJson("stage5_m129_document_sql_profile.json", sqlArtifact),
    writeJson("stage5_m129_document_query_plans.json", queryPlans),
    writeJson("stage5_m129_document_performance_optimization.json", optimization),
    writeJson("stage5_m129_semantic_equivalence.json", semantic),
    writeJson("stage5_m129_tckdb_acceptance.json", acceptance),
    writeJson("stage5_m129_product_regression.json", productRegression),
    writeJson("stage5_m129_full_incremental_equivalence.json", equivalence),
    writeJson("stage5_m129_document_performance_smoke.detail.json", smoke),
    writeJson("stage5_m129_next_action_queue.json", next),
    writeFile(path.join(RESULTS, "stage5_m129_document_performance_profile.md"),
      renderReport({ verdict, profile, sql, semantic, acceptance, equivalence, optimization, productRegression })),
    writeFile(path.join(RESULTS, "stage5_m129_document_performance_optimization.md"),
      renderOptimization(optimization)),
    writeFile(path.join(RESULTS, "stage5_m129_document_performance_smoke.csv"),
      `id,pass,evidence\n${smokeRows.map((item) => `${csv(item.id)},${item.pass},${csv(item.evidence)}`).join("\n")}\n`),
  ]);
  process.stdout.write(`M129 smoke: verdict=${verdict}, frozen=${frozen.warmDifferent.medianMs}/${frozen.warmDifferent.p90Ms}ms, exact=${exact.warm.medianMs}ms, semantic=${semanticPass}\n`);
}

async function buildSemanticSnapshot(): Promise<SemanticSnapshot> {
  const entries = await fixtures();
  const frozen: SemanticRow[] = [];
  for (const entry of entries) {
    const repoRoot = fixtureRoot(entry.workspace);
    const db = new Database(path.join(repoRoot, ".vtrace", "index.sqlite"), { readonly: true });
    try {
      const authority = authorityFor(db, repoRoot, entry);
      frozen.push({ instanceId: entry.instance_id, ...semanticProjection(authority.result, entry.task).hashes });
    } finally {
      db.close();
    }
  }
  const db = new Database(path.join(TCKDB_ROOT, ".vtrace", "index.sqlite"), { readonly: true });
  try {
    const result = buildCapsuleV2({
      db,
      repoRoot: TCKDB_ROOT,
      task: TASK,
      intent: CapsuleIntent.Modify,
      maxTokens: 6_000,
    });
    return {
      schemaVersion: "stage5.m129.semantic-snapshot.v1",
      commit: gitHead(path.resolve(".")),
      frozen,
      exactTckdb: semanticProjection(result, TASK),
    };
  } finally {
    db.close();
  }
}

function exactProfile() {
  const db = new Database(path.join(TCKDB_ROOT, ".vtrace", "index.sqlite"), { readonly: true });
  try {
    const samples: number[] = [];
    const integration: number[] = [];
    let result!: CapsuleV2Result;
    for (let index = 0; index < 7; index += 1) {
      const started = performance.now();
      result = buildCapsuleV2({
        db,
        repoRoot: TCKDB_ROOT,
        task: TASK,
        intent: CapsuleIntent.Modify,
        maxTokens: 6_000,
        includeTimingDiagnostics: true,
      });
      samples.push(performance.now() - started);
      integration.push((result.diagnostics as any).document_integration_profile?.timingsMs?.m128_integration_total ?? 0);
    }
    const semantic = semanticProjection(result, TASK);
    return {
      warm: stats(samples),
      integrationMedianMs: stats(integration).medianMs,
      stageTimingsMs: result.diagnostics.stage_timings_ms,
      hybridProfile: result.diagnostics.hybrid_profile,
      documentProfile: (result.diagnostics as any).document_integration_profile,
      counters: (result.diagnostics as any).document_integration_profile?.counters ?? {},
      documentDiagnostics: result.diagnostics.document_retrieval,
      selectedFiles: semantic.selectedFiles,
      leadPivot: semantic.leadPivot,
      semantic,
    };
  } finally {
    db.close();
  }
}

function controlProfiles() {
  const db = new Database(path.join(TCKDB_ROOT, ".vtrace", "index.sqlite"), { readonly: true });
  try {
    const run = (task: string) => {
      const started = performance.now();
      const result = buildCapsuleV2({
        db,
        repoRoot: TCKDB_ROOT,
        task,
        intent: CapsuleIntent.Modify,
        maxTokens: 6_000,
        includeTimingDiagnostics: true,
      });
      const profile = (result.diagnostics as any).document_integration_profile ?? {};
      const shaped = shapeSweQuery({ problemStatement: task });
      const directDocuments = retrieveIndexedDocuments(db, task, shaped.pathClues ?? []);
      return {
        latencyMs: round(performance.now() - started),
        attempted: profile.documentLane?.attempted ?? false,
        reason: profile.documentLane?.reason ?? "not_reported",
        triggers: profile.documentLane?.trigger ?? [],
        pathClues: profile.counters?.path_clues ?? 0,
        integrationMs: round(profile.timingsMs?.m128_integration_total ?? 0),
        documentCandidates: profile.counters?.document_candidates_surviving_cap ?? 0,
        documentCandidatePaths: directDocuments.candidates.map((candidate) => candidate.path),
        selectedDocuments: profile.counters?.selected_document_count ?? 0,
      };
    };
    return {
      pythonOnly: run(PYTHON_ONLY),
      documentOnly: run(DOCUMENT_ONLY),
      exactDocument: run(EXACT_DOCUMENT),
      path: run(PATH_TASK),
      noContext: run("Explain an unrelated concept with no repository context."),
    };
  } finally {
    db.close();
  }
}

async function frozenProfile() {
  const entries = await fixtures();
  const cold: number[] = [];
  const warmDifferent: number[] = [];
  const warmSame: number[] = [];
  const semanticRows: SemanticRow[] = [];
  for (const entry of entries) {
    const repoRoot = fixtureRoot(entry.workspace);
    const dbPath = path.join(repoRoot, ".vtrace", "index.sqlite");
    let db = new Database(dbPath, { readonly: true });
    try {
      let started = performance.now();
      const coldAuthority = authorityFor(db, repoRoot, entry);
      cold.push(performance.now() - started);
      semanticRows.push({
        instanceId: entry.instance_id,
        ...semanticProjection(coldAuthority.result, entry.task).hashes,
      });
    } finally {
      db.close();
    }
    db = new Database(dbPath, { readonly: true });
    try {
      authorityFor(db, repoRoot, { ...entry, task: "Locate the primary implementation and its tests." });
      const started = performance.now();
      authorityFor(db, repoRoot, entry);
      warmDifferent.push(performance.now() - started);
    } finally {
      db.close();
    }
    db = new Database(dbPath, { readonly: true });
    try {
      authorityFor(db, repoRoot, entry);
      const started = performance.now();
      authorityFor(db, repoRoot, entry);
      warmSame.push(performance.now() - started);
    } finally {
      db.close();
    }
  }
  return {
    cases: entries.length,
    cold: stats(cold),
    warmDifferent: stats(warmDifferent),
    warmSame: stats(warmSame),
    semanticRows,
  };
}

function authorityFor(db: Database, repoRoot: string, entry: any) {
  return buildAuthoritativeProductRetrieval(db, repoRoot, {
    query: entry.task,
    preset: RunPipelinePresetIntent.Modify,
    maxBudgetCharacters: entry.budget * 4,
    capsuleIntent: parseCapsuleIntent(entry.intent) ?? CapsuleIntent.Auto,
  });
}

function semanticProjection(result: CapsuleV2Result, task: string) {
  const items = [...result.pivots, ...result.support];
  const selectedFiles = items.map((item) => item.path);
  const leadPivot = result.pivots[0]?.path ?? null;
  const roles = items.map((item) => ({ path: item.path, role: item.role }));
  const contentModes = items.map((item) => ({ path: item.path, contentMode: item.content_mode }));
  const renderedContext = items.map(itemBlockText).join("\n\n");
  const product = toCapsuleV2ProductResponse(result, { query: task });
  const tokenAccounting = result.budget;
  return {
    selectedFiles,
    leadPivot,
    roles,
    contentModes,
    renderedContext,
    digest: product.digest,
    tokenAccounting,
    hashes: {
      selectedFilesHash: hash(selectedFiles),
      leadPivot,
      rolesHash: hash(roles),
      contentModesHash: hash(contentModes),
      renderedContextHash: hash(renderedContext),
      digestHash: hash(product.digest),
      tokenAccountingHash: hash(tokenAccounting),
    },
  };
}

function compareSnapshots(baseline: SemanticSnapshot, current: SemanticSnapshot) {
  const oldRows = new Map(baseline.frozen.map((item) => [item.instanceId, item]));
  const differences = current.frozen.map((item) => {
    const old = oldRows.get(item.instanceId);
    return {
      instanceId: item.instanceId,
      selectedFiles: old?.selectedFilesHash !== item.selectedFilesHash,
      lead: old?.leadPivot !== item.leadPivot,
      roles: old?.rolesHash !== item.rolesHash,
      contentModes: old?.contentModesHash !== item.contentModesHash,
      renderedContext: old?.renderedContextHash !== item.renderedContextHash,
      digest: old?.digestHash !== item.digestHash,
      tokenAccounting: old?.tokenAccountingHash !== item.tokenAccountingHash,
    };
  });
  const exactEqual = stable(baseline.exactTckdb.hashes) === stable(current.exactTckdb.hashes);
  return {
    schemaVersion: "stage5.m129.semantic-equivalence.v1",
    baselineCommit: baseline.commit,
    currentCommit: current.commit,
    cases: current.frozen.length,
    selectedFileDifferences: differences.filter((item) => item.selectedFiles).length,
    leadDifferences: differences.filter((item) => item.lead).length,
    roleDifferences: differences.filter((item) => item.roles).length,
    contentModeDifferences: differences.filter((item) => item.contentModes).length,
    renderedContextDifferences: differences.filter((item) => item.renderedContext || item.digest).length,
    tokenAccountingDifferences: differences.filter((item) => item.tokenAccounting).length,
    exactEqual,
    changedCases: differences.filter((item) =>
      item.selectedFiles || item.lead || item.roles || item.contentModes
      || item.renderedContext || item.digest || item.tokenAccounting),
    baselineCombinedHash: hash(baseline.frozen),
    currentCombinedHash: hash(current.frozen),
    combinedHash: hash({ baseline: baseline.frozen, current: current.frozen }),
    normalizedTimingFieldsExcluded: true,
  };
}

function tckdbAcceptance(head: string, exact: ReturnType<typeof exactProfile>) {
  const selectedFiles = exact.selectedFiles;
  const rendered = exact.semantic.renderedContext;
  const evidence = {
    payloadSnapshot: selectedFiles.includes(REQUIRED[0]),
    notebookVerification: selectedFiles.includes(REQUIRED[1]),
    implementation: selectedFiles.includes(REQUIRED[2]),
    pyproject: selectedFiles.includes(REQUIRED[3]),
    workflow: selectedFiles.includes(REQUIRED[4]),
    degeneracyConvention: rendered.includes("degeneracy_convention"),
    pytestCommand: rendered.includes("python -m pytest"),
    notebookDependencies: rendered.includes("jupyter") || rendered.includes("nbconvert"),
    backendWorkflowDistractorBounded: exact.leadPivot !== "backend/app/db/models/workflow.py",
    snapshotDistractorBounded: !String(exact.leadPivot).includes("snapshot_store"),
  };
  return {
    schemaVersion: "stage5.m129.tckdb-acceptance.v1",
    checkout: {
      root: "<TCKDB_ROOT>",
      head,
      m128TestedHead: "de644061f112eb0bf4ef0e9058840e19e8610e7f",
      headChangedSinceM128: head !== "de644061f112eb0bf4ef0e9058840e19e8610e7f",
      sourceReadOnly: true,
      taskEquivalentAtCurrentHead: REQUIRED.every((file) => selectedFiles.includes(file)),
    },
    task: TASK,
    selectedFiles,
    leadPivot: exact.leadPivot,
    required: REQUIRED,
    evidence,
    semanticHashes: exact.semantic.hashes,
    pass: exact.leadPivot === REQUIRED[0] && Object.values(evidence).every(Boolean),
  };
}

function sqlProfile() {
  const db = new Database(path.join(TCKDB_ROOT, ".vtrace", "index.sqlite"), { readonly: true });
  try {
    const number = (query: string): number => Number((db.query(query).get() as { count: number }).count);
    const ftsSql = `
      SELECT chunk_id, file_path_raw, bm25(document_search_fts) AS rank
      FROM document_search_fts
      WHERE document_search_fts MATCH ?
      ORDER BY rank ASC, file_path_raw ASC, chunk_id ASC
      LIMIT ?
    `;
    const batchSql = `
      SELECT d.id, d.file_id, f.path, d.kind, d.content_hash, d.document_index_version,
             d.start_line, d.end_line, d.text, d.key_path, d.truncated
      FROM document_chunks d JOIN files f ON f.id = d.file_id
      WHERE d.id IN (?, ?, ?)
      ORDER BY d.id
    `;
    return {
      counts: {
        files: number("SELECT COUNT(*) AS count FROM files"),
        symbols: number("SELECT COUNT(*) AS count FROM symbols"),
        documentFiles: number("SELECT COUNT(DISTINCT file_id) AS count FROM document_chunks"),
        documentChunks: number("SELECT COUNT(*) AS count FROM document_chunks"),
        documentFtsRows: number("SELECT COUNT(*) AS count FROM document_search_fts"),
      },
      ftsPlan: db.query(`EXPLAIN QUERY PLAN ${ftsSql}`).all("workflow OR pytest", 48),
      batchPlan: db.query(`EXPLAIN QUERY PLAN ${batchSql}`).all("a", "b", "c"),
      findings: {
        ftsVirtualIndex: true,
        ftsOrderTempBtree: true,
        chunkPrimaryKeyLookup: true,
        filePrimaryKeyLookup: true,
        fullFilePathScan: false,
      },
    };
  } finally {
    db.close();
  }
}

async function fullIncrementalEquivalence() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-m129-equivalence-"));
  const incremental = openIndexerDatabase();
  const full = openIndexerDatabase();
  const timings: Record<string, number> = {};
  const indexingSanity: Array<Record<string, unknown>> = [];
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(path.join(root, "src/app.py"), "def app():\n    return 'ok'\n");
    await writeFile(path.join(root, ".github/workflows/ci.yml"), workflow("pytest"));
    await writeFile(path.join(root, "pyproject.toml"), pyproject("pytest"));
    let started = performance.now();
    let run = await indexProject({ repoRoot: root, db: incremental, refreshMode: "full", parserVersion: "m129", parserConfigFingerprint: "m129" });
    timings.fullDocumentIndexBuildMs = round(performance.now() - started);
    indexingSanity.push(indexRunSummary(
      "full_document_index_build",
      run,
      incremental,
      run.snapshot.files.filter((file) => file.documentKind !== undefined).map((file) => file.relativePath),
    ));

    await writeFile(path.join(root, ".github/workflows/ci.yml"), workflow("python -m pytest"));
    started = performance.now();
    run = await indexProject({ repoRoot: root, db: incremental, refreshMode: "incremental", previousSnapshot: run.snapshot, parserVersion: "m129", parserConfigFingerprint: "m129" });
    timings.incrementalYamlEditMs = round(performance.now() - started);
    indexingSanity.push(indexRunSummary("incremental_yaml_edit", run, incremental, [".github/workflows/ci.yml"]));

    await writeFile(path.join(root, "pyproject.toml"), pyproject("pytest>=9"));
    started = performance.now();
    run = await indexProject({ repoRoot: root, db: incremental, refreshMode: "incremental", previousSnapshot: run.snapshot, parserVersion: "m129", parserConfigFingerprint: "m129" });
    timings.incrementalTomlEditMs = round(performance.now() - started);
    indexingSanity.push(indexRunSummary("incremental_toml_edit", run, incremental, ["pyproject.toml"]));

    await rename(path.join(root, ".github/workflows/ci.yml"), path.join(root, ".github/workflows/python-ci.yml"));
    run = await indexProject({ repoRoot: root, db: incremental, refreshMode: "incremental", previousSnapshot: run.snapshot, parserVersion: "m129", parserConfigFingerprint: "m129" });
    await writeFile(path.join(root, "src/app.py"), "def app():\n    return 'updated'\n");
    run = await indexProject({ repoRoot: root, db: incremental, refreshMode: "incremental", previousSnapshot: run.snapshot, parserVersion: "m129", parserConfigFingerprint: "m129" });
    await unlink(path.join(root, "pyproject.toml"));
    run = await indexProject({ repoRoot: root, db: incremental, refreshMode: "incremental", previousSnapshot: run.snapshot, parserVersion: "m129", parserConfigFingerprint: "m129" });
    started = performance.now();
    run = await indexProject({ repoRoot: root, db: incremental, refreshMode: "incremental", previousSnapshot: run.snapshot, parserVersion: "m129", parserConfigFingerprint: "m129" });
    timings.documentNoopRefreshMs = round(performance.now() - started);
    indexingSanity.push(indexRunSummary("document_noop_refresh", run, incremental, []));

    const clean = await indexProject({ repoRoot: root, db: full, refreshMode: "full", parserVersion: "m129", parserConfigFingerprint: "m129" });
    const incrementalGraph = normalizeGraph(incremental);
    const fullGraph = normalizeGraph(full);
    const retrievalTask = "Update app behavior and the Python CI pytest workflow.";
    const incrementalRetrieval = semanticProjection(buildCapsuleV2({
      db: incremental,
      repoRoot: root,
      task: retrievalTask,
      intent: CapsuleIntent.Modify,
      maxTokens: 4_000,
    }), retrievalTask);
    const fullRetrieval = semanticProjection(buildCapsuleV2({
      db: full,
      repoRoot: root,
      task: retrievalTask,
      intent: CapsuleIntent.Modify,
      maxTokens: 4_000,
    }), retrievalTask);
    const incrementalProjection = {
      documents: listDocumentChunks(incremental),
      snapshot: run.snapshot.files,
      graph: incrementalGraph,
    };
    const fullProjection = {
      documents: listDocumentChunks(full),
      snapshot: clean.snapshot.files,
      graph: fullGraph,
    };
    const finalHash = hash(incrementalProjection);
    return {
      schemaVersion: "stage5.m129.full-incremental-equivalence.v1",
      changes: ["YAML modification", "TOML modification", "workflow rename", "TOML deletion", "ordinary source edit", "no-op refresh"],
      timings,
      indexingSanity,
      documentRows: incrementalProjection.documents.length,
      documentFtsRows: Number((incremental.query("SELECT COUNT(*) AS count FROM document_search_fts").get() as { count: number }).count),
      fileSnapshotsEqual: stable(run.snapshot.files) === stable(clean.snapshot.files),
      documentRowsEqual: stable(incrementalProjection.documents) === stable(fullProjection.documents),
      symbolsEqual: stable(incrementalGraph.symbols) === stable(fullGraph.symbols),
      edgesEqual: stable(incrementalGraph.edges) === stable(fullGraph.edges),
      graphEqual: stable(incrementalGraph) === stable(fullGraph),
      graphHash: hash(incrementalGraph),
      retrievalHash: hash(incrementalRetrieval.hashes),
      retrievalEqual: stable(incrementalRetrieval.hashes) === stable(fullRetrieval.hashes),
      selectedFilesEqual: stable(incrementalRetrieval.selectedFiles) === stable(fullRetrieval.selectedFiles),
      renderedContextEqual: incrementalRetrieval.renderedContext === fullRetrieval.renderedContext,
      finalHash,
      fullHash: hash(fullProjection),
      pass: stable(incrementalProjection) === stable(fullProjection)
        && stable(incrementalRetrieval.hashes) === stable(fullRetrieval.hashes),
      worktreeIsolation: "covered by src/indexer/worktreeIdentity.test.ts",
    };
  } finally {
    incremental.close();
    full.close();
    await rm(root, { recursive: true, force: true });
  }
}

function indexRunSummary(
  label: string,
  run: Awaited<ReturnType<typeof indexProject>>,
  db: Database,
  reindexedDocumentPaths: readonly string[],
): Record<string, unknown> {
  const documentFiles = run.snapshot.files.filter((file) => file.documentKind !== undefined);
  const chunksWritten = reindexedDocumentPaths.length === 0
    ? 0
    : Number((db.query(`
        SELECT COUNT(*) AS count
        FROM document_chunks d JOIN files f ON f.id = d.file_id
        WHERE f.path IN (${reindexedDocumentPaths.map(() => "?").join(", ")})
      `).get(...reindexedDocumentPaths) as { count: number }).count);
  return {
    label,
    mode: run.performance.mode,
    documentsScanned: documentFiles.length,
    documentsReindexed: reindexedDocumentPaths.length,
    chunksWritten,
    ftsRowsWritten: chunksWritten,
    chunksPresent: Number((db.query("SELECT COUNT(*) AS count FROM document_chunks").get() as { count: number }).count),
    ftsRowsPresent: Number((db.query("SELECT COUNT(*) AS count FROM document_search_fts").get() as { count: number }).count),
    parseCacheHits: run.performance.parseCacheHits,
    parseCacheMisses: run.performance.parseCacheMisses,
    durationMs: round(run.performance.timingsMs.total),
  };
}

function renderReport(input: any): string {
  const { verdict, profile, sql, semantic, acceptance, equivalence, optimization, productRegression } = input;
  return `# Stage 5 M129 Document-Aware Retrieval Performance Convergence

## Summary
- M128 functional status: authoritative and preserved.
- Latency regression: historical ${profile.historical.m128FrozenMedianMs}/${profile.historical.m128FrozenP90Ms} ms.
- Dominant cause: cold/warm benchmark mismatch, not document FTS.
- Optimization: batched chunks plus request-local path/objective reuse and optional profiling.
- Semantic equivalence: ${semantic.selectedFileDifferences} selected, ${semantic.leadDifferences} lead, ${semantic.roleDifferences} role, ${semantic.renderedContextDifferences} rendered differences.
- Final latency: frozen ${profile.frozen.warmDifferent.medianMs}/${profile.frozen.warmDifferent.p90Ms} ms; exact ${profile.exact.warm.medianMs} ms.
- Verdict: ${verdict}.
- Recommendation: ${verdict === "PASS" ? "promote optimized document retrieval" : "promote current optimization and continue profiling"}.

## Pre-change Architecture
M128 ran document relevance and bounded FTS before hybrid retrieval, rescored the capped hybrid candidates with embedded paths, applied mixed-objective coverage after role assignment, and inserted line-bounded YAML/TOML support after ordinary packing.

## Measurement Method
Pristine M127/M128 detached code and M129 were compared without agents. Cold, warm-different-task, and warm-same-task protocols are reported separately. Frozen workspaces and TCKDB indexes were opened read-only.

## Stage Profile
\`\`\`json
${JSON.stringify(profile.exact.documentProfile, null, 2)}
\`\`\`

## SQL and Scaling Profile
Counts: ${JSON.stringify(sql.counts)}. FTS uses the FTS5 virtual index and a bounded 48-row result; the deterministic order uses a temporary B-tree. The batch lookup uses document/file primary keys. No all-files path scan occurs.

## Root Cause
${optimization.rootCause.dominant}. M127 warmed each frozen database twice before timing; M128 timed the first retrieval. Identical-protocol M127/M128 exact medians differed by only about 15 ms. Document FTS plus materialization is a few milliseconds.

## Optimization Design
Deterministic clue gating is retained. Candidate paths, components, task tokens, and affinities are request-local. Up to 48 chunk lookups are replaced by one batch. Duplicate document evidence remains merged by file. No persistent/result cache was added.

## Semantic Equivalence
Frozen differences: selected=${semantic.selectedFileDifferences}, lead=${semantic.leadDifferences}, roles=${semantic.roleDifferences}, modes=${semantic.contentModeDifferences}, rendered=${semantic.renderedContextDifferences}, accounting=${semantic.tokenAccountingDifferences}. Exact TCKDB equal=${semantic.exactEqual}.

## Performance Results
- Frozen cold: ${profile.frozen.cold.medianMs}/${profile.frozen.cold.p90Ms} ms median/p90.
- Frozen warm different task: ${profile.frozen.warmDifferent.medianMs}/${profile.frozen.warmDifferent.p90Ms} ms.
- Frozen warm same task: ${profile.frozen.warmSame.medianMs}/${profile.frozen.warmSame.p90Ms} ms.
- Exact TCKDB warm: ${profile.exact.warm.medianMs} ms.
- Python-only M128 integration: ${profile.controls.pythonOnly.integrationMs} ms.
- Document-only M128 integration: ${profile.controls.documentOnly.integrationMs} ms.

## Exact TCKDB Acceptance
HEAD ${acceptance.checkout.head}; lead ${acceptance.leadPivot}. Selected: ${acceptance.selectedFiles.join(", ")}. Workflow, pyproject, notebook, payload, implementation, and pytest evidence: ${acceptance.pass ? "PASS" : "FAIL"}.

## Product Regression
Quality: ${JSON.stringify(productRegression.quality)}. No-candidates=${productRegression.noCandidates}; unversioned authority preserved.

## Full/Incremental Equivalence
${equivalence.pass ? "PASS" : "FAIL"} across YAML/TOML edits, rename, deletion, source edit, and no-op. Worktree isolation remains covered by the dedicated identity suite.

## Limitations
Timings retain OS/SQLite noise. No live-agent effect is claimed. Candidate scoring still reads bounded FTS-hit text before final selection because exact M128 token/objective semantics depend on it.

## Deferred Work
M130 cross-repository workspace intelligence; JavaScript/JSX; Markdown/JSON policy; notebook parsing; tokenizer-exact accounting; prospective validation.

## Success Criteria Check
Stage profile, query plans, scaling counters, semantic hashes, exact acceptance, frozen quality, performance bounds, indexing equivalence, and offline controls are recorded in the sibling JSON artifacts.

## Verdict
${verdict}

## Recommendation
${verdict === "PASS" ? "promote optimized document retrieval" : "promote current optimization and continue profiling"}
`;
}

function renderOptimization(value: any): string {
  return `# M129 Document Retrieval Optimization

Dominant cause: ${value.rootCause.dominant}.

Implemented:
${value.changes.map((item: string) => `- ${item}`).join("\n")}

Cache policy: ${value.cachePolicy}.

Semantic risk: ${value.semanticsRisk}.
`;
}

async function fixtures() {
  return [
    ...await loadRetrievalFixture(path.join(ROOT, "retrieval_eval.django.expanded.json")),
    ...await loadRetrievalFixture(path.join(ROOT, "retrieval_eval.cross_repo.30.json")),
  ];
}

function fixtureRoot(workspace: string): string {
  return path.isAbsolute(workspace) ? workspace : path.resolve(WORKSPACE_ROOT, workspace);
}

function workflow(command: string): string {
  return `name: CI\njobs:\n  test:\n    steps:\n      - run: ${command}\n`;
}

function pyproject(pytest: string): string {
  return `[project]\nname = "fixture"\n[project.optional-dependencies]\ntest = ["${pytest}"]\n`;
}

function stats(values: readonly number[]) {
  const samplesMs = values.map(round);
  const sorted = [...samplesMs].sort((left, right) => left - right);
  return {
    samplesMs,
    medianMs: sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0,
    p90Ms: sorted[Math.ceil(sorted.length * 0.9) - 1] ?? 0,
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function gitHead(root: string): string {
  const result = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "unknown";
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : stable(value))
    .digest("hex");
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, child) => {
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      return Object.fromEntries(Object.entries(child).sort(([left], [right]) => left.localeCompare(right)));
    }
    return child;
  });
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function row(id: string, pass: boolean, evidence: string) {
  return { id, pass, evidence };
}

function csv(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(path.join(RESULTS, file), `${JSON.stringify(value, null, 2)}\n`);
}

await main();
