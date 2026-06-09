# Stage 5 controlled 10-task benchmark plan

_Generated: 2026-06-09T21:43:25.767Z_

_Planning / reporting only. No agents, no Docker, no retrieval / PIVOT_CHECK / telemetry changes. Proposes a fixed, defensible controlled subset; computes nothing for runs that do not yet exist._

## Summary

- Target size: 10 tasks (each run in baseline AND VTRACE).
- Existing controlled pairs preserved (same-label): 5.
- Additional tasks selected: 5.
- Completed cross-label controlled pairs recognized: 5.
- Total tasks in subset: 10.
- Repositories represented: 6 (astropy, django, matplotlib, psf, sphinx-doc, sympy).
- Currently comparable pairs (controlled now): 10.
- Comparable pairs after completion: 10.
- Missing runs to execute: 0 (0 baseline, 0 VTRACE).

## Existing comparable pairs

These already ran baseline + VTRACE under one run label and are controlled as-is:

| instance | repo | run label | baseline | VTRACE |
| --- | --- | --- | :---: | :---: |
| django__django-10880 | django | eval-10880 | resolved | resolved |
| django__django-11095 | django | eval-11095 | resolved | resolved |
| django__django-11490 | django | eval-11490 | resolved | resolved |
| django__django-11728 | django | eval-11728 | resolved | resolved |
| django__django-11740 | django | eval-11740 | resolved | resolved |

_(All five existing pairs are django — the additional tasks below add repository diversity.)_

## Selected additional tasks

| instance | repo | baseline run (reuse) | VTRACE run | base res | vtrace res | status | reason |
| --- | --- | --- | --- | :---: | :---: | --- | --- |
| astropy__astropy-14369 | astropy | eval-baseline-vs-vtrace-baseline-astropy-14369 | eval-controlled-vtrace-astropy-14369 | unresolved | unresolved | complete (cross-label pair) | completed controlled pair across separate run labels (reused baseline ↔ controlled VTRACE run), matched by instanceId |
| matplotlib__matplotlib-22719 | matplotlib | eval-localization-gap-baseline-matplotlib-22719 | eval-controlled-vtrace-matplotlib-22719 | resolved | unresolved | complete (cross-label pair) | completed controlled pair across separate run labels (reused baseline ↔ controlled VTRACE run), matched by instanceId |
| psf__requests-5414 | psf | eval-baseline-vs-vtrace-baseline-requests-5414 | eval-controlled-vtrace-requests-5414 | resolved | unresolved | complete (cross-label pair) | completed controlled pair across separate run labels (reused baseline ↔ controlled VTRACE run), matched by instanceId |
| sphinx-doc__sphinx-7462 | sphinx-doc | eval-localization-gap-baseline-sphinx-7462 | eval-controlled-vtrace-sphinx-7462 | unresolved | unresolved | complete (cross-label pair) | completed controlled pair across separate run labels (reused baseline ↔ controlled VTRACE run), matched by instanceId |
| sympy__sympy-16766 | sympy | eval-baseline-vs-vtrace-baseline-sympy-16766 | eval-controlled-vtrace-sympy-16766 | resolved | unresolved | complete (cross-label pair) | completed controlled pair across separate run labels (reused baseline ↔ controlled VTRACE run), matched by instanceId |

Tasks marked **complete (cross-label pair)** already ran the controlled VTRACE condition under a separate run label (both labels shown); their resolutions are evaluated measurements. For tasks that still **need a controlled VTRACE run**, the per-condition resolution shown is SELECTION EVIDENCE from existing runs, not a controlled measurement.

## Completed controlled pilot

All 10 selected tasks are now controlled (5 same-label, 5 cross-label). Per-pair measurements (token/cost Δ are VTRACE − baseline):

