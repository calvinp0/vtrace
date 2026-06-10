# Stage 5 token-path audit

_Generated: 2026-06-10T20:09:02.623Z_

_Reporting/accounting only. Re-runs nothing (no agent, no live critic, no repair, no Docker); reads the controlled-task plan, outcome ledger, policy accounting, and per-run raw artifacts where present._

## Summary

VTRACE first-pass used +318289 tokens (+1.9%) and $1.2312 (+17.6%) vs baseline across 10 paired tasks, resolving 5/10 vs baseline 8/10. 7 task(s) are token-overhead cases; the largest is matplotlib__matplotlib-22719 (+1550405 tokens, agent_oversearched, tool_loop_overhead, pivot_check_overhead). Dominant overhead categories by token mass: pivot_check_overhead, agent_oversearched, tool_loop_overhead.

- paired tasks: **10** of 10
- token-overhead cases (vtrace > baseline): **7**
- total token delta: **+318289** (+1.9%)
- total cost delta: **$1.2312** (+17.6%)
- resolved: baseline **8/10**, vtrace first-pass **5/10**
- tasks with ordered tool logs: **5** (all VTRACE-side; baseline runs have none)

## Aggregate token/cost comparison

| metric | baseline | vtrace | delta | delta % |
| --- | --- | --- | --- | --- |
| total tokens | 16756692 | 17074981 | +318289 | +1.9% |
| total cost | $6.9777 | $8.2089 | $1.2312 | +17.6% |
| resolved | 8 | 5 | -3 | — |

Token-component deltas (vtrace − baseline, summed over paired tasks):

| component | delta |
| --- | --- |
| input | +116 |
| output | +125 |
| cacheRead | +316121 |
| cacheCreation | +1927 |

Cache reads carry **96%** of the summed positive token deltas: the overhead is mostly the conversation prefix being re-read on every extra agent turn, i.e. token deltas track TURN COUNT more than prompt size.

## Per-task token deltas

| instance | baseline run | vtrace run | baseline tok | vtrace tok | Δ tok | Δ % | baseline $ | vtrace $ | Δ $ | base res | vtrace res |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-10880 | eval-10880 | eval-10880 | 432600 | 628051 | +195451 | +45.2% | $0.2088 | $0.2561 | $0.0473 | true | true |
| django__django-11095 | eval-11095 | eval-11095 | 535997 | 999877 | +463880 | +86.5% | $0.2230 | $0.3553 | $0.1323 | true | true |
| django__django-11490 | eval-11490 | eval-11490 | 4661640 | 3301462 | -1360178 | -29.2% | $1.6256 | $1.0802 | $-0.5454 | true | true |
| django__django-11728 | eval-11728 | eval-11728 | 1716132 | 1194127 | -522005 | -30.4% | $0.7336 | $0.5916 | $-0.1420 | true | true |
| django__django-11740 | eval-11740 | eval-11740 | 2387415 | 1849882 | -537533 | -22.5% | $0.9119 | $0.6621 | $-0.2498 | true | true |
| astropy__astropy-14369 | eval-baseline-vs-vtrace-baseline-astropy-14369 | eval-controlled-vtrace-astropy-14369 | 3076313 | 3365366 | +289053 | +9.4% | $1.5550 | $3.0284 | $1.4734 | false | false |
| matplotlib__matplotlib-22719 | eval-localization-gap-baseline-matplotlib-22719 | eval-controlled-vtrace-matplotlib-22719 | 1167993 | 2718398 | +1550405 | +132.7% | $0.4638 | $0.9627 | $0.4989 | true | false |
| psf__requests-5414 | eval-baseline-vs-vtrace-baseline-requests-5414 | eval-controlled-vtrace-requests-5414 | 736898 | 956785 | +219887 | +29.8% | $0.4726 | $0.4065 | $-0.0660 | true | false |
| sphinx-doc__sphinx-7462 | eval-localization-gap-baseline-sphinx-7462 | eval-controlled-vtrace-sphinx-7462 | 627263 | 638586 | +11323 | +1.8% | $0.2651 | $0.2895 | $0.0244 | false | false |
| sympy__sympy-16766 | eval-baseline-vs-vtrace-baseline-sympy-16766 | eval-controlled-vtrace-sympy-16766 | 1414441 | 1422447 | +8006 | +0.6% | $0.5185 | $0.5765 | $0.0580 | true | false |

## Tool-call and file-read analysis

_VTRACE-side only: ordered `_tool_calls.json` logs exist for the cross-label controlled VTRACE runs; baseline runs and the older same-label django pairs have no tool log (null)._

