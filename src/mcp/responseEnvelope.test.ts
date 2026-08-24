// M130 complete-response budgeting and source-duplication tests.
//
// The incident: a `max_tokens: 6000` request returned an 87,146-character result
// because the same selected context was serialized across several fields. These
// tests pin the invariant that replaced it — one source-bearing representation,
// compact metadata, bounded diagnostics — and the envelope that enforces it.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { estimateTokens } from "../capsuleV2/tokens";
import {
  McpResponseDetail,
  REQUEST_PROSE_OMITTED,
  compactProductResponse,
  isMcpResponseDetail,
  remeasureResponseBudget,
  responseTokenCeiling,
  serialize,
} from "./responseEnvelope";
import { projectRunPipelineOrientation } from "../runPipeline/orientationProjection";

/** A body long enough that accidental repetition is unmistakable in the totals. */
function bigBody(marker: string, lines = 60): string {
  return Array.from(
    { length: lines },
    (_, index) => `    ${marker}_line_${index} = compute_${marker}(${index})  # ${marker} unique payload`,
  ).join("\n");
}

const PIVOT_BODY = bigBody("pivot");
const SUPPORT_BODY = bigBody("support");
const DOCUMENT_EXCERPT = bigBody("document", 20);
const SKELETON_BODY = bigBody("skeleton", 15);
const UNSELECTED_BODY = bigBody("unselected", 40);

function renderedContext(): string {
  return [
    "# VTRACE product context",
    "task: investigate the failure",
    "",
    "## [P1] pkg/pivot.py::pivot_function",
    "roles: pivot, required",
    "mode: focused_source",
    "",
    PIVOT_BODY,
    "",
    "## [S1] pkg/support.py::support_function",
    "roles: support",
    "mode: skeleton",
    "",
    SKELETON_BODY,
    "",
    "## [S2] pkg/other.py::other_function",
    "roles: support",
    "mode: focused_source",
    "",
    SUPPORT_BODY,
    "",
    "## [D1] config/settings.yaml",
    "roles: configuration",
    "mode: document_excerpt",
    "",
    DOCUMENT_EXCERPT,
  ].join("\n");
}

/** A response shaped like the real one, with every duplication the incident had. */
function duplicatedResponse() {
  const modelVisibleContext = renderedContext();
  return {
    schemaVersion: "run_pipeline.vnext/1",
    request: { query: "investigate the failure", task: "investigate the failure" },
    taskSummary: {
      query: "investigate the failure",
      normalizedQuery: "investigate the failure",
      editGoal: "investigate_failure",
    },
    productContext: {
      responseVersion: 2,
      resolved: true,
      task: "investigate the failure",
      modelVisibleContext,
      items: [
        {
          id: "P1",
          stableId: "aaaa1111",
          path: "pkg/pivot.py",
          symbol: "pivot_function",
          roles: ["pivot", "required"],
          contentMode: "focused_source",
          lineSpan: { start: 10, end: 70 },
          selectionReasons: ["symbol-name match", "strong lexical match", "issue-domain relevance", "extra reason"],
          estimatedTokens: 400,
          content: PIVOT_BODY,
          metadata: { fqName: "pkg/pivot.py::pivot_function", kind: "function", strongestPaths: ["noise"], testLinks: ["noise"] },
        },
        {
          id: "S1",
          stableId: "bbbb2222",
          path: "pkg/support.py",
          symbol: "support_function",
          roles: ["support", "skeleton"],
          contentMode: "skeleton",
          selectionReasons: ["structural neighbour"],
          estimatedTokens: 90,
          content: SKELETON_BODY,
          metadata: { fqName: "pkg/support.py::support_function", kind: "function" },
        },
        {
          id: "S2",
          stableId: "cccc3333",
          path: "pkg/other.py",
          symbol: "other_function",
          roles: ["support"],
          contentMode: "focused_source",
          selectionReasons: ["co-edit evidence"],
          estimatedTokens: 380,
          content: SUPPORT_BODY,
          metadata: { fqName: "pkg/other.py::other_function", kind: "function" },
        },
        {
          id: "D1",
          stableId: "dddd4444",
          path: "config/settings.yaml",
          roles: ["configuration"],
          contentMode: "document_excerpt",
          selectionReasons: ["path clue"],
          estimatedTokens: 120,
          content: DOCUMENT_EXCERPT,
          metadata: { documentKind: "yaml" },
        },
      ],
      accounting: {
        budgetTokens: 6000,
        usedTokensEstimate: 1200,
        baseline: "full source contents of every unique selected source file before compression",
        claimBoundary: "Compression relative to uniquely selected full files; not the repository.",
      },
      freshness: { status: "fresh", reason: "fresh", action: "none", refreshDiagnostics: { verbose: "x".repeat(600) } },
      diagnostics: {
        staticEvidenceOnly: true,
        limitations: ["one", "two", "three", "four"],
        selectedFiles: ["pkg/pivot.py", "pkg/support.py", "pkg/other.py", "config/settings.yaml"],
        requiredFiles: ["pkg/pivot.py"],
        supportFiles: ["pkg/support.py", "pkg/other.py"],
      },
    },
    // Second serialization of the same bodies.
    capsuleResult: {
      query: "investigate the failure",
      digest: "● pivot pkg/pivot.py::pivot_function\n○ skel pkg/support.py::support_function",
      pivots: [{
        role: "pivot",
        path: "pkg/pivot.py",
        symbol: "pivot_function",
        fqName: "pkg/pivot.py::pivot_function",
        kind: "function",
        roleReason: "actionable function",
        contentMode: "full",
        source: PIVOT_BODY,
        signature: "def pivot_function():",
        evidence: ["symbol-name match", "strong lexical match"],
        estimatedTokens: 400,
        isNonSourceExample: false,
      }],
      support: [{
        role: "support",
        path: "pkg/other.py",
        symbol: "other_function",
        fqName: "pkg/other.py::other_function",
        kind: "function",
        roleReason: "co-edit evidence",
        contentMode: "full",
        source: SUPPORT_BODY,
        signature: "def other_function():",
        evidence: ["co-edit evidence"],
        estimatedTokens: 380,
        isNonSourceExample: false,
      }],
      // Unselected candidate evidence, including its source.
      discarded: [
        { path: "pkg/unselected.py", symbol: "unselected", kind: "function", discardReason: "below threshold", source: UNSELECTED_BODY },
      ],
      discardedTotal: 9,
      diagnostics: { candidateCount: 40, likelyFiles: ["pkg/pivot.py"] },
      actionabilityHints: [],
      warnings: [],
    },
    // Third serialization: neighborhood excerpt text.
    pivotNeighborhood: [{
      pivot: { path: "pkg/pivot.py", symbol: "pivot_function", fqName: "pkg/pivot.py::pivot_function" },
      excerpts: [
        { filePath: "pkg/other.py", symbol: "other_function", fqName: "pkg/other.py::other_function", startLine: 1, endLine: 40, text: SUPPORT_BODY, reason: "callee", truncated: false },
      ],
      skipped: [],
    }],
    // Legacy compatibility surface with per-candidate scoring.
    context: {
      included: true,
      skipReason: null,
      pivots: [{
        symbolId: "sym-1",
        filePath: "pkg/pivot.py",
        fqName: "pkg/pivot.py::pivot_function",
        localName: "pivot_function",
        kind: "function",
        role: "pivot",
        contentMode: "full",
        inclusionReasons: [{ kind: "query_coverage", note: "actionable function" }],
        budgetCost: 1600,
        compressed: false,
        sourceBacked: true,
        lexicalScore: 0.86,
        graphScore: 0,
        finalScore: 1.9,
      }],
      supports: [],
      itemCount: 1,
    },
    diagnostics: {
      retrieval: {
        initialReason: "ok",
        finalReason: "ok",
        fallbackApplied: false,
        finalContextItemCount: 4,
        search: {
          normalizedQuery: "investigate the failure",
          identifierTerms: ["failure"],
          queryVariants: Array.from({ length: 60 }, (_, index) => `variant number ${index} of the expanded query`),
          laneCandidateFiles: Array.from({ length: 80 }, (_, index) => `pkg/candidate_${index}.py`),
        },
      },
      indexFreshness: {
        status: "fresh",
        reason: "fresh",
        action: "none",
        readiness: { ready: true, sourceFresh: true },
        beforeState: "fresh",
        latestRunId: 7,
        manifestDelta: "x".repeat(900),
      },
      freshness: {
        state: "fresh",
        isStale: false,
        recommendedAction: "none",
        readiness: { ready: true, sourceFresh: true },
        snapshot: { lastIndexedHead: "abc" },
        nested: { verbose: "x".repeat(400) },
      },
      budget: { model: "bounded", usedCharacters: 10 },
      nudge: { enabled: false, reason: "no_session" },
      impact: { included: false, skipReason: "not_requested_by_intent" },
    },
    accounting: { latencyMs: 12, estimatedOutputTokens: 900, method: "chars_div_4" },
    flow: { included: false, skipReason: "no_indexed_path_found", paths: null },
    memory: { session: { included: false, recentObservations: [] }, durable: { included: false, topObservations: [] } },
    rules: { included: false, active: [], notes: ["one", "two"] },
    inspectFirst: { confidence: "medium", likelyFirst: { path: "pkg/pivot.py", symbol: "pivot_function", why: "lead" }, related: [], avoidFirst: null },
    deferred: { items: [], expandable: false, notes: ["a", "b", "c"] },
  };
}

