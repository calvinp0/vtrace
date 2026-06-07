# Stage 5 Capsule v2 force-inject validation

_Generated: 2026-06-07T13:37:28.925Z_

## Scope

Stage 5 Capsule v2 five-task force-inject validation on the Django SWE-bench smoke set.

## Protocol

vtrace-indexed protocol with forced Capsule v2 injection (--protocol vtrace-indexed --context-policy force-inject --capsule-engine v2 --capsule-intent debug --capsule-budget 8000). Baseline is the identical `run --no-vexp` command with no vtrace context injected.

## Instance set

- django__django-10880
- django__django-11095
- django__django-11490
- django__django-11728
- django__django-11740

## Fresh-index evidence

Each Capsule v2 run reindexed a fresh workspace before the live agent ran. Index start/finish timestamps and durations come from each run's `_run.meta.json`.

| instance | fresh workspace | index started | index finished | index duration (s) |
| --- | --- | --- | --- | ---: |
| django__django-10880 | yes | 2026-06-07T10:47:40.179Z | 2026-06-07T11:12:43.139Z | 1503.0 |
| django__django-11095 | yes | 2026-06-07T11:15:51.634Z | 2026-06-07T11:41:48.854Z | 1557.2 |
| django__django-11490 | yes | 2026-06-07T11:46:31.490Z | 2026-06-07T12:12:13.153Z | 1541.7 |
| django__django-11728 | yes | 2026-06-07T12:21:31.737Z | 2026-06-07T12:47:46.071Z | 1574.3 |
| django__django-11740 | yes | 2026-06-07T12:55:52.584Z | 2026-06-07T13:22:02.577Z | 1570.0 |

## Capsule v2 metadata

| instance | engine | intent | budget | est tok | mode | top pivot file | top pivot symbol | pivot source | source chars | source mode | edit-risk directive | policy override |
| --- | --- | --- | ---: | ---: | --- | --- | --- | --- | ---: | --- | --- | --- |
| django__django-10880 | v2 | debug | 8000 | 489 | standard | django/db/models/query.py | count | yes | 410 | full | no | force-inject |
| django__django-11095 | v2 | debug | 8000 | 731 | standard | django/contrib/admin/options.py | get_inline_formsets | yes | 1160 | full | no | force-inject |
| django__django-11490 | v2 | debug | 8000 | 1148 | standard | django/db/models/sql/compiler.py | get_combinator_sql | yes | 2849 | full | yes | force-inject |
| django__django-11728 | v2 | debug | 8000 | 1220 | standard | django/contrib/admindocs/utils.py | replace_named_groups | yes | 1563 | full | no | force-inject |
| django__django-11740 | v2 | debug | 8000 | 2842 | standard | django/db/migrations/autodetector.py | _get_dependencies_for_foreign_key | yes | 879 | full | no | force-inject |

### Snapshot path / SHA per instance

| instance | snapshot present | snapshot sha256 | snapshot path |
| --- | --- | --- | --- |
| django__django-10880 | yes | dde84da62e6f1c3f2a4e8657a759cbf0e782f91ea4209f8162456b172226badc | /home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results/runs/eval-capsulev2-risk5-10880/_vtrace_instructions.snapshot.md |
| django__django-11095 | yes | 6e55d1035adb3f07d7afd75d5d9ce265e561285a7f78739537db726b6d129d56 | /home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results/runs/eval-capsulev2-risk5-11095/_vtrace_instructions.snapshot.md |
| django__django-11490 | yes | 8ab88210fcaf790fb2baf39bd1f16dd33157e328dd593d57c7c83bdd5da2997d | /home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results/runs/eval-capsulev2-risk5-11490/_vtrace_instructions.snapshot.md |
| django__django-11728 | yes | 0e0267f65a2c98743b61ea09357bf3c095127b557e93ff781f31a4a740030b28 | /home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results/runs/eval-capsulev2-risk5-11728/_vtrace_instructions.snapshot.md |
| django__django-11740 | yes | 76754f77e4f8f256ecbec8d30867876669b7f1608dc9530bc467bec841c2cc72 | /home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results/runs/eval-capsulev2-risk5-11740/_vtrace_instructions.snapshot.md |

## Resolution

| instance | baseline resolved | capsule-v2 resolved | treatment valid | injection observed |
| --- | --- | --- | --- | --- |
| django__django-10880 | True | True | yes | yes |
| django__django-11095 | True | True | yes | yes |
| django__django-11490 | True | True | yes | yes |
| django__django-11728 | True | True | yes | yes |
| django__django-11740 | True | True | yes | yes |

## Token / cost / duration comparison

| instance | baseline tok | capsule tok | token reduction | cost reduction | duration reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| django__django-10880 | 432600 | 385653 | 10.85% | 13.46% | 26.60% |
| django__django-11095 | 535997 | 646809 | -20.67% | -22.10% | -32.86% |
| django__django-11490 | 4661640 | 1088993 | 76.64% | 69.40% | 61.97% |
| django__django-11728 | 1716132 | 909044 | 47.03% | 40.26% | 23.07% |
| django__django-11740 | 2387415 | 697287 | 70.79% | 67.99% | 57.08% |

## Aggregate metrics

- Resolved baseline: 5/5
- Resolved capsule-v2: 5/5
- Mean per-task token reduction: 36.93%
- Pooled token reduction: 61.70%
- Pooled cost reduction: 54.61%
- Pooled duration reduction: 44.52%

## Caveats / non-claims

- This validation used forced Capsule v2 injection (--context-policy force-inject), not the auto context policy.
- This validation used five Django SWE-bench smoke instances only.
- This is NOT a public SWE-bench pass@1 claim.
- This is NOT a claim that vtrace beats vexp.
- This measures whether Capsule v2 context can preserve resolution while reducing live agent effort on this fixed smoke set.

