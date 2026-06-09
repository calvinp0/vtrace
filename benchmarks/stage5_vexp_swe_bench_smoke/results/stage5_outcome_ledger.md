# Stage 5 outcome ledger

_Generated: 2026-06-09T19:15:20.305Z_

_Reporting / indexing only. No agents, no Docker, no retrieval / PIVOT_CHECK / telemetry changes. Folds existing Stage 5 run artifacts into one outcome table for future VTRACE-vs-baseline / VEXP-style measurement._

## Summary

- Total runs discovered: 79
- Valid VTRACE runs: 67
- Runs with ordered tool logs: 4
- Runs with resolution known: 70
- Runs with resolution unknown: 9
- Total cost (USD): 51.7999
- Mean cost per run (USD): 0.6816
- Mean tokens per run: 1618944
- PIVOT_CHECK before/after pairs discovered: 2
- baseline-vs-vtrace pairs discovered: 5

## What this ledger measures

This ledger INDEXES existing artifacts; it does not evaluate. For each run it records the protocol/treatment validity, PIVOT_CHECK state, tokens/cost, edited/read/searched files, capsule pivots, ordered tool-call presence, hidden-pivot engagement (when both a capsule and an ordered tool log exist), and resolution (ONLY when actually evaluated). It keeps four signals strictly separate and never conflates them:

- **patch production** — a non-empty `modelPatch` was extracted.
- **edited-file-set change** — the set of edited files differs across a pair.
- **inspection conversion** — a hidden pivot moved from ignored → inspected/edited across a pair.
- **docker resolution** — the SWE-bench evaluation said the patch resolves the task.

## Run inventory

