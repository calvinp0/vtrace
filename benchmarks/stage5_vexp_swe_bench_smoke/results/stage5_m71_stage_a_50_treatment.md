# Stage 5 M71 Stage A 50-Treatment Run

## Summary
- Stage A selected count: **50**
- pre-flight valid / invalid / skipped: **50 / 0 / 0** (of 50)
- new live treatment runs: **50**
- Docker evals: **48**
- reused baselines available in Stage A: **15**
- fresh baselines pending in Stage A (Stage C): **35**
- treatment valid / invalid: **48 / 2** (96%)
- headline treatment resolution: **32/50** resolved (48 evaluated)
- paired (reused-baseline) subset: treatment **9/14** vs baseline **9/14**
- unpaired (fresh-baseline-pending) subset: treatment **23/34** (paired conclusion pending Stage C)
- headline cost: total **$34.40**, mean **$0.69**/run, pooled tokens **61,374,252**
- structured-decision compliance: coverage **93.59%**, ignored **0%**, invalid rule-out **6.41%**
- verdict: **PASS**
- recommendation: **authorize Stage B 50 treatment runs**

## Fixture / Matrix Compliance
- M70B execution matrix used: `stage5_m70b_100_task_execution_matrix.json` (100 rows)
- Stage A membership (execution_stage == "stage_a"): **50**
- cases added / removed / replaced: **none** (frozen membership; not altered after seeing results)
- deviations:
  1. Pre-flight rendered to an isolated temp `--out` with the real `results/workspaces` symlinked in (reuse), so the committed `stage5_m70b_preflight.json` was not overwritten. No retrieval/scoring/ranking code touched.
  2. Quota interruption: 8 first-pass runs (sphinx-doc__sphinx-9698, sphinx-doc__sphinx-9711, sympy__sympy-12481, sympy__sympy-16597, sympy__sympy-16792, sympy__sympy-18189, sympy__sympy-20428, sympy__sympy-24213) were aborted by the account's 5-hour session limit (HTTP 429 `out_of_credits`) with no patch. The user explicitly authorized re-running those 8 **distinct** instances after the credit reset to obtain one valid result per Stage A instance — 58 total live launches vs the literal 50-launch cap, **no** new/replacement instances and **no** variance replicates. All 8 re-runs completed cleanly with no repeat 429.

## Stage A Pre-flight
- valid cases: **50**
- invalid cases: **0** 
- skipped cases: **0**
- zero-required cases: **2** (sympy__sympy-16597, sympy__sympy-16792)
- demoted pivot count (pre-flight): **14**
- required IMPACT count (pre-flight): **0**
- optional/FYI integrity: optional_impact_context_missing=0
- confidence-gate integrity: gate-on render reproduced for all rendered cases (reuse=27, clone=23)

