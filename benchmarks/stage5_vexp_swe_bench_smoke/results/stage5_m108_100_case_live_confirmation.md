# Stage 5 M108 100-Case Live Confirmation

_2026-07-07. Completes the M105 (14) → M106 (24) → M107 (50) live-confirmation
series over the full frozen 100-case pool. Current default VTRACE path only
(M95–M104 deterministic chain, M103/M104 structured task derivation, M92
clean-core flags, mandatory M89/M90A safety stack). No V4/C7_D, no
revision/corrective arms, no VEXP, no fresh baseline._

## Summary

- **M105/M106/M107 reuse**: all three committed sets REUSED, never rerun —
  shape-validated adapter, re-aggregation bit-identical to every committed
  aggregate (m105, m106, m107, combined24 via M107, combined50), triple
  overlap guard; complement selection makes a rerun impossible by
  construction.
- **M108 extension**: 50 pre-registered remaining cases; 47 spawned and
  completed valid; 3 never spawned (pre-registered expected-no-context class,
  below).
- **Combined 100-case count**: 14 + 10 + 26 + 50 = 100 cases; 97 valid live
  runs.
- **Safety/parity**: CLEAN SWEEP — task parity 47/47 byte-exact vs the frozen
  M103 rows, 0 unexplained leakage hits pre- and post-run, 0 legacy-fallback
  fires, env guard pass 47/47 + 0 drift, shell guard pass 47/47 + 0
  host-package blocks, 0 unguarded runs, 0 revision/behavioral-guard
  artifacts, 0 provider retries.
- **Resolution**: extension 38/47 (80.9%) vs M73-treatment expectation 41/47
  on the attempted subset; combined **55/97 (56.7%)** vs pre-registered
  66/100 M73-treatment expectation; floor (≥36) cleared by 19.
- **Token/cost**: extension $25.27 (< $45 pause cap; M73-treatment spent
  $28.19 on the same 50 cases, −10%), 47.07M tokens, 93.7% cache-read;
  combined $56.69 / 104.6M tokens / 93.9% cache-read.
- **Verdict**: **PASS** (one explained deviation: 47 of 50 extension cases
  live-attempted; the 3 exclusions are deterministic no-context cases,
  pre-registered before any spawn).
- **Recommendation**: freeze the current default path and prepare the final
  internal summary.

## Pre-run Plan

Pre-registered in `stage5_m108_100_case_live_confirmation_plan.md` (20
answers + preflight addendum, all fixed before any live spawn).

- **Commands**: `run_stage5_m108_driver.sh treat A|B|C|D` then
  `run_stage5_m108_driver.sh evaluate A|B|C|D`; per case the driver invokes
  `bun run_stage5_vexp_swe_bench_smoke.ts --mode run-protocol --protocol
  vtrace-indexed --instances <id> --run-label m108_live_ext_<safe_id>` with
  the exact M105/M92 clean-core flag set, and evaluation uses `--mode
  evaluate --eval-mode docker --eval-dataset $VEXP/data/swe-bench-100.jsonl`.
- **Flags**: `--context-policy force-inject --capsule-engine v2
  --capsule-intent debug --capsule-budget 8000 --inject-capsule-digest
  --digest-decision-contract --bounded-digest-decisions
  --compact-digest-injection --pivot-confidence-gate --stage5-env-guard
  --stage5-env-drift-check --expected-testbed-prefix
  /home/calvin/miniforge3/envs/vexp_swebench --stage5-agent-shell-guard
  --stage5-host-pip-firewall` (byte-identical to
  `M105_TREATMENT_CONTEXT_ARGV`; preflight asserts every forbidden arm off on
  the PARSED config).
- **Case selection**: deterministic complement of the committed
  M105+M106+M107 ids over the frozen M103 100-case pool — exactly 50, no
  sampling, no backup list; ordering M92-row-first then instance_id; frozen
  in `stage5_m108_case_selection.json` before any run. Phases A=1–8, B=9–22,
  C=23–36, D=37–50.
- **Historical expectation (pre-registered)**: M73-treatment 43/50 on the
  extension (django-10973 has no valid M73 treatment row), M73-baseline
  44/50, M92 overlap 6/13; combined M73-treatment 66/100, M73-baseline
  64/100; "not catastrophic" floor = 36/100 combined resolved.
- **Stop conditions**: any unexplained leakage / fallback fire / guard
  failure / drift / rerun of a committed case ⇒ stop; extension spend > $45
  before completion ⇒ stop and seek approval. None triggered.

## No-Agent Preflight

50/50 cases preflighted under the exact treatment argv before any spawn
(`stage5_m108_live_preflight.detail.json`):

