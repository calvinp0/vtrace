# M187 — benchmark validation environment truthfulness and executability

**Verdict: PASS.** Phase 1B benchmark-infrastructure correctness only. No live
VTRACE-vs-baseline experiment was run, no retrieval/indexing/ranking/orientation/product code
was touched, and M185's `NO_FURTHER_AGENT_UTILITY_PRODUCT_WORK_LICENSED` is unaffected.

## Starting state

| | |
|---|---|
| branch | `main` |
| starting SHA | `5d3b8898af70ca37272cf06bbd1d611a659af3a3` |
| ahead/behind | ahead 136 of `origin/main`, nothing pushed |
| pre-existing dirt | 203 entries — 2 tracked (`stage5_outcome_ledger.{json,md}`), 201 untracked |

The dirt count matches M186's report exactly and was re-measured rather than assumed. Nothing
under `results/runs/` was modified: every M183/M185 raw artifact is byte-identical.

## 1 — M185's classification reproduces

`M185_CLASSIFICATION_REPRODUCED`. Its detector was reconstructed verbatim (the `SUITE` /
`EXECUTED` / `ENV_REFUSAL` regexes from `run_stage5_m185_behavior.ts`) and re-run over the
preserved corpus:

| | expected | recomputed |
|---|---|---|
| arms | 60 | 60 |
| arms attempting validation | 14 | 14 |
| arms executing a suite | 5 | 5 |
| arms attempting but never executing | 9 | 9 |
| attempts | 51 | 51 |
| attempts refused by the environment | 36 | 36 |

One thing the reproduction surfaces that M185 did not report: **6 of its 51 attempts fell into
none of its three categories** — not executed, not matched by its refusal set, and never named.
The M187 model classifies all of them (4 `UNKNOWN`, 2 recovered as prevented).

## 2 — why every exit code was null

`exitCode` was null for all 335 Bash calls because **the field does not exist in the
transport**. A `tool_result` block in the preserved streams carries exactly
`{tool_use_id, type, content, is_error}` — verified across every block in the corpus.
`exitCodeFrom()` in `src/capsule/toolOutputCapture.ts` looks for `exit_code` / `exitCode` /
`returncode` / `return_code` / `status` and correctly finds none of them. This was never a
parsing bug and nothing upstream discarded the value; MCP protocol `2024-11-05` has no
exit-status field.

The status was nevertheless recoverable, on a surface nobody was reading:

| surface | coverage | meaning |
|---|---|---|
| `Exit code N` as the first line of the tool result | 144 / 335 | the shell tool prints this for a non-zero exit |
| no such line, `is_error` absent | 190 / 335 | exited 0 |
| `is_error: true` with no line | 1 / 335 | a tool-policy refusal, not a process at all |

The correlation is a clean bijection: every `success=false` call carries a code (105×`1`,
28×`127`, 6×`2`, 5×`128`) and every `success=true` call carries none.

**M187 changed the upstream capture** so the truth is recorded where it is produced, not
re-inferred by each consumer: `attachResult()` now falls back to the anchored `Exit code N`
prefix and records `exitCodeSource: "stream_field" | "output_prefix" | null`. No code is
synthesized — an absent prefix stays `null`, because a refused command has no prefix either.

**And the exit code still must not be trusted alone.** 190 M183 calls report `success=true`
while the command under test failed, because the agent piped through `head`/`grep` and a
pipeline reports its *last* stage. `readExitStatus` therefore returns `known:false` for a
piped success rather than laundering it into a zero.

## 3 — the nine historical refusals, audited

23 prevented attempts across the 9 arms:

