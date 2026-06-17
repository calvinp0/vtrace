# Stage 5 — M25 design: isolated per-instance in-loop test runner for fair verification

Design/audit only. No live agents, no Docker, no 30/100, no source change (report-only).
Builds on M24 (`fc9ee5e`). Investigated VTRACE Stage 5 runner
(`benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts`), the external
harness (`/home/calvin/code/vexp-swe-bench`), and the installed upstream `swebench==4.1.0`
package (`/home/calvin/code/vexp-swe-bench/.venv/lib/python3.12/site-packages/swebench/`).

## 1. Executive conclusion

**An isolated per-instance in-loop test runner is feasible and can be fair.** The upstream
`swebench` package cleanly separates *building/starting the per-instance environment* from
*oracle test selection + scoring*. VTRACE can build/start the identical per-instance image the
canonical evaluator uses (`sweb.eval.<arch>.<instance_id>:latest`), apply exactly one patch
source, run an **agent-selected** test command, and parse **only that command's** stdout/stderr
— **without ever calling `grading.py`, FAIL_TO_PASS/PASS_TO_PASS, `resolved`, or the test_patch
gold directives**. Environment parity is guaranteed because the image key is a pure function of
the instance dict + namespace/tags.

Caveats that keep this honest: (a) it requires Docker (a new post-hoc *verify* path, not the
agent's live host loop), (b) fairness still depends on the M23/M24 provenance + environment
gates rejecting injected/oracle-derived commands, and (c) `final_patch_verified` may be claimed
only with an explicit patch-apply + worktree-hash proof. Recommended next step is **A —
implement the artifact planner first** (a no-Docker dry-run that resolves and gates inputs and
emits a plan), before any runner that touches Docker.

## 2. Current environment problem (M24 recap)

The agent's in-loop Bash inherits the host `process.env` PATH (vexp spawns `claude` with
`env: { ...process.env }`, cwd = a host git clone under `.bench-repos/`; no conda/venv/Docker).
For sphinx-7462 that resolved to base miniforge with `jinja2 3.1.6`; old Sphinx imports
`jinja2.environmentfilter` (removed in 3.1), so pytest's plugin import failed **before
collecting any test** (`test_error_environment`, M24). `conda run -n vexp_swebench` does not fix
it — that env also has `jinja2 3.1.6`. The failure is a **per-instance dependency-pin
mismatch**: no single shared env satisfies every instance's pins. Only a per-instance
environment (the SWE-bench testbed image, built at `base_commit` with `pip install -e .[test]`
and the instance-pinned deps) can run these tests.

## 3. Existing evaluator integration (what's reusable, what's oracle)

### VTRACE side (`run_stage5_vexp_swe_bench_smoke.ts`)
- `--mode evaluate` → `buildEvaluateCommand` → `node <cli> evaluate <jsonl> --mode docker`
  mutates `resolved` IN-PLACE. This is the **full oracle** (uses F2P/P2P → `resolved`).
- `--mode evaluate-revised-patch` (M17 shadow eval, `runEvaluateRevisedPatch`) writes a shadow
  JSONL (canonical row, revised patch swapped in) and runs the **same `evaluate`** on it →
  `resolved`, `failToPassResult`, `passToPassResult`. **Oracle, diagnostic-only**; never
  replaces the canonical patch (canonical artifacts hashed before/after to prove untouched).
- M21–M24 capture/verification (`src/capsule/toolOutputCapture.ts`): `parseEnrichedToolCalls`,
  `deriveTestCommands`, `parsePytestOutcome`, `classifyTestProvenance`,
  `classifyTestEnvironmentOutcome`, `assessFairVerification`, `buildFairVerificationReport`.
  These produce the agent-selected command, its provenance, and its environment classification —
  the **inputs** the isolated runner consumes. Pure; no oracle.
- Patch artifacts per run/condition dir: `_pivot_revision_original.patch`,
  `_pivot_revision_revised.patch`, `_pivot_revision.json` (`REVISION_ARTIFACT_FILES`); canonical
  first-pass `modelPatch` in `raw/vtrace/swebench-*.jsonl`. Command artifacts:
  `_pivot_revision_test_commands.json`, `_revision_verification_policy.json`.

