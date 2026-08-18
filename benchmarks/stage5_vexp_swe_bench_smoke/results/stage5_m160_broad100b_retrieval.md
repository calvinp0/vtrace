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
| instances_total | 100 |
| instances_evaluated | 100 |
| workspace_error_count | 0 |
| no_context_count | 1 |
| top_1_file_accuracy | 41.0% |
| top_3_file_recall | 64.0% |
| expected_file_as_pivot_rate | 58.0% |
| expected_file_as_support_rate | 13.0% |
| expected_file_discarded_rate | 16.0% |
| expected_file_missing_rate | 13.0% |
| expected_symbol_hit_rate | 63.0% |
| expected_symbol_as_pivot_rate | 30.0% |
| mean_capsule_tokens | 2145.1 |
| mean_pivot_count | 2.19 |
| mean_support_count | 3.72 |

## Aggregate metrics — by label source

All 100 instances share one label source (gold_patch); see the table above.

## Metrics by repo

| repo | instances | top-1 file | top-3 file | as pivot | missing | mean tokens | mean pivots | mean support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| astropy/astropy | 11/11 | 18.2% | 63.6% | 54.5% | 0.0% | 2743.5 | 2.64 | 3.36 |
| django/django | 11/11 | 45.5% | 72.7% | 63.6% | 0.0% | 778.9 | 2.27 | 3.73 |
| matplotlib/matplotlib | 11/11 | 27.3% | 45.5% | 45.5% | 18.2% | 2547.0 | 2.27 | 3.73 |
| pydata/xarray | 11/11 | 36.4% | 54.5% | 54.5% | 9.1% | 2058.9 | 2.27 | 3.73 |
| pytest-dev/pytest | 11/11 | 36.4% | 72.7% | 54.5% | 27.3% | 1830.1 | 2.09 | 3.82 |
| scikit-learn/scikit-learn | 11/11 | 81.8% | 90.9% | 90.9% | 9.1% | 4098.6 | 2.45 | 3.55 |
| sphinx-doc/sphinx | 11/11 | 36.4% | 54.5% | 45.5% | 36.4% | 1361.1 | 1.82 | 3.64 |
| sympy/sympy | 10/10 | 60.0% | 70.0% | 60.0% | 10.0% | 2779.5 | 2.00 | 4.00 |
| pylint-dev/pylint | 8/8 | 25.0% | 62.5% | 62.5% | 12.5% | 1369.3 | 2.13 | 3.88 |
| psf/requests | 4/4 | 50.0% | 50.0% | 50.0% | 0.0% | 840.0 | 1.50 | 4.00 |
| mwaskom/seaborn | 1/1 | 0.0% | 0.0% | 0.0% | 0.0% | 2797.0 | 2.00 | 4.00 |

## Miss summary (compact)

- non-top-3 cases: 36
- missing (not surfaced): 5
- present-but-support: 7
- present-but-discarded: 15
- wrong-subsystem: 5
- body-literal misses: 2
- parser/language gaps: 0

## Miss taxonomy

| category | count |
| --- | --- |
| none | 64 |
| missing_from_candidates | 5 |
| present_but_support | 7 |
| present_but_discarded | 15 |
| wrong_subsystem | 5 |
| line_anchor_not_resolved | 1 |
| body_literal_not_resolved | 2 |
| test_symbol_pollution | 1 |

## Per-instance results

| instance | label | expected file | top pivot | role | top-1? | top-3? | result | miss category |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| astropy__astropy-12907 | gold_patch | astropy/modeling/separable.py | astropy/modeling/separable.py::separability_matrix | pivot | yes | yes | hit_top1_pivot | none |
| astropy__astropy-13236 | gold_patch | astropy/table/table.py | astropy/table/ndarray_mixin.py::NdarrayMixin | discarded | no | no | hit_discarded | present_but_discarded |
| astropy__astropy-13398 | gold_patch | astropy/coordinates/builtin_frames/__init__.py | astropy/coordinates/transformations.py::_add_merged_transform | pivot | no | yes | hit_top3 | none |
| astropy__astropy-13453 | gold_patch | astropy/io/ascii/html.py | astropy/io/fits/column.py::formats | pivot | no | yes | hit_top3 | none |
| astropy__astropy-14508 | gold_patch | astropy/io/fits/card.py | astropy/io/fits/diff.py::HeaderDiff | support | no | yes | hit_top3 | none |
| astropy__astropy-14995 | gold_patch | astropy/nddata/mixins/ndarithmetic.py | astropy/io/ascii/core.py::BaseData | discarded | no | no | hit_discarded | present_but_discarded |
| astropy__astropy-7336 | gold_patch | astropy/units/decorators.py | astropy/modeling/core.py::Model | support | no | no | hit_support | present_but_support |
| astropy__astropy-7606 | gold_patch | astropy/units/core.py | astropy/io/misc/asdf/tags/transform/polynomial.py::PolynomialType | pivot | no | yes | hit_top3 | none |
| astropy__astropy-7671 | gold_patch | astropy/utils/introspection.py | astropy/coordinates/sky_coordinate.py::_parse_ra_dec | support | no | no | hit_support | present_but_support |
| astropy__astropy-8707 | gold_patch | astropy/io/fits/card.py | astropy/io/fits/hdu/base.py::_BaseHDU | pivot | no | yes | hit_top3 | none |
| astropy__astropy-8872 | gold_patch | astropy/units/quantity.py | astropy/units/quantity.py::Quantity | pivot | yes | yes | hit_top1_pivot | none |
| django__django-11603 | gold_patch | django/db/models/aggregates.py | db/models/aggregates.py::Avg | pivot | yes | yes | hit_top1_pivot | none |
| django__django-11880 | gold_patch | django/forms/fields.py | forms/fields.py::__deepcopy__ | pivot | yes | yes | hit_top1_pivot | none |
| django__django-12741 | gold_patch | django/core/management/commands/flush.py | db/backends/mysql/operations.py::sql_flush | pivot | no | yes | hit_top3 | none |
| django__django-14500 | gold_patch | django/db/migrations/executor.py | views/decorators/http.py::last_modified | discarded | no | no | hit_discarded | present_but_discarded |
| django__django-14559 | gold_patch | django/db/models/query.py | db/models/query.py::bulk_update | pivot | yes | yes | hit_top1_pivot | none |
| django__django-15022 | gold_patch | django/contrib/admin/options.py | contrib/admin/options.py::has_change_permission | pivot | yes | yes | hit_top1_pivot | none |
| django__django-15252 | gold_patch | django/db/migrations/executor.py | db/utils.py::allow_migrate | discarded | no | no | hit_discarded | present_but_discarded |
| django__django-15375 | gold_patch | django/db/models/aggregates.py | contrib/messages/storage/cookie.py::default | support | no | yes | hit_top3 | none |
| django__django-15569 | gold_patch | django/db/models/query_utils.py | db/models/query_utils.py::_unregister_lookup | pivot | yes | yes | hit_top1_pivot | none |
| django__django-15629 | gold_patch | django/db/backends/base/schema.py | db/backends/sqlite3/operations.py::last_executed_query | discarded | no | no | hit_discarded | present_but_discarded |
| django__django-16100 | gold_patch | django/contrib/admin/options.py | contrib/admin/checks.py::_check_list_editable | pivot | no | yes | hit_top3 | none |
| matplotlib__matplotlib-13989 | gold_patch | lib/matplotlib/axes/_axes.py | lib/matplotlib/pyplot.py::hist | pivot | no | yes | hit_top3 | none |
| matplotlib__matplotlib-20488 | gold_patch | lib/matplotlib/image.py | lib/matplotlib/image.py::AxesImage | pivot | yes | yes | hit_top1_pivot | none |
| matplotlib__matplotlib-20676 | gold_patch | lib/matplotlib/widgets.py | lib/matplotlib/widgets.py::SpanSelector | pivot | yes | yes | hit_top1_pivot | none |
| matplotlib__matplotlib-20859 | gold_patch | lib/matplotlib/legend.py | lib/matplotlib/figure.py::SubFigure | missing | no | no | missing | body_literal_not_resolved |
| matplotlib__matplotlib-21568 | gold_patch | lib/matplotlib/dates.py | lib/matplotlib/axis.py::axis_date | discarded | no | no | hit_discarded | present_but_discarded |
| matplotlib__matplotlib-22871 | gold_patch | lib/matplotlib/dates.py | lib/matplotlib/dates.py::ConciseDateFormatter | pivot | yes | yes | hit_top1_pivot | none |
| matplotlib__matplotlib-23314 | gold_patch | lib/mpl_toolkits/mplot3d/axes3d.py | lib/matplotlib/widgets.py::set_visible | discarded | no | no | hit_discarded | present_but_discarded |
| matplotlib__matplotlib-23412 | gold_patch | lib/matplotlib/patches.py | lib/matplotlib/lines.py::set_dash_capstyle | pivot | no | yes | hit_top3 | none |
| matplotlib__matplotlib-25311 | gold_patch | lib/matplotlib/offsetbox.py | lib/matplotlib/legend_handler.py::HandlerErrorbar | support | no | no | hit_support | present_but_support |
| matplotlib__matplotlib-25479 | gold_patch | lib/matplotlib/cm.py | lib/matplotlib/_pylab_helpers.py::Gcf | missing | no | no | missing | wrong_subsystem |
| matplotlib__matplotlib-26291 | gold_patch | lib/mpl_toolkits/axes_grid1/inset_locator.py | lib/matplotlib/axes/_axes.py::inset_axes | support | no | no | hit_support | present_but_support |
| mwaskom__seaborn-3069 | gold_patch | seaborn/_core/plot.py | seaborn/_oldcore.py::scale_categorical | discarded | no | no | hit_discarded | present_but_discarded |
| psf__requests-1766 | gold_patch | requests/auth.py | requests/auth.py::HTTPDigestAuth | pivot | yes | yes | hit_top1_pivot | none |
| psf__requests-2317 | gold_patch | requests/sessions.py | requests/sessions.py::merge_hooks | pivot | yes | yes | hit_top1_pivot | none |
| psf__requests-2931 | gold_patch | requests/models.py | requests/utils.py::to_native_string | discarded | no | no | hit_discarded | present_but_discarded |
| psf__requests-6028 | gold_patch | requests/utils.py | requests/auth.py::HTTPProxyAuth | discarded | no | no | hit_discarded | test_symbol_pollution |
| pydata__xarray-3095 | gold_patch | xarray/core/indexing.py | xarray/core/dataset.py::copy | support | no | no | hit_support | present_but_support |
| pydata__xarray-3151 | gold_patch | xarray/core/combine.py | xarray/core/combine.py::combine_by_coords | pivot | yes | yes | hit_top1_pivot | none |
| pydata__xarray-3993 | gold_patch | xarray/core/dataarray.py | xarray/core/dataset.py::_integrate_one | pivot | yes | yes | hit_top1_pivot | none |
| pydata__xarray-4075 | gold_patch | xarray/core/weighted.py | xarray/core/weighted.py::mean | pivot | yes | yes | hit_top1_pivot | none |
| pydata__xarray-4094 | gold_patch | xarray/core/dataarray.py | xarray/core/dataset.py::merge | pivot | no | yes | hit_top3 | none |
| pydata__xarray-4629 | gold_patch | xarray/core/merge.py | ci/min_deps_check.py::process_pkg | pivot | no | yes | hit_top3 | none |
| pydata__xarray-4687 | gold_patch | xarray/core/computation.py | xarray/core/common.py::where | discarded | no | no | hit_discarded | present_but_discarded |
| pydata__xarray-6721 | gold_patch | xarray/core/common.py | xarray/backends/zarr.py::open_zarr | missing | no | no | missing | wrong_subsystem |
| pydata__xarray-6744 | gold_patch | xarray/core/rolling.py | xarray/core/accessor_str.py::center | support | no | no | hit_support | present_but_support |
| pydata__xarray-7229 | gold_patch | xarray/core/computation.py | xarray/core/common.py::astype | support | no | no | hit_support | present_but_support |
| pydata__xarray-7233 | gold_patch | xarray/core/rolling.py | xarray/core/rolling.py::construct | pivot | yes | yes | hit_top1_pivot | none |
| pylint-dev__pylint-4604 | gold_patch | pylint/checkers/variables.py | pylint/checkers/imports.py::_add_imported_module | pivot | no | yes | hit_top3 | none |
| pylint-dev__pylint-4661 | gold_patch | pylint/config/__init__.py | pylint/checkers/base_checker.py::__str__ | discarded | no | no | hit_discarded | present_but_discarded |
| pylint-dev__pylint-4970 | gold_patch | pylint/checkers/similar.py | pylint/checkers/similar.py::filter_noncode_lines | pivot | yes | yes | hit_top1_pivot | none |
| pylint-dev__pylint-6386 | gold_patch | pylint/config/argument.py | pylint/config/arguments_provider.py::option_value | pivot | no | yes | hit_top3 | none |
| pylint-dev__pylint-6528 | gold_patch | pylint/lint/expand_modules.py | pylint/checkers/utils.py::node_ignores_exception | discarded | no | no | hit_discarded | present_but_discarded |
| pylint-dev__pylint-6903 | gold_patch | pylint/lint/run.py | pylint/typing.py::ErrorDescriptionDict | missing | no | no | missing | wrong_subsystem |
| pylint-dev__pylint-7080 | gold_patch | pylint/lint/expand_modules.py | pylint/lint/expand_modules.py::_is_ignored_file | pivot | yes | yes | hit_top1_pivot | none |
| pylint-dev__pylint-7277 | gold_patch | pylint/__init__.py | pylint/lint/base_options.py::_make_run_options | pivot | no | yes | hit_top3 | none |
| pytest-dev__pytest-10081 | gold_patch | src/_pytest/unittest.py | src/_pytest/unittest.py::_is_skipped | pivot | yes | yes | hit_top1_pivot | none |
| pytest-dev__pytest-10356 | gold_patch | src/_pytest/mark/structures.py | bench/manyparam.py::foo | missing | no | no | missing | missing_from_candidates |
| pytest-dev__pytest-5787 | gold_patch | src/_pytest/reports.py | src/_pytest/_code/code.py::ExceptionChainRepr | support | no | yes | hit_top3 | none |
| pytest-dev__pytest-5840 | gold_patch | src/_pytest/config/__init__.py | src/_pytest/config/__init__.py::ConftestImportFailure | pivot | yes | yes | hit_top1_pivot | none |
| pytest-dev__pytest-6202 | gold_patch | src/_pytest/python.py | src/_pytest/reports.py::CollectErrorRepr | support | no | yes | hit_top3 | none |
| pytest-dev__pytest-7205 | gold_patch | src/_pytest/setuponly.py | src/_pytest/cacheprovider.py::pytest_addoption | pivot | no | yes | hit_top3 | none |
| pytest-dev__pytest-7236 | gold_patch | src/_pytest/unittest.py | src/_pytest/fixtures.py::fixture | pivot | no | yes | hit_top3 | none |
| pytest-dev__pytest-7324 | gold_patch | src/_pytest/mark/expression.py | src/_pytest/_code/code.py::is_true | missing | no | no | missing | line_anchor_not_resolved |
| pytest-dev__pytest-7490 | gold_patch | src/_pytest/skipping.py | src/_pytest/outcomes.py::xfail | missing | no | no | missing | missing_from_candidates |
| pytest-dev__pytest-7521 | gold_patch | src/_pytest/capture.py | src/_pytest/capture.py::readouterr | pivot | yes | yes | hit_top1_pivot | none |
| pytest-dev__pytest-7571 | gold_patch | src/_pytest/logging.py | src/_pytest/logging.py::set_level | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-10297 | gold_patch | sklearn/linear_model/ridge.py | sklearn/linear_model/ridge.py::__init__ | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-10908 | gold_patch | sklearn/feature_extraction/text.py | sklearn/feature_extraction/text.py::get_feature_names | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-11310 | gold_patch | sklearn/model_selection/_search.py | sklearn/model_selection/_search.py::GridSearchCV | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-12973 | gold_patch | sklearn/linear_model/least_angle.py | sklearn/linear_model/least_angle.py::LassoLarsIC | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-13135 | gold_patch | sklearn/preprocessing/_discretization.py | sklearn/preprocessing/_discretization.py::KBinsDiscretizer | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-13142 | gold_patch | sklearn/mixture/base.py | benchmarks/bench_plot_nmf.py::run_bench | missing | no | no | missing | body_literal_not_resolved |
| scikit-learn__scikit-learn-13328 | gold_patch | sklearn/linear_model/huber.py | sklearn/linear_model/huber.py::HuberRegressor | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-13779 | gold_patch | sklearn/ensemble/voting.py | sklearn/ensemble/voting.py::fit | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-14053 | gold_patch | sklearn/tree/export.py | sklearn/feature_extraction/text.py::HashingVectorizer | pivot | no | yes | hit_top3 | none |
| scikit-learn__scikit-learn-14894 | gold_patch | sklearn/svm/base.py | sklearn/svm/base.py::_sparse_fit | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-26194 | gold_patch | sklearn/metrics/_ranking.py | sklearn/metrics/_ranking.py::roc_curve | pivot | yes | yes | hit_top1_pivot | none |
| sphinx-doc__sphinx-10449 | gold_patch | sphinx/ext/autodoc/typehints.py | sphinx/ext/autodoc/typehints.py::augment_descriptions_with_types | pivot | yes | yes | hit_top1_pivot | none |
| sphinx-doc__sphinx-10466 | gold_patch | sphinx/builders/gettext.py | sphinx/builders/gettext.py::__init__ | pivot | yes | yes | hit_top1_pivot | none |
| sphinx-doc__sphinx-7454 | gold_patch | sphinx/domains/python.py | sphinx/ext/autodoc/typehints.py::record_typehints | missing | no | no | missing | wrong_subsystem |
| sphinx-doc__sphinx-7757 | gold_patch | sphinx/util/inspect.py | sphinx/application.py::add_config_value | missing | no | no | missing | wrong_subsystem |
| sphinx-doc__sphinx-7985 | gold_patch | sphinx/builders/linkcheck.py | sphinx/builders/gettext.py::LocalTimeZone | pivot | no | yes | hit_top3 | none |
| sphinx-doc__sphinx-8459 | gold_patch | sphinx/ext/autodoc/typehints.py | sphinx/util/cfamily.py::description | support | no | yes | hit_top3 | none |
| sphinx-doc__sphinx-8548 | gold_patch | sphinx/ext/autodoc/__init__.py | sphinx/ext/autodoc/__init__.py::inherited_members_option | pivot | yes | yes | hit_top1_pivot | none |
| sphinx-doc__sphinx-8595 | gold_patch | sphinx/ext/autodoc/__init__.py | sphinx/ext/autodoc/__init__.py::is_uninitialized_instance_attribute | pivot | yes | yes | hit_top1_pivot | none |
| sphinx-doc__sphinx-9258 | gold_patch | sphinx/domains/python.py | — | discarded | no | no | skipped_no_context | present_but_discarded |
| sphinx-doc__sphinx-9602 | gold_patch | sphinx/domains/python.py | sphinx/writers/texinfo.py::visit_desc_annotation | missing | no | no | missing | missing_from_candidates |
| sphinx-doc__sphinx-9658 | gold_patch | sphinx/ext/autodoc/mock.py | sphinx/ext/inheritance_diagram.py::class_name | missing | no | no | missing | missing_from_candidates |
| sympy__sympy-13031 | gold_patch | sympy/matrices/sparse.py | sympy/matrices/common.py::hstack | missing | no | no | missing | missing_from_candidates |
| sympy__sympy-13551 | gold_patch | sympy/concrete/products.py | sympy/concrete/products.py::product | pivot | yes | yes | hit_top1_pivot | none |
| sympy__sympy-13852 | gold_patch | sympy/functions/special/zeta_functions.py | sympy/assumptions/handlers/sets.py::Rational | support | no | yes | hit_top3 | none |
| sympy__sympy-14531 | gold_patch | sympy/printing/str.py | sympy/printing/str.py::StrPrinter | pivot | yes | yes | hit_top1_pivot | none |
| sympy__sympy-15345 | gold_patch | sympy/printing/mathematica.py | sympy/printing/mathematica.py::mathematica_code | pivot | yes | yes | hit_top1_pivot | none |
| sympy__sympy-15976 | gold_patch | sympy/printing/mathml.py | sympy/printing/mathml.py::apply_patch | pivot | yes | yes | hit_top1_pivot | none |
| sympy__sympy-16450 | gold_patch | sympy/simplify/simplify.py | sympy/assumptions/ask.py::finite | discarded | no | no | hit_discarded | present_but_discarded |
| sympy__sympy-16886 | gold_patch | sympy/crypto/crypto.py | sympy/crypto/crypto.py::encode_morse | pivot | yes | yes | hit_top1_pivot | none |
| sympy__sympy-18698 | gold_patch | sympy/polys/polytools.py | sympy/polys/galoistools.py::gf_sqf_list | discarded | no | no | hit_discarded | present_but_discarded |
| sympy__sympy-23824 | gold_patch | sympy/physics/hep/gamma_matrices.py | sympy/physics/hep/gamma_matrices.py::kahane_simplify | pivot | yes | yes | hit_top1_pivot | none |

