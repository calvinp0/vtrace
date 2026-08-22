import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "bun:test";

import { buildCapsule, createSourceBackedCapsuleBuilder } from "../capsule/buildCapsule";
import { createCharacterBudget } from "../capsule/budget";
import {
  type CapsuleInclusionReason,
  CapsuleInclusionReasonKind,
  type CapsuleSupportingCandidate,
} from "../capsule/types";
import { prepareCapsuleAssembly } from "../capsuleProfiles/orchestrator";
import { persistCapsuleManifest } from "../session/repositories/capsuleManifestsRepository";
import { listIndexRuns } from "../db/repositories/indexRunsRepository";
import { countObservations, listObservations, persistObservation } from "../session/repositories/observationsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { createTestProductStores } from "../testing/productStores";
import { ProductStoreLease } from "../session/sessionStore";
import { indexProject } from "../indexer/indexProject";
import { routeQuery } from "../intent/routeQuery";
import {
  DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS,
  compressInactiveSessions,
} from "../observations/sessionLifecycle";
import { consolidatePassiveObservationsForSession } from "../observations/consolidation";
import { buildObservationProvenance, resolveCurrentObservationContext } from "../observations/provenance";
import { ObservationKind, ObservationOrigin, ObservationScope, ObservationSource } from "../observations/types";
import {
  createActiveProjectRule,
  generateProjectRuleCandidates,
} from "../projectRules/projectRules";
import { recordObservedFileChanges } from "../runtime/fileWatcher";
import { reindexRepoAndRefreshState } from "../runtime/reindexRepo";
import { resolveRepoLocalPaths } from "../setup/repoState";
import type { GraphSearchResult } from "../retrieval/types";
import { initRepo } from "../setup/initRepo";
import { REPO_LOCAL_STATE_DIRNAME } from "../setup/types";
import { resolveWorkspaceConfigPath } from "../workspace/config";
import { createMcpToolRegistry } from "./registry";
import { createMcpServer, createMcpServerContext } from "./server";
import {
  buildMcpServerInstructions,
  createRepoBoundMcpServer,
  startMcpServer,
  VTRACE_TOOL_SUITE_POLICY,
} from "./startServer";
import {
  LEGACY_MCP_TOOL_DEFINITIONS,
  RESERVED_MCP_TOOL_DEFINITIONS,
  RESERVED_MCP_TOOL_METADATA,
} from "./tools";
import {
  MCP_SERVER_ID,
  MCP_SERVER_SCHEMA,
  McpErrorCode,
  McpToolAvailability,
  McpToolHandlerKind,
  McpToolId,
  type McpObjectSchema,
  type McpSchemaProperty,
  type McpToolDefinition,
} from "./types";

function normalizeProductContextTiming<T extends Record<string, any>>(output: T): T {
  if (output.productContext === undefined) return output;
  return {
    ...output,
    productContext: {
      ...output.productContext,
      freshness: { ...output.productContext.freshness, refreshDiagnostics: null },
      timing: {
        freshnessMs: 0,
        retrievalMs: 0,
        capsuleBuildMs: 0,
        impactMs: 0,
        memoryRulesMs: 0,
        renderMs: 0,
        totalMs: 0,
      },
    },
  };
}

const EXPECTED_VISIBLE_TOOL_IDS = [
  "get_code_context",
  "run_pipeline",
  "index_repo",
  "check_capsule_staleness",
  "get_context_capsule",
  "get_impact_graph",
  "search_logic_flow",
  "get_skeleton",
  "index_status",
  "workspace_setup",
  "get_session_context",
  "search_memory",
  "save_observation",
  "expand_vexp_ref",
] as const;

test("MCP tool vocabulary and metadata are explicit and stable", () => {
  assert.deepEqual(McpToolId, {
    GetCodeContext: "get_code_context",
    RunPipeline: "run_pipeline",
    GetContextCapsule: "get_context_capsule",
    GetImpactGraph: "get_impact_graph",
    SearchLogicFlow: "search_logic_flow",
    GetSkeleton: "get_skeleton",
    IndexStatus: "index_status",
    WorkspaceSetup: "workspace_setup",
    ExpandVexpRef: "expand_vexp_ref",
    IndexRepo: "index_repo",
    SearchSymbols: "search_symbols",
    RouteQuery: "route_query",
    BuildCapsule: "build_capsule",
    BuildHandoff: "build_handoff",
    ListRuns: "list_runs",
    CheckCapsuleStaleness: "check_capsule_staleness",
    SaveObservation: "save_observation",
    SearchMemory: "search_memory",
    GetSessionContext: "get_session_context",
    ListSessions: "list_sessions",
    ReadSession: "read_session",
  });
  assert.deepEqual(
    RESERVED_MCP_TOOL_METADATA.map((tool) => tool.toolId),
    EXPECTED_VISIBLE_TOOL_IDS,
  );

  const registrationsByToolId = new Map(
    RESERVED_MCP_TOOL_METADATA.map((tool) => [tool.toolId, tool.registration]),
  );

  assert.deepEqual(registrationsByToolId.get(McpToolId.GetCodeContext), {
    registered: true,
    reserved: true,
    availability: McpToolAvailability.Wired,
    handlerKind: McpToolHandlerKind.EngineDelegate,
  });
  assert.deepEqual(registrationsByToolId.get(McpToolId.RunPipeline), {
    registered: true,
    reserved: true,
    availability: McpToolAvailability.Wired,
    handlerKind: McpToolHandlerKind.EngineDelegate,
  });
  assert.deepEqual(registrationsByToolId.get(McpToolId.GetContextCapsule), {
    registered: true,
    reserved: true,
    availability: McpToolAvailability.Wired,
    handlerKind: McpToolHandlerKind.EngineDelegate,
  });
  assert.deepEqual(registrationsByToolId.get(McpToolId.GetImpactGraph), {
    registered: true,
    reserved: true,
    availability: McpToolAvailability.Wired,
    handlerKind: McpToolHandlerKind.EngineDelegate,
  });
  assert.deepEqual(registrationsByToolId.get(McpToolId.SearchLogicFlow), {
    registered: true,
    reserved: true,
    availability: McpToolAvailability.Wired,
    handlerKind: McpToolHandlerKind.EngineDelegate,
  });
  assert.deepEqual(registrationsByToolId.get(McpToolId.GetSkeleton), {
    registered: true,
    reserved: true,
    availability: McpToolAvailability.Wired,
    handlerKind: McpToolHandlerKind.EngineDelegate,
  });
  assert.deepEqual(registrationsByToolId.get(McpToolId.IndexStatus), {
    registered: true,
    reserved: true,
    availability: McpToolAvailability.Wired,
    handlerKind: McpToolHandlerKind.EngineDelegate,
  });
  assert.deepEqual(registrationsByToolId.get(McpToolId.WorkspaceSetup), {
    registered: true,
    reserved: true,
    availability: McpToolAvailability.Wired,
    handlerKind: McpToolHandlerKind.EngineDelegate,
  });
  assert.deepEqual(registrationsByToolId.get(McpToolId.SaveObservation), {
    registered: true,
    reserved: true,
    availability: McpToolAvailability.Wired,
    handlerKind: McpToolHandlerKind.EngineDelegate,
  });
  assert.deepEqual(registrationsByToolId.get(McpToolId.SearchMemory), {
    registered: true,
    reserved: true,
    availability: McpToolAvailability.Wired,
    handlerKind: McpToolHandlerKind.EngineDelegate,
  });
  assert.deepEqual(registrationsByToolId.get(McpToolId.GetSessionContext), {
    registered: true,
    reserved: true,
    availability: McpToolAvailability.Wired,
    handlerKind: McpToolHandlerKind.EngineDelegate,
  });
  assert.deepEqual(registrationsByToolId.get(McpToolId.ExpandVexpRef), {
    registered: true,
    reserved: true,
    availability: McpToolAvailability.Wired,
    handlerKind: McpToolHandlerKind.EngineDelegate,
  });

  const getCodeContext = RESERVED_MCP_TOOL_METADATA.find((tool) => tool.toolId === McpToolId.GetCodeContext);
  assert.notEqual(getCodeContext, undefined);
  const description = getCodeContext!.description.toLowerCase();

  // Capability vocabulary: the description must still say what the tool is for.
  // Neutral is not the same as vague, and a description an agent cannot route on
  // would depress adoption for a reason that has nothing to do with retrieval.
  for (const word of ["code", "context", "orientation", "evidence", "debugging", "refactor"]) {
    assert.match(description, new RegExp(`\\b${word}\\b`));
  }

  // M162: routing lives in the authoritative tool-suite policy served on
  // `initialize`, not in an individual tool's adjectives. Individual descriptions
  // must not rank themselves against the agent's other tools, and must never
  // constrain the agent's own investigation.
  for (const phrase of [
    "default first-pass",
    "first-pass",
    "use this first",
    "start with",
    "before grep",
    "primary tool",
    "do not use grep",
    "must use",
    "patch immediately",
    "mandatory",
  ]) {
    assert.ok(
      !description.includes(phrase),
      `get_code_context description must not carry usage-priority/coercive language: "${phrase}"`,
    );
  }
});

test("MCP registry registration and lookup are deterministic", () => {
  const customTool = makeCustomTool();
  const registry = createMcpToolRegistry({
    tools: [...RESERVED_MCP_TOOL_DEFINITIONS, customTool],
    hiddenTools: LEGACY_MCP_TOOL_DEFINITIONS.filter((tool) => (
      tool.metadata.toolId !== McpToolId.SaveObservation
      && tool.metadata.toolId !== McpToolId.SearchMemory
      && tool.metadata.toolId !== McpToolId.GetSessionContext
      && tool.metadata.toolId !== McpToolId.IndexRepo
      && tool.metadata.toolId !== McpToolId.CheckCapsuleStaleness
    )),
  });

  assert.equal(
    registry.getByToolId(McpToolId.GetContextCapsule),
    RESERVED_MCP_TOOL_DEFINITIONS.find((tool) => tool.metadata.toolId === McpToolId.GetContextCapsule),
  );
  assert.notEqual(registry.getByToolId(McpToolId.SearchSymbols), undefined);
  assert.equal(registry.getByToolId("custom_tool"), customTool);
  assert.deepEqual(
    registry.lookup("custom_tool"),
    registry.lookup("custom_tool"),
  );
  assert.deepEqual(
    registry.listMetadata().map((tool) => tool.toolId),
    [...EXPECTED_VISIBLE_TOOL_IDS, "custom_tool"],
  );
  assert.notEqual(
    registry.getByToolId(McpToolId.GetCodeContext)?.handler,
    undefined,
  );
  const getCodeContextInputSchema = registry.getByToolId(McpToolId.GetCodeContext)?.metadata.inputSchema;
  const runPipelineInputSchema = registry.getByToolId(McpToolId.RunPipeline)?.metadata.inputSchema;
  assert.notEqual(getCodeContextInputSchema, undefined);
  assert.notEqual(runPipelineInputSchema, undefined);
  for (const key of Object.keys(runPipelineInputSchema!.properties)) {
    assert.deepEqual(getCodeContextInputSchema!.properties[key], runPipelineInputSchema!.properties[key]);
  }
  assert.notEqual(getCodeContextInputSchema!.properties.repo_root, undefined);
  assert.notEqual(getCodeContextInputSchema!.properties.auto_refresh, undefined);
  const getCodeContextOutputSchema =
    registry.getByToolId(McpToolId.GetCodeContext)?.metadata.outputSchema;
  const runPipelineOutputSchema =
    registry.getByToolId(McpToolId.RunPipeline)?.metadata.outputSchema;
  assert.notEqual(getCodeContextOutputSchema, undefined);
  assert.notEqual(runPipelineOutputSchema, undefined);
  for (const key of ["resolved", "reason", "message", "nextTool"]) {
    assert.ok(
      getCodeContextOutputSchema!.properties[key] !== undefined,
      `get_code_context outputSchema should document ${key}`,
    );
    assert.equal(
      runPipelineOutputSchema!.properties[key],
      undefined,
      `run_pipeline outputSchema must not document ${key}`,
    );
  }
});

test("unknown-tool responses are structured and deterministic", async () => {
  const server = createMcpServer();
  const request = {
    schema: MCP_SERVER_SCHEMA,
    requestId: "req-unknown",
    toolId: "missing_tool",
    input: {},
  } as const;
  const first = await server.handleRequest(request);
  const second = await server.handleRequest(request);

  assert.deepEqual(second, first);
  assert.deepEqual(first, {
    schema: MCP_SERVER_SCHEMA,
    requestId: "req-unknown",
    toolId: "missing_tool",
    result: {
      ok: false,
      error: {
        code: McpErrorCode.UnknownTool,
        message: "Unknown MCP tool: missing_tool",
        details: {
          availableToolIds: EXPECTED_VISIBLE_TOOL_IDS,
        },
      },
    },
  });
});

test("repo-bound MCP server startup succeeds for an initialized repo and is deterministic", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const first = await createRepoBoundMcpServer({ repoPath: repoRoot });
    const second = await createRepoBoundMcpServer({ repoPath: path.join(repoRoot, "src") });

    assert.equal(first.startup.repoRoot, initialized.repoRoot);
    assert.equal(first.startup.requestedPath, repoRoot);
    assert.equal(second.startup.requestedPath, path.join(repoRoot, "src"));
    assert.deepEqual(
      {
        ...first.startup,
        requestedPath: undefined,
      },
      {
        ...second.startup,
        requestedPath: undefined,
      },
    );
    assert.deepEqual(first.server.context, second.server.context);
    assert.equal(first.server.context.initialized, true);
    assert.equal(first.server.context.state?.readiness.status, "ready");
    assert.equal(first.startup.initialized, true);
    assert.deepEqual(first.startup.toolIds, EXPECTED_VISIBLE_TOOL_IDS);
  });
});

test("repo-bound MCP server startup binds an uninitialized repo and exposes setup/status tools", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const bound = await createRepoBoundMcpServer({ repoPath: repoRoot });

    assert.equal(bound.startup.repoRoot, repoRoot);
    assert.equal(bound.startup.initialized, false);
    assert.equal(bound.startup.readiness, null);
    assert.deepEqual(bound.startup.toolIds, EXPECTED_VISIBLE_TOOL_IDS);
  });
});

test("local MCP server process starts for an initialized repo and exposes wired tools", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const expectedServer = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const processResult = runMcpServerProcessWithMessages(repoRoot, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "mcp-test",
            version: "1.0.0",
          },
        },
      },
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "index_status",
          arguments: {},
        },
      },
    ]);
    const [initializeResponse, listResponse, callResponse] = processResult.responses;
    const listTools = (listResponse.result as {
      tools: Array<{ name: string }>;
    }).tools;
    const expectedSearchResponse = await expectedServer.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "jsonrpc:3:index_status",
      toolId: McpToolId.IndexStatus,
      input: {},
    });
    const callResult = callResponse.result as {
      isError: boolean;
      structuredContent: unknown;
      content: unknown;
    };

    assert.equal(processResult.exitCode, 0);
    assert.equal(processResult.stderr, "");
    assert.deepEqual(initializeResponse, {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: "vtrace_rc1_mcp",
          version: "1.0.0",
        },
        // M162: the authoritative agent-facing routing policy is served here, in
        // one reviewable place, rather than distributed across tool adjectives.
        instructions: `Repo-bound vtrace MCP server for ${repoRoot}. Use tools/list to inspect available tools.\n\n${VTRACE_TOOL_SUITE_POLICY}`,
      },
    });
    assert.deepEqual(
      listTools.map((tool) => tool.name),
      EXPECTED_VISIBLE_TOOL_IDS,
    );
    assert.deepEqual(
      Object.keys(listTools[0] ?? {}).sort(),
      ["description", "inputSchema", "name"],
    );
    assert.equal(callResult.isError, false);
    assert.deepEqual(callResult.structuredContent, expectedSearchResponse);
    assert.deepEqual(
      callResult.content,
      [
        {
          type: "text",
          text: JSON.stringify(expectedSearchResponse.result.ok
            ? expectedSearchResponse.result.output
            : expectedSearchResponse.result.error),
        },
      ],
    );
  });
});

// M163 apparatus: the policy ablation needs a condition in which the tools carry
// nothing but their own schemas. These three tests pin the only two states the
// flag can produce and, more importantly, pin that its ABSENCE changes nothing —
// every existing invocation must stay byte-identical or M162's CALLABLE arm and
// M163's NEUTRAL arm would not be the same treatment.
test("initialize instructions default to identification plus the suite policy", () => {
  const repoRoot = "/tmp/example-repo";

  assert.equal(
    buildMcpServerInstructions(repoRoot),
    `Repo-bound vtrace MCP server for ${repoRoot}. Use tools/list to inspect available tools.\n\n${VTRACE_TOOL_SUITE_POLICY}`,
  );
  assert.equal(
    buildMcpServerInstructions(repoRoot, { suitePolicy: true }),
    buildMcpServerInstructions(repoRoot),
  );
});

test("suitePolicy:false drops the policy and keeps the server identification", () => {
  const repoRoot = "/tmp/example-repo";
  const suppressed = buildMcpServerInstructions(repoRoot, { suitePolicy: false });

  assert.equal(
    suppressed,
    `Repo-bound vtrace MCP server for ${repoRoot}. Use tools/list to inspect available tools.`,
  );
  // The model must still be able to tell WHICH repository answers, or the
  // tools-only arm would be missing information the other arms have for a
  // reason unrelated to policy.
  assert.ok(suppressed.includes(repoRoot));
  assert.ok(!suppressed.includes(VTRACE_TOOL_SUITE_POLICY));
  assert.ok(!suppressed.includes("Repository-intelligence workflow"));
});

test("--no-suite-policy suppresses the served policy without changing the tool surface", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    await initRepo({ repoPath: repoRoot });

    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mcp-test", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ];
    const args = ["--tools", "get_code_context,get_impact_graph"];

    const withPolicy = runMcpServerProcessWithMessages(repoRoot, messages, args);
    const withoutPolicy = runMcpServerProcessWithMessages(repoRoot, messages, [
      ...args,
      "--no-suite-policy",
    ]);

    const instructionsOf = (result: { responses: Record<string, unknown>[] }): string =>
      ((result.responses[0]?.result ?? {}) as { instructions?: string }).instructions ?? "";
    const toolNamesOf = (result: { responses: Record<string, unknown>[] }): string[] =>
      (((result.responses[1]?.result ?? {}) as { tools?: Array<{ name: string }> }).tools ?? [])
        .map((tool) => tool.name);

    assert.equal(withPolicy.exitCode, 0);
    assert.equal(withoutPolicy.exitCode, 0);
    assert.ok(instructionsOf(withPolicy).includes(VTRACE_TOOL_SUITE_POLICY));
    assert.ok(!instructionsOf(withoutPolicy).includes(VTRACE_TOOL_SUITE_POLICY));

    // The whole point of the arm: identical callable surface, different policy.
    // If the flag also changed which tools were served, A-vs-B would be
    // measuring availability again instead of policy.
    assert.deepEqual(toolNamesOf(withoutPolicy), ["get_code_context", "get_impact_graph"]);
    assert.deepEqual(toolNamesOf(withoutPolicy), toolNamesOf(withPolicy));
  });
});

test("stdio MCP server stays alive and emits no stdout before protocol traffic", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    await initRepo({ repoPath: repoRoot });

    const child = spawn(process.execPath, ["src/mcp/server.ts", "--repo", repoRoot], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(child.exitCode, null);
    assert.equal(Buffer.concat(stdoutChunks).toString("utf8"), "");
    assert.equal(Buffer.concat(stderrChunks).toString("utf8"), "");

    child.kill("SIGTERM");
    await waitForChildExit(child);
  });
});

test("chunked buffered MCP input drains without stack overflow and preserves response order", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const expectedServer = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const serverPromise = startMcpServer({
      repoPath: repoRoot,
      stdin,
      stdout,
    });

    stdout.on("data", (chunk) => {
      stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    });

    const encodedInput = Buffer.concat([
      encodeFramedJson({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
        },
      }),
      encodeFramedJson({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
      encodeFramedJson({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "index_status",
          arguments: {},
        },
      }),
    ]);

    for (let index = 0; index < encodedInput.length; index += 7) {
      stdin.write(encodedInput.subarray(index, Math.min(index + 7, encodedInput.length)));
    }

    stdin.end();
    const startup = await serverPromise;
    const responses = collectFramedResponses(Buffer.concat(stdoutChunks));
    const expectedSearchResponse = await expectedServer.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "jsonrpc:3:index_status",
      toolId: McpToolId.IndexStatus,
      input: {},
    });
    const [initializeResponse, listResponse, callResponse] = responses;
    const listResult = listResponse.result as { tools: Array<{ name: string }> };
    const callResult = callResponse.result as {
      isError: boolean;
      structuredContent: unknown;
    };

    assert.equal(startup.repoRoot, repoRoot);
    assert.deepEqual(
      responses.map((response) => response.id),
      [1, 2, 3],
    );
    assert.equal(
      (initializeResponse.result as { serverInfo: { name: string } }).serverInfo.name,
      "vtrace_rc1_mcp",
    );
    assert.deepEqual(
      listResult.tools.map((tool) => tool.name),
      EXPECTED_VISIBLE_TOOL_IDS,
    );
    assert.equal(callResult.isError, false);
    assert.deepEqual(callResult.structuredContent, expectedSearchResponse);
  });
});

test("chunked line-delimited MCP input is processed deterministically without framed transport", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const expectedServer = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const serverPromise = startMcpServer({
      repoPath: repoRoot,
      stdin,
      stdout,
    });

    stdout.on("data", (chunk) => {
      stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    });

    const encodedInput = Buffer.concat([
      encodeLineJson({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
        },
      }),
      encodeLineJson({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
      encodeLineJson({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "index_status",
          arguments: {},
        },
      }),
    ]);

    for (let index = 0; index < encodedInput.length; index += 5) {
      stdin.write(encodedInput.subarray(index, Math.min(index + 5, encodedInput.length)));
    }

    stdin.end();
    const startup = await serverPromise;
    const responses = collectLineResponses(Buffer.concat(stdoutChunks));
    const expectedSearchResponse = await expectedServer.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "jsonrpc:3:index_status",
      toolId: McpToolId.IndexStatus,
      input: {},
    });
    const [initializeResponse, listResponse, callResponse] = responses;
    const listResult = listResponse.result as { tools: Array<{ name: string }> };
    const callResult = callResponse.result as {
      isError: boolean;
      structuredContent: unknown;
    };

    assert.equal(startup.repoRoot, repoRoot);
    assert.deepEqual(
      responses.map((response) => response.id),
      [1, 2, 3],
    );
    assert.equal(
      (initializeResponse.result as { serverInfo: { name: string } }).serverInfo.name,
      "vtrace_rc1_mcp",
    );
    assert.deepEqual(
      listResult.tools.map((tool) => tool.name),
      EXPECTED_VISIBLE_TOOL_IDS,
    );
    assert.equal(callResult.isError, false);
    assert.deepEqual(callResult.structuredContent, expectedSearchResponse);
  });
});

