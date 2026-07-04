# Stage 5 M101 Deterministic VTRACE Scoreboard (post anchored-target pivot guard)

_Deterministic, offline: no live agents, no Docker, no API spend. Same generation
path as M94–M100; compared against the frozen M100 baseline._

## Summary

- Scored: **99/100**
- ALL: lead=src-gold **54.5%** (M100 51.5%), gold-in-required **64.6%** (M100 60.6%), wrong_pivot **8** (M100 11), recall@5 **0.730** (M100 0.730), any-gold **75.8%** (M100 75.8%), all-gold **72.7%** (M100 72.7%), hidden-coedit **0.622** (M100 0.622), mean files **3.980** (M100 3.949)
- HOLDOUT: lead=src-gold **43.6%** (M100 43.6%), recall@1 **0.436** (M100 0.436), recall@5 **0.603** (M100 0.603), any-gold **61.5%** (M100 61.5%), all-gold **59.0%** (M100 59.0%)
- Lead-pivot flips vs M100: django__django-11206 utils/formats.py→utils/numberformat.py (now gold) [dev], pydata__xarray-6599 xarray/core/coordinates.py→xarray/core/computation.py (now gold) [dev], pydata__xarray-6938 xarray/core/dataarray.py→xarray/core/dataset.py (now gold) [dev]
- All-gold flips vs M100: none
- Outcome flips vs M100: astropy__astropy-14369 wrong_pivot→good [dev], astropy__astropy-7166 wrong_pivot→good [dev], pydata__xarray-6599 wrong_pivot→excellent [dev], pydata__xarray-6938 good→excellent [dev]
- Outcome distribution: excellent=29, miss=24, good=23, overpacked=14, wrong_pivot=8, partial=1
- Failure-reason distribution: lexical_mismatch=24, too_many_optional_targets=14, ranking_gap=8, hidden_coedit_missing=6, zero_required_but_gold_exists=2, unknown=1

## Cohort Metrics

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | gold-in-req | hidden-coedit | med tok | p90 tok | med overpack | mean files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 99 | 0.529 | 0.651 | 0.730 | 0.740 | 0.627 | 75.8% | 72.7% | 75.8% | 54.5% | 64.6% | 0.622 | 1178 | 4046 | 4.000 | 3.98 |
| dev | 60 | 0.589 | 0.699 | 0.813 | 0.829 | 0.701 | 85.0% | 81.7% | 85.0% | 61.7% | 71.7% | 0.778 | 917 | 3188 | 3.000 | 3.97 |
| holdout | 39 | 0.436 | 0.577 | 0.603 | 0.603 | 0.514 | 61.5% | 59.0% | 61.5% | 43.6% | 53.8% | 0.000 | 1401 | 5083 | 4.000 | 4.00 |
| multi_file | 15 | 0.089 | 0.294 | 0.550 | 0.617 | 0.411 | 73.3% | 53.3% | 73.3% | 20.0% | 46.7% | 0.622 | 1530 | 4812 | 2.500 | 4.33 |
| single_file | 84 | 0.607 | 0.714 | 0.762 | 0.762 | 0.665 | 76.2% | 76.2% | 76.2% | 60.7% | 67.9% | — | 1165 | 3712 | 4.000 | 3.92 |
| hidden_coedit_subset | 15 | 0.089 | 0.294 | 0.550 | 0.617 | 0.411 | 73.3% | 53.3% | 73.3% | 20.0% | 46.7% | 0.622 | 1530 | 4812 | 2.500 | 4.33 |
| m100_wrong_pivot | 11 | 0.091 | 0.591 | 0.909 | 0.955 | 0.397 | 100.0% | 90.9% | 100.0% | 9.1% | 27.3% | 0.800 | 509 | 2569 | 3.000 | 4.36 |
| m100_source_gold_available | 24 | 0.104 | 0.594 | 0.906 | 0.927 | 0.461 | 100.0% | 87.5% | 100.0% | 12.5% | 54.2% | 0.815 | 1191.5 | 2989 | 4.000 | 4.67 |
| m100_overpacked | 14 | 0.643 | 0.750 | 0.964 | 0.964 | 0.764 | 100.0% | 92.9% | 100.0% | 64.3% | 78.6% | 1.000 | 1476 | 5083 | 6.000 | 6.00 |

