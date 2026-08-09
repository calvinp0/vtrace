// M137 deterministic acceptance and preservation smoke.
//
// This runner reads existing ARC/TCKDB indexes through isolated copies. It does
// not invoke an agent, Docker, VEXP, a paid API, or any network service.

import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";

import { shapeSweQuery } from "../../src/capsule/sweQueryShaping";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { resolveProjectNameAliases } from "../../src/capsuleV2/projectNameSignals";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { createMcpServer } from "../../src/mcp/server";
import { MCP_SERVER_SCHEMA, McpToolId } from "../../src/mcp/types";
import { deriveQueryIntent, evaluateDirectAnswer } from "../../src/retrieval/querySemantics";
import { hybridRetrieve } from "../../src/retrieval/hybridRetrieval";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const ARC_ROOT = "/home/calvin/code/ARC";
const ARC_INDEX = "/tmp/vtrace-m135-arc.sqlite";
const TCKDB_ROOT = "/home/calvin/code/TCKDB_v2";
const TCKDB_INDEX = "/tmp/vtrace-m133-tckdb.sqlite";
const QUERY = "a function that returns a dihedral angle given three vectors, rather than given coordinates and four atom indices";
const PROJECT_QUERY = "Is there a function in ARC that returns a dihedral angle given three vectors, rather than given coordinates and four atom indices?";
const WATCH = ["get_dihedral", "interp_dihedral_deg", "get_normal", "calculate_dihedral_angle", "interpolate_addition"];
const BUDGETS = [200, 500, 3_000, 9_000];

type Json = Record<string, unknown>;

interface HistoricalModules {
  shapeSweQuery: typeof shapeSweQuery;
  hybridRetrieve: typeof hybridRetrieve;
}

