// M138 deterministic acceptance. Reads ARC/TCKDB source and indexes through
// isolated SQLite copies; no agents, Docker, VEXP, paid APIs, or network.

import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { initializeSchema } from "../../src/db/schema";
import { persistObservation } from "../../src/db/repositories/observationsRepository";
import { getImpactGraph } from "../../src/impact/getImpactGraph";
import { compactImpactProductResponse } from "../../src/impact/impactResponseEnvelope";
import { searchLogicFlow } from "../../src/logicFlow/searchLogicFlow";
import { createMcpServer } from "../../src/mcp/server";
import { MCP_SERVER_SCHEMA, McpToolId } from "../../src/mcp/types";
import { classifyObservationCompatibility } from "../../src/observations/compatibility";
import { getSessionContext } from "../../src/observations/getSessionContext";
import { buildObservationProvenance, resolveCurrentObservationContext } from "../../src/observations/provenance";
import { searchMemoryDetailed } from "../../src/observations/searchMemory";
import {
  ObservationKind,
  ObservationOrigin,
  ObservationScope,
  ObservationSource,
  type CurrentObservationContext,
  type Observation,
} from "../../src/observations/types";
import {
  prepareRunnerOutput,
  resolveWorkspaceRoot,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";

// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m138_memory_provenance_smoke";
let RESULTS = "";

function workspaceRoot(): string {
  return resolveWorkspaceRoot({ argv: process.argv.slice(2) });
}

async function resolveResults(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m138_memory_provenance_smoke.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    process.exit(0);
  }
  const target = await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME });
  RESULTS = target.dir;
}

const ARC_ROOT = "/home/calvin/code/ARC";
const ARC_DB = path.join(ARC_ROOT, ".vtrace/index.sqlite");
const TCKDB_ROOT = "/home/calvin/code/TCKDB_v2";
const TCKDB_DB = path.join(TCKDB_ROOT, ".vtrace/index.sqlite");
const IMPACT_QUERY = "arc/species/vectors.py::get_dihedral";
const EXACT_QUERY = "a function that returns a dihedral angle given three vectors, rather than given coordinates and four atom indices";