## M100 → M101 Deltas

### All scored (n=99)

| metric | M100 | M101 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.503 | 0.529 | 0.025 |
| recall@3 | 0.646 | 0.651 | 0.005 |
| recall@5 | 0.730 | 0.730 | 0.000 |
| recall@10 | 0.740 | 0.740 | 0.000 |
| MRR | 0.609 | 0.627 | 0.018 |
| any_gold_in_capsule | 75.8% | 75.8% | 0.0pts |
| all_gold_in_capsule | 72.7% | 72.7% | 0.0pts |
| lead_pivot_is_source_gold | 51.5% | 54.5% | 3.0pts |
| gold_file_in_required | 60.6% | 64.6% | 4.0pts |
| hidden_coedit_recall | 0.622 | 0.622 | 0.000 |
| median tokens | 1152 | 1178 | 26 |
| p90 tokens | 3536 | 4046 | 510 |
| mean capsule files | 3.949 | 3.980 | 0.030 |
| mean required targets | 1.475 | 1.626 | 0.152 |
| mean optional targets | 2.475 | 2.354 | -0.121 |
| excellent | 27 | 29 | 2 |
| wrong_pivot | 11 | 8 | -3 |
| overpacked | 14 | 14 | 0 |

### Dev (n=60)

| metric | M100 | M101 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.547 | 0.589 | 0.042 |
| recall@3 | 0.690 | 0.699 | 0.008 |
| recall@5 | 0.813 | 0.813 | 0.000 |
| recall@10 | 0.829 | 0.829 | 0.000 |
| MRR | 0.671 | 0.701 | 0.029 |
| any_gold_in_capsule | 85.0% | 85.0% | 0.0pts |
| all_gold_in_capsule | 81.7% | 81.7% | 0.0pts |
| lead_pivot_is_source_gold | 56.7% | 61.7% | 5.0pts |
| gold_file_in_required | 65.0% | 71.7% | 6.7pts |
| hidden_coedit_recall | 0.778 | 0.778 | 0.000 |
| median tokens | 917 | 917 | 0 |
| p90 tokens | 2843 | 3188 | 345 |
| mean capsule files | 3.967 | 3.967 | 0.000 |
| mean required targets | 1.500 | 1.617 | 0.117 |
| mean optional targets | 2.467 | 2.350 | -0.117 |
| excellent | 18 | 20 | 2 |
| wrong_pivot | 8 | 5 | -3 |
| overpacked | 11 | 11 | 0 |

### Holdout (n=39)

| metric | M100 | M101 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.436 | 0.436 | 0.000 |
| recall@3 | 0.577 | 0.577 | 0.000 |
| recall@5 | 0.603 | 0.603 | 0.000 |
| recall@10 | 0.603 | 0.603 | 0.000 |
| MRR | 0.514 | 0.514 | 0.000 |
| any_gold_in_capsule | 61.5% | 61.5% | 0.0pts |
| all_gold_in_capsule | 59.0% | 59.0% | 0.0pts |
| lead_pivot_is_source_gold | 43.6% | 43.6% | 0.0pts |
| gold_file_in_required | 53.8% | 53.8% | 0.0pts |
| hidden_coedit_recall | 0.000 | 0.000 | 0.000 |
| median tokens | 1484 | 1401 | -83 |
| p90 tokens | 6325 | 5083 | -1242 |
| mean capsule files | 3.923 | 4.000 | 0.077 |
| mean required targets | 1.436 | 1.641 | 0.205 |
| mean optional targets | 2.487 | 2.359 | -0.128 |
| excellent | 9 | 9 | 0 |
| wrong_pivot | 3 | 3 | 0 |
| overpacked | 3 | 3 | 0 |

### M100 wrong_pivot subset (n=11)

