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
| instances_total | 30 |
| instances_evaluated | 30 |
| workspace_error_count | 0 |
| no_context_count | 0 |
| top_1_file_accuracy | 66.7% |
| top_3_file_recall | 73.3% |
| expected_file_as_pivot_rate | 70.0% |
| expected_file_as_support_rate | 20.0% |
| expected_file_discarded_rate | 3.3% |
| expected_file_missing_rate | 6.7% |
| expected_symbol_hit_rate | 66.7% |
| expected_symbol_as_pivot_rate | 26.7% |
| mean_capsule_tokens | 4160.8 |
| mean_pivot_count | 2.17 |
| mean_support_count | 50.70 |

## Comparison vs prior cross-repo baseline

Does Capsule v2 retrieval stay stable as cross-repo coverage grows from 16 to 30 non-Django instances? Delta is in percentage points; for **missing**, lower is better.

| metric | previous 16-instance cross-repo | new 30-instance cross-repo | delta |
| --- | --- | --- | --- |
| top-1 file accuracy | 62.5% | 66.7% | +4.2 pp ▲ |
| top-3 file recall | 87.5% | 73.3% | -14.2 pp ▼ |
| expected file as pivot | 81.3% | 70.0% | -11.3 pp ▼ |
| expected file missing | 6.3% | 6.7% | +0.4 pp ▼ |

## Aggregate metrics — by label source

All 30 instances share one label source (gold_patch); see the table above.

## Metrics by repo

| repo | instances | top-1 file | top-3 file | as pivot | missing | mean tokens | mean pivots | mean support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy/sympy | 5/5 | 60.0% | 60.0% | 60.0% | 0.0% | 4249.0 | 2.20 | 51.00 |
| astropy/astropy | 4/4 | 50.0% | 75.0% | 75.0% | 0.0% | 5692.0 | 2.50 | 55.00 |
| matplotlib/matplotlib | 4/4 | 50.0% | 75.0% | 50.0% | 25.0% | 4509.0 | 2.00 | 56.00 |
| sphinx-doc/sphinx | 4/4 | 50.0% | 50.0% | 50.0% | 25.0% | 2551.0 | 2.00 | 46.75 |
| psf/requests | 3/3 | 100.0% | 100.0% | 100.0% | 0.0% | 2583.3 | 2.00 | 40.33 |
| pytest-dev/pytest | 3/3 | 100.0% | 100.0% | 100.0% | 0.0% | 2718.0 | 2.00 | 49.67 |
| pydata/xarray | 2/2 | 50.0% | 50.0% | 50.0% | 0.0% | 3298.0 | 3.00 | 49.00 |
| scikit-learn/scikit-learn | 2/2 | 100.0% | 100.0% | 100.0% | 0.0% | 7016.0 | 2.00 | 67.50 |
| mwaskom/seaborn | 1/1 | 100.0% | 100.0% | 100.0% | 0.0% | 6824.0 | 2.00 | 52.00 |
| pallets/flask | 1/1 | 100.0% | 100.0% | 100.0% | 0.0% | 7701.0 | 2.00 | 51.00 |
| pylint-dev/pylint | 1/1 | 0.0% | 0.0% | 0.0% | 0.0% | 1514.0 | 2.00 | 29.00 |

## Miss summary (compact)

- non-top-3 cases: 8
- missing (not surfaced): 0
- present-but-support: 5
- present-but-discarded: 1
- wrong-subsystem: 2
- body-literal misses: 0
- parser/language gaps: 0

## Miss taxonomy

| category | count |
| --- | --- |
| none | 22 |
| present_but_support | 5 |
| present_but_discarded | 1 |
| wrong_subsystem | 2 |

## Per-instance results