test("local MCP server process startup succeeds for an uninitialized repo and stays quiet without protocol traffic", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const processResult = await runMcpServerProcess(repoRoot);

    assert.equal(processResult.exitCode, 0);
    assert.equal(processResult.stdout, "");
    assert.equal(processResult.stderr, "");
  });
});

test("index_repo delegates to the real indexing service and returns structured run output", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-index",
      toolId: McpToolId.IndexRepo,
      input: {},
    });

    assert.equal(response.result.ok, true);
    assert.equal(response.result.output.repoRoot, repoRoot);
    assert.equal(response.result.output.latestRunId, 2);
    assert.equal(response.result.output.readiness.status, "ready");
    assert.equal(response.result.output.indexSummary.totalFilesSuccessfullyIndexed, 5);
      assert.deepEqual(response.result.output.latestRun, {
        id: 2,
        previousRunId: 1,
        totalFiles: 5,
        totalSymbols: 12,
        fileChangeCounts: {
          added: 0,
          modified: 0,
          removed: 0,
          unchanged: 5,
        },
        symbolChangeCounts: {
          added: 0,
          modified: 0,
          removed: 0,
          unchanged: 12,
        },
      });
  });
});

test("index_repo preserves structured unsupported-file diagnostics", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    await mkdir(path.join(repoRoot, "frontend"), { recursive: true });
    await writeFile(path.join(repoRoot, "frontend", "eslint.config.js"), "export default [];\n");
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-index-unsupported",
      toolId: McpToolId.IndexRepo,
      input: { mode: "incremental" },
    });

    assert.equal(response.result.ok, true);
    assert.equal(response.result.output.indexSummary.totalSkippedUnregisteredLanguage, 1);
    assert.deepEqual(
      response.result.output.fileOutcomes.find((file) => file.path === "frontend/eslint.config.js"),
      {
        path: "frontend/eslint.config.js",
        language: "javascript",
        status: "unregistered_language",
        diagnostics: [],
        error: {
          code: "unregistered_language",
          message: "No parser registered for language: javascript",
          filePath: "frontend/eslint.config.js",
          language: "javascript",
        },
      },
    );
  });
});

test("M156: index_repo succeeds on a parse failure and reports degraded coverage", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    await writeFile(path.join(repoRoot, "src", "script.py"), "def broken(:\n");
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-index-failure",
      toolId: McpToolId.IndexRepo,
      input: { mode: "incremental" },
    });

    // §45: the repository remains usable, and the consumer is told — in the same
    // response — that its coverage is no longer complete.
    assert.equal(response.result.ok, true);
    assert.equal(response.result.output.indexReadiness.ready, true);
    assert.equal(response.result.output.indexReadiness.coverageComplete, false);
    assert.equal(response.result.output.indexReadiness.failedFiles, 1);

    // The failed file keeps its structured identity in the bounded outcome view.
    assert.equal(response.result.output.outcomes.counts.failed, 1);
    const failure = response.result.output.fileOutcomes
      .find((outcome: { path: string }) => outcome.path === "src/script.py");
    assert.equal(failure.language, "python");
    assert.equal(failure.status, "parse_failed");
    assert.match(failure.error.message, /Parser failed: SyntaxError:/);
  });
});

test("search_symbols delegates to the real retrieval service and returns deterministic candidates", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const request = {
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-search",
      toolId: McpToolId.SearchSymbols,
      input: {
        query: "readUser",
        maxResults: 4,
      },
    } as const;

    const first = await server.handleRequest(request);
    const second = await server.handleRequest(request);

    assert.deepEqual(second, first);
    assert.equal(first.result.ok, true);
    assert.equal(first.result.output.query, "readUser");
    assert.equal(first.result.output.candidates[0]?.localName, "readUser");
    assert.equal(first.result.output.candidates[0]?.filePath, "src/service.ts");
    assert.equal(first.result.output.candidates[0]?.matches[0]?.field, "local_name");
  });
});

test("route_query delegates to the real routing service and returns deterministic structured output", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const request = {
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-route",
      toolId: McpToolId.RouteQuery,
      input: {
        query: "Session",
        maxResults: 4,
      },
    } as const;

    const first = await server.handleRequest(request);
    const second = await server.handleRequest(request);

    assert.deepEqual(second, first);
    assert.equal(first.result.ok, true);
    assert.equal(first.result.output.query, "Session");
    assert.equal(first.result.output.intent, "explain");
    assert.equal(first.result.output.classification.explanation.reasonKind, "no_rule_match_fallback");
    assert.equal(first.result.output.profile.id, "explain");
    assert.equal(first.result.output.rerankedResults.length > 0, true);
    assert.equal(first.result.output.rerankedResults[0]?.localName, "Session");
    assert.equal(first.result.output.rerankedResults[0]?.graphContributions.length >= 0, true);
  });
});

test("build_capsule delegates to the real capsule pipeline and returns deterministic capsule output", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const request = {
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-capsule",
      toolId: McpToolId.BuildCapsule,
      input: {
        query: "SessionManager",
        maxBudgetCharacters: 5_000,
      },
    } as const;

    const first = await server.handleRequest(request);
    const second = await server.handleRequest(request);

    assert.deepEqual(second, first);
    assert.equal(first.result.ok, true);
    assert.equal(first.result.output.query, "SessionManager");
    assert.equal(first.result.output.intent, "explain");
    assert.equal(first.result.output.routingProfile.id, "explain");
    assert.equal(first.result.output.capsuleProfile.id, "explain_stable");
    assert.equal(first.result.output.capsule.pivots.length > 0, true);
    assert.equal(
      first.result.output.capsule.pivots.some((item) => {
        return item.content.source?.includes("class SessionManager") ?? false;
      }),
      true,
    );
    assert.equal(
      first.result.output.capsule.pivots.length
        + first.result.output.capsule.supportingItems.length > 0,
      true,
    );
  });
});

test("build_handoff delegates to the real handoff builder and returns deterministic payload output", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const request = {
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-handoff",
      toolId: McpToolId.BuildHandoff,
      input: {
        query: "Session",
      },
    } as const;

    const first = await server.handleRequest(request);
    const second = await server.handleRequest(request);

    assert.deepEqual(second, first);
    assert.equal(first.result.ok, true);
    assert.deepEqual(first.result.output.schema, {
      name: "vtrace.external_handoff",
      version: "1.0.0",
    });
    assert.equal(first.result.output.query, "Session");
    assert.equal(first.result.output.selectedIntent, "explain");
    assert.equal(first.result.output.provenance.repoRoot, repoRoot);
    assert.equal(first.result.output.provenance.sourceRunId, 1);
    assert.equal(first.result.output.trust.capsuleStaleness, null);
    assert.equal(first.result.output.capsule.items.length > 0, true);
    assert.equal(
      first.result.output.capsule.items.some((item) => item.content.mode === "full"),
      true,
    );
  });
});

test.skip("get_context_capsule is a thin visible wrapper over the existing capsule pipeline", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const visible = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-visible-capsule",
      toolId: McpToolId.GetContextCapsule,
      input: {
        query: "Session",
        maxBudgetCharacters: 5_000,
      },
    });
    const legacy = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-legacy-capsule",
      toolId: McpToolId.BuildCapsule,
      input: {
        query: "Session",
        maxBudgetCharacters: 5_000,
      },
    });

    assert.equal(visible.result.ok, true);
    assert.equal(legacy.result.ok, true);
    // get_context_capsule additionally persists a capsule manifest and surfaces
    // its id (plus the additive, estimated `accounting` block); build_capsule
    // does neither. Aside from those fields the visible tool is still a thin
    // wrapper over the same pipeline output.
    const {
      capsuleManifestId,
      accounting,
      capsuleEngine,
      inspectFirst,
      productContext,
      ...visibleWithoutExtras
    } = visible.result.output;
    assert.deepEqual(visibleWithoutExtras, legacy.result.output);
    assert.equal(typeof capsuleManifestId, "string");
    assert.equal((capsuleManifestId as string).length > 0, true);
    assert.equal(productContext.responseVersion, 2);
    // The visible product tool also records the engine selection on the default
    // v1 path; build_capsule (legacy) does not.
    assert.deepEqual(capsuleEngine, {
      requested: "default",
      effective: "v1",
      fallbackReason: null,
      compactInspectFirst: false,
    });
    assert.equal(inspectFirst, null);
    // Accounting is present on the visible product tool and well-formed.
    assert.notEqual(accounting, undefined);
    assert.equal(accounting.method, "chars_div_4");
    assert.equal(typeof accounting.estimatedOutputTokens, "number");
  });
});

test("get_context_capsule persists a manifest that check_capsule_staleness resolves, and reindex makes it stale", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const capsuleRequest = {
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-capsule-manifest",
      toolId: McpToolId.GetContextCapsule,
      input: { query: "Session", maxBudgetCharacters: 5_000 },
    } as const;

    const capsule = await server.handleRequest(capsuleRequest);
    assert.equal(capsule.result.ok, true);
    const manifestId = capsule.result.output.capsuleManifestId;
    assert.equal(typeof manifestId, "string");
    assert.equal((manifestId as string).length > 0, true);

    // Deterministic: the same call returns the same persisted manifest id.
    const capsuleAgain = await server.handleRequest({
      ...capsuleRequest,
      requestId: "req-capsule-manifest-again",
    });
    assert.equal(capsuleAgain.result.output.capsuleManifestId, manifestId);

    // The manifest resolves against the run it was built from instead of
    // returning "Capsule manifest not found".
    const fresh = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-staleness-fresh",
      toolId: McpToolId.CheckCapsuleStaleness,
      input: { manifestId, comparisonRunId: 1 },
    });
    assert.equal(fresh.result.ok, true);
    assert.equal(fresh.result.output.status, "fresh");

    // Modify a linked source file and reindex into a new comparison run.
    await writeFile(
      path.join(repoRoot, "src", "session.ts"),
      [
        "export type Session = string;",
        "",
        "export class SessionManager {",
        "  createSession(accountId: string, label: string): Session {",
        "    return `${accountId}:${label}`;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const reindex = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-reindex-stale",
      toolId: McpToolId.IndexRepo,
      input: {},
    });
    assert.equal(reindex.result.ok, true);
    const comparisonRunId = reindex.result.output.latestRunId;
    assert.equal(comparisonRunId > 1, true);

    const stale = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-staleness-stale",
      toolId: McpToolId.CheckCapsuleStaleness,
      input: { manifestId, comparisonRunId },
    });
    assert.equal(stale.result.ok, true);
    assert.equal(stale.result.output.status, "stale");
  });
});

test.skip("get_context_capsule default path stays on the Capsule v1 engine", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-capsule-default-v1",
      toolId: McpToolId.GetContextCapsule,
      input: { query: "Session", maxBudgetCharacters: 5_000 },
    });

    assert.equal(response.result.ok, true);
    // The default response is the unchanged v1 shape: the routed capsule, no v2
    // discriminator, no v2 product block.
    assert.equal(response.result.output.engine, undefined);
    assert.equal(response.result.output.capsuleV2, undefined);
    assert.notEqual(response.result.output.capsule, undefined);
    assert.notEqual(response.result.output.classification, undefined);
    assertOutputConformsToToolSchema(McpToolId.GetContextCapsule, response.result.output);
  });
});

test.skip("get_context_capsule capsule_engine=v2 returns the bounded Capsule v2 product response", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const request = {
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-capsule-v2",
      toolId: McpToolId.GetContextCapsule,
      input: {
        query: "modify createSession in SessionManager to accept a label",
        capsule_engine: "v2",
        capsule_intent: "modify",
        capsule_budget_tokens: 8_000,
      },
    } as const;

    const first = await server.handleRequest(request);
    const second = await server.handleRequest({ ...request, requestId: "req-capsule-v2-again" });

    assert.equal(first.result.ok, true);
    // Output is deterministic across repeated calls, except for the additive
    // `accounting` block whose `latencyMs` is wall-clock and inherently varies.
    const { accounting: firstAccounting, ...firstStable } = first.result.output;
    const { accounting: secondAccounting, ...secondStable } = second.result.output;
    assert.deepEqual(normalizeProductContextTiming(secondStable), normalizeProductContextTiming(firstStable));
    // Everything in accounting except latency is deterministic too.
    assert.notEqual(firstAccounting, undefined);
    assert.notEqual(secondAccounting, undefined);
    assert.deepEqual(
      { ...secondAccounting, latencyMs: 0 },
      { ...firstAccounting, latencyMs: 0 },
    );

    const output = first.result.output;
    assert.equal(output.engine, "v2");
    assert.equal(output.query, "modify createSession in SessionManager to accept a label");

    const capsuleV2 = output.capsuleV2;
    assert.notEqual(capsuleV2, undefined);
    assert.equal(capsuleV2.engine, "v2");
    assert.equal(capsuleV2.experimental, true);
    assert.equal(capsuleV2.intent, "modify");
    assert.equal(typeof capsuleV2.budget.maxTokens, "number");
    assert.equal(capsuleV2.budget.maxTokens, 8_000);
    assert.equal(typeof capsuleV2.budget.estimatedTokens, "number");

    // At least one pivot on the small TS fixture, carrying the product fields.
    assert.equal(capsuleV2.pivots.length >= 1, true);
    const pivot = capsuleV2.pivots[0];
    assert.equal(pivot.role, "pivot");
    assert.equal(typeof pivot.path, "string");
    assert.equal(pivot.path.length > 0, true);
    assert.equal(typeof pivot.fqName, "string");
    assert.equal(typeof pivot.roleReason, "string");
    assert.equal(typeof pivot.contentMode, "string");
    assert.equal(pivot.evidence.length > 0, true);

    // Output is bounded: no item carries content beyond the requested budget.
    const totalTokens = [...capsuleV2.pivots, ...capsuleV2.support]
      .reduce((sum, item) => sum + item.estimatedTokens, 0);
    assert.equal(totalTokens <= capsuleV2.budget.maxTokens, true);

    // VEXP-shaped enrichment: query, summary counts, warnings array, and a
    // role-glyph digest that an agent can read as the first-call answer.
    assert.equal(capsuleV2.query, "modify createSession in SessionManager to accept a label");
    assert.equal(capsuleV2.summary.pivotCount, capsuleV2.pivots.length);
    assert.equal(capsuleV2.summary.supportCount, capsuleV2.support.length);
    assert.equal(typeof capsuleV2.summary.skeletonCount, "number");
    assert.equal(Array.isArray(capsuleV2.warnings), true);
    assert.equal(typeof capsuleV2.digest, "string");
    assert.equal(capsuleV2.digest.includes("● pivot"), true);
    assert.equal(capsuleV2.digest.includes("budget:"), true);

    // Manifest persistence is consistent with the v1 path: a deterministic id.
    assert.equal(typeof output.capsuleManifestId, "string");
    assert.equal((output.capsuleManifestId as string).length > 0, true);

    assertOutputConformsToToolSchema(McpToolId.GetContextCapsule, output);
  });
});

test.skip("get_context_capsule accepts the camelCase capsuleEngine alias for v2", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-capsule-v2-camel",
      toolId: McpToolId.GetContextCapsule,
      input: {
        query: "modify createSession in SessionManager to accept a label",
        capsuleEngine: "v2",
      },
    });

    assert.equal(response.result.ok, true);
    assert.equal(response.result.output.engine, "v2");
    assert.equal(response.result.output.capsuleV2.engine, "v2");
    // Default intent when none is supplied is auto-resolved (never "auto" itself).
    assert.notEqual(response.result.output.capsuleV2.intent, "auto");
  });
});

test.skip("get_context_capsule explicit v2 records effectiveCapsuleEngine=v2 and inspect-first", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-capsule-v2-selection",
      toolId: McpToolId.GetContextCapsule,
      input: {
        query: "modify createSession in SessionManager to accept a label",
        capsule_engine: "v2",
        capsule_intent: "modify",
      },
    });

    assert.equal(response.result.ok, true);
    const output = response.result.output;
    assert.equal(output.engine, "v2");
    assert.equal(output.capsuleEngine.requested, "v2");
    assert.equal(output.capsuleEngine.effective, "v2");
    assert.equal(output.capsuleEngine.fallbackReason, null);
    // The fixture has at least one pivot, so inspect-first is produced and tracked.
    assert.notEqual(output.inspectFirst, null);
    assert.equal(output.capsuleEngine.compactInspectFirst, true);
    assert.ok(["high", "medium", "low"].includes(output.inspectFirst.confidence));
    assert.equal(typeof output.inspectFirst.likelyFirst.path, "string");
    assertOutputConformsToToolSchema(McpToolId.GetContextCapsule, output);
  });
});

test.skip("get_context_capsule explicit v1 and legacy resolve to effectiveCapsuleEngine=v1", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });

    for (const requested of ["v1", "legacy"] as const) {
      const response = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: `req-capsule-${requested}`,
        toolId: McpToolId.GetContextCapsule,
        input: { query: "Session", capsule_engine: requested },
      });

      assert.equal(response.result.ok, true);
      const output = response.result.output;
      // Explicit v1/legacy stays on the backward-compatible v1 shape (no `engine`
      // discriminator, the flat capsule) but records the request distinctly.
      assert.equal(output.engine, undefined);
      assert.notEqual(output.capsule, undefined);
      assert.equal(output.capsuleEngine.requested, requested);
      assert.equal(output.capsuleEngine.effective, "v1");
      assert.equal(output.capsuleEngine.fallbackReason, null);
      assert.equal(output.capsuleEngine.compactInspectFirst, false);
      assert.equal(output.inspectFirst, null);
      assertOutputConformsToToolSchema(McpToolId.GetContextCapsule, output);
    }
  });
});

test.skip("get_context_capsule v2 no_context stays v2 and does not trigger a fallback", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-capsule-v2-nocontext",
      toolId: McpToolId.GetContextCapsule,
      input: {
        // A query with no plausible pivot in the fixture, to exercise the v2
        // no_context path. The invariant holds regardless of what the engine finds.
        query: "zzqqx nonexistent unrelated gibberish symbol wXyZ",
        capsule_engine: "v2",
      },
    });

    assert.equal(response.result.ok, true);
    const output = response.result.output;
    // no_context is a real v2 result, never a fallback: effective stays v2 and
    // there is no fallback reason.
    assert.equal(output.capsuleEngine.effective, "v2");
    assert.equal(output.capsuleEngine.fallbackReason, null);
    if (output.capsuleV2.actualMode === "no_context") {
      assert.equal(typeof output.capsuleV2.reason, "string");
      assert.equal(output.capsuleEngine.compactInspectFirst, false);
      assert.equal(output.inspectFirst, null);
    }
    assertOutputConformsToToolSchema(McpToolId.GetContextCapsule, output);
  });
});

test("get_context_capsule v2 persists a manifest that check_capsule_staleness resolves", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const capsule = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-capsule-v2-manifest",
      toolId: McpToolId.GetContextCapsule,
      input: {
        query: "modify createSession in SessionManager to accept a label",
        capsule_engine: "v2",
        capsule_intent: "modify",
      },
    });
    assert.equal(capsule.result.ok, true);
    const manifestId = capsule.result.output.capsuleManifestId;
    assert.equal(typeof manifestId, "string");
    assert.equal((manifestId as string).length > 0, true);

    // The v2 manifest resolves against the run it was built from (fresh), exactly
    // like the v1 path — not "Capsule manifest not found".
    const fresh = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-capsule-v2-staleness",
      toolId: McpToolId.CheckCapsuleStaleness,
      input: { manifestId, comparisonRunId: 1 },
    });
    assert.equal(fresh.result.ok, true);
    assert.equal(fresh.result.output.status, "fresh");
  });
});

const V2_PIPELINE_QUERY = "modify createSession in SessionManager to accept a label";

test("run_pipeline default path exposes the unversioned capsule response", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-default-v1",
      toolId: McpToolId.RunPipeline,
      input: { detail: "debug", query: V2_PIPELINE_QUERY },
    });

    assert.equal(response.result.ok, true);
    const output = response.result.output;
    // The default response carries no v2 discriminator and no v2 product block.
    assert.equal(output.contextEngine, undefined);
    assert.equal(output.capsuleV2, undefined);
    assert.equal(output.capsuleV2ManifestId, undefined);
    // The v1 sections are all present.
    assert.notEqual(output.context, undefined);
    assert.notEqual(output.impact, undefined);
    assert.notEqual(output.flow, undefined);
    assert.notEqual(output.memory, undefined);
    assert.notEqual(output.rules, undefined);
    assert.notEqual(output.deferred, undefined);
    assertOutputConformsToToolSchema(McpToolId.RunPipeline, output);
  });
});

