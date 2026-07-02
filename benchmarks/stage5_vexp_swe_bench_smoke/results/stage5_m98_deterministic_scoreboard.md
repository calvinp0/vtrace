# Stage 5 M98 Deterministic VTRACE Scoreboard (post co-edit confidence tiers)

_Deterministic, offline: no live agents, no Docker, no API spend. Same generation
path as M94–M97; compared against the frozen M97 baseline (M94–M96 kept as
historical references)._

## Summary

- Scored: **99/100**
- ALL: recall@5 **0.721** (M97 0.721, M96 0.706, M95 0.652, M94 0.637), any-gold **75.8%** (M97 75.8%), all-gold **70.7%** (M97 70.7%), hidden-coedit **0.589** (M97 0.589), mean files **3.919** (M97 4.323)
- HOLDOUT: recall@1 **0.436** (M97 0.436), any-gold **61.5%** (M97 61.5%), hidden-coedit **0.000** (M97 0.000), med tok **1484** (M97 1513), p90 **6325** (M97 6325)
- MULTI-FILE: all-gold **40.0% → 40.0%**, hidden-coedit **0.589 → 0.589**
- M97-recovered cases lost: **none**
- Outcome flips vs M97: astropy__astropy-14539 good→excellent [dev], django__django-10973 good→excellent [dev], django__django-13363 good→excellent [holdout], django__django-15503 overpacked→wrong_pivot [holdout], django__django-15695 good→excellent [holdout], pallets__flask-5014 overpacked→good [dev], pytest-dev__pytest-10051 good→excellent [dev], pytest-dev__pytest-7432 good→excellent [dev], scikit-learn__scikit-learn-11578 good→excellent [dev], sphinx-doc__sphinx-7748 good→excellent [holdout], sympy__sympy-23413 overpacked→good [holdout], sympy__sympy-24213 overpacked→good [holdout]
- Outcome distribution: excellent=26, miss=24, good=22, overpacked=14, wrong_pivot=11, partial=2
- Failure-reason distribution: lexical_mismatch=24, too_many_optional_targets=14, ranking_gap=11, hidden_coedit_missing=7, zero_required_but_gold_exists=2, unknown=1

## Cohort Metrics

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack | mean files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 99 | 0.503 | 0.646 | 0.721 | 0.731 | 0.609 | 75.8% | 70.7% | 75.8% | 51.5% | 0.589 | 1152 | 3536 | 4.000 | 3.92 |
| dev | 60 | 0.547 | 0.690 | 0.799 | 0.815 | 0.671 | 85.0% | 78.3% | 85.0% | 56.7% | 0.736 | 917 | 2843 | 3.000 | 3.93 |
| holdout | 39 | 0.436 | 0.577 | 0.603 | 0.603 | 0.514 | 61.5% | 59.0% | 61.5% | 43.6% | 0.000 | 1484 | 6325 | 4.000 | 3.90 |
| multi_file | 15 | 0.056 | 0.328 | 0.494 | 0.561 | 0.389 | 73.3% | 40.0% | 73.3% | 13.3% | 0.589 | 1194 | 2620 | 2.500 | 4.20 |
| single_file | 84 | 0.583 | 0.702 | 0.762 | 0.762 | 0.649 | 76.2% | 76.2% | 76.2% | 58.3% | — | 1139.5 | 3536 | 4.000 | 3.87 |
| hidden_coedit_subset | 15 | 0.056 | 0.328 | 0.494 | 0.561 | 0.389 | 73.3% | 40.0% | 73.3% | 13.3% | 0.589 | 1194 | 2620 | 2.500 | 4.20 |
| coedit_fired_m97 | 69 | 0.471 | 0.594 | 0.703 | 0.717 | 0.572 | 72.5% | 71.0% | 72.5% | 47.8% | 0.778 | 1216 | 5377 | 4.000 | 4.20 |
| m97_recovered | 5 | 0.100 | 0.400 | 0.800 | 1.000 | 0.550 | 100.0% | 100.0% | 100.0% | 20.0% | 1.000 | 1530 | 2250 | 2.500 | 5.20 |
| m97_overpacked | 18 | 0.500 | 0.750 | 0.972 | 0.972 | 0.680 | 100.0% | 94.4% | 100.0% | 50.0% | 1.000 | 1420 | 5615 | 6.000 | 5.67 |