| instance | label | expected file | top pivot | role | top-1? | top-3? | result | miss category |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-12419 | gold_patch | sympy/matrices/expressions/matexpr.py | sympy/matrices/matrices.py::is_zero | support | no | no | hit_support | present_but_support |
| sympy__sympy-12481 | gold_patch | sympy/combinatorics/permutations.py | sympy/combinatorics/permutations.py::Permutation | pivot | yes | yes | hit_top1_pivot | none |
| sympy__sympy-13372 | gold_patch | sympy/core/evalf.py | sympy/core/evalf.py::evalf | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-10844 | gold_patch | sklearn/metrics/cluster/supervised.py | sklearn/metrics/cluster/supervised.py::fowlkes_mallows_score | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-11578 | gold_patch | sklearn/linear_model/logistic.py | sklearn/linear_model/logistic.py::_check_solver_option | pivot | yes | yes | hit_top1_pivot | none |
| matplotlib__matplotlib-22719 | gold_patch | lib/matplotlib/category.py | lib/matplotlib/_type1font.py::value | support | no | yes | hit_top3 | none |
| matplotlib__matplotlib-24627 | gold_patch | lib/matplotlib/axes/_base.py | lib/matplotlib/axes/_base.py::cla | pivot | yes | yes | hit_top1_pivot | none |
| astropy__astropy-14365 | gold_patch | astropy/io/ascii/qdp.py | astropy/io/ascii/qdp.py::_write_table_qdp | pivot | yes | yes | hit_top1_pivot | none |
| astropy__astropy-14369 | gold_patch | astropy/units/format/cds.py | astropy/io/ascii/cds.py::Cds | pivot | no | yes | hit_top3 | none |
| pytest-dev__pytest-10051 | gold_patch | src/_pytest/logging.py | src/_pytest/logging.py::get_records | pivot | yes | yes | hit_top1_pivot | none |
| pytest-dev__pytest-5262 | gold_patch | src/_pytest/capture.py | src/_pytest/capture.py::EncodedFile | pivot | yes | yes | hit_top1_pivot | none |
| sphinx-doc__sphinx-7462 | gold_patch | sphinx/domains/python.py | sphinx/domains/python.py::_parse_annotation | pivot | yes | yes | hit_top1_pivot | none |
| sphinx-doc__sphinx-7748 | gold_patch | sphinx/ext/autodoc/__init__.py | sphinx/ext/autodoc/__init__.py::DocstringSignatureMixin | pivot | yes | yes | hit_top1_pivot | none |
| psf__requests-1142 | gold_patch | requests/models.py | requests/models.py::prepare_content_length | pivot | yes | yes | hit_top1_pivot | none |
| psf__requests-1724 | gold_patch | requests/sessions.py | requests/sessions.py::resolve_redirects | pivot | yes | yes | hit_top1_pivot | none |
| pallets__flask-5014 | gold_patch | src/flask/blueprints.py | src/flask/blueprints.py::Blueprint | pivot | yes | yes | hit_top1_pivot | none |
| astropy__astropy-14539 | gold_patch | astropy/io/fits/diff.py | astropy/io/fits/diff.py::identical | pivot | yes | yes | hit_top1_pivot | none |
| astropy__astropy-14598 | gold_patch | astropy/io/fits/card.py | astropy/io/fits/diff.py::FITSDiff | support | no | no | hit_support | present_but_support |
| matplotlib__matplotlib-24970 | gold_patch | lib/matplotlib/colors.py | src/numpy_cpp.h::numpy | missing | no | no | missing | wrong_subsystem |
| matplotlib__matplotlib-25960 | gold_patch | lib/matplotlib/figure.py | lib/matplotlib/figure.py::subfigures | pivot | yes | yes | hit_top1_pivot | none |
| mwaskom__seaborn-3187 | gold_patch | seaborn/_core/scales.py | seaborn/utils.py::move_legend | pivot | yes | yes | hit_top1_pivot | none |
| psf__requests-5414 | gold_patch | requests/models.py | requests/models.py::prepare_url | pivot | yes | yes | hit_top1_pivot | none |
| pydata__xarray-2905 | gold_patch | xarray/core/variable.py | xarray/core/variable.py::__setitem__ | pivot | yes | yes | hit_top1_pivot | none |
| pydata__xarray-3677 | gold_patch | xarray/core/dataset.py | versioneer.py::scan_setup_py | support | no | no | hit_support | present_but_support |
| pylint-dev__pylint-8898 | gold_patch | pylint/config/argument.py | pylint/config/config_initialization.py::_order_all_first | support | no | no | hit_support | present_but_support |
| pytest-dev__pytest-7432 | gold_patch | src/_pytest/skipping.py | src/_pytest/skipping.py::evaluate_skip_marks | pivot | yes | yes | hit_top1_pivot | none |
| sphinx-doc__sphinx-7910 | gold_patch | sphinx/ext/napoleon/__init__.py | sphinx/environment/collectors/__init__.py::get_updated_docs | support | no | no | hit_support | present_but_support |
| sphinx-doc__sphinx-9230 | gold_patch | sphinx/util/docfields.py | sphinx/builders/__init__.py::write_doc_serialized | missing | no | no | missing | wrong_subsystem |
| sympy__sympy-15599 | gold_patch | sympy/core/mod.py | sympy/core/mod.py::Mod | pivot | yes | yes | hit_top1_pivot | none |
| sympy__sympy-16766 | gold_patch | sympy/printing/pycode.py | sympy/utilities/lambdify.py::lambdify | discarded | no | no | hit_discarded | present_but_discarded |

