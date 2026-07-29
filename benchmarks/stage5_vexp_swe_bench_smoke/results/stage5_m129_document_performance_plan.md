# Stage 5 M129 Document-Aware Retrieval Performance Plan

## Scope and safety

This is the required pre-production-change plan. It was written on `main` at
`81055338670f7d33edf75bf82952e93dc4d8b95a` before modifying production source.
The authoritative history reviewed was:

- `81055338670f7d33edf75bf82952e93dc4d8b95a` — M128 mixed code/config retrieval.
- `b882909717de190c3bb0ad3601c2857917bd629f` — M127 unversioned capsule authority.
- `fdcda9a479522722c69a06b32d585b058670bc65` through `3efc964` — M126–M120
  retrieval, incremental, product, compound-task, worktree, and evidence invariants.

Pre-existing tracked dirt is limited to
`stage5_outcome_ledger.{md,json}`. Pre-existing untracked dirt includes
`AGENTS.md`, `VTRACE_TOOLING_AUDIT.md`, `package-lock.json`, benchmark raw runs,
streams, logs, caches, workspaces, and generated result directories. None is an
M129 input or staging target. The real TCKDB checkout is read-only at
`de644061f112eb0bf4ef0e9058840e19e8610e7f`; its only reported dirt is an
untracked `paper/` directory.

No live agent, API, Docker, VEXP, TCKDB source mutation, or persistent result
cache will be used.

## Pre-change measurements

The current read-only TCKDB schema-5 index contains 1,008 files, 44 document
files, 527 document chunks, and 527 document FTS rows. Three same-process M128
exact-task calls measured 938.394, 889.582, and 885.270 ms. On the final sample:

| stage | milliseconds |
| --- | ---: |
| task derivation (including relevance/document call) | 111.225 |
| document retrieval total | 3.070 |
| hybrid retrieval | 629.193 |
| lexical symbol search | 444.524 |
| symbol/path retrieval | 149.185 |
| graph expansion | 22.888 |
| candidate score/sort/cap | 12.379 |

The exact task produced one embedded path clue (`clients/python`), 24 document
query terms, six symbol-search calls, 122 symbol-search rows, 130 symbols before
the existing cap, 25 hybrid candidates after the cap, four materialized
document files, and two selected document files. The selected files and lead
match M128 acceptance.

Controls in the same process measured:

- Python-only task: 483.270, 499.962, 487.360 ms; document diagnostics absent,
  so the document lane was skipped.
- document task: 312.912, 308.982, 302.685 ms; document lane 1.893 ms, four
  document candidates, two selected.
- exact filename task: 217.084, 220.520, 215.386 ms, but the capsule policy
  returned no context. M129 must test document-lane invocation separately from
  final context policy and retain exact-filename recovery.

M128's committed profile measured 1,338.849 ms exact-task median, of which
1,107.733 ms was hybrid retrieval and 6.101 ms was document retrieval. Its
frozen median/p90 were 998.220/2,045.885 ms. M127's committed frozen
median/p90 were 595.874/1,222.370 ms.

The M127 and M128 frozen timing protocols were not comparable: M127 ran
`buildCapsule` and `buildCapsuleV2` untimed on each opened database immediately
before timing `buildAuthoritativeProductRetrieval`; M128 timed the authoritative
call immediately after opening the database. That confirmed warm-up mismatch
must be separated from implementation cost in the M127/M128/M129 comparison.

## M128 call graph (questions 1–14)

1. New functions are `buildDocumentChunks`, document policy helpers,
   `replaceDocumentChunksForFile`, `listDocumentChunks`, `getDocumentChunk`,
   `retrieveIndexedDocuments`, `matchPathClues`, `pathObjectiveAffinity`,
   `extractEmbeddedPathClues`, `composeDocumentItem`, and their local helpers.
2. Modified functions include query shaping, language detection/repository scan,
   full and incremental indexing, schema initialization, `buildCapsuleV2`,
   item rendering/product projection, and product-context assembly.
3. Document-task detection is `hasDocumentEvidence` at the start of
   `retrieveIndexedDocuments`; `buildCapsuleV2` calls it for every request.
4. Embedded path clues are extracted once by `shapeSweQuery` through
   `extractEmbeddedPathClues`.
5. Document FTS is queried once per invoked lane in `retrieveIndexedDocuments`.
6. FTS rows are converted to file candidates in that function's `byPath` loop.
7. Path scores are attached to the 25 capped hybrid candidates immediately
   after `hybridRetrieve`; document path matches are attached during document
   row materialization.
8. M128 does not have a general task-objective object. `artifactObjectives`
   derives the four document objectives per returned chunk; `pathObjectiveAffinity`
   independently computes path/task token affinity per hybrid candidate.
9. Mixed-objective pivot coverage is applied after role assignment. Document
   surface diversification is applied inside document retrieval; document
   support replacement happens after ordinary support packing.
10. Document excerpts are loaded eagerly through `getDocumentChunk` for every
    returned FTS row.
11. Excerpts are rendered by `composeDocumentItem`, `itemBlockText`, product
    projection, and `assembleProductContext`.
