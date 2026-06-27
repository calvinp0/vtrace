# Stage 5 M86 Environment Isolation Guard

## Summary

- **Issue found.** The operator's conda **base** prefix (`/home/calvin/miniforge3`) is
  contaminated by SWE-bench dependency installs. `pluggy` is double-installed (conda
  metadata `0.13.1` + pip `1.6.0`, both `dist-info` dirs present); `pytest` is an **editable
  dev install** whose import is **broken** (`No module named '_pytest._version'`);
  `setuptools` pip/conda metadata disagree (`68.2.2` vs `82.0.1`).
- **Guard implemented?** Yes — a pure, fail-closed prefix guard + unsafe-pip detector + a
  read-only drift checker, wired into the Stage 5 runner behind an opt-in flag.
- **Default behavior.** Opt-in / **default-off**. With the guard disabled the runner emits a
  `not_applicable` metadata record and behaves exactly as before — **no behavior change**.
- **Prefixes audited.** base (`/home/calvin/miniforge3`), the clean `vexp_swebench` conda
  env, and the external harness `.venv`.
- **Current pluggy/pytest state.** base: pluggy mismatch + broken pytest editable install;
  `vexp_swebench` env: clean (pluggy 1.6.0, pytest 9.0.3, swebench 4.1.0).
- **Stage 5 integration.** `runCondition()` preflight that **fails closed before spawning
  the agent** unless the disposable testbed interpreter provably targets
  `--expected-testbed-prefix`; compact metadata merged into `_run.meta.json`.
- **Recommendation.** **First repair the conda base prefix manually** (instructions below),
  then keep Stage 5 live runs paused until base is clean and the driver scripts pass
  `--expected-testbed-prefix`.

## Environment Contamination Context

- **pluggy mismatch.** M85 reported conda metadata `pluggy 1.6.0` but on-disk files
  `0.13.1`. This audit observes the converse layout — both `pluggy-0.13.1.dist-info` (the
  conda record) **and** `pluggy-1.6.0.dist-info` (a later pip install) coexist in base, and
  the module imports as `1.6.0`. Same root cause in both framings: **pip and conda disagree
  about what is installed in the base prefix.**
- **Why dangerous for benchmark validity.** Historical SWE-bench testbed specs pin ancient
  `pytest`/`pluggy` versions. If those installs land in **base** or the **active dev** env
  (instead of a disposable testbed), then (a) benchmark resolution can be graded against the
  wrong interpreter, and (b) local development breaks — exactly what happened here: base
  `pytest` no longer imports.
- **Likely cause (high confidence).** A dependency install resolved to **bare `python` /
  `pip`** — i.e. the active conda env (base) — instead of a disposable testbed interpreter.
  The smoking gun: the base editable-pytest `.pth` points at
  `/home/calvin/code/vexp-swe-bench/.bench-repos/pytest-dev__pytest/src`, so a
  `pip install -e .` for the `pytest-dev__pytest` SWE-bench instance was executed against
  base. Both the external harness `findPython()` and the VTRACE verifier
  `resolveVerifierPythonCommand()` fall back to bare `python` when no `.venv` exists — that
  fallback is the contamination vector.
- **Confidence level.** High for the mechanism and the affected prefix; the exact historical
  command is inferred from the residual editable `.pth` + mtimes (2026-06-27).

## Implementation

All new code is Stage 5 plumbing under `benchmarks/stage5_vexp_swe_bench_smoke/`; it touches
**no** retrieval, scoring, ranking, candidate generation, Capsule v2, or the V4/C7_D guards.

### Prefix guard (`envIsolationGuard.ts`, pure)

`evaluatePrefixGuard(probe, config, command?)` runs fail-closed checks (all must pass):

1. an expected testbed prefix is configured at all (missing ⇒ fail closed);
2. the interpreter (`sys.executable`) lives under the expected prefix;
3. `sys.prefix` equals the expected prefix;
4. `python -m pip -V` reports the expected prefix;
5. `CONDA_PREFIX`, if set, equals the expected prefix — or is tolerated **only** when the
   interpreter is an absolute path verified under the expected prefix (reported as a
   warning), and is fatal under `requireCondaPrefixMatch`;