## Misses / failures — top-k diagnostics

### sympy__sympy-12419 — hit_support / present_but_support

- expected: sympy/matrices/expressions/matexpr.py
- reason: —
- down-weighted lexical tokens: bug
- non-source candidates down-ranked: sympy/matrices/benchmarks/bench_matrix.py — path under benchmarks/
- graph-neighbour expansions: sympy/physics/quantum/identitysearch.py::is_scalar_sparse_matrix -[references]-> sympy/physics/quantum/identitysearch.py::np; sympy/matrices/matrices.py::is_anti_symmetric -[contains]-> sympy/matrices/matrices.py::MatrixProperties; sympy/physics/quantum/identitysearch.py::is_scalar_sparse_matrix -[references]-> sympy/physics/quantum/identitysearch.py::scipy; sympy/assumptions/handlers/matrices.py::ZeroMatrix -[contains]-> sympy/assumptions/handlers/matrices.py::AskSymmetricHandler; sympy/assumptions/handlers/matrices.py::BM_elements -[references]-> sympy/assumptions/handlers/matrices.py::AskComplexElementsHandler; sympy/matrices/matrices.py::is_anti_symmetric -[calls]-> sympy/matrices/matrices.py::_eval_is_anti_symmetric; sympy/assumptions/handlers/matrices.py::BM_elements -[references]-> sympy/assumptions/handlers/matrices.py::AskIntegerElementsHandler; sympy/assumptions/handlers/matrices.py::BM_elements -[references]-> sympy/assumptions/handlers/matrices.py::AskRealElementsHandler
- top pivots:
  - sympy/matrices/matrices.py::is_zero — actionable method — strong lexical match; issue-domain relevance
  - sympy/physics/quantum/identitysearch.py::is_scalar_sparse_matrix — actionable function — strong lexical match; issue-domain relevance
- top support:
  - sympy/assumptions/handlers/matrices.py::ZeroMatrix — strong target but beyond the pivot budget — pivot: local implementation helper whose name matches the issue — likely edit site
  - sympy/matrices/expressions/matexpr.py::ZeroMatrix — strong target but beyond the pivot budget — pivot: actionable class — strong lexical match; issue-domain relevance; 24 dependents
  - sympy/assumptions/ask.py::integer_elements — strong target but beyond the pivot budget — pivot: actionable method — strong lexical match; issue-domain relevance
  - sympy/physics/quantum/identitysearch.py::is_scalar_nonsparse_matrix — strong target but beyond the pivot budget — pivot: actionable function — strong lexical match; issue-domain relevance
  - sympy/assumptions/handlers/matrices.py::MatMul_elements — strong target but beyond the pivot budget — pivot: actionable function — strong lexical match; issue-domain relevance
- top discarded:
  - sympy/assumptions/handlers/matrices.py::ZeroMatrix — redundant support: identical delivered evidence to sympy/assumptions/handlers/matrices.py::ZeroMatrix
  - sympy/assumptions/handlers/matrices.py::ZeroMatrix — redundant support: identical delivered evidence to sympy/assumptions/handlers/matrices.py::ZeroMatrix
  - sympy/assumptions/handlers/matrices.py::ZeroMatrix — redundant support: identical delivered evidence to sympy/assumptions/handlers/matrices.py::ZeroMatrix
  - sympy/assumptions/handlers/matrices.py::ZeroMatrix — redundant support: identical delivered evidence to sympy/assumptions/handlers/matrices.py::ZeroMatrix
  - sympy/assumptions/handlers/sets.py::MatrixElement — redundant support: identical delivered evidence to sympy/assumptions/handlers/sets.py::MatrixElement

### astropy__astropy-14598 — hit_support / present_but_support

