# Stage 5 M126 Hybrid Retrieval Core Profiling and Optimization

## Summary

- Baseline exact-TCKDB warm median: 7,528.372 ms; p90: 7,580.136 ms.
- Dominant pre-change stages: broad symbol admission (about 4.45 seconds) and
  co-edit cross-file graph queries (about 2.48 seconds).
- Optimizations: equivalent single-scan broad admission with repeated-group
  memoization; indexed directional edge queries; batched symbol materialization;
  request-local directory and broad-admission reuse.
- Semantic equivalence: byte-identical full results for all 50 frozen cases and
  the exact TCKDB inner Capsule; zero selected-file, lead, role, content-mode,
  rendered-context, token, or rescue differences.
- Final exact-TCKDB authoritative warm median: 869.280 ms; p90: 872.812 ms.
- Verdict: **PASS**.
- Recommendation: **promote optimized hybrid core**.

## Pre-change Architecture

`buildCapsuleV2` shapes the task and intent, calls `hybridRetrieve`, refines
roles, performs bounded graph/co-edit/file-evidence expansion, loads selected
content, and packs the capsule. `hybridRetrieve` unions plain-SQL lexical
results, shaped symbol/path results, test-to-implementation results,
body-literal FTS, and bounded graph/same-module expansion. `assemble` computes
BM25, centrality, score components, hub/actionability penalties, and the final
stable order.

One `Database` connection is supplied and reused. Pre-change graph edges were
batch-loaded by frontier, but symbols were materialized individually and
same-module directories were requeried per seed. Broad search expanded a
17-term TCKDB query into 152 disjuncts, each containing five
`lower(field) LIKE '%…%'` predicates. The final co-edit query joined the whole
edge table and then filtered an OR over source/destination file paths.

Candidate symbols merge early by ID. File deduplication, role assignment, and
packing occur later. Full source reads are synchronous and freshness-checked by
`loadSymbolSource`; they were not dominant on the exact task.

## Measurement Method

Direct-function timings use one read-only SQLite handle and exclude process
startup, index refresh, and product transport. CLI/MCP timing was not substituted
for core timing. The exact TCKDB query and isolated M125 index were used against
source HEAD `70ff50381f42551a825d75874ea2d70f6dbe08ec`.

Cold baseline replay ran pristine pre-M126 `HEAD` from a temporary `git archive`,
not a feature branch/worktree. Warm measurements used five uncached calls in one
process. Different and similar-term tasks were measured separately. The 20+30
frozen suites ran through `buildAuthoritativeProductRetrieval`, including lazy
routed rescue.

The profiler is request-local and opt-in. Stable outputs omit it. It records no
SQL parameters or source bodies. Timings include every expensive stage; same-task
result caching does not exist.

## Stage Profile

Exact TCKDB pre-change:

| Stage | Time |
| --- | ---: |
| Hybrid retrieval | 4,740–5,001 ms |
| Broad lexical symbol search | 4,447–4,573 ms |
| Graph expansion | 172–198 ms |
| Scoring/sort/cap | 7–10 ms |
| Post-hybrid co-edit expansion | about 2,484 ms |
| Full Capsule wall | 7,360–7,580 ms |

Exact TCKDB optimized representative:

| Stage | Time |
| --- | ---: |
| Request preparation/task derivation | included; sub-millisecond outside localization |
| Lexical symbol search | 481.874 ms |
| Symbol/path admission | 83.472 ms |
| Test/import/reference | 0.183 ms |
| Body-literal FTS | 0.269 ms |
| Graph expansion | 27.781 ms |
| Score/sort/cap | 12.684 ms |
| Hybrid total | 606.349 ms |
| Role assignment | 0.314 ms |
| Pivot loading/ranking | 0.614 ms |
| Co-edit expansion | 15.351 ms |
| File-evidence pass | 0.467 ms |
| Pivot/support packing | 0.739 ms |
| Representative full wall | 839.971 ms |

Counters: 959 files, 23,096 symbols, 47,780 edges; two symbol-search calls,
106 returned search results, 105 graph seeds, 129 symbols before scoring, and
25 candidates after the existing cap.

## SQL Profile

The broad query used leading-wildcard predicates, so its plan necessarily
scanned symbols and sorted by fq-name/ID. The optimization preserves that one
scan but removes thousands of repeated SQLite `lower/LIKE` evaluations:
lowered fields and term-group matches are computed once per row and reused
across the 152 disjunct combinations.

The pre-change cross-file edge plan:

```text
SCAN edges USING sqlite_autoindex_edges_1
SEARCH src_symbols/dst_symbols USING primary keys
SEARCH src_files/dst_files USING primary keys
```

The optimized plan:

```text
SEARCH anchor_files USING unique path index
SEARCH anchor_symbols USING idx_symbols_file_id_start_byte
SEARCH edges USING idx_edges_src_symbol_id
UNION ALL
SEARCH edges USING idx_edges_dst_symbol_id
USE TEMP B-TREE only for final edge-id order
```

The companion distinct-neighbor count uses the same directional branches.
Graph symbols use bounded `IN` batches. No temporary table, schema change, or
new index was needed.

## Root Causes

The primary root cause was predicate fan-out in the authoritative plain-SQL
search, not FTS, file loading, candidate scoring, or graph centrality. The
secondary root cause was a join/OR query shape that forced a complete ordered
edge scan once per co-edit anchor and again for fan-out checks.

Same-module N+1 work was real but secondary on the normal 100-seed pool; it
became material on the M100 deep 1,600-seed path. Batched symbol materialization
and one directory load per unique directory reduced graph expansion from roughly
180 ms to roughly 25 ms on the exact normal pass and bound deep-pass statements.

