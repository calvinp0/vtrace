# Stage 5 M99 Deterministic VTRACE Scoreboard (post import-relation co-edit evidence)

_Deterministic, offline: no live agents, no Docker, no API spend. Same generation
path as M94–M98; compared against the frozen M98 baseline (M94–M97 kept as
historical references)._

## Summary

- Scored: **99/100**
- ALL: recall@5 **0.726** (M98 0.721, M97 0.721, M96 0.706, M95 0.652, M94 0.637), any-gold **75.8%** (M98 75.8%), all-gold **71.7%** (M98 70.7%), hidden-coedit **0.589** (M98 0.589), mean files **3.929** (M98 3.919)
- HOLDOUT: recall@1 **0.436** (M98 0.436), any-gold **61.5%** (M98 61.5%), hidden-coedit **0.000** (M98 0.000), med tok **1484** (M98 1484), p90 **6325** (M98 6325)
- MULTI-FILE: all-gold **40.0% → 46.7%**, hidden-coedit **0.589 → 0.589**
- All-gold flips vs M98: django__django-16256 gained [dev]
- Outcome flips vs M98: none
- Outcome distribution: excellent=26, miss=24, good=22, overpacked=14, wrong_pivot=11, partial=2
- Failure-reason distribution: lexical_mismatch=24, too_many_optional_targets=14, ranking_gap=11, hidden_coedit_missing=7, zero_required_but_gold_exists=2, unknown=1

## Cohort Metrics

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack | mean files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 99 | 0.503 | 0.646 | 0.726 | 0.737 | 0.609 | 75.8% | 71.7% | 75.8% | 51.5% | 0.589 | 1152 | 3536 | 4.000 | 3.93 |
| dev | 60 | 0.547 | 0.690 | 0.807 | 0.824 | 0.671 | 85.0% | 80.0% | 85.0% | 56.7% | 0.736 | 917 | 2843 | 3.000 | 3.95 |
| holdout | 39 | 0.436 | 0.577 | 0.603 | 0.603 | 0.514 | 61.5% | 59.0% | 61.5% | 43.6% | 0.000 | 1484 | 6325 | 4.000 | 3.90 |
| multi_file | 15 | 0.056 | 0.328 | 0.528 | 0.594 | 0.389 | 73.3% | 46.7% | 73.3% | 13.3% | 0.589 | 1194 | 2620 | 2.500 | 4.27 |
| single_file | 84 | 0.583 | 0.702 | 0.762 | 0.762 | 0.649 | 76.2% | 76.2% | 76.2% | 58.3% | — | 1139.5 | 3536 | 4.000 | 3.87 |
| hidden_coedit_subset | 15 | 0.056 | 0.328 | 0.528 | 0.594 | 0.389 | 73.3% | 46.7% | 73.3% | 13.3% | 0.589 | 1194 | 2620 | 2.500 | 4.27 |
| coedit_fired_m98 | 69 | 0.471 | 0.594 | 0.710 | 0.725 | 0.572 | 72.5% | 72.5% | 72.5% | 47.8% | 0.778 | 1216 | 5377 | 4.000 | 4.22 |
| import_only_suspected | 16 | 0.000 | 0.047 | 0.109 | 0.109 | 0.078 | 18.8% | 6.3% | 18.8% | 0.0% | 0.583 | 989 | 3432 | 2.500 | 4.44 |
| anchorless | 13 | 0.026 | 0.090 | 0.090 | 0.090 | 0.103 | 15.4% | 0.0% | 15.4% | 7.7% | 0.100 | 701 | 7810 | 3.000 | 2.92 |
| m98_overpacked | 14 | 0.571 | 0.750 | 0.964 | 0.964 | 0.717 | 100.0% | 92.9% | 100.0% | 57.1% | 1.000 | 1476 | 5083 | 6.000 | 6.00 |

## M98 → M99 Deltas

### All scored (n=99)

