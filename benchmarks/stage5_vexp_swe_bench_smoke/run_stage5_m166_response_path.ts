/**
 * M166-A — reconstruct every representation of one repository-context call.
 *
 * The server is spoken to as a real `mcp-serve` child process over stdio JSON-RPC,
 * against the preserved M163/M164 trigger-arm workspaces, so the transport figures
 * are the ones the live runtime saw rather than a hand-built approximation.
 *
 * Four representations are measured independently and never conflated:
 *
 *   INTERNAL            result.output as the handler produced it
 *   TRANSPORT_CONTENT   result.content[0].text  — JSON.stringify(output)
 *   TRANSPORT_STRUCTURED result.structuredContent — the whole tool envelope, output included
 *   MODEL_VISIBLE       the tool_result string the M164 transcript recorded
 *
 * Which of the two transport representations became MODEL_VISIBLE is decided from
 * the transcript, not from the MCP specification (§12).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DeliveredRepresentation, identifyDeliveredRepresentation, parseAgentStream } from "./m166Boundary";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const MANIFEST = path.join(RESULTS, "stage5_m163_manifest.json");
const CORPUS = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const WORKSPACES = path.join(RESULTS, "workspaces");
const RUNS = path.join(RESULTS, "runs");
/** Untracked payload capture, for M166-B/C to classify without re-spawning servers. */
const CAPTURE = path.join(RESULTS, "_m166_payloads");
const TRIGGER_ARM_PREFIX = "m163_tools_task_trigger_";
const M164_PREFIX = "m164_tools_task_trigger_";
const VISIBLE_TOOL_IDS = ["get_code_context", "get_impact_graph"] as const;

interface Case { readonly instanceId: string; readonly repo: string; readonly baseCommit: string }

function loadCases(): Case[] {
  return (JSON.parse(readFileSync(MANIFEST, "utf8")) as { cases: Case[] }).cases;
}

function loadProblemStatements(ids: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(CORPUS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { instance_id: string; problem_statement: string };
    if (ids.has(row.instance_id)) out.set(row.instance_id, row.problem_statement);
  }
  return out;
}

/** Repository index files only; session state may legitimately move on a read. */
function digestIndex(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const hash = createHash("sha256");
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.startsWith("index.")) continue;
    const full = path.join(dir, entry);
    hash.update(entry).update(String(statSync(full).size)).update(readFileSync(full));
  }
  return hash.digest("hex");
}