## Run Matrix
| instance_id | repo | difficulty | baseline_reuse | base_resolved | preflight | valid | evaluated | resolved | notes |
|---|---|---|---|---|---|---|---|---|---|
| astropy__astropy-14365 | astropy/astropy | 15 min - 1 hour | reused_verified | false | VALID | yes | yes | no |  |
| astropy__astropy-14369 | astropy/astropy | 1-4 hours | reused_verified | false | VALID | yes | yes | no |  |
| astropy__astropy-14539 | astropy/astropy | 15 min - 1 hour | reused_verified | true | VALID | yes | yes | yes |  |
| astropy__astropy-14598 | astropy/astropy | 15 min - 1 hour | reused_verified | false | VALID | no | no | no | m71_fail_closed_omitted |
| astropy__astropy-7166 | astropy/astropy | <15 min fix | missing | — | VALID | yes | yes | yes |  |
| django__django-12276 | django/django | <15 min fix | missing | — | VALID | yes | yes | yes |  |
| django__django-12858 | django/django | 15 min - 1 hour | missing | — | VALID | yes | yes | yes |  |
| django__django-13112 | django/django | <15 min fix | missing | — | VALID | yes | yes | yes |  |
| django__django-13363 | django/django | <15 min fix | missing | — | VALID | yes | yes | yes |  |
| django__django-13590 | django/django | 15 min - 1 hour | missing | — | VALID | yes | yes | yes |  |
| django__django-15503 | django/django | 1-4 hours | missing | — | VALID | no | no | no | m71_fail_closed_omitted |
| django__django-15572 | django/django | <15 min fix | missing | — | VALID | yes | yes | no |  |
| matplotlib__matplotlib-22719 | matplotlib/matplotlib | <15 min fix | reused_verified | true | VALID | yes | yes | yes |  |
| matplotlib__matplotlib-24627 | matplotlib/matplotlib | 15 min - 1 hour | reused_verified | false | VALID | yes | yes | yes |  |
| matplotlib__matplotlib-24870 | matplotlib/matplotlib | 15 min - 1 hour | missing | — | VALID | yes | yes | no |  |
| matplotlib__matplotlib-24970 | matplotlib/matplotlib | 15 min - 1 hour | missing | — | VALID | yes | yes | yes |  |
| matplotlib__matplotlib-25332 | matplotlib/matplotlib | <15 min fix | missing | — | VALID | yes | yes | yes |  |
| matplotlib__matplotlib-26466 | matplotlib/matplotlib | 15 min - 1 hour | missing | — | VALID | yes | yes | no |  |
| mwaskom__seaborn-3187 | mwaskom/seaborn | 15 min - 1 hour | reused_verified | false | VALID | yes | yes | no |  |
| pallets__flask-5014 | pallets/flask | <15 min fix | reused_verified | true | VALID | yes | yes | yes |  |
| psf__requests-1142 | psf/requests | <15 min fix | reused_verified | true | VALID | yes | yes | yes |  |
| psf__requests-1724 | psf/requests | <15 min fix | missing | — | VALID | yes | yes | yes |  |
| psf__requests-1921 | psf/requests | <15 min fix | missing | — | VALID | yes | yes | no |  |
| psf__requests-5414 | psf/requests | <15 min fix | reused_verified | true | VALID | yes | yes | no |  |
| pydata__xarray-2905 | pydata/xarray | 15 min - 1 hour | missing | — | VALID | yes | yes | yes |  |
| pydata__xarray-3677 | pydata/xarray | 15 min - 1 hour | reused_verified | true | VALID | yes | yes | yes |  |
| pydata__xarray-4695 | pydata/xarray | 15 min - 1 hour | missing | — | VALID | yes | yes | yes |  |
| pydata__xarray-6599 | pydata/xarray | 15 min - 1 hour | missing | — | VALID | yes | yes | no |  |
| pydata__xarray-6938 | pydata/xarray | 15 min - 1 hour | missing | — | VALID | yes | yes | yes |  |
| pydata__xarray-6992 | pydata/xarray | >4 hours | missing | — | VALID | yes | yes | no |  |
| pylint-dev__pylint-4551 | pylint-dev/pylint | 1-4 hours | missing | — | VALID | yes | yes | no |  |
| pylint-dev__pylint-8898 | pylint-dev/pylint | 1-4 hours | reused_verified | true | VALID | yes | yes | yes |  |
| pytest-dev__pytest-10051 | pytest-dev/pytest | 15 min - 1 hour | missing | — | VALID | yes | yes | no |  |
| pytest-dev__pytest-5262 | pytest-dev/pytest | <15 min fix | missing | — | VALID | yes | yes | yes |  |
| pytest-dev__pytest-6197 | pytest-dev/pytest | 1-4 hours | missing | — | VALID | yes | yes | yes |  |
| pytest-dev__pytest-7432 | pytest-dev/pytest | <15 min fix | reused_verified | true | VALID | yes | yes | yes |  |
| scikit-learn__scikit-learn-10844 | scikit-learn/scikit-learn | 15 min - 1 hour | missing | — | VALID | yes | yes | yes |  |
| scikit-learn__scikit-learn-11578 | scikit-learn/scikit-learn | 15 min - 1 hour | missing | — | VALID | yes | yes | yes |  |
| sphinx-doc__sphinx-7462 | sphinx-doc/sphinx | <15 min fix | reused_verified | false | VALID | yes | yes | no |  |
| sphinx-doc__sphinx-7910 | sphinx-doc/sphinx | <15 min fix | missing | — | VALID | yes | yes | yes |  |
| sphinx-doc__sphinx-9230 | sphinx-doc/sphinx | <15 min fix | missing | — | VALID | yes | yes | yes |  |
| sphinx-doc__sphinx-9320 | sphinx-doc/sphinx | <15 min fix | missing | — | VALID | yes | yes | yes |  |
| sphinx-doc__sphinx-9698 | sphinx-doc/sphinx | <15 min fix | missing | — | VALID | yes | yes | yes |  |
| sphinx-doc__sphinx-9711 | sphinx-doc/sphinx | <15 min fix | missing | — | VALID | yes | yes | no |  |
| sympy__sympy-12481 | sympy/sympy | <15 min fix | reused_verified | true | VALID | yes | yes | yes |  |
| sympy__sympy-16597 | sympy/sympy | 1-4 hours | missing | — | VALID | yes | yes | no |  |
| sympy__sympy-16792 | sympy/sympy | 15 min - 1 hour | missing | — | VALID | yes | yes | yes |  |
| sympy__sympy-18189 | sympy/sympy | <15 min fix | missing | — | VALID | yes | yes | yes |  |
| sympy__sympy-20428 | sympy/sympy | 15 min - 1 hour | missing | — | VALID | yes | yes | no |  |
| sympy__sympy-24213 | sympy/sympy | 15 min - 1 hour | missing | — | VALID | yes | yes | yes |  |

