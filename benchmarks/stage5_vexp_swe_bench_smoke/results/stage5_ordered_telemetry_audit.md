# Stage 5 ordered telemetry audit

## Summary

- Results dir: `/home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results`
- Total agent runs scanned: 110
- Ordered telemetry present: 34
- Raw stream present but not parsed: 0
- No telemetry (legacy / never captured): 76
- High-cost runs missing telemetry: 0
- Runs tripping a loop heuristic: 0

## Coverage

| run-label | condition | instance | state | ordered? | discipline |
| --- | --- | --- | --- | --- | --- |
| (flat) | baseline | django__django-11728 | none | no | — |
| (flat) | vtrace | django__django-11728 | none | no | — |
| eval-10880 | baseline | django__django-10880 | none | no | — |
| eval-10880 | vtrace | django__django-10880 | none | no | — |
| eval-11095 | baseline | django__django-11095 | none | no | — |
| eval-11095 | vtrace | django__django-11095 | none | no | — |
| eval-11490 | baseline | django__django-11490 | none | no | — |
| eval-11490 | vtrace | django__django-11490 | none | no | — |
| eval-11728 | baseline | django__django-11728 | none | no | — |
| eval-11728 | vtrace | django__django-11728 | none | no | — |
| eval-11740 | baseline | django__django-11740 | none | no | — |
| eval-11740 | vtrace | django__django-11740 | none | no | — |
| eval-baseline-vs-vtrace-baseline-astropy-14369 | baseline | astropy__astropy-14369 | none | no | — |
| eval-baseline-vs-vtrace-baseline-requests-5414 | baseline | psf__requests-5414 | none | no | — |
| eval-baseline-vs-vtrace-baseline-sympy-16766 | baseline | sympy__sympy-16766 | none | no | — |
| eval-capsulev2-auto-10880 | vtrace | django__django-10880 | none | no | — |
| eval-capsulev2-auto-11095 | vtrace | django__django-11095 | none | no | — |
| eval-capsulev2-auto-11490 | vtrace | django__django-11490 | none | no | — |
| eval-capsulev2-auto-11728 | vtrace | django__django-11728 | none | no | — |
| eval-capsulev2-auto-11740 | vtrace | django__django-11740 | none | no | — |
| eval-capsulev2-force--10880 | vtrace | django__django-10880 | none | no | — |
| eval-capsulev2-force--11095 | vtrace | django__django-11095 | none | no | — |
| eval-capsulev2-force--11490 | vtrace | django__django-11490 | none | no | — |
| eval-capsulev2-force--11728 | vtrace | django__django-11728 | none | no | — |
| eval-capsulev2-force--11740 | vtrace | django__django-11740 | none | no | — |
| eval-capsulev2-literal-11820 | vtrace | django__django-11820 | none | no | — |
| eval-capsulev2-literal-12858 | vtrace | django__django-12858 | none | no | — |
| eval-capsulev2-recovered-live-astropy-14369 | vtrace | astropy__astropy-14369 | none | no | — |
| eval-capsulev2-recovered-live-requests-5414 | vtrace | psf__requests-5414 | none | no | — |
| eval-capsulev2-recovered-live-sympy-16766 | vtrace | sympy__sympy-16766 | none | no | — |
| eval-capsulev2-risk-11490 | vtrace | django__django-11490 | none | no | — |
| eval-capsulev2-risk5-10880 | vtrace | django__django-10880 | none | no | — |
| eval-capsulev2-risk5-11095 | vtrace | django__django-11095 | none | no | — |
| eval-capsulev2-risk5-11490 | vtrace | django__django-11490 | none | no | — |
| eval-capsulev2-risk5-11728 | vtrace | django__django-11728 | none | no | — |
| eval-capsulev2-risk5-11740 | vtrace | django__django-11740 | none | no | — |
| eval-capsulev2-source-11490 | vtrace | django__django-11490 | none | no | — |
| eval-capsulev2-sqlcompiler-11490 | vtrace | django__django-11490 | none | no | — |
| eval-capsulev2-state-11820 | vtrace | django__django-11820 | none | no | — |
| eval-capsulev2-traversal-11820 | vtrace | django__django-11820 | none | no | — |
| eval-controlled-vtrace-astropy-14369 | vtrace | astropy__astropy-14369 | ordered | yes | — |
| eval-controlled-vtrace-matplotlib-22719 | vtrace | matplotlib__matplotlib-22719 | ordered | yes | — |
| eval-controlled-vtrace-requests-5414 | vtrace | psf__requests-5414 | ordered | yes | — |
| eval-controlled-vtrace-sphinx-7462 | vtrace | sphinx-doc__sphinx-7462 | ordered | yes | — |
| eval-controlled-vtrace-sympy-16766 | vtrace | sympy__sympy-16766 | ordered | yes | — |
| eval-diagnostic-10880 | vtrace | django__django-10880 | none | no | — |
| eval-diagnostic-11095 | vtrace | django__django-11095 | none | no | — |
| eval-diagnostic-11490 | vtrace | django__django-11490 | none | no | — |
| eval-diagnostic-11728 | vtrace | django__django-11728 | none | no | — |
| eval-diagnostic-11740 | vtrace | django__django-11740 | none | no | — |
| eval-diagnostic-rerun-11728 | vtrace | django__django-11728 | none | no | — |
| eval-diagnostic-rerun-11740 | vtrace | django__django-11740 | none | no | — |
| eval-editguard-after-matplotlib-22719 | vtrace | matplotlib__matplotlib-22719 | ordered | yes | — |
| eval-editguard-after-requests-5414 | vtrace | psf__requests-5414 | ordered | yes | — |
| eval-editguard-after-sympy-16766 | vtrace | sympy__sympy-16766 | ordered | yes | — |
| eval-editguard-before-matplotlib-22719 | vtrace | matplotlib__matplotlib-22719 | ordered | yes | — |
| eval-editguard-before-requests-5414 | vtrace | psf__requests-5414 | ordered | yes | — |
| eval-editguard-before-sympy-16766 | vtrace | sympy__sympy-16766 | ordered | yes | — |
| eval-fixed-10880 | vtrace | django__django-10880 | none | no | — |
| eval-fixed-11095 | vtrace | django__django-11095 | none | no | — |
| eval-fixed-11490 | vtrace | django__django-11490 | none | no | — |
| eval-fixed-11728 | vtrace | django__django-11728 | none | no | — |
| eval-fixed-11740 | vtrace | django__django-11740 | none | no | — |
| eval-localization-gap-baseline-matplotlib-22719 | baseline | matplotlib__matplotlib-22719 | none | no | — |
| eval-localization-gap-baseline-matplotlib-24627 | baseline | matplotlib__matplotlib-24627 | none | no | — |
| eval-localization-gap-baseline-sphinx-7462 | baseline | sphinx-doc__sphinx-7462 | none | no | — |
| eval-localization-gap-vtrace-matplotlib-22719 | vtrace | matplotlib__matplotlib-22719 | none | no | — |
| eval-localization-gap-vtrace-matplotlib-24627 | vtrace | matplotlib__matplotlib-24627 | none | no | — |
| eval-localization-gap-vtrace-sphinx-7462 | vtrace | sphinx-doc__sphinx-7462 | none | no | — |
| eval-locgap-multipivot-sphinx-7462 | vtrace | sphinx-doc__sphinx-7462 | none | no | — |
| eval-patchverify-after-matplotlib-22719 | vtrace | matplotlib__matplotlib-22719 | ordered | yes | — |
| eval-patchverify-after-requests-5414 | vtrace | psf__requests-5414 | ordered | yes | — |
| eval-patchverify-after-sympy-16766 | vtrace | sympy__sympy-16766 | ordered | yes | — |
| eval-patchverify-before-matplotlib-22719 | vtrace | matplotlib__matplotlib-22719 | ordered | yes | — |
| eval-patchverify-before-requests-5414 | vtrace | psf__requests-5414 | ordered | yes | — |
| eval-patchverify-before-sympy-16766 | vtrace | sympy__sympy-16766 | ordered | yes | — |
| eval-pivot-11490 | vtrace | django__django-11490 | none | no | — |
| eval-pivot-11728 | vtrace | django__django-11728 | none | no | — |
| eval-pivot-11740 | vtrace | django__django-11740 | none | no | — |
| eval-pivot-check-vtrace-seaborn-3187 | vtrace | mwaskom__seaborn-3187 | ordered | yes | — |
| eval-pivot-check-vtrace-sphinx-7462 | vtrace | sphinx-doc__sphinx-7462 | ordered | yes | — |
| eval-pivot-telemetry-vtrace-seaborn-3187-no-pivot-check | vtrace | mwaskom__seaborn-3187 | ordered | yes | — |
| eval-pivot-telemetry-vtrace-sphinx-7462-r2 | vtrace | sphinx-doc__sphinx-7462 | ordered | yes | — |
| eval-pivot-telemetry-vtrace-sphinx-7462 | vtrace | sphinx-doc__sphinx-7462 | none | no | — |
| eval-policy-11490 | vtrace | django__django-11490 | none | no | — |
| eval-riskgated-vtrace-astropy-14369 | vtrace | astropy__astropy-14369 | ordered | yes | — |
| eval-riskgated-vtrace-matplotlib-22719 | vtrace | matplotlib__matplotlib-22719 | ordered | yes | — |
| eval-riskgated-vtrace-requests-5414 | vtrace | psf__requests-5414 | ordered | yes | — |
| eval-shaped-10880 | vtrace | django__django-10880 | none | no | — |
| eval-shaped-11095 | vtrace | django__django-11095 | none | no | — |
| eval-shaped-11490 | vtrace | django__django-11490 | none | no | — |
| eval-shaped-11728 | vtrace | django__django-11728 | none | no | — |
| eval-shaped-11740 | vtrace | django__django-11740 | none | no | — |
| eval-sized-10880 | vtrace | django__django-10880 | none | no | — |
| eval-sized-11095 | vtrace | django__django-11095 | none | no | — |
| eval-sized-11490 | vtrace | django__django-11490 | none | no | — |
| eval-sized-11728 | vtrace | django__django-11728 | none | no | — |
| eval-sized-11740 | vtrace | django__django-11740 | none | no | — |
| eval-sqlcompiler-force-11490 | vtrace | django__django-11490 | none | no | — |
| eval-sqlcompiler-live-11490 | vtrace | django__django-11490 | none | no | — |
| eval-strictgated-vtrace-astropy-14369 | vtrace | astropy__astropy-14369 | ordered | yes | — |
| eval-strictgated-vtrace-django-10880 | vtrace | django__django-10880 | ordered | yes | — |
| eval-strictgated-vtrace-django-11095 | vtrace | django__django-11095 | ordered | yes | — |
| eval-strictgated-vtrace-django-11490 | vtrace | django__django-11490 | ordered | yes | — |
| eval-strictgated-vtrace-django-11728 | vtrace | django__django-11728 | ordered | yes | — |
| eval-strictgated-vtrace-django-11740 | vtrace | django__django-11740 | ordered | yes | — |
| eval-strictgated-vtrace-matplotlib-22719 | vtrace | matplotlib__matplotlib-22719 | ordered | yes | — |
| eval-strictgated-vtrace-requests-5414 | vtrace | psf__requests-5414 | ordered | yes | — |
| eval-strictgated-vtrace-sphinx-7462 | vtrace | sphinx-doc__sphinx-7462 | ordered | yes | — |
| eval-strictgated-vtrace-sympy-16766 | vtrace | sympy__sympy-16766 | ordered | yes | — |

