import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { persistCapsuleManifest } from "../db/repositories/capsuleManifestsRepository";
import { listIndexRuns } from "../db/repositories/indexRunsRepository";
import { countObservations, listObservations, persistObservation } from "../db/repositories/observationsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { routeQuery } from "../intent/routeQuery";
import {
  DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS,
  compressInactiveSessions,
} from "../observations/sessionLifecycle";
import { consolidatePassiveObservationsForSession } from "../observations/consolidation";
import { ObservationKind, ObservationSource } from "../observations/types";
import {
  createActiveProjectRule,
  generateProjectRuleCandidates,
} from "../projectRules/projectRules";
import { recordObservedFileChanges } from "../runtime/fileWatcher";
import type { GraphSearchResult } from "../retrieval/types";
import { initRepo } from "../setup/initRepo";
import { REPO_LOCAL_STATE_DIRNAME } from "../setup/types";
import { resolveWorkspaceConfigPath } from "../workspace/config";
import { createMcpToolRegistry } from "./registry";
import { createMcpServer, createMcpServerContext } from "./server";
import { createRepoBoundMcpServer, startMcpServer } from "./startServer";
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

const EXPECTED_VISIBLE_TOOL_IDS = [
  "get_code_context",
  "run_pipeline",
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
  for (const word of ["code", "context", "default", "broad", "debugging", "refactor"]) {
    assert.match(description, new RegExp(`\\b${word}\\b`));
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
  assert.equal(
    registry.getByToolId(McpToolId.GetCodeContext)?.metadata.inputSchema,
    registry.getByToolId(McpToolId.RunPipeline)?.metadata.inputSchema,
  );
  assert.equal(
    registry.getByToolId(McpToolId.GetCodeContext)?.metadata.outputSchema,
    registry.getByToolId(McpToolId.RunPipeline)?.metadata.outputSchema,
  );
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
        instructions: `Repo-bound vtrace MCP server for ${repoRoot}. Use tools/list to inspect available tools.`,
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
        totalSymbols: 11,
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
          unchanged: 11,
        },
      });
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
        query: "Session",
        maxBudgetCharacters: 5_000,
      },
    } as const;

    const first = await server.handleRequest(request);
    const second = await server.handleRequest(request);

    assert.deepEqual(second, first);
    assert.equal(first.result.ok, true);
    assert.equal(first.result.output.query, "Session");
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
    assert.equal(first.result.output.capsule.supportingItems.length > 0, true);
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

test("get_context_capsule is a thin visible wrapper over the existing capsule pipeline", async () => {
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
    assert.deepEqual(visible.result.output, legacy.result.output);
  });
});