| instance | repo | scope | baseline label | vtrace label | base res | vtrace res | base tok | vtrace tok | tok Δ | tok Δ% | base $ | vtrace $ | $ Δ | $ Δ% | outcome |
| --- | --- | --- | --- | --- | :---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| django__django-10880 | django | same-label | eval-10880 | eval-10880 | resolved | resolved | 432600 | 628051 | +195451 | +45.2 | 0.2088 | 0.2561 | +0.0473 | +22.6 | tie (both resolved) |
| django__django-11095 | django | same-label | eval-11095 | eval-11095 | resolved | resolved | 535997 | 999877 | +463880 | +86.5 | 0.2230 | 0.3553 | +0.1323 | +59.3 | tie (both resolved) |
| django__django-11490 | django | same-label | eval-11490 | eval-11490 | resolved | resolved | 4661640 | 3301462 | -1360178 | -29.2 | 1.6256 | 1.0802 | -0.5454 | -33.5 | tie (both resolved) |
| django__django-11728 | django | same-label | eval-11728 | eval-11728 | resolved | resolved | 1716132 | 1194127 | -522005 | -30.4 | 0.7336 | 0.5916 | -0.1420 | -19.4 | tie (both resolved) |
| django__django-11740 | django | same-label | eval-11740 | eval-11740 | resolved | resolved | 2387415 | 1849882 | -537533 | -22.5 | 0.9119 | 0.6621 | -0.2498 | -27.4 | tie (both resolved) |
| astropy__astropy-14369 | astropy | cross-label | eval-baseline-vs-vtrace-baseline-astropy-14369 | eval-controlled-vtrace-astropy-14369 | unresolved | unresolved | 3076313 | 3365366 | +289053 | +9.4 | 1.5550 | 3.0284 | +1.4734 | +94.7 | tie (both unresolved) |
| matplotlib__matplotlib-22719 | matplotlib | cross-label | eval-localization-gap-baseline-matplotlib-22719 | eval-controlled-vtrace-matplotlib-22719 | resolved | unresolved | 1167993 | 2718398 | +1550405 | +132.7 | 0.4638 | 0.9627 | +0.4989 | +107.6 | VTRACE loss |
| psf__requests-5414 | psf | cross-label | eval-baseline-vs-vtrace-baseline-requests-5414 | eval-controlled-vtrace-requests-5414 | resolved | unresolved | 736898 | 956785 | +219887 | +29.8 | 0.4726 | 0.4065 | -0.0660 | -14.0 | VTRACE loss |
| sphinx-doc__sphinx-7462 | sphinx-doc | cross-label | eval-localization-gap-baseline-sphinx-7462 | eval-controlled-vtrace-sphinx-7462 | unresolved | unresolved | 627263 | 638586 | +11323 | +1.8 | 0.2651 | 0.2895 | +0.0244 | +9.2 | tie (both unresolved) |
| sympy__sympy-16766 | sympy | cross-label | eval-baseline-vs-vtrace-baseline-sympy-16766 | eval-controlled-vtrace-sympy-16766 | resolved | unresolved | 1414441 | 1422447 | +8006 | +0.6 | 0.5185 | 0.5765 | +0.0580 | +11.2 | VTRACE loss |

### Pilot-level summary

- Paired tasks: 10 (5 same-label + 5 cross-label).
- Baseline resolved: 8 / 10.
- VTRACE resolved: 5 / 10.
- Ties resolved: 5; ties unresolved: 2.
- VTRACE wins: 0; VTRACE losses: 3; unknown: 0.
- Mean baseline cost: 0.6978 USD; mean VTRACE cost: 0.8209 USD; mean cost Δ: +0.1231 USD.
- Mean baseline tokens: 1675669; mean VTRACE tokens: 1707498; mean token Δ: +31829.

This is an opportunistic 10-task controlled pilot — NOT a pass@1 over SWE-bench, NOT a VEXP comparison, and too small for a statistically powered claim. Cost/token deltas describe spend, not quality.

## Missing runs to execute

_No missing runs — every selected task is already controlled._

## Selection rationale

- **Preserve the 5 existing pairs** (principle 1): they are already controlled and need no new runs.
- **Add reusable tasks** (principle 2): each additional task already has a baseline run (protocol-stable, reused) and existing VTRACE evidence, minimizing new runs to one controlled VTRACE run per task.
- **Repository diversity** (principle 3): the 5 django pairs are widened with distinct repositories so the subset is not django-only.
- **Known resolution preferred** (principle 4): candidates with a known Docker resolution in at least one condition are ranked first.
- **Promoted precheck candidate included** (principle 5): at least one promoted live-capsule hidden-pivot candidate is included where it does not distort the subset.
- **No cherry-picking** (principles 6–7): the additional set deliberately mixes outcomes (apparent win, apparent loss, ties, and unresolved) and is not limited to VTRACE wins or easy/resolved tasks.
- **Opportunistic, not stratified** (principle 8): this reuses whatever existing condition data is available; it is a controlled PILOT, not a statistically representative sample.

## Run commands

_No commands — the subset is already controlled._

## Limitations

- This is an OPPORTUNISTIC pilot: it reuses existing, heterogeneously-produced condition data rather than drawing a fresh stratified sample.
- The 5 preserved pairs are all django; repository diversity comes only from the 5 additional tasks.
- Reused baselines were produced at earlier commits; if baseline harness behavior has changed materially, a baseline re-run may be needed for strict control.
- Existing per-condition resolution is selection evidence only and may not reproduce under the controlled re-run.
- 10 tasks is too few for a statistically powered claim; it is a measurement-workflow pilot.

## Non-claims

- This 10-task plan is a pilot controlled subset, not a statistically powered SWE-bench claim.
- It does not claim VTRACE beats VEXP.
- It does not claim pass@1 until all selected runs are evaluated.
- It does not claim token savings without a same-instance baseline comparison.
- It does not run agents or Docker.

