# Stage 5 M87 Environment Guard Post-Repair Readiness

## Summary

- **Base repair verified?** **NO.** The operator's conda **base** prefix
  (`/home/calvin/miniforge3`) is **still contaminated**, byte-for-byte unchanged from M86
  (identical package versions and `__init__.py` mtimes): `pluggy` conda `0.13.1` vs
  imported/pip `1.6.0` (`pip_conda_mismatch`), `setuptools` conda `68.2.2` vs pip `82.0.1`
  (`pip_conda_mismatch`), and `pytest` editable install whose **import is broken**
  (`importedVersion=null`, `_pytest._version` missing). The required manual base repair has
  **not** been performed.
- **Prefixes audited.** base (`/home/calvin/miniforge3`), the intended testbed
  `vexp_swebench` env (`/home/calvin/miniforge3/envs/vexp_swebench`), and the external harness
  `.venv` (`/home/calvin/code/vexp-swe-bench/.venv`).
- **Guard negative tests.** 9/9 unsafe cases **rejected** (all bare/activation install forms,
  base/dev prefixes as install targets, missing-prefix / pip-mismatch / contamination
  fail-closed).
- **Expected-prefix positive path.** **PASS** — the clean `vexp_swebench` prefix passes the
  read-only, no-agent Stage 5 env-guard preflight (`stage5_env_guard_status=pass`,
  `python_prefix_verified=true`, `pip_prefix_verified=true`).
- **Drift checker status.** All 5 synthetic cases pass (stable→ok, mtime change→
  `changed_during_run` + base safety-fail, conda/pip split→`pip_conda_mismatch`, broken
  import→detected).
- **Stage 5 future-command readiness.** The runner accepts `--stage5-env-guard`,
  `--stage5-env-drift-check`, `--expected-testbed-prefix`; future live drivers must add them
  (the current M85 driver template does not). The exact required snippet is in
  **Stage 5 Readiness** below.
- **Recommendation.** **Repair base/dev prefix manually before live work; keep Stage 5 live
  runs paused.** The guard *mechanics* are ready and proven; the *environment* is not.

The M87 question — *"Can Stage 5 prove it will use the intended clean
testbed/`vexp_swebench` prefix and fail closed before any wrong-prefix execution?"* — is
answered **YES for the guard** (it passes the clean prefix and fails closed on every unsafe
path), but the host **base** prefix remains unsafe, so live runs stay paused until it is
repaired.

## M86 Recap

- **Contamination found.** A SWE-bench dependency install (an editable `pip install -e .` of
  the `pytest-dev__pytest` checkout) hit the operator's conda **base** prefix instead of a
  disposable testbed: broken `pytest` import, double-installed `pluggy`
  (conda `0.13.1` + pip `1.6.0`), `setuptools` conda/pip split.
- **Likely cause.** A dependency install resolved to **bare `python`/`pip`** (→ the active
  conda env = base) because both the external harness `findPython()` and the VTRACE verifier
  `resolveVerifierPythonCommand()` fall back to bare `python` when no `.venv` exists.
- **Guard implemented.** A PURE, fail-closed prefix guard (`envIsolationGuard.ts`), an
  unsafe-pip detector (`classifyInstallCommand`), a read-only drift checker
  (`classifyPackageDrift`/`summarizePrefixDrift`), a read-only probe (`envIsolationProbe.ts`),
  and Stage 5 integration (`stage5EnvGuardIntegration.ts`) wired into `runCondition()` behind
  opt-in flags `--stage5-env-guard` / `--stage5-env-drift-check` / `--expected-testbed-prefix`
  (all default-off ⇒ `not_applicable` metadata, no behavior change).

## Read-only Environment Audit

Source: `runEnvAudit` (read-only: `python -c`, `python -m pip -V/show`, `conda list`;
mutates nothing). Full data in `stage5_m87_env_audit.json`.

| Prefix (role) | python | sys.prefix | pip prefix | pluggy | pytest | setuptools | status |
|---|---|---|---|---|---|---|---|
| `/home/calvin/miniforge3` (base) | base/bin/python | base | base | conda 0.13.1 / pip 1.6.0 | editable, **import broken** | conda 68.2.2 / pip 82.0.1 | **pip_conda_mismatch ×2 + import_broken** |
| `…/envs/vexp_swebench` (testbed) | env/bin/python | env | env | 1.6.0 ✓ | 9.0.3 ✓ | 69.5.1 ✓ | **clean (ok)** |
| `…/vexp-swe-bench/.venv` (testbed) | .venv/bin/python | .venv | .venv | missing | missing | pip 82.0.1 ✓ | ok / pytest+pluggy absent |

- **pluggy/pytest state (base).** `pluggy` split-brain (conda metadata `0.13.1`, on-disk/pip
  `1.6.0`); `pytest` editable `0.1.dev1+ge856638ba.d20260627` **does not import**
  (`importedVersion=null`). **Unchanged from M86** — same versions, same mtimes
  (e.g. `pluggy importedMtimeMs=1764896838000`).
- **`vexp_swebench` env.** Clean and pip/conda-consistent across all tracked packages
  (`pluggy 1.6.0`, `pytest 9.0.3`, `pip 26.1.2`, `setuptools 69.5.1`, `wheel 0.47.0`) — the
  viable clean expected testbed prefix.