6. the expected prefix is **not** a protected conda base prefix;
7. the expected prefix is **not** the active VTRACE/dev prefix, and does **not** look like a
   home/miniforge/miniconda base distribution.

Backstops also reject the case where the **actual** `sys.prefix` is a protected base/dev
prefix (the literal contamination case), even if `expected` was mis-set.

### Unsafe pip detection (`classifyInstallCommand`)

- Rejected: bare `pip install`, non-absolute `python -m pip install`, `conda activate … &&
  pip install`, `conda install/remove` without `-p`/`-n`.
- Accepted FORMS (still prefix-verified): `<abs>/bin/python -m pip …`, `conda run -p
  <prefix> python -m pip …`.

### Post-run drift check (`classifyPackageDrift` / `summarizePrefixDrift`, pure)

Read-only before/after snapshots of the tracked packages (`pluggy`, `pytest`, `pip`,
`setuptools`, `wheel`) per protected prefix. Per-package status is one of `ok`,
`pip_conda_mismatch`, `changed_during_run`, `missing`, `unknown`. A change to a **base/dev**
prefix during a run sets `safetyFailed` (the run is marked safety-failed).

### Metadata (`buildEnvGuardMetadata`)

Emits the compact fixed key set: `stage5_env_guard_enabled`,
`stage5_expected_testbed_prefix`, `stage5_python_prefix_verified`,
`stage5_pip_prefix_verified`, `stage5_blocked_unsafe_pip_command_count`,
`stage5_dependency_install_commands_checked`, `stage5_prefix_guard_failures`,
`stage5_drift_check_enabled`, `stage5_prefix_drift_summary`, and
`stage5_env_guard_status` (`pass` | `fail` | `not_applicable` | `unknown`). No env dumps.

### CLI / config

`--stage5-env-guard`, `--stage5-env-drift-check`, `--expected-testbed-prefix <path>`
(all default-off / null).

### Fail-closed behavior

When `--stage5-env-guard` is set, `runCondition()` probes the testbed interpreter the run
depends on and **throws before spawning the agent** if the prefix cannot be proven (missing
prefix, interpreter not found/unprobeable, or any guard check fails). When the flag is off,
the preflight returns `ok` with `not_applicable` metadata and the run proceeds unchanged.

## Read-only Audit Result

(Full data: `stage5_m86_env_audit.json`.)

- **Current shell prefix.** `CONDA_PREFIX=/home/calvin/miniforge3`, `VIRTUAL_ENV` unset,
  active env = `base`.
- **python/pip prefix.** `python` → `/home/calvin/miniforge3/bin/python` (3.12.12);
  `pip 25.3` from the same base prefix. Bare `python`/`pip` resolve to **base**.
- **pluggy state (base).** conda `0.13.1` vs pip/imported `1.6.0` ⇒ `pip_conda_mismatch`;
  both dist-info dirs present.
- **pytest state (base).** editable install `0.1.dev1+ge856638ba.d20260627`; **import
  broken** (`_pytest._version` missing); `.pth` → `…/.bench-repos/pytest-dev__pytest/src`.
- **setuptools (base).** conda `68.2.2` vs pip `82.0.1` ⇒ `pip_conda_mismatch`.
- **vexp_swebench env.** clean: pluggy `1.6.0`, pytest `9.0.3`, swebench `4.1.0`, all
  pip/conda-consistent. A viable disposable/runner testbed candidate.
- **Mismatch?** Yes, in **base** only (`pluggy`, `setuptools`, `pytest`).

### Repair instructions

See **Manual repair instructions** below — not executed automatically.

## Stage 5 Safety

- **Where the guard is wired.** `runCondition()` preflight in
  `run_stage5_vexp_swe_bench_smoke.ts` (before the agent spawn); metadata merged into
  `_run.meta.json`. Also constructed safely in `run_stage5_live_capsule_precheck.ts`.
