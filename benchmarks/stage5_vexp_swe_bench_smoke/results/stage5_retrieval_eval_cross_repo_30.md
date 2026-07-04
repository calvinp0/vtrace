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
| no_context_count | 1 |
| top_1_file_accuracy | 66.7% |
| top_3_file_recall | 80.0% |
| expected_file_as_pivot_rate | 76.7% |
| expected_file_as_support_rate | 6.7% |
| expected_file_discarded_rate | 3.3% |
| expected_file_missing_rate | 13.3% |
| expected_symbol_hit_rate | 56.7% |
| expected_symbol_as_pivot_rate | 20.0% |
| mean_capsule_tokens | 2054.7 |
| mean_pivot_count | 2.03 |
| mean_support_count | 3.73 |

## Comparison vs prior cross-repo baseline

Does Capsule v2 retrieval stay stable as cross-repo coverage grows from 16 to 30 non-Django instances? Delta is in percentage points; for **missing**, lower is better.

| metric | previous 16-instance cross-repo | new 30-instance cross-repo | delta |
| --- | --- | --- | --- |
| top-1 file accuracy | 62.5% | 66.7% | +4.2 pp ▲ |
| top-3 file recall | 87.5% | 80.0% | -7.5 pp ▼ |
| expected file as pivot | 81.3% | 76.7% | -4.6 pp ▼ |
| expected file missing | 6.3% | 13.3% | +7.1 pp ▼ |

## Aggregate metrics — by label source

All 30 instances share one label source (gold_patch); see the table above.

## Metrics by repo

| repo | instances | top-1 file | top-3 file | as pivot | missing | mean tokens | mean pivots | mean support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy/sympy | 5/5 | 60.0% | 100.0% | 80.0% | 0.0% | 2692.6 | 2.20 | 3.80 |
| astropy/astropy | 4/4 | 50.0% | 75.0% | 75.0% | 0.0% | 2977.8 | 2.50 | 3.50 |
| matplotlib/matplotlib | 4/4 | 75.0% | 75.0% | 75.0% | 25.0% | 672.0 | 1.75 | 4.00 |
| sphinx-doc/sphinx | 4/4 | 25.0% | 50.0% | 50.0% | 50.0% | 2797.8 | 2.00 | 4.00 |
| psf/requests | 3/3 | 66.7% | 66.7% | 66.7% | 0.0% | 711.7 | 2.00 | 4.00 |
| pytest-dev/pytest | 3/3 | 100.0% | 100.0% | 100.0% | 0.0% | 779.7 | 2.00 | 4.00 |
| pydata/xarray | 2/2 | 100.0% | 100.0% | 100.0% | 0.0% | 1976.0 | 2.50 | 3.50 |
| scikit-learn/scikit-learn | 2/2 | 100.0% | 100.0% | 100.0% | 0.0% | 3408.0 | 2.00 | 4.00 |
| mwaskom/seaborn | 1/1 | 100.0% | 100.0% | 100.0% | 0.0% | 1530.0 | 2.00 | 4.00 |
| pallets/flask | 1/1 | 100.0% | 100.0% | 100.0% | 0.0% | 5615.0 | 2.00 | 4.00 |
| pylint-dev/pylint | 1/1 | 0.0% | 0.0% | 0.0% | 100.0% | 0.0 | 0.00 | 0.00 |

## Miss summary (compact)

- non-top-3 cases: 6
- missing (not surfaced): 1
- present-but-support: 1
- present-but-discarded: 1
- wrong-subsystem: 3
- body-literal misses: 0
- parser/language gaps: 0

## Miss taxonomy

| category | count |
| --- | --- |
| none | 24 |
| missing_from_candidates | 1 |
| present_but_support | 1 |
| present_but_discarded | 1 |
| wrong_subsystem | 3 |

## Per-instance results