## Misses / failures — top-k diagnostics

### astropy__astropy-13236 — hit_discarded / present_but_discarded

- expected: astropy/table/table.py
- reason: expected file recovered but discarded: astropy/table/table.py — beyond standard support budget (max 4)
- down-weighted lexical tokens: errors, future
- de-anchored exception tokens: future
- title-symbol terms: NdarrayMixin
- title-symbol matches: NdarrayMixin -> astropy/table/ndarray_mixin.py::NdarrayMixin
- graph-neighbour expansions: astropy/table/column.py::__array_wrap__ -[references]-> astropy/table/column.py::_comparison_functions; astropy/table/column.py::Column -[contains]-> astropy/table/column.py::copy; astropy/table/column.py::Column -[contains]-> astropy/table/column.py::__lt__; astropy/units/structured.py::Structure -[references]-> astropy/units/structured.py::physical_type; astropy/table/column.py::Column -[references]-> astropy/table/operations.py::_join; astropy/table/column.py::Column -[references]-> astropy/table/serialize.py::_represent_mixin_as_column; astropy/units/structured.py::Structure -[contains]-> astropy/units/structured.py::__eq__; astropy/coordinates/transformations.py::invalidate_cache -[calls]-> astropy/coordinates/transformations.py::__init__
- generic lexical decoys suppressed: errors -> astropy/coordinates/errors.py
- top pivots:
  - astropy/table/ndarray_mixin.py::NdarrayMixin — actionable class — strong lexical match; issue-domain relevance; 6 dependents
  - astropy/table/serialize.py::represent_mixins_as_columns — actionable function — strong lexical match; issue-domain relevance; 5 dependents
- top support:
  - astropy/table/column.py::Column — strong target beyond the pivot budget — actionable class — symbol-name match; strong lexical match; issue-domain relevance; 170 dependents
  - astropy/units/structured.py::decompose — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - astropy/units/quantity_helper/erfa.py::astrom_unit — likely co-edit sibling of a high-confidence anchor
  - astropy/table/ndarray_mixin.py::_construct_from_dict — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
- top discarded:
  - astropy/table/ndarray_mixin.py::_represent_as_dict — beyond standard support budget (max 4)
  - astropy/io/fits/column.py::__getitem__ — beyond standard support budget (max 4)
  - astropy/io/fits/column.py::_get_index — beyond standard support budget (max 4)
  - astropy/coordinates/transformations.py::invalidate_cache — beyond standard support budget (max 4)
  - astropy/io/misc/asdf/tags/transform/functional_models.py::RickerWavelet1DType — beyond standard support budget (max 4)

### astropy__astropy-14995 — hit_discarded / present_but_discarded

- expected: astropy/nddata/mixins/ndarithmetic.py
- reason: expected file recovered but discarded: astropy/nddata/mixins/ndarithmetic.py — beyond standard support budget (max 3)
- literal-anchor terms: int, NoneType
- literal-anchor matches: int -> astropy/io/votable/converters.py::Int; int -> astropy/io/ascii/core.py::BaseData; int -> astropy/io/ascii/core.py::BaseHeader; NoneType -> astropy/units/decorators.py::NoneType
- graph-neighbour expansions: astropy/io/ascii/core.py::BaseData -[references]-> astropy/io/ascii/latex.py::write; astropy/io/ascii/core.py::BaseData -[references]-> astropy/io/ascii/daophot.py::get_data_lines; astropy/io/ascii/core.py::BaseData -[references]-> astropy/io/ascii/latex.py::LatexData; astropy/io/ascii/core.py::BaseData -[references]-> astropy/io/ascii/latex.py::write; astropy/nddata/mixins/ndarithmetic.py::NDArithmeticMixin -[contains]-> astropy/nddata/mixins/ndarithmetic.py::add; astropy/io/ascii/core.py::BaseHeader -[references]-> astropy/io/ascii/latex.py::LatexHeader; astropy/nddata/nduncertainty.py::propagate -[calls]-> astropy/nddata/nduncertainty.py::_propagate_divide; astropy/nddata/nduncertainty.py::uncertainty_type -[references]-> astropy/nddata/nduncertainty.py::__init__
- top pivots:
  - astropy/io/ascii/core.py::BaseData — actionable class — symbol-name match; strong lexical match
  - astropy/io/ascii/core.py::BaseHeader — actionable class — symbol-name match; strong lexical match
  - astropy/io/votable/converters.py::Int — actionable class — symbol-name match; strong lexical match
- top support:
  - astropy/units/decorators.py::NoneType — symbol-name match; strong lexical match (not a pivot: module_variable is a low-actionability edit target)
  - astropy/table/operations.py::_check_join_type — strong target beyond the pivot budget — actionable function — symbol-name match; lexical match; issue-domain relevance; graph/import neighbour
  - astropy/io/votable/tree.py::type — strong target beyond the pivot budget — actionable method — symbol-name match; lexical match; issue-domain relevance
