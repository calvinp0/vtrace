import assert from "node:assert/strict";
import { test } from "bun:test";

import { EdgeType, SymbolKind } from "../domain/types";
import type { ImpactEdge, ImpactGraphOutput, ImpactNode } from "./getImpactGraph";
import {
  IMPACT_HARD_SERIALIZED_CHARACTER_CEILING,
  compactImpactProductResponse,
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