| instance | label | expected file | top pivot | role | top-1? | top-3? | result | miss category |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-12419 | gold_patch | sympy/matrices/expressions/matexpr.py | sympy/physics/quantum/identitysearch.py::is_scalar_sparse_matrix | pivot | no | yes | hit_top3 | none |
| sympy__sympy-12481 | gold_patch | sympy/combinatorics/permutations.py | sympy/combinatorics/permutations.py::Permutation | pivot | yes | yes | hit_top1_pivot | none |
| sympy__sympy-13372 | gold_patch | sympy/core/evalf.py | sympy/functions/special/error_functions.py::_eval_evalf | support | no | yes | hit_top3 | none |
| scikit-learn__scikit-learn-10844 | gold_patch | sklearn/metrics/cluster/supervised.py | sklearn/metrics/cluster/supervised.py::fowlkes_mallows_score | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-11578 | gold_patch | sklearn/linear_model/logistic.py | sklearn/linear_model/logistic.py::LogisticRegression | pivot | yes | yes | hit_top1_pivot | none |
| matplotlib__matplotlib-22719 | gold_patch | lib/matplotlib/category.py | lib/matplotlib/category.py::default_units | pivot | yes | yes | hit_top1_pivot | none |
| matplotlib__matplotlib-24627 | gold_patch | lib/matplotlib/axes/_base.py | lib/matplotlib/axes/_base.py::cla | pivot | yes | yes | hit_top1_pivot | none |
| astropy__astropy-14365 | gold_patch | astropy/io/ascii/qdp.py | astropy/io/ascii/qdp.py::_write_table_qdp | pivot | yes | yes | hit_top1_pivot | none |
| astropy__astropy-14369 | gold_patch | astropy/units/format/cds.py | astropy/io/ascii/cds.py::Cds | pivot | no | yes | hit_top3 | none |
| pytest-dev__pytest-10051 | gold_patch | src/_pytest/logging.py | src/_pytest/logging.py::get_records | pivot | yes | yes | hit_top1_pivot | none |
| pytest-dev__pytest-5262 | gold_patch | src/_pytest/capture.py | src/_pytest/capture.py::EncodedFile | pivot | yes | yes | hit_top1_pivot | none |
| sphinx-doc__sphinx-7462 | gold_patch | sphinx/domains/python.py | sphinx/application.py::add_object_type | pivot | no | yes | hit_top3 | none |
| sphinx-doc__sphinx-7748 | gold_patch | sphinx/ext/autodoc/__init__.py | sphinx/ext/autodoc/__init__.py::DocstringSignatureMixin | pivot | yes | yes | hit_top1_pivot | none |
| psf__requests-1142 | gold_patch | requests/models.py | requests/models.py::prepare_content_length | pivot | yes | yes | hit_top1_pivot | none |
| psf__requests-1724 | gold_patch | requests/sessions.py | requests/utils.py::stream_decode_response_unicode | discarded | no | no | hit_discarded | present_but_discarded |
| pallets__flask-5014 | gold_patch | src/flask/blueprints.py | src/flask/blueprints.py::Blueprint | pivot | yes | yes | hit_top1_pivot | none |
| astropy__astropy-14539 | gold_patch | astropy/io/fits/diff.py | astropy/io/fits/diff.py::identical | pivot | yes | yes | hit_top1_pivot | none |
| astropy__astropy-14598 | gold_patch | astropy/io/fits/card.py | astropy/io/fits/diff.py::FITSDiff | support | no | no | hit_support | present_but_support |
| matplotlib__matplotlib-24970 | gold_patch | lib/matplotlib/colors.py | lib/matplotlib/_api/deprecation.py::suppress_matplotlib_deprecation_warning | missing | no | no | missing | wrong_subsystem |
| matplotlib__matplotlib-25960 | gold_patch | lib/matplotlib/figure.py | lib/matplotlib/figure.py::subfigures | pivot | yes | yes | hit_top1_pivot | none |
| mwaskom__seaborn-3187 | gold_patch | seaborn/_core/scales.py | seaborn/utils.py::move_legend | pivot | yes | yes | hit_top1_pivot | none |
| psf__requests-5414 | gold_patch | requests/models.py | requests/models.py::prepare_url | pivot | yes | yes | hit_top1_pivot | none |
| pydata__xarray-2905 | gold_patch | xarray/core/variable.py | xarray/core/variable.py::__setitem__ | pivot | yes | yes | hit_top1_pivot | none |
| pydata__xarray-3677 | gold_patch | xarray/core/dataset.py | xarray/core/dataset.py::merge | pivot | yes | yes | hit_top1_pivot | none |
| pylint-dev__pylint-8898 | gold_patch | pylint/config/argument.py | — | missing | no | no | skipped_no_context | missing_from_candidates |
| pytest-dev__pytest-7432 | gold_patch | src/_pytest/skipping.py | src/_pytest/skipping.py::evaluate_skip_marks | pivot | yes | yes | hit_top1_pivot | none |
| sphinx-doc__sphinx-7910 | gold_patch | sphinx/ext/napoleon/__init__.py | sphinx/ext/autodoc/__init__.py::DecoratorDocumenter | missing | no | no | missing | wrong_subsystem |
| sphinx-doc__sphinx-9230 | gold_patch | sphinx/util/docfields.py | sphinx/pycode/ast.py::visit_Dict | missing | no | no | missing | wrong_subsystem |
| sympy__sympy-15599 | gold_patch | sympy/core/mod.py | sympy/core/mod.py::Mod | pivot | yes | yes | hit_top1_pivot | none |
| sympy__sympy-16766 | gold_patch | sympy/printing/pycode.py | sympy/printing/pycode.py::PythonCodePrinter | pivot | yes | yes | hit_top1_pivot | none |

