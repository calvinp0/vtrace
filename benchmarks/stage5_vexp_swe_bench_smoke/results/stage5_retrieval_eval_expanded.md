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
| instances_total | 20 |
| instances_evaluated | 20 |
| workspace_error_count | 0 |
| no_context_count | 0 |
| top_1_file_accuracy | 75.0% |
| top_3_file_recall | 90.0% |
| expected_file_as_pivot_rate | 80.0% |
| expected_file_as_support_rate | 15.0% |
| expected_file_discarded_rate | 5.0% |
| expected_file_missing_rate | 0.0% |
| expected_symbol_hit_rate | 70.0% |
| expected_symbol_as_pivot_rate | 55.0% |
| mean_capsule_tokens | 900.8 |
| mean_pivot_count | 1.85 |
| mean_support_count | 4.00 |

## Aggregate metrics — by label source

### gold_patch (preferred — SWE-bench reference patch)

| metric | value |
| --- | --- |
| instances_total | 15 |
| instances_evaluated | 15 |
| workspace_error_count | 0 |
| no_context_count | 0 |
| top_1_file_accuracy | 66.7% |
| top_3_file_recall | 86.7% |
| expected_file_as_pivot_rate | 73.3% |
| expected_file_as_support_rate | 20.0% |
| expected_file_discarded_rate | 6.7% |
| expected_file_missing_rate | 0.0% |
| expected_symbol_hit_rate | 73.3% |
| expected_symbol_as_pivot_rate | 53.3% |
| mean_capsule_tokens | 864.0 |
| mean_pivot_count | 1.80 |
| mean_support_count | 4.00 |

### manual_verified (hand-curated and checked)

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

## Metrics by repo

| repo | instances | top-1 file | top-3 file | as pivot | missing | mean tokens | mean pivots | mean support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django/django | 20/20 | 75.0% | 90.0% | 80.0% | 0.0% | 900.8 | 1.85 | 4.00 |

## Miss taxonomy

| category | count |
| --- | --- |
| none | 18 |
| present_but_support | 1 |
| present_but_discarded | 1 |

## Per-instance results

| instance | label | expected file | top pivot | role | top-1? | top-3? | result | miss category |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-10880 | manual_verified | django/db/models/aggregates.py | django/db/models/aggregates.py::Count | pivot | yes | yes | hit_top1_pivot | none |
| django__django-11095 | manual_verified | django/contrib/admin/options.py | django/contrib/admin/options.py::get_inline_instances | pivot | yes | yes | hit_top1_pivot | none |
| django__django-11490 | manual_verified | django/db/models/sql/compiler.py | django/db/models/sql/compiler.py::get_combinator_sql | pivot | yes | yes | hit_top1_pivot | none |
| django__django-11728 | manual_verified | django/contrib/admindocs/utils.py | django/contrib/admindocs/utils.py::replace_named_groups | pivot | yes | yes | hit_top1_pivot | none |
| django__django-11740 | manual_verified | django/db/migrations/autodetector.py | django/db/migrations/autodetector.py::_get_dependencies_for_foreign_key | pivot | yes | yes | hit_top1_pivot | none |
| django__django-10973 | gold_patch | django/db/backends/postgresql/client.py | contrib/postgres/fields/array.py::run_validators | support | no | yes | hit_top3 | none |
| django__django-11133 | gold_patch | django/http/response.py | http/response.py::write | pivot | yes | yes | hit_top1_pivot | none |
| django__django-11206 | gold_patch | django/utils/numberformat.py | utils/formats.py::number_format | support | no | yes | hit_top3 | none |
| django__django-11749 | gold_patch | django/core/management/__init__.py | core/management/__init__.py::call_command | pivot | yes | yes | hit_top1_pivot | none |
| django__django-11815 | gold_patch | django/db/migrations/serializer.py | db/migrations/serializer.py::EnumSerializer | pivot | yes | yes | hit_top1_pivot | none |
| django__django-11820 | gold_patch | django/db/models/base.py | db/models/base.py::_check_ordering | pivot | yes | yes | hit_top1_pivot | none |
| django__django-12050 | gold_patch | django/db/models/sql/query.py | db/models/sql/query.py::resolve_lookup_value | pivot | yes | yes | hit_top1_pivot | none |
| django__django-12273 | gold_patch | django/db/models/base.py | forms/models.py::save | pivot | no | yes | hit_top3 | none |
| django__django-12276 | gold_patch | django/forms/widgets.py | forms/widgets.py::use_required_attribute | pivot | yes | yes | hit_top1_pivot | none |
| django__django-12325 | gold_patch | django/db/models/base.py | core/checks/model_checks.py::_check_lazy_references | support | no | no | hit_support | present_but_support |
| django__django-12774 | gold_patch | django/db/models/query.py | db/models/query.py::in_bulk | pivot | yes | yes | hit_top1_pivot | none |
| django__django-12858 | gold_patch | django/db/models/base.py | db/models/base.py::_check_ordering | pivot | yes | yes | hit_top1_pivot | none |
| django__django-13012 | gold_patch | django/db/models/expressions.py | db/models/expressions.py::ExpressionWrapper | pivot | yes | yes | hit_top1_pivot | none |
| django__django-13112 | gold_patch | django/db/models/fields/related.py | contrib/admin/utils.py::FieldIsAForeignKeyColumnName | discarded | no | no | hit_discarded | present_but_discarded |
| django__django-13195 | gold_patch | django/contrib/messages/storage/cookie.py | http/response.py::delete_cookie | pivot | yes | yes | hit_top1_pivot | none |

