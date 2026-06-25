# Stage 5 M72 Stage B 50-Treatment Run

## Summary
- Stage B selected count: **49** (of 50 frozen Stage B membership; 1 skipped pre-flight invalid)
- pre-flight valid / invalid / skipped: **49 / 0 / 1** (rendered 49; skipped = django__django-10973)
- new live treatment runs: **49**
- operational retries / quota aborts: **0 / 0**
- Docker evals: **48**
- reused baselines available in Stage B: **12**
- fresh baselines pending in Stage B (Stage C): **37**
- treatment valid / invalid: **48 / 1** (98%)
- headline Stage B treatment resolution: **34/49** resolved (48 evaluated)
- paired (reused-baseline) subset: treatment **8/12** vs baseline **8/12**
- unpaired (fresh-baseline-pending) subset: treatment **26/36** (paired conclusion pending Stage C)
- headline cost: total **$33.55**, mean **$0.68**/run, pooled tokens **55,740,664**
- structured-decision compliance: coverage **91.43%**, ignored **2.86%**, invalid rule-out **5.71%**
- cumulative Stage A+B treatment-only: **66/99** resolved, valid **96/99** (97%), total cost **$67.95**
- verdict: **PASS**
- recommendation: **authorize Stage C fresh baselines**

## Fixture / Matrix Compliance
- M70B execution matrix used: `stage5_m70b_100_task_execution_matrix.json` (100 rows)
- Stage B membership (execution_stage == "stage_b"): **50**
- cases added / removed / replaced: **none** (frozen membership; not altered after seeing results)
- deviations:
  1. `django__django-10973` is the matrix's known OTHER_INVALID (contract_absent) case — recorded as pre-flight invalid / skipped and **not replaced** (stays within the 50-instance cap). Stage B live runs = 49.
  2. Pre-flight re-rendered the gate-on injected context with current code: 22 reuse (persisted index) + 27 clone (temp dir, cleaned up). No retrieval/scoring/ranking code touched (no `src/` change since the matrix commit).

## Stage B Pre-flight
- valid cases: **49**
- invalid cases (rendered): **0** 
- skipped cases (matrix-invalid, not re-rendered): **1** django__django-10973
- zero-required cases: **6** (django__django-11815, django__django-13012, django__django-13810, django__django-15695, sphinx-doc__sphinx-7748, sympy__sympy-12419)
- demoted pivot count (pre-flight): **17**
- required IMPACT count (pre-flight): **0**
- optional/FYI integrity: optional_impact_context_missing=0
- confidence-gate integrity: gate-on render reproduced for all rendered cases (reuse=22, clone=27); partial sentinel=0

### Live gate integrity (treatment runs)
- `--pivot-confidence-gate` applied to all 49 runs (driver-hard-coded): **true**
- live render reproduced the pre-flight render in **46/49** runs
- runs with a definitive gate effect (demoted pivot or zero-required+marker — gate-only outputs): **14**
- pre-flight render drift (benign): **3** case(s) where the pre-flight REUSE render (older persisted index) differs from the live fresh-clone render. All remain valid gated contracts; the live render is what the agent saw. Not a gate failure (CLAUDE.md: persisted workspaces can be stale).
  - django__django-11206: pre-flight req=2/demoted=0 → live req=1/demoted=0 (gate effect visible: false; resolved: yes)
  - django__django-11740: pre-flight req=2/demoted=0 → live req=0/demoted=2 (gate effect visible: true; resolved: yes)
  - django__django-12774: pre-flight req=2/demoted=0 → live req=1/demoted=1 (gate effect visible: true; resolved: yes)

