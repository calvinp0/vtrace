# Stage 5 token-discipline pilot: matplotlib-22719

## Summary

**Phase 1 preflight PASSED; Phase 2 live paired rerun is PENDING.** The new paired rerun has not been produced, so the token-discipline EFFECT is not yet measured. All `newVtrace*` fields are null/unavailable. The historical overhead is recorded below; once a paired run under label `eval-token-discipline-pilot-matplotlib-22719` exists, regenerate this report. `readyFor100TaskBenchmark` stays false.

| signal | value |
| --- | --- |
| tokenOverheadImproved | n/a |
| turnCountImproved | n/a |
| qualityRegressed | n/a |
| readyForMoreOverheadCases | no |
| readyFor100TaskBenchmark | no |

## Why this case

matplotlib-22719 is the canonical worst-overhead case from the Stage 5 token-path audit: +1,550,405 tokens (+132.7%), 30 tool calls, a 16-deep Bash loop, 9 repeated Read/Grep visits, audited risk `high` — and VTRACE LOST a task the baseline resolved. If patch-first discipline helps anywhere, it should help here.

## Preflight

Phase 1 preflight PASSED: STAGE5_TOKEN_DISCIPLINE is injected for this instance in `strong_context_patch_first` mode, and the baseline arm does not receive it. See `stage5_token_discipline_preflight.md`. (The new-run injection state is separate — `tokenDisciplineInjected=no` until the live rerun runs.)

## Historical overhead

Historical VTRACE run: `eval-controlled-vtrace-matplotlib-22719` (paired baseline `eval-localization-gap-baseline-matplotlib-22719`).

| metric | baseline | VTRACE |
| --- | --- | --- |
| total tokens | 1,167,993 | 2,718,398 |
| cacheRead tokens | n/a | 2,632,899 |
| tool calls | n/a | 30 |
| Bash calls | n/a | 16 |
| repeated Read/Grep | n/a | 9 |
| resolved | yes | no |
| token-reduction risk | n/a | high |

## New paired rerun

No new rerun on disk under label `eval-token-discipline-pilot-matplotlib-22719`. Run it, then regenerate.

## Token-path comparison

| metric | historical VTRACE | new VTRACE | reduction |
| --- | --- | --- | --- |
| total tokens | 2,718,398 | n/a | n/a |
| cacheRead tokens | 2,632,899 | n/a | n/a |

tokenOverheadImproved: **n/a** (material threshold 10.0%).

## Turn-count comparison

| metric | historical VTRACE | new VTRACE |
| --- | --- | --- |
| tool calls | 30 | n/a |
| Bash calls | 16 | n/a |
| repeated Read/Grep | 9 | n/a |
| risk tier | high | n/a |

turnCountImproved: **n/a** — Bash below high-risk threshold (< 8): n/a; risk tier improved: n/a.

## Resolution/quality comparison

- Historical: baseline resolved=yes, VTRACE resolved=no.
- qualityRegressed (new VTRACE unresolved while a baseline resolved): **n/a**.
- qualityWorseThanHistorical (lost a task historical VTRACE held): **n/a**.

> Token reduction is not a win if the new VTRACE patch is worse or loses resolution because it patched too early.

## Interpretation

This pilot tests whether the new strong-context patch-first token discipline reduces the known turn-count/cache-read blowup on the worst historical overhead case. It is not a headline benchmark and it is not a 100-task validation. It is a targeted engineering check before scaling to more instances.

- no new paired rerun on disk yet — overhead effect not measured

## Recommended next step

Do a deliberate, SUPERVISED live paired rerun of matplotlib-22719 (label `eval-token-discipline-pilot-matplotlib-22719`) with token discipline enabled — baseline and VTRACE arms — then regenerate this report to measure the overhead effect. This is a billable Docker solve and should be launched intentionally, not as part of CI.

## Non-claims

- This pilot does not establish the 100-task token-reduction number.
- This pilot does not prove the policy generalizes.
- This pilot does not change Stage 5 policy accounting.
- This pilot does not enable generated-parser repair broadly.
