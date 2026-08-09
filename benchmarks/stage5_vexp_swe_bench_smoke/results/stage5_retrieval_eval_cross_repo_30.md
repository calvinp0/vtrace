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
| top_1_file_accuracy | 70.0% |
| top_3_file_recall | 83.3% |
| expected_file_as_pivot_rate | 76.7% |
| expected_file_as_support_rate | 10.0% |
| expected_file_discarded_rate | 3.3% |
| expected_file_missing_rate | 10.0% |
| expected_symbol_hit_rate | 56.7% |
| expected_symbol_as_pivot_rate | 26.7% |
| mean_capsule_tokens | 2149.3 |
| mean_pivot_count | 2.13 |
| mean_support_count | 3.83 |

## Comparison vs prior cross-repo baseline

Does Capsule v2 retrieval stay stable as cross-repo coverage grows from 16 to 30 non-Django instances? Delta is in percentage points; for **missing**, lower is better.

| metric | previous 16-instance cross-repo | new 30-instance cross-repo | delta |
| --- | --- | --- | --- |
| top-1 file accuracy | 62.5% | 70.0% | +7.5 pp ▲ |
| top-3 file recall | 87.5% | 83.3% | -4.2 pp ▼ |
| expected file as pivot | 81.3% | 76.7% | -4.6 pp ▼ |
| expected file missing | 6.3% | 10.0% | +3.8 pp ▼ |

## Aggregate metrics — by label source

All 30 instances share one label source (gold_patch); see the table above.

## Metrics by repo

| repo | instances | top-1 file | top-3 file | as pivot | missing | mean tokens | mean pivots | mean support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy/sympy | 5/5 | 80.0% | 100.0% | 100.0% | 0.0% | 2969.2 | 2.20 | 3.80 |
| astropy/astropy | 4/4 | 50.0% | 75.0% | 75.0% | 0.0% | 2977.8 | 2.50 | 3.50 |
| matplotlib/matplotlib | 4/4 | 50.0% | 75.0% | 50.0% | 25.0% | 656.3 | 1.75 | 4.00 |
| sphinx-doc/sphinx | 4/4 | 50.0% | 50.0% | 50.0% | 50.0% | 2750.8 | 2.00 | 4.00 |
| psf/requests | 3/3 | 66.7% | 100.0% | 66.7% | 0.0% | 863.0 | 2.00 | 4.00 |
| pytest-dev/pytest | 3/3 | 100.0% | 100.0% | 100.0% | 0.0% | 855.3 | 2.00 | 4.00 |
| pydata/xarray | 2/2 | 100.0% | 100.0% | 100.0% | 0.0% | 2124.0 | 3.00 | 3.00 |
| scikit-learn/scikit-learn | 2/2 | 100.0% | 100.0% | 100.0% | 0.0% | 3412.0 | 2.00 | 4.00 |
| mwaskom/seaborn | 1/1 | 100.0% | 100.0% | 100.0% | 0.0% | 1530.0 | 2.00 | 4.00 |
| pallets/flask | 1/1 | 100.0% | 100.0% | 100.0% | 0.0% | 5615.0 | 2.00 | 4.00 |
| pylint-dev/pylint | 1/1 | 0.0% | 0.0% | 0.0% | 0.0% | 722.0 | 2.00 | 4.00 |

## Miss summary (compact)

- non-top-3 cases: 5
- missing (not surfaced): 0
- present-but-support: 1
- present-but-discarded: 1
- wrong-subsystem: 3
- body-literal misses: 0
- parser/language gaps: 0

## Miss taxonomy

| category | count |
| --- | --- |
| none | 25 |
| present_but_support | 1 |
| present_but_discarded | 1 |
| wrong_subsystem | 3 |

## Per-instance results