## Misses / failures — top-k diagnostics

### psf__requests-1724 — hit_discarded / present_but_discarded

- expected: requests/sessions.py
- reason: expected file recovered but discarded: requests/sessions.py — beyond standard support budget (max 4)
- down-weighted lexical tokens: decode, error
- de-anchored exception tokens: decode
- graph-neighbour expansions: requests/models.py::prepare_method -[calls]-> requests/models.py::prepare; requests/packages/urllib3/connectionpool.py::HTTPConnectionPool -[contains]-> requests/packages/urllib3/connectionpool.py::_put_conn; requests/packages/urllib3/connectionpool.py::HTTPConnectionPool -[contains]-> requests/packages/urllib3/connectionpool.py::_get_conn; requests/packages/urllib3/connectionpool.py::HTTPConnectionPool -[contains]-> requests/packages/urllib3/connectionpool.py::_get_timeout; requests/packages/urllib3/fields.py::from_tuples -[calls]-> requests/packages/urllib3/filepost.py::iter_field_objects; requests/packages/charade/hebrewprober.py::feed -[calls]-> requests/packages/charade/hebrewprober.py::is_non_final; requests/packages/urllib3/connectionpool.py::HTTPConnectionPool -[contains]-> requests/packages/urllib3/connectionpool.py::_make_request; requests/packages/urllib3/request.py::RequestMethods -[contains]-> requests/packages/urllib3/request.py::_encode_url_methods
- top pivots:
  - requests/utils.py::stream_decode_response_unicode — local implementation helper whose name matches the issue — likely edit site
  - requests/packages/urllib3/exceptions.py::DecodeError — actionable class — strong lexical match; issue-domain relevance
- top support:
  - requests/structures.py::CaseInsensitiveDict — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance; 25 dependents
  - requests/packages/urllib3/connectionpool.py::HTTPConnectionPool — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance
  - requests/api.py::request — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance; 7 dependents
  - requests/packages/urllib3/exceptions.py::PoolError — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance
- top discarded:
  - requests/packages/urllib3/request.py::RequestMethods — beyond standard support budget (max 4)
  - requests/models.py::Request — beyond standard support budget (max 4)
  - requests/packages/urllib3/exceptions.py::HTTPError — beyond standard support budget (max 4)
  - requests/packages/charade/hebrewprober.py::feed — beyond standard support budget (max 4)
  - requests/packages/urllib3/connectionpool.py::_get_timeout — beyond standard support budget (max 4)