- expected: astropy/io/fits/card.py
- reason: —
- down-weighted lexical tokens: single
- literal-anchor terms: FITS
- literal-anchor matches: FITS -> astropy/units/format/fits.py::Fits; FITS -> astropy/io/fits/diff.py::FITSDiff; FITS -> astropy/io/fits/fitsrec.py::FITS_rec
- graph-neighbour expansions: astropy/io/fits/fitsrec.py::FITS_rec -[contains]-> astropy/io/fits/fitsrec.py::_coldefs; astropy/io/fits/card.py::_format_long_commentary_image -[calls]-> astropy/io/fits/card.py::_format_value; astropy/io/fits/card.py::_format_long_image -[calls]-> astropy/io/fits/card.py::_format_image; astropy/io/fits/fitsrec.py::FITS_rec -[contains]-> astropy/io/fits/fitsrec.py::_convert_other; astropy/io/fits/fitsrec.py::FITS_rec -[contains]-> astropy/io/fits/fitsrec.py::_coldefs; astropy/io/fits/fitsrec.py::FITS_rec -[references]-> astropy/io/fits/hdu/groups.py::__new__; astropy/io/fits/scripts/fitsheader.py::_get_cards -[contains]-> astropy/io/fits/scripts/fitsheader.py::HeaderFormatter; astropy/units/format/fits.py::Fits -[contains]-> astropy/units/format/fits.py::_to_decomposed_alternative
- top pivots:
  - astropy/io/fits/diff.py::FITSDiff — actionable class — symbol-name match; strong lexical match
  - astropy/io/fits/fitsrec.py::FITS_rec — actionable class — symbol-name match; strong lexical match
  - astropy/units/format/fits.py::Fits — actionable class — symbol-name match; strong lexical match
- top support:
  - astropy/extern/configobj/configobj.py::_quote — strong target but beyond the pivot budget — pivot: actionable method — symbol-name match; lexical match; issue-domain relevance
  - astropy/io/fits/scripts/fitsheader.py::_get_cards — strong target but beyond the pivot budget — pivot: actionable method — strong lexical match; issue-domain relevance
  - astropy/io/fits/card.py::_format_long_commentary_image — strong target but beyond the pivot budget — pivot: local implementation helper invoked by the entry point — likely edit site
  - astropy/io/fits/hdu/table.py::quotechar — symbol-name match; lexical match; issue-domain relevance (not a pivot: module_variable is a low-actionability edit target)
  - astropy/io/fits/header.py::append — strong target but beyond the pivot budget — pivot: actionable method — strong lexical match; issue-domain relevance; 6 dependents
- top discarded:
  - astropy/io/fits/card.py::comment — redundant support: identical delivered evidence to astropy/io/fits/card.py::comment
  - astropy/io/fits/card.py::value — redundant support: identical delivered evidence to astropy/io/fits/card.py::value
  - astropy/io/fits/card.py::field_specifier — redundant support: identical delivered evidence to astropy/io/fits/card.py::field_specifier
  - astropy/io/ascii/tests/test_c_reader.py::test_doubled_quotes_segv — a test symbol, not an edit target
  - astropy/io/ascii/tests/test_c_reader.py::test_doubled_quotes — a test symbol, not an edit target

### matplotlib__matplotlib-24970 — missing / wrong_subsystem

- expected: lib/matplotlib/colors.py
- reason: expected file not surfaced (candidate_count=67)
- down-weighted lexical tokens: bug, errors
- title-symbol terms: NumPy
- title-symbol matches: NumPy -> src/numpy_cpp.h::numpy
- graph-neighbour expansions: src/numpy_cpp.h::numpy -[contains]-> src/numpy_cpp.h::operator; lib/matplotlib/backends/backend_wx.py::__init__ -[contains]-> lib/matplotlib/backends/backend_wx.py::FigureFrameWx; lib/matplotlib/dates.py::julian2num -[calls]-> lib/matplotlib/dates.py::__getattr__; src/numpy_cpp.h::numpy -[contains]-> src/numpy_cpp.h::subarray; src/numpy_cpp.h::numpy -[contains]-> src/numpy_cpp.h::npy_long; src/numpy_cpp.h::numpy -[contains]-> src/numpy_cpp.h::npy_short; lib/matplotlib/mlab.py::stride_windows -[calls]-> lib/matplotlib/mlab.py::_stride_windows; lib/matplotlib/backends/backend_wx.py::__init__ -[calls]-> lib/matplotlib/backends/backend_wx.py::_set_frame_icon
- generic lexical decoys suppressed: deprecation -> lib/matplotlib/_api/deprecation.py
- top pivots:
  - src/numpy_cpp.h::numpy — actionable function — symbol-name match
  - lib/matplotlib/_api/deprecation.py::MatplotlibDeprecationWarning — actionable class — strong lexical match; issue-domain relevance; 23 dependents
