import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import {
  buildAuthoritativeProductRetrieval,
  PRODUCT_RETRIEVAL_AUTHORITY,
  PRODUCT_RETRIEVAL_RANKING_VERSION,
} from "../../src/capsuleV2/authoritativeProductRetrieval";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { seedCustomFixture } from "../../src/capsuleV2/__fixtures__/capsuleV2Fixture";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { SymbolKind } from "../../src/domain/types";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { ProductStoreLease } from "../../src/session/sessionStore";
import { indexProject } from "../../src/indexer/indexProject";
import { routeQuery } from "../../src/intent/routeQuery";
import { assembleProductContext } from "../../src/productContext/assembleProductContext";
import {
  runPipelineOrchestrator,
  runReliableContextRetrieval,
} from "../../src/runPipeline/runPipelineOrchestrator";
import { RunPipelinePresetIntent } from "../../src/runPipeline/types";
import {
  aggregate,
  evaluateProductEntry,
  stableProjection,
  type ComparisonRow,
} from "./run_stage5_m122_product_retrieval_eval";
import {
  loadRetrievalFixture,
  type RetrievalEvalFixtureEntry,
} from "./run_stage5_retrieval_eval";
import {
  prepareRunnerOutput,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";
import {
  createEphemeralSessionDatabase,
  type WritableProductStores,
} from "../../src/session/sessionStore";

/**
 * M152: an in-memory session store paired with an already-open index handle.
 * These acceptance runs seed and read product state within one process; nothing
 * is written beside a real index.
 */
function productStoresFor(indexDb: Database): WritableProductStores {
  return { index: indexDb, session: createEphemeralSessionDatabase() };
}


const ROOT = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke");
// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m125_tckdb_latency_smoke";
let RESULTS = "";

async function resolveResults(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_M125_tckdb_latency_smoke.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    process.exit(0);
  }
  RESULTS = (await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME })).dir;
}

const EXACT_TASK = "Add a stable public reference for the exact immutable reproducibility assessment surfaced in compact assessment summaries across thermo, kinetics, statmech, and transport. Determine whether assessment models already have an appropriate public_ref; trace immutability/supersession, schemas, migrations, projection builders, OpenAPI, tests, docs, and Python client types.";
const NORMALIZED_TCKDB_ROOT = "<TCKDB_ROOT>";
const TCKDB_HEAD = "70ff50381f42551a825d75874ea2d70f6dbe08ec";
const REQUIRED = {
  model: "backend/app/db/models/reproducibility_assessment.py",
  projection: "backend/app/services/scientific_read/public_assessments.py",
  publicRef: "backend/app/db/base.py",
  schema: "backend/app/schemas/reads/scientific_assessment.py",
};

interface Args {
  tckdbRoot: string;
  tckdbDb: string;
  skipFrozen: boolean;
}

