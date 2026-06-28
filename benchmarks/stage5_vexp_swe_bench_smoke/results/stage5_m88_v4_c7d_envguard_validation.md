# Stage 5 M88 V4 + C7_D Env-Guarded Validation

Larger guarded validation of the combined **V4 tool-loop guard + C7_D cost/no-convergence guard**
(both runtime-inject) over a **frozen 24-case split**, hardened with the **M86 Stage 5
environment-isolation guard**. This is an internal mechanism-validation slice — **not** a 100-task
benchmark, **not** a VEXP/SWE-bench parity claim, **not** a default promotion. Both behavioral
guards remain **DEFAULT-OFF**; the env guard is opt-in.

## Summary

- **Selected cases:** 24 (A=8 cost/thrash, B=4 protected/treatment-only wins, C=4 baseline-only/
  regression-risk, D=4 controls, E=4 M85 carryover sentinels). Frozen before any live run; no
  replacements.
- **New live runs:** 24 (sequential, env guard enabled). **Operational retries: 0. Quota aborts: 0.**
- **Valid runs:** **24 / 24** (0 invalid, 0 partial sentinel, 0 required-IMPACT).
- **Docker evals:** 24 / 24 (`evaluationRan=true` on every run).
- **Environment guard:** **PASS on every one of the 24 runs** — python+pip prefix verified, expected
  prefix `/home/calvin/miniforge3/envs/vexp_swebench` on all, **zero drift danger, zero prefix-guard
  failures, zero unsafe-pip blocks**.
- **V4 injections / suppressions:** **0 / 0** (V4 never fired; no risky early read fire).
- **C7_D injections:** **2** — `sympy-15599` (A, @turn 29) and `django-16263` (E, @turn 32), both
  `edit_verify_churn`, both on cap/thrash targets, **none on any control/protected case**.
- **Resolution:** **M88 10/24** vs prior M73-treatment 10/24 on the same cases (flat); M73-baseline
  13/24 (the split intentionally over-samples baseline-only regressions in C).
- **Cost / tool-calls:** **M88 $21.36 vs M73-treatment $28.50 (−25%); 309 vs 356 tool calls (−13%).**
  Targeted cohort A: mean cost **$1.36 vs $1.88 (−28%)**, mean tools **17.6 vs 20**.
- **Verdict:** **MIXED** — env safety + guard mechanism + targeted-cost all clean; live resolution
  remains inconclusive (guard-silent run-to-run variance in the protected/carryover cohorts).
- **Recommendation:** **Make the env guard mandatory for Stage 5 live work** (proven clean across 24
  runs, pure safety); keep both behavioral guards **default-off** pending a larger confirmation.

## M87B Sanity Check

Read from `stage5_m87b_env_guard_repair_verified.json` / `stage5_m87b_env_audit.json`:

- `baseRepairVerified = true`; `expectedTestbedClean = true`; `environmentSafeForLiveRuns = true`.
- Expected prefix `/home/calvin/miniforge3/envs/vexp_swebench` — positive-path guard `pass`
  (python + pip prefix verified, drift summary present).
- Guard negative tests: **9 / 9 rejected** (bare pip, `python -m pip`, `conda activate && pip`,
  `conda install` w/o `-p/-n`, base/dev prefix as target, missing expected prefix, pip-prefix
  mismatch, sys.prefix==base contamination).
- M85 guarded treatment was valid (10/10), C7_D default-off, V4 + C7_D calibrations available, env
  guard flags present in runner `--help`.
- **Safe to continue: YES.** All sanity checks passed before any live work.

## Split

Deterministic selection from existing M73/M74/M85 metadata only (no hidden-test info; no
post-hoc replacement). Rules recorded in `stage5_m88_v4_c7d_envguard_split.json`:

- **A (8)** unresolved-treatment cases, cap/thrash-classified first (cost≥2.9 or tool_calls≥25),
  then cost desc: `sympy-15599, pylint-4551, sympy-12419, astropy-14598, xarray-6599, astropy-14369,
  requests-1921, django-15695`.
- **B (4)** treatment-only wins, lowest cost: `django-12325, django-11815, requests-1724, sympy-15875`.
- **C (4)** baseline-only losses (regression-risk), sympy-first: `sympy-24562, sympy-13974,
  django-16938, django-15572`.