## Misses / failures — top-k diagnostics

### django__django-12325 — hit_support / present_but_support

- expected: django/db/models/base.py, django/db/models/options.py
- reason: —
- down-weighted lexical tokens: multiple
- top pivots:
  - core/checks/model_checks.py::_check_lazy_references — actionable function — strong lexical match; issue-domain relevance
- top support:
  - db/models/fields/reverse_related.py::ManyToOneRel — generic infrastructure outside the issue's subsystem (class) — support only without direct failing-test or issue evidence
  - db/models/sql/query.py::setup_joins — generic infrastructure outside the issue's subsystem (method) — support only without direct failing-test or issue evidence
  - db/backends/ddl_references.py::TableColumns — generic infrastructure outside the issue's subsystem (class) — support only without direct failing-test or issue evidence
  - db/models/options.py::setup_pk — generic infrastructure outside the issue's subsystem (method) — support only without direct failing-test or issue evidence
- top discarded:
  - db/backends/ddl_references.py::Columns — beyond standard support budget (max 4)
  - db/models/fields/related_descriptors.py::ReverseManyToOneDescriptor — beyond standard support budget (max 4)
  - db/models/sql/compiler.py::pre_sql_setup — beyond standard support budget (max 4)
  - db/backends/sqlite3/schema.py::_is_referenced_by_fk_constraint — beyond standard support budget (max 4)
  - conf/__init__.py::_setup — beyond standard support budget (max 4)

### django__django-13112 — hit_discarded / present_but_discarded

- expected: django/db/models/fields/related.py
- reason: expected file recovered but discarded: db/models/fields/related.py — beyond standard support budget (max 4)
- filtered generic symbols: error
- filtered runner files: manage.py
- top pivots:
  - contrib/admin/utils.py::FieldIsAForeignKeyColumnName — actionable class — strong lexical match; issue-domain relevance
  - db/migrations/autodetector.py::_get_dependencies_for_foreign_key — actionable method — strong lexical match; issue-domain relevance; 6 dependents
- top support:
  - db/backends/ddl_references.py::ForeignKeyName — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance
  - db/backends/oracle/operations.py::__foreign_key_constraints — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - db/backends/sqlite3/introspection.py::_get_foreign_key_constraints — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - forms/models.py::_get_foreign_key — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance
- top discarded:
  - contrib/gis/utils/layermapping.py::MissingForeignKey — beyond standard support budget (max 4)
  - contrib/contenttypes/fields.py::GenericForeignKey — beyond standard support budget (max 4)
  - db/models/fields/json.py::KeyTransformIEndsWith — beyond standard support budget (max 4)
  - db/models/fields/json.py::KeyTransformIStartsWith — beyond standard support budget (max 4)
  - db/models/fields/reverse_related.py::get_accessor_name — beyond standard support budget (max 4)

## Notes

- `expected_files` / `expected_symbols` are EVALUATION LABELS only. They are
  read from the fixture to score the capsule and are NEVER passed into Capsule
  v2 retrieval — production retrieval receives only `(task, intent, budget)`.
- No instance IDs or expected paths are hardcoded in production Capsule v2 logic.
- This stage measures retrieval quality only; it runs no Claude, Docker, or
  vexp agent execution and makes no API calls.
- `passing_model_patch` labels are reported separately: a miss against one may
  reflect a valid ALTERNATIVE fix site rather than a retrieval failure.