| run label | cond | instance | protocol | treat. valid | pivot-check inj | tokens | cost | resolved | pivots | tool log | edited | completeness |
| --- | --- | --- | --- | :---: | :---: | ---: | ---: | :---: | ---: | :---: | --- | --- |
| eval-10880 | vtrace | django__django-10880 | vtrace-indexed | yes | unknown | 628051 | 0.2561 | resolved | ? | no | django/db/models/aggregates.py | complete |
| eval-10880 | baseline | django__django-10880 | baseline | unknown | unknown | 432600 | 0.2088 | resolved | ? | no | django/db/models/aggregates.py | complete |
| eval-11095 | vtrace | django__django-11095 | vtrace-indexed | yes | unknown | 999877 | 0.3553 | resolved | ? | no | django/contrib/admin/options.py | complete |
| eval-11095 | baseline | django__django-11095 | baseline | unknown | unknown | 535997 | 0.2230 | resolved | ? | no | django/contrib/admin/options.py | complete |
| eval-11490 | vtrace | django__django-11490 | vtrace-indexed | yes | unknown | 3301462 | 1.0802 | resolved | ? | no | django/db/models/sql/query.py | complete |
| eval-11490 | baseline | django__django-11490 | baseline | unknown | unknown | 4661640 | 1.6256 | resolved | ? | no | django/db/models/sql/query.py | complete |
| eval-11728 | vtrace | django__django-11728 | vtrace-indexed | yes | unknown | 1194127 | 0.5916 | resolved | ? | no | django/contrib/admindocs/utils.py | complete |
| eval-11728 | baseline | django__django-11728 | baseline | unknown | unknown | 1716132 | 0.7336 | resolved | ? | no | django/contrib/admindocs/utils.py | complete |
| eval-11740 | vtrace | django__django-11740 | vtrace-indexed | yes | unknown | 1849882 | 0.6621 | resolved | ? | no | django/db/migrations/autodetector.py | complete |
| eval-11740 | baseline | django__django-11740 | baseline | unknown | unknown | 2387415 | 0.9119 | resolved | ? | no | django/db/migrations/autodetector.py | complete |
| eval-baseline-vs-vtrace-baseline-astropy-14369 | baseline | astropy__astropy-14369 | baseline | unknown | unknown | 3076313 | 1.5550 | unresolved | ? | no | astropy/units/format/cds.py, astropy/units/format/cds_parsetab.py, astropy/units/format/parser.out | complete |
| eval-baseline-vs-vtrace-baseline-requests-5414 | baseline | psf__requests-5414 | baseline | unknown | unknown | 736898 | 0.4726 | resolved | ? | no | requests/models.py | complete |
| eval-baseline-vs-vtrace-baseline-sympy-16766 | baseline | sympy__sympy-16766 | baseline | unknown | unknown | 1414441 | 0.5185 | resolved | ? | no | sympy/printing/pycode.py | complete |
| eval-capsulev2-auto-10880 | vtrace | django__django-10880 | vtrace-indexed | yes | unknown | 753097 | 0.4046 | resolved | 2 | no | django/db/models/aggregates.py | complete |
| eval-capsulev2-auto-11095 | vtrace | django__django-11095 | vtrace-indexed | yes | unknown | 665993 | 0.2624 | resolved | 2 | no | django/contrib/admin/options.py | complete |
| eval-capsulev2-auto-11490 | vtrace | django__django-11490 | vtrace-indexed | yes | unknown | 1610878 | 0.6387 | resolved | 2 | no | django/db/models/sql/compiler.py | complete |
| eval-capsulev2-auto-11728 | vtrace | django__django-11728 | vtrace-indexed | yes | unknown | 1373090 | 0.5260 | resolved | 2 | no | django/contrib/admindocs/utils.py | complete |
| eval-capsulev2-auto-11740 | vtrace | django__django-11740 | vtrace-indexed | yes | unknown | 2074004 | 0.8221 | resolved | 2 | no | django/db/migrations/autodetector.py | complete |
| eval-capsulev2-force--10880 | vtrace | django__django-10880 | vtrace-indexed | yes | unknown | 498435 | 0.3193 | resolved | 2 | no | django/db/models/aggregates.py | complete |
| eval-capsulev2-force--11095 | vtrace | django__django-11095 | vtrace-indexed | yes | unknown | 413980 | 0.1852 | resolved | 2 | no | django/contrib/admin/options.py | complete |
| eval-capsulev2-force--11490 | vtrace | django__django-11490 | vtrace-indexed | yes | unknown | 466608 | 0.2276 | unresolved | 2 | no | django/db/models/sql/compiler.py | complete |
| eval-capsulev2-force--11728 | vtrace | django__django-11728 | vtrace-indexed | yes | unknown | 1253461 | 0.5560 | resolved | 2 | no | django/contrib/admindocs/utils.py | complete |
| eval-capsulev2-force--11740 | vtrace | django__django-11740 | vtrace-indexed | yes | unknown | 1252756 | 0.4520 | resolved | 2 | no | django/db/migrations/autodetector.py | complete |
| eval-capsulev2-literal-11820 | vtrace | django__django-11820 | vtrace-indexed | yes | unknown | 1669927 | 0.7773 | unresolved | 2 | no | django/db/models/base.py | complete |
| eval-capsulev2-literal-12858 | vtrace | django__django-12858 | vtrace-indexed | yes | unknown | 522209 | 0.3595 | resolved | 2 | no | django/db/models/base.py | complete |
| eval-capsulev2-recovered-live-astropy-14369 | vtrace | astropy__astropy-14369 | vtrace-indexed | yes | unknown | 4298912 | 3.0240 | resolved | 2 | no | astropy/units/format/cds.py | complete |
| eval-capsulev2-recovered-live-requests-5414 | vtrace | psf__requests-5414 | vtrace-indexed | yes | unknown | 543663 | 0.3009 | unresolved | 2 | no | requests/models.py | complete |
| eval-capsulev2-recovered-live-sympy-16766 | vtrace | sympy__sympy-16766 | vtrace-indexed | yes | unknown | 1658843 | 0.6317 | resolved | 2 | no | sympy/printing/pycode.py | complete |
| eval-capsulev2-risk-11490 | vtrace | django__django-11490 | vtrace-indexed | yes | unknown | 1394548 | 0.7436 | resolved | 2 | no | django/db/models/sql/compiler.py | complete |
| eval-capsulev2-risk5-10880 | vtrace | django__django-10880 | vtrace-indexed | yes | unknown | 385653 | 0.1807 | resolved | 2 | no | django/db/models/aggregates.py | complete |
| eval-capsulev2-risk5-11095 | vtrace | django__django-11095 | vtrace-indexed | yes | unknown | 646809 | 0.2722 | resolved | 2 | no | django/contrib/admin/options.py | complete |
| eval-capsulev2-risk5-11490 | vtrace | django__django-11490 | vtrace-indexed | yes | unknown | 1088993 | 0.4975 | resolved | 2 | no | django/db/models/sql/compiler.py | complete |
| eval-capsulev2-risk5-11728 | vtrace | django__django-11728 | vtrace-indexed | yes | unknown | 909044 | 0.4382 | resolved | 2 | no | django/contrib/admindocs/utils.py | complete |
| eval-capsulev2-risk5-11740 | vtrace | django__django-11740 | vtrace-indexed | yes | unknown | 697287 | 0.2919 | resolved | 2 | no | django/db/migrations/autodetector.py | complete |
| eval-capsulev2-source-11490 | vtrace | django__django-11490 | vtrace-indexed | yes | unknown | 427334 | 0.3343 | unresolved | 2 | no | django/db/models/sql/compiler.py | complete |
| eval-capsulev2-sqlcompiler-11490 | vtrace | django__django-11490 | vtrace-indexed | yes | unknown | 2294811 | 0.9444 | resolved | 2 | no | django/db/models/sql/compiler.py | complete |
| eval-capsulev2-state-11820 | vtrace | django__django-11820 | vtrace-indexed | yes | unknown | 1196151 | 0.5035 | resolved | 2 | no | django/db/models/base.py | complete |
| eval-capsulev2-traversal-11820 | vtrace | django__django-11820 | vtrace-indexed | yes | unknown | 986834 | 0.4503 | unresolved | 2 | no | django/db/models/base.py | complete |
| eval-diagnostic-10880 | vtrace | django__django-10880 | vtrace | yes | unknown | 851780 | 0.3307 | resolved | 0 | no | django/db/models/aggregates.py | complete |
| eval-diagnostic-11095 | vtrace | django__django-11095 | vtrace | yes | unknown | 662786 | 0.2661 | resolved | 0 | no | django/contrib/admin/options.py | complete |
| eval-diagnostic-11490 | vtrace | django__django-11490 | vtrace-indexed | yes | unknown | 4002572 | 1.3645 | resolved | 0 | no | django/db/models/sql/compiler.py | complete |
| eval-diagnostic-11728 | vtrace | django__django-11728 | vtrace-indexed | yes | unknown | unknown | unknown | unknown | 0 | no | — | metadata_only |
| eval-diagnostic-11740 | vtrace | django__django-11740 | vtrace-indexed | yes | unknown | unknown | unknown | unknown | 0 | no | — | metadata_only |
| eval-diagnostic-rerun-11728 | vtrace | django__django-11728 | vtrace-indexed | yes | unknown | 1037753 | 0.4571 | resolved | 0 | no | django/contrib/admindocs/utils.py | complete |
| eval-diagnostic-rerun-11740 | vtrace | django__django-11740 | vtrace-indexed | yes | unknown | 2453214 | 0.8703 | resolved | 0 | no | django/db/migrations/autodetector.py | complete |
| eval-directive-11490 | vtrace | unknown | vtrace | unknown | unknown | unknown | unknown | unknown | ? | no | — | missing |
| eval-fixed-10880 | vtrace | django__django-10880 | vtrace-indexed | yes | unknown | 989184 | 0.3829 | resolved | ? | no | django/db/models/aggregates.py | complete |
| eval-fixed-11095 | vtrace | django__django-11095 | vtrace-indexed | yes | unknown | 848008 | 0.4129 | resolved | ? | no | django/contrib/admin/options.py | complete |
| eval-fixed-11490 | vtrace | django__django-11490 | vtrace-indexed | yes | unknown | 3474086 | 1.2019 | resolved | ? | no | django/db/models/sql/query.py | complete |
| eval-fixed-11728 | vtrace | django__django-11728 | vtrace-indexed | yes | unknown | 1638761 | 0.6524 | resolved | ? | no | django/contrib/admindocs/utils.py | complete |
| eval-fixed-11740 | vtrace | django__django-11740 | vtrace-indexed | yes | unknown | 1116974 | 0.5045 | resolved | ? | no | django/db/migrations/autodetector.py | complete |
| eval-localization-gap-baseline-matplotlib-22719 | baseline | matplotlib__matplotlib-22719 | baseline | unknown | unknown | 1167993 | 0.4638 | resolved | ? | no | lib/matplotlib/category.py | complete |
| eval-localization-gap-baseline-matplotlib-24627 | baseline | matplotlib__matplotlib-24627 | baseline | unknown | unknown | 4837198 | 3.0240 | unresolved | ? | no | lib/matplotlib/axes/_base.py, lib/matplotlib/figure.py | complete |
| eval-localization-gap-baseline-sphinx-7462 | baseline | sphinx-doc__sphinx-7462 | baseline | unknown | unknown | 627263 | 0.2651 | unresolved | ? | no | sphinx/domains/python.py | complete |
| eval-localization-gap-vtrace-matplotlib-22719 | vtrace | matplotlib__matplotlib-22719 | vtrace-indexed | yes | unknown | 1543461 | 0.6146 | resolved | 2 | no | lib/matplotlib/category.py | complete |
| eval-localization-gap-vtrace-matplotlib-24627 | vtrace | matplotlib__matplotlib-24627 | vtrace-indexed | yes | unknown | 3686556 | 1.1297 | unresolved | 2 | no | lib/matplotlib/axes/_base.py, lib/matplotlib/figure.py | complete |
| eval-localization-gap-vtrace-sphinx-7462 | vtrace | sphinx-doc__sphinx-7462 | vtrace-indexed | yes | unknown | 572906 | 0.2493 | unresolved | 2 | no | sphinx/domains/python.py | complete |
| eval-locgap-multipivot-sphinx-7462 | vtrace | sphinx-doc__sphinx-7462 | vtrace-indexed | yes | unknown | 689423 | 0.3148 | unresolved | 2 | no | sphinx/domains/python.py | complete |
| eval-pivot-11490 | vtrace | django__django-11490 | vtrace-indexed | yes | unknown | 2970135 | 1.3020 | resolved | ? | no | django/db/models/sql/compiler.py | complete |
| eval-pivot-11728 | vtrace | django__django-11728 | vtrace-indexed | yes | unknown | 1373979 | 0.6789 | resolved | ? | no | django/contrib/admindocs/utils.py | complete |
| eval-pivot-11740 | vtrace | django__django-11740 | vtrace-indexed | yes | unknown | 1995432 | 0.7426 | resolved | ? | no | django/db/migrations/autodetector.py | complete |
| eval-pivot-check-vtrace-seaborn-3187 | vtrace | mwaskom__seaborn-3187 | vtrace-indexed | yes | yes | 3308810 | 1.1158 | unknown | 2 | yes | seaborn/_core/scales.py, seaborn/utils.py | partial |
| eval-pivot-check-vtrace-sphinx-7462 | vtrace | sphinx-doc__sphinx-7462 | vtrace-indexed | yes | unknown | 1034743 | 0.4234 | unknown | 2 | yes | sphinx/domains/python.py | partial |
| eval-pivot-telemetry-vtrace-seaborn-3187-no-pivot-check | vtrace | mwaskom__seaborn-3187 | vtrace-indexed | yes | no | 2444167 | 1.0404 | unknown | 2 | yes | seaborn/_core/scales.py, seaborn/utils.py | partial |
| eval-pivot-telemetry-vtrace-sphinx-7462 | vtrace | sphinx-doc__sphinx-7462 | vtrace-indexed | yes | unknown | 801512 | 0.3660 | unknown | 2 | no | sphinx/domains/python.py | partial |
| eval-pivot-telemetry-vtrace-sphinx-7462-r2 | vtrace | sphinx-doc__sphinx-7462 | vtrace-indexed | yes | unknown | 581546 | 0.2172 | unknown | 2 | yes | sphinx/domains/python.py | partial |
| eval-policy-11490 | vtrace | django__django-11490 | vtrace | yes | unknown | 2785410 | 1.1572 | resolved | 0 | no | django/db/models/sql/compiler.py | complete |
| eval-shaped-10880 | vtrace | django__django-10880 | vtrace-indexed | yes | unknown | 746595 | 0.2951 | resolved | ? | no | django/db/models/aggregates.py | complete |
| eval-shaped-11095 | vtrace | django__django-11095 | vtrace-indexed | yes | unknown | 597571 | 0.2367 | resolved | ? | no | django/contrib/admin/options.py | complete |
| eval-shaped-11490 | vtrace | django__django-11490 | vtrace-indexed | yes | unknown | 2886169 | 1.0425 | resolved | ? | no | django/db/models/sql/compiler.py | complete |
| eval-shaped-11728 | vtrace | django__django-11728 | vtrace-indexed | yes | unknown | 2510627 | 0.9377 | resolved | ? | no | django/contrib/admindocs/utils.py | complete |
| eval-shaped-11740 | vtrace | django__django-11740 | vtrace-indexed | yes | unknown | 1968617 | 0.7541 | resolved | ? | no | django/db/migrations/autodetector.py | complete |
| eval-sized-10880 | vtrace | django__django-10880 | vtrace-indexed | yes | unknown | 814900 | 0.3294 | resolved | ? | no | django/db/models/aggregates.py | complete |
| eval-sized-11095 | vtrace | django__django-11095 | vtrace-indexed | yes | unknown | 626914 | 0.2417 | resolved | ? | no | django/contrib/admin/options.py | complete |
| eval-sized-11490 | vtrace | django__django-11490 | vtrace-indexed | yes | unknown | 3083226 | 1.1745 | resolved | ? | no | django/db/models/sql/compiler.py | complete |
| eval-sized-11728 | vtrace | django__django-11728 | vtrace-indexed | yes | unknown | 3125235 | 1.1124 | resolved | ? | no | django/contrib/admindocs/utils.py | complete |
| eval-sized-11740 | vtrace | django__django-11740 | vtrace-indexed | yes | unknown | 2296986 | 0.8035 | resolved | ? | no | django/db/migrations/autodetector.py | complete |
| eval-sqlcompiler-force-11490 | vtrace | django__django-11490 | vtrace-indexed | yes | unknown | 2375408 | 0.8801 | resolved | 0 | no | django/db/models/sql/query.py | complete |
| eval-sqlcompiler-live-11490 | vtrace | django__django-11490 | vtrace | yes | unknown | 2493652 | 1.1061 | unknown | 0 | no | django/db/models/sql/compiler.py | partial |

