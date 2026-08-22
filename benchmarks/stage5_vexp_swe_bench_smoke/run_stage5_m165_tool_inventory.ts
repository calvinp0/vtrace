/**
 * M165-A — Mechanical reconstruction of the authoritative VTRACE tool surface.
 *
 * The milestone brief reported "approximately 14 tools" and instructed that the
 * number not be trusted blindly. This script reconstructs the surface from the
 * registry itself rather than from documentation, and records the four levels
 * M162-M164 proved must be kept apart (§9):
 *
 *   IMPLEMENTED != REGISTERED != EXPOSED != COMPOSED-INTO-THE-FIRST-CALL
 *
 * The `pipelineComposition` field is source-verified, not inferred: it records
 * whether run_pipeline's own code path reaches that tool's PRODUCER (not the MCP
 * tool), per §38's preference for internal composition over recursive MCP calls.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  defaultMcpToolRegistry,
  RESERVED_MCP_TOOL_DEFINITIONS,
  LEGACY_MCP_TOOL_DEFINITIONS,
} from "../../src/mcp/tools";
import { McpToolId } from "../../src/mcp/types";

const OUT = path.join(path.resolve("."), "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m165_tool_inventory.json");

/**
 * Producer reached by run_pipeline's own code path, verified by reading
 * runPipelineOrchestrator.ts's import list and productContext/assembleProductContext.ts.
 * `via` names WHERE the composition happens, because two different lanes deliver
 * impact and only one of them is intent-gated.
 */
const COMPOSITION: Record<string, { composed: boolean; producer: string; via: string | null; note: string }> = {
  get_code_context: { composed: true, producer: "runPipelineOrchestrator", via: "IS the pipeline", note: "delegates to run_pipeline's handler verbatim after a freshness gate" },
  run_pipeline: { composed: true, producer: "runPipelineOrchestrator", via: "IS the pipeline", note: "the authoritative composed investigation" },
  get_impact_graph: { composed: true, producer: "impact/getImpactGraph", via: "orchestrator impact section + productContext addImpactEvidence", note: "TWO lanes: the intent-gated impact section, and ungated bounded impact items in productContext" },
  get_skeleton: { composed: true, producer: "skeleton/getSkeleton", via: "productContext renderStructuralSkeleton", note: "structural support rendered as item content, not a separate section" },
  search_logic_flow: { composed: true, producer: "logicFlow/searchLogicFlow", via: "orchestrator flow section", note: "conditional on resolvable endpoints (§28)" },
  search_memory: { composed: true, producer: "observations/searchMemory", via: "orchestrator durable memory section", note: "intent-weighted" },
  get_session_context: { composed: true, producer: "observations/getSessionContext", via: "orchestrator session memory section", note: "requires an explicit sessionId" },
  route_query: { composed: true, producer: "intent/routeQuery", via: "orchestrator context section", note: "query routing feeds retrieval" },
  search_symbols: { composed: true, producer: "retrieval/searchSymbolsShared", via: "orchestrator context section", note: "shared retrieval producer; tool itself hidden by default" },
  get_context_capsule: { composed: true, producer: "capsuleV2/authoritativeProductRetrieval", via: "orchestrator capsuleV2", note: "same authoritative capsule, projected differently" },
  build_capsule: { composed: false, producer: "capsule/runIntentAwareCapsulePipeline", via: null, note: "legacy v1 capsule path; superseded by capsuleV2" },
  expand_vexp_ref: { composed: true, producer: "runPipeline/expandDeferredVexpRef", via: "orchestrator deferred placeholders", note: "pipeline EMITS the refs this tool expands" },
  check_capsule_staleness: { composed: false, producer: "db/indexRunsRepository", via: null, note: "lifecycle verification, not first-call evidence" },
  index_repo: { composed: false, producer: "runtime/initRepo+reindexRepo", via: null, note: "write path; deliberately not inside a read call" },
  index_status: { composed: false, producer: "indexer/inspectIndexStatus", via: null, note: "readiness reporting; get_code_context runs its own freshness gate" },
  workspace_setup: { composed: false, producer: "workspace/inspectProductShellStatus", via: null, note: "multi-repo lifecycle (§29)" },
  save_observation: { composed: false, producer: "observations/saveObservation", via: null, note: "write path; opt-in only via saveObservation input (§61)" },
  build_handoff: { composed: false, producer: "handoff", via: null, note: "session handoff artifact, not first-call evidence" },
  list_runs: { composed: false, producer: "db/listIndexRuns", via: null, note: "diagnostics" },
  list_sessions: { composed: false, producer: "session store", via: null, note: "diagnostics" },
  read_session: { composed: false, producer: "session store", via: null, note: "diagnostics" },
};

