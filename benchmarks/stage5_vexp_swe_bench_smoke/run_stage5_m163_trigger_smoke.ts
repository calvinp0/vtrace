/**
 * M163-B — task-trigger compliance control. ONE live agent run.
 *
 * The question it answers is narrow and it is the only one that must be settled
 * before 36 paid arms: does the FROZEN Arm C instruction, delivered in its
 * FROZEN position, actually cause `mcp__vtrace__get_code_context` to be the
 * agent's first repository action?
 *
 * If it does not, the sweep would spend $25 measuring a trigger that never
 * reached the model, and M162 already showed how indistinguishable that is from
 * a trigger the model declined.
 *
 * OUT OF SAMPLE by construction: it runs on the synthetic Gate 1 fixture, not on
 * any of the frozen twelve, so no M163 task is consumed for wiring validation.
 *
 * The prompt is assembled exactly as the patched adapter assembles it — task
 * text, then the shared anti-loop block, then the trigger heading and the frozen
 * trigger bytes last. The trigger is the ONLY mention of VTRACE anywhere in it;
 * nothing else asks for a tool call. Ordinary tools are permitted and plentiful,
 * so "zero ordinary actions before the required call" is a real measurement
 * rather than an artefact of having nothing else to reach for.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m163_trigger_smoke.ts \
 *     [--workspace /home/calvin/bench/tmp/m162_gate1]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildCallableAllowedTools, frozenCallableMcpToolNames } from "./m162Callable";
import { classifyTriggerCompliance, ORDINARY_REPOSITORY_TOOLS } from "./m163Adoption";
import { buildArmWiring, M163_CONTEXT_TOOL_NAME, M163_TASK_TRIGGER_TEXT, sha256 } from "./m163Policy";
import { STAGE5_M163_TASK_TRIGGER_HEADING } from "./run_stage5_vexp_swe_bench_smoke";

const MODEL = "claude-opus-4-5-20251101";
const MAX_TURNS = 14;
const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const DISCIPLINE_FILE = path.join(RESULTS, "_stage5_tool_use_discipline.md");

/**
 * An ordinary bug report, in the shape the external harness passes. It names a
 * symptom and asks for a fix. It does not mention VTRACE, tools, or orientation.
 */
const TASK_TEXT = [
  "Fix the following issue in this repository.",
  "",
  "## Issue",
  "",
  "Gold-tier orders are being discounted twice in the final total. A gold order of 100.00",
  "with the standard rate should come out above the discounted subtotal, but callers report",
  "the total is lower than expected. Ordinary-tier orders are unaffected.",
  "",
  "Make the smallest change that fixes the reported behaviour, and do not change behaviour",
  "for tiers other than gold.",
].join("\n");

function assemblePrompt(): string {
  const sections = [TASK_TEXT];
  // Present in every M163 arm, exactly as in M162, so the smoke sees the same
  // prompt neighbourhood the sweep will.
  if (existsSync(DISCIPLINE_FILE)) sections.push(readFileSync(DISCIPLINE_FILE, "utf8").trim());
  sections.push(`${STAGE5_M163_TASK_TRIGGER_HEADING}\n\n${M163_TASK_TRIGGER_TEXT}`);
  return sections.join("\n\n");
}

interface StreamEvent { readonly type?: string; readonly [key: string]: unknown }

interface ToolExchange {
  readonly order: number;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly isError: boolean | null;
  readonly responseChars: number;
}

function extractExchanges(events: readonly StreamEvent[]): ToolExchange[] {
  const uses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const results = new Map<string, { text: string; isError: boolean }>();

  for (const event of events) {
    const message = event.message as { content?: unknown[] } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      const record = block as Record<string, unknown>;
      if (record.type === "tool_use" && typeof record.id === "string" && typeof record.name === "string") {
        uses.push({ id: record.id, name: record.name, input: (record.input ?? {}) as Record<string, unknown> });
      }
      if (record.type === "tool_result" && typeof record.tool_use_id === "string") {
        const raw = record.content;
        const text = typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? raw.map((entry) => (entry !== null && typeof entry === "object"
              && typeof (entry as Record<string, unknown>).text === "string"
              ? String((entry as Record<string, unknown>).text) : "")).join("")
            : JSON.stringify(raw ?? null);
        results.set(record.tool_use_id, { text, isError: record.is_error === true });
      }
    }
  }

  return uses.map((use, order) => ({
    order,
    name: use.name,
    input: use.input,
    isError: results.get(use.id)?.isError ?? null,
    responseChars: (results.get(use.id)?.text ?? "").length,
  }));
}

