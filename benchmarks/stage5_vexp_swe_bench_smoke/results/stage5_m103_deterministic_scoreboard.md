# Stage 5 M103 Deterministic Scoreboard (structured task derivation rebaseline)

_Deterministic, offline: no live agents, no Docker, no API spend. Same
generation path as M94–M102; task derivation is now the structured M103
default (V0 base + exceptions + failing tests + capped traceback frames), and
the leakage policy is provenance-based (issue-authored gold paths scored with
a diagnostic; gold-patch-derived paths still block)._

## Coverage

- Scored: **100/100** (M101 scored 99/100)
- Newly scored vs M101: psf__requests-5414
- issue_authored_gold_path diagnostics: 8
- gold_patch_leak blocks: 0

## M102 V5 Reproduction

V5 parity mismatches (outcome / lead pivot / task chars, on the 99-id
comparable set): **none — exact reproduction**

## Comparable-Set Metrics (M101-scored 99 ids)

### All scored (n=99)

| metric | M101 | M102 V5 | M103 |
| --- | --- | --- | --- |
| recall@1 | 0.529 | 0.564 | 0.564 |
| recall@3 | 0.651 | 0.681 | 0.681 |
| recall@5 | 0.730 | 0.745 | 0.745 |
| recall@10 | 0.740 | 0.765 | 0.765 |
| MRR | 0.627 | 0.660 | 0.660 |
| any_gold_in_capsule | 75.8% | 78.8% | 78.8% |
| all_gold_in_capsule | 72.7% | 74.7% | 74.7% |
| source_gold_in_capsule | 75.8% | 78.8% | 78.8% |
| lead_pivot_is_source_gold | 54.5% | 58.6% | 58.6% |
| lead_pivot_is_any_gold | 54.5% | 58.6% | 58.6% |
| gold_file_in_required | 64.6% | 67.7% | 67.7% |
| hidden_coedit_recall | 0.622 | 0.622 | 0.622 |
| multi_file_all_gold_in_capsule | 53.3% | 53.3% | 53.3% |
| wrong_pivot | 8 | 7 | 7 |
| miss | 24 | 21 | 21 |
| overpacked | 14 | 14 | 14 |
| excellent | 29 | 32 | 32 |
| median capsule tokens | 1178 | 1094 | 1094 |
| p90 capsule tokens | 4046 | 3712 | 3712 |
| mean capsule files | 3.980 | 3.879 | 3.879 |
| median capsule files | 4 | 4 | 4 |
| task chars median | — | 176 | 176 |
| task chars p90 | — | 392 | 392 |
| issue_authored_gold_path | 0 | 7 | 7 |

### Dev (n=60)

| metric | M101 | M102 V5 | M103 |
| --- | --- | --- | --- |
| recall@1 | 0.589 | 0.614 | 0.614 |
| recall@3 | 0.699 | 0.724 | 0.724 |
| recall@5 | 0.813 | 0.813 | 0.813 |
| recall@10 | 0.829 | 0.846 | 0.846 |
| MRR | 0.701 | 0.721 | 0.721 |
| any_gold_in_capsule | 85.0% | 86.7% | 86.7% |
| all_gold_in_capsule | 81.7% | 83.3% | 83.3% |
| source_gold_in_capsule | 85.0% | 86.7% | 86.7% |
| lead_pivot_is_source_gold | 61.7% | 65.0% | 65.0% |
| lead_pivot_is_any_gold | 61.7% | 65.0% | 65.0% |
| gold_file_in_required | 71.7% | 71.7% | 71.7% |
| hidden_coedit_recall | 0.778 | 0.778 | 0.778 |
| multi_file_all_gold_in_capsule | 66.7% | 66.7% | 66.7% |
| wrong_pivot | 5 | 5 | 5 |
| miss | 9 | 8 | 8 |
| overpacked | 11 | 11 | 11 |
| excellent | 20 | 23 | 23 |
| median capsule tokens | 917 | 864 | 864 |
| p90 capsule tokens | 3188 | 2989 | 2989 |
| mean capsule files | 3.967 | 3.867 | 3.867 |
| median capsule files | 4 | 4 | 4 |
| task chars median | — | 178.5 | 178.5 |
| task chars p90 | — | 357 | 357 |
| issue_authored_gold_path | 0 | 4 | 4 |

### Holdout (n=39)

