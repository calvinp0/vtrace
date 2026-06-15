# Stage 5 — M8.1 eval-artifact confirmation for astropy-14539 (VTRACE r1)

Generated 2026-06-15, on `main` HEAD `b8834a7`. **Measurement-cleanup task** (eval-only; no agents, no patch regeneration, no 30/100-case runs, no policy/retrieval/scoring/ranking changes). Follows up the M8 failure-shape audit (`stage5_m8_regression_failure_shape_audit.md`), which flagged astropy-14539 as a *likely* evaluation artifact, and the M7.2 clean-Docker re-baseline (`stage5_m7_clean_docker_rebaseline.md`), which counted it as one of three surviving "genuine" regressions. This task confirms the artifact and corrects the interpretation.

## 1. Docker health

```
docker run --rm hello-world : OK ("Hello from Docker!")
docker ps                   : OK (daemon healthy; 5 unrelated host containers up)
curl _ping                  : OK
```

Daemon is healthy for *hello-world* and unrelated containers. **However**, the astropy-14539 evaluation image cannot be (re)built on this host right now: container creation fails with a containerd snapshot-corruption fault (see §4). This is an isolated per-image fault, not a daemon-down condition — exactly the false-negative-only fault class the rebaseline documented. (A targeted `docker builder prune` to clear the corrupt snapshot was out of scope for an eval-only task and was not performed.)

## 2. Target label

Exact VTRACE r1 label (verified against the run-dir tree; the reports refer to the case by instance, the runs by label):

```
eval-bounded20-current-clean-astropy-14539-r1
  condition dir: runs/eval-bounded20-current-clean-astropy-14539-r1/raw/vtrace/
  instance:      astropy__astropy-14539
```

Re-evaluated eval-only with:

```
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate --eval-mode docker \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --run-label eval-bounded20-current-clean-astropy-14539-r1 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

(`evaluate` re-runs the SWE-bench test harness against the *existing* model patch in the JSONL; it does not re-run the agent or regenerate the patch. `run-protocol` was not invoked.)

## 3. Old eval result

From the run artifacts as they stood at the start of this task (written by a re-eval at 21:41 on 2026-06-15):

```
_eval.meta.json : evaluationRan=true, evaluationMethod=docker, dockerUsed=true,
                  evaluationError=null, instancesEvaluated=1, resolvedCount=0
swebench JSONL  : resolved=False, modelPatch present (526 bytes)
```

i.e. recorded as **unresolved**. Note `evaluationError=null` is misleading: the wrapper exits 0 and reports `resolvedCount=0` even when the *instance-level* container build fails, because the per-instance `BuildImageError` does not propagate to a non-zero process exit (see §4).

## 4. New eval result

Re-ran `--mode evaluate` twice under the healthy daemon. Both returned:

```
{ condition: vtrace, evaluationRan: true, evaluationMethod: docker, dockerUsed: true,
  evaluationError: null, instancesEvaluated: 1, resolvedCount: 0 }
