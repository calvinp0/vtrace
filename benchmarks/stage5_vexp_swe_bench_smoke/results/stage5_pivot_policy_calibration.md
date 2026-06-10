# Stage 5 pivot-check policy calibration

_Generated: 2026-06-10T22:00:56.294Z_

_Reporting / accounting only. No agents, no live critic, no repair, no Docker. Simulated injection decisions are recomputed in-process from recorded metadata; production PIVOT_CHECK / risk_gated behavior is unchanged and no raw artifact is mutated. Usage / cost / resolution come from the SWE-bench JSONL row; pivot-check policy / signal / capsule metadata from `_run.meta.json`; token and cost numbers are never sourced from `_run.meta.json`._

## Summary

Discovered 94 run(s); analyzed 3 carrying pivot-check decision metadata. PIVOT_CHECK was injected on 3/3. hidden_pivot was the SOLE risk signal on 3/3, and current risk_gated matched multi_pivot on 3/3.

> In the 3-task risk-gated verification set, risk_gated did not suppress PIVOT_CHECK because hidden_pivot fired on every task.

A stricter policy would have suppressed PIVOT_CHECK on 3 run(s) (strict_risk_gated) / 3 run(s) (no_hidden_pivot_only). Token mass where hidden_pivot was the sole signal: 6,603,626 tokens, $3.1922.

**hidden_pivot appears too broad: yes.** On every analyzed run hidden_pivot alone forced injection and a stricter gate would have suppressed it, so risk_gated is currently indistinguishable from multi_pivot.

## Current risk-gated behavior

| instance | run label | injected | policy | risk signals | wouldInjectUnderMultiPivot | risk_gated≡multi_pivot |
| --- | --- | --- | --- | --- | --- | --- |
| astropy__astropy-14369 | `eval-riskgated-vtrace-astropy-14369` | yes | risk_gated | [hidden_pivot] | yes | yes |
| matplotlib__matplotlib-22719 | `eval-riskgated-vtrace-matplotlib-22719` | yes | risk_gated | [hidden_pivot] | yes | yes |
| psf__requests-5414 | `eval-riskgated-vtrace-requests-5414` | yes | risk_gated | [hidden_pivot] | yes | yes |

Where `risk_gated≡multi_pivot` is `yes`, the risk gate changed nothing relative to the old multi-pivot heuristic — PIVOT_CHECK was injected on the same runs it always would have been.

## Hidden-pivot signal analysis

| instance | risk signals | hidden_pivot sole signal | pivots | editRiskDirectives | additional signals | classification |
| --- | --- | --- | --- | --- | --- | --- |
| astropy__astropy-14369 | [hidden_pivot] | yes | 2 | 0 | 0 | suppression_candidate_hidden_only |
| matplotlib__matplotlib-22719 | [hidden_pivot] | yes | 2 | 0 | 0 | suppression_candidate_hidden_only |
| psf__requests-5414 | [hidden_pivot] | yes | 2 | 0 | 0 | suppression_candidate_hidden_only |

`three_or_more_pivots` is derived from the capsule pivot count and `edit_risk_directives` from `vtraceCapsuleEditRiskDirectivesCount`; both are independent of the recorded signal list so a stricter gate can be simulated even where hidden_pivot short-circuited the production decision.

## Simulated policy comparison

| instance | actual injected | multi_pivot | current_risk_gated | strict_risk_gated | no_hidden_pivot_only | off |
| --- | --- | --- | --- | --- | --- | --- |
| astropy__astropy-14369 | yes | inject | inject | suppress | suppress | suppress |
| matplotlib__matplotlib-22719 | yes | inject | inject | suppress | suppress | suppress |
| psf__requests-5414 | yes | inject | inject | suppress | suppress | suppress |

Policy definitions (simulation only — production behavior is unchanged):

- **multi_pivot** — inject when `wouldInjectUnderMultiPivot` is true.
- **current_risk_gated** — inject under any risk signal (`hidden_pivot` OR `three_or_more_pivots` OR `edit_risk_directives`).
- **strict_risk_gated** — inject only on a non-hidden risk, or hidden_pivot accompanied by ≥1 additional signal / known edit-relevant metadata.
- **no_hidden_pivot_only** — `hidden_pivot` alone is not sufficient.
- **off** — never inject.

## Suppression candidates

Classification counts:

| classification | count |
| --- | --- |
| suppression_candidate_hidden_only | 3 |
| still_high_risk_multi_signal | 0 |
| already_suppressed | 0 |
| no_multi_pivot | 0 |
| unknown | 0 |

3 run(s) are **suppression_candidate_hidden_only** — injected solely because `hidden_pivot` fired, with no other risk signal. A stricter policy would suppress PIVOT_CHECK on these:

- `astropy__astropy-14369` (`eval-riskgated-vtrace-astropy-14369`) — tokens 3,649,897, $1.7340, ordered tool calls 30, resolved no.
- `matplotlib__matplotlib-22719` (`eval-riskgated-vtrace-matplotlib-22719`) — tokens 1,277,672, $0.7695, ordered tool calls 12, resolved yes.
- `psf__requests-5414` (`eval-riskgated-vtrace-requests-5414`) — tokens 1,676,057, $0.6887, ordered tool calls 16, resolved no.

## Relationship to token/cost outcomes

The 3-task risk-gated verification report recorded aggregate tokens -6.2% and cost -27.4% vs the controlled runs, with 0 task(s) where PIVOT_CHECK suppression was claimable.

Because PIVOT_CHECK was injected on every analyzed run, none of the observed token/cost movement can be attributed to PIVOT_CHECK suppression — the suppression pathway never fired. Any token mass shown above is what a stricter gate would have had the OPPORTUNITY to act on, not a realized saving.

The token-path audit's dominant overhead categories were: pivot_check_overhead, agent_oversearched, tool_loop_overhead. `pivot_check_overhead` is among them, which is the cost a stricter gate would target.

## Recommendation

**Do not rerun the full 10-task set yet. First test a stricter risk-gated policy where hidden_pivot alone is not sufficient.**

hidden_pivot was the sole risk signal on all 3 analyzed runs and a stricter policy would have suppressed PIVOT_CHECK on every one of them, so risk_gated currently behaves like multi_pivot. Test the stricter gate before spending a full 10-task rerun.

## Non-claims

- This is a simulation over existing run metadata; it does NOT change PIVOT_CHECK, the risk_gated policy, or any production behavior.
- Simulated injection decisions are recomputed from recorded risk signals and capsule metadata, not by re-running agents.
- It does not run agents, live critic, repair, or Docker; usage/cost/resolution are read verbatim from existing run + docker-eval artifacts.
- Token/cost figures come from the SWE-bench JSONL row; pivot-check policy/signal metadata from `_run.meta.json`. Token/cost are never sourced from `_run.meta.json`.
- It does not prove a stricter policy would resolve more tasks or cut tokens — only that hidden_pivot alone forced injection on every analyzed run.
- n is small (analyzed risk_gated runs only); no statistical significance is claimed.