- top discarded:
  - astropy/nddata/nddata.py::NDData — beyond standard support budget (max 3)
  - astropy/nddata/nddata_withmixins.py::NDDataRef — beyond standard support budget (max 3)
  - astropy/io/votable/tree.py::type — beyond standard support budget (max 3)
  - astropy/io/votable/tree.py::type — beyond standard support budget (max 3)
  - astropy/io/votable/tree.py::type — beyond standard support budget (max 3)

### astropy__astropy-7336 — hit_support / present_but_support

- expected: astropy/units/decorators.py
- reason: —
- down-weighted lexical tokens: exception
- title-symbol terms: quantity_input
- title-symbol matches: quantity_input -> astropy/units/decorators.py::quantity_input
- literal-anchor terms: units.quantity_input, NoneType
- literal-anchor matches: units.quantity_input -> astropy/modeling/core.py::Model; units.quantity_input -> astropy/modeling/parameters.py::Parameter; units.quantity_input -> astropy/units/quantity.py::Quantity
- graph-neighbour expansions: astropy/units/quantity.py::Quantity -[contains]-> astropy/units/quantity.py::si; astropy/units/quantity.py::Quantity -[contains]-> astropy/units/quantity.py::to_value; astropy/units/quantity.py::Quantity -[contains]-> astropy/units/quantity.py::any; astropy/units/quantity.py::Quantity -[contains]-> astropy/units/quantity.py::to; astropy/modeling/core.py::Model -[references]-> astropy/modeling/parameters.py::constraints; astropy/modeling/core.py::Model -[references]-> astropy/modeling/polynomial.py::InverseSIP; astropy/modeling/core.py::Model -[references]-> astropy/modeling/separable.py::_compute_n_outputs
- top pivots:
  - astropy/modeling/core.py::Model — actionable class — symbol-name match; strong lexical match
  - astropy/units/quantity.py::Quantity — actionable class — symbol-name match; strong lexical match
- top support:
  - astropy/modeling/parameters.py::_create_value_wrapper — strong target beyond the pivot budget — actionable method — symbol-name match; lexical match; issue-domain relevance
  - astropy/units/decorators.py::quantity_input — in a likely edit file; lexical match; issue-domain relevance (not a pivot: module_alias is a low-actionability edit target)
  - astropy/constants/constant.py::__quantity_subclass__ — likely co-edit sibling of a high-confidence anchor
  - astropy/cosmology/core.py::_float_or_none — strong target beyond the pivot budget — actionable function — symbol-name match; lexical match; issue-domain relevance; 8 dependents
- top discarded:
  - astropy/samp/utils.py::SAMPMsgReplierWrapper — beyond standard support budget (max 4)
  - astropy/modeling/core.py::_custom_model_wrapper — beyond standard support budget (max 4)
  - astropy/table/table_helpers.py::ArrayWrapper — beyond standard support budget (max 4)
  - astropy/modeling/core.py::return_units — beyond standard support budget (max 4)
  - astropy/modeling/parameters.py::Parameter — beyond standard support budget (max 4)

### astropy__astropy-7671 — hit_support / present_but_support

- expected: astropy/utils/introspection.py
- reason: —
- down-weighted lexical tokens: failures, change, errors, type, error
- de-anchored exception tokens: type
- literal-anchor terms: minversion, int, str
- literal-anchor matches: minversion -> astropy/utils/introspection.py::minversion; int -> astropy/io/votable/converters.py::Int; int -> astropy/io/ascii/core.py::BaseData; int -> astropy/io/ascii/core.py::BaseHeader; str -> astropy/coordinates/sky_coordinate.py::_parse_ra_dec; str -> astropy/extern/bundled/six.py::python_2_unicode_compatible
- graph-neighbour expansions: astropy/io/fits/hdu/compressed.py::__init__ -[contains]-> astropy/io/fits/hdu/compressed.py::CompImageHDU; astropy/io/votable/converters.py::Int -[references]-> astropy/io/votable/converters.py::Integer; astropy/io/ascii/core.py::BaseData -[references]-> astropy/io/ascii/latex.py::LatexData; astropy/coordinates/sky_coordinate.py::_parse_ra_dec -[references]-> astropy/coordinates/sky_coordinate.py::J_PREFIXED_RA_DEC_RE; astropy/io/ascii/core.py::BaseData -[references]-> astropy/io/ascii/latex.py::write; astropy/io/votable/converters.py::Int -[contains]-> astropy/io/votable/converters.py::format; astropy/nddata/nduncertainty.py::propagate -[calls]-> astropy/nddata/nduncertainty.py::_propagate_multiply; astropy/io/fits/hdu/compressed.py::__init__ -[calls]-> astropy/io/fits/hdu/compressed.py::_update_header_data
- top pivots:
  - astropy/coordinates/sky_coordinate.py::_parse_ra_dec — actionable function — symbol-name match; strong lexical match
  - astropy/extern/bundled/six.py::python_2_unicode_compatible — actionable function — symbol-name match; strong lexical match
  - astropy/io/ascii/core.py::BaseData — actionable class — symbol-name match; strong lexical match
- top support:
  - astropy/io/ascii/core.py::BaseHeader — strong target beyond the pivot budget — actionable class — symbol-name match; strong lexical match
  - astropy/io/votable/converters.py::Int — strong target beyond the pivot budget — actionable class — symbol-name match; strong lexical match
  - astropy/utils/introspection.py::minversion — strong target beyond the pivot budget — actionable function — symbol-name match; lexical match; issue-domain relevance
- top discarded:
  - astropy/io/fits/hdu/hdulist.py::fitsopen — beyond standard support budget (max 3)
  - astropy/nddata/ccddata.py::CCDData — beyond standard support budget (max 3)
  - astropy/nddata/compat.py::NDDataArray — beyond standard support budget (max 3)
  - astropy/io/fits/hdu/compressed.py::__init__ — beyond standard support budget (max 3)
  - astropy/nddata/nduncertainty.py::propagate — beyond standard support budget (max 3)

### django__django-14500 — hit_discarded / present_but_discarded

- expected: django/db/migrations/executor.py
- reason: expected file recovered but discarded: db/migrations/executor.py — beyond standard support budget (max 4)
- graph-neighbour expansions: db/migrations/loader.py::MigrationLoader -[contains]-> db/migrations/loader.py::detect_conflicts; db/migrations/graph.py::MigrationGraph -[contains]-> db/migrations/graph.py::forwards_plan; db/migrations/loader.py::MigrationLoader -[contains]-> db/migrations/loader.py::get_migration_by_prefix; db/migrations/graph.py::MigrationGraph -[contains]-> db/migrations/graph.py::__str__; db/migrations/graph.py::MigrationGraph -[contains]-> db/migrations/graph.py::backwards_plan; db/migrations/loader.py::MigrationLoader -[contains]-> db/migrations/loader.py::check_consistent_history; db/migrations/autodetector.py::_trim_to_apps -[calls]-> db/migrations/autodetector.py::changes; db/migrations/loader.py::MigrationLoader -[contains]-> db/migrations/loader.py::build_graph
- top pivots:
  - views/decorators/http.py::last_modified — actionable function — strong lexical match; issue-domain relevance
  - db/migrations/recorder.py::record_unapplied — actionable method — strong lexical match; issue-domain relevance
- top support:
  - db/migrations/loader.py::check_consistent_history — lexical match; issue-domain relevance; graph/import neighbour (not a pivot: no direct evidence (graph/domain reach only))
  - db/migrations/migration.py::unapply — lexical match; issue-domain relevance (not a pivot: no direct evidence (graph/domain reach only))
  - db/migrations/graph.py::forwards_plan — lexical match; issue-domain relevance; graph/import neighbour (not a pivot: no direct evidence (graph/domain reach only))
  - db/migrations/loader.py::MigrationLoader — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance
- top discarded:
  - db/migrations/questioner.py::_ask_default — beyond standard support budget (max 4)
  - db/migrations/executor.py::check_replacements — beyond standard support budget (max 4)
  - db/migrations/operations/base.py::Operation — beyond standard support budget (max 4)
  - db/migrations/operations/utils.py::field_references — beyond standard support budget (max 4)
  - db/migrations/exceptions.py::NodeNotFoundError — beyond standard support budget (max 4)

### django__django-15252 — hit_discarded / present_but_discarded

- expected: django/db/migrations/executor.py
- reason: expected file recovered but discarded: db/migrations/executor.py — beyond standard support budget (max 3)
- title-symbol terms: MigrationRecorder, db_router, allow_migrate
- title-symbol matches: MigrationRecorder -> db/migrations/recorder.py::MigrationRecorder; allow_migrate -> db/utils.py::allow_migrate
- graph-neighbour expansions: db/migrations/recorder.py::MigrationRecorder -[calls]-> db/migrations/executor.py::__init__; db/migrations/recorder.py::MigrationRecorder -[contains]-> db/migrations/recorder.py::_migration_class
- top pivots:
  - db/utils.py::allow_migrate — local implementation helper whose name matches the issue — likely edit site
  - db/migrations/operations/base.py::allow_migrate_model — local implementation helper whose name matches the issue — likely edit site
  - db/migrations/recorder.py::MigrationRecorder — actionable class — strong lexical match; issue-domain relevance
- top support:
  - db/utils.py::allow_migrate_model — strong target beyond the pivot budget — local implementation helper whose name matches the issue — likely edit site
  - db/migrations/recorder.py::migration_qs — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance; 5 dependents
  - db/migrations/recorder.py::Migration — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
- top discarded:
  - db/migrations/questioner.py::InteractiveMigrationQuestioner — beyond standard support budget (max 3)
  - db/migrations/executor.py::apply_migration — beyond standard support budget (max 3)
  - db/migrations/recorder.py::has_table — beyond standard support budget (max 3)
  - db/migrations/recorder.py::ensure_schema — beyond standard support budget (max 3)
  - db/migrations/recorder.py::_migration_class — beyond standard support budget (max 3)

### django__django-15629 — hit_discarded / present_but_discarded

- expected: django/db/backends/base/schema.py, django/db/backends/oracle/features.py, django/db/backends/sqlite3/schema.py, django/db/models/fields/related.py
- reason: expected file recovered but discarded: db/models/fields/related.py — beyond standard support budget (max 4)
- down-weighted lexical tokens: errors
- graph-neighbour expansions: db/models/fields/related.py::ForeignKey -[contains]-> db/models/fields/related.py::get_col; db/models/query.py::last -[calls]-> db/models/query.py::reverse; db/models/fields/related.py::ForeignKey -[contains]-> db/models/fields/related.py::get_attname; db/models/fields/related.py::ForeignKey -[contains]-> db/models/fields/related.py::__init__; db/models/fields/related.py::ForeignKey -[references]-> db/models/fields/related.py::ForeignObject; db/models/query.py::last -[references]-> db/models/query.py::ordered; db/backends/sqlite3/operations.py::last_executed_query -[contains]-> db/backends/sqlite3/operations.py::DatabaseOperations; db/models/query.py::last -[references]-> db/models/query.py::alast
- top pivots:
  - db/backends/sqlite3/operations.py::last_executed_query — actionable method — strong lexical match; issue-domain relevance
  - db/models/query.py::last — actionable method — strong lexical match; issue-domain relevance
- top support:
  - db/utils.py::DatabaseErrorWrapper — lexical match; issue-domain relevance; graph/import neighbour (not a pivot: no direct evidence (graph/domain reach only))
  - db/backends/oracle/operations.py::last_executed_query — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - db/migrations/autodetector.py::generate_altered_order_with_respect_to — lexical match; graph/import neighbour (not a pivot: no direct evidence (graph/domain reach only))
  - db/migrations/exceptions.py::NodeNotFoundError — lexical match; issue-domain relevance; 6 dependents (not a pivot: high-degree framework root — support at most)
- top discarded:
  - db/migrations/exceptions.py::InvalidBasesError — beyond standard support budget (max 4)
  - db/migrations/state.py::__init__ — beyond standard support budget (max 4)
  - db/utils.py::NotSupportedError — beyond standard support budget (max 4)
  - db/migrations/exceptions.py::IrreversibleError — beyond standard support budget (max 4)
  - db/migrations/exceptions.py::CircularDependencyError — beyond standard support budget (max 4)

### matplotlib__matplotlib-20859 — missing / body_literal_not_resolved

