# Stage 5 M126 Hybrid Retrieval Core Profiling and Optimization Plan

Date: 2026-07-23
Branch: `main`
Pre-change HEAD: `1272d2b`

This plan was written before M126 production-code changes. The outcome ledgers
were already modified. `AGENTS.md`, `VTRACE_TOOLING_AUDIT.md`, `package-lock.json`,
benchmark run trees, streams, logs, caches, prompt captures, and other generated
results were already untracked. M126 will not modify or stage that pre-existing
dirt. TCKDB source and in-place `.vtrace` state are read-only and out of scope.

Authoritative history:

- `a4b7cf6` — incremental unsupported-language handling
- `1272d2b` — M125 product retrieval authority, lazy routed rescue, and latency baseline
- `c678624` — M123 product ranking convergence
- `102dc37` — M123 frozen product baseline
- `965e561` — M121 zero-candidate compound rescue
- `3b0baa7` — incremental worktree indexing
- `6dbd519` — unified product-context responses
- `3efc964` — impact/static-flow evidence

## Scope and hypotheses

M126 profiles and optimizes the existing authoritative Capsule v2 path. It does
not change scoring constants, query decomposition, candidate ranking, roles,
lead selection, budgets, rescue triggers, selected-file limits, or product
response shape. Optimization priority is Class A query work, then Class B
request-local reuse. Class C caching is rejected unless the measured remainder
requires it. Class D pruning requires byte-identical semantic outputs.

The primary source-derived hypothesis is same-module expansion:
`hybridRetrieve` normally requests 25 results, which makes its default lexical
pool 100. `expandGraphCandidates` passes every raw seed to
`addSameModuleNeighbours`; that function calls `getSymbolById` and then
`listSymbolsUnderDirectory` once per seed. The directory query uses
`files.path LIKE ?` plus `instr(substr(...), '/') = 0`. Many seeds commonly
share a directory, but the same directory rows are requeried and rematerialized.
Graph materialization and evidence formatting add further per-symbol
`getSymbolById` lookups. This is an N+1/repeated-work hypothesis until timing,
statement counts, row counts, and query plans confirm it.

Secondary hypotheses are repeated FTS ranking lanes, candidate-wide centrality,
co-edit/file-evidence source loading, and repeated content hashing. File loading
is expected to be secondary because M125 measured product enrichment at roughly
51 ms versus roughly 7.5 seconds for the hybrid build, but M126 will measure it.

## Pre-change hybrid call graph

`buildCapsuleV2` (`src/capsuleV2/buildCapsuleV2.ts`) performs task shaping,
localization, intent planning, allocation, `hybridRetrieve`, optional M121
hybrid rescue, anchors/backfills, role refinement, co-edit/file-evidence
expansion, content construction, and packing.

`hybridRetrieve` is defined in `src/retrieval/hybridRetrieval.ts`. Its direct
stages are:

1. `normalizeMaxResults` and lexical-pool calculation.
2. `lexicalCandidates` -> `searchSymbols`.
3. `symbolPathCandidates` -> per-symbol `searchSymbols` and
   `listSymbolsForFile`.
4. `failingTestCandidates` -> `expandTestsToImplementation`.
5. `bodyLiteralCandidates` -> `extractBodyLiterals` and
   `searchBodyLiterals`.
6. `graphExpandedCandidates` -> `expandGraphCandidates` and evidence lookup.
7. `assemble` -> BM25, centrality, component scores, penalties, deterministic
   sort, and cap.

Detailed ownership:

- Task normalization and derivation: `shapeSweQuery`, `planIntent`,
  `detectLocalizationSignals`, `deriveSymbolSeeds` in the Capsule v2 path;
  `normalizeSearchQuery` and the `resolve*QueryContext` helpers inside routed
  symbol FTS.
- Term/path extraction: `shapeSweQuery`, `collectIdentifierTerms`,
  `collectQueryVariants`, `resolvePathSignalQueryContext`, and
  `extractBodyLiterals`.
- Symbol FTS: `searchSymbolsFtsDetailed`, `queryCandidates`, and recovery,
  identifier, boundary, and path lanes in `searchSymbolsFts.ts` and
  `searchSymbolsShared.ts`.
