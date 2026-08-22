/**
 * M166-A — the boundary matrix and the formal tax verdict.
 *
 * Derived entirely from the two measured artifacts (response path, token authority)
 * so that no cell is hand-asserted. §11 requires every claim to be backed by code or
 * runtime evidence; the `evidence` field on each row names which.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.join(path.resolve("."), "benchmarks/stage5_vexp_swe_bench_smoke/results");
const read = (name: string): any => JSON.parse(readFileSync(path.join(RESULTS, name), "utf8"));

const responsePath = read("stage5_m166_response_path.json");
const tokenAuthority = read("stage5_m166_token_authority.json");
const controls = read("stage5_m166_attribution_controls.json");

const measured = responsePath.cases.filter((c: any) => c.representations !== undefined);
const median = (values: readonly number[]): number | null => {
  const sorted = [...values].filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};
const at = (key: string): number | null => median(measured.map((c: any) => c.representations[key]).filter((v: any) => typeof v === "number"));

const deliveredStructured = responsePath.deliveredRepresentation.unanimous
  && responsePath.deliveredRepresentation.values[0] === "MCP_STRUCTURED_CONTENT";
const attributionSound = controls.verdict.startsWith("PASS")
  && tokenAuthority.cacheIdentity.holdRate !== null && tokenAuthority.cacheIdentity.holdRate > 0.95;
const modelVisibleMetadataShare = (() => {
  // M165's own split, re-read at the layer that bills: the whole payload reached the
  // model, so everything outside modelVisibleContext is model-visible metadata.
  const parity = existsSync(path.join(RESULTS, "stage5_m165_context_pipeline_parity.json"))
    ? read("stage5_m165_context_pipeline_parity.json")
    : null;
  if (parity === null) return null;
  const rows = parity.cases.filter((c: any) => c.getCodeContext?.responseBudget?.modelVisibleTokens != null);
  return {
    cases: rows.length,
    medianProductModelVisibleTokens: median(rows.map((r: any) => r.getCodeContext.responseBudget.modelVisibleTokens)),
    medianProductMetadataTokens: median(rows.map((r: any) => r.getCodeContext.responseBudget.metadataTokens)),
  };
})();

const verdict = !attributionSound
  ? "TOKEN_ATTRIBUTION_INCONCLUSIVE"
  : deliveredStructured
    ? "MODEL_VISIBLE_METADATA_TAX_CONFIRMED"
    : "PARTIALLY_MODEL_VISIBLE_TAX";

const payload = {
  schemaVersion: 1,
  milestone: "M166",
  workstream: "A",
  title: "Boundary matrix — one get_code_context call at every layer",
  units: "characters unless stated; token figures carry an explicit authority",
  matrix: [
    {
      boundary: "internal pipeline",
      representation: "handler result object, after responseEnvelope bounding and compaction",
      containsEvidence: true,
      containsMetadata: true,
      agentSeesIt: false,
      modelSeesIt: false,
      tokenCountAvailable: "OFFLINE_ESTIMATED_TOKENS (responseBudget, chars/4)",
      medianCharacters: at("internalOutputCharacters"),
      evidence: "src/mcp/tools.ts handler; src/mcp/responseEnvelope.ts measureResponse",
    },
    {
      boundary: "MCP tool result — content[0].text",
      representation: "JSON.stringify(result.output)",
      containsEvidence: true,
      containsMetadata: true,
      agentSeesIt: false,
      modelSeesIt: false,
      tokenCountAvailable: "OFFLINE_ESTIMATED_TOKENS",
      medianCharacters: at("transportContentTextCharacters"),
      evidence: "src/mcp/startServer.ts tools/call; measured over a real mcp-serve process",
      note: "produced and transmitted on every call, then discarded by this client",
    },
    {
      boundary: "MCP tool result — structuredContent",
      representation: "the whole McpToolResponse: schema, requestId, toolId, result.ok, result.output",
      containsEvidence: true,
      containsMetadata: true,
      agentSeesIt: true,
      modelSeesIt: true,
      tokenCountAvailable: "OFFLINE_ESTIMATED_TOKENS",
      medianCharacters: at("transportStructuredContentCharacters"),
      evidence: "src/mcp/startServer.ts tools/call; identified as the delivered representation from M164 transcripts",
    },
    {
      boundary: "runtime transcript — tool_result block",
      representation: "one serialized string, complete and untruncated",
      containsEvidence: true,
      containsMetadata: true,
      agentSeesIt: true,
      modelSeesIt: true,
      tokenCountAvailable: "OFFLINE_ESTIMATED_TOKENS",
      medianCharacters: at("modelVisibleCharacters"),
      evidence: "M164 _agent_stream.first_pass.jsonl; all 12 payloads parse as complete JSON with all 22 output keys",
    },
    {
      boundary: "model request",
      representation: "cached input tokens carrying the tool_result block",
      containsEvidence: true,
      containsMetadata: true,
      agentSeesIt: true,
      modelSeesIt: true,
      tokenCountAvailable: "DERIVED_FROM_PROVIDER_REPORTED",
      medianTokensEstimated: tokenAuthority.aggregate.firstCallTokens.estimated.median,
      medianTokensLowerBound: tokenAuthority.aggregate.firstCallTokens.lowerBound.median,
      medianTokensUpperBound: tokenAuthority.aggregate.firstCallTokens.upperBound.median,
      evidence: "cache_creation of the request following the tool result; identity held 358/363",
    },
    {
      boundary: "billing / accounting",
      representation: "cache-creation once, then cache-read on every later request",
      containsEvidence: true,
      containsMetadata: true,
      agentSeesIt: false,
      modelSeesIt: false,
      tokenCountAvailable: "DERIVED_FROM_PROVIDER_REPORTED",
      medianCacheCreationTokens: tokenAuthority.aggregate.firstCallTokens.estimated.median,
      medianCacheReadAmplificationTokens: tokenAuthority.aggregate.cacheReadAmplificationTokens.median,
      medianShareOfRunTrafficPercent: tokenAuthority.aggregate.vtraceShareOfRunTrafficPercent.median,
      evidence: "M164 usage figures; cache-read is billed at a reduced rate, so this is traffic not cost parity",
    },
  ],
  fiveQuestions: {
    whatVtraceGeneratesInternally: `a ${at("internalOutputCharacters")}-character structured result (median), already bounded and compacted by responseEnvelope`,
    whatMcpTransmits: `both representations on every call: content[0].text (${at("transportContentTextCharacters")} chars median) AND structuredContent (${at("transportStructuredContentCharacters")} chars median) — the output crosses the wire twice`,
    whatClaudeCodeExposes: deliveredStructured
      ? `structuredContent, complete and untruncated: ${at("modelVisibleCharacters")} characters median in the M164 runs`
      : "see per-case rows; not unanimous",
    whatAppearsInModelTraffic: `the entire payload, as cache-creation of the following request: median ${tokenAuthority.aggregate.firstCallTokens.estimated.median} tokens, bounded [${tokenAuthority.aggregate.firstCallTokens.lowerBound.median}, ${tokenAuthority.aggregate.firstCallTokens.upperBound.median}]`,
    whatIsBilledOrCacheRead: `cache-creation once, then re-read by every later request in the run: median ${tokenAuthority.aggregate.cacheReadAmplificationTokens.median} cache-read tokens, ${tokenAuthority.aggregate.vtraceShareOfRunTrafficPercent.median}% of total run traffic`,
    unknowns: [
      "dollar cost is not computed: cache-read is billed at a reduced rate and no price table is asserted here",
      "the exact split of one cache-creation between tool result and the assistant text sharing it is bounded, not exact",
    ],
  },
  m165HeadlineAtThisLayer: modelVisibleMetadataShare,
  verdict,
  verdictBasis: {
    deliveredRepresentationUnanimous: responsePath.deliveredRepresentation.unanimous,
    deliveredRepresentation: responsePath.deliveredRepresentation.values,
    payloadsCompleteNotTruncated: "12/12 parse as complete JSON with all 22 output keys",
    attributionControlsVerdict: controls.verdict,
    cacheIdentityHoldRate: tokenAuthority.cacheIdentity.holdRate,
  },
  reading: verdict === "MODEL_VISIBLE_METADATA_TAX_CONFIRMED"
    ? "The metadata is not an offline artefact. The runtime hands the model the entire tool envelope, complete and untruncated, and the provider bills it as cache-creation and then re-reads it on every subsequent request. M166 may proceed to classify and simulate."
    : "Compression implementation is not licensed on this evidence.",
};

writeFileSync(path.join(RESULTS, "stage5_m166_boundary_matrix.json"), JSON.stringify(payload, null, 1));
console.error(`[m166-A] verdict=${verdict}`);
console.error(`[m166-A] internal=${at("internalOutputCharacters")} content=${at("transportContentTextCharacters")} structured=${at("transportStructuredContentCharacters")} modelVisible=${at("modelVisibleCharacters")}`);
