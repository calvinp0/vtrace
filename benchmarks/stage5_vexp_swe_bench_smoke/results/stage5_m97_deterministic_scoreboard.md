# Stage 5 M97 Deterministic VTRACE Scoreboard (post hidden co-edit lane)

_Deterministic, offline: no live agents, no Docker, no API spend. Same generation
path as M94/M95/M96; compared against the frozen M96 baseline (M94/M95 kept as
historical references)._

## Summary

- Scored: **99/100**
- ALL: recall@5 **0.721** (M96 0.706, M95 0.652, M94 0.637), any-gold **75.8%** (M96 75.8%), all-gold **70.7%** (M96 65.7%), hidden-coedit **0.589** (M96 0.256)
- HOLDOUT: recall@1 **0.436** (M96 0.436), any-gold **61.5%** (M96 61.5%), hidden-coedit **0.000** (M96 0.000), med tok **1513** (M96 1484), p90 **6325** (M96 6329)
- MULTI-FILE: all-gold **6.7% → 40.0%**, hidden-coedit **0.256 → 0.589**
- Dev outcome flips vs M96: astropy__astropy-14539 excellent→good, django__django-10973 excellent→good, django__django-11820 good→overpacked, django__django-12774 excellent→good, django__django-15037 wrong_pivot→overpacked, django__django-16877 excellent→good, matplotlib__matplotlib-22719 good→overpacked, mwaskom__seaborn-3187 overpacked→excellent, pallets__flask-5014 good→overpacked, psf__requests-1142 excellent→good, pydata__xarray-2905 excellent→good, pydata__xarray-3677 excellent→good, pydata__xarray-6938 partial→good, pytest-dev__pytest-10051 excellent→good, pytest-dev__pytest-7432 excellent→good, scikit-learn__scikit-learn-11578 excellent→good, sphinx-doc__sphinx-7462 partial→good
- Outcome distribution: good=27, miss=24, excellent=18, overpacked=18, wrong_pivot=10, partial=2
- Failure-reason distribution: lexical_mismatch=24, too_many_optional_targets=18, ranking_gap=10, hidden_coedit_missing=7, zero_required_but_gold_exists=2, unknown=1

## Cohort Metrics

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 99 | 0.503 | 0.646 | 0.721 | 0.731 | 0.610 | 75.8% | 70.7% | 75.8% | 51.5% | 0.589 | 1152 | 3536 | 4.000 |
| dev | 60 | 0.547 | 0.690 | 0.799 | 0.815 | 0.673 | 85.0% | 78.3% | 85.0% | 56.7% | 0.736 | 890 | 2843 | 4.000 |
| holdout | 39 | 0.436 | 0.577 | 0.603 | 0.603 | 0.514 | 61.5% | 59.0% | 61.5% | 43.6% | 0.000 | 1513 | 6325 | 4.000 |
| multi_file | 15 | 0.056 | 0.328 | 0.494 | 0.561 | 0.389 | 73.3% | 40.0% | 73.3% | 13.3% | 0.589 | 1194 | 2620 | 2.500 |
| single_file | 84 | 0.583 | 0.702 | 0.762 | 0.762 | 0.650 | 76.2% | 76.2% | 76.2% | 58.3% | — | 1145 | 3536 | 4.500 |
| hidden_coedit_subset | 15 | 0.056 | 0.328 | 0.494 | 0.561 | 0.389 | 73.3% | 40.0% | 73.3% | 13.3% | 0.589 | 1194 | 2620 | 2.500 |
| partial_gold_subset | 10 | 0.083 | 0.392 | 0.642 | 0.742 | 0.533 | 100.0% | 50.0% | 100.0% | 20.0% | 0.783 | 926 | 1646 | 2.750 |

## M96 → M97 Deltas

### All scored (n=99)

| metric | M96 | M97 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.503 | 0.503 | 0.000 |
| recall@3 | 0.646 | 0.646 | 0.000 |
| recall@5 | 0.706 | 0.721 | 0.015 |
| recall@10 | 0.706 | 0.731 | 0.025 |
| MRR | 0.609 | 0.610 | 0.001 |
| any_gold_in_capsule | 75.8% | 75.8% | 0.0pts |
| all_gold_in_capsule | 65.7% | 70.7% | 5.1pts |
| lead_pivot_is_source_gold | 51.5% | 51.5% | 0.0pts |
| hidden_coedit_recall | 0.256 | 0.589 | 0.333 |
| median tokens | 1152 | 1152 | 0 |
| p90 tokens | 3536 | 3536 | 0 |
| mean capsule files | 3.626 | 4.323 | 0.697 |
| overpacked | 11 | 18 | 7 |

### Dev (n=60)