test.skip("run_pipeline capsule_engine=v2 returns a bounded Capsule v2 section and preserves the v1 sections", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-v2",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: V2_PIPELINE_QUERY,
        capsule_engine: "v2",
        capsule_intent: "modify",
        capsule_budget_tokens: 8_000,
      },
    });

    assert.equal(response.result.ok, true);
    const output = response.result.output;

    // v2 discriminator + product block are present.
    assert.equal(output.contextEngine, "v2");
    const capsuleV2 = output.capsuleV2;
    assert.notEqual(capsuleV2, undefined);
    assert.equal(capsuleV2.engine, "v2");
    assert.equal(capsuleV2.experimental, true);
    assert.equal(capsuleV2.intent, "modify");
    assert.equal(capsuleV2.budget.maxTokens, 8_000);

    // At least one pivot on the TS fixture, carrying the product fields.
    assert.equal(capsuleV2.pivots.length >= 1, true);
    const pivot = capsuleV2.pivots[0];
    assert.equal(pivot.role, "pivot");
    assert.equal(typeof pivot.fqName, "string");
    assert.equal(pivot.evidence.length > 0, true);

    // Output is bounded: nothing exceeds the requested budget.
    const totalTokens = [...capsuleV2.pivots, ...capsuleV2.support]
      .reduce((sum, item) => sum + item.estimatedTokens, 0);
    assert.equal(totalTokens <= capsuleV2.budget.maxTokens, true);

    // The v1 sections are not accidentally removed by the v2 opt-in.
    assert.notEqual(output.context, undefined);
    assert.notEqual(output.impact, undefined);
    assert.notEqual(output.flow, undefined);
    assert.notEqual(output.memory, undefined);
    assert.notEqual(output.rules, undefined);
    assert.notEqual(output.deferred, undefined);

    // Manifest persistence is consistent with the v1 path: a deterministic id.
    assert.equal(typeof output.capsuleV2ManifestId, "string");
    assert.equal((output.capsuleV2ManifestId as string).length > 0, true);

    // The unified engine selection records requested/effective and compact
    // inspect-first; the v2 section also carries the inspect-first guidance block.
    assert.equal(output.capsuleEngine.requested, "v2");
    assert.equal(output.capsuleEngine.effective, "v2");
    assert.equal(output.capsuleEngine.fallbackReason, null);
    assert.equal(output.capsuleEngine.compactInspectFirst, true);
    assert.notEqual(output.inspectFirst, null);
    assert.ok(["high", "medium", "low"].includes(output.inspectFirst.confidence));

    assertOutputConformsToToolSchema(McpToolId.RunPipeline, output);
  });
});

test.skip("get_code_context inherits capsule_engine=v2 by delegating to run_pipeline", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-code-context-v2",
      toolId: McpToolId.GetCodeContext,
      input: {
        detail: "debug",
        query: V2_PIPELINE_QUERY,
        capsule_engine: "v2",
        capsule_intent: "modify",
      },
    });

    assert.equal(response.result.ok, true);
    const output = response.result.output;
    assert.equal(output.contextEngine, "v2");
    assert.equal(output.capsuleV2.engine, "v2");
    assert.equal(output.capsuleV2.pivots.length >= 1, true);
    // The v2 engine selection passes through the run_pipeline delegation intact.
    assert.equal(output.capsuleEngine.requested, "v2");
    assert.equal(output.capsuleEngine.effective, "v2");
    assert.equal(output.capsuleEngine.compactInspectFirst, true);
    assertOutputConformsToToolSchema(McpToolId.GetCodeContext, output);
  });
});

test("M119 primary product paths share task, selection, roles, estimator, and worktree identity", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });
    const input = {
      task: V2_PIPELINE_QUERY,
      query: V2_PIPELINE_QUERY,
      capsule_engine: "v2",
      capsule_intent: "modify",
      capsule_budget_tokens: 8_000,
    } as const;
    const code = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "m119-code", toolId: McpToolId.GetCodeContext, input: { ...input, detail: "debug" } });
    const capsule = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "m119-capsule", toolId: McpToolId.GetContextCapsule, input: { ...input, detail: "debug" } });
    const pipeline = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "m119-pipeline", toolId: McpToolId.RunPipeline, input: { ...input, detail: "debug" } });
    for (const result of [code, capsule, pipeline]) assert.equal(result.result.ok, true);
    const parity = (response: any) => {
      const product = response.result.output.productContext;
      return {
        responseVersion: product.responseVersion,
        taskHash: product.taskHash,
        intent: product.intent,
        capsuleMode: product.capsuleMode,
        leadPivot: product.leadPivot,
        selectedFileHash: product.selectedFileHash,
        identities: product.items.map((item: any) => ({ stableId: item.stableId, path: item.path, symbol: item.symbol, roles: item.roles })),
        estimator: [product.accounting.estimateMethod, product.accounting.estimateExact],
        worktree: [product.repository.repositoryId, product.repository.worktreeId, product.repository.headCommit],
        freshness: [product.freshness.status, product.freshness.reason],
      };
    };
    assert.deepEqual(parity(code), parity(capsule));
    assert.deepEqual(parity(code), parity(pipeline));
  });
});

test("M130 product tools share one source-bearing representation and each stay inside their envelope", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });
    const input = {
      task: V2_PIPELINE_QUERY,
      query: V2_PIPELINE_QUERY,
      capsule_intent: "modify",
      max_tokens: 6_000,
    } as const;
    const code = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "m130-code", toolId: McpToolId.GetCodeContext, input: { ...input, detail: "debug" } });
    const capsule = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "m130-capsule", toolId: McpToolId.GetContextCapsule, input: { ...input, detail: "debug" } });
    const pipeline = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "m130-pipeline", toolId: McpToolId.RunPipeline, input: { ...input, detail: "debug" } });
    for (const result of [code, capsule, pipeline]) assert.equal(result.result.ok, true);

    const outputs = [code, capsule, pipeline].map((response: any) => response.result.output);

    // One authoritative selection and one authoritative rendered context.
    for (const output of outputs.slice(1)) {
      assert.equal(output.productContext.modelVisibleContext, outputs[0].productContext.modelVisibleContext);
      assert.equal(output.productContext.selectedFileHash, outputs[0].productContext.selectedFileHash);
      assert.equal(output.productContext.taskHash, outputs[0].productContext.taskHash);
      assert.equal(output.productContext.leadPivot, outputs[0].productContext.leadPivot);
      assert.deepEqual(
        output.productContext.items.map((item: any) => [item.id, item.path, item.roles, item.contentMode]),
        outputs[0].productContext.items.map((item: any) => [item.id, item.path, item.roles, item.contentMode]),
      );
      assert.deepEqual(output.productContext.accounting, outputs[0].productContext.accounting);
      assert.deepEqual(output.productContext.roleCounts, outputs[0].productContext.roleCounts);
    }

    // max_tokens bounds the model-visible context, and every tool declares and
    // respects its own complete-response envelope.
    for (const output of outputs) {
      assert.equal(output.responseBudget.requested_context_tokens, 6_000);
      assert.equal(output.responseBudget.total_response_token_ceiling, 7_000);
      assert.equal(output.responseBudget.estimated_model_visible_tokens <= 6_000, true);
      assert.equal(output.responseBudget.within_envelope, true);
      assert.equal(output.responseBudget.serialized_response_characters, JSON.stringify(output).length);
    }

    // No wrapper reconstructs a second source-bearing context: the pivot body is
    // rendered once, and the capsule manifest references it instead of copying it.
    for (const output of outputs) {
      for (const item of output.capsuleResult.pivots ?? []) {
        assert.equal(item.source, null, "capsuleResult must not carry a second copy of the source");
      }
      for (const item of output.productContext.items) {
        assert.equal(item.content, undefined, "items must reference the rendered body, not repeat it");
      }
    }
  });
});

test("unversioned product tools share one capsule selection and model-visible context", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });
    const task = "modify createSession and identify its related tests and dependencies";
    const common = {
      task,
      preset: "modify",
      max_tokens: 6_000,
      include_tests: true,
      include_file_content: true,
    };
    const [run, code, capsule] = await Promise.all([
      server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "m127-run",
        toolId: McpToolId.RunPipeline,
        input: { ...common, detail: "debug" },
      }),
      server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "m127-code",
        toolId: McpToolId.GetCodeContext,
        input: { ...common, auto_refresh: "never", detail: "debug" },
      }),
      server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "m127-capsule",
        toolId: McpToolId.GetContextCapsule,
        input: { ...common, detail: "debug" },
      }),
    ]);

    for (const response of [run, code, capsule]) assert.equal(response.result.ok, true);
    const contexts = [run, code, capsule].map((response) => response.result.output.productContext);
    const authority = (context: typeof contexts[number]) => ({
      taskHash: context.taskHash,
      capsuleMode: context.capsuleMode,
      leadPivot: context.leadPivot,
      selectedFileHash: context.selectedFileHash,
      roles: context.items.map((item: { path?: string; symbol?: string; roles: string[] }) => ({
        path: item.path,
        symbol: item.symbol,
        roles: item.roles,
      })),
      modelVisibleContext: context.modelVisibleContext,
    });
    assert.deepEqual(authority(contexts[1]), authority(contexts[0]));
    assert.deepEqual(authority(contexts[2]), authority(contexts[0]));
    for (const response of [run, code, capsule]) {
      assert.equal(response.result.output.capsule.implementation, "hybrid");
      assert.equal(response.result.output.capsule.retrievalVersion, "product-retrieval-v2");
      assert.equal(response.result.output.runtime.capsuleImplementation, "hybrid");
      assert.equal(response.result.output.capsuleEngine, undefined);
    }
  });
});

test("MCP hides the old selector from schemas, accepts deprecated aliases, and rejects v1", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });
    for (const toolId of [McpToolId.RunPipeline, McpToolId.GetCodeContext, McpToolId.GetContextCapsule]) {
      const definition = server.lookupTool(toolId).tool!;
      assert.equal(definition.metadata.inputSchema.properties?.capsule_engine, undefined);
      assert.equal(definition.metadata.inputSchema.properties?.capsuleEngine, undefined);

      for (const alias of ["default", "v2"]) {
        const response = await server.handleRequest({
          schema: MCP_SERVER_SCHEMA,
          requestId: `m127-${toolId}-${alias}`,
          toolId,
          input: { task: "modify createSession", capsule_engine: alias, detail: "debug" },
        });
        assert.equal(response.result.ok, true);
        assert.match(response.result.output.capsule.compatibilityWarnings[0], /deprecated and ignored/);
      }

      const rejected = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: `m127-${toolId}-v1`,
        toolId,
        input: { task: "modify createSession", capsule_engine: "v1" },
      });
      assert.equal(rejected.result.ok, false);
      assert.equal(rejected.result.error.code, McpErrorCode.InvalidRequest);
      assert.equal(rejected.result.error.details.error, "unsupported_legacy_capsule_engine");
    }
  });
});

test("index_status exposes runtime provenance for stale-process diagnosis", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "m127-index-runtime",
      toolId: McpToolId.IndexStatus,
      input: {},
    });
    assert.equal(response.result.ok, true);
    const runtime = (response.result as any).output.runtime;
    assert.equal(runtime.capsuleImplementation, "hybrid");
    assert.equal(runtime.retrievalImplementation, "product-retrieval-v2");
    assert.match(runtime.executablePath, /bin\/vtrace$/);
  });
});

test.skip("get_code_context default delegation records effectiveCapsuleEngine=v1", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-code-context-default-engine",
      toolId: McpToolId.GetCodeContext,
      input: { detail: "debug", query: "where is createSession" },
    });

    assert.equal(response.result.ok, true);
    const output = response.result.output;
    assert.equal(output.contextEngine, undefined);
    assert.deepEqual(output.capsuleEngine, {
      requested: "default",
      effective: "v1",
      fallbackReason: null,
      compactInspectFirst: false,
    });
    assertOutputConformsToToolSchema(McpToolId.GetCodeContext, output);
  });
});

test("get_code_context inherits run_pipeline impact source excerpts when the impact section fires", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    // A refactor task naming one focal symbol with indexed reverse dependents
    // fires the run_pipeline impact section. get_code_context delegates to
    // run_pipeline, so the bounded per-dependent excerpts must come through the
    // delegation intact rather than forcing the agent into follow-up Reads.
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-code-context-impact-excerpts",
      toolId: McpToolId.GetCodeContext,
      input: {
        detail: "debug",
        query: "refactor createSession",
        intent: "refactor",
      },
    });

    assert.equal(response.result.ok, true);
    const output = response.result.output;
    assert.equal(output.impact.included, true, "expected the impact section to fire");

    const dependents = (output.impact.topDependents ?? []).filter(
      (node: { distance: number }) => node.distance > 0,
    );
    assert.equal(dependents.length >= 1, true, "expected at least one impact dependent");
    const enriched = dependents.find(
      (node: { sourceExcerpt?: unknown }) => node.sourceExcerpt != null,
    ) as { sourceExcerpt: { text: string; reason: string; filePath: string } } | undefined;
    assert.ok(enriched, "expected at least one dependent to carry an inherited inline excerpt");
    assert.equal(enriched.sourceExcerpt.text.split("\n").length <= 12, true);
    assert.equal(
      ["symbol_span", "signature", "fallback_symbol_window"].includes(enriched.sourceExcerpt.reason),
      true,
      `inherited excerpt reason must never claim an exact edge site: ${enriched.sourceExcerpt.reason}`,
    );
    assertOutputConformsToToolSchema(McpToolId.GetCodeContext, output);
  });
});

test("get_code_context inherits unified intent metadata and impact ungating from run_pipeline", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    // Explicit impact phrasing (no refactor preset, no magic "what breaks") must
    // ungate impact through the shared normalized intent — and get_code_context,
    // being a thin run_pipeline alias, must surface the same decision and the new
    // metadata fields, schema-conformant.
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-code-context-impact-intent",
      toolId: McpToolId.GetCodeContext,
      input: { detail: "debug", query: "what is the impact of changing createSession" },
    });

    assert.equal(response.result.ok, true);
    const output = response.result.output;
    assert.equal(output.intent.resolvedIntent, "impact");
    assert.equal(output.intent.intentSource, "phrase");
    assert.equal(output.intent.impactEligible, true);
    assert.equal(output.intent.impactSkipReason, null);
    assert.equal(typeof output.intent.flowEligible, "boolean");
    assert.equal(
      output.intent.flowEligible
        ? output.intent.flowSkipReason === null
        : output.intent.flowSkipReason === "unsupported_query_shape",
      true,
    );
    assert.equal(output.diagnostics.intent.resolvedIntent, "impact");
    assert.equal(output.impact.included, true);
    assert.equal(output.impact.triggerReason, "impact_phrase");
    assertOutputConformsToToolSchema(McpToolId.GetCodeContext, output);
  });
});

// A well-formed `accounting` block: deterministic chars/4 figures, a measured
// latency, and the explicit naive-full-file baseline. Shared by the tests below.
function assertWellFormedAccounting(accounting: unknown): void {
  assert.notEqual(accounting, undefined);
  const block = accounting as Record<string, unknown>;
  assert.equal(block.method, "chars_div_4");
  assert.equal(typeof block.baseline, "string");
  assert.equal((block.baseline as string).length > 0, true);
  assert.equal(typeof block.latencyMs, "number");
  assert.equal((block.latencyMs as number) >= 0, true);
  assert.equal(typeof block.estimatedOutputTokens, "number");
  assert.equal((block.estimatedOutputTokens as number) > 0, true);
  assert.equal(typeof block.estimatedNaiveFullFileTokens, "number");
  assert.equal(typeof block.estimatedTokensSavedVsNaiveFullFile, "number");
  // Savings are clamped at 0 (never negative).
  assert.equal((block.estimatedTokensSavedVsNaiveFullFile as number) >= 0, true);
  assert.equal(typeof block.uniqueFilesCounted, "number");
}

test.skip("get_context_capsule v1 includes the deterministic accounting block", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-capsule-v1-accounting",
      toolId: McpToolId.GetContextCapsule,
      input: { query: "Session", maxBudgetCharacters: 5_000 },
    });

    assert.equal(response.result.ok, true);
    const output = response.result.output;
    // v1 shape is preserved; accounting is additive.
    assert.notEqual(output.capsule, undefined);
    assertWellFormedAccounting(output.accounting);
    // The naive baseline reflects the real fixture files the capsule touched.
    assert.equal(output.accounting.estimatedNaiveFullFileTokens > 0, true);
    assert.equal(output.accounting.uniqueFilesCounted >= 1, true);
    assertOutputConformsToToolSchema(McpToolId.GetContextCapsule, output);
  });
});

test.skip("get_context_capsule v2 includes the deterministic accounting block", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-capsule-v2-accounting",
      toolId: McpToolId.GetContextCapsule,
      input: {
        query: "modify createSession in SessionManager to accept a label",
        capsule_engine: "v2",
        capsule_intent: "modify",
      },
    });

    assert.equal(response.result.ok, true);
    const output = response.result.output;
    assert.equal(output.engine, "v2");
    assertWellFormedAccounting(output.accounting);
    assert.equal(output.accounting.uniqueFilesCounted >= 1, true);
    assertOutputConformsToToolSchema(McpToolId.GetContextCapsule, output);
  });
});

test("run_pipeline default path includes the deterministic accounting block", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-accounting",
      toolId: McpToolId.RunPipeline,
      input: { detail: "debug", query: V2_PIPELINE_QUERY },
    });

    assert.equal(response.result.ok, true);
    const output = response.result.output;
    // Default (v1-only) path: no v2 section, but accounting is present.
    assert.equal(output.contextEngine, undefined);
    assertWellFormedAccounting(output.accounting);
    assertOutputConformsToToolSchema(McpToolId.RunPipeline, output);
  });
});

test.skip("run_pipeline v2 opt-in includes the deterministic accounting block", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-v2-accounting",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: V2_PIPELINE_QUERY,
        capsule_engine: "v2",
        capsule_intent: "modify",
      },
    });

    assert.equal(response.result.ok, true);
    const output = response.result.output;
    assert.equal(output.contextEngine, "v2");
    assertWellFormedAccounting(output.accounting);
    assertOutputConformsToToolSchema(McpToolId.RunPipeline, output);
  });
});

test("get_code_context returns accounting through delegation to run_pipeline", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-code-context-accounting",
      toolId: McpToolId.GetCodeContext,
      input: { detail: "debug", task: "where is createSession", maxBudgetCharacters: 5_000 },
    });

    assert.equal(response.result.ok, true);
    const output = response.result.output;
    assertWellFormedAccounting(output.accounting);
    assertOutputConformsToToolSchema(McpToolId.GetCodeContext, output);
  });
});

test.skip("run_pipeline accepts the camelCase capsuleEngine alias and is deterministic across calls", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const request = {
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-v2-camel",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: V2_PIPELINE_QUERY,
        capsuleEngine: "v2",
        capsuleIntent: "modify",
      },
    } as const;

    const first = await server.handleRequest(request);
    const second = await server.handleRequest({ ...request, requestId: "req-run-pipeline-v2-camel-again" });

    assert.equal(first.result.ok, true);
    assert.equal(second.result.ok, true);
    assert.equal(first.result.output.contextEngine, "v2");
    assert.equal(first.result.output.capsuleV2.engine, "v2");
    // The v2 product section is deterministic across repeated calls.
    assert.deepEqual(second.result.output.capsuleV2, first.result.output.capsuleV2);
    assert.equal(second.result.output.capsuleV2ManifestId, first.result.output.capsuleV2ManifestId);
  });
});

test.skip("run_pipeline capsule_engine=v2 persists a manifest resolvable by check_capsule_staleness", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const pipeline = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-v2-manifest",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: V2_PIPELINE_QUERY,
        capsule_engine: "v2",
        capsule_intent: "modify",
      },
    });
    assert.equal(pipeline.result.ok, true);
    const manifestId = pipeline.result.output.capsuleV2ManifestId;
    assert.equal(typeof manifestId, "string");
    assert.equal((manifestId as string).length > 0, true);

    const fresh = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-v2-staleness",
      toolId: McpToolId.CheckCapsuleStaleness,
      input: { manifestId, comparisonRunId: 1 },
    });
    assert.equal(fresh.result.ok, true);
    assert.equal(fresh.result.output.status, "fresh");
  });
});

test.skip("run_pipeline capsule_engine=v2 is rejected for a multi-repo workspace", async () => {
  await withTwoRepoWorkspace(async ({ alphaRoot }) => {
    const server = createMcpServer({
      context: { repoRoot: alphaRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-v2-multi-repo",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: V2_PIPELINE_QUERY,
        capsule_engine: "v2",
      },
    });

    assert.equal(response.result.ok, false);
    assert.equal(response.result.error.code, McpErrorCode.InvalidRequest);
    assert.match(response.result.error.message, /single-repo only/);
  });
});

test("run_pipeline persists a manifest surfaced in context.capsuleManifestId and resolvable by check_capsule_staleness", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const pipeline = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-manifest",
      toolId: McpToolId.RunPipeline,
      input: { detail: "debug", query: "Session" },
    });
    assert.equal(pipeline.result.ok, true);
    const manifestId = pipeline.result.output.context.capsuleManifestId;
    assert.equal(typeof manifestId, "string");
    assert.equal((manifestId as string).length > 0, true);

    const fresh = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-staleness",
      toolId: McpToolId.CheckCapsuleStaleness,
      input: { manifestId, comparisonRunId: 1 },
    });
    assert.equal(fresh.result.ok, true);
    assert.equal(fresh.result.output.status, "fresh");
  });
});

test.skip("single-repo context capsule output remains untagged without a workspace config", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-single-repo-no-alias",
      toolId: McpToolId.GetContextCapsule,
      input: {
        query: "Session",
        maxBudgetCharacters: 5_000,
      },
    });

    assert.equal(response.result.ok, true);
    assert.equal("workspace" in response.result.output, false);
    assert.equal("retrieval" in response.result.output, false);
    assert.equal(
      response.result.output.capsule.pivots.some((item) => "repoAlias" in item),
      false,
    );
  });
});