/** Count non-overlapping occurrences of `needle` in the serialized response. */
function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Structural duplicate scanner: how many times a body appears in the response,
 * counting both raw text and JSON-escaped renderings of the same content.
 */
function bodyOccurrences(response: unknown, body: string): number {
  const wire = serialize(response);
  const probe = body.split("\n")[3] ?? body.slice(0, 60);
  return occurrences(wire, JSON.stringify(probe).slice(1, -1));
}

test("the selected source body is serialized exactly once", () => {
  const before = duplicatedResponse();
  assert.equal(bodyOccurrences(before, PIVOT_BODY), 3, "fixture must start with the incident's duplication");

  const after = compactProductResponse(before, { requestedContextTokens: 6000 });

  assert.equal(bodyOccurrences(after, PIVOT_BODY), 1, "pivot body must appear once");
  assert.equal(bodyOccurrences(after, SUPPORT_BODY), 1, "support body must appear once");
  assert.equal(bodyOccurrences(after, SKELETON_BODY), 1, "skeleton must appear once");
  assert.equal(bodyOccurrences(after, DOCUMENT_EXCERPT), 1, "document excerpt must appear once");
});

test("modelVisibleContext is authoritative and remains unchanged when already within budget", () => {
  const before = duplicatedResponse();
  const after = compactProductResponse(before, { requestedContextTokens: 6000 });

  assert.equal(after.productContext.modelVisibleContext, before.productContext.modelVisibleContext);
  const wire = serialize(after);
  assert.ok(wire.includes(JSON.stringify(PIVOT_BODY).slice(1, -1)), "the one copy must be the rendered one");
});

test("unselected candidate source never reaches the response", () => {
  const after = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 6000 });
  assert.equal(bodyOccurrences(after, UNSELECTED_BODY), 0);
  assert.deepEqual(after.capsuleResult.discarded, []);
  assert.equal(after.capsuleResult.discardedTotal, 9, "the true count survives; only the bodies go");
});

test("compatibility surfaces become references, not second copies", () => {
  const after = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 6000 });

  assert.equal(after.capsuleResult.pivots[0]?.source, null);
  assert.equal(after.capsuleResult.pivots[0]?.signature, null);
  assert.equal(after.capsuleResult.pivots[0]?.contextItemId, "P1");
  assert.equal(after.capsuleResult.support[0]?.contextItemId, "S2");
  assert.equal(after.context.supersededBy, "productContext");
  for (const excerpt of after.pivotNeighborhood[0]?.excerpts ?? []) {
    assert.equal((excerpt as { text?: string }).text, undefined);
    assert.ok((excerpt as { textCharacters: number }).textCharacters > 0);
  }
});

test("a max_tokens request bounds the complete serialized response, not only the context", () => {
  const after = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 6000 });
  const budget = after.responseBudget;

  assert.equal(budget.requested_context_tokens, 6000);
  assert.equal(budget.total_response_token_ceiling, 7000);
  assert.ok(
    budget.estimated_model_visible_tokens <= 6000,
    `model-visible ${budget.estimated_model_visible_tokens} exceeded the requested budget`,
  );
  assert.ok(
    budget.estimated_total_response_tokens <= budget.total_response_token_ceiling,
    `total ${budget.estimated_total_response_tokens} exceeded ceiling ${budget.total_response_token_ceiling}`,
  );
  assert.equal(budget.within_envelope, true);
  assert.equal(budget.serialized_response_characters, serialize(after).length);
  assert.equal(budget.estimate_method, "chars_div_4");
});

test("the envelope holds even when the caller asks for a very small response", () => {
  for (const requested of [200, 500, 1_000, 2_000]) {
    const after = compactProductResponse(duplicatedResponse(), { requestedContextTokens: requested });
    const budget = after.responseBudget;
    assert.ok(budget.estimated_model_visible_tokens <= requested);
    assert.equal(budget.within_envelope, true, `requested=${requested} produced ${budget.estimated_total_response_tokens} tokens`);
    assert.equal(budget.compaction_applied, true);
    assert.ok(budget.compacted_fields.length > 0);
  }
});

test("critical freshness and provenance survive every level of compaction", () => {
  const before = duplicatedResponse();
  before.productContext.freshness.status = "stale";
  before.productContext.freshness.reason = "working_tree_changed";
  before.diagnostics.indexFreshness.status = "stale";

  const after = compactProductResponse(before, { requestedContextTokens: 200 });

  assert.equal(after.productContext.freshness.status, "stale");
  assert.equal(after.productContext.freshness.reason, "working_tree_changed");
  assert.equal(after.diagnostics.indexFreshness.status, "stale");
  assert.equal(after.productContext.resolved, true);
  assert.equal(after.productContext.resultState, "resolved");
  assert.equal(after.productContext.retrievalFound, true);
  assert.ok(after.productContext.items.length > 0);
  assert.match(after.productContext.modelVisibleContext, /pivot_function/);
  assert.ok(after.responseBudget.estimated_total_response_tokens > 0);
});

test("detail modes trade evidence for size without ever unbounding the response", () => {
  const sizes = new Map<string, number>();
  for (const detail of [McpResponseDetail.Compact, McpResponseDetail.Standard, McpResponseDetail.Debug]) {
    const after = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 12_000, detail });
    sizes.set(detail, after.responseBudget.serialized_response_characters);
    assert.equal(after.responseBudget.diagnostics_detail, detail);
    assert.ok(
      after.responseBudget.estimated_total_response_tokens <= after.responseBudget.total_response_token_ceiling,
      `${detail} exceeded its ceiling`,
    );
    // No level ever restores a duplicated body.
    assert.equal(bodyOccurrences(after, PIVOT_BODY), 1);
  }

  assert.ok(
    sizes.get(McpResponseDetail.Compact)! < sizes.get(McpResponseDetail.Debug)!,
    "compact must be smaller than debug",
  );
});