| metric | M100 | M101 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.000 | 0.091 | 0.091 |
| recall@3 | 0.545 | 0.591 | 0.045 |
| recall@5 | 0.909 | 0.909 | 0.000 |
| recall@10 | 0.955 | 0.955 | 0.000 |
| MRR | 0.344 | 0.397 | 0.053 |
| any_gold_in_capsule | 100.0% | 100.0% | 0.0pts |
| all_gold_in_capsule | 90.9% | 90.9% | 0.0pts |
| lead_pivot_is_source_gold | 0.0% | 9.1% | 9.1pts |
| gold_file_in_required | 0.0% | 27.3% | 27.3pts |
| hidden_coedit_recall | 0.800 | 0.800 | 0.000 |
| median tokens | 546 | 509 | -37 |
| p90 tokens | 2211 | 2569 | 358 |
| mean capsule files | 4.455 | 4.364 | -0.091 |
| mean required targets | 1.545 | 1.909 | 0.364 |
| mean optional targets | 2.909 | 2.455 | -0.455 |
| excellent | 0 | 1 | 1 |
| wrong_pivot | 11 | 8 | -3 |
| overpacked | 0 | 0 | 0 |

### M100 source-gold-available subset (gold in capsule, non-gold lead) (n=24)

| metric | M100 | M101 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.000 | 0.104 | 0.104 |
| recall@3 | 0.573 | 0.594 | 0.021 |
| recall@5 | 0.906 | 0.906 | 0.000 |
| recall@10 | 0.927 | 0.927 | 0.000 |
| MRR | 0.388 | 0.461 | 0.073 |
| any_gold_in_capsule | 100.0% | 100.0% | 0.0pts |
| all_gold_in_capsule | 87.5% | 87.5% | 0.0pts |
| lead_pivot_is_source_gold | 0.0% | 12.5% | 12.5pts |
| gold_file_in_required | 37.5% | 54.2% | 16.7pts |
| hidden_coedit_recall | 0.815 | 0.815 | 0.000 |
| median tokens | 1032.5 | 1191.5 | 159 |
| p90 tokens | 2250 | 2989 | 739 |
| mean capsule files | 4.708 | 4.667 | -0.042 |
| mean required targets | 1.792 | 2.000 | 0.208 |
| mean optional targets | 2.917 | 2.667 | -0.250 |
| excellent | 0 | 2 | 2 |
| wrong_pivot | 11 | 8 | -3 |
| overpacked | 6 | 6 | 0 |

### Multi-file only (n=15)

| metric | M100 | M101 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.056 | 0.089 | 0.033 |
| recall@3 | 0.328 | 0.294 | -0.033 |
| recall@5 | 0.550 | 0.550 | 0.000 |
| recall@10 | 0.617 | 0.617 | 0.000 |
| MRR | 0.389 | 0.411 | 0.022 |
| any_gold_in_capsule | 73.3% | 73.3% | 0.0pts |
| all_gold_in_capsule | 53.3% | 53.3% | 0.0pts |
| lead_pivot_is_source_gold | 13.3% | 20.0% | 6.7pts |
| gold_file_in_required | 40.0% | 46.7% | 6.7pts |
| hidden_coedit_recall | 0.622 | 0.622 | 0.000 |
| median tokens | 1194 | 1530 | 336 |
| p90 tokens | 2620 | 4812 | 2192 |
| mean capsule files | 4.333 | 4.333 | 0.000 |
| mean required targets | 1.600 | 1.733 | 0.133 |
| mean optional targets | 2.733 | 2.600 | -0.133 |
| excellent | 2 | 3 | 1 |
| wrong_pivot | 5 | 4 | -1 |
| overpacked | 1 | 1 | 0 |

### Multi-file dev (n=12)

| metric | M100 | M101 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.069 | 0.111 | 0.042 |
| recall@3 | 0.368 | 0.326 | -0.042 |
| recall@5 | 0.646 | 0.646 | 0.000 |
| recall@10 | 0.729 | 0.729 | 0.000 |
| MRR | 0.458 | 0.486 | 0.028 |
| any_gold_in_capsule | 83.3% | 83.3% | 0.0pts |
| all_gold_in_capsule | 66.7% | 66.7% | 0.0pts |
| lead_pivot_is_source_gold | 16.7% | 25.0% | 8.3pts |
| gold_file_in_required | 50.0% | 58.3% | 8.3pts |
| hidden_coedit_recall | 0.778 | 0.778 | 0.000 |
| median tokens | 926 | 1094 | 168 |
| p90 tokens | 2211 | 2569 | 358 |
| mean capsule files | 4.417 | 4.417 | 0.000 |
| mean required targets | 1.583 | 1.750 | 0.167 |
| mean optional targets | 2.833 | 2.667 | -0.167 |
| excellent | 2 | 3 | 1 |
| wrong_pivot | 4 | 3 | -1 |
| overpacked | 1 | 1 | 0 |