### astropy__astropy-14598 — hit_support / present_but_support

- expected: astropy/io/fits/card.py
- reason: —
- down-weighted lexical tokens: single
- literal-anchor terms: FITS
- literal-anchor matches: FITS -> astropy/units/format/fits.py::Fits; FITS -> astropy/io/fits/diff.py::FITSDiff; FITS -> astropy/io/fits/fitsrec.py::FITS_rec
- graph-neighbour expansions: astropy/io/fits/card.py::Card -[contains]-> astropy/io/fits/card.py::_number_NFSC_RE; astropy/io/fits/card.py::Card -[contains]-> astropy/io/fits/card.py::__init__; astropy/io/fits/fitsrec.py::FITS_rec -[contains]-> astropy/io/fits/fitsrec.py::_coldefs; astropy/io/fits/card.py::Card -[contains]-> astropy/io/fits/card.py::_strg; astropy/io/fits/card.py::Card -[contains]-> astropy/io/fits/card.py::_format_value; astropy/io/fits/fitsrec.py::FITS_rec -[contains]-> astropy/io/fits/fitsrec.py::_convert_other; astropy/io/fits/fitsrec.py::FITS_rec -[contains]-> astropy/io/fits/fitsrec.py::_coldefs; astropy/io/fits/fitsrec.py::FITS_rec -[references]-> astropy/io/fits/hdu/groups.py::__new__
- top pivots:
  - astropy/io/fits/diff.py::FITSDiff — actionable class — symbol-name match; strong lexical match
  - astropy/io/fits/fitsrec.py::FITS_rec — actionable class — symbol-name match; strong lexical match
  - astropy/units/format/fits.py::Fits — actionable class — symbol-name match; strong lexical match
- top support:
  - astropy/io/fits/hdu/table.py::quotechar — symbol-name match; lexical match; issue-domain relevance (not a pivot: module_variable is a low-actionability edit target)
  - astropy/io/fits/card.py::Card — strong target beyond the pivot budget — actionable class — symbol-name match; strong lexical match
  - astropy/io/fits/hdu/groups.py::__array_finalize__ — likely co-edit sibling of a high-confidence anchor
- top discarded:
  - astropy/io/ascii/core.py::quotechar — beyond standard support budget (max 3)
  - astropy/io/fits/header.py::__repr__ — beyond standard support budget (max 3)
  - astropy/io/fits/card.py::_value_FSC_RE — beyond standard support budget (max 3)
  - astropy/extern/configobj/configobj.py::_quote — beyond standard support budget (max 3)
  - astropy/io/fits/hdu/hdulist.py::fitsopen — beyond standard support budget (max 3)

### matplotlib__matplotlib-24970 — missing / wrong_subsystem

- expected: lib/matplotlib/colors.py
- reason: expected file not surfaced (candidate_count=25)
- down-weighted lexical tokens: bug
- generic lexical decoys suppressed: deprecation -> lib/matplotlib/_api/deprecation.py
- top pivots:
  - lib/matplotlib/_api/deprecation.py::suppress_matplotlib_deprecation_warning — actionable function — strong lexical match; issue-domain relevance; 16 dependents
  - lib/matplotlib/_api/deprecation.py::MatplotlibDeprecationWarning — actionable class — strong lexical match; issue-domain relevance; 23 dependents
- top support:
  - lib/matplotlib/_api/deprecation.py::deprecated — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance; 116 dependents
  - lib/matplotlib/_api/deprecation.py::warn_deprecated — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance; 28 dependents
  - lib/matplotlib/_api/deprecation.py::delete_parameter — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance; 11 dependents
  - lib/matplotlib/_api/deprecation.py::rename_parameter — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance; 8 dependents
