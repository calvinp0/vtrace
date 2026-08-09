# M133 — Impact Graph Response Boundedness and Delivery Integrity

## Verdict

**PASS.** Starting state was `bb65f09` on `main` (M132 functional state
`9260d37`). Functional commit: `a004529` (`Bound impact graph product
responses`). This report/ledger commit is recorded separately.

M133 did not implement benchmark provenance, query-semantic ranking changes, or
workspace aggregation. The next milestone is M134, Retrieval Benchmark
Provenance and Historical Attribution.

## Headline incident result

| field | before chars | after chars |
| --- | ---: | ---: |
| edges | 743,698 | 1,113 |
| nodes | 418,353 | 930 |
| view | 205,948 | 345 |
| directRelations | 4,018 | 1,790 |
| complete | 1,385,362 | 6,689 |
| estimated tokens | ~346,341 | 1,673 |

| contract | value |
| --- | ---: |
| requested max_edges | 10 |
| retained unique edges | 3 |
| requested model-facing tokens | 1,200 |
| final model-facing estimate | 1,059 |
| complete token ceiling | 2,000 |
| complete serialized characters | 6,689 |
| within envelope | true |

The 2,000-token complete ceiling was established empirically: the stable root,
provenance, omission and accounting schema needs roughly 700 metadata tokens.
The rule is `max_tokens + max(800, 15%)`, with an additional 80,000-character
absolute guard. The real incident remains below the preferred 8,000-character
acceptance target.

## Root cause and old limit placement

`get_impact_graph` had two independent representations. The rich path selected
`directRelations.slice(0, maxEdges)` and token-bounded ranked paths. Separately,
the legacy reverse path called `discoverImpactSymbols` without any requested
edge/token budget, hydrated every reachable node, rebuilt all shortest-layer
edges, and rendered all nodes/edges into `view`. MCP then appended accounting
and returned the object without measuring the final JSON. Thus directRelations
was bounded while edges/nodes/view scaled with the repository graph.

Before M133:

- `max_depth`: reverse discovery and rich traversal depth.
- `max_paths`: rich path selection only.
- `max_edges`: rich direct-relation slice and rich traversal inspection only.
- `max_tokens`: rich path evidence only.
- complete serialized result: no gate.

## Canonical impact representation

The reverse engine now retains at most the requested canonical edge budget
before node excerpt loading or rendering. Nodes are endpoints of retained edges
plus the root. The delivery compactor then selects direct evidence first,
projects missing direct outgoing edges into the same canonical edge set, derives
all endpoint nodes, filters paths by canonical IDs/depth/count, and renders view
from those nodes/edges. Large source excerpts are removed from node projections;
compact edge-site evidence remains in directRelations.

`max_edges` now means maximum unique canonical impact edges delivered across
projections. Traversal/examination may be larger and is separately reported.
The ARC case examined/candidated more evidence, retained three high-value unique
edges, and reports 41 omitted edges. Bounded/truncated is never presented as an
exhaustive no-impact result.

## Complete-response enforcement

MCP and CLI both call the typed `compactImpactProductResponse` after accounting
is attached. Its deterministic ladder removes duplicate source bodies,
secondary paths/classifications, verbose coverage/diagnostics/accounting, and
lower-value transitive compatibility edges before direct callers. It repeatedly
measures the complete valid JSON. It never substrings JSON.

For context products, the existing `compactProductResponse` and
`remeasureResponseBudget` now have a final invariant: successful return implies
`within_envelope:true`. A new final metadata tier drops redundant item rows and
diagnostic/accounting detail while retaining modelVisibleContext. If that cannot
fit, it returns an explicit `resolved:false` bounded degradation; it never ships
an oversized success.

## ARC correctness acceptance

ARC was read-only on branch `arcbench`, HEAD `1202705b`; the 19,404-edge index
was copied to `/tmp` and only the copy was opened by VTRACE. Direct source search
confirmed:

- `arc/species/vectors.py:253`
- `arc/species/vectors_test.py:84,88,92,98,101`

The bounded result retains all six lines with their existing resolution methods.
Every serialized edge endpoint has one node. No node contains a repeated source
body. Impact analysis semantics and the M132 module-qualified caller fix remain
intact.

The M131/M132 flow acceptance also remains exact:
`reorder_p_label_map → map_two_species` returns one `calls` edge at
`engine.py:1724`, with `edge_site` provenance, 11/19,404 edges fetched, three DB
queries, and no traversal-budget exhaustion.

## Scale, matrix, determinism and duplication

