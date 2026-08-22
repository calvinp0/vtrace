import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  DeliveredRepresentation,
  TokenAuthority,
  attributeToolResult,
  calibrateResultTokens,
  checkCacheIdentity,
  identifyDeliveredRepresentation,
  parseAgentStream,
} from "./m166Boundary";

// §15/§30. Every measurement path gets a known-positive before a zero it produces
// is believed. The controls here prove the parser separates turns, the identity
// check can fail, the calibration recovers a planted slope, and the attribution
// distinguishes a small result from a large one.

function assistant(usage: Record<string, number>, blocks: unknown[] = []): string {
  return JSON.stringify({ type: "assistant", message: { usage, content: blocks } });
}
function toolResult(text: string, id = "t1"): string {
  return JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
}

test("parseAgentStream collapses streaming blocks that share one request usage", () => {
  const turns = parseAgentStream([
    assistant({ cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }, [{ type: "text", text: "abcd" }]),
    assistant({ cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }, [{ type: "tool_use", name: "mcp__vtrace__get_code_context", input: { a: 1 } }]),
    toolResult("x".repeat(120)),
    assistant({ cache_read_input_tokens: 150, cache_creation_input_tokens: 40 }, []),
  ]);
  assert.equal(turns.length, 3);
  const first = turns[0]!;
  assert.equal(first.kind, "assistant");
  if (first.kind !== "assistant") return;
  // One request, both blocks' characters, and the tool name preserved.
  assert.deepEqual(first.toolNames, ["mcp__vtrace__get_code_context"]);
  assert.equal(first.authoredCharacters, 4 + JSON.stringify({ a: 1 }).length);
  assert.equal(turns[1]!.kind, "toolResult");
});

test("checkCacheIdentity holds on a consistent stream and names the turn where it breaks", () => {
  const good = parseAgentStream([
    assistant({ cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }),
    assistant({ cache_read_input_tokens: 150, cache_creation_input_tokens: 20 }),
    assistant({ cache_read_input_tokens: 170, cache_creation_input_tokens: 10 }),
  ]);
  const held = checkCacheIdentity(good);
  assert.equal(held.checked, 2);
  assert.equal(held.holdsEverywhere, true);

  const broken = parseAgentStream([
    assistant({ cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }),
    assistant({ cache_read_input_tokens: 999, cache_creation_input_tokens: 20 }),
  ]);
  const report = checkCacheIdentity(broken);
  assert.equal(report.holdsEverywhere, false);
  assert.deepEqual(report.violations, [1]);
});

test("checkCacheIdentity reports no claim when a stream carries no usage", () => {
  // A run with absent accounting must not read as an identity that held (§103).
  const report = checkCacheIdentity(parseAgentStream([assistant({}), assistant({})]));
  assert.equal(report.checked, 0);
  assert.equal(report.holdsEverywhere, false);
});

test("calibrateResultTokens recovers a planted slope", () => {
  // y = r/4 + x/5 + 500, exactly.
  const samples = [
    { resultCharacters: 1000, authoredCharacters: 100, cacheCreationTokens: 1000 / 4 + 100 / 5 + 500 },
    { resultCharacters: 20000, authoredCharacters: 500, cacheCreationTokens: 20000 / 4 + 500 / 5 + 500 },
    { resultCharacters: 300, authoredCharacters: 2000, cacheCreationTokens: 300 / 4 + 2000 / 5 + 500 },
    { resultCharacters: 8000, authoredCharacters: 3000, cacheCreationTokens: 8000 / 4 + 3000 / 5 + 500 },
  ];
  const calibration = calibrateResultTokens(samples);
  assert.notEqual(calibration, null);
  assert.ok(Math.abs(calibration!.resultCharactersPerToken - 4) < 1e-6);
  assert.ok(Math.abs(calibration!.fixedTokensPerRequest - 500) < 1e-6);
  assert.ok(calibration!.rSquared > 0.999);
});

test("calibrateResultTokens declines to fit fewer than three samples", () => {
  assert.equal(calibrateResultTokens([{ resultCharacters: 1, authoredCharacters: 1, cacheCreationTokens: 1 }]), null);
});