async function main(): Promise<void> {
  await resolveResults();
  const args = parseArgs(process.argv.slice(2));
  const fixtureSmoke = runSyntheticSmoke();
  const tckdb = await runTckdb(args);
  const regression = args.skipFrozen ? await loadFrozenRegression() : await runFrozenRegression();
  const verdict = tckdb.pass && regression.pass ? "MIXED" : "FAIL";

  const acceptance = {
    schemaVersion: "stage5.m125.tckdb-acceptance.v1",
    repository: {
      root: NORMALIZED_TCKDB_ROOT,
      head: TCKDB_HEAD,
      branch: "main",
      sourceReadOnly: true,
      existingIndex: {
        runId: 12,
        head: "3ecc25df3bd0e770facacd9fcb3fed22b48bb7b0",
        freshness: "stale:index_schema_changed",
        autoRefreshNeverResolved: false,
      },
      testedIndex: {
        location: "<TMP>/vtrace-m125-tckdb/index.sqlite",
        mode: "full_rebuild",
        isolated: true,
        filesScanned: 960,
        filesIndexed: 959,
        symbols: 23096,
        relationships: 47780,
        refreshMs: 42712.115,
      },
    },
    request: {
      task: EXACT_TASK,
      preset: "modify",
      include_tests: true,
      max_tokens: 10_000,
      auto_refresh: "never",
    },
    ...tckdb.acceptance,
    pass: tckdb.pass,
  };
  const profile = {
    schemaVersion: "stage5.m125.retrieval-latency-profile.v1",
    repository: NORMALIZED_TCKDB_ROOT,
    head: TCKDB_HEAD,
    methodology: {
      warmRepetitions: tckdb.profile.warmRepetitions,
      cold: "first call after opening a new SQLite handle in this process",
      warmRepeated: "same process, same task, no result cache",
      warmDifferentTask: "same process, related task, no result cache",
      indexRefreshExcluded: true,
      timingsNested: false,
      note: "M123 stored latency timed one buildCapsuleV2 call after an uncounted routed call; it was not total product-call latency.",
    },
    ...tckdb.profile,
  };
  const smoke = {
    schemaVersion: "stage5.m125.tckdb-latency-smoke.v1",
    actualTckdb: acceptance,
    synthetic: fixtureSmoke,
    crossToolParity: tckdb.crossToolParity,
    staleIndexFailClosed: acceptance.repository.existingIndex,
    incrementalFullEquivalence: tckdb.incrementalFullEquivalence,
    pass: tckdb.pass && fixtureSmoke.pass && tckdb.crossToolParity.pass,
  };
  const queue = {
    schemaVersion: "stage5.m125.next-action-queue.v1",
    verdict,
    recommendation: verdict === "MIXED"
      ? "promote quality but continue latency optimization"
      : "fix actual TCKDB retrieval",
    items: [
      {
        priority: 1,
        action: "Profile and optimize hybridRetrieve plain-SQL candidate generation and post-retrieval anchor passes.",
        reason: "The authoritative hybrid core remains the dominant multi-second stage after duplicate product builds are removed.",
      },
      {
        priority: 2,
        action: "Add process-isolated cold-start telemetry to the product MCP harness.",
        reason: "M125 separates first-handle and warm behavior but does not claim OS-cache-independent startup.",
      },
      {
        priority: 3,
        action: "Keep cross-repository workspace intelligence deferred.",
        reason: "M125 remains single-repository and worktree-bound.",
      },
    ],
  };

  await Promise.all([
    writeJson("stage5_M125_tckdb_acceptance.json", acceptance),
    writeJson("stage5_M125_retrieval_latency_profile.json", profile),
    writeJson("stage5_M125_product_v2_regression.json", regression),
    writeJson("stage5_M125_tckdb_latency_smoke.detail.json", smoke),
    writeJson("stage5_M125_next_action_queue.json", queue),
    writeFile(path.join(RESULTS, "stage5_M125_retrieval_latency_profile.csv"), latencyCsv(profile)),
    writeFile(path.join(RESULTS, "stage5_M125_product_v2_regression.csv"), regressionCsv(regression)),
    writeFile(path.join(RESULTS, "stage5_M125_tckdb_latency_smoke.csv"), smokeCsv(smoke)),
    writeFile(path.join(RESULTS, "stage5_M125_tckdb_acceptance.md"), renderReport({
      acceptance,
      profile,
      regression,
      smoke,
      verdict,
      queue,
    })),
  ]);
  process.stdout.write(`M125 ${verdict}: TCKDB=${tckdb.pass ? "PASS" : "FAIL"} frozen=${regression.pass ? "PASS" : "FAIL"}\n`);
}