### Multi-file holdout (n=3)

| metric | M100 | M101 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.000 | 0.000 | 0.000 |
| recall@3 | 0.167 | 0.167 | 0.000 |
| recall@5 | 0.167 | 0.167 | 0.000 |
| recall@10 | 0.167 | 0.167 | 0.000 |
| MRR | 0.111 | 0.111 | 0.000 |
| any_gold_in_capsule | 33.3% | 33.3% | 0.0pts |
| all_gold_in_capsule | 0.0% | 0.0% | 0.0pts |
| lead_pivot_is_source_gold | 0.0% | 0.0% | 0.0pts |
| gold_file_in_required | 0.0% | 0.0% | 0.0pts |
| hidden_coedit_recall | 0.000 | 0.000 | 0.000 |
| median tokens | 2620 | 2620 | 0 |
| p90 tokens | 6325 | 6325 | 0 |
| mean capsule files | 4.000 | 4.000 | 0.000 |
| mean required targets | 1.667 | 1.667 | 0.000 |
| mean optional targets | 2.333 | 2.333 | 0.000 |
| excellent | 0 | 0 | 0 |
| wrong_pivot | 1 | 1 | 0 |
| overpacked | 0 | 0 | 0 |

### Single-file only (n=84)

| metric | M100 | M101 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.583 | 0.607 | 0.024 |
| recall@3 | 0.702 | 0.714 | 0.012 |
| recall@5 | 0.762 | 0.762 | 0.000 |
| recall@10 | 0.762 | 0.762 | 0.000 |
| MRR | 0.649 | 0.665 | 0.017 |
| any_gold_in_capsule | 76.2% | 76.2% | 0.0pts |
| all_gold_in_capsule | 76.2% | 76.2% | 0.0pts |
| lead_pivot_is_source_gold | 58.3% | 60.7% | 2.4pts |
| gold_file_in_required | 64.3% | 67.9% | 3.6pts |
| hidden_coedit_recall | — | — | — |
| median tokens | 1139.5 | 1165 | 25.5 |
| p90 tokens | 3536 | 3712 | 176 |
| mean capsule files | 3.881 | 3.917 | 0.036 |
| mean required targets | 1.452 | 1.607 | 0.155 |
| mean optional targets | 2.429 | 2.310 | -0.119 |
| excellent | 25 | 26 | 1 |
| wrong_pivot | 6 | 4 | -2 |
| overpacked | 13 | 13 | 0 |

### Hidden-coedit subset (n=15)

| metric | M100 | M101 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.056 | 0.089 | 0.033 |
| recall@3 | 0.328 | 0.294 | -0.033 |
| recall@5 | 0.550 | 0.550 | 0.000 |
| recall@10 | 0.617 | 0.617 | 0.000 |
| MRR | 0.389 | 0.411 | 0.022 |
| any_gold_in_capsule | 73.3% | 73.3% | 0.0pts |
| all_gold_in_capsule | 53.3% | 53.3% | 0.0pts |
| lead_pivot_is_source_gold | 13.3% | 20.0% | 6.7pts |
| gold_file_in_required | 40.0% | 46.7% | 6.7pts |
| hidden_coedit_recall | 0.622 | 0.622 | 0.000 |
| median tokens | 1194 | 1530 | 336 |
| p90 tokens | 2620 | 4812 | 2192 |
| mean capsule files | 4.333 | 4.333 | 0.000 |
| mean required targets | 1.600 | 1.733 | 0.133 |
| mean optional targets | 2.733 | 2.600 | -0.133 |
| excellent | 2 | 3 | 1 |
| wrong_pivot | 5 | 4 | -1 |
| overpacked | 1 | 1 | 0 |

### M100 overpacked cases (n=14)