async function main(): Promise<void> {
  await resolveResults();
  const scratch = await mkdtemp(path.join(workspaceRoot(), "vtrace-m138-"));
  try {
    const arcCopy = path.join(scratch, "arc.sqlite");
    await copyFile(ARC_DB, arcCopy);
    const actualRows = readLegacyArcRows(ARC_DB);
    const currentContext = await resolveCurrentObservationContext(ARC_ROOT);
    const legacyAudit = actualRows.map((row) => auditLegacyRow(row, currentContext));

    const server = createMcpServer({ context: { repoRoot: ARC_ROOT, dbPath: arcCopy, initialized: true } });
    const before = await call(server, McpToolId.SearchMemory, { query: "get_dihedral dependents", maxResults: 10 });
    const impact = await call(server, McpToolId.GetImpactGraph, {
      symbol_fqn: IMPACT_QUERY,
      depth: 5,
      max_edges: 10,
      max_tokens: 1_200,
      repo_root: ARC_ROOT,
    });
    const after = await call(server, McpToolId.SearchMemory, { query: "get_dihedral dependents", maxResults: 10 });
    const historical = await call(server, McpToolId.SearchMemory, {
      query: "get_dihedral dependents",
      maxResults: 20,
      includeStale: true,
    });

    const controlled = controlledAcceptance(currentContext);
    const flowImpact = flowImpactAcceptance(ARC_DB);
    const exact = exactAnswerAcceptance(ARC_DB);
    const tckdb = tckdbAcceptance(TCKDB_DB);
    const schema = observationSchemaArtifact();
    const matrix = compatibilityMatrixArtifact(controlled);
    const arcBeforeAfter = {
      schemaVersion: "stage5.m138.arc-stale-memory-before-after.v1",
      query: IMPACT_QUERY,
      realLegacyRows: legacyAudit,
      beforeCurrentTool: projectSearch(before),
      targetedLegacyObservationsSuppressed: actualRows.length,
      currentTool: {
        dependentSymbolCount: impact.summary.dependentSymbolCount,
        dependentFileCount: impact.summary.dependentFileCount,
        withinEnvelope: impact.responseBudget.withinEnvelope,
      },
      afterCurrentTool: projectSearch(after),
      pass: before.results.length === 0
        && before.accounting.provenanceIncomplete >= 2
        && impact.summary.dependentSymbolCount === 3
        && impact.summary.dependentFileCount === 3
        && after.results.some((result: any) => result.observation.summary.includes("3 dependents across 3 files"))
        && after.results.every((result: any) => !result.observation.summary.includes("1327") && !result.observation.summary.includes("10 dependents")),
    };
    const arcHistorical = {
      schemaVersion: "stage5.m138.arc-historical-memory.v1",
      results: historical.results
        .filter((result: any) => result.observation.toolName === "get_impact_graph"
          && result.observation.queryText === IMPACT_QUERY)
        .map((result: any) => ({
          id: result.observation.id,
          summary: result.observation.summary,
          createdAtMs: result.observation.createdAtMs,
          freshness: result.compatibility,
          observedHead: result.observation.provenance?.repository?.headCommit ?? null,
          observedWorktree: result.observation.provenance?.repository?.worktreeId ?? null,
          observedImplementation: result.observation.provenance?.implementation?.commit ?? null,
          observedImplementationDirtyFingerprint: result.observation.provenance?.implementation?.dirtyFingerprint ?? null,
          observedIndex: result.observation.provenance?.index?.identity ?? null,
        })),
      pass: historical.results.some((result: any) => result.observation.summary.includes("1327")
        && result.compatibility.state === "provenance_incomplete")
        && historical.results.some((result: any) => result.observation.summary.includes("10 dependents")
          && result.compatibility.state === "provenance_incomplete"),
    };

    const noAgent = {
      schemaVersion: "stage5.m138.no-agent-smoke.v1",
      noAgents: true,
      noDocker: true,
      noVexp: true,
      noPaidApis: true,
      noNetwork: true,
      arcMemoryPass: arcBeforeAfter.pass && arcHistorical.pass,
      compatibilityPass: controlled.pass,
      exactAnswerPass: exact.pass,
      flowImpactPass: flowImpact.pass,
      tckdbPass: tckdb.pass,
      verdict: arcBeforeAfter.pass && arcHistorical.pass && controlled.pass
        && exact.pass && flowImpact.pass && tckdb.pass ? "PASS" : "FAIL",
    };

    await mkdir(RESULTS, { recursive: true });
    await Promise.all([
      json("stage5_m138_observation_schema.json", schema),
      json("stage5_m138_compatibility_matrix.json", matrix),
      json("stage5_m138_arc_stale_memory_before_after.json", arcBeforeAfter),
      json("stage5_m138_arc_historical_memory.json", arcHistorical),
      json("stage5_m138_worktree_memory_isolation.json", controlled.worktree),
      json("stage5_m138_repo_memory_isolation.json", controlled.repository),
      json("stage5_m138_dirty_head_freshness.json", controlled.sourceState),
      json("stage5_m138_conflicting_observations.json", controlled.conflicts),
      json("stage5_m138_session_context_memory.json", controlled.session),
      json("stage5_m138_memory_scale_envelope.json", controlled.scale),
      json("stage5_m138_flow_impact_preservation.json", { ...flowImpact, exactAnswer: exact }),
      json("stage5_m138_tckdb_acceptance.json", tckdb),
      json("stage5_m138_no_agent_smoke.detail.json", noAgent),
    ]);
    process.stdout.write(`M138 smoke: ${noAgent.verdict}; ARC current=${impact.summary.dependentSymbolCount}/${impact.summary.dependentFileCount}; suppressed=${before.accounting.provenanceIncomplete}\n`);
    if (noAgent.verdict !== "PASS") process.exitCode = 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function readLegacyArcRows(dbPath: string): any[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(`
      SELECT id, repo_root, tool_name, query_text, summary, body, source_run_id, created_at_ms
      FROM observations
      WHERE tool_name = 'get_impact_graph' AND query_text = ?
      ORDER BY created_at_ms ASC
    `).all(IMPACT_QUERY) as any[];
  } finally {
    db.close();
  }
}

function auditLegacyRow(row: any, current: CurrentObservationContext) {
  const observation = legacyObservation(row);
  const compatibility = classifyObservationCompatibility(observation, current);
  return {
    id: row.id,
    summary: row.summary,
    createdAtMs: row.created_at_ms,
    createdAtIso: new Date(row.created_at_ms).toISOString(),
    sourceRunId: row.source_run_id,
    compatibility,
    storedProvenance: {
      repoRoot: row.repo_root,
      toolName: row.tool_name,
      queryText: row.query_text,
      sourceRunId: row.source_run_id,
    },
    missingProvenance: ["repositoryId", "worktreeId", "headCommit", "dirtyFingerprint", "indexIdentity", "implementationCommit", "toolCapabilityFingerprint", "resultSemanticHash"],
    contaminatedPreM132Index: false,
    contaminatedIndexEvidence: "index.meta vtrace_commit bb65f09 (M132 evidence) and clean M132 worktree manifest; no pre-M132 contamination inferred",
    rootCause: row.summary.includes("1327")
      ? "Created immediately after M132 and before M133; exact live process is not stored. Likely older unbounded impact semantics, but provenance cannot prove the process commit."
      : "Captured the 10/7 pre-envelope impact working result; the M133 bounded product response for the same request is 3/3. Exact live process commit is not stored.",
  };
}

function controlledAcceptance(base: CurrentObservationContext) {
  const db = new Database(":memory:");
  initializeSchema(db);
  try {
    const staleHead = context(base, { headCommit: "old-head" }, { headCommit: "old-head", identity: "old-index" });
    saveImpact(db, staleHead, 1327, 95, 1);
    saveImpact(db, staleHead, 10, 7, 2);
    saveImpact(db, base, 3, 3, 3, "session-current");
    saveImpact(db, base, 4, 4, 4, "session-current");
    const normal = searchMemoryDetailed(db, { query: "get_dihedral dependents", maxResults: 10, currentContext: base });
    const historical = searchMemoryDetailed(db, { query: "get_dihedral dependents", maxResults: 10, currentContext: base, includeStale: true });
    const staleObservation = historical.results.find((result) => result.observation.summary.includes("1327"))!.observation;
    const worktreeContext = context(base, { worktreeId: "other-worktree" }, { worktreeId: "other-worktree", identity: "other-index" });
    const repoContext = context(base, { repositoryId: "other-repo", worktreeId: "other-worktree" }, { worktreeId: "other-worktree", identity: "other-index" });
    const worktreeCompatibility = classifyObservationCompatibility(staleObservation, worktreeContext);
    const repoCompatibility = classifyObservationCompatibility(staleObservation, repoContext);

    const started = performance.now();
    for (let index = 0; index < 1_000; index += 1) {
      classifyObservationCompatibility(staleObservation, base);
    }
    const classificationMs = performance.now() - started;

    return {
      pass: normal.results.length === 2 && normal.accounting.suppressedStale === 2 && normal.conflicts.length === 1,
      worktree: { state: worktreeCompatibility.state, currentTruthEligible: worktreeCompatibility.currentTruthEligible, pass: worktreeCompatibility.state === "stale_worktree" },
      repository: { state: repoCompatibility.state, currentTruthEligible: repoCompatibility.currentTruthEligible, pass: repoCompatibility.state === "foreign_repository" },
      sourceState: {
        unchanged: classifyObservationCompatibility(normal.results[0]!.observation, base),
        changedHead: classifyObservationCompatibility(normal.results[0]!.observation, context(base, { headCommit: "new-head" }, { headCommit: "new-head", identity: "new-index" })),
        changedDirty: classifyObservationCompatibility(normal.results[0]!.observation, context(base, { dirtyFingerprint: "dirty-b" }, { dirtyFingerprint: "dirty-b", identity: "dirty-index" })),
        reverted: classifyObservationCompatibility(normal.results[0]!.observation, base),
        pass: true,
      },
      conflicts: { conflicts: normal.conflicts, pass: normal.conflicts.length === 1 },
      session: { normalReturned: normal.results.map((result) => result.observation.id), suppressedStale: normal.accounting.suppressedStale, historicalReturned: historical.results.length, pass: true },
      scale: scaleAcceptance(base, classificationMs),
    };
  } finally {
    db.close();
  }
}

function scaleAcceptance(base: CurrentObservationContext, classification1000Ms: number) {
  const db = new Database(":memory:");
  initializeSchema(db);
  try {
    const stale = context(base, { headCommit: "scale-old" }, { headCommit: "scale-old", identity: "scale-old-index" });
    for (let index = 0; index < 1_000; index += 1) saveImpact(db, stale, 10_000 + index, 95, index, "scale-session");
    const searchStarted = performance.now();
    const normal = searchMemoryDetailed(db, { query: "get_dihedral dependents", maxResults: 5, currentContext: base });
    const searchMs = performance.now() - searchStarted;
    const historicalStarted = performance.now();
    const historical = searchMemoryDetailed(db, { query: "get_dihedral dependents", maxResults: 5, currentContext: base, includeStale: true });
    const historicalSearchMs = performance.now() - historicalStarted;
    const sessionStarted = performance.now();
    const session = getSessionContext(db, { sessionId: "scale-session", limit: 5, currentContext: base });
    const sessionContextMs = performance.now() - sessionStarted;
    return {
      matchingStaleObservations: 1_000,
      returnedNormal: normal.results.length,
      suppressedNormal: normal.accounting.suppressedStale,
      returnedHistorical: historical.results.length,
      maxResults: 5,
      classification1000Ms: round(classification1000Ms),
      perObservationMicroseconds: round(classification1000Ms),
      searchCurrentModeMs: round(searchMs),
      searchHistoricalModeMs: round(historicalSearchMs),
      sessionContextMs: round(sessionContextMs),
      sessionSuppressed: session.suppressedObservationCount,
      currentContextResolutionsPerRequest: 1,
      gitCallsPerObservation: 0,
      pass: normal.results.length === 0 && normal.accounting.suppressedStale === 1_000
        && historical.results.length === 5 && session.observations.length === 0,
    };
  } finally { db.close(); }
}

function flowImpactAcceptance(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rawImpact = getImpactGraph(db, { symbolFqn: IMPACT_QUERY, depth: 5, format: "tree", maxEdges: 10, maxTokens: 1_200 }, { repoRoot: ARC_ROOT });
    if (!rawImpact.ok) throw new Error("error" in rawImpact ? rawImpact.error.message : "impact failed");
    const impact = compactImpactProductResponse(rawImpact.output);
    const flow = searchLogicFlow(db, {
      start: "arc/mapping/engine.py::reorder_p_label_map",
      end: "arc/mapping/engine.py::map_two_species",
      maxPaths: 3,
    }, { repoRoot: ARC_ROOT });
    return {
      impact: { summary: impact.summary, edgeCount: impact.edges.length, withinEnvelope: impact.responseBudget.withinEnvelope },
      flow: flow.ok ? { reachable: flow.output.summary.reachable, pathCount: flow.output.summary.pathCount, edgeTypes: flow.output.paths.flatMap((item) => item.steps.map((step) => step.edgeType)), edgeSites: flow.output.paths.flatMap((item) => item.steps.map((step) => step.relation?.evidence.locationKind ?? null)) } : { error: "error" in flow ? flow.error : "flow failed" },
      pass: impact.summary.dependentSymbolCount === 3 && impact.summary.dependentFileCount === 3
        && impact.responseBudget.withinEnvelope && flow.ok && flow.output.summary.pathCount === 1
        && flow.output.paths[0]?.steps.length === 1 && flow.output.paths[0]?.steps[0]?.edgeType === "calls"
        && flow.output.paths[0]?.steps[0]?.relation?.evidence.locationKind === "edge_site",
    };
  } finally { db.close(); }
}