## M97 → M98 Deltas

### All scored (n=99)

| metric | M97 | M98 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.503 | 0.503 | 0.000 |
| recall@3 | 0.646 | 0.646 | 0.000 |
| recall@5 | 0.721 | 0.721 | 0.000 |
| recall@10 | 0.731 | 0.731 | 0.000 |
| MRR | 0.610 | 0.609 | -0.001 |
| any_gold_in_capsule | 75.8% | 75.8% | 0.0pts |
| all_gold_in_capsule | 70.7% | 70.7% | 0.0pts |
| lead_pivot_is_source_gold | 51.5% | 51.5% | 0.0pts |
| hidden_coedit_recall | 0.589 | 0.589 | 0.000 |
| median tokens | 1152 | 1152 | 0 |
| p90 tokens | 3536 | 3536 | 0 |
| mean capsule files | 4.323 | 3.919 | -0.404 |
| median capsule files | 5.000 | 4.000 | -1.000 |
| excellent | 18 | 26 | 8 |
| overpacked | 18 | 14 | -4 |

### Dev (n=60)

| metric | M97 | M98 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.547 | 0.547 | 0.000 |
| recall@3 | 0.690 | 0.690 | 0.000 |
| recall@5 | 0.799 | 0.799 | 0.000 |
| recall@10 | 0.815 | 0.815 | 0.000 |
| MRR | 0.673 | 0.671 | -0.002 |
| any_gold_in_capsule | 85.0% | 85.0% | 0.0pts |
| all_gold_in_capsule | 78.3% | 78.3% | 0.0pts |
| lead_pivot_is_source_gold | 56.7% | 56.7% | 0.0pts |
| hidden_coedit_recall | 0.736 | 0.736 | 0.000 |
| median tokens | 890 | 917 | 27 |
| p90 tokens | 2843 | 2843 | 0 |
| mean capsule files | 4.300 | 3.933 | -0.367 |
| median capsule files | 5.000 | 4.000 | -1.000 |
| excellent | 12 | 17 | 5 |
| overpacked | 12 | 11 | -1 |

### Holdout (n=39)

| metric | M97 | M98 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.436 | 0.436 | 0.000 |
| recall@3 | 0.577 | 0.577 | 0.000 |
| recall@5 | 0.603 | 0.603 | 0.000 |
| recall@10 | 0.603 | 0.603 | 0.000 |
| MRR | 0.514 | 0.514 | 0.000 |
| any_gold_in_capsule | 61.5% | 61.5% | 0.0pts |
| all_gold_in_capsule | 59.0% | 59.0% | 0.0pts |
| lead_pivot_is_source_gold | 43.6% | 43.6% | 0.0pts |
| hidden_coedit_recall | 0.000 | 0.000 | 0.000 |
| median tokens | 1513 | 1484 | -29 |
| p90 tokens | 6325 | 6325 | 0 |
| mean capsule files | 4.359 | 3.897 | -0.462 |
| median capsule files | 5.000 | 4.000 | -1.000 |
| excellent | 6 | 9 | 3 |
| overpacked | 6 | 3 | -3 |

### Multi-file only (n=15)

| metric | M97 | M98 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.056 | 0.056 | 0.000 |
| recall@3 | 0.328 | 0.328 | 0.000 |
| recall@5 | 0.494 | 0.494 | 0.000 |
| recall@10 | 0.561 | 0.561 | 0.000 |
| MRR | 0.389 | 0.389 | 0.000 |
| any_gold_in_capsule | 73.3% | 73.3% | 0.0pts |
| all_gold_in_capsule | 40.0% | 40.0% | 0.0pts |
| lead_pivot_is_source_gold | 13.3% | 13.3% | 0.0pts |
| hidden_coedit_recall | 0.589 | 0.589 | 0.000 |
| median tokens | 1194 | 1194 | 0 |
| p90 tokens | 2620 | 2620 | 0 |
| mean capsule files | 4.267 | 4.200 | -0.067 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| excellent | 1 | 1 | 0 |
| overpacked | 1 | 1 | 0 |