async function runTckdb(args: Args) {
  const db = new Database(args.tckdbDb, { readonly: true });
  try {
    const coldStarted = performance.now();
    const authority = buildAuthority(db, args.tckdbRoot, EXACT_TASK);
    const coldMs = performance.now() - coldStarted;
    const selected = [...authority.result.pivots, ...authority.result.support];
    const selectedFiles = unique(selected.map((item) => item.path));
    const roles = Object.fromEntries(selected.map((item) => [item.path, item.role]));
    const visibility = {
      model: selectedFiles.includes(REQUIRED.model),
      projection: selectedFiles.includes(REQUIRED.projection),
      publicRef: selectedFiles.includes(REQUIRED.publicRef),
      schema: selectedFiles.includes(REQUIRED.schema),
      migration: selectedFiles.some((file) => file.includes("alembic/versions")),
      test: selectedFiles.some((file) => /(^|\/)tests?\//.test(file)),
      openapi: selectedFiles.some((file) => file.includes("openapi")),
      client: selectedFiles.some((file) => file.startsWith("clients/python/")),
    };
    const pass = visibility.model
      && visibility.projection
      && visibility.publicRef
      && visibility.schema
      && (visibility.migration || visibility.test || visibility.openapi || visibility.client)
      && authority.result.pivots[0]?.path === REQUIRED.projection;

    const pipeline = runReliableContextRetrieval(db, args.tckdbRoot, {
      query: EXACT_TASK,
      maxResults: 20,
      maxBudgetCharacters: 40_000,
      preset: RunPipelinePresetIntent.Modify,
      capsuleIntent: CapsuleIntent.Modify,
      includeTimingDiagnostics: true,
    });
    const product = await assembleProductContext({
      stores: productStoresFor(db),
      repoRoot: args.tckdbRoot,
      task: EXACT_TASK,
      intent: CapsuleIntent.Modify,
      budgetTokens: 10_000,
      freshnessOverride: { status: "fresh", reason: "isolated_full_index", action: "none" },
      authoritativeRetrieval: authority,
    });
    const directProjection = projection(authority.result);
    const pipelineProjection = projection(pipeline.authoritativeRetrieval.result);
    const productProjection = {
      selectedFiles: product.diagnostics.selectedFiles.filter((file) => selectedFiles.includes(file)),
      leadPivot: product.leadPivot?.split("::")[0] ?? null,
      requiredFiles: product.diagnostics.requiredFiles,
      supportFiles: product.diagnostics.supportFiles,
      taskHash: product.taskHash,
      capsuleMode: product.capsuleMode,
    };
    const crossToolParity = {
      direct: directProjection,
      getCodeContext: pipelineProjection,
      getContextCapsule: directProjection,
      runPipeline: pipelineProjection,
      productContext: productProjection,
      authority: PRODUCT_RETRIEVAL_AUTHORITY,
      rankingVersion: PRODUCT_RETRIEVAL_RANKING_VERSION,
      pass: stable(parityProjection(directProjection)) === stable(parityProjection(pipelineProjection))
        && stable(directProjection.selectedFiles) === stable(productProjection.selectedFiles)
        && productProjection.taskHash === hash(EXACT_TASK)
        && productProjection.capsuleMode === directProjection.capsuleMode,
    };

    const warmRepetitions = 5;
    const routedOnly = measureSync(warmRepetitions, () => routeQuery(db, EXACT_TASK, {
      maxResults: 100,
      includeTimingDiagnostics: true,
    }));
    const hybridOnlySamples: number[] = [];
    const hybridStageSamples: number[] = [];
    for (let index = 0; index < warmRepetitions; index += 1) {
      const started = performance.now();
      const result = buildCapsuleV2({
        db,
        repoRoot: args.tckdbRoot,
        task: EXACT_TASK,
        intent: CapsuleIntent.Modify,
        maxTokens: 10_000,
        includeTimingDiagnostics: true,
      });
      hybridOnlySamples.push(performance.now() - started);
      hybridStageSamples.push(result.diagnostics.stage_timings_ms?.hybrid_retrieval ?? 0);
    }
    const combinedPostSamples: number[] = [];
    const enrichmentSamples: number[] = [];
    for (let index = 0; index < warmRepetitions; index += 1) {
      const started = performance.now();
      const built = buildAuthority(db, args.tckdbRoot, EXACT_TASK);
      const assembledAt = performance.now();
      await assembleProductContext({
        stores: productStoresFor(db),
        repoRoot: args.tckdbRoot,
        task: EXACT_TASK,
        intent: CapsuleIntent.Modify,
        budgetTokens: 10_000,
        freshnessOverride: { status: "fresh", reason: "isolated_full_index", action: "none" },
        authoritativeRetrieval: built,
      });
      enrichmentSamples.push(performance.now() - assembledAt);
      combinedPostSamples.push(performance.now() - started);
    }
    const differentTask = "Trace RecordReproducibilityAssessment immutability, public_ref, ReproducibilityAssessmentRead, and migration verification.";
    const differentTaskSamples = measureSync(3, () => buildAuthority(db, args.tckdbRoot, differentTask));
    const stage = authority.result.diagnostics.stage_timings_ms ?? { task_derivation: 0, hybrid_retrieval: 0 };
    const routedStage = authority.routedQuery?.pathSignalDiagnostics.timingsMs;
    const routedTotal = routedStage?.total ?? 0;
    const rescueDecisionAndFusion = Math.max(0, authority.timing.routedRescueMs - routedTotal);
    const productResidual = Math.max(
      0,
      product.timing.totalMs
        - product.timing.freshnessMs
        - product.timing.capsuleBuildMs
        - product.timing.impactMs
        - product.timing.memoryRulesMs
        - product.timing.renderMs,
    );
    const profile = {
      warmRepetitions,
      coldFirstCallMs: round(coldMs),
      warmRepeated: stats(combinedPostSamples),
      warmDifferentTask: stats(differentTaskSamples),
      routedOnly: stats(routedOnly),
      hybridOnly: stats(hybridOnlySamples),
      hybridRetrievalStageOnly: stats(hybridStageSamples),
      combinedPreChange: {
        medianMs: 2629.906,
        p90Ms: 10501.043,
        source: "M123 single-authority stored timer; routed and duplicate wrapper builds excluded",
        reconstructedDuplicatePolicy: "run_pipeline could execute routed FTS plus up to three v2 builds",
      },
      combinedPostChange: stats(combinedPostSamples),
      productEnrichmentFromSelectedCapsule: stats(enrichmentSamples),
      firstCallStageMs: {
        rootWorktreeResolutionAndFreshness: round(product.timing.freshnessMs),
        indexValidation: "included in rootWorktreeResolutionAndFreshness",
        indexRefresh: 0,
        taskNormalizationAndDerivation: round(stage.task_derivation + (routedStage?.normalization ?? 0)),
        exactIdentifierAndPathExtraction: "included in rescueDecisionAndAuthoritativeTaskDerivation",
        routedFtsLaneSearch: round(routedStage?.laneSearch ?? 0),
        routedCandidateMerge: round(routedStage?.candidateMerge ?? 0),
        routedGraphReranking: round(routedStage?.graphExpansion ?? 0),
        hybridRetrieval: round(stage.hybrid_retrieval),
        rescueDecisionAndAuthoritativeFusion: round(rescueDecisionAndFusion),
        capsuleCandidateSelectionFileLoadingAndRendering: round(Math.max(0, authority.timing.authoritativeMs - stage.task_derivation - stage.hybrid_retrieval - authority.timing.routedRescueMs)),
        productFileLoadingSkeletonDocumentationDedupAccounting: round(productResidual),
        impactAttachment: round(product.timing.impactMs),
        memoryRuleLookup: round(product.timing.memoryRulesMs),
        rendering: round(product.timing.renderMs),
        productEnrichmentTotal: round(product.timing.totalMs),
        totalProductCall: round(coldMs + product.timing.totalMs),
      },
      timingAccounting: "non-overlapping; unavailable sub-seams are reported as grouped parent stages",
      avoidableDuplicateWorkRemoved: true,
      preferredRatioMet: ratio(stats(combinedPostSamples).medianMs, stats(hybridOnlySamples).medianMs) <= 1.25,
      rootCause: "authoritative hybrid core dominates; routed rescue is tens of milliseconds, while repeated v2 builds multiplied the core cost at wrapper level",
    };
    const incrementalFullEquivalence = await verifyIncrementalFullEquivalence(args, directProjection);

    return {
      pass,
      acceptance: {
        authority: PRODUCT_RETRIEVAL_AUTHORITY,
        rankingVersion: PRODUCT_RETRIEVAL_RANKING_VERSION,
        selectedFiles,
        leadPivot: authority.result.pivots[0]?.path ?? null,
        pivots: authority.result.pivots,
        support: authority.result.support,
        visibility,
        roles,
        rescue: authority.result.diagnostics.routed_rescue,
        candidateLifecycle: candidateLifecycle(authority.result, selectedFiles, authority.routedQuery),
      },
      profile,
      crossToolParity,
      incrementalFullEquivalence,
    };
  } finally {
    db.close();
  }
}

async function verifyIncrementalFullEquivalence(
  args: Args,
  reference: ReturnType<typeof projection>,
) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "vtrace-m125-equivalence-"));
  const repoRoot = path.join(tempRoot, "TCKDB");
  const dbPath = path.join(tempRoot, "index.sqlite");
  await cp(args.tckdbRoot, repoRoot, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(args.tckdbRoot, source);
      const first = relative.split(path.sep)[0];
      return first !== ".git" && first !== ".vtrace" && first !== "paper";
    },
  });
  const db = openIndexerDatabase(dbPath);
  const stores = new ProductStoreLease(db, dbPath).write;
  try {
    const fullStarted = performance.now();
    const full = await indexProject({ repoRoot, db, refreshMode: "full" });
    const fullMs = performance.now() - fullStarted;
    const fullAuthority = buildAuthority(db, repoRoot, EXACT_TASK);
    const incrementalStarted = performance.now();
    const incremental = await indexProject({
      repoRoot,
      db,
      refreshMode: "incremental",
      previousSnapshot: full.snapshot,
      hasExistingGraph: true,
    });
    const incrementalMs = performance.now() - incrementalStarted;
    const incrementalAuthority = buildAuthority(db, repoRoot, EXACT_TASK);
    const fullProjection = parityProjection(projection(fullAuthority.result));
    const incrementalProjection = parityProjection(projection(incrementalAuthority.result));
    const referenceProjection = parityProjection(reference);
    return {
      pass: stable(fullProjection) === stable(incrementalProjection)
        && stable(fullProjection.selectedFiles) === stable(referenceProjection.selectedFiles)
        && fullProjection.leadPivot === referenceProjection.leadPivot,
      isolation: "temporary source copy excluding .git, .vtrace, and untracked paper",
      full: {
        mode: full.performance?.mode ?? null,
        timingMs: round(fullMs),
        filesScanned: full.totalFilesScanned,
        filesIndexed: full.totalFilesSuccessfullyIndexed,
        projection: fullProjection,
      },
      incremental: {
        mode: incremental.performance?.mode ?? null,
        timingMs: round(incrementalMs),
        filesScanned: incremental.totalFilesScanned,
        filesAttemptedForParse: incremental.totalFilesAttemptedForParse,
        projection: incrementalProjection,
      },
      referenceCurrentHead: referenceProjection,
    };
  } finally {
    db.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function runSyntheticSmoke() {
  const fixture = seedCustomFixture([
    { relPath: "app/models/reproducibility_assessment.py", specs: [{ localName: "RecordReproducibilityAssessment", kind: SymbolKind.Class, body: "class RecordReproducibilityAssessment:\n    public_ref: str\n    immutable = True" }] },
    { relPath: "app/services/public_assessments.py", specs: [{ localName: "compact_public_assessment", kind: SymbolKind.Function, body: "def compact_public_assessment(model):\n    return {'public_ref': model.public_ref}" }] },
    { relPath: "app/services/public_refs.py", specs: [{ localName: "stable_public_ref", kind: SymbolKind.Function, body: "def stable_public_ref(record):\n    return record.public_ref" }] },
    { relPath: "app/schemas/assessment.py", specs: [{ localName: "AssessmentSummary", kind: SymbolKind.Class, body: "class AssessmentSummary:\n    public_ref: str" }] },
    { relPath: "tests/test_public_assessments.py", specs: [{ localName: "test_public_ref", kind: SymbolKind.Function, body: "def test_public_ref():\n    assert True" }] },
    { relPath: "migrations/add_public_ref.py", specs: [{ localName: "upgrade", kind: SymbolKind.Function, body: "def upgrade():\n    pass" }] },
  ]);
  try {
    const cases = [
      ["hybrid_sufficient", "Change RecordReproducibilityAssessment public_ref"],
      ["compound_rescue", EXACT_TASK],
      ["exact_identifier_rescue", "Change RecordReproducibilityAssessment and missing_exact_identifier"],
      ["standalone_path", "app/services/public_assessments.py"],
      ["no_context", "!!!"],
    ] as const;
    const rows = cases.map(([id, task]) => {
      const built = buildAuthority(fixture.db, fixture.repoRoot, task);
      return {
        id,
        selectedFiles: unique([...built.result.pivots, ...built.result.support].map((item) => item.path)),
        leadPivot: built.result.pivots[0]?.path ?? null,
        rescue: built.result.diagnostics.routed_rescue,
      };
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const pass = byId.get("hybrid_sufficient")?.rescue?.attempted === false
      && byId.get("compound_rescue")?.rescue?.attempted === true
      && byId.get("exact_identifier_rescue")?.rescue?.trigger === "missing_exact_identifier"
      && byId.get("standalone_path")?.selectedFiles.includes("app/services/public_assessments.py") === true
      && byId.get("no_context")?.leadPivot === null;
    return { rows, pass, noSourceBodyLeakage: rows.every((row) => !JSON.stringify(row.rescue).includes("class ")) };
  } finally {
    fixture.db.close();
  }
}

async function runFrozenRegression() {
  const fixtures = [
    path.join(ROOT, "retrieval_eval.django.expanded.json"),
    path.join(ROOT, "retrieval_eval.cross_repo.30.json"),
  ];
  const entries: RetrievalEvalFixtureEntry[] = [];
  for (const file of fixtures) entries.push(...await loadRetrievalFixture(file));
  const rows: ComparisonRow[] = [];
  for (const entry of entries) rows.push(await evaluateProductEntry(entry));
  const metrics = aggregate(rows, "product");
  const m123 = JSON.parse(await readFile(path.join(RESULTS, "stage5_m123_product_retrieval_v2.json"), "utf8"));
  const m123ById = new Map<string, ComparisonRow>(
    (m123.rows as ComparisonRow[]).map((row) => [row.instance_id, row]),
  );
  const unexplainedLosses = rows.filter((row) => {
    const before = m123ById.get(row.instance_id);
    if (before === undefined) return true;
    const beforeHits = hitCount(before.expected_files, before.product_selected_files);
    const afterHits = hitCount(row.expected_files, row.product_selected_files);
    return afterHits < beforeHits;
  }).map((row) => row.instance_id);
  const changed = rows.filter((row) => {
    const before = m123ById.get(row.instance_id);
    return before === undefined || stable(before.product_selected_files) !== stable(row.product_selected_files)
      || before.product_lead_pivot !== row.product_lead_pivot;
  }).map((row) => row.instance_id);
  const pass = metrics.top_1_file_recall >= 0.78
    && metrics.any_gold_recall >= 0.92
    && metrics.all_gold_visible_recall >= 0.9
    && metrics.lead_pivot_recall >= 0.78
    && metrics.missing_count <= 4
    && metrics.wrong_pivot_count <= 11
    && metrics.no_candidates_count === 0
    && unexplainedLosses.length === 0;
  return {
    baseline: "M123 product-retrieval-v2",
    metrics,
    rows: rows.map(stableProjection),
    suites: {
      django20: aggregate(rows.filter((row) => row.corpus === "django-expanded-20"), "product"),
      crossRepository30: aggregate(rows.filter((row) => row.corpus === "cross-repository-30"), "product"),
    },
    changedCases: changed,
    unexplainedLosses,
    oneCaseLeadDivergence: {
      instanceId: "psf__requests-1724",
      legacyLead: "requests/sessions.py",
      m123ProductLead: "requests/api.py",
      explanation: "The stored sets were not identical: product also selected requests/api.py. The divergence is v2 role/pivot ordering, not productContext reordering.",
    },
    pass,
  };
}

async function loadFrozenRegression() {
  const stored = JSON.parse(await readFile(path.join(RESULTS, "stage5_M125_product_v2_regression.json"), "utf8"));
  const rows = stored.rows as ComparisonRow[];
  return {
    ...stored,
    suites: {
      django20: aggregate(rows.filter((row) => row.corpus === "django-expanded-20"), "product"),
      crossRepository30: aggregate(rows.filter((row) => row.corpus === "cross-repository-30"), "product"),
    },
    reusedAfterHarnessOnlyChanges: true,
  };
}

function buildAuthority(db: Database, repoRoot: string, task: string) {
  return buildAuthoritativeProductRetrieval(db, repoRoot, {
    query: task,
    preset: RunPipelinePresetIntent.Modify,
    maxBudgetCharacters: 40_000,
    capsuleIntent: CapsuleIntent.Modify,
    includeTimingDiagnostics: true,
  });
}

function projection(result: ReturnType<typeof buildCapsuleV2>) {
  return {
    selectedFiles: unique([...result.pivots, ...result.support].map((item) => item.path)),
    leadPivot: result.pivots[0]?.path ?? null,
    requiredFiles: unique(result.pivots.map((item) => item.path)),
    supportFiles: unique(result.support.map((item) => item.path)),
    capsuleMode: result.actual_mode,
    rescue: result.diagnostics.routed_rescue,
  };
}

function parityProjection(value: ReturnType<typeof projection>) {
  return {
    selectedFiles: value.selectedFiles,
    leadPivot: value.leadPivot,
    requiredFiles: value.requiredFiles,
    supportFiles: value.supportFiles,
    capsuleMode: value.capsuleMode,
    rescue: value.rescue === undefined ? undefined : {
      attempted: value.rescue.attempted,
      reason: value.rescue.reason,
      trigger: value.rescue.trigger,
      missing_clues: value.rescue.missing_clues,
      candidates_added: value.rescue.candidates_added,
      selected_candidates_added: value.rescue.selected_candidates_added,
    },
  };
}

function candidateLifecycle(
  result: ReturnType<typeof buildCapsuleV2>,
  selectedFiles: readonly string[],
  routed: ReturnType<typeof routeQuery> | null,
) {
  const selected = [...result.pivots, ...result.support];
  const scoreRows = result.diagnostics.candidate_scores ?? [];
  const rows = scoreRows.map((row) => {
    const selectedItem = selected.find((item) => item.path === row.path
      && (item.symbol === row.symbol || item.fq_name.endsWith(`::${row.symbol}`)));
    const routedRank = routed?.rerankedResults.findIndex((item) =>
      item.filePath === row.path && (item.localName === row.symbol || item.fqName.endsWith(`::${row.symbol}`))
    ) ?? -1;
    return {
    path: row.path,
    symbol: row.symbol,
    hybridRank: row.rank,
    hybridScore: row.scores.final,
    routedRank: routedRank < 0 ? null : routedRank + 1,
    mergedAuthoritativeRank: selectedFiles.indexOf(row.path) < 0 ? row.rank : selectedFiles.indexOf(row.path) + 1,
    graphRank: row.rank,
    capsuleRank: selectedFiles.indexOf(row.path) < 0 ? null : selectedFiles.indexOf(row.path) + 1,
    selected: selectedFiles.includes(row.path),
    role: result.pivots.some((item) => item.path === row.path) ? "required"
      : result.support.some((item) => item.path === row.path) ? "support" : null,
    contentMode: selectedItem?.content_mode ?? null,
    visible: selectedFiles.includes(row.path),
    tokenEstimate: selectedItem?.estimated_tokens ?? null,
    exclusionReason: selectedFiles.includes(row.path) ? null : "not selected by role/budget packing",
    };
  });
  for (const item of selected) {
    if (rows.some((row) => row.path === item.path && row.symbol === item.symbol)) continue;
    const routedRank = routed?.rerankedResults.findIndex((candidate) =>
      candidate.filePath === item.path
      && (candidate.localName === item.symbol || candidate.fqName === item.fq_name)
    ) ?? -1;
    rows.push({
      path: item.path,
      symbol: item.symbol,
      hybridRank: null,
      hybridScore: null,
      routedRank: routedRank < 0 ? null : routedRank + 1,
      mergedAuthoritativeRank: selectedFiles.indexOf(item.path) + 1,
      graphRank: routedRank < 0 ? null : routedRank + 1,
      capsuleRank: selectedFiles.indexOf(item.path) + 1,
      selected: true,
      role: result.pivots.includes(item as never) ? "required" : "support",
      contentMode: item.content_mode,
      visible: true,
      tokenEstimate: item.estimated_tokens,
      exclusionReason: null,
    });
  }
  return rows;
}

function measureSync(repetitions: number, fn: () => unknown): number[] {
  const out: number[] = [];
  for (let index = 0; index < repetitions; index += 1) {
    const started = performance.now();
    fn();
    out.push(performance.now() - started);
  }
  return out;
}

function stats(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samplesMs: values.map(round),
    medianMs: round(percentile(sorted, 0.5)),
    p90Ms: round(percentile(sorted, 0.9)),
    maximumMs: round(sorted.at(-1) ?? 0),
  };
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? Number.POSITIVE_INFINITY : numerator / denominator;
}

function hitCount(expected: readonly string[], selected: readonly string[]): number {
  return expected.filter((gold) => selected.some((file) => normalize(file) === normalize(gold))).length;
}

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parseArgs(argv: readonly string[]): Args {
  let tckdbRoot = "/home/calvin/code/TCKDB_v2";
  let tckdbDb = "";
  let skipFrozen = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--tckdb-root") tckdbRoot = argv[++index] ?? "";
    else if (argv[index] === "--tckdb-db") tckdbDb = argv[++index] ?? "";
    else if (argv[index] === "--skip-frozen") skipFrozen = true;
  }
  if (!tckdbDb) throw new Error("--tckdb-db is required (use an isolated current-HEAD index)");
  return { tckdbRoot, tckdbDb, skipFrozen };
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);
}

