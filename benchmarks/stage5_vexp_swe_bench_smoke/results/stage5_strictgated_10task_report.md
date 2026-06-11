# Stage 5 strict-gated 10-task comparison

_Generated: 2026-06-11T07:56:33.148Z_

_Reporting / accounting only. No agents, no live critic, no repair, no Docker. Usage / cost / resolution come from the SWE-bench JSONL row; VTRACE policy / context metadata from `_run.meta.json`; ordered tool calls from `_tool_calls.json`; evaluation from `_eval.meta.json`. Token and cost numbers are never sourced from `_run.meta.json`. The primary comparison is controlled VTRACE → strict_risk_gated; baseline is shown for context. CLI policy flags are benchmark/dev controls only. No retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator / policy behavior is changed, and no raw artifact is mutated._

**Question:** Should strict_risk_gated become the internal default policy for Stage 5 first-pass VTRACE?

## Summary

Controlled set: 10 tasks. Paired (old VTRACE + strict present): 10; missing strict: 0.

Across paired tasks, controlled VTRACE → strict: tokens 17,074,981 → 12,526,985 (-4,547,996, -26.6%); cost $8.2089 → $6.4080 ($-1.8008, -21.9%); resolved 5 → 7.

Resolved counts — baseline: 8, controlled VTRACE: 5, strict: 7. Resolution wins: 2; losses: 0; net: +2. Suppression claimable (strict): 9/10.

**Decision: make_default** — Make strict_risk_gated the internal Stage 5 default PIVOT_CHECK policy. This should be an internal default policy, not a normal user toggle. Users should see simple modes such as auto/fast/thorough/debug.

## Task coverage

| instance | status | baseline label | old VTRACE label | strict label |
| --- | --- | --- | --- | --- |
| django__django-10880 | complete | `eval-10880` | `eval-10880` | `eval-strictgated-vtrace-django-10880` |
| django__django-11095 | complete | `eval-11095` | `eval-11095` | `eval-strictgated-vtrace-django-11095` |
| django__django-11490 | complete | `eval-11490` | `eval-11490` | `eval-strictgated-vtrace-django-11490` |
| django__django-11728 | complete | `eval-11728` | `eval-11728` | `eval-strictgated-vtrace-django-11728` |
| django__django-11740 | complete | `eval-11740` | `eval-11740` | `eval-strictgated-vtrace-django-11740` |
| astropy__astropy-14369 | complete | `eval-baseline-vs-vtrace-baseline-astropy-14369` | `eval-controlled-vtrace-astropy-14369` | `eval-strictgated-vtrace-astropy-14369` |
| matplotlib__matplotlib-22719 | complete | `eval-localization-gap-baseline-matplotlib-22719` | `eval-controlled-vtrace-matplotlib-22719` | `eval-strictgated-vtrace-matplotlib-22719` |
| psf__requests-5414 | complete | `eval-baseline-vs-vtrace-baseline-requests-5414` | `eval-controlled-vtrace-requests-5414` | `eval-strictgated-vtrace-requests-5414` |
| sphinx-doc__sphinx-7462 | complete | `eval-localization-gap-baseline-sphinx-7462` | `eval-controlled-vtrace-sphinx-7462` | `eval-strictgated-vtrace-sphinx-7462` |
| sympy__sympy-16766 | complete | `eval-baseline-vs-vtrace-baseline-sympy-16766` | `eval-controlled-vtrace-sympy-16766` | `eval-strictgated-vtrace-sympy-16766` |

## Aggregate comparison

_Token/cost aggregates for old VTRACE and strict are over paired tasks only._

| metric | baseline | old VTRACE | strict | old→strict Δ |
| --- | --- | --- | --- | --- |
| totalTokens | 16,756,692 | 17,074,981 | 12,526,985 | -4,547,996 (-26.6%) |
| totalCost | $6.9777 | $8.2089 | $6.4080 | $-1.8008 (-21.9%) |
| resolved | 8 | 5 | 7 | wins 2 / losses 0 / net +2 |

| metric | value |
| --- | --- |
| taskCount | 10 |
| pairedCount | 10 |
| missingStrictCount | 0 |
| suppressionClaimableCount | 9 |
| strictPivotCheckInjectedCount | 1 |
| strictEditGuardInjectedCount | 1 |
| strictPatchVerifyInjectedCount | 1 |

