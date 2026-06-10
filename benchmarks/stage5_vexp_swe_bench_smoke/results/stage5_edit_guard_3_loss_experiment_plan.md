# Stage 5 EDIT_GUARD 3-loss experiment plan

_Generated: 2026-06-10T08:13:46.716Z_

_Planning / reporting only. No agents, no Docker, no retrieval / PIVOT_CHECK / telemetry changes. Emits a fixed before/after experiment for the three controlled-pilot VTRACE losses; computes nothing until the runs exist._

## Summary

- Cases: 3 controlled-pilot VTRACE losses (all `patch_mistake_despite_good_context`).
- Two conditions per case (6 runs total):
  - **before** = PIVOT_CHECK only (`--disable-edit-guard`).
  - **after** = PIVOT_CHECK + EDIT_GUARD (default).
- Run commands: 6. Evaluation commands: 6.
- Isolates the **incremental** effect of EDIT_GUARD: PIVOT_CHECK is ON in both conditions; `--disable-pivot-check` is never used.

## Why these cases

All three were VTRACE losses in the controlled 10-task pilot, and the loss analysis classified each as `patch_mistake_despite_good_context`: correct file/context, wrong edit. EDIT_GUARD was designed for exactly this failure mode, so these are the natural cases to test its incremental effect.

| instance | repo | known loss | before label | after label | reason included |
| --- | --- | --- | --- | --- | --- |
| sympy__sympy-16766 | sympy | patch_mistake_despite_good_context | eval-editguard-before-sympy-16766 | eval-editguard-after-sympy-16766 | wrong class scope — new printer methods landed in AbstractPythonCodePrinter instead of PythonCodePrinter; targeted by EDIT_GUARD's SCOPE (confirm the exact enclosing class/function before inserting methods) |
| matplotlib__matplotlib-22719 | matplotlib | patch_mistake_despite_good_context | eval-editguard-before-matplotlib-22719 | eval-editguard-after-matplotlib-22719 | incomplete fix — narrowed a warning guard but missed the baseline's early return for empty arrays; targeted by EDIT_GUARD's FAILING BEHAVIOR (name the concrete failing input — the empty array — and verify the patch handles it) |
| psf__requests-5414 | psf | patch_mistake_despite_good_context | eval-editguard-before-requests-5414 | eval-editguard-after-requests-5414 | broad control-flow rewrite — always-IDNA-encode restructure instead of minimal additive empty-label validation; targeted by EDIT_GUARD's MINIMAL FIX (prefer the smallest additive guard/validation over a control-flow rewrite) |

## Experimental design

For each case, run two VTRACE conditions that differ ONLY in the edit guard:

- **A. PIVOT_CHECK only** — add `--disable-edit-guard` (PIVOT_CHECK still injects).
- **B. PIVOT_CHECK + EDIT_GUARD** — default (EDIT_GUARD rides after PIVOT_CHECK).

Both conditions share the current normal protocol:

```text
--protocol vtrace-indexed
--context-policy force-inject
--capsule-engine v2
--capsule-intent debug
--capsule-budget 8000
```

`--disable-pivot-check` is NOT used: this experiment measures the effect of EDIT_GUARD on top of PIVOT_CHECK, not the effect of PIVOT_CHECK.

## Run commands

**sympy__sympy-16766 — before** (`eval-editguard-before-sympy-16766`, PIVOT_CHECK only):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-16766 \
  --run-label eval-editguard-before-sympy-16766 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --disable-edit-guard \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**sympy__sympy-16766 — after** (`eval-editguard-after-sympy-16766`, PIVOT_CHECK + EDIT_GUARD):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-16766 \
  --run-label eval-editguard-after-sympy-16766 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**matplotlib__matplotlib-22719 — before** (`eval-editguard-before-matplotlib-22719`, PIVOT_CHECK only):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances matplotlib__matplotlib-22719 \
  --run-label eval-editguard-before-matplotlib-22719 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --disable-edit-guard \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**matplotlib__matplotlib-22719 — after** (`eval-editguard-after-matplotlib-22719`, PIVOT_CHECK + EDIT_GUARD):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances matplotlib__matplotlib-22719 \
  --run-label eval-editguard-after-matplotlib-22719 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**psf__requests-5414 — before** (`eval-editguard-before-requests-5414`, PIVOT_CHECK only):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances psf__requests-5414 \
  --run-label eval-editguard-before-requests-5414 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --disable-edit-guard \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**psf__requests-5414 — after** (`eval-editguard-after-requests-5414`, PIVOT_CHECK + EDIT_GUARD):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances psf__requests-5414 \
  --run-label eval-editguard-after-requests-5414 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

## Evaluation commands

After the six runs complete, Docker-evaluate every produced label:

**sympy__sympy-16766** (`eval-editguard-before-sympy-16766`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-16766 \
  --run-label eval-editguard-before-sympy-16766 \
  --eval-mode docker \
  --eval-dataset swebench-verified-full.jsonl \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**sympy__sympy-16766** (`eval-editguard-after-sympy-16766`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-16766 \
  --run-label eval-editguard-after-sympy-16766 \
  --eval-mode docker \
  --eval-dataset swebench-verified-full.jsonl \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**matplotlib__matplotlib-22719** (`eval-editguard-before-matplotlib-22719`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances matplotlib__matplotlib-22719 \
  --run-label eval-editguard-before-matplotlib-22719 \
  --eval-mode docker \
  --eval-dataset swebench-verified-full.jsonl \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**matplotlib__matplotlib-22719** (`eval-editguard-after-matplotlib-22719`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances matplotlib__matplotlib-22719 \
  --run-label eval-editguard-after-matplotlib-22719 \
  --eval-mode docker \
  --eval-dataset swebench-verified-full.jsonl \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**psf__requests-5414** (`eval-editguard-before-requests-5414`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances psf__requests-5414 \
  --run-label eval-editguard-before-requests-5414 \
  --eval-mode docker \
  --eval-dataset swebench-verified-full.jsonl \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**psf__requests-5414** (`eval-editguard-after-requests-5414`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances psf__requests-5414 \
  --run-label eval-editguard-after-requests-5414 \
  --eval-mode docker \
  --eval-dataset swebench-verified-full.jsonl \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

## Expected comparison after completion

Once all six runs and evaluations exist, generate an EDIT_GUARD comparison report that measures, per case (before vs after):

- resolved before vs after (Docker `resolved`).
- patch file differences (edited-file set and the diff itself).
- token/cost deltas (after − before).
- edit guard metadata: `vtraceEditGuardInjected` / `vtraceEditGuardTextPresent` (after only).
- whether the known patch defect was fixed (per-case: class scope / empty-array handling / minimal additive validation).
- whether context inspection stayed stable (pivots inspected, hidden-pivot engagement unchanged).

**None of these are computed here.** They require the six runs and Docker evaluations to exist first; this plan only enumerates the work.

## Non-claims

- This is a 3-case before/after experiment plan, not a statistically powered benchmark.
- It isolates the INCREMENTAL effect of EDIT_GUARD only: PIVOT_CHECK stays on in BOTH conditions (--disable-pivot-check is never used).
- It does not claim EDIT_GUARD fixes these losses — that is the hypothesis the runs will test.
- It does not compare against VEXP or baseline; both conditions are VTRACE-indexed.
- It computes NO resolved/token/cost deltas here — those require the six runs and Docker evaluations to exist first.
- It runs no agents and no Docker.

