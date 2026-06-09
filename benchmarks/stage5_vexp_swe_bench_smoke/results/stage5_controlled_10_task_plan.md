# Stage 5 controlled 10-task benchmark plan

_Generated: 2026-06-09T19:41:26.043Z_

_Planning / reporting only. No agents, no Docker, no retrieval / PIVOT_CHECK / telemetry changes. Proposes a fixed, defensible controlled subset; computes nothing for runs that do not yet exist._

## Summary

- Target size: 10 tasks (each run in baseline AND VTRACE).
- Existing controlled pairs preserved: 5.
- Additional tasks selected: 5.
- Total tasks in subset: 10.
- Repositories represented: 6 (astropy, django, matplotlib, psf, sphinx-doc, sympy).
- Currently comparable pairs (controlled now): 5.
- Comparable pairs after completion: 10.
- Missing runs to execute: 5 (0 baseline, 5 VTRACE).

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

| instance | repo | baseline run (reuse) | existing VTRACE | base res | vtrace res | reason |
| --- | --- | --- | --- | :---: | :---: | --- |
| astropy__astropy-14369 | astropy | eval-baseline-vs-vtrace-baseline-astropy-14369 | eval-capsulev2-recovered-live-astropy-14369 | unresolved | resolved | repository diversity (astropy); reusable existing baseline run; existing VTRACE evidence; existing VTRACE resolved where baseline did not (apparent win); promoted live-capsule precheck candidate |
| sympy__sympy-16766 | sympy | eval-baseline-vs-vtrace-baseline-sympy-16766 | eval-capsulev2-recovered-live-sympy-16766 | resolved | resolved | repository diversity (sympy); reusable existing baseline run; existing VTRACE evidence; both existing conditions resolved (tie); promoted live-capsule precheck candidate |
| matplotlib__matplotlib-22719 | matplotlib | eval-localization-gap-baseline-matplotlib-22719 | eval-localization-gap-vtrace-matplotlib-22719 | resolved | resolved | repository diversity (matplotlib); reusable existing baseline run; existing VTRACE evidence; both existing conditions resolved (tie) |
| psf__requests-5414 | psf | eval-baseline-vs-vtrace-baseline-requests-5414 | eval-capsulev2-recovered-live-requests-5414 | resolved | unresolved | repository diversity (psf); reusable existing baseline run; existing VTRACE evidence; existing baseline resolved where VTRACE did not (apparent loss) |
| sphinx-doc__sphinx-7462 | sphinx-doc | eval-localization-gap-baseline-sphinx-7462 | eval-localization-gap-vtrace-sphinx-7462 | unresolved | unresolved | repository diversity (sphinx-doc); reusable existing baseline run; existing VTRACE evidence; both existing conditions unresolved |

Per-condition resolution above is SELECTION EVIDENCE from existing runs, not a controlled measurement — the VTRACE condition is re-run under the current normal protocol before any delta is computed.

## Missing runs to execute

| instance | condition | run label | why |
| --- | --- | --- | --- |
| astropy__astropy-14369 | vtrace | eval-controlled-vtrace-astropy-14369 | existing VTRACE data is from a non-controlled label/config; re-run under the current normal protocol |
| sympy__sympy-16766 | vtrace | eval-controlled-vtrace-sympy-16766 | existing VTRACE data is from a non-controlled label/config; re-run under the current normal protocol |
| matplotlib__matplotlib-22719 | vtrace | eval-controlled-vtrace-matplotlib-22719 | existing VTRACE data is from a non-controlled label/config; re-run under the current normal protocol |
| psf__requests-5414 | vtrace | eval-controlled-vtrace-requests-5414 | existing VTRACE data is from a non-controlled label/config; re-run under the current normal protocol |
| sphinx-doc__sphinx-7462 | vtrace | eval-controlled-vtrace-sphinx-7462 | existing VTRACE data is from a non-controlled label/config; re-run under the current normal protocol |

Total: 5 run(s) — 0 baseline, 5 VTRACE. Existing baselines are reused (baseline behavior is protocol-independent), so the VTRACE re-runs are the bulk of the work.

## Selection rationale

- **Preserve the 5 existing pairs** (principle 1): they are already controlled and need no new runs.
- **Add reusable tasks** (principle 2): each additional task already has a baseline run (protocol-stable, reused) and existing VTRACE evidence, minimizing new runs to one controlled VTRACE run per task.
- **Repository diversity** (principle 3): the 5 django pairs are widened with distinct repositories so the subset is not django-only.
- **Known resolution preferred** (principle 4): candidates with a known Docker resolution in at least one condition are ranked first.
- **Promoted precheck candidate included** (principle 5): at least one promoted live-capsule hidden-pivot candidate is included where it does not distort the subset.
- **No cherry-picking** (principles 6–7): the additional set deliberately mixes outcomes (apparent win, apparent loss, ties, and unresolved) and is not limited to VTRACE wins or easy/resolved tasks.
- **Opportunistic, not stratified** (principle 8): this reuses whatever existing condition data is available; it is a controlled PILOT, not a statistically representative sample.

## Expected metrics after completion

Once the missing runs are executed and evaluated, the outcome ledger can report over the fixed subset:

- 10 paired tasks (baseline + VTRACE per instance).
- Baseline resolved count and VTRACE resolved count.
- Wins / losses / ties (per-instance resolution comparison).
- Cost per task by condition; token use by condition.
- Token/cost deltas (VTRACE − baseline) per task and aggregated.
- Unique VTRACE wins (VTRACE resolved where baseline did not) and unique VTRACE losses (the reverse).

**None of these are computed here.** They require the missing runs to be executed and evaluated first; this plan only enumerates the work.

## Run commands

Run each missing condition, then re-run the outcome ledger to materialize the pairs:

**astropy__astropy-14369 — vtrace** (`eval-controlled-vtrace-astropy-14369`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances astropy__astropy-14369 \
  --run-label eval-controlled-vtrace-astropy-14369 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**sympy__sympy-16766 — vtrace** (`eval-controlled-vtrace-sympy-16766`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-16766 \
  --run-label eval-controlled-vtrace-sympy-16766 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**matplotlib__matplotlib-22719 — vtrace** (`eval-controlled-vtrace-matplotlib-22719`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances matplotlib__matplotlib-22719 \
  --run-label eval-controlled-vtrace-matplotlib-22719 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**psf__requests-5414 — vtrace** (`eval-controlled-vtrace-requests-5414`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances psf__requests-5414 \
  --run-label eval-controlled-vtrace-requests-5414 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**sphinx-doc__sphinx-7462 — vtrace** (`eval-controlled-vtrace-sphinx-7462`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sphinx-doc__sphinx-7462 \
  --run-label eval-controlled-vtrace-sphinx-7462 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

After all runs complete:

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_outcome_ledger.ts \
  --results benchmarks/stage5_vexp_swe_bench_smoke/results \
  --out-name stage5_outcome_ledger
```

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