- **Are dependency installs now protected?** The VTRACE runner itself performs **zero**
  dependency installs (verified: no `pip install` / `python -m pip` / `conda install` /
  `conda activate` / `pytest` anywhere in the TS runners or driver shell scripts). The guard
  protects the only VTRACE-controlled lever: it refuses to spawn the agent when the testbed
  interpreter the run would depend on is not provably the expected prefix.
- **Remaining unguarded paths.** The **external** `vexp-swe-bench` install path
  (`setup.sh`, and `findPython()` falling back to bare `python3`) is outside VTRACE. The
  guard blocks the run when the resolved interpreter is wrong, but cannot rewrite the
  external harness's internal pip calls.
- **External assumptions.** Run the external harness with `vexp-swe-bench/.venv` present (so
  `findPython()` never falls back to bare `python3`), and run SWE-bench evaluation in
  **docker** mode (containerized installs) — not lightweight mode against the host.

## Tests

Added/updated (mocks + synthetic command outputs only — **no real environment is mutated**):

- `envIsolationGuard.test.ts` — 31 tests: safe abs `-m pip` passes; bare pip rejected; wrong
  `sys.prefix` rejected; conda base rejected as target; dev prefix rejected as target;
  missing expected prefix fails closed; `pip -V` mismatch fails closed; `CONDA_PREFIX`
  mismatch reported; drift detects pip/conda mismatch, changed mtime, and reports `ok` for
  stable records; metadata pass/fail status; compact-metadata-no-dump.
- `stage5EnvGuardIntegration.test.ts` — 8 tests: default path unchanged when disabled;
  clean testbed passes; base interpreter rejected; missing/unfound prefix fails closed;
  unsafe vs safe candidate command accounting.
- `run_stage5_vexp_swe_bench_smoke.test.ts` — added an M86 flag-parse case (flags default
  off; opt-in flips them; `--expected-testbed-prefix` captures its value).

**Verification:** `bun run typecheck` ✓ · `bun run typecheck:benchmarks` ✓ ·
`bun test` (full suite) ✓ · `git diff --check` ✓.

## Recommendation

**First repair the conda base/dev prefix manually**, then keep Stage 5 live runs paused
until base is clean and the driver scripts (`run_stage5_m*_driver.sh`) pass
`--expected-testbed-prefix` (and `--stage5-env-guard`). The guard, drift check, and audit
are in place and default-off; promoting them to a larger guarded validation (M87) should
follow the base repair, not precede it.

## Manual repair instructions (DO NOT auto-run)

The contamination is in the **base** `/home/calvin/miniforge3` prefix. Repair from a shell
the operator controls (these are mutating commands and were intentionally **not** executed
by this milestone):

```bash
# 1. Remove the stray editable pytest install that landed in base.
/home/calvin/miniforge3/bin/python -m pip uninstall -y pytest
rm -f /home/calvin/miniforge3/lib/python3.12/site-packages/__editable__.pytest-*.pth

# 2. Resolve the pluggy double-install (drop the pip 1.6.0 over the conda 0.13.1 record,
#    or reconcile to a single version). Inspect first:
/home/calvin/miniforge3/bin/python -m pip show pluggy
ls -d /home/calvin/miniforge3/lib/python3.12/site-packages/pluggy-*.dist-info
#    Then reconcile via conda so metadata and files agree, e.g.:
conda install -n base --force-reinstall pluggy

# 3. Reconcile setuptools (conda 68.2.2 vs pip 82.0.1):
conda install -n base --force-reinstall setuptools

# 4. Verify base is consistent again:
/home/calvin/miniforge3/bin/python - <<'PY'
import pluggy
print("pluggy", pluggy.__version__, pluggy.__file__)
try:
    import pytest; print("pytest", pytest.__version__)
except Exception as e:
    print("pytest import:", e)
PY
conda list -n base | grep -E '^(pluggy|pytest|setuptools)\s'
```

For future SWE-bench work, run dependency installs **only** through a disposable testbed
interpreter (`<testbed>/bin/python -m pip …` or `conda run -p <testbed> …`) — never bare
`pip`/`python` — and keep `vexp-swe-bench/.venv` present so the harness never falls back to
the base interpreter.
