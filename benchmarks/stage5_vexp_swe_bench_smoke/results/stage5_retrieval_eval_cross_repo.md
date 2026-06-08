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
| instances_total | 16 |
| instances_evaluated | 16 |
| workspace_error_count | 0 |
| no_context_count | 0 |
| top_1_file_accuracy | 62.5% |
| top_3_file_recall | 81.3% |
| expected_file_as_pivot_rate | 75.0% |
| expected_file_as_support_rate | 12.5% |
| expected_file_discarded_rate | 6.3% |
| expected_file_missing_rate | 6.3% |
| expected_symbol_hit_rate | 68.8% |
| expected_symbol_as_pivot_rate | 18.8% |
| mean_capsule_tokens | 1692.9 |
| mean_pivot_count | 2.00 |
| mean_support_count | 4.00 |

## Aggregate metrics — by label source

All 16 instances share one label source (gold_patch); see the table above.

## Metrics by repo

| repo | instances | top-1 file | top-3 file | as pivot | missing | mean tokens | mean pivots | mean support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy/sympy | 3/3 | 66.7% | 100.0% | 100.0% | 0.0% | 2101.3 | 2.00 | 4.00 |
| astropy/astropy | 2/2 | 50.0% | 50.0% | 50.0% | 50.0% | 945.5 | 2.00 | 4.00 |
| matplotlib/matplotlib | 2/2 | 0.0% | 100.0% | 50.0% | 0.0% | 396.0 | 2.00 | 4.00 |
| psf/requests | 2/2 | 50.0% | 50.0% | 50.0% | 0.0% | 478.0 | 2.00 | 4.00 |
| pytest-dev/pytest | 2/2 | 100.0% | 100.0% | 100.0% | 0.0% | 860.0 | 2.00 | 4.00 |
| scikit-learn/scikit-learn | 2/2 | 100.0% | 100.0% | 100.0% | 0.0% | 3719.5 | 2.00 | 4.00 |
| sphinx-doc/sphinx | 2/2 | 50.0% | 50.0% | 50.0% | 0.0% | 1195.5 | 2.00 | 4.00 |
| pallets/flask | 1/1 | 100.0% | 100.0% | 100.0% | 0.0% | 5594.0 | 2.00 | 4.00 |

## Miss taxonomy

| category | count |
| --- | --- |
| none | 13 |
| present_but_support | 1 |
| present_but_discarded | 1 |
| body_literal_not_resolved | 1 |

## Per-instance results

| instance | label | expected file | top pivot | role | top-1? | top-3? | result | miss category |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-12419 | gold_patch | sympy/matrices/expressions/matexpr.py | sympy/matrices/expressions/matexpr.py::ZeroMatrix | pivot | yes | yes | hit_top1_pivot | none |
| sympy__sympy-12481 | gold_patch | sympy/combinatorics/permutations.py | sympy/combinatorics/permutations.py::Permutation | pivot | yes | yes | hit_top1_pivot | none |
| sympy__sympy-13372 | gold_patch | sympy/core/evalf.py | sympy/core/sympify.py::sympify | pivot | no | yes | hit_top3 | none |
| scikit-learn__scikit-learn-10844 | gold_patch | sklearn/metrics/cluster/supervised.py | sklearn/metrics/cluster/supervised.py::fowlkes_mallows_score | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-11578 | gold_patch | sklearn/linear_model/logistic.py | sklearn/linear_model/logistic.py::predict_proba | pivot | yes | yes | hit_top1_pivot | none |
| matplotlib__matplotlib-22719 | gold_patch | lib/matplotlib/category.py | lib/matplotlib/_api/deprecation.py::MatplotlibDeprecationWarning | support | no | yes | hit_top3 | none |
| matplotlib__matplotlib-24627 | gold_patch | lib/matplotlib/axes/_base.py | lib/matplotlib/figure.py::clf | pivot | no | yes | hit_top3 | none |
| astropy__astropy-14365 | gold_patch | astropy/io/ascii/qdp.py | astropy/io/ascii/qdp.py::_write_table_qdp | pivot | yes | yes | hit_top1_pivot | none |
| astropy__astropy-14369 | gold_patch | astropy/units/format/cds.py | astropy/io/ascii/mrt.py::Mrt | missing | no | no | missing | body_literal_not_resolved |
| pytest-dev__pytest-10051 | gold_patch | src/_pytest/logging.py | src/_pytest/logging.py::get_records | pivot | yes | yes | hit_top1_pivot | none |
| pytest-dev__pytest-5262 | gold_patch | src/_pytest/capture.py | src/_pytest/capture.py::EncodedFile | pivot | yes | yes | hit_top1_pivot | none |
| sphinx-doc__sphinx-7462 | gold_patch | sphinx/domains/python.py | sphinx/addnodes.py::index | support | no | no | hit_support | present_but_support |
| sphinx-doc__sphinx-7748 | gold_patch | sphinx/ext/autodoc/__init__.py | sphinx/ext/autodoc/__init__.py::DocstringSignatureMixin | pivot | yes | yes | hit_top1_pivot | none |
| psf__requests-1142 | gold_patch | requests/models.py | requests/models.py::prepare_content_length | pivot | yes | yes | hit_top1_pivot | none |
| psf__requests-1724 | gold_patch | requests/sessions.py | requests/utils.py::stream_decode_response_unicode | discarded | no | no | hit_discarded | present_but_discarded |
| pallets__flask-5014 | gold_patch | src/flask/blueprints.py | src/flask/blueprints.py::Blueprint | pivot | yes | yes | hit_top1_pivot | none |

