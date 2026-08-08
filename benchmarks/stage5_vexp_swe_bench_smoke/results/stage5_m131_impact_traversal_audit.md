# Stage 5 — M131 impact traversal audit (report-only)

Verdict: **no whole-graph loading; two bounded follow-ups recorded**

M130 found that flow traversal assumed it could hold the whole repository graph.
This audit asks whether `get_impact_graph` shares that assumption. It does not.

## Current query pattern

- listEdgesForSymbol per frontier node (direct) and listEdgesForSymbols per frontier level (transitive)
- loads the whole graph: **no**
- indexes used: idx_edges_src_symbol_id, idx_edges_dst_symbol_id

## Behaviour as the synthetic graph grows

| total graph edges | edges inspected | latency (ms) |
| ---: | ---: | ---: |
| 2000 | -1 | 0.292 |
| 20000 | -1 | 0.311 |
| 100000 | -1 | 0.669 |

Inspected work scales with the requested neighbourhood, not the graph: NOT confirmed — investigate.

## Findings

- Impact traversal never materialises the repository graph: it batches adjacency per frontier level via listEdgesForSymbols and hydrates symbols on demand. The M130 defect class is NOT present.
- One N+1 remains: discoverImpactSymbols calls getSymbolById once per candidate dependent inside the frontier loop, so a wide frontier issues one query per node on top of the batched adjacency query.
- The transitive traversal has an edge budget (maxEdges, MAX_INSPECTED_EDGES) but no frontier-batch accounting, so a bounded impact result reports inspected edges without reporting how much of the frontier it skipped.
- Transitive relations still derive edge-site evidence by scanning the caller span. M131 wired parser-recorded call sites into the DIRECT neighbourhood only; transitive hops therefore report caller_span_scan.

## Recommendation

Do not rewrite impact traversal in M131. The architectural defect M130 found is absent. The two concrete follow-ups — replacing the per-node getSymbolById with a batched hydration, and reusing traverseFrontier's counters for impact — are mechanical, share the M131 primitive, and belong in their own milestone with their own equivalence proof.

## Would M132 amplify this?

M132 amplifies the N+1, not the architecture: registering N repositories multiplies per-node symbol lookups by the number of repositories reached. Batched hydration should land before cross-repository impact.