## Results Table
| instance_id | repo | base_reuse | treat_resolved | base_resolved | total_tokens | cost | tools | reads | searches | rpt_reads | req_tgts | demoted | open | inv_ruleout | optional | opt_edited |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| astropy__astropy-14365 | astropy/astropy | reused_verified | no | false | 470020 | $0.34 | 4 | 1 | 0 | 0 | 1 | 1 | 0 | 0 | 2 | 0 |
| astropy__astropy-14369 | astropy/astropy | reused_verified | no | false | 963010 | $0.70 | 9 | 2 | 2 | 1 | 2 | 0 | 1 | 1 | 2 | 0 |
| astropy__astropy-14539 | astropy/astropy | reused_verified | yes | true | 906802 | $0.50 | 9 | 4 | 0 | 3 | 2 | 0 | 0 | 0 | 2 | 0 |
| astropy__astropy-14598 | astropy/astropy | reused_verified | no | false | 4324562 | $3.00 | 32 | 10 | 9 | 8 | 2 | 0 | 2 | 0 | 0 | 0 |
| astropy__astropy-7166 | astropy/astropy | missing | yes | — | 540685 | $0.40 | 5 | 1 | 1 | 0 | 2 | 0 | 0 | 0 | 2 | 0 |
| django__django-12276 | django/django | missing | yes | — | 560439 | $0.34 | 5 | 2 | 0 | 1 | 1 | 1 | 0 | 0 | 3 | 0 |
| django__django-12858 | django/django | missing | yes | — | 795176 | $0.41 | 7 | 2 | 0 | 1 | 1 | 1 | 0 | 0 | 2 | 0 |
| django__django-13112 | django/django | missing | yes | — | 2107444 | $0.87 | 17 | 6 | 4 | 2 | 2 | 0 | 0 | 0 | 2 | 0 |
| django__django-13363 | django/django | missing | yes | — | 450200 | $0.31 | 4 | 2 | 0 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| django__django-13590 | django/django | missing | yes | — | 969483 | $0.51 | 10 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| django__django-15503 | django/django | missing | no | — | 4668542 | $3.04 | 44 | 12 | 1 | 10 | 1 | 1 | 0 | 0 | 2 | 0 |
| django__django-15572 | django/django | missing | no | — | 700827 | $0.38 | 7 | 2 | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 0 |
| matplotlib__matplotlib-22719 | matplotlib/matplotlib | reused_verified | yes | true | 1316556 | $0.63 | 13 | 5 | 2 | 2 | 2 | 0 | 0 | 0 | 0 | 0 |
| matplotlib__matplotlib-24627 | matplotlib/matplotlib | reused_verified | yes | false | 1934960 | $0.75 | 19 | 5 | 3 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| matplotlib__matplotlib-24870 | matplotlib/matplotlib | missing | no | — | 999153 | $0.51 | 9 | 1 | 1 | 0 | 2 | 0 | 0 | 0 | 2 | 0 |
| matplotlib__matplotlib-24970 | matplotlib/matplotlib | missing | yes | — | 906633 | $0.47 | 9 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 2 | 0 |
| matplotlib__matplotlib-25332 | matplotlib/matplotlib | missing | yes | — | 1763862 | $0.84 | 18 | 6 | 3 | 4 | 2 | 0 | 2 | 2 | 2 | 0 |
| matplotlib__matplotlib-26466 | matplotlib/matplotlib | missing | no | — | 718107 | $0.40 | 7 | 2 | 2 | 1 | 1 | 1 | 0 | 0 | 1 | 0 |
| mwaskom__seaborn-3187 | mwaskom/seaborn | reused_verified | no | false | 692555 | $0.45 | 6 | 2 | 1 | 1 | 2 | 0 | 0 | 0 | 0 | 0 |
| pallets__flask-5014 | pallets/flask | reused_verified | yes | true | 631974 | $0.34 | 6 | 2 | 0 | 1 | 2 | 0 | 1 | 1 | 2 | 0 |
| psf__requests-1142 | psf/requests | reused_verified | yes | true | 605078 | $0.37 | 6 | 3 | 1 | 1 | 2 | 0 | 1 | 1 | 2 | 0 |
| psf__requests-1724 | psf/requests | missing | yes | — | 957550 | $0.46 | 9 | 4 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 0 |
| psf__requests-1921 | psf/requests | missing | no | — | 1153016 | $0.69 | 10 | 4 | 0 | 3 | 2 | 0 | 0 | 0 | 2 | 0 |
| psf__requests-5414 | psf/requests | reused_verified | no | true | 460116 | $0.32 | 4 | 1 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| pydata__xarray-2905 | pydata/xarray | missing | yes | — | 572710 | $0.37 | 5 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| pydata__xarray-3677 | pydata/xarray | reused_verified | yes | true | 1887096 | $0.78 | 17 | 5 | 0 | 4 | 2 | 0 | 0 | 0 | 2 | 0 |
| pydata__xarray-4695 | pydata/xarray | missing | yes | — | 1231394 | $0.61 | 10 | 3 | 2 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| pydata__xarray-6599 | pydata/xarray | missing | no | — | 1702344 | $0.96 | 14 | 3 | 1 | 2 | 2 | 0 | 0 | 0 | 2 | 0 |
| pydata__xarray-6938 | pydata/xarray | missing | yes | — | 3025575 | $1.12 | 26 | 3 | 6 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| pydata__xarray-6992 | pydata/xarray | missing | no | — | 455193 | $0.32 | 4 | 1 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| pylint-dev__pylint-4551 | pylint-dev/pylint | missing | no | — | 3578695 | $3.01 | 26 | 7 | 2 | 3 | 1 | 1 | 0 | 0 | 1 | 0 |
| pylint-dev__pylint-8898 | pylint-dev/pylint | reused_verified | yes | true | 1958536 | $0.84 | 18 | 1 | 3 | 0 | 2 | 0 | 0 | 0 | 2 | 0 |
| pytest-dev__pytest-10051 | pytest-dev/pytest | missing | no | — | 770134 | $0.38 | 7 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| pytest-dev__pytest-5262 | pytest-dev/pytest | missing | yes | — | 597021 | $0.36 | 6 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| pytest-dev__pytest-6197 | pytest-dev/pytest | missing | yes | — | 2812676 | $1.75 | 23 | 7 | 4 | 5 | 1 | 1 | 0 | 0 | 3 | 0 |
| pytest-dev__pytest-7432 | pytest-dev/pytest | reused_verified | yes | true | 971683 | $0.50 | 12 | 2 | 0 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| scikit-learn__scikit-learn-10844 | scikit-learn/scikit-learn | missing | yes | — | 541970 | $0.38 | 5 | 2 | 0 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| scikit-learn__scikit-learn-11578 | scikit-learn/scikit-learn | missing | yes | — | 488657 | $0.35 | 4 | 2 | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 0 |
| sphinx-doc__sphinx-7462 | sphinx-doc/sphinx | reused_verified | no | false | 578462 | $0.37 | 5 | 2 | 0 | 1 | 2 | 0 | 0 | 0 | 1 | 0 |
| sphinx-doc__sphinx-7910 | sphinx-doc/sphinx | missing | yes | — | 1319178 | $0.71 | 12 | 2 | 0 | 1 | 1 | 1 | 0 | 0 | 3 | 0 |
| sphinx-doc__sphinx-9230 | sphinx-doc/sphinx | missing | yes | — | 1037162 | $0.52 | 10 | 3 | 2 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| sphinx-doc__sphinx-9320 | sphinx-doc/sphinx | missing | yes | — | 835951 | $0.45 | 8 | 3 | 1 | 2 | 2 | 0 | 0 | 0 | 2 | 0 |
| sphinx-doc__sphinx-9698 | sphinx-doc/sphinx | missing | yes | — | 1088897 | $0.40 | 11 | 4 | 4 | 2 | 2 | 0 | 0 | 0 | 2 | 0 |
| sphinx-doc__sphinx-9711 | sphinx-doc/sphinx | missing | no | — | 722853 | $0.38 | 8 | 1 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| sympy__sympy-12481 | sympy/sympy | reused_verified | yes | true | 671078 | $0.38 | 6 | 3 | 0 | 2 | 1 | 1 | 0 | 0 | 3 | 1 |
| sympy__sympy-16597 | sympy/sympy | missing | no | — | 489163 | $0.34 | 4 | 1 | 0 | 0 | 0 | 2 | 0 | 0 | 3 | 0 |
| sympy__sympy-16792 | sympy/sympy | missing | yes | — | 1560118 | $0.71 | 15 | 3 | 8 | 1 | 0 | 2 | 0 | 0 | 4 | 0 |
| sympy__sympy-18189 | sympy/sympy | missing | yes | — | 458657 | $0.31 | 4 | 1 | 0 | 0 | 1 | 1 | 0 | 0 | 3 | 0 |
| sympy__sympy-20428 | sympy/sympy | missing | no | — | 1407371 | $0.62 | 13 | 3 | 4 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| sympy__sympy-24213 | sympy/sympy | missing | yes | — | 1014928 | $0.46 | 10 | 3 | 2 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |

## Paired Subset Analysis
_Cases with reused_verified baselines only._
- paired_case_count: **14**
- baseline_passes: **9**
- treatment_passes: **9**
- both_pass: **8**
- both_fail: **4**
- treatment_only_pass: **1**
- baseline_only_pass: **1**
- pooled cost (metrics pairs=14): treatment $7.26 vs baseline $13.56
- pooled tokens: treatment 14,047,926 vs baseline 23,795,641

## Unpaired Treatment-Only Analysis
_Cases with fresh_required baselines pending (Stage C). Paired conclusion is pending Stage C._
- case_count: **34**
- treatment_passes: **23**
- treatment_failures: **11**
- pooled cost: $21.09 (mean $0.62/run); pooled tokens 38,333,222; mean tool calls 10.1

## Structured Decision Analysis
- required targets (pooled): **78** — closed 73, open 5, ignored 0, invalid 5
- decisions: EDIT 40, RULE_OUT 7, INSPECT_ONLY_NO_EDIT 26
- decision coverage: **93.59%**
- ignored rate: **0%**
- invalid rule-out rate: **6.41%**
- zero-required count: **2** (all marker-backed=true)
- demoted pivot count: **13** (any demoted edited=true)
- required IMPACT target count: **0** (required_impact_any=false)
- off-target edits (pooled): **16**
- comparison to M69: M69 coverage 90.24%, ignored 2.44%, invalid rule-out 7.32%