- Body-literal FTS: `bodyLiteralCandidates` and
  `bodyLiteralsRepository.searchBodyLiterals`.
- Exact identifiers/path matching: search FTS identifier/path lanes plus
  `symbolPathCandidates`; M121 routed rescue remains outside authoritative
  hybrid selection in `authoritativeProductRetrieval.ts`.
- Test/import/call/reference retrieval: `expandTestsToImplementation`,
  `listEdgesForSymbols`, and graph expansion edge classification.
- Graph traversal: `expandGraphCandidates`; bounded depth 1 by default, at most
  24 expanded candidates, optional depth 2, and six same-module symbols per seed.
- Co-edit expansion: `expandCoeditSupport` in `coeditExpansion.ts`, after hybrid
  ranking and role refinement.
- Score aggregation: `assemble`, `computeBm25Scores`,
  `computeInDegreeCentrality`, normalization, and `combineFinalScore`.
- Hub/actionability penalties: `evaluateHub` and `evaluateActionability` in
  `hybridScoring.ts`, called by `assemble`.
- Role assignment: `assignCandidateRoles`, `refineDebugRoles`, pivot v2
  ranking, and product authoritative selection.
- Budget packing: `allocateBudget`, pivot/support construction,
  `estimateTokens`, compression/content-mode fallbacks, and final packing in
  `buildCapsuleV2.ts`.

Symbol-level stages are lexical, symbol/path admission, test expansion,
body-literal admission, graph traversal, BM25, centrality, component scoring,
penalties, and the first role gate. File-level stages are co-edit/file-evidence
expansion, file deduplication/order, content loading, content-mode decisions,
and packing.

## Questions 1–10: call graph and transformations

1. `hybridRetrieve` is at `src/retrieval/hybridRetrieval.ts`.
2. It directly invokes its five candidate generators and `assemble`; their
   database/retrieval callees are listed above.
3. Every requested responsibility is mapped in the call graph above.
4. Symbol stages are all generators through `assemble`.
5. File stages begin with likely-file admission and become authoritative during
   product selection/content construction.
6. Requeries already visible in source: `ensureCandidate` calls
   `getSymbolById` for newly admitted IDs; graph expansion requeries seed symbols,
   directory symbols, materialized neighbor symbols, evidence `via` symbols, and
   centrality edges. `expandTestsToImplementation` also resolves destination
   symbols individually.
7. `loadSymbolSource`, actionability hints, co-edit scanning, and file-evidence
   rescue independently use synchronous reads. They currently have no common
   request-local content provider.
8. Complete-set sorts occur in search ranking, graph materialization,
   `assemble`, role/pivot ranking, co-edit proposal ranking, and support ordering.
9. Large arrays include FTS candidate rows/ranked rows, raw symbol maps, edge
   arrays, directory-symbol arrays, co-edit file lists, and rendered candidate
   items.
10. Pre-M126 timing covers task derivation, the whole hybrid block, routed rescue,
    enrichment, and total build/product walls. `searchSymbolsFtsDetailed` times
    normalization, lanes, merge, and total. Hybrid generators, graph subphases,
    scoring, file loading, roles, and packing are not separately timed.

## Questions 11–25: database access and query planning

11. Direct `buildCapsuleV2` receives one already-open `Database`; it opens zero
    connections. CLI/MCP opens a connection through `openIndexerDatabase` per
    bound tool execution. M125 direct profiling used one read-only
    `new Database(...)` for the measurement block.
12. The supplied connection is reused through a request.
13. Exact statement count is not observable pre-M126; bounded profiling will
    record it by category and fingerprint for every corpus case.
14. Once-per-retrieval statements include primary lexical lanes, graph edge
    batches per depth, and centrality edge loading, subject to optional lanes.
15. Once-per-term statements include exact-identifier FTS lanes, symbol seed
    searches, body-literal expressions, and path/boundary lanes where present.
16. Per-candidate statements include `ensureCandidate` misses,
    test-destination resolution, graph materialization, graph evidence name
    resolution, and post-hybrid content/metadata lookups.
17. Edges are batch-loaded by frontier/ID set, not one query per edge. Same-module
    symbols are loaded once per seed, even when directories repeat. Content reads
    can repeat per product phase.
