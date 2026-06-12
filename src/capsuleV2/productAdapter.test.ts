import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  capsuleV2ToManifestItemFields,
  toCapsuleV2ProductResponse,
} from "./productAdapter";
import {
  CapsuleIntent,
  CapsuleV2ContentMode,
  CapsuleV2Mode,
  NO_DEBUG_ROLE_SIGNALS,
  type CapsuleV2Discarded,
  type CapsuleV2Item,
  type CapsuleV2Result,
} from "./types";

function scorecard() {
  return {
    lexical: 0.5,
    symbol: 0,
    path: 0,
    test_to_impl: 0,
    body_literal: 0,
    graph_proximity: 0,
    centrality: 0,
    actionability: 1,
    hub_penalty: 0,
    final: 0.5,
  };
}

function pivotItem(): CapsuleV2Item {
  return {
    ...NO_DEBUG_ROLE_SIGNALS,
    role: "pivot",
    role_reason: "actionable edit target",
    path: "src/session.ts",
    fq_name: "src/session.ts::SessionManager.createSession",
    symbol: "createSession",
    kind: "method",
    content_mode: CapsuleV2ContentMode.Full,
    source: "createSession() {}",
    signature: "createSession(): Session",
    evidence: ["lexical match on local_name", "actionable edit target"],
    scorecard: scorecard(),
    estimated_tokens: 40,
  };
}

function supportItem(): CapsuleV2Item {
  return {
    ...NO_DEBUG_ROLE_SIGNALS,
    role: "support",
    role_reason: "related context",
    path: "src/controller.ts",
    fq_name: "src/controller.ts::SessionController",
    symbol: "SessionController",
    kind: "class",
    content_mode: CapsuleV2ContentMode.Signature,
    signature: "class SessionController",
    evidence: ["graph neighbour of pivot"],
    scorecard: scorecard(),
    estimated_tokens: 12,
  };
}

function discarded(reason: string): CapsuleV2Discarded {
  return {
    ...NO_DEBUG_ROLE_SIGNALS,
    path: "src/noise.ts",
    symbol: "noise",
    kind: "function",
    scorecard: scorecard(),
    evidence: ["weak lexical match"],
    discard_reason: reason,
  };
}

function result(overrides: Partial<CapsuleV2Result> = {}): CapsuleV2Result {
  return {
    intent: CapsuleIntent.Modify,
    actual_mode: CapsuleV2Mode.Standard,
    budget: { max_tokens: 8_000, estimated_tokens: 52, used_percent: 0.65 },
    pivots: [pivotItem()],
    support: [supportItem()],
    discarded: [discarded("over budget")],
    diagnostics: {
      intent_reason: ["task names an edit verb"],
      intent_confidence: "high",
      strategy: {
        candidate_generators: ["lexical"],
        role_policy: "caller_oriented",
        budget_policy: "standard",
      },
      candidate_count: 5,
      pivot_count: 1,
      support_count: 1,
      discarded_count: 1,
      tier: CapsuleV2Mode.Standard,
      weights: { lexical: 1 },
      likely_files: ["src/session.ts"],
      likely_symbols: ["createSession"],
      failing_tests: [],
    },
    ...overrides,
  } as CapsuleV2Result;
}

test("toCapsuleV2ProductResponse projects the v2 result onto the stable product shape", () => {
  const response = toCapsuleV2ProductResponse(result());

  assert.equal(response.engine, "v2");
  assert.equal(response.experimental, true);
  assert.equal(response.intent, "modify");
  assert.equal(response.actualMode, "standard");
  assert.equal(response.reason, null);
  assert.deepEqual(response.budget, { maxTokens: 8_000, estimatedTokens: 52, usedPercent: 0.65 });

  assert.equal(response.pivots.length, 1);
  const pivot = response.pivots[0]!;
  assert.equal(pivot.role, "pivot");
  assert.equal(pivot.path, "src/session.ts");
  assert.equal(pivot.fqName, "src/session.ts::SessionManager.createSession");
  assert.equal(pivot.symbol, "createSession");
  assert.equal(pivot.contentMode, "full");
  assert.equal(pivot.source, "createSession() {}");
  assert.equal(pivot.signature, "createSession(): Session");
  assert.equal(pivot.isNonSourceExample, false);
  assert.deepEqual(pivot.evidence, ["lexical match on local_name", "actionable edit target"]);

  assert.equal(response.support.length, 1);
  assert.equal(response.support[0]!.source, null);
  assert.equal(response.support[0]!.contentMode, "signature");

  assert.equal(response.diagnostics.rolePolicy, "caller_oriented");
  assert.equal(response.diagnostics.intentConfidence, "high");
  assert.deepEqual(response.diagnostics.likelyFiles, ["src/session.ts"]);
  assert.equal(response.discardedTotal, 1);
});

test("toCapsuleV2ProductResponse is deterministic across repeated calls", () => {
  const fixture = result();
  assert.deepEqual(toCapsuleV2ProductResponse(fixture), toCapsuleV2ProductResponse(fixture));
});

test("toCapsuleV2ProductResponse caps the discarded list but reports the true total", () => {
  const many = Array.from({ length: 20 }, (_unused, index) => discarded(`reason ${index}`));
  const response = toCapsuleV2ProductResponse(result({ discarded: many }));

  assert.equal(response.discarded.length, 12);
  assert.equal(response.discardedTotal, 20);
});

test("toCapsuleV2ProductResponse surfaces the no_context reason", () => {
  const response = toCapsuleV2ProductResponse(
    result({
      actual_mode: CapsuleV2Mode.NoContext,
      reason: "no high-confidence edit target recovered",
      pivots: [],
      support: [],
    }),
  );

  assert.equal(response.actualMode, "no_context");
  assert.equal(response.reason, "no high-confidence edit target recovered");
  assert.equal(response.pivots.length, 0);
});

test("capsuleV2ToManifestItemFields uses fqName as the symbol-identity surrogate", () => {
  const fields = capsuleV2ToManifestItemFields(result());

  assert.equal(fields.length, 2);
  assert.equal(fields[0]!.symbolId, "src/session.ts::SessionManager.createSession");
  assert.equal(fields[0]!.fqName, fields[0]!.symbolId);
  assert.equal(fields[0]!.role, "pivot");
  assert.equal(fields[0]!.sourceBacked, true);
  // Support is signature-mode → not source-backed.
  assert.equal(fields[1]!.role, "support");
  assert.equal(fields[1]!.sourceBacked, false);
});