test("raw retrieval matrices reach the model at no detail level, and are bounded samples under debug", () => {
  // M166 measured these matrices as model-visible and billed on every call while no
  // product code read them. They are now held for `detail=debug`, where the earlier
  // bounding still applies: a debug response is more informative, never unbounded.
  const standard = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 12_000 });
  assert.equal(standard.diagnostics.retrieval, undefined);

  const debug = compactProductResponse(duplicatedResponse(), {
    requestedContextTokens: 12_000,
    detail: McpResponseDetail.Debug,
  });
  const debugSearch = debug.diagnostics.retrieval.search as Record<string, unknown>;
  assert.equal(debugSearch.queryVariants, undefined);
  assert.equal(debugSearch.queryVariantsCount, 60);
  assert.equal(debugSearch.laneCandidateFilesCount, 80);
  // Short, readable term lists are not collateral damage.
  assert.deepEqual(debugSearch.identifierTerms, ["failure"]);
  assert.equal((debugSearch.queryVariantsSample as string[]).length, 12);
});

test("the default response keeps readiness truth and holds machine diagnostics for debug", () => {
  // M166-D. The model is billed for every character of this response and re-billed
  // on every later request in the run, so the default carries what an agent can act
  // on and nothing else. What must survive is what stops a bounded answer reading as
  // an authoritative one: status, reason, action and the readiness predicates.
  const standard = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 12_000 });
  const debug = compactProductResponse(duplicatedResponse(), {
    requestedContextTokens: 12_000,
    detail: McpResponseDetail.Debug,
  });
  const diagnostics = standard.diagnostics as Record<string, any>;
  const debugDiagnostics = debug.diagnostics as Record<string, any>;

  // Every machine-facing member the response can carry is gone from the default.
  for (const machineFacing of ["retrieval", "budget", "nudge", "intent", "memory", "rules", "impact", "flow"]) {
    if (debugDiagnostics[machineFacing] === undefined) continue;
    assert.equal(diagnostics[machineFacing], undefined, `${machineFacing} should not reach the model by default`);
  }
  // and at least two of them really were there, so this is not a vacuous loop.
  assert.notEqual(debugDiagnostics.retrieval, undefined);
  assert.notEqual(debugDiagnostics.impact, undefined);

  // Readiness truth survives, in both places that carry it.
  assert.equal(diagnostics.indexFreshness.status, "fresh");
  assert.equal(diagnostics.indexFreshness.reason, "fresh");
  assert.equal(diagnostics.indexFreshness.action, "none");
  assert.deepEqual(diagnostics.indexFreshness.readiness, { ready: true, sourceFresh: true });
  assert.equal(diagnostics.freshness.state, "fresh");
  assert.equal(diagnostics.freshness.isStale, false);
  assert.equal(diagnostics.freshness.recommendedAction, "none");
  assert.deepEqual(diagnostics.freshness.readiness, { ready: true, sourceFresh: true });

  // The indexer's own working out is not part of the answer.
  assert.equal(diagnostics.indexFreshness.beforeState, undefined);
  assert.equal(diagnostics.indexFreshness.latestRunId, undefined);
  assert.equal(diagnostics.indexFreshness.manifestDelta, undefined);
  assert.equal(diagnostics.freshness.snapshot, undefined);
  assert.equal(diagnostics.freshness.nested, undefined);

  // Component skip reasons live in their own top-level sections and are untouched,
  // so not_applicable stays distinguishable from no_relevant_evidence.
  assert.equal(standard.flow.skipReason, "no_indexed_path_found");
  assert.equal(standard.memory.session.included, false);
  assert.equal(standard.rules.included, false);
});

test("removing the machine diagnostics is disclosed, not silent", () => {
  // A response that quietly dropped detail would let partial coverage read as
  // complete. The envelope says what it held back and where to get it.
  const standard = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 12_000 });
  assert.ok((standard.responseBudget.omitted_detail_counts as Record<string, number>).machineFacingDiagnosticCharacters > 0);
  assert.ok(standard.responseBudget.compacted_fields.includes("diagnostics"));
  // The envelope's expansion list is bounded, so the disclosure must also live where
  // the removal happened; otherwise a reduced diagnostics block reads as a whole one.
  assert.ok(
    typeof (standard.diagnostics as Record<string, any>).omittedForDetail === "string"
    && (standard.diagnostics as Record<string, any>).omittedForDetail.includes("detail=debug"),
  );
});

test("detail=debug still returns the full diagnostics", () => {
  const debug = compactProductResponse(duplicatedResponse(), {
    requestedContextTokens: 12_000,
    detail: McpResponseDetail.Debug,
  });
  const diagnostics = debug.diagnostics as Record<string, any>;
  for (const machineFacing of ["retrieval", "budget", "nudge", "impact"]) {
    assert.notEqual(diagnostics[machineFacing], undefined, `${machineFacing} must survive at debug`);
  }
  assert.notEqual(diagnostics.freshness.snapshot, undefined);
  assert.notEqual(diagnostics.indexFreshness.beforeState, undefined);
  assert.equal(diagnostics.indexFreshness.latestRunId, 7);
});

test("holding the diagnostics back makes the response materially smaller", () => {
  const standard = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 12_000 });
  const debug = compactProductResponse(duplicatedResponse(), {
    requestedContextTokens: 12_000,
    detail: McpResponseDetail.Debug,
  });
  assert.ok(
    JSON.stringify(standard).length < JSON.stringify(debug).length,
    "the default must cost less than debug",
  );
  // The evidence itself is untouched by the saving.
  assert.equal(standard.productContext.modelVisibleContext, debug.productContext.modelVisibleContext);
  assert.deepEqual(
    standard.productContext.items.map((item: any) => item.path),
    debug.productContext.items.map((item: any) => item.path),
  );
});

test("include_item_content restores per-item bodies as an explicit opt-in", () => {
  const off = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 12_000 });
  assert.equal(off.productContext.items[0]?.content, undefined);
  assert.ok(typeof off.productContext.items[0]?.contentHash === "string");

  const on = compactProductResponse(duplicatedResponse(), {
    requestedContextTokens: 12_000,
    includeItemContent: true,
  });
  assert.equal(on.productContext.items[0]?.content, PIVOT_BODY);
});

test("compaction is pure and its accounting is self-consistent", () => {
  const before = duplicatedResponse();
  const snapshot = serialize(before);
  const after = compactProductResponse(before, { requestedContextTokens: 6000 });

  assert.equal(serialize(before), snapshot, "input must not be mutated");
  assert.equal(
    after.responseBudget.estimated_metadata_tokens,
    after.responseBudget.estimated_total_response_tokens - after.responseBudget.estimated_model_visible_tokens,
  );
  assert.equal(after.responseBudget.serialized_response_characters, serialize(after).length);
});

test("remeasure keeps the compaction record and refreshes the size figures", () => {
  const after = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 6000 });
  const mutated = {
    ...after,
    diagnostics: { ...after.diagnostics, indexFreshness: { status: "fresh", reason: "fresh", action: "none" } },
  };
  const remeasured = remeasureResponseBudget(mutated);

  assert.deepEqual(remeasured.responseBudget.compacted_fields, after.responseBudget.compacted_fields);
  assert.equal(remeasured.responseBudget.compaction_applied, after.responseBudget.compaction_applied);
  assert.equal(remeasured.responseBudget.serialized_response_characters, serialize(remeasured).length);
});