test("multi-repo workspace config loads two repos and index_status reports both", async () => {
  await withTwoRepoWorkspace(async ({ alphaRoot }) => {
    const server = createMcpServer({
      context: { repoRoot: alphaRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-workspace-index-status",
      toolId: McpToolId.IndexStatus,
      input: {},
    });

    assert.equal(response.result.ok, true);
    assert.deepEqual(response.result.output.workspace.selectedRepos, ["alpha", "beta"]);
    assert.deepEqual(
      response.result.output.repos.map((repo) => [repo.repoAlias, repo.initialized, repo.readiness?.status]),
      [
        ["alpha", true, "ready"],
        ["beta", true, "ready"],
      ],
    );
  });
});

test("multi-repo tools reject invalid repo aliases explicitly", async () => {
  await withTwoRepoWorkspace(async ({ alphaRoot }) => {
    const server = createMcpServer({
      context: { repoRoot: alphaRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-workspace-invalid-alias",
      toolId: McpToolId.GetContextCapsule,
      input: {
        query: "Session",
        repos: ["missing"],
      },
    });

    assert.equal(response.result.ok, false);
    assert.equal(response.result.error.code, McpErrorCode.InvalidRequest);
    assert.deepEqual(response.result.error.details?.unknownRepos, ["missing"]);
    assert.deepEqual(response.result.error.details?.availableRepos, ["alpha", "beta"]);
  });
});

test.skip("get_context_capsule tags multi-repo capsule items and honors repo filtering", async () => {
  await withTwoRepoWorkspace(async ({ alphaRoot }) => {
    const server = createMcpServer({
      context: { repoRoot: alphaRoot },
    });

    const allRepos = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-workspace-capsule-all",
      toolId: McpToolId.GetContextCapsule,
      input: {
        query: "Session",
        maxBudgetCharacters: 10_000,
      },
    });
    const betaOnly = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-workspace-capsule-beta",
      toolId: McpToolId.GetContextCapsule,
      input: {
        query: "Session",
        repos: ["beta"],
        maxBudgetCharacters: 10_000,
      },
    });

    assert.equal(allRepos.result.ok, true);
    assert.equal(betaOnly.result.ok, true);
    const allItems = [
      ...allRepos.result.output.capsule.pivots,
      ...allRepos.result.output.capsule.supportingItems,
    ];
    const aliases = new Set(allItems.map((item) => item.repoAlias));
    assert.equal(aliases.has("alpha"), true);
    assert.equal(aliases.has("beta"), true);
    assert.equal(allItems.every((item) => typeof item.repoAlias === "string"), true);
    assert.deepEqual(betaOnly.result.output.workspace.selectedRepos, ["beta"]);
    assert.equal(
      [
        ...betaOnly.result.output.capsule.pivots,
        ...betaOnly.result.output.capsule.supportingItems,
      ].every((item) => item.repoAlias === "beta"),
      true,
    );
  });
});

test.skip("multi-repo capsule merge order is deterministic with repo alias tie-breakers", async () => {
  await withTwoRepoWorkspace(async ({ alphaRoot }) => {
    const server = createMcpServer({
      context: { repoRoot: alphaRoot },
    });
    const request = {
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-workspace-deterministic-merge",
      toolId: McpToolId.GetContextCapsule,
      input: {
        query: "Session",
        maxBudgetCharacters: 10_000,
      },
    } as const;

    const first = await server.handleRequest(request);
    const second = await server.handleRequest(request);

    assert.deepEqual(second.result, first.result);
    assert.equal(first.result.ok, true);
    assert.deepEqual(first.result.output.retrieval.mergeSummary.tieBreakers, [
      "finalScore desc",
      "lexicalScore desc",
      "repoAlias asc",
      "filePath asc",
      "fqName asc",
      "symbolId asc",
    ]);
    const firstAlpha = first.result.output.capsule.pivots.findIndex((item) => item.repoAlias === "alpha");
    const firstBeta = first.result.output.capsule.pivots.findIndex((item) => item.repoAlias === "beta");
    assert.equal(firstAlpha >= 0, true);
    assert.equal(firstBeta >= 0, true);
    assert.equal(firstAlpha < firstBeta, true);
  });
});

test.skip("run_pipeline reports selected repos, per-repo diagnostics, and skips cross-repo impact honestly", async () => {
  await withTwoRepoWorkspace(async ({ alphaRoot }) => {
    const server = createMcpServer({
      context: { repoRoot: alphaRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-workspace-run-pipeline",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: "rename createSession",
        maxBudgetCharacters: 10_000,
      },
    });

    assert.equal(response.result.ok, true);
    assert.deepEqual(response.result.output.request.selectedRepos, ["alpha", "beta"]);
    assert.deepEqual(response.result.output.diagnostics.retrieval.selectedRepos, ["alpha", "beta"]);
    assert.deepEqual(
      response.result.output.diagnostics.retrieval.perRepo.map((repo) => [repo.repoAlias, repo.ready]),
      [
        ["alpha", true],
        ["beta", true],
      ],
    );
    assert.equal(response.result.output.context.pivots.every((item) => typeof item.repoAlias === "string"), true);
    assert.equal(response.result.output.impact.included, false);
    assert.equal(response.result.output.impact.skipReason, "cross_repo_impact_unsupported");
    assert.equal(response.result.output.diagnostics.impact.skipReason, "cross_repo_impact_unsupported");
  });
});

test.skip("run_pipeline repos filter limits context retrieval to selected aliases", async () => {
  await withTwoRepoWorkspace(async ({ alphaRoot }) => {
    const server = createMcpServer({
      context: { repoRoot: alphaRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-workspace-run-pipeline-filtered",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: "Session",
        repos: ["beta"],
        maxBudgetCharacters: 10_000,
      },
    });

    assert.equal(response.result.ok, true);
    assert.deepEqual(response.result.output.request.selectedRepos, ["beta"]);
    assert.deepEqual(
      response.result.output.diagnostics.retrieval.perRepo.map((repo) => repo.repoAlias),
      ["beta"],
    );
    assert.equal(
      [
        ...response.result.output.context.pivots,
        ...response.result.output.context.supports,
      ].every((item) => item.repoAlias === "beta"),
      true,
    );
  });
});

test.skip("run_pipeline vNext returns a compact orchestration result that differs materially from get_context_capsule", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const pipeline = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-vnext-shape",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: "Session",
        maxBudgetCharacters: 5_000,
      },
    });
    const capsule = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-context-capsule-shape",
      toolId: McpToolId.GetContextCapsule,
      input: {
        query: "Session",
        maxBudgetCharacters: 5_000,
      },
    });

    assert.equal(pipeline.result.ok, true);
    assert.equal(capsule.result.ok, true);
    // Top-level orchestration keys must be present and distinct from the capsule shape.
    assert.deepEqual(
      Object.keys(pipeline.result.output).sort(),
      [
        "accounting",
        "capsuleEngine",
        "context",
        "deferred",
        "diagnostics",
        "flow",
        "impact",
        "intent",
        "memory",
        "productContext",
        "request",
        "rules",
        "savedObservation",
        "schemaVersion",
        "taskSummary",
      ],
    );
    // The engine selection is recorded on every run, including the default
    // v1-only path, so the engine choice is never silent.
    assert.deepEqual(pipeline.result.output.capsuleEngine, {
      requested: "default",
      effective: "v1",
      fallbackReason: null,
      compactInspectFirst: false,
    });
    assert.equal(pipeline.result.output.schemaVersion, "run_pipeline.vnext/1");
    assert.equal("capsule" in pipeline.result.output, false);
    assert.equal("classification" in pipeline.result.output, false);
    // get_context_capsule preserves the original flat capsule shape.
    assert.equal("capsule" in capsule.result.output, true);
    assert.equal("impact" in capsule.result.output, false);
    assert.equal("memory" in capsule.result.output, false);
  });
});

test("get_code_context delegates to the same implementation and output as run_pipeline", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const input = {
      task: "where is createSession",
      maxBudgetCharacters: 5_000,
    };
    const getCodeContext = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-code-context-alias",
      toolId: McpToolId.GetCodeContext,
      input: { ...input, detail: "debug" },
    });
    const runPipeline = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-alias-target",
      toolId: McpToolId.RunPipeline,
      input: { ...input, detail: "debug" },
    });

    assert.equal(getCodeContext.result.ok, true);
    assert.equal(runPipeline.result.ok, true);
    // Same implementation, so outputs match modulo the additive `accounting`
    // block whose `latencyMs` is wall-clock and varies between the two calls.
    const normalizeAccounting = (result: typeof getCodeContext.result) => ({
      ...result,
      output: {
        ...normalizeProductContextTiming(result.output),
        accounting: undefined,
      },
    });
    // `responseBudget` measures the emitted bytes, which legitimately differ:
    // get_code_context overwrites freshness after delegating. Product parity is
    // asserted over everything else, plus both staying inside their envelope.
    const normalizeFreshnessAndAccounting = (result: typeof getCodeContext.result) => ({
      ...normalizeAccounting(result),
      output: {
        ...normalizeAccounting(result).output,
        responseBudget: undefined,
        diagnostics: {
          ...normalizeAccounting(result).output.diagnostics,
          indexFreshness: undefined,
        },
      },
    });
    assert.deepEqual(
      normalizeFreshnessAndAccounting(getCodeContext.result),
      normalizeFreshnessAndAccounting(runPipeline.result),
    );
    assert.equal(getCodeContext.result.output.diagnostics.indexFreshness.status, "fresh");
    assert.equal(getCodeContext.result.output.diagnostics.indexFreshness.action, "none");
    assert.equal(getCodeContext.result.output.responseBudget.within_envelope, true);
    assert.equal(runPipeline.result.output.responseBudget.within_envelope, true);
    assert.equal(
      getCodeContext.result.output.responseBudget.requested_context_tokens,
      runPipeline.result.output.responseBudget.requested_context_tokens,
    );
  });
});

test("run_pipeline auto-intent resolves refactor preset for rename phrasing and explore preset for explain-style queries", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const refactor = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-auto-refactor",
      toolId: McpToolId.RunPipeline,
      input: { detail: "debug", query: "rename createSession" },
    });
    const explore = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-auto-explore",
      toolId: McpToolId.RunPipeline,
      input: { detail: "debug", query: "where is createSession" },
    });

    assert.equal(refactor.result.ok, true);
    assert.equal(refactor.result.output.intent.requested, "auto");
    assert.equal(refactor.result.output.intent.selected, "refactor");
    assert.equal(refactor.result.output.intent.source, "auto_phrase_trigger");
    assert.equal(refactor.result.output.intent.mappedQueryIntent, "refactor");
    assert.equal(refactor.result.output.taskSummary.editGoal, "refactor_api");

    assert.equal(explore.result.ok, true);
    assert.equal(explore.result.output.intent.requested, "auto");
    assert.equal(explore.result.output.intent.selected, "explore");
    assert.equal(explore.result.output.intent.source, "auto_classifier");
    assert.equal(explore.result.output.intent.mappedQueryIntent, "explain");
    assert.equal(explore.result.output.taskSummary.editGoal, "explore_codebase");
  });
});

test("run_pipeline presets materially change capsule profile, include-tests default, and impact eligibility", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const presets = ["explore", "debug", "modify", "refactor"] as const;
    const responses = await Promise.all(
      presets.map((preset) =>
        server.handleRequest({
          schema: MCP_SERVER_SCHEMA,
          requestId: `req-run-pipeline-preset-${preset}`,
          toolId: McpToolId.RunPipeline,
          input: {
            detail: "debug",
            query: "createSession",
            intent: preset,
            maxBudgetCharacters: 5_000,
          },
        })
      ),
    );
    const byPreset = new Map(presets.map((preset, index) => [preset, responses[index]!] as const));

    for (const preset of presets) {
      const response = byPreset.get(preset)!;
      assert.equal(response.result.ok, true);
      assert.equal(response.result.output.intent.requested, preset);
      assert.equal(response.result.output.intent.selected, preset);
      assert.equal(response.result.output.intent.requestedPreset, preset);
      assert.equal(response.result.output.intent.selectedPreset, preset);
      assert.equal(typeof response.result.output.intent.reason, "string");
      assert.equal(response.result.output.intent.reason.length > 0, true);
      assert.equal(response.result.output.intent.source, "explicit");
    }

    assert.equal(byPreset.get("debug")!.result.output.request.includeTests, true);
    assert.equal(byPreset.get("explore")!.result.output.request.includeTests, false);
    assert.equal(byPreset.get("modify")!.result.output.request.includeTests, false);
    assert.equal(byPreset.get("refactor")!.result.output.request.includeTests, false);

    // Capsule profile must differ across presets because the preset maps to a QueryIntent.
    const profilesByPreset = Object.fromEntries(
      presets.map((preset) => [preset, byPreset.get(preset)!.result.output.context.capsuleProfileId]),
    );
    assert.equal(profilesByPreset.explore, "explain_stable");
    assert.equal(profilesByPreset.debug, "debug_tight");
    assert.equal(profilesByPreset.modify, "feature_balanced");
    assert.equal(profilesByPreset.refactor, "refactor_structural");

    // Impact must be eligible under refactor and skipped with an explicit reason otherwise.
    assert.equal(byPreset.get("refactor")!.result.output.impact.included, true);
    assert.equal(byPreset.get("refactor")!.result.output.impact.triggerReason, "refactor_preset");
    assert.notEqual(byPreset.get("refactor")!.result.output.impact.focalSymbol, null);

    const explore = byPreset.get("explore")!.result.output.impact;
    assert.equal(explore.included, false);
    assert.equal(explore.skipReason, "not_requested_by_intent");
    assert.equal(explore.focalSymbol, null);

    const modify = byPreset.get("modify")!.result.output.impact;
    assert.equal(modify.included, false);
    assert.equal(modify.skipReason, "not_requested_by_intent");

    const debug = byPreset.get("debug")!.result.output.impact;
    assert.equal(debug.included, false);
    assert.equal(debug.skipReason, "not_requested_by_intent");
  });
});

test("run_pipeline interprets product max_tokens as tokens while preserving the character-budget alias", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const productFacing = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-product-facing-input",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        task: "debug why createSession fails",
        preset: "debug",
        max_tokens: 4_000,
        include_tests: false,
        include_file_content: false,
      },
    });
    const legacy = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-legacy-input",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: "debug why createSession fails",
        intent: "debug",
        maxBudgetCharacters: 4_000,
      },
    });

    assert.equal(productFacing.result.ok, true);
    assert.equal(legacy.result.ok, true);
    assert.equal(productFacing.result.output.request.query, "debug why createSession fails");
    assert.equal(productFacing.result.output.request.task, "debug why createSession fails");
    assert.equal(productFacing.result.output.request.maxBudgetCharacters, 16_000);
    assert.equal(legacy.result.output.request.maxBudgetCharacters, 4_000);
    assert.equal(productFacing.result.output.request.includeTests, false);
    assert.equal(productFacing.result.output.request.includeFileContent, false);
    assert.equal(productFacing.result.output.intent.selectedPreset, "debug");
    assert.equal(legacy.result.output.intent.selectedPreset, "debug");
  });
});

test("run_pipeline includes compact impact section for refactor tasks with a clear focal symbol", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-impact-included",
      toolId: McpToolId.RunPipeline,
      input: { detail: "debug", query: "rename createSession" },
    });

    assert.equal(response.result.ok, true);
    const impact = response.result.output.impact;
    assert.equal(impact.included, true);
    assert.equal(impact.skipReason, null);
    assert.equal(impact.triggerReason, "refactor_preset");
    assert.equal(impact.selectionSource, "top_pivot_task_mention");
    assert.equal(impact.focalSymbol?.fqName, "src/session.ts::SessionManager.createSession");
    assert.deepEqual(impact.summary, {
      dependentSymbolCount: 4,
      dependentFileCount: 2,
      maxDepth: 2,
      maxObservedDistance: 2,
      // M139: the legacy count above mixes containment with real consumers, so
      // the truthful split travels beside it. Here 4 "dependents" resolve to one
      // structural container and zero proven callers.
      consumers: {
        exactCallerCount: 0,
        exactReferenceCount: 0,
        potentialCallerCount: 1,
        structuralContainerCount: 1,
        outgoingDependencyCount: 1,
        reverseReachableSymbolCount: 4,
      },
    });
    assert.equal(impact.topDependents?.length, 4);
    assert.equal(impact.impactRef, "vexp:impact:src/session.ts::SessionManager.createSession");
    // impact section must not leak the full graph contract.
    assert.equal("nodes" in impact, false);
    assert.equal("edges" in impact, false);
    assert.equal("view" in impact, false);
  });
});

test("run_pipeline skips impact with explicit reason when no focal symbol can be resolved", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-impact-ambiguous",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        detail: "debug",
        query: "what breaks if I change the public api for session code",
      },
    });

    assert.equal(response.result.ok, true);
    const impact = response.result.output.impact;
    assert.equal(impact.included, false);
    // Phrase-trigger forces refactor preset; focal selection then fails.
    assert.equal(response.result.output.intent.selected, "refactor");
    assert.equal(impact.triggerReason, "refactor_preset");
    assert.equal(impact.skipReason, "no_focal_symbol");
    assert.equal(impact.focalSymbol, null);
    assert.equal(response.result.output.diagnostics.impact.skipReason, "no_focal_symbol");
  });
});

test("run_pipeline reports multiple_focal_symbols when impact trigger mentions more than one candidate", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-impact-multiple",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        detail: "debug",
        task: "what breaks if I change createSession and readSession",
        preset: "refactor",
      },
    });

    assert.equal(response.result.ok, true);
    assert.equal(response.result.output.impact.included, false);
    assert.equal(response.result.output.impact.skipReason, "multiple_focal_symbols");
    assert.equal(response.result.output.impact.matchedCandidates >= 2, true);
    assert.equal(response.result.output.diagnostics.impact.skipReason, "multiple_focal_symbols");
  });
});

test("run_pipeline memory section includes durable observations when they match and records skip reasons otherwise", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    // First call saves an observation that becomes durable memory evidence.
    await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-seed-memory",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: "rename createSession",
        sessionId: "session-alpha",
        saveObservation: true,
      },
    });

    const withMemory = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-memory-hit",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        detail: "debug",
        query: "rename createSession",
        sessionId: "session-alpha",
      },
    });

    assert.equal(withMemory.result.ok, true);
    const memory = withMemory.result.output.memory;
    // Durable memory should see the prior observation.
    assert.equal(memory.durable.included, true);
    assert.equal(memory.durable.skipReason, null);
    assert.equal(memory.durable.matchedCount >= 1, true);
    assert.equal(memory.durable.topObservations[0]?.kind, "tool_call");
    // Session evidence should be present because the session now has observations.
    assert.equal(memory.session.included, true);
    assert.equal(memory.session.skipReason, null);
    assert.equal(memory.session.sessionId, "session-alpha");
    assert.equal(memory.session.observationCount >= 1, true);
    // Diagnostics mirror the section decisions.
    assert.equal(withMemory.result.output.diagnostics.memory.sessionIncluded, true);
    assert.equal(withMemory.result.output.diagnostics.memory.durableIncluded, true);

    // Separate call without sessionId and without matching memory.
    const noSession = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-memory-no-session",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        detail: "debug",
        query: "rename createSession",
      },
    });
    assert.equal(noSession.result.ok, true);
    assert.equal(noSession.result.output.memory.session.included, false);
    assert.equal(noSession.result.output.memory.session.skipReason, "no_session_requested");
    assert.equal(noSession.result.output.diagnostics.memory.sessionSkipReason, "no_session_requested");
  });
});

test("run_pipeline memory can surface relevant compressed session summaries", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const db = openIndexerDatabase(initialized.paths.dbPath);
const stores = new ProductStoreLease(db, initialized.paths.dbPath).write;

    try {
      await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-compressed-seed",
        toolId: McpToolId.RunPipeline,
        input: {
          detail: "debug",
          query: "rename createSession memory lifecycle",
          sessionId: "session-compress",
        },
      });
      const session = stores.session.query(`
        SELECT last_activity_at_ms AS lastActivityAtMs
        FROM sessions
        WHERE session_id = 'session-compress'
      `).get() as { lastActivityAtMs: number };
      const compressed = compressInactiveSessions(stores, {
        repoRoot,
        nowMs: session.lastActivityAtMs + DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS,
      });

      assert.equal(compressed.compressedSummaries.length, 1);

      const response = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-compressed-memory",
        toolId: McpToolId.RunPipeline,
        input: {
          detail: "debug",
          query: "rename createSession memory lifecycle",
          includeMemory: true,
        },
      });

      assert.equal(response.result.ok, true);
      assert.equal(response.result.output.memory.durable.included, true);
      assert.equal(
        response.result.output.memory.durable.topObservations.some((observation) => {
          return observation.observationId === compressed.compressedSummaries[0]?.summaryObservationId;
        }),
        true,
      );
    } finally {
      db.close();
    }
  });
});

test("run_pipeline memory can surface relevant consolidated passive summaries", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const db = openIndexerDatabase(initialized.paths.dbPath);
const stores = new ProductStoreLease(db, initialized.paths.dbPath).write;
    const sourceRunId = listIndexRuns(db).at(-1)?.id;

    try {
      const currentContext = await resolveCurrentObservationContext(repoRoot);
      for (const [index, createdAtMs] of [100, 120, 140].entries()) {
        persistObservation(stores, {
          repoRoot,
          sessionId: "session-consolidated-memory",
          kind: ObservationKind.ToolCall,
          source: ObservationSource.McpAuto,
          toolName: "run_pipeline",
          summary: `Built repeated lifecycle context ${index}`,
          body: `tool=run_pipeline\nquery=rename createSession lifecycle memory\npivot_count=1\nsupport_count=2\ncall=${index}`,
          queryText: "rename createSession lifecycle memory",
          intent: "refactor",
          sourceRunId,
          scope: ObservationScope.IndexState,
          origin: ObservationOrigin.AutomaticCapture,
          provenance: buildObservationProvenance({
            context: currentContext,
            toolName: "run_pipeline",
            queryText: "rename createSession lifecycle memory",
            semanticOptions: { intent: "refactor" },
            resultValue: { call: index },
          }),
          createdAtMs,
          linkedFilePaths: ["src/session.ts"],
        });
      }

      const consolidated = consolidatePassiveObservationsForSession(stores, {
        sessionId: "session-consolidated-memory",
        nowMs: 500,
      });

      assert.equal(consolidated?.consolidatedObservationIds.length, 1);

      const response = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-consolidated-memory",
        toolId: McpToolId.RunPipeline,
        input: {
          detail: "debug",
          query: "rename createSession lifecycle memory",
          includeMemory: true,
        },
      });

      assert.equal(response.result.ok, true);
      assert.equal(response.result.output.memory.durable.included, true);
      assert.equal(
        response.result.output.memory.durable.topObservations.some((observation) => {
          return observation.observationId === consolidated?.consolidatedObservationIds[0];
        }),
        true,
      );
    } finally {
      db.close();
    }
  });
});

test("run_pipeline explore preset de-emphasizes durable memory unless includeMemory=true", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    // Seed a durable observation via a non-explore call.
    await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-seed-explore-memory",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: "rename createSession",
        sessionId: "session-gamma",
        saveObservation: true,
      },
    });

    const exploreSkipped = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-explore-memory-skipped",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: "createSession",
        intent: "explore",
      },
    });
    assert.equal(exploreSkipped.result.ok, true);
    assert.equal(exploreSkipped.result.output.memory.durable.included, false);
    assert.equal(exploreSkipped.result.output.memory.durable.skipReason, "intent_deemphasized");

    const exploreForced = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-explore-memory-forced",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: "createSession",
        intent: "explore",
        includeMemory: true,
      },
    });
    assert.equal(exploreForced.result.ok, true);
    assert.equal(
      exploreForced.result.output.memory.durable.included
      || exploreForced.result.output.memory.durable.skipReason === "no_matches",
      true,
    );
  });
});

