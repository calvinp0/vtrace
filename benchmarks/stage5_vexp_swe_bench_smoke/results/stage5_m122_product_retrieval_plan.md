# Stage 5 M122 Product-Path Retrieval Plan

Date: 2026-07-22
Branch: `main`
Authoritative M121 commit: `965e561274b41a5bb3c21e7716684a5fc64a3e01` (`Fix zero-candidate retrieval for compound tasks`)

This plan was written before any M122 source or evaluator change. The pre-existing modified outcome ledgers and all pre-existing untracked run artifacts are out of scope and will remain unstaged. M122 is offline and deterministic: no agent, API, Docker, VEXP, environment mutation, or TCKDB write is permitted.

## Retrieval Architecture

1. `get_code_context` is `handleGetCodeContextRequest` in `src/mcp/tools.ts`; after fail-closed worktree freshness handling it delegates to the same run-pipeline handler and `runPipelineOrchestrator` in `src/runPipeline/runPipelineOrchestrator.ts`.
2. Default `get_context_capsule` calls `runIntentAwareCapsulePipeline` (via `src/mcp/tools.ts`); it also attaches M119 `assembleProductContext` from `src/productContext/assembleProductContext.ts`. Its opt-in v2 envelope calls `buildCapsuleV2` directly.
3. `run_pipeline` calls `runPipelineOrchestrator`; `runReliableContextRetrieval` calls `routeQuery`, `prepareCapsuleAssembly`, and `buildCapsule`. It separately attaches `assembleProductContext` in `src/mcp/tools.ts`.
4. The three visible responses all expose the M119 `productContext`, but their outer/default capsule is not identical: `get_code_context` and `run_pipeline` use routed FTS; default `get_context_capsule` uses the intent-aware v1 wrapper; the attached M119 projection currently selects through `buildCapsuleV2`. This is the split M122 must measure, not conceal.
5. `resolveBroadQueryContext` is owned by `src/retrieval/searchSymbolsShared.ts`.
6. Compound decomposition is owned by `resolveBroadQueryContext`, `buildBroadPhraseGroups`, and `buildBroadAdmissionDisjuncts` in that file.
7. Exact identifier extraction/variants are owned by `collectIdentifierTerms` and `collectQueryVariants` in `src/retrieval/searchSymbolsFts.ts`, with broad term variants in `searchSymbolsShared.ts`.
8. Candidate lane union is owned by `searchSymbolsFtsDetailed` using `mergeSearchCandidates` plus the prioritized exact-identifier map.
9. Graph reranking is `rerankGraph` in `src/retrieval/rerankGraph.ts`, invoked by `routeQuery`.
10. Routed final capsule selection is `prepareCapsuleAssembly` plus `buildCapsule`/`createSourceBackedCapsuleBuilder`; legacy final selection is `buildCapsuleV2`.
11. In the routed path the first `capsule.pivots` item is the lead pivot; pivots are required/edit targets and `supportingItems` are supports. `assembleProductContext` independently derives `leadPivot`, `requiredFiles`, `supportFiles`, and `selectedFiles` from Capsule v2 product items in `src/productContext/assembleProductContext.ts`.
12. Shared stages include SQLite/index contents, symbol FTS data, `searchSymbols` dispatch primitives, normalization helpers, graph data, source/skeleton readers, and deterministic budgets.
13. Divergent stages are candidate generation/ranking (`routeQuery` routed FTS versus `buildCapsuleV2` hybrid retrieval and its anchor/backfill policies), role selection, packing, and final rendering.

## Existing Evaluators

14. `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_retrieval_eval.ts` produced the M94-M103 metrics by calling `buildCapsuleV2`.
15. The same evaluator produced the frozen Django-expanded 20 and cross-repository 30 M121 no-change results.
16. It invokes `buildCapsuleV2` directly; it does not invoke routed product retrieval.
17. `run_stage5_m104_live_context_smoke.ts` exercises a live-context seam, but no frozen deterministic scorer invokes `get_code_context` or `runPipelineOrchestrator` directly.
18. `retrieval_eval.django.expanded.json` and `retrieval_eval.cross_repo.30.json` contain task, intent, 8,000-token budget, expected files/symbols, and label provenance. M103 detail has 100 fixed task derivations and gold file data, but not a frozen product-route workspace identity or explicit per-case product character budget; hidden/co-edit is only present where inferable from multiple gold files.
19. The 100-case M103 pool is semantically useful but not directly runnable as a frozen product-path corpus without reconstructing missing workspace/budget seams.
20. Missing seams are a frozen workspace path/index snapshot for every row, an explicit routed-product character budget mapping, and product-role labels distinct from historical Capsule v2 output-derived roles.
21. The largest valid no-relabeling product corpus is therefore the existing 50 cases. M122 will not manufacture a 100-case fixture.

## Product Response

22. Scoring needs structured task hash, capsule mode, lead pivot, items/roles, diagnostic selected/required/support files, accounting, freshness, and timing from `ProductContextResponse`, plus routed capsule/candidate diagnostics for M121.
23. `ProductContextResponse.leadPivot` and `diagnostics.selectedFiles` are structural.
24. Required/support roles are structural in `items[].roles` and the corresponding diagnostic arrays.
25. Yes; scoring will not parse rendered prose.
26. M119 unresolved freshness returns `resolved=false`/`capsuleMode=no_context`; routed retrieval uses explicit skip reasons. The evaluator will normalize both without erasing provenance.
27. Token estimates are deterministic for fixed files/content. Wall-clock latency is not byte deterministic and is measurement-only.
28. All `timing.*`, per-lane `timingsMs`, generated timestamps, and absolute roots are excluded from byte-stable projections.