test("the ceiling formula is a documented function of the requested budget", () => {
  assert.equal(responseTokenCeiling(6_000), 7_000);
  assert.equal(responseTokenCeiling(0), 1_000);
  assert.equal(responseTokenCeiling(20_000), 23_000);
  assert.equal(isMcpResponseDetail("standard"), true);
  assert.equal(isMcpResponseDetail("verbose"), false);
});

test("a slight model-context overshoot compacts reasons without erasing the lead", () => {
  const before = duplicatedResponse();
  const initialTokens = estimateTokens(before.productContext.modelVisibleContext);
  const requested = Math.floor(initialTokens * 0.9);
  const after = compactProductResponse(before, { requestedContextTokens: requested });

  assert.equal(after.productContext.resultState, "resolved");
  assert.equal(after.productContext.retrievalFound, true);
  assert.match(after.productContext.modelVisibleContext, /pivot_function/);
  assert.ok(after.productContext.items.length > 0);
  assert.ok(after.responseBudget.estimated_model_visible_tokens <= requested);
  assert.ok(after.productContext.delivery.compactionStages.includes("selection_reasons_compacted"));
});

test("a large overshoot removes weaker support before the answer-bearing pivot", () => {
  const after = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 500 });

  assert.equal(after.productContext.resultState, "resolved");
  assert.match(after.productContext.modelVisibleContext, /pkg\/pivot\.py::pivot_function/);
  assert.ok(after.productContext.delivery.droppedForBudget > 0);
  assert.ok(after.productContext.delivery.deliveredItems >= 1);
});

test("a single huge lead is reduced to a minimal truthful representation", () => {
  const before = duplicatedResponse();
  before.productContext.items = [before.productContext.items[0]!];
  before.productContext.modelVisibleContext = [
    "# VTRACE product context",
    "task: investigate the failure",
    "intent: modify",
    "worktree: fixture",
    "capsule_mode: standard",
    "",
    "## [P1] pkg/pivot.py::pivot_function",
    "roles: pivot, required",
    "mode: focused_source",
    "",
    PIVOT_BODY.repeat(4),
  ].join("\n");
  const after = compactProductResponse(before, { requestedContextTokens: 250 });

  assert.equal(after.productContext.resultState, "resolved");
  assert.match(after.productContext.modelVisibleContext, /pivot_function/);
  assert.ok(after.responseBudget.estimated_model_visible_tokens <= 250);
  assert.ok(after.productContext.delivery.compactionStages.includes("lead_excerpt_shortened"));
});

test("many small support items cannot displace the strong lead", () => {
  const before = duplicatedResponse();
  const lead = before.productContext.items[0]!;
  const supports = Array.from({ length: 20 }, (_, index) => ({
    ...before.productContext.items[1]!,
    id: `S${index + 1}`,
    stableId: `support-${index}`,
    path: `pkg/support_${index}.py`,
    symbol: `support_${index}`,
    selectionReasons: ["optional graph neighbour"],
    content: `def support_${index}():\n    return ${index}`,
  }));
  before.productContext.items = [lead, ...supports];
  before.productContext.modelVisibleContext = [
    before.productContext.modelVisibleContext,
    ...supports.map((item) => `\n## [${item.id}] ${item.path}::${item.symbol}\nroles: support\nmode: focused_source\n\n${item.content}`),
  ].join("\n");
  const after = compactProductResponse(before, { requestedContextTokens: 650 });

  assert.equal(after.productContext.resultState, "resolved");
  assert.match(after.productContext.modelVisibleContext, /pivot_function/);
  assert.ok(after.productContext.delivery.supportDropped > 0);
  assert.ok(after.productContext.delivery.deliveredItems < 21);
});

test("optional metadata is compacted before answer-bearing model context", () => {
  const before = duplicatedResponse();
  const requested = estimateTokens(before.productContext.modelVisibleContext) + 10;
  before.diagnostics.retrieval.search.queryVariants = Array.from({ length: 2_000 }, (_, index) => `diagnostic-${index}-${"x".repeat(40)}`);
  const after = compactProductResponse(before, { requestedContextTokens: requested });

  assert.equal(after.productContext.resultState, "resolved");
  assert.equal(after.productContext.modelVisibleContext, before.productContext.modelVisibleContext);
  assert.match(after.productContext.modelVisibleContext, /pivot_function/);
  assert.equal(after.responseBudget.within_envelope, true);
});

test("retrieval miss, bounded hit, compacted hit, and delivery failure are distinct", () => {
  const miss = duplicatedResponse();
  miss.productContext.resolved = false;
  miss.productContext.items = [];
  miss.productContext.modelVisibleContext = "";
  const noResult = compactProductResponse(miss, { requestedContextTokens: 500 });
  const complete = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 12_000 });
  const compacted = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 500 });
  const failed = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 1 });

  assert.deepEqual(
    [noResult.productContext.resultState, complete.productContext.resultState, compacted.productContext.resultState, failed.productContext.resultState],
    ["no_result", "resolved", "resolved", "delivery_failure"],
  );
  assert.deepEqual(
    [noResult.productContext.retrievalFound, complete.productContext.retrievalFound, compacted.productContext.retrievalFound, failed.productContext.retrievalFound],
    [false, true, true, true],
  );
  assert.equal(failed.productContext.deliveryFailed, true);
  assert.equal(failed.productContext.resolved, false);
});

test("delivery is deterministic and answer-bearing usefulness is monotonic with budget", () => {
  const budgets = [100, 200, 500, 1_000, 2_000, 6_000];
  let previousDelivered = 0;
  let answerSeen = false;
  for (const budget of budgets) {
    const first = compactProductResponse(duplicatedResponse(), { requestedContextTokens: budget });
    const second = compactProductResponse(duplicatedResponse(), { requestedContextTokens: budget });
    assert.equal(first.productContext.modelVisibleContext, second.productContext.modelVisibleContext);
    assert.deepEqual(first.productContext.delivery, second.productContext.delivery);
    if (first.productContext.resultState === "resolved") {
      assert.ok(first.productContext.delivery.deliveredItems >= previousDelivered);
      previousDelivered = first.productContext.delivery.deliveredItems;
      const hasAnswer = first.productContext.modelVisibleContext.includes("pivot_function");
      assert.ok(!answerSeen || hasAnswer, `answer disappeared at budget ${budget}`);
      answerSeen ||= hasAnswer;
    }
  }
});

test("M142-D: the same selection reasoning is not shipped twice", () => {
  // capsuleResult's roleReason is character-identical to an entry in
  // productContext.items[].selectionReasons -- measured 6/6 on a real request,
  // where it was also the largest field in the manifest. The default keeps the
  // reference and drops the copy; debug keeps both.
  const standard = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 12_000 });
  const debug = compactProductResponse(duplicatedResponse(), {
    requestedContextTokens: 12_000,
    detail: McpResponseDetail.Debug,
  });

  assert.equal(standard.capsuleResult.pivots[0]?.roleReason, "");
  assert.equal(debug.capsuleResult.pivots[0]?.roleReason, "actionable function");
  // Identity survives, so the manifest is still usable and still resolvable.
  assert.equal(standard.capsuleResult.pivots[0]?.path, "pkg/pivot.py");
  assert.ok(typeof standard.capsuleResult.pivots[0]?.contextItemId === "string");
  assert.ok(standard.responseBudget.compacted_fields.includes("capsuleResult.pivots[].roleReason"));
  assert.ok(!debug.responseBudget.compacted_fields.includes("capsuleResult.pivots[].roleReason"));

  // The reasoning itself is still in the response exactly once.
  const reasons = standard.productContext.items.flatMap((item: { selectionReasons?: string[] }) => item.selectionReasons ?? []);
  assert.ok(reasons.includes("actionable function") || reasons.length > 0);
});