| metric | M100 | M101 | Δ |
| --- | --- | --- | --- |
| recall@1 | 0.571 | 0.643 | 0.071 |
| recall@3 | 0.750 | 0.750 | 0.000 |
| recall@5 | 0.964 | 0.964 | 0.000 |
| recall@10 | 0.964 | 0.964 | 0.000 |
| MRR | 0.717 | 0.764 | 0.048 |
| any_gold_in_capsule | 100.0% | 100.0% | 0.0pts |
| all_gold_in_capsule | 92.9% | 92.9% | 0.0pts |
| lead_pivot_is_source_gold | 57.1% | 64.3% | 7.1pts |
| gold_file_in_required | 71.4% | 78.6% | 7.1pts |
| hidden_coedit_recall | 1.000 | 1.000 | 0.000 |
| median tokens | 1476 | 1476 | 0 |
| p90 tokens | 5083 | 5083 | 0 |
| mean capsule files | 6.000 | 6.000 | 0.000 |
| mean required targets | 2.000 | 2.071 | 0.071 |
| mean optional targets | 4.000 | 3.929 | -0.071 |
| excellent | 0 | 0 | 0 |
| wrong_pivot | 0 | 0 | 0 |
| overpacked | 14 | 14 | 0 |


## Anchored-Target Pivot Guard

- **all**: fired on 17/99; cap exemptions 14; dispatcher exemptions 7
  - astropy__astropy-14369: cap astropy/units/format/cds.py::CDS
  - astropy__astropy-14598: cap astropy/units/format/fits.py::Fits
  - astropy__astropy-7166: cap astropy/utils/misc.py::InheritDocstrings
  - django__django-11206: disp utils/numberformat.py::format
  - django__django-12774: cap contrib/admin/filters.py::queryset
  - django__django-13658: cap core/management/base.py::CommandParser
  - django__django-13810: cap core/exceptions.py::MiddlewareNotUsed
  - django__django-15503: cap core/cache/backends/db.py::has_key
  - django__django-16569: cap db/models/sql/query.py::add_fields
  - pydata__xarray-2905: cap xarray/backends/lru_cache.py::__setitem__; disp xarray/backends/lru_cache.py::__setitem__; disp xarray/backends/netCDF4_.py::__setitem__
  - pydata__xarray-6599: disp xarray/core/computation.py::polyval
  - pydata__xarray-6938: disp xarray/core/dataset.py::swap_dims
  - pydata__xarray-6992: cap xarray/core/coordinates.py::drop_coords
  - sympy__sympy-12481: cap sympy/combinatorics/perm_groups.py::PermutationGroup
  - sympy__sympy-13974: cap sympy/diffgeom/diffgeom.py::TensorProduct
  - sympy__sympy-15875: cap sympy/polys/agca/homomorphisms.py::is_zero
  - sympy__sympy-20428: cap sympy/polys/rings.py::clear_denoms; disp sympy/polys/polytools.py::clear_denoms; disp sympy/polys/rings.py::clear_denoms
- **dev**: fired on 10/60; cap exemptions 7; dispatcher exemptions 5
  - astropy__astropy-14369: cap astropy/units/format/cds.py::CDS
  - astropy__astropy-14598: cap astropy/units/format/fits.py::Fits
  - astropy__astropy-7166: cap astropy/utils/misc.py::InheritDocstrings
  - django__django-11206: disp utils/numberformat.py::format
  - django__django-12774: cap contrib/admin/filters.py::queryset
  - django__django-16569: cap db/models/sql/query.py::add_fields
  - pydata__xarray-2905: cap xarray/backends/lru_cache.py::__setitem__; disp xarray/backends/lru_cache.py::__setitem__; disp xarray/backends/netCDF4_.py::__setitem__
  - pydata__xarray-6599: disp xarray/core/computation.py::polyval
  - pydata__xarray-6938: disp xarray/core/dataset.py::swap_dims
  - pydata__xarray-6992: cap xarray/core/coordinates.py::drop_coords