### Multi-file dev (n=12)

| metric | M97 | M98 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.069 | 0.069 | 0.000 |
| recall@3 | 0.368 | 0.368 | 0.000 |
| recall@5 | 0.576 | 0.576 | 0.000 |
| recall@10 | 0.660 | 0.660 | 0.000 |
| MRR | 0.458 | 0.458 | 0.000 |
| any_gold_in_capsule | 83.3% | 83.3% | 0.0pts |
| all_gold_in_capsule | 50.0% | 50.0% | 0.0pts |
| lead_pivot_is_source_gold | 16.7% | 16.7% | 0.0pts |
| hidden_coedit_recall | 0.736 | 0.736 | 0.000 |
| median tokens | 926 | 926 | 0 |
| p90 tokens | 2183 | 2211 | 28 |
| mean capsule files | 4.333 | 4.250 | -0.083 |
| median capsule files | 5.000 | 4.500 | -0.500 |
| excellent | 1 | 1 | 0 |
| overpacked | 1 | 1 | 0 |

### Multi-file holdout (n=3)

| metric | M97 | M98 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.000 | 0.000 | 0.000 |
| recall@3 | 0.167 | 0.167 | 0.000 |
| recall@5 | 0.167 | 0.167 | 0.000 |
| recall@10 | 0.167 | 0.167 | 0.000 |
| MRR | 0.111 | 0.111 | 0.000 |
| any_gold_in_capsule | 33.3% | 33.3% | 0.0pts |
| all_gold_in_capsule | 0.0% | 0.0% | 0.0pts |
| lead_pivot_is_source_gold | 0.0% | 0.0% | 0.0pts |
| hidden_coedit_recall | 0.000 | 0.000 | 0.000 |
| median tokens | 2620 | 2620 | 0 |
| p90 tokens | 6325 | 6325 | 0 |
| mean capsule files | 4.000 | 4.000 | 0.000 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| excellent | 0 | 0 | 0 |
| overpacked | 0 | 0 | 0 |

### Single-file only (n=84)

| metric | M97 | M98 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.583 | 0.583 | 0.000 |
| recall@3 | 0.702 | 0.702 | 0.000 |
| recall@5 | 0.762 | 0.762 | 0.000 |
| recall@10 | 0.762 | 0.762 | 0.000 |
| MRR | 0.650 | 0.649 | -0.001 |
| any_gold_in_capsule | 76.2% | 76.2% | 0.0pts |
| all_gold_in_capsule | 76.2% | 76.2% | 0.0pts |
| lead_pivot_is_source_gold | 58.3% | 58.3% | 0.0pts |
| hidden_coedit_recall | — | — | — |
| median tokens | 1145 | 1139.5 | -5.5 |
| p90 tokens | 3536 | 3536 | 0 |
| mean capsule files | 4.333 | 3.869 | -0.464 |
| median capsule files | 5.000 | 4.000 | -1.000 |
| excellent | 17 | 25 | 8 |
| overpacked | 17 | 13 | -4 |

### Hidden-coedit subset (n=15)

| metric | M97 | M98 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.056 | 0.056 | 0.000 |
| recall@3 | 0.328 | 0.328 | 0.000 |
| recall@5 | 0.494 | 0.494 | 0.000 |
| recall@10 | 0.561 | 0.561 | 0.000 |
| MRR | 0.389 | 0.389 | 0.000 |
| any_gold_in_capsule | 73.3% | 73.3% | 0.0pts |
| all_gold_in_capsule | 40.0% | 40.0% | 0.0pts |
| lead_pivot_is_source_gold | 13.3% | 13.3% | 0.0pts |
| hidden_coedit_recall | 0.589 | 0.589 | 0.000 |
| median tokens | 1194 | 1194 | 0 |
| p90 tokens | 2620 | 2620 | 0 |
| mean capsule files | 4.267 | 4.200 | -0.067 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| excellent | 1 | 1 | 0 |
| overpacked | 1 | 1 | 0 |