- top support:
  - lib/matplotlib/axis.py::label — lexical match; graph/import neighbour (not a pivot: no direct evidence (graph/domain reach only))
  - tools/github_stats.py::report — strong target but beyond the pivot budget — pivot: actionable function — strong lexical match
  - lib/matplotlib/_api/deprecation.py::suppress_matplotlib_deprecation_warning — strong target but beyond the pivot budget — pivot: local implementation helper whose name matches the issue — likely edit site
  - lib/matplotlib/_api/deprecation.py::deprecated — strong target but beyond the pivot budget — pivot: actionable function — strong lexical match; issue-domain relevance; 116 dependents
  - lib/matplotlib/_api/deprecation.py::warn_deprecated — strong target but beyond the pivot budget — pivot: actionable function — strong lexical match; issue-domain relevance; 28 dependents
- top discarded:
  - lib/mpl_toolkits/axes_grid1/tests/test_axes_grid1.py::test_image_grid_label_mode_deprecation_warning — a test symbol, not an edit target
  - lib/matplotlib/tests/test_colorbar.py::test_colorbar_no_warning_rcparams_grid_true — a test symbol, not an edit target
  - lib/matplotlib/tests/test_style.py::test_invalid_rc_warning_includes_filename — a test symbol, not an edit target
  - lib/matplotlib/tests/test_pyplot.py::test_copy_docstring_and_deprecators — a test symbol, not an edit target
  - lib/matplotlib/tests/test_sphinxext.py::build_sphinx_html — a test symbol, not an edit target

### pydata__xarray-3677 — hit_support / present_but_support

- expected: xarray/core/dataset.py
- reason: —
- down-weighted lexical tokens: same
- literal-anchor terms: DataArray, items, __getattr__
- literal-anchor matches: DataArray -> xarray/core/dataarray.py::DataArray; DataArray -> xarray/backends/api.py::DATAARRAY_NAME; DataArray -> xarray/backends/api.py::DATAARRAY_VARIABLE; items -> versioneer.py::scan_setup_py; items -> xarray/backends/lru_cache.py::LRUCache; items -> xarray/backends/lru_cache.py::maxsize; __getattr__ -> xarray/core/common.py::__getattr__
- graph-neighbour expansions: xarray/core/dataarray.py::DataArray -[contains]-> xarray/core/dataarray.py::reset_coords; xarray/backends/lru_cache.py::LRUCache -[contains]-> xarray/backends/lru_cache.py::__len__; xarray/core/dataarray.py::DataArray -[contains]-> xarray/core/dataarray.py::reindex_like; xarray/core/dataarray.py::DataArray -[contains]-> xarray/core/dataarray.py::name; xarray/core/dataarray.py::DataArray -[contains]-> xarray/core/dataarray.py::sortby
- top pivots:
  - versioneer.py::scan_setup_py — actionable function — symbol-name match; strong lexical match
  - xarray/backends/lru_cache.py::LRUCache — actionable class — symbol-name match; strong lexical match
  - xarray/core/common.py::__getattr__ — actionable method — symbol-name match; strong lexical match
- top support:
  - xarray/core/dataset.py::merge — strong target but beyond the pivot budget — pivot: actionable method — symbol-name match; in a likely edit file; lexical match; issue-domain relevance
  - xarray/core/merge.py::merge — strong target but beyond the pivot budget — pivot: actionable function — symbol-name match; in a likely edit file; lexical match; issue-domain relevance; 23 dependents
  - xarray/core/coordinates.py::merge — strong target but beyond the pivot budget — pivot: actionable method — symbol-name match; lexical match; issue-domain relevance
  - xarray/core/combine.py::auto_combine — lexical match; issue-domain relevance; 11 dependents (not a pivot: high-degree framework root — support at most)
  - xarray/backends/lru_cache.py::maxsize — strong target but beyond the pivot budget — pivot: actionable method — symbol-name match; strong lexical match