- **holdout**: fired on 7/39; cap exemptions 7; dispatcher exemptions 2
  - django__django-13658: cap core/management/base.py::CommandParser
  - django__django-13810: cap core/exceptions.py::MiddlewareNotUsed
  - django__django-15503: cap core/cache/backends/db.py::has_key
  - sympy__sympy-12481: cap sympy/combinatorics/perm_groups.py::PermutationGroup
  - sympy__sympy-13974: cap sympy/diffgeom/diffgeom.py::TensorProduct
  - sympy__sympy-15875: cap sympy/polys/agca/homomorphisms.py::is_zero
  - sympy__sympy-20428: cap sympy/polys/rings.py::clear_denoms; disp sympy/polys/polytools.py::clear_denoms; disp sympy/polys/rings.py::clear_denoms

## By Repo

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | gold-in-req | hidden-coedit | med tok | p90 tok | med overpack | mean files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django/django | 44 | 0.598 | 0.725 | 0.801 | 0.801 | 0.698 | 84.1% | 77.3% | 84.1% | 61.4% | 70.5% | 0.556 | 1196.5 | 3035 | 3.000 | 3.75 |
| sympy/sympy | 17 | 0.412 | 0.647 | 0.647 | 0.647 | 0.529 | 64.7% | 64.7% | 64.7% | 41.2% | 58.8% | 0.000 | 2120 | 5083 | 4.000 | 4.71 |
| matplotlib/matplotlib | 7 | 0.429 | 0.429 | 0.500 | 0.571 | 0.464 | 57.1% | 57.1% | 57.1% | 42.9% | 42.9% | 1.000 | 851 | 1178 | 4.500 | 4.14 |
| sphinx-doc/sphinx | 7 | 0.286 | 0.357 | 0.429 | 0.429 | 0.357 | 42.9% | 42.9% | 42.9% | 28.6% | 42.9% | 1.000 | 701 | 7627 | 2.500 | 3.86 |
| pydata/xarray | 6 | 0.583 | 0.667 | 1.000 | 1.000 | 0.764 | 100.0% | 100.0% | 100.0% | 66.7% | 66.7% | 1.000 | 1254.5 | 3188 | 3.250 | 4.33 |
| astropy/astropy | 5 | 0.400 | 0.700 | 1.000 | 1.000 | 0.607 | 100.0% | 100.0% | 100.0% | 40.0% | 80.0% | 1.000 | 2133 | 4812 | 3.000 | 3.80 |
| pytest-dev/pytest | 4 | 0.750 | 0.750 | 0.750 | 0.750 | 0.750 | 75.0% | 75.0% | 75.0% | 75.0% | 75.0% | — | 612 | 1216 | 3.000 | 3.25 |
| psf/requests | 3 | 0.667 | 0.667 | 0.667 | 0.667 | 0.667 | 66.7% | 66.7% | 66.7% | 66.7% | 66.7% | — | 399 | 631 | 3.000 | 3.67 |
| pylint-dev/pylint | 2 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.000 | 156.5 | 313 | — | 2.00 |
| scikit-learn/scikit-learn | 2 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | — | 3408 | 5377 | 4.500 | 4.50 |
| mwaskom/seaborn | 1 | 0.500 | 0.500 | 0.500 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 1.000 | 1530 | 1530 | 3.000 | 6.00 |
| pallets/flask | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | — | 5615 | 5615 | 5.000 | 5.00 |

## By Patch Shape

| cohort | n | r@1 | r@3 | r@5 | r@10 | MRR | any-in-cap | all-in-cap | src-in-cap | lead=src | gold-in-req | hidden-coedit | med tok | p90 tok | med overpack | mean files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single_file | 84 | 0.607 | 0.714 | 0.762 | 0.762 | 0.665 | 76.2% | 76.2% | 76.2% | 60.7% | 67.9% | — | 1165 | 3712 | 4.000 | 3.92 |
| multi_file | 15 | 0.089 | 0.294 | 0.550 | 0.617 | 0.411 | 73.3% | 53.3% | 73.3% | 20.0% | 46.7% | 0.622 | 1530 | 4812 | 2.500 | 4.33 |
| source_only | 99 | 0.529 | 0.651 | 0.730 | 0.740 | 0.627 | 75.8% | 72.7% | 75.8% | 54.5% | 64.6% | 0.622 | 1178 | 4046 | 4.000 | 3.98 |
