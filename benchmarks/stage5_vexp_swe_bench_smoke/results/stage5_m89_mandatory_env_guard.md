# Stage 5 M89 Mandatory Environment Guard

## Summary

- **Mandatory env guard implemented?** Yes. The Stage 5 environment-isolation guard is now
  **mandatory** for every live agent run. `runCondition()` — the single Stage 5 path that
  spawns a real agent / external SWE-bench agent run (baseline, vtrace, vexp) — fails closed
  before agent spawn unless the guard provably passes.
- **Default behavior for live runs:** fail closed. A live run cannot proceed unless
  `stage5_env_guard_enabled` **and** `stage5_drift_check_enabled` are true, an expected
  testbed prefix resolves, the python + pip prefixes verify, and
  `stage5_env_guard_status == pass`. Any miss ⇒ a thrown error **before** any model call,
  Docker eval, or external-harness mutation.
- **Behavior for offline / report / replay modes:** unchanged. Those paths never call
  `runCondition`, so the guard is not applicable to them (`stage5_env_guard_required: false`,
  `stage5_env_guard_status: not_applicable`). No behavior change for analysis, preflight
  metadata inspection, threshold replay, report generation, or unit tests with mocks.
- **Expected prefix resolution:** `--expected-testbed-prefix` → else
  `$VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX` → else (no reliable inference) → fail closed with
  fix instructions. Default for the current local setup:
  `/home/calvin/miniforge3/envs/vexp_swebench` (configured via flag/env, never hard-coded into
  the enforcement).
- **Driver/template updates:** `run_stage5_m88_driver.template.sh` already carried the three
  env-guard flags (comments now note they are mandatory since M89); a new
  `run_stage5_m90_driver.template.sh` (future 50-task guarded confirmation) ships with them.
- **Tests:** pure policy/resolution/metadata tests + end-to-end `runCondition` fail-closed /
  pass tests, all with injected synthetic probes (no real Conda, no agents, no Docker).
- **Recommendation:** proceed to M90 50-task guarded confirmation.

## Rationale

- **M86 contamination.** A SWE-bench dependency install contaminated the operator's Conda
  **base** prefix (`/home/calvin/miniforge3`): an editable `pip install -e .` of a pytest
  checkout landed in base and `pluggy` ended up double-installed. Root cause class: a
  dependency install resolved to bare `python`/`pip` (the active env) instead of a disposable
  testbed interpreter. M86 added the **opt-in** env-isolation guard to defend against this.
- **M87B repair verification.** The base prefix was repaired and verified clean
  (`baseRepairVerified=true`, `expectedTestbedClean=true`,
  `environmentSafeForLiveRuns=true`), with the verified clean testbed prefix
  `/home/calvin/miniforge3/envs/vexp_swebench`.
- **M88 flawless env-guard live validation.** Across 24 live treatment runs the env guard was
  flawless: 24/24 valid, 24/24 Docker evals, 0 env-guard failures, 0 drift danger, 0
  prefix-guard failures, 0 unsafe-pip blocks, protected base/dev prefixes untouched. M88's
  recommendation was explicit: **make the env guard mandatory; keep V4 and C7_D default-off.**
- **Why env guard is safety infra, not a behavioral intervention.** The env guard changes no
  retrieval, scoring, ranking, Capsule v2, V4 tool-loop guard, or C7_D cost-guard behavior. It
  only refuses to run when a dependency install could provably corrupt a protected prefix —
  exactly the M86 failure. Safety infrastructure should be **always-on / fail-closed**, whereas
  V4 and C7_D are behavior-changing experiments that must stay explicit opt-in / default-off.
  M89 promotes **only** the env guard; V4 and C7_D are untouched.

## Implementation

### Live-run enforcement point

`runCondition()` in `run_stage5_vexp_swe_bench_smoke.ts` is the single Stage 5 function that
spawns a live agent (via `runProcess`). The M89 gate sits immediately before the spawn, after
the run directory is created (so failure metadata can be written) and before `startedMs` /
the agent process. The precheck (reporting-only) and the M87 readiness script (preflight,
no spawn) do not call `runCondition` and are therefore correctly exempt.

### Expected-prefix resolution order

`resolveExpectedTestbedPrefix({ cliPrefix, envValue, inferredPrefix })` (pure):

1. `--expected-testbed-prefix` (source `cli`)
2. `$VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX` (source `env`)
3. a reliably-inferred prefix (source `inferred`) — none is wired by default (conservative)
4. otherwise `null` / source `none` ⇒ a live run **fails closed**

### Fail-closed behavior

`evaluateMandatoryLiveEnvGuard(...)` (pure) encodes the policy and is fully unit-tested:

- non-live run ⇒ proceed, `required: false` (not applicable);
- escape hatch set ⇒ proceed **bypassed**, `benchmarkValid: false`;
- env guard not enabled ⇒ fail closed (fix: pass `--stage5-env-guard`);
- drift check not enabled ⇒ fail closed (fix: pass `--stage5-env-drift-check`);
- no expected prefix ⇒ fail closed with fix instructions:
  ```
  Pass:
    --expected-testbed-prefix /path/to/env
  or set:
    VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX=/path/to/env
  ```
- prefix preflight not `pass` (wrong interpreter, pip-prefix mismatch, base/dev target, …) ⇒
  fail closed with the preflight reason.

When failing closed, the runner refuses to spawn the agent and throws **before** any model
call / Docker eval / external-harness mutation.

### Metadata

Every live run emits compact env metadata (no full environment dump), including on failure
(`_env_guard.meta.json` for fail-closed; merged into `_run.meta.json` on success/bypass):

| field | meaning |
| --- | --- |
| `stage5_env_guard_required` | `true` for live runs |
| `stage5_env_guard_enabled` | guard flag state |
| `stage5_drift_check_enabled` | drift flag state |
| `stage5_expected_testbed_prefix` | resolved expected prefix |
| `stage5_expected_testbed_prefix_source` | `cli` / `env` / `inferred` / `none` |
| `stage5_env_guard_status` | `pass` / `fail` (`not_applicable` only when not required) |
| `stage5_python_prefix_verified` | `sys.prefix` == expected |
| `stage5_pip_prefix_verified` | `pip -V` prefix == expected |
| `stage5_prefix_drift_summary` | compact drift line |
| `stage5_prefix_guard_failures` | failed-check details |
| `stage5_env_guard_failure_reason` | fail-closed / bypass reason, when any |
| `stage5_env_guard_mandatory_since` | `"M89"` for required runs |
| `stage5_unguarded_live_env_allowed` | escape-hatch bypass flag |
| `stage5_env_guard_benchmark_valid` | `false` for bypass/failure, `true` on a clean pass |

For offline/non-live modes: `stage5_env_guard_required: false`,
`stage5_env_guard_status: not_applicable`.

### Drift-check requirement

The drift check (`--stage5-env-drift-check`) is required for live runs alongside the guard.
Absence fails closed; the drift summary is read-only (it never mutates an environment).

### Escape hatch (added; test-/emergency-only)

`--allow-unguarded-live-env` is the only way to proceed a live run with the guard bypassed. It
is **default-off**, prints a loud multi-line warning, is recorded in metadata
(`stage5_unguarded_live_env_allowed: true`), and **invalidates benchmark-valid status**
(`stage5_env_guard_benchmark_valid: false`). It is never used by any default driver/template;
the generic mocked live-path unit tests use it (they exercise other behavior and never touch a
real environment). The dedicated M89 tests set it to `false` to assert the real fail-closed /
pass behavior.

## Compatibility

- **Offline modes** (ingest / report / aggregate / replay / planner / verifier / preflight)
  do not call `runCondition`, so they are unaffected and never require the guard.
- **Preflight modes** (M87/M87B readiness) call `runStage5EnvGuardPreflight` directly with no
  agent spawn — still report `pass` / `not_applicable` without a live run.
- **Historical reports / raw run artifacts** were not rewritten or edited.
- **Future driver commands** always include:
  ```
  --stage5-env-guard \
  --stage5-env-drift-check \
  --expected-testbed-prefix /home/calvin/miniforge3/envs/vexp_swebench
  ```

## Tests

Coverage summary (synthetic probes only — no real Conda, no agents, no Docker):

1. live run without env guard → fail closed before spawn ✓
2. live run without drift check → fail closed before spawn ✓
3. live run without expected prefix → fail closed with fix instructions ✓
4. expected prefix from CLI → pass ✓
5. expected prefix from env var → pass ✓
6. offline / non-live → not required ✓ (pure gate)
7. preflight-only → reports without spawning ✓ (preflight returns not_applicable/pass)
8. wrong-prefix python → fail closed ✓
9. pip-prefix mismatch → fail closed ✓
10. base/dev prefix target → fail closed ✓
11. metadata records `stage5_env_guard_required=true` for live ✓
12. metadata records mandatory-since `M89` ✓
13. disabled/unguarded (escape hatch) live path is never benchmark-valid ✓
14. future driver/template includes env-guard flags (and excludes the escape hatch) ✓
15. metadata is compact — no full environment dump ✓

**Verification result:** `bun run typecheck` ✓, `bun run typecheck:benchmarks` ✓, `bun test` ✓,
`git diff --check` clean. No retrieval/scoring/ranking/Capsule code was touched (no retrieval
evals required). No live agents, no Docker, no Conda mutation.

## Recommendation

**Proceed to M90 50-task guarded confirmation.** The env guard is now mandatory safety
infrastructure and is fail-closed for all live agent runs; M88 already showed the guard is
operationally flawless. The behavioral guards (V4, C7_D) remain default-off and unchanged, so
the M90 slice can confirm them under the now-mandatory env guard using
`run_stage5_m90_driver.template.sh`.