- expected: lib/matplotlib/legend.py
- reason: expected file not surfaced (candidate_count=25)
- down-weighted lexical tokens: bug, errors, type, error
- de-anchored exception tokens: type
- title-symbol terms: SubFigure
- title-symbol matches: SubFigure -> lib/matplotlib/figure.py::SubFigure
- literal-anchor terms: SubFigure
- literal-anchor matches: SubFigure -> lib/matplotlib/figure.py::SubFigure; SubFigure -> lib/matplotlib/patches.py::ConnectionPatch; SubFigure -> lib/matplotlib/patches.py::__init__
- graph-neighbour expansions: lib/matplotlib/patches.py::__init__ -[calls]-> lib/matplotlib/patches.py::__init__; lib/matplotlib/axes/_axes.py::Axes -[contains]-> lib/matplotlib/axes/_axes.py::indicate_inset_zoom; lib/matplotlib/figure.py::Figure -[contains]-> lib/matplotlib/figure.py::__repr__; lib/matplotlib/patches.py::ConnectionPatch -[calls]-> lib/matplotlib/axes/_axes.py::indicate_inset; lib/matplotlib/figure.py::Figure -[references]-> lib/matplotlib/backends/backend_pdf.py::savefig; lib/matplotlib/figure.py::Figure -[contains]-> lib/matplotlib/figure.py::execute_constrained_layout; lib/matplotlib/axes/_axes.py::Axes -[contains]-> lib/matplotlib/axes/_axes.py::axline; lib/matplotlib/axes/_axes.py::Axes -[contains]-> lib/matplotlib/axes/_axes.py::contour
- top pivots:
  - lib/matplotlib/figure.py::SubFigure — actionable class — symbol-name match; in a likely edit file; lexical match; issue-domain relevance
  - lib/matplotlib/figure.py::FigureBase — actionable class — in a likely edit file; lexical match; issue-domain relevance; graph/import neighbour
  - lib/matplotlib/patches.py::ConnectionPatch — actionable class — symbol-name match; strong lexical match
- top support:
  - lib/matplotlib/__init__.py::rc_context — lexical match; issue-domain relevance; graph/import neighbour; 46 dependents (not a pivot: high-degree framework root — support at most)
  - lib/matplotlib/axes/_axes.py::Axes — strong target beyond the pivot budget — actionable class — symbol-name match; strong lexical match
  - lib/matplotlib/figure.py::dpi — strong target beyond the pivot budget — local implementation helper invoked by the entry point — likely edit site
- top discarded:
  - lib/matplotlib/figure.py::dpi — beyond standard support budget (max 3)
  - lib/matplotlib/patches.py::__init__ — beyond standard support budget (max 3)
  - lib/matplotlib/figure.py::add_subfigure — beyond standard support budget (max 3)
  - lib/matplotlib/figure.py::subfigures — beyond standard support budget (max 3)
  - lib/matplotlib/figure.py::axes — beyond standard support budget (max 3)

### matplotlib__matplotlib-21568 — hit_discarded / present_but_discarded

- expected: lib/matplotlib/dates.py
- reason: expected file recovered but discarded: lib/matplotlib/dates.py — beyond standard support budget (max 4)
- down-weighted lexical tokens: bug
- graph-neighbour expansions: lib/matplotlib/axis.py::axis_date -[contains]-> lib/matplotlib/axis.py::Axis; lib/matplotlib/axis.py::axis_date -[calls]-> lib/matplotlib/axis.py::update_units
- top pivots:
  - lib/matplotlib/axis.py::axis_date — actionable method — strong lexical match; issue-domain relevance
  - lib/matplotlib/axis.py::Axis — actionable class — symbol-name match; lexical match; issue-domain relevance; graph/import neighbour
- top support:
  - lib/matplotlib/projections/polar.py::RadialAxis — likely co-edit sibling of a high-confidence anchor
  - examples/axisartist/simple_axis_pad.py::ann — lexical match; issue-domain relevance (not a pivot: no direct evidence (graph/domain reach only))
  - examples/axisartist/axis_direction.py::setup_axes — lexical match; issue-domain relevance (not a pivot: no direct evidence (graph/domain reach only))
  - examples/axisartist/simple_axis_direction03.py::setup_axes — lexical match; issue-domain relevance (not a pivot: no direct evidence (graph/domain reach only))
- top discarded:
  - examples/axisartist/demo_axis_direction.py::add_floating_axis1 — beyond standard support budget (max 4)
  - examples/axisartist/demo_axis_direction.py::add_floating_axis2 — beyond standard support budget (max 4)
  - examples/axisartist/simple_axis_pad.py::add_floating_axis1 — beyond standard support budget (max 4)
  - examples/axisartist/simple_axis_pad.py::add_floating_axis2 — beyond standard support budget (max 4)
  - examples/subplots_axes_and_figures/secondary_axis.py::dates — beyond standard support budget (max 4)

### matplotlib__matplotlib-23314 — hit_discarded / present_but_discarded

- expected: lib/mpl_toolkits/mplot3d/axes3d.py
- reason: expected file recovered but discarded: lib/mpl_toolkits/mplot3d/axes3d.py — beyond standard support budget (max 4)
- down-weighted lexical tokens: bug
- title-symbol terms: set_visible
- title-symbol matches: set_visible -> lib/matplotlib/artist.py::set_visible; set_visible -> lib/matplotlib/widgets.py::set_visible; set_visible -> lib/matplotlib/widgets.py::set_visible
- graph-neighbour expansions: lib/matplotlib/projections/polar.py::set_rlabel_position -[calls]-> lib/matplotlib/projections/polar.py::drag_pan; lib/matplotlib/projections/polar.py::_determine_anchor -[calls]-> lib/matplotlib/projections/polar.py::update_position; lib/matplotlib/widgets.py::set_visible -[calls]-> lib/matplotlib/widgets.py::_on_key_release; lib/matplotlib/projections/geo.py::set_xlim -[contains]-> lib/matplotlib/projections/geo.py::GeoAxes; lib/matplotlib/widgets.py::set_visible -[calls]-> lib/matplotlib/widgets.py::_press; lib/matplotlib/projections/polar.py::_determine_anchor -[contains]-> lib/matplotlib/projections/polar.py::RadialTick; lib/matplotlib/widgets.py::set_visible -[calls]-> lib/matplotlib/widgets.py::_press; lib/matplotlib/artist.py::set_visible -[calls]-> lib/mpl_toolkits/axes_grid1/mpl_axes.py::set_visible
- top pivots:
  - lib/matplotlib/widgets.py::set_visible — actionable method — symbol-name match; lexical match; issue-domain relevance; 7 dependents
  - lib/matplotlib/artist.py::set_visible — actionable method — symbol-name match; lexical match; issue-domain relevance
- top support:
  - lib/mpl_toolkits/axes_grid1/mpl_axes.py::set_visible — strong target beyond the pivot budget — actionable method — symbol-name match; lexical match; issue-domain relevance
  - lib/matplotlib/axis.py::draw — likely co-edit sibling of a high-confidence anchor
  - lib/matplotlib/widgets.py::set_visible — strong target beyond the pivot budget — actionable method — symbol-name match; lexical match; issue-domain relevance
  - lib/matplotlib/widgets.py::set_visible — strong target beyond the pivot budget — actionable method — symbol-name match; lexical match; issue-domain relevance
- top discarded:
  - examples/misc/custom_projection.py::_set_lim_and_transforms — beyond standard support budget (max 4)
  - lib/matplotlib/projections/geo.py::set_xlim — beyond standard support budget (max 4)
  - lib/matplotlib/projections/polar.py::set_thetagrids — beyond standard support budget (max 4)
  - lib/matplotlib/projections/polar.py::set_theta_zero_location — beyond standard support budget (max 4)
  - lib/matplotlib/projections/polar.py::_determine_anchor — beyond standard support budget (max 4)

### matplotlib__matplotlib-25311 — hit_support / present_but_support

- expected: lib/matplotlib/offsetbox.py
- reason: —
- down-weighted lexical tokens: bug, errors, type, error
- de-anchored exception tokens: type
- graph-neighbour expansions: lib/matplotlib/figure.py::colorbar -[calls]-> lib/matplotlib/figure.py::sca; lib/matplotlib/legend.py::DraggableLegend -[references]-> lib/matplotlib/offsetbox.py::DraggableOffsetBox; lib/matplotlib/legend.py::__init__ -[calls]-> lib/matplotlib/legend.py::_set_loc; lib/matplotlib/figure.py::legend -[contains]-> lib/matplotlib/figure.py::FigureBase; lib/matplotlib/legend.py::_parse_legend_args -[calls]-> lib/matplotlib/legend.py::_get_legend_handles; lib/matplotlib/figure.py::colorbar -[calls]-> lib/matplotlib/colorbar.py::make_axes; lib/matplotlib/legend.py::__init__ -[references]-> lib/matplotlib/legend.py::codes; lib/matplotlib/figure.py::colorbar -[calls]-> lib/matplotlib/figure.py::gca
- top pivots:
  - lib/matplotlib/legend_handler.py::HandlerErrorbar — actionable class — strong lexical match; issue-domain relevance
  - lib/matplotlib/legend.py::DraggableLegend — actionable class — strong lexical match; issue-domain relevance
- top support:
  - lib/matplotlib/figure.py::legend — strong target beyond the pivot budget — actionable method — symbol-name match; strong lexical match; issue-domain relevance
  - lib/matplotlib/offsetbox.py::DraggableOffsetBox — likely co-edit sibling of a high-confidence anchor
  - lib/matplotlib/legend.py::__init__ — strong target beyond the pivot budget — local implementation helper invoked by the entry point — likely edit site
  - lib/matplotlib/legend.py::set_draggable — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
- top discarded:
  - lib/matplotlib/legend.py::get_draggable — beyond standard support budget (max 4)
  - lib/matplotlib/pyplot.py::axes — beyond standard support budget (max 4)
  - lib/matplotlib/legend.py::_legend_kw_figure_st — beyond standard support budget (max 4)
  - lib/matplotlib/legend.py::_legend_kw_doc_base — beyond standard support budget (max 4)
  - lib/matplotlib/figure.py::show — beyond standard support budget (max 4)

### matplotlib__matplotlib-25479 — missing / wrong_subsystem

- expected: lib/matplotlib/cm.py, lib/matplotlib/colors.py
- reason: expected file not surfaced (candidate_count=25)
- literal-anchor terms: pyplot
- literal-anchor matches: pyplot -> lib/matplotlib/pyplot.py::_get_pyplot_commands; pyplot -> lib/matplotlib/_pylab_helpers.py::Gcf; pyplot -> lib/matplotlib/_pylab_helpers.py::_set_new_active_manager
- graph-neighbour expansions: lib/matplotlib/_pylab_helpers.py::Gcf -[contains]-> lib/matplotlib/_pylab_helpers.py::destroy_fig; lib/matplotlib/_pylab_helpers.py::Gcf -[references]-> lib/matplotlib/backends/_backend_tk.py::destroy; lib/matplotlib/_pylab_helpers.py::Gcf -[references]-> lib/matplotlib/backend_bases.py::show; lib/matplotlib/_pylab_helpers.py::Gcf -[contains]-> lib/matplotlib/_pylab_helpers.py::get_active; lib/matplotlib/_pylab_helpers.py::_set_new_active_manager -[calls]-> lib/matplotlib/_pylab_helpers.py::set_active; lib/matplotlib/pyplot.py::_get_pyplot_commands -[calls]-> lib/matplotlib/pyplot.py::get_plot_commands
- top pivots:
  - lib/matplotlib/_pylab_helpers.py::Gcf — actionable class — symbol-name match; strong lexical match
  - lib/matplotlib/_pylab_helpers.py::_set_new_active_manager — actionable method — symbol-name match; strong lexical match
  - lib/matplotlib/pyplot.py::_get_pyplot_commands — actionable function — symbol-name match; strong lexical match
- top support:
  - lib/matplotlib/backend_bases.py::pyplot_show — strong target beyond the pivot budget — actionable method — symbol-name match; lexical match; issue-domain relevance
  - lib/matplotlib/backends/backend_nbagg.py::create_with_canvas — likely co-edit sibling of a high-confidence anchor
  - galleries/examples/user_interfaces/mplcvd.py::_get_color_filter — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance
- top discarded:
  - lib/matplotlib/pyplot.py::subplots — beyond standard support budget (max 3)
  - galleries/examples/user_interfaces/embedding_webagg_sgskip.py::create_figure — beyond standard support budget (max 3)
  - galleries/examples/event_handling/cursor_demo.py::create_new_background — beyond standard support budget (max 3)
  - galleries/examples/user_interfaces/fourier_demo_wx_sgskip.py::createPlots — beyond standard support budget (max 3)
  - tools/boilerplate.py::PYPLOT_MAGIC_HEADER — beyond standard support budget (max 3)

### matplotlib__matplotlib-26291 — hit_support / present_but_support