```

**r1 did not flip to resolved.** The SWE-bench harness log for the re-eval shows *why* — the container could not be created, so the FAIL_TO_PASS tests never executed:

```
ERROR - Error creating container for astropy__astropy-14539:
  500 Server Error ... /containers/create ...:
  Internal Server Error ("NotFound: parent snapshot
  sha256:3140a2c282adcab0dcf507e1bc196a3c75441796d1caf03fc1042943bb63b36b
  does not exist: not found")
swebench.harness.docker_build.BuildImageError: Error building image astropy__astropy-14539
```

(log: `vexp-swe-bench/logs/run_evaluation/vexp-swebench-1781548843{864,900}/.../astropy__astropy-14539/run_instance.log`)

This is a **containerd/overlayfs snapshot-corruption fault**: the image's parent snapshot is missing, so `containers/create` fails before any test runs. When `build_container` raises, the harness records the instance as `resolved=False` by default. This is a **pure false-negative generator** — identical in effect to the "Yunix" shim fault the rebaseline identified (container fails to start → tests never run → `resolved` defaults to False). The fault string differs (`parent snapshot … does not exist` vs the shim error), which is why the rebaseline's health check did not catch it for this row.

**Contrast — the same patch under a successful build.** The most recent run in which the astropy-14539 container *did* build (`vexp-swebench-1781513829000`, 11:57 on 2026-06-15) graded the **identical** patch (its `patch.diff` is byte-for-byte equal to r1's `modelPatch`, verified) as:

```
patch_successfully_applied : true
resolved                   : true
FAIL_TO_PASS success        : test_identical_tables, test_different_table_data
FAIL_TO_PASS failure        : []
PASS_TO_PASS failure        : []  (0)
```

So the patch genuinely fixes the issue and passes every gating test whenever the container builds.

## 5. Patch identity check

Deterministic, offline (no Docker):

```
r1 modelPatch  : sha256 584ab6bdf747fbf0…  526 bytes
r2 modelPatch  : sha256 584ab6bdf747fbf0…  526 bytes
r1 == r2 (exact byte-for-byte)            : TRUE
successful-build patch.diff == r1 patch    : TRUE (identical)
```

Functional change, all three (r1, r2, gold) identical:

```
- elif "P" in col.format:
+ elif "P" in col.format or "Q" in col.format:
  (astropy/io/fits/diff.py, TableDataDiff._diff)
```

r1's patch is byte-identical to r2's (which scored `resolved=True`) and functionally identical to the gold patch. A deterministic evaluation cannot grade the same patch as both pass and fail; the divergence is therefore non-deterministic *infrastructure*, not patch content.

## 6. Conclusion

**`confirmed_eval_artifact`.**

Two independent lines of evidence, either sufficient on its own:

1. **Patch identity proves the unresolved result is inconsistent.** r1's patch is byte-identical to r2's, which resolved; and identical to the gold patch. The same input cannot deterministically yield both verdicts.
2. **Direct root cause.** r1's `resolved=False` is produced by a containerd `BuildImageError` (parent snapshot missing) at container-create time — tests never ran. The identical patch, when the container builds, resolves with all FAIL_TO_PASS and PASS_TO_PASS passing.

Caveat (stated plainly): r1 did **not** flip to `resolved=True` in this task's re-eval, because the corrupted containerd snapshot persists on this host and clearing it (`docker builder prune`) was out of scope for an eval-only task. The artifact is nonetheless *confirmed*, not merely *suspected*, because we have the failing run's build-error root cause **and** the identical patch passing under a clean build — not just patch identity. A clean rebuild of the astropy-14539 image (after a build-cache prune) is expected to reproduce `resolved=True`; that is the only step left to mechanically flip the stored value.

## 7. Impact on bounded-20 interpretation

astropy-14539 should **not** be counted as a VTRACE-caused regression. Its recorded `3/3 → 1/3` is contaminated:

- r1: gold-identical patch, scored `False` only because the container failed to build (false negative).
- r2: gold-identical patch, `resolved=True`.
- r3: empty patch (a real but isolated synthesis miss, 1/3).

Under clean builds, VTRACE produces the gold-correct patch in **2 of 3** runs (r1, r2); the only genuine miss is r3's empty patch. There is no context/policy/retrieval failure here. This also corrects the M7.2 re-baseline: its "clean Docker" pass did not achieve a clean build for this row — the r1 re-eval hit the snapshot fault, and the row carried a stale false-negative — so astropy-14539's inclusion among the "3 genuine regressions" was itself a residual contamination the rebaseline's health-grep missed.

Combined with the M8 audit findings for the other two cases (sympy-12419 and pylint-8898 — VTRACE localizes and edits the gold file/symbol, but the model writes a subtly-worse patch in some repeats: `patch_synthesis_bound`), the corrected tally of the three "surviving regressions" is:

```
confirmed VTRACE policy/retrieval regressions : 0
patch-synthesis-bound regressions             : 2   (sympy-12419, pylint-8898)
eval-artifact (confirmed)                      : 1   (astropy-14539)
```

Bounded-20 resolution-regression rate, corrected: the rebaseline's 3/20 (15%) drops to **2/20 (10%)** apparent once astropy-14539 is removed as an artifact — and **0/20** are attributable to VTRACE policy/retrieval/actionability/context-action behavior; the remaining two are model patch-synthesis variance at n=3, not VTRACE-addressable.

This does not change the substantive open VTRACE problem identified earlier: the inject-without-benefit rate (24%: sphinx-7462, sympy-16766, requests-5414, seaborn-3187) and the multi-file co-edit actionability gap. Those, not these three, should drive the next milestone.

## 8. Non-claims / caveats

- The stored r1 `resolved` value remains `False` (the corrupted snapshot blocks a clean rebuild on this host; cache prune was out of scope). Older reports are **not** rewritten; this follow-up references them and supersedes the astropy-14539 interpretation only.
- "Confirmed" rests on the identical patch passing under a documented clean build plus the r1 build-fault root cause — not on a fresh green r1 re-eval, which is gated on clearing the containerd snapshot corruption.
- No code changed. Raw eval artifacts (re-run JSONL/meta/logs) were not staged.
