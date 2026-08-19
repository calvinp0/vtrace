/**
 * M162 Gate 1 — real-agent known-positive control.
 *
 * Infrastructure qualification ONLY. Its task outcome is irrelevant and must
 * never enter M162-D's capability or efficiency denominators.
 *
 * Everything below the live-runtime boundary was already proved offline by
 * direct JSON-RPC and by capturing the spawned process's argv. Exactly one
 * thing could not be: whether a real Claude runtime loads the server, surfaces
 * its instructions, exposes precisely the frozen tools, permits them, and can
 * chain one into the other using an identity it copies rather than invents.
 *
 * The model-visible tool names are DISCOVERED from the run's own init event and
 * treated as the authority. They are not assumed, and telemetry does not key on
 * an expected spelling until this control confirms it.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m162_gate1_control.ts \
 *     --workspace /home/calvin/bench/tmp/m162_gate1
 */

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { FROZEN_CALLABLE_TOOL_IDS, buildCallableAllowedTools, frozenCallableMcpToolNames } from "./m162Callable";

const MODEL = "claude-opus-4-5-20251101";
const MAX_TURNS = 14;

/**
 * The control MAY instruct the sequence explicitly: it tests wiring, not
 * behaviour, and a zero-call run would leave the wiring unproven. Natural
 * adoption is an M162-D question and is not asked here.
 *
 * The instruction deliberately forbids repairing the identifier, because the
 * defect M162-A fixed was precisely that the identifier VTRACE showed could not
 * be passed back unchanged.
 */
const CONTROL_PROMPT = [
  "This is an infrastructure control. Do not modify any file.",
  "",
  "Perform exactly these steps, in order:",
  "",
  "1. Call the vtrace get_code_context tool with the task description:",
  '   "gold tier discount is wrong when computing the order total"',
  "",
  "2. In its response, find an item in productContext.items whose `fqName` refers to a METHOD",
  "   (its fqName contains a dot after the class name, e.g. something like path.py::Class.method).",
  "",
  "3. Call the vtrace get_impact_graph tool, passing that EXACT fqName string as symbol_fqn.",
  "   Copy it byte-for-byte. Do not shorten it, do not strip the path, do not reformat it.",
  "",
  "4. Report the fqName you used and whether the impact call resolved.",
  "",
  "5. Finally, answer this exactly: were you given any instructions or guidance from the",
  "   `vtrace` MCP server itself (server-level instructions, not the tool descriptions)?",
  "   If yes, quote them verbatim between the markers POLICY_BEGIN and POLICY_END.",
  "   If you received no server-level instructions, write POLICY_BEGIN NONE POLICY_END.",
  "",
  "Then stop. Do not edit, write, or test anything.",
].join("\n");

interface StreamEvent { readonly type?: string; readonly [key: string]: unknown }

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fingerprint(target: string): Record<string, unknown> {
  if (!existsSync(target)) return { present: false };
  const stat = statSync(target);
  return {
    present: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: sha256(readFileSync(target).toString("latin1")),
  };
}

async function runAgent(
  workspace: string,
  mcpConfigPath: string,
  allowedTools: readonly string[],
  streamPath: string,
): Promise<{ events: StreamEvent[]; exitCode: number | null; stderr: string; durationMs: number }> {
  const args = [
    "-p", CONTROL_PROMPT,
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
        try { events.push(JSON.parse(trimmed) as StreamEvent); } catch { /* non-JSON line */ }
      }
      resolve({ events, exitCode, stderr, durationMs: Date.now() - started });
    });
  });
}

/** Ordered tool_use events, paired with their tool_result by id. */
interface ToolExchange {
  readonly order: number;
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly resultText: string | null;
  readonly isError: boolean | null;
}

function extractExchanges(events: readonly StreamEvent[]): ToolExchange[] {
  const uses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const results = new Map<string, { text: string; isError: boolean }>();

  for (const event of events) {
    const message = event.message as { content?: unknown[] } | undefined;
    const content = Array.isArray(message?.content) ? message!.content : [];
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
            ? raw.map((entry) => (entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string"
              ? String((entry as Record<string, unknown>).text) : "")).join("")
            : JSON.stringify(raw ?? null);
        results.set(record.tool_use_id, { text, isError: record.is_error === true });
      }
    }
  }

  return uses.map((use, order) => {
    const result = results.get(use.id);
    return {
      order,
      id: use.id,
      name: use.name,
      input: use.input,
      resultText: result?.text ?? null,
      isError: result?.isError ?? null,
    };
  });
}

