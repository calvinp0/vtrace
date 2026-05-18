import type {
  McpToolDefinition,
  McpToolId,
  McpToolLookupResult,
  McpToolMetadata,
} from "./types";

export interface CreateMcpToolRegistryInput {
  readonly tools: readonly McpToolDefinition[];
  readonly hiddenTools?: readonly McpToolDefinition[];
}

export interface McpToolRegistry {
  readonly tools: readonly McpToolDefinition[];
  listMetadata(): readonly McpToolMetadata[];
  getByToolId(toolId: McpToolId): McpToolDefinition | undefined;
  lookup(toolId: McpToolId): McpToolLookupResult;
}

export function createMcpToolRegistry(
  input: CreateMcpToolRegistryInput,
): McpToolRegistry {
  const visibleTools = [...input.tools];
  const hiddenTools = [...(input.hiddenTools ?? [])];
  const tools = [...visibleTools, ...hiddenTools];
  const toolsById = new Map<McpToolId, McpToolDefinition>();

  for (const tool of tools) {
    if (toolsById.has(tool.metadata.toolId)) {
      throw new Error(`Duplicate MCP tool id: ${tool.metadata.toolId}`);
    }

    toolsById.set(tool.metadata.toolId, tool);
  }

  const metadataList = Object.freeze(visibleTools.map((tool) => tool.metadata));

  return {
    tools: Object.freeze(tools),
    listMetadata() {
      return metadataList;
    },
    getByToolId(toolId) {
      return toolsById.get(toolId);
    },
    lookup(toolId) {
      const tool = toolsById.get(toolId);

      if (tool === undefined) {
        return {
          requestedToolId: toolId,
          explanation: {
            found: false,
            summary: `MCP tool ${toolId} is not registered.`,
          },
        };
      }

      return {
        requestedToolId: toolId,
        tool,
        explanation: {
          found: true,
          summary: `Resolved MCP tool ${toolId}.`,
        },
      };
    },
  };
}