| metric | M101 | M102 V5 | M103 |
| --- | --- | --- | --- |
| recall@1 | 0.436 | 0.487 | 0.487 |
| recall@3 | 0.577 | 0.615 | 0.615 |
| recall@5 | 0.603 | 0.641 | 0.641 |
| recall@10 | 0.603 | 0.641 | 0.641 |
| MRR | 0.514 | 0.565 | 0.565 |
| any_gold_in_capsule | 61.5% | 66.7% | 66.7% |
| all_gold_in_capsule | 59.0% | 61.5% | 61.5% |
| source_gold_in_capsule | 61.5% | 66.7% | 66.7% |
| lead_pivot_is_source_gold | 43.6% | 48.7% | 48.7% |
| lead_pivot_is_any_gold | 43.6% | 48.7% | 48.7% |
| gold_file_in_required | 53.8% | 61.5% | 61.5% |
| hidden_coedit_recall | 0.000 | 0.000 | 0.000 |
| multi_file_all_gold_in_capsule | 0.0% | 0.0% | 0.0% |
| wrong_pivot | 3 | 2 | 2 |
| miss | 15 | 13 | 13 |
| overpacked | 3 | 3 | 3 |
| excellent | 9 | 9 | 9 |
| median capsule tokens | 1401 | 1401 | 1401 |
| p90 capsule tokens | 5083 | 3993 | 3993 |
| mean capsule files | 4.000 | 3.897 | 3.897 |
| median capsule files | 4 | 4 | 4 |
| task chars median | — | 157 | 157 |
| task chars p90 | — | 396 | 396 |
| issue_authored_gold_path | 0 | 3 | 3 |

### Evidence-beyond-V0 cohort (n=50)

| metric | M101 | M102 V5 | M103 |
| --- | --- | --- | --- |
| recall@1 | 0.547 | 0.597 | 0.597 |
| recall@3 | 0.633 | 0.693 | 0.693 |
| recall@5 | 0.730 | 0.760 | 0.760 |
| recall@10 | 0.740 | 0.790 | 0.790 |
| MRR | 0.637 | 0.692 | 0.692 |
| any_gold_in_capsule | 74.0% | 80.0% | 80.0% |
| all_gold_in_capsule | 74.0% | 78.0% | 78.0% |
| source_gold_in_capsule | 74.0% | 80.0% | 80.0% |
| lead_pivot_is_source_gold | 58.0% | 64.0% | 64.0% |
| lead_pivot_is_any_gold | 58.0% | 64.0% | 64.0% |
| gold_file_in_required | 62.0% | 68.0% | 68.0% |
| hidden_coedit_recall | 0.750 | 0.750 | 0.750 |
| multi_file_all_gold_in_capsule | 75.0% | 75.0% | 75.0% |
| wrong_pivot | 4 | 3 | 3 |
| miss | 13 | 10 | 10 |
| overpacked | 6 | 6 | 6 |
| excellent | 19 | 21 | 21 |
| median capsule tokens | 1139.5 | 1091.5 | 1091.5 |
| p90 capsule tokens | 3432 | 3484 | 3484 |
| mean capsule files | 3.800 | 3.780 | 3.780 |
| median capsule files | 4 | 4 | 4 |
| task chars median | — | 190 | 190 |
| task chars p90 | — | 555 | 555 |
| issue_authored_gold_path | 0 | 7 | 7 |

### No-evidence-beyond-V0 cohort (n=49)

| metric | M101 | M102 V5 | M103 |
| --- | --- | --- | --- |
| recall@1 | 0.510 | 0.531 | 0.531 |
| recall@3 | 0.668 | 0.668 | 0.668 |
| recall@5 | 0.730 | 0.730 | 0.730 |
| recall@10 | 0.740 | 0.740 | 0.740 |
| MRR | 0.616 | 0.627 | 0.627 |
| any_gold_in_capsule | 77.6% | 77.6% | 77.6% |
| all_gold_in_capsule | 71.4% | 71.4% | 71.4% |
| source_gold_in_capsule | 77.6% | 77.6% | 77.6% |
| lead_pivot_is_source_gold | 51.0% | 53.1% | 53.1% |
| lead_pivot_is_any_gold | 51.0% | 53.1% | 53.1% |
| gold_file_in_required | 67.3% | 67.3% | 67.3% |
| hidden_coedit_recall | 0.476 | 0.476 | 0.476 |
| multi_file_all_gold_in_capsule | 28.6% | 28.6% | 28.6% |
| wrong_pivot | 4 | 4 | 4 |
| miss | 11 | 11 | 11 |
| overpacked | 8 | 8 | 8 |
| excellent | 10 | 11 | 11 |
| median capsule tokens | 1185 | 1094 | 1094 |
| p90 capsule tokens | 4812 | 3712 | 3712 |
| mean capsule files | 4.163 | 3.980 | 3.980 |
| median capsule files | 4 | 4 | 4 |
| task chars median | — | 172 | 172 |
| task chars p90 | — | 256 | 256 |
| issue_authored_gold_path | 0 | 0 | 0 |


## New-Policy Set (all M103-scored, includes psf__requests-5414)

