# Stage 5 M125 TCKDB Acceptance and Product Retrieval Latency

## Summary

- TCKDB availability: available at `<TCKDB_ROOT>`, current `main` HEAD `70ff50381f42551a825d75874ea2d70f6dbe08ec`.
- Actual acceptance: PASS on an isolated full index; TCKDB source and in-place index remained read-only.
- Latency root cause: authoritative hybrid core dominates; routed rescue is tens of milliseconds, while repeated v2 builds multiplied the core cost at wrapper level.
- Implementation: generic weak-stem filtering, deterministic lazy routed rescue, one request-local authoritative result, and non-overlapping stage clocks.
- Verdict: **MIXED**.
- Recommendation: **promote quality but continue latency optimization**.

## Pre-change Architecture

`run_pipeline` ran routed FTS/graph, authoritative Capsule v2, an optional second v2 product section, and a third v2 build inside `productContext`. `get_context_capsule` built v2 twice. Routed candidates did not influence M123 selection.

## TCKDB Repository State

The existing run-12 index was stale at `3ecc25d...` and failed closed with `index_schema_changed`. The tested isolated full index represents `70ff50381f42551a825d75874ea2d70f6dbe08ec`: 960 scanned, 959 indexed, 23,096 symbols, 47,780 relationships, 42712.115 ms. No TCKDB source or in-place `.vtrace` state was changed.

## Actual TCKDB Acceptance

Exact query:

```text
Add a stable public reference for the exact immutable reproducibility assessment surfaced in compact assessment summaries across thermo, kinetics, statmech, and transport. Determine whether assessment models already have an appropriate public_ref; trace immutability/supersession, schemas, migrations, projection builders, OpenAPI, tests, docs, and Python client types.
```

Lead pivot: `backend/app/services/scientific_read/public_assessments.py`.

Selected files:

- `backend/app/services/scientific_read/public_assessments.py`
- `backend/app/schemas/reads/scientific_assessment.py`
- `backend/app/db/base.py`
- `backend/app/db/models/thermo.py`
- `clients/python/src/tckdb_client/scientific_types.py`
- `backend/app/db/models/reproducibility_assessment.py`

Visibility: model=true, projection=true, public-ref=true, schema=true, migration=false, test=false, OpenAPI=false, client=true.

Cross-tool parity: PASS; authority `product-retrieval-v2`, ranking `hybrid-shared-core+routed-rescue-v1`.

## Candidate Lifecycle

The JSON artifact records hybrid score/rank, routed-rescue decision, projected graph/capsule rank, role, visibility, and exclusion reason. Rescue: `{"attempted":true,"trigger":"low_compound_coverage","missing_clues":["assessment models","supersession schemas","schemas migrations","migrations projection","projection builders","builders openapi","openapi tests","tests docs","docs python"],"candidates_added":1,"selected_candidates_added":1,"timing_ms":31.139508000000205}`.

## Latency Profile

| Stage | median ms | p90 ms | max ms |
| --- | ---: | ---: | ---: |
| Routed only | 27.444 | 29.375 | 29.375 |
| Hybrid/v2 only | 7528.372 | 7580.136 | 7580.136 |
| M123 stored single authority | 2629.906 | 10501.043 | — |
| Combined post-change | 7650.591 | 7676.875 | 7676.875 |
| Product enrichment from selection | 50.742 | 55.048 | 55.048 |

Cold first handle/call: 7347.984 ms. Warm different-task: median 3394.428 ms, p90 3413.427 ms.

## Root Cause

The authoritative hybrid core dominates. Routed FTS is only tens of milliseconds. Wrapper-level duplicate v2 builds multiplied the multi-second core; request-local reuse removes those repeats. Database opening, enrichment, impact, memory/rules, and rendering are not the primary bottleneck.

## Optimization

Routed rescue is skipped with `authoritative_context_sufficient`. It runs for no candidates, missing exact identifier, missing standalone path, or at least two unmatched high-information artifact clauses in a task of at least 28 significant words. It adds at most two source-backed support items from a bounded 100-result routed pool. No persistent cache was added; reuse is request-local and bound to the already-open database/index snapshot.

## Quality Regression

Frozen combined metrics:

