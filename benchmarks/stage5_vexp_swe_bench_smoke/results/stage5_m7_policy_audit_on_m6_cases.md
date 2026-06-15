# Stage 5 — M7 conservative-localization policy audit (offline)

## Scope

**Deterministic, offline policy audit — no Claude, no Docker, no agent run, no API calls.**

Runs the OLD and NEW Capsule v2 cost-aware context policy over the 20 M6
bounded-validation cases. Capsule v2 is built in-process from the SAME task
text the live harness feeds it (`buildCapsuleV2Task` = full problem statement +
failing tests + hints). The localization detector reads ONLY issue text + the
repo index — never the gold patch. `old action` is the M7 gate with its
localization inputs disabled (provably identical to the pre-M7 gate), so the
OLD→NEW delta is exactly the M7 conservative-skip logic.

- dataset (full issue text): `/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl`
- M6 outcome labels transcribed from `stage5_bounded_20_case_validation.md` (scoring only).

## Headline

- cases audited: **20**
- inject→skip flips: **2** — sympy-13372, xarray-3677
- skip→inject flips: **0** — none
- desired-skip cases (inject-without-benefit + regression) now skipped: **2/8**
- known useful / safe cases preserved: **9/9**
- harmful flips (useful/safe case wrongly skipped): **0** — none

## Success criteria

1. ✅ known useful injected wins remain **inject** (5/5)
2. ✅ astropy actionability remains **inject**
3. ✅ safe no_context remains **skip** (3/3)
4. ✅ at least some inject-without-benefit / regression cases become **skip** (2)
5. ✅ policy reasons are explicit and inspectable (see per-case table)

## Per-case decisions

| case | M6 class | M6 res. | loc conf | kind | top pivot localized? | actionability | old → new | flip | new skip signal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| matplotlib-24627 | strict_efficiency_pass | unchanged | strong | file_named | no | — | inject → inject | — | — |
| sphinx-7748 | strict_efficiency_pass | unchanged | medium | file_named | no | — | inject → inject | — | — |
| requests-1142 | strict_efficiency_pass | unchanged | strong | file_named | no | — | inject → inject | — | — |
| matplotlib-25960 | strict_efficiency_pass | improved | strong | file_named | yes | — | inject → inject | — | — |
| django-11728 | strict_efficiency_pass | improved | strong | file_named | yes | — | inject → inject | — | — |
| astropy-14369 | actionability_success | improved | strong | file_named | yes | 2 | inject → inject | — | — |
| astropy-14365 | resolution_improvement_with_cost | improved | strong | file_named | no | — | inject → inject | — | — |
| flask-5014 | no_context_safety_pass | unchanged | strong | file_named | no | — | no_context → no_context | — | — |
| django-11095 | no_context_safety_pass | unchanged | weak | none | no | — | no_context → no_context | — | — |
| sympy-12481 | no_context_safety_pass | unchanged | medium | symbol_named | no | — | no_context → no_context | — | — |
| sphinx-7462 | inject_without_benefit | unchanged | strong | traceback | yes | — | inject → inject | — | — |
| sympy-16766 | inject_without_benefit | unchanged | medium | symbol_named | no | — | inject → inject | — | — |
| requests-5414 | inject_without_benefit | unchanged | strong | file_named | yes | — | inject → inject | — | — |
| sympy-12419 | resolution_regression | regressed | medium | symbol_named | no | — | inject → inject | — | — |
| astropy-14539 | resolution_regression | regressed | strong | file_named | yes | — | inject → inject | — | — |
| pylint-8898 | resolution_regression | regressed | strong | traceback | yes | — | inject → inject | — | — |
| sympy-13372 | resolution_regression | regressed | strong | traceback | yes | — | inject → no_context | inject→skip | skip_traceback_localized |
| xarray-3677 | resolution_regression | regressed | strong | traceback | yes | — | inject → no_context | inject→skip | skip_traceback_localized |
| seaborn-3187 | patch_synthesis_bound | unchanged | strong | file_named | yes | — | inject → inject | — | — |
| django-13195 | patch_synthesis_bound | unchanged | medium | symbol_named | no | — | inject → inject | — | — |

## Per-case detail

### matplotlib-24627 — strict_efficiency_pass

- M6: live=inject, resolution=unchanged, skip-desired=false
- top pivot: lib/matplotlib/pyplot.py::plot (user-localized: false)
- localization: confidence=strong, kind=file_named
- actionability hints: 0
- advantage signals: inject_hidden_pivot
- policy: **inject → inject** (unchanged)
- new reason: Moderate task with retrieved context and no strong cheap/local signal; a standard Capsule v2 is worthwhile.

### sphinx-7748 — strict_efficiency_pass