### Co-edit-fired cases (M97 definition) (n=69)

| metric | M97 | M98 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.471 | 0.471 | 0.000 |
| recall@3 | 0.594 | 0.594 | 0.000 |
| recall@5 | 0.703 | 0.703 | 0.000 |
| recall@10 | 0.717 | 0.717 | 0.000 |
| MRR | 0.574 | 0.572 | -0.002 |
| any_gold_in_capsule | 72.5% | 72.5% | 0.0pts |
| all_gold_in_capsule | 71.0% | 71.0% | 0.0pts |
| lead_pivot_is_source_gold | 47.8% | 47.8% | 0.0pts |
| hidden_coedit_recall | 0.778 | 0.778 | 0.000 |
| median tokens | 1216 | 1216 | 0 |
| p90 tokens | 5282 | 5377 | 95 |
| mean capsule files | 4.783 | 4.203 | -0.580 |
| median capsule files | 5.000 | 4.000 | -1.000 |
| excellent | 7 | 15 | 8 |
| overpacked | 14 | 10 | -4 |

### M97-recovered hidden-gold cases (n=5)

| metric | M97 | M98 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.100 | 0.100 | 0.000 |
| recall@3 | 0.400 | 0.400 | 0.000 |
| recall@5 | 0.800 | 0.800 | 0.000 |
| recall@10 | 1.000 | 1.000 | 0.000 |
| MRR | 0.550 | 0.550 | 0.000 |
| any_gold_in_capsule | 100.0% | 100.0% | 0.0pts |
| all_gold_in_capsule | 100.0% | 100.0% | 0.0pts |
| lead_pivot_is_source_gold | 20.0% | 20.0% | 0.0pts |
| hidden_coedit_recall | 1.000 | 1.000 | 0.000 |
| median tokens | 1530 | 1530 | 0 |
| p90 tokens | 2250 | 2250 | 0 |
| mean capsule files | 5.200 | 5.200 | 0.000 |
| median capsule files | 5.000 | 5.000 | 0.000 |
| excellent | 1 | 1 | 0 |
| overpacked | 0 | 0 | 0 |

### M97 overpacked cases (n=18)

| metric | M97 | M98 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.500 | 0.500 | 0.000 |
| recall@3 | 0.750 | 0.750 | 0.000 |
| recall@5 | 0.972 | 0.972 | 0.000 |
| recall@10 | 0.972 | 0.972 | 0.000 |
| MRR | 0.680 | 0.680 | 0.000 |
| any_gold_in_capsule | 100.0% | 100.0% | 0.0pts |
| all_gold_in_capsule | 94.4% | 94.4% | 0.0pts |
| lead_pivot_is_source_gold | 50.0% | 50.0% | 0.0pts |
| hidden_coedit_recall | 1.000 | 1.000 | 0.000 |
| median tokens | 1476 | 1420 | -56 |
| p90 tokens | 5628 | 5615 | -13 |
| mean capsule files | 6.000 | 5.667 | -0.333 |
| median capsule files | 6.000 | 6.000 | 0.000 |
| excellent | 0 | 0 | 0 |
| overpacked | 18 | 14 | -4 |


## Co-edit Lane (confidence-tiered)

- **all**: fired on 69/99 (69.7%); gold hit on 6 (8.7% of fired); kept 61 (rescued 35, injected 26; gold 6, non-gold 55); pruned 46 (gold 0); spare-deferred 15; displaced 37; tiers: medium=15, high=46, low=46; prune reasons: single relation type rescue=23, no call edge behind injection=10, package facade (__init__) injection=13; rejected ambiguous 883, hub 209, budget 0; types: pool_rescue_calls_references=26, generated_artifact_pair=1, edge_calls_references=13, edge_calls_imports_references=1, pool_rescue_calls_imports=1, edge_calls=9
- **dev**: fired on 41/60 (68.3%); gold hit on 5 (12.2% of fired); kept 38 (rescued 18, injected 20; gold 5, non-gold 33); pruned 24 (gold 0); spare-deferred 10; displaced 26; tiers: medium=10, high=28, low=24; prune reasons: single relation type rescue=15, no call edge behind injection=6, package facade (__init__) injection=3; rejected ambiguous 335, hub 59, budget 0; types: pool_rescue_calls_references=14, generated_artifact_pair=1, edge_calls_references=10, pool_rescue_calls_imports=1, edge_calls=7
- **holdout**: fired on 28/39 (71.8%); gold hit on 1 (3.6% of fired); kept 23 (rescued 17, injected 6; gold 1, non-gold 22); pruned 22 (gold 0); spare-deferred 5; displaced 11; tiers: medium=5, low=22, high=18; prune reasons: package facade (__init__) injection=10, no call edge behind injection=4, single relation type rescue=8; rejected ambiguous 548, hub 150, budget 0; types: pool_rescue_calls_references=12, edge_calls_imports_references=1, edge_calls_references=3, edge_calls=2

