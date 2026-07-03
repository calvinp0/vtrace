# Stage 5 M100 Deterministic VTRACE Scoreboard (post file-evidence deep-pool rescue)

_Deterministic, offline: no live agents, no Docker, no API spend. Same generation
path as M94–M99; compared against the frozen M99 baseline (M94–M98 kept as
historical references)._

## Summary

- Scored: **99/100**
- ALL: recall@5 **0.730** (M99 0.726, M98 0.721, M97 0.721, M96 0.706, M95 0.652, M94 0.637), any-gold **75.8%** (M99 75.8%), all-gold **72.7%** (M99 71.7%), hidden-coedit **0.622** (M99 0.589), mean files **3.949** (M99 3.929)
- HOLDOUT: recall@1 **0.436** (M99 0.436), any-gold **61.5%** (M99 61.5%), hidden-coedit **0.000** (M99 0.000), med tok **1484** (M99 1484), p90 **6325** (M99 6325)
- MULTI-FILE: all-gold **46.7% → 53.3%**, hidden-coedit **0.589 → 0.622**
- All-gold flips vs M99: django__django-13195 gained [dev]
- Outcome flips vs M99: django__django-13195 partial→excellent [dev]
- Outcome distribution: excellent=27, miss=24, good=22, overpacked=14, wrong_pivot=11, partial=1
- Failure-reason distribution: lexical_mismatch=24, too_many_optional_targets=14, ranking_gap=11, hidden_coedit_missing=6, zero_required_but_gold_exists=2, unknown=1

## Cohort Metrics

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack | mean files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 99 | 0.503 | 0.646 | 0.730 | 0.740 | 0.609 | 75.8% | 72.7% | 75.8% | 51.5% | 0.622 | 1152 | 3536 | 4.000 | 3.95 |
| dev | 60 | 0.547 | 0.690 | 0.813 | 0.829 | 0.671 | 85.0% | 81.7% | 85.0% | 56.7% | 0.778 | 917 | 2843 | 3.000 | 3.97 |
| holdout | 39 | 0.436 | 0.577 | 0.603 | 0.603 | 0.514 | 61.5% | 59.0% | 61.5% | 43.6% | 0.000 | 1484 | 6325 | 4.000 | 3.92 |
| multi_file | 15 | 0.056 | 0.328 | 0.550 | 0.617 | 0.389 | 73.3% | 53.3% | 73.3% | 13.3% | 0.622 | 1194 | 2620 | 2.500 | 4.33 |
| single_file | 84 | 0.583 | 0.702 | 0.762 | 0.762 | 0.649 | 76.2% | 76.2% | 76.2% | 58.3% | — | 1139.5 | 3536 | 4.000 | 3.88 |
| hidden_coedit_subset | 15 | 0.056 | 0.328 | 0.550 | 0.617 | 0.389 | 73.3% | 53.3% | 73.3% | 13.3% | 0.622 | 1194 | 2620 | 2.500 | 4.33 |
| absent_pool_subset | 21 | 0.016 | 0.067 | 0.083 | 0.083 | 0.095 | 14.3% | 4.8% | 14.3% | 4.8% | 0.333 | 1178 | 7627 | 2.000 | 3.57 |
| source_absent_subset | 21 | 0.016 | 0.067 | 0.083 | 0.083 | 0.095 | 14.3% | 4.8% | 14.3% | 4.8% | 0.333 | 1178 | 7627 | 2.000 | 3.57 |
| m99_overpacked | 14 | 0.571 | 0.750 | 0.964 | 0.964 | 0.717 | 100.0% | 92.9% | 100.0% | 57.1% | 1.000 | 1476 | 5083 | 6.000 | 6.00 |

## M99 → M100 Deltas

### All scored (n=99)

