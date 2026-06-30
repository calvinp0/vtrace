# Stage 5 M92 Core VTRACE Token-Reduction Confirmation

## Summary

- Selected cases: 50 (frozen M90 50-task split, membership unchanged)
- New live runs: 50; valid: 50; invalid: 0; operational retries used: 0
- Docker evals: 50 resolved-or-unresolved scored; pending eval: 0
- Safety guard result: env_guard_pass_all=True, shell_guard_pass_all=True, host_pip_firewall_all=True, drift_detected=0, escape_hatch=0, blocked_pkg_cmds=0
- Behavioral guards disabled: True (tool_loop_guard_enabled_any=False, cost_guard_enabled_any=False, V4 injections=0, C7_D injections=0)
- Resolution: M92=20/50 vs M73 baseline=20, M73 treatment=22, M90=17
- Cost: M92=$36.3370 vs M73 baseline=$48.4530 vs M73 treatment=$39.7665 vs M90=$34.6072
- Token/cost reduction vs M73 baseline: cost -25.01%, total tokens -26.71%
- **Verdict: PASS**
- **Recommendation: proceed to 100-task core VTRACE confirmation**

## Why M92

- **M91 policy (Policy A):** env guard mandatory; agent shell guard / host-pip firewall mandatory; V4 tool-loop guard and C7_D cost guard kept as opt-in diagnostics, default-off. M91 found the M90 resolution drop was ordinary live single-sample variance (6/7 losses had zero guard fire; the shell guard did not even exist during M90), not guard-caused.
- **Why V4/C7_D are excluded:** M85/M88/M90 showed no resolution benefit; V4 fires are reactive recovery nudges and C7_D fires are neutral-late on cap targets. Including them would confound a clean token-reduction measurement with behavioral-guard noise.
- **Question answered:** with benchmark safety fixed and V4/C7_D disabled, does the CORE VTRACE treatment preserve resolution while reducing tokens/cost on the same 50-task M90 slice?

## Split

- Same M90 50-task split, carried forward unchanged from `stage5_m90_v4_c7d_envguard50_split.json`.
- Group counts: {"A": 14, "B": 10, "C": 10, "D": 10, "E": 6}; total 50.
- Repos covered: astropy/astropy, django/django, matplotlib/matplotlib, mwaskom/seaborn, pallets/flask, psf/requests, pydata/xarray, pylint-dev/pylint, pytest-dev/pytest, scikit-learn/scikit-learn, sphinx-doc/sphinx, sympy/sympy
- No replacements; no re-selection after results.

## Pre-flight

- Treatment validity: 50/50 VALID; by_status={"VALID": 50}.
- 0 partial sentinel (0), 0 required IMPACT (0), compact applied all=True, confidence gate all=True.
- Safety guard config: env guard pass=True (prefix_ok=True, drift=True); shell guard available=True (status=pass, benchmark_valid=True).
- Behavioral guard disabled proof: behavioral_guards_disabled_all=True (tool_loop configured=False, cost configured=False).
- Gate passes: True.

## Run Matrix

