# Stage 5 token-discipline pilot: matplotlib-22719

## Summary

The token-discipline rerun reduced VTRACE token overhead and reduced turn-count, with no quality regression vs baseline.

| signal | value |
| --- | --- |
| tokenOverheadImproved | yes |
| turnCountImproved | yes |
| qualityRegressed | no |
| readyForMoreOverheadCases | yes |
| readyFor100TaskBenchmark | no |

## Why this case

matplotlib-22719 is the canonical worst-overhead case from the Stage 5 token-path audit: +1,550,405 tokens (+132.7%), 30 tool calls, a 16-deep Bash loop, 9 repeated Read/Grep visits, audited risk `high` — and VTRACE LOST a task the baseline resolved. If patch-first discipline helps anywhere, it should help here.

## Preflight

Phase 1 preflight PASSED: STAGE5_TOKEN_DISCIPLINE is injected for this instance in `strong_context_patch_first` mode, and the baseline arm does not receive it. See `stage5_token_discipline_preflight.md`. (The new-run injection state is separate — `tokenDisciplineInjected=yes` until the live rerun runs.)

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

New run label: `eval-token-discipline-pilot-matplotlib-22719` — token discipline injected: yes (`strong_context_patch_first`).

| metric | baseline | VTRACE |
| --- | --- | --- |
| total tokens | 1,116,250 | 1,187,665 |
| cacheRead tokens | 1,060,520 | 1,120,119 |
| cost (USD) | $0.51 | $0.55 |
| tool calls | 11 | 10 |
| Bash calls | 8 | 5 |
| repeated Read/Grep | 1 | 1 |
| resolved | no | no |
| token-reduction risk | n/a | n/a |

new VTRACE total-token overhead vs the same-label baseline: **6.4%** (1,187,665 VTRACE vs 1,116,250 baseline).

## Token-path comparison

| metric | historical VTRACE | new VTRACE | reduction |
| --- | --- | --- | --- |
| total tokens | 2,718,398 | 1,187,665 | 56.3% |
| cacheRead tokens | 2,632,899 | 1,120,119 | 57.5% |

tokenOverheadImproved: **yes** (material threshold 10.0%).

## Turn-count comparison

| metric | historical VTRACE | new VTRACE |
| --- | --- | --- |
| tool calls | 30 | 10 |
| Bash calls | 16 | 5 |
| repeated Read/Grep | 9 | 1 |
| risk tier | high | n/a |

turnCountImproved: **yes** — Bash below high-risk threshold (< 8): yes; risk tier improved: n/a.

## Resolution/quality comparison

- Historical: baseline resolved=yes, VTRACE resolved=no.
- New: baseline resolved=no, VTRACE resolved=no.
- qualityRegressed (new VTRACE unresolved while a baseline resolved): **no**.
- qualityWorseThanHistorical (lost a task historical VTRACE held): **no**.

> Token reduction is not a win if the new VTRACE patch is worse or loses resolution because it patched too early.

## Interpretation

This pilot tests whether the new strong-context patch-first token discipline reduces the known turn-count/cache-read blowup on the worst historical overhead case. It is not a headline benchmark and it is not a 100-task validation. It is a targeted engineering check before scaling to more instances.

- total tokens down 56.3% vs historical
- cacheRead tokens down 57.5% vs historical
- fewer tool calls: 10 < 30
- fewer Bash calls: 5 < 16
- Bash loop dropped below the high-risk threshold (< 8)
- fewer repeated Read/Grep: 1 < 9
- no quality regression vs baseline

## Recommended next step

Proceed to a small batch of the next-worst overhead cases (e.g. astropy-14369) under the same paired protocol before considering any larger run. Do NOT jump to the 100-task benchmark.

## Non-claims

- This pilot does not establish the 100-task token-reduction number.
- This pilot does not prove the policy generalizes.
- This pilot does not change Stage 5 policy accounting.
- This pilot does not enable generated-parser repair broadly.