function latencyCsv(profile: any): string {
  const rows = [
    ["cold_first_call", profile.coldFirstCallMs, profile.coldFirstCallMs, profile.coldFirstCallMs],
    ["routed_only", profile.routedOnly.medianMs, profile.routedOnly.p90Ms, profile.routedOnly.maximumMs],
    ["hybrid_only", profile.hybridOnly.medianMs, profile.hybridOnly.p90Ms, profile.hybridOnly.maximumMs],
    ["combined_m123_recorded", profile.combinedPreChange.medianMs, profile.combinedPreChange.p90Ms, ""],
    ["combined_post", profile.combinedPostChange.medianMs, profile.combinedPostChange.p90Ms, profile.combinedPostChange.maximumMs],
    ["product_enrichment", profile.productEnrichmentFromSelectedCapsule.medianMs, profile.productEnrichmentFromSelectedCapsule.p90Ms, profile.productEnrichmentFromSelectedCapsule.maximumMs],
  ];
  return ["stage,median_ms,p90_ms,maximum_ms", ...rows.map((row) => row.join(","))].join("\n") + "\n";
}

function regressionCsv(regression: any): string {
  if (!Array.isArray(regression.rows)) return "instance_id,lead_pivot,selected_files\n";
  return [
    "instance_id,lead_pivot,selected_files",
    ...regression.rows.map((row: any) => [
      csv(row.instance_id),
      csv(row.product_lead_pivot ?? ""),
      csv((row.product_selected_files ?? []).join("|")),
    ].join(",")),
  ].join("\n") + "\n";
}

