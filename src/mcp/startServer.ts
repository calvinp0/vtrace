// @ts-nocheck
import { access } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  detectRepoRoot,
  readRepoLocalConfig,
  readRepoLocalState,
  resolveRepoLocalPaths,
} from "../setup/repoState";
import type {
  RepoLocalConfig,
  RepoLocalState,
  RepoReadiness,
  RepoRootDetectionMode,
  RepoRootMarker,
} from "../setup/types";
import { createMcpServer, createMcpServerContext } from "./server";
import {
  MCP_SERVER_ID,
  MCP_SERVER_SCHEMA,
  type McpToolMetadata,
  type McpServer,
} from "./types";

const JSON_RPC_VERSION = "2.0" as const;
const MCP_PROTOCOL_VERSION = "2024-11-05" as const;
const MCP_SERVER_USAGE = [
  "Usage: vtrace mcp-serve --repo <repo>",
  "",
  "Starts a local stdio MCP server bound to a repo root.",
  "Engine-backed tools require repo-local state and a ready index.",
  "Setup and status tools work before init.",
  "Visible tool surface: setup/status tools, capsule wrappers, observation/session tools, and a few reserved placeholders.",
  "Docs: docs/getting_started.md and docs/mcp_tools.md",
  "",
].join("\n");

const JSON_RPC_ERROR_CODE = Object.freeze({
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
});

interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
}

interface JsonRpcResponse {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorObject;
}