### Upstream `swebench` 4.1.0 — build vs score are separable
- **Build/start the per-instance env (NO oracle):**
  - `make_test_spec(instance, namespace="swebench")` → `TestSpec` (`test_spec/test_spec.py:174`).
    Image key `sweb.eval.<arch>.<instance_id.lower()>:latest` (`test_spec.py:107-111`), conda env
    `testbed`, workdir `/testbed` (`:207-208`). F2P/P2P are read into dataclass fields but used
    only by grading.
  - `build_container(spec, client, run_id, logger, nocache, force_rebuild)`
    (`docker_build.py:470`) pulls/builds the instance image and creates the container.
  - `copy_to_container` / `write_to_container` (`docker_utils.py:18-60`); patch apply via
    `GIT_APPLY_CMDS` (`run_evaluation.py:64-68`: `git apply --verbose` → `--reject` →
    `patch --fuzz=5 -p1`), `DOCKER_PATCH=/tmp/patch.diff`, `DOCKER_WORKDIR=/testbed`.
  - `exec_run_with_timeout(container, cmd, timeout)` (`docker_utils.py:175`) runs **any** command.
  - `python -m swebench.harness.prepare_images` (`prepare_images.py:113`) builds images and
    stops — never imports `grading`/`run_evaluation`.
- **Oracle (the only place F2P/P2P + resolved live):** `grading.py` —
  `get_eval_report`/`get_eval_tests_report`/`get_resolution_status` (`:235-295,94-191,215-232`),
  called from `run_instance` (`run_evaluation.py:238-247`). Test **selection** for the gold run
  comes from `test_patch` directives (`get_test_directives`, `test_spec/python.py:230-261`) — the
  isolated runner uses neither these nor F2P/P2P.

**Conclusion:** there is a clean non-oracle seam. Stop after build → apply patch → exec command,
and never call `grading.py`.

## 4. Fairness boundary

| signal / path | uses hidden evaluator labels? | uses agent-selected command? | uses correct per-instance env? | fair product-like? | diagnostic / oracle only? | notes |
| ------------- | ----------------------------- | ---------------------------- | ------------------------------ | ------------------ | ------------------------- | ----- |
| host in-loop Bash | no | yes | **no** (host PATH) | no — env unreliable | n/a (broken) | M24: import fails before collection |
| `conda run -n vexp_swebench` | no | yes | **no** (same jinja2 3.1.6) | no | n/a | deterministic but same mismatch |
| SWE-bench Docker evaluator (`--mode evaluate`) | **yes** (F2P/P2P→resolved) | **no** (test_patch directives) | yes | **no** — uses oracle scoring | **oracle** (canonical product score) | the real grade |
| M17 shadow eval (`evaluate-revised-patch`) | **yes** (F2P/P2P→resolved) | no | yes | **no** — oracle upper-bound | **oracle, diagnostic** | never adopts; canonical artifacts hash-guarded |
| **proposed isolated agent-command runner** | **no** | **yes** (M23/M24-gated) | **yes** (same `sweb.eval` image) | **potentially yes** (no oracle) | configurable: fair by default, diagnostic for ambiguous provenance | builds env, applies one patch, runs one command, parses that output only |

The proposed runner is the only row that is both *correct-env* and *no-oracle*. Its fairness is
not automatic — it is enforced by the provenance/environment gates in §5–§7.

## 5. Proposed architecture

New mode (name): **`--mode verify-agent-test-command`** (alias considered:
`run-agent-selected-test`). Read-only w.r.t. canonical artifacts and the SWE-bench evaluator.

**Inputs (flags):**
- `--run-label <source-label>` — the source run whose artifacts are read.
- `--patch-source {original_model_patch | pivot_revision_revised}` — exactly one.
- `--command-source {pivot_revision_test_commands | first_pass_test_commands}` — where the
  agent-selected command(s) come from (the M21/M23 capture artifacts).
- `--vexp-swe-bench-dir <VEXP>`, `--out <OUT>` (as today).
- `--allow-provenance {agent_discovered}` (default) | `--diagnostic-allow {ambiguous,unknown}`
  (opt-in, marks results diagnostic-only, never fair).
- `--command-timeout <seconds>` (default e.g. 900), `--max-commands <n>`.

