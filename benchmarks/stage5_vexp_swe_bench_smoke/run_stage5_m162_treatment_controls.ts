/**
 * M162-B/C — treatment-assembly controls and the real-spawn control plan.
 *
 * Covers the parts of the live path that are decided BEFORE the agent starts:
 * which dataset it is pointed at, which tools it may call, what policy text it
 * is exposed to, and what the telemetry will be able to reconstruct afterwards.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m162_treatment_controls.ts
 */

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { scanDescriptionForPolicy } from "./m162CallableSurface";
import { VTRACE_TOOL_SUITE_POLICY } from "../../src/mcp/startServer";
import {
  FROZEN_CALLABLE_TOOL_IDS,
  buildCallableAllowedTools,
  buildVtraceMcpConfig,
  checkArmToolParity,
  expectedArmToolPermissions,
  frozenCallableMcpToolNames,
} from "./m162Callable";
import { buildRunArgs } from "./run_stage5_vexp_swe_bench_smoke";

const CLI_ENTRY = path.resolve(import.meta.dir, "../../src/cli/index.ts");

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The five historical Stage 5 policy blocks, as concepts to be excluded. */
const HISTORICAL_POLICY_PROBES: ReadonlyArray<{ readonly name: string; readonly text: string }> = [
  { name: "STAGE5_TOKEN_DISCIPLINE", text: "Make at most two searches before your first edit." },
  { name: "PIVOT_CHECK", text: "Do not rediscover with grep what VTRACE already named." },
  { name: "EDIT_GUARD", text: "Write an edit plan, then patch immediately without further searching." },
  { name: "PATCH_VERIFY", text: "You must use the verification step before finishing." },
  { name: "ORIENTATION_INSTRUCTION", text: "Do not use grep, glob, Bash, Read, or cat to explore; always call the tool first." },
];

async function servedSurface(repoRoot: string): Promise<{
  instructions: string;
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      CLI_ENTRY, "mcp-serve", "--repo", repoRoot, "--tools", FROZEN_CALLABLE_TOOL_IDS.join(","),
    ], { stdio: ["pipe", "pipe", "ignore"] });

    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", reject);
    child.on("close", () => {
      let instructions = "";
      let tools: Array<{ name: string; description: string; inputSchema: unknown }> = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const parsed = JSON.parse(trimmed) as { id?: number; result?: Record<string, unknown> };
          if (parsed.id === 1) instructions = String(parsed.result?.instructions ?? "");
          if (parsed.id === 2) tools = (parsed.result?.tools ?? []) as typeof tools;
        } catch { /* partial */ }
      }
      resolve({ instructions, tools });
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m162", version: "1" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    setTimeout(() => child.stdin.end(), 2_500);
  });
}

