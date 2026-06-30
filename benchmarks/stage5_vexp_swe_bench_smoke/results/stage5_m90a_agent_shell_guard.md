# Stage 5 M90A Agent Shell Guard

## Summary
- **Recurrence root cause**: a spawned SWE-bench agent ran `pip install -e .` inside
  `/home/calvin/code/vexp-swe-bench/.bench-repos/pytest-dev__pytest`. That ancient pytest
  checkout pins `pluggy >=0.12,<1.0`; the bare `pip` resolved via PATH to the Miniforge **base**
  interpreter, so the editable install downgraded base `pluggy` to 0.13.1 and broke Conda.
- **Why M89 was insufficient**: M89 fails closed *in the runner, before spawn*. It cannot see a
  mutation that happens *inside the agent's tool shell, after spawn*, via a PATH-resolved `pip`.
- **Agent shell guard implemented?** Yes — every live agent run now inherits a guarded shell.
- **Host pip firewall implemented?** Yes — a per-run wrapper bin shadows `pip`/`python`/`conda`/
  `uv`/`poetry`/`pipx` and blocks host package mutation before it runs.
- **Default live-run behavior**: MANDATORY and ON by default. A live run fails closed before
  spawn unless the shell guard materialized (alongside the still-mandatory M89 env guard). The
  only unguarded path is the loud `--allow-unguarded-live-env` escape hatch, which is **never
  benchmark-valid**.
- **Smoke result**: PASS — all 7 dangerous commands blocked (exit 97) in the real pytest danger
  cwd; harmless `python` works; `which pip`/`which python` resolve to the VTRACE wrapper.
- **Recommendation**: **proceed to M90 50-task confirmation with the shell guard** (env guard +
  shell guard + drift check). No base repair needed — the firewall blocks before mutation, so
  nothing was installed during the smoke.

## Recurrence Analysis
- `pip install -e .` in `pytest-dev__pytest`: the editable install of that pinned checkout
  resolved its dependencies against whatever interpreter `pip` mapped to on PATH.
- **pluggy downgrade mechanism**: the checkout requires `pluggy >=0.12,<1.0`, so resolving the
  editable install pulled `pluggy==0.13.1` into the prefix `pip` targeted.
- **Why Conda broke**: that prefix was the Miniforge **base** (the first PATH entry was
  `/home/calvin/miniforge3/bin`), and Conda itself depends on a modern `pluggy`; the downgrade
  left base inconsistent.
- **Why pre-spawn env guard did not catch it**: M89 vets the interpreter the *runner* would use
  before spawning the agent. The contaminating command was issued by the *agent* from its own
  inherited shell, where `pip` still resolved to base via PATH — a surface M89 never touches.

## Implementation
- **PATH sanitization** (`sanitizeAgentPath`): every Conda/Miniforge/Anaconda/mambaforge PATH
  entry (base bin, condabin, *and* env bins) is removed and the per-run wrapper bin is placed
  first. So a bare `pip`/`python`/`conda` can only resolve to a VTRACE wrapper or a non-conda
  system tool — never host/base pip.
- **Wrapper bin** (`_vtrace_agent_bin/` under the run dir): executable firewall scripts for
  `pip`, `pip3`, `pip3.12`, `python`, `python3`, `python3.12`, `conda`, `uv`, `poetry`, `pipx`.
- **Blocked commands** (fail-closed allowlists):
  - `pip*`: only read-only verbs (`--version`, `-V`, `list`, `show`, `freeze`, `check`,
    `inspect`, `debug`, `help`) are delegated to `<testbed-python> -m pip`; everything else
    (`install`/`uninstall`/`download`/`wheel`/editable/…) is blocked → `VTRACE_HOST_PIP_BLOCKED`.
  - `python*`: `-m pip`, `-mpip`, `-m ensurepip`, `-m virtualenv`, and `get-pip.py` are blocked →
    `VTRACE_HOST_PIP_BLOCKED`; all other invocations delegate to the resolved interpreter.
  - `conda`: only `info`/`list`/`--version`/`help` allowed; `install`/`update`/`remove`/
    `create`/`env` blocked → `VTRACE_HOST_CONDA_BLOCKED`.
  - `uv`/`poetry`/`pipx`: only `--version`/`version`/`help` allowed; any dependency mutation
    (`uv pip install`, `poetry add`, `pipx install`, …) blocked → `VTRACE_HOST_PACKAGE_MANAGER_BLOCKED`.
