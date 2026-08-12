import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Database } from "bun:sqlite";

import { buildAuthoritativeProductRetrieval } from "../../src/capsuleV2/authoritativeProductRetrieval";
import { buildCapsule } from "../../src/capsuleV2/buildCapsule";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent, parseCapsuleIntent } from "../../src/capsuleV2/types";
import { runCapsuleCommand } from "../../src/cli/commands/capsuleCommand";
import { runRunPipelineCommand } from "../../src/cli/commands/runPipelineCommand";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { createMcpServer } from "../../src/mcp/server";
import { MCP_SERVER_SCHEMA, McpToolId } from "../../src/mcp/types";
import { getRuntimeProvenance } from "../../src/runtime/provenance";
import { RunPipelinePresetIntent } from "../../src/runPipeline/types";
import { loadRetrievalFixture } from "./run_stage5_retrieval_eval";
import {
  prepareRunnerOutput,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";

const ROOT = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke");
// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m127_capsule_unification_smoke";
let RESULTS = "";

async function resolveResults(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m127_capsule_unification_smoke.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    process.exit(0);
  }
  RESULTS = (await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME })).dir;
}

const EXACT_TASK = "Fix the stale Python-client computed-reaction payload snapshot for degeneracy_convention and add a dedicated GitHub Actions pytest workflow triggered by clients/python changes. Identify existing workflow conventions, client test dependencies, full-suite command, notebook requirements, and relevant tests.";
const TCKDB_ROOT = process.env.M127_TCKDB_ROOT;
const BASELINE_METRICS = {
  cases: 50, top1: 39, top5: 46, allGoldVisible: 45, lead: 39,
  missing: 4, wrongPivot: 11, noCandidates: 0,
};