| metric | M96 | M97 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.547 | 0.547 | 0.000 |
| recall@3 | 0.690 | 0.690 | 0.000 |
| recall@5 | 0.774 | 0.799 | 0.025 |
| recall@10 | 0.774 | 0.815 | 0.042 |
| MRR | 0.671 | 0.673 | 0.002 |
| any_gold_in_capsule | 85.0% | 85.0% | 0.0pts |
| all_gold_in_capsule | 70.0% | 78.3% | 8.3pts |
| lead_pivot_is_source_gold | 56.7% | 56.7% | 0.0pts |
| hidden_coedit_recall | 0.319 | 0.736 | 0.417 |
| median tokens | 920 | 890 | -30 |
| p90 tokens | 2843 | 2843 | 0 |
| mean capsule files | 3.583 | 4.300 | 0.717 |
| overpacked | 9 | 12 | 3 |

### Holdout (n=39)

| metric | M96 | M97 | Δ |
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
| median tokens | 1484 | 1513 | 29 |
| p90 tokens | 6329 | 6325 | -4 |
| mean capsule files | 3.692 | 4.359 | 0.667 |
| overpacked | 2 | 6 | 4 |

### Multi-file only (n=15)

| metric | M96 | M97 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.056 | 0.056 | 0.000 |
| recall@3 | 0.328 | 0.328 | 0.000 |
| recall@5 | 0.394 | 0.494 | 0.100 |
| recall@10 | 0.394 | 0.561 | 0.167 |
| MRR | 0.389 | 0.389 | 0.000 |
| any_gold_in_capsule | 73.3% | 73.3% | 0.0pts |
| all_gold_in_capsule | 6.7% | 40.0% | 33.3pts |
| lead_pivot_is_source_gold | 13.3% | 13.3% | 0.0pts |
| hidden_coedit_recall | 0.256 | 0.589 | 0.333 |
| median tokens | 1152 | 1194 | 42 |
| p90 tokens | 2637 | 2620 | -17 |
| mean capsule files | 3.600 | 4.267 | 0.667 |
| overpacked | 2 | 1 | -1 |

### Multi-file dev (n=12)

| metric | M96 | M97 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.069 | 0.069 | 0.000 |
| recall@3 | 0.368 | 0.368 | 0.000 |
| recall@5 | 0.451 | 0.576 | 0.125 |
| recall@10 | 0.451 | 0.660 | 0.208 |
| MRR | 0.458 | 0.458 | 0.000 |
| any_gold_in_capsule | 83.3% | 83.3% | 0.0pts |
| all_gold_in_capsule | 8.3% | 50.0% | 41.7pts |
| lead_pivot_is_source_gold | 16.7% | 16.7% | 0.0pts |
| hidden_coedit_recall | 0.319 | 0.736 | 0.417 |
| median tokens | 906 | 926 | 20 |
| p90 tokens | 2172 | 2183 | 11 |
| mean capsule files | 3.750 | 4.333 | 0.583 |
| overpacked | 2 | 1 | -1 |

### Multi-file holdout (n=3)

| metric | M96 | M97 | Δ |
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
| median tokens | 2637 | 2620 | -17 |
| p90 tokens | 6329 | 6325 | -4 |
| mean capsule files | 3.000 | 4.000 | 1.000 |
| overpacked | 0 | 0 | 0 |

### Single-file only (n=84)

| metric | M96 | M97 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.583 | 0.583 | 0.000 |
| recall@3 | 0.702 | 0.702 | 0.000 |
| recall@5 | 0.762 | 0.762 | 0.000 |
| recall@10 | 0.762 | 0.762 | 0.000 |
| MRR | 0.649 | 0.650 | 0.001 |
| any_gold_in_capsule | 76.2% | 76.2% | 0.0pts |
| all_gold_in_capsule | 76.2% | 76.2% | 0.0pts |
| lead_pivot_is_source_gold | 58.3% | 58.3% | 0.0pts |
| hidden_coedit_recall | — | — | — |
| median tokens | 1139.5 | 1145 | 5.5 |
| p90 tokens | 3536 | 3536 | 0 |
| mean capsule files | 3.631 | 4.333 | 0.702 |
| overpacked | 9 | 17 | 8 |

### Hidden-coedit subset (n=15)

| metric | M96 | M97 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.056 | 0.056 | 0.000 |
| recall@3 | 0.328 | 0.328 | 0.000 |
| recall@5 | 0.394 | 0.494 | 0.100 |
| recall@10 | 0.394 | 0.561 | 0.167 |
| MRR | 0.389 | 0.389 | 0.000 |
| any_gold_in_capsule | 73.3% | 73.3% | 0.0pts |
| all_gold_in_capsule | 6.7% | 40.0% | 33.3pts |
| lead_pivot_is_source_gold | 13.3% | 13.3% | 0.0pts |
| hidden_coedit_recall | 0.256 | 0.589 | 0.333 |
| median tokens | 1152 | 1194 | 42 |
| p90 tokens | 2637 | 2620 | -17 |
| mean capsule files | 3.600 | 4.267 | 0.667 |
| overpacked | 2 | 1 | -1 |

### Partial-gold subset (any found, some missing) (n=10)

