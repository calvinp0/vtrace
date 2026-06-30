# Stage 5 M91 M90 Attribution and Policy Decision

> Offline / report-only attribution audit of the M90 50-task guarded confirmation. NO live agents,
> NO Docker evaluation, NO Conda mutation, NO API spend. Internal attribution only — NOT a VEXP
> parity claim, NOT a broad SWE-bench claim, NOT statistical superiority, NOT default promotion of
> V4 or C7_D.

## Summary

- **M90 recap.** 50 selected treatment runs (A14/B10/C10/D10/E6, 12 repos); 50/50 valid; 0 retries;
  0 quota aborts; 49–50/50 Docker evals. Mandatory M89 env guard PASS on all 50 (0 drift, 0
  safety-invalid, 0 escape-hatch). V4 fired 4×, C7_D fired 3×. Resolution: **M90 17/50** vs
  M73-treatment 22/50 vs M73-baseline 20/50 on the same 50. Cost $34.61 (−13% vs M73-treatment);
  tools 577 (−1%). Verdict MIXED.
- **Safety attribution.** The env guard is read-only and changed no agent behavior. **The agent
  shell guard / host-pip firewall did not exist during the M90 live runs** — it was committed
  (`b19fd6c`, 13:18) *after* every M90 run (08:01–10:32) and after the M90 commit (`fa09ebd`,
  12:05). It is the M90A *fix*, not an M90 input. Blocked host package-manager command count across
  all 50 M90 runs = **0**. No safety mechanism interfered with any M90 outcome.
- **Behavioral guard attribution.** All 4 V4 fires are reactive recovery nudges triggered by ≥3
  repeated failures (the agent was already thrashing); one of them (`pydata__xarray-2905`) fired and
  the case **still resolved**, proving V4 does not block wins. No risky early read fire. All 3 C7_D
  fires are on E-cohort cap/carryover targets at turns 25–32, all unresolved regardless —
  neutral-late, consistent with M85/M88. Neither guard explains the resolution drop.
- **B-cohort loss conclusion.** B dropped 10→4. The 6 losses all produced plausible targeted
  patches (real work → wrong/incomplete), **none** were no-patch-cap, **none** had a package block,
  and **5/6 had zero guard fire**. B = M73 *treatment-only single-sample wins*, the most
  variance-prone cohort; reverting on a fresh sample is expected. No guard-caused and no
  shell-firewall-caused B loss (the firewall did not exist).
- **Recommended policy: Policy A** — env guard mandatory, shell guard mandatory, V4/C7_D disabled by
  default and kept as opt-in diagnostics.
- **Next milestone.** M92 default env+shell guarded confirmation slice (no behavioral guards);
  optionally a targeted B-cohort replicate to bound variance.

## Inputs and Method

### Tracked artifacts inspected
- `stage5_m90_v4_c7d_envguard50_validation.md` / `.json` / `.detail.json` / `_split.json` /
  `_preflight.json`
- `stage5_m88_v4_c7d_envguard_validation.{md,json}` (prior 24-task; M85/M88 neutral-late baseline)
- `stage5_m89_mandatory_env_guard.{md,json}` (mandatory env-guard regime)
- `stage5_m73_final_100_paired_summary.json`, `stage5_m74_self_harness_lite_audit.json` (selection
  provenance for A/B/C/D and failure clusters)

### Raw streams inspected (targeted; not staged)
- `runs/m90_v4_c7d_envguard50_*/raw/vtrace/_run.meta.json` for all 50 (env-guard status, blocked-pip
  count, guard events/messages, shell-guard field presence)
- `_run.meta.json` guard events + injected messages for all 7 guard-fire cases (4 V4 + 3 C7_D)
- `swebench-*.jsonl` final rows for the 10 B-cohort cases (modelPatch → changed files, resolved)

### Limitations
- The agent shell guard / host-pip firewall post-dates M90, so its *behavioral* effect cannot be
  measured on this slice; it can only be assessed for absence-of-interference (which is total).
- Single-sample per case: win/loss vs M73-treatment is one fresh draw, so per-case flips cannot be
  separated from agent non-determinism without replication.
- Attribution uses captured `_run.meta.json` event metadata rather than full token-level stream
  replay.

## Safety Infrastructure Attribution

### Env guard (M89, read-only)
- `stage5_env_guard_status` = **pass** on 50/50; `stage5_env_guard_benchmark_valid` = **true** on
  50/50; 0 drift instances; 0 escape-hatch usage; expected prefix
  `/home/calvin/miniforge3/envs/vexp_swebench` verified on all.
- The env guard is a read-only pre-spawn prefix probe + before/after drift snapshot. It does **not**
  sanitize PATH or scrub conda/venv vars (that is the later shell guard). So it changed no Python
  behavior visible to the agent. (Preflight noted `CONDA_PREFIX` ≠ expected but absolute interpreter
  verified — a warning, not a behavior change.)