- M6: live=inject, resolution=unchanged, skip-desired=false
- top pivot: sphinx/ext/autodoc/__init__.py::Documenter (user-localized: false)
- localization: confidence=medium, kind=file_named
- actionability hints: 0
- advantage signals: none
- policy: **inject → inject** (unchanged)
- new reason: Moderate task with retrieved context and no strong cheap/local signal; a standard Capsule v2 is worthwhile.

### requests-1142 — strict_efficiency_pass

- M6: live=inject, resolution=unchanged, skip-desired=false
- top pivot: requests/api.py::head (user-localized: false)
- localization: confidence=strong, kind=file_named
- actionability hints: 0
- advantage signals: inject_hidden_pivot
- policy: **inject → inject** (unchanged)
- new reason: Moderate task with retrieved context and no strong cheap/local signal; a standard Capsule v2 is worthwhile.

### matplotlib-25960 — strict_efficiency_pass

- M6: live=inject, resolution=improved, skip-desired=false
- top pivot: lib/matplotlib/figure.py::subfigures (user-localized: true)
- localization: confidence=strong, kind=file_named
- actionability hints: 0
- advantage signals: inject_edit_changing_evidence
- policy: **inject → inject** (unchanged)
- new reason: High-value context: line-anchor resolution + navigation-heavy task with a focused pivot source; injecting orients the agent and prevents a wrong local edit.

### django-11728 — strict_efficiency_pass

- M6: live=inject, resolution=improved, skip-desired=false
- top pivot: django/contrib/admindocs/utils.py::replace_named_groups (user-localized: true)
- localization: confidence=strong, kind=file_named
- actionability hints: 0
- advantage signals: none
- policy: **inject → inject** (unchanged)
- new reason: High-value context: internal-subsystem navigation with a focused pivot source; injecting orients the agent and prevents a wrong local edit.

### astropy-14369 — actionability_success

- M6: live=inject, resolution=improved, skip-desired=false
- top pivot: astropy/units/format/cds.py::CDS (user-localized: true)
- localization: confidence=strong, kind=file_named
- actionability hints: 2
- advantage signals: inject_actionability_hint
- policy: **inject → inject** (unchanged)
- new reason: High-value context: internal-subsystem navigation with a focused pivot source; injecting orients the agent and prevents a wrong local edit.

### astropy-14365 — resolution_improvement_with_cost

- M6: live=inject, resolution=improved, skip-desired=false
- top pivot: astropy/io/ascii/qdp.py::_write_table_qdp (user-localized: false)
- localization: confidence=strong, kind=file_named
- actionability hints: 0
- advantage signals: inject_hidden_pivot
- policy: **inject → inject** (unchanged)
- new reason: High-value context: internal-subsystem navigation with a focused pivot source; injecting orients the agent and prevents a wrong local edit.

### flask-5014 — no_context_safety_pass

- M6: live=skip, resolution=unchanged, skip-desired=true
- top pivot: src/flask/blueprints.py::Blueprint (user-localized: false)
- localization: confidence=strong, kind=file_named
- actionability hints: 0
- advantage signals: inject_hidden_pivot
- policy: **no_context → no_context** (unchanged)
- new reason: Small/local task with an obvious narrow target (micro capsule, not an internal subsystem, no edit-risk / line-anchor / SQL-rendering evidence); a baseline agent solves it cheaply, so injected context is likely net overhead — caution outweighs the marginal force-inject benefit.

### django-11095 — no_context_safety_pass

- M6: live=skip, resolution=unchanged, skip-desired=true
- top pivot: django/contrib/admin/options.py::get_inline_formsets (user-localized: false)
- localization: confidence=weak, kind=none
- actionability hints: 0
- advantage signals: none
- policy: **no_context → no_context** (unchanged)
- new reason: Small/local task with an obvious narrow target (micro capsule, not an internal subsystem, no edit-risk / line-anchor / SQL-rendering evidence); a baseline agent solves it cheaply, so injected context is likely net overhead — caution outweighs the marginal force-inject benefit.

### sympy-12481 — no_context_safety_pass

- M6: live=skip, resolution=unchanged, skip-desired=true
- top pivot: sympy/combinatorics/permutations.py::Permutation (user-localized: false)
- localization: confidence=medium, kind=symbol_named
- actionability hints: 0
- advantage signals: none
- policy: **no_context → no_context** (unchanged)
- new reason: Small/local task with an obvious narrow target (micro capsule, not an internal subsystem, no edit-risk / line-anchor / SQL-rendering evidence); a baseline agent solves it cheaply, so injected context is likely net overhead — caution outweighs the marginal force-inject benefit.

### sphinx-7462 — inject_without_benefit

- M6: live=inject, resolution=unchanged, skip-desired=true
- top pivot: sphinx/domains/python.py::_parse_annotation (user-localized: true)
- localization: confidence=strong, kind=traceback
- actionability hints: 0
- advantage signals: inject_edit_changing_evidence
- policy: **inject → inject** (unchanged)
- new reason: High-value context: line-anchor resolution + navigation-heavy task with a focused pivot source; injecting orients the agent and prevents a wrong local edit.

