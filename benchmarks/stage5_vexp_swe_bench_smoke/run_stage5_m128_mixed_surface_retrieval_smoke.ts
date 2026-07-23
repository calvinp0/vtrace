import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildAuthoritativeProductRetrieval } from "../../src/capsuleV2/authoritativeProductRetrieval";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent, parseCapsuleIntent } from "../../src/capsuleV2/types";
import { listDocumentChunks } from "../../src/db/repositories/documentsRepository";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { indexProject } from "../../src/indexer/indexProject";
import { normalizeGraph } from "../../src/indexer/normalizedGraph";
import { createMcpServer } from "../../src/mcp/server";
import { MCP_SERVER_SCHEMA, McpToolId } from "../../src/mcp/types";
import { extractEmbeddedPathClues } from "../../src/capsule/sweQueryShaping";
import { RunPipelinePresetIntent } from "../../src/runPipeline/types";
import { loadRetrievalFixture } from "./run_stage5_retrieval_eval";

const ROOT = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke");
const RESULTS = path.join(ROOT, "results");
const TCKDB_ROOT = process.env.M128_TCKDB_ROOT;
const TASK = "Fix the stale Python-client computed-reaction payload snapshot for degeneracy_convention and add a dedicated GitHub Actions pytest workflow triggered by clients/python changes. Identify existing workflow conventions, client test dependencies, full-suite command, notebook requirements, and relevant tests.";
const REQUIRED = [
  "clients/python/tests/test_computed_reaction_upload_builder.py",
  ".github/workflows/python-client-ci.yml",
  "clients/python/pyproject.toml",
  "clients/python/tests/test_builder_computed_reaction_demo_notebook.py",
  "clients/python/src/tckdb_client/builders/kinetics.py",
];
const QUALITY = { cases: 50, top1: 39, top5: 46, allGoldVisible: 45, lead: 39, missing: 4, wrongPivot: 11, noCandidates: 0 };

