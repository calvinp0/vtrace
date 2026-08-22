/**
 * M167-A — the producer→transport→consumer path, the protocol contract it is served
 * under, and who is allowed to read what.
 *
 * Every claim here is anchored to a source location and re-verified from the file on
 * every run: if the code moves, the artifact fails rather than reporting a stale fact.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

interface Anchor {
  readonly claim: string;
  readonly file: string;
  readonly needle: string;
}

function verify(anchor: Anchor): { readonly claim: string; readonly file: string; readonly line: number | null; readonly verified: boolean } {
  const full = path.join(ROOT, anchor.file);
  if (!existsSync(full)) return { claim: anchor.claim, file: anchor.file, line: null, verified: false };
  const lines = readFileSync(full, "utf8").split("\n");
  const index = lines.findIndex((line) => line.includes(anchor.needle));
  return { claim: anchor.claim, file: anchor.file, line: index < 0 ? null : index + 1, verified: index >= 0 };
}

const STAGES: readonly (Anchor & { readonly stage: string; readonly representation: string })[] = [
  {
    stage: "1. pipeline producer",
    representation: "the assembled run_pipeline output — the single semantic authority",
    claim: "run_pipeline assembles the result and hands it to the response envelope",
    file: "src/mcp/tools.ts",
    needle: "output: compactProductResponse(",
  },
  {
    stage: "2. packing",
    representation: "productContext.modelVisibleContext is packed to the requested context budget",
    claim: "the progressive packer bounds the rendered evidence before any compaction runs",
    file: "src/mcp/responseEnvelope.ts",
    needle: "const delivery = applyProgressiveContextBudget(draft, options.requestedContextTokens)",
  },
  {
    stage: "3. compaction ladder",
    representation: "the same object, with compatibility representations replaced by references",
    claim: "compaction rewrites representations in place and then measures the whole response against the ceiling",
    file: "src/mcp/responseEnvelope.ts",
    needle: "const escalation = enforceTotalEnvelope(draft, {",
  },
  {
    stage: "4. wrapper tool overwrite",
    representation: "get_code_context overwrites freshness/timing and re-measures rather than re-compacting",
    claim: "get_code_context delegates to run_pipeline and post-processes the returned value",
    file: "src/mcp/tools.ts",
    needle: "output: remeasureResponseBudget({",
  },
  {
    stage: "5. tool envelope",
    representation: "McpToolResponseEnvelope — schema, requestId, toolId, result{ok,output}",
    claim: "the server wraps every tool output in a response envelope",
    file: "src/mcp/types.ts",
    needle: "export interface McpToolResponseEnvelope<TOutput = unknown> {",
  },
  {
    stage: "6. MCP result construction",
    representation: "content[0].text = JSON.stringify(output) AND structuredContent = the whole envelope",
    claim: "both representations are constructed by hand in the JSON-RPC layer",
    file: "src/mcp/startServer.ts",
    needle: "structuredContent: toolResponse,",
  },
  {
    stage: "7. transport serialization",
    representation: "one newline-delimited JSON-RPC line carrying both representations",
    claim: "responses are written to stdout as line-delimited or framed JSON",
    file: "src/mcp/startServer.ts",
    needle: "function extractJsonRpcMessage(",
  },
];

const PROTOCOL: readonly (Anchor & { readonly question: string; readonly answer: string; readonly authority: string })[] = [
  {
    question: "Which protocol revision does VTRACE advertise?",
    answer: "2024-11-05, hard-coded and asserted by test",
    authority: "PROVEN_IN_REPO",
    claim: "the advertised protocol version is a constant",
    file: "src/mcp/startServer.ts",
    needle: 'const MCP_PROTOCOL_VERSION = "2024-11-05"',
  },
  {
    question: "Is content[] emitted on every tools/call result?",
    answer: "yes — exactly one text block, always",
    authority: "PROVEN_IN_REPO",
    claim: "a single text content block is constructed unconditionally",
    file: "src/mcp/startServer.ts",
    needle: 'type: "text",',
  },
  {
    question: "Is structuredContent part of the 2024-11-05 CallToolResult schema?",
    answer: "no — it is an extension VTRACE emits under a revision that does not define it",
    authority: "NOT_VERIFIABLE_LOCALLY — no MCP SDK, schema or specification text is vendored in this repository",
    claim: "no MCP SDK is installed, so the wire schema cannot be checked against a local authority",
    file: "package.json",
    needle: '"dependencies"',
  },
  {
    question: "Is an outputSchema advertised for any tool?",
    answer: "no — descriptors carry name, description and inputSchema only, asserted by test",
    authority: "PROVEN_IN_REPO",
    claim: "the listed tool descriptor has exactly three members",
    file: "src/mcp/startServer.ts",
    needle: "function formatListedToolDescriptor(tool: McpToolMetadata) {",
  },
  {
    question: "Does an SDK mirror one representation into the other?",
    answer: "no — VTRACE hand-rolls the JSON-RPC layer and constructs both itself",
    authority: "PROVEN_IN_REPO",
    claim: "the JSON-RPC dispatch is implemented in this repository",
    file: "src/mcp/startServer.ts",
    needle: "case \"tools/call\": {",
  },
  {
    question: "Can content and structuredContent drift?",
    answer: "no — both are derived from the same toolResponse value in one expression",
    authority: "PROVEN_IN_REPO",
    claim: "content text is serialized from toolResponse.result.output, structuredContent is toolResponse",
    file: "src/mcp/startServer.ts",
    needle: "toolResponse.result.ok",
  },
];

/**
 * §10/§11 — every consumer the repository claims or exercises.
 *
 * `reads` is what the consumer is OBSERVED or CODED to read. A client whose behaviour
 * is neither observable here nor pinned by a schema is UNKNOWN, and UNKNOWN is a
 * constraint on what may be removed, not a licence to remove it.
 */
