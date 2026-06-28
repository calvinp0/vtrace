# Stage 5 M87B Environment Guard Repair Verification

## Summary

- **Base repair verified?** **YES — `baseRepairVerified=true`.** The operator's conda **base**
  prefix (`/home/calvin/miniforge3`) is now clean: every tracked package agrees across conda
  metadata, pip metadata, and the imported module, with **no** `pip_conda_mismatch` and **no**
  broken imports. The two M86/M87 mismatches are resolved (`pluggy` conda==pip==imported
  `1.6.0`; `setuptools` `82.0.1` consistent) and the broken editable `pytest` is gone —
  base `pytest` now imports cleanly as `9.1.1`.
- **Prefixes audited.** base (`/home/calvin/miniforge3`), the intended testbed `vexp_swebench`
  env (`/home/calvin/miniforge3/envs/vexp_swebench`), and the external harness `.venv`
  (`/home/calvin/code/vexp-swe-bench/.venv`).
- **pluggy/pytest state.** base: `pluggy 1.6.0` (consistent, no split-brain), `pytest 9.1.1`
  (imports OK). testbed `vexp_swebench`: `pluggy 1.6.0`, `pytest 9.0.3`, all consistent.
- **Guard negative tests.** 9/9 unsafe cases **rejected** (bare/activation install forms,
  base/dev prefixes as install targets, missing-prefix / pip-mismatch / contamination
  fail-closed).
- **Expected-prefix positive path.** **PASS** — the clean `vexp_swebench` prefix passes the
  read-only, no-agent Stage 5 env-guard preflight (`stage5_env_guard_status=pass`,
  `python_prefix_verified=true`, `pip_prefix_verified=true`, `stage5_prefix_drift_summary`
  present).
- **Drift checker status.** All 5 synthetic cases pass (stable→ok, base mtime change→
  `changed_during_run` + safety-fail, conda/pip split→`pip_conda_mismatch`, broken import→
  detected). The real read-only audit shows **no** `changed_during_run` on any protected prefix.
- **Stage 5 future-command readiness.** The runner accepts `--stage5-env-guard`,
  `--stage5-env-drift-check`, `--expected-testbed-prefix`. A ready future template
  (`run_stage5_m88_driver.template.sh`) wires all three into the live-treatment invocation
  (the historical M85 driver did not, and was not edited).
- **Recommendation.** **Proceed to M88 larger guarded validation** with the env-guard flags
  enabled. Base is repaired, the clean prefix passes, the guard fails closed on every unsafe
  path. (Live runs themselves remain out of scope for M87B — verification only.)

The M87B question — *"Does M87B now report `baseRepairVerified=true` and
`stage5_env_guard_status=pass` with the clean `vexp_swebench` prefix?"* — is answered **YES on
both counts**.

## M86/M87 Recap

- **Contamination found (M86).** A SWE-bench dependency install (an editable `pip install -e .`
  of the `pytest-dev__pytest` checkout) hit the operator's conda **base** prefix instead of a
  disposable testbed: broken `pytest` import (`_pytest._version` missing), double-installed
  `pluggy` (conda `0.13.1` + pip `1.6.0`), `setuptools` conda/pip split (`68.2.2` vs `82.0.1`).
  Root cause: an install resolved to **bare `python`/`pip`** (→ active env = base) because both
  the external harness `findPython()` and the VTRACE verifier `resolveVerifierPythonCommand()`
  fall back to bare `python` when no `.venv` exists.
- **M87 stopped live readiness.** The guard mechanics were verified (negatives reject, the clean
  `vexp_swebench` prefix passes, drift detection works), but the host **base** prefix was still
  contaminated byte-for-byte unchanged from M86, so M87 reported `baseRepairVerified=false` and
  kept live runs paused, recommending manual base repair first.
- **Manual repair now verified (M87B).** The operator has manually repaired base. This read-only
  re-run of the same verification confirms base is clean (`baseRepairVerified=true`): the two
  mismatches and the broken `pytest` import are all gone.

## Read-only Environment Audit

Source: `runEnvAudit` (read-only: `python -c`, `python -m pip -V/show`, `conda list`; mutates
nothing). Full data in `stage5_m87b_env_audit.json`. Shell: `CONDA_PREFIX=/home/calvin/miniforge3`
(`base`), `VIRTUAL_ENV` unset.

| Prefix (role) | python | sys.prefix | pip prefix | pluggy | pytest | setuptools | status |
|---|---|---|---|---|---|---|---|
| `/home/calvin/miniforge3` (base) | base/bin/python | base | base | 1.6.0 ✓ | 9.1.1 ✓ (imports) | 82.0.1 ✓ | **clean (ok)** |
| `…/envs/vexp_swebench` (testbed) | env/bin/python | env | env | 1.6.0 ✓ | 9.0.3 ✓ | 69.5.1 ✓ | **clean (ok)** |
| `…/vexp-swe-bench/.venv` (testbed) | .venv/bin/python | .venv | .venv | missing | missing | pip 82.0.1 ✓ | ok / pytest+pluggy absent |

