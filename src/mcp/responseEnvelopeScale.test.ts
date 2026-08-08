// M131 whole-response scale tests.
//
// M130 proved the envelope holds for ONE payload: the captured incident. That is
// exactly the shape of assurance that failed before — a property checked against
// a single example. These tests vary the dimensions a real response actually
// grows along (items, source size, diagnostics, flow hops, impact records,
// document excerpts) and assert the same invariants at every size.

import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  compactProductResponse,
  responseTokenCeiling,
  serialize,
} from "./responseEnvelope";
import { resolveProductResponseOptions, resolveRequestedContextTokens } from "./productResponseOptions";

const REQUESTED_TOKENS = 6_000;

function body(marker: string, lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) => `    ${marker}_line_${index} = compute_${marker}(${index})  # unique ${marker} payload`,
  ).join("\n");
}

interface ShapeSpec {
  readonly items: number;
  readonly sourceLines: number;
  readonly diagnosticsEntries: number;
  readonly flowHops: number;
  readonly impactRecords: number;
  readonly documentExcerpts: number;
}

const BASELINE: ShapeSpec = {
  items: 4,
  sourceLines: 30,
  diagnosticsEntries: 10,
  flowHops: 1,
  impactRecords: 3,
  documentExcerpts: 1,
};

/**
 * A response with the given shape. Every body is unique so duplication shows up
 * as repeated text rather than hiding behind a shared string reference.
 */