## Misses / failures — top-k diagnostics

### astropy__astropy-14369 — missing / body_literal_not_resolved

- expected: astropy/units/format/cds.py, astropy/units/format/cds_parsetab.py
- reason: expected file not surfaced (candidate_count=25)
- top pivots:
  - astropy/io/ascii/mrt.py::Mrt — actionable class — symbol-name match; lexical match; issue-domain relevance
  - astropy/io/ascii/mrt.py::MrtSplitter — actionable class — symbol-name match; lexical match; issue-domain relevance
- top support:
  - astropy/io/ascii/mrt.py::MrtData — strong target beyond the pivot budget — actionable class — symbol-name match; lexical match; issue-domain relevance
  - astropy/io/ascii/mrt.py::MrtHeader — strong target beyond the pivot budget — actionable class — symbol-name match; lexical match; issue-domain relevance
  - astropy/io/ascii/mrt.py::MRT_TEMPLATE — symbol-name match; lexical match; issue-domain relevance (not a pivot: module_constant is a low-actionability edit target)
  - astropy/io/ascii/mrt.py::write — lexical match; issue-domain relevance; graph/import neighbour (not a pivot: no direct evidence (graph/domain reach only))
- top discarded:
  - astropy/io/ascii/cds.py::CdsData — beyond standard support budget (max 4)
  - astropy/io/ascii/mrt.py::_set_column_val_limits — beyond standard support budget (max 4)
  - astropy/io/ascii/cparser.pyx::FileString — beyond standard support budget (max 4)
  - astropy/io/ascii/cparser.pyx::__dealloc__ — beyond standard support budget (max 4)
  - astropy/io/ascii/cparser.pyx::__getitem__ — beyond standard support budget (max 4)

### sphinx-doc__sphinx-7462 — hit_support / present_but_support

- expected: sphinx/domains/python.py, sphinx/pycode/ast.py
- reason: —
- down-weighted lexical tokens: error, bug
- top pivots:
  - sphinx/addnodes.py::index — actionable class — strong lexical match; issue-domain relevance; 56 dependents
  - sphinx/application.py::add_object_type — actionable method — strong lexical match; issue-domain relevance
- top support:
  - sphinx/domains/__init__.py::Index — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance
  - sphinx/domains/index.py::entries — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - sphinx/domains/index.py::run — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - sphinx/domains/python.py::_parse_annotation — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance
- top discarded:
  - sphinx/domains/__init__.py::IndexEntry — beyond standard support budget (max 4)
  - sphinx/roles.py::indexmarkup_role — beyond standard support budget (max 4)
  - sphinx/roles.py::Index — beyond standard support budget (max 4)
  - sphinx/application.py::add_crossref_type — beyond standard support budget (max 4)
  - sphinx/roles.py::index_role — beyond standard support budget (max 4)

### psf__requests-1724 — hit_discarded / present_but_discarded

- expected: requests/sessions.py
- reason: expected file recovered but discarded: requests/sessions.py — beyond standard support budget (max 4)
- down-weighted lexical tokens: error
- top pivots:
  - requests/utils.py::stream_decode_response_unicode — local implementation helper whose name matches the issue — likely edit site
  - requests/packages/urllib3/exceptions.py::DecodeError — actionable class — strong lexical match; issue-domain relevance
- top support:
  - requests/structures.py::CaseInsensitiveDict — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance; 25 dependents
  - requests/packages/urllib3/exceptions.py::PoolError — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance
  - requests/packages/urllib3/connectionpool.py::HTTPConnectionPool — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance
  - requests/api.py::request — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance; 7 dependents
- top discarded:
  - requests/models.py::Request — beyond standard support budget (max 4)
  - requests/packages/urllib3/exceptions.py::HTTPError — beyond standard support budget (max 4)
  - requests/packages/urllib3/connectionpool.py::_get_timeout — beyond standard support budget (max 4)
  - requests/packages/urllib3/request.py::RequestMethods — beyond standard support budget (max 4)
  - requests/packages/urllib3/util.py::Timeout — beyond standard support budget (max 4)

## Notes

- `expected_files` / `expected_symbols` are EVALUATION LABELS only. They are
  read from the fixture to score the capsule and are NEVER passed into Capsule
  v2 retrieval — production retrieval receives only `(task, intent, budget)`.
- No instance IDs or expected paths are hardcoded in production Capsule v2 logic.
- This stage measures retrieval quality only; it runs no Claude, Docker, or
  vexp agent execution and makes no API calls.
- `passing_model_patch` labels are reported separately: a miss against one may
  reflect a valid ALTERNATIVE fix site rather than a retrieval failure.