- expected: lib/mpl_toolkits/axes_grid1/inset_locator.py
- reason: —
- down-weighted lexical tokens: bug, error, errors
- title-symbol terms: mpl_toolkits.axes_grid1.inset_locator.inset_axes, mpl_toolkits, axes_grid1, inset_locator, inset_axes
- title-symbol matches: inset_axes -> lib/mpl_toolkits/axes_grid1/inset_locator.py::inset_axes; inset_axes -> lib/matplotlib/axes/_axes.py::inset_axes
- literal-anchor terms: mpl_toolkits.axes_grid1.inset_locator.inset_axes, NoneType, _get_renderer
- literal-anchor matches: _get_renderer -> lib/matplotlib/backend_bases.py::_get_renderer; _get_renderer -> lib/matplotlib/figure.py::_get_renderer; _get_renderer -> lib/matplotlib/figure.py::_get_renderer
- graph-neighbour expansions: lib/mpl_toolkits/axes_grid1/inset_locator.py::zoomed_inset_axes -[calls]-> lib/mpl_toolkits/axes_grid1/inset_locator.py::AnchoredZoomLocator; lib/mpl_toolkits/axes_grid1/inset_locator.py::inset_axes -[calls]-> lib/mpl_toolkits/axes_grid1/inset_locator.py::_add_inset_axes; lib/mpl_toolkits/axes_grid1/inset_locator.py::inset_axes -[calls]-> lib/mpl_toolkits/axes_grid1/inset_locator.py::AnchoredSizeLocator; lib/mpl_toolkits/axes_grid1/inset_locator.py::__call__ -[calls]-> lib/matplotlib/offsetbox.py::get_offset; lib/mpl_toolkits/axes_grid1/inset_locator.py::__call__ -[contains]-> lib/mpl_toolkits/axes_grid1/inset_locator.py::AnchoredLocatorBase; lib/matplotlib/backend_bases.py::_get_renderer -[calls]-> lib/matplotlib/backend_bases.py::print_figure; lib/matplotlib/axes/_axes.py::inset_axes -[contains]-> lib/matplotlib/axes/_axes.py::Axes; lib/matplotlib/figure.py::_get_renderer -[contains]-> lib/matplotlib/figure.py::SubFigure
- top pivots:
  - lib/matplotlib/axes/_axes.py::inset_axes — actionable method — symbol-name match
  - lib/matplotlib/backend_bases.py::_get_renderer — actionable function — symbol-name match; strong lexical match
  - lib/matplotlib/figure.py::_get_renderer — actionable method — symbol-name match; strong lexical match
- top support:
  - lib/mpl_toolkits/axes_grid1/inset_locator.py::inset_axes — strong target beyond the pivot budget — local implementation helper whose name matches the issue — likely edit site
  - lib/matplotlib/colorbar.py::make_axes — likely co-edit sibling of a high-confidence anchor
  - lib/mpl_toolkits/axes_grid1/inset_locator.py::zoomed_inset_axes — strong target beyond the pivot budget — local implementation helper whose name matches the issue — likely edit site
- top discarded:
  - lib/mpl_toolkits/axes_grid1/inset_locator.py::__init__ — beyond standard support budget (max 3)
  - lib/mpl_toolkits/axes_grid1/inset_locator.py::__init__ — beyond standard support budget (max 3)
  - lib/mpl_toolkits/axes_grid1/inset_locator.py::get_path — beyond standard support budget (max 3)
  - lib/mpl_toolkits/axes_grid1/inset_locator.py::get_path — beyond standard support budget (max 3)
  - lib/matplotlib/figure.py::_get_renderer — beyond standard support budget (max 3)

### mwaskom__seaborn-3069 — hit_discarded / present_but_discarded

- expected: seaborn/_core/plot.py
- reason: expected file recovered but discarded: seaborn/_core/plot.py — beyond standard support budget (max 4)
- down-weighted lexical tokens: same
- graph-neighbour expansions: seaborn/_core/scales.py::Scale -[contains]-> seaborn/_core/scales.py::_get_scale; seaborn/_core/scales.py::Scale -[references]-> seaborn/_core/scales.py::Discrete; seaborn/_core/scales.py::Scale -[contains]-> seaborn/_core/scales.py::_legend; seaborn/categorical.py::scale_width -[calls]-> seaborn/categorical.py::estimate_densities; seaborn/_core/scales.py::Scale -[contains]-> seaborn/_core/scales.py::_get_locators
- top pivots:
  - seaborn/_oldcore.py::scale_categorical — local implementation helper whose name matches the issue — likely edit site
  - seaborn/_core/scales.py::Nominal — actionable class — strong lexical match; issue-domain relevance; 79 dependents
- top support:
  - seaborn/categorical.py::scale_width — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - seaborn/_core/scales.py::Scale — strong target beyond the pivot budget — actionable class — symbol-name match; strong lexical match
  - seaborn/categorical.py::scale_area — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - seaborn/_core/scales.py::PseudoAxis — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance; 11 dependents
- top discarded:
  - seaborn/_core/plot.py::scale — beyond standard support budget (max 4)
  - seaborn/categorical.py::scale_count — beyond standard support budget (max 4)
  - seaborn/_core/scales.py::label — beyond standard support budget (max 4)
  - seaborn/_core/scales.py::tick — beyond standard support budget (max 4)
  - seaborn/_core/scales.py::_get_scale — beyond standard support budget (max 4)

### psf__requests-2931 — hit_discarded / present_but_discarded

- expected: requests/models.py
- reason: expected file recovered but discarded: requests/models.py — beyond standard support budget (max 4)
- title-symbol terms: to_native_string
- title-symbol matches: to_native_string -> requests/utils.py::to_native_string
- graph-neighbour expansions: requests/utils.py::to_native_string -[calls]-> requests/models.py::_encode_params; requests/adapters.py::build_response -[calls]-> requests/cookies.py::extract_cookies_to_jar; requests/utils.py::to_native_string -[calls]-> requests/sessions.py::resolve_redirects; requests/adapters.py::init_poolmanager -[calls]-> requests/adapters.py::__init__; requests/adapters.py::init_poolmanager -[calls]-> requests/adapters.py::__setstate__; requests/adapters.py::proxy_manager_for -[calls]-> requests/packages/urllib3/poolmanager.py::proxy_from_url; requests/adapters.py::init_poolmanager -[calls]-> requests/packages/urllib3/poolmanager.py::PoolManager; requests/utils.py::to_native_string -[calls]-> requests/models.py::prepare_url
- top pivots:
  - requests/utils.py::to_native_string — local implementation helper whose name matches the issue — likely edit site
  - requests/api.py::get — actionable function — strong lexical match; issue-domain relevance; 38 dependents
- top support:
  - requests/adapters.py::request_url — strong target beyond the pivot budget — local implementation helper invoked by the entry point — likely edit site
  - requests/adapters.py::cert_verify — strong target beyond the pivot budget — local implementation helper invoked by the entry point — likely edit site
  - requests/adapters.py::add_headers — strong target beyond the pivot budget — local implementation helper invoked by the entry point — likely edit site
  - requests/adapters.py::get_connection — strong target beyond the pivot budget — local implementation helper invoked by the entry point — likely edit site
- top discarded:
  - requests/auth.py::HTTPDigestAuth — beyond standard support budget (max 4)
  - requests/cookies.py::values — beyond standard support budget (max 4)
  - requests/adapters.py::build_response — beyond standard support budget (max 4)
  - requests/cookies.py::extract_cookies_to_jar — beyond standard support budget (max 4)
  - requests/api.py::request — beyond standard support budget (max 4)

### psf__requests-6028 — hit_discarded / test_symbol_pollution

- expected: requests/utils.py
- reason: expected file recovered but discarded: requests/utils.py — no lexical/symbol/path/test/graph relevance to the task
- down-weighted lexical tokens: bug
- graph-neighbour expansions: requests/auth.py::HTTPProxyAuth -[references]-> requests/auth.py::HTTPBasicAuth; requests/auth.py::HTTPProxyAuth -[contains]-> requests/auth.py::__call__
- top pivots:
  - requests/auth.py::HTTPProxyAuth — actionable class — strong lexical match; issue-domain relevance
- top support:
  - requests/status_codes.py::_codes — strong lexical match (not a pivot: module_variable is a low-actionability edit target)
  - requests/auth.py::__call__ — lexical match; graph/import neighbour (not a pivot: no direct evidence (graph/domain reach only))
  - requests/auth.py::HTTPBasicAuth — lexical match; graph/import neighbour (not a pivot: no direct evidence (graph/domain reach only))
  - requests/status_codes.py::_init — graph/import neighbour (not a pivot: no direct evidence (graph/domain reach only))
- top discarded:
  - requests/sessions.py::rebuild_auth — beyond standard support budget (max 4)
  - requests/__init__.py::_check_cryptography — beyond standard support budget (max 4)
  - requests/__init__.py::check_compatibility — beyond standard support budget (max 4)
  - requests/help.py::info — beyond standard support budget (max 4)
  - requests/help.py::main — beyond standard support budget (max 4)

### pydata__xarray-3095 — hit_support / present_but_support

- expected: xarray/core/indexing.py, xarray/core/variable.py
- reason: —
- body-literal matches: s with dtype= -> NetCDF4DataStore, s with dtype= -> char_to_bytes, s with dtype= -> ensure_dtype_not_object, s with dtype= -> maybe_encode_nonstring_dtype, s with dtype= -> DatetimeAccessor, s with dtype= -> __init__, s with dtype= -> concatenate, s with dtype= -> stack, s with dtype= -> where, s with dtype= -> short_data_repr
- graph-neighbour expansions: xarray/conventions.py::ensure_dtype_not_object -[calls]-> xarray/coding/strings.py::is_bytes_dtype; xarray/conventions.py::maybe_encode_nonstring_dtype -[calls]-> xarray/core/duck_array_ops.py::around; xarray/backends/netCDF4_.py::NetCDF4DataStore -[contains]-> xarray/backends/netCDF4_.py::get_encoding; xarray/coding/strings.py::char_to_bytes -[calls]-> xarray/coding/strings.py::decode; xarray/core/accessor_dt.py::DatetimeAccessor -[contains]-> xarray/core/accessor_dt.py::month; xarray/backends/netCDF4_.py::NetCDF4DataStore -[contains]-> xarray/backends/netCDF4_.py::get_dimensions; xarray/core/formatting.py::short_data_repr -[calls]-> xarray/core/formatting.py::array_repr; xarray/backends/netCDF4_.py::NetCDF4DataStore -[contains]-> xarray/backends/netCDF4_.py::sync
- top pivots:
  - xarray/core/dataset.py::copy — existing method recovered from Class.method expansion — more actionable than containing class
  - xarray/core/dataarray.py::copy — existing method recovered from Class.method expansion — more actionable than containing class
- top support:
  - xarray/conventions.py::ensure_dtype_not_object — strong target beyond the pivot budget — task diagnostic literal appears in this symbol's body — explicit edit site
  - xarray/core/duck_array_ops.py::concatenate — strong target beyond the pivot budget — task diagnostic literal appears in this symbol's body — explicit edit site
  - xarray/core/alignment.py::reindex_variables — lexical match; issue-domain relevance (not a pivot: no direct evidence (graph/domain reach only))
  - xarray/core/variable.py::copy — entry point/caller delegating to local helpers — the edit site is the helper it calls
- top discarded:
  - xarray/core/duck_array_ops.py::where — beyond standard support budget (max 4)
  - xarray/core/duck_array_ops.py::stack — beyond standard support budget (max 4)
  - xarray/conventions.py::maybe_encode_nonstring_dtype — beyond standard support budget (max 4)
  - xarray/core/formatting.py::short_data_repr — beyond standard support budget (max 4)
  - xarray/coding/strings.py::char_to_bytes — beyond standard support budget (max 4)

### pydata__xarray-4687 — hit_discarded / present_but_discarded

- expected: xarray/core/computation.py
- reason: expected file recovered but discarded: xarray/core/computation.py — beyond standard support budget (max 4)
- graph-neighbour expansions: xarray/core/dataset.py::reindex -[calls]-> xarray/core/dataset.py::_reindex; xarray/core/dataarray.py::copy -[calls]-> xarray/core/dataarray.py::compute; xarray/core/dataset.py::reindex -[calls]-> xarray/core/dataset.py::interp_like; xarray/core/common.py::where -[calls]-> xarray/core/ops.py::where_method; xarray/core/dataarray.py::copy -[calls]-> xarray/core/dataarray.py::__deepcopy__; xarray/coding/cftimeindex.py::to_datetimeindex -[calls]-> xarray/coding/times.py::infer_calendar_name; xarray/core/variable.py::astype -[references]-> xarray/core/duck_array_ops.py::astype; xarray/core/dataset.py::reindex -[calls]-> xarray/core/dataset.py::reindex_like
- top pivots:
  - xarray/core/common.py::where — actionable method — strong lexical match; issue-domain relevance
  - xarray/core/dataarray.py::DataArray — actionable class — strong lexical match; 955 dependents
- top support:
  - xarray/core/dataset.py::copy — entry point/caller delegating to local helpers — the edit site is the helper it calls
  - xarray/core/variable.py::copy — entry point/caller delegating to local helpers — the edit site is the helper it calls
  - xarray/core/accessor_str.py::contains — lexical match; issue-domain relevance (not a pivot: no direct evidence (graph/domain reach only))
  - xarray/core/concat.py::concat — strong target beyond the pivot budget — actionable function — strong lexical match
- top discarded:
  - xarray/backends/api.py::open_dataset — beyond standard support budget (max 4)
  - xarray/core/dataarray.py::copy — beyond standard support budget (max 4)
  - xarray/core/computation.py::apply_ufunc — beyond standard support budget (max 4)
  - xarray/core/common.py::groupby_bins — beyond standard support budget (max 4)
  - xarray/core/dataset.py::reindex — beyond standard support budget (max 4)

### pydata__xarray-6721 — missing / wrong_subsystem