- ALL: n=100 r@1=0.568 r@5=0.748 any=79.0% all=75.0% lead=59.0% wp=7 miss=21 op=14 files=3.880 taskP90=371
- DEV: n=60 r@1=0.614 r@5=0.813 any=86.7% all=83.3% lead=65.0% wp=5 miss=8 op=11 files=3.867 taskP90=357
- HOLDOUT: n=40 r@1=0.500 r@5=0.650 any=67.5% all=62.5% lead=50.0% wp=2 miss=13 op=3 files=3.900 taskP90=392

## Flips vs M101

- Outcome flips: django__django-13012 good→excellent [dev], django__django-13513 excellent→good [holdout], django__django-16938 miss→partial [holdout], psf__requests-1724 miss→excellent [dev], sphinx-doc__sphinx-7462 good→excellent [dev], sympy__sympy-13372 wrong_pivot→excellent [holdout], sympy__sympy-13480 miss→good [holdout]
- Lead-pivot flips: django__django-11740 db/models/fields/related_descriptors.py→— [dev], django__django-11815 db/models/base.py→db/migrations/serializer.py (now gold) [dev], django__django-13513 views/debug.py→views/generic/__init__.py (LOST gold) [holdout], django__django-15572 contrib/humanize/templatetags/humanize.py→— [dev], matplotlib__matplotlib-22719 lib/matplotlib/category.py→lib/matplotlib/units.py (LOST gold) [dev], psf__requests-1724 requests/utils.py→requests/sessions.py (now gold) [dev], pylint-dev__pylint-8898 —→pylint/config/config_initialization.py [dev], sphinx-doc__sphinx-7462 sphinx/application.py→sphinx/domains/python.py (now gold) [dev], sympy__sympy-13372 sympy/functions/special/error_functions.py→sympy/core/evalf.py (now gold) [holdout], sympy__sympy-13480 sympy/integrals/rationaltools.py→sympy/functions/elementary/hyperbolic.py (now gold) [holdout], sympy__sympy-24213 sympy/physics/units/quantities.py→sympy/physics/units/unitsystem.py (now gold) [holdout]
- All-gold flips: psf__requests-1724 gained [dev], sympy__sympy-13480 gained [holdout]

## Regression Guard Cases

```json
[
  {
    "instance_id": "django__django-13513",
    "cohort": "holdout",
    "m101": {
      "outcome": "excellent",
      "lead_pivot_file": "views/debug.py",
      "any_gold_in_capsule": true,
      "all_gold_in_capsule": true,
      "lead_pivot_is_source_gold": true,
      "gold_file_in_required": true,
      "recall_at_5": 1,
      "overpacking_ratio": 3,
      "capsule_file_count": 3
    },
    "m102_v5": {
      "outcome": "good",
      "lead_pivot_file": "views/generic/__init__.py",
      "any_gold_in_capsule": true,
      "all_gold_in_capsule": true,
      "lead_pivot_is_source_gold": false,
      "gold_file_in_required": true,
      "recall_at_5": 1,
      "overpacking_ratio": 3,
      "capsule_file_count": 3
    },
    "m103": {
      "outcome": "good",
      "lead_pivot_file": "views/generic/__init__.py",
      "any_gold_in_capsule": true,
      "all_gold_in_capsule": true,
      "lead_pivot_is_source_gold": false,
      "gold_file_in_required": true,
      "recall_at_5": 1,
      "overpacking_ratio": 3,
      "capsule_file_count": 3
    },
    "m103_generation_status": "scored",
    "m103_status_detail": null,
    "m103_leakage": {
      "verdict": "clean",
      "issue_authored_paths": [],
      "leaked_paths": []
    }
  },
  {
    "instance_id": "matplotlib__matplotlib-22719",
    "cohort": "dev",
    "m101": {
      "outcome": "overpacked",
      "lead_pivot_file": "lib/matplotlib/category.py",
      "any_gold_in_capsule": true,
      "all_gold_in_capsule": true,
      "lead_pivot_is_source_gold": true,
      "gold_file_in_required": true,
      "recall_at_5": 1,
      "overpacking_ratio": 6,
      "capsule_file_count": 6
    },
    "m102_v5": {
      "outcome": "overpacked",
      "lead_pivot_file": "lib/matplotlib/units.py",
      "any_gold_in_capsule": true,
      "all_gold_in_capsule": true,
      "lead_pivot_is_source_gold": false,
      "gold_file_in_required": false,
      "recall_at_5": 1,
      "overpacking_ratio": 6,
      "capsule_file_count": 6
    },
    "m103": {
      "outcome": "overpacked",
      "lead_pivot_file": "lib/matplotlib/units.py",
      "any_gold_in_capsule": true,
      "all_gold_in_capsule": true,
      "lead_pivot_is_source_gold": false,
      "gold_file_in_required": false,
      "recall_at_5": 1,
      "overpacking_ratio": 6,
      "capsule_file_count": 6
    },
    "m103_generation_status": "scored",
    "m103_status_detail": null,
    "m103_leakage": {
      "verdict": "clean",
      "issue_authored_paths": [],
      "leaked_paths": []
    }
  },
  {
    "instance_id": "pydata__xarray-4695",
    "cohort": "dev",
    "m101": {
      "outcome": "overpacked",
      "lead_pivot_file": "xarray/backends/api.py",
      "any_gold_in_capsule": true,
      "all_gold_in_capsule": true,
      "lead_pivot_is_source_gold": false,
      "gold_file_in_required": false,
      "recall_at_5": 1,
      "overpacking_ratio": 6,
      "capsule_file_count": 6
    },
    "m102_v5": {
      "outcome": "overpacked",
      "lead_pivot_file": "xarray/backends/api.py",
      "any_gold_in_capsule": true,
      "all_gold_in_capsule": true,
      "lead_pivot_is_source_gold": false,
      "gold_file_in_required": false,
      "recall_at_5": 0,
      "overpacking_ratio": 6,
      "capsule_file_count": 6
    },
    "m103": {
      "outcome": "overpacked",
      "lead_pivot_file": "xarray/backends/api.py",
      "any_gold_in_capsule": true,
      "all_gold_in_capsule": true,
      "lead_pivot_is_source_gold": false,
      "gold_file_in_required": false,
      "recall_at_5": 0,
      "overpacking_ratio": 6,
      "capsule_file_count": 6
    },
    "m103_generation_status": "scored",
    "m103_status_detail": null,
    "m103_leakage": {
      "verdict": "clean",
      "issue_authored_paths": [],
      "leaked_paths": []
    }
  }
]
```