test("single-repo context capsule output remains untagged without a workspace config", async () => {
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

test("get_context_capsule tags multi-repo capsule items and honors repo filtering", async () => {
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

test("multi-repo capsule merge order is deterministic with repo alias tie-breakers", async () => {
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

test("run_pipeline reports selected repos, per-repo diagnostics, and skips cross-repo impact honestly", async () => {
  await withTwoRepoWorkspace(async ({ alphaRoot }) => {
    const server = createMcpServer({
      context: { repoRoot: alphaRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-workspace-run-pipeline",
      toolId: McpToolId.RunPipeline,
      input: {
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

test("run_pipeline repos filter limits context retrieval to selected aliases", async () => {
  await withTwoRepoWorkspace(async ({ alphaRoot }) => {
    const server = createMcpServer({
      context: { repoRoot: alphaRoot },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-workspace-run-pipeline-filtered",
      toolId: McpToolId.RunPipeline,
      input: {
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

test("run_pipeline vNext returns a compact orchestration result that differs materially from get_context_capsule", async () => {
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
        "context",
        "deferred",
        "diagnostics",
        "impact",
        "intent",
        "memory",
        "request",
        "rules",
        "savedObservation",
        "schemaVersion",
        "taskSummary",
      ],
    );
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
      input,
    });
    const runPipeline = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-alias-target",
      toolId: McpToolId.RunPipeline,
      input,
    });

    assert.equal(getCodeContext.result.ok, true);
    assert.equal(runPipeline.result.ok, true);
    assert.deepEqual(getCodeContext.result, runPipeline.result);
    assert.equal(getCodeContext.result.output.diagnostics.indexFreshness.status, "fresh");
    assert.equal(getCodeContext.result.output.diagnostics.indexFreshness.action, "none");
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
      input: { query: "rename createSession" },
    });
    const explore = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-auto-explore",
      toolId: McpToolId.RunPipeline,
      input: { query: "where is createSession" },
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
    assert.equal(explore.skipReason, "not_refactor_like");
    assert.equal(explore.focalSymbol, null);

    const modify = byPreset.get("modify")!.result.output.impact;
    assert.equal(modify.included, false);
    assert.equal(modify.skipReason, "not_refactor_like");

    const debug = byPreset.get("debug")!.result.output.impact;
    assert.equal(debug.included, false);
    assert.equal(debug.skipReason, "not_refactor_like");
  });
});

test("run_pipeline accepts product-facing input names while preserving legacy aliases", async () => {
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
        query: "debug why createSession fails",
        intent: "debug",
        maxBudgetCharacters: 4_000,
      },
    });

    assert.equal(productFacing.result.ok, true);
    assert.equal(legacy.result.ok, true);
    assert.equal(productFacing.result.output.request.query, "debug why createSession fails");
    assert.equal(productFacing.result.output.request.task, "debug why createSession fails");
    assert.equal(productFacing.result.output.request.maxBudgetCharacters, 4_000);
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
      input: { query: "rename createSession" },
    });

    assert.equal(response.result.ok, true);
    const impact = response.result.output.impact;
    assert.equal(impact.included, true);
    assert.equal(impact.skipReason, null);
    assert.equal(impact.triggerReason, "refactor_preset");
    assert.equal(impact.selectionSource, "top_pivot_task_mention");
    assert.equal(impact.focalSymbol?.fqName, "src/session.ts::SessionManager.createSession");
    assert.deepEqual(impact.summary, {
      dependentSymbolCount: 2,
      dependentFileCount: 2,
      maxDepth: 2,
      maxObservedDistance: 2,
    });
    assert.equal(impact.topDependents?.length, 2);
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

    try {
      await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-compressed-seed",
        toolId: McpToolId.RunPipeline,
        input: {
          query: "rename createSession memory lifecycle",
          sessionId: "session-compress",
        },
      });
      const session = db.query(`
        SELECT last_activity_at_ms AS lastActivityAtMs
        FROM sessions
        WHERE session_id = 'session-compress'
      `).get() as { lastActivityAtMs: number };
      const compressed = compressInactiveSessions(db, {
        repoRoot,
        nowMs: session.lastActivityAtMs + DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS,
      });

      assert.equal(compressed.compressedSummaries.length, 1);

      const response = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-compressed-memory",
        toolId: McpToolId.RunPipeline,
        input: {
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
    const sourceRunId = listIndexRuns(db).at(-1)?.id;

    try {
      for (const [index, createdAtMs] of [100, 120, 140].entries()) {
        persistObservation(db, {
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
          createdAtMs,
          linkedFilePaths: ["src/session.ts"],
        });
      }

      const consolidated = consolidatePassiveObservationsForSession(db, {
        sessionId: "session-consolidated-memory",
        nowMs: 500,
      });

      assert.equal(consolidated?.consolidatedObservationIds.length, 1);

      const response = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-consolidated-memory",
        toolId: McpToolId.RunPipeline,
        input: {
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
      input: { query: "definitely_missing_pipeline_symbol" },
    });
    const unsupported = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-unsupported-shape",
      toolId: McpToolId.RunPipeline,
      input: { query: "!!! ???" },
    });

    assert.equal(noCandidates.result.ok, true);
    assert.equal(noCandidates.result.output.context.included, false);
    assert.equal(noCandidates.result.output.context.skipReason, "no_candidates");
    assert.equal(noCandidates.result.output.diagnostics.retrieval.finalReason, "no_candidates");

    assert.equal(unsupported.result.ok, true);
    assert.equal(unsupported.result.output.context.skipReason, "unsupported_query_shape");
    assert.equal(unsupported.result.output.diagnostics.retrieval.finalReason, "unsupported_query_shape");
  });
});

test("run_pipeline retries once with relaxed assembly when the profile-shaped capsule omits all useful context", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const db = openIndexerDatabase(initialized.paths.dbPath);

    try {
      const fallbackBudget = findRunPipelineFallbackBudget(db, initialized.repoRoot, "Session");
      assert.notEqual(fallbackBudget, null);

      const recovered = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-recovered",
        toolId: McpToolId.RunPipeline,
        input: {
          query: "Session",
          maxBudgetCharacters: fallbackBudget,
        },
      });

      assert.equal(recovered.result.ok, true);
      const retrieval = recovered.result.output.diagnostics.retrieval;
      assert.equal(retrieval.initialReason, "all_candidates_omitted");
      assert.equal(retrieval.fallbackApplied, true);
      assert.equal(retrieval.fallbackMode, "relaxed_unprofiled_assembly");
      assert.equal(retrieval.fallbackRecovered, true);
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

    try {
      createActiveProjectRule(db, {
        repoRoot: initialized.repoRoot,
        summary: "When changing session creation, inspect the controller caller.",
        files: ["src/session.ts"],
        terms: ["rename", "createSession"],
        nowMs: 100,
      });
      for (const createdAtMs of [200, 300, 400]) {
        persistObservation(db, {
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
      const generatedCandidates = generateProjectRuleCandidates(db, {
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
      input: { query: "rename createSession" },
    });
    const first = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-det-first",
      toolId: McpToolId.RunPipeline,
      input: { query: "rename createSession" },
    });
    const second = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-run-pipeline-det-second",
      toolId: McpToolId.RunPipeline,
      input: { query: "rename createSession" },
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
      input: { query: "Session", intent: "planetary" },
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

    try {
      const silentFirst = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-silent-1",
        toolId: McpToolId.RunPipeline,
        input: { query: "Session" },
      });
      assert.equal(silentFirst.result.ok, true);
      assert.equal(silentFirst.result.output.savedObservation, null);
      assert.equal(countObservations(db), 1);

      // Repeating the same silent call must dedupe — still exactly one observation.
      const silentSecond = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-silent-2",
        toolId: McpToolId.RunPipeline,
        input: { query: "Session" },
      });
      assert.equal(silentSecond.result.ok, true);
      assert.equal(silentSecond.result.output.savedObservation, null);
      assert.equal(countObservations(db), 1);

      const saved = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-saved",
        toolId: McpToolId.RunPipeline,
        input: {
          query: "Session",
          sessionId: "pipeline-session",
          saveObservation: true,
        },
      });
      assert.equal(saved.result.ok, true);
      assert.equal(saved.result.output.savedObservation?.observation.toolName, "run_pipeline");
      assert.equal(saved.result.output.savedObservation?.observation.sessionId, "pipeline-session");
      // Auto-capture (no session) + session-bound auto-capture + explicit session-bound observation.
      assert.equal(countObservations(db), 3);
      assert.equal(
        listObservations(db).some((observation) => {
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

    try {
      const noSession = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-nudge-no-session",
        toolId: McpToolId.RunPipeline,
        input: { query: "Session" },
      });
      assert.equal(noSession.result.ok, true);
      assert.equal(noSession.result.output.diagnostics.nudge.enabled, false);
      assert.equal(noSession.result.output.diagnostics.nudge.reason, "no_session");

      const first = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-nudge-1",
        toolId: McpToolId.RunPipeline,
        input: { query: "createSession", sessionId: "nudge-session" },
      });
      assert.equal(first.result.ok, true);
      assert.equal(first.result.output.diagnostics.nudge.enabled, false);
      assert.equal(first.result.output.diagnostics.nudge.reason, "below_threshold");
      assert.equal(first.result.output.diagnostics.nudge.toolCallCount, 1);

      await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-nudge-2",
        toolId: McpToolId.RunPipeline,
        input: { query: "loadSession", sessionId: "nudge-session" },
      });
      const third = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-nudge-3",
        toolId: McpToolId.RunPipeline,
        input: { query: "readSession", sessionId: "nudge-session" },
      });

      assert.equal(third.result.ok, true);
      assert.equal(third.result.output.diagnostics.nudge.enabled, true);
      assert.equal(third.result.output.diagnostics.nudge.level, "full");
      assert.equal(third.result.output.diagnostics.nudge.reason, "no_durable_observation_after_tool_activity");
      assert.equal(third.result.output.diagnostics.nudge.toolCallCount, 3);
      assert.equal(third.result.output.diagnostics.nudge.nextNudgeAfterToolCallCount, 8);

      const afterThirdCount = countObservations(db);
      assert.equal(
        listObservations(db).filter((observation) => observation.sessionId === "nudge-session").length,
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
      assert.equal(countObservations(db), afterThirdCount + 1);

      const afterDurable = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-run-pipeline-nudge-after-durable",
        toolId: McpToolId.RunPipeline,
        input: { query: "SessionManager", sessionId: "nudge-session" },
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
      input: { query: "session manager", maxBudgetCharacters: 4_000 },
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

test("get_code_context auto-refreshes a stale index before running context retrieval", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const bound = await createRepoBoundMcpServer({ repoPath: repoRoot });
    const server = bound.server;

    await recordObservedFileChanges({
      repoRoot,
      statePath: initialized.paths.statePath,
      changedFilePaths: ["src/session.ts"],
      nowMs: 6_000,
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-get-code-context-auto-refresh-stale",
      toolId: McpToolId.GetCodeContext,
      input: { query: "session manager", maxBudgetCharacters: 4_000 },
    });
    const status = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-index-status-after-get-code-context-refresh",
      toolId: McpToolId.IndexStatus,
      input: {},
    });

    assert.equal(response.result.ok, true);
    assert.equal(response.result.output.diagnostics.indexFreshness.status, "refreshed");
    assert.equal(response.result.output.diagnostics.indexFreshness.reason, "stale_index");
    assert.equal(response.result.output.diagnostics.indexFreshness.action, "auto_index_repo");
    assert.equal(response.result.output.diagnostics.indexFreshness.beforeState, "possibly_stale");
    assert.equal(response.result.output.diagnostics.indexFreshness.afterState, "fresh");
    assert.equal(response.result.output.diagnostics.freshness.state, "fresh");

    assert.equal(status.result.ok, true);
    assert.equal(status.result.output.freshness.state, "fresh");
    assert.equal(status.result.output.freshness.isStale, false);
    assert.equal(status.result.output.freshness.observedFileChanges, null);
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
    ]);
    assert.equal(
      response.result.output.coverage.notes.includes(
        "Structural-only reverse impact view built from indexed contains, imports, calls, and references edges.",
      ),
      true,
    );
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
    assert.deepEqual(standardRepeat.result.output, standard.result.output);
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

      assert.equal((await server.handleRequest(impactRequest)).result.ok, true);
      assert.equal((await server.handleRequest(impactRequest)).result.ok, true);
      assert.equal(countObservations(db), 1);

      assert.equal((await server.handleRequest(skeletonRequest)).result.ok, true);
      assert.equal((await server.handleRequest(skeletonRequest)).result.ok, true);
      assert.equal(countObservations(db), 2);

      assert.equal((await server.handleRequest(logicFlowRequest)).result.ok, true);
      assert.equal((await server.handleRequest(logicFlowRequest)).result.ok, true);
      assert.equal(countObservations(db), 3);

      const observations = listObservations(db);
      const impact = observations.find((observation) => observation.toolName === "get_impact_graph");
      const skeleton = observations.find((observation) => observation.toolName === "get_skeleton");
      const logicFlow = observations.find((observation) => observation.toolName === "search_logic_flow");

      assert.equal(impact?.kind, "tool_call");
      assert.equal(impact?.source, "mcp_auto");
      assert.equal(impact?.queryText, "src/session.ts::SessionManager.createSession");
      assert.equal(impact?.summary.includes("with 2 dependents"), true);
      assert.deepEqual(impact?.linkedFilePaths, ["src/session.ts", "src/controller.ts"]);
      assert.equal(impact?.linkedFqNames.includes("src/session.ts::SessionManager.createSession"), true);
      assert.equal(impact?.body.includes("view.lines"), false);

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
      assert.equal(countObservations(db), 4);

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
      assert.equal(countObservations(db), 5);
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
      assert.equal(countObservations(db), 0);

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
      assert.equal(countObservations(db), 1);
      assert.equal(listObservations(db)[0]?.summary, "Explicit save only");
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
      assert.equal(countObservations(db), 1, "save_observation should only create its explicit row");

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

