# Stage 5 — M131 flow scalability profile

Verdict: **PASS**

## Old vs new traversal architecture

| | M130 | M131 |
| --- | --- | --- |
| graph acquisition | `listAllSymbols` + `listAllEdges`, whole tables | batched adjacency per frontier level |
| relation filter | every persisted edge | only edges the frontier reached |
| cost driver | repository graph size | explored subgraph |
| `maxEdges` | traversal budget (M130 fix) | traversal budget, shared across both directions |
| budget exhaustion | reported | reported, with per-traversal counters |

## ARC — direct one-edge flow

- repository: `/home/calvin/code/ARC` @ `1202705be46edf01c84bfb89e3fa94f76f7ae15e` (arcbench), read-only
- protocol: warm, 3 warm-ups, 15 measured repetitions, median, single process
- total graph edges: 18862
- edges fetched: 4
- edges relaxed: 4
- nodes expanded: 2
- frontier batches: 2
- DB queries: 3
- warm median: **6.606 ms** (M130 baseline 82.851 ms, 12.542x)
- warm p90: 8.88 ms

## Synthetic scaling — same short path, growing graph

| total edges | edges fetched | edges relaxed | nodes expanded | frontier batches | DB queries | warm median (ms) | result |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2000 | 2 | 2 | 2 | 2 | 2 | 0.088 | 1 edge, calls |
| 20000 | 2 | 2 | 2 | 2 | 2 | 0.182 | 1 edge, calls |
| 100000 | 2 | 2 | 2 | 2 | 2 | 0.798 | 1 edge, calls |

Graph grows 50x; explored work grows 1x.
This is not a claim of O(1): it is the claim that unrelated graph size does not dominate a short-path search.

## SQL access pattern

```sql
SELECT id, src_symbol_id, dst_symbol_id, edge_type, confidence
FROM edges WHERE src_symbol_id IN (?, ?, …) ORDER BY id ASC   -- forward frontier
SELECT … FROM edges WHERE dst_symbol_id IN (?, ?, …) ORDER BY id ASC   -- reverse frontier
```

- `src_symbol_id`: SEARCH edges USING INDEX idx_edges_src_symbol_id (src_symbol_id=?)
- `dst_symbol_id`: SEARCH edges USING INDEX idx_edges_dst_symbol_id (dst_symbol_id=?)
- `edge_call_sites`: SEARCH edge_call_sites USING INDEX sqlite_autoindex_edge_call_sites_1 (edge_id=?)

Indexes used: idx_edges_src_symbol_id, idx_edges_dst_symbol_id, sqlite_autoindex_edge_call_sites_1. New indexes added: none.
The frontier is chunked at 500 ids per statement so one prepared-statement shape is reused across levels; a chunk is still a batch, never a per-node query.

## Why the previous tests could not catch this class of failure

- **Repository-size dimension.** Every flow fixture was a repository smaller than the bound that caused the defect. More syntax fixtures would never have crossed it. The suite now builds graphs at 2k / 20k / 100k edges and asserts the answer does not move.
- **Storage-order dimension.** The defect was ultimately a dependence on SQLite row order. Order is now an explicit test input: five insertion orders must produce one semantic hash.
- **Whole-response dimension.** M130's envelope was proven against a single captured payload. It is now asserted across items, source size, diagnostics, flow hops, impact records and document excerpts — which found two real gaps M130's shape had hidden.
- **Metamorphic invariants beat examples.** "Unrelated growth must not change the answer" and "a bound that bites must be reported as a bound" are properties. Examples only sample them.