18. Confirmed source-level N+1 shapes are per-seed same-module lookup and
    per-neighbor/per-evidence symbol lookup. M126 will quantify each.
19. `symbol_search_fts MATCH ?` and
    `symbol_body_literals_fts MATCH ?` use FTS5.
20. `listSymbolsUnderDirectory` uses an escaped prefix `LIKE` plus substring
    slash exclusion. Search ranking performs TypeScript substring comparisons
    after FTS admission.
21. Potential scans requiring plans: same-directory `files.path LIKE`,
    FTS virtual-table searches, and any co-edit path joins. The edges query uses
    indexed `src_symbol_id`/`dst_symbol_id` disjuncts.
22. No retrieval source inspected creates explicit temporary tables.
23. `ORDER BY id` on the OR-ed edge query may require a temporary B-tree; the
    same-directory order spans file path and symbol byte/id. Plans will confirm.
24. Primary FTS and directory queries can return substantially more rows than
    final caps; FTS ranking intentionally needs its admitted row set, while
    same-directory code stops consuming after six but currently materializes all
    direct-directory symbols.
25. Identical directory and `getSymbolById` queries repeat. Profiling will record
    normalized fingerprints without private parameters.

For every statement class consuming at least 2% of total wall time or executing
more than once, the profiler will capture `EXPLAIN QUERY PLAN`, plan detail,
invocation count, row count, median/max/total duration, and observed input/output
cardinality. No index will be added without a demonstrated scan/sort need and
before/after plan.

## Questions 26–34: graph traversal

26. Incoming and outgoing edges are loaded together by
    `listEdgesForSymbols`, whose SQL uses
    `src_symbol_id IN (...) OR dst_symbol_id IN (...)`.
27. Edges are batched per frontier. Neighbor symbols are materialized one at a
    time; same-module rows are queried per seed.
28. Seed IDs are deduplicated. Pending candidates merge by ID and frontier seed
    provenance merges, but an already-pending node may re-enter the next frontier;
    maximum depth is two. Same directories are revisited across seeds.
29. Seed exclusion and pending maps prevent duplicate output, but there is no
    explicit global visited set for depth-two frontier work. Default depth one
    limits the effect.
30. Edge traversal depth is bounded before each load. Expanded-candidate cap is
    applied after pending candidates and neighbor symbols are materialized.
    Same-module per-seed cap is applied while iterating a fully returned directory
    row set.
31. Edge types are returned by SQL and filtered/classified in TypeScript.
32. Hybrid traversal does not load the full edges table. A broad root-directory
    same-module query can approach all root-file symbols, but nested directories
    are excluded.
33. Centrality is recomputed per request from one `listEdgesForSymbols` call over
    all raw candidates.
34. Graph raw scores aggregate once per expanded symbol; later file-level
    co-edit expansion aggregates cross-file evidence separately.

## Questions 35–42: candidate aggregation

35. Counters will record FTS rows, lexical results, seed/path/test/literal
    admissions, raw deduplicated symbols before graph, pending graph symbols,
    assembled symbols, capped symbols, file-level deduplication, roles, and
    packed files.
36. Symbols merge early in the shared `Map<SymbolId, RawCandidate>`. Files remain
    represented by multiple symbols until later role/product selection.
37. Primary FTS rows may be broad but lexical output is capped. Directory queries
    can materialize unlimited rows before consuming six per seed.
38. Hybrid score breakdowns are computed once per assembled symbol. Later pivot
    ranking computes additional file/actionability scores by design.
39. Search merging and candidate enrichment spread/copy candidate objects and
    arrays, but no JSON serialization occurs in the core.
40. Most comparator keys are read directly; locale comparisons and evidence
    sorts repeat but are expected secondary.
41. Existing lexical/final/graph caps are applied, but graph pending
    materialization and directory row production occur before the 24-candidate
    cap.
42. Every raw symbol receives BM25, centrality, score, and penalty processing
    even if it cannot survive the 25-result cap; safe earlier pruning is not
    assumed because normalization depends on pool maxima and BM25 depends on the
    entire contention set.

## Questions 43–50: file access and packing