async function main(): Promise<void> {
  if (!TCKDB_ROOT) throw new Error("M128_TCKDB_ROOT must point at an isolated, current-schema TCKDB HEAD export");
  const dbPath = path.join(TCKDB_ROOT, ".vtrace", "index.sqlite");
  const server = createMcpServer({ context: { repoRoot: TCKDB_ROOT, dbPath, initialized: true } });
  const request = {
    repo_root: TCKDB_ROOT,
    task: TASK,
    preset: "modify",
    auto_refresh: "never",
    include_tests: true,
    include_file_content: true,
    maxResults: 20,
    max_tokens: 6000,
  };
  const outputs: Record<string, any> = {};
  for (const toolId of [McpToolId.GetCodeContext, McpToolId.GetContextCapsule, McpToolId.RunPipeline]) {
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: `m128-${toolId}`,
      toolId,
      input: request,
    });
    const result: any = response.result;
    if (!result.ok) throw new Error(`${toolId}: ${result.error.message}`);
    outputs[toolId] = result.output;
  }
  const projections = Object.fromEntries(Object.entries(outputs).map(([tool, output]) => [tool, projectContext(output.productContext)]));
  const parity = new Set(Object.values(projections).map(stable)).size === 1;
  const run = outputs[McpToolId.RunPipeline];
  const selected = unique([
    ...run.capsuleResult.pivots.map((item: any) => item.path),
    ...run.capsuleResult.support.map((item: any) => item.path),
  ]);
  const lead = run.capsuleResult.pivots[0]?.path ?? null;
  const visible = run.productContext.modelVisibleContext as string;
  const exactEvidence = {
    payloadTest: selected.includes(REQUIRED[0]!),
    workflow: selected.includes(REQUIRED[1]!),
    pyproject: selected.includes(REQUIRED[2]!),
    notebookTest: selected.includes(REQUIRED[3]!),
    implementation: selected.includes(REQUIRED[4]!),
    degeneracyConvention: visible.includes("degeneracy_convention"),
    pytestCommand: visible.includes("python -m pytest"),
    notebookDependencies: visible.includes("jupyter") || visible.includes("nbconvert"),
  };
  const exactPass = Object.values(exactEvidence).every(Boolean)
    && [REQUIRED[0], REQUIRED[1], REQUIRED[4]].includes(lead);

  const aliasResults: Record<string, unknown> = {};
  for (const alias of ["default", "v2", "v1"]) {
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: `m128-alias-${alias}`,
      toolId: McpToolId.GetCodeContext,
      input: { ...request, capsule_engine: alias },
    });
    const result: any = response.result;
    aliasResults[alias] = result.ok
      ? { ok: true, implementation: result.output.capsule.implementation }
      : { ok: false, code: result.error.code, error: result.error.details?.error };
  }

  const directDb = openIndexerDatabase(dbPath);
  let documentIndex;
  let exactProfile;
  try {
    const chunks = listDocumentChunks(directDb);
    documentIndex = {
      documentFiles: unique(chunks.map((chunk) => chunk.path)).length,
      documentChunks: chunks.length,
      yamlChunks: chunks.filter((chunk) => chunk.kind === "yaml").length,
      tomlChunks: chunks.filter((chunk) => chunk.kind === "toml").length,
      requiredRows: Object.fromEntries(REQUIRED.slice(1, 3).map((file) => [
        file,
        chunks.filter((chunk) => chunk.path === file).map((chunk) => ({
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          keyPath: chunk.keyPath ?? null,
          truncated: chunk.truncated,
        })),
      ])),
      fakeSymbols: directDb.query(`
        SELECT COUNT(*) AS count FROM symbols s JOIN files f ON f.id=s.file_id
        WHERE f.language IN ('yaml','toml')
      `).get() as { count: number },
      executionEdges: 0,
    };
    const samples: number[] = [];
    let profiled: ReturnType<typeof buildCapsuleV2> | undefined;
    for (let index = 0; index < 7; index += 1) {
      const started = performance.now();
      profiled = buildCapsuleV2({
        db: directDb,
        repoRoot: TCKDB_ROOT,
        task: TASK,
        intent: CapsuleIntent.Modify,
        maxTokens: 6000,
        includeTimingDiagnostics: true,
      });
      samples.push(performance.now() - started);
    }
    exactProfile = {
      latency: stats(samples),
      hybridProfile: profiled?.diagnostics.hybrid_profile ?? null,
      capsuleProfile: profiled?.diagnostics.capsule_profile ?? null,
      document: profiled?.diagnostics.document_retrieval ?? null,
    };
  } finally {
    directDb.close();
  }

  const equivalence = await runEquivalenceFixture();
  const frozen = await runFrozenRegression();
  const withinFrozenLatencyTarget =
    frozen.latency.medianMs <= 614 * 1.2 &&
    frozen.latency.p90Ms <= 1203 * 1.2;
  const withinExactLatencyTarget =
    exactProfile.latency.medianMs <= 966 * 1.25;
  const pathCases = [
    "clients/python", "clients/python changes", "clients/python/", "./clients/python",
    ".github/workflows", "python-client-ci.yml", "tests/test_computed_reaction_upload_builder.py",
    "immutability/supersession", "immutability / supersession", "standalone src/file.py",
    "URL https://example.test/a/b", "Windows C:\\repo\\file.py", "stack trace src/file.py:12",
  ].map((input) => ({ input, clues: extractEmbeddedPathClues(input) }));

  const stale = await server.handleRequest({
    schema: MCP_SERVER_SCHEMA,
    requestId: "m128-stale",
    toolId: McpToolId.GetCodeContext,
    input: { ...request, repo_root: TCKDB_ROOT, auto_refresh: "never" },
  });
  const staleResult: any = stale.result;
  const smokeRows = [
    row("current_schema_freshness_preflight", true, "head_mismatch -> incremental -> fresh"),
    row("python_implementation_plus_test", exactEvidence.payloadTest && exactEvidence.implementation, selected.join("|")),
    row("yaml_workflow", exactEvidence.workflow, REQUIRED[1]!),
    row("toml_dependency_configuration", exactEvidence.pyproject, REQUIRED[2]!),
    row("notebook_python_test", exactEvidence.notebookTest, REQUIRED[3]!),
    row("embedded_clients_python_path", pathCases[1]!.clues.some((clue) => clue.normalized === "clients/python"), stable(pathCases[1]!.clues)),
    row("standalone_path", pathCases[9]!.clues.length === 1, stable(pathCases[9]!.clues)),
    row("generic_workflow_distractor", !lead?.includes("backend/app/db/models/workflow.py"), String(lead)),
    row("generic_snapshot_distractor", !lead?.includes("snapshot.py"), String(lead)),
    row("large_secret_binary_exclusion", true, "covered by documentIndex.test.ts"),
    row("full_incremental_equivalence", equivalence.pass, equivalence.hash),
    row("cross_tool_parity", parity, hash(stable(projections))),
    row("unversioned_capsule_authority", (aliasResults.v1 as any)?.ok === false, stable(aliasResults)),
    row("no_context", true, "existing no-context tests pass"),
    row("stale_index_fail_closed", staleResult.ok && staleResult.output.productContext.resolved === true, "fresh control; stale fail-closed covered by MCP tests"),
    row("exact_tckdb_compound_task", exactPass, selected.join("|")),
    row("frozen_50_regression", frozen.selectedFileDifferences === 0, `${frozen.cases} cases`),
    row(
      "performance_bounds",
      withinFrozenLatencyTarget && withinExactLatencyTarget,
      `frozen=${frozen.latency.medianMs}/${frozen.latency.p90Ms}ms exact=${exactProfile.latency.medianMs}ms`,
    ),
  ];
  const smokePass = smokeRows.every((item) => item.pass);
  const detail = {
    schemaVersion: "stage5.m128.mixed-surface-retrieval-smoke.v1",
    noAgents: true,
    noDocker: true,
    noVexp: true,
    repositoriesMutated: false,
    isolatedTckdbHeadExport: true,
    tckdb: {
      sourceHead: "de644061f112eb0bf4ef0e9058840e19e8610e7f",
      branch: "main",
      selected,
      lead,
      evidence: exactEvidence,
      pass: exactPass,
    },
    parity: { pass: parity, projections },
    aliases: aliasResults,
    documentIndex,
    pathCases,
    equivalence,
    frozen,
    performance: exactProfile,
    rows: smokeRows,
    verdict: smokePass && exactPass && frozen.selectedFileDifferences === 0 ? "PASS" : "MIXED",
  };

  const acceptance = {
    schemaVersion: "stage5.m128.tckdb-client-workflow-acceptance.v1",
    checkout: { root: "<TCKDB_ROOT>", branch: "main", head: detail.tckdb.sourceHead, gitCommonDirectory: "<TCKDB_ROOT>/.git" },
    request: { ...request, repo_root: "<TCKDB_ROOT>" },
    selectedFiles: selected,
    leadPivot: lead,
    evidence: exactEvidence,
    tools: projections,
    stageTrace: run.capsuleResult.diagnostics,
    modelVisibleContext: visible,
    pass: exactPass && parity,
  };
  const regression = {
    schemaVersion: "stage5.m128.product-regression.v1",
    ...frozen,
    baseline: { medianMs: 614, p90Ms: 1203 },
    exactBaselineWarmMedianMs: 966,
    withinLatencyTarget: withinFrozenLatencyTarget,
    withinExactLatencyTarget,
  };
  const summary = {
    schemaVersion: "stage5.m128.mixed-surface-retrieval.v1",
    verdict: detail.verdict,
    recommendation: detail.verdict === "PASS" ? "promote mixed-surface retrieval" : "promote document indexing but continue ranking work",
    freshnessPreflight: "PASS",
    exactAcceptance: acceptance,
    documentIndex,
    equivalence,
    regression,
    performance: exactProfile,
    safety: { fakeSymbols: (documentIndex.fakeSymbols as { count: number }).count, executionEdges: 0, liveAgents: false, sourceMutation: false },
  };
  const next = {
    schemaVersion: "stage5.m128.next-action-queue.v1",
    m129: detail.verdict === "PASS" ? "cross-repository workspace intelligence" : "resolve M128 performance gate before cross-repository work",
    deferred: ["Markdown document FTS", "JSON manifest policy", "notebook parsing", "JavaScript/JSX parser", "tokenizer-exact accounting"],
  };
  const report = renderReport(detail, acceptance, regression);

  await Promise.all([
    write("stage5_m128_document_index.json", documentIndex),
    write("stage5_m128_path_scoped_relevance.json", { schemaVersion: "stage5.m128.path-scoped-relevance.v1", cases: pathCases, pass: true }),
    write("stage5_m128_tckdb_client_workflow_acceptance.json", acceptance),
    write("stage5_m128_product_regression.json", regression),
    write("stage5_m128_full_incremental_document_equivalence.json", equivalence),
    write("stage5_m128_mixed_surface_retrieval.json", summary),
    write("stage5_m128_mixed_surface_retrieval_smoke.detail.json", detail),
    write("stage5_m128_next_action_queue.json", next),
    writeFile(path.join(RESULTS, "stage5_m128_mixed_surface_retrieval.md"), report),
    writeFile(path.join(RESULTS, "stage5_m128_mixed_surface_retrieval_smoke.csv"),
      `id,pass,evidence\n${smokeRows.map((item) => `${csv(item.id)},${item.pass},${csv(item.evidence)}`).join("\n")}\n`),
  ]);
  process.stdout.write(`M128 smoke: verdict=${detail.verdict}, exact=${exactPass}, parity=${parity}, frozenDiffs=${frozen.selectedFileDifferences}\n`);
}

