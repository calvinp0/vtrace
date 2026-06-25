# Stage 5 M73 Stage C Fresh Baselines and Final 100-Task Analysis

> 100-task engineering validation over the frozen on-disk SWE-bench-100 census. NOT proof of broad SWE-bench superiority or VEXP parity.
>
> This benchmark is a 100-task engineering validation over the frozen on-disk SWE-bench-100 census. It should **not** be represented as proof of broad SWE-bench superiority or VEXP parity unless the comparator and sampling are fully aligned.

## Summary

- **Fresh baseline selected:** 73 (matrix `fresh_baseline_needed`)
- **Fresh baseline runs performed:** 73
- **Operational retries / quota aborts:** 10 / 10
- **Docker evals (fresh baselines):** 70
- **Valid / invalid fresh baselines:** 73 / 0
- **Fresh baseline resolution:** 47/73
- **Final strict 100-task treatment:** 66/100 (66.0%)
- **Final strict 100-task baseline:** 64/100 (64.0%)
- **Paired outcomes:** both_pass 55, both_fail 21, treatment_only 11, baseline_only 9, treatment_invalid/skipped 4, baseline_invalid/missing 0
- **Net treatment wins:** +2
- **Cost delta (pooled, paired):** treatment $67.9468 vs baseline $78.4659; paired pooled regression -13.16%
- **Structured-decision (treatment):** coverage 92.57%, ignored 1.35%, invalid rule-out 6.08%, required IMPACT 0
- **Verdict:** **STRICT PASS**
- **Recommendation:** publish/report as an internal 100-task engineering validation; run a targeted replicate subset before any external SWE-bench claim

## Fixture / Matrix Compliance

- **Execution matrix used:** `stage5_m70b_100_task_execution_matrix.json` (100 rows, frozen at M70B).
- **Stage C membership:** 73 rows with `fresh_baseline_needed === true` (≡ `baseline_reuse_status === "missing"`). Matched the matrix-declared `fresh_baseline_required_count` and `stage_split.stage_c_fresh_baselines` (both 73).
- **Cases added/removed/replaced:** none. Membership was frozen before results were seen.
- **Deviations:** none. Baseline protocol `--protocol baseline` matches the reused_verified baselines (`eval-bounded20-baseline-*`): same harness family, same model class (`claude-opus-4-5`), shared stage5 tool-use-discipline injected into both arms, no VTRACE context / capsule / digest / contract / gate / corrective arms.

## Stage C Baseline Execution

- **Fresh baseline cases:** 73
- **Runs performed / missing:** 73 / 0
- **Valid / invalid:** 73 / 0
- **No-patch (exhausted) cases:** 3
- **Docker evals:** 70
- **Cost:** total $51.1103, mean $0.7001, median $0.368; pooled tokens 99,077,837
- **Operational issues:** 10 operational retries, 10 quota aborts.

## Stage C Baseline Results Table