| instance_id | grp | M73_base | M73_treat | M90 | M92 | M92_cost | M92_tokens | M92_tools | notes |
|---|---|---|---|---|---|---|---|---|---|
| pylint-dev__pylint-4551 | A | ✗ | ✗ | ✗ | ✗ | 1.212 | 2932181 | 24 |  |
| sphinx-doc__sphinx-7748 | A | ✗ | ✗ | ✗ | ✗ | 0.831 | 1955090 | 19 |  |
| pydata__xarray-6599 | A | ✓ | ✗ | ✗ | ✗ | 1.605 | 3313443 | 28 |  |
| astropy__astropy-14369 | A | ✗ | ✗ | ✗ | ✗ | 1.251 | 2294336 | 16 |  |
| psf__requests-1921 | A | ✗ | ✗ | ✗ | ✗ | 0.407 | 528153 | 4 |  |
| django__django-15695 | A | ✓ | ✗ | ✗ | ✗ | 0.655 | 1191564 | 11 |  |
| django__django-14792 | A | ✗ | ✗ | ✗ | ✗ | 0.631 | 980299 | 11 |  |
| sympy__sympy-24562 | A | ✓ | ✗ | ✓ | ✓ | 0.921 | 1499906 | 14 |  |
| sympy__sympy-20428 | A | ✗ | ✗ | ✗ | ✗ | 3.023 | 4560995 | 40 |  |
| django__django-16938 | A | ✓ | ✗ | ✗ | ✗ | 0.481 | 842135 | 8 |  |
| matplotlib__matplotlib-24870 | A | ✗ | ✗ | ✗ | ✗ | 0.910 | 2131528 | 21 |  |
| django__django-16667 | A | ✗ | ✗ | ✗ | ✗ | 0.329 | 560307 | 5 |  |
| django__django-16256 | A | ✗ | ✗ | ✗ | ✗ | 0.614 | 1209800 | 13 |  |
| mwaskom__seaborn-3187 | A | ✗ | ✗ | ✗ | ✗ | 0.450 | 659018 | 6 |  |
| django__django-11815 | B | ✗ | ✓ | ✓ | ✓ | 0.340 | 549090 | 6 |  |
| matplotlib__matplotlib-24627 | B | ✗ | ✓ | ✗ | ✓ | 0.892 | 2061428 | 22 |  |
| psf__requests-1724 | B | ✗ | ✓ | ✗ | ✓ | 0.438 | 867787 | 8 |  |
| pydata__xarray-6938 | B | ✗ | ✓ | ✓ | ✓ | 0.614 | 1363425 | 14 |  |
| sympy__sympy-15875 | B | ✗ | ✓ | ✗ | ✗ | 0.899 | 2068206 | 20 |  |
| django__django-12325 | B | ✗ | ✓ | ✗ | ✓ | 0.489 | 852648 | 8 |  |
| matplotlib__matplotlib-25960 | B | ✗ | ✓ | ✗ | ✗ | 0.589 | 1149776 | 11 |  |
| django__django-12774 | B | ✗ | ✓ | ✓ | ✓ | 0.537 | 1102662 | 11 |  |
| django__django-13112 | B | ✗ | ✓ | ✗ | ✗ | 1.248 | 3439135 | 26 |  |
| django__django-13590 | B | ✗ | ✓ | ✓ | ✓ | 0.525 | 1104852 | 11 |  |
| sympy__sympy-13974 | C | ✓ | ✗ | ✗ | ✗ | 0.472 | 838958 | 8 |  |
| django__django-15572 | C | ✓ | ✗ | ✗ | ✗ | 0.418 | 838450 | 9 |  |
| psf__requests-5414 | C | ✓ | ✗ | ✗ | ✗ | 0.405 | 614130 | 6 |  |
| sympy__sympy-16597 | C | ✗ | ✗ | ✗ | ✗ | 0.613 | 1099874 | 11 |  |
| matplotlib__matplotlib-26466 | C | ✗ | ✗ | ✓ | ✗ | 0.453 | 1041580 | 11 |  |
| pytest-dev__pytest-10051 | C | ✗ | ✗ | ✗ | ✗ | 0.394 | 722143 | 8 |  |
| django__django-11820 | C | ✗ | ✗ | ✗ | ✗ | 0.453 | 763732 | 8 |  |
| sphinx-doc__sphinx-9711 | C | ✗ | ✗ | ✗ | ✗ | 0.348 | 683310 | 7 |  |
| sphinx-doc__sphinx-7462 | C | ✗ | ✗ | ✗ | ✗ | 0.359 | 612816 | 6 |  |
| astropy__astropy-14365 | C | ✗ | ✗ | ✗ | ✗ | 0.332 | 471876 | 4 |  |
| django__django-16569 | D | ✓ | ✓ | ✓ | ✓ | 0.355 | 564652 | 6 |  |
| sympy__sympy-18189 | D | ✓ | ✓ | ✓ | ✓ | 0.444 | 786126 | 9 |  |
| pallets__flask-5014 | D | ✓ | ✓ | ✓ | ✓ | 0.395 | 732787 | 8 |  |
| scikit-learn__scikit-learn-11578 | D | ✓ | ✓ | ✓ | ✓ | 0.373 | 525993 | 5 |  |
| pytest-dev__pytest-5262 | D | ✓ | ✓ | ✓ | ✓ | 0.333 | 497567 | 5 |  |
| pydata__xarray-2905 | D | ✓ | ✓ | ✓ | ✓ | 0.390 | 655873 | 6 |  |
| psf__requests-1142 | D | ✓ | ✓ | ✓ | ✓ | 0.437 | 654224 | 6 |  |
| sphinx-doc__sphinx-9698 | D | ✓ | ✓ | ✓ | ✓ | 0.545 | 1153447 | 13 |  |
| astropy__astropy-7166 | D | ✓ | ✓ | ✓ | ✓ | 0.380 | 571052 | 5 |  |
| matplotlib__matplotlib-24970 | D | ✓ | ✓ | ✓ | ✓ | 0.371 | 609310 | 6 |  |
| django__django-16263 | E | ✗ | ✗ | ✗ | ✗ | 3.034 | 4570386 | 40 |  |
| django__django-15503 | E | ✗ | ✗ | ✗ | ✗ | 0.531 | 1037133 | 11 |  |
| pytest-dev__pytest-6197 | E | ✓ | ✓ | ✗ | ✗ | 0.501 | 934518 | 10 |  |
| django__django-12273 | E | ✗ | ✓ | ✓ | ✓ | 0.634 | 1146033 | 11 |  |
| sympy__sympy-12419 | E | ✓ | ✗ | ✗ | ✓ | 3.043 | 4154452 | 29 |  |
| sympy__sympy-15599 | E | ✓ | ✗ | ✗ | ✗ | 0.432 | 714652 | 7 |  |

