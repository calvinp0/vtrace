# Stage 5 policy accounting

_Generated: 2026-06-11T14:43:54.232Z_

_Reporting/accounting only. Re-runs nothing (no agent, no live critic, no repair, no Docker); accounts for strict-gated first-pass runs, observed artifacts, and verified repaired-patch evaluations over the controlled task set._

## Summary

strict_vtrace_first_patch (the internal Stage 5 default) resolved 7/10 using 12.53M tokens at $6.41, improving on old_vtrace_first_patch (5/10, 17.07M, $8.21) and remaining one resolved task behind baseline (8/10, 16.76M, $6.98). Applying 1 strict-specific verified repair conversion(s) (psf__requests-5414), strict_vtrace_with_verified_repair reaches 8/10 at $6.82 / 12.54M, matching baseline resolution at lower total cost and fewer tokens. Verified OLD-VTRACE repair (4 artifact(s), 2 unique task recovery(ies)) is accounted separately and never transferred to strict.

- controlled tasks: **10**
- resolved: baseline **8**, old_vtrace_first_patch **5**, strict_vtrace_first_patch **7**, strict_vtrace_with_verified_repair **8**
- strict vs old VTRACE: resolved **+2**, tokens **-4.55M**, cost **-$1.80**
- strict vs baseline: resolved **-1**, tokens **-4.23M**, cost **-$0.57**
- strict+repair vs baseline: resolved **0**, tokens **-4.21M**, cost **-$0.15**
- verified OLD-VTRACE repair artifacts: **4** (**2** unique task recoveries: psf__requests-5414, sympy__sympy-16766) — accounted under `old_vtrace_with_verified_repair`, never transferred to strict
- strict-specific repair conversions: **1** artifact(s) (**1** unique task recoveries: psf__requests-5414) — accounted under `strict_vtrace_with_verified_repair` only

## Policies compared

- `baseline` — Existing baseline result for each controlled task (no VTRACE).
- `old_vtrace_first_patch` — Old VTRACE first-patch result before the strict gate and before critic/repair.
- `strict_vtrace_first_patch` — Strict-gated first-pass VTRACE (the internal Stage 5 default). First patch only — NO repair conversions are transferred from old VTRACE.
- `old_vtrace_with_observed_gated_repair` — old_vtrace_first_patch with verified OLD-VTRACE repaired-patch conversions applied to RESOLUTION only (recovery cost not added — optimistic ceiling).
- `old_vtrace_with_live_critic_observation_cost` — old_vtrace_first_patch plus live-critic observation cost where critic was run; resolution UNCHANGED (pure overhead).
- `old_vtrace_with_verified_repair` — Realistic OLD-VTRACE gated repair: verified OLD-VTRACE conversions change resolution AND add critic+repair cost only for those conversions. Tied to the old first patches, never strict.
- `strict_vtrace_with_verified_repair` — Realistic STRICT gated repair: starts from strict_vtrace_first_patch and applies ONLY strict-specific verified repaired-patch conversions, adding strict critic+repair cost only for those conversions. Never includes old-VTRACE repair conversions.

## Resolution results

| policy | tasks | resolved | unresolved | unknown | Δ vs baseline | Δ vs old VTRACE |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 10 | 8 | 2 | 0 | 0 | +3 |
| old_vtrace_first_patch | 10 | 5 | 5 | 0 | -3 | 0 |
| strict_vtrace_first_patch | 10 | 7 | 3 | 0 | -1 | +2 |
| old_vtrace_with_observed_gated_repair | 10 | 7 | 3 | 0 | -1 | +2 |
| old_vtrace_with_live_critic_observation_cost | 10 | 5 | 5 | 0 | -3 | 0 |
| old_vtrace_with_verified_repair | 10 | 7 | 3 | 0 | -1 | +2 |
| strict_vtrace_with_verified_repair | 10 | 8 | 2 | 0 | 0 | +3 |

## Cost accounting

| policy | agent $ | critic $ | repair $ | total $ | mean $ | Δ$ vs baseline | Δ$ vs old VTRACE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | $6.9777 | n/a | n/a | $6.9777 | $0.6978 | +$0.00 | -$1.23 |
| old_vtrace_first_patch | $8.2089 | n/a | n/a | $8.2089 | $0.8209 | +$1.23 | +$0.00 |
| strict_vtrace_first_patch | $6.4080 | n/a | n/a | $6.4080 | $0.6408 | -$0.57 | -$1.80 |
| old_vtrace_with_observed_gated_repair | $8.2089 | n/a | n/a | $8.2089 | $0.8209 | +$1.23 | +$0.00 |
| old_vtrace_with_live_critic_observation_cost | $8.2089 | $0.3503 | n/a | $8.5592 | $0.8559 | +$1.58 | +$0.35 |
| old_vtrace_with_verified_repair | $8.2089 | $0.2598 | $0.3105 | $8.7793 | $0.8779 | +$1.80 | +$0.57 |
| strict_vtrace_with_verified_repair | $6.4080 | $0.1909 | $0.2241 | $6.8230 | $0.6823 | -$0.15 | -$1.39 |

## Token accounting

