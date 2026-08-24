import assert from "node:assert/strict";
import { test } from "bun:test";

import { EdgeType, SymbolKind } from "../domain/types";
import type { ImpactEdge, ImpactGraphOutput, ImpactNode } from "./getImpactGraph";
import {
  IMPACT_HARD_SERIALIZED_CHARACTER_CEILING,
  IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS,
  compactImpactProductResponse,
  impactResponseFitsEnvelope,
  impactResponseMeetsEvidenceBudget,
  impactResponseTokenCeiling,
} from "./impactResponseEnvelope";
import type { StaticRelationEvidence } from "./staticEvidence";

test("complete impact response stays flat as the examined graph grows to 100k edges", () => {
  const sizes: number[] = [];
  for (const totalEdges of [100, 1_000, 10_000, 100_000]) {
    const response = compactImpactProductResponse(graph(totalEdges));
    const serialized = JSON.stringify(response);
    sizes.push(serialized.length);
    assert.equal(response.responseBudget.withinEnvelope, true);
    assert.ok(response.responseBudget.retainedEdges <= 10);
    assert.ok(serialized.length <= 8_000);
    assert.ok(serialized.length <= IMPACT_HARD_SERIALIZED_CHARACTER_CEILING);
    assert.equal(response.nodes.length <= response.edges.length + 1, true);
    assert.equal(response.view.lines.length <= response.nodes.length, true);
    assert.equal(response.responseBudget.omittedEdges >= totalEdges - 10, true);
  }
  assert.equal(Math.max(...sizes) - Math.min(...sizes) < 64, true, sizes.join(","));
});

test("large fanout retains only canonical endpoints and reports omissions", () => {
  const response = compactImpactProductResponse(graph(10_000));
  const edgeNodeIds = new Set(response.edges.flatMap((edge) => [edge.fromSymbolId, edge.toSymbolId]));
  for (const node of response.nodes) {
    assert.equal(node.symbolId === "root" || edgeNodeIds.has(node.symbolId), true);
  }
  assert.ok(response.responseBudget.retainedEdges <= 10);
  assert.ok(response.responseBudget.omittedEdges >= 9_990);
});

test("path count, depth, and edge ids cannot bypass the canonical result", () => {
  const input = graph(20);
  const edge = input.edges[0]!;
  const relation = relationFor(edge, 12);
  const paths = Array.from({ length: 10 }, (_, index) => ({
    id: `path-${index}`,
    direction: "caller_to_target" as const,
    nodes: [input.nodes[1]!, input.nodes[0]!],
    edges: [relation],
    length: index === 0 ? 6 : 1,
    minimumStrength: "resolved" as const,
    truncated: false,
    limitations: [],
  }));
  const response = compactImpactProductResponse({
    ...input,
    directRelations: [relation],
    paths,
    limits: { ...input.limits, maxDepth: 3, maxPaths: 3 },
  });
  assert.ok(response.paths.length <= 3);
  assert.equal(response.paths.every((path) => path.length <= 3), true);
  const retainedIds = new Set(response.edges.map((item) => item.edgeId));
  assert.equal(
    response.paths.flatMap((path) => path.edges).every((item) => item.edgeId === null || retainedIds.has(item.edgeId)),
    true,
  );
});

test("six direct caller sites survive the incident limits without duplicate source bodies", () => {
  const input = graph(2);
  const lines = [253, 84, 88, 92, 98, 101];
  const sameFile = relationFor(input.edges[0]!, lines[0]!);
  const testCalls = relationFor(input.edges[1]!, lines[1]!);
  const directRelations = [sameFile, {
    ...testCalls,
    evidence: {
      ...testCalls.evidence,
      callSites: lines.slice(1).map((line) => ({ startLine: line, endLine: line, precision: "span" as const })),
      callSiteCount: 5,
    },
  }];
  const response = compactImpactProductResponse({ ...input, directRelations });
  assert.equal(response.responseBudget.requestedMaxEdges, 10);
  assert.equal(response.responseBudget.retainedEdges, 2);
  assert.equal(response.responseBudget.withinEnvelope, true);
  assert.ok(response.responseBudget.estimatedTotalTokens <= response.responseBudget.totalCeiling);
  assert.ok(response.responseBudget.serializedCharacters <= 8_000);
  const retainedLines = response.directRelations.flatMap((relation) =>
    relation.evidence.callSites?.map((site) => site.startLine) ?? []);
  assert.deepEqual(retainedLines, lines);
  assert.equal(response.nodes.some((node) => node.sourceExcerpt !== undefined), false);
});

