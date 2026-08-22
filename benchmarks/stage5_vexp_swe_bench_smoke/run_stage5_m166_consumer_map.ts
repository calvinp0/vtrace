/**
 * M166-B — who actually needs each field group.
 *
 * §26: a field can be necessary to machines and unnecessary to the LLM, and that
 * distinction is the whole architectural question M166 is testing. Every consumer
 * claim below names the file that proves it; a group with no proven non-model
 * consumer is marked so rather than assumed to have one.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

/** Files that only produce or type a field do not count as consumers of it. */
const PRODUCERS = [/^src\/mcp\/responseEnvelope\.ts$/, /^src\/mcp\/tools\.ts$/, /^src\/productContext\/types\.ts$/, /^src\/runPipeline\//];

function consumersOf(token: string): { tests: string[]; product: string[]; benchmarks: string[]; producers: string[] } {
  let hits: string[] = [];
  try {
    hits = execFileSync("grep", ["-rl", "--include=*.ts", token, "src", "benchmarks"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").filter((line) => line.trim().length > 0);
  } catch { hits = []; }
  const out = { tests: [] as string[], product: [] as string[], benchmarks: [] as string[], producers: [] as string[] };
  for (const hit of hits) {
    if (hit.includes("m166")) continue; // this milestone's own analysis is not a consumer
    if (hit.endsWith(".test.ts")) { out.tests.push(hit); continue; }
    if (hit.startsWith("benchmarks/")) { out.benchmarks.push(hit); continue; }
    if (PRODUCERS.some((pattern) => pattern.test(hit))) { out.producers.push(hit); continue; }
    out.product.push(hit);
  }
  return out;
}

interface GroupSpec {
  readonly group: string;
  readonly token: string;
  readonly category: string;
  readonly agentNeedsIt: "YES" | "PARTIAL" | "NO";
  readonly why: string;
}

const GROUPS: readonly GroupSpec[] = [
  { group: "productContext.modelVisibleContext", token: "modelVisibleContext", category: "REPOSITORY_EVIDENCE", agentNeedsIt: "YES", why: "the rendered evidence; the only span written to be read" },
  { group: "productContext.items[]", token: "productContext.items", category: "REPOSITORY_EVIDENCE (largely restated)", agentNeedsIt: "PARTIAL", why: "structured twin of the rendering; machine consumers address items by id" },
  { group: "capsuleResult.digest", token: "capsuleResult.digest", category: "REPOSITORY_EVIDENCE (second rendering)", agentNeedsIt: "NO", why: "a third rendering of facts already in the canonical one, in a different notation" },
  { group: "diagnostics.retrieval", token: "diagnostics.retrieval", category: "MACHINE_DIAGNOSTIC", agentNeedsIt: "NO", why: "lane candidate file lists and scorer internals; nothing the agent can act on" },
  { group: "diagnostics.indexFreshness", token: "indexFreshness", category: "AGENT_USEFUL_CONTROL + PROVENANCE", agentNeedsIt: "PARTIAL", why: "readiness truth matters; the full snapshot/fingerprint detail does not" },
  { group: "productContext.freshness.refreshDiagnostics", token: "refreshDiagnostics", category: "DUPLICATE", agentNeedsIt: "NO", why: "byte-identical twin of diagnostics.indexFreshness in the same response" },
  { group: "responseBudget", token: "responseBudget", category: "MACHINE_DIAGNOSTIC + AGENT_USEFUL_CONTROL", agentNeedsIt: "PARTIAL", why: "what was omitted is material; the accounting arithmetic is not" },
  { group: "productContext.accounting", token: "productContext.accounting", category: "MACHINE_DIAGNOSTIC", agentNeedsIt: "NO", why: "savings arithmetic against a naive full-file baseline" },
  { group: "productContext.timing", token: "productContext.timing", category: "MACHINE_DIAGNOSTIC", agentNeedsIt: "NO", why: "per-stage milliseconds" },
  { group: "workspaceRouting", token: "workspaceRouting", category: "MACHINE_DIAGNOSTIC + AGENT_USEFUL_CONTROL", agentNeedsIt: "PARTIAL", why: "the routing outcome can matter; the probe coverage counters do not" },
  { group: "taskSummary", token: "taskSummary", category: "MACHINE_DIAGNOSTIC", agentNeedsIt: "NO", why: "the normalized form of the query the agent just wrote" },
  { group: "request", token: "\"request\"", category: "MACHINE_DIAGNOSTIC", agentNeedsIt: "NO", why: "echo of the call arguments" },
  { group: "pivotNeighborhood", token: "pivotNeighborhood", category: "REPOSITORY_EVIDENCE", agentNeedsIt: "YES", why: "bounded structural neighbourhood excerpts" },
  { group: "inspectFirst", token: "inspectFirst", category: "REPOSITORY_EVIDENCE", agentNeedsIt: "YES", why: "where to look first, and why" },
  { group: "deferred", token: "\"deferred\"", category: "AGENT_USEFUL_CONTROL", agentNeedsIt: "PARTIAL", why: "what was held back and how to ask for it" },
  { group: "runtime", token: "retrievalRankingVersion", category: "PROVENANCE", agentNeedsIt: "NO", why: "implementation and ranking versions; an analyzer concern" },
  { group: "savedObservation", token: "savedObservation", category: "MACHINE_DIAGNOSTIC", agentNeedsIt: "NO", why: "null on every one of the twelve" },
];

const rows = GROUPS.map((spec) => {
  const consumers = consumersOf(spec.token);
  const hasMachineConsumer = consumers.product.length > 0 || consumers.benchmarks.length > 0;
  return {
    ...spec,
    consumers: {
      agentOrModel: spec.agentNeedsIt !== "NO",
      productCode: consumers.product,
      benchmarkAnalyzers: consumers.benchmarks.slice(0, 6),
      benchmarkAnalyzerCount: consumers.benchmarks.length,
      tests: consumers.tests.slice(0, 6),
      testCount: consumers.tests.length,
      producersOnly: consumers.producers,
    },
    /** §35. Required by machines, unnecessary to the LLM: the separation candidate. */
    classification: spec.agentNeedsIt === "NO" && hasMachineConsumer
      ? "MACHINE_REQUIRED_MODEL_UNNECESSARY"
      : spec.agentNeedsIt === "NO"
        ? "NO_PROVEN_CONSUMER_OF_EITHER_KIND"
        : spec.agentNeedsIt === "PARTIAL"
          ? "SPLIT — part is agent-facing truth, part is machine bookkeeping"
          : "MODEL_REQUIRED",
  };
});

const payload = {
  schemaVersion: 1,
  milestone: "M166",
  workstream: "B",
  title: "Consumer map — who needs each model-facing field group",
  method: "grep over src/ and benchmarks/ for each group's identifying token; producers and this milestone's own analysis excluded",
  standingArchitecturalFact: {
    cliEmitsWholeStructuredResult: "src/cli/commands/runPipelineCommand.ts returns JSON.stringify of the assembled result — a programmatic consumer of the complete object",
    mcpReturnsBothRepresentations: "src/mcp/startServer.ts populates content[0].text AND structuredContent with the same payload",
    outputSchemaNotAdvertised: "src/mcp/startServer.ts formatListedToolDescriptor emits name, description and inputSchema only",
    consequence: "a compact model-facing rendering cannot be delivered by shrinking content[0].text alone, because this client reads structuredContent",
  },
  groups: rows,
  summary: {
    modelRequired: rows.filter((r) => r.classification === "MODEL_REQUIRED").map((r) => r.group),
    machineRequiredModelUnnecessary: rows.filter((r) => r.classification === "MACHINE_REQUIRED_MODEL_UNNECESSARY").map((r) => r.group),
    split: rows.filter((r) => r.classification.startsWith("SPLIT")).map((r) => r.group),
    noProvenConsumer: rows.filter((r) => r.classification === "NO_PROVEN_CONSUMER_OF_EITHER_KIND").map((r) => r.group),
  },
};

writeFileSync(path.join(RESULTS, "stage5_m166_consumer_map.json"), JSON.stringify(payload, null, 1));
console.error(`[m166-B] consumer map: ${payload.summary.modelRequired.length} model-required, ${payload.summary.machineRequiredModelUnnecessary.length} machine-only, ${payload.summary.split.length} split, ${payload.summary.noProvenConsumer.length} unconsumed`);