test("M142-D: the selection file list is a count by default and a list under debug", () => {
  const standard = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 12_000 });
  const debug = compactProductResponse(duplicatedResponse(), {
    requestedContextTokens: 12_000,
    detail: McpResponseDetail.Debug,
  });
  assert.deepEqual(standard.productContext.diagnostics.selectedFiles, []);
  assert.equal(standard.productContext.diagnostics.selectedFilesCount, 4);
  assert.deepEqual(debug.productContext.diagnostics.selectedFiles, [
    "pkg/pivot.py", "pkg/support.py", "pkg/other.py", "config/settings.yaml",
  ]);
  // `limitations` is never dropped: a caller who loses it reads the rest more
  // confidently than the evidence supports.
  assert.equal(standard.productContext.diagnostics.limitations.length, 4);
});

test("M142-D: debug is observably different from the default", () => {
  // §32 recorded the contract as inert: debug returned ONE byte more than the
  // default on a real request, because the only debug-aware branch fired on
  // arrays that never got big enough.
  const standard = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 12_000 });
  const debug = compactProductResponse(duplicatedResponse(), {
    requestedContextTokens: 12_000,
    detail: McpResponseDetail.Debug,
  });
  const size = (value: unknown): number => JSON.stringify(value).length;
  assert.ok(size(debug) > size(standard) + 100, `debug=${size(debug)} standard=${size(standard)}`);
  assert.equal(standard.responseBudget.diagnostics_detail, McpResponseDetail.Standard);
  assert.equal(debug.responseBudget.diagnostics_detail, McpResponseDetail.Debug);
});

test("M142-D: debug is observational and never changes the selection", () => {
  // §47: whatever detail level a caller asks for, they must be reasoning about
  // the same answer.
  for (const budget of [1_000, 6_000, 12_000]) {
    const levels = [McpResponseDetail.Compact, McpResponseDetail.Standard, McpResponseDetail.Debug]
      .map((detail) => compactProductResponse(duplicatedResponse(), { requestedContextTokens: budget, detail }));
    const [first] = levels;
    for (const level of levels) {
      assert.equal(level.productContext.modelVisibleContext, first!.productContext.modelVisibleContext);
      assert.equal(level.capsuleResult.digest, first!.capsuleResult.digest);
      assert.deepEqual(
        level.productContext.items.map((item: { path: string }) => item.path),
        first!.productContext.items.map((item: { path: string }) => item.path),
      );
    }
  }
});

test("M142-D: a response stays bounded as the hidden candidate pool grows", () => {
  // §43: the pool behind a request may be orders of magnitude larger than the
  // answer. Response size must track the ANSWER, not the search.
  const sizes: number[] = [];
  for (const poolSize of [10, 100, 1_000, 10_000]) {
    const draft = duplicatedResponse() as unknown as Record<string, any>;
    draft.capsuleResult.discarded = Array.from({ length: poolSize }, (_unused, index) => ({
      path: `pkg/candidate_${index}.py`,
      symbol: `candidate_${index}`,
      discard_reason: "beyond standard support budget (max 3)",
    }));
    draft.capsuleResult.discardedTotal = poolSize;
    draft.diagnostics.retrieval.search.queryVariants =
      Array.from({ length: poolSize }, (_unused, index) => `variant_${index}`);
    const response = compactProductResponse(draft as never, { requestedContextTokens: 12_000 });
    sizes.push(JSON.stringify(response).length);
    assert.deepEqual(response.capsuleResult.discarded, []);
    assert.equal(response.responseBudget.omitted_detail_counts.capsuleDiscardedCandidates, poolSize);
  }
  // A thousandfold larger pool must not produce a materially larger response.
  const growth = sizes[sizes.length - 1]! - sizes[0]!;
  assert.ok(growth < 200, `response grew ${growth} bytes across a 1000x pool: ${sizes.join(" -> ")}`);
});

// ── M175: the caller's own question must not outbid the repository evidence ──

/** A response whose only oversized field is the question the caller asked. */
function echoedResponse(taskCharacters: number) {
  const draft = duplicatedResponse() as unknown as Record<string, any>;
  const question = "the reported failure occurs when the axis converts empty data. "
    .repeat(Math.ceil(taskCharacters / 62)).slice(0, taskCharacters);
  draft.request = {
    query: question,
    task: question,
    maxResults: 6,
    maxBudgetCharacters: 2_000,
    includeTests: true,
    includeFileContent: true,
  };
  return draft;
}

test("M175: the default response references the request instead of restating it", () => {
  const response = compactProductResponse(echoedResponse(12_000) as never, {
    requestedContextTokens: 8_000,
  }) as unknown as Record<string, any>;

  assert.equal(response.request.task, REQUEST_PROSE_OMITTED);
  assert.equal(response.request.query, "@request.task");
  // The block keeps its shape and its RESOLVED parameters; only prose is projected.
  assert.equal(response.request.maxResults, 6);
  assert.equal(response.request.maxBudgetCharacters, 2_000);
  assert.equal(response.request.includeTests, true);
});

test("M175: detail=debug still returns the request verbatim", () => {
  const draft = echoedResponse(12_000);
  const question = draft.request.task as string;
  const response = compactProductResponse(draft as never, {
    requestedContextTokens: 8_000,
    detail: McpResponseDetail.Debug,
  }) as unknown as Record<string, any>;

  assert.equal(response.request.task, question);
  assert.equal(response.request.query, question);
});

test("M175: the request block's cost is constant in the length of the question", () => {
  // The defect was that this cost was unbounded in the caller's own input. Two
  // questions three orders of magnitude apart must now cost the same.
  const sizes = [200, 4_000, 60_000].map((characters) => {
    const response = compactProductResponse(echoedResponse(characters) as never, {
      requestedContextTokens: 8_000,
    }) as unknown as Record<string, any>;
    return serialize(response.request).length;
  });
  assert.equal(new Set(sizes).size, 1, `request block sizes diverged: ${sizes.join(" -> ")}`);
});

test("M175: a long question no longer evicts the evidence it was asked about", () => {
  // The M174 incident, reduced to its mechanism: retrieval succeeds, the echo
  // fills the envelope, and the ladder has nothing left to drop but the evidence.
  const withEcho = compactProductResponse(echoedResponse(30_000) as never, {
    requestedContextTokens: 8_000,
  }) as unknown as Record<string, any>;

  assert.notEqual(withEcho.productContext.resultState, "delivery_failure");
  assert.notEqual(withEcho.productContext.deliveryFailed, true);
  assert.ok(
    withEcho.productContext.items.length > 0,
    "evidence was evicted by a question the response did not need to repeat",
  );
  assert.ok(withEcho.responseBudget.within_envelope);
});

test("M175: projecting the request changes nothing about the evidence selected", () => {
  // §49 — freed budget may restore what was already selected and must attract
  // nothing new. A short question leaves nothing to project, so the two responses
  // must agree item for item.
  const short = compactProductResponse(echoedResponse(120) as never, {
    requestedContextTokens: 8_000,
  }) as unknown as Record<string, any>;
  const long = compactProductResponse(echoedResponse(30_000) as never, {
    requestedContextTokens: 8_000,
  }) as unknown as Record<string, any>;

  assert.deepEqual(
    long.productContext.items.map((item: { path: string }) => item.path),
    short.productContext.items.map((item: { path: string }) => item.path),
  );
});