## Pair inventory

| type | instance | before → after | token Δ | token Δ% | cost Δ | resolved Δ | edited-set Δ | →inspected | →edited | source |
| --- | --- | --- | ---: | ---: | ---: | :---: | :---: | ---: | ---: | --- |
| baseline_vs_vtrace | django__django-10880 | eval-10880 [baseline] → eval-10880 [vtrace] | 195451 | 45.2 | 0.0473 | resolved→resolved | no | — | — | runs/eval-10880 (baseline+vtrace conditions) |
| baseline_vs_vtrace | django__django-11095 | eval-11095 [baseline] → eval-11095 [vtrace] | 463880 | 86.5 | 0.1323 | resolved→resolved | no | — | — | runs/eval-11095 (baseline+vtrace conditions) |
| baseline_vs_vtrace | django__django-11490 | eval-11490 [baseline] → eval-11490 [vtrace] | -1360178 | -29.2 | -0.5454 | resolved→resolved | no | — | — | runs/eval-11490 (baseline+vtrace conditions) |
| baseline_vs_vtrace | django__django-11728 | eval-11728 [baseline] → eval-11728 [vtrace] | -522005 | -30.4 | -0.1420 | resolved→resolved | no | — | — | runs/eval-11728 (baseline+vtrace conditions) |
| baseline_vs_vtrace | django__django-11740 | eval-11740 [baseline] → eval-11740 [vtrace] | -537533 | -22.5 | -0.2498 | resolved→resolved | no | — | — | runs/eval-11740 (baseline+vtrace conditions) |
| pivot_check_before_after | mwaskom__seaborn-3187 | eval-pivot-telemetry-vtrace-seaborn-3187-no-pivot-check → eval-pivot-check-vtrace-seaborn-3187 | 864643 | 35.4 | 0.0754 | unknown→unknown | no | 1 | 0 | stage5_pivot_check_targeted_summary.json |
| pivot_check_before_after | sphinx-doc__sphinx-7462 | eval-pivot-telemetry-vtrace-sphinx-7462-r2 → eval-pivot-check-vtrace-sphinx-7462 | 453197 | 77.9 | 0.2063 | unknown→unknown | no | 1 | 0 | stage5_pivot_check_targeted_summary.json |