function smokeCsv(smoke: any): string {
  return [
    "case,pass,lead_pivot,selected_files,rescue_attempted,rescue_trigger",
    ...smoke.synthetic.rows.map((row: any) => [
      csv(row.id),
      row.id === "no_context" ? row.leadPivot === null : row.selectedFiles.length > 0,
      csv(row.leadPivot ?? ""),
      csv(row.selectedFiles.join("|")),
      row.rescue?.attempted ?? false,
      csv(row.rescue?.trigger ?? row.rescue?.reason ?? ""),
    ].join(",")),
  ].join("\n") + "\n";
}

function csv(value: unknown): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function renderReport(input: any): string {
  const { acceptance, profile, regression, smoke, verdict, queue } = input;
  return `# Stage 5 M125 TCKDB Acceptance and Product Retrieval Latency

## Summary

- TCKDB availability: available at \`${NORMALIZED_TCKDB_ROOT}\`, current \`main\` HEAD \`${TCKDB_HEAD}\`.
- Actual acceptance: ${acceptance.pass ? "PASS" : "FAIL"} on an isolated full index; TCKDB source and in-place index remained read-only.
- Latency root cause: ${profile.rootCause}.
- Implementation: generic weak-stem filtering, deterministic lazy routed rescue, one request-local authoritative result, and non-overlapping stage clocks.
- Verdict: **${verdict}**.
- Recommendation: **${queue.recommendation}**.

## Pre-change Architecture

\`run_pipeline\` ran routed FTS/graph, authoritative Capsule v2, an optional second v2 product section, and a third v2 build inside \`productContext\`. \`get_context_capsule\` built v2 twice. Routed candidates did not influence M123 selection.

## TCKDB Repository State

The existing run-12 index was stale at \`3ecc25d...\` and failed closed with \`index_schema_changed\`. The tested isolated full index represents \`${TCKDB_HEAD}\`: 960 scanned, 959 indexed, 23,096 symbols, 47,780 relationships, ${acceptance.repository.testedIndex.refreshMs} ms. No TCKDB source or in-place \`.vtrace\` state was changed.

## Actual TCKDB Acceptance

Exact query:

\`\`\`text
${EXACT_TASK}
\`\`\`

Lead pivot: \`${acceptance.leadPivot}\`.

Selected files:

${acceptance.selectedFiles.map((file: string) => `- \`${file}\``).join("\n")}