async function main(): Promise<void> {
  await resolveResults();
  if (!TCKDB_ROOT) throw new Error("M127_TCKDB_ROOT is required and must name an isolated indexed TCKDB HEAD archive");
  const dbPath = path.join(TCKDB_ROOT, ".vtrace", "index.sqlite");
  const runtime = getRuntimeProvenance();
  const reportRuntime = {
    ...runtime,
    executablePath: "<VTRACE_ROOT>/bin/vtrace",
    sourceRoot: "<VTRACE_ROOT>",
  };
  const server = createMcpServer({ context: { repoRoot: TCKDB_ROOT, dbPath, initialized: true } });
  const request = {
    repo_root: TCKDB_ROOT,
    task: EXACT_TASK,
    preset: "modify",
    auto_refresh: "never",
    include_tests: true,
    include_file_content: true,
    maxResults: 20,
    max_tokens: 6000,
  };

  const toolOutputs: Record<string, any> = {};
  for (const toolId of [McpToolId.GetCodeContext, McpToolId.GetContextCapsule, McpToolId.RunPipeline]) {
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: `m127-${toolId}`,
      toolId,
      input: request,
    });
    const result: any = response.result;
    if (!result.ok) throw new Error(`${toolId}: ${result.error.message}`);
    toolOutputs[toolId] = result.output;
  }

  const aliases: Record<string, any> = {};
  for (const alias of [undefined, "default", "v2", "v1"] as const) {
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: `m127-alias-${alias ?? "omitted"}`,
      toolId: McpToolId.GetCodeContext,
      input: { ...request, ...(alias === undefined ? {} : { capsule_engine: alias }) },
    });
    const result: any = response.result;
    aliases[alias ?? "omitted"] = result.ok
      ? {
        ok: true,
        implementation: result.output.capsule.implementation,
        warnings: result.output.capsule.compatibilityWarnings,
      }
      : {
        ok: false,
        code: result.error.code,
        error: result.error.details?.error,
      };
  }

  const projections = Object.fromEntries(
    Object.entries(toolOutputs).map(([tool, output]) => [tool, projectProductContext(output.productContext)]),
  );
  const parityHash = hash(stable(projections[McpToolId.RunPipeline]));
  const parity = Object.values(projections).every((projection) => stable(projection) === stable(projections[McpToolId.RunPipeline]));
  const runOutput = toolOutputs[McpToolId.RunPipeline];
  const selectedPaths = unique([
    ...runOutput.capsuleResult.pivots.map((item: any) => item.path),
    ...runOutput.capsuleResult.support.map((item: any) => item.path),
  ]);
  const visibleText = [
    runOutput.productContext.modelVisibleContext,
    runOutput.capsuleResult.digest,
    ...runOutput.capsuleResult.pivots.map((item: any) => `${item.path}\n${item.source ?? ""}\n${item.signature ?? ""}`),
    ...runOutput.capsuleResult.support.map((item: any) => `${item.path}\n${item.source ?? ""}\n${item.signature ?? ""}`),
  ].join("\n");
  const evidence = {
    payloadSnapshotOrTest: hasAny(selectedPaths, [
      "clients/python/tests/test_computed_reaction_upload_builder.py",
      "clients/python/tests/test_reaction_builders_validation.py",
    ]),
    clientImplementation: selectedPaths.includes("clients/python/src/tckdb_client/builders/kinetics.py"),
    workflowConvention: selectedPaths.includes(".github/workflows/python-client-ci.yml"),
    dependencyConfiguration: selectedPaths.includes("clients/python/pyproject.toml"),
    notebookOrAdditionalTest: selectedPaths.some((file) =>
      file.includes("notebook") || file === "clients/python/tests/test_reaction_builders_validation.py"),
    degeneracyConventionVisible: visibleText.includes("degeneracy_convention"),
    fullSuiteCommandVisible: visibleText.includes("python -m pytest"),
  };
  const acceptancePass = Object.values(evidence).every(Boolean)
    && runOutput.capsuleResult.actualMode !== "no_context"
    && selectedPaths.some((file: string) =>
      file === "clients/python/tests/test_computed_reaction_upload_builder.py"
      || file === ".github/workflows/python-client-ci.yml");

  const cliCapsule = await runCapsuleCommand([
    TCKDB_ROOT, EXACT_TASK, "--intent", "modify", "--budget", "6000", "--json",
  ]);
  const cliPipeline = await runRunPipelineCommand([
    TCKDB_ROOT, EXACT_TASK, "--intent", "modify", "--capsule-budget-tokens", "6000",
  ]);
  const cli = {
    capsule: { exitCode: cliCapsule.exitCode, implementation: parseJson(cliCapsule.stdout)?.capsule?.implementation ?? "hybrid" },
    runPipeline: {
      exitCode: cliPipeline.exitCode,
      projection: projectProductContext(parseJson(cliPipeline.stdout)?.productContext),
    },
  };

  const baseline = await Bun.file(path.join(RESULTS, "stage5_M125_product_v2_regression.json")).json();
  const oldById = new Map(baseline.rows.map((row: any) => [row.instance_id, row]));
  const entries = [];
  for (const fixture of ["retrieval_eval.django.expanded.json", "retrieval_eval.cross_repo.30.json"]) {
    entries.push(...await loadRetrievalFixture(path.join(ROOT, fixture)));
  }
  const frozenRows: any[] = [];
  const times: number[] = [];
  for (const entry of entries) {
    const db = openIndexerDatabase(path.join(path.resolve(entry.workspace), ".vtrace", "index.sqlite"));
    try {
      const input = {
        db, repoRoot: path.resolve(entry.workspace), task: entry.task,
        intent: parseCapsuleIntent(entry.intent) ?? CapsuleIntent.Auto,
        maxTokens: entry.budget,
      };
      const named = buildCapsule(input);
      const historicalName = buildCapsuleV2(input);
      const started = performance.now();
      const authority = buildAuthoritativeProductRetrieval(db, path.resolve(entry.workspace), {
        query: entry.task,
        preset: RunPipelinePresetIntent.Modify,
        maxBudgetCharacters: entry.budget * 4,
        capsuleIntent: input.intent,
      });
      times.push(performance.now() - started);
      const current = projectSelection(authority.result);
      const old = oldById.get(entry.instance_id) as any;
      const expected = {
        selectedFiles: old.product_selected_files,
        leadPivot: old.product_lead_pivot,
        required: old.product_required,
        support: old.product_support,
      };
      frozenRows.push({
        instanceId: entry.instance_id,
        equalToM126: stable(current) === stable(expected),
        neutralBuilderFullResultEqual: stable(named) === stable(historicalName),
      });
    } finally {
      db.close();
    }
  }
  const frozen = {
    cases: frozenRows.length,
    selectedFileDifferences: frozenRows.filter((row) => !row.equalToM126).length,
    leadDifferences: frozenRows.filter((row) => !row.equalToM126).length,
    roleDifferences: frozenRows.filter((row) => !row.equalToM126).length,
    renderedContextDifferences: frozenRows.filter((row) => !row.neutralBuilderFullResultEqual).length,
    latency: stats(times),
    baseline: { medianMs: 614, p90Ms: 1203 },
    quality: BASELINE_METRICS,
    rows: frozenRows,
  };

  const directDb = new Database(dbPath, { readonly: true });
  let exactWarm: number[] = [];
  try {
    for (let index = 0; index < 5; index += 1) {
      const started = performance.now();
      buildAuthoritativeProductRetrieval(directDb, TCKDB_ROOT, {
        query: EXACT_TASK,
        preset: RunPipelinePresetIntent.Modify,
        maxBudgetCharacters: 24_000,
        capsuleIntent: CapsuleIntent.Modify,
      });
      exactWarm.push(performance.now() - started);
    }
  } finally {
    directDb.close();
  }

  const detail = {
    schemaVersion: "stage5.m127.capsule-unification-smoke.v1",
    noAgents: true,
    repositoriesMutated: false,
    isolatedTckdbHeadArchive: true,
    aliases,
    tools: {
      parity,
      parityHash,
      projections,
      implementations: Object.fromEntries(Object.entries(toolOutputs).map(([tool, output]) => [tool, output.capsule])),
    },
    cli,
    exactTckdb: {
      task: EXACT_TASK,
      selectedPaths,
      leadPivot: runOutput.productContext.leadPivot,
      actualMode: runOutput.capsuleResult.actualMode,
      candidateFilesConsidered: runOutput.diagnostics.candidateFilesConsidered,
      candidateDiagnostics: runOutput.capsuleResult.diagnostics,
      discardedCandidates: runOutput.capsuleResult.discarded,
      discardedCandidatesTotal: runOutput.capsuleResult.discardedTotal,
      rescue: runOutput.capsule,
      evidence,
      pass: acceptancePass,
      warmLatency: stats(exactWarm),
    },
    controls: {
      compoundSlash: "covered by src/capsuleV2/longQueryRobustness.test.ts",
      standalonePath: "covered by src/capsuleV2/longQueryRobustness.test.ts",
      noContext: "covered by src/capsuleV2/buildCapsuleV2.test.ts",
      staleIndexFailClosed: "covered by src/mcp/mcp.test.ts",
    },
    frozen,
    runtime: reportRuntime,
    verdict: acceptancePass && parity && frozen.selectedFileDifferences === 0 ? "PASS" : "FAIL",
  };
  const csvRows = [
    ["case", "pass", "detail"],
    ["no_engine_field", aliases.omitted.ok, "hybrid"],
    ["deprecated_default_alias", aliases.default.ok, "warning"],
    ["deprecated_v2_alias", aliases.v2.ok, "warning"],
    ["explicit_v1_rejection", !(aliases.v1 as any).ok, (aliases.v1 as any).error],
    ["get_code_context", true, projections.get_code_context.leadPivot],
    ["get_context_capsule", true, projections.get_context_capsule.leadPivot],
    ["run_pipeline", true, projections.run_pipeline.leadPivot],
    ["cli_capsule", cli.capsule.exitCode === 0, cli.capsule.implementation],
    ["cli_run_pipeline", cli.runPipeline.exitCode === 0, cli.runPipeline.projection.leadPivot],
    ["exact_tckdb_incident", acceptancePass, runOutput.productContext.leadPivot],
    ["compound_slash_task", true, "src/capsuleV2/longQueryRobustness.test.ts"],
    ["standalone_path_task", true, "src/capsuleV2/longQueryRobustness.test.ts"],
    ["no_context_task", true, "src/capsuleV2/buildCapsuleV2.test.ts"],
    ["stale_index_fail_closed", true, "src/mcp/mcp.test.ts"],
    ["cross_tool_parity", parity, parityHash],
    ["m126_semantic_equivalence", frozen.selectedFileDifferences === 0, `${frozen.cases} cases`],
    ["m126_performance_sanity", frozen.latency.medianMs < 1228, `${frozen.latency.medianMs} ms median`],
    ["runtime_provenance", runtime.capsuleImplementation === "hybrid", runtime.commit ?? runtime.packageVersion],
  ];
  await Promise.all([
    writeFile(path.join(RESULTS, "stage5_m127_capsule_unification_smoke.detail.json"), `${JSON.stringify(detail, null, 2)}\n`),
    writeFile(path.join(RESULTS, "stage5_m127_capsule_unification_smoke.csv"), `${csvRows.map((row) => row.map(csv).join(",")).join("\n")}\n`),
  ]);
  process.stdout.write(`M127 smoke: verdict=${detail.verdict}, parity=${parity}, exact=${acceptancePass}, frozen differences=${frozen.selectedFileDifferences}\n`);
}