### sympy-16766 — inject_without_benefit

- M6: live=inject, resolution=unchanged, skip-desired=true
- top pivot: sympy/printing/pycode.py::PythonCodePrinter (user-localized: false)
- localization: confidence=medium, kind=symbol_named
- actionability hints: 0
- advantage signals: none
- policy: **inject → inject** (unchanged)
- new reason: Moderate task with retrieved context and no strong cheap/local signal; a standard Capsule v2 is worthwhile.

### requests-5414 — inject_without_benefit

- M6: live=inject, resolution=unchanged, skip-desired=true
- top pivot: requests/models.py::prepare_url (user-localized: true)
- localization: confidence=strong, kind=file_named
- actionability hints: 0
- advantage signals: inject_edit_changing_evidence
- policy: **inject → inject** (unchanged)
- new reason: High-value context: line-anchor resolution + navigation-heavy task with a focused pivot source; injecting orients the agent and prevents a wrong local edit.

### sympy-12419 — resolution_regression

- M6: live=inject, resolution=regressed, skip-desired=true
- top pivot: sympy/functions/elementary/piecewise.py::piecewise_fold (user-localized: false)
- localization: confidence=medium, kind=symbol_named
- actionability hints: 0
- advantage signals: none
- policy: **inject → inject** (unchanged)
- new reason: High-value context: navigation-heavy task with a focused pivot source; injecting orients the agent and prevents a wrong local edit.

### astropy-14539 — resolution_regression

- M6: live=inject, resolution=regressed, skip-desired=true
- top pivot: astropy/io/fits/diff.py::FITSDiff (user-localized: true)
- localization: confidence=strong, kind=file_named
- actionability hints: 0
- advantage signals: none
- policy: **inject → inject** (unchanged)
- new reason: High-value context: navigation-heavy task with a focused pivot source; injecting orients the agent and prevents a wrong local edit.

### pylint-8898 — resolution_regression

- M6: live=inject, resolution=regressed, skip-desired=true
- top pivot: pylint/config/argument.py::_regexp_paths_csv_transfomer (user-localized: true)
- localization: confidence=strong, kind=traceback
- actionability hints: 0
- advantage signals: inject_edit_changing_evidence
- policy: **inject → inject** (unchanged)
- new reason: High-value context: line-anchor resolution + internal-subsystem navigation with a focused pivot source; injecting orients the agent and prevents a wrong local edit.

### sympy-13372 — resolution_regression

- M6: live=inject, resolution=regressed, skip-desired=true
- top pivot: sympy/core/evalf.py::evalf (user-localized: true)
- localization: confidence=strong, kind=traceback
- actionability hints: 0
- advantage signals: none
- policy: **inject → no_context** (inject→skip)
- new reason: Issue traceback-localizes the edit site (a resolved `File "...", in symbol` frame whose lead pivot the issue already names) with no actionability / hidden-pivot / edit-changing advantage; a baseline agent localizes it for free, so injected context is net overhead.

### xarray-3677 — resolution_regression

- M6: live=inject, resolution=regressed, skip-desired=true
- top pivot: xarray/core/dataset.py::Dataset (user-localized: true)
- localization: confidence=strong, kind=traceback
- actionability hints: 0
- advantage signals: none
- policy: **inject → no_context** (inject→skip)
- new reason: Issue traceback-localizes the edit site (a resolved `File "...", in symbol` frame whose lead pivot the issue already names) with no actionability / hidden-pivot / edit-changing advantage; a baseline agent localizes it for free, so injected context is net overhead.

### seaborn-3187 — patch_synthesis_bound

- M6: live=inject, resolution=unchanged, skip-desired=false
- top pivot: seaborn/_core/scales.py::_setup (user-localized: true)
- localization: confidence=strong, kind=file_named
- actionability hints: 0
- advantage signals: inject_edit_changing_evidence
- policy: **inject → inject** (unchanged)
- new reason: High-value context: line-anchor resolution + navigation-heavy task with a focused pivot source; injecting orients the agent and prevents a wrong local edit.

### django-13195 — patch_synthesis_bound

- M6: live=inject, resolution=unchanged, skip-desired=false
- top pivot: http/response.py::delete_cookie (user-localized: false)
- localization: confidence=medium, kind=symbol_named
- actionability hints: 0
- advantage signals: none
- policy: **inject → inject** (unchanged)
- new reason: Moderate task with retrieved context and no strong cheap/local signal; a standard Capsule v2 is worthwhile.

## Notes

- The localization detector resolves file/symbol mentions against the indexed
  repo only; non-resolving prose and common words never count as localization.
- A regression case that does NOT flip is reported honestly — the policy could
  not distinguish it from a useful injection on localization signal alone.
- This audit measures the POLICY DECISION change only; it does not re-run agents,
  so it does not by itself prove the resolution regressions disappear. It proves
  which cases the new gate would stop injecting on.