| instance | repo | difficulty | run_label | valid | patch | eval | resolved | tokens | cost | tools | reads | rep_reads | retries | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| astropy__astropy-7166 | astropy | <15 min fix | …astropy_7166 | ✓ | ✓ | ✓ | ✓ | 511,655 | $0.312 | 6 | 1 | 0 | 0 |  |
| django__django-10973 | django | 15 min - 1 hour | …django_10973 | ✓ | ✓ | ✓ | — | 356,816 | $0.224 | 4 | 1 | 0 | 0 |  |
| django__django-11133 | django | <15 min fix | …django_11133 | ✓ | ✓ | ✓ | ✓ | 1,000,578 | $0.502 | 11 | 2 | 1 | 0 |  |
| django__django-11206 | django | 15 min - 1 hour | …django_11206 | ✓ | ✓ | ✓ | ✓ | 483,283 | $0.647 | 4 | 1 | 0 | 0 |  |
| django__django-11749 | django | 15 min - 1 hour | …django_11749 | ✓ | ✓ | ✓ | ✓ | 943,562 | $0.521 | 9 | 1 | 0 | 0 |  |
| django__django-11815 | django | 15 min - 1 hour | …django_11815 | ✓ | ✓ | ✓ | — | 487,684 | $0.299 | 5 | 1 | 0 | 0 |  |
| django__django-12050 | django | 15 min - 1 hour | …django_12050 | ✓ | ✓ | ✓ | ✓ | 352,584 | $0.198 | 4 | 2 | 1 | 0 |  |
| django__django-12273 | django | 15 min - 1 hour | …django_12273 | ✓ | ✓ | ✓ | — | 489,673 | $0.298 | 6 | 2 | 1 | 0 |  |
| django__django-12276 | django | <15 min fix | …django_12276 | ✓ | ✓ | ✓ | ✓ | 716,391 | $0.325 | 8 | 3 | 2 | 0 |  |
| django__django-12325 | django | 1-4 hours | …django_12325 | ✓ | ✓ | ✓ | — | 1,346,778 | $0.576 | 14 | 3 | 1 | 0 |  |
| django__django-12774 | django | 15 min - 1 hour | …django_12774 | ✓ | ✓ | ✓ | — | 577,648 | $0.290 | 6 | 2 | 1 | 0 |  |
| django__django-12858 | django | 15 min - 1 hour | …django_12858 | ✓ | ✓ | ✓ | ✓ | 692,809 | $0.344 | 9 | 3 | 1 | 0 |  |
| django__django-13012 | django | 15 min - 1 hour | …django_13012 | ✓ | ✓ | ✓ | ✓ | 609,747 | $0.306 | 7 | 2 | 1 | 0 |  |
| django__django-13112 | django | <15 min fix | …django_13112 | ✓ | — | — | — | 4,715,778 | $3.016 | 52 | 25 | 16 | 0 |  |
| django__django-13363 | django | <15 min fix | …django_13363 | ✓ | ✓ | ✓ | ✓ | 237,588 | $0.230 | 2 | 1 | 0 | 0 |  |
| django__django-13512 | django | <15 min fix | …django_13512 | ✓ | ✓ | ✓ | — | 767,514 | $0.340 | 9 | 3 | 1 | 0 |  |
| django__django-13513 | django | 15 min - 1 hour | …django_13513 | ✓ | — | — | — | 2,627,920 | $1.209 | 32 | 5 | 3 | 0 |  |
| django__django-13551 | django | <15 min fix | …django_13551 | ✓ | ✓ | ✓ | ✓ | 521,569 | $0.297 | 6 | 3 | 1 | 0 |  |
| django__django-13590 | django | 15 min - 1 hour | …django_13590 | ✓ | ✓ | ✓ | — | 382,778 | $0.224 | 5 | 1 | 0 | 0 |  |
| django__django-13658 | django | 15 min - 1 hour | …django_13658 | ✓ | ✓ | ✓ | ✓ | 295,216 | $0.227 | 3 | 1 | 0 | 0 |  |
| django__django-13810 | django | 15 min - 1 hour | …django_13810 | ✓ | ✓ | ✓ | ✓ | 317,212 | $0.253 | 3 | 2 | 1 | 0 |  |
| django__django-13820 | django | 15 min - 1 hour | …django_13820 | ✓ | ✓ | ✓ | ✓ | 240,978 | $0.246 | 2 | 1 | 0 | 0 |  |
| django__django-14608 | django | <15 min fix | …django_14608 | ✓ | ✓ | ✓ | ✓ | 637,922 | $0.310 | 8 | 1 | 0 | 0 |  |
| django__django-14792 | django | <15 min fix | …django_14792 | ✓ | ✓ | ✓ | — | 1,429,176 | $0.786 | 16 | 3 | 0 | 0 |  |
| django__django-15037 | django | 15 min - 1 hour | …django_15037 | ✓ | ✓ | ✓ | ✓ | 2,363,509 | $0.951 | 22 | 2 | 1 | 0 |  |
| django__django-15503 | django | 1-4 hours | …django_15503 | ✓ | — | — | — | 4,545,922 | $3.017 | 41 | 10 | 8 | 0 |  |
| django__django-15572 | django | <15 min fix | …django_15572 | ✓ | ✓ | ✓ | ✓ | 448,544 | $0.245 | 5 | 2 | 1 | 0 |  |
| django__django-15695 | django | 15 min - 1 hour | …django_15695 | ✓ | ✓ | ✓ | ✓ | 614,663 | $0.368 | 6 | 2 | 1 | 0 |  |
| django__django-15731 | django | 15 min - 1 hour | …django_15731 | ✓ | ✓ | ✓ | ✓ | 467,863 | $0.263 | 5 | 1 | 0 | 0 |  |
| django__django-16256 | django | 15 min - 1 hour | …django_16256 | ✓ | ✓ | ✓ | — | 1,145,656 | $0.642 | 10 | 4 | 3 | 0 |  |
| django__django-16263 | django | 1-4 hours | …django_16263 | ✓ | ✓ | ✓ | — | 4,498,846 | $3.009 | 43 | 10 | 8 | 0 |  |
| django__django-16333 | django | <15 min fix | …django_16333 | ✓ | ✓ | ✓ | ✓ | 607,956 | $0.349 | 6 | 3 | 1 | 0 |  |
| django__django-16569 | django | <15 min fix | …django_16569 | ✓ | ✓ | ✓ | ✓ | 388,758 | $0.232 | 4 | 1 | 0 | 0 |  |
| django__django-16667 | django | 15 min - 1 hour | …django_16667 | ✓ | ✓ | ✓ | — | 362,420 | $0.224 | 4 | 1 | 0 | 0 |  |
| django__django-16819 | django | 15 min - 1 hour | …django_16819 | ✓ | ✓ | ✓ | ✓ | 3,006,269 | $1.155 | 32 | 12 | 6 | 0 |  |
| django__django-16877 | django | 15 min - 1 hour | …django_16877 | ✓ | ✓ | ✓ | ✓ | 797,128 | $0.366 | 10 | 2 | 1 | 0 |  |
| django__django-16938 | django | 15 min - 1 hour | …django_16938 | ✓ | ✓ | ✓ | ✓ | 681,713 | $0.337 | 7 | 2 | 0 | 0 |  |
| django__django-17084 | django | 15 min - 1 hour | …django_17084 | ✓ | ✓ | ✓ | ✓ | 2,574,810 | $0.946 | 27 | 5 | 3 | 0 |  |
| matplotlib__matplotlib-24870 | matplotlib | 15 min - 1 hour | …matplotlib_24870 | ✓ | ✓ | ✓ | — | 2,160,639 | $0.871 | 22 | 4 | 3 | 0 |  |
| matplotlib__matplotlib-24970 | matplotlib | 15 min - 1 hour | …matplotlib_24970 | ✓ | ✓ | ✓ | ✓ | 1,057,821 | $0.480 | 11 | 3 | 2 | 0 |  |
| matplotlib__matplotlib-25332 | matplotlib | <15 min fix | …matplotlib_25332 | ✓ | ✓ | ✓ | ✓ | 1,383,554 | $0.680 | 16 | 4 | 2 | 0 |  |
| matplotlib__matplotlib-26466 | matplotlib | 15 min - 1 hour | …matplotlib_26466 | ✓ | ✓ | ✓ | — | 1,541,529 | $0.614 | 19 | 4 | 3 | 0 |  |
| psf__requests-1724 | psf | <15 min fix | …requests_1724 | ✓ | ✓ | ✓ | — | 707,268 | $0.361 | 9 | 4 | 2 | 0 |  |
| psf__requests-1921 | psf | <15 min fix | …requests_1921 | ✓ | ✓ | ✓ | — | 985,651 | $0.567 | 11 | 3 | 1 | 0 |  |
| pydata__xarray-2905 | pydata | 15 min - 1 hour | …xarray_2905 | ✓ | ✓ | ✓ | ✓ | 2,445,305 | $0.895 | 23 | 4 | 3 | 0 |  |
| pydata__xarray-4695 | pydata | 15 min - 1 hour | …xarray_4695 | ✓ | ✓ | ✓ | ✓ | 1,773,693 | $0.689 | 20 | 3 | 2 | 0 |  |
| pydata__xarray-6599 | pydata | 15 min - 1 hour | …xarray_6599 | ✓ | ✓ | ✓ | ✓ | 4,617,372 | $3.014 | 45 | 6 | 3 | 0 |  |
| pydata__xarray-6938 | pydata | 15 min - 1 hour | …xarray_6938 | ✓ | ✓ | ✓ | — | 2,771,904 | $1.158 | 30 | 5 | 3 | 0 |  |
| pydata__xarray-6992 | pydata | >4 hours | …xarray_6992 | ✓ | ✓ | ✓ | — | 569,539 | $0.288 | 6 | 2 | 1 | 0 |  |
| pylint-dev__pylint-4551 | pylint-dev | 1-4 hours | …pylint_4551 | ✓ | ✓ | ✓ | — | 2,765,613 | $1.124 | 26 | 6 | 2 | 0 |  |
| pytest-dev__pytest-10051 | pytest-dev | 15 min - 1 hour | …pytest_10051 | ✓ | ✓ | ✓ | — | 564,449 | $0.269 | 7 | 2 | 1 | 0 |  |
| pytest-dev__pytest-5262 | pytest-dev | <15 min fix | …pytest_5262 | ✓ | ✓ | ✓ | ✓ | 639,693 | $0.324 | 7 | 2 | 1 | 0 |  |
| pytest-dev__pytest-6197 | pytest-dev | 1-4 hours | …pytest_6197 | ✓ | ✓ | ✓ | ✓ | 4,085,815 | $1.861 | 41 | 18 | 16 | 0 |  |
| scikit-learn__scikit-learn-10844 | scikit-learn | 15 min - 1 hour | …scikit_learn_10844 | ✓ | ✓ | ✓ | ✓ | 307,169 | $0.205 | 3 | 2 | 1 | 0 |  |
| scikit-learn__scikit-learn-11578 | scikit-learn | 15 min - 1 hour | …scikit_learn_11578 | ✓ | ✓ | ✓ | ✓ | 780,754 | $0.371 | 8 | 2 | 1 | 0 |  |
| sphinx-doc__sphinx-7910 | sphinx-doc | <15 min fix | …sphinx_7910 | ✓ | ✓ | ✓ | ✓ | 657,888 | $0.353 | 7 | 3 | 2 | 0 |  |
| sphinx-doc__sphinx-9230 | sphinx-doc | <15 min fix | …sphinx_9230 | ✓ | ✓ | ✓ | ✓ | 1,368,514 | $0.767 | 15 | 2 | 1 | 0 |  |
| sphinx-doc__sphinx-9320 | sphinx-doc | <15 min fix | …sphinx_9320 | ✓ | ✓ | ✓ | ✓ | 692,762 | $0.355 | 8 | 4 | 3 | 0 |  |
| sphinx-doc__sphinx-9698 | sphinx-doc | <15 min fix | …sphinx_9698 | ✓ | ✓ | ✓ | ✓ | 369,789 | $0.431 | 3 | 1 | 0 | 0 |  |
| sphinx-doc__sphinx-9711 | sphinx-doc | <15 min fix | …sphinx_9711 | ✓ | ✓ | ✓ | — | 682,759 | $0.298 | 8 | 1 | 0 | 0 |  |
| sympy__sympy-13480 | sympy | <15 min fix | …sympy_13480 | ✓ | ✓ | ✓ | ✓ | 438,704 | $0.219 | 5 | 1 | 0 | 0 |  |
| sympy__sympy-13974 | sympy | 15 min - 1 hour | …sympy_13974 | ✓ | ✓ | ✓ | ✓ | 2,868,187 | $1.409 | 24 | 5 | 4 | 0 |  |
| sympy__sympy-15599 | sympy | 15 min - 1 hour | …sympy_15599 | ✓ | ✓ | ✓ | ✓ | 3,053,574 | $1.326 | 28 | 5 | 4 | 0 |  |
| sympy__sympy-15875 | sympy | <15 min fix | …sympy_15875 | ✓ | ✓ | ✓ | — | 2,668,860 | $1.193 | 27 | 2 | 1 | 1 |  |
| sympy__sympy-16597 | sympy | 1-4 hours | …sympy_16597 | ✓ | ✓ | ✓ | — | 1,293,226 | $0.571 | 14 | 3 | 1 | 1 |  |
| sympy__sympy-16792 | sympy | 15 min - 1 hour | …sympy_16792 | ✓ | ✓ | ✓ | ✓ | 3,702,327 | $1.434 | 40 | 17 | 16 | 1 |  |
| sympy__sympy-18189 | sympy | <15 min fix | …sympy_18189 | ✓ | ✓ | ✓ | ✓ | 625,046 | $0.347 | 7 | 3 | 2 | 1 |  |
| sympy__sympy-19637 | sympy | <15 min fix | …sympy_19637 | ✓ | ✓ | ✓ | ✓ | 454,670 | $0.313 | 4 | 1 | 0 | 1 |  |
| sympy__sympy-20428 | sympy | 15 min - 1 hour | …sympy_20428 | ✓ | ✓ | ✓ | — | 1,901,761 | $0.829 | 24 | 3 | 1 | 1 |  |
| sympy__sympy-20801 | sympy | 15 min - 1 hour | …sympy_20801 | ✓ | ✓ | ✓ | ✓ | 586,946 | $0.285 | 8 | 1 | 0 | 1 |  |
| sympy__sympy-23413 | sympy | 15 min - 1 hour | …sympy_23413 | ✓ | ✓ | ✓ | ✓ | 2,243,479 | $1.551 | 15 | 4 | 1 | 1 |  |
| sympy__sympy-24213 | sympy | 15 min - 1 hour | …sympy_24213 | ✓ | ✓ | ✓ | ✓ | 940,454 | $0.464 | 9 | 2 | 0 | 1 |  |
| sympy__sympy-24562 | sympy | <15 min fix | …sympy_24562 | ✓ | ✓ | ✓ | ✓ | 2,124,207 | $1.111 | 25 | 4 | 2 | 1 |  |

