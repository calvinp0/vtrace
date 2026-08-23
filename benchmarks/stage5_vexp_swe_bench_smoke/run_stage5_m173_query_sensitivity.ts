/**
 * M173-A — is the compact disclosure a property of the product, or of the query?
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_query_sensitivity.ts
 *
 * The positive control asked run_pipeline the raw SWE-bench problem statement
 * and got a valid compact orientation on eleven of twelve prepared workspaces.
 * The twelfth, matplotlib-22719, returned the FULL AUTHORITATIVE RESULT at
 * 26,075 characters — with no `detail` argument passed and on a healthy index
 * of 927 files and 15,700 symbols.
 *
 * That is not a leak and not a broken workspace. It is the shipped fallback:
 * `projectRunPipelineOrientation` declines on states it is not defined over,
 * including an empty delivery, and `orientation ?? authoritativeResult` then
 * hands the model the whole authoritative result. So the compact treatment has
 * an escape hatch, it opens when retrieval delivers nothing, and when it opens
 * the agent receives the payload M169 priced at $0.0985.
 *
 * This script separates the two explanations by asking each workspace the SAME
 * question in two shapes:
 *
 *   PROXY   the raw problem statement — what a preflight can know
 *   AGENT   the query M168's clean-arm agent actually authored for this task,
 *           lifted verbatim from its transcript — what the live agent's call
 *           will look like
 *
 * If a case is compact under AGENT and not under PROXY, the workspace is sound
 * and the preflight's query was the limitation. If a case is non-compact under
 * both, the fallback is a live risk for that task and is declared before the
 * money is spent rather than discovered in the results.
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Disclosure, classifyDisclosure } from "./m173Treatment";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");
const WORKSPACES = path.join(RESULTS, "workspaces");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");

const labelFor = (instanceId: string): string =>
  `m173_vtrace_compact_${instanceId.replace(/-/g, "_")}`;

// ── the two query shapes ────────────────────────────────────────────

const manifest = JSON.parse(
  readFileSync(path.join(RESULTS, "stage5_m173_manifest.json"), "utf8"),
) as { selected: { instanceId: string }[] };

const problemStatements = new Map<string, string>();
for (const line of readFileSync(DATASET, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const row = JSON.parse(line) as { instance_id: string; problem_statement?: string };
  if (typeof row.problem_statement === "string") problemStatements.set(row.instance_id, row.problem_statement);
}

/**
 * The first `run_pipeline` query M168's clean arm actually issued, read from
 * its own transcript. Not reconstructed, not paraphrased: the agent's bytes.
 */
function m168AgentQuery(instanceId: string): string | null {
  const label = `m168_vtrace_clean_${instanceId.replace(/-/g, "_")}`;
  const parent = path.join(RUNS, label, "raw");
  if (!existsSync(parent)) return null;
  for (const child of readdirSync(parent)) {
    const stream = path.join(parent, child, "_agent_stream.first_pass.jsonl");
    if (!existsSync(stream)) continue;
    for (const line of readFileSync(stream, "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (row.type !== "assistant") continue;
      const message = row.message as Record<string, unknown> | undefined;
      const blocks = (Array.isArray(message?.content) ? message?.content : []) as Record<string, unknown>[];
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        if (!String(block.name ?? "").includes("run_pipeline")) continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        const task = input.task ?? input.query;
        if (typeof task === "string" && task.trim() !== "") return task;
      }
    }
  }
  return null;
}

// ── the call ────────────────────────────────────────────────────────

interface Answer {
  readonly disclosure: Disclosure | null;
  readonly characters: number;
  readonly focusFile: string | null;
  readonly relatedCount: number | null;
  readonly deliveredItems: number | null;
}