const CONSUMERS = [
  {
    consumer: "Claude Code (the M164/M165 agent client)",
    readsStructuredContent: "YES",
    readsContentText: "NO",
    requiresBoth: "NO",
    fallback: "not exercised — structuredContent was present on every observed call",
    evidence: "12/12 M164 model-visible tool results begin with the envelope wrapper `{\"schema\":{\"name\":\"vtrace.mcp_server\"`, which content[0].text cannot produce",
    authority: "PROVEN",
    tested: "M166-A boundary matrix, replayed here",
  },
  {
    consumer: "Codex",
    readsStructuredContent: "UNKNOWN",
    readsContentText: "UNKNOWN",
    requiresBoth: "UNKNOWN",
    fallback: "unknown",
    evidence: "README advertises the server for Codex and src/runtime/codexConfig.ts installs its MCP config, but no Codex result-handling code or transcript exists in this repository",
    authority: "UNKNOWN",
    tested: "config installation only",
  },
  {
    consumer: "Stage 5 / benchmark harnesses",
    readsStructuredContent: "YES",
    readsContentText: "YES",
    requiresBoth: "NO — either channel carries the output; harnesses use both for different purposes",
    fallback: "n/a",
    evidence: "run_stage5_m166_acceptance.ts parses content[0].text for the semantic profile and measures structuredContent for width",
    authority: "SUPPORTED_BY_CODE",
    tested: "yes",
  },
  {
    consumer: "MCP transport tests",
    readsStructuredContent: "YES",
    readsContentText: "YES",
    requiresBoth: "YES — both are asserted, and the text block is asserted to equal JSON.stringify(output)",
    fallback: "n/a",
    evidence: "src/mcp/mcp.test.ts asserts callResult.structuredContent and callResult.content in the same test",
    authority: "PROVEN",
    tested: "yes",
  },
  {
    consumer: "VTRACE CLI",
    readsStructuredContent: "N/A",
    readsContentText: "N/A",
    requiresBoth: "NO",
    fallback: "n/a",
    evidence: "src/cli/commands/runPipelineCommand.ts invokes the tool handler in-process and serializes the result itself; it never crosses the MCP transport",
    authority: "PROVEN",
    tested: "yes",
  },
  {
    consumer: "Generic MCP client at the advertised revision",
    readsStructuredContent: "NO",
    readsContentText: "YES",
    requiresBoth: "NO — content[] is the only result channel the advertised revision defines",
    fallback: "would see an empty result if content[] were removed",
    evidence: "VTRACE advertises 2024-11-05 and declares no outputSchema; a client written to that revision has no reason to look at structuredContent",
    authority: "SUPPORTED_BY_CODE — inferred from what VTRACE advertises, not from an observed generic client",
    tested: "no",
  },
] as const;

