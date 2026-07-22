# Stage 5 M123 Product Retrieval Ranking Plan

Date: 2026-07-22
Branch: `main`
Authoritative commits: `965e561` (M121 compound-task recovery) and `1a80527` (M122 product-path evaluation)

This plan was written before M123 product-code changes. The modified outcome ledgers and all pre-existing untracked runtime/benchmark artifacts are out of scope and will remain untouched. M123 is deterministic and offline: no agents, APIs, Docker, VEXP, environment mutation, or TCKDB writes.

## Product Candidate Lifecycle

1. `searchSymbolsFtsDetailed` returns `SearchSymbolsFtsDetailedResult`: ordered `SymbolSearchResult[]` plus source-body-free `SearchSymbolsFtsDiagnostics`.
2. Each result carries symbol/file identity, kind, scalar `score`, and `SymbolSearchMatch[]` with field, match type, and contribution. Diagnostics carry query variants, exact/path/FTS terms, lane counts/files, candidate union, rejection counts, fallback, and timings.
3. `rerankGraph` receives the ordered symbol-level `SymbolSearchResult[]` returned after the routed candidate-pool cap.
4. Candidates are lost at FTS admission/ranking and when `searchSymbolsFtsDetailed` slices to the candidate-pool size; `routeQuery` then slices graph results to `maxResults`.
5. `rerankGraph` adds no candidates. It only scores edges among the closed lexical candidate set.
6. It uses capped in-degree, out-degree, contains-neighbour, imports-neighbour, and connected-matched-candidate contributions.
7. The original lexical score and matches are preserved as `lexicalScore` and `matches`; only one aggregate lexical scalar survives, not lane-specific attribution.
8. Yes. A central/container/import node can add up to the configured graph caps and outrank direct evidence when lexical scores are close; product v1 has no hub/local-evidence guard.
9. Graph reranking operates on symbols. File identity is metadata only.
10. Multiple symbols in a file are not aggregated; they compete independently and can consume multiple result/packing slots.
11. `buildCapsule` receives `BuildCapsuleInput`: graph-ranked pivot candidates, a duplicate support projection of those candidates, a character budget, and a selected capsule profile.
12. It does not rescore relevance. It iterates the supplied pivot order, then independently orders projected supports by the profile support policy.
13. Candidates are removed by pivot/support count caps, duplicate symbol ids, role character sub-budgets, and total character budget. Content ladders compress full source to summary/signature/stub or skeleton/signature/summary/stub.
14. The first graph-ranked candidate that fits becomes the lead pivot.
15. Product v1 treats the profile-limited graph head as pivots/required and the projected remainder as support; it has no semantic model/schema/service role system.
16. File/symbol body size affects representation and whether an item fits, but not the incoming relevance order.
17. A strong candidate normally ladders to a smaller representation, but can still be excluded by count/sub-budget boundaries before a later weak support is considered.
18. Search has test-aware downweighting and documentation matching; there is no general explicit client/docs/test diversity bonus in final packing.
19. Product v1 does not understand model/schema/service roles.
20. Profile `maxPivotCount`/`maxSupportCount`, route `maxResults`, and the FTS candidate-pool cap bound final counts.

## Legacy Candidate Lifecycle

21. `hybridRetrieve` unions lexical FTS, shaped symbol/path seeds, failing-test-to-implementation, body-literal, graph expansion, and same-module candidates; it then computes normalized hybrid scores. `buildCapsuleV2` adds line/title/literal/direct-evidence anchors and production backfills, refines roles, expands co-edits/file evidence, and budget-packs pivots then supports.
22. Signals include FTS, BM25, exact/prefix/token symbol match, path match, domain, test-to-implementation, body literal, graph proximity, bounded centrality, actionability, hub penalties, and anchor/backfill/co-edit provenance.
23. Path/symbol/lexical are independent union lanes; graph expands the union; test import/call has its own component; co-edit/import/reference evidence is introduced in bounded support expansion. Final score uses documented hybrid weights and penalties.
24. Product v1 lacks shaped symbol/path union, BM25, domain/actionability, failing-test routing, body literals, graph expansion, hub penalties, title/literal/direct anchors, production backfill, co-edit support, and file-evidence rescue.
25. Legacy ranking is symbol-level through hybrid scoring; later support policies and rendering reason about distinct file paths. Co-edit and file-evidence rescue are file-aware.
26. Yes. Rare BM25 terms, likely symbols/paths, exact anchors, and direct-evidence floors preserve strong anchors beyond plain FTS overlap.
27. Generic-token lexical downweighting, bounded centrality, hub/actionability penalties, non-source/generic-infrastructure role refinement, and pivot ranking prevent generic infrastructure from becoming lead without local evidence.
28. Hidden/co-edit files come from test-to-implementation graph routes, graph/same-module expansion, bounded import/reference/package co-edit expansion, and exact file-evidence rescue.
29. Legacy uses token estimates, intent-tier pivot/support caps, full→signature→skeleton ladders, support skeleton cost, and bounded co-edit/file-evidence token fractions.
30. `hybridRetrieve`, its score components, query shaping, role refinement, Capsule v2 packing, and product adapter are already reusable primitives. The safest convergence is to make them authoritative rather than reimplement them.

## Product/Legacy Divergence