test("run_pipeline returns explicit retrieval diagnostics for empty candidate and unsupported-query cases", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const noCandidates = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-no-candidates",
      toolId: McpToolId.RunPipeline,
      input: { detail: "debug", query: "definitely_missing_pipeline_symbol" },
    });
    const unsupported = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-unsupported-shape",
      toolId: McpToolId.RunPipeline,
      input: { detail: "debug", query: "!!! ???" },
    });

    assert.equal(noCandidates.result.ok, true);
    assert.equal(noCandidates.result.output.context.included, false);
    assert.equal(noCandidates.result.output.context.skipReason, "no_candidates");
    assert.equal(noCandidates.result.output.diagnostics.retrieval.finalReason, "no_candidates");
    assert.equal(
      noCandidates.result.output.diagnostics.retrieval.search.normalizedQuery,
      "definitely_missing_pipeline_symbol",
    );
    assert.ok(
      noCandidates.result.output.diagnostics.retrieval.search.identifierTerms.includes(
        "definitely_missing_pipeline_symbol",
      ),
    );
    assert.equal(noCandidates.result.output.diagnostics.retrieval.search.laneResults.lexical, 0);
    assert.equal(noCandidates.result.output.diagnostics.retrieval.search.candidateFilesConsidered, 0);
    assert.equal(noCandidates.result.output.diagnostics.retrieval.search.fallbackAttempted, true);
    assert.equal(
      noCandidates.result.output.diagnostics.retrieval.search.fallbackReason,
      "primary_lexical_no_hits",
    );
    assert.equal(noCandidates.result.output.diagnostics.retrieval.search.finalReason, "no_candidates");

    assert.equal(unsupported.result.ok, true);
    assert.equal(unsupported.result.output.context.skipReason, "unsupported_query_shape");
    assert.equal(unsupported.result.output.diagnostics.retrieval.finalReason, "unsupported_query_shape");
  });
});

test("run_pipeline authoritative selection avoids a divergent relaxed-assembly fallback", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const db = openIndexerDatabase(initialized.paths.dbPath);
const stores = new ProductStoreLease(db, initialized.paths.dbPath).write;

    try {
      const fallbackBudget = findRunPipelineFallbackBudget(db, initialized.repoRoot, "Session");
      assert.notEqual(fallbackBudget, null);

      const recovered = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-recovered",
        toolId: McpToolId.RunPipeline,
        input: {
          detail: "debug",
          detail: "debug",
          query: "Session",
          maxBudgetCharacters: fallbackBudget,
        },
      });

      assert.equal(recovered.result.ok, true);
      const retrieval = recovered.result.output.diagnostics.retrieval;
      assert.equal(retrieval.initialReason, null);
      assert.equal(retrieval.fallbackApplied, false);
      assert.equal(retrieval.fallbackMode, null);
      assert.equal(retrieval.fallbackRecovered, false);
      assert.equal(retrieval.finalReason, null);
      assert.equal(recovered.result.output.context.included, true);
      assert.equal(recovered.result.output.context.itemCount > 0, true);
    } finally {
      db.close();
    }
  });
});

test("run_pipeline deferred placeholders cover context, impact, session, and durable memory when included", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    // Seed memory/session evidence under a refactor-style query.
    await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-seed-deferred",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: "rename createSession",
        sessionId: "session-beta",
        saveObservation: true,
      },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-deferred",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        detail: "debug",
        query: "rename createSession",
        sessionId: "session-beta",
      },
    });

    assert.equal(response.result.ok, true);
    const deferred = response.result.output.deferred.items;
    const kinds = new Set(deferred.map((item) => item.kind));
    assert.equal(kinds.has("context_capsule"), true);
    assert.equal(kinds.has("impact_graph"), true);
    assert.equal(kinds.has("session_context"), true);
    assert.equal(kinds.has("durable_memory"), true);
    // Each deferred item must have a stable reference id and an MCP-tool pointer.
    for (const item of deferred) {
      assert.equal(typeof item.id, "string");
      assert.equal(item.id.length > 0, true);
      assert.equal(typeof item.suggestedTool, "string");
      assert.equal(item.suggestedTool.length > 0, true);
      assert.equal(item.expandable, true);
      assert.equal(item.expansionTool, "expand_vexp_ref");
    }
    assert.equal(response.result.output.diagnostics.deferredCount, deferred.length);
    assert.equal(response.result.output.deferred.expandable, true);
  });
});

test("run_pipeline and adjacent visible MCP outputs conform to their declared schemas", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const db = openIndexerDatabase(initialized.paths.dbPath);
const stores = new ProductStoreLease(db, initialized.paths.dbPath).write;

    try {
      createActiveProjectRule(stores.session, {
        repoRoot: initialized.repoRoot,
        summary: "When changing session creation, inspect the controller caller.",
        files: ["src/session.ts"],
        terms: ["rename", "createSession"],
        nowMs: 100,
      });
      for (const createdAtMs of [200, 300, 400]) {
        persistObservation(stores, {
          repoRoot: initialized.repoRoot,
          kind: ObservationKind.Decision,
          source: ObservationSource.Manual,
          summary: `Session creation convention ${createdAtMs}`,
          body: "When changing createSession behavior, keep controller integration tests in view.",
          queryText: "rename createSession controller tests",
          linkedFilePaths: ["src/session.ts"],
          createdAtMs,
        });
      }
      const generatedCandidates = generateProjectRuleCandidates(stores.session, {
        repoRoot: initialized.repoRoot,
        nowMs: 500,
      });
      assert.equal(generatedCandidates.created.length, 1);
    } finally {
      db.close();
    }

    const pipeline = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-schema-parity",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        detail: "debug",
        query: "rename createSession",
        maxBudgetCharacters: 5_000,
      },
    });
    assert.equal(pipeline.result.ok, true);
    assertOutputConformsToToolSchema(McpToolId.RunPipeline, pipeline.result.output);
    assert.deepEqual(
      Object.keys(pipeline.result.output.diagnostics.rules).sort(),
      [
        "activeIncluded",
        "activeMatchedCount",
        "activeTotalCount",
        "candidatePreviewCount",
        "candidateTotalCount",
        "disabledTotalCount",
        "dismissedTotalCount",
        "included",
        "staleTotalCount",
      ],
    );
    assert.equal(pipeline.result.output.diagnostics.rules.activeMatchedCount > 0, true);
    assert.equal(pipeline.result.output.diagnostics.rules.candidatePreviewCount > 0, true);
    assert.equal(pipeline.result.output.deferred.items.length > 0, true);

    const deferredHash = pipeline.result.output.deferred.items[0]?.hash;
    assert.equal(typeof deferredHash, "string");
    const expanded = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-expand-vexp-schema-parity",
      toolId: McpToolId.ExpandVexpRef,
      input: { hash: deferredHash },
    });
    assert.equal(expanded.result.ok, true);
    assert.equal(typeof expanded.result.output.resolved, "boolean");
    assertOutputConformsToToolSchema(McpToolId.ExpandVexpRef, expanded.result.output);

    const capsule = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-context-capsule-schema-parity",
      toolId: McpToolId.GetContextCapsule,
      input: {
        query: "Session",
        maxBudgetCharacters: 5_000,
      },
    });
    assert.equal(capsule.result.ok, true);
    assertOutputConformsToToolSchema(McpToolId.GetContextCapsule, capsule.result.output);

    await recordObservedFileChanges({
      repoRoot: initialized.repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: ["src/session.ts"],
      nowMs: 10_000,
    });

    const stalePipeline = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-stale-schema-parity",
      toolId: McpToolId.RunPipeline,
      input: {
        detail: "debug",
        query: "rename createSession",
        maxBudgetCharacters: 5_000,
      },
    });
    assert.equal(stalePipeline.result.ok, true);
    assert.equal(stalePipeline.result.output.diagnostics.freshness.state, "possibly_stale");
    assert.equal(
      stalePipeline.result.output.diagnostics.freshness.reasons.some((reason) => {
        return Array.isArray(reason.changedFiles) && reason.changedFiles.includes("src/session.ts");
      }),
      true,
    );
    assertOutputConformsToToolSchema(McpToolId.RunPipeline, stalePipeline.result.output);

    const indexStatus = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-index-status-schema-parity",
      toolId: McpToolId.IndexStatus,
      input: {},
    });
    assert.equal(indexStatus.result.ok, true);
    assertOutputConformsToToolSchema(McpToolId.IndexStatus, indexStatus.result.output);
  });
});

test("run_pipeline is deterministic across repeated calls for the same request", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    // First call primes auto-capture; compare the second and third calls so
    // the memory section has converged to its steady state.
    await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-det-prime",
      toolId: McpToolId.RunPipeline,
      input: { detail: "debug", query: "rename createSession" },
    });
    const first = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-det-first",
      toolId: McpToolId.RunPipeline,
      input: { detail: "debug", query: "rename createSession" },
    });
    const second = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-det-second",
      toolId: McpToolId.RunPipeline,
      input: { detail: "debug", query: "rename createSession" },
    });

    assert.equal(first.result.ok, true);
    assert.equal(second.result.ok, true);
    assert.deepEqual(second.result.output.intent, first.result.output.intent);
    assert.deepEqual(second.result.output.context, first.result.output.context);
    assert.deepEqual(second.result.output.impact, first.result.output.impact);
    assert.deepEqual(second.result.output.deferred, first.result.output.deferred);
  });
});

test("run_pipeline rejects unknown intent presets with invalid_request", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-bad-intent",
      toolId: McpToolId.RunPipeline,
      input: { detail: "debug", query: "Session", intent: "planetary" },
    });
    assert.equal(response.result.ok, false);
    assert.equal(response.result.error.code, "invalid_request");
    assert.match(response.result.error.message, /run_pipeline preset\/intent must be one of/);
  });
});

test("run_pipeline auto-captures a deduped tool-call observation on happy path and adds a session-bound observation when saveObservation=true", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const db = openIndexerDatabase(initialized.paths.dbPath);
const stores = new ProductStoreLease(db, initialized.paths.dbPath).write;

    try {
      const silentFirst = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-silent-1",
        toolId: McpToolId.RunPipeline,
        input: { detail: "debug", query: "Session" },
      });
      assert.equal(silentFirst.result.ok, true);
      assert.equal(silentFirst.result.output.savedObservation, null);
      assert.equal(countObservations(stores.session), 1);

      // Repeating the same silent call must dedupe — still exactly one observation.
      const silentSecond = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-silent-2",
        toolId: McpToolId.RunPipeline,
        input: { detail: "debug", query: "Session" },
      });
      assert.equal(silentSecond.result.ok, true);
      assert.equal(silentSecond.result.output.savedObservation, null);
      assert.equal(countObservations(stores.session), 1);

      const saved = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-saved",
        toolId: McpToolId.RunPipeline,
        input: {
          detail: "debug",
          query: "Session",
          sessionId: "pipeline-session",
          saveObservation: true,
        },
      });
      assert.equal(saved.result.ok, true);
      assert.equal(saved.result.output.savedObservation?.observation.toolName, "run_pipeline");
      assert.equal(saved.result.output.savedObservation?.observation.sessionId, "pipeline-session");
      // Auto-capture (no session) + session-bound auto-capture + explicit session-bound observation.
      assert.equal(countObservations(stores.session), 3);
      assert.equal(
        listObservations(stores.session).some((observation) => {
          return observation.toolName === "run_pipeline"
            && observation.source === "mcp_auto"
            && observation.sessionId === "pipeline-session";
        }),
        true,
      );
    } finally {
      db.close();
    }
  });
});

test("run_pipeline diagnostics include progressive observation nudges without persisting nudge rows", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const db = openIndexerDatabase(initialized.paths.dbPath);
const stores = new ProductStoreLease(db, initialized.paths.dbPath).write;

    try {
      const noSession = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-nudge-no-session",
        toolId: McpToolId.RunPipeline,
        input: { detail: "debug", query: "Session" },
      });
      assert.equal(noSession.result.ok, true);
      assert.equal(noSession.result.output.diagnostics.nudge.enabled, false);
      assert.equal(noSession.result.output.diagnostics.nudge.reason, "no_session");

      const first = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-nudge-1",
        toolId: McpToolId.RunPipeline,
        input: { detail: "debug", query: "createSession", sessionId: "nudge-session" },
      });
      assert.equal(first.result.ok, true);
      assert.equal(first.result.output.diagnostics.nudge.enabled, false);
      assert.equal(first.result.output.diagnostics.nudge.reason, "below_threshold");
      assert.equal(first.result.output.diagnostics.nudge.toolCallCount, 1);

      await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-nudge-2",
        toolId: McpToolId.RunPipeline,
        input: { detail: "debug", query: "loadSession", sessionId: "nudge-session" },
      });
      const third = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-nudge-3",
        toolId: McpToolId.RunPipeline,
        input: { detail: "debug", query: "readSession", sessionId: "nudge-session" },
      });

      assert.equal(third.result.ok, true);
      assert.equal(third.result.output.diagnostics.nudge.enabled, true);
      assert.equal(third.result.output.diagnostics.nudge.level, "full");
      assert.equal(third.result.output.diagnostics.nudge.reason, "no_durable_observation_after_tool_activity");
      assert.equal(third.result.output.diagnostics.nudge.toolCallCount, 3);
      assert.equal(third.result.output.diagnostics.nudge.nextNudgeAfterToolCallCount, 8);

      const afterThirdCount = countObservations(stores.session);
      assert.equal(
        listObservations(stores.session).filter((observation) => observation.sessionId === "nudge-session").length,
        3,
      );

      const saved = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-nudge-save",
        toolId: McpToolId.SaveObservation,
        input: {
          sessionId: "nudge-session",
          kind: "decision",
          summary: "Keep the current session persistence model.",
          body: "Explicit save_observation should self-disable future nudges.",
        },
      });
      assert.equal(saved.result.ok, true);
      assert.equal(countObservations(stores.session), afterThirdCount + 1);

      const afterDurable = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-nudge-after-durable",
        toolId: McpToolId.RunPipeline,
        input: { detail: "debug", query: "SessionManager", sessionId: "nudge-session" },
      });
      assert.equal(afterDurable.result.ok, true);
      assert.equal(afterDurable.result.output.diagnostics.nudge.enabled, false);
      assert.equal(afterDurable.result.output.diagnostics.nudge.reason, "durable_observation_exists");
      assert.equal(afterDurable.result.output.diagnostics.nudge.durableObservationCount, 1);
    } finally {
      db.close();
    }
  });
});

test("index_status and workspace_setup expose honest setup state before and after init", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const bound = await createRepoBoundMcpServer({ repoPath: repoRoot });
    const server = bound.server;

    const beforeIndexStatus = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-index-status-before",
      toolId: McpToolId.IndexStatus,
      input: {},
    });
    const inspected = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-workspace-setup-inspect",
      toolId: McpToolId.WorkspaceSetup,
      input: {},
    });
    const applied = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-workspace-setup-apply",
      toolId: McpToolId.WorkspaceSetup,
      input: {
        apply: true,
      },
    });
    const afterIndexStatus = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-index-status-after",
      toolId: McpToolId.IndexStatus,
      input: {},
    });

    assert.equal(beforeIndexStatus.result.ok, true);
    assert.equal(beforeIndexStatus.result.output.initialized, false);
    assert.equal(beforeIndexStatus.result.output.indexPresent, false);
    assert.equal(beforeIndexStatus.result.output.readiness, null);

    assert.equal(inspected.result.ok, true);
    assert.equal(inspected.result.output.mode, "inspect");
    assert.equal(inspected.result.output.status.initialized, false);
    assert.equal("workspace" in inspected.result.output.status, false);
    assert.equal(
      inspected.result.output.status.nextSteps.some((step) => step.includes("vtrace setup")),
      true,
    );

    assert.equal(applied.result.ok, true);
    assert.equal(applied.result.output.mode, "apply");
    assert.equal(applied.result.output.initAction, "initialized");
    assert.equal(applied.result.output.status.initialized, true);
    assert.equal(applied.result.output.status.claudeCode.matchesExpected, true);

    assert.equal(afterIndexStatus.result.ok, true);
    assert.equal(afterIndexStatus.result.output.initialized, true);
    assert.equal(afterIndexStatus.result.output.indexPresent, true);
    assert.equal(afterIndexStatus.result.output.readiness?.status, "ready");
    assert.equal(afterIndexStatus.result.output.freshness.state, "fresh");
    assert.equal(afterIndexStatus.result.output.freshness.isStale, false);
    assert.equal(afterIndexStatus.result.output.freshness.autoReindex.enabled, false);
    assert.equal(afterIndexStatus.result.output.freshness.autoReindex.state, "idle");
    assert.equal(afterIndexStatus.result.output.watcher.supported, true);
    assert.equal(afterIndexStatus.result.output.watcher.running, false);
    assert.equal(afterIndexStatus.result.output.watcher.autoReindexEnabled, false);
    assert.equal(afterIndexStatus.result.output.watcher.reindexState, "idle");
  });
});

test("index_status and run_pipeline diagnostics report watcher-observed stale file changes", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const bound = await createRepoBoundMcpServer({ repoPath: repoRoot });
    const server = bound.server;

    await recordObservedFileChanges({
      repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: ["src/session.ts"],
      nowMs: 5_000,
    });

    const status = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-index-status-stale-watcher",
      toolId: McpToolId.IndexStatus,
      input: {},
    });
    const pipeline = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-stale-watcher",
      toolId: McpToolId.RunPipeline,
      input: { detail: "debug", query: "session manager", maxBudgetCharacters: 4_000 },
    });

    assert.equal(status.result.ok, true);
    assert.equal(status.result.output.freshness.state, "possibly_stale");
    assert.equal(status.result.output.freshness.isStale, true);
    assert.equal(status.result.output.freshness.observedFileChanges.changedFileCount, 1);
    assert.deepEqual(status.result.output.freshness.observedFileChanges.changedFiles, ["src/session.ts"]);
    assert.equal(status.result.output.watcher.enabled, true);
    assert.equal(status.result.output.watcher.lastEventAtMs, 5_000);
    assert.equal(status.result.output.watcher.autoReindexEnabled, false);
    assert.equal(status.result.output.watcher.reindexState, "pending_changes");
    assert.equal(status.result.output.freshness.autoReindex.state, "pending_changes");

    assert.equal(pipeline.result.ok, true);
    assert.equal(pipeline.result.output.diagnostics.freshness.state, "possibly_stale");
    assert.equal(pipeline.result.output.diagnostics.indexFreshness.status, "stale");
    assert.equal(pipeline.result.output.diagnostics.indexFreshness.action, "none");
    assert.equal(pipeline.result.output.diagnostics.freshness.observedFileChanges.changedFiles[0], "src/session.ts");
    assert.equal(pipeline.result.output.diagnostics.freshness.autoReindex.state, "pending_changes");
  });
});

test("get_code_context returns fast stale envelope and does not auto-reindex when stale", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const bound = await createRepoBoundMcpServer({ repoPath: repoRoot });
    const server = bound.server;

    const statusBefore = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-index-status-before-get-code-context-stale",
      toolId: McpToolId.IndexStatus,
      input: {},
    });

    await recordObservedFileChanges({
      repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: ["src/session.ts"],
      nowMs: 6_000,
    });

    const startMs = Date.now();
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-code-context-stale-fast-fail",
      toolId: McpToolId.GetCodeContext,
      input: { detail: "debug", query: "session manager", maxBudgetCharacters: 4_000 },
    });
    const elapsedMs = Date.now() - startMs;

    const statusAfter = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-index-status-after-get-code-context-stale-fast-fail",
      toolId: McpToolId.IndexStatus,
      input: {},
    });

    assert.equal(response.result.ok, true);
    assert.equal(response.result.output.resolved, false);
    assert.equal(response.result.output.reason, "working_tree_changed");
    assert.equal(typeof response.result.output.message, "string");
    assert.ok(
      response.result.output.message.length > 0,
      "stale envelope message should be non-empty",
    );
    assert.match(response.result.output.message, /index_repo/);
    assert.match(response.result.output.message, /get_code_context/);
    assert.deepEqual(response.result.output.nextTool, {
      name: "index_repo",
      input: { repo_root: repoRoot },
    });
    assert.equal(response.result.output.diagnostics.indexFreshness.status, "stale");
    assert.equal(response.result.output.diagnostics.indexFreshness.reason, "working_tree_changed");
    assert.equal(response.result.output.diagnostics.indexFreshness.action, "call_index_repo");
    assert.equal("context" in response.result.output, false);
    assert.equal("capsule" in response.result.output, false);

    // Front door must not block on indexing work — be conservative but generous
    // enough for slow CI machines.
    assert.ok(
      elapsedMs < 30_000,
      `expected fast stale response, took ${elapsedMs}ms`,
    );

    // Index state must not be advanced by get_code_context's stale-fail path.
    assert.equal(statusBefore.result.ok, true);
    assert.equal(statusAfter.result.ok, true);
    assert.equal(
      statusAfter.result.output.latestRunId,
      statusBefore.result.output.latestRunId,
      "get_code_context must not run a new index run on the stale path",
    );
    assert.equal(statusAfter.result.output.freshness.isStale, true);
    assert.equal(statusAfter.result.output.freshness.observedFileChanges?.changedFileCount, 1);
  });
});

test("get_code_context returns nextTool=index_repo when the index is missing", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const bound = await createRepoBoundMcpServer({ repoPath: repoRoot });
    const server = bound.server;

    const db = openIndexerDatabase(initialized.paths.dbPath);
const stores = new ProductStoreLease(db, initialized.paths.dbPath).write;
    try {
      db.exec("DELETE FROM files");
    } finally {
      db.close();
    }

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-code-context-missing-index",
      toolId: McpToolId.GetCodeContext,
      input: { detail: "debug", query: "session manager", maxBudgetCharacters: 4_000 },
    });

    assert.equal(response.result.ok, true);
    assert.equal(response.result.output.resolved, false);
    assert.equal(response.result.output.reason, "missing_index");
    assert.equal(response.result.output.nextTool.name, "index_repo");
    assert.deepEqual(response.result.output.nextTool.input, { repo_root: repoRoot });
    assert.equal(response.result.output.diagnostics.indexFreshness.action, "call_index_repo");
  });
});