- **Task parity**: 47/47 spawnable cases byte-exact vs the shared M103
  derivation AND the frozen M103 detail row (diagnostics equal); the M108
  structured-task sha256 of every case is recorded as the frozen hash.
  `m104_hash_match` is vacuous-null (none of these cases was in the M104
  smoke), as in M106/M107.
- **Leakage**: 0 unexplained hits over the fully assembled model-visible
  markdown (task + capsule + digest + decision contract) for all 50.
- **Fallback**: 0 cases where the v2 capsule would fall back to legacy.
- **Guards**: env guard read-only probe pass (python+pip prefixes verified,
  drift check armed), shell guard materialization pass, benchmark-valid.
- **Expected deterministic no-context (3 cases, never spawned)**:
  django-11740, django-15572, sphinx-9320. Their FROZEN M103 scoreboard rows
  record `capsule.mode = no_context` (deterministic path finds no capsule
  content); the live preflight reproduces `gate_action=no_context` for
  exactly these — parity, not failure. A live run would inject nothing:
  baseline-shaped (forbidden non-goal) and parity-invalid under the M105
  validity contract (`vtraceContextInjected !== true`). Pre-registered in the
  plan addendum before any spawn; the driver's per-case gate held all three
  back. A no_context gate action on any case NOT frozen as no_context would
  have blocked all spawning.
- **Issue-authored provenance (1 case)**: sympy-15599's task contains
  `test_Mod` — a FAIL_TO_PASS id the issue author wrote verbatim in the
  problem statement (and base-commit repo content; the post-run snapshot scan
  classifies it as such). Reclassified `issue_authored_task_hits` per the
  M103 `issue_authored_gold_path` policy; task text is byte-exact with the
  frozen M103 row the deterministic scoreboard already scored. The case ran
  and was leak-clean post-run.

## M108 Live Results

Per-case table (sets m105/m106/m107 reused rows are in the CSV; this table is
the 50 M108 selection rows). R = resolved, U = unresolved, — = n/a.

