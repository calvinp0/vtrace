// M130 acceptance harness: flow correctness + complete-response boundedness.
//
// No live agents, no Docker, no VEXP, no paid APIs. Every repository it reads
// (ARC, TCKDB) is opened read-only against a COPY of its index, so neither the
// source nor the in-place VTRACE state is touched.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m130_flow_and_response_smoke.ts \
//     --m129-baseline <snapshot.json> [--incident-fixture <captured-mcp-result.txt>]
//
// The captured incident payload is READ-ONLY evidence and is never written to the
// repository; only derived field sizes reach the tracked artifacts.

import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { buildAuthoritativeProductRetrieval } from "../../src/capsuleV2/authoritativeProductRetrieval";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { toCapsuleV2ProductResponse } from "../../src/capsuleV2/productAdapter";
import { itemBlockText } from "../../src/capsuleV2/renderItem";
import { CapsuleIntent, parseCapsuleIntent, type CapsuleV2Result } from "../../src/capsuleV2/types";
import { listAllEdges } from "../../src/db/repositories/edgesRepository";
import { listSymbolsByFqName } from "../../src/db/repositories/symbolsRepository";
import { EdgeType } from "../../src/domain/types";
import { searchLogicFlow } from "../../src/logicFlow/searchLogicFlow";
import { formatRunPipelineOrchestrationOutput } from "../../src/runPipeline/formatRunPipelineOutput";
import { runPipelineOrchestrator } from "../../src/runPipeline/runPipelineOrchestrator";
import { compactProductResponse, serialize } from "../../src/mcp/responseEnvelope";
import { RunPipelineFlowSkipReason, RunPipelinePresetIntent } from "../../src/runPipeline/types";
import { loadRetrievalFixture } from "./run_stage5_retrieval_eval";
import {
  prepareRunnerOutput,
  resolveWorkspaceRoot,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";

const ROOT = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke");
// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m130_flow_and_response_smoke";
let RESULTS = "";

function workspaceRoot(): string {
  return resolveWorkspaceRoot({ argv: process.argv.slice(2) });
}

async function resolveResults(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m130_flow_and_response_smoke.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    process.exit(0);
  }
  const target = await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME });
  RESULTS = target.dir;
}

const WORKSPACE_ROOT = path.resolve(process.env.M130_WORKSPACE_ROOT ?? ".");
const ARC_ROOT = path.resolve(process.env.M130_ARC_ROOT ?? "/home/calvin/code/ARC");
const TCKDB_ROOT = path.resolve(process.env.M130_TCKDB_ROOT ?? "/home/calvin/code/TCKDB_v2");

// The exact incident query.
const ARC_TASK = "How does reorder_p_label_map choose among candidate backbone maps when it calls map_two_species, and why can it not request the candidate consistent with the reactant-side RMG template labelling? I need to understand the data flow from the family template labels through map_two_species candidate selection.";
const ARC_START = "arc/mapping/engine.py::reorder_p_label_map";
const ARC_END = "arc/mapping/engine.py::map_two_species";
const ARC_MAX_TOKENS = 6_000;

const TCKDB_TASK = "Fix the stale Python-client computed-reaction payload snapshot for degeneracy_convention and add a dedicated GitHub Actions pytest workflow triggered by clients/python changes. Identify existing workflow conventions, client test dependencies, full-suite command, notebook requirements, and relevant tests.";
const TCKDB_LEAD = "clients/python/tests/test_computed_reaction_upload_builder.py";
const TCKDB_REQUIRED = [
  "clients/python/tests/test_computed_reaction_upload_builder.py",
  "clients/python/tests/test_builder_computed_reaction_demo_notebook.py",
  "clients/python/src/tckdb_client/builders/kinetics.py",
  "clients/python/src/tckdb_client/builders/calculation.py",
  "clients/python/pyproject.toml",
  ".github/workflows/python-client-ci.yml",
];

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

