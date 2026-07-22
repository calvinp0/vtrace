# Stage 5 M122 Product-Path Retrieval Evaluation

## Summary

- Corpora evaluated: frozen Django-expanded 20 and cross-repository fixture 30 (50 total), TCKDB acceptance, synthetic metamorphic fixture.
- Product any-gold / lead-pivot recall: 50.0% / 30.0%.
- Legacy any-gold / lead-pivot recall: 92.0% / 80.0%.
- TCKDB acceptance: FAIL.
- Decision: C; verdict FAIL; recommendation: fix product retrieval before promotion.

## Motivation

M121 repaired a zero-candidate routed FTS failure, but the frozen evaluator called unchanged `buildCapsuleV2`. Candidate count alone does not prove that required files survive graph ranking and capsule packing.

## Retrieval Architecture

The product route is `runPipelineOrchestrator -> routeQuery -> searchSymbolsFtsDetailed -> rerankGraph -> buildCapsule`. The historical route is `buildCapsuleV2 -> hybridRetrieve`. They share index data and lower-level search primitives but diverge in candidate assembly, role selection, and packing.

## Evaluation Corpora

The frozen 50 retain tasks, labels, intents, budgets, and indexed workspaces unchanged. The M103 100-case artifact is not used because it lacks a frozen product-route workspace/index identity and explicit routed character-budget seam. No labels were improvised.

## Product-Path Baseline

`product-retrieval-v1`; M121 commit; max 20 reranked results; fixture budget converted with the established four-characters-per-token estimate; timings excluded from stable row projections.

## Frozen Product Metrics

- cases: 50
- top_1_file_recall: 0.3
- top_5_file_recall: 0.5
- any_gold_recall: 0.5
- all_gold_visible_recall: 0.46
- lead_pivot_recall: 0.3
- hidden_coedit_all_visible_recall: not available
- hidden_coedit_reason: Frozen fixtures label expected files but do not distinguish hidden/co-edit files.
- required_target_recall: not available
- required_target_reason: Frozen fixtures do not label required versus optional target roles.
- support_file_recall: not available
- support_file_reason: Frozen fixtures do not label support-role files.
- missing_count: 25
- wrong_pivot_count: 35
- overpacked_count: 0
- no_candidates_count: 0
- median_model_visible_tokens: 3192
- p90_model_visible_tokens: 5955
- median_selected_file_count: 3
- p90_selected_file_count: 4
- median_retrieval_latency_ms: 14.934
- p90_retrieval_latency_ms: 48.24

## Legacy versus Product

- cases: 50
- top_1_file_recall: 0.8
- top_5_file_recall: 0.92
- any_gold_recall: 0.92
- all_gold_visible_recall: 0.9
- lead_pivot_recall: 0.8
- hidden_coedit_all_visible_recall: not available
- hidden_coedit_reason: Frozen fixtures label expected files but do not distinguish hidden/co-edit files.
- required_target_recall: not available
- required_target_reason: Frozen fixtures do not label required versus optional target roles.
- support_file_recall: not available
- support_file_reason: Frozen fixtures do not label support-role files.
- missing_count: 4
- wrong_pivot_count: 10
- overpacked_count: 0
- no_candidates_count: 0
- median_model_visible_tokens: 1208
- p90_model_visible_tokens: 4046
- median_selected_file_count: 4
- p90_selected_file_count: 6
- median_retrieval_latency_ms: 2698.23
- p90_retrieval_latency_ms: 10514.825

Changed-case counts: {"ambiguous":26,"product_loss":23,"context_size_only":1}. Every row in the comparison JSON carries a classification and evidence summary.

## TCKDB Final-Context Acceptance

Exact query selected: backend/app/db/base.py, backend/app/api/public_openapi.py, clients/python/src/tckdb_client/__init__.py, clients/python/src/tckdb_client/scientific_types.py, backend/app/db/models/__init__.py, backend/app/schemas/workflows/thermo_upload.py, backend/app/api/routes/scientific/species_subresources.py. Coverage: {"model":false,"projection":false,"publicRef":true,"schema":false,"migrationOrVerification":true}. Stage classification: {"backend/app/db/base.py":"selected and visible","backend/app/db/models/reproducibility_assessment.py":"generated but low-ranked","backend/app/services/scientific_read/public_assessments.py":"generated but low-ranked","backend/app/services/public_refs.py":"reranked but not selected","backend/app/schemas/entities/reproducibility_assessment.py":"generated but low-ranked","backend/app/schemas/reads/scientific_assessment.py":"generated but low-ranked","backend/alembic/versions/d861dfd60891_create_intial_schema.py":"generated but low-ranked","backend/tests/services/test_public_refs.py":"generated but low-ranked","backend/app/api/public_openapi.py":"selected and visible","clients/python/src/tckdb_client/scientific_types.py":"selected but compressed"}. Candidate-only hits are not counted as final success.

The exact request produced 23 candidate files, 5,377 model-visible tokens, and a 28.617 ms routed retrieval call (32.823 ms including selection and the evaluator boundary). `PublicRefMixin` infrastructure was visible in selected full `backend/app/db/base.py`; the richer `services/public_refs.py` support reached reranking but was not packed. The assessment model and compact public projection were generated but ranked below the product result limit, so the user would still have to append identifiers to recover those core files.

## Compound-Query Robustness

Slash/path, identifier, punctuation, URL, stack-trace, version, and 16/17/32/48/96-term families were evaluated. Product admission is capped at 96 disjuncts and diagnostic variants at 32; no complete pairwise expansion is used. Detailed stability: `stage5_m122_compound_query_metamorphic.json`.

## Diagnostics

Rows preserve normalized query, variants, identifiers, path/FTS terms, lane counts, union size, rejections, graph additions, fallback and final reason, and retrieval timings. They contain paths/symbol identifiers but no source bodies.

Frozen-product timing (median / p90 / maximum milliseconds): normalization 0.131 / 0.257 / 0.586; combined path/identifier/FTS lane search 2.254 / 14.945 / 50.667; candidate merge 1.638 / 19.243 / 60.031; graph reranking 0.495 / 1.526 / 4.928; capsule selection 3.094 / 6.846 / 12.724; total product call 10.385 / 40.098 / 83.074. Variant construction is included in normalization and individual lane clocks are not available from the synchronous production seam.

## Implementation Changes

Evaluation harness, smoke, source-body-free candidate-union diagnostics, explicit product-mode path extraction, and bounded adjacent/high-information compound pairs. Historical callers retain legacy decomposition/path behavior.

## Product Evaluator Decision

C: fix product retrieval before promotion. Legacy names remain historical and are not overwritten.

## Invariants

Single-repository behavior, fail-closed freshness contract, existing index snapshots, M119 response schema, M120 impact semantics, and no-gold product inputs were preserved.

## Limitations

Static retrieval only; approximate token accounting; timing is noisy and excluded from byte comparisons; Markdown coverage depends on indexed symbols; no live-agent-effect claim; 100-case product scoring is not yet compatible.

## Deferred Work

M123 cross-repository workspace intelligence; tokenizer-exact accounting; Markdown indexing if independently justified; live comparison only after readiness audit.

## Success Criteria Check

The real product route, frozen 50, row comparison, exact TCKDB query, metamorphic fixture, diagnostics, incremental/full smoke, response compatibility, and offline verification were exercised. The milestone does not pass because product any-gold recall is 50% versus legacy 92%, and the exact TCKDB final context omits the model, projection, and assessment schemas. Unsupported role metrics are explicitly marked rather than inferred.

## Verdict

FAIL

## Recommendation

fix product retrieval before promotion