- **base pluggy/pytest state.** `pluggy` consistent at `1.6.0` across conda/pip/imported — **no
  split-brain**. `pytest 9.1.1` conda==pip==imported and **imports cleanly** (the M86/M87 broken
  editable install is gone). `pip 26.1.2` and `wheel 0.47.0` also consistent.
- **`vexp_swebench` env.** Remains clean and pip/conda-consistent across all tracked packages
  (`pluggy 1.6.0`, `pytest 9.0.3`, `pip 26.1.2`, `setuptools 69.5.1`, `wheel 0.47.0`) — the
  viable clean expected testbed prefix.
- **`.venv`.** `pytest`/`pluggy`/`wheel` absent (the external harness installs them per-run);
  `pip`/`setuptools` consistent, no mismatch. Acceptable. Keeping `.venv` present is what stops
  the harness falling back to bare base `python`.
- **Remaining mismatches.** **None.** No prefix shows `pip_conda_mismatch`, `import_broken`, or
  `changed_during_run` (the audit is read-only and mutated nothing).

## Prefix Guard Verification

Pure / synthetic — nothing is executed. 9/9 unsafe cases rejected (`negativeTests.allRejected =
true`):

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
stage5_prefix_drift_summary     = present
stage5_env_guard_status         = pass
warning: CONDA_PREFIX=/home/calvin/miniforge3 differs from expected but absolute interpreter is verified
```

The `CONDA_PREFIX` warning is the M86-designed tolerance: the shell is in `base`, but because
the resolved interpreter is an **absolute** path verified under the expected prefix
(`sys.prefix == expected`, `pip -V` prefix == expected), the guard passes and merely warns.

## Drift Checker Verification

- **Real protected-prefix status (read-only audit).** No `changed_during_run` on any prefix;
  base is now all `ok` (no standing mismatch); `vexp_swebench` all `ok`. This audit observes
  only — it installs/mutates nothing.
- **Synthetic drift/mismatch checks** (`driftSimulation.allPass = true`):
  - stable before==after on a base package → `overallStatus=ok`, no safety failure;
  - synthetic `importedMtimeMs` change on a base package → `changed_during_run` **and**
    `safetyFailed=true` (base/dev change is a safety failure);
  - synthetic `pluggy` conda `0.13.1` vs pip `1.6.0` → `pip_conda_mismatch`;
  - synthetic broken `pytest` import (metadata present, `importedVersion=null`) → detected by
    the audit-layer `brokenImport` rule (the same signal that flagged base `pytest` in M86/M87,
    now clear).

## Stage 5 Readiness

- **Required flags for M88 live validation** (the runner already parses all three):

  ```bash
  --stage5-env-guard \
  --stage5-env-drift-check \
  --expected-testbed-prefix /home/calvin/miniforge3/envs/vexp_swebench
  ```

  With `--stage5-env-guard`, `runCondition()` probes the testbed interpreter and **throws
  before spawning the agent** unless `sys.prefix`/`pip -V`/interpreter all provably equal the
  expected prefix (never base/dev). Off (today's default) ⇒ `not_applicable` metadata, no
  behavior change.

- **Future driver readiness.** A ready future template,
  `run_stage5_m88_driver.template.sh`, mirrors the M85 live driver and wires the three flags
  into `run_treatment` (the `# >>> M86 env guard` block). The historical M71–M85 drivers were
  **not** edited — they describe completed runs. The template is provided for M88 and must not
  be run without explicit approval (it spawns real agents).

- **Remaining unguarded paths.** The guard protects the only VTRACE-controlled lever (refusing
  to spawn the agent on a wrong prefix); it cannot rewrite the **external** harness's internal
  pip calls. Run the external `vexp-swe-bench` with its `.venv` present (so `findPython()` never
  falls back to bare base `python`), and run SWE-bench evaluation in **docker** mode
  (containerized installs) — not lightweight mode against the host. These assumptions sit outside
  VTRACE and are not enforced by the guard.

## Recommendation

**Proceed to M88 larger guarded validation** (with the env-guard flags enabled per the template).

Base is repaired and verified clean (`baseRepairVerified=true`), the clean `vexp_swebench`
prefix passes the prefix guard (`stage5_env_guard_status=pass`), the guard fails closed on every
unsafe path, and the drift checker works. The environment is now safe for guarded live work —
M87B itself performs **no** live runs (verification only). When M88 is approved, launch it via
`run_stage5_m88_driver.template.sh` (or any driver that passes the three env-guard flags) so the
run fails closed before the agent spawn on any wrong prefix.