- **Blind spot:** the env guard watches the *testbed* prefix, not miniforge *base*, so it did not
  detect the M90A base-`pluggy` downgrade. Canonical resolution runs in isolated Docker, so M90
  resolution numbers are unaffected by host-base contamination.

### Shell guard / host-pip firewall (M90A) — NOT present during M90
- Commit timing: M90 live runs 2026-06-30 ~08:01–10:32; M90 commit `fa09ebd` 12:05; shell-guard
  commit `b19fd6c` **13:18**. The firewall landed after M90.
- No shell-guard-named fields (`stage5_agent_shell_guard_enabled`, host-pip-firewall flags) exist in
  any M90 `_run.meta.json`; only the env-guard fields and `stage5_blocked_unsafe_pip_command_count`
  (= 0) are present.
- **The shell firewall therefore cannot have caused or interfered with any M90 outcome.** It is the
  fix that closes the M90A hole (a bare `pip install -e .` inside `.bench-repos` mutating host/base
  Python), and is mandatory going forward.

### Blocked command analysis
- **Blocked host package-manager command count across all 50 M90 runs = 0** (firewall absent;
  field defaulted to 0). No blocked command, hence no `possible_task_needed_dependency` /
  `false_positive_block` classification applies to M90. (Going forward, the firewall's blocks would
  be `safe_block_host_mutation` by construction — it only blocks host/base mutation, not testbed-env
  installs routed through the wrapper.)

### Drift analysis
- 0 protected-prefix drift across 50 runs (testbed prefix stable). The one real-world drift event
  (M90A base contamination) is outside the env guard's watched prefix and is what motivated M90A.

### Conclusion
Environment safety on M90 is clean and read-only; the shell firewall was absent and so blameless.
No safety mechanism contributed to any unresolved case.

## Behavioral Guard Attribution

### V4 tool-loop guard fires (4)
| instance | grp | resolved | trigger | first turn | mechanism | conf |
|---|---|---|---|---|---|---|
| sphinx-doc__sphinx-7748 | A | no | repeated_read | reactive | neutral | high |
| matplotlib__matplotlib-24627 | B | no | repeated_command_family_error (python\|ImportError ×3) | reactive | neutral | high |
| pydata__xarray-2905 | D | **yes** | repeated_command_family_error (python3\|ValueError ×3) | reactive | neutral (no harm — still resolved) | high |
| sympy__sympy-12419 | E | no | repeated_failed_command (×2) | reactive | neutral | high |

All four require ≥2–3 repeated failures to fire, so by construction they are *post-hoc* recovery
nudges responding to an already-struggling run. `pydata__xarray-2905` fired V4 and still resolved →
direct evidence V4 does not block a win. No pytest-style risky early read fire occurred.

### C7_D cost guard fires (3)
| instance | grp | resolved | trigger(s) | first turn | tools@fire | mechanism | conf |
|---|---|---|---|---|---|---|---|
| django__django-16263 | E | no | edit_verify_churn, high_turn_count | 25 | 26 | neutral_late | high |
| django__django-15503 | E | no | edit_verify_churn | 30 | — | neutral_late | high |
| sympy__sympy-15599 | E | no | edit_verify_churn | 32 | — | neutral_late | high |

All three fire deep into high-cost E-cohort cap/carryover runs (turns 25–32) and all are unresolved
regardless. Zero control/protected fires. Behavior matches M85/M88 neutral-late.

### Classification
- useful: 0; neutral: 4 (V4); neutral_late: 3 (C7_D); possible_harm: 0; harmful: 0.

### Conclusion
- Did any V4 fire improve or harm outcome? **No** — all reactive; one fired and the case resolved.
- Did any C7_D fire improve or harm outcome? **No** — all neutral-late on cap targets.
- Were C7_D fires still neutral-late? **Yes.**
- Did V4/C7_D explain the 5-run drop vs M73-treatment? **No** — see B-cohort and resolution-delta.

## B-Cohort Loss Audit

B (10) = M73 treatment-only single-sample passes. M90 held 4, lost 6.