| instance | label | expected file | top pivot | role | top-1? | top-3? | result | miss category |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-12419 | gold_patch | sympy/matrices/expressions/matexpr.py | sympy/physics/quantum/identitysearch.py::is_scalar_sparse_matrix | pivot | no | yes | hit_top3 | none |
| sympy__sympy-12481 | gold_patch | sympy/combinatorics/permutations.py | sympy/combinatorics/permutations.py::Permutation | pivot | yes | yes | hit_top1_pivot | none |
| sympy__sympy-13372 | gold_patch | sympy/core/evalf.py | sympy/core/evalf.py::evalf | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-10844 | gold_patch | sklearn/metrics/cluster/supervised.py | sklearn/metrics/cluster/supervised.py::fowlkes_mallows_score | pivot | yes | yes | hit_top1_pivot | none |
| scikit-learn__scikit-learn-11578 | gold_patch | sklearn/linear_model/logistic.py | sklearn/linear_model/logistic.py::LogisticRegression | pivot | yes | yes | hit_top1_pivot | none |
| matplotlib__matplotlib-22719 | gold_patch | lib/matplotlib/category.py | lib/matplotlib/units.py::ConversionError | support | no | yes | hit_top3 | none |
| matplotlib__matplotlib-24627 | gold_patch | lib/matplotlib/axes/_base.py | lib/matplotlib/axes/_base.py::cla | pivot | yes | yes | hit_top1_pivot | none |
| astropy__astropy-14365 | gold_patch | astropy/io/ascii/qdp.py | astropy/io/ascii/qdp.py::_write_table_qdp | pivot | yes | yes | hit_top1_pivot | none |
| astropy__astropy-14369 | gold_patch | astropy/units/format/cds.py | astropy/io/ascii/cds.py::Cds | pivot | no | yes | hit_top3 | none |
| pytest-dev__pytest-10051 | gold_patch | src/_pytest/logging.py | src/_pytest/logging.py::get_records | pivot | yes | yes | hit_top1_pivot | none |
| pytest-dev__pytest-5262 | gold_patch | src/_pytest/capture.py | src/_pytest/capture.py::EncodedFile | pivot | yes | yes | hit_top1_pivot | none |
| sphinx-doc__sphinx-7462 | gold_patch | sphinx/domains/python.py | sphinx/domains/python.py::_parse_annotation | pivot | yes | yes | hit_top1_pivot | none |
| sphinx-doc__sphinx-7748 | gold_patch | sphinx/ext/autodoc/__init__.py | sphinx/ext/autodoc/__init__.py::DocstringSignatureMixin | pivot | yes | yes | hit_top1_pivot | none |
| psf__requests-1142 | gold_patch | requests/models.py | requests/models.py::prepare_content_length | pivot | yes | yes | hit_top1_pivot | none |
| psf__requests-1724 | gold_patch | requests/sessions.py | requests/api.py::get | support | no | yes | hit_top3 | none |
| pallets__flask-5014 | gold_patch | src/flask/blueprints.py | src/flask/blueprints.py::Blueprint | pivot | yes | yes | hit_top1_pivot | none |
| astropy__astropy-14539 | gold_patch | astropy/io/fits/diff.py | astropy/io/fits/diff.py::identical | pivot | yes | yes | hit_top1_pivot | none |
| astropy__astropy-14598 | gold_patch | astropy/io/fits/card.py | astropy/io/fits/diff.py::FITSDiff | support | no | no | hit_support | present_but_support |
| matplotlib__matplotlib-24970 | gold_patch | lib/matplotlib/colors.py | lib/matplotlib/_api/deprecation.py::suppress_matplotlib_deprecation_warning | missing | no | no | missing | wrong_subsystem |
| matplotlib__matplotlib-25960 | gold_patch | lib/matplotlib/figure.py | lib/matplotlib/figure.py::subfigures | pivot | yes | yes | hit_top1_pivot | none |
| mwaskom__seaborn-3187 | gold_patch | seaborn/_core/scales.py | seaborn/utils.py::move_legend | pivot | yes | yes | hit_top1_pivot | none |
| psf__requests-5414 | gold_patch | requests/models.py | requests/models.py::prepare_url | pivot | yes | yes | hit_top1_pivot | none |
| pydata__xarray-2905 | gold_patch | xarray/core/variable.py | xarray/core/variable.py::__setitem__ | pivot | yes | yes | hit_top1_pivot | none |
| pydata__xarray-3677 | gold_patch | xarray/core/dataset.py | xarray/core/dataset.py::merge | pivot | yes | yes | hit_top1_pivot | none |
| pylint-dev__pylint-8898 | gold_patch | pylint/config/argument.py | pylint/config/config_initialization.py::_order_all_first | discarded | no | no | hit_discarded | present_but_discarded |
| pytest-dev__pytest-7432 | gold_patch | src/_pytest/skipping.py | src/_pytest/skipping.py::evaluate_skip_marks | pivot | yes | yes | hit_top1_pivot | none |
| sphinx-doc__sphinx-7910 | gold_patch | sphinx/ext/napoleon/__init__.py | sphinx/ext/autodoc/__init__.py::DecoratorDocumenter | missing | no | no | missing | wrong_subsystem |
| sphinx-doc__sphinx-9230 | gold_patch | sphinx/util/docfields.py | sphinx/pycode/ast.py::visit_Dict | missing | no | no | missing | wrong_subsystem |
| sympy__sympy-15599 | gold_patch | sympy/core/mod.py | sympy/core/mod.py::Mod | pivot | yes | yes | hit_top1_pivot | none |
| sympy__sympy-16766 | gold_patch | sympy/printing/pycode.py | sympy/printing/pycode.py::PythonCodePrinter | pivot | yes | yes | hit_top1_pivot | none |