| metric | M96 | M97 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.083 | 0.083 | 0.000 |
| recall@3 | 0.392 | 0.392 | 0.000 |
| recall@5 | 0.492 | 0.642 | 0.150 |
| recall@10 | 0.492 | 0.742 | 0.250 |
| MRR | 0.533 | 0.533 | 0.000 |
| any_gold_in_capsule | 100.0% | 100.0% | 0.0pts |
| all_gold_in_capsule | 0.0% | 50.0% | 50.0pts |
| lead_pivot_is_source_gold | 20.0% | 20.0% | 0.0pts |
| hidden_coedit_recall | 0.283 | 0.783 | 0.500 |
| median tokens | 906 | 926 | 20 |
| p90 tokens | 1643 | 1646 | 3 |
| mean capsule files | 4.000 | 4.700 | 0.700 |
| overpacked | 2 | 1 | -1 |


## Co-edit Lane

- **all**: fired on 69/99 (69.7%); gold hit on 6 (8.7% of fired); candidates 107 (rescued 58, injected 49; gold 6, non-gold 101); displaced 82; rejected ambiguous 883, hub 209, budget 0; types: pool_rescue_calls_references=26, generated_artifact_pair=1, edge_calls_references=15, pool_rescue_calls=12, edge_references=8, pool_rescue_references=8, edge_imports_references=3, edge_imports=9, edge_calls_imports_references=1, pool_rescue_calls_imports=1, edge_calls=10
- **dev**: fired on 41/60 (68.3%); gold hit on 5 (12.2% of fired); candidates 62 (rescued 33, injected 29; gold 5, non-gold 57); displaced 50; rejected ambiguous 335, hub 59, budget 0; types: pool_rescue_calls_references=14, generated_artifact_pair=1, edge_calls_references=10, pool_rescue_calls=7, edge_references=5, pool_rescue_references=6, edge_imports_references=1, edge_imports=3, pool_rescue_calls_imports=1, edge_calls=7
- **holdout**: fired on 28/39 (71.8%); gold hit on 1 (3.6% of fired); candidates 45 (rescued 25, injected 20; gold 1, non-gold 44); displaced 32; rejected ambiguous 548, hub 150, budget 0; types: pool_rescue_calls_references=12, edge_imports=6, edge_calls_imports_references=1, edge_imports_references=2, edge_calls_references=5, pool_rescue_calls=5, pool_rescue_references=2, edge_calls=3, edge_references=3

## By Repo

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django/django | 44 | 0.576 | 0.725 | 0.782 | 0.782 | 0.683 | 84.1% | 72.7% | 84.1% | 59.1% | 0.472 | 1008 | 2989 | 4.000 |
| sympy/sympy | 17 | 0.412 | 0.647 | 0.647 | 0.647 | 0.529 | 64.7% | 64.7% | 64.7% | 41.2% | 0.000 | 2620 | 6654 | 5.000 |
| matplotlib/matplotlib | 7 | 0.429 | 0.429 | 0.500 | 0.571 | 0.464 | 57.1% | 57.1% | 57.1% | 42.9% | 1.000 | 851 | 1172 | 4.500 |
| sphinx-doc/sphinx | 7 | 0.286 | 0.357 | 0.429 | 0.429 | 0.357 | 42.9% | 42.9% | 42.9% | 28.6% | 1.000 | 726 | 7604 | 4.000 |
| pydata/xarray | 6 | 0.333 | 0.750 | 1.000 | 1.000 | 0.625 | 100.0% | 100.0% | 100.0% | 33.3% | 1.000 | 1104.5 | 3178 | 5.000 |
| astropy/astropy | 5 | 0.400 | 0.500 | 1.000 | 1.000 | 0.580 | 100.0% | 100.0% | 100.0% | 40.0% | 1.000 | 2197 | 2724 | 4.000 |
| pytest-dev/pytest | 4 | 0.750 | 0.750 | 0.750 | 0.750 | 0.750 | 75.0% | 75.0% | 75.0% | 75.0% | — | 626 | 1216 | 4.000 |
| psf/requests | 3 | 0.667 | 0.667 | 0.667 | 0.667 | 0.667 | 66.7% | 66.7% | 66.7% | 66.7% | — | 400 | 678 | 3.500 |
| pylint-dev/pylint | 2 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.0% | 0.0% | 0.0% | 0.0% | 0.000 | 156.5 | 313 | — |
| scikit-learn/scikit-learn | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | — | 3360.5 | 5282 | 5.000 |
| mwaskom/seaborn | 1 | 0.500 | 0.500 | 0.500 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | 1.000 | 1530 | 1530 | 3.000 |
| pallets/flask | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | — | 5628 | 5628 | 6.000 |

## By Patch Shape

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | hidden-coedit | med tok | p90 tok | med overpack |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single_file | 84 | 0.583 | 0.702 | 0.762 | 0.762 | 0.650 | 76.2% | 76.2% | 76.2% | 58.3% | — | 1145 | 3536 | 4.500 |
| multi_file | 15 | 0.056 | 0.328 | 0.494 | 0.561 | 0.389 | 73.3% | 40.0% | 73.3% | 13.3% | 0.589 | 1194 | 2620 | 2.500 |
| source_only | 99 | 0.503 | 0.646 | 0.721 | 0.731 | 0.610 | 75.8% | 70.7% | 75.8% | 51.5% | 0.589 | 1152 | 3536 | 4.000 |