| instance | arm | n | root causes | benchmark-owned |
|---|---|---:|---|---|
| django__django-11820 | baseline | 3 | RUNNER_UNAVAILABLE 1, DEPENDENCY 2 | 1 yes, 2 uncertain |
| django__django-12273 | treatment | 3 | RUNNER_UNAVAILABLE 1, DEPENDENCY 2 | 1 yes, 2 uncertain |
| django__django-13820 | baseline | 4 | RUNNER_UNAVAILABLE 1, DEPENDENCY 2, COMMAND_MISSING 1 | 2 yes, 2 uncertain |
| django__django-17084 | baseline | 2 | RUNNER_UNAVAILABLE 1, COMMAND_MISSING 1 | 2 yes |
| sphinx-doc__sphinx-7462 | treatment | 1 | RUNNER_UNAVAILABLE 1 | 1 yes |
| pytest-dev__pytest-6197 | baseline | 2 | DEPENDENCY 1, UNDETERMINED 1 | 2 uncertain |
| pytest-dev__pytest-6197 | treatment | 1 | DEPENDENCY 1 | 1 uncertain |
| pytest-dev__pytest-7432 | treatment | 6 | COMMAND_MISSING 2, RUNNER_UNAVAILABLE 1, DEPENDENCY 1, UNDETERMINED 2 | 3 yes, 3 uncertain |
| sympy__sympy-12419 | treatment | 1 | DEPENDENCY 1 | 1 uncertain |

**Aggregate:** `DEPENDENCY_ENVIRONMENT_UNAVAILABLE` 10, `TEST_RUNNER_UNAVAILABLE` 6,
`COMMAND_OR_TARGET_MISSING` 4, undetermined 3. Ownership: 10 benchmark-owned, 13 uncertain,
0 external-tool, 0 repository-only.

These are not heterogeneous mechanisms wearing different names. All 23 descend from one
upstream cause (§4), and the taxonomy is kept split anyway because the *fix* for each differs
and collapsing them would hide the residue.

## 4 — the execution-path root cause

The seam, traced through the production path:

```
agent tool_use (Bash)
  → claude CLI                       vexp-swe-bench/src/agents/claude-code.ts:99  spawn(cwd, env)
  → external harness startRun        vexp-swe-bench/src/harness/orchestrator.ts:51
  → VTRACE runCondition              run_stage5_vexp_swe_bench_smoke.ts:8102 (dir), :8271 (guard), :8317 (spawn)
  → materializeAgentShellGuard       stage5AgentShellGuardIntegration.ts:105
  → agent PATH / env overrides       agentShellGuard.ts  sanitizeAgentPath / buildAgentShellEnv
  → tool_result capture              src/capsule/toolOutputCapture.ts  attachResult
  → _tool_calls_with_outputs.json    persistPhaseToolTelemetry
  → classifier                       benchmarks/.../validationExecution.ts
```

**The defect.** `runCondition` materialized the M90A firewall wrappers into
`rawConditionDir(...)` — and passed that *same directory* to the external harness as
`--output` (`buildRunArgs`, line 1455). The harness opens every fresh run with
`cleanPreviousRun(config.outputDir)`, which `rmSync`s every entry there. The preserved stdout
of **all 60 M183 arms** records the result:

```
⚠ Cleaned 1 file(s) from .../runs/<label>/raw/baseline/
```

exactly one entry, in 30 baseline and 30 treatment arms. That entry was `_vtrace_agent_bin`.

**What the agent then inherited.** The PATH override survived (it is an env var); the wrappers
did not (they are files). So the agent ran with conda stripped from PATH — and on this host
`pip` exists *only* inside miniforge — with the first PATH entry pointing at a directory that
no longer existed. Every consequence follows mechanically and is visible in the corpus:

- `python` → `/usr/bin/python` (3.14.6, no packages). The guard's recorded intent was
  `→ delegate /home/calvin/miniforge3/envs/vexp_swebench/bin/python`.
- `pip` / `pip3` → `command not found`, exit 127, 28 times.
- The firewall never fired once: 0 blocked commands, 0 `VTRACE_HOST_PIP_BLOCKED` markers and
  no exit 97 anywhere in 60 arms.
- An agent's own `which` output prints the search list with `_vtrace_agent_bin` first and
  still resolves `/usr/bin/python` — the directory was gone.