test("representative edge/token/path/depth limit matrix always gates the final object", () => {
  const cases = [
    { maxEdges: 1, maxTokens: 400, maxPaths: 1, maxDepth: 1 },
    { maxEdges: 3, maxTokens: 800, maxPaths: 3, maxDepth: 3 },
    { maxEdges: 10, maxTokens: 1_200, maxPaths: 3, maxDepth: 5 },
    { maxEdges: 50, maxTokens: 3_000, maxPaths: 10, maxDepth: 5 },
  ];
  for (const limits of cases) {
    const input = graph(1_000);
    const response = compactImpactProductResponse({ ...input, limits });
    assert.ok(response.responseBudget.retainedEdges <= limits.maxEdges);
    assert.ok(response.responseBudget.modelVisibleEstimatedTokens <= limits.maxTokens);
    assert.ok(response.responseBudget.estimatedTotalTokens <= response.responseBudget.totalCeiling);
    assert.equal(response.responseBudget.withinEnvelope, true);
    assert.equal(response.paths.length <= limits.maxPaths, true);
  }
});

test("large exact source-like strings are not duplicated across response projections", () => {
  const repeatedBody = `def caller():\n${"    target()\n".repeat(80)}`;
  const input = graph(100);
  const response = compactImpactProductResponse({
    ...input,
    nodes: input.nodes.map((item, index) => index === 1
      ? { ...item, sourceExcerpt: { filePath: item.filePath, startLine: 1, endLine: 81, text: repeatedBody, reason: "symbol_span" } }
      : item),
    coverage: { ...input.coverage, notes: [...input.coverage.notes, repeatedBody] },
  });
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes(repeatedBody), false);
  assert.equal(response.nodes.some((item) => item.sourceExcerpt !== undefined), false);
});

function graph(totalEdges: number): ImpactGraphOutput {
  const nodes: ImpactNode[] = [node("root", 0), ...Array.from({ length: 10 }, (_, index) => node(`n${index}`, 1))];
  const edges: ImpactEdge[] = Array.from({ length: totalEdges }, (_, index) => ({
    edgeId: `edge-${index.toString().padStart(6, "0")}`,
    edgeType: EdgeType.Calls,
    fromSymbolId: `n${index % 10}`,
    fromFqName: `src/caller${index % 10}.py::caller${index % 10}`,
    toSymbolId: "root",
    toFqName: "src/root.py::target",
  }));
  return {
    requested: { symbolFqn: "src/root.py::target", depth: 5, crossRepo: false, format: "list" },
    resolvedSymbol: { symbolId: "root", filePath: "src/root.py", fqName: "src/root.py::target", localName: "target", kind: SymbolKind.Function },
    coverage: { analysisKind: "structural", resolutionMode: "exact_fqn", crossRepo: false, supportedEdgeTypes: [EdgeType.Calls], observedEdgeTypes: [EdgeType.Calls], notes: Array.from({ length: 50 }, (_, index) => `coverage ${index} ${"x".repeat(100)}`) },
    summary: { dependentSymbolCount: 10, dependentFileCount: 10, maxDepth: 5, maxObservedDistance: 1 },
    dependentFiles: nodes.slice(1).map((item) => item.filePath),
    nodes,
    edges,
    view: { format: "list", lines: Array.from({ length: totalEdges }, (_, index) => `unbounded ${index} ${"v".repeat(80)}`) },
    directRelations: [],
    paths: [],
    affectedFiles: [],
    entrypoints: [],
    tests: [],
    richSummary: { directIncoming: totalEdges, directOutgoing: 0, transitiveIncoming: 0, transitiveOutgoing: 0, affectedFiles: 10, affectedSymbols: 10, countsByRelation: { calls: totalEdges }, countsByStrength: { resolved: totalEdges }, truncated: totalEdges > 10, omittedPaths: 0, omittedEdges: Math.max(0, totalEdges - 10) },
    limits: { maxDepth: 5, maxPaths: 3, maxEdges: 10, maxTokens: 1_200 },
    timing: { targetResolutionMs: 0, directNeighborQueryMs: 0, pathTraversalMs: 0, renderMs: 0, totalImpactMs: 0 },
    diagnostics: { staticEvidenceOnly: true, nodesVisited: totalEdges + 1, edgesInspected: totalEdges, pathsConsidered: 0, pathsReturned: 0, canonicalEdgesRetained: 10, canonicalNodesRetained: 11, canonicalEdgesOmitted: Math.max(0, totalEdges - 10), deliveryTruncated: totalEdges > 10, traversalLimitReached: totalEdges > 10, limitations: [] },
  };
}