12. FTS row loading/materialization occurs before hybrid retrieval. Hybrid path
    rescoring occurs after the existing hybrid cap but before all later capsule
    candidate expansions and role assignment.
13. M128 adds no stage after the completed product capsule selection. Document
    replacement occurs before result construction; product assembly renders it
    through the normal selected-item path.
14. Query shaping and document relevance detection execute for every request.
    Document SQL/materialization is gated. Hybrid path rescoring is conditional
    on extracted path clues. The mixed-objective `refined.filter(...).sort(...)`
    block currently executes even without path clues, although it cannot change
    roles without them.

## Request-stage duplication (questions 15–25)

15. Task normalization is repeated across shaping, localization detection,
    planning, lexical scoring, document detection, objectives, and path affinity.
16. Path extraction itself is once, but path normalization/components repeat in
    every `matchPathClues` call.
17. Objective decomposition is not centralized: `artifactObjectives` repeats per
    chunk and `pathObjectiveAffinity` repeats per candidate and comparator call.
18. Document-intent detection is once per capsule build.
19. Candidate path components are normalized repeatedly: once per candidate
    rescore, again during document scoring, and again while choosing removable
    support/notebook slots.
20. Document file metadata and chunk text are loaded once per FTS row rather than
    once per unique chunk/file batch.
21. Document FTS executes once, not more than once.
22. Each selected chunk is loaded once in current code, but all rejected chunks
    are also eagerly loaded.
23. Hybrid candidate scores are recomputed once after fusion for path evidence;
    the existing hybrid `assemble` computed the original scores first.
24. Final objective coverage is not recomputed during packing, but path matches
    are recomputed during support replacement.
25. M128 adds one full candidate `map` and `sort`, a spread/sort of document
    candidates, repeated `[...]` selected-item arrays, and comparator-time path
    affinity recomputation.

## Candidate scaling (questions 26–35)

26. At most the 25 post-hybrid-cap candidates receive M128 path scoring, not all
    indexed files. The exact TCKDB task path-scores 25 candidates.
27. Document objective work is returned chunks × fixed predicates; mixed hybrid
    objective work is refined candidates plus repeated comparator evaluations.
    Exact counters will be added before optimization.
28. Path matching is candidates × clues × path components. Exact TCKDB has one
    clue and 25 capped candidates; document matching adds at most 48 row/clue
    comparisons.
29. Current scaling is capped candidates × clues, returned documents/chunks, and
    repeated candidate × implicit-objective token affinity. It is not
    indexed-files × clues.
30. No. All 1,008 current TCKDB files (959 in the M126 snapshot) are not
    M128-path-scored; the M128 pass sees the capped hybrid candidates.
31. No. At most 48 FTS hits are considered, and none when document evidence is
    absent.
32. Document candidates are built separately before hybrid retrieval and merged
    only after ordinary capsule support packing.
33. Yes. Up to 48 complete chunks, including text, are loaded and scored before
    most are rejected to four files and two selected documents.
34. Hybrid mixed-objective selection evaluates `refined`, which is bounded by
    existing candidate/expansion caps, not the complete repository.
35. A bounded batch of the identical 48 FTS hits and request-local normalized
    metadata can produce the identical final set. Lazy text loading is safe only
    after preserving every current score input (text tokens and objective
    predicates), or by splitting lightweight indexed fields from selected text.

## SQL and storage (questions 36–45)

36. M128 retrieval executes one FTS query and up to 48 `getDocumentChunk` joined
    queries. It adds no SQL path-prefix query.
37. Exact TCKDB: one FTS query plus one chunk lookup for each returned row.
    The committed exact profile returned enough rows to materialize four files;
    the raw-row counter will record the exact number.
38. FTS is capped at 48 rows; each chunk lookup returns zero or one row.
39. Yes. `EXPLAIN QUERY PLAN` reports
    `SCAN document_search_fts VIRTUAL TABLE INDEX 0:M7`.
40. Each chunk join uses the `document_chunks` primary-key index followed by the
    `files` primary-key index, but the N+1 invocation pattern is avoidable.
41. Path matching is TypeScript-only.
42. M128 path matching does not scan the `files` table.
43. No. Matched excerpts are not batch-loaded.
44. Yes: one joined lookup per FTS hit.
45. FTS ordering reports `USE TEMP B-TREE FOR ORDER BY`. Chunk lookup itself uses
    both intended indexes and no full table scan.

The SQL profiler will capture statements, invocation/row counts, and normalized
plans. The intended correction is a single bounded query joining an ordered FTS
subquery to chunks/files, preserving exact FTS rank and tie order.

## M126 reuse interaction (questions 46–53)

46. M126 introduced `HybridRetrievalRequestCache.broadCandidates`, reused by
    repeated symbol searches and the compound rescue within one capsule build.
47. M128 passes that same cache to both primary and rescue retrieval; document
    retrieval neither uses nor bypasses it.
48. M128 does not reopen the index connection.
49. M128 does not issue a broad file/symbol scan. It does add a separate bounded
    document FTS query and N joined chunk lookups.