**And the guard reported `pass` for all 60 arms**, because `evaluateMandatoryAgentShellGuard`
checks `wrapperBinReady` before spawn, which is the one moment it is always true. A readiness
check that runs before the only event that can invalidate it cannot fail.

The M90A firewall was therefore not merely disarmed — M183 paid its entire cost (no testbed
interpreter, no `pip`) and received none of its protection.

## 5 — implementation

| file | change |
|---|---|
| `src/capsule/toolOutputCapture.ts` | capture the exit status from the surface it is actually on: `exitCodeFromOutputPrefix()`, `ExitCodeSource`, and `attachResult` recording which surface answered. Additive; never synthesizes a code. |
| `benchmarks/.../run_stage5_vexp_swe_bench_smoke.ts` | new `agentShellGuardDir()`; the guard now materializes there instead of into the harness's `--output` directory; post-run wrapper-bin liveness observed and a vanished firewall degrades the recorded status. |
| `benchmarks/.../agentShellGuard.ts` | `wrapperBinSurvivedRun` on the metadata input and `stage5_agent_shell_guard_wrapper_bin_survived_run` on the output. `null` when not observed. |
| `benchmarks/.../validationExecution.ts` | **new** — the state model, the attempt/execution split, the exit-status reader and the refusal taxonomy. Pure; composes `classifyTestFramework` and the M22/M24 `classifyTestEnvironmentOutcome` rather than forking them. |
| `benchmarks/.../validationExecution.test.ts` | **new** — 31 tests over the §26 matrix, the `exitCode = null` invariant and the §28 independence proof. |
| `benchmarks/.../m187ShellGuardSurvival.test.ts` | **new** — 6 tests; reproduces the harness cleaner against both layouts, with a control that must destroy the old one. |
| `benchmarks/.../run_stage5_m187_{audit,probes,symmetry}.ts` | **new** — reclassification, controlled probes, arm-symmetry evidence. |

`src/capsule/toolOutputCapture.ts` is the only `src/` file touched. It is the owner of the
`exitCode` field, and it is an island: its only importers are `agentTestCommandPlanner`,
`agentTestCommandVerifier` and benchmark code. It is unreachable from `src/mcp`,
`src/retrieval`, `src/capsuleV2` and `src/indexer`, so no product semantics can move.

**No forced testing.** No system prompt, `CLAUDE.md`, `AGENTS.md`, tool description or agent
policy was changed. The repair restores capability; whether an agent uses it stays its choice.

## 6 — controlled executability proof

`stage5_m187_executability_probes.json` — **11/11 preregistered rows agree**, across four
independent repositories, with no agent spawned and nothing spent. The environment is built by
the production `materializeAgentShellGuard` call and exercised through `bash -c`, which is the
shell the agent's Bash tool uses.

| probe | repo | observed |
|---|---|---|
| A1 runner starts, tests pass | seaborn | `STARTED_PASSED` |
| A2 runner starts, tests fail (naturally, no source altered) | seaborn | `STARTED_FAILED` |
| A3 runner starts, environment breaks first | requests | `STARTED_INFRA_FAILURE` |
| A4 same shape, independent repo | sympy | `STARTED_INFRA_FAILURE` |
| D1 runner not installed | seaborn | `ATTEMPTED_NOT_STARTED` |
| D2 invalid target | seaborn | `STARTED_INFRA_FAILURE` |
| **G1 an M183 refusal replayed** | **django** | **`STARTED_PASSED`** |
| G2 the same, without PYTHONPATH | django | `ATTEMPTED_NOT_STARTED` |
| E1 host-pip firewall refuses | seaborn | `ATTEMPTED_NOT_STARTED` |
| F1 timeout after the runner started | seaborn | `STARTED_TIMED_OUT` |
| **Z1 CONTROL — the M183 layout** | **seaborn** | **`ATTEMPTED_NOT_STARTED`** |