## M121 Behavior

29. M121 changed `routeQuery`, `searchSymbolsFtsDetailed`, `resolveBroadQueryContext` and helpers, routed diagnostics/types, run-pipeline diagnostics/formatting, and MCP schema/tests.
30. `buildCapsuleV2`, `hybridRetrieve`, its scoring, and `run_stage5_retrieval_eval.ts` remained unchanged; this explains byte-identical legacy metrics.
31. Yes: call `runPipelineOrchestrator` (or a smaller exported product evaluation seam) in-process against an opened index.
32. Yes: use the same fixture row and SQLite snapshot for `buildCapsuleV2` and routed product assembly.
33. Record `routeQuery.rerankedResults` and `pathSignalDiagnostics.search` beside legacy Capsule v2 diagnostics for every row.
34. Record routed pivots/supports/packing and legacy pivots/supports, then classify every expected file at both candidate and final stages.
35. M121 exposes normalized query, query variants, identifier/path/FTS terms, raw lane counts, union size, rejections, fallback, graph count, final reason, and timings. The evaluator will preserve these source-body-free fields.

## TCKDB Acceptance

36. Read-only acceptance targets under `<TCKDB_ROOT>` are: `backend/app/db/models/reproducibility_assessment.py`; `backend/app/services/scientific_read/public_assessments.py`; `backend/app/services/public_refs.py` and `PublicRefMixin`; `backend/app/schemas/entities/reproducibility_assessment.py` plus `backend/app/schemas/reads/scientific_assessment.py`; relevant files under `backend/alembic/versions` (or the repository's discovered migration root); tests under `backend/tests`; `backend/app/api/public_openapi.py` and `backend/tests/api/golden/openapi.json`; and discovered Python client model/type paths.
37. The evaluator will report each target at raw union, reranked, selected, lead, required, and support stages; no candidate-only hit counts as final success.
38. The exact unmodified query must surface both model and projection in final selected context.
39. Any miss will be localized as not generated, generated/low-ranked, reranked/not-selected, selected/compressed, or selected/visible before a fix is considered.
40. Under the existing 10,000-token acceptance budget: model and projection must be pivot/required/high-confidence support; public-ref infrastructure and schema must be visible; at least one migration or test/OpenAPI/client surface must be visible. All six categories need not be pivots.

## Robustness

41. Slash and backslash currently affect broad-context admission most directly; punctuation also affects token/identifier/path extraction.
42. `/` and `\\` are path candidates; `:`, `-`, `_`, and `.` delimit or preserve identifiers depending on shape; quotes/backticks preserve inner tokens; URLs and stack paths carry slash signals; version dots should remain bounded lexical terms.
43. A standalone path-like query gets path-aware treatment. Natural-language separators must remain broad. Prose containing a real path must retain both the extracted path signal and broad decomposition.
44. Equivalent prompts must preserve non-empty status, exact identifiers, materially similar selected files, stable top/lead/required targets absent a real tie, and bounded token/variant growth.
45. M121 currently caps path and phrase diagnostic variants at eight each plus identifiers, semantic query, and at most one fallback. M122 will assert a documented global bound after measuring long-query identifier counts; no pairwise Cartesian expansion is allowed.
46. Long stopword-light tasks, many identifier-shaped tokens, and recovery OR queries are the latency risks. The synthetic 16/17/32/48/96-term family will measure them.

For harmless punctuation families, the preregistered selected-file Jaccard acceptance is at least 0.60, with no `no_candidates` regression and stable lead pivot unless diagnostics show a deterministic score tie. A 0.60 floor is strict enough to catch replacement of most small capsules while allowing one bounded support swap in a 3-5-file context; results will also report the actual distribution rather than optimize to the threshold.

## Benchmark Convergence

47. The product route should become primary only after it is competitive on the frozen 50, passes compound robustness, meets TCKDB final-context acceptance, stays bounded, and has actionable diagnostics.
48. Until that gate is met, both evaluators remain, with `product-retrieval-v1` the prospective product baseline and legacy Capsule v2 retained as historical comparison.
49. Replacing historical output names would lose the M94-M103 longitudinal series and role semantics, so those artifacts remain immutable.
50. The new baseline name is `product-retrieval-v1`.
51. Reports will show corpus-specific product and legacy aggregates side by side, followed by row-level classifications and evidence.
52. Promotion requires: direct routed-path execution; fixed inputs; no gold leakage; competitive recall; controlled no-candidates; TCKDB final acceptance; metamorphic/path tests; bounded variants/latency; incremental/full equivalence; schema/impact compatibility; full tests/typechecks/smoke/diff checks.

## Execution and Decision Policy

The evaluator will use frozen 20+30 rows, run legacy `buildCapsuleV2` and routed product retrieval against each row's existing index, and emit a byte-stable projection without timing fields plus measurement artifacts with timing. A synthetic indexed repository will cover routing, identifiers, punctuation, URL, trace, versions, and long tasks. TCKDB will be freshly indexed only through VTRACE's read-only source scan/index output under TCKDB's existing `.vtrace`, never modifying TCKDB source or Git state; the index itself remains untracked and unstaged.

Evaluation comes first. A source fix is allowed only for a stage-localized defect demonstrated by the frozen, TCKDB, or metamorphic evidence, followed by one full rerun and changed-case review. Decision A/B/C/D and PASS/MIXED/FAIL will follow the requested gates. M123 cross-repository workspace intelligence is explicitly deferred.