| policy | total tokens | mean tokens | Δtok vs baseline | Δtok vs old VTRACE | critic in | critic out | repair in | repair out |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 16756692 | 1675669 | +0.00M | -0.32M | null | null | null | null |
| old_vtrace_first_patch | 17074981 | 1707498 | +0.32M | +0.00M | null | null | null | null |
| strict_vtrace_first_patch | 12526985 | 1252699 | -4.23M | -4.55M | null | null | null | null |
| old_vtrace_with_observed_gated_repair | 17074981 | 1707498 | +0.32M | +0.00M | null | null | null | null |
| old_vtrace_with_live_critic_observation_cost | 17094636 | 1709464 | +0.34M | +0.02M | 12937 | 6718 | null | null |
| old_vtrace_with_verified_repair | 17102353 | 1710235 | +0.35M | +0.03M | 8686 | 5492 | 10364 | 2830 |
| strict_vtrace_with_verified_repair | 12543588 | 1254359 | -4.21M | -4.53M | 4343 | 4327 | 6126 | 1807 |

## Cost per resolved task

| policy | resolved | total $ | cost / resolved |
| --- | --- | --- | --- |
| baseline | 8 | $6.9777 | $0.8722 |
| old_vtrace_first_patch | 5 | $8.2089 | $1.6418 |
| strict_vtrace_first_patch | 7 | $6.4080 | $0.9154 |
| old_vtrace_with_observed_gated_repair | 7 | $8.2089 | $1.1727 |
| old_vtrace_with_live_critic_observation_cost | 5 | $8.5592 | $1.7118 |
| old_vtrace_with_verified_repair | 7 | $8.7793 | $1.2542 |
| strict_vtrace_with_verified_repair | 8 | $6.8230 | $0.8529 |

## Token per resolved task

| policy | resolved | total tokens | tokens / resolved |
| --- | --- | --- | --- |
| baseline | 8 | 16756692 | 2094587 |
| old_vtrace_first_patch | 5 | 17074981 | 3414996 |
| strict_vtrace_first_patch | 7 | 12526985 | 1789569 |
| old_vtrace_with_observed_gated_repair | 7 | 17074981 | 2439283 |
| old_vtrace_with_live_critic_observation_cost | 5 | 17094636 | 3418927 |
| old_vtrace_with_verified_repair | 7 | 17102353 | 2443193 |
| strict_vtrace_with_verified_repair | 8 | 12543588 | 1567949 |

## Strict-gated first-pass accounting

**strict_vtrace_first_patch improves over old_vtrace_first_patch:**

- resolved 5/10 → 7/10
- tokens 17.07M → 12.53M
- cost $8.21 → $6.41

**strict_vtrace_first_patch remains one resolved task behind baseline:** strict 7/10 vs baseline 8/10.

strict_vtrace_first_patch uses fewer total tokens and lower total cost than baseline in this controlled set, but lower total cost does not imply higher success rate.

| metric | baseline | old_vtrace_first_patch | strict_vtrace_first_patch |
| --- | --- | --- | --- |
| resolved | 8/10 | 5/10 | 7/10 |
| total tokens | 16756692 | 17074981 | 12526985 |
| total cost | $6.9777 | $8.2089 | $6.4080 |
| cost / resolved | $0.8722 | $1.6418 | $0.9154 |
| tokens / resolved | 2094587 | 3414996 | 1789569 |

## Strict repair accounting

**strict_vtrace_with_verified_repair** starts from **strict_vtrace_first_patch** (7/10) and applies 1 strict-specific verified repair conversion(s) — `psf__requests-5414` — reaching **8/10** resolved.

strict_vtrace_with_verified_repair reaches 8/10 by applying one strict-specific verified repair conversion: psf__requests-5414.

This strict repair conversion is not transferred from old VTRACE repair evidence. It was generated from the strict first patch run eval-strictgated-vtrace-requests-5414.

- added strict critic cost: $0.1909
- added strict repair cost: $0.2241
- added strict recovery cost (critic + repair): $0.4150
- strict first-pass total cost: $6.4080
- strict+repair total cost: $6.8230

strict_vtrace_with_verified_repair matches baseline resolved count in this controlled set (8/10 vs baseline 8/10), while cost/token totals must be read from the accounting table.

strict_vtrace_with_verified_repair matches baseline resolution while using lower total cost and fewer total tokens.

| metric | baseline | strict_vtrace_first_patch | strict_vtrace_with_verified_repair |
| --- | --- | --- | --- |
| resolved | 8/10 | 7/10 | 8/10 |
| total tokens | 16756692 | 12526985 | 12543588 |
| total cost | $6.9777 | $6.4080 | $6.8230 |
| cost / resolved | $0.8722 | $0.9154 | $0.8529 |
| tokens / resolved | 2094587 | 1789569 | 1567949 |

## Repair accounting boundary

