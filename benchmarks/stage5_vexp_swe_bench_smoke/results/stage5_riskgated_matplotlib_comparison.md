# Stage 5 risk-gated matplotlib comparison

_Generated: 2026-06-10T21:16:49.127Z_

_Reporting / accounting only. No agents, no live critic, no repair, no Docker. Usage / cost / resolution are read from the SWE-bench JSONL row; VTRACE policy / context metadata is read from `_run.meta.json`. Token and cost numbers are never sourced from `_run.meta.json`. No retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator / policy behavior is changed, and no raw artifact is mutated._

## Summary

Instance `matplotlib__matplotlib-22719` was rerun under the risk_gated pivot-check policy (`eval-riskgated-vtrace-matplotlib-22719`) and compared to the prior controlled VTRACE run (`eval-controlled-vtrace-matplotlib-22719`).

Tokens 2,718,398 → 1,277,672 (-1,440,726, -53.0%). Cost $0.9627 → $0.7695 ($-0.1932, -20.1%). Ordered tool calls 30 → 12 (-18).

Resolution no → yes (changed: yes). The new run resolved the previous matplotlib loss and used far fewer ordered tool calls than the old controlled VTRACE run.

## Old vs new usage

| field | old | new | Δ |
| --- | --- | --- | --- |
| runLabel | `eval-controlled-vtrace-matplotlib-22719` | `eval-riskgated-vtrace-matplotlib-22719` | — |
| instanceId | matplotlib__matplotlib-22719 | matplotlib__matplotlib-22719 | — |
| resolved | no | yes | changed |
| costUsd | $0.9627 | $0.7695 | $-0.1932 (-20.1%) |
| inputTokens | 491 | 246 | -245 |
| outputTokens | 158 | 85 | -73 |
| cacheReadTokens | 2,632,899 | 1,121,725 | -1,511,174 |
| cacheCreationTokens | 84,850 | 155,616 | +70,766 |
| totalTokens | 2,718,398 | 1,277,672 | -1,440,726 (-53.0%) |
| numTurns | 69 | 34 | -35 |
| vtraceCapsuleEstimatedTokens | 601 | 601 | +0 |
| vtraceContextChars | 3,533 | 3,615 | +82 |

Token and cost figures above come from the SWE-bench JSONL row (real model spend). `vtraceCapsuleEstimatedTokens` and `vtraceContextChars` are the much smaller injected-context figures from `_run.meta.json` and are NOT the model spend — they are shown only to confirm the initial context size was essentially unchanged between runs.

## Pivot-check policy decision

| field | value |
| --- | --- |
| vtracePivotCheckPolicy | risk_gated |
| vtracePivotCheckPolicyReason | risk_gated: risk signals [hidden_pivot] |
| vtracePivotCheckRiskSignals | [hidden_pivot] |
| vtracePivotCheckWouldInjectUnderMultiPivot | yes |
| vtracePivotCheckInjected | yes |
| vtraceEditGuardInjected | yes |
| vtracePatchVerifyInjected | yes |
| suppressionClaimable | no |

Under `risk_gated`, the new run detected risk signals [hidden_pivot] and therefore STILL injected PIVOT_CHECK (`vtracePivotCheckInjected = yes`). The suppression pathway never fired, so PIVOT_CHECK suppression cannot be the cause of the token reduction.

> This comparison does NOT prove that risk_gated reduced tokens by suppressing PIVOT_CHECK, because the new risk_gated run still injected PIVOT_CHECK due to hidden_pivot.

## Tool-call comparison

| field | old | new | Δ |
| --- | --- | --- | --- |
| orderedToolCallCount | 30 | 12 | -18 |
| toolCallsByType | Read:9, Grep:4, Edit:1, Bash:16 | Read:5, Grep:2, Edit:1, Bash:4 | — |
| uniqueFilesRead | 4 | 3 | -1 |
| uniqueFilesEdited | 1 | 1 | +0 |

`orderedToolCallCount` is taken from the ordered `_tool_calls.json` log when present (falling back to `vtraceToolCallCount` in `_run.meta.json`). The drop in ordered tool calls is the clearest behavioral difference between the two runs.

## Patch comparison

| field | old | new |
| --- | --- | --- |
| modelPatchHash | `e9c2efff46a7…` | `65ca7f4d9773…` |
| modelPatchSummary | lib/matplotlib/category.py: +1/-1 lines | lib/matplotlib/category.py: +2/-0 lines |

The patches differ (distinct hashes). The old run narrowed the deprecation-warning guard; the new run added an explicit empty-array early return. The new patch is the one that passed Docker evaluation.

## Evaluation result

| field | old | new |
| --- | --- | --- |
| resolved (JSONL row) | no | yes |
| evaluationRan | yes | yes |
| dockerUsed | yes | yes |
| resolvedCount | 0 | 1 |
| evaluationError | n/a | n/a |

The new risk_gated rerun was Docker-evaluated and resolved the instance, recovering the previous matplotlib loss. Resolution is read verbatim from the existing JSONL row and `_eval.meta.json`; nothing was re-evaluated here.

## Interpretation

- This comparison does NOT prove that risk_gated reduced tokens by suppressing PIVOT_CHECK, because the new risk_gated run still injected PIVOT_CHECK due to hidden_pivot.
- The new run resolved the previous matplotlib loss and used far fewer ordered tool calls than the old controlled VTRACE run.
- The likely improvement is reduced agent/tool-loop behavior, not smaller initial context. The exact cause is not proven from one rerun.

## Recommended next step

**Run a small 3-task risk_gated verification set, not the full 10-task set yet.**

Suggested candidates:

- `matplotlib__matplotlib-22719` — confirmed improvement/resolution; rerun already available.
- `astropy__astropy-14369` — context_too_large + retrieval_noise case.
- `psf__requests-5414` — low-cost Requests case where repair later helped.

Do not recommend more duplicate repair experiments.

## Non-claims

- This comparison does NOT prove that risk_gated reduced tokens by suppressing PIVOT_CHECK, because the new risk_gated run still injected PIVOT_CHECK due to hidden_pivot.
- This is a single rerun (n=1), not a statistical benchmark; no significance is claimed.
- It does not isolate which factor (tool-loop behavior, stochasticity, sampling) drove the token drop.
- It does not change retrieval, Capsule v2, PIVOT_CHECK, EDIT_GUARD, PATCH_VERIFY, probes, critic, repair, the evaluator, or policy behavior.
- It does not rerun agents or Docker; usage/cost/resolution are read verbatim from the existing run + docker-eval artifacts.