43. Complete source files are synchronously loaded by `loadSymbolSource` during
    pivot/support content construction; co-edit and file-evidence helpers can
    read files earlier for their own evidence.
44. Co-edit scanning and file-evidence rescue can load bodies before final packing.
45. The same file can be read by separate helpers and by multiple selected
    symbols. M126 counters will identify content identity and bytes.
46. `estimateTokens` is called on source/snippet and rendered item blocks; no
    shared content-identity memo exists.
47. Full/skeleton/signature decisions are made during item construction; a
    candidate that later loses packing may already have paid extraction cost.
48. Compression cost is computed before final item admission for the candidate
    being considered, not globally for all files.
49. Symbol/file metadata can be batch-loaded; content is filesystem-backed and
    can be request-locally reused by normalized path/content hash.
50. Immutable content can safely be reused within one request when keyed by
    indexed file identity/content hash and freshness checks remain fail-closed.

## Questions 51–60: measurement integrity

51. M125 warm direct-function timings excluded process startup; its cold label
    meant first retrieval on an already-open process/connection, not a new process.
52. Direct M125 timing opened the database before the timed retrieval but read-only
    construction itself may validate SQLite headers. CLI/MCP `openIndexerDatabase`
    runs schema initialization checks.
53. M125 direct `buildCapsuleV2` timing excluded product binding freshness checks.
    Product combined measurements passed an explicit fresh override.
54. Direct and CLI/MCP differ because CLI/MCP includes binding, freshness, schema,
    formatting, and transport. M126 reports them separately and does not use CLI
    totals as hybrid-core totals.
55. Frozen retrieval eval scripts generally run cases in one Bun process; live
    benchmark harness process behavior is irrelevant and will not be invoked.
56. The 7.5-second TCKDB warm timing occurred repeatedly in one warm process,
    one connection, and one task loop.
57. M126 will measure cold new process, warm first task, warm same task, warm
    different task, and warm similar-term different task independently.
58. OS page cache likely explains part of cold/warm movement; same-process
    different-task measurements and subprocess cold samples will distinguish it.
59. `readFileSync`, `readdirSync`, and `statSync` in Capsule v2 block the event
    loop. They are included in total and separately counted/timed.
60. GC is not currently surfaced. Repetition samples and optional CPU profiles
    will flag isolated outliers; performance claims use median and p90, retain
    all stages, and do not discard unexplained slow samples.

## Instrumentation design

Add an optional request-local profile sink to hybrid/Capsule v2. Disabled mode
must preserve current return shape and avoid clocks/counters beyond a single
branch. Enabled mode records a fixed timing tree:

- hybrid total
- request preparation: normalization, task derivation, term/path extraction
- lexical: symbol FTS, body-literal FTS, path, exact identifiers
- structural: imports, tests, references/calls, graph, co-edit
- candidate processing: symbol-to-file aggregation, scoring, penalties,
  sorting/capping
- capsule construction: metadata/content, roles, compression/skeleton, packing

Counters follow the milestone contract: statements, rows, FTS variants, raw and
deduplicated symbols/files, graph nodes/edges, bodies/bytes, sorts, and
before/after caps. SQL profiling is bounded and benchmark-facing: repositories
receive wrappers/hooks around known repository calls rather than persisted raw
SQL or parameters. Fingerprints normalize whitespace and literals; categories
are stable enums. Plans contain only schema/index names and plan details. No
source body or private parameter value is emitted.

Stable product projections omit the profile unless an explicit diagnostics flag
is set; comparison helpers zero timing fields before semantic hashing.

## Measurement corpus and protocol

The exact TCKDB task is byte-for-byte:

> Add a stable public reference for the exact immutable reproducibility assessment surfaced in compact assessment summaries across thermo, kinetics, statmech, and transport. Determine whether assessment models already have an appropriate public_ref; trace immutability/supersession, schemas, migrations, projection builders, OpenAPI, tests, docs, and Python client types.

TCKDB source is `<TCKDB_ROOT>` at
`70ff50381f42551a825d75874ea2d70f6dbe08ec`. Its source and in-place state remain
read-only. An isolated copied database/index or temporary source copy is used
where rebuild/refresh is required.