| metric | M99 | M100 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.503 | 0.503 | 0.000 |
| recall@3 | 0.646 | 0.646 | 0.000 |
| recall@5 | 0.726 | 0.730 | 0.003 |
| recall@10 | 0.737 | 0.740 | 0.003 |
| MRR | 0.609 | 0.609 | 0.000 |
| any_gold_in_capsule | 75.8% | 75.8% | 0.0pts |
| all_gold_in_capsule | 71.7% | 72.7% | 1.0pts |
| lead_pivot_is_source_gold | 51.5% | 51.5% | 0.0pts |
| hidden_coedit_recall | 0.589 | 0.622 | 0.033 |
| median tokens | 1152 | 1152 | 0 |
| p90 tokens | 3536 | 3536 | 0 |
| mean capsule files | 3.929 | 3.949 | 0.020 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| mean required targets | 1.475 | 1.475 | 0.000 |
| mean optional targets | 2.455 | 2.475 | 0.020 |
| excellent | 26 | 27 | 1 |
| overpacked | 14 | 14 | 0 |

### Dev (n=60)

| metric | M99 | M100 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.547 | 0.547 | 0.000 |
| recall@3 | 0.690 | 0.690 | 0.000 |
| recall@5 | 0.807 | 0.813 | 0.006 |
| recall@10 | 0.824 | 0.829 | 0.006 |
| MRR | 0.671 | 0.671 | 0.000 |
| any_gold_in_capsule | 85.0% | 85.0% | 0.0pts |
| all_gold_in_capsule | 80.0% | 81.7% | 1.7pts |
| lead_pivot_is_source_gold | 56.7% | 56.7% | 0.0pts |
| hidden_coedit_recall | 0.736 | 0.778 | 0.042 |
| median tokens | 917 | 917 | 0 |
| p90 tokens | 2843 | 2843 | 0 |
| mean capsule files | 3.950 | 3.967 | 0.017 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| mean required targets | 1.500 | 1.500 | 0.000 |
| mean optional targets | 2.450 | 2.467 | 0.017 |
| excellent | 17 | 18 | 1 |
| overpacked | 11 | 11 | 0 |

### Holdout (n=39)

| metric | M99 | M100 | Δ |
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
| median tokens | 1484 | 1484 | 0 |
| p90 tokens | 6325 | 6325 | 0 |
| mean capsule files | 3.897 | 3.923 | 0.026 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| mean required targets | 1.436 | 1.436 | 0.000 |
| mean optional targets | 2.462 | 2.487 | 0.026 |
| excellent | 9 | 9 | 0 |
| overpacked | 3 | 3 | 0 |

### Multi-file only (n=15)

| metric | M99 | M100 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.056 | 0.056 | 0.000 |
| recall@3 | 0.328 | 0.328 | 0.000 |
| recall@5 | 0.528 | 0.550 | 0.022 |
| recall@10 | 0.594 | 0.617 | 0.022 |
| MRR | 0.389 | 0.389 | 0.000 |
| any_gold_in_capsule | 73.3% | 73.3% | 0.0pts |
| all_gold_in_capsule | 46.7% | 53.3% | 6.7pts |
| lead_pivot_is_source_gold | 13.3% | 13.3% | 0.0pts |
| hidden_coedit_recall | 0.589 | 0.622 | 0.033 |
| median tokens | 1194 | 1194 | 0 |
| p90 tokens | 2620 | 2620 | 0 |
| mean capsule files | 4.267 | 4.333 | 0.067 |
| median capsule files | 4.000 | 5.000 | 1.000 |
| mean required targets | 1.600 | 1.600 | 0.000 |
| mean optional targets | 2.667 | 2.733 | 0.067 |
| excellent | 1 | 2 | 1 |
| overpacked | 1 | 1 | 0 |

### Multi-file dev (n=12)

| metric | M99 | M100 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.069 | 0.069 | 0.000 |
| recall@3 | 0.368 | 0.368 | 0.000 |
| recall@5 | 0.618 | 0.646 | 0.028 |
| recall@10 | 0.701 | 0.729 | 0.028 |
| MRR | 0.458 | 0.458 | 0.000 |
| any_gold_in_capsule | 83.3% | 83.3% | 0.0pts |
| all_gold_in_capsule | 58.3% | 66.7% | 8.3pts |
| lead_pivot_is_source_gold | 16.7% | 16.7% | 0.0pts |
| hidden_coedit_recall | 0.736 | 0.778 | 0.042 |
| median tokens | 926 | 926 | 0 |
| p90 tokens | 2211 | 2211 | 0 |
| mean capsule files | 4.333 | 4.417 | 0.083 |
| median capsule files | 5.000 | 5.000 | 0.000 |
| mean required targets | 1.583 | 1.583 | 0.000 |
| mean optional targets | 2.750 | 2.833 | 0.083 |
| excellent | 1 | 2 | 1 |
| overpacked | 1 | 1 | 0 |