async function speak(repoRoot: string, messages: readonly unknown[]): Promise<Record<string, any>[]> {
  return await new Promise((resolve, reject) => {
    const child = spawn("bun", ["src/cli/index.ts", "mcp-serve", "--repo", repoRoot, "--tools", VISIBLE_TOOL_IDS.join(",")], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("mcp-serve timeout")); }, 300_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout.split("\n").filter((l) => l.trim().startsWith("{")).flatMap((l) => {
        try { return [JSON.parse(l) as Record<string, any>]; } catch { return []; }
      }));
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

/** The first VTRACE tool_result a real M164 run recorded, as the model received it. */
function modelVisibleResult(instanceId: string): { characters: number; head: string; text: string } | null {
  const dir = path.join(RUNS, M164_PREFIX + instanceId.replace(/[^A-Za-z0-9]/g, "_"), "raw/vtrace");
  for (const name of ["_agent_stream.first_pass.jsonl", "_agent_stream.jsonl"]) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
    const turns = parseAgentStream(lines);
    const target = turns.find((t) => t.kind === "toolResult" && t.head.includes('"vtrace.mcp_server"'));
    if (target === undefined || target.kind !== "toolResult") return null;
    // Recover the full string, which parseAgentStream deliberately does not retain.
    for (const line of lines) {
      let row: Record<string, any>;
      try { row = JSON.parse(line) as Record<string, any>; } catch { continue; }
      if (row.type !== "user") continue;
      for (const block of (row.message?.content ?? []) as Record<string, any>[]) {
        if (block?.type !== "tool_result") continue;
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        if (text.includes('"vtrace.mcp_server"')) return { characters: text.length, head: text.slice(0, 200), text };
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  mkdirSync(CAPTURE, { recursive: true });
  const cases = loadCases();
  const statements = loadProblemStatements(new Set(cases.map((c) => c.instanceId)));
  const rows: Record<string, unknown>[] = [];
  let indexWrites = 0;

  for (const testCase of cases) {
    const outer = path.join(WORKSPACES, TRIGGER_ARM_PREFIX + testCase.instanceId.replace(/[^A-Za-z0-9]/g, "_"));
    if (!existsSync(outer)) { rows.push({ instanceId: testCase.instanceId, error: "workspace_missing" }); continue; }
    const inner = readdirSync(outer).filter((e) => statSync(path.join(outer, e)).isDirectory());
    const repoRoot = path.join(outer, inner[0]!);
    const task = statements.get(testCase.instanceId) ?? "";

    const before = digestIndex(path.join(repoRoot, ".vtrace"));
    const responses = await speak(repoRoot, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m166", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_code_context", arguments: { task, repo_root: repoRoot } } },
    ]);
    const after = digestIndex(path.join(repoRoot, ".vtrace"));
    if (before !== after) indexWrites += 1;

    const call = responses.find((r) => r.id === 3);
    const result = call?.result ?? {};
    const contentText: string = result?.content?.[0]?.text ?? "";
    const structuredText = JSON.stringify(result?.structuredContent ?? null);
    const wholeJsonRpcLine = JSON.stringify(call ?? null);
    let output: unknown = null;
    try { output = JSON.parse(contentText); } catch { output = null; }

    const observed = modelVisibleResult(testCase.instanceId);
    const delivered = observed === null
      ? DeliveredRepresentation.Undetermined
      : identifyDeliveredRepresentation({ modelVisibleHead: observed.head, contentTextHead: contentText.slice(0, 200), structuredContentHead: structuredText.slice(0, 200) });

    // Capture for M166-B/C. Untracked; §7 forbids staging transport captures.
    writeFileSync(path.join(CAPTURE, `${testCase.instanceId}.structured.json`), structuredText);
    if (observed !== null) writeFileSync(path.join(CAPTURE, `${testCase.instanceId}.modelvisible.json`), observed.text);

    const toolsList = (responses.find((r) => r.id === 2)?.result?.tools ?? []) as Record<string, any>[];
    rows.push({
      instanceId: testCase.instanceId,
      repoRoot,
      taskCharacters: task.length,
      representations: {
        internalOutputCharacters: output === null ? null : JSON.stringify(output).length,
        transportContentTextCharacters: contentText.length,
        transportStructuredContentCharacters: structuredText.length,
        transportJsonRpcLineCharacters: wholeJsonRpcLine.length,
        modelVisibleCharacters: observed?.characters ?? null,
      },
      /** The same payload crosses the wire twice: once as text, once as structure. */
      transportDuplicationFactor: contentText.length === 0 ? null : Number((structuredText.length / contentText.length).toFixed(3)),
      deliveredRepresentation: delivered,
      modelVisibleMatchesStructuredContentExactly: observed !== null && observed.text.length === structuredText.length,
      toolsListCharacters: JSON.stringify(toolsList).length,
      toolsListedCount: toolsList.length,
    });
    console.error(`[m166-A] ${testCase.instanceId}: content=${contentText.length} structured=${structuredText.length} modelVisible=${observed?.characters ?? "n/a"} delivered=${delivered}`);
  }

  const measured = rows.filter((r) => r.representations !== undefined);
  const deliveredValues = new Set(measured.map((r) => r.deliveredRepresentation));

  writeFileSync(path.join(RESULTS, "stage5_m166_response_path.json"), JSON.stringify({
    schemaVersion: 1,
    milestone: "M166",
    workstream: "A",
    title: "Every representation of one get_code_context call, measured independently",
    callPath: [
      { stage: "task/query", producer: "agent tool call arguments { task, repo_root }", representation: "JSON-RPC params" },
      { stage: "tool dispatch", producer: "src/mcp/startServer.ts tools/call branch", representation: "McpToolRequest" },
      { stage: "get_code_context handler", producer: "src/mcp/tools.ts", representation: "index-freshness gate, then RUN_PIPELINE_TOOL_DEFINITION.handler verbatim (M165)" },
      { stage: "run_pipeline handler", producer: "src/mcp/tools.ts", representation: "internal structured result object" },
      { stage: "response envelope", producer: "src/mcp/responseEnvelope.ts", representation: "bounded/compacted result.output + responseBudget accounting" },
      { stage: "MCP serialization", producer: "src/mcp/startServer.ts", representation: "content[0].text = JSON.stringify(output) AND structuredContent = whole tool envelope" },
      { stage: "Claude Code runtime", producer: "MCP client", representation: "one tool_result content string" },
      { stage: "model request", producer: "provider", representation: "cached input tokens" },
      { stage: "accounting", producer: "provider usage", representation: "cache_creation / cache_read" },
    ],
    transport: { mode: "real mcp-serve child process over stdio JSON-RPC", handBuiltFixture: false },
    indexWrites,
    deliveredRepresentation: {
      values: [...deliveredValues],
      unanimous: deliveredValues.size === 1,
      reading: deliveredValues.size === 1 && deliveredValues.has(DeliveredRepresentation.StructuredContent)
        ? "the runtime handed the model structuredContent — the whole tool envelope — not content[0].text"
        : "mixed or undetermined; see per-case rows",
    },
    cases: rows,
  }, null, 1));

  writeFileSync(path.join(RESULTS, "stage5_m166_mcp_content_semantics.json"), JSON.stringify({
    schemaVersion: 1,
    milestone: "M166",
    workstream: "A",
    title: "What VTRACE returns over MCP, and which part the client gives the model",
    serverReturns: {
      content: { present: true, shape: "[{ type: 'text', text: JSON.stringify(result.ok ? result.output : result.error) }]", source: "src/mcp/startServer.ts" },
      structuredContent: { present: true, shape: "the entire McpToolResponse — schema, requestId, toolId, result.ok AND result.output", source: "src/mcp/startServer.ts" },
      metadata: { present: false, note: "no separate _meta channel is populated" },
      annotations: { present: false },
      isError: { present: true, shape: "boolean" },
    },
    duplicationOnTheWire: {
      statement: "result.output is serialized twice per response: once inside content[0].text and once inside structuredContent",
      medianContentCharacters: median(measured.map((r) => (r.representations as any).transportContentTextCharacters)),
      medianStructuredCharacters: median(measured.map((r) => (r.representations as any).transportStructuredContentCharacters)),
      medianJsonRpcLineCharacters: median(measured.map((r) => (r.representations as any).transportJsonRpcLineCharacters)),
    },
    clientBehaviour: {
      determinedFrom: "M164 stream-json transcripts, not the MCP specification",
      delivered: [...deliveredValues],
      consequence: deliveredValues.has(DeliveredRepresentation.StructuredContent)
        ? "the model pays for the envelope wrapper (schema, requestId, toolId, result.ok) on top of the output"
        : "the model pays for output only",
    },
    cases: measured.map((r) => ({
      instanceId: r.instanceId,
      delivered: r.deliveredRepresentation,
      contentCharacters: (r.representations as any).transportContentTextCharacters,
      structuredCharacters: (r.representations as any).transportStructuredContentCharacters,
      modelVisibleCharacters: (r.representations as any).modelVisibleCharacters,
    })),
  }, null, 1));

  console.error(`[m166-A] indexWrites=${indexWrites}; delivered=${[...deliveredValues].join(",")}`);
}

function median(values: readonly (number | null)[]): number | null {
  const clean = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 1 ? clean[mid]! : Math.round((clean[mid - 1]! + clean[mid]!) / 2);
}

await main();