50. Document fusion does not rebuild hybrid candidates. Path integration maps
    and sorts the already capped hybrid candidate array once.
51. Path scoring does not reload file metadata; file paths are already on
    candidates. Document scoring reloads file metadata through each chunk join.
52. Path-scored score objects and candidates are cloned only on matches.
    Objective coverage mutates roles and does not clone score objects.
53. Yes. A request-local M129 context will hold normalized task tokens, clues,
    candidate path metadata, affinity, document rows/candidate map, and counters.

## Gating (questions 54–60)

54. Existing structured clues are explicit YAML/TOML filename/path clues and the
    document terms recognized by `hasDocumentEvidence`.
55. Workflow, GitHub Actions, CI, YAML/YML, `.github/workflows`, or an exact
    `.yml`/`.yaml` filename indicate workflow/YAML relevance.
56. TOML, pyproject, dependencies, pytest configuration, or an exact `.toml`
    filename indicate project-configuration relevance.
57. The exact current task has `clients/python`, which is a subtree rather than
    a document path. `python-client-ci.yml` and `pyproject.toml` are direct
    document filename clues in their controls.
58. FTS may be skipped when there is no supported document clue. Path-document
    work may be skipped without an embedded path clue. Objective document
    coverage may be skipped when no document candidate exists. An exact matching
    filename/path remains sufficient to invoke the lane.
59. Skips will be profiled as
    `documentLane: { attempted:false, reason:"no_supported_document_clue" }`
    with avoided counts where available; deterministic product output will not
    contain timing values.
60. The existing Python-only control already skips the lane and M128 frozen
    output was unchanged in all 50 cases. M129 will normalize/hash all outputs
    before accepting any stronger gate.

## Measurement integrity (questions 61–68)

61. No. M127 pre-warmed every frozen database with two capsule calls; M128 timed
    the first authoritative call after open.
62. Both used prebuilt indexes, but their SQLite/process/cache warmth differed.
63. Schema-5 opening cost is outside M128's per-case timer because the database
    is opened before `started`; first-query page-cache effects are inside.
64. M128's retrieval timer did not migrate/rebuild indexes; the smoke prepared
    compatible indexes separately.
65. Yes, latency remains nontrivial warm, but current same-process exact calls
    converge to ~885–890 ms rather than the committed 1,339 ms median.
66. Python-only warm calls are ~483–500 ms and skip the document lane, proving
    that document FTS is not the direct cost on those tasks.
67. The exact mixed task (~885–938 ms) and document-only task (~303–313 ms) both
    select documents; document retrieval itself is only ~2–3 ms.
68. M128 work is bounded by clue count, the 25 candidate cap, 48 FTS rows, and
    527 current TCKDB chunks. Correlation with file/document/objective/clue
    counts will be measured with the required synthetic controls; the present
    evidence rejects raw document-count scanning as the dominant exact-task cost.

## Instrumentation design

Profiling remains optional and disabled by default. A request-local profile will
retain the M126 hybrid/capsule clocks and add:

- relevance detection, path extraction/integration, FTS, materialization,
  objective decomposition/matching, coverage, excerpt loading, rendering, and
  document accounting/deduplication timings;
- objective/clue/file/component/row/candidate/comparison/excerpt/byte/render/sort
  counters;
- bounded SQL statement/row counters in benchmark-only profiling;
- deterministic skipped-lane trigger/reason diagnostics without source content.

Timing and raw profiler counters will be excluded from normalized semantic hashes.
No source body or excerpt body will appear in diagnostics.

## Optimization order and equivalence proof

1. Establish like-for-like M127/M128/M129 cold and warm protocols in isolated
   compatible worktrees/indexes.
2. Add optional counters/timers without changing selection.
3. Batch the FTS-hit chunk join, preserving row order and all current score inputs.
4. Create request-local normalized task/path metadata and affinity maps.
5. Skip mixed-coverage traversal when there are no path clues or document
   candidates; retain the existing deterministic document clue gate.
6. Deduplicate evidence lanes by document path/chunk while retaining provenance.
7. Load/render only the excerpts needed by the same selected document candidates
   if and only if byte-equivalence proves the lazy boundary safe.
8. Do not add a persistent or identical-task result cache.

Every step must preserve selected files, lead, roles, content modes, excerpts,
rendered context, accounting, task hash, rescue semantics, and document
diagnostics after timing-only normalization. Any unexpected scoring, ordering,
budget, rescue, authority, or supported-format change stops optimization.

## Validation matrix

The no-agent M129 smoke will cover Python-only gating, mixed Python/YAML/TOML,
exact workflow filename, embedded subtree, many files, many objectives, many
chunks, duplicate evidence, TCKDB shape, full/incremental equality, linked
worktrees, stale fail-closed behavior, unversioned authority, and semantic hashes.

The final run will also execute the frozen 20+30 suites, exact read-only TCKDB
acceptance, SQL plans, indexing sanity, YAML/TOML edit/rename/delete/no-op
equivalence, all repository tests and typechecks, and `git diff --check`.
Performance PASS uses like-for-like non-memoized warm calls and the stated
715/1,467 ms frozen and 1,208 ms TCKDB maximums.