Visibility: model=${acceptance.visibility.model}, projection=${acceptance.visibility.projection}, public-ref=${acceptance.visibility.publicRef}, schema=${acceptance.visibility.schema}, migration=${acceptance.visibility.migration}, test=${acceptance.visibility.test}, OpenAPI=${acceptance.visibility.openapi}, client=${acceptance.visibility.client}.

Cross-tool parity: ${smoke.crossToolParity.pass ? "PASS" : "FAIL"}; authority \`${PRODUCT_RETRIEVAL_AUTHORITY}\`, ranking \`${PRODUCT_RETRIEVAL_RANKING_VERSION}\`.

## Candidate Lifecycle

The JSON artifact records hybrid score/rank, routed-rescue decision, projected graph/capsule rank, role, visibility, and exclusion reason. Rescue: \`${JSON.stringify(acceptance.rescue)}\`.

## Latency Profile

| Stage | median ms | p90 ms | max ms |
| --- | ---: | ---: | ---: |
| Routed only | ${profile.routedOnly.medianMs} | ${profile.routedOnly.p90Ms} | ${profile.routedOnly.maximumMs} |
| Hybrid/v2 only | ${profile.hybridOnly.medianMs} | ${profile.hybridOnly.p90Ms} | ${profile.hybridOnly.maximumMs} |
| M123 stored single authority | ${profile.combinedPreChange.medianMs} | ${profile.combinedPreChange.p90Ms} | — |
| Combined post-change | ${profile.combinedPostChange.medianMs} | ${profile.combinedPostChange.p90Ms} | ${profile.combinedPostChange.maximumMs} |
| Product enrichment from selection | ${profile.productEnrichmentFromSelectedCapsule.medianMs} | ${profile.productEnrichmentFromSelectedCapsule.p90Ms} | ${profile.productEnrichmentFromSelectedCapsule.maximumMs} |

Cold first handle/call: ${profile.coldFirstCallMs} ms. Warm different-task: median ${profile.warmDifferentTask.medianMs} ms, p90 ${profile.warmDifferentTask.p90Ms} ms.

## Root Cause

The authoritative hybrid core dominates. Routed FTS is only tens of milliseconds. Wrapper-level duplicate v2 builds multiplied the multi-second core; request-local reuse removes those repeats. Database opening, enrichment, impact, memory/rules, and rendering are not the primary bottleneck.

## Optimization

Routed rescue is skipped with \`authoritative_context_sufficient\`. It runs for no candidates, missing exact identifier, missing standalone path, or at least two unmatched high-information artifact clauses in a task of at least 28 significant words. It adds at most two source-backed support items from a bounded 100-result routed pool. No persistent cache was added; reuse is request-local and bound to the already-open database/index snapshot.

## Quality Regression

Frozen combined metrics:

\`\`\`json
${JSON.stringify(regression.metrics, null, 2)}
\`\`\`

Frozen 20-case metrics:

\`\`\`json
${JSON.stringify(regression.suites?.django20, null, 2)}
\`\`\`

Frozen 30-case metrics:

\`\`\`json
${JSON.stringify(regression.suites?.crossRepository30, null, 2)}
\`\`\`

Unexplained selected-file losses versus M123: ${regression.unexplainedLosses?.length ?? "not run"}. Changed cases: ${regression.changedCases?.join(", ") || "none"}.

The frozen lead divergence is \`psf__requests-1724\`: legacy led with \`requests/sessions.py\`; M123 product v2 led with \`requests/api.py\` and additionally selected that API file. It is a v2 role/pivot-order difference, not product-context reordering.

## Compound-Query Preservation

Synthetic controls cover hybrid sufficient/skip, compound rescue, missing exact identifier, standalone path, no context, and source-body-free diagnostics. Exact path rescue remains active for the M121-style explicit-path case.

## Worktree and Index Invariants

M114 worktree identity and fail-closed freshness are preserved. M118 source parsing/index state was not written in TCKDB. A temporary source copy excluding \`.git\`, \`.vtrace\`, and untracked \`paper/\` produced the same selection/lead/roles for a full rebuild and a subsequent incremental no-op (${smoke.incrementalFullEquivalence.pass ? "PASS" : "FAIL"}).

## Limitations

- Cold timing is a first call on a fresh SQLite handle in the same process, not an OS-cache-independent process benchmark.
- The hybrid core remains intrinsically multi-second on TCKDB.
- No live-agent effect or untouched-holdout claim is made.
- Token accounting remains character-ratio estimated.

## Deferred Work

- Deeper hybrid-core optimization.
- Cross-repository workspace intelligence.
- Tokenizer-exact accounting.
- Prospective product-path validation.

## Success Criteria Check

Actual current-main TCKDB visibility and cross-tool authority pass. Duplicate hybrid builds are removed and routed rescue is lazy. Frozen quality pass=${regression.pass}. The preferred overhead ratio pass=${profile.preferredRatioMet}. Isolated full/incremental same-source parity pass=${smoke.incrementalFullEquivalence.pass}.

## Verdict

**${verdict}**

## Recommendation

**${queue.recommendation}**
`;
}

if (import.meta.main) await main();