- expected: xarray/core/common.py
- reason: expected file not surfaced (candidate_count=25)
- graph-neighbour expansions: xarray/backends/zarr.py::get_array -[calls]-> xarray/backends/zarr.py::__getitem__; xarray/backends/memory.py::InMemoryDataStore -[contains]-> xarray/backends/memory.py::set_dimension; xarray/backends/memory.py::InMemoryDataStore -[contains]-> xarray/backends/memory.py::prepare_variable; xarray/backends/memory.py::InMemoryDataStore -[contains]-> xarray/backends/memory.py::get_variables; xarray/backends/memory.py::InMemoryDataStore -[contains]-> xarray/backends/memory.py::get_attrs; xarray/backends/zarr.py::extract_zarr_variable_encoding -[calls]-> xarray/backends/zarr.py::set_variables; xarray/backends/zarr.py::open_group -[calls]-> xarray/backends/zarr.py::open_dataset; xarray/backends/zarr.py::ZarrArrayWrapper -[contains]-> xarray/backends/zarr.py::__slots__
- top pivots:
  - xarray/backends/zarr.py::open_zarr — actionable function — strong lexical match; issue-domain relevance; 9 dependents
  - xarray/backends/zarr.py::_determine_zarr_chunks — local implementation helper whose name matches the issue — likely edit site
- top support:
  - xarray/backends/memory.py::InMemoryDataStore — strong target beyond the pivot budget — actionable class — symbol-name match; strong lexical match
  - xarray/backends/api.py::load_dataarray — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance
  - xarray/backends/zarr.py::encode_zarr_attr_value — strong target beyond the pivot budget — actionable function — symbol-name match; strong lexical match
  - xarray/backends/api.py::load_dataset — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance
- top discarded:
  - xarray/core/dataarray.py::load — beyond standard support budget (max 4)
  - xarray/core/variable.py::load — beyond standard support budget (max 4)
  - xarray/backends/zarr.py::ZarrArrayWrapper — beyond standard support budget (max 4)
  - xarray/backends/api.py::open_dataset — beyond standard support budget (max 4)
  - xarray/backends/zarr.py::get_array — beyond standard support budget (max 4)

### pydata__xarray-6744 — hit_support / present_but_support

- expected: xarray/core/rolling.py
- reason: —
- non-source candidates down-ranked: doc/examples/_code/accessor_example.py — path under doc/
- title-symbol terms: center, DataArrayRolling
- title-symbol matches: center -> doc/examples/_code/accessor_example.py::center; center -> xarray/core/accessor_str.py::center; DataArrayRolling -> xarray/core/rolling.py::DataArrayRolling
- literal-anchor terms: center
- literal-anchor matches: center -> doc/examples/_code/accessor_example.py::center; center -> xarray/core/accessor_str.py::center; center -> doc/examples/_code/accessor_example.py::GeoAccessor
- graph-neighbour expansions: xarray/core/accessor_str.py::center -[calls]-> xarray/core/accessor_str.py::_padder; xarray/core/accessor_str.py::center -[contains]-> xarray/core/accessor_str.py::StringAccessor; xarray/core/accessor_str.py::center -[references]-> xarray/core/accessor_str.py::pad
- top pivots:
  - xarray/core/accessor_str.py::center — actionable method — symbol-name match; lexical match; issue-domain relevance
  - xarray/core/rolling_exp.py::_get_center_of_mass — strong target beyond the pivot budget — actionable function — symbol-name match; lexical match; issue-domain relevance — pivot slot released by a later demotion
- top support:
  - xarray/core/dataarray.py::DataArray — lexical match; issue-domain relevance; graph/import neighbour; 996 dependents (not a pivot: high-degree framework root — support at most)
  - xarray/core/rolling.py::__init__ — lexical match; issue-domain relevance; graph/import neighbour (not a pivot: no direct evidence (graph/domain reach only))
  - xarray/core/pdcompat.py::count_not_none — likely co-edit sibling of a high-confidence anchor
  - doc/examples/_code/accessor_example.py::GeoAccessor — non-source example (path under doc/) — support, not an edit target
- top discarded:
  - doc/examples/_code/accessor_example.py::center — beyond standard support budget (max 4)
  - xarray/core/rolling.py::reduce — beyond standard support budget (max 4)
  - xarray/core/rolling.py::__init__ — beyond standard support budget (max 4)
  - xarray/core/rolling.py::__iter__ — beyond standard support budget (max 4)
  - xarray/core/rolling.py::_bottleneck_reduce — beyond standard support budget (max 4)

### pydata__xarray-7229 — hit_support / present_but_support

- expected: xarray/core/computation.py
- reason: —
- graph-neighbour expansions: xarray/core/_aggregations.py::var -[contains]-> xarray/core/_aggregations.py::DataArrayAggregations; xarray/core/rolling.py::construct -[contains]-> xarray/core/rolling.py::Coarsen; xarray/core/dataarray.py::idxmin -[calls]-> xarray/core/computation.py::_calc_idxminmax; xarray/core/common.py::astype -[references]-> xarray/core/duck_array_ops.py::astype; xarray/core/_aggregations.py::var -[contains]-> xarray/core/_aggregations.py::DatasetAggregations; xarray/core/rolling.py::construct -[references]-> xarray/core/rolling.py::obj
- top pivots:
  - xarray/core/common.py::astype — actionable method — strong lexical match
  - xarray/core/dataarray.py::interpolate_na — actionable method — strong lexical match
- top support:
  - xarray/core/rolling.py::_get_keep_attrs — strong target beyond the pivot budget — local implementation helper invoked by the entry point — likely edit site
  - xarray/core/dataset.py::Dataset — lexical match; graph/import neighbour; 718 dependents (not a pivot: high-degree framework root — support at most)
  - xarray/core/computation.py::where — lexical match; issue-domain relevance; graph/import neighbour; 8 dependents (not a pivot: high-degree framework root — support at most)
  - xarray/core/coordinates.py::assert_coordinate_consistent — likely co-edit sibling of a high-confidence anchor
- top discarded:
  - xarray/core/rolling.py::_get_keep_attrs — beyond standard support budget (max 4)
  - xarray/core/_aggregations.py::std — beyond standard support budget (max 4)
  - xarray/core/options.py::set_options — beyond standard support budget (max 4)
  - xarray/core/dataset.py::idxmax — beyond standard support budget (max 4)
  - xarray/core/dataset.py::idxmin — beyond standard support budget (max 4)

### pylint-dev__pylint-4661 — hit_discarded / present_but_discarded

- expected: pylint/config/__init__.py, setup.cfg
- reason: expected file recovered but discarded: pylint/config/__init__.py — beyond standard support budget (max 4)
- graph-neighbour expansions: pylint/checkers/base_checker.py::__str__ -[references]-> pylint/checkers/base_checker.py::reports; pylint/checkers/base_checker.py::check_consistency -[references]-> pylint/checkers/base_checker.py::messages; pylint/checkers/imports.py::_make_tree_defs -[calls]-> pylint/checkers/imports.py::_report_external_dependencies; pylint/checkers/base_checker.py::__str__ -[calls]-> pylint/config/options_provider_mixin.py::options_and_values; pylint/checkers/base_checker.py::__str__ -[calls]-> pylint/checkers/base_checker.py::get_full_documentation
- generic lexical decoys suppressed: base -> pylint/checkers/base.py
- top pivots:
  - pylint/checkers/base_checker.py::__str__ — actionable method — strong lexical match; issue-domain relevance
  - pylint/reporters/base_reporter.py::display_messages — actionable method — strong lexical match; issue-domain relevance
- top support:
  - pylint/checkers/imports.py::_make_tree_defs — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance
  - pylint/checkers/base_checker.py::__init__ — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance; 18 dependents
  - pylint/checkers/base_checker.py::BaseTokenChecker — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance; 14 dependents
  - pylint/checkers/base_checker.py::BaseChecker — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance; 60 dependents
- top discarded:
  - pylint/checkers/refactoring/refactoring_checker.py::__init__ — beyond standard support budget (max 4)
  - pylint/reporters/collecting_reporter.py::__init__ — beyond standard support budget (max 4)
  - pylint/checkers/base_checker.py::add_message — beyond standard support budget (max 4)
  - pylint/checkers/exceptions.py::BaseVisitor — beyond standard support budget (max 4)
  - pylint/checkers/base_checker.py::check_consistency — beyond standard support budget (max 4)

### pylint-dev__pylint-6528 — hit_discarded / present_but_discarded

- expected: pylint/lint/expand_modules.py, pylint/lint/pylinter.py
- reason: expected file recovered but discarded: pylint/lint/pylinter.py — beyond standard support budget (max 4)
- down-weighted lexical tokens: bug
- graph-neighbour expansions: pylint/checkers/base/name_checker/checker.py::_recursive_check_names -[calls]-> pylint/checkers/base/name_checker/checker.py::visit_functiondef; pylint/lint/pylinter.py::_parse_error_mode -[calls]-> pylint/lint/message_state_handler.py::disable_noerror_messages; pylint/config/help_formatter.py::get_long_description -[references]-> pylint/constants.py::DEFAULT_PYLINT_HOME; pylint/checkers/variables.py::_find_assigned_names_recursive -[calls]-> pylint/checkers/variables.py::leave_functiondef; pylint/lint/pylinter.py::add_ignored_message -[calls]-> pylint/lint/message_state_handler.py::_get_message_state_scope; pylint/checkers/stdlib.py::_check_mode_str -[calls]-> pylint/checkers/stdlib.py::_check_open_call; pylint/checkers/base/name_checker/checker.py::_recursive_check_names -[contains]-> pylint/checkers/base/name_checker/checker.py::NameChecker; pylint/checkers/unicode.py::description -[references]-> pylint/checkers/unicode.py::escaped
- top pivots:
  - pylint/checkers/utils.py::node_ignores_exception — actionable function — strong lexical match; issue-domain relevance; 8 dependents
  - pylint/checkers/variables.py::_recursive_search_for_continue_before_break — actionable method — strong lexical match; issue-domain relevance
- top support:
  - pylint/checkers/base/name_checker/checker.py::_recursive_check_names — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - pylint/checkers/unicode.py::description — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - pylint/lint/message_state_handler.py::_MessageStateHandler — likely co-edit sibling of a high-confidence anchor
  - pylint/checkers/utils.py::_except_handlers_ignores_exceptions — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance
- top discarded:
  - pylint/checkers/variables.py::_find_assigned_names_recursive — beyond standard support budget (max 4)
  - pylint/lint/pylinter.py::add_ignored_message — beyond standard support budget (max 4)
  - pylint/config/help_formatter.py::get_long_description — beyond standard support budget (max 4)
  - pylint/checkers/typecheck.py::_suggestion_mode — beyond standard support budget (max 4)
  - pylint/checkers/stdlib.py::_check_mode_str — beyond standard support budget (max 4)

### pylint-dev__pylint-6903 — missing / wrong_subsystem

- expected: pylint/lint/run.py
- reason: expected file not surfaced (candidate_count=31)
- down-weighted lexical tokens: running, bug, errors, value, error
- de-anchored exception tokens: value
- graph-neighbour expansions: pylint/typing.py::ErrorDescriptionDict -[contains]-> pylint/typing.py::ex; pylint/checkers/base/basic_error_checker.py::_check_in_loop -[calls]-> pylint/checkers/base/basic_error_checker.py::visit_break; pylint/typing.py::ErrorDescriptionDict -[references]-> pylint/lint/expand_modules.py::expand_modules; pylint/exceptions.py::InvalidReporterError -[calls]-> pylint/lint/pylinter.py::_load_reporter_by_name; pylint/checkers/base/basic_error_checker.py::_check_else_on_loop -[calls]-> pylint/checkers/base/basic_error_checker.py::visit_for; pylint/checkers/base/basic_error_checker.py::_check_else_on_loop -[calls]-> pylint/checkers/base/basic_error_checker.py::visit_while; pylint/checkers/utils.py::error_of_type -[calls]-> pylint/checkers/base/name_checker/checker.py::_redefines_import; pylint/checkers/base/basic_error_checker.py::redefined_by_decorator -[calls]-> pylint/checkers/base/basic_error_checker.py::visit_functiondef
- top pivots:
  - pylint/typing.py::ErrorDescriptionDict — actionable class — strong lexical match; issue-domain relevance
  - pylint/exceptions.py::InvalidArgsError — actionable class — strong lexical match; issue-domain relevance
- top support:
  - pylint/checkers/base/basic_error_checker.py::msgs — strong lexical match; issue-domain relevance (not a pivot: module_variable is a low-actionability edit target)
  - pylint/checkers/base/basic_error_checker.py::redefined_by_decorator — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance
  - pylint/checkers/utils.py::error_of_type — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance
  - pylint/checkers/base/basic_error_checker.py::_check_in_loop — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
- top discarded:
  - pylint/checkers/base/basic_error_checker.py::_loop_exits_early — beyond standard support budget (max 4)
  - pylint/checkers/base/basic_error_checker.py::visit_call — beyond standard support budget (max 4)
  - pylint/checkers/base/basic_error_checker.py::_check_else_on_loop — beyond standard support budget (max 4)
  - pylint/checkers/base/basic_error_checker.py::_has_abstract_methods — beyond standard support budget (max 4)
  - pylint/exceptions.py::InvalidMessageError — beyond standard support budget (max 4)