## Run Matrix
| instance_id | repo | difficulty | baseline_reuse | base_resolved | preflight | treatment_run_label | valid | evaluated | resolved | retries | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| django__django-10880 | django/django | <15 min fix | reused_verified | true | VALID | m72_stage_b_pivot_confidence_django_10880 | yes | yes | yes | 0 |  |
| django__django-11095 | django/django | 15 min - 1 hour | reused_verified | true | VALID | m72_stage_b_pivot_confidence_django_11095 | yes | yes | yes | 0 |  |
| django__django-11133 | django/django | <15 min fix | missing | — | VALID | m72_stage_b_pivot_confidence_django_11133 | yes | yes | yes | 0 |  |
| django__django-11206 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_11206 | yes | yes | yes | 0 |  |
| django__django-11490 | django/django | <15 min fix | reused_verified | true | VALID | m72_stage_b_pivot_confidence_django_11490 | yes | yes | yes | 0 |  |
| django__django-11728 | django/django | 15 min - 1 hour | reused_verified | true | VALID | m72_stage_b_pivot_confidence_django_11728 | yes | yes | yes | 0 |  |
| django__django-11740 | django/django | 15 min - 1 hour | reused_verified | true | VALID | m72_stage_b_pivot_confidence_django_11740 | yes | yes | yes | 0 |  |
| django__django-11749 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_11749 | yes | yes | yes | 0 |  |
| django__django-11815 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_11815 | yes | yes | yes | 0 |  |
| django__django-11820 | django/django | <15 min fix | reused_verified | false | VALID | m72_stage_b_pivot_confidence_django_11820 | yes | yes | no | 0 |  |
| django__django-12050 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_12050 | yes | yes | yes | 0 |  |
| django__django-12273 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_12273 | yes | yes | yes | 0 |  |
| django__django-12325 | django/django | 1-4 hours | missing | — | VALID | m72_stage_b_pivot_confidence_django_12325 | yes | yes | yes | 0 |  |
| django__django-12774 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_12774 | yes | yes | yes | 0 |  |
| django__django-13012 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_13012 | yes | yes | yes | 0 |  |
| django__django-13195 | django/django | 15 min - 1 hour | reused_verified | false | VALID | m72_stage_b_pivot_confidence_django_13195 | yes | yes | no | 0 |  |
| django__django-13512 | django/django | <15 min fix | missing | — | VALID | m72_stage_b_pivot_confidence_django_13512 | yes | yes | no | 0 |  |
| django__django-13513 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_13513 | no | no | no | 0 | m72_fail_closed_omitted |
| django__django-13551 | django/django | <15 min fix | missing | — | VALID | m72_stage_b_pivot_confidence_django_13551 | yes | yes | yes | 0 |  |
| django__django-13658 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_13658 | yes | yes | yes | 0 |  |
| django__django-13810 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_13810 | yes | yes | yes | 0 |  |
| django__django-13820 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_13820 | yes | yes | yes | 0 |  |
| django__django-14608 | django/django | <15 min fix | missing | — | VALID | m72_stage_b_pivot_confidence_django_14608 | yes | yes | yes | 0 |  |
| django__django-14792 | django/django | <15 min fix | missing | — | VALID | m72_stage_b_pivot_confidence_django_14792 | yes | yes | no | 0 |  |
| django__django-15037 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_15037 | yes | yes | yes | 0 |  |
| django__django-15695 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_15695 | yes | yes | no | 0 |  |
| django__django-15731 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_15731 | yes | yes | yes | 0 |  |
| django__django-16256 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_16256 | yes | yes | no | 0 |  |
| django__django-16263 | django/django | 1-4 hours | missing | — | VALID | m72_stage_b_pivot_confidence_django_16263 | yes | yes | no | 0 |  |
| django__django-16333 | django/django | <15 min fix | missing | — | VALID | m72_stage_b_pivot_confidence_django_16333 | yes | yes | yes | 0 |  |
| django__django-16569 | django/django | <15 min fix | missing | — | VALID | m72_stage_b_pivot_confidence_django_16569 | yes | yes | yes | 0 |  |
| django__django-16667 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_16667 | yes | yes | no | 0 |  |
| django__django-16819 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_16819 | yes | yes | yes | 0 |  |
| django__django-16877 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_16877 | yes | yes | yes | 0 |  |
| django__django-16938 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_16938 | yes | yes | no | 0 |  |
| django__django-17084 | django/django | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_django_17084 | yes | yes | yes | 0 |  |
| matplotlib__matplotlib-25960 | matplotlib/matplotlib | 15 min - 1 hour | reused_verified | false | VALID | m72_stage_b_pivot_confidence_matplotlib_25960 | yes | yes | yes | 0 |  |
| sphinx-doc__sphinx-7748 | sphinx-doc/sphinx | 15 min - 1 hour | reused_verified | false | VALID | m72_stage_b_pivot_confidence_sphinx_7748 | yes | yes | no | 0 |  |
| sympy__sympy-12419 | sympy/sympy | 15 min - 1 hour | reused_verified | true | VALID | m72_stage_b_pivot_confidence_sympy_12419 | yes | yes | no | 0 |  |
| sympy__sympy-13372 | sympy/sympy | <15 min fix | reused_verified | true | VALID | m72_stage_b_pivot_confidence_sympy_13372 | yes | yes | yes | 0 |  |
| sympy__sympy-13480 | sympy/sympy | <15 min fix | missing | — | VALID | m72_stage_b_pivot_confidence_sympy_13480 | yes | yes | yes | 0 |  |
| sympy__sympy-13974 | sympy/sympy | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_sympy_13974 | yes | yes | no | 0 |  |
| sympy__sympy-15599 | sympy/sympy | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_sympy_15599 | yes | yes | no | 0 |  |
| sympy__sympy-15875 | sympy/sympy | <15 min fix | missing | — | VALID | m72_stage_b_pivot_confidence_sympy_15875 | yes | yes | yes | 0 |  |
| sympy__sympy-16766 | sympy/sympy | <15 min fix | reused_verified | true | VALID | m72_stage_b_pivot_confidence_sympy_16766 | yes | yes | yes | 0 |  |
| sympy__sympy-19637 | sympy/sympy | <15 min fix | missing | — | VALID | m72_stage_b_pivot_confidence_sympy_19637 | yes | yes | yes | 0 |  |
| sympy__sympy-20801 | sympy/sympy | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_sympy_20801 | yes | yes | yes | 0 |  |
| sympy__sympy-23413 | sympy/sympy | 15 min - 1 hour | missing | — | VALID | m72_stage_b_pivot_confidence_sympy_23413 | yes | yes | yes | 0 |  |
| sympy__sympy-24562 | sympy/sympy | <15 min fix | missing | — | VALID | m72_stage_b_pivot_confidence_sympy_24562 | yes | yes | no | 0 |  |