## Support Composition (all scored)

- mean support items 3.869, mean support files 3.020
- duplicate-file support items 141, generic-infra 0, docs/examples 10

## By Repo

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack | mean files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django/django | 44 | 0.576 | 0.725 | 0.782 | 0.782 | 0.683 | 84.1% | 72.7% | 84.1% | 59.1% | 0.472 | 1008 | 2989 | 4.000 | 3.66 |
| sympy/sympy | 17 | 0.412 | 0.647 | 0.647 | 0.647 | 0.529 | 64.7% | 64.7% | 64.7% | 41.2% | 0.000 | 2620 | 6654 | 4.000 | 4.53 |
| matplotlib/matplotlib | 7 | 0.429 | 0.429 | 0.500 | 0.571 | 0.464 | 57.1% | 57.1% | 57.1% | 42.9% | 1.000 | 851 | 1178 | 4.500 | 4.14 |
| sphinx-doc/sphinx | 7 | 0.286 | 0.357 | 0.429 | 0.429 | 0.357 | 42.9% | 42.9% | 42.9% | 28.6% | 1.000 | 701 | 7627 | 2.500 | 3.86 |
| pydata/xarray | 6 | 0.333 | 0.750 | 1.000 | 1.000 | 0.597 | 100.0% | 100.0% | 100.0% | 33.3% | 1.000 | 1078 | 3188 | 3.500 | 4.50 |
| astropy/astropy | 5 | 0.400 | 0.500 | 1.000 | 1.000 | 0.590 | 100.0% | 100.0% | 100.0% | 40.0% | 1.000 | 2133 | 2731 | 3.000 | 3.80 |
| pytest-dev/pytest | 4 | 0.750 | 0.750 | 0.750 | 0.750 | 0.750 | 75.0% | 75.0% | 75.0% | 75.0% | — | 612 | 1216 | 3.000 | 3.25 |
| psf/requests | 3 | 0.667 | 0.667 | 0.667 | 0.667 | 0.667 | 66.7% | 66.7% | 66.7% | 66.7% | — | 399 | 631 | 3.000 | 3.67 |
| pylint-dev/pylint | 2 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.0% | 0.0% | 0.0% | 0.0% | 0.000 | 156.5 | 313 | — | 2.00 |
| scikit-learn/scikit-learn | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | — | 3408 | 5377 | 4.500 | 4.50 |
| mwaskom/seaborn | 1 | 0.500 | 0.500 | 0.500 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | 1.000 | 1530 | 1530 | 3.000 | 6.00 |
| pallets/flask | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | — | 5615 | 5615 | 5.000 | 5.00 |

## By Patch Shape

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack | mean files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single_file | 84 | 0.583 | 0.702 | 0.762 | 0.762 | 0.649 | 76.2% | 76.2% | 76.2% | 58.3% | — | 1139.5 | 3536 | 4.000 | 3.87 |
| multi_file | 15 | 0.056 | 0.328 | 0.494 | 0.561 | 0.389 | 73.3% | 40.0% | 73.3% | 13.3% | 0.589 | 1194 | 2620 | 2.500 | 4.20 |
| source_only | 99 | 0.503 | 0.646 | 0.721 | 0.731 | 0.609 | 75.8% | 70.7% | 75.8% | 51.5% | 0.589 | 1152 | 3536 | 4.000 | 3.92 |