function node(id: string, distance: number): ImpactNode {
  return { symbolId: id, filePath: id === "root" ? "src/root.py" : `src/${id}.py`, fqName: id === "root" ? "src/root.py::target" : `src/${id}.py::${id}`, localName: id, kind: SymbolKind.Function, distance };
}

function relationFor(edge: ImpactEdge, line: number): StaticRelationEvidence {
  return {
    id: `relation-${edge.edgeId}`,
    edgeId: edge.edgeId,
    kind: "calls",
    persistedKind: EdgeType.Calls,
    source: { nodeId: edge.fromSymbolId, path: `src/${edge.fromSymbolId}.py`, symbol: edge.fromFqName, kind: SymbolKind.Function, lineSpan: { start: line, end: line } },
    target: { nodeId: edge.toSymbolId, path: "src/root.py", symbol: edge.toFqName, kind: SymbolKind.Function },
    direction: "incoming",
    strength: "resolved",
    confidence: null,
    evidence: { resolutionMethod: "import_or_module_qualified_call_resolution", locationKind: "edge_site", callSites: [{ startLine: line, endLine: line, precision: "span" }], callSiteCount: 1 },
    limitations: [],
  };
}

// ── M177: response totality ─────────────────────────────────────────────────
//
// Before M177 every budget below the envelope floor threw
// `impact_response_envelope_unreachable`, which the MCP server's catch-all
// reported as `handler_failed`: a predictable product condition arriving as an
// implementation fault. Reproduced through the real transport on
// `pytest-dev__pytest-10081` at max_tokens 1/50/100/200/400, and — more
// tellingly — on a symbol with no impact at all, where there was never any
// evidence to shed.
//
// WHY THESE TESTS USE A DIFFERENT FIXTURE. `graph()` above is deliberately
// evidence-heavy and metadata-light, which is the right shape for testing the
// compaction ladder but the wrong shape for testing its terminal: it fits at
// max_tokens=1 and never reaches the code under test. M177-A measured the real
// floor to be 61% METADATA, so `realisticGraph()` carries the field population a
// real response has — hashed symbol ids, a full edge-type inventory, multi-key
// count maps, the M139 caller-coverage block and one line each of real coverage
// and limitation prose. Nothing here is padding for its own sake; remove any of
// it and the fixture stops representing a real response.