- top discarded:
  - xarray/tests/test_sparse.py::test_dataarray_method — a test symbol, not an edit target
  - xarray/tests/test_dataarray.py::test_chunk — a test symbol, not an edit target
  - xarray/tests/test_dataarray.py::test_get_index — a test symbol, not an edit target
  - xarray/tests/test_dataarray.py::test_resample_first — a test symbol, not an edit target
  - xarray/tests/test_dataarray.py::test_stack_nonunique_consistency — a test symbol, not an edit target

### pylint-dev__pylint-8898 — hit_support / present_but_support

- expected: pylint/config/argument.py, pylint/utils/__init__.py, pylint/utils/utils.py
- reason: —
- down-weighted lexical tokens: run, bug
- generic lexical decoys suppressed: config -> pylint/config/arguments_manager.py
- top pivots:
  - pylint/config/config_initialization.py::_order_all_first — actionable function — in a likely edit file; lexical match; issue-domain relevance; graph/import neighbour
  - pylint/__init__.py::_run_pylint_config — local implementation helper whose name matches the issue — likely edit site
- top support:
  - pylint/config/find_default_config_files.py::_find_config_in_home_or_environment — strong target but beyond the pivot budget — pivot: local implementation helper whose name matches the issue — likely edit site
  - pylint/config/config_file_parser.py::_ConfigurationFileParser — likely co-edit sibling of a high-confidence anchor
  - pylint/__init__.py::run_pylint — strong target but beyond the pivot budget — pivot: actionable function — in a likely edit file; lexical match; issue-domain relevance
  - pylint/config/config_initialization.py::_config_initialization — strong target but beyond the pivot budget — pivot: local implementation helper whose name matches the issue — likely edit site
  - pylint/__init__.py::modify_sys_path — strong target but beyond the pivot budget — pivot: actionable function — in a likely edit file; lexical match; issue-domain relevance
- top discarded:
  - tests/pyreverse/test_main.py::test_command_line_arguments_yes_no — a test symbol, not an edit target
  - tests/lint/test_run_pylint.py::test_run_pylint_with_invalid_argument_in_config — a test symbol, not an edit target
  - tests/lint/test_caching.py::test__get_pdata_path_nix — a test symbol, not an edit target
  - tests/lint/test_run_pylint.py::test_run_pylint_with_invalid_argument — a test symbol, not an edit target
  - tests/pyreverse/test_main.py::test_class_command — a test symbol, not an edit target

### sphinx-doc__sphinx-7910 — hit_support / present_but_support

- expected: sphinx/ext/napoleon/__init__.py
- reason: —
- graph-neighbour expansions: sphinx/ext/autodoc/__init__.py::DecoratorDocumenter -[references]-> sphinx/ext/autodoc/__init__.py::FunctionDocumenter; sphinx/ext/autosummary/__init__.py::get_documenter -[calls]-> sphinx/ext/autosummary/__init__.py::FakeDirective; sphinx/ext/autodoc/__init__.py::DecoratorDocumenter -[contains]-> sphinx/ext/autodoc/__init__.py::objtype; sphinx/ext/autodoc/__init__.py::DecoratorDocumenter -[references]-> sphinx/ext/autodoc/__init__.py::setup; sphinx/ext/autodoc/__init__.py::format_name -[calls]-> sphinx/ext/autodoc/__init__.py::add_directive_header; sphinx/ext/autosummary/__init__.py::get_documenter -[calls]-> sphinx/ext/autosummary/__init__.py::get_items; sphinx/ext/autodoc/__init__.py::document_members -[contains]-> sphinx/ext/autodoc/__init__.py::AttributeDocumenter; sphinx/builders/__init__.py::get_outdated_docs -[calls]-> sphinx/builders/__init__.py::build_update
- top pivots:
  - sphinx/environment/collectors/__init__.py::get_updated_docs — actionable method — strong lexical match; issue-domain relevance
  - sphinx/builders/__init__.py::get_outdated_docs — actionable method — strong lexical match; issue-domain relevance
- top support:
  - sphinx/pycode/__init__.py::find_attr_docs — strong target but beyond the pivot budget — pivot: actionable method — strong lexical match; issue-domain relevance
  - sphinx/ext/autodoc/__init__.py::DecoratorDocumenter — strong target but beyond the pivot budget — pivot: actionable class — strong lexical match; issue-domain relevance
  - sphinx/locale/__init__.py::setlocale — strong target but beyond the pivot budget — pivot: actionable function — strong lexical match; issue-domain relevance
  - sphinx/ext/autodoc/__init__.py::Documenter — strong target but beyond the pivot budget — pivot: actionable class — strong lexical match; issue-domain relevance; 7 dependents
  - sphinx/environment/collectors/__init__.py::get_outdated_docs — strong target but beyond the pivot budget — pivot: actionable method — strong lexical match; issue-domain relevance