function shapedResponse(spec: ShapeSpec): Record<string, unknown> {
  const bodies = Array.from({ length: spec.items }, (_, index) => body(`item${index}`, spec.sourceLines));
  const documents = Array.from(
    { length: spec.documentExcerpts },
    (_, index) => body(`doc${index}`, Math.max(4, Math.floor(spec.sourceLines / 2))),
  );

  // The packer bounds the rendered context to the caller's token budget upstream;
  // the envelope's job is everything AROUND that one representation. Truncating
  // here models the real contract — an unbounded rendered context is an input the
  // product cannot produce, and no metadata compaction could rescue it.
  const modelVisibleContext = [
    "# VTRACE product context",
    ...bodies.flatMap((source, index) => [`## [P${index}] pkg/mod_${index}.py::fn_${index}`, "", source, ""]),
    ...documents.flatMap((text, index) => [`## [D${index}] config/doc_${index}.yaml`, "", text, ""]),
  ].join("\n").slice(0, REQUESTED_TOKENS * 4);

  return {
    schemaVersion: "run_pipeline.vnext/1",
    request: { query: "scale probe", task: "scale probe" },
    productContext: {
      responseVersion: 2,
      resolved: true,
      task: "scale probe",
      modelVisibleContext,
      items: [
        ...bodies.map((source, index) => ({
          id: `P${index}`,
          stableId: `item${index}`,
          path: `pkg/mod_${index}.py`,
          symbol: `fn_${index}`,
          roles: index === 0 ? ["pivot", "required"] : ["support"],
          contentMode: "focused_source",
          lineSpan: { start: 1, end: spec.sourceLines },
          selectionReasons: ["lexical match", "graph neighbour", "co-edit evidence", "extra"],
          estimatedTokens: Math.ceil(source.length / 4),
          content: source,
          metadata: { fqName: `pkg/mod_${index}.py::fn_${index}`, kind: "function" },
        })),
        ...documents.map((text, index) => ({
          id: `D${index}`,
          stableId: `doc${index}`,
          path: `config/doc_${index}.yaml`,
          roles: ["configuration"],
          contentMode: "document_excerpt",
          selectionReasons: ["path clue"],
          estimatedTokens: Math.ceil(text.length / 4),
          content: text,
          metadata: { documentKind: "yaml" },
        })),
      ],
      accounting: { budgetTokens: 6000, usedTokensEstimate: 1200 },
      freshness: { status: "fresh", reason: "fresh", action: "none" },
      diagnostics: {
        staticEvidenceOnly: true,
        selectedFiles: bodies.map((_, index) => `pkg/mod_${index}.py`),
      },
    },
    capsuleResult: {
      query: "scale probe",
      digest: bodies.map((_, index) => `● pivot pkg/mod_${index}.py::fn_${index}`).join("\n"),
      pivots: bodies.map((source, index) => ({
        role: index === 0 ? "pivot" : "support",
        path: `pkg/mod_${index}.py`,
        symbol: `fn_${index}`,
        fqName: `pkg/mod_${index}.py::fn_${index}`,
        kind: "function",
        contentMode: "full",
        source,
        signature: `def fn_${index}():`,
        evidence: ["lexical match", "graph neighbour"],
        estimatedTokens: Math.ceil(source.length / 4),
      })),
      support: [],
      discarded: Array.from({ length: spec.items }, (_, index) => ({
        path: `pkg/unselected_${index}.py`,
        symbol: `dropped_${index}`,
        discardReason: "below threshold",
        source: body(`unselected${index}`, spec.sourceLines),
      })),
      discardedTotal: spec.items,
      diagnostics: { candidateCount: spec.items * 10 },
      warnings: [],
    },
    pivotNeighborhood: bodies.slice(0, Math.min(3, spec.items)).map((source, index) => ({
      pivot: { path: `pkg/mod_${index}.py`, symbol: `fn_${index}`, fqName: `pkg/mod_${index}.py::fn_${index}` },
      excerpts: [{
        filePath: `pkg/mod_${index}.py`,
        symbol: `fn_${index}`,
        startLine: 1,
        endLine: spec.sourceLines,
        text: source,
        reason: "callee",
        truncated: false,
      }],
      skipped: [],
    })),
    context: {
      included: true,
      skipReason: null,
      pivots: bodies.map((_, index) => ({
        symbolId: `sym-${index}`,
        filePath: `pkg/mod_${index}.py`,
        fqName: `pkg/mod_${index}.py::fn_${index}`,
        localName: `fn_${index}`,
        kind: "function",
        role: "pivot",
        contentMode: "full",
        inclusionReasons: [{ kind: "query_coverage", note: "actionable" }],
        lexicalScore: 0.8,
        graphScore: 0.1,
        finalScore: 1.4,
      })),
      supports: [],
      itemCount: spec.items,
    },
    diagnostics: {
      retrieval: {
        finalReason: "ok",
        finalContextItemCount: spec.items,
        search: {
          normalizedQuery: "scale probe",
          identifierTerms: ["scale"],
          queryVariants: Array.from({ length: spec.diagnosticsEntries }, (_, index) => `expanded query variant number ${index}`),
          laneCandidateFiles: Array.from({ length: spec.diagnosticsEntries }, (_, index) => `pkg/candidate_${index}.py`),
        },
      },
      indexFreshness: { status: "fresh", reason: "fresh", action: "none" },
      impact: { included: spec.impactRecords > 0, skipReason: null },
    },
    flow: {
      included: spec.flowHops > 0,
      skipReason: null,
      claimScope: "current_index",
      endpointsResolved: true,
      paths: [{
        pathIndex: 1,
        edgeCount: spec.flowHops,
        steps: Array.from({ length: spec.flowHops }, (_, index) => ({
          edgeType: "calls",
          fromFqName: `pkg/mod_${index}.py::fn_${index}`,
          toFqName: `pkg/mod_${index + 1}.py::fn_${index + 1}`,
          relation: {
            kind: "calls",
            strength: "exact",
            evidence: {
              resolutionMethod: "same_file_or_same_class_call_resolution",
              locationKind: "edge_site",
              sourceText: `    result_${index} = fn_${index + 1}(payload)`,
              callSites: [{ startLine: index + 1, endLine: index + 1, precision: "span" }],
              callSiteCount: 1,
            },
          },
          sourceExcerpt: {
            filePath: `pkg/mod_${index}.py`,
            startLine: index + 1,
            endLine: index + 6,
            text: body(`hop${index}`, 6),
            reason: "edge_site",
            truncated: true,
          },
        })),
      }],
    },
    impact: {
      included: spec.impactRecords > 0,
      skipReason: null,
      topDependents: Array.from({ length: spec.impactRecords }, (_, index) => ({
        path: `pkg/dependent_${index}.py`,
        symbol: `dependent_${index}`,
        distance: 1 + (index % 3),
        sourceExcerpt: { filePath: `pkg/dependent_${index}.py`, startLine: 1, endLine: 6, text: body(`dep${index}`, 6), reason: "signature", truncated: true },
      })),
    },
    memory: { session: { included: false, recentObservations: [] }, durable: { included: false, topObservations: [] } },
    rules: { included: false, active: [] },
    inspectFirst: { confidence: "medium", likelyFirst: { path: "pkg/mod_0.py", symbol: "fn_0", why: "lead" }, related: [], avoidFirst: null },
    deferred: { items: [], expandable: false },
    accounting: { latencyMs: 9, estimatedOutputTokens: 700, method: "chars_div_4" },
  };
}

/** How many times a unique body appears in the serialized response. */
function bodyOccurrences(response: unknown, marker: string): number {
  const serialized = serialize(response);
  const probe = JSON.stringify(`    ${marker}_line_0 = compute_${marker}(0)`).slice(1, -1);
  return serialized.split(probe).length - 1;
}

/** The invariants that must hold for EVERY shape, not just the incident's. */
function assertEnvelopeInvariants(spec: ShapeSpec, label: string): void {
  const before = shapedResponse(spec);
  const modelVisible = (before.productContext as { modelVisibleContext: string }).modelVisibleContext;
  const after = compactProductResponse(before, { requestedContextTokens: REQUESTED_TOKENS });
  const budget = after.responseBudget;
  const ceiling = responseTokenCeiling(REQUESTED_TOKENS);

  assert.equal(
    budget.estimated_total_response_tokens <= ceiling,
    true,
    `${label}: ${budget.estimated_total_response_tokens} tokens exceeds ceiling ${ceiling}`,
  );
  assert.equal(
    budget.serialized_response_characters,
    serialize(after).length,
    `${label}: reported serialized size disagrees with the actual payload`,
  );
  assert.equal(
    budget.estimated_model_visible_tokens <= REQUESTED_TOKENS,
    true,
    `${label}: model-visible context ${budget.estimated_model_visible_tokens} exceeds the request`,
  );

  // One source-bearing representation, at every shape.
  for (let index = 0; index < spec.items; index += 1) {
    assert.equal(
      bodyOccurrences(after, `item${index}`) <= 1,
      true,
      `${label}: item ${index} body serialized more than once`,
    );
    assert.equal(
      bodyOccurrences(after, `unselected${index}`),
      0,
      `${label}: unselected candidate source leaked`,
    );
  }

  assert.equal(JSON.parse(serialize(after)) !== null, true, `${label}: response must serialize and parse`);
}

