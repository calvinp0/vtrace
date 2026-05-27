import type { RepoLocalConfig, RepoLocalState } from "../setup/types";

export const MCP_SERVER_SCHEMA_NAME = "vtrace.mcp_server" as const;
export const MCP_SERVER_SCHEMA_VERSION = "1.0.0" as const;
export const MCP_SERVER_ID = "vtrace_rc1_mcp" as const;

export type McpServerSchemaName = typeof MCP_SERVER_SCHEMA_NAME;
export type McpServerSchemaVersion = typeof MCP_SERVER_SCHEMA_VERSION;
export type McpServerId = typeof MCP_SERVER_ID;

export const McpToolId = Object.freeze({
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

export type McpToolId =
  | (typeof McpToolId)[keyof typeof McpToolId]
  | (string & {});

export const McpToolAvailability = Object.freeze({
  Placeholder: "placeholder",
  Wired: "wired",
});

export type McpToolAvailability =
  (typeof McpToolAvailability)[keyof typeof McpToolAvailability];

export const McpToolHandlerKind = Object.freeze({
  Placeholder: "placeholder",
  EngineDelegate: "engine_delegate",
});

export type McpToolHandlerKind =
  (typeof McpToolHandlerKind)[keyof typeof McpToolHandlerKind];

export const McpErrorCode = Object.freeze({
  UnknownTool: "unknown_tool",
  ToolUnavailable: "tool_unavailable",
  InvalidRequest: "invalid_request",
  RepoNotReady: "repo_not_ready",
  HandlerFailed: "handler_failed",
});

export type McpErrorCode =
  (typeof McpErrorCode)[keyof typeof McpErrorCode];

export type McpSchemaType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "null";

export interface McpSchemaProperty {
  readonly type: McpSchemaType | readonly McpSchemaType[];
  readonly description: string;
  readonly properties?: Readonly<Record<string, McpSchemaProperty>>;
  readonly required?: readonly string[];
  readonly items?: McpSchemaProperty;
  readonly additionalProperties?: boolean;
}

export interface McpObjectSchema {
  readonly type: "object";
  readonly description: string;
  readonly properties: Readonly<Record<string, McpSchemaProperty>>;
  readonly required: readonly string[];
  readonly additionalProperties: boolean;
}

export interface McpServerSchemaDescriptor {
  readonly name: McpServerSchemaName;
  readonly version: McpServerSchemaVersion;
}

export interface McpToolRegistrationMetadata {
  readonly registered: boolean;
  readonly reserved: boolean;
  readonly availability: McpToolAvailability;
  readonly handlerKind: McpToolHandlerKind;
}

export interface McpToolMetadata {
  readonly toolId: McpToolId;
  readonly displayName: string;
  readonly description: string;
  readonly inputSchema: McpObjectSchema;
  readonly outputSchema: McpObjectSchema;
  readonly registration: McpToolRegistrationMetadata;
}

export interface McpServerContext {
  readonly serverId: McpServerId;
  readonly repoRoot: string | null;
  readonly dbPath: string | null;
  readonly configPath: string | null;
  readonly statePath: string | null;
  readonly initialized: boolean;
  readonly config: RepoLocalConfig | null;
  readonly state: RepoLocalState | null;
}

export interface McpToolError {
  readonly code: McpErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface McpToolRequestEnvelope<TInput = unknown> {
  readonly schema: McpServerSchemaDescriptor;
  readonly requestId: string;
  readonly toolId: McpToolId;
  readonly input: TInput;
}

export interface McpToolSuccessResult<TOutput = unknown> {
  readonly ok: true;
  readonly output: TOutput;
}

export interface McpToolFailureResult {
  readonly ok: false;
  readonly error: McpToolError;
}

export type McpToolExecutionResult<TOutput = unknown> =
  | McpToolSuccessResult<TOutput>
  | McpToolFailureResult;

export interface McpToolResponseEnvelope<TOutput = unknown> {
  readonly schema: McpServerSchemaDescriptor;
  readonly requestId: string;
  readonly toolId: McpToolId;
  readonly result: McpToolExecutionResult<TOutput>;
}

export interface McpToolHandlerInput<TInput = unknown> {
  readonly context: McpServerContext;
  readonly request: McpToolRequestEnvelope<TInput>;
}

export type McpToolHandler<TInput = unknown, TOutput = unknown> = (
  input: McpToolHandlerInput<TInput>,
) => Promise<McpToolExecutionResult<TOutput>> | McpToolExecutionResult<TOutput>;

export interface McpToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly metadata: McpToolMetadata;
  readonly handler: McpToolHandler<TInput, TOutput>;
}

export interface McpToolLookupExplanation {
  readonly found: boolean;
  readonly summary: string;
}

export interface McpToolLookupResult {
  readonly requestedToolId: McpToolId;
  readonly tool?: McpToolDefinition;
  readonly explanation: McpToolLookupExplanation;
}

export interface McpServer {
  readonly schema: McpServerSchemaDescriptor;
  readonly context: McpServerContext;
  listTools(): readonly McpToolMetadata[];
  lookupTool(toolId: McpToolId): McpToolLookupResult;
  handleRequest<TInput = unknown, TOutput = unknown>(
    request: McpToolRequestEnvelope<TInput>,
  ): Promise<McpToolResponseEnvelope<TOutput>>;
}

export const MCP_SERVER_SCHEMA = Object.freeze({
  name: MCP_SERVER_SCHEMA_NAME,
  version: MCP_SERVER_SCHEMA_VERSION,
}) satisfies McpServerSchemaDescriptor;