**Patch-source handling:**
- Resolve the patch bytes: `original_model_patch` ← canonical `modelPatch` from
  `raw/vtrace/swebench-*.jsonl`; `pivot_revision_revised` ← `_pivot_revision_revised.patch`.
- Compute `patchHash = sha256(patchBytes)` BEFORE anything runs. Apply **exactly one** patch
  source into the container (`copy_to_container` + `GIT_APPLY_CMDS`). Refuse if patch is empty
  or apply fails on all three strategies (record `patchApplied=false`).

**Command-source handling:**
- Load the captured test-command events + their fair-verification rows
  (`buildFairVerificationReport`). For each candidate command, enforce the §7 gates
  (provenance, classification, safety). Run only commands that pass. Use the command **as the
  agent issued it** only after safety screening (§7); otherwise reconstruct the parsed test
  invocation.

**Environment / testbed handling:**
- Build a `TestSpec` from the same instance dict + the evaluator's default namespace/tags
  (`namespace="swebench"`, `latest`, arch `x86_64`) so the image key equals the canonical
  evaluator's. Implementation is a small **Python entry script** in vexp invoked via subprocess
  (mirrors `evaluator.ts`): `make_test_spec` → `build_container` → `start` →
  `copy_to_container`(patch) → `GIT_APPLY_CMDS` → `exec_run_with_timeout`(command) →
  `cleanup_container`. The TS runner shells out and reads back a JSON result; it never imports
  grading.
- Record env summary: image key, container name, conda env (`testbed`), workdir (`/testbed`),
  arch, namespace, `environment_setup_commit`.

**Artifact outputs** (new, distinctly-named; never overwrite canonical/shadow files):
- `_agent_command_verify.meta.json` — full result (below).
- `_agent_command_verify.stdout.txt` / `.stderr.txt` — bounded (reuse `OUTPUT_MAX_BYTES`).
- `_agent_command_verify.plan.json` — the resolved inputs + gate decisions (the M26 planner
  writes this WITHOUT Docker).

**Timeout / error handling:** per-command timeout via `exec_run_with_timeout`; classify a
timeout as `test_error_environment`-adjacent `command_timeout` (never a pass). Build/pull
failures, patch-apply failures, and container errors are recorded as explicit non-pass states.
Always `cleanup_container` in a finally path.

**Result classification:** reuse M22/M24 — parse the command output with `parsePytestOutcome`
and label with `classifyTestEnvironmentOutcome` (`test_passed | test_failed | test_error_target
| test_error_environment | test_not_run | unknown`). Compose the final verdict with
`assessFairVerification`, now able to supply a real `finalPatchProof` (§6).

## 6. Patch-state proof design (`final_patch_verified`)

M24's `classifyVerificationPatchState` already emits `final_patch_verified` ONLY when
`finalPatchProof.applied === true` AND non-empty evidence is supplied — otherwise it refuses.
The isolated runner is what can finally supply that proof honestly:

```
patchSource            = pivot_revision_revised        // exactly one source
patchApplied           = true                          // GIT_APPLY_CMDS succeeded
patchHash              = sha256(<patch bytes>)         // computed before apply
worktreeDiffHashBeforeCommand = sha256(`git diff` in /testbed AFTER apply, BEFORE command)
commandRanAfterPatchApply     = true                   // ordering enforced by the runner
worktreeDiffHashAfterCommand  = sha256(`git diff` in /testbed AFTER command)
worktreeUnchangedByCommand    = (before === after)     // command did not mutate the patched tree
```

`finalPatchProof.evidence` = these fields serialized. `canVerifyFinalPatch=true` is set ONLY
when: `patchApplied && commandRanAfterPatchApply && worktreeUnchangedByCommand` and the patch
hash matches the requested source. If the command mutated the worktree (before≠after), the proof
is withheld (the test may have run against a tree that no longer equals the patch) — stays
`revision_phase_state`/`after_observed_edit_state`. This binds "which patch was installed" to
"which command ran" with hashes, the missing M22/M23 link.

## 7. Command safety policy

Captured commands are real shell strings (e.g. `python -m pytest … 2>&1 | head -50`). Policy:

**Gate 0 — provenance/classification (fairness, from M23/M24):**
- Reject `injected_metadata` provenance (matches injected FAIL_TO_PASS). Fair mode requires
  `agent_discovered`. `ambiguous`/`unknown` allowed ONLY under `--diagnostic-allow`, and such
  results are tagged `diagnostic_only=true`, never fair.