test("the envelope holds as the number of selected items grows", () => {
  for (const items of [1, 4, 12, 40]) {
    assertEnvelopeInvariants({ ...BASELINE, items }, `items=${items}`);
  }
});

test("the envelope holds as selected source files grow", () => {
  for (const sourceLines of [10, 60, 300, 1_200]) {
    assertEnvelopeInvariants({ ...BASELINE, sourceLines }, `sourceLines=${sourceLines}`);
  }
});

test("the envelope holds as diagnostics grow", () => {
  for (const diagnosticsEntries of [0, 20, 200, 2_000]) {
    assertEnvelopeInvariants({ ...BASELINE, diagnosticsEntries }, `diagnostics=${diagnosticsEntries}`);
  }
});

test("the envelope holds as flow hops grow", () => {
  for (const flowHops of [0, 1, 4, 12]) {
    assertEnvelopeInvariants({ ...BASELINE, flowHops }, `flowHops=${flowHops}`);
  }
});

test("the envelope holds as impact records grow", () => {
  for (const impactRecords of [0, 5, 40, 200]) {
    assertEnvelopeInvariants({ ...BASELINE, impactRecords }, `impact=${impactRecords}`);
  }
});

test("the envelope holds as document excerpts grow", () => {
  for (const documentExcerpts of [0, 3, 15, 60]) {
    assertEnvelopeInvariants({ ...BASELINE, documentExcerpts }, `documents=${documentExcerpts}`);
  }
});

test("the envelope holds when every dimension grows at once", () => {
  assertEnvelopeInvariants(
    { items: 30, sourceLines: 400, diagnosticsEntries: 800, flowHops: 10, impactRecords: 120, documentExcerpts: 25 },
    "combined",
  );
});

test("a tiny budget still yields a valid, bounded, parseable response", () => {
  const shaped = shapedResponse({ ...BASELINE, items: 20, sourceLines: 200 });
  // A 100-token request against a context rendered for 6000: the rendered text
  // is the caller's own, so the honest outcome is to compact everything around
  // it and report the shortfall rather than mutilate the context.
  const after = compactProductResponse(shaped, { requestedContextTokens: 100 });

  assert.equal(after.responseBudget.compaction_applied, true);
  assert.equal(typeof JSON.parse(serialize(after)), "object");
  assert.equal(
    after.responseBudget.estimated_metadata_tokens < after.responseBudget.estimated_model_visible_tokens,
    true,
    "metadata should have been compacted well below the context it describes",
  );
});

test("a model-visible context larger than the ceiling is reported, never silently exceeded", () => {
  const shaped = shapedResponse({ ...BASELINE, items: 20, sourceLines: 200 });
  const after = compactProductResponse(shaped, { requestedContextTokens: 100 });

  // The one case metadata compaction cannot fix. `within_envelope` says so
  // instead of the response quietly overshooting the documented bound.
  assert.equal(after.responseBudget.estimated_model_visible_tokens > 100, true);
  assert.equal(after.responseBudget.within_envelope, false);
  assert.equal(after.responseBudget.total_response_token_ceiling, responseTokenCeiling(100));
});

test("the budget rule is resolved in exactly one place", () => {
  // The M130 defect this replaces: max_tokens reached the capsule but not the
  // authoritative product context, because the precedence was written by hand
  // at each call site.
  assert.equal(resolveRequestedContextTokens({ maxTokens: 6_000 }), 6_000);
  assert.equal(resolveRequestedContextTokens({ capsuleBudgetTokens: 3_000, maxTokens: 6_000 }), 3_000);
  assert.equal(resolveRequestedContextTokens({}), 8_000);
  // Malformed input degrades to the default rather than producing a zero budget.
  assert.equal(resolveRequestedContextTokens({ maxTokens: 0 }), 8_000);
  assert.equal(resolveRequestedContextTokens({ maxTokens: Number.NaN }), 8_000);

  const options = resolveProductResponseOptions({ maxTokens: 6_000, detail: "debug" });
  assert.equal(options.requestedContextTokens, 6_000);
  assert.equal(options.responseTokenCeiling, responseTokenCeiling(6_000));
  assert.equal(options.detail, "debug");
  assert.equal(options.includeItemContent, false);
  assert.equal(resolveProductResponseOptions({ detail: "nonsense" }).detail, "standard");
});