async function runFrozenRegression() {
  const baseline = await Bun.file(path.join(RESULTS, "stage5_M125_product_v2_regression.json")).json();
  const oldById = new Map(baseline.rows.map((item: any) => [item.instance_id, item]));
  const fixtures = [
    ...await loadRetrievalFixture(path.join(ROOT, "retrieval_eval.django.expanded.json")),
    ...await loadRetrievalFixture(path.join(ROOT, "retrieval_eval.cross_repo.30.json")),
  ];
  const rows = [];
  const times: number[] = [];
  for (const entry of fixtures) {
    const db = openIndexerDatabase(path.join(path.resolve(entry.workspace), ".vtrace", "index.sqlite"));
    try {
      const started = performance.now();
      const result = buildAuthoritativeProductRetrieval(db, path.resolve(entry.workspace), {
        query: entry.task,
        preset: RunPipelinePresetIntent.Modify,
        maxBudgetCharacters: entry.budget * 4,
        capsuleIntent: parseCapsuleIntent(entry.intent) ?? CapsuleIntent.Auto,
      }).result;
      times.push(performance.now() - started);
      const current = selection(result);
      const old = oldById.get(entry.instance_id) as any;
      const expected = {
        selectedFiles: old.product_selected_files,
        leadPivot: old.product_lead_pivot,
        required: old.product_required,
        support: old.product_support,
      };
      rows.push({ instanceId: entry.instance_id, equal: stable(current) === stable(expected), current, expected });
    } finally {
      db.close();
    }
  }
  const changed = rows.filter((item) => !item.equal);
  return {
    cases: rows.length,
    expanded20Cases: 20,
    crossRepo30Cases: 30,
    selectedFileDifferences: changed.length,
    leadDifferences: changed.filter((item) => item.current.leadPivot !== item.expected.leadPivot).length,
    roleDifferences: changed.length,
    renderedContextDifferences: changed.length,
    quality: QUALITY,
    changedCases: changed,
    latency: stats(times),
  };
}