## Missing telemetry

| run-label | condition | instance | state | reason |
| --- | --- | --- | --- | --- |
| (flat) | baseline | django__django-11728 | none | legacy-run-no-stream-json |
| (flat) | vtrace | django__django-11728 | none | legacy-run-no-stream-json |
| eval-10880 | baseline | django__django-10880 | none | legacy-run-no-stream-json |
| eval-10880 | vtrace | django__django-10880 | none | legacy-run-no-stream-json |
| eval-11095 | baseline | django__django-11095 | none | legacy-run-no-stream-json |
| eval-11095 | vtrace | django__django-11095 | none | legacy-run-no-stream-json |
| eval-11490 | baseline | django__django-11490 | none | legacy-run-no-stream-json |
| eval-11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |
| eval-11728 | baseline | django__django-11728 | none | legacy-run-no-stream-json |
| eval-11728 | vtrace | django__django-11728 | none | legacy-run-no-stream-json |
| eval-11740 | baseline | django__django-11740 | none | legacy-run-no-stream-json |
| eval-11740 | vtrace | django__django-11740 | none | legacy-run-no-stream-json |
| eval-baseline-vs-vtrace-baseline-astropy-14369 | baseline | astropy__astropy-14369 | none | legacy-run-no-stream-json |
| eval-baseline-vs-vtrace-baseline-requests-5414 | baseline | psf__requests-5414 | none | legacy-run-no-stream-json |
| eval-baseline-vs-vtrace-baseline-sympy-16766 | baseline | sympy__sympy-16766 | none | legacy-run-no-stream-json |
| eval-capsulev2-auto-10880 | vtrace | django__django-10880 | none | legacy-run-no-stream-json |
| eval-capsulev2-auto-11095 | vtrace | django__django-11095 | none | legacy-run-no-stream-json |
| eval-capsulev2-auto-11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |
| eval-capsulev2-auto-11728 | vtrace | django__django-11728 | none | legacy-run-no-stream-json |
| eval-capsulev2-auto-11740 | vtrace | django__django-11740 | none | legacy-run-no-stream-json |
| eval-capsulev2-force--10880 | vtrace | django__django-10880 | none | legacy-run-no-stream-json |
| eval-capsulev2-force--11095 | vtrace | django__django-11095 | none | legacy-run-no-stream-json |
| eval-capsulev2-force--11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |
| eval-capsulev2-force--11728 | vtrace | django__django-11728 | none | legacy-run-no-stream-json |
| eval-capsulev2-force--11740 | vtrace | django__django-11740 | none | legacy-run-no-stream-json |
| eval-capsulev2-literal-11820 | vtrace | django__django-11820 | none | legacy-run-no-stream-json |
| eval-capsulev2-literal-12858 | vtrace | django__django-12858 | none | legacy-run-no-stream-json |
| eval-capsulev2-recovered-live-astropy-14369 | vtrace | astropy__astropy-14369 | none | legacy-run-no-stream-json |
| eval-capsulev2-recovered-live-requests-5414 | vtrace | psf__requests-5414 | none | legacy-run-no-stream-json |
| eval-capsulev2-recovered-live-sympy-16766 | vtrace | sympy__sympy-16766 | none | legacy-run-no-stream-json |
| eval-capsulev2-risk-11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |
| eval-capsulev2-risk5-10880 | vtrace | django__django-10880 | none | legacy-run-no-stream-json |
| eval-capsulev2-risk5-11095 | vtrace | django__django-11095 | none | legacy-run-no-stream-json |
| eval-capsulev2-risk5-11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |
| eval-capsulev2-risk5-11728 | vtrace | django__django-11728 | none | legacy-run-no-stream-json |
| eval-capsulev2-risk5-11740 | vtrace | django__django-11740 | none | legacy-run-no-stream-json |
| eval-capsulev2-source-11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |
| eval-capsulev2-sqlcompiler-11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |
| eval-capsulev2-state-11820 | vtrace | django__django-11820 | none | legacy-run-no-stream-json |
| eval-capsulev2-traversal-11820 | vtrace | django__django-11820 | none | legacy-run-no-stream-json |
| eval-diagnostic-10880 | vtrace | django__django-10880 | none | legacy-run-no-stream-json |
| eval-diagnostic-11095 | vtrace | django__django-11095 | none | legacy-run-no-stream-json |
| eval-diagnostic-11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |
| eval-diagnostic-11728 | vtrace | django__django-11728 | none | legacy-run-no-stream-json |
| eval-diagnostic-11740 | vtrace | django__django-11740 | none | legacy-run-no-stream-json |
| eval-diagnostic-rerun-11728 | vtrace | django__django-11728 | none | legacy-run-no-stream-json |
| eval-diagnostic-rerun-11740 | vtrace | django__django-11740 | none | legacy-run-no-stream-json |
| eval-fixed-10880 | vtrace | django__django-10880 | none | legacy-run-no-stream-json |
| eval-fixed-11095 | vtrace | django__django-11095 | none | legacy-run-no-stream-json |
| eval-fixed-11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |
| eval-fixed-11728 | vtrace | django__django-11728 | none | legacy-run-no-stream-json |
| eval-fixed-11740 | vtrace | django__django-11740 | none | legacy-run-no-stream-json |
| eval-localization-gap-baseline-matplotlib-22719 | baseline | matplotlib__matplotlib-22719 | none | legacy-run-no-stream-json |
| eval-localization-gap-baseline-matplotlib-24627 | baseline | matplotlib__matplotlib-24627 | none | legacy-run-no-stream-json |
| eval-localization-gap-baseline-sphinx-7462 | baseline | sphinx-doc__sphinx-7462 | none | legacy-run-no-stream-json |
| eval-localization-gap-vtrace-matplotlib-22719 | vtrace | matplotlib__matplotlib-22719 | none | legacy-run-no-stream-json |
| eval-localization-gap-vtrace-matplotlib-24627 | vtrace | matplotlib__matplotlib-24627 | none | legacy-run-no-stream-json |
| eval-localization-gap-vtrace-sphinx-7462 | vtrace | sphinx-doc__sphinx-7462 | none | legacy-run-no-stream-json |
| eval-locgap-multipivot-sphinx-7462 | vtrace | sphinx-doc__sphinx-7462 | none | legacy-run-no-stream-json |
| eval-pivot-11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |
| eval-pivot-11728 | vtrace | django__django-11728 | none | legacy-run-no-stream-json |
| eval-pivot-11740 | vtrace | django__django-11740 | none | legacy-run-no-stream-json |
| eval-pivot-telemetry-vtrace-sphinx-7462 | vtrace | sphinx-doc__sphinx-7462 | none | legacy-run-no-stream-json |
| eval-policy-11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |
| eval-shaped-10880 | vtrace | django__django-10880 | none | legacy-run-no-stream-json |
| eval-shaped-11095 | vtrace | django__django-11095 | none | legacy-run-no-stream-json |
| eval-shaped-11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |
| eval-shaped-11728 | vtrace | django__django-11728 | none | legacy-run-no-stream-json |
| eval-shaped-11740 | vtrace | django__django-11740 | none | legacy-run-no-stream-json |
| eval-sized-10880 | vtrace | django__django-10880 | none | legacy-run-no-stream-json |
| eval-sized-11095 | vtrace | django__django-11095 | none | legacy-run-no-stream-json |
| eval-sized-11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |
| eval-sized-11728 | vtrace | django__django-11728 | none | legacy-run-no-stream-json |
| eval-sized-11740 | vtrace | django__django-11740 | none | legacy-run-no-stream-json |
| eval-sqlcompiler-force-11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |
| eval-sqlcompiler-live-11490 | vtrace | django__django-11490 | none | legacy-run-no-stream-json |

## High-cost runs missing telemetry

_None above the high-cost thresholds (≥ $0.5000 or ≥ 1,000,000 tokens)._

## Loop heuristics

_No scanned run tripped the diagnostic loop heuristics._

## Recommendations

- 76 run(s) have no ordered telemetry. These are legacy runs that never captured stream-json; future runs capture it universally — re-run them only if their tool order is needed.

## Non-claims

- This report does not re-run agents.
- This report does not infer tool order when stream-json is missing.
- Loop heuristics are diagnostic only and do not affect patch generation.