test("calibrateResultTokens declines a singular design rather than inventing a slope", () => {
  // Every sample sharing one authored width leaves the second coefficient
  // undetermined. Returning null keeps an unfittable run out of the economics.
  assert.equal(calibrateResultTokens([
    { resultCharacters: 1000, authoredCharacters: 0, cacheCreationTokens: 250 },
    { resultCharacters: 2000, authoredCharacters: 0, cacheCreationTokens: 500 },
    { resultCharacters: 3000, authoredCharacters: 0, cacheCreationTokens: 750 },
  ]), null);
});

test("attributeToolResult separates a large result from a small one", () => {
  // §15 known-positive: the measurement path must move with payload size.
  // y = r/4 + 0*x + 0: the assistant term is present but carries no weight, so the
  // planted result slope is the whole signal.
  const calibration = calibrateResultTokens([
    { resultCharacters: 1000, authoredCharacters: 10, cacheCreationTokens: 250 },
    { resultCharacters: 10000, authoredCharacters: 900, cacheCreationTokens: 2500 },
    { resultCharacters: 20000, authoredCharacters: 40, cacheCreationTokens: 5000 },
    { resultCharacters: 40000, authoredCharacters: 700, cacheCreationTokens: 10000 },
  ])!;
  const turns = parseAgentStream([
    assistant({ cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 }),
    toolResult("x".repeat(24000)),
    assistant({ cache_read_input_tokens: 1100, cache_creation_input_tokens: 6200 }),
    toolResult("y".repeat(200)),
    assistant({ cache_read_input_tokens: 7300, cache_creation_input_tokens: 90 }),
  ]);
  const big = attributeToolResult(turns, 1, calibration);
  const small = attributeToolResult(turns, 3, calibration);
  assert.equal(big.derivable, true);
  assert.equal(big.upperBoundTokens, 6200);
  assert.equal(big.estimatedTokens, 6000);
  assert.equal(big.authority, TokenAuthority.DerivedFromReported);
  assert.ok(small.estimatedTokens! < big.estimatedTokens! / 50);
  // The large result is re-read by every later request; the small one by fewer.
  assert.equal(big.subsequentRequests, 2);
  assert.equal(big.cacheReadAmplificationTokens, 12000);
});

test("attributeToolResult refuses a derived claim when no request followed", () => {
  const calibration = calibrateResultTokens([
    { resultCharacters: 1000, authoredCharacters: 10, cacheCreationTokens: 250 },
    { resultCharacters: 10000, authoredCharacters: 900, cacheCreationTokens: 2500 },
    { resultCharacters: 20000, authoredCharacters: 40, cacheCreationTokens: 5000 },
  ])!;
  const turns = parseAgentStream([
    assistant({ cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 }),
    toolResult("x".repeat(4000)),
  ]);
  const attribution = attributeToolResult(turns, 1, calibration);
  assert.equal(attribution.derivable, false);
  assert.equal(attribution.upperBoundTokens, null);
  assert.equal(attribution.authority, TokenAuthority.OfflineEstimated);
});

test("identifyDeliveredRepresentation names the representation the model received", () => {
  const content = '{"schemaVersion":"run_pipeline.vnext/1","request":{"query":"a"}}';
  const structured = '{"schema":{"name":"vtrace.mcp_server","version":"1.0.0"},"requestId":"jsonrpc:2:get_code_context"}';
  assert.equal(
    identifyDeliveredRepresentation({ modelVisibleHead: structured, contentTextHead: content, structuredContentHead: structured }),
    DeliveredRepresentation.StructuredContent,
  );
  assert.equal(
    identifyDeliveredRepresentation({ modelVisibleHead: content, contentTextHead: content, structuredContentHead: structured }),
    DeliveredRepresentation.ContentText,
  );
  assert.equal(
    identifyDeliveredRepresentation({ modelVisibleHead: "unrelated text entirely, not either representation at all here", contentTextHead: content, structuredContentHead: structured }),
    DeliveredRepresentation.Neither,
  );
});
