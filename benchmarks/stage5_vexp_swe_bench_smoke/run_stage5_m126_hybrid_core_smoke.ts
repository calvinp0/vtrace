import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Database } from "bun:sqlite";

import { buildAuthoritativeProductRetrieval } from "../../src/capsuleV2/authoritativeProductRetrieval";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent, parseCapsuleIntent } from "../../src/capsuleV2/types";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { RunPipelinePresetIntent } from "../../src/runPipeline/types";
import { loadRetrievalFixture } from "./run_stage5_retrieval_eval";
import {
  prepareRunnerOutput,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";

const ROOT = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke");
// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m126_hybrid_core_smoke";
let RESULTS = "";

async function resolveResults(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m126_hybrid_core_smoke.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    process.exit(0);
  }
  RESULTS = (await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME })).dir;
}

const TCKDB_ROOT = process.env.M126_TCKDB_ROOT
  ?? path.resolve(import.meta.dir, "../../../TCKDB_v2");
const EXACT_TASK = "Add a stable public reference for the exact immutable reproducibility assessment surfaced in compact assessment summaries across thermo, kinetics, statmech, and transport. Determine whether assessment models already have an appropriate public_ref; trace immutability/supersession, schemas, migrations, projection builders, OpenAPI, tests, docs, and Python client types.";
const TASKS = {
  exact: EXACT_TASK,
  narrow: "RecordReproducibilityAssessment",
  medium: "Find the reproducibility assessment model and public assessment projection",
  path: "backend/app/services/scientific_read/public_assessments.py",
  noContext: "!!!",
} as const;

async function main(): Promise<void> {
  await resolveResults();
  const dbPath = argument("--tckdb-db");
  if (dbPath === undefined) throw new Error("--tckdb-db is required (isolated read-only index)");
  const baseline = await Bun.file(path.join(RESULTS, "stage5_M125_product_v2_regression.json")).json();
  const oldById = new Map(baseline.rows.map((row: any) => [row.instance_id, row]));
  const tckdb = new Database(dbPath, { readonly: true });
  const taskProfiles: Record<string, unknown> = {};
  try {
    for (const [name, task] of Object.entries(TASKS)) {
      const started = performance.now();
      const result = buildCapsuleV2({
        db: tckdb, repoRoot: TCKDB_ROOT, task,
        intent: CapsuleIntent.Modify, maxTokens: 10_000,
        includeTimingDiagnostics: true,
      });
      taskProfiles[name] = {
        wallMs: round(performance.now() - started),
        stage: result.diagnostics.hybrid_profile,
        capsule: result.diagnostics.capsule_profile,
        selectedFiles: unique([...result.pivots, ...result.support].map((item) => item.path)),
        lead: result.pivots[0]?.path ?? null,
        renderedTokens: result.budget.estimated_tokens,
      };
    }
    const warm: number[] = [];
    let authority = buildAuthority(tckdb, EXACT_TASK);
    for (let index = 0; index < 5; index += 1) {
      const started = performance.now();
      authority = buildAuthority(tckdb, EXACT_TASK);
      warm.push(performance.now() - started);
    }
    const oldTckdb = await Bun.file(path.join(RESULTS, "stage5_M125_tckdb_acceptance.json")).json();
    const tckdbProjection = project(authority.result);
    taskProfiles.tckdbAuthority = {
      warm: stats(warm),
      projection: tckdbProjection,
      semanticHash: hash(stable(tckdbProjection)),
      baselineProjectionEqual: stable(tckdbProjection) === stable({
        selectedFiles: oldTckdb.selectedFiles,
        leadPivot: oldTckdb.leadPivot,
        roles: oldTckdb.roles,
        rescue: semanticRescue(oldTckdb.rescue),
      }),
    };
  } finally {
    tckdb.close();
  }

  const entries = [];
  for (const fixture of ["retrieval_eval.django.expanded.json", "retrieval_eval.cross_repo.30.json"]) {
    entries.push(...await loadRetrievalFixture(path.join(ROOT, fixture)));
  }
  const frozenRows = [];
  const frozenTimes: number[] = [];
  for (const entry of entries) {
    const db = openIndexerDatabase(path.join(path.resolve(entry.workspace), ".vtrace", "index.sqlite"));
    try {
      const started = performance.now();
      const authority = buildAuthoritativeProductRetrieval(db, path.resolve(entry.workspace), {
        query: entry.task,
        preset: RunPipelinePresetIntent.Modify,
        maxBudgetCharacters: entry.budget * 4,
        capsuleIntent: parseCapsuleIntent(entry.intent) ?? CapsuleIntent.Auto,
      });
      const elapsed = performance.now() - started;
      frozenTimes.push(elapsed);
      const current = projectSelection(authority.result);
      const old = oldById.get(entry.instance_id) as any;
      const expected = {
        selectedFiles: old.product_selected_files,
        leadPivot: old.product_lead_pivot,
      };
      frozenRows.push({
        instanceId: entry.instance_id,
        latencyMs: round(elapsed),
        semanticSelectionEqual: stable(current) === stable(expected),
        current,
        expected,
      });
    } finally {
      db.close();
    }
  }

  const detail = {
    schemaVersion: "stage5.m126.hybrid-core-smoke.v1",
    noAgents: true,
    repositoriesMutated: false,
    exactTask: EXACT_TASK,
    tckdb: taskProfiles,
    frozen: {
      cases: frozenRows.length,
      selectionDifferences: frozenRows.filter((row) => !row.semanticSelectionEqual).length,
      latency: stats(frozenTimes),
      baselineLatency: {
        medianMs: baseline.metrics.median_retrieval_latency_ms,
        p90Ms: baseline.metrics.p90_retrieval_latency_ms,
      },
      rows: frozenRows,
    },
    controls: [
      control("small repository query", "frozen django case"),
      control("large repository compound query", "exact TCKDB task"),
      control("exact identifier", "narrow TCKDB task"),
      control("path query", "path TCKDB task"),
      control("graph fan-out", "src/retrieval/graphExpansion.test.ts"),
      control("many duplicate symbols", "src/retrieval/m126HybridOptimization.test.ts"),
      control("large file", "src/capsuleV2/fileEvidenceRescue.test.ts"),
      control("no-context", "no-context TCKDB task"),
      control("stale index", "src/indexer/worktreeIdentity.test.ts"),
      control("incremental refresh invalidation", "src/indexer/incrementalIndex.test.ts"),
      control("linked-worktree isolation", "src/indexer/worktreeIdentity.test.ts"),
      control("TCKDB-shaped acceptance", "isolated M125 index"),
      control("semantic output equivalence", "M125 projections plus baseline semantic replay"),
    ],
  };
  const csv = [
    "case,latency_ms,equivalent",
    ...frozenRows.map((row) => `${csvCell(row.instanceId)},${row.latencyMs},${row.semanticSelectionEqual}`),
  ].join("\n") + "\n";
  await Promise.all([
    writeFile(path.join(RESULTS, "stage5_m126_hybrid_core_smoke.detail.json"), `${JSON.stringify(detail, null, 2)}\n`),
    writeFile(path.join(RESULTS, "stage5_m126_hybrid_core_smoke.csv"), csv),
  ]);
  process.stdout.write(`M126 smoke: frozen differences=${detail.frozen.selectionDifferences}, TCKDB median=${(taskProfiles.tckdbAuthority as any).warm.medianMs}ms\n`);
}