test("get_code_context returns nextTool=index_repo when the repo is not ready", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    // Note: no initRepo here — the repo binding is not ready.
    const server = createMcpServer({
      context: { repoRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-code-context-repo-not-ready",
      toolId: McpToolId.GetCodeContext,
      input: { detail: "debug", query: "session manager", maxBudgetCharacters: 4_000 },
    });

    assert.equal(response.result.ok, true);
    assert.equal(response.result.output.resolved, false);
    assert.equal(response.result.output.reason, "missing_index");
    assert.equal(response.result.output.nextTool.name, "index_repo");
    assert.deepEqual(response.result.output.nextTool.input, { repo_root: repoRoot });
  });
});

test("index_repo remains callable and recovers from stale_index reported by get_code_context", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const bound = await createRepoBoundMcpServer({ repoPath: repoRoot });
    const server = bound.server;

    await recordObservedFileChanges({
      repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: ["src/session.ts"],
      nowMs: 7_000,
    });

    const staleResponse = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-code-context-recovery-stale",
      toolId: McpToolId.GetCodeContext,
      input: { detail: "debug", query: "session manager", maxBudgetCharacters: 4_000 },
    });
    assert.equal(staleResponse.result.ok, true);
    assert.equal(staleResponse.result.output.resolved, false);
    assert.equal(staleResponse.result.output.nextTool.name, "index_repo");

    const indexResponse = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-index-repo-recovery",
      toolId: McpToolId.IndexRepo,
      input: {},
    });
    assert.equal(indexResponse.result.ok, true);
    assert.equal(indexResponse.result.output.readiness?.status, "ready");

    const retry = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-code-context-recovery-retry",
      toolId: McpToolId.GetCodeContext,
      input: { detail: "debug", query: "session manager", maxBudgetCharacters: 4_000 },
    });

    assert.equal(retry.result.ok, true);
    assert.equal("resolved" in retry.result.output, false);
    assert.equal(retry.result.output.diagnostics.indexFreshness.status, "fresh");
    assert.equal(retry.result.output.diagnostics.indexFreshness.action, "none");
    assert.equal(retry.result.output.diagnostics.freshness.state, "fresh");
  });
});

test("visible get_code_context always has visible index_repo and check_capsule_staleness companions", () => {
  const visible = new Set(defaultVisibleToolIds());
  assert.equal(visible.has(McpToolId.GetCodeContext), true);
  assert.equal(visible.has(McpToolId.IndexRepo), true);
  assert.equal(visible.has(McpToolId.CheckCapsuleStaleness), true);
});

test("get_code_context auto_refresh defaults to never and if_stale refreshes only the selected worktree", async () => {
  await withGitMcpWorktrees(async ({ mainRoot, featureRoot }) => {
    await initRepo({ repoPath: mainRoot });
    const mainManifestBefore = await readFile(path.join(mainRoot, ".vtrace", "index.meta.json"), "utf8");
    const server = createMcpServer({ context: { repoRoot: mainRoot } });

    const disabled = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-worktree-auto-disabled",
      toolId: McpToolId.GetCodeContext,
      input: {
        detail: "debug",
        task: "find createSession",
        repo_root: featureRoot,
      },
    });
    assert.equal(disabled.result.ok, true);
    assert.equal(disabled.result.output.resolved, false);
    assert.equal(disabled.result.output.reason, "missing_index");
    assert.equal(disabled.result.output.diagnostics.indexFreshness.refreshAttempted, false);
    assert.deepEqual(disabled.result.output.nextTool.input, { repo_root: featureRoot });

    const refreshed = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-worktree-auto-enabled",
      toolId: McpToolId.GetCodeContext,
      input: {
        detail: "debug",
        detail: "debug",
        task: "find createSession",
        repo_root: featureRoot,
        auto_refresh: "if_stale",
        maxBudgetCharacters: 4_000,
      },
    });
    assert.equal(refreshed.result.ok, true);
    assert.equal("resolved" in refreshed.result.output, false);
    assert.equal(refreshed.result.output.diagnostics.indexFreshness.before.reason, "missing_index");
    assert.equal(refreshed.result.output.diagnostics.indexFreshness.refreshAttempted, true);
    assert.equal(refreshed.result.output.diagnostics.indexFreshness.after.reason, "fresh");
    assert.equal(refreshed.result.output.diagnostics.indexFreshness.worktreeRoot, featureRoot);
    assert.equal(await readFile(path.join(mainRoot, ".vtrace", "index.meta.json"), "utf8"), mainManifestBefore);
  });
});

test("original detached-checkout scenario cannot reuse its index for a new main worktree", async () => {
  await withGitMcpWorktrees(async ({ mainRoot, featureRoot }) => {
    gitOk(mainRoot, "checkout", "--detach");
    await initRepo({ repoPath: mainRoot });
    const canonicalManifest = await readFile(path.join(mainRoot, ".vtrace", "index.meta.json"), "utf8");
    const server = createMcpServer({ context: { repoRoot: mainRoot } });

    const missing = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-detached-isolation-missing",
      toolId: McpToolId.GetCodeContext,
      input: { detail: "debug", task: "find createSession", repo_root: featureRoot },
    });
    assert.equal(missing.result.ok, true);
    assert.equal(missing.result.output.reason, "missing_index");

    const refreshed = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-detached-isolation-refresh",
      toolId: McpToolId.GetCodeContext,
      input: { detail: "debug", task: "find createSession", repo_root: featureRoot, auto_refresh: "if_stale" },
    });
    assert.equal(refreshed.result.ok, true);
    assert.equal("resolved" in refreshed.result.output, false);
    assert.equal(await readFile(path.join(mainRoot, ".vtrace", "index.meta.json"), "utf8"), canonicalManifest);
  });
});

test("run_pipeline still surfaces stale diagnostics without short-circuiting on stale index", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const bound = await createRepoBoundMcpServer({ repoPath: repoRoot });
    const server = bound.server;

    await recordObservedFileChanges({
      repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: ["src/session.ts"],
      nowMs: 8_000,
    });

    const pipeline = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-no-regression-on-stale",
      toolId: McpToolId.RunPipeline,
      input: { detail: "debug", query: "session manager", maxBudgetCharacters: 4_000 },
    });

    assert.equal(pipeline.result.ok, true);
    assert.equal("resolved" in pipeline.result.output, false);
    assert.equal(pipeline.result.output.diagnostics.freshness.state, "possibly_stale");
    assert.equal(pipeline.result.output.diagnostics.indexFreshness.status, "stale");
  });
});

test("workspace_setup inspect reports workspace config when present", async () => {
  await withTwoRepoWorkspace(async ({ alphaRoot, betaRoot }) => {
    const bound = await createRepoBoundMcpServer({ repoPath: alphaRoot });
    const server = bound.server;

    const inspected = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-workspace-setup-with-config",
      toolId: McpToolId.WorkspaceSetup,
      input: {},
    });

    assert.equal(inspected.result.ok, true);
    assert.equal(inspected.result.output.mode, "inspect");
    assert.equal(inspected.result.output.status.workspace.configPath, resolveWorkspaceConfigPath(alphaRoot));
    assert.equal(inspected.result.output.status.workspace.name, "integration-fixture");
    assert.equal(inspected.result.output.status.workspace.primaryRepoAlias, "alpha");
    assert.deepEqual(
      inspected.result.output.status.workspace.repos.map((repo: {
        repoAlias: string;
        repoRoot: string;
        enabled: boolean;
        indexPresent: boolean;
        readiness: { status: string } | null;
      }) => ({
        repoAlias: repo.repoAlias,
        repoRoot: repo.repoRoot,
        enabled: repo.enabled,
        indexPresent: repo.indexPresent,
        readiness: repo.readiness?.status ?? null,
      })),
      [
        {
          repoAlias: "alpha",
          repoRoot: alphaRoot,
          enabled: true,
          indexPresent: true,
          readiness: "ready",
        },
        {
          repoAlias: "beta",
          repoRoot: betaRoot,
          enabled: true,
          indexPresent: true,
          readiness: "ready",
        },
      ],
    );
  });
});

test("expand_vexp_ref rejects missing or malformed hash with explicit malformed_hash failure", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const server = (await createRepoBoundMcpServer({ repoPath: repoRoot })).server;

    const missing = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-expand-vexp-ref-missing",
      toolId: McpToolId.ExpandVexpRef,
      input: {},
    });
    assert.equal(missing.result.ok, true);
    if (!missing.result.ok) throw new Error("missing path");
    assert.equal(missing.result.output.resolved, false);
    assert.equal(missing.result.output.reason, "malformed_hash");
    assert.equal(typeof missing.result.output.message, "string");

    const badShapes = ["", "ABCDEF012345", "zzzzzzzzzzzz", "short", "a1b2c3d4e5f", "a1b2c3d4e5f61"];
    for (const hash of badShapes) {
      const response = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: `req-expand-vexp-ref-bad-${hash}`,
        toolId: McpToolId.ExpandVexpRef,
        input: { hash },
      });
      assert.equal(response.result.ok, true);
      if (!response.result.ok) throw new Error("bad shape path");
      assert.equal(response.result.output.resolved, false, `expected malformed for ${hash}`);
      assert.equal(response.result.output.reason, "malformed_hash");
      assert.equal(response.result.output.requestedHash, hash);
    }
  });
});

test("search_logic_flow returns a real bounded structural path view for exact indexed symbols", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-search-logic-flow",
      toolId: McpToolId.SearchLogicFlow,
      input: {
        start: "src/controller.ts::SessionController",
        end: "src/session.ts::SessionManager.createSession",
        max_paths: 3,
      },
    });

    assert.equal(response.result.ok, true);

    if (!response.result.ok) {
      throw new Error("Expected search_logic_flow success.");
    }

    assert.deepEqual(response.result.output.requested, {
      start: "src/controller.ts::SessionController",
      end: "src/session.ts::SessionManager.createSession",
      maxPaths: 3,
      crossRepo: false,
    });
    assert.deepEqual(
      [response.result.output.resolvedStart.fqName, response.result.output.resolvedEnd.fqName],
      [
        "src/controller.ts::SessionController",
        "src/session.ts::SessionManager.createSession",
      ],
    );
    assert.deepEqual(response.result.output.summary, {
      reachable: true,
      pathCount: 1,
      maxPaths: 3,
      shortestPathEdgeCount: 2,
      truncated: false,
      traversalLimitReached: false,
    });
    assert.deepEqual(
      response.result.output.paths[0]?.nodes.map((node) => node.fqName),
      [
        "src/controller.ts::SessionController",
        "src/session.ts::SessionManager",
        "src/session.ts::SessionManager.createSession",
      ],
    );
    assert.deepEqual(
      response.result.output.paths[0]?.steps.map((step) => [step.edgeType, step.fromFqName, step.toFqName]),
      [
        ["imports", "src/controller.ts::SessionController", "src/session.ts::SessionManager"],
        ["contains", "src/session.ts::SessionManager", "src/session.ts::SessionManager.createSession"],
      ],
    );
    assert.equal(response.result.output.coverage.supportedEdgeTypes.includes("calls"), true);
    assert.equal(typeof response.result.output.coverage.callFlowEvidenceAvailable, "boolean");
    assert.equal(typeof response.result.output.coverage.callFlowEvidenceUsed, "boolean");
    // This TypeScript fixture has no statically resolved calls edges, so the
    // result must honestly report that call-flow evidence was unavailable.
    assert.equal(response.result.output.coverage.callFlowEvidenceAvailable, false);
    assert.equal(response.result.output.coverage.callFlowEvidenceUsed, false);
    // The product layer attaches a bounded inline excerpt around each step's
    // edge source so the relationship can be read without a follow-up Read. At
    // least one step must carry one, and it must be honestly labelled — never an
    // exact `edge_site` (indexed edges carry no call-site line) and never a whole
    // file.
    const flowSteps = response.result.output.paths.flatMap((flowPath) => flowPath.steps);
    const stepExcerpts = flowSteps
      .map((step) => step.sourceExcerpt)
      .filter((excerpt): excerpt is NonNullable<typeof excerpt> => excerpt != null);
    assert.equal(stepExcerpts.length >= 1, true, "expected at least one inline step excerpt");
    for (const excerpt of stepExcerpts) {
      assert.equal(typeof excerpt.filePath === "string" && excerpt.filePath.length > 0, true);
      assert.equal(excerpt.startLine >= 1 && excerpt.endLine >= excerpt.startLine, true);
      assert.equal(excerpt.text.split("\n").length <= 12, true, "excerpt must respect the line ceiling");
      assert.equal(
        ["symbol_span", "signature", "fallback_symbol_window"].includes(excerpt.reason),
        true,
        `excerpt reason must never claim an exact edge site without edge-site data: ${excerpt.reason}`,
      );
    }
    // The emitted output (including the new coverage fields) must still conform
    // to the tool's additionalProperties:false schema.
    assertOutputConformsToToolSchema(McpToolId.SearchLogicFlow, response.result.output);
    // The flow output carries the deterministic accounting block. Its naive
    // baseline counts the start/end files plus every file the path nodes and
    // per-step excerpts represent — here src/controller.ts + src/session.ts.
    assertWellFormedAccounting(response.result.output.accounting);
    assert.equal(response.result.output.accounting.uniqueFilesCounted, 2);
    assert.equal(response.result.output.accounting.estimatedNaiveFullFileTokens > 0, true);
  });
});

test("get_impact_graph returns a real bounded structural impact view for an exact indexed symbol", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-impact-graph",
      toolId: McpToolId.GetImpactGraph,
      input: {
        symbol_fqn: "src/session.ts::SessionManager.createSession",
        depth: 2,
        format: "tree",
        max_tokens: 3_000,
      },
    });

    assert.equal(response.result.ok, true);

    if (!response.result.ok) {
      throw new Error("Expected get_impact_graph success.");
    }

    assert.deepEqual(response.result.output.requested, {
      symbolFqn: "src/session.ts::SessionManager.createSession",
      depth: 2,
      crossRepo: false,
      format: "tree",
    });
    assert.deepEqual(
      response.result.output.nodes.map((node) => [node.distance, node.fqName]),
      [
        [0, "src/session.ts::SessionManager.createSession"],
        [1, "src/session.ts::SessionManager"],
        [2, "src/controller.ts::SessionController"],
        [2, "src/controller.ts::SessionController.constructor"],
        [2, "src/session.ts::readSession"],
        [1, "src/session.ts::Session"],
      ],
    );
    assert.deepEqual(response.result.output.dependentFiles, [
      "src/controller.ts",
      "src/session.ts",
    ]);
    assert.deepEqual(response.result.output.view.lines, [
      "d0 src/session.ts::SessionManager.createSession (method)",
      "  d1 src/session.ts::SessionManager (class) contains src/session.ts::SessionManager.createSession",
      "    d2 src/controller.ts::SessionController (class) imports src/session.ts::SessionManager",
      "    d2 src/controller.ts::SessionController.constructor (method) references src/session.ts::SessionManager",
      "    d2 src/session.ts::readSession (function) references src/session.ts::SessionManager",
      "d1 src/session.ts::Session",
    ]);
    assert.equal(response.result.output.coverage.analysisKind, "structural");
    // The impact view carries the deterministic accounting block. Its naive
    // baseline counts every file the nodes (root + dependents) and their inline
    // excerpts represent — here the two fixture files (src/session.ts +
    // src/controller.ts) the dependents and their source excerpts live in.
    assert.equal(response.result.output.accounting.latencyMs >= 0, true);
    if (response.result.output.accounting.ref === undefined) {
      assertWellFormedAccounting(response.result.output.accounting);
      assert.equal(response.result.output.accounting.uniqueFilesCounted, 2);
      assert.equal(response.result.output.accounting.estimatedNaiveFullFileTokens > 0, true);
    } else {
      assert.equal(response.result.output.accounting.ref, "responseBudget");
    }
    assert.equal(response.result.output.responseBudget.withinEnvelope, true);
    assert.equal(
      response.result.output.responseBudget.serializedCharacters
        <= response.result.output.responseBudget.totalCeiling * 4,
      true,
    );
    // Source bodies are not repeated in nodes; compact edge-site evidence is
    // carried by directRelations instead.
    const dependentExcerpts = response.result.output.nodes
      .filter((node) => node.distance > 0)
      .map((node) => node.sourceExcerpt)
      .filter((excerpt): excerpt is NonNullable<typeof excerpt> => excerpt != null);
    assert.deepEqual(dependentExcerpts, []);
    assertOutputConformsToToolSchema(McpToolId.GetImpactGraph, response.result.output);
  });
});

test("get_impact_graph fails explicitly for an unknown exact symbol FQN", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-impact-graph-missing",
      toolId: McpToolId.GetImpactGraph,
      input: {
        symbol_fqn: "src/session.ts::missing",
      },
    });

    assert.deepEqual(response, {
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-impact-graph-missing",
      toolId: McpToolId.GetImpactGraph,
      result: {
        ok: false,
        error: {
          code: McpErrorCode.InvalidRequest,
          message: "Unknown indexed symbol FQN: src/session.ts::missing",
          details: {
            toolId: McpToolId.GetImpactGraph,
            symbolFqn: "src/session.ts::missing",
            resolutionMode: "exact_fqn",
          },
        },
      },
    });
  });
});

test("get_skeleton returns real minimal, standard, and detailed structural output without bodies", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const minimal = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-skeleton-minimal",
      toolId: McpToolId.GetSkeleton,
      input: {
        files: ["src/controller.ts", "src/session.ts"],
        detail: "minimal",
      },
    });
    const standard = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-skeleton-standard",
      toolId: McpToolId.GetSkeleton,
      input: {
        files: ["src/controller.ts", "src/session.ts"],
      },
    });
    const standardRepeat = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-skeleton-standard-repeat",
      toolId: McpToolId.GetSkeleton,
      input: {
        files: ["src/controller.ts", "src/session.ts"],
      },
    });
    const detailed = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-skeleton-detailed",
      toolId: McpToolId.GetSkeleton,
      input: {
        files: ["src/controller.ts", "src/session.ts"],
        detail: "detailed",
      },
    });

    assert.equal(minimal.result.ok, true);
    assert.equal(standard.result.ok, true);
    assert.equal(detailed.result.ok, true);
    // Skeletons are deterministic modulo the additive `accounting` block, whose
    // `latencyMs` is wall-clock and inherently varies between calls.
    const { accounting: standardAccounting, ...standardStable } = standard.result.output;
    const { accounting: repeatAccounting, ...repeatStable } = standardRepeat.result.output;
    assert.deepEqual(repeatStable, standardStable);
    assert.deepEqual(
      { ...repeatAccounting, latencyMs: 0 },
      { ...standardAccounting, latencyMs: 0 },
    );
    // The skeleton carries the deterministic accounting block: both fixture files
    // are real, so the naive baseline counts them and reports positive savings.
    assertWellFormedAccounting(standardAccounting);
    assert.equal(standardAccounting.uniqueFilesCounted, 2);
    assert.equal(standardAccounting.estimatedNaiveFullFileTokens > 0, true);
    assert.equal(
      RESERVED_MCP_TOOL_DEFINITIONS.find((tool) => tool.metadata.toolId === McpToolId.GetSkeleton)?.metadata.description,
      "Return token-efficient structural skeletons for one or more indexed files.",
    );

    assert.deepEqual(
      minimal.result.output.files.map((file) => file.filePath),
      ["src/controller.ts", "src/session.ts"],
    );
    assert.equal(minimal.result.output.detail, "minimal");
    assert.equal(standard.result.output.detail, "standard");
    assert.equal(detailed.result.output.detail, "detailed");

    assert.deepEqual(minimal.result.output.files[0], {
      status: "ok",
      filePath: "src/controller.ts",
      language: "typescript",
      message: null,
      imports: [
        {
          fromFilePath: "src/session.ts",
          name: "SessionManager",
          kind: "class",
        },
      ],
      exports: [
        {
          name: "SessionController",
          kind: "class",
        },
      ],
      declarations: [
        {
          kind: "class",
          name: "SessionController",
          exported: true,
          signature: null,
          startLine: null,
          endLine: null,
          docstring: null,
          decorators: [],
          members: [],
        },
      ],
    });

    assert.deepEqual(
      minimal.result.output.files[1]?.declarations.map((declaration) => [declaration.kind, declaration.name]),
      [
        ["type_alias", "Session"],
        ["class", "SessionManager"],
        ["class", "SessionStore"],
        ["function", "readSession"],
      ],
    );
    assert.equal(minimal.result.output.files[1]?.declarations[1]?.signature, null);
    assert.equal(minimal.result.output.files[1]?.declarations[1]?.members.length, 0);

    assert.equal(standard.result.output.files[1]?.declarations[1]?.signature, "class SessionManager");
    assert.deepEqual(
      standard.result.output.files[1]?.declarations[1]?.members,
      [
        {
          kind: "method",
          name: "createSession",
          signature: "createSession(accountId: string): Session",
          startLine: null,
          endLine: null,
          docstring: null,
          decorators: [],
        },
      ],
    );
    assert.equal(standard.result.output.files[1]?.declarations[0]?.signature, "type Session = string;");
    assert.equal(detailed.result.output.files[1]?.declarations[1]?.startLine, 3);
    assert.equal(detailed.result.output.files[1]?.declarations[1]?.endLine, 7);
    assert.equal(detailed.result.output.files[1]?.declarations[1]?.members[0]?.startLine, 4);
    assert.equal(detailed.result.output.files[1]?.declarations[1]?.members[0]?.endLine, 6);
    assert.equal(JSON.stringify(detailed.result.output).includes("return accountId"), false);
    assert.equal(JSON.stringify(standard.result.output).includes("return manager.createSession"), false);
  });
});

