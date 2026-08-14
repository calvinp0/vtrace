# M144-A — Failure-evidence inventory

Counts of raw failure-LIKE text in the task string each suite feeds `buildCapsuleV2`.
Liberal by design: this is the denominator §77 uses to separate *a parser exists* from
*the capability is useful*. No index resolution here — that is Workstream B.

| Evidence form | django_expanded_20 | cross_repo_30 | django_5 | cross_repo_16 | arc_behavioral | frozen50 (aggregate) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| traceback_frame | 1 | 5 | 0 | 0 | 0 | 6 |
| exception_name | 6 | 12 | 0 | 5 | 0 | 18 |
| failing_test_name | 2 | 4 | 0 | 0 | 0 | 6 |
| pytest_nodeid | 0 | 0 | 0 | 0 | 0 | 0 |
| explicit_source_path | 1 | 0 | 0 | 0 | 0 | 1 |
| line_anchor | 0 | 1 | 0 | 0 | 0 | 1 |
| reproduction_command | 1 | 0 | 0 | 0 | 0 | 1 |
| **any evidence** | 8 | 15 | 0 | 5 | 0 | 23 |
| **localizing evidence** | 4 | 9 | 0 | 0 | 0 | 13 |
| exception-name only | 4 | 6 | 0 | 5 | 0 | 10 |
| **none** | 12 | 15 | 5 | 11 | 7 | 27 |

## django-11740 (§30, §81 — required early determination)

- label source: `manual_verified`
- task: `106` chars
- raw evidence forms: **none**
- localizing evidence: **no**
- determination: **NOT addressable under the M144 supplied-evidence scope**

## Cases carrying localizing evidence

- `django__django-11820` (django_expanded_20): failing_test_name
- `django__django-12273` (django_expanded_20): failing_test_name
- `django__django-12774` (django_expanded_20): traceback_frame, exception_name
- `django__django-13112` (django_expanded_20): exception_name, explicit_source_path, reproduction_command
- `sympy__sympy-13372` (cross_repo_30): traceback_frame, exception_name
- `pytest-dev__pytest-5262` (cross_repo_30): exception_name, failing_test_name
- `sphinx-doc__sphinx-7462` (cross_repo_30): traceback_frame, exception_name
- `psf__requests-1724` (cross_repo_30): traceback_frame, exception_name, failing_test_name
- `psf__requests-5414` (cross_repo_30): exception_name, line_anchor
- `pydata__xarray-3677` (cross_repo_30): traceback_frame, exception_name
- `pylint-dev__pylint-8898` (cross_repo_30): traceback_frame
- `pytest-dev__pytest-7432` (cross_repo_30): failing_test_name
- `sympy__sympy-15599` (cross_repo_30): failing_test_name