- top discarded:
  - lib/matplotlib/path.py::NUM_VERTICES_FOR_CODE — beyond standard support budget (max 4)
  - lib/matplotlib/transforms.py::Bbox — beyond standard support budget (max 4)
  - lib/matplotlib/_api/deprecation.py::make_keyword_only — beyond standard support budget (max 4)
  - lib/matplotlib/_api/deprecation.py::_generate_deprecation_warning — beyond standard support budget (max 4)
  - lib/matplotlib/_mathtext.py::NUM_SIZE_LEVELS — beyond standard support budget (max 4)

### pylint-dev__pylint-8898 — skipped_no_context / missing_from_candidates

- expected: pylint/config/argument.py, pylint/utils/__init__.py, pylint/utils/utils.py
- reason: capsule returned no_context (no high-confidence edit target)
- down-weighted lexical tokens: bug
- non-source candidates down-ranked: doc/data/messages/t/too-many-boolean-expressions/bad.py — path under doc/data; doc/data/messages/s/simplify-boolean-expression/bad.py — path under doc/data
- graph-neighbour expansions: pylint/checkers/lambda_expressions.py::visit_namedexpr -[contains]-> pylint/checkers/lambda_expressions.py::LambdaExpressionChecker
- top pivots: (none)
- top support: (none)
- top discarded:
  - pylint/checkers/base/name_checker/checker.py::_BadNamesTuple — support-only: no actionable edit target
  - doc/data/messages/t/too-many-boolean-expressions/bad.py::can_be_divided_by_two_and_are_not_zero — support-only: no actionable edit target
  - doc/data/messages/s/simplifiable-if-expression/bad.py::FLYING_THINGS — support-only: no actionable edit target
  - doc/data/messages/t/trailing-comma-tuple/bad.py::COMPASS — support-only: no actionable edit target
  - doc/data/messages/s/simplify-boolean-expression/bad.py::has_oranges — support-only: no actionable edit target

### sphinx-doc__sphinx-7910 — missing / wrong_subsystem

- expected: sphinx/ext/napoleon/__init__.py
- reason: expected file not surfaced (candidate_count=25)
- graph-neighbour expansions: sphinx/ext/autodoc/__init__.py::DecoratorDocumenter -[references]-> sphinx/ext/autodoc/__init__.py::FunctionDocumenter; sphinx/ext/autosummary/__init__.py::get_documenter -[calls]-> sphinx/ext/autosummary/__init__.py::FakeDirective; sphinx/ext/autodoc/__init__.py::DecoratorDocumenter -[contains]-> sphinx/ext/autodoc/__init__.py::objtype; sphinx/ext/autodoc/__init__.py::document_members -[calls]-> sphinx/ext/autodoc/__init__.py::get_object_members; sphinx/ext/autodoc/__init__.py::DecoratorDocumenter -[references]-> sphinx/ext/autodoc/__init__.py::setup; sphinx/ext/autodoc/__init__.py::format_name -[calls]-> sphinx/ext/autodoc/__init__.py::add_directive_header; sphinx/ext/autosummary/__init__.py::get_documenter -[calls]-> sphinx/ext/autosummary/__init__.py::get_items; sphinx/ext/autodoc/__init__.py::document_members -[contains]-> sphinx/ext/autodoc/__init__.py::AttributeDocumenter
- top pivots:
  - sphinx/ext/autodoc/__init__.py::DecoratorDocumenter — actionable class — strong lexical match; issue-domain relevance
  - sphinx/ext/autodoc/__init__.py::Documenter — actionable class — strong lexical match; issue-domain relevance; 7 dependents
- top support:
  - sphinx/environment/collectors/__init__.py::get_updated_docs — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - sphinx/builders/__init__.py::get_outdated_docs — strong target beyond the pivot budget — actionable method — strong lexical match; issue-domain relevance
  - sphinx/ext/autodoc/__init__.py::FunctionDocumenter — lexical match; issue-domain relevance; graph/import neighbour (not a pivot: no direct evidence (graph/domain reach only))
  - sphinx/ext/autodoc/__init__.py::can_document_member — entry point/caller delegating to local helpers — the edit site is the helper it calls