function schemaTokens(metadata: any): number {
  return Math.ceil(JSON.stringify({
    name: metadata.toolId,
    description: metadata.description,
    inputSchema: metadata.inputSchema,
  }).length / 4);
}

const visible = new Set(defaultMcpToolRegistry.listMetadata().map((m) => m.toolId));
const reservedIds = new Set(RESERVED_MCP_TOOL_DEFINITIONS.map((t) => t.metadata.toolId));
const legacyIds = new Set(LEGACY_MCP_TOOL_DEFINITIONS.map((t) => t.metadata.toolId));

const tools = defaultMcpToolRegistry.tools.map((tool) => {
  const id = tool.metadata.toolId;
  const composition = COMPOSITION[id] ?? { composed: false, producer: "UNKNOWN", via: null, note: "unclassified" };
  return {
    toolId: id,
    displayName: tool.metadata.displayName,
    implemented: true,
    registered: tool.metadata.registration.registered,
    availability: tool.metadata.registration.availability,
    handlerKind: tool.metadata.registration.handlerKind,
    defaultVisible: visible.has(id),
    surface: reservedIds.has(id) ? (legacyIds.has(id) ? "reserved+legacy" : "reserved") : "legacy",
    approxSchemaTokens: schemaTokens(tool.metadata),
    coreProducer: composition.producer,
    composedIntoFirstCall: composition.composed,
    composedVia: composition.via,
    note: composition.note,
  };
});

const m164Visible = ["get_code_context", "get_impact_graph"];

const payload = {
  schemaVersion: 1,
  milestone: "M165",
  workstream: "A",
  title: "Authoritative VTRACE tool surface",
  method: "reconstructed from defaultMcpToolRegistry at HEAD, not from documentation",
  levels: {
    implemented: tools.length,
    registered: tools.filter((t) => t.registered).length,
    defaultVisible: tools.filter((t) => t.defaultVisible).length,
    hiddenButRegistered: tools.filter((t) => !t.defaultVisible).length,
    m164Visible: m164Visible.length,
    placeholders: tools.filter((t) => t.availability !== "wired").length,
  },
  reportedFourteen: {
    claim: "approximately 14 tools",
    verdict: "CONFIRMED for the default-visible surface, INCOMPLETE as a total",
    defaultVisible: tools.filter((t) => t.defaultVisible).map((t) => t.toolId),
    hidden: tools.filter((t) => !t.defaultVisible).map((t) => t.toolId),
  },
  m164LiveSurface: {
    visibleTools: m164Visible,
    reconstructedFrom: "stage5_m164_sweep_shaped_smoke.json visibleTools + FROZEN_CALLABLE_TOOL_IDS",
    gapExplanation: "the sweep passes --tools to restrict the MODEL-VISIBLE surface; unlisted tools stay registered but hidden, so 19 registered tools were unreachable by name and 12 default-visible ones were not offered",
  },
  schemaTax: {
    m164TwoTools: tools.filter((t) => m164Visible.includes(t.toolId)).reduce((sum, t) => sum + t.approxSchemaTokens, 0),
    plusRunPipeline: tools.filter((t) => [...m164Visible, "run_pipeline"].includes(t.toolId)).reduce((sum, t) => sum + t.approxSchemaTokens, 0),
    fullDefaultSurface: tools.filter((t) => t.defaultVisible).reduce((sum, t) => sum + t.approxSchemaTokens, 0),
  },
  composition: {
    composedIntoFirstCall: tools.filter((t) => t.composedIntoFirstCall).map((t) => t.toolId),
    notComposed: tools.filter((t) => !t.composedIntoFirstCall).map((t) => t.toolId),
    method: "source-verified against runPipelineOrchestrator.ts imports and productContext/assembleProductContext.ts",
  },
  tools,
};

writeFileSync(OUT, JSON.stringify(payload, null, 1));
console.error(`[m165] wrote ${OUT}`);
console.error(`[m165] implemented=${payload.levels.implemented} registered=${payload.levels.registered} defaultVisible=${payload.levels.defaultVisible} m164Visible=${payload.levels.m164Visible} placeholders=${payload.levels.placeholders}`);
console.error(`[m165] composed=${payload.composition.composedIntoFirstCall.length} notComposed=${payload.composition.notComposed.length}`);