## Results Table
| instance_id | repo | base_reuse | treat_resolved | base_resolved | total_tokens | cost | tools | reads | searches | rpt_reads | req_tgts | demoted | open | inv_ruleout | optional | opt_edited |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| django__django-10880 | django/django | reused_verified | yes | true | 541327 | $0.35 | 5 | 1 | 0 | 0 | 2 | 0 | 2 | 0 | 2 | 0 |
| django__django-11095 | django/django | reused_verified | yes | true | 665641 | $0.38 | 6 | 2 | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 0 |
| django__django-11133 | django/django | missing | yes | — | 1084089 | $0.53 | 12 | 2 | 2 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| django__django-11206 | django/django | missing | yes | — | 458539 | $0.56 | 4 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 2 | 0 |
| django__django-11490 | django/django | reused_verified | yes | true | 1855337 | $0.95 | 15 | 3 | 3 | 2 | 1 | 1 | 0 | 0 | 2 | 1 |
| django__django-11728 | django/django | reused_verified | yes | true | 1116528 | $0.64 | 10 | 2 | 0 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| django__django-11740 | django/django | reused_verified | yes | true | 1284712 | $0.62 | 13 | 1 | 5 | 0 | 0 | 2 | 0 | 0 | 4 | 0 |
| django__django-11749 | django/django | missing | yes | — | 1417931 | $0.67 | 15 | 2 | 0 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| django__django-11815 | django/django | missing | yes | — | 863117 | $0.44 | 10 | 1 | 3 | 0 | 0 | 2 | 0 | 0 | 2 | 0 |
| django__django-11820 | django/django | reused_verified | no | false | 578644 | $0.38 | 5 | 1 | 0 | 0 | 2 | 0 | 0 | 0 | 1 | 0 |
| django__django-12050 | django/django | missing | yes | — | 581818 | $0.35 | 6 | 1 | 1 | 0 | 2 | 0 | 0 | 0 | 1 | 0 |
| django__django-12273 | django/django | missing | yes | — | 877147 | $0.54 | 9 | 4 | 1 | 2 | 2 | 0 | 0 | 0 | 2 | 0 |
| django__django-12325 | django/django | missing | yes | — | 540234 | $0.35 | 5 | 2 | 0 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| django__django-12774 | django/django | missing | yes | — | 1210570 | $0.58 | 12 | 2 | 2 | 0 | 1 | 1 | 0 | 0 | 3 | 0 |
| django__django-13012 | django/django | missing | yes | — | 1365224 | $0.62 | 15 | 1 | 4 | 0 | 0 | 2 | 0 | 0 | 3 | 0 |
| django__django-13195 | django/django | reused_verified | no | false | 521408 | $0.32 | 5 | 1 | 1 | 0 | 2 | 0 | 0 | 0 | 1 | 0 |
| django__django-13512 | django/django | missing | no | — | 346618 | $0.26 | 3 | 1 | 0 | 0 | 2 | 0 | 1 | 1 | 0 | 0 |
| django__django-13513 | django/django | missing | no | — | 777650 | $0.51 | 8 | 1 | 1 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| django__django-13551 | django/django | missing | yes | — | 718376 | $0.42 | 7 | 2 | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 0 |
| django__django-13658 | django/django | missing | yes | — | 672978 | $0.37 | 6 | 3 | 0 | 1 | 2 | 0 | 0 | 0 | 1 | 0 |
| django__django-13810 | django/django | missing | yes | — | 1137975 | $0.62 | 11 | 1 | 2 | 0 | 0 | 2 | 0 | 0 | 4 | 0 |
| django__django-13820 | django/django | missing | yes | — | 698094 | $0.42 | 6 | 2 | 0 | 1 | 1 | 1 | 0 | 0 | 3 | 0 |
| django__django-14608 | django/django | missing | yes | — | 500778 | $0.33 | 6 | 1 | 1 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| django__django-14792 | django/django | missing | no | — | 1294314 | $0.66 | 13 | 3 | 2 | 0 | 2 | 0 | 0 | 0 | 2 | 1 |
| django__django-15037 | django/django | missing | yes | — | 1140456 | $0.58 | 10 | 2 | 3 | 1 | 1 | 0 | 1 | 1 | 0 | 0 |
| django__django-15695 | django/django | missing | no | — | 1001722 | $0.68 | 8 | 2 | 1 | 0 | 0 | 2 | 0 | 0 | 4 | 0 |
| django__django-15731 | django/django | missing | yes | — | 908534 | $0.47 | 9 | 3 | 0 | 2 | 2 | 0 | 1 | 1 | 1 | 0 |
| django__django-16256 | django/django | missing | no | — | 750141 | $0.45 | 8 | 3 | 1 | 2 | 2 | 0 | 0 | 0 | 2 | 0 |
| django__django-16263 | django/django | missing | no | — | 4378100 | $3.02 | 35 | 10 | 10 | 9 | 1 | 1 | 0 | 0 | 3 | 0 |
| django__django-16333 | django/django | missing | yes | — | 712294 | $0.40 | 7 | 1 | 1 | 0 | 2 | 0 | 0 | 0 | 2 | 0 |
| django__django-16569 | django/django | missing | yes | — | 455285 | $0.30 | 4 | 2 | 0 | 1 | 1 | 1 | 0 | 0 | 3 | 0 |
| django__django-16667 | django/django | missing | no | — | 888140 | $0.48 | 9 | 1 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| django__django-16819 | django/django | missing | yes | — | 1391017 | $0.64 | 14 | 4 | 6 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| django__django-16877 | django/django | missing | yes | — | 801484 | $0.40 | 8 | 2 | 2 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| django__django-16938 | django/django | missing | no | — | 998348 | $0.57 | 9 | 3 | 0 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| django__django-17084 | django/django | missing | yes | — | 2207095 | $1.02 | 20 | 5 | 10 | 1 | 1 | 1 | 0 | 0 | 3 | 0 |
| matplotlib__matplotlib-25960 | matplotlib/matplotlib | reused_verified | yes | false | 2270353 | $1.33 | 19 | 5 | 9 | 3 | 1 | 0 | 0 | 0 | 0 | 0 |
| sphinx-doc__sphinx-7748 | sphinx-doc/sphinx | reused_verified | no | false | 1308091 | $0.67 | 12 | 6 | 1 | 5 | 0 | 1 | 0 | 0 | 1 | 1 |
| sympy__sympy-12419 | sympy/sympy | reused_verified | no | true | 4263827 | $3.00 | 31 | 12 | 8 | 6 | 0 | 2 | 0 | 0 | 4 | 0 |
| sympy__sympy-13372 | sympy/sympy | reused_verified | yes | true | 639612 | $0.39 | 6 | 2 | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 0 |
| sympy__sympy-13480 | sympy/sympy | missing | yes | — | 550616 | $0.31 | 5 | 2 | 0 | 1 | 2 | 0 | 0 | 0 | 1 | 0 |
| sympy__sympy-13974 | sympy/sympy | missing | no | — | 723425 | $0.44 | 7 | 2 | 0 | 1 | 2 | 0 | 0 | 0 | 1 | 0 |
| sympy__sympy-15599 | sympy/sympy | missing | no | — | 4340034 | $3.02 | 30 | 5 | 0 | 4 | 2 | 0 | 0 | 0 | 2 | 0 |
| sympy__sympy-15875 | sympy/sympy | missing | yes | — | 670154 | $0.49 | 6 | 2 | 0 | 0 | 1 | 1 | 0 | 0 | 3 | 0 |
| sympy__sympy-16766 | sympy/sympy | reused_verified | yes | true | 578323 | $0.38 | 6 | 1 | 2 | 0 | 2 | 0 | 0 | 0 | 2 | 0 |
| sympy__sympy-19637 | sympy/sympy | missing | yes | — | 513109 | $0.32 | 5 | 2 | 0 | 1 | 1 | 0 | 0 | 0 | 1 | 0 |
| sympy__sympy-20801 | sympy/sympy | missing | yes | — | 836781 | $0.42 | 10 | 2 | 3 | 0 | 1 | 0 | 0 | 0 | 2 | 0 |
| sympy__sympy-23413 | sympy/sympy | missing | yes | — | 1024999 | $1.24 | 6 | 1 | 0 | 0 | 2 | 0 | 1 | 1 | 2 | 0 |
| sympy__sympy-24562 | sympy/sympy | missing | no | — | 1279675 | $0.65 | 14 | 3 | 0 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |

## Stage B Paired Subset Analysis
_Cases with reused_verified baselines only._
- paired_case_count: **12**
- baseline_passes: **8**
- treatment_passes: **8**
- both_pass: **7**
- both_fail: **3**
- treatment_only_pass: **1**
- baseline_only_pass: **1**
- pooled cost (metrics pairs=12): treatment $9.42 vs baseline $10.75
- pooled tokens: treatment 15,623,803 vs baseline 24,463,988

## Stage B Unpaired Treatment-Only Analysis
_Cases with fresh_required baselines pending (Stage C). Paired conclusion is pending Stage C._
- case_count: **36**
- treatment_passes: **26**
- treatment_failures: **10**
- pooled cost: $23.62 (mean $0.66/run); pooled tokens 39,339,211; mean tool calls 10.1

## Cumulative Stage A+B Treatment Summary
_Treatment-only. NOT the final paired 100-task conclusion (Stage C fresh baselines pending)._
- selected tasks: **100** (Stage A 50 + Stage B 49)
- pre-flight skipped (in denominator): **1** (django__django-10973)
- treatment denominator after skips: **99**
- treatment attempted: **99**
- treatment valid / invalid: **96 / 3** (97%)
- treatment resolved / unresolved: **66 / 33**
- patch produced / no-patch fail-closed: **96 / 3**
- Docker evals: **96**
- total treatment cost: **$67.95** (Stage A $34.40 + Stage B $33.55); mean $0.69, median $0.47
- structured-decision: coverage **92.57%**, ignored **1.35%**, invalid rule-out **6.08%**
- required IMPACT count: **0**; zero-required count: **9**; demoted pivot count: **33**
- reused baseline available: **26**; fresh baseline pending Stage C: **70** (paired completion requirement for Stage C)