### pytest-dev__pytest-10356 — missing / missing_from_candidates

- expected: src/_pytest/mark/structures.py
- reason: expected file not surfaced (candidate_count=29)
- literal-anchor terms: Foo, Bar, MRO
- literal-anchor matches: Foo -> bench/manyparam.py::foo
- graph-neighbour expansions: src/_pytest/capture.py::CaptureManager -[contains]-> src/_pytest/capture.py::item_capture; src/_pytest/python.py::_inject_setup_class_fixture -[calls]-> src/_pytest/unittest.py::collect; src/_pytest/capture.py::CaptureManager -[contains]-> src/_pytest/capture.py::is_capturing; src/_pytest/capture.py::CaptureManager -[calls]-> src/_pytest/capture.py::pytest_load_initial_conftests; src/_pytest/capture.py::CaptureManager -[contains]-> src/_pytest/capture.py::pytest_runtest_setup; src/_pytest/config/__init__.py::_consider_importhook -[calls]-> src/_pytest/config/__init__.py::_preparse; src/_pytest/python.py::_inject_setup_class_fixture -[calls]-> src/_pytest/python.py::collect; src/_pytest/config/__init__.py::_consider_importhook -[calls]-> src/_pytest/config/__init__.py::_mark_plugins_for_rewrite
- top pivots:
  - bench/manyparam.py::foo — actionable function — symbol-name match; lexical match; issue-domain relevance
  - src/_pytest/python_api.py::approx — actionable function — strong lexical match; issue-domain relevance; 57 dependents
- top support:
  - src/_pytest/config/__init__.py::_consider_importhook — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - src/_pytest/hookspec.py::pytest_markeval_namespace — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance
  - pyproject.toml::pyproject.toml — TOML configuration matches task objectives
  - .github/workflows/test.yml::test.yml — YAML configuration matches task objectives
- top discarded:
  - src/_pytest/capture.py::CaptureManager — beyond standard support budget (max 4)
  - src/_pytest/outcomes.py::skip — beyond standard support budget (max 4)
  - src/_pytest/nodes.py::iter_markers — beyond standard support budget (max 4)
  - src/_pytest/mark/expression.py::compile — beyond standard support budget (max 4)
  - src/_pytest/nodes.py::iter_markers_with_node — beyond standard support budget (max 4)

### pytest-dev__pytest-7324 — missing / line_anchor_not_resolved

- expected: src/_pytest/mark/expression.py
- reason: expected file not surfaced (candidate_count=28)
- down-weighted lexical tokens: failed
- non-source candidates down-ranked: doc/en/example/multipython.py — path under doc/
- top pivots:
  - src/_pytest/_code/code.py::is_true — actionable method — symbol-name match; lexical match; issue-domain relevance
  - src/_pytest/hookspec.py::pytest_assertion_pass — strong target beyond the pivot budget — local implementation helper whose name matches the issue — likely edit site — pivot slot released by a later demotion
- top support:
  - src/_pytest/doctest.py::DOCTEST_REPORT_CHOICE_NONE — symbol-name match; lexical match; issue-domain relevance (not a pivot: module_constant is a low-actionability edit target)
  - src/_pytest/pytester.py::Testdir — lexical match; issue-domain relevance; graph/import neighbour; 80 dependents (not a pivot: high-degree framework root — support at most)
  - pyproject.toml::pyproject.toml — TOML configuration matches task objectives
  - .github/workflows/main.yml::main.yml — YAML configuration matches task objectives
- top discarded:
  - doc/en/example/multipython.py::load_and_is_true — beyond standard support budget (max 4)
  - src/_pytest/assertion/rewrite.py::visit_Assert — beyond standard support budget (max 4)
  - src/_pytest/pytester.py::fnmatch_lines — beyond standard support budget (max 4)
  - src/_pytest/hookspec.py::pytest_pycollect_makeitem — beyond standard support budget (max 4)
  - src/_pytest/pytester.py::runpython — beyond standard support budget (max 4)

### pytest-dev__pytest-7490 — missing / missing_from_candidates

- expected: src/_pytest/skipping.py
- reason: expected file not surfaced (candidate_count=31)
- down-weighted lexical tokens: failure
- graph-neighbour expansions: src/_pytest/nodes.py::repr_failure -[calls]-> src/_pytest/nodes.py::_repr_failure_py; src/_pytest/nodes.py::add_marker -[references]-> src/_pytest/mark/structures.py::MarkDecorator; src/_pytest/config/__init__.py::filter_traceback_for_conftest_import_failure -[calls]-> src/_pytest/_code/code.py::filter_traceback
- top pivots:
  - src/_pytest/outcomes.py::xfail — actionable function — strong lexical match; issue-domain relevance; 7 dependents
  - src/_pytest/nodes.py::add_marker — actionable method — strong lexical match; issue-domain relevance
- top support:
  - src/_pytest/config/__init__.py::filter_traceback_for_conftest_import_failure — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance
  - src/_pytest/hookspec.py::pytest_ignore_collect — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance
  - pyproject.toml::pyproject.toml — TOML configuration matches task objectives
  - .travis.yml::.travis.yml — YAML configuration matches task objectives
- top discarded:
  - src/_pytest/nodes.py::repr_failure — beyond standard support budget (max 4)
  - src/_pytest/hookspec.py::pytest_addhooks — beyond standard support budget (max 4)
  - src/_pytest/hookspec.py::pytest_terminal_summary — beyond standard support budget (max 4)
  - src/_pytest/mark/structures.py::MarkDecorator — beyond standard support budget (max 4)
  - src/_pytest/_code/code.py::filter_traceback — beyond standard support budget (max 4)

### scikit-learn__scikit-learn-13142 — missing / body_literal_not_resolved

- expected: sklearn/mixture/base.py
- reason: expected file not surfaced (candidate_count=25)
- down-weighted lexical tokens: different
- title-symbol terms: GaussianMixture, fit_predict, n_init
- title-symbol matches: GaussianMixture -> sklearn/mixture/gaussian_mixture.py::GaussianMixture; fit_predict -> sklearn/pipeline.py::fit_predict; fit_predict -> sklearn/base.py::fit_predict; fit_predict -> sklearn/base.py::fit_predict
- literal-anchor terms: n_init
- literal-anchor matches: n_init -> benchmarks/bench_plot_nmf.py::run_bench; n_init -> sklearn/base.py::BaseEstimator; n_init -> sklearn/base.py::_get_param_names
- graph-neighbour expansions: sklearn/base.py::BaseEstimator -[references]-> sklearn/cluster/bicluster.py::BaseSpectral; sklearn/base.py::BaseEstimator -[references]-> sklearn/multiclass.py::_ConstantPredictor; sklearn/base.py::BaseEstimator -[references]-> sklearn/manifold/mds.py::MDS; sklearn/mixture/gaussian_mixture.py::GaussianMixture -[contains]-> sklearn/mixture/gaussian_mixture.py::_m_step; sklearn/base.py::BaseEstimator -[references]-> examples/compose/plot_column_transformer.py::SubjectBodyExtractor; benchmarks/bench_plot_nmf.py::run_bench -[calls]-> benchmarks/bench_plot_nmf.py::plot_results; sklearn/mixture/gaussian_mixture.py::GaussianMixture -[contains]-> sklearn/mixture/gaussian_mixture.py::_estimate_log_prob
- top pivots:
  - benchmarks/bench_plot_nmf.py::run_bench — actionable function — symbol-name match; strong lexical match
  - sklearn/base.py::BaseEstimator — actionable class — symbol-name match; strong lexical match
  - sklearn/mixture/gaussian_mixture.py::GaussianMixture — actionable class — symbol-name match
- top support:
  - sklearn/cluster/k_means_.py::fit — strong target beyond the pivot budget — actionable method — symbol-name match; lexical match; issue-domain relevance; graph/import neighbour
  - sklearn/svm/libsvm.pyx::predict — strong target beyond the pivot budget — actionable function — symbol-name match; strong lexical match
  - sklearn/mixture/bayesian_mixture.py::_checkcovariance_prior_parameter — likely co-edit sibling of a high-confidence anchor
- top discarded:
  - sklearn/utils/metaestimators.py::if_delegate_has_method — beyond standard support budget (max 3)
  - sklearn/base.py::_get_param_names — beyond standard support budget (max 3)
  - sklearn/cluster/dbscan_.py::fit_predict — beyond standard support budget (max 3)
  - sklearn/cluster/k_means_.py::fit_predict — beyond standard support budget (max 3)
  - sklearn/base.py::fit_predict — beyond standard support budget (max 3)

### sphinx-doc__sphinx-7454 — missing / wrong_subsystem

- expected: sphinx/domains/python.py
- reason: expected file not surfaced (candidate_count=31)
- down-weighted lexical tokens: bug
- graph-neighbour expansions: sphinx/domains/cpp.py::describe_signature -[contains]-> sphinx/domains/cpp.py::ASTPostfixMemberOfPointer; sphinx/domains/c.py::describe_signature -[contains]-> sphinx/domains/c.py::ASTArray; sphinx/domains/c.py::describe_signature -[contains]-> sphinx/domains/c.py::ASTEnumerator; sphinx/domains/c.py::describe_signature -[calls]-> sphinx/domains/c.py::is_anon; sphinx/domains/c.py::describe_signature -[contains]-> sphinx/domains/c.py::ASTPostfixMemberOfPointer; sphinx/domains/c.py::describe_signature -[contains]-> sphinx/domains/c.py::ASTEnum
- top pivots:
  - sphinx/ext/autodoc/typehints.py::record_typehints — actionable function — strong lexical match; issue-domain relevance
  - sphinx/ext/autodoc/typehints.py::modify_field_list — local implementation helper invoked by the entry point — likely edit site
- top support:
  - sphinx/domains/c.py::describe_signature — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - sphinx/util/cfamily.py::StringifyTransform — likely co-edit sibling of a high-confidence anchor
  - sphinx/ext/autodoc/typehints.py::insert_field_list — strong target beyond the pivot budget — local implementation helper invoked by the entry point — likely edit site
  - sphinx/ext/autodoc/typehints.py::merge_typehints — entry point/caller delegating to local helpers — the edit site is the helper it calls
- top discarded:
  - sphinx/ext/autodoc/typehints.py::setup — beyond standard support budget (max 4)
  - sphinx/domains/c.py::describe_signature — beyond standard support budget (max 4)
  - sphinx/domains/cpp.py::describe_signature — beyond standard support budget (max 4)
  - sphinx/domains/c.py::describe_signature — beyond standard support budget (max 4)
  - sphinx/domains/c.py::describe_signature — beyond standard support budget (max 4)

### sphinx-doc__sphinx-7757 — missing / wrong_subsystem

- expected: sphinx/util/inspect.py
- reason: expected file not surfaced (candidate_count=25)
- down-weighted lexical tokens: bug
- graph-neighbour expansions: sphinx/domains/cpp.py::describe_signature_as_introducer -[contains]-> sphinx/domains/cpp.py::ASTTemplateIntroduction; sphinx/cmd/build.py::jobs_argument -[references]-> sphinx/cmd/build.py::get_parser; sphinx/transforms/compact_bullet_list.py::default_visit -[contains]-> sphinx/transforms/compact_bullet_list.py::RefOnlyListChecker; sphinx/domains/cpp.py::describe_signature -[contains]-> sphinx/domains/cpp.py::ASTTemplateKeyParamPackIdDefault
- top pivots:
  - sphinx/application.py::add_config_value — actionable method — strong lexical match; issue-domain relevance
  - sphinx/domains/cpp.py::describe_signature_as_introducer — actionable method — strong lexical match; issue-domain relevance
- top support:
  - sphinx/transforms/compact_bullet_list.py::default_visit — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - sphinx/domains/javascript.py::has_arguments — strong lexical match; issue-domain relevance (not a pivot: module_variable is a low-actionability edit target)
  - sphinx/addnodes.py::index — strong target beyond the pivot budget — actionable class — strong lexical match; 57 dependents
  - sphinx/locale/__init__.py::setlocale — strong target beyond the pivot budget — actionable function — strong lexical match
- top discarded:
  - sphinx/domains/cpp.py::describe_signature — beyond standard support budget (max 4)
  - sphinx/domains/javascript.py::has_arguments — beyond standard support budget (max 4)
  - sphinx/cmd/build.py::jobs_argument — beyond standard support budget (max 4)
  - sphinx/domains/cpp.py::describe_signature — beyond standard support budget (max 4)
  - sphinx/domains/c.py::describe_signature — beyond standard support budget (max 4)

### sphinx-doc__sphinx-9258 — skipped_no_context / present_but_discarded

- expected: sphinx/domains/python.py
- reason: capsule returned no_context (no high-confidence edit target)
- down-weighted lexical tokens: support, multiple
- non-source candidates down-ranked: doc/usage/extensions/example_google.py — path under doc/; doc/usage/extensions/example_numpy.py — path under doc/
- top pivots: (none)
- top support: (none)
- top discarded:
  - sphinx/domains/c.py::object_types — support-only: no actionable edit target
  - sphinx/domains/cpp.py::ASTParametersQualifiers — support-only: no actionable edit target
  - sphinx/ext/napoleon/docstring.py::_parse_parameters_section — support-only: no actionable edit target
  - doc/usage/extensions/example_google.py::function_with_types_in_docstring — support-only: no actionable edit target
  - doc/usage/extensions/example_numpy.py::function_with_types_in_docstring — support-only: no actionable edit target