test("M175: a response with no request block is untouched", () => {
  const draft = duplicatedResponse() as unknown as Record<string, any>;
  delete draft.request;
  const response = compactProductResponse(draft as never, { requestedContextTokens: 8_000 });
  assert.equal((response as unknown as Record<string, any>).request, undefined);
});

// ── M176: response-envelope totality ──
//
// The ladder in `compactProductResponse` used to end in
// `throw new Error("product_response_envelope_unreachable")`, which the MCP
// server's catch-all reported as `handler_failed`. M176-A measured ten default
// model-facing fields that no rung reduces — `request.repoRoot`,
// `productContext.leadPivot`, `productContext.freshness.reason`,
// `workspaceRouting.*`, `intent.reason`, `savedObservation`, `warnings`,
// `flow.skipReason` among them — each able on its own to carry an ordinary
// response past even the DEFAULT ceiling, and reproduced the crash through the
// real MCP transport on `pytest-dev__pytest-10081` at `max_tokens` 150.
//
// These tests pin the replacement: predictable envelope pressure terminates in a
// bounded truthful decline, in the SAME public vocabulary, without becoming a
// place for unexpected failures to hide.

/** Bulk in a field no rung of the ladder reduces. The M176-A known positive. */
function irreduciblyOversizedResponse(characters = 200_000) {
  const draft = duplicatedResponse() as unknown as Record<string, any>;
  draft.productContext.leadPivot = "pkg/pivot.py::pivot_function";
  draft.productContext.freshness = { status: "fresh", reason: "index current" };
  draft.workspaceRouting = { isWorkspace: false, outcome: "single_repository", reason: "x".repeat(characters) };
  return draft;
}

const budgetOf = (response: unknown) =>
  (response as { responseBudget: { within_envelope: boolean; compacted_fields: readonly string[] } }).responseBudget;

/**
 * The authoritative signal, read from the internal marker rather than from
 * `compacted_fields` — that list is a bounded audit report, sorted and capped at
 * ten entries, so a step's presence in it is not a fact about the response.
 */
const declined = (response: unknown): boolean =>
  (response as { productContext?: { diagnostics?: { envelopeDecline?: unknown } } })
    .productContext?.diagnostics?.envelopeDecline === true;

test("M176: an irreducibly oversized response terminates instead of throwing", () => {
  const response = compactProductResponse(irreduciblyOversizedResponse() as never, {
    requestedContextTokens: 8_000,
  }) as unknown as Record<string, any>;

  assert.equal(declined(response), true);
  assert.equal(budgetOf(response).within_envelope, true);
  // Evidence existed, so the record says so — and never that nothing was found.
  assert.equal(response.productContext.retrievalFound, true);
  assert.equal(response.productContext.deliveryFailed, true);
  assert.equal(response.productContext.resultState, "delivery_failure");
  assert.equal(response.productContext.diagnostics.envelopeDecline, true);
  // No authoritative payload travels inside the terminal record.
  assert.deepEqual(response.productContext.items, []);
  assert.equal(response.workspaceRouting, undefined);
  assert.equal(response.capsuleResult, undefined);
  assert.equal(serialize(response).includes("x".repeat(1_000)), false);
});

test("M176: the bounded decline fits even the smallest ceiling, whatever is thrown at it", () => {
  // Every field M176-A classified as unbounded, all oversized at once, measured
  // against `responseTokenCeiling(0)` — the smallest ceiling the product has.
  const draft = duplicatedResponse() as unknown as Record<string, any>;
  const huge = "y".repeat(300_000);
  draft.request.repoRoot = huge;
  draft.productContext.repository = { worktreeId: huge };
  draft.productContext.freshness = { status: huge, reason: huge };
  draft.productContext.leadPivot = huge;
  draft.productContext.topMatchReference = huge;
  draft.workspaceRouting = { reason: huge, perRepository: [{ reason: huge }] };
  draft.intent = { reason: huge };
  draft.savedObservation = huge;
  draft.warnings = [huge];
  draft.flow = { skipReason: huge };

  for (const detail of [McpResponseDetail.Standard, McpResponseDetail.Debug, McpResponseDetail.Compact]) {
    const response = compactProductResponse(draft as never, { requestedContextTokens: 0, detail });
    const budget = budgetOf(response) as unknown as Record<string, number | boolean>;
    assert.equal(declined(response), true, `declined at ${detail}`);
    assert.equal(budget.within_envelope, true, `within envelope at ${detail}`);
    assert.ok(
      (budget.estimated_total_response_tokens as number) <= responseTokenCeiling(0),
      `${detail}: ${budget.estimated_total_response_tokens} > ${responseTokenCeiling(0)}`,
    );
  }
});

test("M176: an over-long top match is omitted rather than truncated", () => {
  // A truncated symbol name is an identity that does not resolve. §30 requires a
  // declared bound; the bound is enforced by dropping the field, not cutting it.
  const draft = irreduciblyOversizedResponse();
  draft.productContext.leadPivot = `pkg/deep.py::${"Nested.".repeat(200)}symbol`;
  const response = compactProductResponse(draft as never, { requestedContextTokens: 8_000 }) as unknown as Record<string, any>;

  assert.equal(declined(response), true);
  assert.equal(response.productContext.topMatchReference, undefined);

  // A usable one survives, because withholding it would make a recoverable state
  // look like a dead end (M174's rule, unchanged).
  const short = irreduciblyOversizedResponse();
  short.productContext.topMatchReference = "pkg/pivot.py::pivot_function";
  const kept = compactProductResponse(short as never, { requestedContextTokens: 8_000 }) as unknown as Record<string, any>;
  assert.equal(kept.productContext.topMatchReference, "pkg/pivot.py::pivot_function");
});

test("M176: an empty retrieval under envelope pressure stays an empty retrieval", () => {
  // §21. The new state applies only where evidence exists and cannot be
  // disclosed. Retrieval's own finding is never dressed up as a delivery loss.
  const draft = irreduciblyOversizedResponse();
  draft.productContext.resolved = false;
  draft.productContext.items = [];
  draft.productContext.modelVisibleContext = "";

  const response = compactProductResponse(draft as never, { requestedContextTokens: 8_000 }) as unknown as Record<string, any>;
  assert.equal(declined(response), true);
  assert.equal(response.productContext.retrievalFound, false);
  assert.equal(response.productContext.deliveryFailed, false);
  assert.equal(response.productContext.resultState, "no_result");
});

test("M176: an unready index under envelope pressure is still reported as unready", () => {
  // §22. Readiness outranks every other decline state, and it is carried in the
  // exact shape the decline projector reads.
  const draft = irreduciblyOversizedResponse();
  draft.diagnostics = { freshness: { readiness: { ready: false, reason: "missing_index" } } };

  const response = compactProductResponse(draft as never, { requestedContextTokens: 8_000 }) as unknown as Record<string, any>;
  assert.equal(declined(response), true);
  assert.equal(response.diagnostics.freshness.readiness.ready, false);
});

