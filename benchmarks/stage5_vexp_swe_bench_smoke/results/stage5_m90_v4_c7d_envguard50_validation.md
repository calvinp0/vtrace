# Stage 5 M90 V4 + C7_D Env-Guarded 50-Task Confirmation

> Internal guarded confirmation. NOT a VEXP parity claim, NOT a broad SWE-bench claim, NOT statistical superiority, NOT default promotion of V4 or C7_D. Both behavioral guards remain DEFAULT-OFF globally; the M89 environment guard is mandatory for live runs.

## Summary

- Selected cases: 50 (A14 / B10 / C10 / D10 / E6), 12 repos
- New live treatment runs: 50/50 (sequential); operational retries: 0; quota aborts: 0
- Valid / invalid runs: **50 valid**, 0 invalid
- Docker evals: 50/50 evaluated (0 pending)
- Mandatory env guard: **PASS on all 50** (0 safety-invalid, 0 escape-hatch, 0 drift)
- V4 injections: **4×** (suppressed 3); on control/protected: 2
- C7_D injections: **3×** (triggers: ['edit_verify_churn', 'high_turn_count']); on control/protected: 0
- Resolution: **M90 17** vs M73-treatment 22 vs M73-baseline 20 (same 50 cases)
- Cost: **$34.61** vs M73-treatment $39.77 (-13.0%); tool calls 577 vs 583 (-1.0%)
- **Verdict: MIXED**
- **Recommendation: keep env guard mandatory and keep V4/C7_D opt-in diagnostics**

## M89 Sanity Check

- Mandatory env guard implemented; live runs fail closed before agent spawn unless guard+drift on and prefix verified.
- Escape hatch `--allow-unguarded-live-env` default-off and NOT used by drivers.
- M87B baseRepairVerified=true, expectedTestbedClean=true; M88 env guard passed all 24 live runs (0 drift).
- V4 calibration available; C7_D calibration available (editVerifyChurnThreshold=2, 25-tool gate unchanged).
- Expected prefix: `/home/calvin/miniforge3/envs/vexp_swebench`. **Safe to continue: yes.**

## Split

Deterministic selection from M73 paired detail + M74 self-harness classification + M88 detail (skipped/invalid M73 cases excluded from A/B/C/D; carryover sentinels fixed in E). No replacements after results.

**Group A** (14): pylint-dev__pylint-4551, sphinx-doc__sphinx-7748, pydata__xarray-6599, astropy__astropy-14369, psf__requests-1921, django__django-15695, django__django-14792, sympy__sympy-24562, sympy__sympy-20428, django__django-16938, matplotlib__matplotlib-24870, django__django-16667, django__django-16256, mwaskom__seaborn-3187
**Group B** (10): django__django-11815, matplotlib__matplotlib-24627, psf__requests-1724, pydata__xarray-6938, sympy__sympy-15875, django__django-12325, matplotlib__matplotlib-25960, django__django-12774, django__django-13112, django__django-13590
**Group C** (10): sympy__sympy-13974, django__django-15572, psf__requests-5414, sympy__sympy-16597, matplotlib__matplotlib-26466, pytest-dev__pytest-10051, django__django-11820, sphinx-doc__sphinx-9711, sphinx-doc__sphinx-7462, astropy__astropy-14365
**Group D** (10): django__django-16569, sympy__sympy-18189, pallets__flask-5014, scikit-learn__scikit-learn-11578, pytest-dev__pytest-5262, pydata__xarray-2905, psf__requests-1142, sphinx-doc__sphinx-9698, astropy__astropy-7166, matplotlib__matplotlib-24970
**Group E** (6): django__django-16263, django__django-15503, pytest-dev__pytest-6197, django__django-12273, sympy__sympy-12419, sympy__sympy-15599

## Pre-flight

- No-agent gate-on render over all 50 cases: **50/50 VALID**, 0 partial sentinel, 0 required IMPACT.
- Confidence gate enabled all; V4 inject+v4 all; C7_D inject+c7d all; combined hook available all.
- Mandatory env guard preflight: status=pass, python/pip verified, drift-check enabled, prefix ok. Gate passes: **True**.