## Token and cost summary

- Total cost across runs with known cost: 51.7999 USD.
- Mean cost per run (known-cost runs): 0.6816 USD.
- Mean tokens per run (known-token runs): 1618944.
- Token/cost deltas live ONLY in the pair inventory; a standalone run's spend is not a saving or a loss without a comparable counterpart.

## Resolution summary

- Resolution known: 70 / 79 runs.
- Resolution unknown: 9 / 79 runs.
- Of the 70 EVALUATED run(s), 59 resolved. This is a resolved count over evaluated runs only — NOT a pass@1 over all runs.

## Pivot inspection summary

| run label | hidden pivots | inspected | edited | ignored |
| --- | ---: | ---: | ---: | ---: |
| eval-pivot-check-vtrace-seaborn-3187 | 1 | 1 | 0 | 0 |
| eval-pivot-check-vtrace-sphinx-7462 | 1 | 1 | 0 | 0 |
| eval-pivot-telemetry-vtrace-seaborn-3187-no-pivot-check | 1 | 0 | 0 | 1 |
| eval-pivot-telemetry-vtrace-sphinx-7462-r2 | 1 | 0 | 0 | 1 |

Inspection conversion across before/after pairs is in the pair inventory (`→inspected` / `→edited`). Engagement here is per-run and is NOT a claim about patch correctness or resolution.