test("get_context_capsule auto-captures one deduped tool-call observation on happy path without surfacing it as self-echo memory", async () => {
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

    try {
      assert.equal(first.result.ok, true);
      assert.deepEqual(second.result.output, first.result.output);
      assert.equal(countObservations(db), 1);
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

test("build_capsule no longer has unique memory behavior — calling it does not create a new observation when get_context_capsule already auto-captured the same inputs", async () => {
  await withFixture(async (repoRoot) => {
    await writeMcpFixtureRepo(repoRoot);
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({
      context: { repoRoot: initialized.repoRoot },
    });
    const db = openIndexerDatabase(initialized.paths.dbPath);

    try {
      // get_context_capsule auto-captures one observation.
      await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-visible-capsule",
        toolId: McpToolId.GetContextCapsule,
        input: { query: "Session" },
      });
      assert.equal(countObservations(db), 1);

      // build_capsule (hidden legacy) must not add its own observation.
      const legacy = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: "req-legacy-build-capsule",
        toolId: McpToolId.BuildCapsule,
        input: { query: "Session" },
      });
      assert.equal(legacy.result.ok, true);
      assert.equal(countObservations(db), 1);

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

    try {
      const sourceRunId = listIndexRuns(db).at(-1)!.id;
      const routed = routeQuery(db, "readUser", { maxResults: 2 });
      const capsule = buildCapsule(
        createSourceBackedCapsuleBuilder({ db, repoRoot }),
        {
          query: "readUser",
          rerankedCandidates: routed.rerankedResults,
          supportingCandidates: [],
          maxBudget: createCharacterBudget(2_000),
        },
      );
      const manifest = persistCapsuleManifest(db, {
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

    try {
      const sourceRunId = listIndexRuns(db).at(-1)!.id;
      const routed = routeQuery(db, "readUser", { maxResults: 2 });
      const capsule = buildCapsule(
        createSourceBackedCapsuleBuilder({ db, repoRoot }),
        {
          query: "readUser",
          rerankedCandidates: routed.rerankedResults,
          supportingCandidates: [],
          maxBudget: createCharacterBudget(2_000),
        },
      );
      const manifest = persistCapsuleManifest(db, {
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
): {
  exitCode: number | null;
  stderr: string;
  responses: Record<string, unknown>[];
} {
  const input = Buffer.concat(messages.map(encodeLineJson));
  const child = spawnSync(process.execPath, ["src/mcp/server.ts", "--repo", repoRoot], {
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