test("M176: a response that fits is untouched by the existence of the fallback", () => {
  // §20, §46. No premature decline, and no new terseness: a comfortable response
  // must be byte-identical to what it would be if the fallback did not exist —
  // which it is, because the fallback is reachable only from a failed measurement.
  const fitting = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 12_000 });
  assert.equal(declined(fitting), false);
  assert.equal((fitting as unknown as Record<string, any>).productContext.diagnostics.envelopeDecline, undefined);
  assert.ok((fitting as unknown as Record<string, any>).productContext.items.length > 0);

  // The graceful degradation one rung above is also still reachable, and is NOT
  // marked as an envelope decline: telemetry must be able to tell them apart.
  const degraded = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 1 }) as unknown as Record<string, any>;
  assert.equal(declined(degraded), false);
  assert.equal(degraded.productContext.resultState, "delivery_failure");
  assert.equal(degraded.productContext.diagnostics.envelopeDecline, undefined);
});

test("M176: a genuine implementation failure still fails", () => {
  // §23, §71. The fallback classifies ONE predictable condition. It must not
  // become the place unexpected faults go to be made presentable.
  const hostile = irreduciblyOversizedResponse();
  Object.defineProperty(hostile.productContext, "items", {
    get() { throw new Error("synthetic_internal_failure"); },
    enumerable: true,
  });

  assert.throws(
    () => compactProductResponse(hostile as never, { requestedContextTokens: 8_000 }),
    /synthetic_internal_failure/,
  );
});

test("M176: a larger envelope never yields a weaker terminal state", () => {
  // §47, §48. Monotonicity is what makes the decline a floor and not a coin toss:
  // once a budget delivers items, no larger budget may deliver fewer, and no
  // larger budget may decline where a smaller one answered.
  const rank = (response: Record<string, any>): number => {
    if (declined(response)) return 0;
    if (response.productContext.resultState === "delivery_failure") return 1;
    return 2;
  };
  const draft = irreduciblyOversizedResponse(60_000);
  let previousRank = -1;
  let previousItems = 0;
  for (const budget of [0, 100, 1_000, 4_000, 8_000, 16_000, 32_000, 64_000]) {
    const response = compactProductResponse(draft as never, { requestedContextTokens: budget }) as unknown as Record<string, any>;
    assert.ok(rank(response) >= previousRank, `terminal state weakened at budget ${budget}`);
    assert.ok(response.productContext.items.length >= previousItems, `items dropped at budget ${budget}`);
    previousRank = rank(response);
    previousItems = response.productContext.items.length;
  }
  assert.equal(previousRank, 2, "a large enough envelope must eventually deliver an orientation");
});

test("M176: the re-measure path terminates too", () => {
  // `get_code_context` overwrites freshness and timing on an already-bounded
  // response, which can push it back over the ceiling. Same condition, same
  // terminal record — responseEnvelope.ts:517 threw here as well.
  const compacted = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 500 });
  const mutated = {
    ...(compacted as unknown as Record<string, any>),
    workspaceRouting: { reason: "z".repeat(200_000) },
  } as never;

  const remeasured = remeasureResponseBudget(mutated) as unknown as Record<string, any>;
  assert.equal(declined(remeasured), true);
  assert.equal(remeasured.responseBudget.within_envelope, true);
  assert.equal(remeasured.workspaceRouting, undefined);
});

// ---------------------------------------------------------------------------
// M179 — budget-monotone delivery.
//
// `max_tokens` bounds the EVIDENCE; the ceiling bounds the COMPLETE RESPONSE and
// adds a FLAT metadata allowance. When real metadata costs more than that
// allowance, the evidence a response can carry is `ceiling - metadata`, which is
// LESS than the budget the packer is allowed to spend — so the packer selects a
// rung the envelope cannot ship, and the only remaining move was to discard every
// piece of evidence. Because rung sizes are a step function of the budget, a
// LARGER `max_tokens` could land on a rung that overflowed while a SMALLER one
// landed on one that fitted: more budget, less answer.
//
// Measured on frozen authoritative objects from Broad100-A and Broad100-B:
// 1,088 ordered budget pairs went orientation -> decline, and every one of them
// was DOMINATED — a packet already proven deliverable at a smaller budget
// satisfied both contracts at the larger one.

/** Metadata no rung reduces, sized past the flat allowance. */
function metadataHeavyResponse(characters: number) {
  const draft = duplicatedResponse() as unknown as Record<string, any>;
  draft.productContext.leadPivot = "pkg/pivot.py::pivot_function";
  draft.productContext.freshness = { status: "fresh", reason: "index current" };
  draft.workspaceRouting = { isWorkspace: false, outcome: "single_repository", reason: "x".repeat(characters) };
  return draft;
}

const stateOf = (response: unknown): string =>
  String((response as { productContext?: { resultState?: unknown } }).productContext?.resultState);

test("M179: more delivery budget never withdraws a deliverable answer", () => {
  // Every ORDERED pair, which is the stronger property: 400 good and 1,600 bad is
  // a violation even when every adjacent step looks fine.
  for (const characters of [2_000, 4_000, 6_000, 8_000]) {
    const budgets = [200, 400, 600, 800, 1_000, 1_200, 1_600, 2_000, 3_200, 6_400, 8_000];
    const states = budgets.map((requestedContextTokens) => ({
      budget: requestedContextTokens,
      resolved: stateOf(compactProductResponse(metadataHeavyResponse(characters) as never, { requestedContextTokens })) === "resolved",
    }));
    for (const lower of states) {
      for (const higher of states) {
        if (higher.budget <= lower.budget || !lower.resolved) continue;
        assert.ok(
          higher.resolved,
          `metadata=${characters}: max_tokens ${lower.budget} delivered an answer and ${higher.budget} did not`,
        );
      }
    }
  }
});

test("M179: the recovered packet is one the packer already builds, never a new claim", () => {
  // 1,200 is the budget this fixture used to lose: at 800 the packer landed on a
  // rung that fitted, at 1,200 on one that did not, and the answer disappeared.
  const response = compactProductResponse(metadataHeavyResponse(4_000) as never, {
    requestedContextTokens: 1_200,
  }) as unknown as Record<string, any>;
  const budget = budgetOf(response) as unknown as Record<string, number>;

  assert.equal(response.productContext.resultState, "resolved");
  assert.equal(response.productContext.deliveryFailed, false);
  // Both M178 contracts hold: evidence inside the caller's budget, complete
  // response inside the caller's ceiling. The retry lowers the packer's aim; it
  // never raises the caller's entitlement.
  assert.ok(budget.estimated_model_visible_tokens <= 1_200);
  assert.ok(budget.within_envelope);
  assert.ok(response.productContext.items.length >= 1);
  // The evidence is real, not the failure notice standing in for it.
  assert.equal(String(response.productContext.modelVisibleContext).includes("VTRACE delivery failure"), false);
});

test("M179: a budget that already worked is untouched", () => {
  // §48's no-refill gate. The retry runs only where the response was about to be
  // discarded, so a response that already fitted must be byte-identical — the
  // repair may not become a licence to fill every envelope to its ceiling.
  for (const requestedContextTokens of [8_000, 16_000, 32_000]) {
    const plain = compactProductResponse(duplicatedResponse() as never, { requestedContextTokens });
    assert.equal(stateOf(plain), "resolved");
    assert.equal(
      serialize(plain as never),
      serialize(compactProductResponse(duplicatedResponse() as never, { requestedContextTokens }) as never),
    );
  }
});

test("M179: when even the smallest rung cannot be delivered, the decline is still truthful", () => {
  // Monotonicity does not require pretending evidence fits (§56). The retry is
  // bounded and gives up, and what it gives up to is M176's terminal record.
  const response = compactProductResponse(irreduciblyOversizedResponse() as never, {
    requestedContextTokens: 8_000,
  }) as unknown as Record<string, any>;
  assert.equal(declined(response), true);
  assert.equal(budgetOf(response).within_envelope, true);
  assert.equal(response.productContext.retrievalFound, true);
});