## Data completeness

- complete: 70
- partial: 6
- metadata_only: 2
- missing: 1

`complete` = meta + treatment status + tokens/cost + edited files + resolution all known. `partial` = meta + some fields but resolution or ordered tool log missing. `metadata_only` = meta but no tool log and no patch/result details. `missing` = run folder present but meta absent.

## Recommended next benchmark step

- 2. Extend the 5 baseline-vs-vtrace pair(s) into a fixed 10-task controlled subset run with both conditions per instance, so token/cost/resolution deltas are comparable across a stable set.
- 3. Add a VEXP-style savings estimate ONLY where a baseline context size (or baseline token spend) is known for the same instance — never extrapolate savings from a vtrace-only run.

## Non-claims

- This ledger does not run agents, Docker, or any evaluation — it indexes existing artifacts only.
- Resolved / pass@1 is reported ONLY for runs that were actually evaluated; every other run is `unknown`, never `false`.
- A single run never proves token savings or a unique win — those require a comparable baseline/before run and live only in `pairs[]`.
- Inspection conversion, edited-file-set change, patch production, and docker resolution are SEPARATE signals and are never conflated.
- Token/cost deltas describe spend, not quality; a cheaper run is not necessarily a better run.
- Pair token/cost deltas are arithmetic over the paired runs; they are not normalized for task difficulty.