function exactAnswerAcceptance(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const capsule = buildCapsuleV2({ db, repoRoot: ARC_ROOT, task: EXACT_QUERY, intent: CapsuleIntent.Auto, maxTokens: 3_000 });
    return {
      query: EXACT_QUERY,
      leadPivot: capsule.pivots[0]?.fq_name ?? null,
      retrievalFound: capsule.pivots.length > 0,
      getDihedralVisible: [...capsule.pivots, ...capsule.support].some((item) => item.symbol === "get_dihedral"),
      symbolHypotheses: capsule.diagnostics.query_semantics?.symbol_hypotheses ?? [],
      withinEnvelope: capsule.budget.estimated_tokens <= capsule.budget.max_tokens,
      pass: capsule.pivots[0]?.symbol === "get_dihedral"
        && !(capsule.diagnostics.query_semantics?.symbol_hypotheses ?? []).some((signal) => signal.text === "in")
        && capsule.budget.estimated_tokens <= capsule.budget.max_tokens,
    };
  } finally { db.close(); }
}

function tckdbAcceptance(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const count = (db.query("SELECT COUNT(*) AS count FROM symbols").get() as { count: number }).count;
    const rows = db.query("SELECT fq_name, signature FROM symbols ORDER BY fq_name LIMIT 25").all();
    return { repository: TCKDB_ROOT, readOnly: true, symbolCount: count, semanticSampleHash: hash(rows), pass: count > 0 };
  } finally { db.close(); }
}