- **`.venv`.** `pytest`/`pluggy`/`wheel` absent (the external harness installs them per-run);
  no mismatch. Keeping `.venv` present is what stops the harness falling back to bare base
  `python`.
- **Remaining mismatches.** base only: `pluggy`, `setuptools` (`pip_conda_mismatch`) +
  `pytest` (`import_broken`). No protected prefix shows `changed_during_run` (this audit is
  read-only and mutated nothing).

## Prefix Guard Verification

Pure / synthetic — nothing is executed. 9/9 unsafe cases rejected (`negativeTests.allRejected
= true`):

| Case | Rejected | Why |
|---|---|---|
| bare `pip install …` | ✓ | bare `pip` resolves via PATH — interpreter/prefix not provable |
| bare `python -m pip install …` | ✓ | non-absolute interpreter resolves via PATH |
| `conda activate … && pip install …` | ✓ | activation-then-install target not provable |
| `conda install …` (no `-p`/`-n`) | ✓ | targets the active env |
| base prefix as install **target** | ✓ | `expected_not_home_base` / `expected_not_protected_base` fail |
| active dev prefix as install **target** | ✓ | `expected_not_dev` fails |
| missing `--expected-testbed-prefix` | ✓ | `expected_prefix_configured` fails closed |
| `pip -V` prefix mismatch | ✓ | `pip_prefix_matches` fails |
| actual `sys.prefix==base` (literal contamination) | ✓ | `actual_prefix_not_protected_base` backstop fails |

**Expected-prefix pass (positive path).** `runStage5EnvGuardPreflight` against
`/home/calvin/miniforge3/envs/vexp_swebench` (read-only; **no agent, no Docker**):

```
resolved interpreter: /home/calvin/miniforge3/envs/vexp_swebench/bin/python
stage5_env_guard_enabled        = true
stage5_expected_testbed_prefix  = /home/calvin/miniforge3/envs/vexp_swebench
stage5_python_prefix_verified   = true
stage5_pip_prefix_verified      = true
stage5_drift_check_enabled      = true
stage5_env_guard_status         = pass
warning: CONDA_PREFIX=/home/calvin/miniforge3 differs from expected but absolute interpreter is verified
```

The `CONDA_PREFIX` warning is the M86-designed tolerance: the shell is in `base`, but because
the resolved interpreter is an **absolute** path verified under the expected prefix
(`sys.prefix == expected`, `pip -V` prefix == expected), the guard passes and merely warns.

## Drift Checker Verification

- **Real protected-prefix status (read-only audit).** No `changed_during_run` on any prefix;
  base shows the standing `pip_conda_mismatch ×2` + `import_broken ×1`; `vexp_swebench` all
  `ok`. This audit observes only — it installs/mutates nothing.
- **Synthetic drift/mismatch checks** (`driftSimulation.allPass = true`):
  - stable before==after on a base package → `overallStatus=ok`, no safety failure;
  - synthetic `importedMtimeMs` change on a base package → `changed_during_run`
    **and** `safetyFailed=true` (base/dev change is a safety failure);
  - synthetic `pluggy` conda `0.13.1` vs pip `1.6.0` → `pip_conda_mismatch`;
  - synthetic broken `pytest` import (metadata present, `importedVersion=null`) → detected by
    the audit-layer `brokenImport` rule (the same signal that flags base `pytest` today).

## Stage 5 Readiness

- **Required flags for future live validation** (the runner already parses all three):

  ```bash
  --stage5-env-guard \
  --stage5-env-drift-check \
  --expected-testbed-prefix /home/calvin/miniforge3/envs/vexp_swebench
  ```

  With `--stage5-env-guard`, `runCondition()` probes the testbed interpreter and **throws
  before spawning the agent** unless `sys.prefix`/`pip -V`/interpreter all provably equal the
  expected prefix (never base/dev). Off (today's default) ⇒ `not_applicable` metadata, no
  behavior change.

- **Remaining unguarded paths.** The current live-driver template
  (`run_stage5_m85_driver.sh`'s `run_treatment`) does **not** yet pass the env-guard flags;
  any future (M88+) driver MUST add the three flags above to its `bun "$RUNNER" …`
  invocation. No historical driver (M71–M85) was retroactively edited — they describe
  completed runs. The guard protects the only VTRACE-controlled lever (refusing to spawn the
  agent on a wrong prefix); it cannot rewrite the **external** harness's internal pip calls.

- **External harness assumptions.** Run the external `vexp-swe-bench` with its `.venv`
  present (so `findPython()` never falls back to bare base `python`), and run SWE-bench
  evaluation in **docker** mode (containerized installs) — not lightweight mode against the
  host. These assumptions sit outside VTRACE and are not enforced by the guard.

## Recommendation

**Repair base/dev prefix manually before live work; keep Stage 5 live runs paused.**

The guard mechanics are verified ready (negatives reject, the clean `vexp_swebench` prefix
passes, drift detection works), but the host **base** prefix is still contaminated exactly as
M86 found it. Do **not** proceed to M88 larger guarded validation until base is repaired and a
re-run of this readiness driver reports `baseRepairVerified=true`. Manual repair steps are in
`stage5_m86_env_isolation_guard.md` (§ *Manual repair instructions*); after repair, re-run:

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m87_env_guard_readiness.ts
```

and confirm `findings.baseRepairVerified=true` before enabling any live driver.