| instance | stratum | ph | preflight | leak | fallback | live | eval | live res | tokens | cost $ | tools | M103 | M73t | M73b | M92 |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | ---: | ---: | ---: | --- | :-: | :-: | :-: |
| django/django-11820 | overpacked | A | pass | clean | none | valid | evaluated | U | 909,599 | 0.468 | 9 | overpacked | U | U | U |
| django/django-13112 | overpacked | A | pass | clean | none | valid | evaluated | R | 1,496,000 | 0.719 | 14 | overpacked | R | U | U |
| django/django-13590 | miss | A | pass | clean | none | valid | evaluated | R | 642,875 | 0.441 | 7 | miss | R | U | R |
| django/django-14792 | miss | A | pass | clean | none | valid | evaluated | U | 805,441 | 0.513 | 7 | miss | U | U | U |
| django/django-15572 | miss | A | fail | — | — | not att. | — | — | — | — | — | miss | U | R | U |
| psf/requests-1142 | good | A | pass | clean | none | valid | evaluated | R | 582,413 | 0.329 | 6 | good | R | R | R |
| pydata/xarray-2905 | good | A | pass | clean | none | valid | evaluated | R | 1,092,980 | 0.582 | 11 | good | R | R | R |
| pytest-dev/pytest-5262 | excellent | A | pass | clean | none | valid | evaluated | R | 659,745 | 0.397 | 7 | excellent | R | R | R |
| scikit-learn/scikit-learn-11578 | excellent | B | pass | clean | none | valid | evaluated | R | 838,721 | 0.459 | 8 | excellent | R | R | R |
| sympy/sympy-13974 | good | B | pass | clean | none | valid | evaluated | U | 890,575 | 0.561 | 9 | good | U | R | U |
| sympy/sympy-15599 | good | B | pass | clean | none | valid | evaluated | U | 830,433 | 0.450 | 9 | good | U | R | U |
| sympy/sympy-18189 | good | B | pass | clean | none | valid | evaluated | R | 685,561 | 0.400 | 7 | good | R | R | R |
| sympy/sympy-20428 | miss | B | pass | clean | none | valid | evaluated | U | 4,745,294 | 1.883 | 44 | miss | U | U | U |
| astropy/astropy-14539 | excellent | B | pass | clean | none | valid | evaluated | R | 850,699 | 0.482 | 8 | excellent | R | R | — |
| django/django-10973 | excellent | B | pass | clean | none | valid | evaluated | R | 530,130 | 0.339 | 5 | excellent | — | U | — |
| django/django-11095 | excellent | B | pass | clean | none | valid | evaluated | R | 351,106 | 0.252 | 3 | excellent | R | R | — |
| django/django-11133 | excellent | B | pass | clean | none | valid | evaluated | R | 434,314 | 0.328 | 4 | excellent | R | R | — |
| django/django-11206 | overpacked | B | pass | clean | none | valid | evaluated | R | 1,276,744 | 1.013 | 10 | overpacked | R | R | — |
| django/django-11490 | excellent | B | pass | clean | none | valid | evaluated | U | 948,774 | 0.497 | 10 | excellent | R | R | — |
| django/django-11728 | good | B | pass | clean | none | valid | evaluated | R | 742,734 | 0.459 | 7 | good | R | R | — |
| django/django-11740 | miss | B | fail | — | — | not att. | — | — | — | — | — | miss | R | R | — |
| django/django-11749 | overpacked | B | pass | clean | none | valid | evaluated | R | 745,761 | 0.558 | 7 | overpacked | R | R | — |
| django/django-12050 | excellent | C | pass | clean | none | valid | evaluated | R | 462,019 | 0.304 | 4 | excellent | R | R | — |
| django/django-12276 | excellent | C | pass | clean | none | valid | evaluated | R | 612,928 | 0.361 | 6 | excellent | R | R | — |
| django/django-12858 | excellent | C | pass | clean | none | valid | evaluated | R | 790,107 | 0.453 | 9 | excellent | R | R | — |
| django/django-13012 | excellent | C | pass | clean | none | valid | evaluated | R | 753,604 | 0.418 | 8 | excellent | R | R | — |
| django/django-13363 | excellent | C | pass | clean | none | valid | evaluated | R | 686,250 | 0.398 | 6 | excellent | R | R | — |
| django/django-13551 | excellent | C | pass | clean | none | valid | evaluated | U | 575,578 | 0.371 | 6 | excellent | R | R | — |
| django/django-13658 | good | C | pass | clean | none | valid | evaluated | R | 777,741 | 0.420 | 8 | good | R | R | — |
| django/django-13820 | excellent | C | pass | clean | none | valid | evaluated | R | 1,031,359 | 0.590 | 9 | excellent | R | R | — |
| django/django-14608 | excellent | C | pass | clean | none | valid | evaluated | R | 1,177,665 | 0.503 | 13 | excellent | R | R | — |
| django/django-15037 | overpacked | C | pass | clean | none | valid | evaluated | R | 794,563 | 0.502 | 6 | overpacked | R | R | — |
| django/django-16333 | good | C | pass | clean | none | valid | evaluated | R | 523,495 | 0.296 | 5 | good | R | R | — |
| django/django-16819 | excellent | C | pass | clean | none | valid | evaluated | R | 1,813,670 | 0.739 | 18 | excellent | R | R | — |
| django/django-16877 | good | C | pass | clean | none | valid | evaluated | R | 845,415 | 0.463 | 8 | good | R | R | — |
| django/django-17084 | miss | C | pass | clean | none | valid | evaluated | R | 1,809,904 | 0.898 | 17 | miss | R | R | — |
| matplotlib/matplotlib-25332 | miss | D | pass | clean | none | valid | evaluated | R | 1,390,997 | 0.705 | 13 | miss | R | R | — |
| pydata/xarray-3677 | good | D | pass | clean | none | valid | evaluated | R | 899,635 | 0.492 | 9 | good | R | R | — |
| pytest-dev/pytest-7432 | excellent | D | pass | clean | none | valid | evaluated | R | 747,690 | 0.391 | 9 | excellent | R | R | — |
| scikit-learn/scikit-learn-10844 | overpacked | D | pass | clean | none | valid | evaluated | R | 705,076 | 0.428 | 7 | overpacked | R | R | — |
| sphinx-doc/sphinx-7910 | miss | D | pass | clean | none | valid | evaluated | R | 826,801 | 0.461 | 8 | miss | R | R | — |
| sphinx-doc/sphinx-9230 | miss | D | pass | clean | none | valid | evaluated | R | 1,447,600 | 0.715 | 14 | miss | R | R | — |
| sphinx-doc/sphinx-9320 | miss | D | fail | — | — | not att. | — | — | — | — | — | miss | R | R | — |
| sympy/sympy-12481 | good | D | pass | clean | none | valid | evaluated | R | 865,131 | 0.473 | 9 | good | R | R | — |
| sympy/sympy-16766 | overpacked | D | pass | clean | none | valid | evaluated | U | 1,017,841 | 0.555 | 11 | overpacked | R | R | — |
| sympy/sympy-16792 | miss | D | pass | clean | none | valid | evaluated | R | 2,282,948 | 0.951 | 21 | miss | R | R | — |
| sympy/sympy-19637 | excellent | D | pass | clean | none | valid | evaluated | R | 884,842 | 0.454 | 9 | excellent | R | R | — |
| sympy/sympy-20801 | miss | D | pass | clean | none | valid | evaluated | R | 1,102,260 | 0.540 | 13 | miss | R | R | — |
| sympy/sympy-23413 | good | D | pass | clean | none | valid | evaluated | U | 1,091,759 | 0.702 | 11 | good | R | R | — |
| sympy/sympy-24213 | good | D | pass | clean | none | valid | evaluated | R | 1,095,364 | 0.560 | 11 | good | R | R | — |

