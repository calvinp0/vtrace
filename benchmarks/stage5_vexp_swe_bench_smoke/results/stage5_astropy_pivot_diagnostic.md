# Stage 5 Astropy pivot diagnostic

## Summary

- Results dir: `/home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results`
- Instance: `astropy__astropy-14369`
- Astropy runs analyzed: 5
- Focus run: `eval-strictgated-vtrace-astropy-14369`
- Primary classification: **noisy_pivot_ranking**
- Secondary: capsule_budget_too_large, deferred_refs_underused
- Recommended next change: **#1 — Pivot ranking fix**

## Runs analyzed

| run-label | condition | resolved | telemetry | capsule tok | items | pivots | top pivot | top∈edit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eval-baseline-vs-vtrace-baseline-astropy-14369 | baseline | no | missing | — | — | — | — | — |
| eval-capsulev2-recovered-live-astropy-14369 | vtrace | yes | missing | 5086 | 2 | 2 | astropy/units/format/cds.py | — |
| eval-controlled-vtrace-astropy-14369 | vtrace | no | ordered | 5086 | 2 | 2 | astropy/units/format/cds.py | yes |
| eval-riskgated-vtrace-astropy-14369 | vtrace | no | ordered | 2772 | 4 | 2 | astropy/units/format/vounit.py | no |
| eval-strictgated-vtrace-astropy-14369 | vtrace | no | ordered | 2772 | 4 | 2 | astropy/units/format/vounit.py | no |

## Outcome and cost

| run-label | resolved | cost | tokens | source | turns/tools |
| --- | --- | --- | --- | --- | --- |
| eval-baseline-vs-vtrace-baseline-astropy-14369 | no | $1.5550 | 3,076,313 | strictgated_report | — |
| eval-capsulev2-recovered-live-astropy-14369 | yes | — | — | unavailable | — |
| eval-controlled-vtrace-astropy-14369 | no | $3.0284 | 3,365,366 | strictgated_report | bash 13 / grep 2 / read 5 |
| eval-riskgated-vtrace-astropy-14369 | no | $1.7340 | 3,649,897 | strictgated_report | bash 15 / grep 7 / read 7 |
| eval-strictgated-vtrace-astropy-14369 | no | $1.4102 | 2,508,804 | strictgated_report | bash 5 / grep 4 / read 7 |

## Pivot evidence

Focus run: `eval-strictgated-vtrace-astropy-14369` (condition `vtrace`).

- Top pivot: `astropy/units/format/vounit.py`
- All pivots: `astropy/units/format/vounit.py`, `astropy/units/format/cds.py`
- Edited file(s): `/home/calvin/code/vexp-swe-bench/.bench-repos/astropy__astropy/astropy/units/format/cds.py`
- Top pivot concentrated in edited file: no
- Pivots pointing at tests/docs/config rather than implementation: none

Cross-run top-pivot ordering (resolved vs unresolved):

| run-label | resolved | top pivot | top∈edit |
| --- | --- | --- | --- |
| eval-capsulev2-recovered-live-astropy-14369 | yes | astropy/units/format/cds.py | — |
| eval-controlled-vtrace-astropy-14369 | no | astropy/units/format/cds.py | yes |
| eval-riskgated-vtrace-astropy-14369 | no | astropy/units/format/vounit.py | no |
| eval-strictgated-vtrace-astropy-14369 | no | astropy/units/format/vounit.py | no |

Caveat: the ordering↔outcome relationship is correlational, not proven causal. Among the Astropy runs, top-pivot ordering co-varies with outcome but at least one run with a different/better top pivot still failed (and/or one resolved), so good ordering appears necessary-but-not-sufficient.

## Capsule budget evidence

| run-label | capsule tok | budget | items | snippet tok* | largest snippet | largest tok* |
| --- | --- | --- | --- | --- | --- | --- |
| eval-baseline-vs-vtrace-baseline-astropy-14369 | — | — | — | — | — | — |
| eval-capsulev2-recovered-live-astropy-14369 | 5086 | 8000 | 2 | 2740 | astropy/units/format/cds.py | 2536 |
| eval-controlled-vtrace-astropy-14369 | 5086 | 8000 | 2 | 2553 | astropy/units/format/cds.py | 2536 |
| eval-riskgated-vtrace-astropy-14369 | 2772 | 8000 | 4 | 2482 | astropy/units/format/vounit.py | 2191 |
| eval-strictgated-vtrace-astropy-14369 | 2772 | 8000 | 4 | 2482 | astropy/units/format/vounit.py | 2191 |

Strict 10-task-set medians (n=10): capsule tokens 1152.5, items 6, deferred refs 4. Threshold for "too large": 2000 tokens.
Focus Capsule is 2.41× the strict-set median capsule-token count.

\* snippet token figures are char-derived heuristics, not measured tokens.

## Deferred reference evidence

| run-label | deferred refs | deferred paths | expanded |
| --- | --- | --- | --- |
| eval-baseline-vs-vtrace-baseline-astropy-14369 | — | — | — |
| eval-capsulev2-recovered-live-astropy-14369 | 0 | — | — |
| eval-controlled-vtrace-astropy-14369 | 0 | — | 0 |
| eval-riskgated-vtrace-astropy-14369 | 2 | astropy/units/format/cds.py, astropy/coordinates/matching.py | 0 |
| eval-strictgated-vtrace-astropy-14369 | 2 | astropy/units/format/cds.py, astropy/coordinates/matching.py | 0 |

Focus run has 2 deferred ref(s) vs strict-set median 4.

## Tool-loop evidence

Focus run `eval-strictgated-vtrace-astropy-14369` ordered telemetry:

- bashToolCalls: 5
- grepLikeToolCalls: 4
- fileReadToolCalls: 7
- longBashLoopHeuristic: no
- repeatedSearchHeuristic: no

## Classification

- Primary issue: **noisy_pivot_ranking**
- Secondary issues: capsule_budget_too_large, deferred_refs_underused
- Top pivot `astropy/units/format/vounit.py` is not in the eventually edited file(s) [/home/calvin/code/vexp-swe-bench/.bench-repos/astropy__astropy/astropy/units/format/cds.py].
- Capsule budget 2772 tokens exceeds 2000.
- Deferred refs 2 below strict-set median 4.

## Recommended next change

**#1 — Pivot ranking fix**

Prefer implementation pivots that are referenced by multiple evidence types and down-rank broad/noisy paths, so the eventually-edited file is not demoted below an unrelated, large-snippet candidate.

## Non-claims

- This report does not re-run agents or Docker.
- This report does not change retrieval, ranking, Capsule generation, or prompt behavior.
- This report does not prove Astropy is representative of all noisy retrieval failures.
- Missing telemetry is reported as missing, not reconstructed.
- Per-snippet token figures are char-derived heuristics; only each Capsule's own budget line is treated as an authoritative token count.
