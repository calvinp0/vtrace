# Stage 5 risk-gated 3-task verification report

_Generated: 2026-06-10T21:24:10.802Z_

_Reporting / accounting only. No agents, no live critic, no repair, no Docker. Usage / cost / resolution come from the SWE-bench JSONL row; VTRACE policy / context metadata from `_run.meta.json`; ordered tool calls from `_tool_calls.json`; evaluation from `_eval.meta.json`. Token and cost numbers are never sourced from `_run.meta.json`. Missing risk-gated runs are reported as missing evidence, not failures. No retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator / policy behavior is changed, and no raw artifact is mutated._

## Summary

Verification set: 3 tasks. Paired (old+new present): 1; missing risk-gated run: 2; missing controlled run: 0.

Across paired tasks: tokens 2,718,398 → 1,277,672 (-1,440,726, -53.0%); cost $0.9627 → $0.7695 ($-0.1932, -20.1%); ordered tool calls 30 → 12 (-18); resolved 0 → 1 (+1).

PIVOT_CHECK suppression claimable: 0/3. New runs that still injected PIVOT_CHECK: 1.

## Task status

| instance | old label | new label | status |
| --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | `eval-controlled-vtrace-matplotlib-22719` | `eval-riskgated-vtrace-matplotlib-22719` | paired |
| astropy__astropy-14369 | `eval-controlled-vtrace-astropy-14369` | `eval-riskgated-vtrace-astropy-14369` | missing_new_artifact |
| psf__requests-5414 | `eval-controlled-vtrace-requests-5414` | `eval-riskgated-vtrace-requests-5414` | missing_new_artifact |

## Aggregate old vs new comparison

_Aggregates are over paired tasks only (both old and new usage present)._

| metric | old | new | Δ |
| --- | --- | --- | --- |
| pairedCount | — | — | 1 |
| missingNewCount | — | — | 2 |
| totalTokens | 2,718,398 | 1,277,672 | -1,440,726 (-53.0%) |
| totalCost | $0.9627 | $0.7695 | $-0.1932 (-20.1%) |
| resolved | 0 | 1 | +1 |
| orderedToolCalls | 30 | 12 | -18 |
| suppressionClaimableCount | — | — | 0 |
| pivotCheckStillInjectedCount | — | — | 1 |

## Per-task comparison

| instance | status | tokens old→new (Δ%) | cost old→new | resolved old→new | tool calls old→new | turns old→new |
| --- | --- | --- | --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | paired | 2,718,398→1,277,672 (-53.0%) | $0.9627→$0.7695 | no→yes | 30→12 (-18) | 69→34 (-35) |
| astropy__astropy-14369 | missing_new_artifact | 3,365,366→n/a (n/a) | $3.0284→n/a | no→unknown | 23→n/a (n/a) | 60→n/a (n/a) |
| psf__requests-5414 | missing_new_artifact | 956,785→n/a (n/a) | $0.4065→n/a | no→unknown | 9→n/a (n/a) | 27→n/a (n/a) |

### matplotlib__matplotlib-22719

- **Status**: paired.
- **Labels**: old `eval-controlled-vtrace-matplotlib-22719` → new `eval-riskgated-vtrace-matplotlib-22719`.
- **toolCallsByType**: old Read:9, Grep:4, Edit:1, Bash:16; new Read:5, Grep:2, Edit:1, Bash:4.
- **Outcome**: lower_loopiness_without_suppression — PIVOT_CHECK was still injected, but ordered tool calls and/or turns dropped — improvement without suppression (reduced agent/tool-loop behavior). Tokens also dropped.

### astropy__astropy-14369

- **Status**: missing_new_artifact.
- **Labels**: old `eval-controlled-vtrace-astropy-14369` → new `eval-riskgated-vtrace-astropy-14369`.
- **toolCallsByType**: old Read:5, Bash:13, Edit:3, Glob:1, Grep:1; new n/a.
- **Outcome**: missing_evidence — risk-gated run not available yet — no new-side telemetry to compare.

### psf__requests-5414

- **Status**: missing_new_artifact.
- **Labels**: old `eval-controlled-vtrace-requests-5414` → new `eval-riskgated-vtrace-requests-5414`.
- **toolCallsByType**: old Read:3, Grep:1, Bash:3, Edit:2; new n/a.
- **Outcome**: missing_evidence — risk-gated run not available yet — no new-side telemetry to compare.