- top discarded:
  - sphinx/ext/autodoc/__init__.py::sort_members — redundant support: identical delivered evidence to sphinx/ext/autodoc/__init__.py::sort_members
  - sphinx/ext/autodoc/__init__.py::get_object_members — redundant support: identical delivered evidence to sphinx/ext/autodoc/__init__.py::get_object_members
  - sphinx/ext/autodoc/__init__.py::document_members — redundant support: identical delivered evidence to sphinx/ext/autodoc/__init__.py::document_members
  - sphinx/ext/autodoc/__init__.py::document_members — redundant support: identical delivered evidence to sphinx/ext/autodoc/__init__.py::document_members
  - sphinx/ext/autodoc/__init__.py::document_members — redundant support: identical delivered evidence to sphinx/ext/autodoc/__init__.py::document_members

### sphinx-doc__sphinx-9230 — missing / wrong_subsystem

- expected: sphinx/util/docfields.py
- reason: expected file not surfaced (candidate_count=73)
- down-weighted lexical tokens: bug
- non-source candidates down-ranked: doc/usage/extensions/example_google.py — path under doc/; doc/usage/extensions/example_numpy.py — path under doc/; doc/usage/extensions/example_google.py — path under doc/; doc/usage/extensions/example_google.py — path under doc/; doc/usage/extensions/example_numpy.py — path under doc/; doc/usage/extensions/example_google.py — path under doc/; doc/usage/extensions/example_numpy.py — path under doc/; doc/usage/extensions/example_google.py — path under doc/; doc/usage/extensions/example_numpy.py — path under doc/; doc/usage/extensions/example_google.py — path under doc/; doc/usage/extensions/example_numpy.py — path under doc/; doc/usage/extensions/example_numpy.py — path under doc/; doc/usage/extensions/example_google.py — path under doc/; doc/usage/extensions/example_numpy.py — path under doc/; doc/usage/extensions/example_google.py — path under doc/; doc/usage/extensions/example_google.py — path under doc/; doc/usage/extensions/example_numpy.py — path under doc/; doc/usage/extensions/example_numpy.py — path under doc/
- graph-neighbour expansions: sphinx/builders/__init__.py::write_doc_serialized -[calls]-> sphinx/builders/__init__.py::_write_parallel; sphinx/builders/__init__.py::write_doc_serialized -[calls]-> sphinx/builders/__init__.py::_write_serial; sphinx/domains/cpp.py::describe_signature -[contains]-> sphinx/domains/cpp.py::ASTTemplateKeyParamPackIdDefault; sphinx/domains/cpp.py::describe_signature -[contains]-> sphinx/domains/cpp.py::ASTTemplateParamConstrainedTypeWithInit; sphinx/domains/c.py::_render_symbol -[calls]-> sphinx/domains/c.py::apply; sphinx/domains/cpp.py::describe_signature -[contains]-> sphinx/domains/cpp.py::ASTTemplateParamType; sphinx/domains/cpp.py::describe_signature -[contains]-> sphinx/domains/cpp.py::ASTTemplateParamTemplateType; sphinx/domains/cpp.py::describe_signature -[contains]-> sphinx/domains/cpp.py::ASTSizeofParamPack
- top pivots:
  - sphinx/builders/__init__.py::write_doc_serialized — actionable method — strong lexical match; issue-domain relevance
  - sphinx/domains/cpp.py::describe_signature — actionable method — strong lexical match; issue-domain relevance
- top support:
  - sphinx/domains/c.py::describe_signature — strong target but beyond the pivot budget — pivot: actionable method — strong lexical match; issue-domain relevance
  - sphinx/builders/html/__init__.py::render_partial — strong target but beyond the pivot budget — pivot: actionable method — strong lexical match; issue-domain relevance; 6 dependents
  - sphinx/domains/cpp.py::describe_signature — strong target but beyond the pivot budget — pivot: actionable method — strong lexical match; issue-domain relevance
  - sphinx/domains/cpp.py::describe_signature — strong target but beyond the pivot budget — pivot: actionable method — strong lexical match; issue-domain relevance
  - sphinx/application.py::render_string — strong target but beyond the pivot budget — pivot: actionable method — strong lexical match; issue-domain relevance