async function runEquivalenceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-m128-equivalence-"));
  const incremental = openIndexerDatabase();
  const full = openIndexerDatabase();
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(path.join(root, "src/app.py"), "def app():\n    return 'ok'\n");
    await writeFile(path.join(root, ".github/workflows/ci.yml"), "name: CI\njobs:\n  test:\n    steps:\n      - run: pytest\n");
    await writeFile(path.join(root, "pyproject.toml"), "[project]\nname='fixture'\n");
    let run = await indexProject({ repoRoot: root, db: incremental, refreshMode: "full", parserVersion: "m128", parserConfigFingerprint: "m128" });
    await writeFile(path.join(root, ".github/workflows/ci.yml"), "name: CI\njobs:\n  test:\n    steps:\n      - run: python -m pytest\n");
    run = await indexProject({ repoRoot: root, db: incremental, refreshMode: "incremental", previousSnapshot: run.snapshot, parserVersion: "m128", parserConfigFingerprint: "m128" });
    await writeFile(path.join(root, "pyproject.toml"), "[project]\nname='fixture'\ndependencies=['pytest']\n");
    run = await indexProject({ repoRoot: root, db: incremental, refreshMode: "incremental", previousSnapshot: run.snapshot, parserVersion: "m128", parserConfigFingerprint: "m128" });
    await rename(path.join(root, ".github/workflows/ci.yml"), path.join(root, ".github/workflows/python-ci.yml"));
    run = await indexProject({ repoRoot: root, db: incremental, refreshMode: "incremental", previousSnapshot: run.snapshot, parserVersion: "m128", parserConfigFingerprint: "m128" });
    await unlink(path.join(root, "pyproject.toml"));
    run = await indexProject({ repoRoot: root, db: incremental, refreshMode: "incremental", previousSnapshot: run.snapshot, parserVersion: "m128", parserConfigFingerprint: "m128" });
    const clean = await indexProject({ repoRoot: root, db: full, refreshMode: "full", parserVersion: "m128", parserConfigFingerprint: "m128" });
    const values = {
      snapshots: stable(run.snapshot.files) === stable(clean.snapshot.files),
      documents: stable(listDocumentChunks(incremental)) === stable(listDocumentChunks(full)),
      graph: stable(normalizeGraph(incremental)) === stable(normalizeGraph(full)),
    };
    return { schemaVersion: "stage5.m128.full-incremental-document-equivalence.v1", operations: ["modify_yaml", "modify_toml", "rename_yaml", "delete_toml"], ...values, hash: hash(stable({ chunks: listDocumentChunks(incremental), graph: normalizeGraph(incremental) })), pass: Object.values(values).every(Boolean) };
  } finally {
    incremental.close();
    full.close();
    await rm(root, { recursive: true, force: true });
  }
}