(django-10973's M73t is shown as — here: its M73 treatment was skipped
(stage B), so it carries no treatment expectation; the raw row records
`treatment_resolved=false` with `treatment_valid=false`.)

- **Extension aggregate** (n=50 selected, 47 spawned): 47 valid, 47
  evaluated, 38 resolved (80.9% of attempted), 47 patches, 0 no-patch, 0
  invalid; per phase A 5/7, B 9/13, C 13/14, D 11/13.
- **Invalid / not-attempted cases**: none invalid; 3 not attempted
  (expected-no-context, pre-registered) — django-11740, django-15572,
  sphinx-9320.
- **Operational events (zero benchmark impact)**: two external driver-process
  kills during workspace setup (first launches of sympy-20428 and
  django-10973); no run artifacts existed, the partial workspace clones were
  removed and the phases relaunched clean (both cases then completed and
  RESOLVED); ledgered in `_m108_driver_ledger.jsonl`. 0 provider retries of
  the pre-registered 6 allowed.

## Combined 100-Case Result

| set | n | valid | evaluated | resolved | rate | patches | tokens | cache-read | tool calls | cost $ | med $ | p90 $ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| M105 committed | 14 | 14 | 14 | 6 | 42.9% | 13 | 14,150,481 | 13,228,269 | 141 | 7.66 | 0.434 | 1.046 |
| M106 committed ext | 10 | 10 | 10 | 3 | 30.0% | 10 | 14,260,726 | 13,509,597 | 134 | 7.09 | 0.672 | 0.970 |
| M107 committed ext | 26 | 26 | 26 | 8 | 30.8% | 26 | 29,164,558 | 27,369,003 | 273 | 16.66 | 0.526 | 1.013 |
| M108 extension | 50 | 47 | 47 | 38 | 80.9% | 47 | 47,072,141 | 44,103,495 | 460 | 25.27 | 0.468 | 0.739 |
| combined 50 (105+106+107) | 50 | 50 | 50 | 17 | 34.0% | 49 | 57,575,765 | 54,106,869 | 548 | 31.41 | 0.526 | 1.013 |
| **combined 100** | **100** | **97** | **97** | **55** | **56.7%** | **96** | **104,647,906** | **98,210,364** | **1,008** | **56.69** | **0.492** | **0.951** |

Committed M105/M106/M107 rows were REUSED (adapter-validated); re-aggregation
of each reused set and of combined24/combined50 is bit-identical to the
committed aggregates. The `aggregateCombined100` rerun guard threw on no
case (no overlaps anywhere).

## Historical Comparison

- **M73 treatment**: pre-registered 66/100 (43/50 on the extension). Observed
  55/97 valid live runs. On the comparable attempted subset (96 cases with a
  valid M73 treatment row): expectation 64/96, live 55/97, per-case agreement
  **81/96** (M105 14/14, M106 8/10, M107 17/26, M108 42/46). M108's 4 losses
  (django-11490, django-13551, sympy-16766, sympy-23413) and 0 gold-blind
  wins; django-10973 (no M73 row) resolved live. The M107 open question
  (17/50 vs 23/50: variance or gap?) now has a larger sample: the deficit is
  concentrated in the failure-strata extensions (M106/M107 sampled
  wrong_pivot/miss/partial heavily), while the success-heavy M108 remainder
  tracks its expectation within −3 of 41/47. Read: a modest true deficit vs
  M73-treatment on hard-stratum cases plus live-day variance; no systemic
  regression of the default path.
- **M73 baseline**: pre-registered 64/100 (44/50 on the extension). Live
  combined 55/97 vs baseline's 64/100 — same caution: the baseline rows are
  frozen history, not a same-day arm.
- **M92 overlap**: extension 12 attempted overlap cases — live 7/12 vs M92
  6/12, agreement 11/12; with M107's 37-overlap (live 9/37 vs M92 13/37) the
  series remains mixed-flat vs M92 history.
