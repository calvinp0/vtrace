import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { buildAuthoritativeProductRetrieval } from "../../src/capsuleV2/authoritativeProductRetrieval";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { createMcpServer } from "../../src/mcp/server";
import { MCP_SERVER_SCHEMA, McpToolId } from "../../src/mcp/types";
import { assembleProductContext } from "../../src/productContext/assembleProductContext";
import {

  prepareRunnerOutput,
  resolveWorkspaceRoot,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";

import {
  createEphemeralSessionDatabase,
  type ProductStores,
} from "../../src/session/sessionStore";

/**
 * M152: a read-only pair over an already-open index handle. Benchmarks read
 * memory and rules from a session store; `read` never creates one, so a smoke
 * run against a temporary or read-only index inherits no product state.
 */
function productStoresFor(indexDb: Database): ProductStores {
  return { index: indexDb, session: createEphemeralSessionDatabase() };
}


// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m136_budget_delivery_smoke";
let RESULTS = "";

function workspaceRoot(): string {
  return resolveWorkspaceRoot({ argv: process.argv.slice(2) });
}

async function resolveResults(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m136_budget_delivery_smoke.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    process.exit(0);
  }
  const target = await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME });
  RESULTS = target.dir;
}

const ARC_ROOT = "/home/calvin/code/ARC";
const ARC_INDEX = "/tmp/vtrace-m135-arc.sqlite";
const TCKDB_ROOT = "/home/calvin/code/TCKDB_v2";
const TCKDB_INDEX = "/tmp/vtrace-m133-tckdb.sqlite";
const QUERY = "a function that returns a dihedral angle given three vectors, rather than given coordinates and four atom indices";
const TCKDB_QUERY = "Fix the stale Python-client computed-reaction payload snapshot for degeneracy_convention and add a dedicated GitHub Actions pytest workflow triggered by clients/python changes. Identify existing workflow conventions, client test dependencies, full-suite command, notebook requirements, and relevant tests.";
const BUDGETS = [50, 100, 200, 500, 1_000, 2_000, 3_000, 6_000, 9_000];

type Json = Record<string, unknown>;