## Structured Decision Analysis
- required targets (pooled, valid): **70** — closed 64, open 6, ignored 2, invalid 4
- decisions: EDIT 47, RULE_OUT 8, INSPECT_ONLY_NO_EDIT 9
- decision coverage: **91.43%**
- ignored rate: **2.86%**
- invalid rule-out rate: **5.71%**
- zero-required count: **7** (all marker-backed=true)
- demoted pivot count: **20** (any demoted edited=true)
- required IMPACT target count: **0** (required_impact_any=false)
- optional impact inspected/edited: inspected 7, edited 3
- off-target edits (pooled): **17**
- comparison to M71 Stage A: coverage 91.43% (B) vs Stage A (see M71 report); comparison to M69: coverage 90.24%, ignored 2.44%, invalid rule-out 7.32%

## Cost / Operational Analysis
- total Stage B treatment cost: **$33.55**
- cumulative Stage A+B treatment cost: **$67.95**
- Stage B mean / median cost: **$0.68 / $0.49**
- pooled tokens (Stage B): **55,740,664**
- thrashing outlier (max cost): **sympy__sympy-15599** at $3.02
- quota aborts / operational retries: **0 / 0**
- repo cost concentration (top 5): django/django $20.88, sympy/sympy $10.67, matplotlib/matplotlib $1.33, sphinx-doc/sphinx $0.67
- projected Stage C fresh-baseline cost risk: 70 fresh baselines pending; at Stage B mean $0.68/run a comparable baseline arm is roughly $47.93 (baseline runs historically cost more than treatment — treat as a lower bound).