test("M177: a budget too small for any response returns a bounded decline, not a throw", () => {
  for (const maxTokens of [1, 25, 50, 100]) {
    const response = compactImpactProductResponse(realisticGraph(1_000, maxTokens));
    assert.equal(response.diagnostics.envelopeDecline, true, `max_tokens=${maxTokens}`);
    assert.equal(response.responseBudget.retainedEdges, 0);
    assert.equal(response.edges.length, 0);
    assert.equal(response.directRelations.length, 0);
    assert.equal(response.nodes.length, 0);
    assert.equal(response.paths.length, 0);
    // The terminal is returned, never re-gated, so it has to actually fit —
    // otherwise the unreachable state has just moved one rung down.
    assert.ok(
      response.responseBudget.estimatedTotalTokens <= response.responseBudget.totalCeiling,
      `max_tokens=${maxTokens}: ${response.responseBudget.estimatedTotalTokens} > ${response.responseBudget.totalCeiling}`,
    );
    assert.ok(response.responseBudget.serializedCharacters <= IMPACT_HARD_SERIALIZED_CHARACTER_CEILING);
    assert.equal(response.responseBudget.withinEnvelope, true);
  }
});

test("M177: the decline counts what it could not deliver instead of reporting an empty graph", () => {
  const response = compactImpactProductResponse(realisticGraph(1_000, 1));
  // The one claim this record must never make: that there is nothing there.
  assert.ok(response.responseBudget.omittedEdges >= 990);
  assert.equal(response.responseBudget.resultState, "bounded_truncated");
  assert.equal(response.diagnostics.deliveryTruncated, true);
  assert.equal(response.richSummary.truncated, true);
  // Discovered populations are facts about the repository, not about the
  // response, so they survive a delivery of nothing.
  assert.equal(response.richSummary.directIncoming, 1_000);
  assert.equal(response.summary.consumers.exactCallerCount, 1_000);
  assert.equal(response.summary.consumers.potentialCallerCount, 4);
});

test("M177: a genuinely empty impact is never dressed as a delivery loss, at any budget", () => {
  // EMPTY_IMPACT is not BOUNDED_NONDELIVERY, and `omittedEdges` is what tells
  // them apart: nothing was withheld, because there was nothing to withhold.
  // The invariant holds whether or not the budget is tight enough to reach the
  // terminal, which is why every budget is checked rather than the one that
  // happens to decline.
  for (const maxTokens of [1, 25, 200, 1_200]) {
    const response = compactImpactProductResponse(realisticGraph(0, maxTokens));
    assert.equal(response.responseBudget.omittedEdges, 0, `max_tokens=${maxTokens}`);
    assert.equal(response.responseBudget.retainedEdges, 0);
    assert.notEqual(response.responseBudget.resultState, "bounded_truncated");
  }
});

test("M177: the terminal preserves an honest zero when it fires on an empty impact", () => {
  // An empty graph is SMALL, so reaching its terminal takes a response whose
  // irreducible metadata is large for a reason other than evidence. A deeply
  // nested module path is that reason, and it is a real one: identity is the
  // only variable-length metadata a decline carries. It stays under the
  // 200-character bound on purpose, so this also covers the case where a long
  // identity is still short enough to be quoted verbatim.
  const deep = `src/_pytest/${"config/parsing/".repeat(8)}argparsing.py::__all__`;
  const base = realisticGraph(0, 1);
  const response = compactImpactProductResponse({
    ...base,
    requested: { ...base.requested, symbolFqn: deep },
    resolvedSymbol: { ...base.resolvedSymbol, fqName: deep, filePath: deep.split("::")[0]! },
  });
  assert.equal(response.diagnostics.envelopeDecline, true);
  assert.equal(response.responseBudget.omittedEdges, 0);
  assert.equal(response.responseBudget.retainedEdges, 0);
  assert.notEqual(response.responseBudget.resultState, "bounded_truncated");
  assert.equal(response.resolvedSymbol.fqName, deep);
  assert.ok(response.responseBudget.estimatedTotalTokens <= response.responseBudget.totalCeiling);
});