- **D (4)** both-pass low-cost controls across distinct repos: `django-16569, sympy-18189, flask-5014,
  sklearn-11578`.
- **E (4)** fixed M85 carryover sentinels: `django-16263, django-15503, pytest-6197, django-12273`.

10 repos represented (django 9, sympy 6, astropy 2, psf 2, pylint/xarray/pallets/sklearn/pytest 1).
Prior outcomes and M74 failure clusters captured per case. **no_replacements: true.**

## Pre-flight

`run_stage5_m88_preflight.ts` (no agents, no Docker) re-rendered the exact structured-bounded +
pivot-confidence treatment context for all 24 and probed the combined guard + env seams:

- **24 / 24 VALID**; 0 partial sentinel; 0 required-IMPACT; confidence gate enabled on all.
- Tool-loop guard inject + **v4** configured; cost guard inject + **c7d** configured
  (editVerifyChurnThreshold=2, 25-tool gate unchanged); single combined PostToolUse hook available.
- Env guard `status=pass`, expected prefix verified, drift check enabled.
- **Gate PASSES** (≥20 valid required). Recorded in `stage5_m88_v4_c7d_envguard_preflight.json`.

## Run Matrix

| instance | grp | base | m73t | M88 | valid | env | V4 | C7 | cost | tools | note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sympy-15599 | A | R | . | . | ✓ | pass | 0 | **1** | $3.02 | 33 | C7 churn@29; cap, unresolved |
| pylint-4551 | A | . | . | . | ✓ | pass | 0 | 0 | $1.29 | 22 | <25 gate, silent; $3.0→$1.29 |
| sympy-12419 | A | R | . | **R** | ✓ | pass | 0 | 0 | $1.26 | 22 | recovered baseline-only |
| astropy-14598 | A | . | . | . | ✓ | pass | 0 | 0 | $1.76 | 22 | <25 gate, silent |
| xarray-6599 | A | R | . | . | ✓ | pass | 0 | 0 | $1.03 | 17 | silent |
| astropy-14369 | A | . | . | . | ✓ | pass | 0 | 0 | $1.20 | 12 | silent |
| requests-1921 | A | . | . | . | ✓ | pass | 0 | 0 | $0.50 | 6 | silent |
| django-15695 | A | R | . | . | ✓ | pass | 0 | 0 | $0.84 | 7 | silent |
| django-12325 | B | . | R | **R** | ✓ | pass | 0 | 0 | $0.52 | 9 | protected win held |
| django-11815 | B | . | R | **R** | ✓ | pass | 0 | 0 | $0.44 | 8 | protected win held |
| requests-1724 | B | . | R | . | ✓ | pass | 0 | 0 | $0.42 | 9 | lost (guard-silent variance) |
| sympy-15875 | B | . | R | . | ✓ | pass | 0 | 0 | $0.51 | 6 | lost (guard-silent variance) |
| sympy-24562 | C | R | . | **R** | ✓ | pass | 0 | 0 | $0.53 | 9 | recovered |
| sympy-13974 | C | R | . | . | ✓ | pass | 0 | 0 | $0.46 | 8 | still unresolved |
| django-16938 | C | R | . | **R** | ✓ | pass | 0 | 0 | $1.26 | 27 | recovered; 27 tools, C7 silent (no churn) |
| django-15572 | C | R | . | . | ✓ | pass | 0 | 0 | $0.31 | 5 | still unresolved |
| django-16569 | D | R | R | **R** | ✓ | pass | 0 | 0 | $0.30 | 4 | control held |
| sympy-18189 | D | R | R | **R** | ✓ | pass | 0 | 0 | $0.31 | 4 | control held |
| flask-5014 | D | R | R | **R** | ✓ | pass | 0 | 0 | $0.31 | 6 | control held |
| sklearn-11578 | D | R | R | **R** | ✓ | pass | 0 | 0 | $0.34 | 4 | control held |
| django-16263 | E | . | . | . | ✓ | pass | 0 | **1** | $3.02 | 40 | C7 churn@32; cap, unresolved (consistent) |
| django-15503 | E | . | . | . | ✓ | pass | 0 | 0 | $0.55 | 11 | cheap non-resolving path (M85 was $3.0/resolved) |
| pytest-6197 | E | R | R | . | ✓ | pass | 0 | 0 | $0.55 | 8 | lost (variance); **no early V4 fire** |
| django-12273 | E | . | R | **R** | ✓ | pass | 0 | 0 | $0.63 | 10 | **protected win preserved** |