| instance | tool calls | read | grep | search | edit | bash | repeated read/grep | unique files read | unique files edited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-10880 | null | null | null | null | null | null | null | null | 1 |
| django__django-11095 | null | null | null | null | null | null | null | null | 1 |
| django__django-11490 | null | null | null | null | null | null | null | null | 1 |
| django__django-11728 | null | null | null | null | null | null | null | null | 1 |
| django__django-11740 | null | null | null | null | null | null | null | null | 1 |
| astropy__astropy-14369 | 23 | 5 | 1 | 2 | 3 | 13 | 1 | 5 | 2 |
| matplotlib__matplotlib-22719 | 30 | 9 | 4 | 4 | 1 | 16 | 9 | 4 | 1 |
| psf__requests-5414 | 9 | 3 | 1 | 1 | 2 | 3 | 1 | 3 | 1 |
| sphinx-doc__sphinx-7462 | 7 | 2 | 1 | 1 | 2 | 2 | 1 | 2 | 1 |
| sympy__sympy-16766 | 12 | 4 | 2 | 2 | 2 | 4 | 2 | 4 | 1 |

## Prompt/context overhead

| instance | context chars | capsule est. tokens | pivots surfaced | pivots inspected | hidden pivots inspected |
| --- | --- | --- | --- | --- | --- |
| django__django-10880 | 1290 | null | null | null | null |
| django__django-11095 | 2776 | null | null | null | null |
| django__django-11490 | 1380 | null | null | null | null |
| django__django-11728 | 6064 | null | null | null | null |
| django__django-11740 | 8866 | null | null | null | null |
| astropy__astropy-14369 | 12027 | 5086 | 2 | 2 | 2 |
| matplotlib__matplotlib-22719 | 3533 | 601 | 2 | 2 | 2 |
| psf__requests-5414 | 6017 | 1282 | 2 | 2 | 1 |
| sphinx-doc__sphinx-7462 | 7192 | 1577 | 2 | 2 | 1 |
| sympy__sympy-16766 | 4784 | 914 | 2 | 2 | 2 |

Where measured, the injected VTRACE context is small (max 12027 chars ≈ 3007 tokens): one-time prompt size is NOT the main token driver; the multiplier is how many turns re-read the conversation afterwards.

## PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY overhead

| instance | PIVOT_CHECK injected | EDIT_GUARD injected | PATCH_VERIFY injected | critic ran (offline) | repair ran (offline) | Δ tok |
| --- | --- | --- | --- | --- | --- | --- |
| django__django-10880 | unknown | unknown | unknown | false | false | +195451 |
| django__django-11095 | unknown | unknown | unknown | false | false | +463880 |
| django__django-11490 | unknown | unknown | unknown | false | false | -1360178 |
| django__django-11728 | unknown | unknown | unknown | false | false | -522005 |
| django__django-11740 | unknown | unknown | unknown | false | false | -537533 |
| astropy__astropy-14369 | true | unknown | unknown | false | false | +289053 |
| matplotlib__matplotlib-22719 | true | unknown | unknown | false | false | +1550405 |
| psf__requests-5414 | true | unknown | unknown | true | true | +219887 |
| sphinx-doc__sphinx-7462 | true | unknown | unknown | false | false | +11323 |
| sympy__sympy-16766 | true | unknown | unknown | true | true | +8006 |

_EDIT_GUARD / PATCH_VERIFY injection was not recorded (null) for these first-pass controlled runs — their guard experiments ran under separate labels outside this controlled set. Critic/repair columns refer to gated OFFLINE artifacts for the instance, never first-pass work._

## Largest VTRACE token offenders

1. **matplotlib__matplotlib-22719** (eval-controlled-vtrace-matplotlib-22719): +1550405 tokens (+132.7%), $0.4989 — agent_oversearched, tool_loop_overhead, pivot_check_overhead
   - high tool-call volume: 30 tool calls, 9 repeated Read/Grep visits to already-seen paths
   - 16 Bash calls — long run/inspect loop, each turn re-reads the growing context
   - PIVOT_CHECK injected and 2 hidden pivot(s) inspected without a resolution improvement
2. **django__django-11095** (eval-11095): +463880 tokens (+86.5%), $0.1323 — unknown
   - insufficient artifacts: no ordered tool log for this pair
3. **astropy__astropy-14369** (eval-controlled-vtrace-astropy-14369): +289053 tokens (+9.4%), $1.4734 — agent_oversearched, tool_loop_overhead, pivot_check_overhead, retrieval_noise, context_too_large
   - high tool-call volume: 23 tool calls, 1 repeated Read/Grep visits to already-seen paths
   - 13 Bash calls — long run/inspect loop, each turn re-reads the growing context
   - PIVOT_CHECK injected and 2 hidden pivot(s) inspected without a resolution improvement
   - 5 unique files read and 2 pivots surfaced but only 2 file(s) edited, with no resolution gain
   - injected context is large (contextChars=12027, capsuleEstimatedTokens=5086)
4. **psf__requests-5414** (eval-controlled-vtrace-requests-5414): +219887 tokens (+29.8%), $-0.0660 — pivot_check_overhead
   - PIVOT_CHECK injected and 1 hidden pivot(s) inspected without a resolution improvement