- top discarded:
  - sphinx/ext/autosummary/__init__.py::get_documenter — beyond standard support budget (max 4)
  - sphinx/builders/latex/__init__.py::default_latex_documents — beyond standard support budget (max 4)
  - sphinx/pycode/__init__.py::find_attr_docs — beyond standard support budget (max 4)
  - sphinx/ext/autodoc/__init__.py::can_document_member — beyond standard support budget (max 4)
  - sphinx/ext/autodoc/__init__.py::format_name — beyond standard support budget (max 4)

### sphinx-doc__sphinx-9230 — missing / wrong_subsystem

- expected: sphinx/util/docfields.py
- reason: expected file not surfaced (candidate_count=25)
- down-weighted lexical tokens: bug
- graph-neighbour expansions: sphinx/builders/__init__.py::write_doc_serialized -[calls]-> sphinx/builders/__init__.py::_write_parallel; sphinx/builders/__init__.py::write_doc_serialized -[calls]-> sphinx/builders/__init__.py::_write_serial; sphinx/domains/cpp.py::describe_signature -[contains]-> sphinx/domains/cpp.py::ASTTemplateParamConstrainedTypeWithInit; sphinx/domains/cpp.py::describe_signature -[contains]-> sphinx/domains/cpp.py::ASTTemplateParamType; sphinx/domains/cpp.py::describe_signature -[contains]-> sphinx/domains/cpp.py::ASTTemplateParamTemplateType; sphinx/domains/cpp.py::describe_signature -[contains]-> sphinx/domains/cpp.py::ASTSizeofParamPack; sphinx/domains/cpp.py::describe_signature -[contains]-> sphinx/domains/cpp.py::ASTDeclaratorParamPack; sphinx/domains/c.py::describe_signature -[contains]-> sphinx/domains/c.py::ASTDeclaratorNameParam
- top pivots:
  - sphinx/pycode/ast.py::visit_Dict — actionable method — symbol-name match; lexical match; issue-domain relevance
  - sphinx/util/__init__.py::FilenameUniqDict — actionable class — symbol-name match; lexical match; issue-domain relevance
- top support:
  - sphinx/deprecation.py::DeprecatedDict — strong target beyond the pivot budget — actionable class — symbol-name match; lexical match; issue-domain relevance
  - sphinx/util/jsdump.py::ESCAPE_DICT — symbol-name match; lexical match; issue-domain relevance (not a pivot: module_constant is a low-actionability edit target)
  - doc/usage/extensions/example_google.py::ExamplePEP526Class — strong target beyond the pivot budget — actionable class — strong lexical match; issue-domain relevance
  - doc/usage/extensions/example_numpy.py::module_level_function — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance
- top discarded:
  - sphinx/builders/__init__.py::write_doc_serialized — beyond standard support budget (max 4)
  - doc/usage/extensions/example_google.py::module_level_function — beyond standard support budget (max 4)
  - doc/usage/extensions/example_google.py::__init__ — beyond standard support budget (max 4)
  - doc/usage/extensions/example_numpy.py::__init__ — beyond standard support budget (max 4)
  - sphinx/domains/cpp.py::describe_signature — beyond standard support budget (max 4)

## Notes

- `expected_files` / `expected_symbols` are EVALUATION LABELS only. They are
  read from the fixture to score the capsule and are NEVER passed into Capsule
  v2 retrieval — production retrieval receives only `(task, intent, budget)`.
- No instance IDs or expected paths are hardcoded in production Capsule v2 logic.
- This stage measures retrieval quality only; it runs no Claude, Docker, or
  vexp agent execution and makes no API calls.
- `passing_model_patch` labels are reported separately: a miss against one may
  reflect a valid ALTERNATIVE fix site rather than a retrieval failure.