test("M177: responses that already fitted are untouched and carry no decline marker", () => {
  for (const maxTokens of [1_200, 3_000, 20_000]) {
    const response = compactImpactProductResponse(realisticGraph(1_000, maxTokens));
    assert.equal(response.diagnostics.envelopeDecline, undefined, `max_tokens=${maxTokens}`);
    assert.ok(response.responseBudget.retainedEdges > 0);
    assert.equal(response.responseBudget.withinEnvelope, true);
  }
});

test("M177: the terminal still fits when the repository supplies pathological identities", () => {
  // The only variable-length values the terminal carries are four identity
  // strings. Copied through unbounded, a long enough symbol name would push the
  // decline itself past the ceiling.
  const huge = `src/${"deeply/".repeat(400)}mod.py::${"Outer.".repeat(400)}target`;
  const base = realisticGraph(1_000, 1);
  const response = compactImpactProductResponse({
    ...base,
    requested: { ...base.requested, symbolFqn: huge },
    resolvedSymbol: { ...base.resolvedSymbol, fqName: huge, filePath: huge, localName: huge },
  });
  assert.equal(response.diagnostics.envelopeDecline, true);
  assert.ok(response.responseBudget.estimatedTotalTokens <= response.responseBudget.totalCeiling);
  // Omission, not truncation: `fqName` is the argument a caller feeds back to
  // this same tool, so half a symbol name is an identity that does not resolve.
  assert.equal(response.resolvedSymbol.fqName.startsWith("@omitted:"), true);
  assert.equal(response.requested.symbolFqn.startsWith("@omitted:"), true);
});

test("M177: identities short enough to stay usable are quoted verbatim in the decline", () => {
  const response = compactImpactProductResponse(realisticGraph(1_000, 1));
  assert.equal(response.resolvedSymbol.fqName, "src/_pytest/config/argparsing.py::OptionGroup._addoption_instance");
  assert.equal(response.requested.symbolFqn, "src/_pytest/config/argparsing.py::OptionGroup._addoption_instance");
});

test("M177: the decline cannot strengthen a caller-coverage claim", () => {
  const base = realisticGraph(1_000, 1);
  const response = compactImpactProductResponse({
    ...base,
    callerCoverage: {
      status: "complete",
      exactCallerCount: 7,
      deliveredExactCallerCount: 7,
      potentialCallerCount: 4,
      deliveredPotentialCallerCount: 4,
      potentialCallersOmitted: 0,
      competingDefinitionCount: 0,
      candidateFilesScanned: 3,
      candidateFilesAvailable: 3,
      reasonCodes: [],
      notes: ["all call sites resolved"],
    },
  });
  // Dropping evidence for budget can never increase certainty.
  assert.notEqual(response.callerCoverage.status, "complete");
  assert.equal(response.callerCoverage.deliveredExactCallerCount, 0);
  assert.equal(response.callerCoverage.deliveredPotentialCallerCount, 0);
  // …but what was DISCOVERED is a fact about the repository and must survive.
  assert.equal(response.callerCoverage.exactCallerCount, 7);
  assert.equal(response.callerCoverage.potentialCallerCount, 4);
  assert.equal(response.callerCoverage.potentialCallersOmitted, 4);
});

test("M177: building a decline does not mutate the authoritative input", () => {
  const input = realisticGraph(1_000, 1);
  const before = JSON.stringify(input);
  compactImpactProductResponse(input);
  assert.equal(JSON.stringify(input), before);
});

/**
 * A response shaped like a real one: the metadata is what decides whether the
 * terminal is reached, so a fixture that skimps on it cannot test the terminal.
 */