Additional tasks:

- narrow TCKDB: `RecordReproducibilityAssessment`
- medium TCKDB: `Find the reproducibility assessment model and public assessment projection`
- path-only: `backend/app/services/scientific_read/public_assessments.py`
- no-context: `!!!`
- frozen small, medium, and large fixture/repository cases selected from existing
  deterministic retrieval fixtures, with counts reported
- synthetic graph fan-out, duplicate-symbol, large-file, repeated-file,
  stale-index, incremental-refresh, and linked-worktree cases

Each case reports repository files/symbols/edges, term count, stage times,
statement/row counts, candidate counts, selected files, and rendered tokens.
Cold is a new Bun process. Warm first, repeated same, different, and similar-term
different tasks run in one process/connection. At least five warm samples are
used for medians and p90; same-task results are never the sole PASS basis.

## Optimization decision gate

After baseline capture:

1. Rank stages and statement fingerprints by total time.
2. Capture plans for expensive statements.
3. Prefer request-local batching/reuse that preserves the exact row order.
4. Add an index only if a plan proves a scan/temp sort and both fresh/upgraded
   paths are tested; otherwise schema/index format remains unchanged.
5. Do not add a persistent cache unless A/B optimizations leave immutable repeated
   work dominant. If no cache is added, explicitly report that policy.
6. Freeze baseline semantic hashes before edits and compare byte-for-byte after.

Likely Class B candidate, contingent on profiling: load each unique same-module
directory once per graph expansion, reuse seed symbols already present in the
hybrid raw map, batch materialize pending symbol IDs, and resolve evidence names
from the same request-local symbol map. The per-seed six-symbol iteration,
ordering, evidence, pending insertion order, scores, and final cap must remain
identical.

## Equivalence and controls

For every frozen case compare selected files, lead, roles, capsule/content modes,
task hash, rendered model-visible text, token accounting, routed rescue trigger,
and rescue additions. The normalized semantic output hash must be identical.

Controls:

- candidate-growth fixture demonstrates bounded statement growth
- duplicate symbols demonstrate one metadata/body load per identity
- graph fan-out preserves traversal bounds without full graph loading
- excluded large file is not repeatedly loaded/estimated
- multi-lane repeated file is request-locally reused
- linked worktrees cannot share snapshot-dependent state
- incremental refresh cannot serve prior snapshot state
- full and incremental indexes retrieve identically
- database failures remain fatal and stale freshness remains fail-closed

Frozen 20+30 suites must have zero selected-file, lead, role, and rendered-context
differences from M125 and retain at least 39/50 top-1, 46/50 any-gold, 45/50
all-gold-visible, 39/50 lead, at most four missing, at most eleven wrong pivots,
and zero `no_candidates`.

TCKDB must preserve the M125 selection, preferably exactly:

1. `backend/app/services/scientific_read/public_assessments.py`
2. `backend/app/schemas/reads/scientific_assessment.py`
3. `backend/app/db/base.py`
4. `backend/app/db/models/thermo.py`
5. `clients/python/src/tckdb_client/scientific_types.py`
6. `backend/app/db/models/reproducibility_assessment.py`

The lead remains `backend/app/services/scientific_read/public_assessments.py`,
the routed trigger remains `low_compound_coverage`, and model/projection/public
reference/schema/client-or-verification evidence remains visible.

## Success, reporting, and rollback

PASS requires semantic identity plus at least 2x exact-TCKDB warm hybrid speedup,
at least 40% frozen median/p90 reduction, and combined overhead no more than
1.10x hybrid-only where routed rescue does not dominate. MIXED is used if the
measured bottleneck and safe improvement are real but the 2x threshold is missed.
No expensive stage may be omitted.

The no-agent smoke script will produce its detail JSON and CSV. Compact profile,
SQL, plan, optimization, equivalence, product regression, TCKDB, and next-action
artifacts will use normalized repository labels rather than private absolute
paths. No live agent, API, Docker, VEXP, TCKDB mutation, Conda mutation, or
cross-repository intelligence is permitted. Rollback is the single local M126
commit (or the two planned profiling/optimization commits if cleanly separated);
no persistent cache or external state is required.