- **Env-var scrubbing** (`scrubAgentCondaEnv`): `CONDA_PREFIX`, `CONDA_DEFAULT_ENV`,
  `CONDA_SHLVL`, `CONDA_PROMPT_MODIFIER`, `CONDA_EXE`, `CONDA_PYTHON_EXE`, `_CE_CONDA`, `_CE_M`,
  `VIRTUAL_ENV`, `PYTHONPATH`, `PYTHONHOME` neutralized; plus `PYTHONNOUSERSITE=1` and
  `PIP_REQUIRE_VIRTUALENV=true` (so any pip that somehow runs refuses a global prefix).
- **Pre-tool hook**: not added. The external harness's combined PostToolUse hook seam exists,
  but a *PreToolUse* regex blocker is evadable (whitespace/aliasing) and is not the robust layer.
  The PATH wrappers + env scrub are the mandatory, fail-closed defense; a regex hook would only
  be advisory. Documented here as a deliberate non-addition; the wrappers + post-run drift check
  are sufficient.
- **Metadata** (compact, no env dumps): `stage5_agent_shell_guard_required/enabled/status`,
  `stage5_host_pip_firewall_enabled`, `stage5_agent_wrapper_bin`, `stage5_agent_path_sanitized`,
  `stage5_agent_conda_env_scrubbed`, `stage5_agent_python_resolution`,
  `stage5_agent_pip_resolution`, `stage5_blocked_host_package_commands(+_count)`,
  `stage5_agent_shell_guard_failure_reason`, `stage5_agent_shell_guard_mandatory_since: "M90A"`.
- **Fail-closed behavior**: in `runCondition()` (the single live-spawn path), after the M89 env
  gate the guard materializes the wrapper bin and evaluates the mandatory gate. If the guard is
  disabled, the firewall is off, or the wrapper bin did not materialize, it throws **before any
  model call / Docker eval / external harness mutation** and writes `_agent_shell_guard.meta.json`.

## No-Agent Smoke
- **Dangerous cwd**: `/home/calvin/code/vexp-swe-bench/.bench-repos/pytest-dev__pytest` (real).
- **Blocked commands** (all exit 97, marker printed, recorded in block log): `pip install -e .`,
  `python -m pip install -e .`, `python3 -m pip install -e .`, `conda install pluggy=0.13.1`,
  `uv pip install -e .`, `poetry add pluggy`, `pipx install pytest`.
- **Allowed commands**: `python - <<PY … PY` runs; `which python` → wrapper.
- **Wrapper resolution**: `which pip` → `<run>/_vtrace_agent_bin/pip` (NOT
  `/home/calvin/miniforge3/bin/pip`).
- No real pip/conda ran; nothing was installed (blocked before exec), so no prefix changed.

## Stage 5 Safety
- **M89 env guard still mandatory** — unchanged; runs before the M90A layer.
- **M90A shell guard mandatory** — new second layer, default ON; fails closed before spawn.
- **Drift checker still mandatory** — the M89 before/after drift check remains required.
- **Remaining risks**: a determined agent could still mutate a prefix via an absolute-path
  interpreter (`/abs/python -c "import pip; …"`) or an absolute `pip`. The firewall targets the
  accidental-PATH-resolution vector (the actual recurrence). Docker evaluation remains the
  dependency-isolated path; a per-task disposable venv is the future hardening if agents ever
  legitimately need to install during exploration (such attempts are recorded as blocked).

## Tests
- `agentShellGuard.test.ts` (pure): PATH sanitization, conda-entry detection, env scrub,
  composed env, PATH resolution, the mandatory gate (8 cases), block-log parsing, metadata, and
  wrapper-script generation.
- `stage5AgentShellGuardIntegration.test.ts`: real materialization in a temp dir + **invoking
  the wrappers** to prove `pip install -e .`/`python -m pip install`/`conda install`/`uv pip
  install`/`poetry add`/`pipx install` are blocked (exit 97), `which pip` resolves to the
  wrapper, harmless `python` works, the block log is recorded, and `wrapperBinReady=false` on a
  bad write.
- `run_stage5_vexp_swe_bench_smoke.test.ts`: flag parsing (default ON, disable flags) and
  end-to-end through `runCondition` — guarded pass, disabled-guard fail-closed, and the escape
  hatch bypass (never benchmark-valid).
- **Verification**: `bun run typecheck`, `bun run typecheck:benchmarks`, `bun test`, and
  `git diff --check` all pass (see commit). No retrieval/scoring/ranking/Capsule code touched.

## Recommendation
**Proceed to M90 50-task confirmation with the shell guard.** Base repair is NOT required — the
firewall blocks host package mutation before it can run, so the recurrence vector is closed
without any base change. Future live commands must include both the M89 env-guard flags and the
M90A shell-guard flags (both default ON):

```
--stage5-env-guard --stage5-env-drift-check \
--expected-testbed-prefix /home/calvin/miniforge3/envs/vexp_swebench \
--stage5-agent-shell-guard --stage5-host-pip-firewall
```