```json
{
  "cases": 50,
  "top_1_file_recall": 0.78,
  "top_5_file_recall": 0.92,
  "any_gold_recall": 0.92,
  "all_gold_visible_recall": 0.9,
  "lead_pivot_recall": 0.78,
  "hidden_coedit_all_visible_recall": "not available",
  "hidden_coedit_reason": "Frozen fixtures label expected files but do not distinguish hidden/co-edit files.",
  "required_target_recall": "not available",
  "required_target_reason": "Frozen fixtures do not label required versus optional target roles.",
  "support_file_recall": "not available",
  "support_file_reason": "Frozen fixtures do not label support-role files.",
  "missing_count": 4,
  "wrong_pivot_count": 11,
  "overpacked_count": 2,
  "no_candidates_count": 0,
  "median_model_visible_tokens": 1282,
  "p90_model_visible_tokens": 4116,
  "median_selected_file_count": 4,
  "p90_selected_file_count": 6,
  "median_retrieval_latency_ms": 2657.61,
  "p90_retrieval_latency_ms": 10652.107
}
```

Frozen 20-case metrics:

```json
{
  "cases": 20,
  "top_1_file_recall": 0.9,
  "top_5_file_recall": 1,
  "any_gold_recall": 1,
  "all_gold_visible_recall": 0.95,
  "lead_pivot_recall": 0.9,
  "hidden_coedit_all_visible_recall": "not available",
  "hidden_coedit_reason": "Frozen fixtures label expected files but do not distinguish hidden/co-edit files.",
  "required_target_recall": "not available",
  "required_target_reason": "Frozen fixtures do not label required versus optional target roles.",
  "support_file_recall": "not available",
  "support_file_reason": "Frozen fixtures do not label support-role files.",
  "missing_count": 0,
  "wrong_pivot_count": 2,
  "overpacked_count": 1,
  "no_candidates_count": 0,
  "median_model_visible_tokens": 1264,
  "p90_model_visible_tokens": 2501,
  "median_selected_file_count": 4,
  "p90_selected_file_count": 6,
  "median_retrieval_latency_ms": null,
  "p90_retrieval_latency_ms": null
}
```

Frozen 30-case metrics:

```json
{
  "cases": 30,
  "top_1_file_recall": 0.7,
  "top_5_file_recall": 0.867,
  "any_gold_recall": 0.867,
  "all_gold_visible_recall": 0.867,
  "lead_pivot_recall": 0.7,
  "hidden_coedit_all_visible_recall": "not available",
  "hidden_coedit_reason": "Frozen fixtures label expected files but do not distinguish hidden/co-edit files.",
  "required_target_recall": "not available",
  "required_target_reason": "Frozen fixtures do not label required versus optional target roles.",
  "support_file_recall": "not available",
  "support_file_reason": "Frozen fixtures do not label support-role files.",
  "missing_count": 4,
  "wrong_pivot_count": 9,
  "overpacked_count": 1,
  "no_candidates_count": 0,
  "median_model_visible_tokens": 1486,
  "p90_model_visible_tokens": 5473,
  "median_selected_file_count": 5,
  "p90_selected_file_count": 6,
  "median_retrieval_latency_ms": null,
  "p90_retrieval_latency_ms": null
}
```

Unexplained selected-file losses versus M123: 0. Changed cases: django__django-11490, django__django-11740, django__django-11133, django__django-13012, django__django-13112, sympy__sympy-12481, scikit-learn__scikit-learn-11578, matplotlib__matplotlib-22719, astropy__astropy-14369, sphinx-doc__sphinx-7748, sympy__sympy-15599.

The frozen lead divergence is `psf__requests-1724`: legacy led with `requests/sessions.py`; M123 product v2 led with `requests/api.py` and additionally selected that API file. It is a v2 role/pivot-order difference, not product-context reordering.

## Compound-Query Preservation

Synthetic controls cover hybrid sufficient/skip, compound rescue, missing exact identifier, standalone path, no context, and source-body-free diagnostics. Exact path rescue remains active for the M121-style explicit-path case.

## Worktree and Index Invariants

M114 worktree identity and fail-closed freshness are preserved. M118 source parsing/index state was not written in TCKDB. A temporary source copy excluding `.git`, `.vtrace`, and untracked `paper/` produced the same selection/lead/roles for a full rebuild and a subsequent incremental no-op (PASS).

## Limitations

- Cold timing is a first call on a fresh SQLite handle in the same process, not an OS-cache-independent process benchmark.
- The hybrid core remains intrinsically multi-second on TCKDB.
- No live-agent effect or untouched-holdout claim is made.
- Token accounting remains character-ratio estimated.

## Deferred Work

- Deeper hybrid-core optimization.
- Cross-repository workspace intelligence.
- Tokenizer-exact accounting.
- Prospective product-path validation.

## Success Criteria Check

Actual current-main TCKDB visibility and cross-tool authority pass. Duplicate hybrid builds are removed and routed rescue is lazy. Frozen quality pass=true. The preferred overhead ratio pass=true. Isolated full/incremental same-source parity pass=true.

## Verdict

**MIXED**

## Recommendation

**promote quality but continue latency optimization**