interface JsonRpcRequest {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

interface FramedJsonMessage {
  readonly messageText: string;
  readonly remaining: Buffer;
}

type StdioTransportMode = "unknown" | "framed" | "line";

interface HeaderTerminator {
  readonly index: number;
  readonly length: number;
}

/**
 * The one authoritative agent-facing routing policy for the vtrace tool suite.
 *
 * Routing semantics belong here, stated once and visibly, rather than smuggled
 * into an individual tool's adjectives ("the default first-pass tool") where
 * they are neither reviewable nor measurable. Two rules govern its content:
 *
 *  - It may say WHEN a capability is applicable, because a suite of specialized
 *    tools is not discoverable without that.
 *  - It may NOT constrain the agent's own investigation. No "do not grep", no
 *    "patch immediately", no search budgets. Those suppress the ordinary work we
 *    need to keep measurable, and they are what made historical scaffolds
 *    measure prompt engineering rather than repository intelligence.
 *
 * The closing sentence is load-bearing in the other direction: it states that
 * ordinary repository tools remain available, so the policy cannot be read as
 * discouraging them.
 */
export const VTRACE_TOOL_SUITE_POLICY = [
  "Repository-intelligence workflow:",
  "",
  "- Use get_code_context as the initial repository-orientation tool for",
  "  coding/debugging/refactoring tasks.",
  "",
  "- Use get_impact_graph when considering a specific symbol change and",
  "  caller/dependent/blast-radius evidence would help. Pass the canonical",
  "  identity returned as get_code_context items[].fqName.",
  "",
  "- VTRACE results are selective evidence, not proof that omitted code",
  "  does not exist. Ordinary repository tools remain available and should",
  "  be used whenever useful.",
].join("\n");

export interface RepoBoundMcpServerStartup {
  readonly requestedPath: string;
  readonly repoRoot: string;
  readonly detectionMode: RepoRootDetectionMode;
  readonly detectionMarker?: RepoRootMarker;
  readonly initialized: boolean;
  readonly configPath: string;
  readonly statePath: string;
  readonly dbPath: string;
  readonly readiness: RepoReadiness | null;
  readonly toolIds: readonly string[];
}

export interface RepoBoundMcpServer {
  readonly server: McpServer;
  readonly startup: RepoBoundMcpServerStartup;
}

export interface CreateRepoBoundMcpServerOptions {
  readonly repoPath: string;
  readonly cwd?: string;
}

export interface StartMcpServerOptions extends CreateRepoBoundMcpServerOptions {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

export async function createRepoBoundMcpServer(
  options: CreateRepoBoundMcpServerOptions,
): Promise<RepoBoundMcpServer> {
  const requestedPath = path.resolve(options.cwd ?? process.cwd(), options.repoPath);
  const detection = await detectRepoRoot(requestedPath);
  const paths = resolveRepoLocalPaths(detection.repoRoot);
  const config = await readOptionalRepoConfig(paths.configPath);
  const state = await readOptionalRepoState(paths.statePath);
  const dbPath = config?.dbPath ?? state?.dbPath ?? paths.dbPath;
  const initialized = config?.initialized === true && state?.initialized === true;

  const server = createMcpServer({
    context: createMcpServerContext({
      repoRoot: detection.repoRoot,
      dbPath,
      configPath: paths.configPath,
      statePath: paths.statePath,
      initialized,
      config: config ?? null,
      state: state ?? null,
    }),
  });

  return {
    server,
    startup: {
      requestedPath,
      repoRoot: detection.repoRoot,
      detectionMode: detection.mode,
      ...(detection.marker === undefined ? {} : { detectionMarker: detection.marker }),
      initialized,
      configPath: paths.configPath,
      statePath: paths.statePath,
      dbPath,
      readiness: state === undefined ? null : structuredClone(state.readiness),
      toolIds: server.listTools().map((tool) => tool.toolId),
    },
  };
}

export async function startMcpServer(
  options: StartMcpServerOptions,
): Promise<RepoBoundMcpServerStartup> {
  const bound = await createRepoBoundMcpServer(options);

  await serveMcpStdioSession(bound, {
    stdin: options.stdin ?? process.stdin,
    stdout: options.stdout ?? process.stdout,
  });

  return bound.startup;
}

export async function runMcpServerCli(
  argv: readonly string[],
  io: {
    stdin?: Readable;
    stdout?: Writable;
    stderr?: Writable;
  } = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  try {
    const parsed = parseMcpServerArgs(argv);

    if (parsed.help) {
      await writeText(stdout, MCP_SERVER_USAGE);
      return 0;
    }

    await startMcpServer({
      repoPath: parsed.repoPath,
      stdin: io.stdin ?? process.stdin,
      stdout,
      stderr,
    });

    return 0;
  } catch (error) {
    await writeText(stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseMcpServerArgs(
  argv: readonly string[],
): { help: true } | { help: false; repoPath: string } {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--repo") {
      const repoPath = argv[index + 1];

      if (typeof repoPath !== "string" || repoPath.trim().length === 0) {
        throw new Error(MCP_SERVER_USAGE.trimEnd());
      }

      return {
        help: false,
        repoPath,
      };
    }

    if (argument.startsWith("--repo=")) {
      const repoPath = argument.slice("--repo=".length).trim();

      if (repoPath.length === 0) {
        throw new Error(MCP_SERVER_USAGE.trimEnd());
      }

      return {
        help: false,
        repoPath,
      };
    }
  }

  throw new Error(MCP_SERVER_USAGE.trimEnd());
}

async function serveMcpStdioSession(
  bound: RepoBoundMcpServer,
  io: {
    stdin: Readable;
    stdout: Writable;
  },
): Promise<void> {
  let buffer = Buffer.alloc(0);
  let draining = false;
  let ended = false;
  let redrainRequested = false;
  let transportMode: StdioTransportMode = "unknown";

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      io.stdin.off("data", onData);
      io.stdin.off("end", onEnd);
      io.stdin.off("error", onError);
    };

    const finishIfEnded = () => {
      if (!ended || draining) {
        return;
      }

      cleanup();
      resolve();
    };

    const onEnd = () => {
      ended = true;
      finishIfEnded();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const drainBuffer = async () => {
      if (draining) {
        redrainRequested = true;
        return;
      }

      draining = true;

      try {
        do {
          redrainRequested = false;

          while (true) {
            let parsed: (FramedJsonMessage & { readonly mode: StdioTransportMode }) | null;

            try {
              parsed = extractJsonRpcMessage(buffer, transportMode);
            } catch (error) {
              await writeJsonRpcMessage(io.stdout, makeJsonRpcErrorResponse(
                null,
                JSON_RPC_ERROR_CODE.InvalidRequest,
                error instanceof Error ? error.message : String(error),
              ), transportMode === "unknown" ? "line" : transportMode);
              buffer = Buffer.alloc(0);
              return;
            }

            if (parsed === null) {
              break;
            }

            buffer = parsed.remaining;
            transportMode = parsed.mode;

            if (parsed.messageText.trim().length === 0) {
              continue;
            }

            let message: unknown;

            try {
              message = JSON.parse(parsed.messageText) as unknown;
            } catch {
              await writeJsonRpcMessage(io.stdout, makeJsonRpcErrorResponse(
                null,
                JSON_RPC_ERROR_CODE.ParseError,
                "Invalid JSON payload.",
              ), transportMode);
              continue;
            }

            const response = await handleJsonRpcMessage(bound, message);

            if (response !== undefined) {
              await writeJsonRpcMessage(io.stdout, response, transportMode);
            }
          }
        } while (redrainRequested);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      } finally {
        draining = false;

        if (redrainRequested && !ended) {
          queueMicrotask(() => {
            void drainBuffer();
          });
        }

        finishIfEnded();
      }
    };

    const onData = (chunk: string | Buffer) => {
      const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      buffer = Buffer.concat([buffer, incoming]);

      if (draining) {
        redrainRequested = true;
        return;
      }

      void drainBuffer();
    };

    io.stdin.on("data", onData);
    io.stdin.on("end", onEnd);
    io.stdin.on("error", onError);
    io.stdin.resume();
  });
}

async function handleJsonRpcMessage(
  bound: RepoBoundMcpServer,
  message: unknown,
): Promise<JsonRpcResponse | undefined> {
  if (!isRecord(message) || message.jsonrpc !== JSON_RPC_VERSION || typeof message.method !== "string") {
    return makeJsonRpcErrorResponse(
      getJsonRpcId(message),
      JSON_RPC_ERROR_CODE.InvalidRequest,
      "Invalid JSON-RPC request.",
    );
  }

  const request = message as JsonRpcRequest;
  const id = request.id;

  switch (request.method) {
    case "initialize":
      return id === undefined
        ? undefined
        : {
          jsonrpc: JSON_RPC_VERSION,
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: {
                listChanged: false,
              },
            },
            serverInfo: {
              name: MCP_SERVER_ID,
              version: MCP_SERVER_SCHEMA.version,
            },
            instructions: `Repo-bound vtrace MCP server for ${bound.startup.repoRoot}. Use tools/list to inspect available tools.\n\n${VTRACE_TOOL_SUITE_POLICY}`,
          },
        };
    case "notifications/initialized":
      return undefined;
    case "ping":
      return id === undefined
        ? undefined
        : {
          jsonrpc: JSON_RPC_VERSION,
          id,
          result: {},
        };
    case "tools/list":
      return id === undefined
        ? undefined
        : {
          jsonrpc: JSON_RPC_VERSION,
          id,
          result: {
            tools: bound.server.listTools().map(formatListedToolDescriptor),
          },
        };
    case "tools/call": {
      if (id === undefined) {
        return undefined;
      }

      if (!isRecord(request.params)) {
        return makeJsonRpcErrorResponse(
          id,
          JSON_RPC_ERROR_CODE.InvalidParams,
          "tools/call requires an object params payload.",
        );
      }

      const toolName = request.params.name;
      const toolArguments = request.params.arguments;

      if (typeof toolName !== "string" || toolName.trim().length === 0) {
        return makeJsonRpcErrorResponse(
          id,
          JSON_RPC_ERROR_CODE.InvalidParams,
          "tools/call requires a non-empty string name.",
        );
      }

      if (toolArguments !== undefined && !isRecord(toolArguments)) {
        return makeJsonRpcErrorResponse(
          id,
          JSON_RPC_ERROR_CODE.InvalidParams,
          "tools/call arguments must be an object when provided.",
        );
      }

      const toolResponse = await bound.server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: createToolRequestId(id, toolName),
        toolId: toolName,
        input: toolArguments ?? {},
      });

      return {
        jsonrpc: JSON_RPC_VERSION,
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                toolResponse.result.ok
                  ? toolResponse.result.output
                  : toolResponse.result.error,
              ),
            },
          ],
          structuredContent: toolResponse,
          isError: !toolResponse.result.ok,
        },
      };
    }
    default:
      return id === undefined
        ? undefined
        : makeJsonRpcErrorResponse(
          id,
          JSON_RPC_ERROR_CODE.MethodNotFound,
          `Method not found: ${request.method}`,
        );
  }
}