- top discarded:
  - sphinx/domains/cpp.py::describe_signature — redundant support: identical delivered evidence to sphinx/domains/cpp.py::describe_signature
  - sphinx/domains/cpp.py::describe_signature — redundant support: identical delivered evidence to sphinx/domains/cpp.py::describe_signature
  - sphinx/domains/cpp.py::describe_signature — redundant support: identical delivered evidence to sphinx/domains/cpp.py::describe_signature
  - sphinx/domains/cpp.py::describe_signature — redundant support: identical delivered evidence to sphinx/domains/cpp.py::describe_signature
  - sphinx/domains/cpp.py::describe_signature — redundant support: identical delivered evidence to sphinx/domains/cpp.py::describe_signature

### sympy__sympy-16766 — hit_discarded / present_but_discarded

- expected: sympy/printing/pycode.py
- reason: expected file recovered but discarded: sympy/printing/pycode.py — over budget: no room for this support item
- down-weighted lexical tokens: support
- title-symbol terms: PythonCodePrinter
- title-symbol matches: PythonCodePrinter -> sympy/printing/pycode.py::PythonCodePrinter
- graph-neighbour expansions: sympy/tensor/indexed.py::Indexed -[contains]-> sympy/tensor/indexed.py::is_commutative; sympy/tensor/indexed.py::Indexed -[contains]-> sympy/tensor/indexed.py::is_Atom; sympy/tensor/indexed.py::Indexed -[contains]-> sympy/tensor/indexed.py::is_symbol; sympy/plotting/experimental_lambdify.py::vectorized_lambdify -[calls]-> sympy/plotting/plot.py::get_meshes; sympy/tensor/indexed.py::Indexed -[contains]-> sympy/tensor/indexed.py::name; sympy/utilities/lambdify.py::lambdify -[calls]-> sympy/utilities/lambdify.py::_module_present; sympy/printing/jscode.py::jscode -[calls]-> sympy/printing/jscode.py::print_jscode; sympy/utilities/lambdify.py::lambdify -[calls]-> sympy/utilities/lambdify.py::_TensorflowEvaluatorPrinter
- top pivots:
  - sympy/utilities/lambdify.py::lambdify — actionable function — symbol-name match; strong lexical match; issue-domain relevance; 10 dependents
  - sympy/plotting/experimental_lambdify.py::lambdify — actionable class — symbol-name match; strong lexical match; issue-domain relevance
- top support:
  - sympy/printing/glsl.py::glsl_code — strong target but beyond the pivot budget — pivot: actionable function — strong lexical match; issue-domain relevance
  - sympy/printing/julia.py::julia_code — strong target but beyond the pivot budget — pivot: actionable function — strong lexical match; issue-domain relevance
  - sympy/printing/octave.py::octave_code — strong target but beyond the pivot budget — pivot: actionable function — strong lexical match; issue-domain relevance
  - sympy/plotting/plot_implicit.py::_get_meshes_grid — likely co-edit sibling of a high-confidence anchor
  - sympy/utilities/lambdify.py::_print_unpacking — strong target but beyond the pivot budget — pivot: actionable method — strong lexical match; issue-domain relevance
- top discarded:
  - sympy/printing/pycode.py::PythonCodePrinter — over budget: no room for this support item
  - sympy/printing/pycode.py::AbstractPythonCodePrinter — over budget: no room for this support item
  - sympy/functions/special/tensor_functions.py::killable_index — over budget: no room for this support item
  - sympy/functions/special/tensor_functions.py::preferred_index — over budget: no room for this support item
  - sympy/functions/special/spherical_harmonics.py::_eval_conjugate — over budget: no room for this support item

## Notes

- `expected_files` / `expected_symbols` are EVALUATION LABELS only. They are
  read from the fixture to score the capsule and are NEVER passed into Capsule
  v2 retrieval — production retrieval receives only `(task, intent, budget)`.
- No instance IDs or expected paths are hardcoded in production Capsule v2 logic.
- This stage measures retrieval quality only; it runs no Claude, Docker, or
  vexp agent execution and makes no API calls.
- `passing_model_patch` labels are reported separately: a miss against one may
  reflect a valid ALTERNATIVE fix site rather than a retrieval failure.