- Reject any call that does not classify as a known test command (`isTestCommand` /
  `classifyTestFramework !== "unknown"`).

**Gate 1 — command allowlist (the test invocation head):** the leading program must be one of
`pytest`, `python -m pytest`, `python -m unittest`, `unittest`, `tox`, `npm test`/`npm run
test`, `bun test`, `cargo test`, `go test`.

**Gate 2 — reject state-mutating / unsafe tokens** anywhere in the command:
`rm`, `git reset`, `git clean`, `git checkout`, `git commit`, `pip install`/`conda install`/
`apt`/`npm install`/package installs, network tools (`curl`, `wget`, `ssh`, `nc`), redirection
that writes files (`> file`, `>>`), `sudo`, and shell chains that go beyond test execution
(`&&`/`;`/backticks/`$()` introducing a non-test command).

**Shell-syntax handling (the realistic part):** do **not** run arbitrary captured shell
as-is. Two tiers:
- **Fair tier (default):** re-derive a *canonical* invocation from the parsed framework +
  `extractSelectedTests` (e.g. `python -m pytest <selected node ids> -q`), discarding the
  agent's pipes/redirects. This removes the M21/M22 `| head` masking problem at the source and
  guarantees no side effects. The agent's *choice of test* is preserved; only the shell
  plumbing is normalized.
- **Diagnostic tier (opt-in):** run the command as-captured after Gate 1+2 screening, inside the
  container (already isolated), tagged `diagnostic_only`. Used to study agent behavior, never to
  claim fair verification.

A command failing any gate is recorded with the gate that rejected it and is not executed.

## 8. Implementation plan (milestones)

- **M26 — artifact planner only (no Docker).** New `--mode verify-agent-test-command` that, given
  `--run-label`/`--patch-source`/`--command-source`, resolves patch bytes + `patchHash`, loads
  candidate commands, applies the §7 gates, computes the would-be `TestSpec` image key, and
  writes `_agent_command_verify.plan.json` (selected patch, selected commands, canonical/derived
  invocations, gate decisions, target image key). Pure + filesystem only; fully unit-testable
  with the existing sphinx-7462 artifacts. No container, no oracle. **Recommended first step.**
- **M27 — runner behind opt-in flag, no adoption.** Add the vexp Python entry script
  (`make_test_spec`→`build_container`→apply→`exec_run_with_timeout`→cleanup) + TS subprocess
  glue. Emit `_agent_command_verify.meta.json` with the §6 proof. Never replaces `modelPatch`,
  never calls `grading.py`. Off by default; requires explicit Docker approval to run.
- **M28 — one sphinx live validation.** Single pre-approved instance (e.g. sphinx-7462): build
  the per-instance image, run the agent-selected (canonicalized) command for both patch sources,
  confirm the env actually collects/runs the test (no `test_error_environment`), and that the §6
  proof is emitted. No 30/100.
- **M29 — evaluate whether a fair adoption policy can use the result.** Only after M28 shows a
  clean, reproducible, oracle-free pass/fail signal: decide if `fairVerificationUsable=true`
  results may inform revision adoption — still without F2P/P2P/`resolved`. Compare against the
  M17 oracle shadow eval purely as a sanity cross-check, not as the decision input.

## 9. Recommendation

**A. Implement isolated runner artifact planner first.**

Rationale: the feasibility blocker (env parity, oracle separation) is resolved by code
inspection — the seam exists and is clean. The remaining risk is integration correctness and
Docker orchestration, which the planner de-risks with zero Docker and zero spend: it proves we
can resolve the right patch, gate the right command, and compute the exact target image key from
existing artifacts. Building the planner first means M27's Docker runner is a thin, well-specified
shell around an already-validated input/gate layer. Do not run 30/100.

## 10. Scope / safety

Report-only (no source change; `git diff --check` clean). No live agents, no Docker, no 30/100.
No retrieval/ranking/scoring/candidate-generation or Capsule-v2 pivot change. No revised patch
wired into canonical evaluation; revision pass and fair-verification policy remain off by
default. Raw run artifacts under `runs/` not staged.