(base = M73 baseline resolved; m73t = M73 treatment resolved; M88 = this run; R = resolved.)

## Environment Safety

The standout positive. Across **all 24 runs**:

- `stage5_env_guard_status = pass` (24/24); `stage5_python_prefix_verified = true` (24/24);
  `stage5_pip_prefix_verified = true` (24/24); `stage5_expected_testbed_prefix =
  /home/calvin/miniforge3/envs/vexp_swebench` (24/24); `stage5_drift_check_enabled = true` (24/24).
- **Zero** prefix-drift danger (`changed_during_run` / `pip_conda_mismatch` / `import_broken` absent
  on every run); **zero** prefix-guard failures; **zero** blocked unsafe-pip commands.
- **Zero** runs became safety-invalid; **zero** FAILED-CLOSED throws (every run resolved a provably
  correct testbed interpreter before agent spawn).
- No run attempted wrong-prefix behavior. The protected base (`/home/calvin/miniforge3`) and dev
  prefixes were untouched.

## Guard Mechanism Analysis

- **V4 (tool-loop):** fired **0 times** across 24 runs; **0 suppressions**. Mechanically active and
  default-off on every run (`runtime_injection`, calibration `v4`). The agent simply never produced
  the repeated-read/repeated-failed-command signature this slice — so V4 stayed silent, which is the
  safe outcome. No early read fire anywhere.
- **C7_D (cost/no-convergence):** fired **2 times**, both `edit_verify_churn`, both on cap/thrash
  targets — `sympy-15599` (A, @29) and `django-16263` (E, @32). `editVerifyChurnThreshold=2` and the
  25-tool gate were intact on all 24. **Both fires landed on runs that still reached the $3.0 cap and
  did not resolve** (`c7_fired_before_cap_all = false`): C7_D fired earlier than the cap but not early
  enough to alter the outcome — the same *neutral-late* limitation observed in M82/M85, not harm.
- **Combined hook:** the single PostToolUse `--settings` seam coexisted on all 24
  (`combined_hook_coexists_all = true`); **0 same-turn double-fires**; guard markers verified on every
  fire.
- **Early-fire analysis:** no C7_D fire on any B/C/D control/protected case; no V4 read fire ≤turn 4
  anywhere. `django-16938` (C) ran 27 tools — above the 25 gate — yet C7_D correctly stayed silent
  (no edit/verify churn) and the case *resolved*: good restraint, not a missed fire.
- **Targeted no-convergence (cohort A):** mean cost **−28%** ($1.36 vs M73 $1.88) and fewer tools
  (17.6 vs 20); cohort A even recovered one prior baseline-only loss (`sympy-12419`). The cost
  improvement is broad (cheaper trajectories) rather than guard-attributable — only 1 of 8 A-cases
  fired a guard.

## M85 Carryover Cases

| case | M73t | M80 | M82 | M85 | M88 | M85 guard | M88 guard | Δcost vs M85 | intended dir? |
|---|---|---|---|---|---|---|---|---|---|
| **django-16263** | . | . | . | . | . | V4+C7@24 | C7@32 (churn) | +$0.002 | yes (consistent fail; on-target fire) |
| **django-15503** | . | R | . | R | . | V4+C7 | silent | −$2.45 | mixed (cheaper but lost the win) |
| **pytest-6197** | R | . | . | R | . | silent | silent, **no early V4** | −$0.43 | yes on safety (no risky fire); lost on resolution |
| **django-12273** | R | . | . | R | **R** | silent | silent | −$0.12 | **yes — protected win preserved** |

- **django-16263:** the headline thrash sentinel. Unresolved across every milestone. C7_D fired
  on-target (`edit_verify_churn` @32) but, as in M85, the run still hit the cap — neutral-late. Cost
  essentially flat vs M85. No V4 (M85 had a V4 read fire); safe.
- **django-12273:** the protected win that M80/M82 V4 *regressed*. Under V4+C7_D it is **preserved
  (resolved, no guard fire)** at lower cost than M85 — the clearest positive carryover.
- **pytest-6197:** the specific old risk (a risky early V4 read fire) **did not recur**
  (`early_v4_read_fire = false`). It lost the win this run, but guard-silently — live variance, not a
  guard effect.