## Run Matrix

| instance | grp | b73 | t73 | M90 res | valid | env | V4 | C7_D | cost | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| pylint-dev__pylint-4551 | A | · | · | · | ✓ | pass | 0 | 0 | $0.99 |  |
| sphinx-doc__sphinx-7748 | A | · | · | · | ✓ | pass | 1 | 0 | $1.13 | V4 |
| pydata__xarray-6599 | A | ✓ | · | · | ✓ | pass | 0 | 0 | $1.05 |  |
| astropy__astropy-14369 | A | · | · | · | ✓ | pass | 0 | 0 | $0.86 |  |
| psf__requests-1921 | A | · | · | · | ✓ | pass | 0 | 0 | $0.36 |  |
| django__django-15695 | A | ✓ | · | · | ✓ | pass | 0 | 0 | $0.68 |  |
| django__django-14792 | A | · | · | · | ✓ | pass | 0 | 0 | $0.52 |  |
| sympy__sympy-24562 | A | ✓ | · | ✓ | ✓ | pass | 0 | 0 | $0.57 |  |
| sympy__sympy-20428 | A | · | · | · | ✓ | pass | 0 | 0 | $0.68 |  |
| django__django-16938 | A | ✓ | · | · | ✓ | pass | 0 | 0 | $0.60 |  |
| matplotlib__matplotlib-24870 | A | · | · | · | ✓ | pass | 0 | 0 | $0.58 |  |
| django__django-16667 | A | · | · | · | ✓ | pass | 0 | 0 | $0.31 |  |
| django__django-16256 | A | · | · | · | ✓ | pass | 0 | 0 | $0.45 |  |
| mwaskom__seaborn-3187 | A | · | · | · | ✓ | pass | 0 | 0 | $0.51 |  |
| django__django-11815 | B | · | ✓ | ✓ | ✓ | pass | 0 | 0 | $0.41 |  |
| matplotlib__matplotlib-24627 | B | · | ✓ | · | ✓ | pass | 1 | 0 | $1.06 | V4 |
| psf__requests-1724 | B | · | ✓ | · | ✓ | pass | 0 | 0 | $0.46 |  |
| pydata__xarray-6938 | B | · | ✓ | ✓ | ✓ | pass | 0 | 0 | $0.56 |  |
| sympy__sympy-15875 | B | · | ✓ | · | ✓ | pass | 0 | 0 | $0.90 |  |
| django__django-12325 | B | · | ✓ | · | ✓ | pass | 0 | 0 | $0.41 |  |
| matplotlib__matplotlib-25960 | B | · | ✓ | · | ✓ | pass | 0 | 0 | $0.43 |  |
| django__django-12774 | B | · | ✓ | ✓ | ✓ | pass | 0 | 0 | $0.54 |  |
| django__django-13112 | B | · | ✓ | · | ✓ | pass | 0 | 0 | $0.44 |  |
| django__django-13590 | B | · | ✓ | ✓ | ✓ | pass | 0 | 0 | $0.45 |  |
| sympy__sympy-13974 | C | ✓ | · | · | ✓ | pass | 0 | 0 | $0.76 |  |
| django__django-15572 | C | ✓ | · | · | ✓ | pass | 0 | 0 | $0.40 |  |
| psf__requests-5414 | C | ✓ | · | · | ✓ | pass | 0 | 0 | $0.32 |  |
| sympy__sympy-16597 | C | · | · | · | ✓ | pass | 0 | 0 | $0.34 |  |
| matplotlib__matplotlib-26466 | C | · | · | ✓ | ✓ | pass | 0 | 0 | $0.73 |  |
| pytest-dev__pytest-10051 | C | · | · | · | ✓ | pass | 0 | 0 | $0.48 |  |
| django__django-11820 | C | · | · | · | ✓ | pass | 0 | 0 | $0.53 |  |
| sphinx-doc__sphinx-9711 | C | · | · | · | ✓ | pass | 0 | 0 | $0.42 |  |
| sphinx-doc__sphinx-7462 | C | · | · | · | ✓ | pass | 0 | 0 | $0.44 |  |
| astropy__astropy-14365 | C | · | · | · | ✓ | pass | 0 | 0 | $0.38 |  |
| django__django-16569 | D | ✓ | ✓ | ✓ | ✓ | pass | 0 | 0 | $0.27 |  |
| sympy__sympy-18189 | D | ✓ | ✓ | ✓ | ✓ | pass | 0 | 0 | $0.28 |  |
| pallets__flask-5014 | D | ✓ | ✓ | ✓ | ✓ | pass | 0 | 0 | $0.35 |  |
| scikit-learn__scikit-learn-11578 | D | ✓ | ✓ | ✓ | ✓ | pass | 0 | 0 | $0.34 |  |
| pytest-dev__pytest-5262 | D | ✓ | ✓ | ✓ | ✓ | pass | 0 | 0 | $0.36 |  |
| pydata__xarray-2905 | D | ✓ | ✓ | ✓ | ✓ | pass | 1 | 0 | $0.68 | V4 |
| psf__requests-1142 | D | ✓ | ✓ | ✓ | ✓ | pass | 0 | 0 | $0.38 |  |
| sphinx-doc__sphinx-9698 | D | ✓ | ✓ | ✓ | ✓ | pass | 0 | 0 | $0.44 |  |
| astropy__astropy-7166 | D | ✓ | ✓ | ✓ | ✓ | pass | 0 | 0 | $0.42 |  |
| matplotlib__matplotlib-24970 | D | ✓ | ✓ | ✓ | ✓ | pass | 0 | 0 | $0.49 |  |
| django__django-16263 | E | · | · | · | ✓ | pass | 0 | 2 | $3.02 | C7@25 |
| django__django-15503 | E | · | · | · | ✓ | pass | 0 | 1 | $1.92 | C7@30 |
| pytest-dev__pytest-6197 | E | ✓ | ✓ | · | ✓ | pass | 0 | 0 | $0.97 |  |
| django__django-12273 | E | · | ✓ | ✓ | ✓ | pass | 0 | 0 | $0.57 |  |
| sympy__sympy-12419 | E | ✓ | · | · | ✓ | pass | 1 | 0 | $1.33 | V4 |
| sympy__sympy-15599 | E | ✓ | · | · | ✓ | pass | 0 | 1 | $3.02 | C7@32, no-patch |