### Multi-file holdout (n=3)

| metric | M99 | M100 | Δ |
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
| mean required targets | 1.667 | 1.667 | 0.000 |
| mean optional targets | 2.333 | 2.333 | 0.000 |
| excellent | 0 | 0 | 0 |
| overpacked | 0 | 0 | 0 |

### Single-file only (n=84)

| metric | M99 | M100 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.583 | 0.583 | 0.000 |
| recall@3 | 0.702 | 0.702 | 0.000 |
| recall@5 | 0.762 | 0.762 | 0.000 |
| recall@10 | 0.762 | 0.762 | 0.000 |
| MRR | 0.649 | 0.649 | 0.000 |
| any_gold_in_capsule | 76.2% | 76.2% | 0.0pts |
| all_gold_in_capsule | 76.2% | 76.2% | 0.0pts |
| lead_pivot_is_source_gold | 58.3% | 58.3% | 0.0pts |
| hidden_coedit_recall | — | — | — |
| median tokens | 1139.5 | 1139.5 | 0 |
| p90 tokens | 3536 | 3536 | 0 |
| mean capsule files | 3.869 | 3.881 | 0.012 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| mean required targets | 1.452 | 1.452 | 0.000 |
| mean optional targets | 2.417 | 2.429 | 0.012 |
| excellent | 25 | 25 | 0 |
| overpacked | 13 | 13 | 0 |

### Hidden-coedit subset (n=15)

| metric | M99 | M100 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.056 | 0.056 | 0.000 |
| recall@3 | 0.328 | 0.328 | 0.000 |
| recall@5 | 0.528 | 0.550 | 0.022 |
| recall@10 | 0.594 | 0.617 | 0.022 |
| MRR | 0.389 | 0.389 | 0.000 |
| any_gold_in_capsule | 73.3% | 73.3% | 0.0pts |
| all_gold_in_capsule | 46.7% | 53.3% | 6.7pts |
| lead_pivot_is_source_gold | 13.3% | 13.3% | 0.0pts |
| hidden_coedit_recall | 0.589 | 0.622 | 0.033 |
| median tokens | 1194 | 1194 | 0 |
| p90 tokens | 2620 | 2620 | 0 |
| mean capsule files | 4.267 | 4.333 | 0.067 |
| median capsule files | 4.000 | 5.000 | 1.000 |
| mean required targets | 1.600 | 1.600 | 0.000 |
| mean optional targets | 2.667 | 2.733 | 0.067 |
| excellent | 1 | 2 | 1 |
| overpacked | 1 | 1 | 0 |

### Absent-pool subset (M100 audit) (n=21)

| metric | M99 | M100 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.016 | 0.016 | 0.000 |
| recall@3 | 0.067 | 0.067 | 0.000 |
| recall@5 | 0.067 | 0.083 | 0.016 |
| recall@10 | 0.067 | 0.083 | 0.016 |
| MRR | 0.095 | 0.095 | 0.000 |
| any_gold_in_capsule | 14.3% | 14.3% | 0.0pts |
| all_gold_in_capsule | 0.0% | 4.8% | 4.8pts |
| lead_pivot_is_source_gold | 4.8% | 4.8% | 0.0pts |
| hidden_coedit_recall | 0.262 | 0.333 | 0.071 |
| median tokens | 1178 | 1178 | 0 |
| p90 tokens | 7627 | 7627 | 0 |
| mean capsule files | 3.524 | 3.571 | 0.048 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| mean required targets | 1.429 | 1.429 | 0.000 |
| mean optional targets | 2.095 | 2.143 | 0.048 |
| excellent | 0 | 1 | 1 |
| overpacked | 1 | 1 | 0 |

### Source-file absent subset (M100 audit) (n=21)