async function main(): Promise<void> {
  const baselineRoot = baselineRootArg(process.argv.slice(2));
  const scratch = await mkdtemp(path.join(os.tmpdir(), "vtrace-m137-smoke-"));
  try {
    const arcDb = path.join(scratch, "arc.sqlite");
    await copyFile(ARC_INDEX, arcDb);
    const beforeModules = await loadHistoricalModules(baselineRoot);
    const before = scoreRows(beforeModules, arcDb, false);
    const after = scoreRows({ shapeSweQuery, hybridRetrieve }, arcDb, true);
    const current = buildCurrentCapsule(arcDb);
    const arcBeforeAfter = {
      schemaVersion: "stage5.m137.arc-dihedral-before-after.v1",
      query: QUERY,
      baselineRoot,
      repository: repository(ARC_ROOT, arcDb),
      before,
      after,
      currentRoles: current.roles,
      currentLead: current.lead,
      pass: after.find((row) => row.candidate === "get_dihedral")?.rank === 1 && current.lead?.endsWith("::get_dihedral"),
    };

    const hygiene = symbolHygiene(beforeModules);
    const intentCases = existenceCases();
    const projectHygiene = projectNameCases();
    const performance = performanceProfile(arcDb);
    const server = createMcpServer({ context: { repoRoot: ARC_ROOT, dbPath: arcDb, initialized: true } });
    const budgetRows = [];
    for (const budget of BUDGETS) {
      const output = await call(server, McpToolId.GetCodeContext, { task: QUERY, max_tokens: budget, auto_refresh: "never" });
      budgetRows.push(projectBudget(output, budget));
    }
    const flow = await call(server, McpToolId.SearchLogicFlow, {
      start: "arc/mapping/engine.py::reorder_p_label_map", end: "arc/mapping/engine.py::map_two_species",
      repo_root: ARC_ROOT, max_paths: 3,
    });
    const impact = await call(server, McpToolId.GetImpactGraph, {
      symbol_fqn: "arc/species/vectors.py::get_dihedral", repo_root: ARC_ROOT, max_edges: 10, max_tokens: 1_200,
    });
    const flowImpact = {
      schemaVersion: "stage5.m137.flow-impact-preservation.v1",
      flow: summarizeFlow(flow),
      impact: summarizeImpact(impact),
    };
    const tckdb = await tckdbAcceptance(scratch);
    const budget = {
      schemaVersion: "stage5.m137.budget-delivery-preservation.v1",
      query: QUERY,
      rows: budgetRows,
      pass3000: passBudget(budgetRows.find((row) => row.budget === 3_000) ?? {}),
      nonDecreasingAnswerVisibility: monotonicVisibility(budgetRows),
      allWithinEnvelope: budgetRows.every((row) => row.withinEnvelope === true),
    };
    const scoreAttribution = {
      schemaVersion: "stage5.m137.candidate-score-attribution.v1",
      component: "directAnswerScore",
      boundedMaximum: 0.95,
      definitionEvidence: ["symbol name", "symbol kind", "indexed signature", "indexed docstring", "parameter shape"],
      sourceBodiesReadPerCandidate: 0,
      rows: after,
    };
    const noAgent = {
      schemaVersion: "stage5.m137.no-agent-smoke.v1",
      noAgents: true, noDocker: true, noVexp: true, noPaidApis: true, noNetwork: true,
      arcPass: arcBeforeAfter.pass,
      intentPass: intentCases.pass,
      hygienePass: hygiene.pass,
      projectNamePass: projectHygiene.pass,
      budgetPass: budget.pass3000 && budget.allWithinEnvelope,
      flowImpact,
      tckdb,
      performance,
      verdict: arcBeforeAfter.pass && intentCases.pass && hygiene.pass && projectHygiene.pass
        && budget.pass3000 && budget.allWithinEnvelope && tckdb.pass ? "PASS" : "FAIL",
    };

    await mkdir(RESULTS, { recursive: true });
    await Promise.all([
      json("stage5_m137_arc_dihedral_before_after.json", arcBeforeAfter),
      json("stage5_m137_existence_intent_cases.json", intentCases),
      json("stage5_m137_symbol_hypothesis_cleanup.json", hygiene),
      json("stage5_m137_project_name_symbol_hygiene.json", projectHygiene),
      json("stage5_m137_candidate_score_attribution.json", scoreAttribution),
      json("stage5_m137_budget_delivery_preservation.json", budget),
      json("stage5_m137_flow_impact_preservation.json", flowImpact),
      json("stage5_m137_tckdb_acceptance.json", tckdb),
      json("stage5_m137_performance.json", performance),
      json("stage5_m137_no_agent_smoke.detail.json", noAgent),
    ]);
    process.stdout.write(`M137 smoke: ${noAgent.verdict}; ARC lead=${current.lead}; 3000=${budget.pass3000}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function scoreRows(modules: HistoricalModules, dbPath: string, projectAware: boolean): Json[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const shaped = modules.shapeSweQuery(
      { problemStatement: QUERY },
      projectAware ? { projectNameAliases: resolveProjectNameAliases(ARC_ROOT) } : {},
    );
    const result = modules.hybridRetrieve(db, { query: shaped.query, shaped, taskText: QUERY, maxResults: 25 });
    return WATCH.map((candidate) => {
      const index = result.candidates.findIndex((row) => row.localName === candidate);
      const row = index < 0 ? undefined : result.candidates[index];
      const direct = row?.scores.directAnswerScore ?? 0;
      const positive = row?.scores.positiveObjectiveScore ?? 0;
      const contrast = row?.scores.contrastPenalty ?? 0;
      return {
        candidate,
        rank: index < 0 ? null : index + 1,
        lexicalScore: row?.scores.lexical ?? null,
        literalSymbolScore: row?.scores.symbol ?? null,
        positiveObjectiveScore: row?.scores.positiveObjectiveScore ?? null,
        contrastPenalty: row?.scores.contrastPenalty ?? null,
        directAnswerScore: row?.scores.directAnswerScore ?? 0,
        baseScore: row === undefined ? null : round(row.scores.final - direct - positive + contrast),
        finalScore: row?.scores.final ?? null,
        reason: row?.evidence.find((line) => line.includes("direct definition matches")) ?? null,
      };
    });
  } finally {
    db.close();
  }
}

function buildCurrentCapsule(dbPath: string): { lead: string | null; roles: Json[] } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const result = buildCapsuleV2({ db, repoRoot: ARC_ROOT, task: QUERY, intent: CapsuleIntent.Auto, maxTokens: 9_000 });
    const rows = [
      ...result.pivots.map((row) => ({ ...row, role: "pivot" })),
      ...result.support.map((row) => ({ ...row, role: "support" })),
      ...result.discarded.map((row) => ({ ...row, role: "discarded" })),
    ];
    return {
      lead: result.pivots[0]?.fq_name ?? null,
      roles: rows.filter((row) => WATCH.includes(row.symbol)).map((row) => ({ candidate: row.symbol, role: row.role })),
    };
  } finally {
    db.close();
  }
}

function symbolHygiene(beforeModules: HistoricalModules): Json {
  const aliases = resolveProjectNameAliases(ARC_ROOT);
  const before = beforeModules.shapeSweQuery({ problemStatement: PROJECT_QUERY });
  const shaped = shapeSweQuery({ problemStatement: PROJECT_QUERY }, { projectNameAliases: aliases });
  const explicitIn = shapeSweQuery({ problemStatement: "where is element In defined?" }, { projectNameAliases: aliases });
  return {
    schemaVersion: "stage5.m137.symbol-hypothesis-cleanup.v1",
    query: PROJECT_QUERY,
    beforeLikelySymbols: before.likelySymbols,
    afterLikelySymbols: shaped.likelySymbols,
    identifierSignals: shaped.derivedIntent?.identifierSignals,
    symbolHypotheses: shaped.derivedIntent?.symbolHypotheses,
    projectReferences: shaped.derivedIntent?.projectReferences,
    explicitInControl: explicitIn.derivedIntent?.symbolHypotheses,
    proseMetamorphism: {
      base: shapeSweQuery({ problemStatement: "find the parser behavior" }).likelySymbols,
      withPreposition: shapeSweQuery({ problemStatement: "find the parser behavior in this file" }).likelySymbols,
    },
    pass: !shaped.likelySymbols.some((term) => ["in", "arc"].includes(term.toLowerCase()))
      && explicitIn.likelySymbols.includes("In"),
  };
}

function projectNameCases(): Json {
  const aliases = resolveProjectNameAliases(ARC_ROOT);
  const base = shapeSweQuery({ problemStatement: "how is geometry handled?" }, { projectNameAliases: aliases });
  const generic = shapeSweQuery({ problemStatement: "how is geometry handled in ARC?" }, { projectNameAliases: aliases });
  const explicit = shapeSweQuery({ problemStatement: "how does the ARC class initialize?" }, { projectNameAliases: aliases });
  return {
    schemaVersion: "stage5.m137.project-name-symbol-hygiene.v1",
    generic: { likelySymbols: generic.likelySymbols, projectReferences: generic.derivedIntent?.projectReferences },
    base: { likelySymbols: base.likelySymbols },
    explicitClass: { likelySymbols: explicit.likelySymbols, symbolHypotheses: explicit.derivedIntent?.symbolHypotheses },
    pass: JSON.stringify(base.likelySymbols) === JSON.stringify(generic.likelySymbols) && explicit.likelySymbols.includes("ARC"),
  };
}

function existenceCases(): Json {
  const cases = [
    ["is there already a function that parses bytes?", "capability_lookup"],
    ["which helper normalizes a single vector?", "capability_lookup"],
    [QUERY, "capability_lookup"],
    ["how are dihedral angles handled in ARC?", "general"],
    ["compare get_dihedral and calculate_dihedral_angle", "general"],
    ["who calls get_dihedral?", "general"],
    ["find calculate_dihedral_angle", "general"],
  ].map(([task, expected]) => ({ task, expected, actual: deriveQueryIntent(task!).kind }));
  return { schemaVersion: "stage5.m137.existence-intent-cases.v1", cases, pass: cases.every((row) => row.actual === row.expected) };
}

function performanceProfile(dbPath: string): Json {
  const iterations = 2_000;
  let started = performance.now();
  for (let index = 0; index < iterations; index += 1) deriveQueryIntent(PROJECT_QUERY, { projectNameAliases: new Set(["arc"]) });
  const queryDerivationTotal = performance.now() - started;
  const intent = deriveQueryIntent(QUERY);
  const candidate = { localName: "get_dihedral", kind: "function", signature: "get_dihedral(v1, v2, v3, units='degs') -> float", docstring: "Calculate the dihedral angle between three vectors." };
  started = performance.now();
  for (let index = 0; index < iterations; index += 1) evaluateDirectAnswer(intent, candidate);
  const definitionScoringTotal = performance.now() - started;
  const db = new Database(dbPath, { readonly: true });
  const shaped = shapeSweQuery({ problemStatement: QUERY }, { projectNameAliases: resolveProjectNameAliases(ARC_ROOT) });
  started = performance.now();
  hybridRetrieve(db, { query: shaped.query, shaped, taskText: QUERY, maxResults: 25 });
  const totalRetrieval = performance.now() - started;
  db.close();
  return {
    schemaVersion: "stage5.m137.performance.v1",
    iterations,
    queryIntentDerivationMsPerRequest: round(queryDerivationTotal / iterations),
    symbolHypothesisCleanupIncludedInDerivation: true,
    definitionCapabilityScoringMsPerCandidate: round(definitionScoringTotal / iterations),
    totalArcRetrievalMs: round(totalRetrieval),
    sourceReadsPerCandidate: 0,
  };
}

async function tckdbAcceptance(scratch: string): Promise<Json> {
  const dbPath = path.join(scratch, "tckdb.sqlite");
  await copyFile(TCKDB_INDEX, dbPath);
  const db = new Database(dbPath, { readonly: true });
  try {
    const task = "Which helper builds the computed-reaction upload payload for the Python client?";
    const result = buildCapsuleV2({ db, repoRoot: TCKDB_ROOT, task, intent: CapsuleIntent.Auto, maxTokens: 8_000 });
    return {
      schemaVersion: "stage5.m137.tckdb-acceptance.v1",
      repository: repository(TCKDB_ROOT, dbPath),
      query: task,
      lead: result.pivots[0]?.fq_name ?? null,
      selected: [...result.pivots, ...result.support].map((row) => `${row.path}::${row.symbol}`),
      intent: result.diagnostics.query_semantics?.intent ?? null,
      pass: result.pivots.length > 0,
    };
  } finally {
    db.close();
  }
}

async function loadHistoricalModules(root: string): Promise<HistoricalModules> {
  const shaping = await import(pathToFileURL(path.join(root, "src/capsule/sweQueryShaping.ts")).href);
  const retrieval = await import(pathToFileURL(path.join(root, "src/retrieval/hybridRetrieval.ts")).href);
  return { shapeSweQuery: shaping.shapeSweQuery, hybridRetrieve: retrieval.hybridRetrieve } as HistoricalModules;
}

async function call(server: ReturnType<typeof createMcpServer>, toolId: McpToolId, input: Json): Promise<Json> {
  const response = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: `m137-${toolId}`, toolId, input });
  if (response.result.ok === false) throw new Error(`${toolId}: ${JSON.stringify(response.result.error)}`);
  return response.result.output as Json;
}

function projectBudget(output: Json, budget: number): Json {
  const product = record(output.productContext);
  const delivery = record(product.delivery);
  const envelope = record(output.responseBudget);
  const visible = text(product.modelVisibleContext);
  return {
    budget,
    resultState: product.resultState,
    retrievalFound: product.retrievalFound,
    resolved: product.resolved,
    deliveredItems: delivery.deliveredItems,
    itemsNonEmpty: Array.isArray(product.items) && product.items.length > 0,
    getDihedralVisible: visible.includes("get_dihedral"),
    withinEnvelope: envelope.within_envelope,
  };
}

function summarizeFlow(output: Json): Json {
  const paths = Array.isArray(output.paths) ? output.paths : [];
  const first = record(paths[0]);
  const steps = Array.isArray(first.steps) ? first.steps : [];
  return { summary: output.summary, pathCount: paths.length, edgeCount: first.edgeCount ?? steps.length, firstEdge: steps[0] ?? null };
}

function summarizeImpact(output: Json): Json {
  const envelope = record(output.responseBudget);
  const edges = Array.isArray(output.edges) ? output.edges.map(record) : [];
  return {
    resolvedSymbol: record(output.resolvedSymbol).fqName ?? null,
    resultState: envelope.resultState ?? null,
    edgeCount: edges.length,
    callers: edges.filter((edge) => edge.toFqName === "arc/species/vectors.py::get_dihedral").map((edge) => edge.fromFqName),
    withinEnvelope: envelope.withinEnvelope,
    requestedMaxEdges: envelope.requestedMaxEdges,
    retainedEdges: envelope.retainedEdges,
  };
}

function passBudget(row: Json): boolean {
  return row.resultState === "resolved" && row.retrievalFound === true && row.resolved === true
    && row.itemsNonEmpty === true && row.getDihedralVisible === true && row.withinEnvelope === true;
}

function monotonicVisibility(rows: Json[]): boolean {
  let seen = false;
  for (const row of rows) {
    if (row.getDihedralVisible === true) seen = true;
    else if (seen) return false;
  }
  return true;
}

function repository(root: string, isolatedIndex: string): Json {
  return { root, branch: git(root, ["branch", "--show-current"]), head: git(root, ["rev-parse", "HEAD"]), isolatedIndex, sourceReadOnly: true };
}

function baselineRootArg(argv: readonly string[]): string {
  const index = argv.indexOf("--baseline-root");
  if (index < 0 || argv[index + 1] === undefined) throw new Error("Missing --baseline-root <M136 worktree>.");
  return path.resolve(argv[index + 1]!);
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().trim();
}

function record(value: unknown): Json { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function round(value: number): number { return Math.round(value * 10_000) / 10_000; }
async function json(name: string, value: unknown): Promise<void> { await writeFile(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