function fingerprint(target: string): Record<string, unknown> {
  if (!existsSync(target)) return { present: false };
  const stat = statSync(target);
  return { present: true, size: stat.size, sha256: sha256(readFileSync(target).toString("latin1")) };
}

async function runAgent(
  workspace: string,
  mcpConfigPath: string,
  allowedTools: readonly string[],
  prompt: string,
  streamPath: string,
): Promise<{ events: StreamEvent[]; exitCode: number | null; stderr: string; durationMs: number }> {
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--model", MODEL,
    "--max-turns", String(MAX_TURNS),
    "--verbose",
    "--allowedTools", allowedTools.join(","),
    "--mcp-config", mcpConfigPath,
    "--strict-mcp-config",
  ];
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      writeFileSync(streamPath, stdout);
      const events: StreamEvent[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try { events.push(JSON.parse(trimmed) as StreamEvent); } catch { /* non-JSON */ }
      }
      resolve({ events, exitCode, stderr, durationMs: Date.now() - started });
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const wsIndex = argv.indexOf("--workspace");
  const controlRoot = path.resolve(wsIndex !== -1 && argv[wsIndex + 1] !== undefined
    ? argv[wsIndex + 1]! : "/home/calvin/bench/tmp/m162_gate1");
  const workspace = path.join(controlRoot, "repo");
  if (!existsSync(workspace)) throw new Error(`missing control workspace: ${workspace}`);

  const smokeRoot = path.join(controlRoot, "m163_trigger_smoke");
  mkdirSync(smokeRoot, { recursive: true });
  const mcpConfigPath = path.join(smokeRoot, "mcp.json");
  const streamPath = path.join(smokeRoot, "stream.jsonl");

  // The trigger arm's own frozen wiring, not a hand-written config.
  const wiring = buildArmWiring({
    arm: "tools_task_trigger",
    repoRoot: workspace,
    cliEntry: path.resolve("src/cli/index.ts"),
    runtime: "bun",
    triggerFile: path.join(RESULTS, "stage5_m163_task_trigger.md"),
  });
  writeFileSync(mcpConfigPath, `${JSON.stringify(wiring.mcpConfig, null, 2)}\n`);

  const indexPath = path.join(workspace, ".vtrace", "index.sqlite");
  const indexBefore = fingerprint(indexPath);
  const prompt = assemblePrompt();

  const run = await runAgent(workspace, mcpConfigPath, buildCallableAllowedTools(), prompt, streamPath);
  const indexAfter = fingerprint(indexPath);
  const exchanges = extractExchanges(run.events);

  // Availability from the run's OWN init event. Never assumed.
  const init = run.events.find((event) => event.type === "system" && event.subtype === "init");
  const runtimeTools = ((init?.tools ?? []) as unknown[]).filter((entry): entry is string => typeof entry === "string");
  const runtimeServers = (init?.mcp_servers ?? []) as Array<{ name?: string; status?: string }>;
  const discovered = runtimeTools.filter((name) => name.toLowerCase().includes("vtrace"));
  const connected = runtimeServers.some((server) => server.name === "vtrace" && server.status === "connected");
  const toolsAvailable = connected && discovered.length === frozenCallableMcpToolNames().length;

  const compliance = classifyTriggerCompliance(
    exchanges.map((exchange) => ({ tool: exchange.name } as never)),
    { isTriggerArm: true, adoption: toolsAvailable ? "AVAILABLE_USED" : "TOOLS_UNAVAILABLE" },
  );

  const firstVtrace = exchanges.findIndex((exchange) => discovered.includes(exchange.name));
  const before = firstVtrace === -1 ? exchanges : exchanges.slice(0, firstVtrace);
  const ordinaryBefore = before.filter((exchange) =>
    ORDINARY_REPOSITORY_TOOLS.has(exchange.name.trim().toLowerCase()));

  const firstCallIsContextTool = firstVtrace !== -1
    && exchanges[firstVtrace]?.name === "mcp__vtrace__get_code_context";

  const pass = toolsAvailable
    && compliance.state === "TRIGGER_COMPLIED"
    && firstCallIsContextTool
    && ordinaryBefore.length === 0;

  const usage = (run.events.find((event) => event.type === "result") ?? {}) as Record<string, unknown>;

  const artifact = {
    schemaVersion: 1,
    milestone: "M163",
    workstream: "B",
    title: "Task-trigger compliance control",
    purpose:
      "Prove the frozen Arm C instruction reaches the model and produces the required first call. "
      + "Infrastructure qualification only; excluded from every M163 adoption and utility denominator.",
    outOfSample: true,
    workspace,
    model: MODEL,
    triggerSha256: sha256(M163_TASK_TRIGGER_TEXT),
    promptSha256: sha256(prompt),
    promptChars: prompt.length,
    promptMentionsVtraceOnlyInTrigger:
      (prompt.match(/vtrace/gi) ?? []).length === (M163_TASK_TRIGGER_TEXT.match(/vtrace/gi) ?? []).length,
    availability: {
      serverConnected: connected,
      discoveredVtraceTools: discovered,
      expectedVtraceTools: frozenCallableMcpToolNames(),
      inventoryMatches: discovered.join(",") === frozenCallableMcpToolNames().join(","),
      toolsAvailable,
    },
    orderedToolCalls: exchanges.map((exchange) => ({
      order: exchange.order, name: exchange.name, isError: exchange.isError, responseChars: exchange.responseChars,
    })),
    firstAction: exchanges[0]?.name ?? null,
    firstVtraceCallIndex: firstVtrace === -1 ? null : firstVtrace,
    firstCallIsContextTool,
    ordinaryRepositoryActionsBefore: ordinaryBefore.map((exchange) => exchange.name),
    compliance,
    indexWrites: {
      before: indexBefore,
      after: indexAfter,
      unchanged: JSON.stringify(indexBefore) === JSON.stringify(indexAfter),
    },
    cost: {
      costUsd: usage.total_cost_usd ?? null,
      numTurns: usage.num_turns ?? null,
      durationMs: run.durationMs,
      usage: usage.usage ?? null,
    },
    exitCode: run.exitCode,
    stderrTail: run.stderr.trim().split("\n").slice(-5).join("\n"),
    streamFile: streamPath,
    status: pass ? "PASS" : "FAIL",
    // The runtime may emit its own schema-loading call (ToolSearch) before any
    // agent decision. It touches no repository state and is not an ordinary
    // repository action, so it is reported and excluded rather than silently
    // ignored — §34 allows unavoidable system actions, and naming which ones
    // were allowed is the difference between an exemption and a loophole.
    runtimeActionsBeforeFirstVtraceCall: before
      .filter((exchange) => !ORDINARY_REPOSITORY_TOOLS.has(exchange.name.trim().toLowerCase()))
      .map((exchange) => exchange.name),
    limitations: [
      "One task, one run. It qualifies delivery, not effect size.",
      "The control task text is far shorter than a SWE-bench problem statement, so the trigger sits at higher "
      + "relative salience here than it will in the sweep. Compliance in the sweep is measured, not assumed from this.",
      "Run through a direct `claude` invocation rather than the external harness, so the runtime tool inventory "
      + "differs from the sweep's. The VTRACE inventory, MCP config and trigger bytes are the sweep's.",
    ],
    verdictBasis: [
      `tools available from the run's own init event: ${toolsAvailable}`,
      `first ORDINARY repository action: ${exchanges.find((exchange) => ORDINARY_REPOSITORY_TOOLS.has(exchange.name.trim().toLowerCase()))?.name ?? "(none)"}`,
      `ordinary repository actions before the required call: ${ordinaryBefore.length}`,
      `first VTRACE call was ${M163_CONTEXT_TOOL_NAME}: ${firstCallIsContextTool}`,
      `compliance: ${compliance.state} (${compliance.reason})`,
    ],
  };

  writeFileSync(path.join(RESULTS, "stage5_m163_smoke_result.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: artifact.status,
    firstAction: artifact.firstAction,
    compliance: compliance.state,
    ordinaryBefore: ordinaryBefore.length,
    costUsd: artifact.cost.costUsd,
  }, null, 2)}\n`);
  if (!pass) process.exitCode = 1;
}

void main();
