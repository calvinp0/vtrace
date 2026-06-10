# Stage 5 risk-gated 3-task verification report

_Generated: 2026-06-10T22:00:56.264Z_

_Reporting / accounting only. No agents, no live critic, no repair, no Docker. Usage / cost / resolution come from the SWE-bench JSONL row; VTRACE policy / context metadata from `_run.meta.json`; ordered tool calls from `_tool_calls.json`; evaluation from `_eval.meta.json`. Token and cost numbers are never sourced from `_run.meta.json`. Missing risk-gated runs are reported as missing evidence, not failures. No retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator / policy behavior is changed, and no raw artifact is mutated._

## Summary

Verification set: 3 tasks. Paired (old+new present): 3; missing risk-gated run: 0; missing controlled run: 0.

Across paired tasks: tokens 7,040,549 → 6,603,626 (-436,923, -6.2%); cost $4.3976 → $3.1922 ($-1.2055, -27.4%); ordered tool calls 62 → 58 (-4); resolved 0 → 1 (+1).

PIVOT_CHECK suppression claimable: 0/3. New runs that still injected PIVOT_CHECK: 3.

## Task status

| instance | old label | new label | status |
| --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | `eval-controlled-vtrace-matplotlib-22719` | `eval-riskgated-vtrace-matplotlib-22719` | paired |
| astropy__astropy-14369 | `eval-controlled-vtrace-astropy-14369` | `eval-riskgated-vtrace-astropy-14369` | paired |
| psf__requests-5414 | `eval-controlled-vtrace-requests-5414` | `eval-riskgated-vtrace-requests-5414` | paired |

## Aggregate old vs new comparison

_Aggregates are over paired tasks only (both old and new usage present)._

| metric | old | new | Δ |
| --- | --- | --- | --- |
| pairedCount | — | — | 3 |
| missingNewCount | — | — | 0 |
| totalTokens | 7,040,549 | 6,603,626 | -436,923 (-6.2%) |
| totalCost | $4.3976 | $3.1922 | $-1.2055 (-27.4%) |
| resolved | 0 | 1 | +1 |
| orderedToolCalls | 62 | 58 | -4 |
| suppressionClaimableCount | — | — | 0 |
| pivotCheckStillInjectedCount | — | — | 3 |

## Per-task comparison

| instance | status | tokens old→new (Δ%) | cost old→new | resolved old→new | tool calls old→new | turns old→new |
| --- | --- | --- | --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | paired | 2,718,398→1,277,672 (-53.0%) | $0.9627→$0.7695 | no→yes | 30→12 (-18) | 69→34 (-35) |
| astropy__astropy-14369 | paired | 3,365,366→3,649,897 (+8.5%) | $3.0284→$1.7340 | no→no | 23→30 (+7) | 60→68 (+8) |
| psf__requests-5414 | paired | 956,785→1,676,057 (+75.2%) | $0.4065→$0.6887 | no→no | 9→16 (+7) | 27→45 (+18) |

### matplotlib__matplotlib-22719

- **Status**: paired.
- **Labels**: old `eval-controlled-vtrace-matplotlib-22719` → new `eval-riskgated-vtrace-matplotlib-22719`.
- **toolCallsByType**: old Read:9, Grep:4, Edit:1, Bash:16; new Read:5, Grep:2, Edit:1, Bash:4.
- **Outcome**: lower_loopiness_without_suppression — PIVOT_CHECK was still injected, but ordered tool calls and/or turns dropped — improvement without suppression (reduced agent/tool-loop behavior). Tokens also dropped.

### astropy__astropy-14369

- **Status**: paired.
- **Labels**: old `eval-controlled-vtrace-astropy-14369` → new `eval-riskgated-vtrace-astropy-14369`.
- **toolCallsByType**: old Read:5, Bash:13, Edit:3, Glob:1, Grep:1; new Read:7, Bash:15, Edit:1, Glob:4, Grep:3.
- **Outcome**: regression_without_suppression — PIVOT_CHECK suppression was not claimable and tokens / ordered tool calls / turns increased without a resolution gain — a regression, not missing evidence.

### psf__requests-5414

