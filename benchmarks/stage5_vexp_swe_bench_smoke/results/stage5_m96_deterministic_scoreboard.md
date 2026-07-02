# Stage 5 M96 Deterministic VTRACE Scoreboard (post direct-evidence lane)

_Deterministic, offline: no live agents, no Docker, no API spend. Same generation
path as M94/M95; compared against the frozen M94 and M95 baselines._

## Summary

- Scored: **99/100**
- ALL: recall@5 **0.706** (M95 0.652, M94 0.637), any-gold **75.8%** (M95 70.7%), recall@1 **0.503** (M95 0.463), lead=src-gold **51.5%** (M95 47.5%)
- HOLDOUT: recall@10 **0.603** (M95 0.603), any-gold **61.5%** (M95 61.5%), recall@1 **0.436** (M95 0.436), med tok **1484** (M95 1484), p90 **6329** (M95 6329)
- ABSENT-GOLD SUBSET (holdout): any-gold **8.3%** (M95 0.0%)
- Outcome distribution: excellent=32, miss=24, good=16, wrong_pivot=12, overpacked=11, partial=4
- Failure-reason distribution: lexical_mismatch=24, hidden_coedit_missing=12, ranking_gap=12, too_many_optional_targets=11, zero_required_but_gold_exists=2, unknown=1

## Cohort Metrics

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 99 | 0.503 | 0.646 | 0.706 | 0.706 | 0.609 | 75.8% | 65.7% | 75.8% | 51.5% | 0.256 | 1152 | 3536 | 3.000 |
| dev | 60 | 0.547 | 0.690 | 0.774 | 0.774 | 0.671 | 85.0% | 70.0% | 85.0% | 56.7% | 0.319 | 920 | 2843 | 3.000 |
| holdout | 39 | 0.436 | 0.577 | 0.603 | 0.603 | 0.514 | 61.5% | 59.0% | 61.5% | 43.6% | 0.000 | 1484 | 6329 | 3.500 |
| absent_gold_m95 | 23 | 0.087 | 0.130 | 0.152 | 0.152 | 0.112 | 17.4% | 13.0% | 17.4% | 8.7% | 0.000 | 787 | 7627 | 4.000 |
| absent_gold_m95_dev | 11 | 0.091 | 0.182 | 0.227 | 0.227 | 0.144 | 27.3% | 18.2% | 27.3% | 9.1% | 0.000 | 649 | 1573 | 5.000 |
| absent_gold_m95_holdout | 12 | 0.083 | 0.083 | 0.083 | 0.083 | 0.083 | 8.3% | 8.3% | 8.3% | 8.3% | 0.000 | 2337 | 7627 | 3.000 |

## M95 → M96 Deltas

### All scored (n=99)

| metric | M95 | M96 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.463 | 0.503 | 0.040 |
| recall@3 | 0.622 | 0.646 | 0.024 |
| recall@5 | 0.652 | 0.706 | 0.054 |
| recall@10 | 0.662 | 0.706 | 0.044 |
| MRR | 0.571 | 0.609 | 0.038 |
| any_gold_in_capsule | 70.7% | 75.8% | 5.1pts |
| all_gold_in_capsule | 62.6% | 65.7% | 3.0pts |
| lead_pivot_is_source_gold | 47.5% | 51.5% | 4.0pts |
| median tokens | 1127 | 1152 | 25 |
| p90 tokens | 4447 | 3536 | -911 |
| overpacked | 7 | 11 | 4 |

### Dev (n=60)

| metric | M95 | M96 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.481 | 0.547 | 0.067 |
| recall@3 | 0.651 | 0.690 | 0.039 |
| recall@5 | 0.685 | 0.774 | 0.089 |
| recall@10 | 0.701 | 0.774 | 0.072 |
| MRR | 0.611 | 0.671 | 0.060 |
| any_gold_in_capsule | 76.7% | 85.0% | 8.3pts |
| all_gold_in_capsule | 65.0% | 70.0% | 5.0pts |
| lead_pivot_is_source_gold | 50.0% | 56.7% | 6.7pts |
| median tokens | 896 | 920 | 24 |
| p90 tokens | 3048 | 2843 | -205 |
| overpacked | 6 | 9 | 3 |

### Holdout (n=39)

| metric | M95 | M96 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.436 | 0.436 | 0.000 |
| recall@3 | 0.577 | 0.577 | 0.000 |
| recall@5 | 0.603 | 0.603 | 0.000 |
| recall@10 | 0.603 | 0.603 | 0.000 |
| MRR | 0.509 | 0.514 | 0.004 |
| any_gold_in_capsule | 61.5% | 61.5% | 0.0pts |
| all_gold_in_capsule | 59.0% | 59.0% | 0.0pts |
| lead_pivot_is_source_gold | 43.6% | 43.6% | 0.0pts |
| median tokens | 1484 | 1484 | 0 |
| p90 tokens | 6329 | 6329 | 0 |
| overpacked | 1 | 2 | 1 |

### Absent-gold subset (all) (n=23)

| metric | M95 | M96 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.000 | 0.087 | 0.087 |
| recall@3 | 0.000 | 0.130 | 0.130 |
| recall@5 | 0.000 | 0.152 | 0.152 |
| recall@10 | 0.000 | 0.152 | 0.152 |
| MRR | 0.000 | 0.112 | 0.112 |
| any_gold_in_capsule | 0.0% | 17.4% | 17.4pts |
| all_gold_in_capsule | 0.0% | 13.0% | 13.0pts |
| lead_pivot_is_source_gold | 0.0% | 8.7% | 8.7pts |
| median tokens | 724 | 787 | 63 |
| p90 tokens | 7627 | 7627 | 0 |
| overpacked | 0 | 0 | 0 |