| metric | M98 | M99 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.503 | 0.503 | 0.000 |
| recall@3 | 0.646 | 0.646 | 0.000 |
| recall@5 | 0.721 | 0.726 | 0.005 |
| recall@10 | 0.731 | 0.737 | 0.005 |
| MRR | 0.609 | 0.609 | 0.000 |
| any_gold_in_capsule | 75.8% | 75.8% | 0.0pts |
| all_gold_in_capsule | 70.7% | 71.7% | 1.0pts |
| lead_pivot_is_source_gold | 51.5% | 51.5% | 0.0pts |
| hidden_coedit_recall | 0.589 | 0.589 | 0.000 |
| median tokens | 1152 | 1152 | 0 |
| p90 tokens | 3536 | 3536 | 0 |
| mean capsule files | 3.919 | 3.929 | 0.010 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| mean required targets | 1.475 | 1.475 | 0.000 |
| mean optional targets | 2.444 | 2.455 | 0.010 |
| excellent | 26 | 26 | 0 |
| overpacked | 14 | 14 | 0 |

### Dev (n=60)

| metric | M98 | M99 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.547 | 0.547 | 0.000 |
| recall@3 | 0.690 | 0.690 | 0.000 |
| recall@5 | 0.799 | 0.807 | 0.008 |
| recall@10 | 0.815 | 0.824 | 0.008 |
| MRR | 0.671 | 0.671 | 0.000 |
| any_gold_in_capsule | 85.0% | 85.0% | 0.0pts |
| all_gold_in_capsule | 78.3% | 80.0% | 1.7pts |
| lead_pivot_is_source_gold | 56.7% | 56.7% | 0.0pts |
| hidden_coedit_recall | 0.736 | 0.736 | 0.000 |
| median tokens | 917 | 917 | 0 |
| p90 tokens | 2843 | 2843 | 0 |
| mean capsule files | 3.933 | 3.950 | 0.017 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| mean required targets | 1.500 | 1.500 | 0.000 |
| mean optional targets | 2.433 | 2.450 | 0.017 |
| excellent | 17 | 17 | 0 |
| overpacked | 11 | 11 | 0 |

### Holdout (n=39)

| metric | M98 | M99 | Δ |
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
| mean capsule files | 3.897 | 3.897 | 0.000 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| mean required targets | 1.436 | 1.436 | 0.000 |
| mean optional targets | 2.462 | 2.462 | 0.000 |
| excellent | 9 | 9 | 0 |
| overpacked | 3 | 3 | 0 |

### Multi-file only (n=15)

| metric | M98 | M99 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.056 | 0.056 | 0.000 |
| recall@3 | 0.328 | 0.328 | 0.000 |
| recall@5 | 0.494 | 0.528 | 0.033 |
| recall@10 | 0.561 | 0.594 | 0.033 |
| MRR | 0.389 | 0.389 | 0.000 |
| any_gold_in_capsule | 73.3% | 73.3% | 0.0pts |
| all_gold_in_capsule | 40.0% | 46.7% | 6.7pts |
| lead_pivot_is_source_gold | 13.3% | 13.3% | 0.0pts |
| hidden_coedit_recall | 0.589 | 0.589 | 0.000 |
| median tokens | 1194 | 1194 | 0 |
| p90 tokens | 2620 | 2620 | 0 |
| mean capsule files | 4.200 | 4.267 | 0.067 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| mean required targets | 1.600 | 1.600 | 0.000 |
| mean optional targets | 2.600 | 2.667 | 0.067 |
| excellent | 1 | 1 | 0 |
| overpacked | 1 | 1 | 0 |

### Multi-file dev (n=12)