function extractJsonRpcMessage(
  buffer: Buffer,
  transportMode: StdioTransportMode,
): (FramedJsonMessage & { readonly mode: StdioTransportMode }) | null {
  if (buffer.length === 0) {
    return null;
  }

  if (transportMode === "framed") {
    const framed = extractFramedMessage(buffer);
    return framed === null ? null : { ...framed, mode: "framed" };
  }

  if (transportMode === "line") {
    const line = extractLineDelimitedMessage(buffer);
    return line === null ? null : { ...line, mode: "line" };
  }

  const trimmedStart = buffer.toString("utf8", 0, Math.min(buffer.length, 32)).trimStart();

  if (trimmedStart.toLowerCase().startsWith("content-length:")) {
    const framed = extractFramedMessage(buffer);
    return framed === null ? null : { ...framed, mode: "framed" };
  }

  const line = extractLineDelimitedMessage(buffer);
  return line === null ? null : { ...line, mode: "line" };
}

function extractFramedMessage(buffer: Buffer): FramedJsonMessage | null {
  const terminator = findHeaderTerminator(buffer);

  if (terminator === null) {
    return null;
  }

  const headerText = buffer.subarray(0, terminator.index).toString("utf8");
  const contentLength = parseContentLength(headerText);
  const bodyStartIndex = terminator.index + terminator.length;
  const bodyEndIndex = bodyStartIndex + contentLength;

  if (buffer.length < bodyEndIndex) {
    return null;
  }

  return {
    messageText: buffer.subarray(bodyStartIndex, bodyEndIndex).toString("utf8"),
    remaining: buffer.subarray(bodyEndIndex),
  };
}