31. Yes. Routed product v1 is the older intent-routing/FTS/graph/capsule implementation; Capsule v2 evolved separately as the Stage 5 quality path.
32. The routed path supplied intent profiles and a character-budget product capsule; Capsule v2 later accumulated deterministic benchmark-driven retrieval and role policies.
33. M121 query variants/path diagnostics and the v1 orchestration response shape are not presently emitted by `hybridRetrieve`; impact, flow, memory, and M119 enrichment remain outer orchestration concerns.
34. Yes. M121 routed candidates can be a bounded rescue lane merged by symbol id into the hybrid union, with exact/path candidates admitted ahead of generic routed candidates.
35. Yes. `HybridCandidate.sources/evidence/scores` can retain routed rank, exact/path matches, and lexical contribution without outcome data.
36. Yes. Run routed search for diagnostics/rescue, then use the shared Capsule v2 selection and preserve the routed diagnostic object.
37. Yes. `buildCapsule` and `buildCapsuleV2` duplicate final selection today.
38. Yes. M119 `productContext` is selected by `buildCapsuleV2` even when the outer run-pipeline capsule was selected by routed product v1.
39. Yes. `run_pipeline`/`get_code_context` can contain a v1 outer capsule plus independently selected v2 `productContext`.
40. Capsule v2's legacy-quality retrieval/selection becomes authoritative; routed M121 search remains bounded rescue and diagnostics, not a second authority.

## M122 Loss Audit Protocol

41–50. The M123 evaluator will instrument actual routed raw results, graph results, Capsule v2 candidates/discards/final items, and the historical v2 view for every frozen expected file. It will record generation, raw rank/score/components/variants/lanes, graph rank/components, capsule consideration/rank/selection/role/exclusion, and legacy rank/components. No stage will be inferred solely from final output. The frozen M122 aggregate already establishes 23 product-loss cases; score changes are prohibited until the generated stage trace and taxonomy identify dominant stages.

## TCKDB Loss Audit Protocol

51–60. The exact unmodified query will be evaluated against a temporary VTRACE index of the read-only repository. For model, projection, public-reference infrastructure, schemas, migration, and verification, the trace will record generated symbols/files, raw rank, producing variants/lanes, score components, graph movement, displacing generic files, final boundary, legacy visibility, and the general corrective signal. The M122 evidence already shows model/projection/schema/migration/test candidates were generated below the routed cap while generic base, initializer, OpenAPI, and client exports survived; the audit must confirm this with stage data before freezing policy.

## Budget and Role Behavior

61. No. Product v1 converts fixture tokens to a four-character budget; Capsule v2 uses token estimates and intent allocations directly.
62. No. Product v1 accounts exact rendered characters; Capsule v2 uses its estimator over focused/skeleton representations.
63. Relevance order is size-independent, but profile count/sub-budget sequencing can allow compact later support while a large candidate fails; this will be traced.
64. Product v1 chooses a representation during selection; Capsule v2 also renders/compresses during packing. Structural support cost is known before committing each item.
65. Yes, and Capsule v2 already selects using rendered/compressed cost without raising total budget.
66. In both paths candidate/pivot ordering precedes final role rendering; Capsule v2 performs relevance-aware role refinement before packing.
67. Yes in product v1 because symbols, not files, consume slots. Capsule v2 has duplicate-file-aware support displacement but still needs trace coverage.
68. M122 TCKDB shows OpenAPI/client surfaces crowding out implementation evidence in product v1.
69. Yes, only among candidates above a relevance threshold.
70. Infer generic roles from symbol kind, path conventions, graph relation, and indexed structure: definition/model, behavior/service, schema/type, consumer/caller, test, migration/config, documentation. Diversity may break close relevant ties but never admit a weak file merely to fill a role.

## Frozen Architecture Decision

Select **Design D — legacy-quality shared core as authoritative product retrieval**.

The M123 authoritative route is:

```text
query shaping
  + hybrid legacy-quality union/scorer
  + bounded M121 routed exact/path/compound rescue (merged provenance)
  -> Capsule v2 role refinement and budget-aware selection
  -> one authoritative selected context
  -> M119/M120 enrichment and product adapters
```

The routed FTS result remains available for deterministic diagnostics and rescue attribution, but its graph-ranked capsule is no longer an independent final-selection authority. This is lower-risk than rebuilding every proven Capsule v2 signal in product v1 and directly satisfies the objective of one quality core and one selected result.

## Frozen Ranking/Fusion Policy

- Preserve direct exact identifier/path/file evidence and existing hybrid local-evidence signals.
- Merge duplicates by symbol id, union provenance/evidence, and retain the stronger component score; never duplicate a slot.
- Admit a bounded routed rescue set. Exact/path rescue may enter the candidate head; generic routed-only candidates remain behind organically strong hybrid candidates.
- Retain existing hybrid graph/centrality normalization, hub penalty, actionability penalty, generic-token downweighting, and deterministic tie-breaking.
- Aggregate final visibility by distinct file; multiple strong symbols help confidence but duplicate weak symbols cannot consume unlimited slots.
- Apply role diversity only after relevance qualification.
- Rank relevance before rendered cost; use existing compressed/skeleton ladders without increasing budgets.

## Evaluation Freeze

After implementation policy is frozen, run the frozen Django 20, cross-repository 30, exact TCKDB acceptance, synthetic graph/distractor controls, M121 metamorphic families, no-agent smoke, incremental/full equivalence, cross-tool parity, full tests, both typechecks, and `git diff --check`. Report legacy, product-v1, and product-v2 separately. This is retrospective frozen-corpus correction; no prospective-generalization or live-agent-effect claim will be made. Cross-repository workspace intelligence is deferred to M124.
