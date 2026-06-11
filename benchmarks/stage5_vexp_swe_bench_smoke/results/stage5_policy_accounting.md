# Stage 5 policy accounting

_Generated: 2026-06-11T10:49:02.500Z_

_Reporting/accounting only. Re-runs nothing (no agent, no live critic, no repair, no Docker); accounts for strict-gated first-pass runs, observed artifacts, and verified repaired-patch evaluations over the controlled task set._

## Summary

strict_vtrace_first_patch (the internal Stage 5 default) resolved 7/10 using 12.53M tokens at $6.41, improving on old_vtrace_first_patch (5/10, 17.07M, $8.21) and remaining one resolved task behind baseline (8/10, 16.76M, $6.98). Verified OLD-VTRACE repair (4 artifact(s), 2 unique task recovery(ies)) is accounted separately and never transferred to strict.

- controlled tasks: **10**
- resolved: baseline **8**, old_vtrace_first_patch **5**, strict_vtrace_first_patch **7**
- strict vs old VTRACE: resolved **+2**, tokens **-4.55M**, cost **-$1.80**
- strict vs baseline: resolved **-1**, tokens **-4.23M**, cost **-$0.57**
- verified OLD-VTRACE repair artifacts: **4** (**2** unique task recoveries: psf__requests-5414, sympy__sympy-16766) — accounted under `old_vtrace_with_verified_repair`, never transferred to strict

## Policies compared

- `baseline` — Existing baseline result for each controlled task (no VTRACE).
- `old_vtrace_first_patch` — Old VTRACE first-patch result before the strict gate and before critic/repair.
- `strict_vtrace_first_patch` — Strict-gated first-pass VTRACE (the internal Stage 5 default). First patch only — NO repair conversions are transferred from old VTRACE.
- `old_vtrace_with_observed_gated_repair` — old_vtrace_first_patch with verified repaired-patch conversions applied to RESOLUTION only (recovery cost not added — optimistic ceiling).
- `old_vtrace_with_live_critic_observation_cost` — old_vtrace_first_patch plus live-critic observation cost where critic was run; resolution UNCHANGED (pure overhead).
- `old_vtrace_with_verified_repair` — Realistic OLD-VTRACE gated repair: verified conversions change resolution AND add critic+repair cost only for those conversions. Tied to the old first patches, never strict.

## Resolution results

| policy | tasks | resolved | unresolved | unknown | Δ vs baseline | Δ vs old VTRACE |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 10 | 8 | 2 | 0 | 0 | +3 |
| old_vtrace_first_patch | 10 | 5 | 5 | 0 | -3 | 0 |
| strict_vtrace_first_patch | 10 | 7 | 3 | 0 | -1 | +2 |
| old_vtrace_with_observed_gated_repair | 10 | 7 | 3 | 0 | -1 | +2 |
| old_vtrace_with_live_critic_observation_cost | 10 | 5 | 5 | 0 | -3 | 0 |
| old_vtrace_with_verified_repair | 10 | 7 | 3 | 0 | -1 | +2 |

## Cost accounting

| policy | agent $ | critic $ | repair $ | total $ | mean $ | Δ$ vs baseline | Δ$ vs old VTRACE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | $6.9777 | n/a | n/a | $6.9777 | $0.6978 | +$0.00 | -$1.23 |
| old_vtrace_first_patch | $8.2089 | n/a | n/a | $8.2089 | $0.8209 | +$1.23 | +$0.00 |
| strict_vtrace_first_patch | $6.4080 | n/a | n/a | $6.4080 | $0.6408 | -$0.57 | -$1.80 |
| old_vtrace_with_observed_gated_repair | $8.2089 | n/a | n/a | $8.2089 | $0.8209 | +$1.23 | +$0.00 |
| old_vtrace_with_live_critic_observation_cost | $8.2089 | $0.3503 | n/a | $8.5592 | $0.8559 | +$1.58 | +$0.35 |
| old_vtrace_with_verified_repair | $8.2089 | $0.2598 | $0.3105 | $8.7793 | $0.8779 | +$1.80 | +$0.57 |

## Token accounting

| policy | total tokens | mean tokens | Δtok vs baseline | Δtok vs old VTRACE | critic in | critic out | repair in | repair out |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 16756692 | 1675669 | +0.00M | -0.32M | null | null | null | null |
| old_vtrace_first_patch | 17074981 | 1707498 | +0.32M | +0.00M | null | null | null | null |
| strict_vtrace_first_patch | 12526985 | 1252699 | -4.23M | -4.55M | null | null | null | null |
| old_vtrace_with_observed_gated_repair | 17074981 | 1707498 | +0.32M | +0.00M | null | null | null | null |
| old_vtrace_with_live_critic_observation_cost | 17094636 | 1709464 | +0.34M | +0.02M | 12937 | 6718 | null | null |
| old_vtrace_with_verified_repair | 17102353 | 1710235 | +0.35M | +0.03M | 8686 | 5492 | 10364 | 2830 |

## Cost per resolved task

