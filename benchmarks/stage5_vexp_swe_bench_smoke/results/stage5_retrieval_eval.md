# Stage 5R — Capsule v2 Retrieval-Quality Evaluation

## Scope

**This is deterministic retrieval-quality evaluation only.**

- It does **not** run Claude.
- It does **not** run Docker.
- It does **not** run any vexp agent execution and makes **no API calls**.
- It does **not** measure token / cost / duration (those are the LIVE Stage 5
  benchmark, reported separately).
- Expected labels (`expected_files` / `expected_symbols`) are **evaluation-only**
  and are **never** passed into Capsule v2 retrieval.

It evaluates Capsule v2 retrieval quality on a fixed fixture of SWE-bench
instances with known edit targets, asking one question per instance: does the
capsule put the known edited file/symbol in the top-1 pivot, top-3, support,
discarded, or nowhere?

## Methodology

For each instance the indexed workspace is opened and Capsule v2 is built from
`(task, intent, budget)` ALONE via `buildCapsuleV2`. The resulting pivots /
support / discarded are compared against the fixture's `expected_files` and
`expected_symbols` (evaluation labels from known patches). File rank is the
1-based position in the de-duplicated pivots-then-support file ranking.

- **pivot** = likely edit site · **support** = useful context ·
**discard** = test/generic/over-budget · **missing** = not surfaced.

## Aggregate metrics — all instances

| metric | value |
| --- | --- |
| instances_total | 5 |
| instances_evaluated | 5 |
| workspace_error_count | 0 |
| no_context_count | 0 |
| top_1_file_accuracy | 100.0% |
| top_3_file_recall | 100.0% |
| expected_file_as_pivot_rate | 100.0% |
| expected_file_as_support_rate | 0.0% |
| expected_file_discarded_rate | 0.0% |
| expected_file_missing_rate | 0.0% |
| expected_symbol_hit_rate | 60.0% |
| expected_symbol_as_pivot_rate | 60.0% |
| mean_capsule_tokens | 1011.0 |
| mean_pivot_count | 2.00 |
| mean_support_count | 4.00 |

## Aggregate metrics — by label source

All 5 instances share one label source (manual_verified); see the table above.

## Miss taxonomy

| category | count |
| --- | --- |
| none | 5 |

## Per-instance results

| instance | label | expected file | top pivot | role | top-1? | top-3? | result | miss category |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-10880 | manual_verified | django/db/models/aggregates.py | django/db/models/aggregates.py::Count | pivot | yes | yes | hit_top1_pivot | none |
| django__django-11095 | manual_verified | django/contrib/admin/options.py | django/contrib/admin/options.py::get_inline_instances | pivot | yes | yes | hit_top1_pivot | none |
| django__django-11490 | manual_verified | django/db/models/sql/compiler.py | django/db/models/sql/compiler.py::get_combinator_sql | pivot | yes | yes | hit_top1_pivot | none |
| django__django-11728 | manual_verified | django/contrib/admindocs/utils.py | django/contrib/admindocs/utils.py::replace_named_groups | pivot | yes | yes | hit_top1_pivot | none |
| django__django-11740 | manual_verified | django/db/migrations/autodetector.py | django/db/migrations/autodetector.py::_get_dependencies_for_foreign_key | pivot | yes | yes | hit_top1_pivot | none |

## Misses / failures — top-k diagnostics

None — every evaluated instance surfaced its expected edit target in the top-3.

## Notes

- `expected_files` / `expected_symbols` are EVALUATION LABELS only. They are
  read from the fixture to score the capsule and are NEVER passed into Capsule
  v2 retrieval — production retrieval receives only `(task, intent, budget)`.
- No instance IDs or expected paths are hardcoded in production Capsule v2 logic.
- This stage measures retrieval quality only; it runs no Claude, Docker, or
  vexp agent execution and makes no API calls.
- `passing_model_patch` labels are reported separately: a miss against one may
  reflect a valid ALTERNATIVE fix site rather than a retrieval failure.