test("get_skeleton reports not-indexed and missing files explicitly", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    await writeFile(
      path.join(repoRoot, "src", "worker.go"),
      [
        "package main",
        "",
        "func main() {}",
        "",
      ].join("\n"),
    );
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-skeleton-unsupported",
      toolId: McpToolId.GetSkeleton,
      input: {
        files: ["src/worker.go", "src/missing.ts"],
        detail: "standard",
      },
    });

    assert.equal(response.result.ok, true);
    assert.deepEqual(response.result.output.files, [
      {
        status: "not_indexed",
        filePath: "src/worker.go",
        language: null,
        message: "File exists on disk but has no indexed structural data.",
        imports: [],
        exports: [],
        declarations: [],
      },
      {
        status: "file_not_found",
        filePath: "src/missing.ts",
        language: null,
        message: "File was not found in the repo.",
        imports: [],
        exports: [],
        declarations: [],
      },
    ]);
  });
});

test("visible structural MCP tools auto-capture compact deterministic tool-call observations", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const db = openIndexerDatabase(initialized.paths.dbPath);
const stores = new ProductStoreLease(db, initialized.paths.dbPath).write;

    try {
      const impactRequest = {
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-auto-impact",
        toolId: McpToolId.GetImpactGraph,
        input: {
          symbol_fqn: "src/session.ts::SessionManager.createSession",
          depth: 2,
          format: "tree",
        },
      } as const;
      const skeletonRequest = {
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-auto-skeleton",
        toolId: McpToolId.GetSkeleton,
        input: {
          files: ["src/controller.ts", "src/session.ts"],
          detail: "standard",
        },
      } as const;
      const logicFlowRequest = {
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-auto-logic-flow",
        toolId: McpToolId.SearchLogicFlow,
        input: {
          start: "src/controller.ts::SessionController",
          end: "src/session.ts::SessionManager.createSession",
        },
      } as const;

      const deliveredImpact = await server.handleRequest(impactRequest);
      assert.equal(deliveredImpact.result.ok, true);
      assert.equal((await server.handleRequest(impactRequest)).result.ok, true);
      assert.equal(countObservations(stores.session), 1);

      assert.equal((await server.handleRequest(skeletonRequest)).result.ok, true);
      assert.equal((await server.handleRequest(skeletonRequest)).result.ok, true);
      assert.equal(countObservations(stores.session), 2);

      assert.equal((await server.handleRequest(logicFlowRequest)).result.ok, true);
      assert.equal((await server.handleRequest(logicFlowRequest)).result.ok, true);
      assert.equal(countObservations(stores.session), 3);

      const observations = listObservations(stores.session);
      const impact = observations.find((observation) => observation.toolName === "get_impact_graph");
      const skeleton = observations.find((observation) => observation.toolName === "get_skeleton");
      const logicFlow = observations.find((observation) => observation.toolName === "search_logic_flow");

      assert.equal(impact?.kind, "tool_call");
      assert.equal(impact?.source, "mcp_auto");
      assert.equal(impact?.queryText, "src/session.ts::SessionManager.createSession");
      assert.equal(impact?.summary.includes(`with ${deliveredImpact.result.output.summary.dependentSymbolCount} dependents`), true);
      assert.deepEqual(
        impact?.linkedFilePaths,
        [...new Set([
          deliveredImpact.result.output.resolvedSymbol.filePath,
          ...deliveredImpact.result.output.dependentFiles,
        ])],
      );
      assert.equal(impact?.linkedFqNames.includes("src/session.ts::SessionManager.createSession"), true);
      assert.equal(impact?.body.includes("view.lines"), false);
      assert.equal(impact?.scope, "index_state");
      assert.equal(impact?.provenance?.resultSummary?.values.dependentCount, deliveredImpact.result.output.summary.dependentSymbolCount);
      assert.equal(impact?.provenance?.resultSummary?.values.fileCount, deliveredImpact.result.output.summary.dependentFileCount);
      assert.notEqual(impact?.resultSemanticHash, undefined);

      assert.equal(skeleton?.kind, "tool_call");
      assert.equal(skeleton?.summary, "Generated skeletons for 2 indexed files.");
      assert.deepEqual(skeleton?.linkedFilePaths, ["src/controller.ts", "src/session.ts"]);
      assert.equal(skeleton?.body.includes("return accountId"), false);

      assert.equal(logicFlow?.kind, "tool_call");
      assert.equal(logicFlow?.summary.includes("with 1 path(s)"), true);
      assert.equal(logicFlow?.linkedFqNames.includes("src/controller.ts::SessionController"), true);
      assert.equal(logicFlow?.linkedFqNames.includes("src/session.ts::SessionManager.createSession"), true);

      const searched = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-auto-structural-search-memory",
        toolId: McpToolId.SearchMemory,
        input: {
          query: "get_impact_graph src/session.ts::SessionManager.createSession",
          maxResults: 5,
        },
      });
      assert.equal(searched.result.ok, true);
      assert.equal(searched.result.output.results[0]?.observation.toolName, "get_impact_graph");
      assert.equal(countObservations(stores.session), 4);

      const contextResult = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-auto-structural-session-context",
        toolId: McpToolId.GetSessionContext,
        input: {
          limit: 5,
          query: "get_skeleton",
        },
      });
      const repeatedContextResult = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-auto-structural-session-context-repeat",
        toolId: McpToolId.GetSessionContext,
        input: {
          limit: 5,
          query: "get_skeleton",
        },
      });

      assert.equal(contextResult.result.ok, true);
      assert.equal(
        contextResult.result.output.rankedObservations?.some((observation) => {
          return observation.toolName === "get_skeleton";
        }),
        true,
      );
      assert.equal(repeatedContextResult.result.ok, true);
      assert.equal(countObservations(stores.session), 5);
    } finally {
      db.close();
    }
  });
});

test("noisy or explicit MCP tools do not auto-capture observations", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const db = openIndexerDatabase(initialized.paths.dbPath);
const stores = new ProductStoreLease(db, initialized.paths.dbPath).write;

    try {
      const indexStatus = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-no-auto-index-status",
        toolId: McpToolId.IndexStatus,
        input: {},
      });
      const workspaceSetup = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-no-auto-workspace-setup",
        toolId: McpToolId.WorkspaceSetup,
        input: {},
      });

      assert.equal(indexStatus.result.ok, true);
      assert.equal(workspaceSetup.result.ok, true);
      assert.equal(countObservations(stores.session), 0);

      const saved = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-no-recursive-save-observation",
        toolId: McpToolId.SaveObservation,
        input: {
          kind: "insight",
          summary: "Explicit save only",
          body: "This row is created by save_observation itself.",
          toolName: "save_observation",
        },
      });

      assert.equal(saved.result.ok, true);
      assert.equal(countObservations(stores.session), 1);
      assert.equal(listObservations(stores.session)[0]?.summary, "Explicit save only");
    } finally {
      db.close();
    }
  });
});

test("save_observation, search_memory, and get_session_context delegate to the real observation services", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const db = openIndexerDatabase(initialized.paths.dbPath);
const stores = new ProductStoreLease(db, initialized.paths.dbPath).write;

    try {
      const sessionSymbol = db.query(`
        SELECT symbols.id
        FROM symbols
        INNER JOIN files ON files.id = symbols.file_id
        WHERE files.path = 'src/service.ts' AND symbols.local_name = 'readUser'
      `).get() as { id: string } | null;
      const server = createMcpServer({
        context: { repoRoot: initialized.repoRoot },
      });

      assert.notEqual(sessionSymbol, null);

      const saved = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-save-observation",
        toolId: McpToolId.SaveObservation,
        input: {
          sessionId: "session-alpha",
          kind: "warning",
          summary: "Session loader note",
          body: "readUser is the main session loader entrypoint.",
          queryText: "where is the session loader",
          intent: "explain",
          linkedFilePaths: ["src/service.ts"],
          linkedSymbolIds: [sessionSymbol!.id],
        },
      });
      assert.equal(saved.result.ok, true);
      assert.equal(saved.result.output.observation.kind, "warning");
      assert.equal(saved.result.output.observation.sessionId, "session-alpha");
      assert.equal(saved.result.output.observation.linkedSymbols[0]?.symbolId, sessionSymbol!.id);
      assert.equal(countObservations(stores.session), 1, "save_observation should only create its explicit row");

      const searched = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-search-memory",
        toolId: McpToolId.SearchMemory,
        input: {
          query: "session loader",
          sessionId: "session-alpha",
          maxResults: 5,
        },
      });
      const contextResult = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-session-context",
        toolId: McpToolId.GetSessionContext,
        input: {
          sessionId: "session-alpha",
          limit: 3,
        },
      });
      const rankedContextResult = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-session-context-ranked",
        toolId: McpToolId.GetSessionContext,
        input: {
          sessionId: "session-alpha",
          limit: 3,
          query: "session loader",
        },
      });

      assert.equal(searched.result.ok, true);
      assert.equal(searched.result.output.results[0]?.observation.summary, "Session loader note");
      assert.equal(searched.result.output.results[0]?.staleness.status, "fresh");
      assert.equal(contextResult.result.ok, true);
      assert.equal(contextResult.result.output.session.sessionId, "session-alpha");
      assert.equal(contextResult.result.output.session.repoRoot, repoRoot);
      assert.equal(contextResult.result.output.session.agentKind, "mcp");
      assert.equal(contextResult.result.output.session.startedAtMs, saved.result.output.observation.createdAtMs);
      assert.equal(
        contextResult.result.output.session.lastActivityAtMs >= saved.result.output.observation.createdAtMs,
        true,
      );
      assert.equal(contextResult.result.output.session.status, "active");
      assert.deepEqual(contextResult.result.output.summary, {
        observationCount: 2,
        lastObservationAtMs: contextResult.result.output.session.lastActivityAtMs,
        freshObservationCount: 2,
        staleObservationCount: 0,
        kindCounts: {
          decision: 0,
          insight: 0,
          warning: 1,
          deadEnd: 0,
          toolCall: 1,
        },
        recentFilePaths: ["src/service.ts"],
        recentSymbolIds: [sessionSymbol!.id],
        recentFqNames: ["src/service.ts::readUser"],
        repeatedQueryTerms: [
          { term: "loader", count: 2 },
          { term: "session", count: 2 },
        ],
      });
      assert.equal(
        contextResult.result.output.observations.some((observation) => {
          return observation.summary === "Session loader note";
        }),
        true,
      );
      assert.equal(
        contextResult.result.output.observations.some((observation) => {
          return observation.toolName === "search_memory" && observation.kind === "tool_call";
        }),
        true,
      );
      assert.equal(contextResult.result.output.rankedObservations, undefined);
      assert.equal(rankedContextResult.result.ok, true);
      assert.equal(
        rankedContextResult.result.output.rankedObservations?.some((observation) => {
          return observation.summary === "Session loader note";
        }),
        true,
      );
      assert.equal(
        rankedContextResult.result.output.rankedObservations?.some((observation) => {
          return observation.toolName === "search_memory";
        }),
        true,
      );
    } finally {
      db.close();
    }
  });
});

test("list_sessions and read_session stay compact, explicit, and fail cleanly for missing sessions", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });

    await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-save-session-a-1",
      toolId: McpToolId.SaveObservation,
      input: {
        sessionId: "session-alpha",
        kind: "decision",
        summary: "Alpha oldest",
        body: "Oldest alpha body.",
      },
    });
    await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-save-session-a-2",
      toolId: McpToolId.SaveObservation,
      input: {
        sessionId: "session-alpha",
        kind: "warning",
        summary: "Alpha middle",
        body: "Middle alpha body.",
        queryText: "alpha session loader",
      },
    });
    await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-save-session-b-1",
      toolId: McpToolId.SaveObservation,
      input: {
        sessionId: "session-beta",
        kind: "insight",
        summary: "Beta only",
        body: "Only beta body.",
      },
    });
    await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-save-session-a-3",
      toolId: McpToolId.SaveObservation,
      input: {
        sessionId: "session-alpha",
        kind: "tool_call",
        summary: "Alpha newest",
        body: "Newest alpha body.",
        queryText: "alpha session loader",
      },
    });

    const listed = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-list-sessions",
      toolId: McpToolId.ListSessions,
      input: {},
    });
    const read = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-read-session",
      toolId: McpToolId.ReadSession,
      input: {
        sessionId: "session-alpha",
      },
    });
    const missing = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-read-session-missing",
      toolId: McpToolId.ReadSession,
      input: {
        sessionId: "missing-session",
      },
    });

    assert.equal(listed.result.ok, true);
    assert.deepEqual(
      listed.result.output.sessions.map((session) => session.sessionId),
      ["session-alpha", "session-beta"],
    );
    assert.deepEqual(
      Object.keys(listed.result.output.sessions[0] ?? {}).sort(),
      ["agentKind", "compressedAtMs", "lastActivityAtMs", "observationCount", "sessionId", "startedAtMs", "status", "summaryId"],
    );
    assert.equal(listed.result.output.sessions[0]?.agentKind, "mcp");
    assert.equal(listed.result.output.sessions[0]?.observationCount, 3);
    assert.equal(listed.result.output.sessions[1]?.observationCount, 1);

    assert.equal(read.result.ok, true);
    assert.deepEqual(
      Object.keys(read.result.output).sort(),
      ["compressedSummary", "recentObservations", "session", "summary"],
    );
    assert.equal(read.result.output.compressedSummary, null);
    assert.equal(read.result.output.session.sessionId, "session-alpha");
    assert.equal(read.result.output.summary.observationCount, 3);
    assert.equal(read.result.output.recentObservations.length, 3);
    assert.deepEqual(
      read.result.output.recentObservations
        .map((observation) => observation.summary)
        .sort(),
      ["Alpha newest", "Alpha middle", "Alpha oldest"].sort(),
    );

    assert.deepEqual(missing, {
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-read-session-missing",
      toolId: McpToolId.ReadSession,
      result: {
        ok: false,
        error: {
          code: McpErrorCode.InvalidRequest,
          message: "Unknown session: missing-session",
          details: {
            toolId: "read_session",
            sessionId: "missing-session",
          },
        },
      },
    });
  });
});

test.skip("get_context_capsule auto-captures one deduped tool-call observation on happy path without surfacing it as self-echo memory", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const request = {
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-context-capsule-auto",
      toolId: McpToolId.GetContextCapsule,
      input: {
        query: "Session",
      },
    } as const;

    const first = await server.handleRequest(request);
    const second = await server.handleRequest(request);
    const db = openIndexerDatabase(initialized.paths.dbPath);
const stores = new ProductStoreLease(db, initialized.paths.dbPath).write;

    try {
      assert.equal(first.result.ok, true);
      // Deterministic across calls except the additive `accounting.latencyMs`.
      const { accounting: firstAccounting, ...firstStable } = first.result.output;
      const { accounting: secondAccounting, ...secondStable } = second.result.output;
      assert.deepEqual(normalizeProductContextTiming(secondStable), normalizeProductContextTiming(firstStable));
      assert.deepEqual(
        { ...secondAccounting, latencyMs: 0 },
        { ...firstAccounting, latencyMs: 0 },
      );
      assert.equal(countObservations(stores.session), 1);
      const memory = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-auto-memory",
        toolId: McpToolId.SearchMemory,
        input: {
          query: "get_context_capsule Session",
          maxResults: 5,
        },
      });

      assert.equal(memory.result.ok, true);
      assert.equal(memory.result.output.results[0]?.observation.source, "mcp_auto");
      assert.equal(memory.result.output.results[0]?.observation.toolName, "get_context_capsule");
      assert.equal(
        first.result.output.capsule.memories?.some((entry) => {
          return entry.observationId === memory.result.output.results[0]?.observation.id;
        }) ?? false,
        false,
      );
      assert.equal(
        second.result.output.capsule.memories?.some((entry) => {
          return entry.observationId === memory.result.output.results[0]?.observation.id;
        }) ?? false,
        false,
      );
    } finally {
      db.close();
    }
  });
});

test.skip("build_capsule no longer has unique memory behavior — calling it does not create a new observation when get_context_capsule already auto-captured the same inputs", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const db = openIndexerDatabase(initialized.paths.dbPath);
const stores = new ProductStoreLease(db, initialized.paths.dbPath).write;

    try {
      // get_context_capsule auto-captures one observation.
      await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-visible-capsule",
        toolId: McpToolId.GetContextCapsule,
        input: { query: "Session" },
      });
      assert.equal(countObservations(stores.session), 1);

      // build_capsule (hidden legacy) must not add its own observation.
      const legacy = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-legacy-build-capsule",
        toolId: McpToolId.BuildCapsule,
        input: { query: "Session" },
      });
      assert.equal(legacy.result.ok, true);
      assert.equal(countObservations(stores.session), 1);

      // Calling build_capsule first and then get_context_capsule second must
      // also result in exactly one observation, captured under the visible
      // tool name, because build_capsule no longer captures anything itself.
      const freshRepoRoot = repoRoot;
      await withFixture(async (innerRepoRoot) => {
        await writeMcpFixtureRepo(innerRepoRoot);
        const inner = await initRepo({ repoPath: innerRepoRoot });
        const innerServer = createMcpServer({
          context: { repoRoot: inner.repoRoot },
        });
        const innerDb = openIndexerDatabase(inner.paths.dbPath);
        try {
          await innerServer.handleRequest({
            schema: MCP_SERVER_SCHEMA,
            requestId: "req-inner-legacy",
            toolId: McpToolId.BuildCapsule,
            input: { query: "Session" },
          });
          assert.equal(countObservations(innerDb), 0);
          await innerServer.handleRequest({
            schema: MCP_SERVER_SCHEMA,
            requestId: "req-inner-visible",
            toolId: McpToolId.GetContextCapsule,
            input: { query: "Session" },
          });
          assert.equal(countObservations(innerDb), 1);
          const memory = await innerServer.handleRequest({
            schema: MCP_SERVER_SCHEMA,
            requestId: "req-inner-memory",
            toolId: McpToolId.SearchMemory,
            input: { query: "Session", maxResults: 5 },
          });
          assert.equal(memory.result.ok, true);
          assert.equal(memory.result.output.results[0]?.observation.toolName, "get_context_capsule");
        } finally {
          innerDb.close();
        }
      });
      void freshRepoRoot;
    } finally {
      db.close();
    }
  });
});

test("list_runs delegates to the real run-history service and returns deterministic ordering", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const firstInit = await initRepo({ repoPath: repoRoot });
    await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: firstInit.repoRoot },
    });
    const request = {
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-runs",
      toolId: McpToolId.ListRuns,
      input: {},
    } as const;

    const first = await server.handleRequest(request);
    const second = await server.handleRequest(request);

    assert.deepEqual(second, first);
    assert.equal(first.result.ok, true);
    assert.deepEqual(
      first.result.output.runs.map((run) => run.id),
      [1, 2],
    );
    assert.deepEqual(
      first.result.output.runs.map((run) => run.previousRunId),
      [null, 1],
    );
  });
});

test("check_capsule_staleness delegates to the real staleness service and returns structured fresh and stale output", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const db = openIndexerDatabase(initialized.paths.dbPath);
const stores = new ProductStoreLease(db, initialized.paths.dbPath).write;

    try {
      const sourceRunId = listIndexRuns(db).at(-1)!.id;
      const routed = routeQuery(db, "readUser", { maxResults: 2 });
      const capsule = buildCapsule(
        createSourceBackedCapsuleBuilder({ db, stores, repoRoot }),
        {
          query: "readUser",
          rerankedCandidates: routed.rerankedResults,
          supportingCandidates: [],
          maxBudget: createCharacterBudget(2_000),
        },
      );
      const manifest = persistCapsuleManifest(stores, {
        sourceRunId,
        capsule,
        createdAtMs: 1,
      });
      const server = createMcpServer({
        context: { repoRoot: initialized.repoRoot },
      });

      await indexProject({ repoRoot, db });
      const freshRunId = listIndexRuns(db).at(-1)!.id;
      const freshRequest = {
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-stale-fresh",
        toolId: McpToolId.CheckCapsuleStaleness,
        input: {
          manifestId: manifest.id,
          comparisonRunId: freshRunId,
        },
      } as const;
      const freshFirst = await server.handleRequest(freshRequest);
      const freshSecond = await server.handleRequest(freshRequest);

      assert.deepEqual(freshSecond, freshFirst);
      assert.equal(freshFirst.result.ok, true);
      assert.equal(freshFirst.result.output.status, "fresh");
      assert.equal(freshFirst.result.output.items[0]?.status, "fresh");

      await writeFile(
        path.join(repoRoot, "src", "service.ts"),
        [
          "import { User } from \"./models\";",
          "",
          "export function readUser(): User {",
          "  return { id: \"fixture\" };",
          "}",
          "",
          "export function writeUser(): User {",
          "  return { id: \"next\" };",
          "}",
          "",
        ].join("\n"),
      );
      await indexProject({ repoRoot, db });
      const staleRunId = listIndexRuns(db).at(-1)!.id;
      const staleResponse = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-stale-stale",
        toolId: McpToolId.CheckCapsuleStaleness,
        input: {
          manifestId: manifest.id,
          comparisonRunId: staleRunId,
        },
      });

      assert.equal(staleResponse.result.ok, true);
      assert.equal(staleResponse.result.output.status, "stale");
      assert.equal(staleResponse.result.output.items[0]?.status, "stale");
      assert.deepEqual(
        staleResponse.result.output.items[0]?.reasons.map((reason) => reason.kind),
        ["file_modified_source_backed"],
      );
    } finally {
      db.close();
    }
  });
});

test("check_capsule_staleness missing manifest and run cases fail cleanly and deterministically", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const db = openIndexerDatabase(initialized.paths.dbPath);
const stores = new ProductStoreLease(db, initialized.paths.dbPath).write;

    try {
      const sourceRunId = listIndexRuns(db).at(-1)!.id;
      const routed = routeQuery(db, "readUser", { maxResults: 2 });
      const capsule = buildCapsule(
        createSourceBackedCapsuleBuilder({ db, stores, repoRoot }),
        {
          query: "readUser",
          rerankedCandidates: routed.rerankedResults,
          supportingCandidates: [],
          maxBudget: createCharacterBudget(2_000),
        },
      );
      const manifest = persistCapsuleManifest(stores, {
        sourceRunId,
        capsule,
        createdAtMs: 1,
      });
      const server = createMcpServer({
        context: { repoRoot: initialized.repoRoot },
      });

      const missingManifestRequest = {
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-missing-manifest",
        toolId: McpToolId.CheckCapsuleStaleness,
        input: {
          manifestId: "missing-manifest",
          comparisonRunId: sourceRunId,
        },
      } as const;
      const missingManifestFirst = await server.handleRequest(missingManifestRequest);
      const missingManifestSecond = await server.handleRequest(missingManifestRequest);

      assert.deepEqual(missingManifestSecond, missingManifestFirst);
      assert.deepEqual(missingManifestFirst, {
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-missing-manifest",
        toolId: "check_capsule_staleness",
        result: {
          ok: false,
          error: {
            code: McpErrorCode.InvalidRequest,
            message: "Capsule manifest not found: missing-manifest",
            details: {
              toolId: "check_capsule_staleness",
              manifestId: "missing-manifest",
            },
          },
        },
      });

      const missingRunResponse = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-missing-run",
        toolId: McpToolId.CheckCapsuleStaleness,
        input: {
          manifestId: manifest.id,
          comparisonRunId: 999,
        },
      });

      assert.deepEqual(missingRunResponse, {
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-missing-run",
        toolId: "check_capsule_staleness",
        result: {
          ok: false,
          error: {
            code: McpErrorCode.InvalidRequest,
            message: "Index run not found: 999",
            details: {
              toolId: "check_capsule_staleness",
              comparisonRunId: 999,
            },
          },
        },
      });
    } finally {
      db.close();
    }
  });
});

