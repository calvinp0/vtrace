# Stage 5 — M130 flow root cause

Verdict: **PASS**

- Starting commit: `1678871643c34e184e0fc9f5009a14ed4b7799ee` (M129, PASS)
- Branch: `main`
- ARC checkout: `arcbench` @ `1202705be46edf01c84bfb89e3fa94f76f7ae15e` (read-only, isolated index copy)

## 1. Reproduction

```text
get_code_context(
  task: "How does reorder_p_label_map choose among candidate backbone maps when it
         calls map_two_species, ...",
  auto_refresh: "if_stale",
  preset: "debug",
  max_tokens: 6000
)
→ flow.included: false
  flow.skipReason: endpoints_not_connected
```

The source contains a direct call inside `reorder_p_label_map`:

```text
file:    arc/mapping/engine.py
caller:  arc/mapping/engine.py::reorder_p_label_map   (lines 1702-1732)
callee:  arc/mapping/engine.py::map_two_species       (lines 32-137)
site:    arc/mapping/engine.py:1724
         atom_map_1 = map_two_species(template_product, actual_products[arc_mol_num])
```

Both endpoints resolve to exactly one indexed symbol each; neither name is ambiguous.

## 2. Where the relationship was lost

Traced through every stage:

| stage | result |
| --- | --- |
| source AST | call present |
| Python call extraction | `calls` edge produced (`same_file_or_same_class_call_resolution`) |
| enclosing caller ownership | correct — owned by `reorder_p_label_map`, not the module |
| bare-name callee resolution | correct — same-module top-level match |
| persisted call edge | **present** in `edges` (`edge_type=calls`, `confidence=1`) |
| endpoint lookup | both FQNs resolve, exactly one match each |
| **graph traversal** | **relationship lost here** |
| flow result rendering | faithfully rendered a result that was already wrong |

Extraction and persistence were never at fault. Parsing `arc/mapping/engine.py`
in isolation yields the edge, and the shipped ARC index contains the row.

## 3. Root cause

`searchLogicFlow` built its traversal graph from a **prefix of the repository's
edge list**:

```ts
const filteredEdges = filterFlowEdges(db, listAllEdges(db), ...);
const boundedEdges  = filteredEdges.slice(0, maxEdges);   // maxEdges defaults to 2000
const graph         = buildGraph(boundedEdges, symbolsById);
```

`maxEdges` was documented as "maximum number of persisted edges inspected", but it
did not bound *work* — it bounded **which edges existed** for the search, in
arbitrary repository order.

Measured on the ARC index:

```text
persisted edges (all types):                19,404
target edge position in repository order:    6,891
edges retained by the pre-fix slice:         2,000
```

The `reorder_p_label_map → map_two_species` edge sat at position 6,891 and was
discarded before the search began. Roughly 90% of ARC's graph was invisible to
every flow query.

**The general rule:** this is a size-dependent correctness defect. Any repository
with more than 2,000 edges silently lost real relationships, and the arbitrary
cutoff was then reported as a clean negative — `endpoints_not_connected`, a claim
static analysis cannot support even when the graph *is* complete.

## 4. Fix

1. **The graph is the whole filtered edge set.** The pre-slice is gone.
2. **`maxEdges` became a traversal budget.** It counts edges actually relaxed by
   the breadth-first search. Default raised from 2,000 to 20,000 (hard ceiling
   200,000).
3. **Exhausting the budget is reported, not hidden.** `summary.traversalLimitReached`
   and `diagnostics.{edgesAvailable,edgesInspected,traversalLimitReached}` make a
   bounded search legible, and the product maps it to the distinct reason
   `traversal_limit_reached`.
4. **No ARC-specific rule was added.** Nothing in the fix mentions ARC, Python
   call shapes, or these symbols.

## 5. Negative-result semantics

`endpoints_not_connected` was removed. Static analysis over one index cannot prove
two symbols are unconnected — dynamic dispatch, reflection, unindexed languages
and stale snapshots all hide real relationships. Every replacement states a fact
about the *search*:

| reason | means |
| --- | --- |
| `start_endpoint_not_found` | the start name matched no indexed symbol |
| `end_endpoint_not_found` | the end name matched no indexed symbol |
| `endpoint_ambiguous` | a name matched several symbols; no arbitrary pick was made |
| `index_stale` | the index is not fresh, so absence carries no information |
| `unsupported_language` | an endpoint's language has no call-edge extraction |
| `no_indexed_path_found` | both endpoints resolved; this index holds no path |
| `traversal_limit_reached` | the bounded search ran out of budget |
| `not_enough_endpoints` / `ambiguous_endpoints` | the query named fewer/more than two candidates |

Each negative result now carries its scope:

```json
{
  "included": false,
  "reason": "no_indexed_path_found",
  "claimScope": "current_index",
  "endpointsResolved": true,
  "verificationRecommended": true
}
```

## 6. Call-site evidence

The excerpt attached to a flow step was a head window of the caller. For a
31-line caller with a 12-line budget, that window ended at line 1713 — eleven
lines short of the call at 1724. An agent was told the call existed and shown
source that did not contain it.

`buildSymbolSourceExcerpt` now accepts the resolved callee name (already present
in the edge's own relation evidence) and centres the window on the first line
inside the symbol's span where that name appears as a call. The honesty contract
holds: `edge_site` is emitted only when the occurrence was actually located, and
the excerpt degrades to a head window otherwise rather than guessing.

```text
before: arc/mapping/engine.py:1702-1713  reason=fallback_symbol_window  (no call site)
after:  arc/mapping/engine.py:1719-1730  reason=edge_site               (call site included)
```

## 7. Acceptance

```text
endpoints resolved exactly:        1/1 and 1/1 matches
direct calls edge persisted:       true
flow.included:                     true
path length:                       1 edge
edge type:                         calls
relation strength:                 exact
resolution method:                 same_file_or_same_class_call_resolution
call site inside excerpt:          true (1719-1730 covers 1724)
traversal limit reached:           false (1,506 of 19,404 edges relaxed)
full vs incremental agreement:     equivalent (src/logicFlow/directCallFlow.test.ts)
ARC repository modified:           no
ARC in-place VTRACE state touched: no
```

## 8. Regression coverage

`src/logicFlow/directCallFlow.test.ts` pins the general rule, not the incident:

- same-module bare call; callee defined before and after the caller
- imported, aliased (`import target as alias`) and module-qualified (`module.target()`) calls
- duplicate short names across modules — the caller connects to its own module's
  definition and never to the same-named symbol elsewhere
- ambiguous short names produce an explicit diagnostic instead of a silent pick
- nested scopes — calls are owned by the enclosing method, and a sibling function
  that never calls the target has no edge
- traversal budget bounds work, not membership; a starved budget reports
  `traversalLimitReached` instead of a clean negative
- full index, incremental refresh and no-op refresh agree on the edge and the flow
- the call-site excerpt covers the call in a caller longer than the excerpt budget

`src/runPipeline/negativeFlowReasons.test.ts` pins the reason vocabulary and the
claim scope.

## 9. Known limitations

- Call-edge extraction remains conservative and Python/TypeScript/Cython only.
  Dynamic dispatch, reflection and injected dependencies are still unresolved,
  and `unsupported_language` now says so rather than implying absence.
- `edge_site` anchoring finds the *first* call occurrence in the caller's span.
  A caller invoking the same callee several times anchors on the first.
- The traversal loads all symbols and edges into memory once per query
  (~290 ms on ARC's 19,404 edges). Adjacency is not yet queried incrementally
  from SQLite; that is a performance question, not a correctness one.
