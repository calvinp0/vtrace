# Stage 5 final policy story

_Generated: 2026-06-11T14:50:45.262Z_

_Documentation/reporting only. Re-runs nothing (no agent, no live critic, no repair, no Docker); summarizes committed Stage 5 reports over the controlled task set. Every number is read from committed artifacts, not hardcoded._

## Executive summary

Over the controlled 10-task set, VTRACE moved from old_vtrace_first_patch (5/10 resolved at $8.2089 / 17.07M) to strict_vtrace_first_patch (7/10 at $6.4080 / 12.53M) under the strict_risk_gated default, then to strict_vtrace_with_verified_repair (8/10 at $6.8230 / 12.54M) after one strict-specific gated repair recovered psf__requests-5414. strict_vtrace_with_verified_repair matched baseline resolution (8/10) while using lower total cost and fewer total tokens.

## What changed

- The internal Stage 5 PIVOT_CHECK default became `strict_risk_gated`: pivot-check, edit-guard, and patch-verify inject only under strong risk signals instead of on every hidden pivot.
- Strict first-pass VTRACE replaced the old always-injecting controlled VTRACE, cutting tokens and cost while improving resolution.
- A strict-specific, gated one-repair path (deterministic probe → live-critic agreement → one bounded repair → Docker re-evaluation) recovered one previously unresolved task.
- Old VTRACE repair conversions stayed tied to old first patches and were never transferred to strict accounting.

## Controlled 10-task results

| policy | resolved | total cost | total tokens |
| --- | --- | --- | --- |
| baseline | 8/10 | $6.9777 | 16756692 |
| old_vtrace_first_patch | 5/10 | $8.2089 | 17074981 |
| strict_vtrace_first_patch | 7/10 | $6.4080 | 12526985 |
| strict_vtrace_with_verified_repair | 8/10 | $6.8230 | 12543588 |

## Token and cost outcome

- baseline: $6.98 / 16.76M tokens
- strict_vtrace_with_verified_repair: $6.82 / 12.54M tokens
- strict+repair vs baseline: cost -$0.15, tokens -4.21M
- strict_vtrace_with_verified_repair used lower total cost and fewer total tokens than baseline in this controlled set.

## Resolution outcome

- baseline resolved: 8/10
- old_vtrace_first_patch resolved: 5/10
- strict_vtrace_first_patch resolved: 7/10
- strict_vtrace_with_verified_repair resolved: 8/10
- Strict first-pass improved resolution over old VTRACE first patch.
- strict_vtrace_with_verified_repair matched baseline resolution on the controlled 10-task set.

## Strict pivot-check default

`strict_risk_gated` is now the internal Stage 5 default PIVOT_CHECK policy. Under it, pivot-check / edit-guard / patch-verify inject only when strong risk signals are present (a lone hidden-pivot signal is insufficient), which is what reduced strict first-pass tokens and cost relative to old VTRACE.

## Gated repair outcome

- run: `eval-strictgated-vtrace-requests-5414`
- instance: `psf__requests-5414`
- converted unresolved → resolved: **true** (dockerUsed=true, resolved=true)
- recovery cost: critic $0.1909 + repair $0.2241 = **$0.4150**
- This strict repair conversion was generated from the strict first patch run and is NOT transferred from old VTRACE repair evidence.

## Why repair remains gated

- Repair runs only after deterministic probes flag a concrete defect class AND the live critic independently agrees, so it never fires speculatively.
- Exactly one bounded repair attempt is allowed; it edits the existing first patch rather than re-solving from scratch.
- Critic and repair add real per-call cost/tokens, so always-on repair would raise cost-per-resolved without a proven aggregate gain.
- The one observed recovery (psf__requests-5414) is a single controlled-set instance, not evidence that repair helps in aggregate.

## What we can claim

- strict_risk_gated is now the internal Stage 5 default PIVOT_CHECK policy.
- strict first-pass VTRACE improved over old controlled VTRACE on resolution, tokens, and cost.
- strict_vtrace_with_verified_repair matched baseline resolution on the controlled 10-task set.
- strict_vtrace_with_verified_repair used lower total tokens and lower total cost than baseline in this controlled set.

## What we cannot claim

- This does NOT claim VTRACE beats VEXP.
- This is NOT a statistically meaningful SWE-bench benchmark.
- This does NOT claim repair should be always-on.
- This does NOT claim old VTRACE repair conversions transfer to strict runs.
- This does NOT prove aggregate performance beyond this controlled 10-task set.

## Final recommendation

Stop Stage 5 repair experiments for now. Keep strict_risk_gated as the internal Stage 5 default. Keep critic/repair gated and disabled by default, available only after deterministic probes and live critic agreement. Move next to VTRACE productization and release hardening.

## Next productization work

1. Clean user-facing modes: auto / fast / thorough / debug instead of internal policy flags.
2. Release/CI hardening: typecheck, tests, package checks, VS Code packaging.
3. Documentation: explain Capsule v2, strict pivot gating, deferred refs, and repair safety boundaries.
4. Benchmark hygiene: keep raw artifacts untracked, preserve generated evidence, avoid timestamp churn.
5. Product UX: hide internal knobs from normal users while keeping benchmark/dev overrides.
6. Broader validation: later rerun larger sets only after productization, not now.

