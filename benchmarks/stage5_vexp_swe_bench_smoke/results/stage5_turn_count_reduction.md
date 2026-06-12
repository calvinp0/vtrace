# Stage 5 turn-count reduction policy

## Summary

Classified 10 task(s) from the token-path audit: 7 overhead case(s), 2 high-risk, 4 attributable to turn-count/tool loops, 5 would receive strong_context_patch_first, 5 would be capped by the new pre-edit tool budgets, 2 lack telemetry and need a rerun.

High-risk instances: astropy__astropy-14369, matplotlib__matplotlib-22719.

## Token-path audit finding

The token-path audit showed that VTRACE's overhead was primarily a turn-count/cache-read amplification problem, not a capsule-size problem. 96% of the positive token deltas were cache-read movement caused by extra agent turns: repeated Read/Grep/Bash search loops that re-read the conversation prefix and erase the first-pass token savings.

## Policy added

This milestone converts that finding into an active Stage 5 token-discipline policy (STAGE5_TOKEN_DISCIPLINE), injected on the vtrace-only context path. When Capsule v2 provides a strong lead pivot, the agent is instructed to patch from the capsule before broad rediscovery, under concrete pre-edit tool budgets. The goal is to reduce repeated Read/Grep/Bash turns that re-read the conversation prefix and erase first-pass token savings.

Pre-edit tool budgets (strong-context patch-first mode):
- at most 2 search/grep/read calls before the first edit;
- at most 1 Bash inspection command before the first edit (test runs aside);
- at most 1 re-read of an already-read file.

## Strong-context patch-first mode

strong_context is true when a Capsule v2 lead pivot exists, the lead pivot names a file, support snippets exist, and the context was injected successfully. Such tasks receive the patch-first / low-search policy; weak-context tasks receive weaker, exploratory guidance.

Tasks that would receive strong_context_patch_first:
- astropy__astropy-14369
- matplotlib__matplotlib-22719
- psf__requests-5414
- sphinx-doc__sphinx-7462
- sympy__sympy-16766

## Historical overhead cases

| instance | tokenΔ% | telemetry | risk | turn-count caused | patch-first | capped by budget |
|---|---:|---|---|---|---|---|
| django__django-10880 | +45.2% | no | unknown | no | no | no |
| django__django-11095 | +86.5% | no | unknown | no | no | no |
| astropy__astropy-14369 | +9.4% | yes | high | yes | yes | yes |
| matplotlib__matplotlib-22719 | +132.7% | yes | high | yes | yes | yes |
| psf__requests-5414 | +29.8% | yes | medium | yes | yes | yes |
| sphinx-doc__sphinx-7462 | +1.8% | yes | low | no | yes | yes |
| sympy__sympy-16766 | +0.6% | yes | medium | yes | yes | yes |

- **astropy__astropy-14369**: 23 tool calls, 13 Bash, 2 search/grep, 1 repeated read(s), 0 repeated search(es); longBashLoop=yes, strongContextOversearch=yes, risk=high.
- **matplotlib__matplotlib-22719**: 30 tool calls, 16 Bash, 4 search/grep, 5 repeated read(s), 0 repeated search(es); longBashLoop=yes, strongContextOversearch=yes, risk=high.
- **psf__requests-5414**: 9 tool calls, 3 Bash, 1 search/grep, 1 repeated read(s), 0 repeated search(es); longBashLoop=no, strongContextOversearch=no, risk=medium.
- **sphinx-doc__sphinx-7462**: 7 tool calls, 2 Bash, 1 search/grep, 0 repeated read(s), 0 repeated search(es); longBashLoop=no, strongContextOversearch=no, risk=low.
- **sympy__sympy-16766**: 12 tool calls, 4 Bash, 2 search/grep, 1 repeated read(s), 0 repeated search(es); longBashLoop=no, strongContextOversearch=no, risk=medium.

## Expected token impact

5 case(s) would have hit the new pre-edit tool budgets and had their search/Bash loops cut short: astropy__astropy-14369, matplotlib__matplotlib-22719, psf__requests-5414, sphinx-doc__sphinx-7462, sympy__sympy-16766. Because most of the positive token delta on these cases was cache-read amplification from those extra turns, capping the turns is the lever expected to recover the lost token savings.

This is a readiness estimate from historical telemetry, not a measured reduction. The actual token impact is only established by paired baseline-vs-vtrace reruns with the policy active.

## Telemetry gaps

Cases without ordered tool-call telemetry (cause cannot be attributed):
- django__django-10880 (tokenΔ +45.2%) — overhead, needs rerun
- django__django-11095 (tokenΔ +86.5%) — overhead, needs rerun
- django__django-11490 (tokenΔ -29.2%)
- django__django-11728 (tokenΔ -30.4%)
- django__django-11740 (tokenΔ -22.5%)

## Recommended rerun

Rerun these paired tasks with STAGE5_TOKEN_DISCIPLINE active to measure the real delta:
- django__django-10880
- django__django-11095

Recommended next step: paired baseline-vs-vtrace reruns of the high-risk and capped cases above, comparing total tokens with and without the policy, capturing ordered tool logs for every run.

## Non-claims

- This report does not prove a new token-reduction percentage.
- This report does not run agents or Docker.
- This report does not claim the loop issue is solved until paired reruns are performed.
- This report does not change generated-parser repair accounting.
