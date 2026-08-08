# Stage 5 — M131 flow scalability plan

Starting commit: `f0dc8b1` (M130, PASS) · branch `main`

## The problem M131 exists to remove

M130 fixed two discovered failures. Neither was a coding slip; both were
**architectural conditions** that made the failure inevitable at some size, and
invisible below it:

| condition | symptom in M130 | what makes it reappear |
| --- | --- | --- |
| flow materialised the whole repository graph, then bounded the search by truncating it | ARC's real `calls` edge sat at position 6,891 of 19,404 and was discarded before the search | any repository above the bound; workspace/multi-repo multiplies it |
| the response envelope was proven against one captured payload | a 6,000-token request returned 87,146 characters | any response shape the incident did not happen to have |

The rule M131 works to: **the cost of answering must track the subgraph the
question explores, and every whole-system invariant must be asserted as a
property, not sampled by one example.**

## Workstreams

### A — indexed bounded frontier traversal

Replace `listAllSymbols` + `listAllEdges` + repository-wide adjacency with
level-synchronous frontier expansion over batched indexed queries.

- new `src/graph/frontierTraversal.ts`: policy-free, typed, budget-accounted BFS.
  Direction, allowed edge types, filtering and ordering stay with the caller, so
  flow and impact can share mechanics without sharing semantics.
- new directional batch queries `listOutgoingEdgesForSymbols` /
  `listIncomingEdgesForSymbols`, chunked at 500 ids per statement. A chunk is
  still a batch; there is no per-node query.
- symbol records hydrate in batches as edges surface them, memoized per query.
- `maxEdges` becomes a budget **shared across both traversal directions**, so it
  means "edges this query may relax", not "edges each half may relax".
- `callFlowEvidenceAvailable` and `edgesAvailable` are answered with a `LIMIT 1`
  existence probe and a `COUNT`, not by loading the graph.

Semantics deliberately preserved: exact-FQN endpoint resolution, forward
direction, shortest-path-only enumeration, the same relation filter, the same
deterministic edge and path ordering.

Early termination is safe because the search is level-synchronous: a level is
either fully relaxed or the budget stopped it and said so, and every node closer
to the start than the target already has its final distance and full adjacency.

### B — exact edge-site provenance

Record what the parser actually saw instead of rescanning the caller's body.

- additive `edge_call_sites` table (edge id, ordinal, start/end line and column,
  precision). Purely additive: a pre-M131 index has no rows, and a read-only
  consumer that cannot migrate must still answer.
- Python, TypeScript and Cython call extractors emit occurrences. Python and
  TypeScript give exact spans; Cython gives exact lines (`precision: "line"`).
- flow fetches occurrences only for edges that reached a returned path.
- three distinguishable states, and the product never conflates them:
  `edge_site` (recorded), `caller_span_scan` (located by scanning, honestly
  labelled), `source_symbol_span` (nothing located).

### C — type safety

- remove `@ts-nocheck` from `searchLogicFlow.ts` (hard requirement).
- extract the M130 budget rule into a typed module rather than attempting a
  9,400-line historic cleanup of `tools.ts`.

### D — response envelope

Extend the ladder only where the scale tests prove a real gap; do not restructure
a working implementation in the same milestone that changes its behaviour, because
the byte-equivalence proof that would make a refactor safe is impossible while
behaviour moves.

## Test strategy — the part that generalises

More syntax fixtures would never have found M130's defect. The missing inputs
were **dimensions**, not examples:

| dimension | asserted as | why examples missed it |
| --- | --- | --- |
| repository size | 2k / 20k / 100k edge fixtures, same short path | every fixture was below the bound |
| storage order | five insertion orders → one semantic hash | row order was an accidental input nobody varied |
| budget pressure | a frontier that genuinely outgrows its budget | budgets never bit in small fixtures |
| whole response | items, source size, diagnostics, flow hops, impact records, documents | assertions were per-field |

The metamorphic form matters: *"unrelated growth must not change the answer"* and
*"a bound that bites must be reported as a bound"* are properties. An example
only samples them.

## Explicitly out of scope

Workspace registry, multi-repository retrieval, cross-repository edges, OpenAPI
linking, shared-type inference, environment-variable lineage, new parsers, LSP
edge submission, persistent result caching, live agents, Docker, VEXP, paid APIs.
Retrieval ranking and Capsule packing are not touched; the frozen 50 and the
retrieval evals prove it.
