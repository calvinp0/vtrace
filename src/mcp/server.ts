import { resolveRepoLocalPaths } from "../setup/repoState";
import { defaultMcpToolRegistry } from "./tools";
import {
  MCP_SERVER_ID,
  MCP_SERVER_SCHEMA,
  McpErrorCode,
  type McpServer,
  type McpServerContext,
  type McpToolError,
  type McpToolRequestEnvelope,
  type McpToolResponseEnvelope,
} from "./types";
import type { McpToolRegistry } from "./registry";

export interface CreateMcpServerInput {
  readonly context?: Partial<McpServerContext>;
  readonly registry?: McpToolRegistry;
}

export function createMcpServerContext(
  input: Partial<McpServerContext> = {},
): McpServerContext {
  const config = input.config ?? null;
  const state = input.state ?? null;
  const repoRoot = input.repoRoot ?? config?.repoRoot ?? state?.repoRoot ?? null;
  const repoLocalPaths = repoRoot === null ? null : resolveRepoLocalPaths(repoRoot);

  return {
    serverId: MCP_SERVER_ID,
    repoRoot,
    dbPath: input.dbPath ?? config?.dbPath ?? state?.dbPath ?? repoLocalPaths?.dbPath ?? null,
    configPath: input.configPath ?? repoLocalPaths?.configPath ?? null,
    statePath: input.statePath ?? config?.statePath ?? repoLocalPaths?.statePath ?? null,
    initialized: input.initialized ?? config?.initialized ?? state?.initialized ?? false,
    config,
    state,
  };
}

export function createMcpServer(
  input: CreateMcpServerInput = {},
): McpServer {
  const registry = input.registry ?? defaultMcpToolRegistry;
  const context = createMcpServerContext(input.context);

  return {
    schema: MCP_SERVER_SCHEMA,
    context,
    listTools() {
      return registry.listMetadata();
    },
    lookupTool(toolId) {
      return registry.lookup(toolId);
    },
    async handleRequest(request) {
      const lookup = registry.lookup(request.toolId);

      if (!lookup.explanation.found || lookup.tool === undefined) {
        return makeErrorResponse(request, {
          code: McpErrorCode.UnknownTool,
          message: `Unknown MCP tool: ${request.toolId}`,
          details: {
            availableToolIds: registry.listMetadata().map((tool) => tool.toolId),
          },
        });
      }

      try {
        const result = await lookup.tool.handler({
          context,
          request,
        });

        return {
          schema: MCP_SERVER_SCHEMA,
          requestId: request.requestId,
          toolId: request.toolId,
          result,
        };
      } catch (error) {
        return makeErrorResponse(request, {
          code: McpErrorCode.HandlerFailed,
          message: `MCP tool ${request.toolId} handler failed.`,
          details: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    },
  };
}

function makeErrorResponse<TInput = unknown, TOutput = unknown>(
  request: McpToolRequestEnvelope<TInput>,
  error: McpToolError,
): McpToolResponseEnvelope<TOutput> {
  return {
    schema: MCP_SERVER_SCHEMA,
    requestId: request.requestId,
    toolId: request.toolId,
    result: {
      ok: false,
      error,
    },
  };
}

if (import.meta.main) {
  const { runMcpServerCli } = await import("./startServer");
  const exitCode = await runMcpServerCli(process.argv.slice(2));

  process.exit(exitCode);
}
