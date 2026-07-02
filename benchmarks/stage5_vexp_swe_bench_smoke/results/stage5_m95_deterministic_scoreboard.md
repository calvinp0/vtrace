# Stage 5 M95 Deterministic VTRACE Scoreboard (post-change)

_Deterministic, offline: no live agents, no Docker, no API spend. Same generation
path as M94; compared against the frozen M94 baseline._

## Summary

- Scored: **99/100**
- ALL: recall@5 **0.652** (M94 0.637), any-gold-in-capsule **70.7%** (M94 69.7%), recall@1 **0.463** (M94 0.443), lead=src-gold **47.5%** (M94 45.5%)
- HOLDOUT: recall@5 **0.603**, any-gold **61.5%**, recall@1 **0.436**, lead=src-gold **43.6%**, med tok **1484**, p90 **6329**
- Outcome distribution: excellent=31, miss=29, good=18, wrong_pivot=9, overpacked=7, partial=5
- Failure-reason distribution: lexical_mismatch=29, hidden_coedit_missing=12, ranking_gap=9, too_many_optional_targets=7, zero_required_but_gold_exists=3, unknown=1

## Cohort Metrics

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 99 | 0.463 | 0.622 | 0.652 | 0.662 | 0.571 | 70.7% | 62.6% | 70.7% | 47.5% | 0.222 | 1127 | 4447 | 3.000 |
| dev | 60 | 0.481 | 0.651 | 0.685 | 0.701 | 0.611 | 76.7% | 65.0% | 76.7% | 50.0% | 0.278 | 896 | 3048 | 3.000 |
| holdout | 39 | 0.436 | 0.577 | 0.603 | 0.603 | 0.509 | 61.5% | 59.0% | 61.5% | 43.6% | 0.000 | 1484 | 6329 | 3.000 |

## By Repo

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django/django | 44 | 0.553 | 0.695 | 0.718 | 0.718 | 0.652 | 77.3% | 68.2% | 77.3% | 56.8% | 0.389 | 1009.5 | 2989 | 3.000 |
| sympy/sympy | 17 | 0.353 | 0.588 | 0.588 | 0.588 | 0.461 | 58.8% | 58.8% | 58.8% | 35.3% | 0.000 | 2637 | 6657 | 4.000 |
| matplotlib/matplotlib | 7 | 0.286 | 0.429 | 0.429 | 0.429 | 0.357 | 42.9% | 42.9% | 42.9% | 28.6% | 0.000 | 755 | 1194 | 4.000 |
| sphinx-doc/sphinx | 7 | 0.429 | 0.500 | 0.500 | 0.500 | 0.500 | 57.1% | 42.9% | 57.1% | 42.9% | 0.000 | 859 | 7627 | 3.500 |
| pydata/xarray | 6 | 0.333 | 0.750 | 0.917 | 0.917 | 0.597 | 100.0% | 83.3% | 100.0% | 33.3% | 0.500 | 1057 | 3188 | 3.000 |
| astropy/astropy | 5 | 0.400 | 0.500 | 0.700 | 0.900 | 0.583 | 100.0% | 80.0% | 100.0% | 40.0% | 0.000 | 1107 | 4447 | 3.000 |
| pytest-dev/pytest | 4 | 0.750 | 0.750 | 0.750 | 0.750 | 0.750 | 75.0% | 75.0% | 75.0% | 75.0% | — | 598.5 | 1172 | 3.000 |
| psf/requests | 3 | 0.333 | 0.333 | 0.333 | 0.333 | 0.333 | 33.3% | 33.3% | 33.3% | 33.3% | — | 399 | 557 | 3.000 |
| pylint-dev/pylint | 2 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.0% | 0.0% | 0.0% | 0.0% | 0.000 | 156.5 | 313 | — |
| scikit-learn/scikit-learn | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | — | 3398 | 5377 | 4.500 |
| mwaskom/seaborn | 1 | 0.500 | 0.500 | 0.500 | 0.500 | 1.000 | 100.0% | 0.0% | 100.0% | 100.0% | 0.000 | 1506 | 1506 | 6.000 |
| pallets/flask | 1 | 0.000 | 1.000 | 1.000 | 1.000 | 0.500 | 100.0% | 100.0% | 100.0% | 0.0% | — | 5594 | 5594 | 5.000 |

## By Patch Shape

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single_file | 84 | 0.536 | 0.667 | 0.702 | 0.714 | 0.604 | 71.4% | 71.4% | 71.4% | 53.6% | — | 1117 | 3574 | 3.000 |
| multi_file | 15 | 0.056 | 0.372 | 0.372 | 0.372 | 0.389 | 66.7% | 13.3% | 66.7% | 13.3% | 0.222 | 1152 | 4447 | 2.750 |
| source_only | 99 | 0.463 | 0.622 | 0.652 | 0.662 | 0.571 | 70.7% | 62.6% | 70.7% | 47.5% | 0.222 | 1127 | 4447 | 3.000 |

## M94 → M95 (all scored)

| metric | M94 | M95 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.443 | 0.463 | 0.020 |
| recall@5 | 0.637 | 0.652 | 0.015 |
| recall@10 | 0.647 | 0.662 | 0.015 |
| MRR | 0.553 | 0.571 | 0.018 |
| any_gold_in_capsule | 69.7% | 70.7% | 1.0pts |
| all_gold_in_capsule | 60.6% | 62.6% | 2.0pts |
| lead_pivot_is_source_gold | 45.5% | 47.5% | 2.0pts |
| hidden_coedit_recall | 0.222 | 0.222 | — |
| median_capsule_est_tokens | 1077 | 1127 | 50 |
| p90_capsule_est_tokens | 4447 | 4447 | 0 |

_M94 has no per-instance dev/holdout aggregate in its JSON; the dev/holdout Δ is
computed in the improvement report (stage5_m95_retrieval_improvement.md) from the
M94 detail rows restricted to the same split._