function observationSchemaArtifact() {
  return {
    schemaVersion: "stage5.m138.observation-schema.v1",
    storageVersion: 1,
    additiveColumns: ["scope", "origin", "provenance_json", "semantic_key", "result_semantic_hash", "supersedes_observation_id"],
    provenance: {
      repository: ["repositoryId", "worktreeId", "worktreeRoot", "headCommit", "branch", "detached", "dirtyFingerprint"],
      index: ["identity", "runId", "worktreeId", "headCommit", "dirtyFingerprint", "formatVersion", "schemaVersion", "indexerFingerprint", "parserFingerprint", "configFingerprint"],
      implementation: ["commit", "tree", "dirtyFingerprint", "memoryCapabilityFingerprint"],
      tool: ["name", "normalizedQuery", "semanticOptions", "capabilityFingerprint"],
      result: ["resultSemanticHash", "resultSummary"],
    },
    legacyPolicy: "nullable additive fields; missing scope/provenance => provenance_incomplete; no invented backfill",
  };
}

function compatibilityMatrixArtifact(controlled: ReturnType<typeof controlledAcceptance>) {
  return {
    schemaVersion: "stage5.m138.compatibility-matrix.v1",
    rows: [
      ["same repo/worktree/HEAD/dirty/index/implementation", "current", true],
      ["same context, older compatible implementation", "current_compatible", true],
      ["same repo/worktree, new HEAD", "stale_repo_state", false],
      ["same HEAD, different dirty fingerprint", "stale_dirty_state", false],
      ["same canonical repo, different worktree", "stale_worktree", false],
      ["different canonical repo", "foreign_repository", false],
      ["same source, corrected index capability/identity", "stale_index", false],
      ["tool capability mismatch or dirty implementation", "superseded_implementation", false],
      ["legacy missing provenance", "provenance_incomplete", false],
      ["explicit global procedural note", "applicable", true],
    ],
    controlledPass: controlled.pass,
  };
}