async function main(): Promise<void> {
  const resultsDir = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
  mkdirSync(resultsDir, { recursive: true });
  const productSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // ── §7 --data passthrough ─────────────────────────────────────────────────
  //
  // The vexp CLI defaults to its bundled swe-bench-100.jsonl. M162's corpus is
  // drawn from SWE-bench Verified cases that file does not contain, so without
  // an explicit --data the harness would silently run a DIFFERENT task set — or
  // none. The control proves the requested file is what reaches the CLI, and
  // that it reaches every arm identically.
  const baseConfig = {
    cliEntry: "/vexp/dist/index.js", nodeCommand: "node", out: "/out",
    runLabel: "m162-control", vexpSweBenchDir: "/vexp",
  } as unknown as Parameters<typeof buildRunArgs>[0];

  const datasetA = "/data/m162-pilot.jsonl";
  const datasetB = "/data/other-corpus.jsonl";
  const argsWithA = buildRunArgs({ ...baseConfig, vexpRunDataFile: datasetA } as typeof baseConfig, ["astropy__astropy-1"], "/out/a", false);
  const argsWithB = buildRunArgs({ ...baseConfig, vexpRunDataFile: datasetB } as typeof baseConfig, ["astropy__astropy-1"], "/out/a", false);
  const argsWithout = buildRunArgs({ ...baseConfig, vexpRunDataFile: null } as typeof baseConfig, ["astropy__astropy-1"], "/out/a", false);

  const dataPassthrough = {
    flag: "--vexp-run-data",
    forwardedAs: "--data",
    selectedFileReachesCli: argsWithA.includes("--data") && argsWithA[argsWithA.indexOf("--data") + 1] === datasetA,
    distinguishableFilesProduceDistinguishableCommands: JSON.stringify(argsWithA) !== JSON.stringify(argsWithB),
    secondFileReachesCli: argsWithB[argsWithB.indexOf("--data") + 1] === datasetB,
    absentWhenUnset: !argsWithout.includes("--data"),
    identicalAcrossArms: (() => {
      const perArm = [false, false, true].map((vexp) => buildRunArgs(
        { ...baseConfig, vexpRunDataFile: datasetA } as typeof baseConfig, ["astropy__astropy-1"], "/out/x", vexp,
      ));
      return perArm.every((args) => args[args.indexOf("--data") + 1] === datasetA);
    })(),
    note:
      "Already present since M161 rather than newly repaired; the gap was the absence of a control, not the absence of the flag. "
      + "The dataset decides which instances exist, never which arm sees what.",
    exampleCommand: argsWithA,
  };

  // ── §9–§13 served surface, policy delivery, policy exclusion ──────────────
  const repoRoot = path.resolve(".");
  const surface = await servedSurface(repoRoot);
  const servedNames = surface.tools.map((tool) => tool.name);

  const descriptionFindings = surface.tools.map((tool) => ({
    tool: tool.name,
    flags: scanDescriptionForPolicy(tool.description, "tool_description").flags,
  }));
  const policyFindings = scanDescriptionForPolicy(surface.instructions, "suite_policy").flags;

  // Known positives: the scanner must reject each historical block. An empty
  // finding is worthless without proof the detector fires.
  const historicalProbeResults = HISTORICAL_POLICY_PROBES.map((probe) => ({
    block: probe.name,
    rejected: scanDescriptionForPolicy(probe.text, "suite_policy").flags.length > 0,
    flags: scanDescriptionForPolicy(probe.text, "suite_policy").flags,
  }));

  const policyControls = {
    servedOn: "initialize.result.instructions",
    policyPresent: surface.instructions.includes("Repository-intelligence workflow:"),
    policyOccurrences: surface.instructions.split("Repository-intelligence workflow:").length - 1,
    policyMatchesAuthority: surface.instructions.includes(VTRACE_TOOL_SUITE_POLICY),
    policySha256: sha256(VTRACE_TOOL_SUITE_POLICY),
    policyChars: VTRACE_TOOL_SUITE_POLICY.length,
    policyEstimatedTokens: Math.ceil(VTRACE_TOOL_SUITE_POLICY.length / 4),
    armExposure: {
      baseline: { policyServed: false, why: "no MCP server is configured, so no server instructions exist" },
      static: { policyServed: false, why: "no MCP server is configured; STATIC reproduces M161's clean capsule arm exactly" },
      callable: { policyServed: true, occurrences: 1 },
    },
    liveDeliveryUnproven:
      "That the server SERVES the policy is proved here. That the Claude runtime SURFACES server instructions to the "
      + "model cannot be proved without a real spawn, and is therefore an assertion of the gated known-positive control "
      + "rather than a claim made now.",
  };

  const policyExclusion = {
    toolDescriptionFindings: descriptionFindings,
    toolDescriptionsClean: descriptionFindings.every((entry) => entry.flags.length === 0),
    suitePolicyFindings: policyFindings,
    suitePolicyClean: policyFindings.length === 0,
    historicalBlockProbes: historicalProbeResults,
    detectorProvenOnKnownPositives: historicalProbeResults.every((entry) => entry.rejected),
    note:
      "Routing guidance is permitted on the suite surface and forbidden in individual tool descriptions; "
      + "investigation constraints are forbidden everywhere.",
  };

  // ── §11 arm permission parity ─────────────────────────────────────────────
  const armPermissions = (["baseline", "static", "callable"] as const).map((arm) => expectedArmToolPermissions(arm));
  const parity = checkArmToolParity(armPermissions);
  const allowedToolsControls = {
    harnessDefaultAllowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep", "TodoWrite"],
    callableAllowedTools: buildCallableAllowedTools(),
    vtraceToolNames: frozenCallableMcpToolNames(),
    perArm: armPermissions,
    parityOk: parity.ok,
    parityIssues: parity.issues,
    blockerRepaired:
      "The orchestrator's hardcoded --allowedTools names no MCP tool, so before M162 a correctly configured VTRACE "
      + "server would still have been visible-but-unusable. The two frozen names are added narrowly; no wildcard is used.",
  };

  const mcpConfigControls = {
    callableConfig: buildVtraceMcpConfig({ repoRoot: "<task-workspace>", cliEntry: CLI_ENTRY, runtime: "bun" }),
    baselineConfig: { mcpServers: {} },
    staticConfig: { mcpServers: {} },
    strictMcpConfigAllArms: true,
    servedToolNames: servedNames,
    servedMatchesFrozenExactly: servedNames.join(",") === FROZEN_CALLABLE_TOOL_IDS.join(","),
    modelVisibleNames: frozenCallableMcpToolNames(),
    modelVisibleNamesVerifiedLive: false,
    modelVisibleNamesNote:
      "The mcp__<server>__<tool> namespace is Claude Code's documented transformation, applied to the frozen server "
      + "name. It is asserted as an expectation here and must be CONFIRMED by the gated real-spawn control before "
      + "telemetry keys on it.",
  };

  // ── §49–§52 real-spawn control plan ───────────────────────────────────────
  const realSpawnPlan = {
    schemaVersion: 1,
    purpose: "Infrastructure qualification only. Not an M162-D data point.",
    excludedFrom: ["capability outcome counts", "token comparison", "unique win/loss analysis", "the 12-task pilot"],
    outcomeIndependence: "Whether the synthetic task is solved is irrelevant; only the exchange is asserted.",
    mayInstructExplicitly: true,
    instructionRationale:
      "Natural adoption is an M162-D question. Here the agent may be told to make the two calls, because the control "
      + "tests wiring rather than behaviour, and a zero-call run would leave the wiring unproven.",
    fixture: "The M162-A pricing fixture: a tiny indexed repo whose method pivot has a known canonical identity.",
    requiredSequence: [
      "receive exactly the frozen VTRACE tools",
      "call get_code_context on the controlled task",
      "obtain a method item's canonical items[].fqName",
      "pass that exact fqName to get_impact_graph, unrepaired",
      "receive a resolved impact result",
    ],
    assertions: [
      "--data passthrough selects the intended instance",
      "the claude process starts under --strict-mcp-config",
      "visible VTRACE tool set equals the frozen two, exactly",
      "both tools appear in --allowedTools and neither call is denied",
      "the model-visible names are the expected mcp__vtrace__* names",
      "VTRACE_TOOL_SUITE_POLICY reaches the model-facing runtime",
      "the server receives a real get_code_context request",
      "the correct workspace and index answered it",
      "the response is bounded",
      "a canonical method fqName is visible in the response",
      "get_impact_graph is called with that exact string",
      "the impact call resolves",
      "ordered telemetry records both calls in the correct order",
      "result tokens and latency are captured",
    ],
    failurePolicy: {
      onFailure: "DO NOT START M162-D",
      mayFix: ["harness", "MCP wiring", "allowedTools", "policy delivery", "telemetry", "workspace routing"],
      mayNotFix: ["retrieval, to make the control pass"],
    },
    estimatedUsd: 0.7,
  };

  // ── §31–§45 telemetry schema ──────────────────────────────────────────────
  const telemetrySchema = {
    schemaVersion: 1,
    parserVersion: "m162Telemetry.v1",
    rawAuthority: {
      source: "the agent adapter's raw stream-json dump",
      artifacts: ["_agent_stream.jsonl", "_tool_calls_with_outputs.json"],
      tracked: false,
      note: "Raw streams stay untracked; analysis records path, hash, and parser version so any summary is rebuildable.",
      principle: "The injected adapter patch stays dumb and dumps the authoritative stream; all interpretation happens in benchmark code.",
    },
    perCallFields: [
      "sequence", "rawIndex", "turn", "toolId", "modelVisibleName", "args", "argsHash",
      "queryLength", "resultState", "itemCount", "responseChars", "responseEstimatedTokens",
      "responseHash", "latencyMs", "returnedPaths", "returnedFqNames", "beforeFirstEdit", "purpose",
    ],
    resultStates: ["VALID_NONEMPTY", "VALID_EMPTY", "DEGRADED_VALID", "TOOL_ERROR"],
    adoptionStates: ["TOOLS_AVAILABLE_USED", "TOOLS_AVAILABLE_NOT_USED", "TOOLS_UNAVAILABLE"],
    firstCallTimingPrecedence: [
      "NEVER_USED", "BEFORE_ANY_REPO_SEARCH", "AFTER_REPO_SEARCH_BEFORE_READ",
      "AFTER_TEST_FAILURE", "AFTER_FIRST_EDIT", "AFTER_READ_BEFORE_EDIT",
    ],
    precedenceFrozenBeforeExecution: true,
    infrastructureErrorTaxonomy: [
      "MCP_SERVER_START_FAILURE", "MCP_DISCOVERY_FAILURE", "MCP_TRANSPORT_FAILURE",
      "WORKSPACE_ROUTING_FAILURE", "INDEX_BINDING_FAILURE", "SERIALIZATION_FAILURE",
    ],
    infrastructureVsAgentError:
      "A model-issued invalid request is agent behaviour and stays in the data. An infrastructure failure is a "
      + "treatment failure and is rerunnable under the frozen policy.",
    navigationComponents: ["ordinarySearches", "fileReads", "edits", "vtraceCalls", "totalToolCalls", "firstEditPosition"],
    noCompositeScore: "Components are reported separately; three fewer greps bought with five expensive tool calls is not efficiency.",
    tokenAccounting: {
      fixed: ["schema tokens", "suite policy tokens"],
      dynamic: ["per-call result tokens"],
      separateFromProviderCache:
        "Provider cache-read accounting is recorded but kept distinct from VTRACE payload exposure: a result carried "
        + "through the conversation is re-read every turn even when it bills as a cache hit.",
    },
    evaluatorOnly: "No label here may reach product behaviour, and nothing may act on telemetry mid-sweep.",
  };

  for (const [name, value] of [
    ["stage5_m162_data_passthrough_controls.json", dataPassthrough],
    ["stage5_m162_mcp_config_controls.json", mcpConfigControls],
    ["stage5_m162_allowed_tools_controls.json", allowedToolsControls],
    ["stage5_m162_tool_suite_policy_controls.json", policyControls],
    ["stage5_m162_policy_exclusion_controls.json", policyExclusion],
    ["stage5_m162_tool_telemetry_schema.json", telemetrySchema],
    ["stage5_m162_real_spawn_control_plan.json", realSpawnPlan],
  ] as const) {
    writeFileSync(
      path.join(resultsDir, name),
      `${JSON.stringify({ schemaVersion: 1, milestone: "M162", productSha, ...(value as object) }, null, 2)}\n`,
    );
  }

  console.log(JSON.stringify({
    dataPassthroughOk: dataPassthrough.selectedFileReachesCli && dataPassthrough.distinguishableFilesProduceDistinguishableCommands && dataPassthrough.absentWhenUnset,
    servedMatchesFrozenExactly: mcpConfigControls.servedMatchesFrozenExactly,
    allowedToolsParityOk: allowedToolsControls.parityOk,
    policyServedOnce: policyControls.policyOccurrences === 1 && policyControls.policyMatchesAuthority,
    toolDescriptionsClean: policyExclusion.toolDescriptionsClean,
    suitePolicyClean: policyExclusion.suitePolicyClean,
    historicalDetectorProven: policyExclusion.detectorProvenOnKnownPositives,
  }, null, 2));
}

await main();