5. **django__django-10880** (eval-10880): +195451 tokens (+45.2%), $0.0473 — unknown
   - insufficient artifacts: no ordered tool log for this pair
6. **sphinx-doc__sphinx-7462** (eval-controlled-vtrace-sphinx-7462): +11323 tokens (+1.8%), $0.0244 — pivot_check_overhead, cache_accounting_artifact
   - PIVOT_CHECK injected and 1 hidden pivot(s) inspected without a resolution improvement
   - cache-creation delta (24641) accounts for >=60% of the token delta (11323) — prefix re-pricing, not extra reasoning
7. **sympy__sympy-16766** (eval-controlled-vtrace-sympy-16766): +8006 tokens (+0.6%), $0.0580 — pivot_check_overhead, cache_accounting_artifact
   - PIVOT_CHECK injected and 2 hidden pivot(s) inspected without a resolution improvement
   - cache-creation delta (32910) accounts for >=60% of the token delta (8006) — prefix re-pricing, not extra reasoning

## Likely causes

| category | tasks | token mass (positive deltas) |
| --- | --- | --- |
| pivot_check_overhead | 5 | 2078674 |
| agent_oversearched | 2 | 1839458 |
| tool_loop_overhead | 2 | 1839458 |
| unknown | 2 | 659331 |
| retrieval_noise | 1 | 289053 |
| context_too_large | 1 | 289053 |
| cache_accounting_artifact | 2 | 19329 |

_Categories are deterministic threshold rules (multi-label); token mass attributes each overhead task's full positive delta to every category that fired on it, so masses overlap and do not sum to the total delta._

## Token-reduction recommendations

1. **Make PIVOT_CHECK conditional on multi-pivot/high-risk cases only (it currently injects on every first pass).**
   - evidence: PIVOT_CHECK was injected with hidden-pivot inspection on 5 overhead task(s) without any resolution improvement over baseline.
   - affected tasks (5, 2078674 overhead tokens): astropy__astropy-14369, matplotlib__matplotlib-22719, psf__requests-5414, sphinx-doc__sphinx-7462, sympy__sympy-16766
2. **Add anti-loop guidance / make injected context more actionable so the agent stops over-searching and re-running long Bash loops.**
   - evidence: 2 overhead task(s) show high tool-call volume, repeated Read/Grep visits, or >=10 Bash calls; every extra turn re-reads the whole growing context (cache reads carry 96% of the positive token deltas).
   - affected tasks (2, 1839458 overhead tokens): astropy__astropy-14369, matplotlib__matplotlib-22719
3. **Capture ordered tool logs (_tool_calls.json) and capsule metadata for ALL runs — the largest unexplained deltas are on pairs without per-turn telemetry.**
   - evidence: 2 overhead task(s) could not be classified because the pair lacks ordered tool logs or per-run capsule metadata.
   - affected tasks (2, 659331 overhead tokens): django__django-10880, django__django-11095
4. **Improve pivot ranking for noisy retrieval cases (many files read, few edited, no resolution gain).**
   - evidence: 1 overhead task(s) read >=5 unique files against >=2 surfaced pivots while editing <=2, with no resolution gain.
   - affected tasks (1, 289053 overhead tokens): astropy__astropy-14369
5. **Reduce the Capsule snippet budget / pivot context lines, and prefer deferred refs over eager code excerpts.**
   - evidence: 1 overhead task(s) carried injected context above the size thresholds (>=20000 chars or >=4000 capsule tokens).
   - affected tasks (1, 289053 overhead tokens): astropy__astropy-14369
6. **Treat small cache-creation-dominated deltas as measurement noise; re-pair cross-label runs under one label before drawing token conclusions from them.**
   - evidence: 2 overhead task(s) have token deltas dominated (>=60%) by cache-creation accounting rather than extra reasoning.
   - affected tasks (2, 19329 overhead tokens): sphinx-doc__sphinx-7462, sympy__sympy-16766

## Non-claims

- This is not a VEXP comparison and not a statistically meaningful SWE-bench benchmark (n=10, 5 pairs cross-label).
- This re-runs nothing: no agent, no live critic, no repair, no Docker; raw artifacts are read-only inputs.
- This does not change retrieval, Capsule v2, PIVOT_CHECK, EDIT_GUARD, PATCH_VERIFY, probe, critic, repair, evaluator, or policy behavior.
- Tool-call and pivot-inspection analysis only covers VTRACE runs that emitted an ordered _tool_calls.json; baseline runs have no tool log, so per-pair tool-call deltas are NOT claimed.
- Cross-label pairs (astropy, matplotlib, requests, sphinx, sympy) compare runs from different protocols/dates; their cache-accounting components are not strictly controlled.
- vtracePatchCriticRan / vtracePatchRepairRan describe gated OFFLINE artifacts for the instance, never work inside the first-pass run.
- Token totals include cache reads/creation as reported by the runner; no metric was invented or imputed.
- Classifications are deterministic threshold rules over observed artifacts; they identify likely causes, not proven mechanisms.

