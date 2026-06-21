import assert from "node:assert/strict";
import { test } from "bun:test";

import { impactGraphToDigestSeam } from "./impactDigestSeam";
import type { ImpactGraphOutput, ImpactNode } from "./getImpactGraph";

function node(overrides: Partial<ImpactNode>): ImpactNode {
  return {
    symbolId: "s",
    filePath: "src/x.ts",
    fqName: "x",
    localName: "x",
    kind: "function" as ImpactNode["kind"],
    distance: 1,
    ...overrides,
  };
}

function graph(nodes: ImpactNode[], summary: Partial<ImpactGraphOutput["summary"]> = {}): ImpactGraphOutput {
  return {
    requested: { symbolFqn: "focal", depth: 2, crossRepo: false, format: "list" },
    resolvedSymbol: { symbolId: "f", filePath: "src/f.ts", fqName: "focal", localName: "focal", kind: "function" as ImpactNode["kind"] },
    coverage: { analysisKind: "structural", resolutionMode: "exact_fqn", crossRepo: false, supportedEdgeTypes: [], observedEdgeTypes: [], notes: [] },
    summary: { dependentSymbolCount: nodes.filter((n) => n.distance > 0).length, dependentFileCount: 1, maxDepth: 2, maxObservedDistance: 1, ...summary },
    dependentFiles: [],
    nodes: [node({ symbolId: "f", fqName: "focal", localName: "focal", distance: 0 }), ...nodes],
    edges: [],
    view: { format: "list", lines: [] },
  };
}

test("impactGraphToDigestSeam maps counts and excludes the focal root node", () => {
  const seam = impactGraphToDigestSeam(graph(
    [node({ filePath: "src/a.ts", localName: "a" }), node({ filePath: "src/b.ts", localName: "b" })],
    { dependentSymbolCount: 2, dependentFileCount: 2 },
  ));
  assert.equal(seam.dependentCount, 2);
  assert.equal(seam.crossFileDependentCount, 2);
  assert.equal(seam.available, true);
  // Focal (distance 0) is never a representative row.
  assert.equal(seam.representative?.length, 2);
  assert.equal(seam.representative?.every((r) => r.role === "dependent"), true);
});

test("impactGraphToDigestSeam is honest about missing snippets", () => {
  const seam = impactGraphToDigestSeam(graph([node({ filePath: "src/a.ts", localName: "a" })]));
  assert.equal(seam.snippetsAvailable, false);
  assert.equal(seam.representative?.[0]?.snippet, undefined);
  assert.equal(seam.representative?.[0]?.snippetUnavailableReason, "edge_source_spans_not_extracted");
});

test("impactGraphToDigestSeam folds real source excerpts when present", () => {
  const seam = impactGraphToDigestSeam(graph([
    node({
      filePath: "src/a.ts",
      localName: "callA",
      sourceExcerpt: { filePath: "src/a.ts", startLine: 10, endLine: 12, text: "callA()", reason: "edge_site", truncated: false },
    }),
  ]));
  assert.equal(seam.snippetsAvailable, true);
  assert.equal(seam.representative?.[0]?.lineStart, 10);
  assert.equal(seam.representative?.[0]?.lineEnd, 12);
  assert.equal(seam.representative?.[0]?.snippet, "callA()");
});

test("impactGraphToDigestSeam caps representative rows at 3", () => {
  const seam = impactGraphToDigestSeam(graph(
    Array.from({ length: 6 }, (_unused, i) => node({ filePath: `src/d${i}.ts`, localName: `d${i}` })),
    { dependentSymbolCount: 6, dependentFileCount: 6 },
  ));
  // Header count reports the true total; representative preview is bounded.
  assert.equal(seam.dependentCount, 6);
  assert.equal(seam.representative?.length, 3);
});