test("repo-not-ready failures are structured and deterministic", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const server = createMcpServer({
      context: { repoRoot },
    });
    const request = {
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-not-ready",
      toolId: McpToolId.RouteQuery,
      input: {
        query: "Session",
      },
    } as const;

    const first = await server.handleRequest(request);
    const second = await server.handleRequest(request);

    assert.deepEqual(second, first);
    assert.deepEqual(first, {
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-not-ready",
      toolId: "route_query",
      result: {
        ok: false,
        error: {
          code: McpErrorCode.RepoNotReady,
          message: `Repository is not initialized for MCP use: ${repoRoot}`,
          details: {
            diagnosticReason: "repo_not_ready",
            toolId: "route_query",
            repoRoot,
            configPath: path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, "config.json"),
            statePath: path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, "state.json"),
            configPresent: false,
            statePresent: false,
          },
        },
      },
    });
  });
});

test("MCP contract can host later engine-tool wiring without redesign", async () => {
  const customTool = makeCustomTool();
  const server = createMcpServer({
    context: {
      repoRoot: "/repo/demo",
      initialized: true,
    },
    registry: createMcpToolRegistry({
      tools: [customTool],
    }),
  });
  const request = {
    schema: MCP_SERVER_SCHEMA,
    requestId: "req-custom",
    toolId: "custom_tool",
    input: {
      query: "Session",
    },
  } as const;
  const response = await server.handleRequest(request);

  assert.deepEqual(server.lookupTool("custom_tool"), {
    requestedToolId: "custom_tool",
    tool: customTool,
    explanation: {
      found: true,
      summary: "Resolved MCP tool custom_tool.",
    },
  });
  assert.deepEqual(server.listTools().map((tool) => tool.toolId), ["custom_tool"]);
  assert.deepEqual(server.context, {
    serverId: MCP_SERVER_ID,
    repoRoot: "/repo/demo",
    dbPath: `/repo/demo/${REPO_LOCAL_STATE_DIRNAME}/index.sqlite`,
    configPath: `/repo/demo/${REPO_LOCAL_STATE_DIRNAME}/config.json`,
    statePath: `/repo/demo/${REPO_LOCAL_STATE_DIRNAME}/state.json`,
    initialized: true,
    config: null,
    state: null,
  });
  assert.deepEqual(createMcpServerContext({ repoRoot: "/repo/demo", initialized: true }), server.context);
  assert.deepEqual(response, {
    schema: MCP_SERVER_SCHEMA,
    requestId: "req-custom",
    toolId: "custom_tool",
    result: {
      ok: true,
      output: {
        query: "Session",
        delegatedTo: "engine",
      },
    },
  });
});

function makeCustomTool(): McpToolDefinition<{ query: string }, { query: string; delegatedTo: string }> {
  return {
    metadata: {
      toolId: "custom_tool",
      displayName: "Custom Tool",
      description: "Custom tool used to prove future engine delegate wiring.",
      inputSchema: {
        type: "object",
        description: "Custom tool input.",
        properties: {
          query: {
            type: "string",
            description: "User query text.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        description: "Custom tool output.",
        properties: {
          query: {
            type: "string",
            description: "Echoed query text.",
          },
          delegatedTo: {
            type: "string",
            description: "Delegate target summary.",
          },
        },
        required: ["query", "delegatedTo"],
        additionalProperties: false,
      },
      registration: {
        registered: true,
        reserved: false,
        availability: McpToolAvailability.Wired,
        handlerKind: McpToolHandlerKind.EngineDelegate,
      },
    },
    handler({ request }) {
      return {
        ok: true,
        output: {
          query: request.input.query,
          delegatedTo: "engine",
        },
      };
    },
  };
}

function assertOutputConformsToToolSchema(toolId: McpToolId, output: unknown): void {
  const definition = RESERVED_MCP_TOOL_DEFINITIONS.find((tool) => tool.metadata.toolId === toolId);

  assert.notEqual(definition, undefined, `Missing MCP tool definition for ${toolId}`);
  assertConformsToSchema(output, definition!.metadata.outputSchema, toolId);
}

function assertConformsToSchema(
  value: unknown,
  schema: McpObjectSchema | McpSchemaProperty,
  pathLabel: string,
): void {
  if (value === null) {
    assert.equal(
      schemaAllowsType(schema, "null"),
      true,
      `${pathLabel}: schema does not allow null`,
    );
    return;
  }

  if (Array.isArray(value)) {
    assert.equal(
      schemaAllowsType(schema, "array"),
      true,
      `${pathLabel}: schema does not allow array`,
    );
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        assertConformsToSchema(item, schema.items!, `${pathLabel}[${index}]`);
      });
    }
    return;
  }

  if (typeof value === "object") {
    assert.equal(
      schemaAllowsType(schema, "object"),
      true,
      `${pathLabel}: schema does not allow object`,
    );
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];

    for (const requiredKey of required) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(record, requiredKey),
        true,
        `${pathLabel}: missing required property ${requiredKey}`,
      );
    }

    if (schema.additionalProperties === false) {
      const extraKeys = Object.keys(record).filter((key) => properties[key] === undefined);
      assert.deepEqual(extraKeys, [], `${pathLabel}: schema is missing emitted properties`);
    }

    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        continue;
      }
      assertConformsToSchema(record[key], propertySchema, `${pathLabel}.${key}`);
    }
    return;
  }

  if (typeof value === "string") {
    assert.equal(
      schemaAllowsType(schema, "string"),
      true,
      `${pathLabel}: schema does not allow string`,
    );
    return;
  }

  if (typeof value === "number") {
    assert.equal(
      schemaAllowsType(schema, "number") || (Number.isInteger(value) && schemaAllowsType(schema, "integer")),
      true,
      `${pathLabel}: schema does not allow number`,
    );
    return;
  }

  if (typeof value === "boolean") {
    assert.equal(
      schemaAllowsType(schema, "boolean"),
      true,
      `${pathLabel}: schema does not allow boolean`,
    );
    return;
  }

  assert.fail(`${pathLabel}: unsupported value type ${typeof value}`);
}

function schemaAllowsType(
  schema: McpObjectSchema | McpSchemaProperty,
  type: "string" | "integer" | "number" | "boolean" | "object" | "array" | "null",
): boolean {
  return Array.isArray(schema.type)
    ? schema.type.includes(type)
    : schema.type === type;
}

async function withFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-mcp-"));
  const repoRoot = path.join(root, "repo");
  const previousClaudeConfigPath = process.env.VTRACE_CLAUDE_CODE_CONFIG_PATH;

  try {
    process.env.VTRACE_CLAUDE_CODE_CONFIG_PATH = path.join(root, "claude.json");
    await mkdir(repoRoot, { recursive: true });
    await run(repoRoot);
  } finally {
    if (previousClaudeConfigPath === undefined) {
      delete process.env.VTRACE_CLAUDE_CODE_CONFIG_PATH;
    } else {
      process.env.VTRACE_CLAUDE_CODE_CONFIG_PATH = previousClaudeConfigPath;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function withTwoRepoWorkspace(
  run: (input: {
    root: string;
    alphaRoot: string;
    betaRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-multi-mcp-"));
  const alphaRoot = path.join(root, "alpha");
  const betaRoot = path.join(root, "beta");

  try {
    await mkdir(alphaRoot, { recursive: true });
    await mkdir(betaRoot, { recursive: true });
    await writeMcpFixtureRepo(alphaRoot);
    await writeMcpFixtureRepo(betaRoot);
    await initRepo({ repoPath: alphaRoot });
    await initRepo({ repoPath: betaRoot });
    await writeFile(
      resolveWorkspaceConfigPath(alphaRoot),
      `${JSON.stringify({
        schemaVersion: "1.0.0",
        name: "integration-fixture",
        primaryRepoAlias: "alpha",
        repos: [
          {
            alias: "alpha",
            rootPath: alphaRoot,
            enabled: true,
          },
          {
            alias: "beta",
            rootPath: betaRoot,
            enabled: true,
          },
        ],
      }, null, 2)}\n`,
    );

    await run({ root, alphaRoot, betaRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runMcpServerProcess(repoRoot: string): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawnSync(process.execPath, ["src/mcp/server.ts", "--repo", repoRoot], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    exitCode: child.status,
    stdout: child.stdout.toString("utf8"),
    stderr: child.stderr.toString("utf8"),
  };
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
): Promise<number | null> {
  if (child.exitCode !== null) {
    return child.exitCode;
  }

  return await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve(code);
    });
  });
}

function tryExtractFramedJson(buffer: Buffer): {
  messageText: string;
  remaining: Buffer;
} | null {
  const separatorIndex = buffer.indexOf("\r\n\r\n");

  if (separatorIndex < 0) {
    return null;
  }

  const headerText = buffer.subarray(0, separatorIndex).toString("utf8");
  const contentLengthLine = headerText
    .split("\r\n")
    .find((line) => line.toLowerCase().startsWith("content-length:"));

  if (contentLengthLine === undefined) {
    throw new Error("Missing Content-Length header in MCP test response.");
  }

  const contentLength = Number.parseInt(contentLengthLine.slice("content-length:".length).trim(), 10);
  const bodyStart = separatorIndex + 4;
  const bodyEnd = bodyStart + contentLength;

  if (buffer.length < bodyEnd) {
    return null;
  }

  return {
    messageText: buffer.subarray(bodyStart, bodyEnd).toString("utf8"),
    remaining: buffer.subarray(bodyEnd),
  };
}

function collectFramedResponses(buffer: Buffer): Record<string, unknown>[] {
  const responses: Record<string, unknown>[] = [];
  let remaining = buffer;

  while (true) {
    const framed = tryExtractFramedJson(remaining);

    if (framed === null) {
      break;
    }

    responses.push(JSON.parse(framed.messageText) as Record<string, unknown>);
    remaining = framed.remaining;
  }

  return responses;
}

function collectLineResponses(buffer: Buffer): Record<string, unknown>[] {
  return buffer
    .toString("utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function encodeFramedJson(
  message: Record<string, unknown>,
): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

function encodeLineJson(
  message: Record<string, unknown>,
): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

function runMcpServerProcessWithMessages(
  repoRoot: string,
  messages: readonly Record<string, unknown>[],
  extraArgs: readonly string[] = [],
): {
  exitCode: number | null;
  stderr: string;
  responses: Record<string, unknown>[];
} {
  const input = Buffer.concat(messages.map(encodeLineJson));
  const child = spawnSync(process.execPath, ["src/mcp/server.ts", "--repo", repoRoot, ...extraArgs], {
    cwd: process.cwd(),
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    exitCode: child.status,
    stderr: child.stderr.toString("utf8"),
    responses: collectLineResponses(Buffer.from(child.stdout)),
  };
}

function countUsefulContextItemsFromOutput(capsule: {
  pivots: readonly unknown[];
  supportingItems: readonly unknown[];
}): number {
  return capsule.pivots.length + capsule.supportingItems.length;
}

function findRunPipelineFallbackBudget(
  db: ReturnType<typeof openIndexerDatabase>,
  repoRoot: string,
  query: string,
): number | null {
  const routedQuery = routeQuery(db, query, { maxResults: 6 });
  const builder = createSourceBackedCapsuleBuilder({ db, repoRoot });
  const supportingCandidates = routedQuery.rerankedResults.map(makeMcpSupportingCandidateFromGraphResult);

  for (let maxBudgetCharacters = 64; maxBudgetCharacters <= 2_000; maxBudgetCharacters += 1) {
    const preparedAssembly = prepareCapsuleAssembly({
      classification: routedQuery.classification,
      builderInput: {
        query,
        rerankedCandidates: routedQuery.rerankedResults,
        supportingCandidates,
        maxBudget: createCharacterBudget(maxBudgetCharacters),
      },
    });
    const profiled = buildCapsule(builder, preparedAssembly.builderInput);
    const relaxed = buildCapsule(builder, {
      query: preparedAssembly.builderInput.query,
      rerankedCandidates: preparedAssembly.builderInput.rerankedCandidates,
      supportingCandidates: preparedAssembly.builderInput.supportingCandidates,
      maxBudget: preparedAssembly.builderInput.maxBudget,
    });

    if (countUsefulContextItemsFromOutput(profiled) === 0 && countUsefulContextItemsFromOutput(relaxed) > 0) {
      return maxBudgetCharacters;
    }
  }

  return null;
}

function makeMcpSupportingCandidateFromGraphResult(
  result: GraphSearchResult,
): CapsuleSupportingCandidate {
  return {
    symbolId: result.symbolId,
    filePath: result.filePath,
    fqName: result.fqName,
    localName: result.localName,
    kind: result.kind,
    lexicalScore: result.lexicalScore,
    graphScore: result.graphScore,
    finalScore: result.finalScore,
    inclusionReasons: buildMcpInclusionReasonsFromGraphResult(result),
  };
}

function buildMcpInclusionReasonsFromGraphResult(result: GraphSearchResult) {
  const reasons: CapsuleInclusionReason[] = [
    {
      kind: CapsuleInclusionReasonKind.LexicalMatch,
      matchedFields: collectUniqueInOrder(result.matches.map((match) => match.field)),
    },
  ];
  const graphSignals = collectUniqueInOrder(
    result.graphContributions.map((contribution) => contribution.signal),
  );
  const relatedSymbolIds = collectSortedUnique(
    result.graphContributions.flatMap((contribution) => contribution.relatedSymbolIds ?? []),
  );

  if (graphSignals.length > 0) {
    reasons.push({
      kind: CapsuleInclusionReasonKind.GraphConnection,
      graphSignals,
      ...(relatedSymbolIds.length === 0 ? {} : { relatedSymbolIds }),
    });
  }

  return reasons;
}

function collectUniqueInOrder<T>(values: readonly T[]): T[] {
  const uniqueValues: T[] = [];
  const seen = new Set<T>();

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    uniqueValues.push(value);
  }

  return uniqueValues;
}

function collectSortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function defaultVisibleToolIds(): string[] {
  return RESERVED_MCP_TOOL_METADATA.map((tool) => tool.toolId);
}

async function withGitMcpWorktrees(
  run: (roots: { mainRoot: string; featureRoot: string }) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-mcp-worktrees-"));
  const mainRoot = path.join(tempRoot, "canonical");
  const featureRoot = path.join(tempRoot, "main-worktree");
  try {
    await mkdir(path.join(mainRoot, "src"), { recursive: true });
    gitOk(mainRoot, "init", "-b", "main");
    gitOk(mainRoot, "config", "user.email", "vtrace@example.test");
    gitOk(mainRoot, "config", "user.name", "Vtrace Test");
    await writeFile(path.join(mainRoot, ".gitignore"), ".vtrace/\n");
    await writeFile(
      path.join(mainRoot, "src", "session.ts"),
      "export class SessionManager { createSession(): void {} }\n",
    );
    gitOk(mainRoot, "add", ".gitignore", "src/session.ts");
    gitOk(mainRoot, "commit", "-m", "initial");
    gitOk(mainRoot, "worktree", "add", "-b", "worktree-main", featureRoot);
    await run({ mainRoot, featureRoot });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function gitOk(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

// M164. `vtrace index` on a never-initialized repository writes an index and
// deliberately no lifecycle files, and until M164 the MCP read path read that
// absence as "not ready" — about an index its own diagnostics reported fresh,
// coverage-complete and bound to exactly the requested worktree. The CLI served
// the same evidence the whole time. These three tests pin the repaired seam: the
// index-only shape answers, the states that should refuse still refuse, and an
// initialized repository is still judged on its own recorded readiness.

/** The shape `vtrace index <repo>` leaves on a repository that was never initialized. */
async function indexOnly(repoRoot: string): Promise<void> {
  const paths = resolveRepoLocalPaths(repoRoot);
  const state = await reindexRepoAndRefreshState({
    repoRoot,
    dbPath: paths.dbPath,
    statePath: paths.statePath,
    configPresent: false,
    statePresent: false,
    usesDbPathOverride: false,
    refreshMode: "auto",
  });
  // The precondition the whole milestone rests on: no lifecycle record was written.
  assert.equal(state.state, null);
}

test("M164: an indexed but never-initialized repo answers get_code_context from index authority", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    await indexOnly(repoRoot);

    const bound = await createRepoBoundMcpServer({ repoPath: repoRoot });
    assert.equal(bound.startup.initialized, false, "the fixture must have no lifecycle record");

    const response = await bound.server.handleRequest({
      schema: bound.server.schema,
      requestId: "m164-index-only",
      toolId: McpToolId.GetCodeContext,
      input: { detail: "debug", query: "read a user session" },
    });

    const output = response.result?.output as Record<string, unknown> | undefined;
    assert.equal(response.result?.ok, true);
    assert.notEqual(output?.["reason"], "repo_not_ready");
    assert.notEqual(output?.["resolved"], false);
    assert.notEqual(output?.["capsuleResult"], undefined, "a served read must carry a capsule, not a refusal");
  });
});

test("M164: index authority still refuses a stale index on a never-initialized repo", async () => {
  await withFixture(async (repoRoot) => {
    // Source freshness is evaluated against the worktree's committed and dirty
    // state, so the fixture has to be a real repository for the question to mean
    // anything.
    const git = (...args: string[]): void => {
      const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    await writeMcpFixtureRepo(repoRoot);
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=m164@vtrace", "-c", "user.name=m164", "commit", "-qm", "base");
    await indexOnly(repoRoot);
    // Source moves past the index. Nothing about the missing lifecycle files
    // changed; the index simply stopped describing the tree.
    await writeFile(path.join(repoRoot, "src", "service.ts"), "export const REWRITTEN = 1;\n");

    const bound = await createRepoBoundMcpServer({ repoPath: repoRoot });
    const response = await bound.server.handleRequest({
      schema: bound.server.schema,
      requestId: "m164-index-only-stale",
      toolId: McpToolId.GetCodeContext,
      input: { detail: "debug", query: "read a user session" },
    });

    const output = response.result?.output as Record<string, unknown> | undefined;
    assert.equal(output?.["capsuleResult"], undefined, "a stale index must not answer");
    assert.equal(output?.["resolved"], false);
  });
});

test("M164: an initialized repo is still judged on its own recorded readiness", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    await initRepo({ repoPath: repoRoot });

    // A repository that DID record its lifecycle keeps the pre-M164 gate. Index
    // authority is the fallback for repositories with no record, never an
    // override of one that says it is not ready.
    const paths = resolveRepoLocalPaths(repoRoot);
    const state = JSON.parse(await readFile(paths.statePath, "utf8")) as Record<string, unknown>;
    state["readiness"] = { status: "failed", summary: "M164 control", checks: [] };
    await writeFile(paths.statePath, JSON.stringify(state, null, 2));

    const bound = await createRepoBoundMcpServer({ repoPath: repoRoot });
    const response = await bound.server.handleRequest({
      schema: bound.server.schema,
      requestId: "m164-initialized-not-ready",
      toolId: McpToolId.GetCodeContext,
      input: { detail: "debug", query: "read a user session" },
    });

    const output = response.result?.output as Record<string, unknown> | undefined;
    assert.equal(output?.["capsuleResult"], undefined);
    assert.equal(output?.["reason"], "repo_not_ready");
  });
});

async function writeMcpFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "models.ts"),
    "export interface User { id: string }\n",
  );
  await writeFile(
    path.join(repoRoot, "src", "service.ts"),
    [
      "import { User } from \"./models\";",
      "",
      "export function readUser(): User {",
      "  return { id: \"fixture\" };",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "session.ts"),
    [
      "export type Session = string;",
      "",
      "export class SessionManager {",
      "  createSession(accountId: string): Session {",
      "    return accountId;",
      "  }",
      "}",
      "",
      "export class SessionStore {",
      "  loadSession(id: string): Session {",
      "    return id;",
      "  }",
      "}",
      "",
      "export function readSession(manager: SessionManager): Session {",
      "  return manager.createSession(\"fixture\");",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "controller.ts"),
    [
      "import { SessionManager } from \"./session\";",
      "",
      "export class SessionController {",
      "  constructor(private readonly manager: SessionManager) {}",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "script.py"),
    "value = 1\n",
  );
}

async function writeConceptDebugFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src", "diagnostics"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "diagnostics", "classifier.py"),
    [
      "def classify_exceptions(report: dict) -> str:",
      "    \"\"\"Recognize failure categories after parser evaluation and handler review.\"\"\"",
      "    return report.get(\"kind\", \"unknown\")",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "diagnostics", "status.py"),
    [
      "from .classifier import classify_exceptions",
      "",
      "def derive_status_category(report: dict) -> str:",
      "    \"\"\"Determine status after handler evaluation before recovery dispatch.\"\"\"",
      "    return classify_exceptions(report)",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "diagnostics", "actions.py"),
    [
      "from .status import derive_status_category",
      "",
      "def dispatch_recovery_plan(report: dict) -> str:",
      "    \"\"\"Dispatch recovery commands from mapped status categories and retry decisions.\"\"\"",
      "    return derive_status_category(report)",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "diagnostics", "patterns.py"),
    [
      "def register_failure_pattern(pattern: dict) -> None:",
      "    \"\"\"Add new failure patterns to the troubleshooting registry.\"\"\"",
      "    return None",
      "",
    ].join("\n"),
  );
}