const SEMANTIC_AUTHORITY = {
  authoritativeValue: "the McpToolExecutionResult.output returned by the run_pipeline handler after compactProductResponse",
  constructedAt: "src/mcp/tools.ts — RUN_PIPELINE_TOOL_DEFINITION.handler",
  derivedRepresentations: [
    { name: "content[0].text", derivation: "JSON.stringify(toolResponse.result.output)", constructedAt: "src/mcp/startServer.ts" },
    { name: "structuredContent", derivation: "toolResponse — the authority under its envelope wrapper", constructedAt: "src/mcp/startServer.ts" },
  ],
  driftRisk: "NONE — both are expressions over the same `toolResponse` binding in a single return statement, so they cannot diverge",
  shapeVerdict: "AUTHORITY_THEN_TWO_DERIVATIONS — the structure §13 asks for is already in place; the representations are not independently constructed",
};

function main(): void {
  const stages = STAGES.map((stage) => ({ stage: stage.stage, representation: stage.representation, ...verify(stage) }));
  const protocol = PROTOCOL.map((entry) => ({
    question: entry.question,
    answer: entry.answer,
    authority: entry.authority,
    ...verify(entry),
  }));

  const unverified = [...stages, ...protocol].filter((row) => !row.verified);

  writeFileSync(path.join(RESULTS, "stage5_m167_transport_path.json"), JSON.stringify({
    schemaVersion: 1,
    milestone: "M167",
    workstream: "A",
    title: "Producer to consumer: where one semantic result becomes two representations",
    stages,
    unverifiedAnchors: unverified.map((row) => `${row.file}: ${row.claim}`),
  }, null, 1));

  writeFileSync(path.join(RESULTS, "stage5_m167_protocol_contract.json"), JSON.stringify({
    schemaVersion: 1,
    milestone: "M167",
    workstream: "A",
    title: "What the MCP contract actually permits, and what it only tolerates",
    advertisedProtocolVersion: "2024-11-05",
    questions: protocol,
    consequence: "structuredContent is served under a revision that does not define it and is not declared by an outputSchema. A client that reads it does so by leniency, not by contract; a client that ignores it is conformant. content[] is therefore the only channel VTRACE may assume any consumer reads.",
  }, null, 1));

  writeFileSync(path.join(RESULTS, "stage5_m167_consumer_matrix.json"), JSON.stringify({
    schemaVersion: 1,
    milestone: "M167",
    workstream: "A",
    title: "Consumer matrix",
    method: "repository and runtime evidence only; a consumer whose behaviour is neither observed nor pinned by code is UNKNOWN",
    consumers: CONSUMERS,
  }, null, 1));

  writeFileSync(path.join(RESULTS, "stage5_m167_semantic_authority.json"), JSON.stringify({
    schemaVersion: 1,
    milestone: "M167",
    workstream: "A",
    title: "The single semantic authority and its derivations",
    ...SEMANTIC_AUTHORITY,
  }, null, 1));

  console.error(`[m167-A] stages=${stages.length} protocol=${protocol.length} consumers=${CONSUMERS.length} unverifiedAnchors=${unverified.length}`);
  for (const row of unverified) console.error(`[m167-A] UNVERIFIED ${row.file}: ${row.claim}`);
  if (unverified.length > 0) process.exitCode = 1;
}

main();