## Safety

- **Env guard:** pass on all 50 completed runs = True; expected prefix `/home/calvin/miniforge3/envs/vexp_swebench` matched all = True; benchmark_valid all = True.
- **Shell guard / host-pip firewall:** pass all = True; firewall enabled all = True.
- **Drift:** detected on 0 instances [].
- **Escape hatch:** used on 0 instances [].
- **Blocked package-manager commands:** 0 total across 0 instances [] (all logged by the firewall; none task-critical — the agent never needs to mutate host/base Python).

## Token and Cost Reduction

### M92 vs M73 baseline

- Resolution: M92=20 vs prior=[20] (delta +0)

| metric | n_paired | M92 total | prior total | abs delta | pct delta |
|---|---|---|---|---|---|
| cost | 50 | 36.3370 | 48.4530 | -12.1160 | -25.01% |
| total_tokens | 50 | 66212838.0000 | 90342843.0000 | -24130005.0000 | -26.71% |
| cache_read_tokens | 50 | 62721151.0000 | 86635093.0000 | -23913942.0000 | -27.60% |
| tool_calls | 50 | 612.0000 | 877.0000 | -265.0000 | -30.22% |

### M92 vs M73 treatment

- Resolution: M92=20 vs prior=[22] (delta -2)

| metric | n_paired | M92 total | prior total | abs delta | pct delta |
|---|---|---|---|---|---|
| cost | 50 | 36.3370 | 39.7665 | -3.4294 | -8.62% |
| total_tokens | 50 | 66212838.0000 | 66463689.0000 | -250851.0000 | -0.38% |
| tool_calls | 50 | 612.0000 | 583.0000 | 29.0000 | +4.97% |

### M92 vs M90

- Resolution: M92=20 vs prior=[17] (delta +3)

| metric | n_paired | M92 total | prior total | abs delta | pct delta |
|---|---|---|---|---|---|
| cost | 50 | 36.3370 | 34.6072 | 1.7298 | +5.00% |
| total_tokens | 50 | 66212838.0000 | 59781034.0000 | 6431804.0000 | +10.76% |
| tool_calls | 50 | 612.0000 | 577.0000 | 35.0000 | +6.07% |

### By token category (M92 totals)

| category | tokens | share |
|---|---|---|
| input_tokens | 11819 | 0.02% |
| output_tokens | 4117 | 0.01% |
| cache_read_tokens | 62721151 | 94.73% |
| cache_write_tokens | 3475751 | 5.25% |
| **grand total** | 66212838 | 100% |

- Dominant token category: **cache_read_tokens**.

