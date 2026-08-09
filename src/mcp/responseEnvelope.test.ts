// M130 complete-response budgeting and source-duplication tests.
//
// The incident: a `max_tokens: 6000` request returned an 87,146-character result
// because the same selected context was serialized across several fields. These
// tests pin the invariant that replaced it — one source-bearing representation,
// compact metadata, bounded diagnostics — and the envelope that enforces it.

import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  McpResponseDetail,
  compactProductResponse,
  isMcpResponseDetail,
  remeasureResponseBudget,
  responseTokenCeiling,
  serialize,
} from "./responseEnvelope";

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
      indexFreshness: { status: "fresh", reason: "fresh", action: "none", manifestDelta: "x".repeat(900) },
      freshness: { state: "fresh", nested: { verbose: "x".repeat(400) } },
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

test("modelVisibleContext is the authoritative representation and is never compacted", () => {
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
    // The rendered context is fixed by retrieval and is never truncated to fit;
    // when it alone exceeds the ceiling the response says so rather than lying.
    if (budget.estimated_model_visible_tokens <= requested) {
      assert.equal(
        budget.within_envelope,
        true,
        `requested=${requested} produced ${budget.estimated_total_response_tokens} tokens`,
      );
    }
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
  assert.equal(after.productContext.resolved, false);
  assert.match(after.productContext.modelVisibleContext, /Bounded response degradation/);
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

test("raw retrieval matrices are counts by default and bounded samples under debug", () => {
  const standard = compactProductResponse(duplicatedResponse(), { requestedContextTokens: 12_000 });
  const standardSearch = standard.diagnostics.retrieval.search as Record<string, unknown>;
  assert.equal(standardSearch.queryVariants, undefined);
  assert.equal(standardSearch.queryVariantsCount, 60);
  assert.equal(standardSearch.laneCandidateFilesCount, 80);
  // Short, readable term lists are not collateral damage.
  assert.deepEqual(standardSearch.identifierTerms, ["failure"]);

  const debug = compactProductResponse(duplicatedResponse(), {
    requestedContextTokens: 12_000,
    detail: McpResponseDetail.Debug,
  });
  const debugSearch = debug.diagnostics.retrieval.search as Record<string, unknown>;
  assert.equal((debugSearch.queryVariantsSample as string[]).length, 12);
  assert.equal(debugSearch.queryVariantsCount, 60);
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