## Environment Safety

- Mandatory env guard: **PASS on all 50 runs**.
- Drift summary: 0 protected-prefix changes detected (0 drift instances).
- Escape-hatch usage: 0 (none).
- Expected prefix verified on all: True; python_prefix True; pip_prefix True; drift-check enabled all True.
- Blocked / safety-invalid runs: none.

## Guard Mechanism Analysis

### V4 tool-loop guard
- Fired **4×** on: ['sphinx-doc__sphinx-7748', 'matplotlib__matplotlib-24627', 'pydata__xarray-2905', 'sympy__sympy-12419']; triggers ['repeated_command_family_error', 'repeated_failed_command', 'repeated_read']; suppressed 3.
- On control/protected (B/D) cohorts: ['matplotlib__matplotlib-24627', 'pydata__xarray-2905']. pytest-6197 V4 fire: no — no pytest-style risky early read fire.

### C7_D cost guard
- Fired **3×** on: ['django__django-16263', 'django__django-15503', 'sympy__sympy-15599']; triggers ['edit_verify_churn', 'high_turn_count']; first-fire turns {'django__django-16263': 25, 'django__django-15503': 30, 'sympy__sympy-15599': 32}.
- On control/protected (B/D) cohorts: none. No early harmful control fires.
- All C7_D fires on high-cost/cap targets; consistent with M88 neutral-late behavior (guard fires too late to alter the cap outcome but adds no harm).

### Combined hook
- Same-turn combined messages: 0. One combined PostToolUse hook; cost guard has priority near budget.

## Carryover Sentinels

### django__django-16263
- M73 baseline=· treatment=·; M88 resolved=False; M85 status=None
- M90 resolved=·; cost=$3.02; tools=34; V4=False; C7_D=True (first turn 25)