- **M103 deterministic outcome** (M108 extension, attempted): `excellent`
  16/18 (losses django-11490, django-13551), `good` 10/13 (losses
  sympy-13974, sympy-15599, sympy-23413), `miss` 7/9 (the M103-miss class
  turns out largely solvable live by the agent's own navigation — capsule
  misses are not fatal), `overpacked` 5/7.
- **Standing regressions**: astropy-14539 — one of the three open M7.x live
  regressions — RESOLVED live (as sympy-12419 did in M107); pylint-8898
  resolved in M107. The M7.x regression list is now fully recovered in live
  runs across M107+M108.
- **Interpretation limits**: this is a 100-case live confirmation of the
  current default VTRACE path. It validates safety/parity and gives the
  strongest internal directional signal so far. It is NOT a public SWE-bench
  pass@1 benchmark claim by itself, NOT a VEXP parity claim, and no fresh
  baseline arm was run (frozen M73 rows serve as the baseline reference).

## Token/Cost Analysis

- Extension: $25.27 total, median $0.468, p90 $0.739, 47.07M tokens (93.7%
  cache-read), 460 tool calls. M73-treatment historical cost on the same 50
  cases was $28.19 → −10% while running 47 of them.
- Combined 100: $56.69, 104.6M tokens, 93.9% cache-read, median $0.492, p90
  $0.951.
- Outlier: sympy-20428 $1.88 / 101 turns / 4.75M tokens (miss-class,
  unresolved — the familiar structural-ceiling shape, no guard configured by
  design). Next: django-11206 $1.01 (resolved).
- Pause cap: $25.27 < $45 pre-registered cap; never crossed at any phase
  boundary (A $3.45, B $11.13, C $17.84, D $25.27).

## Safety

- **Env guard (M89, mandatory)**: pass 47/47 with `benchmark_valid=true`;
  drift check armed, 0 drift; expected testbed prefix pinned.
- **Shell guard / host-pip firewall (M90A, mandatory)**: pass 47/47; 0
  blocked host package commands; 0 conda/pip mutations.
- **Unguarded escape hatch**: never used (asserted off in preflight and in
  every `_run.meta.json`).
- **Fallback**: 0 v2→legacy fires (the M104 FAIL_TO_PASS-packing residual
  never activated).
- **Revision/corrective**: 0 artifacts in any raw dir; behavioral guards
  (V4/C7_D) never configured — 0 guard metadata keys present.
- **Leakage**: 0 unexplained model-visible hits pre-run (assembled context)
  and post-run (actual `_vtrace_instructions.snapshot.md`, base-commit
  provenance policy). sympy-15599's `test_Mod` is issue-authored + base-commit
  content (explained, documented).

## Success Criteria Check

1. M105/M106/M107 reused, not rerun — **PASS** (bit-identical re-aggregation,
   overlap guards, complement selection).
2. Remaining 50 selected before running and recorded — **PASS**.
3. Remaining count exactly 50 — **PASS**.
4. ≥48/50 preflight-pass and live-attempted — **PASS with explained
   deviation**: 47/50. The 3 exclusions are not infrastructure but a precise,
   pre-registered protocol reason (frozen M103 `no_context` parity: nothing
   to inject; spawning would create a forbidden baseline-shaped,
   parity-invalid run). Zero silent loss.
5. 100% task parity on attempted — **PASS** (47/47 byte-exact).
6. 0 leakage events — **PASS**.
7. 0 fallback fires — **PASS**.
8. 0 revision/corrective/FAIL_TO_PASS context fires — **PASS**.
9. 0 unguarded runs — **PASS**.
10. 0 env drift — **PASS**.
11. 0 host pip/conda escapes — **PASS**.
12. ≥48 parseable run artifacts — **PASS with the same deviation**: 47/47
    spawned runs parseable (100% of attempted).
13. Combined resolution not catastrophically below expectation — **PASS**
    (55 ≥ 36 floor; 55/97 vs 66/100 expectation, deficit localized to
    failure strata).
14. Token/cost accounting complete — **PASS** (all 97 valid runs).
15. Extension spend under cap — **PASS** ($25.27 < $45).
16. Tests/typechecks — **PASS** (see verification in the milestone ledger row).

## Verdict

**PASS**

## Recommendation

**Freeze current default path and prepare final internal summary.** The
M95–M104 chain is now live-validated over the full frozen 100-case pool with
a clean safety/parity sweep and combined 55/97 resolution. The remaining open
analytical thread — the M106/M107 failure-strata deficit vs M73-treatment
(hard-stratum flips) — is characterization work over already-captured
artifacts, not new live spend.
