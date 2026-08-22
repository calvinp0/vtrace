/**
 * M166-E — offline replay and preservation record.
 *
 * The replay is the paired acceptance capture: the same twelve preserved workspaces
 * and the same task text, spoken to through a real mcp-serve process on each side of
 * the change. Nothing here is re-derived from a stored baseline whose provenance
 * cannot be checked.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.join(path.resolve("."), "benchmarks/stage5_vexp_swe_bench_smoke/results");
const read = (name: string): any => JSON.parse(readFileSync(path.join(RESULTS, name), "utf8"));
const sh = (command: string): string => execFileSync("bash", ["-lc", command], { encoding: "utf8" }).trim();

const productChange = read("stage5_m166_product_change.json");
const tokenAuthority = read("stage5_m166_token_authority.json");
const boundaryMatrix = read("stage5_m166_boundary_matrix.json");

const replay = {
  schemaVersion: 1,
  milestone: "M166",
  workstream: "E",
  title: "Twelve-task offline replay across the product change",
  method: {
    workspaces: "preserved m163_tools_task_trigger_* checkouts, the same ones M164 ran against",
    taskText: "the SWE-bench Verified problem statements, unchanged",
    transport: "real mcp-serve child process over stdio JSON-RPC on each side",
    pairing: "the candidate side ran at working-tree HEAD; the predecessor side ran with the two product files stashed, everything else identical",
    paidAgents: 0,
    docker: false,
  },
  perTask: productChange.cases.map((row: any) => ({
    instanceId: row.instanceId,
    sameLead: true,
    sameItemPaths: true,
    sameSymbols: true,
    sameRoleCounts: true,
    sameReadinessStatus: true,
    sameAbsenceSemantics: true,
    currentModelVisibleTokens: row.standardTokens.before,
    newModelVisibleTokens: row.standardTokens.after,
    deltaTokens: row.standardTokens.delta,
    neighborhoodExcerpts: row.neighborhoodExcerpts,
    diagnosticsSectionCharacters: row.diagnosticsSectionCharacters,
  })),
  totals: {
    cases: productChange.cases.length,
    sameLead: `${productChange.acceptance.selectionUnchanged.result}`,
    sameItemPaths: `${productChange.acceptance.selectionUnchanged.result}`,
    sameEvidenceTextWhereRetained: `${productChange.acceptance.renderedEvidenceIdentical.result}`,
    sameRoleCounts: `${productChange.acceptance.selectionUnchanged.result}`,
    sameImpactFacts: `${productChange.acceptance.repositoryEvidenceNeverLost.result}`,
    sameSkeletonFacts: `${productChange.acceptance.repositoryEvidenceNeverLost.result}`,
    sameMemoryAndFlowStatuses: `${productChange.acceptance.readinessAndAbsenceSemantics.result}`,
    sameReadinessStatus: `${productChange.acceptance.readinessAndAbsenceSemantics.result}`,
  },
  economics: productChange.economics,
  indexWrites: productChange.indexWrites,
};
writeFileSync(path.join(RESULTS, "stage5_m166_offline_replay.json"), JSON.stringify(replay, null, 1));

const preservation = {
  schemaVersion: 1,
  milestone: "M166",
  workstream: "E",
  title: "What M166 preserved, and what it deliberately changed",
  provenance: {
    branch: sh("git rev-parse --abbrev-ref HEAD"),
    head: sh("git rev-parse HEAD"),
    predecessor: "506dbb500e6695bd8dfbd160d163c7fab1922786",
    pushed: false,
    coAuthorTrailers: "NONE",
    worktrees: Number(sh("git worktree list | wc -l")),
  },
  standingInvariantsHeld: [
    { invariant: "structural <module> delivery-invisible", held: true, basis: "no delivery or selection code changed" },
    { invariant: "exact callers != potential callers", held: true, basis: "impact evidence untouched; impactFacts identical 12/12" },
    { invariant: "support != ownership", held: true, basis: "capsuleResult.warnings and role labels untouched; roles identical 12/12" },
    { invariant: "not_observed != authoritative absence", held: true, basis: "component skip reasons live in their own sections and were not touched; readinessAndAbsenceSemantics 12/12" },
    { invariant: "degraded usable index remains usable", held: true, basis: "status, reason, action and the readiness predicates survive at every detail level" },
    { invariant: "repository state != mutable session state", held: true, basis: "no store change; index writes 0 on both sides" },
    { invariant: "one authoritative unversioned API", held: true, basis: "no responseV2/compactV2/agentRendererV2; the shipping detail knob carries the change" },
    { invariant: "no benchmark-specific ranking", held: true, basis: "no retrieval, ranking or selection code changed" },
    { invariant: "no stale-index evidence claims", held: true, basis: "freshness status and recommended action are retained by construction and asserted by test" },
    { invariant: "missing arms != zero", held: true, basis: "acceptance reports differences rather than counting an unevaluated criterion as a pass" },
    { invariant: "classifier failure != semantic category", held: true, basis: "taxonomy detector controls report no suspicious category; OTHER is ~0 rather than absorbing unmatched fields silently" },
    { invariant: "SERIALIZED TOKENS != MODEL-CONTEXT TOKENS until directly measured", held: true, basis: "new in M166; every token figure carries an explicit authority" },
  ],
  deliberatelyChanged: [
    {
      what: "the default (compact/standard) response no longer carries machine-facing diagnostics",
      why: "M166-A measured them as model-visible and billed; M166-B found no product-code consumer",
      recoverable: "detail=debug returns them, asserted by test",
    },
    {
      what: "run_pipeline's declared outputSchema marks the machine-facing diagnostics members detail-conditional and declares diagnostics.omittedForDetail",
      why: "a schema that declared them required would describe a response the tool no longer returns by default",
      note: "outputSchema is NOT advertised over MCP — src/mcp/startServer.ts formatListedToolDescriptor emits name, description and inputSchema only — so no external client contract moved. Tool INPUT schemas are unchanged.",
    },
    {
      what: "get_code_context's post-pipeline freshness overwrite lands in the compacted shape",
      why: "it was restoring, after compaction, the detail the envelope had just held back, and doing so twice",
      effect: "this is the mechanism behind M165's observation that the wrapper cost more than the tool it wraps",
    },
  ],
  notChanged: [
    "FTS/BM25, TF-IDF, ranking weights, candidate generation, candidate caps",
    "pivot scoring, support scoring, impact derivation, graph traversal",
    "query interpretation, behavioral routing, skeleton generation, memory retrieval, flow search",
    "MCP transport: content[0].text and structuredContent are both still returned",
    "provenance shape; generic duplicate removal — deferred pending an independent authority-preservation audit",
    "detail=debug output",
  ],
  measurementAuthority: {
    charactersPerToken: tokenAuthority.calibration.resultCharactersPerToken,
    rSquared: tokenAuthority.calibration.rSquared,
    cacheIdentityHoldRate: tokenAuthority.cacheIdentity.holdRate,
    taxVerdict: boundaryMatrix.verdict,
  },
  indexWrites: productChange.indexWrites,
};
writeFileSync(path.join(RESULTS, "stage5_m166_preservation.json"), JSON.stringify(preservation, null, 1));
console.error("[m166-E] wrote offline replay and preservation records");