## Per-task comparison

| instance | tokens base / old / strict | cost base / old / strict | resolved base / old / strict | old→strict token Δ (Δ%) | old→strict cost Δ | resolution |
| --- | --- | --- | --- | --- | --- | --- |
| django__django-10880 | 432,600 / 628,051 / 523,397 | $0.2088 / $0.2561 / $0.2935 | yes / yes / yes | -104,654 (-16.7%) | $0.0374 | same |
| django__django-11095 | 535,997 / 999,877 / 581,178 | $0.2230 / $0.3553 / $0.3095 | yes / yes / yes | -418,699 (-41.9%) | $-0.0458 | same |
| django__django-11490 | 4,661,640 / 3,301,462 / 1,154,475 | $1.6256 / $1.0802 / $0.6612 | yes / yes / yes | -2,146,987 (-65.0%) | $-0.4190 | same |
| django__django-11728 | 1,716,132 / 1,194,127 / 1,612,163 | $0.7336 / $0.5916 / $0.7751 | yes / yes / yes | +418,036 (+35.0%) | $0.1835 | same |
| django__django-11740 | 2,387,415 / 1,849,882 / 2,468,980 | $0.9119 / $0.6621 / $1.1265 | yes / yes / yes | +619,098 (+33.5%) | $0.4644 | same |
| astropy__astropy-14369 | 3,076,313 / 3,365,366 / 2,508,804 | $1.5550 / $3.0284 / $1.4102 | no / no / no | -856,562 (-25.5%) | $-1.6182 | same |
| matplotlib__matplotlib-22719 | 1,167,993 / 2,718,398 / 1,059,041 | $0.4638 / $0.9627 / $0.4900 | yes / no / yes | -1,659,357 (-61.0%) | $-0.4727 | win |
| psf__requests-5414 | 736,898 / 956,785 / 805,298 | $0.4726 / $0.4065 / $0.4120 | yes / no / no | -151,487 (-15.8%) | $0.0055 | same |
| sphinx-doc__sphinx-7462 | 627,263 / 638,586 / 1,134,164 | $0.2651 / $0.2895 / $0.5058 | no / no / no | +495,578 (+77.6%) | $0.2163 | same |
| sympy__sympy-16766 | 1,414,441 / 1,422,447 / 679,485 | $0.5185 / $0.5765 / $0.4243 | yes / no / yes | -742,962 (-52.2%) | $-0.1523 | win |

Where a risk_gated run is available, its tokens are shown for reference:

| instance | risk_gated tokens | risk_gated cost | risk_gated resolved |
| --- | --- | --- | --- |
| astropy__astropy-14369 | 3,649,897 | $1.7340 | no |
| matplotlib__matplotlib-22719 | 1,277,672 | $0.7695 | yes |
| psf__requests-5414 | 1,676,057 | $0.6887 | no |

## Pivot-check suppression outcomes

| instance | strict policy | risk signals | wouldInjectUnderMultiPivot | pivotCheckInjected | editGuardInjected | patchVerifyInjected | suppressionClaimable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-10880 | strict_risk_gated | [hidden_pivot] | yes | no | no | no | yes |
| django__django-11095 | strict_risk_gated | [hidden_pivot] | yes | no | no | no | yes |
| django__django-11490 | strict_risk_gated | [hidden_pivot, edit_risk_directives] | yes | yes | yes | yes | no |
| django__django-11728 | strict_risk_gated | [hidden_pivot] | yes | no | no | no | yes |
| django__django-11740 | strict_risk_gated | [hidden_pivot] | yes | no | no | no | yes |
| astropy__astropy-14369 | strict_risk_gated | [hidden_pivot] | yes | no | no | no | yes |
| matplotlib__matplotlib-22719 | strict_risk_gated | [hidden_pivot] | yes | no | no | no | yes |
| psf__requests-5414 | strict_risk_gated | [hidden_pivot] | yes | no | no | no | yes |
| sphinx-doc__sphinx-7462 | strict_risk_gated | [hidden_pivot] | yes | no | no | no | yes |
| sympy__sympy-16766 | strict_risk_gated | [hidden_pivot] | yes | no | no | no | yes |