### Absent-gold subset (dev) (n=11)

| metric | M95 | M96 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.000 | 0.091 | 0.091 |
| recall@3 | 0.000 | 0.182 | 0.182 |
| recall@5 | 0.000 | 0.227 | 0.227 |
| recall@10 | 0.000 | 0.227 | 0.227 |
| MRR | 0.000 | 0.144 | 0.144 |
| any_gold_in_capsule | 0.0% | 27.3% | 27.3pts |
| all_gold_in_capsule | 0.0% | 18.2% | 18.2pts |
| lead_pivot_is_source_gold | 0.0% | 9.1% | 9.1pts |
| median tokens | 649 | 649 | 0 |
| p90 tokens | 1573 | 1573 | 0 |
| overpacked | 0 | 0 | 0 |

### Absent-gold subset (holdout) (n=12)

| metric | M95 | M96 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.000 | 0.083 | 0.083 |
| recall@3 | 0.000 | 0.083 | 0.083 |
| recall@5 | 0.000 | 0.083 | 0.083 |
| recall@10 | 0.000 | 0.083 | 0.083 |
| MRR | 0.000 | 0.083 | 0.083 |
| any_gold_in_capsule | 0.0% | 8.3% | 8.3pts |
| all_gold_in_capsule | 0.0% | 8.3% | 8.3pts |
| lead_pivot_is_source_gold | 0.0% | 8.3% | 8.3pts |
| median tokens | 2337 | 2337 | 0 |
| p90 tokens | 7627 | 7627 | 0 |
| overpacked | 0 | 0 | 0 |


## Direct-Evidence Lane

- **all**: search used on 60 cases (99 had mentions); gold hit on 31 (51.7% of used); candidates added 72, boosted 46, non-gold matches 86; rejected ambiguous 13, generic 295; types: class_word=10, dotted_module_path=5, file_stem_word=52, explicit_file=1, mixed_case_identifier=1
- **dev**: search used on 39 cases (60 had mentions); gold hit on 23 (59.0% of used); candidates added 43, boosted 28, non-gold matches 47; rejected ambiguous 8, generic 197; types: class_word=7, dotted_module_path=5, file_stem_word=32
- **holdout**: search used on 21 cases (39 had mentions); gold hit on 8 (38.1% of used); candidates added 29, boosted 18, non-gold matches 39; rejected ambiguous 5, generic 98; types: file_stem_word=20, class_word=3, explicit_file=1, mixed_case_identifier=1

## By Repo

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django/django | 44 | 0.576 | 0.725 | 0.782 | 0.782 | 0.683 | 84.1% | 72.7% | 84.1% | 59.1% | 0.472 | 1007 | 2982 | 3.000 |
| sympy/sympy | 17 | 0.412 | 0.647 | 0.647 | 0.647 | 0.529 | 64.7% | 64.7% | 64.7% | 41.2% | 0.000 | 2637 | 6654 | 4.000 |
| matplotlib/matplotlib | 7 | 0.429 | 0.429 | 0.500 | 0.500 | 0.464 | 57.1% | 42.9% | 57.1% | 42.9% | 0.000 | 853 | 1187 | 4.500 |
| sphinx-doc/sphinx | 7 | 0.286 | 0.357 | 0.357 | 0.357 | 0.357 | 42.9% | 28.6% | 42.9% | 28.6% | 0.000 | 701 | 7627 | 4.000 |
| pydata/xarray | 6 | 0.333 | 0.750 | 0.917 | 0.917 | 0.597 | 100.0% | 83.3% | 100.0% | 33.3% | 0.500 | 1057 | 3202 | 3.000 |
| astropy/astropy | 5 | 0.400 | 0.500 | 0.900 | 0.900 | 0.590 | 100.0% | 80.0% | 100.0% | 40.0% | 0.000 | 2133 | 2723 | 3.000 |
| pytest-dev/pytest | 4 | 0.750 | 0.750 | 0.750 | 0.750 | 0.750 | 75.0% | 75.0% | 75.0% | 75.0% | — | 606.5 | 1205 | 3.000 |
| psf/requests | 3 | 0.667 | 0.667 | 0.667 | 0.667 | 0.667 | 66.7% | 66.7% | 66.7% | 66.7% | — | 399 | 557 | 2.000 |
| pylint-dev/pylint | 2 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.0% | 0.0% | 0.0% | 0.0% | 0.000 | 156.5 | 313 | — |
| scikit-learn/scikit-learn | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | — | 3408 | 5377 | 4.500 |
| mwaskom/seaborn | 1 | 0.500 | 0.500 | 0.500 | 0.500 | 1.000 | 100.0% | 0.0% | 100.0% | 100.0% | 0.000 | 1506 | 1506 | 6.000 |
| pallets/flask | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | — | 5615 | 5615 | 5.000 |

## By Patch Shape

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single_file | 84 | 0.583 | 0.702 | 0.762 | 0.762 | 0.649 | 76.2% | 76.2% | 76.2% | 58.3% | — | 1139.5 | 3536 | 3.000 |
| multi_file | 15 | 0.056 | 0.328 | 0.394 | 0.394 | 0.389 | 73.3% | 6.7% | 73.3% | 13.3% | 0.256 | 1152 | 2637 | 4.000 |
| source_only | 99 | 0.503 | 0.646 | 0.706 | 0.706 | 0.609 | 75.8% | 65.7% | 75.8% | 51.5% | 0.256 | 1152 | 3536 | 3.000 |
