// Shared, pure mapping from a structural impact graph onto the Capsule v2 digest
// impact seam. Both the run_pipeline orchestrator (M56) and the Stage 5 live
// injection bridge (M56B) project impact into the digest the same way, so this is
// the single conversion point — keeping the rendered `→ impact` block identical
// across the MCP and Stage 5 surfaces.
//
// It is pure: an `ImpactGraphOutput` in, a bounded seam out — no DB, no IO, no
// clock. The caller decides WHICH symbol's graph to map and WHEN impact applies;
// this only does the projection (counts + bounded representative dependents).

import type { CapsuleV2DigestImpactItem, CapsuleV2DigestImpactSeam } from "../capsuleV2/productAdapter";
import type { ImpactGraphOutput } from "./getImpactGraph";

// How many representative dependent rows the seam carries. The digest renderer caps
// what it spells out too; this bounds the structured seam at the source.
const MAX_IMPACT_REPRESENTATIVE = 3;

/**
 * Project a resolved impact graph onto the digest impact seam. Representative rows
 * carry REAL graph dependent identities (path + local name); a `snippet` is
 * attached only when the graph already loaded a source excerpt for that node, so
 * `snippetsAvailable` is honest and a missing snippet records
 * `snippetUnavailableReason` rather than inventing a body.
 */
export function impactGraphToDigestSeam(graph: ImpactGraphOutput): CapsuleV2DigestImpactSeam {
  const dependentNodes = graph.nodes.filter((node) => node.distance > 0);
  let snippetsAvailable = false;
  const representative: CapsuleV2DigestImpactItem[] = [];
  for (const node of dependentNodes.slice(0, MAX_IMPACT_REPRESENTATIVE)) {
    const excerpt = node.sourceExcerpt ?? null;
    if (excerpt) {
      snippetsAvailable = true;
      representative.push({
        role: "dependent",
        path: node.filePath,
        symbol: node.localName,
        lineStart: excerpt.startLine,
        lineEnd: excerpt.endLine,
        snippet: excerpt.text,
      });
    } else {
      representative.push({
        role: "dependent",
        path: node.filePath,
        symbol: node.localName,
        snippetUnavailableReason: "edge_source_spans_not_extracted",
      });
    }
  }
  return {
    dependentCount: graph.summary.dependentSymbolCount,
    crossFileDependentCount: graph.summary.dependentFileCount,
    snippetsAvailable,
    available: true,
    representative,
  };
}
