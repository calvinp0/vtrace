# Stage 5 strict-gated 3-task comparison

_Generated: 2026-06-11T06:25:18.383Z_

_Reporting / accounting only. No agents, no live critic, no repair, no Docker. Usage / cost / resolution come from the SWE-bench JSONL row; VTRACE policy / context metadata from `_run.meta.json`; ordered tool calls from `_tool_calls.json`; evaluation from `_eval.meta.json`. Token and cost numbers are never sourced from `_run.meta.json`. The primary comparison is risk_gated → strict_risk_gated; the controlled (old) run is shown for context. No retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator / policy behavior is changed, and no raw artifact is mutated._

## Summary

Comparison set: 3 tasks (old controlled, risk_gated, strict_risk_gated). Paired (risk + strict present): 3.

Across paired tasks, risk_gated → strict_risk_gated: tokens 6,603,626 → 4,373,143 (-2,230,483, -33.8%); cost $3.1922 → $2.3122 ($-0.8800, -27.6%); turns 147 → 102 (-45); ordered tool calls 58 → 36 (-22); resolved 1 → 1 (+0).

PIVOT_CHECK suppression claimable (strict): 3/3. Resolution regressions (risk→strict): 0. Strict runs that still injected PIVOT_CHECK: 0.

## Aggregate risk-gated vs strict-gated

_Aggregates are over paired tasks only (both risk and strict usage present)._

| metric | risk_gated | strict_risk_gated | Δ |
| --- | --- | --- | --- |
| pairedCount | — | — | 3 |
| totalTokens | 6,603,626 | 4,373,143 | -2,230,483 (-33.8%) |
| totalCost | $3.1922 | $2.3122 | $-0.8800 (-27.6%) |
| totalTurns | 147 | 102 | -45 |
| orderedToolCalls | 58 | 36 | -22 |
| resolved | 1 | 1 | +0 |
| resolutionRegressionCount | — | — | 0 |
| suppressionClaimableCount | — | — | 3 |
| strictPivotCheckInjectedCount | — | — | 0 |
| strictEditGuardInjectedCount | — | — | 0 |
| strictPatchVerifyInjectedCount | — | — | 0 |

## Per-task comparison

| instance | status | old label | risk label | strict label |
| --- | --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | complete | `eval-controlled-vtrace-matplotlib-22719` | `eval-riskgated-vtrace-matplotlib-22719` | `eval-strictgated-vtrace-matplotlib-22719` |
| astropy__astropy-14369 | complete | `eval-controlled-vtrace-astropy-14369` | `eval-riskgated-vtrace-astropy-14369` | `eval-strictgated-vtrace-astropy-14369` |
| psf__requests-5414 | complete | `eval-controlled-vtrace-requests-5414` | `eval-riskgated-vtrace-requests-5414` | `eval-strictgated-vtrace-requests-5414` |

| instance | tokens old / risk / strict | cost old / risk / strict | turns old / risk / strict | resolved old / risk / strict |
| --- | --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | 2,718,398 / 1,277,672 / 1,059,041 | $0.9627 / $0.7695 / $0.4900 | 69 / 34 / 30 | no / yes / yes |
| astropy__astropy-14369 | 3,365,366 / 3,649,897 / 2,508,804 | $3.0284 / $1.7340 / $1.4102 | 60 / 68 / 47 | no / no / no |
| psf__requests-5414 | 956,785 / 1,676,057 / 805,298 | $0.4065 / $0.6887 / $0.4120 | 27 / 45 / 25 | no / no / no |

Risk → strict deltas per task:

| instance | token Δ (Δ%) | cost Δ (Δ%) | turn Δ | tool-call Δ | resolution regression |
| --- | --- | --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | -218,631 (-17.1%) | $-0.2795 (-36.3%) | -4 | -1 | no |
| astropy__astropy-14369 | -1,141,093 (-31.3%) | $-0.3238 (-18.7%) | -21 | -13 | no |
| psf__requests-5414 | -870,759 (-52.0%) | $-0.2767 (-40.2%) | -20 | -8 | no |

## Pivot-check suppression

| instance | strict policy | risk signals | wouldInjectUnderMultiPivot | pivotCheckInjected | editGuardInjected | patchVerifyInjected | suppressionClaimable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | strict_risk_gated | [hidden_pivot] | yes | no | no | no | yes |
| astropy__astropy-14369 | strict_risk_gated | [hidden_pivot] | yes | no | no | no | yes |
| psf__requests-5414 | strict_risk_gated | [hidden_pivot] | yes | no | no | no | yes |

`suppressionClaimable` is true ONLY when `wouldInjectUnderMultiPivot === true` AND `pivotCheckInjected === false` — i.e. strict_risk_gated actively withheld a checklist that the multi-pivot heuristic would have injected. Here every strict run had risk signals `[hidden_pivot]` and strict treats hidden_pivot alone as insufficient, so PIVOT_CHECK was suppressed.

> Unlike the risk_gated 3-task report, suppression is claimable here: strict_risk_gated suppressed PIVOT_CHECK on hidden-pivot-only cases where multi_pivot would have injected.

## Tool-loop and turn-count impact

| instance | ordered tool calls risk→strict (Δ) | turns risk→strict (Δ) | tokens Δ% |
| --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | 12→11 (-1) | 34→30 (-4) | -17.1% |
| astropy__astropy-14369 | 30→17 (-13) | 68→47 (-21) | -31.3% |
| psf__requests-5414 | 16→8 (-8) | 45→25 (-20) | -52.0% |

With PIVOT_CHECK suppressed under strict gating, the drop in ordered tool calls and turns reflects reduced agent/tool-loop behavior rather than a smaller initial context.

## Resolution outcomes

| instance | old resolved | risk resolved | strict resolved | regression (risk→strict) |
| --- | --- | --- | --- | --- |
| matplotlib__matplotlib-22719 | no | yes | yes | no |
| astropy__astropy-14369 | no | no | no | no |
| psf__requests-5414 | no | no | no | no |

Resolved count risk → strict: 1 → 1 (+0); resolution regressions: 0.

## Interpretation

- Unlike the risk_gated 3-task report, suppression is claimable here: strict_risk_gated suppressed PIVOT_CHECK on hidden-pivot-only cases where multi_pivot would have injected.
- Strict gating reduced tokens, cost, turns, and ordered tool calls on all three tasks without reducing the resolved count in this small set.
- This is n=3 and does not prove aggregate benchmark improvement.
- Astropy and Requests remain unresolved; strict gating improves efficiency, not necessarily patch quality.

## Recommendation

**Update the Stage 5 controlled policy/accounting to include strict_risk_gated as a candidate default, then run a 10-task strict-gated controlled comparison.**

This report does not recommend further duplicate repair experiments.

## Non-claims

- This is n=3 and does not prove aggregate benchmark improvement.
- Astropy and Requests remain unresolved; strict gating improves efficiency, not necessarily patch quality.
- It does not isolate which factor (tool-loop behavior, stochasticity, sampling) drove any token drop.
- It does not change retrieval, Capsule v2, PIVOT_CHECK, EDIT_GUARD, PATCH_VERIFY, probes, critic, repair, the evaluator, or policy behavior.
- It does not rerun agents or Docker; usage/cost/resolution are read verbatim from existing run + docker-eval artifacts.