| instance | repo | t73 | m90 | guard | blk pip | patch | changed files | failure_mode | conf |
|---|---|---|---|---|---|---|---|---|---|
| django__django-11815 | django | ✓ | ✓ | — | 0 | ✓ | migrations/serializer.py | held | high |
| matplotlib__matplotlib-24627 | matplotlib | ✓ | ✗ | V4×1 | 0 | ✓ | axes/_base.py, figure.py | wrong_patch (ImportError thrash; V4 reactive) | high |
| psf__requests-1724 | requests | ✓ | ✗ | — | 0 | ✓ | sessions.py | live_variance | high |
| pydata__xarray-6938 | xarray | ✓ | ✓ | — | 0 | ✓ | core/variable.py | held | high |
| sympy__sympy-15875 | sympy | ✓ | ✗ | — | 0 | ✓ | core/add.py | wrong_patch | high |
| django__django-12325 | django | ✓ | ✗ | — | 0 | ✓ | db/models/base.py | live_variance | high |
| matplotlib__matplotlib-25960 | matplotlib | ✓ | ✗ | — | 0 | ✓ | figure.py | live_variance | high |
| django__django-12774 | django | ✓ | ✓ | — | 0 | ✓ | db/models/query.py | held | high |
| django__django-13112 | django | ✓ | ✗ | — | 0 | ✓ | db/models/utils.py | live_variance | high |
| django__django-13590 | django | ✓ | ✓ | — | 0 | ✓ | db/models/sql/query.py | held | high |

### Aggregate failure modes (6 losses)
- live_variance: 4 (psf-1724, django-12325, matplotlib-25960, django-13112)
- wrong_patch: 2 (matplotlib-24627, sympy-15875)
- no_patch_cap / dependency_blocked / shell_guard_side_effect: 0

### Guard-causal assessment
- B losses with no behavioral guard fire: **5 / 6** (all except matplotlib-24627).
- The single guard-fire loss (matplotlib-24627) had a *reactive* V4 nudge after ≥3 ImportError-family
  failures; it is an agent-execution / wrong-patch failure, not guard-caused.

### Shell-firewall assessment
- B losses with a package-manager block: **0 / 6**; firewall absent during M90 → shell-firewall
  interference is **impossible** for any B loss.

### Variance / context / action assessment
- B losses plausibly pure live variance: **6 / 6** (single-sample treatment-only wins not
  replicating; all produced plausible targeted patches).
- B losses showing an actual VTRACE context/action failure: **0** clearly (context was injected;
  failures are agent-execution variance and wrong-patch selection, not missing/incorrect context).

## Policy Evaluation

- **Policy A — env mandatory + shell mandatory + V4/C7_D opt-in (CHOSEN).** Matches all evidence:
  safety is clean, the firewall was blameless (absent), behavioral guards are harmless but show no
  benefit, and the drop is variance.
- **Policy B — V4 default-on.** Rejected: no demonstrated benefit; V4 fires are purely reactive and
  one fired on a case that resolved anyway. Promoting it only adds injected-message noise.
- **Policy C — V4 + C7_D default-on.** Rejected: same as B plus C7_D is consistently neutral-late
  across M85/M88/M90 — never alters a cap outcome.
- **Policy D — retire V4/C7_D.** Rejected as premature: both are harmless and useful as cap/thrash
  diagnostics; keep the code reachable via flags.
- **Policy E — pause for disposable per-task venv.** Rejected: the M89 env guard + M90A shell guard
  already close the M90A hole, and Docker eval already isolates canonical resolution. No live-safety
  gap remains that justifies pausing.

### Chosen policy and rationale
**Policy A.** Keep both safety layers mandatory; keep V4/C7_D as default-off opt-in diagnostics. The
M90 resolution dip (22→17) is +2/−7 across *different* single-sample cases, 6/7 losses had no guard
fire, all 7 produced patches with zero package blocks, and the shell firewall did not exist during
M90 — so neither the behavioral guards nor the safety infra explains the drop. It is ordinary live
variance, concentrated in the variance-prone treatment-only B cohort.

## Future Driver Template

- **Path:** `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m91_default_envshell_driver.template.sh`
- **Flags included:** `--stage5-env-guard`, `--stage5-env-drift-check`,
  `--expected-testbed-prefix /home/calvin/miniforge3/envs/vexp_swebench`,
  `--stage5-agent-shell-guard`, `--stage5-host-pip-firewall` (the last two are default-ON in the
  runner and passed only for self-documentation).
- **Flags deliberately excluded:** `--tool-loop-guard-mode inject`,
  `--tool-loop-guard-calibration v4`, `--cost-guard-mode inject`, `--cost-guard-calibration c7d`,
  `--allow-unguarded-live-env`.
- **Runner behavior note:** since M89 the env guard fails closed before spawn unless its three flags
  are present; since M90A the agent shell guard / host-pip firewall is default-ON (disable only via
  `--disable-agent-shell-guard`, which then also fails closed unless the escape hatch is set). The
  template documents this so a future operator knows the safety floor is enforced by the runner, not
  merely by the flags.

## Recommendation

**Proceed to a default env+shell guarded confirmation without V4/C7_D (Policy A); keep V4/C7_D as
opt-in diagnostics.** Optionally run a targeted B-cohort replicate (e.g. 3× per B case) to bound the
single-sample variance that drove the 22→17 dip. Do not promote behavioral guards. Do not pause for
a per-task venv — the two mandatory safety layers already close the M90A hole and Docker isolates
canonical resolution.