| policy | resolved | total $ | cost / resolved |
| --- | --- | --- | --- |
| baseline | 8 | $6.9777 | $0.8722 |
| old_vtrace_first_patch | 5 | $8.2089 | $1.6418 |
| strict_vtrace_first_patch | 7 | $6.4080 | $0.9154 |
| old_vtrace_with_observed_gated_repair | 7 | $8.2089 | $1.1727 |
| old_vtrace_with_live_critic_observation_cost | 5 | $8.5592 | $1.7118 |
| old_vtrace_with_verified_repair | 7 | $8.7793 | $1.2542 |

## Token per resolved task

| policy | resolved | total tokens | tokens / resolved |
| --- | --- | --- | --- |
| baseline | 8 | 16756692 | 2094587 |
| old_vtrace_first_patch | 5 | 17074981 | 3414996 |
| strict_vtrace_first_patch | 7 | 12526985 | 1789569 |
| old_vtrace_with_observed_gated_repair | 7 | 17074981 | 2439283 |
| old_vtrace_with_live_critic_observation_cost | 5 | 17094636 | 3418927 |
| old_vtrace_with_verified_repair | 7 | 17102353 | 2443193 |

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

## Repair accounting boundary

- Verified old repair conversions are tied to the old VTRACE first patches. They are not automatically counted as strict repairs unless strict-specific repaired-patch evaluation exists.
- These conversions are accounted under `old_vtrace_with_verified_repair`, never under a `strict_with_repair` row.
- No strict repair policy row exists because no strict repaired-patch artifacts exist. Strict resolution is read straight from the strict first-pass run artifacts.

4 verified repaired-patch artifact(s) resolved under Docker, corresponding to 2 unique controlled task recovery(ies) under `old_vtrace_with_verified_repair`. Each artifact row is an individual OLD-VTRACE repair run; multiple rows for one instance are still one task recovery.

| run | instance | first resolved | repaired resolved | converted | critic $ | repair $ | recovery $ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| eval-patchverify-before-requests-5414 | psf__requests-5414 | false | true | true | $0.1365 | $0.1334 | $0.2699 |
| eval-editguard-after-requests-5414 | psf__requests-5414 | false | true | true | $0.1195 | $0.0997 | $0.2192 |
| eval-editguard-before-requests-5414 | psf__requests-5414 | false | true | true | $0.1380 | $0.1029 | $0.2410 |
| eval-patchverify-before-sympy-16766 | sympy__sympy-16766 | false | true | true | $0.1218 | $0.2076 | $0.3294 |

Unique OLD-VTRACE task recoveries (de-duplicated by instance): `psf__requests-5414`, `sympy__sympy-16766`. These belong to `old_vtrace_with_verified_repair`, not to strict.

_Cost sources:_
- old agentCostUsd ← stage5_controlled_10_task_plan.json selectedTasks (baselineCost / vtraceCost).
- strict agentCostUsd ← stage5_strictgated_10task_report.json tasks[].strict.costUsd (joined by instanceId).
- criticCostUsd ← stage5_live_critic_high_risk_comparison.json (mean per-instance observation) and stage5_repair_conversion_*.json costs.criticCostUsd (verified OLD-VTRACE conversions).
- repairCostUsd ← stage5_repair_conversion_*.json costs.repairCostUsd (verified OLD-VTRACE conversions only).

_Token sources:_
- old agent tokens ← stage5_controlled_10_task_plan.json selectedTasks (baselineTokens / vtraceTokens; total tokens incl. cache).
- strict agent tokens ← stage5_strictgated_10task_report.json tasks[].strict.totalTokens (joined by instanceId).
- critic tokens ← stage5_live_critic_high_risk_comparison.json and stage5_repair_conversion_*.json costs.criticInput/OutputTokens.
- repair tokens ← stage5_repair_conversion_*.json costs.repairInput/OutputTokens (verified OLD-VTRACE conversions only).

## Recommended next step

Run a strict-specific repair smoke/evaluation only for eval-strictgated-vtrace-requests-5414, because Requests remains unresolved under strict and prior old-VTRACE repair evidence suggests this defect class may be recoverable.

Requests is unresolved under the strict first pass but was recovered by a verified OLD-VTRACE repaired patch, so a strict-specific repair smoke targets exactly the lost task. Do NOT transfer the old repair conversion to strict accounting, do NOT re-run already-recovered old repair experiments, and do NOT trigger a full 10-task rerun.

_OLD-VTRACE repair-experiment guidance (separate track): Option D — Stop duplicate Requests repair runs. Shift back to reducing default VTRACE first-pass token use and/or expand the controlled set with new unique high-risk tasks before more repair experiments._

## Non-claims

- This is not a VEXP comparison.
- This is not a statistically meaningful SWE-bench benchmark.
- This does not prove aggregate resolution improvement.
- This does not justify always-on critic/repair.
- This does not change production behavior.
- This only accounts for observed artifacts and verified repaired-patch evaluations.
- strict_vtrace_first_patch using fewer total tokens and lower total cost than baseline does NOT imply a higher success rate — strict remains behind baseline on resolved count.
- Verified old repair conversions are NOT transferred to strict accounting; strict carries no repair recovery.