## Misses / failures — top-k diagnostics

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
- down-weighted lexical tokens: bug, errors
- generic lexical decoys suppressed: deprecation -> lib/matplotlib/_api/deprecation.py
- top pivots:
  - lib/matplotlib/_api/deprecation.py::suppress_matplotlib_deprecation_warning — local implementation helper whose name matches the issue — likely edit site
  - lib/matplotlib/_api/deprecation.py::MatplotlibDeprecationWarning — actionable class — strong lexical match; issue-domain relevance; 23 dependents
- top support:
  - lib/matplotlib/_api/deprecation.py::_generate_deprecation_warning — strong target beyond the pivot budget — local implementation helper whose name matches the issue — likely edit site
  - lib/matplotlib/_api/deprecation.py::deprecated — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance; 116 dependents
  - lib/matplotlib/_api/deprecation.py::warn_deprecated — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance; 28 dependents
  - lib/matplotlib/_api/deprecation.py::rename_parameter — strong target beyond the pivot budget — actionable function — strong lexical match; issue-domain relevance; 8 dependents
- top discarded:
  - lib/matplotlib/_api/deprecation.py::delete_parameter — beyond standard support budget (max 4)
  - lib/matplotlib/transforms.py::Bbox — beyond standard support budget (max 4)
  - lib/matplotlib/mathtext.py::MathTextWarning — beyond standard support budget (max 4)
  - lib/matplotlib/_api/deprecation.py::make_keyword_only — beyond standard support budget (max 4)
  - lib/matplotlib/widgets.py::rectangles — beyond standard support budget (max 4)

### pylint-dev__pylint-8898 — hit_discarded / present_but_discarded

- expected: pylint/config/argument.py, pylint/utils/__init__.py, pylint/utils/utils.py
- reason: expected file recovered but discarded: pylint/config/argument.py — beyond standard support budget (max 4)
- down-weighted lexical tokens: run, bug
- generic lexical decoys suppressed: config -> pylint/config/arguments_manager.py
- top pivots:
  - pylint/config/config_initialization.py::_order_all_first — actionable function — in a likely edit file; lexical match; issue-domain relevance; graph/import neighbour
  - pylint/__init__.py::_run_pylint_config — local implementation helper whose name matches the issue — likely edit site
- top support:
  - pylint/config/__init__.py::__all__ — in a likely edit file; lexical match; issue-domain relevance; graph/import neighbour (not a pivot: module_variable is a low-actionability edit target)
  - pylint/pyreverse/__init__.py::__revision__ — in a likely edit file; lexical match; issue-domain relevance; graph/import neighbour (not a pivot: module_variable is a low-actionability edit target)
  - pylint/config/config_file_parser.py::_ConfigurationFileParser — likely co-edit sibling of a high-confidence anchor
  - pylint/config/config_initialization.py::_config_initialization — strong target beyond the pivot budget — local implementation helper whose name matches the issue — likely edit site
- top discarded:
  - pylint/__init__.py::run_pylint — beyond standard support budget (max 4)
  - pylint/config/argument.py::_csv_transformer — beyond standard support budget (max 4)
  - pylint/config/arguments_provider.py::_ArgumentsProvider — beyond standard support budget (max 4)
  - pylint/config/arguments_manager.py::help — beyond standard support budget (max 4)
  - pylint/__pkginfo__.py::get_numversion_from_version — beyond standard support budget (max 4)

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
