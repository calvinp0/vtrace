# Stage 5 PATCH_VERIFY 3-loss experiment plan

_Generated: 2026-06-10T11:23:47.953Z_

_Planning / reporting only. No agents, no Docker, no retrieval / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / telemetry changes. Emits exact commands for a fixed before/after experiment; computes nothing until the runs exist._

## Summary

- Cases: 3 known VTRACE losses (all `patch_mistake_despite_good_context`).
- Two conditions per case (6 runs total):
  - **before** = PIVOT_CHECK only (`--disable-edit-guard --disable-patch-verify`).
  - **after** = PIVOT_CHECK + PATCH_VERIFY (`--disable-edit-guard`).
- Run commands: 6. Evaluation commands: 6.
- PIVOT_CHECK remains enabled in both conditions; `--disable-pivot-check` is never used.
- EDIT_GUARD remains disabled in both conditions, isolating PATCH_VERIFY directly.

## Why these cases

These are the same three known loss cases used in the EDIT_GUARD experiment. EDIT_GUARD increased cost/tokens and converted none of them, so the clean next test isolates PATCH_VERIFY against PIVOT_CHECK only.

| instance | repo | known loss | before label | after label | reason included |
| --- | --- | --- | --- | --- | --- |
| sympy__sympy-16766 | sympy | patch_mistake_despite_good_context | eval-patchverify-before-sympy-16766 | eval-patchverify-after-sympy-16766 | Known unresolved VTRACE loss after EDIT_GUARD; patch defect was new printer methods landing in AbstractPythonCodePrinter instead of PythonCodePrinter. Known defect: wrong class scope. |
| matplotlib__matplotlib-22719 | matplotlib | patch_mistake_despite_good_context | eval-patchverify-before-matplotlib-22719 | eval-patchverify-after-matplotlib-22719 | Known unresolved VTRACE loss after EDIT_GUARD; patch defect was narrowing a warning guard without adding the needed empty-array early return. Known defect: missed empty-array behavior. |
| psf__requests-5414 | psf | patch_mistake_despite_good_context | eval-patchverify-before-requests-5414 | eval-patchverify-after-requests-5414 | Known unresolved VTRACE loss after EDIT_GUARD; patch defect was an always-IDNA-encode restructure instead of minimal additive empty-label validation. Known defect: broad control-flow rewrite. |

## Experimental design

For each case, run two VTRACE conditions:

- **A. PIVOT_CHECK only**: add `--disable-edit-guard` and `--disable-patch-verify`.
- **B. PIVOT_CHECK + PATCH_VERIFY**: add `--disable-edit-guard` only.

Both conditions share:

```text
--protocol vtrace-indexed
--context-policy force-inject
--capsule-engine v2
--capsule-intent debug
--capsule-budget 8000
```

Never use `--disable-pivot-check`: this experiment isolates PATCH_VERIFY, not PIVOT_CHECK.

## Run commands

**sympy__sympy-16766 - before** (`eval-patchverify-before-sympy-16766`, PIVOT_CHECK only):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-16766 \
  --run-label eval-patchverify-before-sympy-16766 \
  --show-vtrace-index-log \
  --reuse-workspace \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --disable-edit-guard \
  --disable-patch-verify \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**sympy__sympy-16766 - after** (`eval-patchverify-after-sympy-16766`, PIVOT_CHECK + PATCH_VERIFY):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-16766 \
  --run-label eval-patchverify-after-sympy-16766 \
  --show-vtrace-index-log \
  --reuse-workspace \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --disable-edit-guard \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**matplotlib__matplotlib-22719 - before** (`eval-patchverify-before-matplotlib-22719`, PIVOT_CHECK only):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances matplotlib__matplotlib-22719 \
  --run-label eval-patchverify-before-matplotlib-22719 \
  --show-vtrace-index-log \
  --reuse-workspace \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --disable-edit-guard \
  --disable-patch-verify \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**matplotlib__matplotlib-22719 - after** (`eval-patchverify-after-matplotlib-22719`, PIVOT_CHECK + PATCH_VERIFY):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances matplotlib__matplotlib-22719 \
  --run-label eval-patchverify-after-matplotlib-22719 \
  --show-vtrace-index-log \
  --reuse-workspace \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --disable-edit-guard \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**psf__requests-5414 - before** (`eval-patchverify-before-requests-5414`, PIVOT_CHECK only):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances psf__requests-5414 \
  --run-label eval-patchverify-before-requests-5414 \
  --show-vtrace-index-log \
  --reuse-workspace \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --disable-edit-guard \
  --disable-patch-verify \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**psf__requests-5414 - after** (`eval-patchverify-after-requests-5414`, PIVOT_CHECK + PATCH_VERIFY):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances psf__requests-5414 \
  --run-label eval-patchverify-after-requests-5414 \
  --show-vtrace-index-log \
  --reuse-workspace \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --disable-edit-guard \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

## Evaluation commands

After the six runs complete, Docker-evaluate every produced label:

**sympy__sympy-16766** (`eval-patchverify-before-sympy-16766`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-16766 \
  --run-label eval-patchverify-before-sympy-16766 \
  --eval-mode docker \
  --eval-dataset swebench-verified-full.jsonl \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**sympy__sympy-16766** (`eval-patchverify-after-sympy-16766`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-16766 \
  --run-label eval-patchverify-after-sympy-16766 \
  --eval-mode docker \
  --eval-dataset swebench-verified-full.jsonl \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**matplotlib__matplotlib-22719** (`eval-patchverify-before-matplotlib-22719`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances matplotlib__matplotlib-22719 \
  --run-label eval-patchverify-before-matplotlib-22719 \
  --eval-mode docker \
  --eval-dataset swebench-verified-full.jsonl \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**matplotlib__matplotlib-22719** (`eval-patchverify-after-matplotlib-22719`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances matplotlib__matplotlib-22719 \
  --run-label eval-patchverify-after-matplotlib-22719 \
  --eval-mode docker \
  --eval-dataset swebench-verified-full.jsonl \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**psf__requests-5414** (`eval-patchverify-before-requests-5414`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances psf__requests-5414 \
  --run-label eval-patchverify-before-requests-5414 \
  --eval-mode docker \
  --eval-dataset swebench-verified-full.jsonl \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**psf__requests-5414** (`eval-patchverify-after-requests-5414`):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances psf__requests-5414 \
  --run-label eval-patchverify-after-requests-5414 \
  --eval-mode docker \
  --eval-dataset swebench-verified-full.jsonl \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

## Expected comparison after completion

After all six runs and evaluations complete, generate a PATCH_VERIFY comparison report that measures:

- resolved before vs after.
- patch file differences.
- token/cost deltas.
- patch-verify injected/text-present metadata.
- whether the known patch defect was fixed.
- whether context inspection stayed stable.
- whether the final patch mentions or follows the verification checkpoint.

Do not compute these until the runs exist.

## Non-claims

- This is a 3-case before/after experiment plan, not a statistically powered benchmark.
- It isolates PATCH_VERIFY directly: PIVOT_CHECK stays on and EDIT_GUARD stays off in both conditions.
- It does not claim PATCH_VERIFY fixes these losses; that is the hypothesis the runs will test.
- It does not compare against VEXP or baseline; both conditions are VTRACE-indexed.
- It computes no resolved, patch, token, cost, metadata, or behavior deltas here.
- It runs no agents and no Docker.