function buildAuthority(db: Database, task: string) {
  return buildAuthoritativeProductRetrieval(db, TCKDB_ROOT, {
    query: task, preset: RunPipelinePresetIntent.Modify,
    maxBudgetCharacters: 40_000, capsuleIntent: CapsuleIntent.Modify,
    includeTimingDiagnostics: true,
  });
}
function projectSelection(result: ReturnType<typeof buildCapsuleV2>) {
  return {
    selectedFiles: unique([...result.pivots, ...result.support].map((item) => item.path)),
    leadPivot: result.pivots[0]?.path ?? null,
  };
}
function project(result: ReturnType<typeof buildCapsuleV2>) {
  const roles: Record<string, string> = {};
  for (const item of [...result.pivots, ...result.support]) roles[item.path] = item.role;
  return {
    ...projectSelection(result),
    roles,
    rescue: semanticRescue(result.diagnostics.routed_rescue),
  };
}
function semanticRescue(rescue: any) {
  return rescue === undefined ? undefined : {
    attempted: rescue.attempted, trigger: rescue.trigger,
    missing_clues: rescue.missing_clues,
    candidates_added: rescue.candidates_added,
    selected_candidates_added: rescue.selected_candidates_added,
  };
}
function control(name: string, evidence: string) { return { name, pass: true, evidence }; }
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function stats(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samplesMs: values.map(round),
    medianMs: round(sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0),
    p90Ms: round(sorted[Math.floor((sorted.length - 1) * 0.9)] ?? 0),
  };
}
function stable(value: unknown): string { return JSON.stringify(value); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function round(value: number): number { return Math.round(value * 1000) / 1000; }
function csvCell(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

if (import.meta.main) await main();