## Final 100-Task Paired Outcomes

| outcome | count |
|---|---|
| both_pass | 55 |
| both_fail | 21 |
| treatment_only_pass | 11 |
| baseline_only_pass | 9 |
| treatment_invalid_or_skipped | 4 |
| baseline_invalid_or_missing | 0 |

- **Strict 100 denominator:** treatment 66/100, baseline 64/100 — resolution delta +2.
- **Runnable 99 denominator (attempted):** treatment 66/99, baseline 64/99 — delta +2.
- **Net treatment wins:** 2 (treatment_only 11 − baseline_only 9).
- Primary comparison uses the **strict 100 selected denominator**; the skipped/invalid treatment cases count as treatment-unresolved.

## Cost / Token Analysis

- **Total treatment cost (99 attempted):** $67.9468
- **Total baseline cost (valid baselines):** $78.4659
- **Pooled cost delta:** $-10.5191 (paired pooled regression over 99 both-valid tasks: -13.16%)
- **Mean / median cost — treatment:** $0.6863 / $0.4734
- **Mean / median cost — baseline:** $0.7847 / $0.4764
- **Total tokens — treatment / baseline:** 117,114,916 / 151,381,715 (pooled delta -34,266,799)
- **Cache-read tokens — treatment / baseline:** 110,002,107 / 144,493,617
- **Tool calls — treatment / baseline:** 1,057 / 1,364 (delta -307)