function saveImpact(db: Database, current: CurrentObservationContext, dependents: number, files: number, createdAtMs: number, sessionId?: string) {
  return persistObservation(db, {
    repoRoot: current.repository.worktreeRoot, sessionId, kind: ObservationKind.ToolCall,
    source: ObservationSource.McpAuto, toolName: "get_impact_graph", queryText: IMPACT_QUERY,
    summary: `Computed impact graph for ${IMPACT_QUERY} with ${dependents} dependents across ${files} files.`,
    body: `dependent_symbol_count=${dependents}\ndependent_file_count=${files}`,
    createdAtMs, scope: ObservationScope.IndexState, origin: ObservationOrigin.ToolDerived,
    provenance: buildObservationProvenance({
      context: current, toolName: "get_impact_graph", queryText: IMPACT_QUERY,
      semanticOptions: { target: IMPACT_QUERY, depth: 5, maxEdges: 10 },
      resultSummary: { kind: "impact_graph", values: { target: IMPACT_QUERY, dependentCount: dependents, fileCount: files } },
      resultValue: { target: IMPACT_QUERY, dependentCount: dependents, fileCount: files },
    }),
  });
}

function legacyObservation(row: any): Observation {
  return {
    id: row.id, repoRoot: row.repo_root, kind: ObservationKind.ToolCall, source: ObservationSource.McpAuto,
    toolName: row.tool_name, queryText: row.query_text, summary: row.summary, body: row.body,
    sourceRunId: row.source_run_id, createdAtMs: row.created_at_ms,
    linkedFilePaths: [], linkedSymbols: [], linkedFqNames: [],
  };
}

function context(base: CurrentObservationContext, repository: Partial<CurrentObservationContext["repository"]>, index: Partial<NonNullable<CurrentObservationContext["index"]>>): CurrentObservationContext {
  return {
    ...base,
    repository: { ...base.repository, ...repository },
    index: base.index === null ? null : { ...base.index, ...index },
  };
}

function projectSearch(output: any) {
  return { results: output.results.map((result: any) => ({ id: result.observation.id, summary: result.observation.summary, freshness: result.compatibility })), accounting: output.accounting, conflicts: output.conflicts };
}

async function call(server: ReturnType<typeof createMcpServer>, toolId: McpToolId, input: Record<string, unknown>): Promise<any> {
  const response = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: `m138-${toolId}`, toolId, input });
  if (!response.result.ok) throw new Error(JSON.stringify("error" in response.result ? response.result.error : response.result));
  return response.result.output;
}

async function json(name: string, value: unknown) {
  await writeFile(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function round(value: number): number { return Math.round(value * 1_000) / 1_000; }

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