| metric | M98 | M99 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.069 | 0.069 | 0.000 |
| recall@3 | 0.368 | 0.368 | 0.000 |
| recall@5 | 0.576 | 0.618 | 0.042 |
| recall@10 | 0.660 | 0.701 | 0.042 |
| MRR | 0.458 | 0.458 | 0.000 |
| any_gold_in_capsule | 83.3% | 83.3% | 0.0pts |
| all_gold_in_capsule | 50.0% | 58.3% | 8.3pts |
| lead_pivot_is_source_gold | 16.7% | 16.7% | 0.0pts |
| hidden_coedit_recall | 0.736 | 0.736 | 0.000 |
| median tokens | 926 | 926 | 0 |
| p90 tokens | 2211 | 2211 | 0 |
| mean capsule files | 4.250 | 4.333 | 0.083 |
| median capsule files | 4.500 | 5.000 | 0.500 |
| mean required targets | 1.583 | 1.583 | 0.000 |
| mean optional targets | 2.667 | 2.750 | 0.083 |
| excellent | 1 | 1 | 0 |
| overpacked | 1 | 1 | 0 |

### Multi-file holdout (n=3)

| metric | M98 | M99 | Δ |
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

| metric | M98 | M99 | Δ |
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
| mean capsule files | 3.869 | 3.869 | 0.000 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| mean required targets | 1.452 | 1.452 | 0.000 |
| mean optional targets | 2.417 | 2.417 | 0.000 |
| excellent | 25 | 25 | 0 |
| overpacked | 13 | 13 | 0 |

### Hidden-coedit subset (n=15)

| metric | M98 | M99 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.056 | 0.056 | 0.000 |
| recall@3 | 0.328 | 0.328 | 0.000 |
| recall@5 | 0.494 | 0.528 | 0.033 |
| recall@10 | 0.561 | 0.594 | 0.033 |
| MRR | 0.389 | 0.389 | 0.000 |
| any_gold_in_capsule | 73.3% | 73.3% | 0.0pts |
| all_gold_in_capsule | 40.0% | 46.7% | 6.7pts |
| lead_pivot_is_source_gold | 13.3% | 13.3% | 0.0pts |
| hidden_coedit_recall | 0.589 | 0.589 | 0.000 |
| median tokens | 1194 | 1194 | 0 |
| p90 tokens | 2620 | 2620 | 0 |
| mean capsule files | 4.200 | 4.267 | 0.067 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| mean required targets | 1.600 | 1.600 | 0.000 |
| mean optional targets | 2.600 | 2.667 | 0.067 |
| excellent | 1 | 1 | 0 |
| overpacked | 1 | 1 | 0 |

### Co-edit-fired cases (M98 definition) (n=69)

| metric | M98 | M99 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.471 | 0.471 | 0.000 |
| recall@3 | 0.594 | 0.594 | 0.000 |
| recall@5 | 0.703 | 0.710 | 0.007 |
| recall@10 | 0.717 | 0.725 | 0.007 |
| MRR | 0.572 | 0.572 | 0.000 |
| any_gold_in_capsule | 72.5% | 72.5% | 0.0pts |
| all_gold_in_capsule | 71.0% | 72.5% | 1.4pts |
| lead_pivot_is_source_gold | 47.8% | 47.8% | 0.0pts |
| hidden_coedit_recall | 0.778 | 0.778 | 0.000 |
| median tokens | 1216 | 1216 | 0 |
| p90 tokens | 5377 | 5377 | 0 |
| mean capsule files | 4.203 | 4.217 | 0.014 |
| median capsule files | 4.000 | 4.000 | 0.000 |
| mean required targets | 1.464 | 1.464 | 0.000 |
| mean optional targets | 2.739 | 2.754 | 0.014 |
| excellent | 15 | 15 | 0 |
| overpacked | 10 | 10 | 0 |

### Import-only suspected subset (M99 audit) (n=16)