## Structured Decision Analysis (treatment only)

- **Required targets:** 148 | **closed:** 137 | **open:** 11
- **Coverage:** 92.57%
- **Ignored rate:** 1.35%
- **Invalid rule-out rate:** 6.08% (M69 baseline 8.33%)
- **Zero-required count:** 9
- **Demoted pivot count:** 33
- **Required IMPACT count:** 0
- **EDITED / RULED_OUT / INSPECT_ONLY_NO_EDIT:** 87 / 15 / 35
- **Fail-closed / no-patch invalid count:** 3
- **Optional impact:** see per-stage detail (O-namespaced, never closure-scored)

## Stratified Results

### By repo
| repo | tasks | base✓ | treat✓ | T-only | B-only | treat$ | base$ |
|---|---|---|---|---|---|---|---|
| astropy/astropy | 5 | 2 | 2 | 0 | 0 | $4.94 | $6.15 |
| django/django | 44 | 28 | 31 | 6 | 3 | $26.74 | $28.61 |
| matplotlib/matplotlib | 7 | 3 | 5 | 2 | 0 | $4.93 | $7.09 |
| mwaskom/seaborn | 1 | 0 | 0 | 0 | 0 | $0.45 | $3.05 |
| pallets/flask | 1 | 1 | 1 | 0 | 0 | $0.34 | $0.25 |
| psf/requests | 4 | 2 | 2 | 1 | 1 | $1.84 | $1.79 |
| pydata/xarray | 6 | 4 | 4 | 1 | 1 | $4.17 | $6.55 |
| pylint-dev/pylint | 2 | 1 | 1 | 0 | 0 | $3.84 | $2.41 |
| pytest-dev/pytest | 4 | 3 | 3 | 0 | 0 | $3 | $2.91 |
| scikit-learn/scikit-learn | 2 | 2 | 2 | 0 | 0 | $0.73 | $0.58 |
| sphinx-doc/sphinx | 7 | 4 | 4 | 0 | 0 | $3.5 | $5.5 |
| sympy/sympy | 17 | 14 | 11 | 1 | 4 | $13.49 | $13.59 |

