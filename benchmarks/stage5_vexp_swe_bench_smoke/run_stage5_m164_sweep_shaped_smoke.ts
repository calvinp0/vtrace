/**
 * M164-B — the sweep-shaped evidence-delivery smoke. Offline, no live agent, no spend.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m164_sweep_shaped_smoke.ts [--tasks n]
 *
 * WHY THIS FILE EXISTS AND WHY IT IS SHAPED THE WAY IT IS
 * ------------------------------------------------------
 * M163's gates passed on workspaces prepared with `vtrace init` + `vtrace index`
 * while its sweep prepared workspaces with `vtrace index` alone. The controls
 * proved the runtime end to end and could not have caught the seam they depended
 * on, because they never ran against a workspace shaped like the ones under test.
 * That is now a standing rule:
 *
 *   A positive control only validates an experimental path if it reproduces the
 *   subject's relevant preparation and state shape. Runtime similarity alone is
 *   not enough.
 *
 * So this control takes the SUBJECT WORKSPACES THEMSELVES — the trees the M163
 * trigger arm actually ran against, still on disk under results/workspaces/ —
 * restores each to its base commit, and re-prepares it with the runner's own
 * `buildVtraceIndexCommand`. No fixture is hand-built and no `init` is smuggled
 * in: the shape under test is asserted to have an index and NO lifecycle files,
 * which is precisely the shape that refused twelve times.
 *
 * It then speaks to a REAL `mcp-serve` child process started from the sweep's own
 * `buildVtraceMcpConfig` args, over stdio, and issues the call the trigger
 * mandates. What it proves is delivery — a call reaching the product and coming
 * back carrying repository evidence — up to but not including an agent choosing
 * to make it. The agent half needs a live run and is deliberately NOT done here.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildVtraceMcpConfig, FROZEN_CALLABLE_TOOL_IDS, mcpToolName } from "./m162Callable";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const OUT = path.join(RESULTS, "stage5_m164_sweep_shaped_smoke.json");
const MANIFEST = path.join(RESULTS, "stage5_m163_manifest.json");
const CORPUS = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const WORKSPACES = path.join(RESULTS, "workspaces");
const TRIGGER_ARM_PREFIX = "m163_tools_task_trigger_";

/**
 * The evidence-delivery state machine (§33). Exactly one applies to a call, and
 * `evidenceDelivered` is true for exactly one of them. M163's mistake was letting
 * refusal text count as a response worth classifying for quality; keeping these
 * apart at the source is what stops that recurring.
 */
type CallStatus =
  | "CALL_NOT_MADE"
  | "INVALID_REQUEST"
  | "TOOLS_UNAVAILABLE"
  | "REPO_NOT_READY"
  | "TOOL_ERROR"
  | "VALID_EMPTY"
  | "VALID_NONEMPTY";

interface JsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
}

function sh(command: string, args: readonly string[], cwd: string = ROOT): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(command, [...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Drive a real stdio MCP server process through initialize -> tools/list -> tools/call. */
async function speakToMcpServer(
  command: string,
  args: readonly string[],
  messages: readonly JsonRpcMessage[],
): Promise<{ responses: Record<string, any>[]; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("mcp-serve did not answer within 180s"));
    }, 180_000);

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => {
      clearTimeout(timer);
      const responses = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .flatMap((line) => {
          try { return [JSON.parse(line) as Record<string, any>]; } catch { return []; }
        });
      resolve({ responses, stderr });
    });

    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

function digestDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const hash = createHash("sha256");
  for (const entry of readdirSync(dir).sort()) {
    // Session state is allowed to move on a read (leases, WAL); repository
    // evidence is not. Only the latter enters the digest.
    if (!entry.startsWith("index.")) continue;
    const full = path.join(dir, entry);
    hash.update(entry).update(String(statSync(full).size)).update(readFileSync(full));
  }
  return hash.digest("hex");
}

interface Case {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
}

function loadCases(): Case[] {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { cases: Case[] };
  return manifest.cases;
}

function loadProblemStatements(ids: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(CORPUS, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as { instance_id?: string; problem_statement?: string };
    if (row.instance_id !== undefined && ids.has(row.instance_id) && row.problem_statement !== undefined) {
      out.set(row.instance_id, row.problem_statement);
    }
  }
  return out;
}

/** Locate the tree the M163 trigger arm actually ran against. */
function subjectWorkspace(instanceId: string): string | null {
  const armDir = path.join(WORKSPACES, `${TRIGGER_ARM_PREFIX}${instanceId.replace(/-/g, "_").replace(/__/g, "__")}`);
  const candidates = existsSync(armDir) ? [armDir] : readdirSync(WORKSPACES)
    .filter((name) => name.startsWith(TRIGGER_ARM_PREFIX))
    .map((name) => path.join(WORKSPACES, name))
    .filter((dir) => existsSync(path.join(dir, instanceId)));
  for (const candidate of candidates) {
    const inner = path.join(candidate, instanceId);
    if (existsSync(inner)) return inner;
  }
  return null;
}