### By cohort (group)

| grp | n | ran | valid | M92 res | M73 base res | cost M92 | cost M73 base | tokens M92 | tools M92 |
|---|---|---|---|---|---|---|---|---|---|
| A | 14 | 14 | 14 | 1 | 4 | 13.3200 | 17.5004 | 24658755 | 220 |
| B | 10 | 10 | 10 | 7 | 0 | 6.5700 | 11.0973 | 14559009 | 137 |
| C | 10 | 10 | 10 | 0 | 3 | 4.2471 | 5.3615 | 7686869 | 78 |
| D | 10 | 10 | 10 | 10 | 10 | 4.0234 | 4.0321 | 6751031 | 69 |
| E | 6 | 6 | 6 | 2 | 3 | 8.1765 | 10.4618 | 12557174 | 108 |

### By repo

| repo | n | M92 resolved | cost M92 | tokens M92 | cost M73 base |
|---|---|---|---|---|---|
| astropy/astropy | 3 | 1 | 1.9634 | 3337264 | 2.3776 |
| django/django | 16 | 6 | 11.2746 | 20752878 | 14.2673 |
| matplotlib/matplotlib | 5 | 2 | 3.2145 | 6993622 | 5.9450 |
| mwaskom/seaborn | 1 | 0 | 0.4499 | 659018 | 3.0466 |
| pallets/flask | 1 | 1 | 0.3954 | 732787 | 0.2537 |
| psf/requests | 4 | 2 | 1.6881 | 2664294 | 1.7869 |
| pydata/xarray | 3 | 2 | 2.6089 | 5332741 | 5.0671 |
| pylint-dev/pylint | 1 | 0 | 1.2121 | 2932181 | 1.1242 |
| pytest-dev/pytest | 3 | 1 | 1.2284 | 2154228 | 2.4540 |
| scikit-learn/scikit-learn | 1 | 1 | 0.3733 | 525993 | 0.3707 |
| sphinx-doc/sphinx | 4 | 1 | 2.0830 | 4404663 | 4.0227 |
| sympy/sympy | 8 | 3 | 9.8455 | 15723169 | 7.7372 |

## Resolution / Quality

- vs M73 baseline: wins ['django__django-11815', 'matplotlib__matplotlib-24627', 'psf__requests-1724', 'pydata__xarray-6938', 'django__django-12325', 'django__django-12774', 'django__django-13590', 'django__django-12273']; losses ['pydata__xarray-6599', 'django__django-15695', 'django__django-16938', 'sympy__sympy-13974', 'django__django-15572', 'psf__requests-5414', 'pytest-dev__pytest-6197', 'sympy__sympy-15599'].
- vs M73 treatment: wins ['sympy__sympy-24562', 'sympy__sympy-12419']; losses ['sympy__sympy-15875', 'matplotlib__matplotlib-25960', 'django__django-13112', 'pytest-dev__pytest-6197'].
- Likely variance vs context failure: single-sample one-shot flips on discordant cases are consistent with the M73/M90 live variance profile (M91 finding); a flip is attributed to context failure only when the injected capsule omitted the gold pivot neighborhood.
- No behavioral-guard confounders: V4/C7_D injections total 0/0 (both 0 expected).

## Token Attribution

- Capsule/digest estimates (deterministic render): mean injected context ≈ 11560 chars; mean digest ≈ 2524 chars.
- Dominant spend category: **cache_read_tokens** (94.73% of all tokens) — cache-read dominance indicates spend is driven by conversation/tool-output replay across turns, not by the (small, bounded) injected capsule.
- Top 10 cost-heavy cases:
  - sympy__sympy-12419 (grp E, sympy/sympy): $3.043, 4154452 tok, 29 tools, 71 turns, resolved=True
  - django__django-16263 (grp E, django/django): $3.034, 4570386 tok, 40 tools, 97 turns, resolved=False
  - sympy__sympy-20428 (grp A, sympy/sympy): $3.023, 4560995 tok, 40 tools, 93 turns, resolved=False
  - pydata__xarray-6599 (grp A, pydata/xarray): $1.605, 3313443 tok, 28 tools, 70 turns, resolved=False
  - astropy__astropy-14369 (grp A, astropy/astropy): $1.251, 2294336 tok, 16 tools, 46 turns, resolved=False
  - django__django-13112 (grp B, django/django): $1.248, 3439135 tok, 26 tools, 73 turns, resolved=False
  - pylint-dev__pylint-4551 (grp A, pylint-dev/pylint): $1.212, 2932181 tok, 24 tools, 64 turns, resolved=False
  - sympy__sympy-24562 (grp A, sympy/sympy): $0.921, 1499906 tok, 14 tools, 35 turns, resolved=True
  - matplotlib__matplotlib-24870 (grp A, matplotlib/matplotlib): $0.910, 2131528 tok, 21 tools, 53 turns, resolved=False
  - sympy__sympy-15875 (grp B, sympy/sympy): $0.899, 2068206 tok, 20 tools, 53 turns, resolved=False