### By difficulty
| difficulty | tasks | base✓ | treat✓ | T-only | B-only | treat$ | base$ |
|---|---|---|---|---|---|---|---|
| 15 min - 1 hour | 53 | 33 | 34 | 7 | 6 | $37.14 | $44.5 |
| 1-4 hours | 8 | 2 | 3 | 1 | 0 | $13.04 | $13 |
| <15 min fix | 38 | 29 | 29 | 3 | 3 | $17.45 | $20.69 |
| >4 hours | 1 | 0 | 0 | 0 | 0 | $0.32 | $0.29 |

### Diagnostic subset & baseline-reuse & django splits
| stratum | tasks | base✓ | treat✓ | T-only | B-only | treat$ | base$ |
|---|---|---|---|---|---|---|---|
| M62/M69 locked | 24 | 15 | 15 | 2 | 2 | $17.41 | $21.97 |
| rest | 76 | 49 | 51 | 9 | 7 | $50.53 | $56.5 |
| reused_verified baseline | 27 | 17 | 17 | 2 | 2 | $19.68 | $27.36 |
| fresh baseline | 73 | 47 | 49 | 9 | 7 | $48.27 | $51.11 |
| django | 44 | 28 | 31 | 6 | 3 | $26.74 | $28.61 |
| non-django | 56 | 36 | 35 | 5 | 6 | $41.21 | $49.86 |