function extractLineDelimitedMessage(buffer: Buffer): FramedJsonMessage | null {
  const newlineIndex = buffer.indexOf("\n");

  if (newlineIndex < 0) {
    return null;
  }

  const line = buffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/u, "");
  const remaining = buffer.subarray(newlineIndex + 1);

  if (line.trim().length === 0) {
    return {
      messageText: "",
      remaining,
    };
  }

  return {
    messageText: line,
    remaining,
  };
}

function findHeaderTerminator(buffer: Buffer): HeaderTerminator | null {
  const crlfIndex = buffer.indexOf("\r\n\r\n");

  if (crlfIndex >= 0) {
    return {
      index: crlfIndex,
      length: 4,
    };
  }

  const lfIndex = buffer.indexOf("\n\n");

  if (lfIndex >= 0) {
    return {
      index: lfIndex,
      length: 2,
    };
  }

  return null;
}

function parseContentLength(headerText: string): number {
  const headerLine = headerText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().startsWith("content-length:"));

  if (headerLine === undefined) {
    throw new Error("Missing Content-Length header.");
  }

  const rawLength = headerLine.slice("content-length:".length).trim();
  const parsed = Number.parseInt(rawLength, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("Invalid Content-Length header.");
  }

  return parsed;
}

function createToolRequestId(id: string | number | null, toolName: string): string {
  return `jsonrpc:${String(id)}:${toolName}`;
}

function formatListedToolDescriptor(tool: McpToolMetadata) {
  return {
    name: tool.toolId,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
  };
}

function makeJsonRpcErrorResponse(
  id: string | number | null | undefined,
  code: number,
  message: string,
): JsonRpcResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: id ?? null,
    error: {
      code,
      message,
    },
  };
}

async function readOptionalRepoConfig(
  configPath: string,
): Promise<RepoLocalConfig | undefined> {
  try {
    return await readRepoLocalConfig(configPath);
  } catch {
    return undefined;
  }
}

async function readOptionalRepoState(
  statePath: string,
): Promise<RepoLocalState | undefined> {
  try {
    return await readRepoLocalState(statePath);
  } catch {
    return undefined;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonRpcMessage(
  output: Writable,
  message: JsonRpcResponse,
  transportMode: StdioTransportMode,
): Promise<void> {
  const encodedBody = Buffer.from(JSON.stringify(message), "utf8");

  if (transportMode === "framed") {
    const encodedMessage = Buffer.concat([
      Buffer.from(`Content-Length: ${encodedBody.length}\r\n\r\n`, "utf8"),
      encodedBody,
    ]);
    output.write(encodedMessage);
    return;
  }

  output.write(Buffer.concat([
    encodedBody,
    Buffer.from("\n", "utf8"),
  ]));
}

async function writeText(output: Writable, text: string): Promise<void> {
  output.write(text);
}

function getJsonRpcId(message: unknown): string | number | null | undefined {
  if (!isRecord(message) || !("id" in message)) {
    return undefined;
  }

  const value = message.id;

  if (typeof value === "string" || typeof value === "number" || value === null) {
    return value;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