| metric | M98 | M99 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.000 | 0.000 | 0.000 |
| recall@3 | 0.047 | 0.047 | 0.000 |
| recall@5 | 0.078 | 0.109 | 0.031 |
| recall@10 | 0.078 | 0.109 | 0.031 |
| MRR | 0.078 | 0.078 | 0.000 |
| any_gold_in_capsule | 18.8% | 18.8% | 0.0pts |
| all_gold_in_capsule | 0.0% | 6.3% | 6.3pts |
| lead_pivot_is_source_gold | 0.0% | 0.0% | 0.0pts |
| hidden_coedit_recall | 0.583 | 0.583 | 0.000 |
| median tokens | 989 | 989 | 0 |
| p90 tokens | 3432 | 3432 | 0 |
| mean capsule files | 4.375 | 4.438 | 0.063 |
| median capsule files | 5.000 | 5.000 | 0.000 |
| mean required targets | 1.500 | 1.500 | 0.000 |
| mean optional targets | 2.875 | 2.938 | 0.063 |
| excellent | 0 | 0 | 0 |
| overpacked | 1 | 1 | 0 |

### Anchor-less subset (M99 audit) (n=13)

| metric | M98 | M99 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.026 | 0.026 | 0.000 |
| recall@3 | 0.090 | 0.090 | 0.000 |
| recall@5 | 0.090 | 0.090 | 0.000 |
| recall@10 | 0.090 | 0.090 | 0.000 |
| MRR | 0.103 | 0.103 | 0.000 |
| any_gold_in_capsule | 15.4% | 15.4% | 0.0pts |
| all_gold_in_capsule | 0.0% | 0.0% | 0.0pts |
| lead_pivot_is_source_gold | 7.7% | 7.7% | 0.0pts |
| hidden_coedit_recall | 0.100 | 0.100 | 0.000 |
| median tokens | 701 | 701 | 0 |
| p90 tokens | 7810 | 7810 | 0 |
| mean capsule files | 2.923 | 2.923 | 0.000 |
| median capsule files | 3.000 | 3.000 | 0.000 |
| mean required targets | 1.308 | 1.308 | 0.000 |
| mean optional targets | 1.615 | 1.615 | 0.000 |
| excellent | 0 | 0 | 0 |
| overpacked | 0 | 0 | 0 |

### M98 overpacked cases (n=14)

| metric | M98 | M99 | Δ |
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


## Co-edit Lane (with import-relation evidence)

- **all**: fired on 69/99 (69.7%); gold hit on 7 (10.1% of fired); kept 62 (rescued 36, injected 26; gold 7, non-gold 55); pruned 46 (gold 0); spare-deferred 15; displaced 38; tiers: medium=15, high=47, low=46; import lane: considered 51, kept 1 (gold 1), pruned 0, hub 0, ambiguous 50; import types: import_reexport_rescue=1
- **dev**: fired on 41/60 (68.3%); gold hit on 6 (14.6% of fired); kept 39 (rescued 19, injected 20; gold 6, non-gold 33); pruned 24 (gold 0); spare-deferred 10; displaced 27; tiers: medium=10, high=29, low=24; import lane: considered 38, kept 1 (gold 1), pruned 0, hub 0, ambiguous 37; import types: import_reexport_rescue=1
- **holdout**: fired on 28/39 (71.8%); gold hit on 1 (3.6% of fired); kept 23 (rescued 17, injected 6; gold 1, non-gold 22); pruned 22 (gold 0); spare-deferred 5; displaced 11; tiers: medium=5, low=22, high=18; import lane: considered 13, kept 0 (gold 0), pruned 0, hub 0, ambiguous 13; import types: —

## Support Composition (all scored)

- mean support items 3.869, mean support files 3.020
- duplicate-file support items 140, generic-infra 0, docs/examples 10

## By Repo

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack | mean files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django/django | 44 | 0.576 | 0.725 | 0.794 | 0.794 | 0.683 | 84.1% | 75.0% | 84.1% | 59.1% | 0.472 | 1008 | 2989 | 3.000 | 3.68 |
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
| multi_file | 15 | 0.056 | 0.328 | 0.528 | 0.594 | 0.389 | 73.3% | 46.7% | 73.3% | 13.3% | 0.589 | 1194 | 2620 | 2.500 | 4.27 |
| source_only | 99 | 0.503 | 0.646 | 0.726 | 0.737 | 0.609 | 75.8% | 71.7% | 75.8% | 51.5% | 0.589 | 1152 | 3536 | 4.000 | 3.93 |