## Success Criteria Check
PASS only if all of:
- ✅ **C1** Stage B pre-flight has no partial sentinel — preflight partial_sentinel=0, run partial_sentinel_any=false
- ✅ **C2** treatment valid in >=95% of attempted Stage B runs — 48/49 = 98%
- ✅ **C3** no required IMPACT targets emitted — required_impact_any=false
- ✅ **C4** confidence gate enabled in all valid treatment runs — gate verified 48/48
- ✅ **C5** optional/FYI targets not closure-scored — optional_impact_ok=true
- ✅ **C6** decision coverage >=90% (or miss explained by zero-required/known-invalid) — coverage 91.43% (zero-required=7)
- ✅ **C7** invalid rule-out rate not >2pp above M69 — M72 5.71% vs M69 7.32% (Δ -1.61pp)
- ✅ **C8** no severe cost explosion (cumulative 100-treatment acceptable) — cumulative A+B $67.95 (Stage B mean $0.68/run)
- ✅ **C9** no systematic failure pattern making Stage C unsafe — 1 invalid; gate_all=true; required_impact=false; ids_collide=false

## Verdict
**PASS**

## Recommendation
**authorize Stage C fresh baselines**

---
_Interpretation guardrails: this is Stage B only — not the full 100-task benchmark, not Stage C, not a default promotion. No VEXP-parity or general SWE-bench-improvement claim is made. Paired pass-rate conclusions are limited to the reused-baseline subset; the rest is treatment-only pending Stage C fresh baselines._