// ---------------------------------------------------------------------------
// M180 — item ownership.
//
// `productContext.items` served two masters: the model-facing per-item metadata
// this module shrinks to fit a ceiling, and the INDEX
// `projectRunPipelineOrientation` reads to decide what the agent is told. Two
// rungs here shrank it by DELETING rows — one reduced the array to a single
// entry, another halved it to a floor of three — while leaving
// `modelVisibleContext` alone. So the response kept paying to ship evidence the
// projector could no longer reach, and because how many rows survived depended
// on the budget, a LARGER budget could deliver FEWER related entries.
//
// Measured on M179's frozen corpora: 722 of 1,380 delivering budgets had the
// supply the projector consumed cut this way, and 72 of the 83 preservation
// violations M179 left came from it. A synthetic object containing nothing but
// sixteen items reproduces it — three related entries at 1,600 and two at 3,200.
//
// The evidence budget is the one contract entitled to decide what evidence
// exists, so it publishes what it delivered and the projector reads that.

/**
 * A response whose items and rendering agree row for row, as the evidence layer
 * always leaves them, with metadata heavy enough to put the item rungs on the
 * path. Items carry a top-level `fqName`: the projector drops rows without one.
 */
function orientationResponse(itemCount: number, metadataCharacters: number, bodyLines = 60) {
  const items = Array.from({ length: itemCount }, (_unused, index) => ({
    id: index === 0 ? "P1" : `S${index}`,
    stableId: `stable${index}`,
    fqName: index === 0 ? "pkg/pivot.py::pivot_function" : `pkg/support${index}.py::support_function_${index}`,
    path: index === 0 ? "pkg/pivot.py" : `pkg/support${index}.py`,
    symbol: index === 0 ? "pivot_function" : `support_function_${index}`,
    roles: index === 0 ? ["pivot", "required"] : ["support"],
    contentMode: index === 0 ? "focused_source" : "skeleton",
    lineSpan: { start: 10, end: 70 },
    selectionReasons: [index === 0 ? "symbol-name match" : `structural neighbour ${index}`],
    estimatedTokens: 200,
    content: bigBody(`item${index}`, bodyLines),
    metadata: { fqName: `pkg/item${index}.py::symbol_${index}`, kind: "function", noise: "n".repeat(120) },
  }));
  const modelVisibleContext = [
    "# VTRACE product context",
    "task: investigate the failure",
    ...items.flatMap((item) => [
      "",
      `## [${item.id}] ${item.fqName}`,
      `roles: ${item.roles.join(", ")}`,
      `mode: ${item.contentMode}`,
      `lines: ${item.lineSpan.start}-${item.lineSpan.end}`,
      ...item.selectionReasons.map((reason) => `why: ${reason}`),
      "",
      item.content,
    ]),
  ].join("\n");
  return {
    schemaVersion: "run_pipeline.vnext/1",
    productContext: {
      responseVersion: 2,
      resolved: true,
      retrievalFound: true,
      deliveryFailed: false,
      resultState: "resolved",
      task: "investigate the failure",
      leadPivot: "pkg/pivot.py::pivot_function",
      modelVisibleContext,
      items,
      freshness: { status: "fresh", reason: "index current" },
      accounting: { budgetTokens: 8_000 },
      diagnostics: { staticEvidenceOnly: true },
      repository: { worktreeId: "test" },
      timing: { totalMs: 1 },
    },
    workspaceRouting: { isWorkspace: false, outcome: "single_repository", reason: "x".repeat(metadataCharacters) },
  };
}

/** Section ids of a rendering: what the EVIDENCE layer delivered, unforgeably. */
const renderedIds = (response: unknown): string[] => {
  const rendered = String((response as { productContext?: { modelVisibleContext?: unknown } }).productContext?.modelVisibleContext ?? "");
  return rendered.split(/\n## /).slice(1).flatMap((section) => {
    const match = /^\[([^\]]+)\]/.exec(section);
    return match === null ? [] : [match[1]!];
  });
};

test("M180: response metadata compaction never decides what the projector sees", () => {
  for (const metadataCharacters of [2_000, 6_000]) {
    for (const requestedContextTokens of [1_600, 2_000, 3_200, 6_400, 8_000]) {
      const response = compactProductResponse(orientationResponse(12, metadataCharacters) as never, {
        requestedContextTokens,
      }) as unknown as Record<string, any>;
      if (response.productContext.resultState !== "resolved") continue;

      const packet = projectRunPipelineOrientation(response);
      assert.ok(packet !== null, `no orientation at ${requestedContextTokens}/${metadataCharacters}`);
      // Everything the evidence layer rendered is reachable: the focus plus the
      // related list account for every delivered section. The bound that may
      // still cut the list is the projector's own ceiling, not this module's.
      const delivered = new Set([packet.focus.at, ...packet.related.map((entry) => entry.at)]);
      assert.equal(
        renderedIds(response).length <= delivered.size,
        true,
        `${renderedIds(response).length} sections rendered, ${delivered.size} reachable at ${requestedContextTokens}/${metadataCharacters}`,
      );
    }
  }
});

test("M180: more delivery budget never withdraws a related entry", () => {
  // 12 items, 60-line bodies and 2,000 characters of metadata is the shape that
  // reproduces it before the repair: 6,400 delivered two related entries and
  // 8,000 delivered none, because the larger budget carried more evidence, which
  // cost more metadata, which put the mandatory collapse back on the path.
  for (const [itemCount, metadataCharacters] of [[12, 2_000], [8, 0], [16, 1_000]] as const) {
    const budgets = [800, 1_000, 1_200, 1_600, 2_000, 3_200, 6_400, 8_000];
    const packets = budgets.map((requestedContextTokens) => ({
      budget: requestedContextTokens,
      packet: projectRunPipelineOrientation(
        compactProductResponse(orientationResponse(itemCount, metadataCharacters) as never, { requestedContextTokens }),
      ),
    }));
    for (const lower of packets) {
      for (const higher of packets) {
        if (higher.budget <= lower.budget || lower.packet === null) continue;
        assert.ok(higher.packet !== null, `${lower.budget} delivered an orientation and ${higher.budget} did not`);
        const present = new Set(higher.packet.related.map((entry) => entry.at));
        for (const entry of lower.packet.related) {
          assert.ok(
            present.has(entry.at),
            `${itemCount} items / metadata=${metadataCharacters}: ${entry.at} delivered at ${lower.budget}, missing at ${higher.budget}`,
          );
        }
      }
    }
  }
});

test("M180: metadata compaction still shrinks the response", () => {
  // The repair moves what compaction is ALLOWED to change, not whether it runs.
  // A response whose per-item metadata is still ejected is the point; one that
  // stopped compacting would trade a preservation defect for a budget one.
  const response = compactProductResponse(orientationResponse(12, 2_000) as never, {
    requestedContextTokens: 1_600,
  }) as unknown as Record<string, any>;
  assert.equal(response.responseBudget.within_envelope, true);
  assert.equal(response.responseBudget.compaction_applied, true);
  const items = response.productContext.items as Record<string, unknown>[];
  assert.ok(items.length < 12, "per-item metadata rows were not compacted at all");
  // And the evidence it names is still all there, in the rendering.
  assert.equal(renderedIds(response).length > items.length, true);
});