The routed M121 FTS lane remained tens of milliseconds and was not dominant.
BM25, penalties, sorting, role assignment, source extraction, and packing were
all small.

## Optimization Design

- Class A: rewrite cross-file endpoint and neighbor-count SQL into equivalent
  indexed source/destination branches.
- Class A: keep the legacy broad admission row set/order, but perform its
  unavoidable scan once and evaluate identical ASCII-lower substring predicates
  in-process.
- Class B: reuse the immutable admitted row set inside one request.
- Class B: batch symbol-ID loads and reuse same-directory rows.
- No persistent/snapshot cache.
- No algorithmic relevance pruning.
- No ranking, budget, role, lead, rescue, or query-decomposition changes.

An experimental FTS substitution was rejected and reverted because it changed
23/50 frozen selections and three leads. It is not part of M126.

## Query-Plan Changes

Only the edge statements changed plan: full edge scans became indexed searches
from the anchor file/symbol. Result rows and edge-ID order are identical. The
broad statement still has a scan/temp-order plan, but its repeated predicates
moved to a memoized, exact in-process evaluator. Tests cover directional result
parity, ordering, and distinct fan-out.

No index/schema version changed. Fresh/upgraded index behavior is therefore the
same DDL and existing M114/M118 invalidation rules remain authoritative.

## Semantic Equivalence

Pristine pre-M126 code and optimized code were replayed against every frozen
workspace. All 50 complete authority results had identical SHA-256 hashes.
The standalone 20-case and 30-case retrieval harnesses were also regenerated
with both pristine HEAD code and M126 code; each corresponding CSV was
byte-identical. The regenerated files were not copied over the committed
baselines: the existing baseline CSVs differ from a fresh pristine-HEAD run in
one 20-case row and two 30-case rows, so M126 treats that as baseline/corpus
drift rather than modifying unrelated result artifacts.
The exact TCKDB inner Capsule result was also byte-identical:

```text
5c0d824c269fc97f69e1259f79aecaaf6cb25a4db978982e13e3d26df9055c22
```

Thus selected files, leads, required/support roles, content modes, rendered
source/signatures, token accounting, capsule modes, diagnostics, and rescue
outputs are unchanged. Timing/profiling fields were absent from both semantic
replays.

Synthetic controls cover batched metadata, duplicate symbol identities,
directional graph fan-out, large-file gates, no-context, stale index,
incremental refresh, and linked-worktree isolation.

## Performance Results

| Corpus/task | Baseline | Optimized | Reduction |
| --- | ---: | ---: | ---: |
| Exact TCKDB warm median | 7,528.372 ms | 869.280 ms | 88.5% (8.66x) |
| Exact TCKDB warm p90 | 7,580.136 ms | 872.812 ms | 88.5% |
| Frozen 50 median | 2,657.610 ms | 614.192 ms | 76.9% |
| Frozen 50 p90 | 10,652.107 ms | 1,203.403 ms | 88.7% |
| Narrow TCKDB | — | 334.565 ms | reported, not a cache hit |
| Medium TCKDB | — | 251.378 ms | reported, not a cache hit |
| Path TCKDB | — | 883.593 ms | reported, not a cache hit |
| No-context | — | 44.485 ms | reported |

Baseline cold replay was 7,360.510 ms. The optimized first task was 839.971 ms.
Warm same-task samples were 868.641–873.226 ms through the full authority seam.
There is no same-task result cache; warm improvements also hold across different
tasks. Routed/product overhead remains well under 1.10x the inner optimized
build on the exact case.

## Product Quality

Frozen metrics remain exactly M125:

- Top-1: 39/50.
- Top-5 / any-gold: 46/50.
- All-gold visible: 45/50.
- Lead pivot: 39/50.
- Missing: 4.
- Wrong pivot: 11.
- `no_candidates`: 0.

TCKDB final files remain:

1. `backend/app/services/scientific_read/public_assessments.py`
2. `backend/app/schemas/reads/scientific_assessment.py`
3. `backend/app/db/base.py`
4. `backend/app/db/models/thermo.py`
5. `clients/python/src/tckdb_client/scientific_types.py`
6. `backend/app/db/models/reproducibility_assessment.py`

The lead remains `backend/app/services/scientific_read/public_assessments.py`.
Routed rescue remains `low_compound_coverage` and adds the assessment model.

## Worktree and Index Safety

All caches are allocated inside one `buildCapsuleV2` call and discarded on
return. Nothing crosses repository, worktree, connection, index run, refresh,
intent, budget, or task boundaries. No stale snapshot can be returned. Existing
M114 worktree/freshness and M118 full/incremental equivalence tests remain the
source of truth. Rollback is the single M126 commit; there is no stored cache or
migration to undo.

## Limitations

The broad admission path still scans all symbols and performs a final stable
sort. On much larger indexes this remains the principal hybrid cost. Timings
share the host OS page cache and are not hardware-portable. The representative
corpus is the frozen Stage 5 50 plus TCKDB; no live-agent effect is claimed.

## Deferred Work

- Further hybrid redesign only if larger repositories make the remaining scan
  material.
- M127 cross-repository intelligence.
- Tokenizer-exact accounting.
- Prospective product validation.

## Success Criteria Check

All profiling, equivalence, TCKDB visibility, frozen quality, worktree/index
safety, 2x TCKDB, 40% frozen median/p90, uncached different-task, and no-agent
criteria pass. No gold/outcome data enters runtime code. No schema/index change,
persistent cache, live agent, API, Docker, VEXP, Conda mutation, or TCKDB
mutation occurred.

## Verdict

**PASS**

## Recommendation

**promote optimized hybrid core**