- **django-15503:** took a cheap non-resolving trajectory this run ($0.55 vs M85 $3.0) and lost the
  M85 win, guard-silently. Variance.

## Cohort Analysis

### Cost/no-convergence targets (A, n=8)
Resolved 1/8 (M73-treatment 0/8 → +1: `sympy-12419` recovered). Mean cost **$1.36 vs M73 $1.88
(−28%)**, mean tools 17.6 vs 20. C7_D fired on 1 (`sympy-15599`, on-target churn). The cohort is
cheaper and slightly leaner; the guard engaged exactly where designed.

### Protected wins / treatment-only wins (B, n=4)
Resolved 2/4 (M73-treatment 4/4). Two wins lost (`requests-1724`, `sympy-15875`) — both
**guard-silent** (no V4/C7 fire), cheap, short runs: run-to-run variance, **not guard-caused harm**.

### Baseline-only losses / regression-risk (C, n=4)
Resolved 2/4 (M73-treatment 0/4 → **+2 recovered**: `sympy-24562`, `django-16938`). No guard fired.
A net positive cohort; the regression-risk cases were not further harmed by the guards.

### Normal controls (D, n=4)
Resolved **4/4** (M73-treatment 4/4). **No guard fired; controls fully preserved.** Costs flat.

### M85 sentinels (E, n=4)
Resolved 1/4 (M85 3/4). The protected win `django-12273` held; `pytest-6197` and `django-15503` lost
guard-silently (variance). C7_D fired on-target on `django-16263`; no risky V4 fire anywhere.

## Success Criteria Check

1. ≥20 valid treatment runs — **PASS** (24/24).
2. Env guard passes every valid run — **PASS** (24/24).
3. No protected base/dev prefix drift — **PASS** (zero).
4. Both guards runtime-active and default-off — **PASS** (`runtime_injection`, opt-in).
5. C7_D calibration recorded — **PASS** (`c7d`, churn=2, gate=25 on all).
6. No early harmful C7_D fires on controls/protected — **PASS** (C7 only on A+E cap/thrash targets).
7. No pytest-style risky early V4 read fire — **PASS** (V4 fired 0×; pytest-6197 early_v4=false).
8. Protected/control cohorts not materially harmed — **PARTIAL** — D held 4/4 and no guard fired on
   any B/C/D/E case, so **no guard-caused harm**; but raw B-cohort resolution dropped 4/4→2/4 via
   live variance.
9. Targeted cost cohort shows cost/tool improvement or clear explanation — **PASS** (cohort A −28%
   cost, fewer tools; C7 on-target).
10. Guard + env-safety metadata complete — **PASS**.
11. No new sentinel/contract/gate validity failures — **PASS** (0 invalid, 0 partial sentinel).

10 PASS, 1 PARTIAL (criterion 8: no guard-caused harm, but guard-silent resolution variance in the
protected cohort).

## Verdict

**MIXED.**

Environment safety, guard mechanism, and the targeted-cost cohort all pass cleanly: the env guard
held on all 24 runs with zero drift, both behavioral guards were runtime-active/default-off with the
correct V4 + C7_D calibration, C7_D fired only on cap/thrash targets (never on a control/protected
case), V4 produced no risky early read fire, and cohort A was 28% cheaper. **No safety regression and
no guard-caused harm occurred.** However, live resolution remains inconclusive — the protected (B)
and carryover (E) cohorts lost wins through guard-silent run-to-run variance, and the two C7_D fires
were neutral-late (fired before the cap but too late to change the outcome). This mirrors the M85
MIXED finding at larger N.

## Recommendation

**Make the env guard mandatory for Stage 5 live work.** It performed flawlessly across all 24 runs
(prefix verified, zero drift, zero unsafe-pip, zero FAILED-CLOSED), is pure protection with no effect
on agent behavior, and directly closes the contamination risk that paused live work in M86/M87. Keep
**both behavioral guards default-off**: they are mechanically safe but show no clear resolution
benefit at this scale (V4 silent; C7_D fires only neutral-late on cap cases). If the behavioral
guards are pursued further, a 50-task guarded confirmation (env guard mandatory) is the right next
step to separate guard effect from live variance — but the bankable outcome here is the env guard.