- High-cost unresolved cases account for $23.8806 (65.72% of total M92 spend).
- Top 10 context-heavy cases:
  - sphinx-doc__sphinx-7748 (grp A): 11994 ctx chars, ~7323 capsule tok, truncated=True, req=0, opt=1
  - astropy__astropy-14369 (grp A): 11994 ctx chars, ~5086 capsule tok, truncated=True, req=2, opt=2
  - psf__requests-1921 (grp A): 11994 ctx chars, ~1236 capsule tok, truncated=True, req=2, opt=2
  - django__django-15695 (grp A): 11994 ctx chars, ~2413 capsule tok, truncated=True, req=0, opt=4
  - sympy__sympy-24562 (grp A): 11994 ctx chars, ~5667 capsule tok, truncated=True, req=2, opt=2
  - matplotlib__matplotlib-24870 (grp A): 11994 ctx chars, ~2396 capsule tok, truncated=True, req=2, opt=2
  - django__django-16256 (grp A): 11994 ctx chars, ~6162 capsule tok, truncated=True, req=2, opt=2
  - matplotlib__matplotlib-24627 (grp B): 11994 ctx chars, ~1848 capsule tok, truncated=True, req=2, opt=2
  - pydata__xarray-6938 (grp B): 11994 ctx chars, ~1477 capsule tok, truncated=True, req=2, opt=2
  - django__django-12325 (grp B): 11994 ctx chars, ~3840 capsule tok, truncated=True, req=2, opt=0
- Likely next optimization lever: **tool-output/token accounting (cache-read dominates spend)**.

## Success Criteria Check

| # | criterion | result | evidence |
|---|---|---|---|
| 1 | >=45 valid treatment runs | PASS | valid=50/50 |
| 2 | env guard passes on every valid run | PASS | env_guard_pass_all=True |
| 3 | shell guard / host-pip firewall passes on every valid run | PASS | shell_pass_all=True firewall_all=True |
| 4 | no protected base/dev prefix drift | PASS | drift=[] |
| 5 | no unguarded escape hatch | PASS | escape=[] |
| 6 | V4/C7_D behavioral guards disabled | PASS | behavioral_off_all=True tl_any=False cg_any=False |
| 7 | resolution >= M73 baseline on selected 50 | PASS | m92=20 m73_baseline=20 |
| 8 | cost reduction vs M73 baseline >= 10% | PASS | cost_delta_pct=-25.01 |
| 9 | token/cost metrics complete enough for attribution | PASS | grand_total_tokens=66212838 |
| 10 | no new sentinel/contract/gate validity failures | PASS | preflight_valid=50 partial_sentinel=0 |
| 11 | no safety guard blocked a task-critical command unreported | PASS | blocked_pkg_cmds=0 (all logged; none task-critical) |

## Verdict

**PASS**

Safety clean (env+shell guards pass on every run, no drift, no escape hatch), behavioral guards provably off, resolution at least matched M73 baseline, and cost reduced ≥10% vs M73 baseline with complete attribution metrics.

## Recommendation

**proceed to 100-task core VTRACE confirmation**

### Scope caveat

Internal token-reduction confirmation on the frozen M90 50-task slice. NOT a VEXP parity, broad SWE-bench, statistical-superiority, or public claim, and not a 100-task sweep.