## Leakage Policy Case (psf__requests-5414)

```json
{
  "instance_id": "psf__requests-5414",
  "cohort": "holdout",
  "m101": null,
  "m102_v5": null,
  "m103": {
    "outcome": "good",
    "lead_pivot_file": "requests/models.py",
    "any_gold_in_capsule": true,
    "all_gold_in_capsule": true,
    "lead_pivot_is_source_gold": true,
    "gold_file_in_required": true,
    "recall_at_5": 1,
    "overpacking_ratio": 4,
    "capsule_file_count": 4
  },
  "m103_generation_status": "scored",
  "m103_status_detail": null,
  "m103_leakage": {
    "verdict": "issue_authored_gold_path",
    "issue_authored_paths": [
      "requests/models.py"
    ],
    "leaked_paths": []
  }
}
```

## By Repo (M103, with M101/V5 baselines in the CSV)

| repo | n | r@1 | r@5 | MRR | any | all | lead=src | gold-in-req | files | medTok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django/django | 44 | 0.598 | 0.813 | 0.709 | 86.4% | 77.3% | 61.4% | 72.7% | 3.55 | 749 |
| sympy/sympy | 17 | 0.588 | 0.706 | 0.647 | 70.6% | 70.6% | 58.8% | 70.6% | 4.53 | 2620 |
| matplotlib/matplotlib | 7 | 0.286 | 0.500 | 0.369 | 57.1% | 57.1% | 28.6% | 28.6% | 4.14 | 808 |
| sphinx-doc/sphinx | 7 | 0.357 | 0.429 | 0.429 | 42.9% | 42.9% | 42.9% | 42.9% | 3.71 | 701 |
| pydata/xarray | 6 | 0.583 | 0.833 | 0.750 | 100.0% | 100.0% | 66.7% | 66.7% | 4.50 | 1333 |
| astropy/astropy | 5 | 0.400 | 1.000 | 0.607 | 100.0% | 100.0% | 40.0% | 80.0% | 3.80 | 2133 |
| pytest-dev/pytest | 4 | 0.750 | 0.750 | 0.750 | 75.0% | 75.0% | 75.0% | 75.0% | 3.25 | 723 |
| psf/requests | 3 | 1.000 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | 2.67 | 631 |
| pylint-dev/pylint | 2 | 0.000 | 0.000 | 0.000 | 0.0% | 0.0% | 0.0% | 0.0% | 4.50 | 517.5 |
| scikit-learn/scikit-learn | 2 | 1.000 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | 4.50 | 3412 |
| mwaskom/seaborn | 1 | 0.500 | 0.500 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | 6.00 | 1530 |
| pallets/flask | 1 | 1.000 | 1.000 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% | 5.00 | 5615 |

## Distributions

- Outcomes: excellent=32, good=24, miss=21, overpacked=14, wrong_pivot=7, partial=2
- Failure reasons: lexical_mismatch=21, too_many_optional_targets=14, ranking_gap=7, hidden_coedit_missing=6, zero_required_but_gold_exists=3
