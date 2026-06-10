# Stage 5 policy accounting

_Generated: 2026-06-10T19:36:07.345Z_

_Reporting/accounting only. Re-runs nothing (no agent, no live critic, no repair, no Docker); accounts for observed artifacts and verified repaired-patch evaluations over the controlled task set._

## Summary

2 verified conversion(s): vtrace_first_patch resolved 5/10 → gated repair 7/10. Cost-per-resolved improved ($1.6418 → $1.2583 with recovery cost included). Baseline remains 8/10 at $0.8722/resolved.

- controlled tasks: **10**
- verified conversions: **2**
- resolved: baseline **8**, vtrace_first_patch **5**, gated repair **7**
- recovery cost added (critic+repair): **$0.5993**

## Policies compared

- `baseline` — Existing baseline result for each controlled task.
- `vtrace_first_patch` — Existing VTRACE result before critic/repair.
- `vtrace_with_observed_gated_repair` — vtrace_first_patch with verified repaired-patch conversions applied to RESOLUTION only (recovery cost not added — optimistic ceiling).
- `vtrace_with_live_critic_observation_cost` — vtrace_first_patch plus live-critic observation cost where critic was run; resolution UNCHANGED (pure overhead).
- `vtrace_with_verified_repair_cost` — Realistic gated repair: verified conversions change resolution AND add critic+repair cost only for those conversions.

## Resolution results

| policy | tasks | resolved | unresolved | unknown | conversions |
| --- | --- | --- | --- | --- | --- |
| baseline | 10 | 8 | 2 | 0 | 0 |
| vtrace_first_patch | 10 | 5 | 5 | 0 | 0 |
| vtrace_with_observed_gated_repair | 10 | 7 | 3 | 0 | 2 |
| vtrace_with_live_critic_observation_cost | 10 | 5 | 5 | 0 | 0 |
| vtrace_with_verified_repair_cost | 10 | 7 | 3 | 0 | 2 |

## Cost accounting

| policy | agent $ | critic $ | repair $ | total $ | mean $ |
| --- | --- | --- | --- | --- | --- |
| baseline | $6.9777 | n/a | n/a | $6.9777 | $0.6978 |
| vtrace_first_patch | $8.2089 | n/a | n/a | $8.2089 | $0.8209 |
| vtrace_with_observed_gated_repair | $8.2089 | n/a | n/a | $8.2089 | $0.8209 |
| vtrace_with_live_critic_observation_cost | $8.2089 | $0.3503 | n/a | $8.5592 | $0.8559 |
| vtrace_with_verified_repair_cost | $8.2089 | $0.2583 | $0.3410 | $8.8082 | $0.8808 |

## Token accounting

| policy | total tokens | mean tokens | critic in | critic out | repair in | repair out |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 16756692 | 1675669 | null | null | null | null |
| vtrace_first_patch | 17074981 | 1707498 | null | null | null | null |
| vtrace_with_observed_gated_repair | 17074981 | 1707498 | null | null | null | null |
| vtrace_with_live_critic_observation_cost | 17094636 | 1709464 | 12937 | 6718 | null | null |
| vtrace_with_verified_repair_cost | 17102010 | 1710201 | 8686 | 5480 | 10366 | 2497 |

## Cost per resolved task

| policy | resolved | total $ | cost / resolved |
| --- | --- | --- | --- |
| baseline | 8 | $6.9777 | $0.8722 |
| vtrace_first_patch | 5 | $8.2089 | $1.6418 |
| vtrace_with_observed_gated_repair | 7 | $8.2089 | $1.1727 |
| vtrace_with_live_critic_observation_cost | 5 | $8.5592 | $1.7118 |
| vtrace_with_verified_repair_cost | 7 | $8.8082 | $1.2583 |

## Token per resolved task

| policy | resolved | total tokens | tokens / resolved |
| --- | --- | --- | --- |
| baseline | 8 | 16756692 | 2094587 |
| vtrace_first_patch | 5 | 17074981 | 3414996 |
| vtrace_with_observed_gated_repair | 7 | 17074981 | 2439283 |
| vtrace_with_live_critic_observation_cost | 5 | 17094636 | 3418927 |
| vtrace_with_verified_repair_cost | 7 | 17102010 | 2443144 |

## Repair conversions included

| run | instance | first resolved | repaired resolved | converted | critic $ | repair $ | recovery $ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| eval-patchverify-before-requests-5414 | psf__requests-5414 | false | true | true | $0.1365 | $0.1334 | $0.2699 |
| eval-patchverify-before-sympy-16766 | sympy__sympy-16766 | false | true | true | $0.1218 | $0.2076 | $0.3294 |

_Cost sources:_
- agentCostUsd ← stage5_controlled_10_task_plan.json selectedTasks (baselineCost / vtraceCost).
- criticCostUsd ← stage5_live_critic_high_risk_comparison.json (mean per-instance observation) and stage5_repair_conversion_*.json costs.criticCostUsd (verified conversions).
- repairCostUsd ← stage5_repair_conversion_*.json costs.repairCostUsd (verified conversions only).

_Token sources:_
- agent tokens ← stage5_controlled_10_task_plan.json selectedTasks (baselineTokens / vtraceTokens; total tokens incl. cache).
- critic tokens ← stage5_live_critic_high_risk_comparison.json and stage5_repair_conversion_*.json costs.criticInput/OutputTokens.
- repair tokens ← stage5_repair_conversion_*.json costs.repairInput/OutputTokens (verified conversions only).

## Interpretation

1. **Did the verified repair conversion improve resolved count?** Yes — vtrace_first_patch 5 → gated repair 7 (+2).
2. **How much extra cost/tokens did recovery add?** $0.5993 and 27029 tokens, for the verified conversion(s) only.
3. **Did cost per resolved improve or worsen?** Within vtrace it **improved** ($1.6418 → $1.2583 with recovery cost). Baseline is still cheaper at $0.8722/resolved.
4. **Did tokens per resolved improve or worsen?** Within vtrace it **improved** (3414996 → 2439283). Baseline is still leaner at 2094587/resolved.
5. **Is there enough evidence to run the three Requests repairs?** Not yet — only 2 verified conversion(s).
6. **Does this support always-on critic/repair?** **No.** Gated, disabled-by-default repair recovered one lost resolution cheaply, but vtrace_first_patch is still behind baseline; the dominant lever is reducing default Capsule/agent tokens, not always-on repair.

## Recommended next step

**Option C.** Run only one Requests repair smoke, then update the policy accounting.

2 verified conversions improved cost-per-resolved within vtrace (from $1.6418 to $1.2583 per resolved) and recovery was cheap ($0.2583 critic + $0.3410 repair), but n=2 is still too thin to commit to a batch (the batch threshold is 3 verified conversions); gather one more verified conversion (Requests) and re-account.

## Non-claims

- This is not a VEXP comparison.
- This is not a statistically meaningful SWE-bench benchmark.
- This does not prove aggregate resolution improvement.
- This does not justify always-on critic/repair.
- This does not change production behavior.
- This only accounts for observed artifacts and verified repaired-patch evaluations.