- **Status**: paired.
- **Labels**: old `eval-controlled-vtrace-requests-5414` → new `eval-riskgated-vtrace-requests-5414`.
- **toolCallsByType**: old Read:3, Grep:1, Bash:3, Edit:2; new Read:4, Grep:1, Bash:10, Edit:1.
- **Outcome**: regression_without_suppression — PIVOT_CHECK suppression was not claimable and tokens / ordered tool calls / turns increased without a resolution gain — a regression, not missing evidence.

## Pivot-check policy outcomes

| instance | old injected | new injected | new policy | wouldInjectUnderMultiPivot | risk signals | suppressionClaimable |
| --- | --- | --- | --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | yes | yes | risk_gated | yes | [hidden_pivot] | no |
| astropy__astropy-14369 | yes | yes | risk_gated | yes | [hidden_pivot] | no |
| psf__requests-5414 | yes | yes | risk_gated | yes | [hidden_pivot] | no |

`suppressionClaimable` is true ONLY when `vtracePivotCheckWouldInjectUnderMultiPivot === true` AND `vtracePivotCheckInjected === false` — i.e. risk_gated actively withheld a checklist the multi-pivot heuristic would have injected.

## Tool-loop / turn-count analysis

| instance | ordered tool calls old→new (Δ) | turns old→new (Δ) | tokens Δ% |
| --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | 30→12 (-18) | 69→34 (-35) | -53.0% |
| astropy__astropy-14369 | 23→30 (+7) | 60→68 (+8) | +8.5% |
| psf__requests-5414 | 9→16 (+7) | 27→45 (+18) | +75.2% |

Where PIVOT_CHECK was still injected, a drop in ordered tool calls and turns is evidence of reduced agent/tool-loop behavior rather than smaller initial context.

## Resolution outcomes

| instance | old resolved | new resolved | changed |
| --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | no | yes | yes |
| astropy__astropy-14369 | no | no | no |
| psf__requests-5414 | no | no | no |

## Interpretation

Each task is classified into one of these evidence outcomes:

1. **suppression** — risk_gated prevented PIVOT_CHECK where multi-pivot would have injected.
2. **lower_loopiness_without_suppression** — PIVOT_CHECK still injected, but tool calls/turns dropped.
3. **regression_without_suppression** — paired, no suppression, and tokens / tool calls / turns increased without a resolution gain.
4. **no_suppression_no_improvement** — paired, no suppression, and no clear token / tool / turn improvement or resolution gain.
5. **missing_evidence** — RESERVED for missing artifacts or missing telemetry only (not for paired non-improving tasks).

- `matplotlib__matplotlib-22719`: **lower_loopiness_without_suppression** — PIVOT_CHECK was still injected, but ordered tool calls and/or turns dropped — improvement without suppression (reduced agent/tool-loop behavior). Tokens also dropped.
- `astropy__astropy-14369`: **regression_without_suppression** — PIVOT_CHECK suppression was not claimable and tokens / ordered tool calls / turns increased without a resolution gain — a regression, not missing evidence.
- `psf__requests-5414`: **regression_without_suppression** — PIVOT_CHECK suppression was not claimable and tokens / ordered tool calls / turns increased without a resolution gain — a regression, not missing evidence.

matplotlib improved strongly, but suppression is not claimable because PIVOT_CHECK still injected due to hidden_pivot.

## Recommended next step

**Analyze per-task causes before rerunning the full 10-task set.**

## Non-claims

- This does NOT prove risk_gated cut tokens by suppressing PIVOT_CHECK; where PIVOT_CHECK was still injected, the suppression pathway never fired.
- This is a small verification set (n≤3), not a statistical benchmark; no significance is claimed.
- It does not isolate which factor (tool-loop behavior, stochasticity, sampling) drove any token drop.
- It does not change retrieval, Capsule v2, PIVOT_CHECK, EDIT_GUARD, PATCH_VERIFY, probes, critic, repair, the evaluator, or policy behavior.
- It does not rerun agents or Docker; usage/cost/resolution are read verbatim from existing run + docker-eval artifacts.
- Missing risk-gated runs are reported as missing evidence; paired tasks whose usage grew are labeled regression_without_suppression, not missing_evidence.