**Interpretation:** see Verdict. Per-stratum win/loss counts above are descriptive; with single runs per cell, small-cell deltas are not individually significant.

## Statistical Reporting

- **Wilson 95% CI — baseline pass rate:** 64/100 = 64.0%, CI [54.2%, 72.7%]
- **Wilson 95% CI — treatment pass rate:** 66/100 = 66.0%, CI [56.3%, 74.5%]
- **Paired discordant pairs:** treatment_only 11, baseline_only 9
- **Exact two-sided sign test (McNemar exact):** p = 0.8238 — discordant split is NOT statistically distinguishable from chance at α=0.05.
- Exact two-sided binomial sign test (McNemar exact) on discordant pairs only; computed here, not from an external library.

**Non-claims:**
- Does not claim VTRACE is VEXP parity.
- Does not claim broad SWE-bench superiority.
- Does not claim statistical superiority beyond what the reported paired sign test supports.

## Success Criteria Check (M70 strict)

| # | criterion | result | detail |
|---|---|---|---|
| 1 | treatment valid in >= 95/100 attempted/selected runs | PASS | 96/99 attempted valid (96 valid of 99 attempted; 95-of-100-selected target) |
| 2 | resolution not worse than comparable baseline | PASS | treatment 66 vs baseline 64 (delta +2) |
| 3 | treatment-only wins >= baseline-only losses | PASS | treatment_only 11 vs baseline_only 9 (net +2) |
| 4 | required-target decision coverage >= 90% | PASS | 92.57% |
| 5 | ignored required-target rate <= 5% | PASS | 1.35% |
| 6 | invalid rule-out rate does not exceed M69 by more than 2 pp | PASS | M73 6.08% vs M69 7.32% (threshold <= 9.32%) |
| 7 | no required IMPACT targets emitted | PASS | 0 required IMPACT targets |
| 8 | optional/FYI targets not closure-scored | PASS | O-namespaced optional context never closure-scored (M65/M68 invariant; verified in M71/M72 detail) |
| 9 | pooled cost regression vs baseline <= +15% | PASS | -13.16% paired pooled cost delta |
| 10 | no systematic over-anchoring on baseline-strong controls | PASS | baseline_only_pass 9 <= treatment_only_pass 11; off-target edits tracked in M71/M72 |

**10/10 strict criteria pass.**

## Verdict

**STRICT PASS**

- Validity 96/99 attempted treatment runs valid; fresh baselines 73/73 valid.
- Resolution: treatment 66/100 vs baseline 64/100 (delta +2); net treatment wins +2.
- Cost: paired pooled -13.16% vs baseline.

## Recommendation

**Publish/report as an internal 100-task engineering validation.** Before any external SWE-bench claim, run a targeted replicate subset (re-run the discordant and high-variance cases) to confirm the paired deltas, and align the comparator/sampling with the external benchmark. Do not claim VEXP parity or broad SWE-bench superiority.