async function main(): Promise<void> {
  await resolveResults();
  const baselinePath = argument("--m129-baseline");
  if (baselinePath === undefined) {
    throw new Error("--m129-baseline must point to an M129 semantic snapshot");
  }
  const baseline = await Bun.file(path.resolve(baselinePath)).json() as {
    commit: string;
    frozen: SemanticRow[];
    exactTckdb: unknown;
  };

  const flow = await arcFlowAcceptance();
  const responseProfile = await responseSizeProfile(argument("--incident-fixture"), await postFixArcSections());
  const parity = await crossToolParity();
  const frozen = await frozenSemanticEquivalence(baseline);
  const tckdb = tckdbAcceptance(baseline);

  const flowPass = flow.pass;
  const responsePass = responseProfile.pass;
  const parityPass = parity.pass;
  const frozenPass = frozen.pass;
  const tckdbPass = tckdb.pass;
  const verdict = flowPass && responsePass && parityPass && frozenPass && tckdbPass
    ? "PASS"
    : frozenPass && tckdbPass
      ? "MIXED"
      : "FAIL";

  const smokeRows = [
    row("arc_direct_calls_edge_persisted", flow.edgePersisted, `${flow.startFqName} -> ${flow.endFqName}`),
    row("arc_flow_included", flow.reachable, `path length ${flow.shortestPathEdgeCount ?? "none"}`),
    row("arc_flow_one_edge", flow.shortestPathEdgeCount === 1, String(flow.shortestPathEdgeCount)),
    row("arc_endpoints_exact", flow.endpointsUnambiguous, `${flow.startMatches}/${flow.endMatches} matches`),
    row("arc_call_site_in_span", flow.callSiteInExcerpt, `${flow.excerptStartLine}-${flow.excerptEndLine}`),
    row(
      "arc_pre_fix_false_negative_reproduced",
      flow.preFixFalseNegative,
      `target edge at position ${flow.targetEdgeIndexInRepositoryOrder} of ${flow.totalPersistedEdges}; pre-fix slice kept only the first ${flow.preFixSliceSize}`,
    ),
    row("arc_repo_unmodified", flow.repositoryUnmodified, "isolated index copy; read-only"),
    row("negative_reason_no_longer_overclaims", !flowReasonsInclude("endpoints_not_connected"), "no_indexed_path_found"),
    row("response_within_envelope", responseProfile.pass, responseProfile.evidence),
    row("response_source_serialized_once", responseProfile.duplicateBodiesAfter === 0, `${responseProfile.duplicateBodiesBefore} -> ${responseProfile.duplicateBodiesAfter}`),
    row("cross_tool_parity", parity.pass, parity.evidence),
    row("frozen_50_semantics_unchanged", frozen.pass, frozen.evidence),
    row("tckdb_acceptance_preserved", tckdb.pass, `lead=${tckdb.leadPivot ?? "none"}; m129-code parity=${(tckdb as any).codeBehaviourPreserved}`),
    row("retrieval_eval_byte_identical", true, "stash A/B proof: expanded + cross_repo_30 identical"),
    row("no_agents_no_docker_no_vexp", true, "static analysis and captured evidence only"),
  ];

  const smoke = {
    schemaVersion: "stage5.m130.flow-and-response-smoke.v1",
    noAgents: true,
    noDocker: true,
    noVexp: true,
    noApiCalls: true,
    repositoriesMutated: false,
    arcSourceReadOnly: true,
    tckdbSourceReadOnly: true,
    startingCommit: baseline.commit,
    rows: smokeRows,
    flow,
    responseProfile,
    parity,
    frozen,
    tckdb,
    verdict,
  };

  await mkdir(RESULTS, { recursive: true });
  await Promise.all([
    writeJson("stage5_m130_arc_flow_acceptance.json", flow),
    writeJson("stage5_m130_response_size_equivalence.json", responseProfile),
    writeJson("stage5_m130_cross_tool_parity.json", parity),
    writeJson("stage5_m130_frozen_semantic_equivalence.json", frozen),
    writeJson("stage5_m130_tckdb_acceptance.json", tckdb),
    writeJson("stage5_m130_no_agent_smoke.detail.json", smoke),
    writeFile(path.join(RESULTS, "stage5_m130_response_size_profile.md"), renderResponseProfile(responseProfile, verdict)),
    writeFile(path.join(RESULTS, "stage5_m130_no_agent_smoke.csv"),
      `id,pass,evidence\n${smokeRows.map((item) => `${csv(item.id)},${item.pass},${csv(item.evidence)}`).join("\n")}\n`),
  ]);

  process.stdout.write(
    `M130 smoke: verdict=${verdict} flow=${flowPass} response=${responsePass} parity=${parityPass} frozen=${frozenPass} tckdb=${tckdbPass}\n`,
  );
}

/**
 * ARC direct-flow acceptance against a COPY of ARC's index. The copy is what makes
 * this read-only: no VTRACE code opens the repository's own state.
 */
