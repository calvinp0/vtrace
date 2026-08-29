# M183 — grader contract

Frozen before any M183 live run existed. §60/§88/§89.

## Authority

SWE-bench resolution comes from the official Docker grading path and from
nothing else:

    bun run_stage5_vexp_swe_bench_smoke.ts --mode evaluate --eval-mode docker \
      --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
      --run-label <label> --swe-bench-data <dataset> --eval-dataset <dataset>

writing `raw/<condition>/_eval.meta.json` with `resolvedCount` and
`evaluationRan`, and mutating `resolved` on the result row in place.

`TMPDIR` is redirected to disk. M173 exhausted the 32G `/tmp` tmpfs's INODES
mid-sweep — free bytes still looked healthy — and four runs died with ENOSPC
before their agent spawned (§30).

## Resolution requires ALL of FAIL_TO_PASS to pass

A partially-correct patch reports `resolved = 0`. This is the benchmark's rule,
not a threshold M183 chose.

## What may NOT decide a grade

- the agent saying it fixed the issue
- tests the agent chose to run passing
- the patch looking correct
- the orientation packet's focus being the gold file

The last is the one this milestone must be careful about: gold-file localization
is an explanatory diagnostic and is computed **after** grading, from artifacts
grading never reads (§52/§88/§147).

## Grading runs after the sweep

Gold patches are not inspected while live tasks remain pending (§86). Grading is
post-hoc, touches nothing the run protocol froze, and its inputs — the extracted
`modelPatch` per arm — are sealed with a hash before any gold analysis begins
(§85).

## Reproducibility

Preserved per arm: the grader command, `_eval.meta.json`, the dataset path and
hash, the patch hash, and the failure reason where the harness reports one (§89).