Permanent whole-object tests cover 100, 1,000, 10,000 and 100,000 candidate
edges under `max_edges=10/max_tokens=1200`; final size spread is under 64
characters and every result stays below 8,000 characters. A 10,000-dependent
fanout retains only canonical endpoints. Deep/path fixtures prove that depth,
path and edge IDs cannot leak via another field.

Representative limits cover edges `1/3/10/50`, tokens `400/800/1200/3000`,
paths `1/3/10`, and depths `1/3/5`. Repeated construction is deterministic;
timing is excluded from semantic comparisons. A duplicate scanner fixture puts
the same large source-like string in a node and coverage; neither copy survives,
while compact provenance does.

## get_code_context incident

The observed before state was 4,213 estimated tokens against a 4,000 ceiling,
with `within_envelope:false`. Root cause: post-construction metadata could exhaust
the existing ladder; the measurement was honest but the handler still returned
the oversized successful product.

The real ARC 3,000-token acceptance now returns:

- model-visible: 9,466 chars / 2,367 estimated tokens
- metadata: 1,625 estimated tokens
- complete: 15,966 chars / 3,992 estimated tokens
- ceiling: 4,000
- `resolved:true`, `within_envelope:true`

The model-visible context was retained; redundant item metadata was removed.

## Other bounded tools

`get_context_capsule` and `run_pipeline` already call the shared product
compactor after accounting. `get_code_context` additionally remeasures after its
freshness/timing mutation. `search_logic_flow` has bounded path evidence and
frontier work but no general whole-object accounting block; `get_skeleton` has
bounded structural detail but no declared max_tokens. No catastrophic leak was
observed in either, and M133 did not alter their semantics. A shared thin final
guard remains a follow-up; product-specific compactors should remain separate.

## Retrieval and TCKDB preservation

Same-checkout M132 (`9260d37`) versus M133 runs were byte-identical:

- Django expanded 20 CSV SHA-256:
  `52fd65c971d5274ce088723556a29a00dd699113d67470502c2330d3e2fdba33`
- Cross-repo 30 CSV SHA-256:
  `089dc81dcb79767888a7ac8038e5706bea0060aba64b33d010e4b3cd32baa845`
- semantic retrieval differences: 0/50

This does not claim historical benchmark provenance was repaired; that is M134.

TCKDB was opened read-only on branch `fix/kinetics-deterministic-order`, HEAD
`9ed823e`. M132/M133 selected files, lead, roles, content modes, rendered context
and accounting were identical. Lead remained
`clients/python/tests/test_computed_reaction_upload_builder.py`; rendered context
SHA-256 was `5c210454b1facc1e317a759f6059324f793841eb23d1f549179b64d1584c55f8`.

## Performance and memory

ARC impact analysis plus final delivery completed in single-digit milliseconds
for traversal in the warm acceptance; flow took 7.1 ms total. The principal
memory improvement occurs before rendering: the new engine object was 26,002
characters instead of the 1.385 MB incident. The final gate reduced it to 6,689
characters. The final guard is therefore defense in depth, not the first bound.
M132 hydration batching remains pinned at at most 73 queries in its wide fixture.

## Verification and safety

- `bun run typecheck`: pass
- `bun run typecheck:benchmarks`: pass
- `bun test`: 3,883 tests across 239 files; 3,834 pass, 49 skip, 0 fail
- `git diff --check`: pass
- 100k-edge, fanout, limit matrix, duplicate, ARC, flow, paired retrieval and
  TCKDB acceptances: pass
- live agents, paid APIs, Docker and VEXP: not run
- ARC/TCKDB source and in-place `.vtrace`: not modified

All substantial new impact-envelope logic is in a typed module. No new
`@ts-nocheck` was added; `tools.ts` integration is a thin call.

## Why the previous test suite could not catch this

Impact resolution correctness and individual rich-field caps were tested, but
no scale test asserted on `JSON.stringify(completeImpactResponse)`. The legacy
edges/nodes/view path could therefore grow independently while directRelations
looked correct. Permanent principle: every bounded MCP product needs a final
whole-object assertion at realistic scale, after all metadata is attached.

## Known limitations and next milestone

The chars/4 estimator is approximate. Debug detail is bounded but may compact
more aggressively. Search-flow/skeleton final guard convergence remains a
follow-up. Retrieval contrast/negation and short identifier/stopword collisions
are deliberately deferred to M135. Workspace/repository aggregation remains
deferred to M136.

Proceed next to **M134 — Retrieval Benchmark Provenance and Historical
Attribution**.