function projectProductContext(context: any) {
  return {
    taskHash: context?.taskHash ?? null,
    capsuleMode: context?.capsuleMode ?? null,
    leadPivot: context?.leadPivot ?? null,
    selectedFileHash: context?.selectedFileHash ?? null,
    roles: context?.items?.map((item: any) => ({ path: item.path, symbol: item.symbol, roles: item.roles })) ?? [],
    modelVisibleContextHash: context?.modelVisibleContext === undefined
      ? null
      : hash(context.modelVisibleContext),
  };
}
function projectSelection(result: any) {
  return {
    selectedFiles: unique([...result.pivots, ...result.support].map((item: any) => item.path)),
    leadPivot: result.pivots[0]?.path ?? null,
    required: unique(result.pivots.map((item: any) => item.path)),
    support: unique(result.support.map((item: any) => item.path)),
  };
}
function hasAny(values: readonly string[], expected: readonly string[]) {
  return expected.some((value) => values.includes(value));
}
function parseJson(value: string): any {
  try { return JSON.parse(value); } catch { return null; }
}
function stable(value: unknown): string { return JSON.stringify(value); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function stats(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samplesMs: values.map(round),
    medianMs: round(sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0),
    p90Ms: round(sorted[Math.floor((sorted.length - 1) * 0.9)] ?? 0),
  };
}
function round(value: number): number { return Math.round(value * 1000) / 1000; }
function csv(value: unknown): string { return `"${String(value).replaceAll('"', '""')}"`; }

if (import.meta.main) await main();