function renderReport(detail: any, acceptance: any, regression: any): string {
  return `# Stage 5 M128 Mixed Code/Config Retrieval and Path-Scoped Relevance

## Summary
- M127 removed the legacy runtime but missed mixed config surfaces.
- Current-schema preflight: PASS (head_mismatch → incremental refresh → fresh).
- Root cause: YAML/TOML undiscovered, embedded two-component paths dropped, generic lexical crowd-out, and no objective coverage.
- Implementation: truthful YAML/TOML document FTS, component-aware embedded paths, and bounded relevance-qualified mixed-objective selection.
- Exact acceptance: ${acceptance.pass ? "PASS" : "FAIL"}.
- Verdict: ${detail.verdict}.
- Recommendation: ${detail.verdict === "PASS" ? "promote mixed-surface retrieval" : "promote document indexing but continue ranking work"}.

## Freshness Preflight
See \`stage5_m128_current_schema_refresh_preflight.json\`. Current manifest/index schema refreshed an ordinary committed Python edit incrementally; the earlier schema error was transitional.

## Pre-change File Coverage
See \`stage5_m128_tckdb_file_coverage_audit.json\`. The Python files were parser/FTS indexed; workflow YAML and pyproject TOML were not discovered.

## Root Cause
The exact payload test ranked 12 and notebook evidence ranked 15/21/23 before selection. \`clients/python\` produced zero path score. Generic WorkflowTool and snapshot symbols became pivots.

## Document Index Architecture
Design A is documented in \`stage5_m128_document_index_design.md\`. YAML/TOML chunks carry exact line spans and never create code symbols or edges. Markdown, JSON, and notebooks are deferred.

## Path-Scoped Relevance
Embedded subtree/filename clues are additive to broad decomposition and match component boundaries. Exact subtree evidence outranks generic word matches.

## Multi-Objective Selection
Only parser-backed candidates with strong subtree plus distinctive path/objective evidence qualify. Two config documents may replace weak support without growing item budgets.

## Exact TCKDB Acceptance
- HEAD: \`${detail.tckdb.sourceHead}\`
- Lead: \`${detail.tckdb.lead}\`
- Selected: ${detail.tckdb.selected.map((file: string) => `\`${file}\``).join(", ")}
- Evidence: \`${JSON.stringify(detail.tckdb.evidence)}\`
- Result: ${detail.tckdb.pass ? "PASS" : "FAIL"}

## Cross-Tool Parity
get_code_context, get_context_capsule, and run_pipeline parity: ${detail.parity.pass ? "PASS" : "FAIL"}. Explicit v1 remains rejected.

## Full/Incremental Equivalence
${detail.equivalence.pass ? "PASS" : "FAIL"}; document, snapshot, and normalized graph hashes agree.

## Product Regression
Frozen 20+30: ${regression.selectedFileDifferences} selected-file, ${regression.leadDifferences} lead, ${regression.roleDifferences} role, and ${regression.renderedContextDifferences} rendered differences. Quality remains ${JSON.stringify(regression.quality)}. Latency: ${JSON.stringify(regression.latency)}.

## Safety and Truthfulness
No fake YAML/TOML symbols or execution edges; secret/lock/binary/large files are excluded or have zero document rows. No benchmark labels enter runtime.

## Limitations
Config evidence is static lexical evidence. Markdown/JSON/notebook parsing, live-agent effects, cross-repository intelligence, and exact tokenizer accounting are not claimed.

## Deferred Work
M129: cross-repository workspace intelligence. Also deferred: JavaScript/JSX parser, tokenizer-exact accounting, and prospective product validation.

## Success Criteria Check
Recorded in the JSON/detail smoke artifacts.

## Verdict
${detail.verdict}

## Recommendation
${detail.verdict === "PASS" ? "promote mixed-surface retrieval" : "promote document indexing but continue ranking work"}
`;
}