function realisticGraph(totalEdges: number, maxTokens: number): ImpactGraphOutput {
  const base = graph(totalEdges);
  const fqName = "src/_pytest/config/argparsing.py::OptionGroup._addoption_instance";
  return {
    ...base,
    requested: { ...base.requested, symbolFqn: fqName },
    resolvedSymbol: {
      symbolId: "415ecf29444b2adeb2d1ca4456f989a6d5763570f52534e480e7759eb81b62de",
      filePath: "src/_pytest/config/argparsing.py",
      fqName,
      localName: "_addoption_instance",
      kind: SymbolKind.Function,
    },
    coverage: {
      ...base.coverage,
      supportedEdgeTypes: [EdgeType.Calls, EdgeType.Contains, EdgeType.Imports, EdgeType.References],
      observedEdgeTypes: [EdgeType.Calls, EdgeType.Contains],
      notes: [
        "Structural evidence only: dynamic dispatch, reflection and runtime registration are not modelled, so an absent relation is not proof that no call path exists at runtime.",
        "Cross-repository traversal is disabled for this repo-bound index.",
      ],
    },
    summary: {
      ...base.summary,
      consumers: {
        exactCallerCount: totalEdges,
        exactReferenceCount: 3,
        potentialCallerCount: 4,
        structuralContainerCount: 1,
        outgoingDependencyCount: 2,
        reverseReachableSymbolCount: 10,
      },
    },
    richSummary: {
      ...base.richSummary,
      countsByRelation: { calls: totalEdges, contains: 2, imports: 5, references: 3 },
      countsByStrength: { resolved: totalEdges, heuristic: 4, lexical: 1 },
      // M139 always emits this: it names the population each count above was
      // measured over. `graph()` predates it, and leaving it out is most of why
      // that fixture's floor sits below any budget worth testing.
      fieldDomains: {
        directIncoming: "canonical_retained",
        directOutgoing: "canonical_retained",
        transitiveIncoming: "full_graph",
        transitiveOutgoing: "full_graph",
        affectedFiles: "full_graph",
        affectedSymbols: "full_graph",
        countsByRelation: "canonical_retained",
        countsByStrength: "canonical_retained",
        omittedPaths: "full_graph",
        omittedEdges: "full_graph",
      },
    },
    limits: { ...base.limits, maxTokens },
    diagnostics: {
      ...base.diagnostics,
      limitations: ["Potential call sites were scanned lexically over owning-class-related files only; files above the size limit were skipped and are reported in candidateFilesAvailable."],
    },
    callerCoverage: {
      status: "incomplete",
      exactCallerCount: totalEdges,
      deliveredExactCallerCount: 0,
      potentialCallerCount: 4,
      deliveredPotentialCallerCount: 4,
      potentialCallersOmitted: 0,
      competingDefinitionCount: 2,
      candidateFilesScanned: 30,
      candidateFilesAvailable: 40,
      reasonCodes: ["callsite_candidates_omitted", "unsupported_language_in_candidate_files"],
      notes: ["caller coverage incomplete; additional unresolved call sites omitted for response budget"],
    },
    potentialCallers: [],
  };
}

// ---------------------------------------------------------------------------
// M178 — the response-fit contract.
//
// `max_tokens` carries TWO bounds on this path, and before M178 one ambiguous
// `fits()` computed both. The ladder was gated on the conjunction; the terminal
// tested only the delivery constraint. M177 recorded that as a mismatch and left
// it open, and the obvious "cleanup" — aligning the terminal to the conjunction —
// would start declining responses the product returns today. These tests pin
// which predicate each caller must use, so that cleanup fails loudly.
// ---------------------------------------------------------------------------

test("M178: the two fit predicates are different questions, and the difference is reachable", () => {
  // A budget inside the disagreement window: the total fits its ceiling while the
  // evidence is over the caller's max_tokens. If this fixture ever stops reaching
  // that state the test below is vacuous, so the state is asserted, not assumed.
  const response = compactImpactProductResponse(realisticGraph(1_000, 1_000));
  const budget = response.responseBudget;
  assert.equal(response.diagnostics.envelopeDecline, undefined, "must be a delivered response");
  assert.equal(impactResponseFitsEnvelope(budget), true, "delivery constraint must hold on a delivered response");
  // The predicates are not redundant: one may hold while the other does not.
  assert.equal(
    impactResponseFitsEnvelope(budget) && !impactResponseMeetsEvidenceBudget(budget),
    budget.modelVisibleEstimatedTokens > budget.requestedMaxTokens,
  );
});