- Old VTRACE repairs and strict VTRACE repairs are separate evidence sets. A repaired patch only applies to the first patch whose run label produced it.
- Verified old repair conversions are tied to the old VTRACE first patches. They are not automatically counted as strict repairs unless strict-specific repaired-patch evaluation exists.
- Old conversions are accounted ONLY under `old_vtrace_with_verified_repair`; strict-specific conversions are accounted ONLY under `strict_vtrace_with_verified_repair`. Neither is ever transferred across the boundary.
- `strict_vtrace_with_verified_repair` starts from `strict_vtrace_first_patch` and applies only strict-specific verified repaired-patch evaluations produced from strict first patches; it carries no old-VTRACE repair recovery.

4 OLD-VTRACE verified repaired-patch artifact(s) (→ 2 unique recovery(ies) under `old_vtrace_with_verified_repair`) and 1 STRICT verified repaired-patch artifact(s) (→ 1 unique recovery(ies) under `strict_vtrace_with_verified_repair`) resolved under Docker. Each artifact row is an individual repair run, tagged by its first-patch family (source); multiple rows for one instance are still one task recovery, and old/strict rows are never merged.

| run | instance | source | first resolved | repaired resolved | converted | critic $ | repair $ | recovery $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eval-patchverify-before-requests-5414 | psf__requests-5414 | old | false | true | true | $0.1365 | $0.1334 | $0.2699 |
| eval-editguard-after-requests-5414 | psf__requests-5414 | old | false | true | true | $0.1195 | $0.0997 | $0.2192 |
| eval-editguard-before-requests-5414 | psf__requests-5414 | old | false | true | true | $0.1380 | $0.1029 | $0.2410 |
| eval-strictgated-vtrace-requests-5414 | psf__requests-5414 | strict | false | true | true | $0.1909 | $0.2241 | $0.4150 |
| eval-patchverify-before-sympy-16766 | sympy__sympy-16766 | old | false | true | true | $0.1218 | $0.2076 | $0.3294 |

Unique OLD-VTRACE task recoveries (de-duplicated by instance): `psf__requests-5414`, `sympy__sympy-16766`. These belong to `old_vtrace_with_verified_repair`, not to strict.

Unique STRICT task recoveries (de-duplicated by instance): `psf__requests-5414`. These belong to `strict_vtrace_with_verified_repair`, not to old VTRACE.

_Cost sources:_
- old agentCostUsd ← stage5_controlled_10_task_plan.json selectedTasks (baselineCost / vtraceCost).
- strict agentCostUsd ← stage5_strictgated_10task_report.json tasks[].strict.costUsd (joined by instanceId).
- criticCostUsd ← stage5_live_critic_high_risk_comparison.json (mean per-instance observation) and stage5_repair_conversion_*.json costs.criticCostUsd (conversions matched to the policy family by run label).
- repairCostUsd ← stage5_repair_conversion_*.json costs.repairCostUsd (OLD conversions → old_vtrace_with_verified_repair; strictgated conversions → strict_vtrace_with_verified_repair).

_Token sources:_
- old agent tokens ← stage5_controlled_10_task_plan.json selectedTasks (baselineTokens / vtraceTokens; total tokens incl. cache).
- strict agent tokens ← stage5_strictgated_10task_report.json tasks[].strict.totalTokens (joined by instanceId).
- critic tokens ← stage5_live_critic_high_risk_comparison.json and stage5_repair_conversion_*.json costs.criticInput/OutputTokens (matched to the policy family by run label).
- repair tokens ← stage5_repair_conversion_*.json costs.repairInput/OutputTokens (OLD conversions → old repair row; strictgated conversions → strict repair row).

## Recommended next step

Stop Stage 5 repair experiments for now. Summarize the final Stage 5 policy story and move back to broader VTRACE productization/release hardening.

strict_vtrace_with_verified_repair reaches 8/10, matching baseline (8/10) at no worse cost ($6.82 vs $6.98) and no more tokens (12.54M vs 16.76M). The strict policy story is complete for this controlled set, so further Stage 5 repair experiments are not warranted. Do NOT duplicate the verified strict Requests repair and do NOT trigger full reruns unless a specific regression is discovered.

_Strict repair-target guidance: No strict-specific repair experiment is warranted: every controlled task that is still unresolved under the strict first pass lacks prior verified OLD-VTRACE repair evidence, so there is no defect-class signal that strict-specific repair would recover._

_OLD-VTRACE repair-experiment guidance (separate track): Option D — Stop duplicate Requests repair runs. Shift back to reducing default VTRACE first-pass token use and/or expand the controlled set with new unique high-risk tasks before more repair experiments._

## Non-claims

- This is not a VEXP comparison.
- This is not a statistically meaningful SWE-bench benchmark.
- This does not prove aggregate resolution improvement.
- This does not justify always-on critic/repair.
- This does not change production behavior.
- This only accounts for observed artifacts and verified repaired-patch evaluations.
- strict_vtrace_first_patch using fewer total tokens and lower total cost than baseline does NOT imply a higher success rate — strict remains behind baseline on resolved count.
- Verified old repair conversions are NOT transferred to strict accounting; strict carries only strict-specific repair recovery.
- strict_vtrace_with_verified_repair matching baseline resolved count does NOT imply a higher success rate; it reflects one strict-specific verified repair conversion on this controlled set, not an aggregate benchmark.