interface SmokeResult {
  readonly instanceId: string;
  readonly workspace: string | null;
  readonly prepared: boolean;
  readonly preparation: string;
  readonly vtraceFiles: readonly string[];
  readonly shapeIsIndexOnly: boolean;
  readonly serverConnected: boolean;
  readonly visibleTools: readonly string[];
  readonly toolInventoryCorrect: boolean;
  readonly queryChars: number;
  readonly callStatus: CallStatus;
  readonly evidenceDelivered: boolean;
  readonly evidenceItems: number;
  readonly evidenceCharacters: number;
  readonly refusalCharacters: number;
  readonly indexWrites: number;
  readonly detail: string;
}

async function runCase(instance: Case, problemStatement: string): Promise<SmokeResult> {
  const empty = {
    instanceId: instance.instanceId,
    workspace: null,
    prepared: false,
    preparation: "",
    vtraceFiles: [] as string[],
    shapeIsIndexOnly: false,
    serverConnected: false,
    visibleTools: [] as string[],
    toolInventoryCorrect: false,
    queryChars: 0,
    callStatus: "CALL_NOT_MADE" as CallStatus,
    evidenceDelivered: false,
    evidenceItems: 0,
    evidenceCharacters: 0,
    refusalCharacters: 0,
    indexWrites: 0,
  };

  const workspace = subjectWorkspace(instance.instanceId);
  if (workspace === null) {
    return { ...empty, detail: "the M163 trigger-arm workspace is no longer on disk" };
  }

  // Restore the tree the sweep started from. The agent edited these during M163,
  // so without this the index would be legitimately stale and the control would
  // measure the wrong refusal.
  const clean = sh("git", ["-C", workspace, "checkout", "--force", instance.baseCommit]);
  const reset = sh("git", ["-C", workspace, "clean", "-fdx", "-e", ".vtrace"]);
  if (clean.code !== 0) {
    return { ...empty, workspace, detail: `git checkout failed: ${clean.stderr.trim().slice(0, 200)}` };
  }

  // THE PREPARATION UNDER TEST. The runner's own index step, nothing else. No
  // `vtrace init`, because the sweep does not run one.
  const preparation = `bun src/cli/index.ts index ${workspace}`;
  const indexed = sh("bun", ["src/cli/index.ts", "index", workspace, "--quiet"]);
  if (indexed.code !== 0) {
    return { ...empty, workspace, preparation, detail: `vtrace index failed: ${indexed.stderr.trim().slice(0, 200)}` };
  }

  const vtraceDir = path.join(workspace, ".vtrace");
  const vtraceFiles = readdirSync(vtraceDir).sort();
  // The subject shape, asserted rather than assumed: an index, and no lifecycle
  // record. If this ever goes false the control has stopped testing the sweep.
  const shapeIsIndexOnly = vtraceFiles.includes("index.sqlite")
    && !vtraceFiles.includes("config.json")
    && !vtraceFiles.includes("state.json");

  const before = digestDir(vtraceDir);

  const mcpConfig = buildVtraceMcpConfig({
    runtime: "bun",
    cliEntry: "src/cli/index.ts",
    repoRoot: workspace,
  });
  const server = mcpConfig.mcpServers["vtrace"]!;
  const toolName = mcpToolName("get_code_context");

  // The query the frozen trigger produces: this task's description.
  const query = problemStatement.trim();
  const { responses, stderr } = await speakToMcpServer(server.command, server.args, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m164-smoke", version: "1.0.0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_code_context", arguments: { query } } },
  ]);

  const after = digestDir(vtraceDir);
  const initialize = responses.find((r) => r["id"] === 1);
  const listed = responses.find((r) => r["id"] === 2);
  const called = responses.find((r) => r["id"] === 3);

  const visibleTools: string[] = (listed?.["result"]?.tools ?? []).map((tool: { name: string }) => tool.name);
  const toolInventoryCorrect = visibleTools.length === FROZEN_CALLABLE_TOOL_IDS.length
    && FROZEN_CALLABLE_TOOL_IDS.every((id) => visibleTools.includes(id));

  const text: string = (called?.["result"]?.content ?? [])
    .filter((part: { type?: string }) => part.type === "text")
    .map((part: { text?: string }) => part.text ?? "")
    .join("\n");

  let callStatus: CallStatus = "CALL_NOT_MADE";
  let evidenceItems = 0;
  let evidenceCharacters = 0;
  let refusalCharacters = 0;

  if (initialize === undefined) {
    callStatus = "TOOLS_UNAVAILABLE";
  } else if (called === undefined) {
    callStatus = "CALL_NOT_MADE";
  } else if (called["error"] !== undefined) {
    callStatus = "TOOL_ERROR";
    refusalCharacters = JSON.stringify(called["error"]).length;
  } else if (/invalid_request|non-empty string/i.test(text)) {
    callStatus = "INVALID_REQUEST";
    refusalCharacters = text.length;
  } else if (/repo_not_ready|is not ready|not initialized/i.test(text)) {
    callStatus = "REPO_NOT_READY";
    refusalCharacters = text.length;
  } else {
    // Repository evidence means named source locations came back, not merely
    // that the envelope parsed. Path-shaped lines are counted; prose is not.
    const paths = new Set(
      [...text.matchAll(/(?:^|[\s"'`(])((?:[\w.\-]+\/)+[\w.\-]+\.(?:py|ts|tsx|js|rs|go|java|c|cc|cpp|h))/gm)]
        .map((match) => match[1]!),
    );
    evidenceItems = paths.size;
    if (evidenceItems > 0) {
      callStatus = "VALID_NONEMPTY";
      evidenceCharacters = text.length;
    } else {
      callStatus = "VALID_EMPTY";
    }
  }

  return {
    instanceId: instance.instanceId,
    workspace,
    prepared: true,
    preparation,
    vtraceFiles,
    shapeIsIndexOnly,
    serverConnected: initialize !== undefined,
    visibleTools,
    toolInventoryCorrect,
    queryChars: query.length,
    callStatus,
    evidenceDelivered: callStatus === "VALID_NONEMPTY",
    evidenceItems,
    evidenceCharacters,
    refusalCharacters,
    indexWrites: before !== null && after !== null && before !== after ? 1 : 0,
    detail: callStatus === "VALID_NONEMPTY"
      ? `${evidenceItems} distinct source paths returned (${toolName}, ${reset.code === 0 ? "clean tree" : "tree reset warned"})`
      : `${text.slice(0, 220)}${stderr.trim().length === 0 ? "" : ` | stderr: ${stderr.trim().slice(0, 160)}`}`,
  };
}

async function main(): Promise<void> {
  const limitArgIndex = process.argv.indexOf("--tasks");
  const limit = limitArgIndex === -1 ? 3 : Number(process.argv[limitArgIndex + 1]);
  const cases = loadCases().slice(0, Number.isFinite(limit) && limit > 0 ? limit : 3);
  const statements = loadProblemStatements(new Set(cases.map((c) => c.instanceId)));

  const results: SmokeResult[] = [];
  for (const instance of cases) {
    const statement = statements.get(instance.instanceId);
    if (statement === undefined) {
      process.stdout.write(`✗ ${instance.instanceId}: no problem statement in the corpus\n`);
      continue;
    }
    const result = await runCase(instance, statement);
    results.push(result);
    process.stdout.write(
      `${result.evidenceDelivered ? "✓" : "✗"} ${result.instanceId}: ${result.callStatus}`
      + ` shape=${result.shapeIsIndexOnly ? "index-only" : "OTHER"}`
      + ` tools=${result.visibleTools.length}`
      + ` items=${result.evidenceItems}`
      + ` writes=${result.indexWrites}`
      + `${result.evidenceDelivered ? "" : ` — ${result.detail.slice(0, 160)}`}\n`,
    );
  }

  const delivered = results.filter((r) => r.evidenceDelivered);
  const verdict = results.length > 0
    && results.every((r) => r.shapeIsIndexOnly && r.serverConnected && r.toolInventoryCorrect && r.indexWrites === 0)
    && delivered.length === results.length
    ? "PASS"
    : "FAIL";

  const report = {
    schemaVersion: 1,
    milestone: "M164",
    workstream: "B",
    title: "Evidence delivery through the exact live-runner preparation path",
    controlValidity: {
      preparedThrough: "the live runner's own index step against the M163 trigger arm's own workspaces",
      handBuiltFixture: false,
      initRun: false,
      why: "M163's controls passed on init+index fixtures while its sweep used index alone. The specimen must share the subject's setup, not merely its runtime.",
    },
    agentHalfNotProven: [
      "Whether an agent complies with the trigger and whether it uses what comes back are live questions and are not claimed here.",
      "This control proves the product answers a sweep-shaped workspace with repository evidence, which is exactly what M163 could not do.",
    ],
    cases: results,
    summary: {
      cases: results.length,
      indexOnlyShape: results.filter((r) => r.shapeIsIndexOnly).length,
      serverConnected: results.filter((r) => r.serverConnected).length,
      toolInventoryCorrect: results.filter((r) => r.toolInventoryCorrect).length,
      validNonEmpty: delivered.length,
      repoNotReady: results.filter((r) => r.callStatus === "REPO_NOT_READY").length,
      invalidRequest: results.filter((r) => r.callStatus === "INVALID_REQUEST").length,
      evidenceCharacters: delivered.reduce((total, r) => total + r.evidenceCharacters, 0),
      refusalCharacters: results.reduce((total, r) => total + r.refusalCharacters, 0),
      indexWrites: results.reduce((total, r) => total + r.indexWrites, 0),
    },
    verdict,
  };

  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\n${verdict}: ${OUT}\n`);
  if (verdict !== "PASS") process.exitCode = 1;
}

await main();