## Pivot-check policy outcomes

| instance | old injected | new injected | new policy | wouldInjectUnderMultiPivot | risk signals | suppressionClaimable |
| --- | --- | --- | --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | yes | yes | risk_gated | yes | [hidden_pivot] | no |
| astropy__astropy-14369 | yes | unknown | n/a | unknown | n/a | n/a |
| psf__requests-5414 | yes | unknown | n/a | unknown | n/a | n/a |

`suppressionClaimable` is true ONLY when `vtracePivotCheckWouldInjectUnderMultiPivot === true` AND `vtracePivotCheckInjected === false` — i.e. risk_gated actively withheld a checklist the multi-pivot heuristic would have injected.

## Tool-loop / turn-count analysis

| instance | ordered tool calls old→new (Δ) | turns old→new (Δ) | tokens Δ% |
| --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | 30→12 (-18) | 69→34 (-35) | -53.0% |
| astropy__astropy-14369 | 23→n/a (n/a) | 60→n/a (n/a) | n/a |
| psf__requests-5414 | 9→n/a (n/a) | 27→n/a (n/a) | n/a |

Where PIVOT_CHECK was still injected, a drop in ordered tool calls and turns is evidence of reduced agent/tool-loop behavior rather than smaller initial context.

## Resolution outcomes

| instance | old resolved | new resolved | changed |
| --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | no | yes | yes |
| astropy__astropy-14369 | no | unknown | unknown |
| psf__requests-5414 | no | unknown | unknown |

## Interpretation

Each task is classified into one of three evidence outcomes:

1. **Evidence of suppression** — risk_gated prevented PIVOT_CHECK where multi-pivot would have injected.
2. **Evidence of lower loopiness without suppression** — PIVOT_CHECK still injected, but tool calls/turns dropped.
3. **Missing evidence** — run not available or telemetry missing.

- `matplotlib__matplotlib-22719`: **lower_loopiness_without_suppression** — PIVOT_CHECK was still injected, but ordered tool calls and/or turns dropped — improvement without suppression (reduced agent/tool-loop behavior). Tokens also dropped.
- `astropy__astropy-14369`: **missing_evidence** — risk-gated run not available yet — no new-side telemetry to compare.
- `psf__requests-5414`: **missing_evidence** — risk-gated run not available yet — no new-side telemetry to compare.

matplotlib improved strongly, but suppression is not claimable because PIVOT_CHECK still injected due to hidden_pivot.

## Recommended next step

**Run the remaining two risk-gated verification tasks: astropy__astropy-14369 and psf__requests-5414.**

Ready-to-copy commands for the missing risk-gated runs:

#### astropy__astropy-14369 — run

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances astropy__astropy-14369 \
  --run-label eval-riskgated-vtrace-astropy-14369 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results \
  --capsule-engine v2 \
  --context-policy force-inject \
  --pivot-check-policy risk_gated \
  --reuse-workspace \
  --capsule-budget 8000
```

#### astropy__astropy-14369 — evaluate

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --run-label eval-riskgated-vtrace-astropy-14369 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

#### psf__requests-5414 — run

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances psf__requests-5414 \
  --run-label eval-riskgated-vtrace-requests-5414 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results \
  --capsule-engine v2 \
  --context-policy force-inject \
  --pivot-check-policy risk_gated \
  --reuse-workspace \
  --capsule-budget 8000
```

#### psf__requests-5414 — evaluate

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --run-label eval-riskgated-vtrace-requests-5414 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

## Non-claims

- This does NOT prove risk_gated cut tokens by suppressing PIVOT_CHECK; where PIVOT_CHECK was still injected, the suppression pathway never fired.
- This is a small verification set (n≤3), not a statistical benchmark; no significance is claimed.
- It does not isolate which factor (tool-loop behavior, stochasticity, sampling) drove any token drop.
- It does not change retrieval, Capsule v2, PIVOT_CHECK, EDIT_GUARD, PATCH_VERIFY, probes, critic, repair, the evaluator, or policy behavior.
- It does not rerun agents or Docker; usage/cost/resolution are read verbatim from existing run + docker-eval artifacts.
- Missing risk-gated runs are reported as missing evidence, not as regressions.