Two rows carry the argument. **G1** replays django__django-13820's own M183 command,
`PYTHONPATH=. python tests/runtests.py migrations.test_loader -v0`, which returned
`ModuleNotFoundError: No module named 'django'` in the live run; on the repaired path it
returns `Ran 27 tests … OK`. **Z1** materializes the wrappers the M183 way, applies the
harness's cleaner, and re-runs A1's passing command — which then fails to start. Without Z1
failing, nothing else here would be evidence.

**E1 also proves the firewall is armed again**: it blocks, which is exactly what never
happened in 60 M183 arms.

Two honest limits. **G2** is recorded deliberately: the repair restores the interpreter, not
the agent's job — django's entrypoint still needs `PYTHONPATH`, as it does for anyone.
And **A3/A4 are not universal executability**: the testbed is one Python 3.12 environment, and
old pinned repositories (requests, sympy, flask, pylint, sphinx) still cannot import at that
version. The claim proven here is that the *harness mechanism* works, not that every
SWE-bench task's dependency environment does (§27).

One preregistered expectation was **revised after the run and is recorded as revised** rather
than quietly rewritten: D2 was preregistered `ATTEMPTED_NOT_STARTED` on the theory that an
invalid target refuses before launch. The evidence disagreed — pytest itself prints
`no tests ran in 0.00s` and `ERROR: file or directory not found:` and exits 4, which is a
*running* pytest reporting an empty selection. The expectation was wrong about the mechanism
and the classifier was extended to see pytest's own launcher diagnostics. Both fields are in
the artifact (`preregisteredExpectation`, `expectationRevised`).

## 7 — baseline/treatment symmetry

`stage5_m187_arm_symmetry.json` — **`VALIDATION_CAPABILITY_EQUIVALENT`**. 30/30 pairs compared,
0 asymmetric, 0 unexpected treatment-only environment keys. Nine capability-bearing env vars
(`PATH`, `PYTHONPATH`, `PYTHONHOME`, `VIRTUAL_ENV`, `CONDA_*`, `PIP_REQUIRE_VIRTUALENV`) and
eleven run-meta fields were compared per pair with run-label path components normalized.

The shared implementation is traced, not assumed: both arms are launched from one `common=(…)`
flag array in `run_stage5_m183_driver.sh`, both run `--protocol baseline`, and both therefore
take the same `runCondition()` path and the same `materializeAgentShellGuard()` call. The
wipe hit both equally — 30 baseline and 30 treatment arms each logged `Cleaned 1 file(s)`.

Symmetry here is *not* a claim the arms were identical: the treatment reached the agent by a
different surface, and M183's own witness records 30/30 orientation packets delivered with 30
distinct semantic hashes. The scope is stated in the artifact.

## 8 — historical reclassification of M183

Raw artifacts untouched; this is derived interpretation.

| state | all 60 | baseline | treatment |
|---|---:|---:|---:|
| `NOT_ATTEMPTED` | 46 | 22 | 24 |
| `ATTEMPTED_NOT_STARTED` | 9 | 4 | 5 |
| `STARTED_PASSED` | 3 | 2 | 1 |
| `STARTED_FAILED` | 1 | 1 | 0 |
| `STARTED_TIMED_OUT` | 0 | 0 | 0 |
| `STARTED_INFRA_FAILURE` | 1 | 1 | 0 |
| `UNKNOWN` | 0 | 0 | 0 |

Per attempt (47 detected): 34 `ATTEMPTED_NOT_STARTED`, 7 `STARTED_PASSED`, 1 `STARTED_FAILED`,
1 `STARTED_INFRA_FAILURE`, 4 `UNKNOWN`.

The five arms that reached a runner: django-12325 baseline (`STARTED_FAILED`), pytest-7432
baseline (`STARTED_INFRA_FAILURE`), sympy-12419 baseline and sympy-13974 both arms
(`STARTED_PASSED`).

**The arm-level partition is unchanged from M185: 46 / 9 / 5.** M185's headline finding stands
and is now stated in terms that separate a choice from a capability. What changed is precision:

- **3 movers, all attempt-count only, no arm changed state.** Four attempts M185 counted are
  not validation attempts: a `cat > test_x.py << EOF` heredoc that *writes* a test file, a
  `pip install` whose working directory happened to be `…/pytest-dev__pytest`, and two
  `import _pytest` probes. M185's `\bpytest\b` matched the repository *path*.
- One attempt M185 missed is recovered: `python src/pytest.py …`.
- The 6 attempts M185 counted but never named are now classified.
- The `rm -rf /tmp/pytest_test_dir` call — the single tool-policy refusal in the corpus, and
  M183's only `is_error` without an exit code — is correctly no longer a validation attempt.

**Raw-output agreement control (§22): PASS**, 47/47. Every `STARTED_*` verdict has a literal
runner marker in the preserved text and every `ATTEMPTED_NOT_STARTED` has none. A classifier
that disagreed with the transcript would fail the script.

## 9 — verification

| gate | result |
|---|---|
| `bun run typecheck` | pass |
| `bun run typecheck:benchmarks` | pass |
| `bun test` | 5632 pass, 49 skip, **0 fail**, 359 files |
| `git diff --check` | clean |
| `run_stage5_m187_audit.ts` | `M185_CLASSIFICATION_REPRODUCED`, agreement control PASS |
| `run_stage5_m187_probes.ts` | 11/11 agree, control fires |
| `run_stage5_m187_symmetry.ts` | `VALIDATION_CAPABILITY_EQUIVALENT` |

Functional commit: `c9a477de85820678d7e2411488dec10944c72542`, on `main`, not pushed. The
pre-existing dirt (`stage5_outcome_ledger.{json,md}` and 201 untracked entries) was left
exactly as found.

## 10 — remaining benchmark-validation issues

1. **The testbed is one interpreter, and SWE-bench is many.** `vexp_swebench` is Python 3.12
   with pytest 9 and a partial package set; django, sympy, xarray and astroid are absent and
   old pinned repositories cannot import there at all. The repair restores *an* interpreter
   with a real pytest, which is a large improvement on a bare 3.14 with nothing, but per-task
   dependency provisioning remains unsolved. This is the honest residue behind the 13
   `uncertain` attempts, and the SWE-bench Docker images are the obvious place it belongs.
2. **`.bench-repos` accumulates editable installs of benchmark repositories.** The shared
   `vexp-swe-bench/.venv` currently carries `pytest-0.1.dev1+ge6e300e72.d20260829` (dated the
   M183 run day) and `pylint-2.9.0.dev1` as editable installs pointing at bench checkouts. Any
   task that activates that venv imports another task's mid-edit source — sympy-12419's
   treatment arm hit exactly this. Not repaired here: it is outside the benchmark's own tree
   and deleting another tool's environment is not M187's call.
3. **Per-command timeouts are external-tool-owned.** The agent CLI emits `Command timed out
   after Ns`; the harness's own timeout kills the whole agent. `STARTED_TIMED_OUT` is proven
   against that string (F1) and by fixture, not by causing a real tool-level timeout.
4. **Pre-spawn readiness is still structurally blind.** M187 adds a post-run observation, which
   converts a silent lie into a recorded fact but cannot prevent the run. A guard that
   re-verified itself from inside the agent's first turn would close this properly.
5. **`cleanPreviousRun` is still there.** The repair moves out of its way rather than changing
   it, because the external harness is not this repository's to modify. Any future artifact
   written into `raw/<condition>` before the harness starts will be deleted the same way.

## Closing

No live VTRACE utility benchmark was run. No VTRACE agent-utility product work was licensed by
M187. M185's `NO_FURTHER_AGENT_UTILITY_PRODUCT_WORK_LICENSED` stands unchanged, and M187
authorizes no Phase 2 implementation.

M183 remains a valid paired comparison — both arms were equally deprived — but it was not a
measurement of a normal edit→test→revise loop, because in 55 of 60 arms no test runner ever
started, and in 9 of those the agent tried.