### sphinx-doc__sphinx-9602 — missing / missing_from_candidates

- expected: sphinx/domains/python.py
- reason: expected file not surfaced (candidate_count=31)
- down-weighted lexical tokens: bug
- graph-neighbour expansions: sphinx/ext/inheritance_diagram.py::_class_info -[contains]-> sphinx/ext/inheritance_diagram.py::InheritanceGraph; sphinx/domains/c.py::describe_signature -[calls]-> sphinx/addnodes.py::desc_sig_literal_string; sphinx/domains/cpp.py::describe_signature -[contains]-> sphinx/domains/cpp.py::ASTBooleanLiteral; sphinx/transforms/post_transforms/code.py::TrimDoctestFlagsTransform -[contains]-> sphinx/transforms/post_transforms/code.py::default_priority; sphinx/domains/cpp.py::describe_signature -[calls]-> sphinx/addnodes.py::desc_sig_literal_number; sphinx/domains/c.py::describe_signature -[contains]-> sphinx/domains/c.py::ASTCharLiteral; sphinx/domains/c.py::describe_signature -[contains]-> sphinx/domains/c.py::ASTBooleanLiteral; sphinx/domains/c.py::describe_signature -[contains]-> sphinx/domains/c.py::ASTStringLiteral
- top pivots:
  - sphinx/writers/texinfo.py::visit_desc_annotation — actionable method — strong lexical match; issue-domain relevance
  - sphinx/addnodes.py::desc_annotation — actionable class — strong lexical match; issue-domain relevance; 26 dependents
- top support:
  - sphinx/application.py::add_config_value — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - sphinx/ext/inheritance_diagram.py::_class_info — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - sphinx/domains/c.py::describe_signature — entry point/caller delegating to local helpers — the edit site is the helper it calls
  - sphinx/domains/cpp.py::describe_signature — entry point/caller delegating to local helpers — the edit site is the helper it calls
- top discarded:
  - sphinx/config.py::config_values — beyond standard support budget (max 4)
  - sphinx/domains/c.py::describe_signature — beyond standard support budget (max 4)
  - sphinx/domains/c.py::describe_signature — beyond standard support budget (max 4)
  - sphinx/domains/c.py::describe_signature — beyond standard support budget (max 4)
  - sphinx/domains/cpp.py::describe_signature — beyond standard support budget (max 4)

### sphinx-doc__sphinx-9658 — missing / missing_from_candidates

- expected: sphinx/ext/autodoc/mock.py
- reason: expected file not surfaced (candidate_count=30)
- down-weighted lexical tokens: bug
- graph-neighbour expansions: sphinx/directives/__init__.py::ObjectDescription -[contains]-> sphinx/directives/__init__.py::domain; sphinx/ext/inheritance_diagram.py::InheritanceGraph -[contains]-> sphinx/ext/inheritance_diagram.py::_import_classes; sphinx/directives/__init__.py::ObjectDescription -[contains]-> sphinx/directives/__init__.py::add_target_and_index; sphinx/directives/__init__.py::ObjectDescription -[contains]-> sphinx/directives/__init__.py::handle_signature; sphinx/ext/autosummary/__init__.py::get_documenter -[calls]-> sphinx/ext/autosummary/__init__.py::FakeDirective; sphinx/ext/autodoc/__init__.py::NonDataDescriptorMixin -[contains]-> sphinx/ext/autodoc/__init__.py::should_suppress_value_header; sphinx/ext/autosummary/__init__.py::get_documenter -[calls]-> sphinx/ext/autosummary/generate.py::generate_autosummary_content; sphinx/directives/__init__.py::ObjectDescription -[contains]-> sphinx/directives/__init__.py::doc_field_types
- top pivots:
  - sphinx/ext/inheritance_diagram.py::class_name — actionable method — strong lexical match; issue-domain relevance
  - sphinx/ext/autodoc/__init__.py::ClassDocumenter — actionable class — strong lexical match; issue-domain relevance; 5 dependents
- top support:
  - sphinx/addnodes.py::document — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance
  - sphinx/ext/autodoc/__init__.py::ClassLevelDocumenter — lexical match; issue-domain relevance (not a pivot: no direct evidence (graph/domain reach only))
  - sphinx/ext/autodoc/__init__.py::Documenter — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance; 9 dependents
  - sphinx/ext/autodoc/__init__.py::NonDataDescriptorMixin — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance
- top discarded:
  - sphinx/ext/inheritance_diagram.py::InheritanceDiagram — beyond standard support budget (max 4)
  - sphinx/ext/autosummary/__init__.py::get_documenter — beyond standard support budget (max 4)
  - sphinx/domains/c.py::describe_signature — beyond standard support budget (max 4)
  - sphinx/ext/inheritance_diagram.py::InheritanceGraph — beyond standard support budget (max 4)
  - sphinx/domains/cpp.py::describe_signature — beyond standard support budget (max 4)

### sympy__sympy-13031 — missing / missing_from_candidates

- expected: sympy/matrices/sparse.py
- reason: expected file not surfaced (candidate_count=31)
- graph-neighbour expansions: sympy/matrices/matrices.py::eigenvects -[calls]-> sympy/matrices/matrices.py::is_diagonalizable; sympy/polys/fglmtools.py::matrix_fglm -[calls]-> sympy/polys/fglmtools.py::_identity_matrix; sympy/matrices/matrices.py::LUdecomposition_Simple -[calls]-> sympy/matrices/matrices.py::LUsolve; sympy/matrices/matrices.py::eigenvects -[calls]-> sympy/matrices/matrices.py::diagonalize; sympy/physics/quantum/identitysearch.py::is_scalar_sparse_matrix -[references]-> sympy/physics/quantum/identitysearch.py::np; sympy/matrices/common.py::hstack -[calls]-> sympy/holonomic/linearsolver.py::gauss_jordan_solve; sympy/physics/mechanics/linearize.py::permutation_matrix -[calls]-> sympy/physics/mechanics/linearize.py::_form_permutation_matrices; sympy/matrices/matrices.py::LUdecomposition_Simple -[calls]-> sympy/matrices/matrices.py::LUdecomposition
- top pivots:
  - sympy/matrices/common.py::hstack — actionable method — strong lexical match; issue-domain relevance
  - sympy/matrices/common.py::vstack — actionable method — strong lexical match; issue-domain relevance
- top support:
  - sympy/matrices/matrices.py::is_diagonalizable — lexical match; issue-domain relevance; graph/import neighbour (not a pivot: no direct evidence (graph/domain reach only))
  - sympy/core/sympify.py::sympify — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance; 393 dependents
  - sympy/matrices/dense.py::matrix_multiply_elementwise — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance
  - sympy/matrices/matrices.py::LUdecomposition_Simple — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
- top discarded:
  - sympy/matrices/matrices.py::nullspace — beyond standard support budget (max 4)
  - sympy/matrices/expressions/slice.py::MatrixSlice — beyond standard support budget (max 4)
  - sympy/physics/quantum/identitysearch.py::is_scalar_sparse_matrix — beyond standard support budget (max 4)
  - sympy/matrices/expressions/matexpr.py::MatrixSymbol — beyond standard support budget (max 4)
  - sympy/plotting/pygletplot/util.py::billboard_matrix — beyond standard support budget (max 4)

### sympy__sympy-16450 — hit_discarded / present_but_discarded

- expected: sympy/simplify/simplify.py
- reason: expected file recovered but discarded: sympy/simplify/simplify.py — beyond standard support budget (max 4)
- title-symbol terms: is_finite
- title-symbol matches: is_finite -> sympy/core/numbers.py::is_finite; is_finite -> sympy/core/numbers.py::is_finite; is_finite -> sympy/core/numbers.py::is_finite
- graph-neighbour expansions: sympy/core/symbol.py::Symbol -[calls]-> sympy/solvers/ode.py::_linear_2eq_order1_type5; sympy/core/symbol.py::Symbol -[references]-> sympy/utilities/codegen.py::__init__; sympy/core/symbol.py::Symbol -[calls]-> sympy/polys/specialpolys.py::fateman_poly_F_2; sympy/core/symbol.py::Symbol -[references]-> sympy/solvers/ode.py::sysode_nonlinear_2eq_order1
- top pivots:
  - sympy/assumptions/ask.py::finite — actionable method — strong lexical match; issue-domain relevance
  - sympy/assumptions/handlers/calculus.py::AskFiniteHandler — actionable class — strong lexical match; issue-domain relevance
- top support:
  - sympy/core/numbers.py::is_finite — symbol-name match (not a pivot: module_variable is a low-actionability edit target)
  - sympy/core/symbol.py::Symbol — strong target beyond the pivot budget — actionable class — symbol-name match; strong lexical match
  - sympy/assumptions/assume.py::add — lexical match; issue-domain relevance; graph/import neighbour (not a pivot: no direct evidence (graph/domain reach only))
  - sympy/core/numbers.py::is_finite — symbol-name match (not a pivot: module_variable is a low-actionability edit target)
- top discarded:
  - sympy/core/numbers.py::is_finite — beyond standard support budget (max 4)
  - sympy/integrals/rubi/symbol.py::matchpyWC — beyond standard support budget (max 4)
  - sympy/assumptions/ask.py::remove_handler — beyond standard support budget (max 4)
  - sympy/assumptions/assume.py::remove_handler — beyond standard support budget (max 4)
  - sympy/assumptions/handlers/calculus.py::Symbol — beyond standard support budget (max 4)

### sympy__sympy-18698 — hit_discarded / present_but_discarded

- expected: sympy/polys/polytools.py
- reason: expected file recovered but discarded: sympy/polys/polytools.py — beyond standard support budget (max 4)
- title-symbol terms: sqf_list
- title-symbol matches: sqf_list -> sympy/polys/polytools.py::sqf_list; sqf_list -> sympy/polys/polytools.py::sqf_list; sqf_list -> sympy/polys/polyclasses.py::sqf_list
- graph-neighbour expansions: sympy/ntheory/factor_.py::multiplicity_in_factorial -[calls]-> sympy/ntheory/factor_.py::digits; sympy/polys/galoistools.py::gf_sqf_list -[calls]-> sympy/polys/galoistools.py::gf_factor; sympy/ntheory/factor_.py::smoothness_p -[calls]-> sympy/ntheory/factor_.py::smoothness; sympy/ntheory/factor_.py::primefactors -[calls]-> sympy/combinatorics/perm_groups.py::abelian_invariants; sympy/ntheory/factor_.py::factorrat -[calls]-> sympy/integrals/rubi/utility_function.py::FactorInteger; sympy/polys/polytools.py::sqf_list -[calls]-> sympy/integrals/rubi/utility_function.py::FactorSquareFreeList; sympy/polys/polytools.py::sqf_list -[calls]-> sympy/polys/polytools.py::_generic_factor_list; sympy/polys/galoistools.py::gf_sqf_list -[calls]-> sympy/polys/sqfreetools.py::dup_gf_sqf_list
- top pivots:
  - sympy/polys/galoistools.py::gf_sqf_list — actionable function — strong lexical match; issue-domain relevance
  - sympy/ntheory/factor_.py::multiplicity_in_factorial — actionable function — strong lexical match; issue-domain relevance
- top support:
  - sympy/polys/polyclasses.py::sqf_list — lexical match; issue-domain relevance (not a pivot: no direct evidence (graph/domain reach only))
  - sympy/holonomic/holonomic.py::_have_init_cond — strong target beyond the pivot budget — actionable method — symbol-name match; lexical match; 9 dependents
  - sympy/ntheory/factor_.py::_check_termination — strong target beyond the pivot budget — local implementation helper invoked by the entry point — likely edit site
  - sympy/ntheory/factor_.py::_factorint_small — strong target beyond the pivot budget — local implementation helper invoked by the entry point — likely edit site
- top discarded:
  - sympy/ntheory/factor_.py::pollard_rho — beyond standard support budget (max 4)
  - sympy/ntheory/factor_.py::smoothness_p — beyond standard support budget (max 4)
  - sympy/ntheory/factor_.py::multiplicity — beyond standard support budget (max 4)
  - sympy/ntheory/factor_.py::factorint — beyond standard support budget (max 4)
  - sympy/ntheory/factor_.py::pollard_pm1 — beyond standard support budget (max 4)

## Notes

- `expected_files` / `expected_symbols` are EVALUATION LABELS only. They are
  read from the fixture to score the capsule and are NEVER passed into Capsule
  v2 retrieval — production retrieval receives only `(task, intent, budget)`.
- No instance IDs or expected paths are hardcoded in production Capsule v2 logic.
- This stage measures retrieval quality only; it runs no Claude, Docker, or
  vexp agent execution and makes no API calls.
- `passing_model_patch` labels are reported separately: a miss against one may
  reflect a valid ALTERNATIVE fix site rather than a retrieval failure.