`suppressionClaimable` is true ONLY when `wouldInjectUnderMultiPivot === true` AND `pivotCheckInjected === false` — strict_risk_gated actively withheld a checklist the multi-pivot heuristic would have injected.

## Token/cost/turn impact

| instance | turns old→strict (Δ) | ordered tool calls old→strict (Δ) | tokens Δ% | cost Δ% |
| --- | --- | --- | --- | --- |
| django__django-10880 | 21→17 (-4) | n/a→5 (n/a) | -16.7% | +14.6% |
| django__django-11095 | 32→19 (-13) | n/a→7 (n/a) | -41.9% | -12.9% |
| django__django-11490 | 80→31 (-49) | n/a→10 (n/a) | -65.0% | -38.8% |
| django__django-11728 | 32→42 (+10) | n/a→17 (n/a) | +35.0% | +31.0% |
| django__django-11740 | 50→47 (-3) | n/a→18 (n/a) | +33.5% | +70.1% |
| astropy__astropy-14369 | 60→47 (-13) | 23→17 (-6) | -25.5% | -53.4% |
| matplotlib__matplotlib-22719 | 69→30 (-39) | 30→11 (-19) | -61.0% | -49.1% |
| psf__requests-5414 | 27→25 (-2) | 9→8 (-1) | -15.8% | +1.3% |
| sphinx-doc__sphinx-7462 | 19→33 (+14) | 7→13 (+6) | +77.6% | +74.7% |
| sympy__sympy-16766 | 31→17 (-14) | 12→5 (-7) | -52.2% | -26.4% |

## Resolution outcomes

| instance | baseline | old VTRACE | strict | old→strict |
| --- | --- | --- | --- | --- |
| django__django-10880 | yes | yes | yes | same |
| django__django-11095 | yes | yes | yes | same |
| django__django-11490 | yes | yes | yes | same |
| django__django-11728 | yes | yes | yes | same |
| django__django-11740 | yes | yes | yes | same |
| astropy__astropy-14369 | no | no | no | same |
| matplotlib__matplotlib-22719 | yes | no | yes | win |
| psf__requests-5414 | yes | no | no | same |
| sphinx-doc__sphinx-7462 | no | no | no | same |
| sympy__sympy-16766 | yes | no | yes | win |

Resolution wins (old unresolved → strict resolved): 2; losses (old resolved → strict unresolved): 0; net: +2.

## Relationship to repair accounting

Verified repair is a SEPARATE downstream pass and is accounted by its own reports (e.g. the Stage 5 patch-repair smoke reports). This report covers FIRST-PASS VTRACE only: strict gating reduces first-pass tokens/turns by suppressing PIVOT_CHECK on hidden-pivot-only tasks, but does not itself repair an unresolved patch. A task that strict leaves unresolved may still be recovered by verified repair, which is counted elsewhere. This report does not re-run or re-account repair, and does not recommend duplicate repair experiments.

## Default-policy recommendation

**Decision: make_default.** Make strict_risk_gated the internal Stage 5 default PIVOT_CHECK policy. This should be an internal default policy, not a normal user toggle. Users should see simple modes such as auto/fast/thorough/debug.

Recommendation rule: recommend making strict_risk_gated the internal default only when strict has lower total tokens AND lower total cost than controlled VTRACE, no net resolution regression, and a meaningful suppression count (≥ 3). If strict saves tokens but loses resolution, hold and find the lost task's missing risk signal. If strict does not save tokens, hold and keep risk_gated while investigating tool-loop causes.

## Non-claims

- This is a single controlled 10-task set, not a statistical benchmark; no significance is claimed.
- It does not isolate which factor (tool-loop behavior, stochasticity, sampling) drove any token change.
- It does not change retrieval, Capsule v2, PIVOT_CHECK, EDIT_GUARD, PATCH_VERIFY, probes, critic, repair, the evaluator, or policy behavior.
- It does not rerun agents or Docker; usage/cost/resolution are read verbatim from existing run + docker-eval artifacts.
- CLI policy flags are benchmark/dev controls only; the recommendation concerns the internal default, not a user-facing toggle.
- Repair accounting is tracked by separate reports; this report does not re-run or re-account repair.