| metric | M99 | M100 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.016 | 0.016 | 0.000 |
| recall@3 | 0.067 | 0.067 | 0.000 |
| recall@5 | 0.067 | 0.083 | 0.016 |
| recall@10 | 0.067 | 0.083 | 0.016 |
| MRR | 0.095 | 0.095 | 0.000 |
| any_gold_in_capsule | 14.3% | 14.3% | 0.0pts |
| all_gold_in_capsule | 0.0% | 4.8% | 4.8pts |
| lead_pivot_is_source_gold | 4.8% | 4.8% | 0.0pts |
| hidden_coedit_recall | 0.262 | 0.333 | 0.071 |
| median tokens | 1178 | 1178 | 0 |
| p90 tokens | 7627 | 7627 | 0 |
| mean capsule files | 3.524 | 3.571 | 0.048 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| mean required targets | 1.429 | 1.429 | 0.000 |
| mean optional targets | 2.095 | 2.143 | 0.048 |
| excellent | 0 | 1 | 1 |
| overpacked | 1 | 1 | 0 |

### M99 overpacked cases (n=14)

| metric | M99 | M100 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.571 | 0.571 | 0.000 |
| recall@3 | 0.750 | 0.750 | 0.000 |
| recall@5 | 0.964 | 0.964 | 0.000 |
| recall@10 | 0.964 | 0.964 | 0.000 |
| MRR | 0.717 | 0.717 | 0.000 |
| any_gold_in_capsule | 100.0% | 100.0% | 0.0pts |
| all_gold_in_capsule | 92.9% | 92.9% | 0.0pts |
| lead_pivot_is_source_gold | 57.1% | 57.1% | 0.0pts |
| hidden_coedit_recall | 1.000 | 1.000 | 0.000 |
| median tokens | 1476 | 1476 | 0 |
| p90 tokens | 5083 | 5083 | 0 |
| mean capsule files | 6.000 | 6.000 | 0.000 |
| median capsule files | 6.000 | 6.000 | 0.000 |
| mean required targets | 2.000 | 2.000 | 0.000 |
| mean optional targets | 4.000 | 4.000 | 0.000 |
| excellent | 0 | 0 | 0 |
| overpacked | 14 | 14 | 0 |


## File-Evidence Rescue Lane

- **all**: fired on 2/99; cap-skipped 27; considered 666; added 2 (gold 1, non-gold 1); rendered 2 (gold 1); pruned 0; ambiguous-rejected 61; generic-rejected 2; size-rejected 3; budget-limited 0; cases w/ gold hit 1; shapes: snake_identifier=1, camel_identifier=1
- **dev**: fired on 1/60; cap-skipped 19; considered 347; added 1 (gold 1, non-gold 0); rendered 1 (gold 1); pruned 0; ambiguous-rejected 32; generic-rejected 1; size-rejected 0; budget-limited 0; cases w/ gold hit 1; shapes: snake_identifier=1
- **holdout**: fired on 1/39; cap-skipped 8; considered 319; added 1 (gold 0, non-gold 1); rendered 1 (gold 0); pruned 0; ambiguous-rejected 29; generic-rejected 1; size-rejected 3; budget-limited 0; cases w/ gold hit 0; shapes: camel_identifier=1

## By Repo

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack | mean files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django/django | 44 | 0.576 | 0.725 | 0.801 | 0.801 | 0.683 | 84.1% | 77.3% | 84.1% | 59.1% | 0.556 | 1008 | 2989 | 3.000 | 3.73 |
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
| single_file | 84 | 0.583 | 0.702 | 0.762 | 0.762 | 0.649 | 76.2% | 76.2% | 76.2% | 58.3% | — | 1139.5 | 3536 | 4.000 | 3.88 |
| multi_file | 15 | 0.056 | 0.328 | 0.550 | 0.617 | 0.389 | 73.3% | 53.3% | 73.3% | 13.3% | 0.622 | 1194 | 2620 | 2.500 | 4.33 |
| source_only | 99 | 0.503 | 0.646 | 0.730 | 0.740 | 0.609 | 75.8% | 72.7% | 75.8% | 51.5% | 0.622 | 1152 | 3536 | 4.000 | 3.95 |