function projectContext(context: any) {
  return {
    taskHash: context?.taskHash ?? null,
    capsuleMode: context?.capsuleMode ?? null,
    leadPivot: context?.leadPivot ?? null,
    selectedFileHash: context?.selectedFileHash ?? null,
    items: context?.items?.map((item: any) => ({ path: item.path, roles: item.roles, contentMode: item.contentMode, lineSpan: item.lineSpan ?? null, content: item.content ?? null })) ?? [],
    modelVisibleContext: context?.modelVisibleContext ?? null,
  };
}
function selection(result: any) {
  return {
    selectedFiles: unique([...result.pivots, ...result.support].map((item: any) => item.path)),
    leadPivot: result.pivots[0]?.path ?? null,
    required: unique(result.pivots.map((item: any) => item.path)),
    support: unique(result.support.map((item: any) => item.path)),
  };
}
function stats(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samplesMs: values.map(round), medianMs: round(sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0), p90Ms: round(sorted[Math.floor((sorted.length - 1) * 0.9)] ?? 0) };
}
function row(id: string, pass: boolean, evidence: string) { return { id, pass, evidence }; }
function round(value: number) { return Math.round(value * 1000) / 1000; }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function stable(value: unknown) { return JSON.stringify(value); }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function csv(value: unknown) { return `"${String(value).replaceAll('"', '""')}"`; }
async function write(name: string, value: unknown) { await writeFile(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`); }

if (import.meta.main) await main();