async function ask(repoRoot: string, queries: readonly (string | null)[]): Promise<(Answer | null)[]> {
  const messages: unknown[] = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m173-qs", version: "1" } } },
  ];
  queries.forEach((query, index) => {
    if (query === null) return;
    messages.push({
      jsonrpc: "2.0", id: 100 + index, method: "tools/call",
      params: { name: "run_pipeline", arguments: { task: query, repo_root: repoRoot } },
    });
  });

  const frames = await new Promise<Map<number, Record<string, unknown>>>((resolve) => {
    const child = spawn(
      "bun",
      ["src/cli/index.ts", "mcp-serve", "--repo", repoRoot, "--tools", "run_pipeline,get_impact_graph"],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 900_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("close", () => {
      clearTimeout(timer);
      const byId = new Map<number, Record<string, unknown>>();
      for (const line of stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (typeof row.id === "number") byId.set(row.id, row);
        } catch { /* not a protocol frame */ }
      }
      resolve(byId);
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });

  return queries.map((query, index) => {
    if (query === null) return null;
    const structured = (frames.get(100 + index) as { result?: { structuredContent?: unknown } } | undefined)
      ?.result?.structuredContent;
    if (structured === undefined || structured === null) return null;
    const serialized = JSON.stringify(structured);
    const output = (structured as { result?: { output?: Record<string, any> } }).result?.output ?? {};
    return {
      disclosure: classifyDisclosure(serialized),
      characters: serialized.length,
      focusFile: typeof output?.focus?.file === "string" ? output.focus.file : null,
      relatedCount: Array.isArray(output?.related) ? output.related.length : null,
      deliveredItems: Array.isArray(output?.productContext?.items) ? output.productContext.items.length : null,
    };
  });
}

// ── main ────────────────────────────────────────────────────────────

const rows: Record<string, unknown>[] = [];

for (const [index, entry] of manifest.selected.entries()) {
  const instanceId = entry.instanceId;
  const workspace = path.join(WORKSPACES, labelFor(instanceId), instanceId);
  if (!existsSync(path.join(workspace, ".vtrace", "index.sqlite"))) {
    rows.push({ instanceId, error: "workspace not indexed" });
    continue;
  }
  const proxyQuery = problemStatements.get(instanceId) ?? null;
  const agentQuery = m168AgentQuery(instanceId);
  const [proxy, agent] = await ask(workspace, [proxyQuery, agentQuery]);

  const verdict = agent === null
    ? "AGENT_QUERY_UNAVAILABLE"
    : agent.disclosure === Disclosure.CompactOrientation
      ? (proxy?.disclosure === Disclosure.CompactOrientation ? "COMPACT_UNDER_BOTH" : "COMPACT_ONLY_UNDER_AGENT_QUERY")
      : "FALLBACK_UNDER_AGENT_QUERY";

  rows.push({
    instanceId,
    verdict,
    proxyQueryCharacters: proxyQuery?.length ?? null,
    agentQueryCharacters: agentQuery?.length ?? null,
    proxy,
    agent,
  });
  process.stdout.write(
    `[${index + 1}/${manifest.selected.length}] ${instanceId.padEnd(34)} ${verdict}`
    + `  proxy=${proxy?.characters ?? "-"}ch/${proxy?.disclosure ?? "-"}`
    + `  agent=${agent?.characters ?? "-"}ch/${agent?.disclosure ?? "-"}\n`,
  );
}

const tally = (verdict: string): number => rows.filter((r) => r.verdict === verdict).length;
const fallbackRisk = rows.filter((r) => r.verdict === "FALLBACK_UNDER_AGENT_QUERY").map((r) => r.instanceId);

const report = {
  schemaVersion: "stage5.m173.query-sensitivity.v1",
  milestone: "M173",
  workstream: "M173-A",
  finding:
    "the shipped default is compact only when the pipeline delivers. On an empty delivery "
    + "projectRunPipelineOrientation declines and the tool returns the full authoritative "
    + "result, which is the payload M169 priced at $0.0985. The compact treatment therefore "
    + "has an escape hatch, and M173 measures per run whether it opened.",
  queryShapes: {
    proxy: "the raw SWE-bench problem statement — what a preflight can know",
    agent: "the first run_pipeline query M168's clean arm authored, lifted verbatim from its transcript",
  },
  counts: {
    tasks: rows.length,
    compactUnderBoth: tally("COMPACT_UNDER_BOTH"),
    compactOnlyUnderAgentQuery: tally("COMPACT_ONLY_UNDER_AGENT_QUERY"),
    fallbackUnderAgentQuery: tally("FALLBACK_UNDER_AGENT_QUERY"),
    agentQueryUnavailable: tally("AGENT_QUERY_UNAVAILABLE"),
    errors: rows.filter((r) => r.error !== undefined).length,
  },
  declaredFallbackRiskBeforeSpend: fallbackRisk,
  limit:
    "the live agent authors a fresh query and will not reproduce M168's bytes. This measures "
    + "how the product behaves under an AGENT-SHAPED query, not a prediction of any run.",
  rows,
};

writeFileSync(path.join(RESULTS, "stage5_m173_query_sensitivity.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`\nquery sensitivity over ${rows.length} workspaces`);
console.log(`  compact under both query shapes        ${report.counts.compactUnderBoth}`);
console.log(`  compact only under the agent query     ${report.counts.compactOnlyUnderAgentQuery}`);
console.log(`  fell back even under the agent query   ${report.counts.fallbackUnderAgentQuery} ${fallbackRisk.join(", ")}`);