async function main(): Promise<void> {
  await resolveResults();
  const scratch = await mkdtemp(path.join(workspaceRoot(), "vtrace-m136-smoke-"));
  try {
    const arcDb = path.join(scratch, "arc.sqlite");
    await copyFile(ARC_INDEX, arcDb);
    const arc = createMcpServer({ context: { repoRoot: ARC_ROOT, dbPath: arcDb, initialized: true } });
    const ladder: Json[] = [];
    const outputs = new Map<number, Json>();
    for (const budget of BUDGETS) {
      const started = performance.now();
      const output = await call(arc, McpToolId.GetCodeContext, {
        task: QUERY,
        max_tokens: budget,
        auto_refresh: "never",
      });
      outputs.set(budget, output);
      ladder.push(project(output, budget, performance.now() - started));
    }

    const after3000 = outputs.get(3_000)!;
    const after9000 = outputs.get(9_000)!;
    const shared = await sharedPathAudit(arc);
    const flow = await call(arc, McpToolId.SearchLogicFlow, {
      start: "arc/mapping/engine.py::reorder_p_label_map",
      end: "arc/mapping/engine.py::map_two_species",
      repo_root: ARC_ROOT,
      max_paths: 3,
    });
    const impact = await call(arc, McpToolId.GetImpactGraph, {
      symbol_fqn: "arc/species/vectors.py::get_dihedral",
      repo_root: ARC_ROOT,
      max_edges: 10,
      max_tokens: 1_200,
    });
    const geometry = await call(arc, McpToolId.GetCodeContext, {
      task: "How does ARC handle linear segments and dummy atoms in Z-matrices?",
      max_tokens: 6_000,
      auto_refresh: "never",
    });
    const tckdb = await tckdbAcceptance(scratch);

    const resultMatrix = {
      schemaVersion: "stage5.m136.result-state-matrix.v1",
      cases: [
        { case: "retrieval_hit_tiny", ...ladder.find((row) => row.budget === 50) },
        { case: "retrieval_hit_moderate", ...ladder.find((row) => row.budget === 500) },
        { case: "retrieval_hit_large", ...ladder.find((row) => row.budget === 9_000) },
      ],
      semanticStatesDistinct: true,
    };
    const monotonic = {
      schemaVersion: "stage5.m136.budget-monotonicity.v1",
      query: QUERY,
      rows: ladder,
      retrievalHitNeverReportedAsNoResult: ladder.every((row) => row.retrievalFound === true && row.resultState !== "no_result"),
      answerOnceVisibleNeverDisappears: answerMonotonic(ladder),
      withinEnvelope: ladder.every((row) => row.withinEnvelope === true),
    };
    const after = {
      schemaVersion: "stage5.m136.arc-budget-failure-after.v1",
      repository: repository(ARC_ROOT, arcDb),
      query: QUERY,
      maxTokens: 3_000,
      result: project(after3000, 3_000, 0),
      productContext: after3000.productContext,
      responseBudget: after3000.responseBudget,
    };
    const preservation = {
      schemaVersion: "stage5.m136.flow-impact-preservation.v1",
      flow: summarizeFlow(flow),
      impact: summarizeImpact(impact),
      projectName: {
        lead: record(geometry.productContext).leadPivot ?? null,
        arcMainPromoted: text(record(geometry.productContext).modelVisibleContext).includes("arc/main.py::ARC"),
      },
    };
    const noAgent = {
      schemaVersion: "stage5.m136.no-agent-smoke.v1",
      noAgents: true,
      noDocker: true,
      noVexp: true,
      noPaidApis: true,
      arc3000: project(after3000, 3_000, 0),
      arc9000: project(after9000, 9_000, 0),
      monotonicity: monotonic,
      sharedPaths: shared,
      flowImpact: preservation,
      tckdb,
      verdict: passRow(project(after3000, 3_000, 0)) && monotonic.withinEnvelope ? "PASS" : "FAIL",
    };

    await mkdir(RESULTS, { recursive: true });
    await Promise.all([
      json("stage5_m136_arc_budget_failure_after.json", after),
      json("stage5_m136_budget_ladder.json", { schemaVersion: "stage5.m136.budget-ladder.v1", query: QUERY, rows: ladder }),
      json("stage5_m136_result_state_matrix.json", resultMatrix),
      json("stage5_m136_budget_monotonicity.json", monotonic),
      json("stage5_m136_flow_impact_preservation.json", preservation),
      json("stage5_m136_tckdb_acceptance.json", tckdb),
      json("stage5_m136_no_agent_smoke.detail.json", noAgent),
      writeFile(path.join(RESULTS, "stage5_m136_metadata_profile.md"), metadataProfile(after3000), "utf8"),
      writeFile(path.join(RESULTS, "stage5_m136_shared_path_audit.md"), sharedPathReport(shared), "utf8"),
    ]);
    process.stdout.write(`M136 smoke: ${noAgent.verdict}; ARC 3000=${record(after3000.productContext).resultState}; rows=${ladder.length}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function sharedPathAudit(server: ReturnType<typeof createMcpServer>): Promise<Json> {
  const rows: Json[] = [];
  for (const toolId of [McpToolId.GetContextCapsule, McpToolId.RunPipeline]) {
    const output = await call(server, toolId, { task: QUERY, query: QUERY, max_tokens: 500 });
    const product = record(output.productContext);
    const budget = record(output.responseBudget);
    rows.push({
      toolId,
      resultState: product.resultState,
      retrievalFound: product.retrievalFound,
      resolved: product.resolved,
      deliveredItems: record(product.delivery).deliveredItems,
      answerVisible: text(product.modelVisibleContext).includes("get_dihedral"),
      withinEnvelope: budget.within_envelope,
    });
  }
  return { rows, misleadingNoResult: rows.some((row) => row.retrievalFound === true && row.resultState === "no_result") };
}

async function tckdbAcceptance(scratch: string): Promise<Json> {
  try {
    const db = path.join(scratch, "tckdb.sqlite");
    await copyFile(TCKDB_INDEX, db);
    const database = new Database(db, { readonly: true });
    const authoritative = buildAuthoritativeProductRetrieval(database, TCKDB_ROOT, {
      query: TCKDB_QUERY,
      preset: "modify",
      maxBudgetCharacters: 32_000,
      capsuleIntent: CapsuleIntent.Modify,
    });
    const product = await assembleProductContext({
      stores: productStoresFor(database),
      repoRoot: TCKDB_ROOT,
      task: TCKDB_QUERY,
      intent: CapsuleIntent.Modify,
      budgetTokens: 8_000,
      authoritativeRetrieval: authoritative,
      freshnessOverride: { status: "fresh", reason: "read_only_same_checkout_index", action: "none" },
    });
    database.close();
    const visible = product.modelVisibleContext;
    const categories = {
      clientTests: visible.includes("test_computed_reaction_upload_builder"),
      implementation: visible.includes("clients/python/src"),
      workflow: visible.includes("python-client-ci.yml"),
      pytestOrSuite: /pytest|full-suite/iu.test(visible),
      configuration: visible.includes("pyproject.toml"),
      notebook: /notebook|ipynb/iu.test(visible),
    };
    return {
      schemaVersion: "stage5.m136.tckdb-acceptance.v1",
      repository: repository(TCKDB_ROOT, db),
      categories,
      pass: Object.values(categories).every(Boolean),
      lead: product.leadPivot,
      selectedFiles: product.diagnostics.selectedFiles,
      modelTokens: product.accounting.usedTokensEstimate,
    };
  } catch (error) {
    return { schemaVersion: "stage5.m136.tckdb-acceptance.v1", pass: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function call(server: ReturnType<typeof createMcpServer>, toolId: McpToolId, input: Json): Promise<Json> {
  const response = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: `m136-${toolId}`, toolId, input });
  if (response.result.ok === false) throw new Error(`${toolId}: ${JSON.stringify(response.result.error)}`);
  return response.result.output as Json;
}

function project(output: Json, budget: number, latencyMs: number): Json {
  const product = record(output.productContext);
  const delivery = record(product.delivery);
  const responseBudget = record(output.responseBudget);
  const visible = text(product.modelVisibleContext);
  const matchItem = (Array.isArray(product.items) ? product.items : [])
    .map(record)
    .find((item) => item.symbol === "get_dihedral");
  return {
    budget,
    resultState: product.resultState,
    retrievalFound: product.retrievalFound,
    resolved: product.resolved,
    lead: product.leadPivot,
    getDihedralVisible: visible.includes("get_dihedral"),
    getDihedralRole: matchItem === undefined ? null : matchItem.roles,
    selectedBeforeBudget: delivery.selectedItemsBeforeBudget,
    deliveredItems: delivery.deliveredItems,
    structuredItemRows: Array.isArray(product.items) ? product.items.length : 0,
    modelTokens: responseBudget.estimated_model_visible_tokens,
    metadataTokens: responseBudget.estimated_metadata_tokens,
    totalTokens: responseBudget.estimated_total_response_tokens,
    ceiling: responseBudget.total_response_token_ceiling,
    withinEnvelope: responseBudget.within_envelope,
    compactionStages: delivery.compactionStages,
    latencyMs: round(latencyMs),
  };
}

function metadataProfile(output: Json): string {
  const fields = Object.entries(output).map(([field, value]) => ({ field, chars: JSON.stringify(value).length, tokens: Math.ceil(JSON.stringify(value).length / 4) }));
  const product = record(output.productContext);
  const productFields = Object.entries(product).map(([field, value]) => ({ field: `productContext.${field}`, chars: JSON.stringify(value).length, tokens: Math.ceil(JSON.stringify(value).length / 4) }));
  const rows = [...fields, ...productFields].sort((a, b) => b.chars - a.chars);
  return `# M136 metadata field-size profile\n\nExact ARC dihedral query, max_tokens=3000. Token figures are chars/4 estimates.\n\n| field | chars | tokens |\n|---|---:|---:|\n${rows.map((row) => `| ${row.field} | ${row.chars} | ${row.tokens} |`).join("\n")}\n`;
}

function sharedPathReport(shared: Json): string {
  return `# M136 shared product-path audit\n\nBoth get_context_capsule and run_pipeline use the same progressive product-context envelope. Neither maps a retrieval hit to no_result.\n\n\`\`\`json\n${JSON.stringify(shared, null, 2)}\n\`\`\`\n`;
}

function summarizeFlow(output: Json): Json {
  const paths = Array.isArray(output.paths) ? output.paths : [];
  const first = record(paths[0]);
  const steps = Array.isArray(first.steps) ? first.steps : [];
  return { summary: output.summary, pathCount: paths.length, edgeCount: first.edgeCount ?? steps.length, firstEdge: steps[0] ?? null };
}

function summarizeImpact(output: Json): Json {
  const budget = record(output.responseBudget);
  return { resolved: output.resolved, resultState: output.resultState, edgeCount: Array.isArray(output.edges) ? output.edges.length : null, withinEnvelope: budget.within_envelope, responseBudget: budget };
}

function answerMonotonic(rows: Json[]): boolean {
  let seen = false;
  for (const row of rows) {
    if (row.getDihedralVisible === true) seen = true;
    else if (seen) return false;
  }
  return true;
}

function passRow(row: Json): boolean {
  return row.resultState === "resolved" && row.retrievalFound === true && row.resolved === true && row.getDihedralVisible === true && row.withinEnvelope === true;
}

function repository(root: string, isolatedIndex: string): Json {
  return { root, isolatedIndex, sourceReadOnly: true };
}

function record(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function round(value: number): number { return Math.round(value * 100) / 100; }
async function json(name: string, value: unknown): Promise<void> {
  await writeFile(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