## Cost / Operational Analysis
- total Stage A treatment cost: **$34.40**
- mean / median cost: **$0.69 / $0.46**
- pooled tokens: **61,374,252**
- thrashing outlier (max cost): **django__django-15503** at $3.04
- repo cost concentration (top 5): django/django $5.85, astropy/astropy $4.94, pydata/xarray $4.17, pylint-dev/pylint $3.84, matplotlib/matplotlib $3.60
- projected full 100-treatment cost (Stage A mean × 100): **$68.80**

## Success Criteria Check
- ✅ **C1** Stage A pre-flight has no partial sentinel — preflight partial_sentinel=0, run partial_sentinel_any=false
- ✅ **C2** treatment valid in >=95% of attempted runs — 48/50 = 96%
- ✅ **C3** no required IMPACT targets emitted — required_impact_any=false
- ✅ **C4** confidence gate enabled in all valid treatment runs — gate verified 48/48
- ✅ **C5** optional/FYI targets not closure-scored — optional_impact_ok=true
- ✅ **C6** decision coverage >=90% (or miss explained by zero-required/known-invalid) — coverage 93.59% (zero-required=2)
- ✅ **C7** invalid rule-out rate not >2pp above M69 — M71 6.41% vs M69 7.32% (Δ -0.91pp)
- ✅ **C8** no severe cost explosion (projected 100-treatment acceptable) — projected 100-treatment $68.80 (mean $0.69/run)
- ✅ **C9** no systematic failure pattern making Stage B unsafe — 2 invalid; gate_all=true; required_impact=false

## Verdict
**PASS**

## Recommendation
**authorize Stage B 50 treatment runs**

---
_Interpretation guardrails: this is Stage A only — not the full 100-task benchmark, not Stage B/C, not a default promotion. No VEXP-parity or general SWE-bench-improvement claim is made. Paired pass-rate conclusions are limited to the reused-baseline subset; the rest is treatment-only pending Stage C fresh baselines._