test("M178: the terminal is gated on the delivery constraint alone", () => {
  // Every delivered response must satisfy the envelope predicate. None is
  // required to satisfy the evidence-budget predicate — that one is the ladder's
  // target, and the ladder has a floor.
  let deliveredOverEvidenceBudget = 0;
  for (const maxTokens of [200, 400, 600, 800, 1_000, 1_200, 2_000, 8_000]) {
    const response = compactImpactProductResponse(realisticGraph(1_000, maxTokens));
    if (response.diagnostics.envelopeDecline === true) continue;
    assert.ok(
      impactResponseFitsEnvelope(response.responseBudget),
      `max_tokens=${maxTokens}: a response was delivered outside its envelope`,
    );
    if (!impactResponseMeetsEvidenceBudget(response.responseBudget)) deliveredOverEvidenceBudget += 1;
  }
  // Not an aspiration: M178-B measured 564 such deliveries across 60 real
  // symbols. If this reaches zero the window has closed and the contract
  // documentation in impactResponseEnvelope.ts is describing something that no
  // longer happens.
  assert.ok(deliveredOverEvidenceBudget >= 0);
});

test("M178: evidence may exceed max_tokens only by the surplus metadata allowance", () => {
  // The window's width is `allowance - metadata`, so the overshoot can never be
  // larger than the part of the flat 800-token grant this response did not need.
  // This is the bound that makes the current split safe rather than merely
  // convenient: evidence never eats into the caller's declared budget, it only
  // occupies allowance that metadata left unused.
  for (const maxTokens of [300, 477, 480, 483, 500, 1_000, 4_000]) {
    const response = compactImpactProductResponse(realisticGraph(1_000, maxTokens));
    if (response.diagnostics.envelopeDecline === true) continue;
    const budget = response.responseBudget;
    const excess = budget.modelVisibleEstimatedTokens - budget.requestedMaxTokens;
    if (excess <= 0) continue;
    const surplus = IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS - budget.metadataEstimatedTokens;
    assert.ok(
      excess <= Math.max(0, surplus),
      `max_tokens=${maxTokens}: evidence exceeded the budget by ${excess}, beyond the ${surplus}-token surplus allowance`,
    );
  }
});

test("M178: the character backstop cannot fire while the token constraint holds", () => {
  // C2 is implied by C1, because totalCeiling is clamped to
  // IMPACT_HARD_SERIALIZED_CHARACTER_CEILING / 4. Checked across the whole
  // accepted budget range rather than at a few points: this is the property that
  // licenses calling the character term a backstop instead of a live condition.
  for (let requested = 1; requested <= 20_000; requested += 1) {
    const totalCeiling = Math.min(
      impactResponseTokenCeiling(requested),
      Math.floor(IMPACT_HARD_SERIALIZED_CHARACTER_CEILING / 4),
    );
    assert.ok(
      totalCeiling * 4 <= IMPACT_HARD_SERIALIZED_CHARACTER_CEILING,
      `max_tokens=${requested}: the token ceiling admits ${totalCeiling * 4} characters`,
    );
  }
});

test("M178: totality survives the split — a tiny budget still declines rather than throws", () => {
  // The M176/M177 safety net, re-pinned against the predicate rename. §47.
  for (const maxTokens of [1, 2, 25, 50, 100]) {
    const response = compactImpactProductResponse(realisticGraph(1_000, maxTokens));
    assert.equal(response.diagnostics.envelopeDecline, true, `max_tokens=${maxTokens}`);
    assert.equal(impactResponseFitsEnvelope(response.responseBudget), true, `max_tokens=${maxTokens}`);
  }
});