function main(): void {
  const argv = process.argv.slice(2);
  const wsIndex = argv.indexOf("--workspace");
  const controlRoot = path.resolve(wsIndex !== -1 && argv[wsIndex + 1] !== undefined
    ? argv[wsIndex + 1]! : "/home/calvin/bench/tmp/m162_gate1");
  const workspace = path.join(controlRoot, "repo");
  const mcpConfigPath = path.join(controlRoot, "mcp.json");
  const resultsDir = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
  mkdirSync(resultsDir, { recursive: true });
  const streamPath = path.join(controlRoot, "gate1_stream.jsonl");

  const indexPath = path.join(workspace, ".vtrace", "index.sqlite");
  const indexBefore = fingerprint(indexPath);

  const allowedTools = buildCallableAllowedTools();
  const expectedNames = frozenCallableMcpToolNames();

  void (async () => {
    const run = await runAgent(workspace, mcpConfigPath, allowedTools, streamPath);
    const indexAfter = fingerprint(indexPath);
    const exchanges = extractExchanges(run.events);

    // ── Discovery: the init event is the AUTHORITY on tool names ────────────
    const init = run.events.find((event) => event.type === "system" && event.subtype === "init");
    const runtimeTools = ((init?.tools ?? []) as unknown[]).filter((entry): entry is string => typeof entry === "string");
    const runtimeMcpServers = (init?.mcp_servers ?? []) as Array<{ name?: string; status?: string }>;
    const discoveredVtraceTools = runtimeTools.filter((name) => name.toLowerCase().includes("vtrace"));

    const vtraceExchanges = exchanges.filter((exchange) => discoveredVtraceTools.includes(exchange.name));
    const contextCalls = vtraceExchanges.filter((exchange) => exchange.name.includes("get_code_context"));
    const impactCalls = vtraceExchanges.filter((exchange) => exchange.name.includes("get_impact_graph"));

    // ── Composition: was the identifier COPIED or invented? ─────────────────
    let composition: Record<string, unknown> = { attempted: false };
    if (contextCalls.length > 0 && impactCalls.length > 0) {
      const contextCall = contextCalls[0]!;
      let returnedFqNames: string[] = [];
      try {
        const raw = JSON.parse(contextCall.resultText ?? "{}") as Record<string, unknown>;
        // The live runtime records the server envelope; a direct stdio client
        // does not. Peel defensively so both shapes read identically.
        let parsed = raw;
        for (let depth = 0; depth < 4 && parsed.productContext === undefined; depth += 1) {
          const next = (parsed.output ?? parsed.result) as Record<string, unknown> | undefined;
          if (next === null || typeof next !== "object") break;
          parsed = next;
        }
        const productContext = parsed.productContext as Record<string, unknown> | undefined;
        const items = (productContext?.items ?? []) as Array<Record<string, unknown>>;
        returnedFqNames = items
          .map((item) => item.fqName)
          .filter((value): value is string => typeof value === "string" && value.length > 0);
      } catch { /* recorded below as unparsed */ }

      const impactCall = impactCalls[0]!;
      const usedIdentifier = String(impactCall.input.symbol_fqn ?? "");
      composition = {
        attempted: true,
        returnedFqNames,
        usedIdentifier,
        copiedVerbatimFromReturnedFqName: returnedFqNames.includes(usedIdentifier),
        identifierIsMethod: /::\w+\.\w+/.test(usedIdentifier),
        impactResolved: impactCall.isError !== true,
        contextBeforeImpact: contextCall.order < impactCall.order,
      };
    }

    const resultText = (exchange: ToolExchange | undefined): string => exchange?.resultText ?? "";
    const finalEvent = run.events.find((event) => event.type === "result");

    // ── Suite-policy delivery ───────────────────────────────────────────────
    //
    // Server-level MCP instructions are injected into the system prompt, which
    // stream-json does not echo, so their absence from the transcript proves
    // nothing. The agent is therefore asked to quote what it was given: text it
    // could only reproduce by having received it is the available evidence.
    const agentText = run.events
      .filter((event) => event.type === "assistant")
      .flatMap((event) => {
        const message = event.message as { content?: unknown[] } | undefined;
        return (message?.content ?? []).map((block) => (
          block !== null && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string"
            ? String((block as Record<string, unknown>).text) : ""
        ));
      })
      .join("\n");
    const resultTextFinal = typeof finalEvent?.result === "string" ? finalEvent.result : "";
    const reported = `${agentText}\n${resultTextFinal}`;
    const policyMarkers = [
      "Repository-intelligence workflow",
      "initial repository-orientation",
      "selective evidence",
      "Ordinary repository tools remain available",
    ];
    const matched = policyMarkers.filter((marker) => reported.toLowerCase().includes(marker.toLowerCase()));
    const declaredNone = /POLICY_BEGIN\s*NONE\s*POLICY_END/i.test(reported);
    const policyEvidence = {
      method: "agent self-report; server instructions are not echoed in stream-json, so transcript absence is not evidence of absence",
      markersMatched: matched,
      agentDeclaredNoServerInstructions: declaredNone,
      reachedRuntime: matched.length >= 2 && !declaredNone,
      reportExcerpt: reported.slice(-1200),
    };

    const assertions: Record<string, boolean> = {
      liveProcessStarted: run.events.length > 0,
      exitedCleanly: run.exitCode === 0,
      mcpServerLoaded: runtimeMcpServers.some((server) => server.name === "vtrace" && server.status === "connected"),
      vtraceToolsDiscovered: discoveredVtraceTools.length > 0,
      exactlyTwoVtraceTools: discoveredVtraceTools.length === 2,
      noOtherVtraceToolsLeaked: discoveredVtraceTools.every((name) => FROZEN_CALLABLE_TOOL_IDS.some((id) => name.endsWith(id))),
      discoveredNamesMatchExpectation: [...discoveredVtraceTools].sort().join(",") === [...expectedNames].sort().join(","),
      allowedToolsPermittedBoth: contextCalls.length > 0 && impactCalls.length > 0
        && contextCalls.every((call) => !resultText(call).includes("permission"))
        && impactCalls.every((call) => !resultText(call).includes("permission")),
      agentCalledGetCodeContext: contextCalls.length > 0,
      contextReturnedEvidence: contextCalls.some((call) => resultText(call).includes("productContext")),
      agentCalledGetImpactGraph: impactCalls.length > 0,
      identifierCopiedVerbatim: composition.copiedVerbatimFromReturnedFqName === true,
      identifierWasAMethod: composition.identifierIsMethod === true,
      impactResolved: composition.impactResolved === true,
      correctWorkspaceSelected: contextCalls.some((call) => resultText(call).includes(workspace))
        || contextCalls.some((call) => resultText(call).includes("pkg/core.py")),
      suitePolicyReachedRuntime: policyEvidence.reachedRuntime,
      orderedTelemetryCapturedBothCalls: contextCalls.length > 0 && impactCalls.length > 0
        && contextCalls[0]!.order < impactCalls[0]!.order,
      resultStatesCaptured: vtraceExchanges.every((exchange) => exchange.resultText !== null),
      indexWritesZero: JSON.stringify(indexBefore) === JSON.stringify(indexAfter),
    };

    const artifact = {
      schemaVersion: 1,
      milestone: "M162",
      gate: 1,
      title: "Real-agent known-positive control",
      purpose: "Infrastructure qualification only. Excluded from every M162-D denominator.",
      productSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      model: MODEL,
      workspace,
      workspaceCommit: execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      mcpConfig: JSON.parse(readFileSync(mcpConfigPath, "utf8")),
      allowedToolsPassed: allowedTools,
      expectedVtraceToolNames: expectedNames,
      discovery: {
        note: "Runtime-reported names are the AUTHORITY; expectations are compared against them, never substituted for them.",
        runtimeToolCount: runtimeTools.length,
        runtimeTools,
        runtimeMcpServers,
        discoveredVtraceTools,
      },
      exchanges: vtraceExchanges.map((exchange) => ({
        order: exchange.order,
        name: exchange.name,
        input: exchange.input,
        isError: exchange.isError,
        responseChars: (exchange.resultText ?? "").length,
        responseEstimatedTokens: Math.ceil((exchange.resultText ?? "").length / 4),
        responseHash: sha256(exchange.resultText ?? ""),
      })),
      ordinaryToolCalls: exchanges.filter((exchange) => !discoveredVtraceTools.includes(exchange.name))
        .map((exchange) => ({ order: exchange.order, name: exchange.name })),
      composition,
      suitePolicyDelivery: policyEvidence,
      indexReadOnly: { before: indexBefore, after: indexAfter, writes: assertions.indexWritesZero ? 0 : 1 },
      sessionIsolation: {
        serverLifetime: "one stdio process for this run, bound to this workspace at startup",
        sharedStateWithOtherRuns: false,
        sessionIsolationValid: true,
      },
      economics: {
        durationMs: run.durationMs,
        costUsd: (finalEvent?.total_cost_usd ?? null) as number | null,
        numTurns: (finalEvent?.num_turns ?? null) as number | null,
        usage: (finalEvent?.usage ?? null) as unknown,
      },
      streamArtifact: { path: streamPath, sha256: sha256(readFileSync(streamPath, "utf8")), tracked: false },
      assertions,
      allAssertionsPassed: Object.values(assertions).every(Boolean),
      failedAssertions: Object.entries(assertions).filter(([, ok]) => !ok).map(([name]) => name),
      exitCode: run.exitCode,
      stderrTail: run.stderr.slice(-2000),
    };

    writeFileSync(
      path.join(resultsDir, "stage5_m162_gate1_control.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );

    console.log(JSON.stringify({
      allAssertionsPassed: artifact.allAssertionsPassed,
      failedAssertions: artifact.failedAssertions,
      discoveredVtraceTools,
      mcpServers: runtimeMcpServers,
      policyMarkersMatched: policyEvidence.markersMatched,
      agentDeclaredNoServerInstructions: policyEvidence.agentDeclaredNoServerInstructions,
      vtraceCalls: vtraceExchanges.map((exchange) => exchange.name),
      composition,
      costUsd: artifact.economics.costUsd,
      durationMs: run.durationMs,
    }, null, 2));
  })();
}

main();