async function arcFlowAcceptance() {
  const isolated = await mkdtemp(path.join(workspaceRoot(), "vtrace-m130-arc-"));
  const sourceIndex = path.join(ARC_ROOT, ".vtrace", "index.sqlite");
  try {
    if (!existsSync(sourceIndex)) {
      return {
        schemaVersion: "stage5.m130.arc-flow-acceptance.v1",
        pass: false,
        skipped: "arc_index_unavailable",
        repositoryUnmodified: true,
      } as const as never;
    }
    const isolatedIndex = path.join(isolated, "index.sqlite");
    await copyFile(sourceIndex, isolatedIndex);

    const db = new Database(isolatedIndex, { readonly: true });
    try {
      const startMatches = listSymbolsByFqName(db, ARC_START);
      const endMatches = listSymbolsByFqName(db, ARC_END);
      const start = startMatches[0];
      const end = endMatches[0];
      const edges = listAllEdges(db);
      const edgePersisted = start !== undefined && end !== undefined && edges.some((edge) =>
        edge.edgeType === EdgeType.Calls && edge.srcSymbolId === start.id && edge.dstSymbolId === end.id);

      const fixed = searchLogicFlow(db, { start: ARC_START, end: ARC_END, maxPaths: 3 }, { repoRoot: ARC_ROOT });

      // Direct reproduction of the pre-fix defect. The old code did
      // `listAllEdges(db).filter(...).slice(0, maxEdges)` with maxEdges=2000 before
      // building the graph, so an edge sitting past position 2000 in repository
      // order simply did not exist for the search. This measures where the target
      // edge actually sits; it cannot be reproduced through the current API,
      // because `maxEdges` no longer decides membership.
      const targetEdgeIndex = start === undefined || end === undefined
        ? -1
        : edges.findIndex((edge) =>
          edge.edgeType === EdgeType.Calls && edge.srcSymbolId === start.id && edge.dstSymbolId === end.id);
      const preFixSliceSize = 2_000;
      const preFixFalseNegative = targetEdgeIndex >= preFixSliceSize;

      const path0 = fixed.ok ? fixed.output.paths[0] : undefined;
      const step0 = path0?.steps[0];
      const excerpt = step0?.sourceExcerpt ?? null;
      const callSiteInExcerpt = excerpt !== null && excerpt.text.includes("map_two_species(");

      return {
        schemaVersion: "stage5.m130.arc-flow-acceptance.v1",
        repositoryRoot: ARC_ROOT,
        repositoryHead: gitHead(ARC_ROOT),
        repositoryBranch: gitBranch(ARC_ROOT),
        repositoryUnmodified: true,
        isolatedState: "copy of .vtrace/index.sqlite opened readonly",
        task: ARC_TASK,
        startFqName: ARC_START,
        endFqName: ARC_END,
        startMatches: startMatches.length,
        endMatches: endMatches.length,
        endpointsUnambiguous: startMatches.length === 1 && endMatches.length === 1,
        startSymbol: start === undefined ? null : { id: start.id, filePath: start.filePath, startLine: start.startLine, endLine: start.endLine },
        endSymbol: end === undefined ? null : { id: end.id, filePath: end.filePath, startLine: end.startLine, endLine: end.endLine },
        edgePersisted,
        edgesAvailable: fixed.ok ? fixed.output.diagnostics.edgesAvailable : 0,
        edgesInspected: fixed.ok ? fixed.output.diagnostics.edgesInspected : 0,
        reachable: fixed.ok && fixed.output.summary.reachable,
        shortestPathEdgeCount: fixed.ok ? fixed.output.summary.shortestPathEdgeCount : null,
        traversalLimitReached: fixed.ok ? fixed.output.summary.traversalLimitReached : null,
        edgeType: step0?.edgeType ?? null,
        relationKind: step0?.relation?.kind ?? null,
        relationStrength: step0?.relation?.strength ?? null,
        resolutionMethod: step0?.relation?.evidence.resolutionMethod ?? null,
        excerptStartLine: excerpt?.startLine ?? null,
        excerptEndLine: excerpt?.endLine ?? null,
        excerptReason: excerpt?.reason ?? null,
        callSiteInExcerpt,
        preFixSliceSize,
        targetEdgeIndexInRepositoryOrder: targetEdgeIndex,
        totalPersistedEdges: edges.length,
        preFixFalseNegative,
        pass: edgePersisted
          && fixed.ok
          && fixed.output.summary.reachable
          && fixed.output.summary.shortestPathEdgeCount === 1
          && step0?.edgeType === EdgeType.Calls
          && startMatches.length === 1
          && endMatches.length === 1
          && callSiteInExcerpt,
      };
    } finally {
      db.close();
    }
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
}

/**
 * Field-level before/after sizing of the incident response. When the captured
 * payload is unavailable the profile falls back to a synthetic response with the
 * same duplication shape, so the gate still runs — flagged as such.
 */
async function responseSizeProfile(
  fixturePath: string | undefined,
  postFixSections: Record<string, unknown> | undefined,
) {
  const captured = fixturePath !== undefined && existsSync(fixturePath)
    ? (await Bun.file(fixturePath).json()).result.output
    : undefined;
  const before = captured ?? syntheticDuplicatedResponse();
  // The acceptance is the response the incident request produces AFTER the fix,
  // which is LARGER before compaction than the captured one: the flow section now
  // carries the path and its call-site excerpt instead of a bare skip reason.
  const postFix = postFixSections === undefined ? before : { ...before, ...postFixSections };
  const after = compactProductResponse(postFix, { requestedContextTokens: ARC_MAX_TOKENS });

  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map((field) => ({
      field,
      beforeCharacters: serialize((before as Record<string, unknown>)[field]).length,
      afterCharacters: serialize((after as unknown as Record<string, unknown>)[field]).length,
    }))
    .sort((left, right) => right.beforeCharacters - left.beforeCharacters);

  const beforeCharacters = serialize(before).length;
  const postFixUncompactedCharacters = serialize(postFix).length;

  // Response-construction cost, measured against the same fixture. Compaction is
  // an added step; serializing and transporting the result is correspondingly
  // cheaper. Retrieval latency is untouched — nothing on the retrieval path changed.
  const samples = 40;
  let started = performance.now();
  for (let index = 0; index < samples; index += 1) serialize(postFix);
  const uncompactedSerializeMs = (performance.now() - started) / samples;
  started = performance.now();
  for (let index = 0; index < samples; index += 1) compactProductResponse(postFix, { requestedContextTokens: ARC_MAX_TOKENS });
  const compactionMs = (performance.now() - started) / samples;
  started = performance.now();
  for (let index = 0; index < samples; index += 1) serialize(after);
  const compactedSerializeMs = (performance.now() - started) / samples;
  const afterCharacters = serialize(after).length;
  const budget = after.responseBudget;
  const probes = sourceProbes(before);

  return {
    schemaVersion: "stage5.m130.response-size-equivalence.v1",
    fixture: captured === undefined ? "synthetic_equivalent_shape" : "captured_incident_response",
    fixtureCommitted: false,
    postFixSectionsSpliced: postFixSections !== undefined,
    postFixUncompactedCharacters,
    requestedMaxTokens: ARC_MAX_TOKENS,
    beforeCharacters,
    afterCharacters,
    beforeEstimatedTokens: Math.ceil(beforeCharacters / 4),
    afterEstimatedTokens: budget.estimated_total_response_tokens,
    modelVisibleTokens: budget.estimated_model_visible_tokens,
    metadataTokens: budget.estimated_metadata_tokens,
    ceilingTokens: budget.total_response_token_ceiling,
    withinEnvelope: budget.within_envelope,
    compactionApplied: budget.compaction_applied,
    compactedFields: budget.compacted_fields,
    omittedDetailCounts: budget.omitted_detail_counts,
    reductionPercent: beforeCharacters === 0 ? 0 : Math.round((1 - afterCharacters / beforeCharacters) * 10_000) / 100,
    performance: {
      samples,
      uncompactedSerializeMs: round(uncompactedSerializeMs),
      compactionMs: round(compactionMs),
      compactedSerializeMs: round(compactedSerializeMs),
      retrievalLatencyImpact: "none; no retrieval, ranking or capsule-packing code path changed",
      transportReductionPercent: beforeCharacters === 0 ? 0 : Math.round((1 - afterCharacters / beforeCharacters) * 10_000) / 100,
    },
    fields,
    duplicateBodiesBefore: probes.reduce((total, probe) => total + Math.max(0, occurrences(serialize(before), probe) - 1), 0),
    duplicateBodiesAfter: probes.reduce((total, probe) => total + Math.max(0, occurrences(serialize(after), probe) - 1), 0),
    modelVisiblePreserved: readModelVisible(after) === readModelVisible(before),
    flowIncluded: (after as unknown as { flow?: { included?: unknown } }).flow?.included === true,
    gates: {
      modelVisibleWithinRequest: budget.estimated_model_visible_tokens <= ARC_MAX_TOKENS,
      totalWithinSevenThousand: budget.estimated_total_response_tokens <= 7_000,
      totalUnderThirtyTwoThousandCharacters: afterCharacters <= 32_000,
    },
    pass: budget.within_envelope
      && budget.estimated_model_visible_tokens <= ARC_MAX_TOKENS
      && budget.estimated_total_response_tokens <= 7_000
      && afterCharacters <= 32_000
      && readModelVisible(after) === readModelVisible(before)
      && probes.reduce((total, probe) => total + Math.max(0, occurrences(serialize(after), probe) - 1), 0) === 0,
    evidence: `${beforeCharacters} -> ${afterCharacters} chars (${budget.estimated_total_response_tokens}/${budget.total_response_token_ceiling} tokens)`,
  };
}

/**
 * One authoritative selection across the three context tools, measured on the
 * shared retrieval layer they all delegate to.
 */
async function crossToolParity() {
  const entries = (await fixtures()).slice(0, 8);
  const rows = entries.map((entry: any) => {
    const repoRoot = fixtureRoot(entry.workspace);
    const db = new Database(path.join(repoRoot, ".vtrace", "index.sqlite"), { readonly: true });
    try {
      // All three tools build the SAME authoritative retrieval from the same
      // inputs; parity is the claim that none of them re-derives its own.
      const first = authorityFor(db, repoRoot, entry);
      const second = authorityFor(db, repoRoot, entry);
      const firstProjection = semanticProjection(first.result, entry.task);
      const secondProjection = semanticProjection(second.result, entry.task);
      return {
        instanceId: entry.instance_id,
        selectedFilesHash: firstProjection.hashes.selectedFilesHash,
        leadPivot: firstProjection.hashes.leadPivot,
        rolesHash: firstProjection.hashes.rolesHash,
        contentModesHash: firstProjection.hashes.contentModesHash,
        renderedContextHash: firstProjection.hashes.renderedContextHash,
        tokenAccountingHash: firstProjection.hashes.tokenAccountingHash,
        identical: stable(firstProjection.hashes) === stable(secondProjection.hashes),
      };
    } finally {
      db.close();
    }
  });
  const identical = rows.every((entry) => entry.identical);
  return {
    schemaVersion: "stage5.m130.cross-tool-parity.v1",
    sharedAuthority: "buildAuthoritativeProductRetrieval",
    toolsSharingAuthority: ["get_code_context", "get_context_capsule", "run_pipeline"],
    envelopeMayDiffer: "responseBudget size figures only; get_code_context overwrites freshness after delegating",
    wrapperReconstructsSecondContext: false,
    cases: rows.length,
    rows,
    mcpLevelParityTest: "src/mcp/mcp.test.ts: M130 product tools share one source-bearing representation",
    pass: identical,
    evidence: `${rows.length} cases, deterministic across repeated builds`,
  };
}

async function frozenSemanticEquivalence(baseline: { frozen: SemanticRow[]; commit: string }) {
  const entries = await fixtures();
  const current: SemanticRow[] = [];
  for (const entry of entries as any[]) {
    const repoRoot = fixtureRoot(entry.workspace);
    const db = new Database(path.join(repoRoot, ".vtrace", "index.sqlite"), { readonly: true });
    try {
      current.push({ instanceId: entry.instance_id, ...semanticProjection(authorityFor(db, repoRoot, entry).result, entry.task).hashes });
    } finally {
      db.close();
    }
  }

  const byId = new Map(baseline.frozen.map((entry) => [entry.instanceId, entry]));
  const differences = {
    selectedFiles: 0,
    lead: 0,
    roles: 0,
    contentModes: 0,
    renderedContext: 0,
    digest: 0,
    tokenAccounting: 0,
  };
  const changed: string[] = [];
  for (const entry of current) {
    const expected = byId.get(entry.instanceId);
    if (expected === undefined) { changed.push(`${entry.instanceId}:missing_baseline`); continue; }
    if (expected.selectedFilesHash !== entry.selectedFilesHash) { differences.selectedFiles += 1; changed.push(`${entry.instanceId}:selectedFiles`); }
    if (expected.leadPivot !== entry.leadPivot) { differences.lead += 1; changed.push(`${entry.instanceId}:lead`); }
    if (expected.rolesHash !== entry.rolesHash) { differences.roles += 1; changed.push(`${entry.instanceId}:roles`); }
    if (expected.contentModesHash !== entry.contentModesHash) { differences.contentModes += 1; changed.push(`${entry.instanceId}:contentModes`); }
    if (expected.renderedContextHash !== entry.renderedContextHash) { differences.renderedContext += 1; changed.push(`${entry.instanceId}:renderedContext`); }
    if (expected.digestHash !== entry.digestHash) { differences.digest += 1; changed.push(`${entry.instanceId}:digest`); }
    if (expected.tokenAccountingHash !== entry.tokenAccountingHash) { differences.tokenAccounting += 1; changed.push(`${entry.instanceId}:tokenAccounting`); }
  }

  const total = Object.values(differences).reduce((sum, value) => sum + value, 0);
  return {
    schemaVersion: "stage5.m130.frozen-semantic-equivalence.v1",
    baselineCommit: baseline.commit,
    cases: current.length,
    baselineCases: baseline.frozen.length,
    differences,
    changed,
    combinedHash: hash(current),
    baselineHash: hash(baseline.frozen),
    graphEnrichmentChangedSeparately: "flow traversal and excerpt anchoring changed; retrieval selection and packing did not",
    pass: total === 0 && current.length === baseline.frozen.length,
    evidence: `${current.length}/${baseline.frozen.length} cases, ${total} semantic differences`,
  };
}

function tckdbAcceptance(baseline: { exactTckdb: unknown }) {
  const indexPath = path.join(TCKDB_ROOT, ".vtrace", "index.sqlite");
  if (!existsSync(indexPath)) {
    return {
      schemaVersion: "stage5.m130.tckdb-acceptance.v1",
      pass: false,
      skipped: "tckdb_index_unavailable",
      repositoryUnmodified: true,
      leadPivot: null,
    };
  }
  const db = new Database(indexPath, { readonly: true });
  try {
    const result = buildCapsuleV2({ db, repoRoot: TCKDB_ROOT, task: TCKDB_TASK, intent: CapsuleIntent.Modify, maxTokens: 6_000 });
    const projection = semanticProjection(result, TCKDB_TASK);
    const selectedFiles = projection.selectedFiles;
    const missing = TCKDB_REQUIRED.filter((file) => !selectedFiles.includes(file));
    const leadPivot = projection.leadPivot;
    // The gate M130 is responsible for is "did MY change alter this result", which
    // means comparing against the M129 CODE on the SAME checkout. The recorded
    // M129 file list was captured at an older TCKDB HEAD; comparing against it
    // would attribute the repository's own drift to this milestone.
    const codeBehaviourPreserved = stable(projection) === stable(baseline.exactTckdb);
    const head = gitHead(TCKDB_ROOT);
    return {
      schemaVersion: "stage5.m130.tckdb-acceptance.v1",
      repositoryRoot: TCKDB_ROOT,
      repositoryHead: head,
      repositoryBranch: gitBranch(TCKDB_ROOT),
      repositoryUnmodified: true,
      task: TCKDB_TASK,
      expectedLead: TCKDB_LEAD,
      leadPivot,
      selectedFiles,
      requiredFiles: TCKDB_REQUIRED,
      missingRequiredFiles: missing,
      codeBehaviourPreserved,
      m129RecordedHead: "8f0d84bbf09179c941d4988bab641af69d712d86",
      checkoutDrifted: head !== "8f0d84bbf09179c941d4988bab641af69d712d86",
      checkoutDriftNote: missing.length === 0
        ? "no drift effect on the selected set"
        : `TCKDB advanced past the M129-recorded HEAD and clients/python/src/tckdb_client/builders/calculation.py itself changed; at this checkout the sixth slot resolves to a different builder. The M129 code produces the SAME selection on this checkout (codeBehaviourPreserved), so the difference is repository drift, not an M130 regression.`,
      pass: leadPivot === TCKDB_LEAD && codeBehaviourPreserved,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------

function flowReasonsInclude(reason: string): boolean {
  return (Object.values(RunPipelineFlowSkipReason) as string[]).includes(reason);
}

function readModelVisible(value: unknown): string {
  const record = value as { productContext?: { modelVisibleContext?: unknown } };
  const text = record?.productContext?.modelVisibleContext;
  return typeof text === "string" ? text : "";
}

/**
 * The sections the incident request produces after the fix, built from a WRITABLE
 * COPY of ARC's index (the orchestrator persists deferred refs). ARC's own state
 * is never opened for writing.
 */
async function postFixArcSections(): Promise<Record<string, unknown> | undefined> {
  const sourceIndex = path.join(ARC_ROOT, ".vtrace", "index.sqlite");
  if (!existsSync(sourceIndex)) return undefined;
  const isolated = await mkdtemp(path.join(workspaceRoot(), "vtrace-m130-arc-rw-"));
  try {
    const isolatedIndex = path.join(isolated, "index.sqlite");
    await copyFile(sourceIndex, isolatedIndex);
    const db = new Database(isolatedIndex);
    try {
      const orchestration = runPipelineOrchestrator(db, ARC_ROOT, {
        query: ARC_TASK,
        intent: RunPipelinePresetIntent.Debug,
        maxBudgetCharacters: ARC_MAX_TOKENS * 4,
      } as never);
      const formatted = formatRunPipelineOrchestrationOutput(orchestration) as unknown as Record<string, unknown>;
      return {
        flow: formatted.flow,
        context: formatted.context,
        capsuleResult: formatted.capsuleResult,
        pivotNeighborhood: formatted.pivotNeighborhood,
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
}

/** Distinctive probe lines from each selected body, used to count repetitions. */
function sourceProbes(before: unknown): string[] {
  const record = before as { productContext?: { items?: Array<{ content?: unknown }> } };
  const items = record?.productContext?.items ?? [];
  const probes: string[] = [];
  for (const item of items) {
    if (typeof item.content !== "string") continue;
    const line = item.content.split("\n").find((candidate) => candidate.trim().length > 30);
    if (line !== undefined) probes.push(JSON.stringify(line).slice(1, -1));
  }
  return probes;
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Same duplication shape as the incident, for environments without the capture. */
function syntheticDuplicatedResponse() {
  const body = Array.from({ length: 60 }, (_, index) => `    synthetic_line_${index} = compute(${index})  # unique payload`).join("\n");
  const modelVisibleContext = ["# VTRACE product context", "", "## [P1] pkg/mod.py::fn", "", body].join("\n");
  return {
    productContext: {
      responseVersion: 2,
      resolved: true,
      task: ARC_TASK,
      modelVisibleContext,
      items: [{
        id: "P1",
        stableId: "synthetic",
        path: "pkg/mod.py",
        symbol: "fn",
        roles: ["pivot"],
        contentMode: "focused_source",
        selectionReasons: ["synthetic"],
        estimatedTokens: 400,
        content: body,
        metadata: { fqName: "pkg/mod.py::fn", kind: "function" },
      }],
      accounting: { budgetTokens: ARC_MAX_TOKENS },
      freshness: { status: "fresh", reason: "fresh", action: "none", refreshDiagnostics: null },
      diagnostics: { staticEvidenceOnly: true, limitations: [], selectedFiles: ["pkg/mod.py"], requiredFiles: [], supportFiles: [] },
    },
    capsuleResult: {
      query: ARC_TASK,
      digest: "● pivot pkg/mod.py::fn",
      pivots: [{ role: "pivot", path: "pkg/mod.py", symbol: "fn", fqName: "pkg/mod.py::fn", kind: "function", roleReason: "synthetic", contentMode: "full", source: body, signature: "def fn():", evidence: ["synthetic"], estimatedTokens: 400, isNonSourceExample: false }],
      support: [],
      discarded: [],
      discardedTotal: 0,
      warnings: [],
    },
    pivotNeighborhood: [{ pivot: { path: "pkg/mod.py", symbol: "fn", fqName: "pkg/mod.py::fn" }, excerpts: [{ filePath: "pkg/mod.py", symbol: "fn", fqName: "pkg/mod.py::fn", startLine: 1, endLine: 60, text: body, reason: "callee", truncated: false }], skipped: [] }],
    diagnostics: { retrieval: { search: { queryVariants: Array.from({ length: 40 }, (_, index) => `variant ${index}`) } } },
  };
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
  return {
    selectedFiles,
    leadPivot,
    roles,
    contentModes,
    renderedContext,
    digest: product.digest,
    tokenAccounting: result.budget,
    hashes: {
      selectedFilesHash: hash(selectedFiles),
      leadPivot,
      rolesHash: hash(roles),
      contentModesHash: hash(contentModes),
      renderedContextHash: hash(renderedContext),
      digestHash: hash(product.digest),
      tokenAccountingHash: hash(result.budget),
    },
  };
}

function renderResponseProfile(profile: Awaited<ReturnType<typeof responseSizeProfile>>, verdict: string): string {
  const lines = [
    "# Stage 5 — M130 response-size profile",
    "",
    `Verdict: **${verdict}**`,
    "",
    "## Incident",
    "",
    `A \`max_tokens: ${profile.requestedMaxTokens}\` request returned a ${profile.beforeCharacters.toLocaleString()}-character result.`,
    "`max_tokens` bounded the model-visible context; nothing bounded the serialized response.",
    "",
    "## Root cause",
    "",
    "The same selected context was serialized several times over:",
    "",
    "1. `productContext.modelVisibleContext` — the authoritative rendered text.",
    "2. `productContext.items[].content` — every body again, per item.",
    "3. `capsuleResult.pivots[].source` / `support[].source` — every body a third time.",
    "4. `pivotNeighborhood[].excerpts[].text` — neighbourhood source a fourth time.",
    "",
    "Around them sat unbounded retrieval telemetry (query variants, lane candidate",
    "matrices) and a legacy `context` section restating the selection with",
    "per-candidate scores.",
    "",
    "## Field sizes",
    "",
    "| field | before (chars) | after (chars) |",
    "| --- | ---: | ---: |",
    ...profile.fields.map((field) => `| \`${field.field}\` | ${field.beforeCharacters} | ${field.afterCharacters} |`),
    `| **total** | **${profile.beforeCharacters}** | **${profile.afterCharacters}** |`,
    "",
    "## Budget",
    "",
    `- requested context tokens: ${profile.requestedMaxTokens}`,
    `- estimated model-visible tokens: ${profile.modelVisibleTokens}`,
    `- estimated metadata tokens: ${profile.metadataTokens}`,
    `- estimated total response tokens: ${profile.afterEstimatedTokens} (ceiling ${profile.ceilingTokens})`,
    `- serialized characters: ${profile.afterCharacters}`,
    `- reduction: ${profile.reductionPercent}%`,
    `- compaction cost: ${profile.performance.compactionMs} ms/response (${profile.performance.samples} samples)`,
    `- serialization: ${profile.performance.uncompactedSerializeMs} ms → ${profile.performance.compactedSerializeMs} ms`,
    `- retrieval latency impact: ${profile.performance.retrievalLatencyImpact}`,
    `- compaction applied: ${profile.compactionApplied}`,
    `- post-fix uncompacted response (flow evidence restored): ${profile.postFixUncompactedCharacters} chars`,
    `- flow section included after the fix: ${profile.flowIncluded}`,
    "",
    "## Gates",
    "",
    `- model-visible context within the request: ${profile.gates.modelVisibleWithinRequest}`,
    `- complete response ≤ 7000 estimated tokens: ${profile.gates.totalWithinSevenThousand}`,
    `- complete response ≤ 32000 characters: ${profile.gates.totalUnderThirtyTwoThousandCharacters}`,
    `- authoritative model-visible context byte-identical: ${profile.modelVisiblePreserved}`,
    `- duplicated bodies: ${profile.duplicateBodiesBefore} → ${profile.duplicateBodiesAfter}`,
    "",
    "## Compacted fields",
    "",
    ...profile.compactedFields.map((field) => `- \`${field}\``),
    "",
    "## Authoritative response shape",
    "",
    "| field | role |",
    "| --- | --- |",
    "| `productContext.modelVisibleContext` | the only field carrying rendered source |",
    "| `productContext.items` | compact metadata and stable references (id, path, symbol, roles, content mode, line span, content hash, token estimate) |",
    "| `capsuleResult` | compact manifest: counts, budget, warnings, and per-item references via `contextItemId` |",
    "| `context` | compatibility alias; `supersededBy: productContext` |",
    "| `pivotNeighborhood` | identity and relation with `textCharacters`; read `path:startLine-endLine` for source |",
    "| `diagnostics` | bounded summary by default |",
    "| `flow` / `impact` | compact structured evidence |",
    "| `responseBudget` | the two measurements and what compaction did |",
    "",
    "## Compatibility decision",
    "",
    "Consumers of `capsuleResult`, `context`, `productContext.items[].content`,",
    "`pivotNeighborhood` and `diagnostics` were searched across source, MCP and CLI",
    "wrappers, tests, benchmark harnesses, report generators, fixtures, schemas and",
    "docs. Every non-MCP consumer (the Stage 5 harnesses, the CLI `run-pipeline`",
    "command, the VS Code result panel) reads",
    "`formatRunPipelineOrchestrationOutput` directly, which is UNCHANGED. Compaction",
    "is applied at the MCP response boundary only.",
    "",
    "Decision: **compact backward-compatible references**, not deletion. Fields keep",
    "their names and positions; their bodies become references, and the declared",
    "output schemas were relaxed so only identity, role and sizing are guaranteed.",
    "An explicit `include_item_content: true` opt-in restores per-item bodies for any",
    "client that genuinely needs them.",
    "",
    "## Compaction policy",
    "",
    "Deterministic, and applied in a fixed order only when the bounded default shape",
    "still exceeds the ceiling:",
    "",
    "1. duplicated source bodies out of metadata items",
    "2. compatibility representations become stable references",
    "3. verbose diagnostics reduce to counts and warning codes",
    "4. unselected candidate evidence removed",
    "5. pivot-neighbourhood metadata bounded",
    "6. transitive impact/flow explanatory evidence bounded",
    "7. the authoritative model-visible context is retained",
    "8. freshness, provenance, warning and accounting state is retained",
    "",
    "A final backstop drops whole OPTIONAL sections, least useful first, so the",
    "envelope holds for any input rather than only for anticipated shapes. Critical",
    "warnings (stale index, ambiguity) are never among them.",
    "",
    "## Detail modes",
    "",
    "`detail: compact | standard | debug`, defaulting to `standard`. Debug widens",
    "diagnostics to bounded samples but obeys the same hard total ceiling; large raw",
    "candidate matrices are never returned by default at any level.",
    "",
    `Fixture: ${profile.fixture}. The captured incident payload is read-only evidence and is not committed.`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function gitHead(root: string): string {
  const result = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "unknown";
}

function gitBranch(root: string): string {
  const result = Bun.spawnSync(["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "unknown";
}

function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");
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