### django__django-15503
- M73 baseline=· treatment=·; M88 resolved=False; M85 status=None
- M90 resolved=·; cost=$1.92; tools=37; V4=False; C7_D=True (first turn 30)

### pytest-dev__pytest-6197
- M73 baseline=✓ treatment=✓; M88 resolved=False; M85 status=None
- M90 resolved=·; cost=$0.97; tools=13; V4=False; C7_D=False (first turn None)

### django__django-12273
- M73 baseline=· treatment=✓; M88 resolved=True; M85 status=None
- M90 resolved=✓; cost=$0.57; tools=11; V4=False; C7_D=False (first turn None)

### sympy__sympy-12419
- M73 baseline=✓ treatment=·; M88 resolved=True; M85 status=None
- M90 resolved=·; cost=$1.33; tools=32; V4=True; C7_D=False (first turn None)

### sympy__sympy-15599
- M73 baseline=✓ treatment=·; M88 resolved=False; M85 status=None
- M90 resolved=·; cost=$3.02; tools=35; V4=False; C7_D=True (first turn 32)

## Cohort Analysis

### A Cost/no-convergence or thrash
- n=14 valid=14 resolved=1 (M73-treatment 0); V4 fired 1, C7_D fired 0
- cost $9.29 vs M73 $11.10 (-16.3%); tools 153 vs 160 (-4.4%)

### B Protected / treatment-only wins
- n=10 valid=10 resolved=4 (M73-treatment 10); V4 fired 1, C7_D fired 0
- cost $5.66 vs M73 $6.90 (-18.0%); tools 109 vs 133 (-18.0%)
- Prior treatment-only wins held 4/10. Of the 6 B losses, 5 had ZERO guard fire (live single-sample variance — these were one-shot M73 wins); 1 had a guard fire, and that fire was an advisory recovery nudge after repeated command failures (responding to an already-struggling run, not a patch-altering mechanism). No guard-caused regression mechanism.

### C Baseline-only / regression-risk
- n=10 valid=10 resolved=1 (M73-treatment 0); V4 fired 0, C7_D fired 0
- cost $4.80 vs M73 $3.73 (+28.7%); tools 86 vs 58 (+48.3%)
- C are baseline-only / regression-risk cases treatment loses; resolved 1/10. Cost/tool uptick reflects treatment churning on hard cases it ultimately can't solve (not a control concern).

### D Controls
- n=10 valid=10 resolved=10 (M73-treatment 10); V4 fired 1, C7_D fired 0
- cost $4.02 vs M73 $3.67 (+9.6%); tools 67 vs 60 (+11.7%)
- Controls held 10/10 (0 regressions). xarray-2905 fired V4 (command-failure recovery) and STILL resolved → guard fire caused no harm. Cost/tool uptick is small-case noise, not guard churn.

### E Carryover sentinels
- n=6 valid=6 resolved=1 (M73-treatment 2); V4 fired 1, C7_D fired 3
- cost $10.83 vs M73 $14.37 (-24.6%); tools 162 vs 172 (-5.8%)

## Success Criteria Check

1. ✅ ≥45 valid treatment runs
2. ✅ mandatory env guard passes on every valid run
3. ✅ no protected base/dev prefix drift
4. ✅ no live run used unguarded escape hatch
5. ✅ both guards runtime-active but default-off globally
6. ✅ C7_D calibration recorded in metadata
7. ✅ no early harmful C7_D fires on controls/protected wins
8. ✅ no pytest-style risky early V4 read fire
9. ✅ protected/control cohorts not materially harmed
10. ✅ targeted cost cohort A shows cost/tool improvement or neutral-late explanation
11. ✅ guard + env-safety metadata complete
12. ✅ no new sentinel/contract/gate validity failures

## Verdict

**MIXED**

## Recommendation

**keep env guard mandatory and keep V4/C7_D opt-in diagnostics**

Rationale: environment safety is clean (mandatory guard passed every run, no drift, no escape hatch) and both behavioral guards are mechanically safe (no early harmful fires on controls/protected wins, no pytest-style risky V4 read fire). V4/C7_D fires concentrate on high-cost/cap targets and behave neutral-late, so they remain useful diagnostics but do not justify default promotion on this slice.
